/**
 * ブラウザで起きたことをサーバへ送る（設計§12）。
 *
 * ここが埋める穴は「何ひとつ残らない」ことだった。WebSocket のエラーは単一のスロットへ
 * 上書きされるだけで、バナーを閉じれば消える。未捕捉の例外に至っては受け止める仕組みが
 * 無い。**残す先はサーバのログ**で、置き場所も形も他の経路と揃えてある。
 *
 * # `console.*` は拾わない
 *
 * React の未捕捉ハンドラは既定で `console.error` を呼び、ブラウザ自身も送信の失敗を
 * コンソールへ出す。拾うと**送信の失敗を拾って送信して失敗する輪**ができる（設計§12-1）。
 * 同じ理由で、**このファイルの中でも `console` を使わない**。
 *
 * # 送れなかったことは、送らない
 *
 * 送信の失敗そのものはログにしない。上限付きのリングへ積み直し、**捨てた件数だけ**を
 * 次の便へ載せる（`dropped`）。輪を構造的に断つのが狙いで、黙って減らさないための
 * 件数はサーバ側の行に残る。
 */

import { cardIdFromPath } from '@/lib/routes'

const ENDPOINT = '/api/client-logs'

/** まとめて送るまでの窓（設計§12-2）。 */
const FLUSH_MS = 1_000

/** 1リクエストの件数の上限（`protocol::client_log::MAX_BATCH_ENTRIES` と同じ値）。 */
const MAX_BATCH_ENTRIES = 32

/** 1リクエストの合計（同 `MAX_BATCH_BYTES`）。天井は `sendBeacon` の 64 KiB。 */
const MAX_BATCH_BYTES = 56 * 1024

/** 1件の大きさ（同 `MAX_ENTRY_BYTES`）。 */
const MAX_ENTRY_BYTES = 8 * 1024

/** 1件あたりの本文以外の目安（同 `ENTRY_OVERHEAD_BYTES`）。 */
const ENTRY_OVERHEAD_BYTES = 128

/**
 * 溜めておける件数。**溢れたら古い方から捨てる。**
 *
 * 送れない間に無限に溜めると、落ちている最中のタブがメモリで死ぬ。捨てたことは
 * `dropped` で残るので、黙って減ることにはならない。
 */
const RING = 64

export type ClientLogLevel = 'ERROR' | 'WARN' | 'INFO'

export type ClientLogKind =
  | 'unhandled'
  | 'rejection'
  | 'react_uncaught'
  | 'react_caught'
  | 'react_recoverable'
  | 'ws_error'
  | 'ws_close'

export interface ClientLogEntry {
  ts: string
  level: ClientLogLevel
  kind: ClientLogKind
  msg: string
  url?: string
  card_id?: string
  stack?: string
  /**
   * こちらで切ったか。**上限ぴったりに収めると、受け取った側は何もしない**ので、
   * 切った事実はここでしか残せない（サーバ側の `truncated` と同じ欄）。
   */
  truncated?: boolean
}

let pending: ClientLogEntry[] = []
let dropped = 0
let timer: ReturnType<typeof setTimeout> | undefined
/** 据えた聞き耳。**外せる形で持つ**——持たないと、据え直したときに二重に発火する */
let listeners: (() => void) | undefined

const ENCODER = new TextEncoder()

/**
 * UTF-8 での長さ。**`.length` を使わない。**
 *
 * あちらが数えるのは UTF-16 の符号単位で、サーバ（`str::len()`）が数えるのは
 * UTF-8 のバイトである。日本語は1文字が UTF-16 では1、UTF-8 では3になるので、
 * **手元の検査を通った行がサーバの上限を超える**——そして断られたことは
 * `fetch` の `ok` にしか出ないので、黙って消える形になっていた。
 */
function byteLen(text: string): number {
  return ENCODER.encode(text).length
}

/**
 * 予算に収まるところまで、**符号位置の境目で**切る。
 *
 * `slice` はサロゲートペアを割りうる。割れた片割れは単独では正しい文字ではなく、
 * サーバの JSON 解釈が拒む——ここでも「断られたのに気づかない」に落ちる。
 */
function sliceToBytes(text: string, budget: number): string {
  if (budget <= 0) {
    return ''
  }
  if (byteLen(text) <= budget) {
    return text
  }
  let used = 0
  let out = ''
  for (const ch of text) {
    const size = byteLen(ch)
    if (used + size > budget) {
      break
    }
    used += size
    out += ch
  }
  return out
}

function sizeOf(entry: ClientLogEntry): number {
  return (
    byteLen(entry.msg) +
    byteLen(entry.stack ?? '') +
    byteLen(entry.url ?? '') +
    byteLen(entry.card_id ?? '') +
    byteLen(entry.ts) +
    ENTRY_OVERHEAD_BYTES
  )
}

/**
 * 1件を上限まで切る。**スタックから先に落とす**（サーバ側の `clamp` と同じ順序）。
 *
 * こちらでも切るのは、線に載せる量を減らすため。**判定はサーバも独立に行う**——
 * ブラウザの言い分だけを信じる形にはしない。
 */
function clamp(entry: ClientLogEntry): ClientLogEntry {
  if (sizeOf(entry) <= MAX_ENTRY_BYTES) {
    return entry
  }
  const withoutStack = sizeOf({ ...entry, stack: undefined })
  if (withoutStack <= MAX_ENTRY_BYTES && entry.stack !== undefined) {
    return {
      ...entry,
      stack: sliceToBytes(entry.stack, MAX_ENTRY_BYTES - withoutStack),
      truncated: true,
    }
  }
  const withoutMsg = sizeOf({ ...entry, stack: undefined, msg: '' })
  return {
    ...entry,
    stack: undefined,
    msg: sliceToBytes(entry.msg, MAX_ENTRY_BYTES - withoutMsg),
    truncated: true,
  }
}

/** いま開いている画面。React の外から呼ばれるので `window.location` から読む。 */
function whereAmI(): { url?: string; card_id?: string } {
  if (typeof window === 'undefined') {
    return {}
  }
  const pathname = window.location.pathname
  return { url: pathname, card_id: cardIdFromPath(pathname) }
}

/**
 * 1件を積む。**送るのは窓が閉じてから**（設計§12-2）。
 *
 * 例外を投げないこと。ここで投げると、拾った先（`window.onerror`）へ戻って輪ができる。
 */
export function report(
  kind: ClientLogKind,
  level: ClientLogLevel,
  msg: string,
  extra?: { stack?: string; cardId?: string },
): void {
  try {
    const where = whereAmI()
    pending.push(
      clamp({
        ts: new Date().toISOString(),
        level,
        kind,
        msg,
        url: where.url,
        card_id: extra?.cardId ?? where.card_id,
        stack: extra?.stack,
      }),
    )
    while (pending.length > RING) {
      pending.shift()
      dropped += 1
    }
    schedule()
  } catch {
    // 積むことに失敗しても、画面は動き続ける。**ここで声を上げない**
  }
}

function schedule(): void {
  if (timer !== undefined || pending.length === 0) {
    return
  }
  timer = setTimeout(() => {
    timer = undefined
    void flush()
  }, FLUSH_MS)
}

/** 上限に収まるぶんだけ取り出す。**件数と大きさを重ねて掛ける。** */
function takeBatch(): ClientLogEntry[] {
  const batch: ClientLogEntry[] = []
  let bytes = 0
  while (pending.length > 0 && batch.length < MAX_BATCH_ENTRIES) {
    const next = pending[0]
    bytes += sizeOf(next)
    if (bytes > MAX_BATCH_BYTES) {
      break
    }
    batch.push(next)
    pending.shift()
  }
  return batch
}

/** いま溜まっているぶんを送る。 */
export async function flush(): Promise<void> {
  if (pending.length === 0) {
    return
  }
  const batch = takeBatch()
  const carried = dropped
  dropped = 0
  const body = JSON.stringify({ entries: batch, dropped: carried })

  // **`fetch` はネットワーク障害でしか reject しない。** 413 や 400 で断られても
  // `try` を抜けてしまうので、`ok` を見ないと「サーバが受け取らなかった」だけが
  // 成功として通り、行も `dropped` も黙って消える
  let accepted = false
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // タブが閉じかけていても送り切る
      keepalive: true,
    })
    accepted = response.ok
  } catch {
    accepted = false
  }
  if (!accepted) {
    // **送信の失敗はログにしない**（輪ができる）。積み直して次に賭ける
    requeue(batch, carried)
  }
  schedule()
}

/**
 * 送れなかったぶんを積み直す。
 *
 * **`dropped` は足す**（上書きしない）。待っている間に新しく捨てたぶんが
 * 積まれていることがあり、上書きするとその数が消える。
 */
function requeue(batch: ClientLogEntry[], carried: number): void {
  pending = [...batch, ...pending]
  dropped += carried
  while (pending.length > RING) {
    pending.shift()
    dropped += 1
  }
}

/**
 * 画面を離れるときに送る。
 *
 * `fetch` は間に合わないことがあるので `sendBeacon` へ切り替える（64 KiB 制限）。
 * **待てない場面なので、失敗しても積み直さない**——次が無い。
 */
export function flushOnLeave(): void {
  if (pending.length === 0 && dropped === 0) {
    return
  }
  const batch = takeBatch()
  // **持ち出せなかったぶんも、この便で数として伝える。** 次が無いので、ここで
  // 数えなければどこにも残らない（`takeBatch` は件数と大きさで頭打ちになる）
  const carried = dropped + pending.length
  const body = JSON.stringify({ entries: batch, dropped: carried })
  const sent =
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function' &&
    navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
  if (sent) {
    pending = []
    dropped = 0
    return
  }
  // **送れていないなら消費しない。** `sendBeacon` はキューが一杯・64 KiB 超で
  // `false` を返し、そもそも実装が無い環境もある。`pagehide` は bfcache から
  // 戻ってくることがあるので、戻れたときに次の便へ載せられる形で残す
  pending = [...batch, ...pending]
}

/**
 * 拾う口を据える（設計§12-1）。**2度目以降は据え直さない。**
 *
 * 拾うのは `window.onerror` と `unhandledrejection` の2つ。React の3つは
 * [`reactErrorHandlers`] が返すものを `createRoot` へ渡す。
 */
export function installClientLogs(): void {
  if (listeners !== undefined || typeof window === 'undefined') {
    return
  }

  const onError = (event: ErrorEvent) => {
    report('unhandled', 'ERROR', event.message || '未捕捉のエラー', {
      stack: event.error instanceof Error ? event.error.stack : undefined,
    })
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason
    report('rejection', 'ERROR', describe(reason), {
      stack: reason instanceof Error ? reason.stack : undefined,
    })
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  // **`beforeunload` ではなく `pagehide`。** 前者はモバイルで発火しないことがある
  window.addEventListener('pagehide', flushOnLeave)

  listeners = () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    window.removeEventListener('pagehide', flushOnLeave)
  }
}

/** `createRoot` に渡す3つ（React 19）。 */
export function reactErrorHandlers() {
  return {
    onUncaughtError: (error: unknown) => {
      report('react_uncaught', 'ERROR', describe(error), {
        stack: error instanceof Error ? error.stack : undefined,
      })
    },
    onCaughtError: (error: unknown) => {
      report('react_caught', 'WARN', describe(error), {
        stack: error instanceof Error ? error.stack : undefined,
      })
    },
    onRecoverableError: (error: unknown) => {
      report('react_recoverable', 'WARN', describe(error), {
        stack: error instanceof Error ? error.stack : undefined,
      })
    },
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name
  }
  return String(value)
}

/** テストから状態を戻す口。**製品の経路からは呼ばない。** */
export function resetClientLogs(): void {
  pending = []
  dropped = 0
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
  // **聞き耳も外す。** 印だけ戻すと、据え直したときに同じ行が2回積まれる
  listeners?.()
  listeners = undefined
}
