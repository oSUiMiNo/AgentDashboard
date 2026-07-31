import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { TileGrid } from './TileGrid'
import type { SessionMeta } from '@/lib/protocol'
import { applySessionSnapshot, clearSessions } from '@/stores/sessions'

/**
 * 一覧の絞り込み（セルフホスト化設計§8-5、テスト計画フェーズ5）。
 *
 * `.agent-dashboard.toml` の名乗りは、ローカルモードでは**認証ではなく一覧の
 * フィルタとしてのみ**働く。攻撃者の居ない環境での自己整理機能で、権限とは無関係。
 */

const NOW = 1_700_000_000_000

function meta(cardId: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    card_id: cardId,
    project: `/dev/${cardId}`,
    claude_session_id: null,
    permission_mode: null,
    model: null,
    model_label: null,
    model_requested: null,
    status: { kind: 'working' },
    subagent_active: 0,
    last_activity_at: NOW,
    last_assistant_message: null,
    created_at: NOW,
    hooks_seen: true,
    agent_id: null,
    agent_connected: true,
    account: null,
    toml_account: null,
    ...overrides,
  }
}

function renderGrid() {
  return render(
    <MemoryRouter>
      <TileGrid />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  clearSessions()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearSessions()
})

describe('名乗りによる絞り込み', () => {
  it('名乗ったカードが無ければ選択肢を出さない', () => {
    // 使わない操作を常に置くと、一覧の主役（状態インジケータ）が埋もれる
    applySessionSnapshot([meta('a'), meta('b')])
    renderGrid()

    expect(screen.queryByTestId('account-filter')).toBeNull()
  })

  it('選んだ名乗りのカードだけになる', async () => {
    applySessionSnapshot([
      meta('a', { toml_account: 'しごと' }),
      meta('b', { toml_account: 'あそび' }),
      meta('c'),
    ])
    renderGrid()

    expect(screen.getAllByTestId('session-tile')).toHaveLength(3)

    await userEvent.selectOptions(
      screen.getByTestId('account-filter'),
      'しごと',
    )
    const shown = screen.getAllByTestId('session-tile')
    expect(shown).toHaveLength(1)
    expect(shown[0].dataset.cardId).toBe('a')

    // 戻せる。**サーバへは何も送っていない**（表示だけの操作）
    await userEvent.selectOptions(screen.getByTestId('account-filter'), '')
    expect(screen.getAllByTestId('session-tile')).toHaveLength(3)
  })

  it('絞り込んだ結果が空でも、理由が分かる文言を出す', async () => {
    // 「まだありません」と出すと、絞り込んでいることを忘れて起動していないと思う
    applySessionSnapshot([meta('a', { toml_account: 'しごと' })])
    renderGrid()

    await userEvent.selectOptions(
      screen.getByTestId('account-filter'),
      'しごと',
    )
    // ストアの更新は React の外から来るので、描き直しを待ってから見る
    act(() => {
      applySessionSnapshot([])
    })

    expect(screen.getByText(/「しごと」/)).toBeInTheDocument()
  })
})
