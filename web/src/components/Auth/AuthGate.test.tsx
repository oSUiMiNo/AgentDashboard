import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthGate } from './AuthGate'
import { useAuthStore } from '@/stores/auth'

/**
 * 入口の画面（セルフホスト化設計§8-2・§8-3）。
 *
 * 出し分けの材料は `GET /api/me` だけ。**ブラウザ側で構成を推測しない**ので、
 * ここで確かめるのは「その応答で正しい形が出るか」になる。
 */
function mode(overrides: Partial<ReturnType<typeof useAuthStore.getState>['auth']>) {
  useAuthStore.setState({
    auth: {
      mode: 'account',
      authenticated: false,
      account: null,
      is_admin: false,
      setup_open: false,
      from_loopback: false,
      ...overrides,
    },
    loading: false,
    lastError: null,
  })
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('入口の画面', () => {
  it('管理者が居なければセットアップを出す', () => {
    mode({ setup_open: true })
    render(<AuthGate />)

    expect(screen.getByTestId('setup-form')).toBeInTheDocument()
    // 名前も要る（アカウントを作るのだから）
    expect(screen.getByTestId('login-name')).toBeInTheDocument()
  })

  it('アカウントログインでは名前とパスワードを聞く', () => {
    mode({})
    render(<AuthGate />)

    expect(screen.getByTestId('login-form')).toBeInTheDocument()
    expect(screen.getByTestId('login-name')).toBeInTheDocument()
    expect(screen.getByTestId('login-password')).toBeInTheDocument()
  })

  it('LAN 開放ではパスワードだけを聞く', () => {
    // 共有パスワード1本なので、名前という概念が無い（設計§8-1 の表）
    mode({ mode: 'lan_password' })
    render(<AuthGate />)

    expect(screen.queryByTestId('login-name')).toBeNull()
    expect(screen.getByTestId('login-password')).toBeInTheDocument()
  })

  it('断られた理由はサーバの言葉のまま出す', async () => {
    // こちらで言い換えると、「名前かパスワードが違います」を分けて書き直しかねない
    mode({})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('名前かパスワードが違います', { status: 401 })),
    )
    render(<AuthGate />)

    await userEvent.type(screen.getByTestId('login-name'), 'わたし')
    await userEvent.type(screen.getByTestId('login-password'), 'ちがう')
    await userEvent.click(screen.getByRole('button', { name: '入る' }))

    expect(await screen.findByTestId('login-error')).toHaveTextContent(
      '名前かパスワードが違います',
    )
  })
})
