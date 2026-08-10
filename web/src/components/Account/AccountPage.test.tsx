import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountPage } from '@/components/Account/AccountPage'
import { useSettingsStore } from '@/stores/settings'

/**
 * 札の1件（サーバの `TokenView` と同じ形）。
 */
function token(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    label: '仕事用ノート',
    kind: 'agent',
    created_at: 1_000,
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  }
}

/**
 * `/api/account/*` の応答を流し込んで描く。
 *
 * このページは店（store）を介さず自分で fetch するので、応答そのものを差し替える。
 * 呼ばれた要求は後から検分できるよう `calls` に控える。
 */
function show(tokens: unknown[], agents: unknown[] = []) {
  const calls: { url: string; method: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.startsWith('/api/account/tokens')) {
        if (init?.method === 'DELETE') {
          return new Response(null, { status: 204 })
        }
        return new Response(JSON.stringify(tokens), { status: 200 })
      }
      if (url.startsWith('/api/account/agents')) {
        return new Response(JSON.stringify(agents), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }),
  )
  render(
    <MemoryRouter>
      <AccountPage />
    </MemoryRouter>,
  )
  return calls
}

describe('札の一覧の用途（CLI設計§5-3・テスト計画F6）', () => {
  beforeEach(() => {
    // 失効後の一覧同期が本物の /api/settings へ行かないように
    vi.spyOn(useSettingsStore.getState(), 'load').mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('札の一覧に kind が出て、PC と CLI を見分けられる', async () => {
    show([
      token(),
      token({ id: '22222222-2222-4222-8222-222222222222', label: '開発エージェント', kind: 'cli' }),
    ])

    await waitFor(() => expect(screen.getAllByTestId('token-row')).toHaveLength(2))
    const rows = screen.getAllByTestId('token-row')
    expect(rows[0]).toHaveAttribute('data-kind', 'agent')
    expect(rows[1]).toHaveAttribute('data-kind', 'cli')
    const kinds = screen.getAllByTestId('token-kind').map((el) => el.textContent)
    expect(kinds).toEqual(['PC', 'CLI'])
  })

  it('CLI の札は「登録済みの PC」として数えられない', async () => {
    // CLI の札は `agents` の行を作らない（行が増えるのは /agent/ws に繋いだときだけ）。
    // ここが崩れると「繋いでこない PC」が一覧に並び続ける
    show([token({ kind: 'cli', label: '開発エージェント' })], [])

    await waitFor(() => expect(screen.getAllByTestId('token-row')).toHaveLength(1))
    expect(screen.queryAllByTestId('agent-row')).toHaveLength(0)
    expect(screen.getByText(/まだ1台も繋がっていません/)).toBeInTheDocument()
  })

  it('CLI の札も PC の札と同じく画面から失効できる', async () => {
    const calls = show([token({ kind: 'cli', label: '開発エージェント' })])

    await waitFor(() => expect(screen.getAllByTestId('token-row')).toHaveLength(1))
    await userEvent.click(screen.getByTestId('revoke-token'))

    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/account/tokens/11111111-1111-4111-8111-111111111111',
        method: 'DELETE',
      }),
    )
  })
})
