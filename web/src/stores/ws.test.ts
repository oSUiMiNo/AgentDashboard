import { GLOBAL_TARGET } from '@/lib/annotationTarget'
import type { ClientMessage, ServerMessage } from '@/lib/protocol'
import { clearSessions, getSession, getSessions, isReviving } from './sessions'
import { clearAppNotices, getAppNotices, unreadCount } from './appNotices'
import { clearMemos, memosFor } from './memos'
import { useWsStore } from './ws'
import { useSettingsStore } from './settings'
import { remoteAgent, settingsFixture } from '@/test/fixtures'

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
  clearAppNotices()
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
  clearMemos()
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

  /*
    **メモも出し直す**（レビュー対応3）。

    面を開いたままサーバが再起動すると、**古い一覧が残る**。切れている最中に開くと
    「まだ何も書かれていません。」という**嘘の空状態が永続する**——サーバには在るのに、
    画面だけが「無い」と言い続ける。
  */
  it('繋ぎ直したらメモも引き直す', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    useWsStore.getState().memoList(GLOBAL_TARGET)

    latest().drop()
    await vi.advanceTimersByTimeAsync(500)
    const reconnected = latest()
    reconnected.accept()

    expect(reconnected.requests()).toContainEqual({
      t: 'memo_list',
      target: GLOBAL_TARGET,
    })
  })

  it('閉じた面のメモは出し直さない（開いていない宛先まで引かない）', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    const store = useWsStore.getState()
    store.memoList(GLOBAL_TARGET)
    store.memoClose(GLOBAL_TARGET)

    latest().drop()
    await vi.advanceTimersByTimeAsync(500)
    const reconnected = latest()
    reconnected.accept()

    expect(
      reconnected.requests().filter((request) => request.t === 'memo_list'),
    ).toEqual([])
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

    // **名指しがあるものはそのカードへ。** アプリ全体の器へは積まれない
    expect(getAppNotices()).toHaveLength(0)
  })

  it('名指しの無い失敗は、この接続への返事として積まれる', async () => {
    // **帯から器へ移った**（トーストとベル設計§12-1）。合流点を通ったものは
    // `notice_created` が別に届くので、ここへ来るのは `ws.rs` が直接返した
    // ぶん——つまり「いまこのタブがやった操作への返事」だけになる
    await useWsStore.getState().connect()
    latest().accept()

    latest().deliver({
      t: 'error',
      card_id: null,
      message: '起動できませんでした',
      kind: 'revive',
    })

    const 溜まり = getAppNotices()
    expect(溜まり).toHaveLength(1)
    expect(溜まり[0]?.message).toBe('起動できませんでした')
    expect(溜まり[0]?.origin).toBe('reply')
    // **捨てていた種別を拾えるようになった**（設計§12-1）
    expect(溜まり[0]?.kind).toBe('revive')
  })

  it('記録に載った知らせは、未読の数と一緒に届く', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    latest().deliver({
      t: 'notice_created',
      notice: {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        source: 'selfheal',
        kind: 'swapped',
        message: 'パーサを差し替えました',
        created_at: Date.now(),
      },
      unread_count: 2,
    })

    expect(getAppNotices()[0]?.origin).toBe('server')
    // **サーバが数えたぶんを使う**（手元で数え直さない。設計§6-1）
    expect(unreadCount()).toBe(2)
  })

  it('自己修復は押し出さずに積まれる', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    latest().deliver({ t: 'selfheal', phase: 'detected', detail: null })
    latest().deliver({ t: 'selfheal', phase: 'repairing', detail: '1/3 回目' })

    // **かつては単一スロットで、前の段階が黙って消えていた**（設計§6-2）
    expect(getAppNotices().map((n) => n.kind)).toEqual(['detected', 'repairing'])
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
        resumed_from: null,
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
        branched_from: null,
        context_usage: null,
        rate_limits: null,
        cost: null,
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

/*
  **サーバが配っているものを、ブラウザが受け取れているか。**

  フェーズ3 が `ServerMessage::memos` を足したが、**`handleJson` の `switch` には
  `default:` も網羅検査も無い**。つまり腕を書き忘れても・後から消しても、
  **コンパイラも既存のテストも1本も落ちない**——メモは黙って捨てられ、画面には
  「1件も無い」と出る。実際にフェーズ3 の時点ではその状態だった。

  **これが「誰も捕まえない連動先」の実例そのものである。** だから腕の隣に、
  腕が在ることを見るテストを置く。
*/
describe('メモの受け取り', () => {
  it('宛先ぶんが丸ごと届き、手元へ入る', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    latest().deliver({
      t: 'memos',
      target: { t: 'global' },
      memos: [
        { id: 'm1', body: { text: 'あとで見る' }, noted_at: 1000 },
        { id: 'm2', body: { text: '片付けた' }, noted_at: 900, checked_at: 1100 },
      ],
    })

    const 手元 = memosFor({ t: 'global' })
    expect(手元).toHaveLength(2)
    // **サーバの順のまま。** 手元で並べ直していないことを、時刻の逆順で確かめる
    expect(手元.map((memo) => memo.id)).toEqual(['m1', 'm2'])
  })

  it('宛先ごとに別の箱へ入る', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    latest().deliver({
      t: 'memos',
      target: { t: 'global' },
      memos: [{ id: 'g1', body: {}, noted_at: 1 }],
    })
    latest().deliver({
      t: 'memos',
      target: { t: 'session', claude_session_id: 's-1' },
      memos: [{ id: 's1', body: {}, noted_at: 1 }],
    })

    expect(memosFor({ t: 'global' }).map((m) => m.id)).toEqual(['g1'])
    expect(
      memosFor({ t: 'session', claude_session_id: 's-1' }).map((m) => m.id),
    ).toEqual(['s1'])
    // **別のセッションには出ない**（要件の確かめ方）
    expect(memosFor({ t: 'session', claude_session_id: 's-2' })).toHaveLength(0)
  })

  it('あとから届いたぶんで置き換える（足し込まない）', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    latest().deliver({
      t: 'memos',
      target: { t: 'global' },
      memos: [{ id: 'a', body: {}, noted_at: 1 }],
    })
    latest().deliver({
      t: 'memos',
      target: { t: 'global' },
      memos: [{ id: 'b', body: {}, noted_at: 2 }],
    })

    // 丸ごとの配信なので、**前のぶんは残らない**
    expect(memosFor({ t: 'global' }).map((m) => m.id)).toEqual(['b'])
  })
})

/**
 * 軽い便が、ブラウザで当たること（レビュー対応 対応1）。
 *
 * **ここが切れていた。** セッションホストは便を出し、サーバは中継し、ブラウザは
 * 受け取り、そして**捨てていた**——`handleJson` の `switch` に腕が無く、`default` も
 * 無いので黙って落ちる。型も単体テストも結合テストも台帳も緑のまま、
 * **画面にだけ何も届いていなかった。**
 *
 * したがってここで見るのは「**配達経路が生きているか**」である。ストアへ直接
 * 値を入れて描くテストは、この経路を1度も通らない。
 */
describe('コンテキストの使い具合が、軽い便で届く', () => {
  /** カードを1枚立ててから、軽い便を流せる状態にする。 */
  async function カードを1枚立てる(cardId = CARD) {
    await useWsStore.getState().connect()
    latest().accept()
    latest().deliver({
      t: 'session_upsert',
      session: {
        card_id: cardId,
        project: '/tmp/x',
        claude_session_id: null,
        resumed_from: null,
        permission_mode: null,
        model: null,
        model_label: null,
        model_requested: null,
        status: { kind: 'waiting_input' },
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
        branched_from: null,
        context_usage: null,
        rate_limits: null,
        cost: null,
      },
    })
  }

  const 使い具合 = {
    used_percentage: 24,
    total_input_tokens: 241_479,
    context_window_size: 1_000_000,
  }

  it('軽い便を流すと、そのカードの使い具合が変わる', async () => {
    await カードを1枚立てる()
    expect(getSession(CARD)?.context_usage).toBeNull()

    latest().deliver({ t: 'context_usage', card_id: CARD, usage: 使い具合 })

    expect(getSession(CARD)?.context_usage).toEqual(使い具合)
  })

  it('usage が null の便で「まだ分からない」へ戻る（/compact 直後の経路）', async () => {
    await カードを1枚立てる()
    latest().deliver({ t: 'context_usage', card_id: CARD, usage: 使い具合 })
    expect(getSession(CARD)?.context_usage).toEqual(使い具合)

    latest().deliver({ t: 'context_usage', card_id: CARD, usage: null })

    // **0% ではなく「無い」に戻る。** 空と不明は別物（設計§5）
    expect(getSession(CARD)?.context_usage).toBeNull()
  })

  it('その欄だけを当てる（他の欄を巻き戻さない）', async () => {
    await カードを1枚立てる()
    // 状態が進んだあとに軽い便が来る、という順序を作る
    latest().deliver({
      t: 'status',
      card_id: CARD,
      status: { kind: 'working' },
      subagent_active: 2,
      last_activity_at: 99,
    })

    latest().deliver({ t: 'context_usage', card_id: CARD, usage: 使い具合 })

    const 手元 = getSession(CARD)
    expect(手元?.context_usage).toEqual(使い具合)
    // **meta 全体を置き換えると、ここが巻き戻る**
    expect(手元?.status).toEqual({ kind: 'working' })
    expect(手元?.subagent_active).toBe(2)
    expect(手元?.last_activity_at).toBe(99)
  })

  it('知らないカードIDの便が来ても、他のカードが壊れない', async () => {
    await カードを1枚立てる()
    latest().deliver({ t: 'context_usage', card_id: CARD, usage: 使い具合 })

    latest().deliver({
      t: 'context_usage',
      card_id: 'ffffffff-0000-0000-0000-00000000ffff',
      usage: { used_percentage: 99, total_input_tokens: 1, context_window_size: 2 },
    })

    // 知らないカードは捨てる（`session_upsert` が後から来る）。既にあるカードは無傷
    expect(getSessions()).toHaveLength(1)
    expect(getSession(CARD)?.context_usage).toEqual(使い具合)
  })
})

describe('使用上限の便', () => {
  const 上限 = { windows: [{ name: 'five_hour', used_percentage: 41, resets_at: 1 }] }

  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
  })

  it('この機械ぶん（宛先なし）は、設定の machine_rate_limits に入る', async () => {
    // **腕が空でも型検査は通る**（`assertNever` は腕の有無しか見ない）。
    // 1件目は同じ格好で「型も単体テストも台帳も緑、画面にだけ何も届かない」を踏んだ。
    // **見張りを1回使い切っているので、ここが唯一の砦である**
    await useWsStore.getState().connect()
    latest().accept()

    latest().deliver({ t: 'rate_limits', agent_id: null, limits: 上限 })

    expect(useSettingsStore.getState().settings.machine_rate_limits).toEqual(上限)
  })

  it('PC を名指しした便は、その行に入る（宛先で置き場所が分かれる）', async () => {
    const id = 'bbbbbbbb-0000-0000-0000-000000000002'
    useSettingsStore.setState({
      settings: settingsFixture(remoteAgent(id, '別の PC')),
      loading: false,
    })
    await useWsStore.getState().connect()
    latest().accept()

    latest().deliver({ t: 'rate_limits', agent_id: id, limits: 上限 })

    const { settings } = useSettingsStore.getState()
    expect(settings.agents[0]?.rate_limits).toEqual(上限)
    // **この機械の欄は触らない。** 両方へ入れると同じ数字が2箇所に出る
    expect(settings.machine_rate_limits).toBeUndefined()
  })

  it('一覧に無い PC の便は捨てる（描く行が無い）', async () => {
    await useWsStore.getState().connect()
    latest().accept()

    latest().deliver({
      t: 'rate_limits',
      agent_id: 'cccccccc-0000-0000-0000-000000000003',
      limits: 上限,
    })

    // 落ちも増えもしない。次の `load()` で行ごと届く
    expect(useSettingsStore.getState().settings.agents).toHaveLength(0)
    expect(useSettingsStore.getState().settings.machine_rate_limits).toBeUndefined()
  })
})
