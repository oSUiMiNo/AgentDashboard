import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { SessionTile } from './SessionTile'
import type { SessionMeta, SessionStatus } from '@/lib/protocol'
import { applySessionSnapshot, clearSessions } from '@/stores/sessions'

/**
 * 小窓の表示（テスト計画フェーズ5「小窓」）。
 *
 * 一覧の主役は状態インジケータなので、6つの状態それぞれが区別できること、人の対処が
 * 要る状態が見分けられること、経過時間が出ることを確かめる。
 *
 * 小窓は中身をストアから購読するので、描く前にストアへ置く。経過時間は共有の時計
 * （[`useNow`]）が返す**実時刻**から求まるので、確かめるときは実時刻を起点に置く。
 */

const NOW = 1_700_000_000_000
const CARD = '11111111-2222-3333-4444-555555555555'

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

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    card_id: CARD,
    project: '/home/example/dev/app',
    claude_session_id: null,
    status: { kind: 'working' },
    subagent_active: 0,
    last_activity_at: NOW,
    last_assistant_message: null,
    created_at: NOW - 60_000,
    hooks_seen: true,
    ...overrides,
  }
}

function renderTile(session: SessionMeta) {
  applySessionSnapshot([session])
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<SessionTile cardId={session.card_id} />} />
        <Route path="/s/:cardId" element={<p>専用画面</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('SessionTile', () => {
  it.each<[SessionStatus, string]>([
    [{ kind: 'starting' }, '起動中'],
    [{ kind: 'working' }, '作業中'],
    [{ kind: 'waiting_permission' }, '権限確認待ち'],
    [{ kind: 'waiting_input' }, '入力待ち'],
    [{ kind: 'stalled' }, '停滞'],
    [{ kind: 'ended', ok: true }, '終了'],
    [{ kind: 'ended', ok: false }, '異常終了'],
    [{ kind: 'unknown' }, '不明'],
  ])('状態 %o は「%s」と表示される', (status, label) => {
    renderTile(meta({ status }))

    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByTestId('session-tile')).toHaveAttribute(
      'data-status',
      status.kind,
    )
  })

  it('状態ごとに色が変わる', () => {
    const { unmount } = renderTile(meta({ status: { kind: 'working' } }))
    const working = screen.getByTestId('status-dot').className
    unmount()

    renderTile(meta({ status: { kind: 'waiting_permission' } }))
    expect(screen.getByTestId('status-dot').className).not.toBe(working)
  })

  it('人の対処が要る状態は見た目で目立つ', () => {
    // 権限確認待ちを見落とすと、セッションがそこで止まったままになる
    const { unmount } = renderTile(meta({ status: { kind: 'working' } }))
    const calm = screen.getByTestId('session-tile').className
    unmount()

    renderTile(meta({ status: { kind: 'waiting_permission' } }))
    expect(screen.getByTestId('session-tile').className).not.toBe(calm)
  })

  it('最終活動からの経過時間が出る', () => {
    renderTile(meta({ last_activity_at: Date.now() - 3 * 60_000 }))
    expect(screen.getByTestId('elapsed')).toHaveTextContent('最終活動 3分前')
  })

  it('サブエージェントが動いている間だけバッジが出る', () => {
    const { unmount } = renderTile(meta({ subagent_active: 0 }))
    expect(screen.queryByTestId('subagent-badge')).not.toBeInTheDocument()
    unmount()

    renderTile(meta({ subagent_active: 2 }))
    expect(screen.getByTestId('subagent-badge')).toHaveTextContent(
      'サブエージェント 2',
    )
  })

  it('直前の応答があれば要約として出る', () => {
    const { unmount } = renderTile(meta({ last_assistant_message: null }))
    expect(screen.queryByTestId('last-message')).not.toBeInTheDocument()
    unmount()

    renderTile(meta({ last_assistant_message: 'テストが通りました' }))
    expect(screen.getByTestId('last-message')).toHaveTextContent(
      'テストが通りました',
    )
  })

  it('フックが1件も来ていない不明には理由が出る', () => {
    // ただの「不明」では利用者は打つ手が分からない（設計§11）
    const { unmount } = renderTile(
      meta({ status: { kind: 'unknown' }, hooks_seen: false }),
    )
    expect(screen.getByTestId('hook-warning')).toHaveTextContent('フック未受信')
    unmount()

    // フックは届いているのに不明、という別の理由のときは名指ししない
    renderTile(meta({ status: { kind: 'unknown' }, hooks_seen: true }))
    expect(screen.queryByTestId('hook-warning')).not.toBeInTheDocument()
  })

  it('小窓をクリックすると専用画面へ移る', async () => {
    renderTile(meta())
    await userEvent.click(screen.getByTestId('session-tile'))
    expect(screen.getByText('専用画面')).toBeInTheDocument()
  })
})
