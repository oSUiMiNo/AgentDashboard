import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { ProjectGroup } from './ProjectGroup'
import type { SessionMeta } from '@/lib/protocol'

/**
 * クリックの作り分け（テスト計画フェーズ5「クリック挙動」の単体側）。
 *
 * 同じ箱の中に「余白＝全員を横並び」「小窓＝1つだけ」という2つの意味を持たせているので、
 * 小窓のクリックが親へ伝わらないこと（stopPropagation）が仕様の要になる。
 * ブラウザでの確認は Playwright が担当する。
 */

const NOW = 1_700_000_000_000
const PROJECT = '/home/example/dev/app'

function meta(cardId: string): SessionMeta {
  return {
    card_id: cardId,
    project: PROJECT,
    claude_session_id: null,
    status: { kind: 'working' },
    subagent_active: 0,
    last_activity_at: NOW,
    last_assistant_message: null,
    created_at: NOW,
  }
}

/** いまのURLを画面に出すだけの部品。遷移先の確認に使う。 */
function ShowLocation() {
  const location = useLocation()
  return <p data-testid="current-path">{location.pathname}</p>
}

function renderGroup(sessions: SessionMeta[]) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <ShowLocation />
      <Routes>
        <Route
          path="/"
          element={
            <ProjectGroup project={PROJECT} sessions={sessions} now={NOW} />
          }
        />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProjectGroup', () => {
  it('プロジェクトのパスとセッション数が出る', () => {
    renderGroup([meta('a'), meta('b')])

    expect(screen.getByText(PROJECT)).toBeInTheDocument()
    expect(screen.getByText('2セッション')).toBeInTheDocument()
    expect(screen.getAllByTestId('session-tile')).toHaveLength(2)
  })

  it('余白をクリックするとプロジェクトの画面へ移る', async () => {
    renderGroup([meta('a')])

    await userEvent.click(screen.getByTestId('project-group'))
    expect(screen.getByTestId('current-path')).toHaveTextContent(
      `/p/${encodeURIComponent(PROJECT)}`,
    )
  })

  it('小窓をクリックしたときは余白のクリックにならない', async () => {
    renderGroup([meta('a')])

    await userEvent.click(screen.getByTestId('session-tile'))
    expect(screen.getByTestId('current-path')).toHaveTextContent('/s/a')
  })
})
