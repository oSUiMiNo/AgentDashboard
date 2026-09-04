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
 *
 * # 出し直す合図は2つある
 *
 * | 合図 | 何が起きた |
 * |---|---|
 * | 線が開いた（`onopen`） | 接続そのものが張り直された |
 * | **カードが止まりから動きへ移った**（[`noteLiveness`]） | **線は無事のまま、実体だけが入れ替わった** |
 *
 * 2つ目が要るのは、**起こし直しでカードIDが変わらない**ため。IDが同じだと接続も購読も
 * 健康に見えるが、サーバ側の運び手は古い擬似ターミナルと一緒に終わっている。
 * **線に何も起きないので `onopen` は来ない**——状態を見て自分で気づくしかない。
 */

import { create } from 'zustand'
import { report } from '@/lib/clientLogs'
import { KIND_PTY_INPUT, decodeFrame, encodeFrame } from '@/lib/frame'
import type {
  CardId,
  ClientMessage,
  FlowState,
  ModelId,
  PermissionMode,
  ServerMessage,
  SessionMeta,
  SessionStatus,
} from '@/lib/protocol'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import {
  applySessionSnapshot,
  markBranching,
  markReviving,
  patchSessionStatus,
  removeSession,
  setCardError,
  upsertSession,
} from '@/stores/sessions'
import { loadProjects, removeProject, upsertProject } from '@/stores/projects'
import {
  markAllRead,
  pushBrowserNotice,
  pushReplyNotice,
  pushSelfhealNotice,
  pushServerNotice,
} from '@/stores/appNotices'
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
  /** 構造化ビューの健康状態。縮退していてもターミナルは動く（設計§11） */
  parserState: 'ok' | 'degraded'
  parserDetail: string | null
  /**
   * インスタンスの間の連絡係の健康状態（セルフホスト化設計§12）。
   *
   * 縮退しても**このサーバの中で完結する更新は届き続ける**。止まるのは、別のサーバに
   * 繋がっている PC の分だけ。連絡係を持たない構成では一度も届かないので `ok` のまま。
   */
  busState: 'ok' | 'degraded'
  busDetail: string | null

  connect: () => Promise<void>
  disconnect: () => void
  /**
   * セッションを起動する。
   *
   * `mode` を省略（`null`）すると CLI へ何も渡さない。利用者の `permissions.defaultMode`
   * を尊重するという意味なので、ここで既定のモードを補ってはいけない。
   */
  spawn: (
    cwd: string,
    mode?: PermissionMode | null,
    agentId?: string | null,
  ) => void
  /**
   * 走っているセッションの権限モードを切り替える（設計§6）。
   *
   * サーバが TUI へ Shift+Tab を送って目的のモードへ着くまで繰り返す。着けない場合は
   * `error` が返り、画面に理由が出る（巡回に入らないモードがあるため）。
   */
  setPermissionMode: (cardId: CardId, mode: PermissionMode) => void
  /**
   * 走っているセッションのモデルを切り替える（設計§5）。
   *
   * サーバが端末へ `/model <値>` を送る。会話が進んでいると CLI が確認を求めてくるので、
   * 着地まで数秒かかる。**送るのは別名**（`opus`）で、CLI が名乗り返すのはフルID
   * （`claude-opus-5`）なので一致しない。
   *
   * 楽観更新はここではしない。サーバが `model_requested` を立てて配信するので、
   * 手応えはそちらから届く。**ブラウザ側にも持つと2箇所が食い違う。**
   */
  setModel: (cardId: CardId, model: ModelId) => void
  kill: (cardId: CardId) => void
  archive: (cardId: CardId) => void
  /**
   * 抜け殻のカードを、元の CLI セッションで起こし直す（復旧設計§4-1）。
   *
   * **運ぶのはカードIDだけ。** 作業ディレクトリも権限モードも呼び戻し先も記録が
   * 持っているので、ブラウザから渡すと**古い写しで起こし直す**経路ができる。
   *
   * `setModel` と違い**印を立てる**。あちらはサーバが `model_requested` を配って
   * くれるが、こちらは**席が空くまでカードが1バイトも変わらない**（§9-4）。
   */
  revive: (cardId: CardId) => void
  /**
   * 会話を枝分かれさせ、元の会話を隣の席へ呼び戻す（ブランチ設計§7-4）。
   *
   * **運ぶのはカードIDだけ。** 元の会話のIDはサーバが記録から引く。
   *
   * `revive` と同じく**印を立てる**——段取りには2回の待ちがあり、その間カードは
   * 1バイトも変わらないので、押した手応えが無いと二度押しされる。**元の会話のIDを
   * 一緒に控える**のは、失敗したときの断りへ「もう一度呼び戻す」を出すため
   * （§4-3。押した時点の写しからしか取れない）。
   */
  branch: (cardId: CardId, claudeSessionId: string | null) => void
  /**
   * カードに付いている CLI セッションへ、利用者の名前を付ける（名前付け設計§9-5）。
   *
   * **楽観更新しない。** 手元を先に書き換えず、サーバが配る `session_upsert` で
   * 変わるのを待つ——ブラウザ側にも持つと2箇所が食い違う（`setModel` と同じ流儀）。
   *
   * `nickname` が `null` なら消す。
   */
  setNickname: (cardId: CardId, nickname: string | null) => void
  /**
   * 過去の CLI セッションを指定して、新しいカードで起こす（名前付け設計§9-4）。
   *
   * **カードIDを運ばない**（カードはまだ無い）。作業ディレクトリも運ばない——
   * サーバの記録が持っている。
   */
  recall: (
    claudeSessionId: string,
    mode?: PermissionMode | null,
    agentId?: string | null,
  ) => void
  resize: (cardId: CardId, cols: number, rows: number) => void
  setFlow: (cardId: CardId, state: FlowState) => void
  sendPtyInput: (cardId: CardId, data: Uint8Array) => void
  /** Composer からの指示送信。改行の扱いはサーバ側で決まる（設計§6） */
  /** 指示を送る。**送れたら真**（入力欄が書きかけを消してよいかの判断に使う） */
  /**
   * 指示を1つ送る。`attachments` は**置き終わった添付の絶対パス**（画像添付 設計§6）。
   *
   * 運ぶのはパスだけで、画像そのものは先に REST で置いてある。
   */
  sendInput: (
    cardId: CardId,
    text: string,
    attachments?: string[],
  ) => boolean
  /** ターミナルの購読を始める。戻り値を呼ぶと購読を止める */
  subscribeTerminal: (
    cardId: CardId,
    cols: number,
    rows: number,
    listener: TerminalListener,
  ) => () => void
  /** 履歴の購読を始める。戻り値を呼ぶと購読を止める */
  subscribeTranscript: (cardId: CardId) => () => void
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

/**
 * カードごとの「前に見たとき生きていたか」。購読を出し直す合図を作るためだけに持つ。
 *
 * 起こし直しでは**カードIDが変わらない**ので、ブラウザもサーバも「同じカードだから
 * 購読も生きている」と扱ってしまう。実際にはサーバ側の運び手は古い擬似ターミナルが
 * 閉じた時点で終わっており、新しい実体のバイトを汲む者が居ない。**線は健康なままなので
 * `onopen` も起きず、購読は二度と出し直されない。**
 *
 * 状態を見て自分で気づくしかないのはこのためで、ここが唯一の合図になる。
 */
const alive = new Map<CardId, boolean>()

/** 自分から切ったのか、落ちたのか。落ちたときだけ繋ぎ直す。 */
let closedByUs = false
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retryAttempt = 0

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

/**
 * 1通送る。**送れたかを返す。**
 *
 * 繋がっていなければ黙って捨てるのは従来どおりだが、**捨てたことを呼び手が知れる**
 * ようにした。入力欄の書きかけは「送信に成功したら消し、失敗したら残す」という約束を
 * 持っており（十字ボタン設計§11）、送れたかどうかが分からないと**送れていない文を
 * 消してしまう**——いちばん困る形になる。
 */
function send(message: ClientMessage): boolean {
  if (socket?.readyState !== WebSocket.OPEN) {
    return false
  }
  socket.send(JSON.stringify(message))
  return true
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
    if (response.status === 401) {
      // **401 は障害ではない。** 入館証が切れただけなので、赤いバナーを出さずに
      // ログイン画面へ戻す（バナーを出しても利用者にできることが無い）
      useAuthStore.getState().markSignedOut()
      return
    }
    if (!response.ok) {
      return
    }
    applySessionSnapshot((await response.json()) as SessionMeta[])
    // 枠も同じ契機で取り直す。**カードと枠が揃って初めて一覧の箱が作れる**（設計§13）
    void loadProjects()
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
  // **ここで全部出し直すので、それ以前の生死は用済み。** 残すと、切れている間に
  // 起こし直されたカードで「出し直したばかりなのにもう一度出す」が起きて画面が明滅する
  alive.clear()
  for (const [cardId, entry] of terminals) {
    send({ t: 'sub_pty', card_id: cardId, cols: entry.cols, rows: entry.rows })
  }
  for (const cardId of transcripts) {
    send({ t: 'sub_transcript', card_id: cardId })
  }
}

/**
 * 1枚ぶんだけ購読を出し直す。開いていない口には何も送らない。
 *
 * [`resubscribe`] と同じことを1枚に絞ってやる。**どちらもサーバが持っている内容で
 * 作り直す**ので、`sub_pty` にはスクロールバックのスナップショットが、`sub_transcript`
 * には作り直しの指示に続けて手元ぶんが返る。
 */
function resubscribeCard(cardId: CardId) {
  const entry = terminals.get(cardId)
  if (entry) {
    send({ t: 'sub_pty', card_id: cardId, cols: entry.cols, rows: entry.rows })
  }
  if (transcripts.has(cardId)) {
    send({ t: 'sub_transcript', card_id: cardId })
  }
}

/**
 * カードの生死を見て、**止まっていたものが動き出したら購読を出し直す**。
 *
 * # なぜ「変わった瞬間」だけなのか
 *
 * `sub_pty` の応答はスクロールバックのスナップショットで、受け取った端末は画面を
 * 作り直す。**動いている間ずっと出し直すと、状態が届くたびに画面が明滅する。**
 * 出し直すのは実体が入れ替わったときだけでよい。
 *
 * # なぜ最初の1回では出し直さないのか
 *
 * 初めて見るカードは、まだ生きていたかどうかを知らない。ここで出し直すと、
 * **購読した直後にもう一度出す**ことになる（購読自体が `sub_pty` を送っている）。
 * したがって前の値を持っていないときは覚えるだけにする。
 */
function noteLiveness(cardId: CardId, status: SessionStatus) {
  const now = status.kind !== 'ended'
  const before = alive.get(cardId)
  alive.set(cardId, now)
  if (before === false && now) {
    resubscribeCard(cardId)
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
    set({ status: 'open' })
    // 開き直したときに台帳の購読を出し直す。初回は台帳が空なので何も起きない
    resubscribe()
    // **繋がった相手の版を聞き直す**（CICD設計§11）。版を切り替えるとサーバごと
    // 入れ替わるので、繋ぎ直した瞬間が「画面のほうが古い」と気づける唯一の機会になる
    void useAuthStore.getState().load()
  }

  next.onclose = (event) => {
    // 台帳は消さない。消すと繋ぎ直せても画面が二度と更新されない
    set({ status: 'closed' })
    // **切れたことをログへ残す**（設計§12-1）。画面には出さない——切断は繋ぎ直しで
    // 解消するのが普通なので、そのたびにバナーを出す意味は無い。だが「あのとき
    // 切れていた」を後から言えないと、原因追跡がそこで止まる
    report('ws_close', event.wasClean ? 'INFO' : 'WARN', 'WebSocket が切れました', {
      stack: `code=${event.code} reason=${event.reason} wasClean=${event.wasClean}`,
    })
    scheduleReconnect(set)
  }

  next.onerror = () => {
    // **ブラウザ自身の気づき**（トーストとベル設計§6-3）。サーバへ届いていないので
    // 記録に残しようがなく、リロードで消える
    pushBrowserNotice('サーバへ接続できません。起動しているか確認してください')
    // `onerror` の `Event` は理由を持たない（仕様でそう決まっている）。
    // **分からなかったことを、分かる形で残す**
    report('ws_error', 'ERROR', 'WebSocket でエラーが起きました（理由は通知されません）')
  }

  next.onmessage = (event) => {
    if (typeof event.data === 'string') {
      handleJson(event.data, set)
      return
    }
    handleBinary(event.data as ArrayBuffer)
  }
}

export const useWsStore = create<WsState>((set) => ({
  status: 'closed',
  // サーバの hello が届くまでの暫定値（設計§12 の既定値と同じ）
  flowHigh: 256 * 1024,
  flowLow: 32 * 1024,
  parserState: 'ok',
  parserDetail: null,
  busState: 'ok',
  busDetail: null,

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
    alive.clear()
    set({ status: 'closed' })
  },

  spawn: (cwd, mode = null, agentId = null) =>
    // 宛先は**選ばれているときだけ**載せる。載せない形（1台構成・ローカル）と
    // 同じ JSON になるよう、null のときはキーごと省く（`protocol.test.ts` が
    // その形を固定している）
    send(
      agentId === null
        ? { t: 'spawn', cwd, permission_mode: mode }
        : { t: 'spawn', cwd, permission_mode: mode, agent_id: agentId },
    ),
  setPermissionMode: (cardId, mode) =>
    send({ t: 'set_permission_mode', card_id: cardId, mode }),

  setModel: (cardId, model) => send({ t: 'set_model', card_id: cardId, model }),
  kill: (cardId) => send({ t: 'kill', card_id: cardId }),
  archive: (cardId) => send({ t: 'archive', card_id: cardId }),

  revive: (cardId) => {
    if (!send({ t: 'revive_session', card_id: cardId })) {
      // 繋がっていないのに印を立てると、届いていない頼みを待ち続けることになる
      return
    }
    markReviving(cardId)
  },

  branch: (cardId, claudeSessionId) => {
    if (!send({ t: 'branch_session', card_id: cardId })) {
      // `revive` と同じ。届いていない頼みを待ち続けさせない
      return
    }
    markBranching(cardId, claudeSessionId)
  },

  setNickname: (cardId, nickname) => {
    send({ t: 'set_nickname', card_id: cardId, nickname })
  },

  recall: (claudeSessionId, mode = null, agentId = null) =>
    // 宛先は**選ばれているときだけ**載せる（`spawn` と同じ形）。null のときは
    // キーごと省く——`protocol.test.ts` がその形を固定している
    send(
      agentId === null || agentId === undefined
        ? {
            t: 'recall_session',
            claude_session_id: claudeSessionId,
            permission_mode: mode ?? null,
          }
        : {
            t: 'recall_session',
            claude_session_id: claudeSessionId,
            permission_mode: mode ?? null,
            agent_id: agentId,
          },
    ),

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
  sendInput: (cardId, text, attachments) =>
    send({ t: 'send_input', card_id: cardId, text, attachments }),

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


}))

function handleJson(raw: string, set: SetState) {
  let message: ServerMessage
  try {
    message = JSON.parse(raw) as ServerMessage
  } catch {
    // **この接続への返事**（設計§4-2 の6箇所のうち、ブラウザ側で気づくぶん）
    pushReplyNotice(`サーバから解釈できない応答が届きました: ${raw}`)
    return
  }

  switch (message.t) {
    case 'hello':
      set({ flowHigh: message.flow_high, flowLow: message.flow_low })
      break
    case 'session_upsert':
      upsertSession(message.session)
      // 起こし直しは線に触らないので、**状態を見て自分で気づくしかない**
      noteLiveness(message.session.card_id, message.session.status)
      // 別名の実測はサーバが覚えるので、**切り替えた直後は画面の手元が古い**。
      // 知らないモデルを見たら設定を取り直す（設計§12）
      useSettingsStore.getState().noteModelSeen(message.session.model)
      break
    case 'session_removed':
      removeSession(message.card_id)
      // 台帳に残すと、同じIDが二度と来ないのに死んだ値を持ち続ける
      alive.delete(message.card_id)
      break
    case 'status':
      // 状態だけの差分。フックはツールコールのたびに飛んでくるので、
      // カード全体を送り直すのはそれ以外が変わったときに限られる（設計§4）
      patchSessionStatus(message)
      noteLiveness(message.card_id, message.status)
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
    case 'bus_status':
      set({ busState: message.state, busDetail: message.detail })
      break
    case 'selfheal':
      // **押し出さずに積む**（設計§6-2）。かつては単一スロットで、新しい段階が
      // 届くと前のものが黙って消えていた
      pushSelfhealNotice(message.phase, message.detail)
      break
    case 'project_upsert':
      // 枠は**書けてから配られる**（設計§11）。押した瞬間に手元へ足さないので、
      // ここが唯一の反映点になる
      upsertProject(message.project)
      break
    case 'project_removed':
      removeProject(message.project_id)
      break
    case 'notice_created':
      // **記録に載ったもの。** 未読の数はサーバが数えたぶんを使う（設計§6-1）
      pushServerNotice(message.notice, message.unread_count)
      break
    case 'notice_read':
      // 別のタブや端末で既読にされた。**バッジを揃える**
      markAllRead(message.read_at)
      break
    case 'error':
      // **行き先を決めるのは種別ではなく名指しの有無**（復旧設計§9-5）。こうしておけば、
      // 名指しできる失敗を持つ経路が増えても、ここを直さずに済む
      if (message.card_id === null) {
        // **捨てていた種別を拾う。** これまでは文言だけを取って帯へ出していた
        // （設計§12-1）。合流点を通ったものは `notice_created` が別に届くので、
        // ここで積むのは**この接続への返事**（`ws.rs` の6箇所）だけになる
        pushReplyNotice(message.message, message.kind ?? 'other')
      } else {
        // **種別は運ばれてこないことがある**（欄を持たない古いサーバ）。既定は `other` で、
        // 5秒で消える側に落ちる（細かい修正 設計§7-2）
        setCardError(message.card_id, message.message, message.kind ?? 'other')
      }
      break
  }
}

function handleBinary(buffer: ArrayBuffer) {
  let frame
  try {
    frame = decodeFrame(buffer)
  } catch (error) {
    // ブラウザ自身の気づき（受け取ったものを解けなかった）
    pushBrowserNotice(`壊れたフレームを受け取りました: ${String(error)}`)
    return
  }
  if (frame.kind === KIND_PTY_INPUT) {
    // 入力フレームはブラウザ→サーバの向きにしか存在しない
    return
  }
  terminals.get(frame.cardId)?.listener(frame.kind, frame.payload)
}
