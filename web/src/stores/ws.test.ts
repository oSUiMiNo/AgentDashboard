import type { ClientMessage, ServerMessage } from '@/lib/protocol'
import { clearSessions, isReviving } from './sessions'
import { useWsStore } from './ws'

/**
 * 接続の作り直し（テスト計画フェーズ5「リロード復元」の単体側）。
 *
 * 確かめるのは「切れたあとに自分で戻ってこられるか」。ブラウザのリロードで戻ることは
 * E2E が見るので、ここでは**サーバが落ちて上がった**ときの振る舞いを固定する。
 * 実際の WebSocket は使えないので、開閉を手で操れる偽物に差し替えている。
 */

const CARD = 'aaaaaaaa-0000-0000-0000-000000000001'

/** 開閉をテストから操れる WebSocket。 */
class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static instances: FakeSocket[] = []

  readyState = FakeSocket.CONNECTING
  binaryType = 'blob'
  sent: string[] = []

  onopen: (() => void) | null = null
  /**
   * **本物と同じく `CloseEvent` を渡す。** 引数なしで呼ぶ形にしていると、
   * 切断の理由を読む実装を足した瞬間にここだけが落ちる（実際に落ちた）
   */
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    // こちらから閉じたので「きれいに閉じた」
    this.drop({ code: 1000, reason: '', wasClean: true })
  }

  /** サーバが受け入れた。 */
  accept() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  /** 接続が切れた（サーバが落ちた・回線が途切れた）。 */
  drop(how: { code: number; reason: string; wasClean: boolean } = { code: 1006, reason: '', wasClean: false }) {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.(how as CloseEvent)
  }

  /** このソケットが送った操作メッセージ。 */
  requests(): ClientMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientMessage)
  }

  /** サーバから1通届いた。 */
  deliver(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
}

/**
 * 叩かれた口。**数だけでは足りない。**
 *
 * 繋がった時点でサーバの版も聞きに行く（CICD設計§11）ので、全部まとめて数えると
 * 「全体像を取り直したか」を見ているつもりが別の口の呼び出しまで数えてしまう。
 */
let fetched: string[] = []

/** 全体像を取りに行った回数。 */
function snapshots(): number {
  return fetched.filter((url) => url.includes('/api/sessions')).length
}

beforeEach(() => {
  clearSessions()
  FakeSocket.instances = []
  fetched = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(String(url))
    return { ok: true, json: async () => [] } as unknown as Response
  })
})

afterEach(() => {
  useWsStore.getState().disconnect()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearSessions()
})

/** 直近のソケット。 */
function latest(): FakeSocket {
  const socket = FakeSocket.instances.at(-1)
  if (!socket) {
    throw new Error('ソケットがまだ作られていません')
  }
  return socket
}

describe('WebSocket ストア', () => {
  it('全体像を取ってから接続する', async () => {
    // 逆順だと、遅れて届いたスナップショットが差分を古い値で上書きする
    await useWsStore.getState().connect()

    expect(snapshots()).toBe(1)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(latest().url).toMatch(/\/ws$/)

    latest().accept()
    expect(useWsStore.getState().status).toBe('open')
  })

  it('落ちたら待ってから繋ぎ直す', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    latest().drop()
    expect(useWsStore.getState().status).toBe('closed')
    // すぐには繋ぎ直さない（落ちたサーバを叩き続けない）
    expect(FakeSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(snapshots()).toBe(2)
  })

  it('繋がるたびにサーバの版を聞き直す', async () => {
    // 版を切り替えるとサーバごと入れ替わる。**繋ぎ直した瞬間**が、画面のほうが
    // 古いと気づける唯一の機会になる（CICD設計§11）
    await useWsStore.getState().connect()
    latest().accept()

    expect(fetched.filter((url) => url.includes('/api/me'))).toHaveLength(1)
  })

  it('繋がらないうちは待ち時間を伸ばす', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    latest().drop()
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeSocket.instances).toHaveLength(2)

    // 2回目の失敗。1秒待つので、500ms では次が始まらない
    latest().drop()
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeSocket.instances).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(500)
    expect(FakeSocket.instances).toHaveLength(3)
  })

  it('繋ぎ直したら開いていた購読を出し直す', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    const store = useWsStore.getState()
    store.subscribeTerminal(CARD, 100, 40, () => {})
    store.subscribeTranscript(CARD)
    // 端末の大きさが変わったら台帳も追随する
    store.resize(CARD, 120, 50)

    latest().drop()
    await vi.advanceTimersByTimeAsync(500)
    const reconnected = latest()
    reconnected.accept()

    const requests = reconnected.requests()
    expect(requests).toContainEqual({
      t: 'sub_pty',
      card_id: CARD,
      cols: 120,
      rows: 50,
    })
    expect(requests).toContainEqual({ t: 'sub_transcript', card_id: CARD })
  })

  it('画面から外した購読は出し直さない', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    const stop = useWsStore.getState().subscribeTerminal(CARD, 80, 24, () => {})
    stop()

    latest().drop()
    await vi.advanceTimersByTimeAsync(500)
    latest().accept()

    expect(latest().requests()).toHaveLength(0)
  })

  it('自分から切ったときは繋ぎ直さない', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    useWsStore.getState().disconnect()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(FakeSocket.instances).toHaveLength(1)
    expect(useWsStore.getState().status).toBe('closed')
  })
})

/**
 * 起こし直しの頼みと、失敗の行き先（復旧設計§4-1・§9-4・§9-5）。
 *
 * ここで固定するのは3つ——**運ぶのはカードIDだけ**であること、**送れたときだけ
 * 印を立てる**こと、**失敗の行き先を種別ではなく名指しの有無で決める**こと。
 */
describe('起こし直しの頼み', () => {
  it('運ぶのはカードIDだけ', async () => {
    // 作業ディレクトリや権限モードを載せると、**古い写しで起こし直す**経路ができる
    await useWsStore.getState().connect()
    latest().accept()

    useWsStore.getState().revive(CARD)

    expect(latest().requests()).toEqual([
      { t: 'revive_session', card_id: CARD },
    ])
  })

  it('繋がっていなければ印を立てない', () => {
    // 届いていない頼みを待ち続けることになる（「復旧中…」のまま押せなくなる）
    useWsStore.getState().revive(CARD)

    expect(useWsStore.getState().status).toBe('closed')
    expect(isReviving(CARD)).toBe(false)
  })

  it('カードを名指しした失敗は、画面全体の帯に出さない', async () => {
    // 行き先を決めるのは**種別ではなく名指しの有無**。こうしておけば、名指しできる
    // 失敗を持つ経路が増えてもここを直さずに済む（設計§9-5）
    await useWsStore.getState().connect()
    latest().accept()

    latest().deliver({
      t: 'error',
      card_id: CARD,
      message: 'この PC が繋がっていません',
    })

    expect(useWsStore.getState().lastError).toBeNull()
  })

  it('名指しの無い失敗は、いままでどおり帯に出す', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    latest().deliver({
      t: 'error',
      card_id: null,
      message: '起動できませんでした',
    })

    expect(useWsStore.getState().lastError).toBe('起動できませんでした')
  })
})

/**
 * 起こし直したあとに、購読を出し直すか（イシュー
 * `電源ボタンで起こし直すと、ターミナルがリロードするまで描かれない`）。
 *
 * **線は最初から最後まで健康なまま**なので `onopen` は起きない。それでも実体は
 * 入れ替わっているので、購読を出し直さないとサーバ側に汲む者が居ないままになる。
 * ここで見るのは「状態の移り変わりを合図にできているか」だけである。
 */
describe('起こし直しと購読', () => {
  /** そのカードが `status` を1通受け取ったことにする。 */
  function status(kind: 'working' | 'waiting_input', ok = true) {
    latest().deliver({
      t: 'status',
      card_id: CARD,
      status: kind === 'working' ? { kind: 'working' } : { kind: 'waiting_input' },
      subagent_active: 0,
      last_activity_at: 0,
    })
    void ok
  }

  /** そのカードが止まったことにする。 */
  function ended() {
    latest().deliver({
      t: 'status',
      card_id: CARD,
      status: { kind: 'ended', ok: true },
      subagent_active: 0,
      last_activity_at: 0,
    })
  }

  /** 購読したあとに送られたものだけを見る。 */
  function 購読を出し直したか(): ClientMessage[] {
    return latest()
      .requests()
      .filter((request) => request.t === 'sub_pty' || request.t === 'sub_transcript')
  }

  async function 開いて購読する() {
    await useWsStore.getState().connect()
    latest().accept()
    const store = useWsStore.getState()
    store.subscribeTerminal(CARD, 120, 50, () => {})
    store.subscribeTranscript(CARD)
    // 購読そのものが送った2通を数えないよう、ここまでを捨てる
    latest().sent = []
  }

  it('止まっていたカードが動き出したら、端末と履歴を出し直す', async () => {
    await 開いて購読する()

    ended()
    status('working')

    expect(購読を出し直したか()).toEqual([
      { t: 'sub_pty', card_id: CARD, cols: 120, rows: 50 },
      { t: 'sub_transcript', card_id: CARD },
    ])
  })

  it('動いている間は出し直さない', async () => {
    // 出し直すたびに画面を作り直すので、状態が届くたびに出すと明滅する
    await 開いて購読する()

    status('working')
    status('waiting_input')
    status('working')

    expect(購読を出し直したか()).toEqual([])
  })

  it('初めて見るカードでは出し直さない', async () => {
    // 購読した直後にもう一度出すことになる（購読自体が `sub_pty` を送っている）
    await 開いて購読する()

    status('working')

    expect(購読を出し直したか()).toEqual([])
  })

  it('開いていない口には送らない', async () => {
    await useWsStore.getState().connect()
    latest().accept()
    // 端末だけ開き、履歴は開いていない
    useWsStore.getState().subscribeTerminal(CARD, 80, 24, () => {})
    latest().sent = []

    ended()
    status('working')

    expect(購読を出し直したか()).toEqual([
      { t: 'sub_pty', card_id: CARD, cols: 80, rows: 24 },
    ])
  })

  it('何も見ていないカードでは何も送らない', async () => {
    await useWsStore.getState().connect()
    latest().accept()
    latest().sent = []

    ended()
    status('working')

    expect(購読を出し直したか()).toEqual([])
  })

  it('繰り返し止めて起こしても、そのつど出し直す', async () => {
    // 短い間に何度も押したときに取りこぼさないこと（要件の確かめ方）
    await 開いて購読する()

    ended()
    status('working')
    ended()
    status('working')

    expect(購読を出し直したか().filter((r) => r.t === 'sub_pty')).toHaveLength(2)
  })

  it('カード全体が届く形（session_upsert）でも合図になる', async () => {
    // 起こし直しでは状態以外も変わるので、こちらで届くことがある
    await 開いて購読する()

    ended()
    latest().deliver({
      t: 'session_upsert',
      session: {
        card_id: CARD,
        project: '/tmp/x',
        claude_session_id: null,
        permission_mode: null,
        model: null,
        model_label: null,
        model_requested: null,
        status: { kind: 'starting' },
        subagent_active: 0,
        last_activity_at: 0,
        last_assistant_message: null,
        created_at: 0,
        hooks_seen: false,
        agent_id: null,
        agent_connected: true,
        account: null,
        toml_account: null,
        session_title: null,
        position: 0,
        nickname: null,
      },
    })

    expect(購読を出し直したか()).toContainEqual({
      t: 'sub_pty',
      card_id: CARD,
      cols: 120,
      rows: 50,
    })
  })

  it('繋ぎ直したあとは、直前の生死を引きずらない', async () => {
    // `onopen` が全部出し直すので、そのあとに状態が1通来ただけで
    // もう一度出すと画面が明滅する
    await 開いて購読する()
    ended()

    latest().drop()
    await vi.advanceTimersByTimeAsync(500)
    latest().accept()
    // 繋ぎ直しの出し直しぶんを捨てる
    latest().sent = []

    status('working')

    expect(購読を出し直したか()).toEqual([])
  })
})
