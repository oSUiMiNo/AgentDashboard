/**
 * サーバとの WebSocket 接続（設計§10・§11）。
 *
 * # 届いたものを3つの行き先に振り分ける
 *
 * | 届くもの | 行き先 |
 * |---|---|
 * | PTY のバイナリフレーム | [`WsState.subscribeTerminal`] で登録した受け取り口へ直接 |
 * | セッションの増減と状態 | [`@/stores/sessions`]（rAF でまとめてカード単位に通知） |
 * | 履歴のノード | [`@/stores/transcript`] |
 *
 * どれも **React の状態には載せない**。ターミナルの出力は毎秒100フレーム規模、状態は
 * ツールコールのたびに届くので、React の再レンダリングを通すと追いつかない。
 * ここが React の状態として持つのは、接続の様子のように更新頻度が低いものだけ。
 *
 * # 復元はいつも同じ手順
 *
 * 「REST で全体を取る → WebSocket を開く → 開いていた購読を出し直す」。この順序は
 * **初回接続・ブラウザのリロード・自動再接続のすべてで同じ**（設計§4/§11）。
 * 逆順にすると、遅れて届いた REST の結果が新しい差分を古い値で上書きしてしまう。
 * 真実は常にサーバ側にあり、ブラウザはその写しを持つだけなので、迷ったら取り直す。
 *
 * # 購読は接続ではなくストアが覚えている
 *
 * どのカードのターミナル・履歴を見ているかは**モジュールが持つ台帳**にある。接続が
 * 切れても台帳は消えないので、繋ぎ直したあとに同じ購読を出し直せる。台帳を持たずに
 * 「送ったら忘れる」ようにすると、再接続はできても画面が二度と更新されない。
 */

import { create } from 'zustand'
import { KIND_PTY_INPUT, decodeFrame, encodeFrame } from '@/lib/frame'
import type {
  CardId,
  ClientMessage,
  FlowState,
  PermissionMode,
  SelfhealPhase,
  ServerMessage,
  SessionMeta,
} from '@/lib/protocol'
import {
  applySessionSnapshot,
  patchSessionStatus,
  removeSession,
  upsertSession,
} from '@/stores/sessions'
import { appendNodes, resetTranscript } from '@/stores/transcript'

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

/**
 * ターミナル1つ分の受け取り口。
 *
 * `kind` に届くのは [`KIND_PTY_OUTPUT`]（書き足す）か [`KIND_PTY_SNAPSHOT`]
 * （画面をリセットしてから書く）のどちらか。
 */
export type TerminalListener = (kind: number, payload: Uint8Array) => void

/** 再接続の待ち時間。倍々に伸ばして上限で頭打ちにする。 */
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 10_000

interface WsState {
  status: ConnectionStatus
  /** サーバから受け取ったフロー制御のしきい値（バイト） */
  flowHigh: number
  flowLow: number
  /** 直近の失敗。ユーザに見せたら消す */
  lastError: string | null
  /** 構造化ビューの健康状態。縮退していてもターミナルは動く（設計§11） */
  parserState: 'ok' | 'degraded'
  parserDetail: string | null
  /**
   * 自己修復の進み具合（設計§9）。まだ一度も起きていなければ null。
   *
   * 履歴を持たず**最新の1件だけ**にしてある。ここは「いま何をしているか」を伝える
   * ための表示で、経過を追いたいときは修復セッション自体が一覧に出ている
   */
  selfheal: { phase: SelfhealPhase; detail: string | null } | null

  connect: () => Promise<void>
  disconnect: () => void
  /**
   * セッションを起動する。
   *
   * `mode` を省略（`null`）すると CLI へ何も渡さない。利用者の `permissions.defaultMode`
   * を尊重するという意味なので、ここで既定のモードを補ってはいけない。
   */
  spawn: (cwd: string, mode?: PermissionMode | null) => void
  /**
   * 走っているセッションの権限モードを切り替える（設計§6）。
   *
   * サーバが TUI へ Shift+Tab を送って目的のモードへ着くまで繰り返す。着けない場合は
   * `error` が返り、画面に理由が出る（巡回に入らないモードがあるため）。
   */
  setPermissionMode: (cardId: CardId, mode: PermissionMode) => void
  kill: (cardId: CardId) => void
  archive: (cardId: CardId) => void
  resize: (cardId: CardId, cols: number, rows: number) => void
  setFlow: (cardId: CardId, state: FlowState) => void
  sendPtyInput: (cardId: CardId, data: Uint8Array) => void
  /** Composer からの指示送信。改行の扱いはサーバ側で決まる（設計§6） */
  sendInput: (cardId: CardId, text: string) => void
  /** ターミナルの購読を始める。戻り値を呼ぶと購読を止める */
  subscribeTerminal: (
    cardId: CardId,
    cols: number,
    rows: number,
    listener: TerminalListener,
  ) => () => void
  /** 履歴の購読を始める。戻り値を呼ぶと購読を止める */
  subscribeTranscript: (cardId: CardId) => () => void
  clearError: () => void
  clearSelfheal: () => void
}

/**
 * 接続そのものはモジュールに1つだけ持つ。
 *
 * React の状態に入れないのは、再レンダリングのたびに繋ぎ直す事故を避けるため。
 */
let socket: WebSocket | null = null

/** 開いているターミナルの台帳。カードID → 受け取り口と端末の大きさ。 */
interface TerminalEntry {
  listener: TerminalListener
  cols: number
  rows: number
}
const terminals = new Map<CardId, TerminalEntry>()

/** 開いている履歴の台帳。 */
const transcripts = new Set<CardId>()

/** 自分から切ったのか、落ちたのか。落ちたときだけ繋ぎ直す。 */
let closedByUs = false
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retryAttempt = 0

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

function send(message: ClientMessage) {
  if (socket?.readyState !== WebSocket.OPEN) {
    return
  }
  socket.send(JSON.stringify(message))
}

type SetState = (partial: Partial<WsState>) => void

/**
 * `GET /api/sessions` で現在の一覧を取り込む（設計§4 の初期スナップショット）。
 *
 * サーバが居ない状態でも画面は出したいので、失敗しても接続処理は続ける。
 */
async function loadSnapshot() {
  try {
    const response = await fetch('/api/sessions')
    if (!response.ok) {
      return
    }
    applySessionSnapshot((await response.json()) as SessionMeta[])
  } catch {
    // 接続できないこと自体は WebSocket 側の onerror で画面に出る
  }
}

/**
 * 台帳にある購読を出し直す。
 *
 * ターミナルは `sub_pty` の応答としてスクロールバックのスナップショットが届き、履歴は
 * `transcript_reset` に続けて手元ぶんが届く。どちらも**サーバが持っている内容で
 * 作り直す**ので、切れている間に進んだぶんも含めて画面が現在に追いつく。
 */
function resubscribe() {
  for (const [cardId, entry] of terminals) {
    send({ t: 'sub_pty', card_id: cardId, cols: entry.cols, rows: entry.rows })
  }
  for (const cardId of transcripts) {
    send({ t: 'sub_transcript', card_id: cardId })
  }
}

/** 落ちた接続を、待ち時間を伸ばしながら繋ぎ直す。 */
function scheduleReconnect(set: SetState) {
  if (closedByUs || retryTimer !== undefined) {
    return
  }
  const wait = Math.min(RECONNECT_BASE_MS * 2 ** retryAttempt, RECONNECT_MAX_MS)
  retryAttempt += 1
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    void openSocket(set)
  }, wait)
}

async function openSocket(set: SetState) {
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    return
  }
  set({ status: 'connecting' })

  // 先に全体像を取ってから WebSocket を開く。逆順だと、遅れて届いた
  // スナップショットが差分より後に適用され、状態が巻き戻って見える
  await loadSnapshot()

  const next = new WebSocket(socketUrl())
  // PTY のバイトをコピーせず扱うために ArrayBuffer で受け取る
  next.binaryType = 'arraybuffer'
  socket = next

  next.onopen = () => {
    retryAttempt = 0
    set({ status: 'open', lastError: null })
    // 開き直したときに台帳の購読を出し直す。初回は台帳が空なので何も起きない
    resubscribe()
  }

  next.onclose = () => {
    // 台帳は消さない。消すと繋ぎ直せても画面が二度と更新されない
    set({ status: 'closed' })
    scheduleReconnect(set)
  }

  next.onerror = () =>
    set({ lastError: 'サーバへ接続できません。起動しているか確認してください' })

  next.onmessage = (event) => {
    if (typeof event.data === 'string') {
      handleJson(event.data, set)
      return
    }
    handleBinary(event.data as ArrayBuffer, set)
  }
}

export const useWsStore = create<WsState>((set) => ({
  status: 'closed',
  // サーバの hello が届くまでの暫定値（設計§12 の既定値と同じ）
  flowHigh: 256 * 1024,
  flowLow: 32 * 1024,
  lastError: null,
  parserState: 'ok',
  parserDetail: null,
  selfheal: null,

  connect: async () => {
    closedByUs = false
    await openSocket(set)
  },

  disconnect: () => {
    closedByUs = true
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    retryAttempt = 0
    socket?.close()
    socket = null
    terminals.clear()
    transcripts.clear()
    set({ status: 'closed' })
  },

  spawn: (cwd, mode = null) =>
    send({ t: 'spawn', cwd, permission_mode: mode }),
  setPermissionMode: (cardId, mode) =>
    send({ t: 'set_permission_mode', card_id: cardId, mode }),
  kill: (cardId) => send({ t: 'kill', card_id: cardId }),
  archive: (cardId) => send({ t: 'archive', card_id: cardId }),

  resize: (cardId, cols, rows) => {
    // 台帳の大きさも更新する。繋ぎ直したときに古い大きさで購読し直さないため
    const entry = terminals.get(cardId)
    if (entry) {
      entry.cols = cols
      entry.rows = rows
    }
    send({ t: 'resize', card_id: cardId, cols, rows })
  },

  setFlow: (cardId, state) => send({ t: 'pty_flow', card_id: cardId, state }),
  sendInput: (cardId, text) => send({ t: 'send_input', card_id: cardId, text }),

  sendPtyInput: (cardId, data) => {
    if (socket?.readyState !== WebSocket.OPEN) {
      return
    }
    socket.send(encodeFrame(KIND_PTY_INPUT, cardId, data))
  },

  subscribeTerminal: (cardId, cols, rows, listener) => {
    terminals.set(cardId, { listener, cols, rows })
    send({ t: 'sub_pty', card_id: cardId, cols, rows })
    return () => {
      terminals.delete(cardId)
      send({ t: 'unsub_pty', card_id: cardId })
    }
  },

  // 履歴はターミナルと違い、受け取り口を渡さない。届いたノードは transcript ストアが
  // 直接受け取る（画面はそちらを購読する）
  subscribeTranscript: (cardId) => {
    transcripts.add(cardId)
    send({ t: 'sub_transcript', card_id: cardId })
    return () => {
      transcripts.delete(cardId)
      send({ t: 'unsub_transcript', card_id: cardId })
    }
  },

  clearError: () => set({ lastError: null }),

  clearSelfheal: () => set({ selfheal: null }),
}))

function handleJson(raw: string, set: SetState) {
  let message: ServerMessage
  try {
    message = JSON.parse(raw) as ServerMessage
  } catch {
    set({ lastError: `サーバから解釈できない応答が届きました: ${raw}` })
    return
  }

  switch (message.t) {
    case 'hello':
      set({ flowHigh: message.flow_high, flowLow: message.flow_low })
      break
    case 'session_upsert':
      upsertSession(message.session)
      break
    case 'session_removed':
      removeSession(message.card_id)
      break
    case 'status':
      // 状態だけの差分。フックはツールコールのたびに飛んでくるので、
      // カード全体を送り直すのはそれ以外が変わったときに限られる（設計§4）
      patchSessionStatus(message)
      break
    case 'transcript_append':
      appendNodes(message.card_id, message.nodes)
      break
    case 'transcript_reset':
      // 巻き戻り、または購読し直し。どちらも「作り直す」で正しい
      resetTranscript(message.card_id)
      break
    case 'parser_status':
      set({ parserState: message.state, parserDetail: message.detail })
      break
    case 'selfheal':
      set({ selfheal: { phase: message.phase, detail: message.detail } })
      break
    case 'error':
      set({ lastError: message.message })
      break
  }
}

function handleBinary(buffer: ArrayBuffer, set: SetState) {
  let frame
  try {
    frame = decodeFrame(buffer)
  } catch (error) {
    set({ lastError: `壊れたフレームを受け取りました: ${String(error)}` })
    return
  }
  if (frame.kind === KIND_PTY_INPUT) {
    // 入力フレームはブラウザ→サーバの向きにしか存在しない
    return
  }
  terminals.get(frame.cardId)?.listener(frame.kind, frame.payload)
}
