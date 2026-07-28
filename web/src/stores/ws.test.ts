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
  onclose: (() => void) | null = null
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
    this.drop()
  }

  /** サーバが受け入れた。 */
  accept() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  /** 接続が切れた（サーバが落ちた・回線が途切れた）。 */
  drop() {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }

  /** このソケットが送った操作メッセージ。 */
  requests(): ClientMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientMessage)
  }
}

let fetched = 0

beforeEach(() => {
  clearSessions()
  FakeSocket.instances = []
  fetched = 0
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  vi.stubGlobal('fetch', async () => {
    fetched += 1
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

    expect(fetched).toBe(1)
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
    expect(fetched).toBe(2)
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
