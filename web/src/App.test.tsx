import { render, screen } from '@testing-library/react'
import App from './App'
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

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  // 接続時に取りにいく初期スナップショット（設計§4）
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', { status: 200 })),
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
    expect(screen.getByLabelText('作業ディレクトリ')).toBeInTheDocument()
    // 起動ボタンは権限モードの選択でもある（設計§8）。既定は3つ
    expect(screen.getAllByTestId('spawn-button')).toHaveLength(3)
    expect(
      await screen.findByText('セッションはまだありません'),
    ).toBeInTheDocument()
  })

  it('作業ディレクトリが空のうちは起動できない', () => {
    render(<App />)

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
    // 「勝手に直った」を黙って起こさないための表示（設計§9）
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
