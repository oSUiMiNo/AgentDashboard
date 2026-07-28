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
    expect(
      screen.getByRole('button', { name: 'セッションを起動' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByText('セッションはまだありません'),
    ).toBeInTheDocument()
  })

  it('作業ディレクトリが空のうちは起動できない', () => {
    render(<App />)

    expect(
      screen.getByRole('button', { name: 'セッションを起動' }),
    ).toBeDisabled()
  })

  it('接続時に一覧のスナップショットを取りにいく', async () => {
    render(<App />)

    await screen.findByText('セッションはまだありません')
    expect(fetch).toHaveBeenCalledWith('/api/sessions')
  })
})
