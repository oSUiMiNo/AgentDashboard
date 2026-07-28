import { render, screen } from '@testing-library/react'
import App from './App'

/**
 * jsdom には本物の WebSocket サーバがないので、接続だけを差し替える。
 * ここで確かめたいのは画面が組み上がることであって、通信そのものではない
 * （通信を含めた確認は Playwright の E2E が実サーバ相手に行う）。
 */
class FakeWebSocket {
  static readonly OPEN = 1
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
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('起動フォームとセッション一覧の枠が表示される', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: 'AgentDashboard' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('作業ディレクトリ')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'セッションを起動' }),
    ).toBeInTheDocument()
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument()
  })

  it('作業ディレクトリが空のうちは起動できない', () => {
    render(<App />)

    expect(screen.getByRole('button', { name: 'セッションを起動' })).toBeDisabled()
  })
})
