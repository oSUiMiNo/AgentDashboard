import { render, screen } from '@testing-library/react'
import App from './App'
import { useAuthStore } from '@/stores/auth'
import { useWsStore } from '@/stores/ws'

/**
 * jsdom には本物の WebSocket サーバがないので、接続だけを差し替える。
 * ここで確かめたいのは画面が組み上がることであって、通信そのものではない
 * （通信を含めた確認は Playwright の E2E が実サーバ相手に行う）。
 */
class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  binaryType = 'blob'
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  send() {}
  close() {}
}

/**
 * 鍵の無いローカルモード（実機と同じ形）の `GET /api/me`。
 *
 * **ここを返さないとログイン画面が出る。** 画面は「何を出すべきか」をこの応答だけで
 * 決めており（セルフホスト化設計§8-1）、ブラウザ側で構成を推測しないため。
 */
const OPEN_MODE = JSON.stringify({
  mode: 'open',
  authenticated: true,
  account: null,
  is_admin: false,
  setup_open: false,
  from_loopback: true,
})

beforeEach(() => {
  // **鍵の状態を毎回まっさらに戻す。** ストアはモジュールに1つなので、前のテストで
  // 通った状態が残ると「聞く前から入れている」テストができてしまう
  useAuthStore.setState({
    auth: {
      mode: 'open',
      authenticated: false,
      account: null,
      is_admin: false,
      setup_open: false,
      from_loopback: false,
    },
    loading: true,
    lastError: null,
  })
  vi.stubGlobal('WebSocket', FakeWebSocket)
  // 接続時に取りにいく初期スナップショット（設計§4）と、入口の鍵の状態
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/me'
        ? new Response(OPEN_MODE, { status: 200 })
        : new Response('[]', { status: 200 }),
    ),
  )
})

afterEach(() => {
  // 接続はモジュールに1つだけ持たせているので、明示的に畳まないと次のテストが
  // 「もう繋がっている」と判断して接続処理ごと飛ばしてしまう
  useWsStore.getState().disconnect()
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('起動フォームと一覧の枠が表示される', async () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: 'AgentDashboard' }),
    ).toBeInTheDocument()
    // **聞いてから描く。** 何を出すかはサーバの構成で決まるので、最初の1描画では
     // まだ決まっていない（`GET /api/me` の応答を待つ）
    expect(await screen.findByLabelText('作業ディレクトリ')).toBeInTheDocument()
    // 起動ボタンは権限モードの選択でもある（設計§8）。既定は3つ
    expect(screen.getAllByTestId('spawn-button')).toHaveLength(3)
    expect(
      await screen.findByText('セッションはまだありません'),
    ).toBeInTheDocument()
  })

  it('作業ディレクトリが空のうちは起動できない', async () => {
    render(<App />)

    await screen.findByLabelText('作業ディレクトリ')
    for (const button of screen.getAllByTestId('spawn-button')) {
      expect(button).toBeDisabled()
    }
  })

  it('接続時に一覧のスナップショットを取りにいく', async () => {
    render(<App />)

    await screen.findByText('セッションはまだありません')
    expect(fetch).toHaveBeenCalledWith('/api/sessions')
  })

  it('自己修復の進行が段階つきで出る', () => {
    // 「勝手に直った」を黙って起こさないための表示（設計§9）。
    // バナーは鍵の外側にある（通っていなくても、直っていることは見せる）
    useWsStore.setState({
      selfheal: { phase: 'repairing', detail: '1/3 回目' },
    })
    render(<App />)

    const banner = screen.getByTestId('selfheal-banner')
    expect(banner).toHaveTextContent('修復セッションが作業しています')
    expect(banner).toHaveTextContent('1/3 回目')
    expect(banner.dataset.phase).toBe('repairing')
  })

  it('直せなかったときは人が気づける見た目にする', () => {
    // 直った・進行中と、人の手が要る状態を同じ見た目にすると見落とす
    useWsStore.setState({
      selfheal: { phase: 'failed', detail: null },
    })
    render(<App />)

    const banner = screen.getByTestId('selfheal-banner')
    expect(banner.className).toContain('red')
  })
})

describe('通っていない間の見え方（セルフホスト化設計§8-2）', () => {
  it('ログイン前は接続の様子も導線も出さない', async () => {
    // **動作は正しいのに見た目が嘘をつく**形の回帰テスト。繋ぎに行くのは通ってから
    // なので、出すと必ず「切断」と表示される（実物を見て気づいた）
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/me'
          ? new Response(
              JSON.stringify({
                mode: 'account',
                authenticated: false,
                account: null,
                is_admin: false,
                setup_open: true,
                from_loopback: true,
              }),
              { status: 200 },
            )
          : new Response('[]', { status: 200 }),
      ),
    )
    render(<App />)

    // 最初のセットアップが出る（管理者がまだ居ない）
    expect(await screen.findByTestId('setup-form')).toBeInTheDocument()
    expect(screen.queryByTestId('connection-status')).toBeNull()
    expect(screen.queryByTestId('settings-link')).toBeNull()
    expect(screen.queryByTestId('account-link')).toBeNull()
  })
})
