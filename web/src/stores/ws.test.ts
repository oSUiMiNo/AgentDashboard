import type { ClientMessage } from '@/lib/protocol'
import { clearSessions } from './sessions'
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
