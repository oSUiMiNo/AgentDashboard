/**
 * エクスプローラ・VSCode で開く口を、画面から読む・押す
 * （サイドバーにエクスプローラで開くボタンが欲しい 設計§7-6）。
 *
 * # なぜ `compact.ts` に相乗りしないのか
 *
 * あちらは仮想ディスクの縮小の口で、**主題が違う**。同じ「PC 自身に効く口」でも、
 * 答えの形も断り方も別なので、型を混ぜると片方の都合でもう片方が動く。
 *
 * # 「口が無い（null）」と「一時的に聞けなかった（FAILED）」を分ける
 *
 * `null` は**この口は無い・使えない**（501・404・405・JSON でない答え・形が違う答え）。
 * 口の無いサーバは知らない GET に `index.html` を 200 で返すので、状態コードだけでは
 * 決めない。呼ぶ側は `null` を受けたら読み直しを止める。
 *
 * `FAILED` は**線が切れた・500 など、次は聞けるかもしれない**もの。これまで `null` に
 * 混ぜると、一度の瞬断でそのサイドバーではボタンが二度と出なくなる。
 *
 * # 401 を畳まない・例外を投げない
 *
 * 他の取得口（`compact.ts` ほか）と同じく、401 は `markSignedOut()` を呼んで
 * ログイン画面へ落とし、失敗は返り値で言い分ける。
 */

import { useAuthStore } from '@/stores/auth'

export type OpenApp = 'explorer' | 'vscode'

/** Rust 側の `ToolView`（`core/src/open_api.rs`）と同じ綴り。 */
export interface ToolView {
  available: boolean
  /** 使えない理由（`null` なら使える）。人が読む文 */
  reason: string | null
}

/** Rust 側の `OpenedView` と同じ綴り。 */
export interface OpenedView {
  /** 画面が送ったパスのまま返る（文字のまま突き合わせてよい） */
  path: string
  kind: 'dir' | 'file'
  since_ms: number
}

/** Rust 側の `OpenInView` と同じ綴り。 */
export interface OpenInView {
  /** このブラウザ（接続）が親PC の上か */
  same_machine: boolean
  same_machine_reason: string | null
  explorer: ToolView
  vscode: ToolView
  /** VSCode で開いているもの（古い順） */
  opened: OpenedView[]
}

export type OpenOutcome = 'launched' | 'opened' | 'fronted'

/** Rust 側の `OpenResult` と同じ綴り。 */
export interface OpenResult {
  outcome: OpenOutcome
  view: OpenInView
}

/** ログインが切れていた。**「聞けなかった」と区別する。** */
export const SIGNED_OUT = 'signed-out' as const

/** 一時的に聞けなかった。**口が無い（`null`）とは分ける**（冒頭の説明） */
export const FAILED = 'failed' as const

export type OpenInAnswer =
  | OpenInView
  | null
  | typeof SIGNED_OUT
  | typeof FAILED

export type OpenAttempt =
  | { ok: true; result: OpenResult }
  | { ok: false; message: string }

function isToolView(value: unknown): value is ToolView {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const tool = value as Record<string, unknown>
  return (
    typeof tool.available === 'boolean' &&
    (tool.reason === null || typeof tool.reason === 'string')
  )
}

function isOpenedView(value: unknown): value is OpenedView {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const entry = value as Record<string, unknown>
  return (
    typeof entry.path === 'string' &&
    (entry.kind === 'dir' || entry.kind === 'file') &&
    typeof entry.since_ms === 'number'
  )
}

/** 形を確かめる。口の無いサーバの `index.html` や、別の口の JSON を通さない */
export function isOpenInView(value: unknown): value is OpenInView {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const view = value as Record<string, unknown>
  return (
    typeof view.same_machine === 'boolean' &&
    (view.same_machine_reason === null ||
      typeof view.same_machine_reason === 'string') &&
    isToolView(view.explorer) &&
    isToolView(view.vscode) &&
    Array.isArray(view.opened) &&
    view.opened.every(isOpenedView)
  )
}

function urlOf(host: string): string {
  return `/api/hosts/${encodeURIComponent(host)}/open`
}

/** いまの様子を聞く。 */
export async function fetchOpenIn(host: string): Promise<OpenInAnswer> {
  let response: Response
  try {
    response = await fetch(urlOf(host))
  } catch {
    return FAILED
  }
  if (response.status === 401) {
    useAuthStore.getState().markSignedOut()
    return SIGNED_OUT
  }
  if (
    response.status === 501 ||
    response.status === 404 ||
    response.status === 405
  ) {
    return null
  }
  if (!response.ok) {
    return FAILED
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null
  }
  return isOpenInView(body) ? body : null
}

/**
 * 開く。
 *
 * **体は必ず JSON で送る。** サーバは JSON でない体を 415 で断る（他のサイトのページが
 * 送れる「単純な要求」を塞ぐ門。設計§4-6）。断りの本文はそのまま `message` に出す。
 */
export async function postOpenIn(
  host: string,
  app: OpenApp,
  path: string,
): Promise<OpenAttempt> {
  let response: Response
  try {
    response = await fetch(urlOf(host), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app, path }),
    })
  } catch {
    return { ok: false, message: '送れませんでした。線が切れているかもしれません' }
  }
  if (response.status === 401) {
    useAuthStore.getState().markSignedOut()
    return { ok: false, message: 'ログインが切れています' }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return {
      ok: false,
      message: text.trim() === '' ? `開けませんでした（${response.status}）` : text,
    }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, message: '答えの形が違います' }
  }
  const result = body as Partial<OpenResult> | null
  if (
    result !== null &&
    typeof result === 'object' &&
    (result.outcome === 'launched' ||
      result.outcome === 'opened' ||
      result.outcome === 'fronted') &&
    isOpenInView(result.view)
  ) {
    return { ok: true, result: { outcome: result.outcome, view: result.view } }
  }
  return { ok: false, message: '答えの形が違います' }
}
