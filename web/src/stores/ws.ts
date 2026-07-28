/**
 * サーバとの WebSocket 接続と、そこから届くセッション一覧の保持（設計§10）。
 *
 * # PTY のバイトを React の状態に入れない
 *
 * ターミナルの出力は毎秒100フレーム規模で届く。これを React の状態にすると再レンダリングが
 * 追いつかず、体感速度が一気に落ちる。そこで**バイナリフレームは購読者へ直接渡す**
 * （[`subscribeTerminal`] で登録したコールバック）。React の状態に載せるのは、
 * 更新頻度の低い接続状態とセッション一覧だけ。
 *
 * # 一覧は「REST で全体 → WS で差分」
 *
 * 接続するとき、まず `GET /api/sessions` で現在の全体像を取り、そのあとに WebSocket を
 * 開く（設計§4）。順序を逆にすると、遅れて届いた REST の結果が新しい状態を古い値で
 * 上書きしてしまう。真実は常にサーバ側にあり、ブラウザはその写しを持つだけ。
 *
 * 自動再接続はフェーズ4の担当。ここでは切れたことを画面に出すところまで。
 */

import { create } from 'zustand'
import { KIND_PTY_INPUT, decodeFrame, encodeFrame } from '@/lib/frame'
import type {
  CardId,
  ClientMessage,
  FlowState,
  ServerMessage,
  SessionMeta,
} from '@/lib/protocol'

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

/**
 * ターミナル1つ分の受け取り口。
 *
 * `kind` に届くのは [`KIND_PTY_OUTPUT`]（書き足す）か [`KIND_PTY_SNAPSHOT`]
 * （画面をリセットしてから書く）のどちらか。
 */
export type TerminalListener = (kind: number, payload: Uint8Array) => void

interface WsState {
  status: ConnectionStatus
  /** 作成順に並べたセッション一覧 */
  sessions: SessionMeta[]
  /** サーバから受け取ったフロー制御のしきい値（バイト） */
  flowHigh: number
  flowLow: number
  /** 直近の失敗。ユーザに見せたら消す */
  lastError: string | null

  connect: () => Promise<void>
  disconnect: () => void
  spawn: (cwd: string) => void
  kill: (cardId: CardId) => void
  archive: (cardId: CardId) => void
  resize: (cardId: CardId, cols: number, rows: number) => void
  setFlow: (cardId: CardId, state: FlowState) => void
  sendPtyInput: (cardId: CardId, data: Uint8Array) => void
  /** ターミナルの購読を始める。戻り値を呼ぶと購読を止める */
  subscribeTerminal: (
    cardId: CardId,
    cols: number,
    rows: number,
    listener: TerminalListener,
  ) => () => void
  clearError: () => void
}

/**
 * 接続そのものはモジュールに1つだけ持つ。
 *
 * React の状態に入れないのは、再レンダリングのたびに繋ぎ直す事故を避けるため。
 */
let socket: WebSocket | null = null

/** ターミナルの受け取り口。カードID → コールバック。 */
const terminalListeners = new Map<CardId, TerminalListener>()

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

/** 作成順を保ったまま1枚を差し替える（無ければ足す）。 */
function upsert(sessions: SessionMeta[], session: SessionMeta): SessionMeta[] {
  const index = sessions.findIndex((item) => item.card_id === session.card_id)
  if (index >= 0) {
    const next = sessions.slice()
    next[index] = session
    return next
  }
  return [...sessions, session].sort((a, b) => a.created_at - b.created_at)
}

export const useWsStore = create<WsState>((set) => ({
  status: 'closed',
  sessions: [],
  // サーバの hello が届くまでの暫定値（設計§12 の既定値と同じ）
  flowHigh: 256 * 1024,
  flowLow: 32 * 1024,
  lastError: null,

  connect: async () => {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      return
    }
    set({ status: 'connecting' })

    // 先に全体像を取ってから WebSocket を開く。逆順だと、遅れて届いた
    // スナップショットが差分より後に適用され、状態が巻き戻って見える
    await loadSnapshot(set)

    const next = new WebSocket(socketUrl())
    // PTY のバイトをコピーせず扱うために ArrayBuffer で受け取る
    next.binaryType = 'arraybuffer'
    socket = next

    next.onopen = () => set({ status: 'open' })
    next.onclose = () => {
      set({ status: 'closed' })
      terminalListeners.clear()
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
  },

  disconnect: () => {
    socket?.close()
    socket = null
    terminalListeners.clear()
    set({ status: 'closed' })
  },

  spawn: (cwd) => send({ t: 'spawn', cwd }),
  kill: (cardId) => send({ t: 'kill', card_id: cardId }),
  archive: (cardId) => send({ t: 'archive', card_id: cardId }),
  resize: (cardId, cols, rows) =>
    send({ t: 'resize', card_id: cardId, cols, rows }),
  setFlow: (cardId, state) => send({ t: 'pty_flow', card_id: cardId, state }),

  sendPtyInput: (cardId, data) => {
    if (socket?.readyState !== WebSocket.OPEN) {
      return
    }
    socket.send(encodeFrame(KIND_PTY_INPUT, cardId, data))
  },

  subscribeTerminal: (cardId, cols, rows, listener) => {
    terminalListeners.set(cardId, listener)
    send({ t: 'sub_pty', card_id: cardId, cols, rows })
    return () => {
      terminalListeners.delete(cardId)
      send({ t: 'unsub_pty', card_id: cardId })
    }
  },

  clearError: () => set({ lastError: null }),
}))

type SetState = (partial: Partial<WsState>) => void

/**
 * `GET /api/sessions` で現在の一覧を取り込む（設計§4 の初期スナップショット）。
 *
 * サーバが居ない状態でも画面は出したいので、失敗しても接続処理は続ける。
 */
async function loadSnapshot(set: SetState) {
  try {
    const response = await fetch('/api/sessions')
    if (!response.ok) {
      return
    }
    set({ sessions: (await response.json()) as SessionMeta[] })
  } catch {
    // 接続できないこと自体は WebSocket 側の onerror で画面に出る
  }
}

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
      set({ sessions: upsert(useWsStore.getState().sessions, message.session) })
      break
    case 'session_removed':
      set({
        sessions: useWsStore
          .getState()
          .sessions.filter((item) => item.card_id !== message.card_id),
      })
      break
    case 'status':
      // 状態だけの差分。フックはツールコールのたびに飛んでくるので、
      // カード全体を送り直すのはそれ以外が変わったときに限られる（設計§4）
      set({
        sessions: useWsStore.getState().sessions.map((item) =>
          item.card_id === message.card_id
            ? {
                ...item,
                status: message.status,
                subagent_active: message.subagent_active,
                last_activity_at: message.last_activity_at,
              }
            : item,
        ),
      })
      break
    case 'error':
      set({ lastError: message.message })
      break
    default:
      // フェーズ3以降で実装する種別。届いても落ちないように黙って受け流す
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
  terminalListeners.get(frame.cardId)?.(frame.kind, frame.payload)
}
