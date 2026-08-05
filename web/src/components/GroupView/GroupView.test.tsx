/**
 * PJT 専用画面（設計§14。テスト計画 フェーズ4「PJT 専用画面」）。
 *
 * セッションの中身は [`SessionView`] 自身のテストが見ているので、ここでは差し替える。
 * 端末を作る部品を巻き込むと、**確かめたいのは配置なのに、落ちる理由が xterm になる**。
 */

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupView } from '@/components/GroupView/GroupView'
import type { SessionMeta } from '@/lib/protocol'
import { applySessionSnapshot, clearSessions } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { settingsFixture } from '@/test/fixtures'

vi.mock('@/components/SessionView/SessionView', () => ({
  SessionView: ({ cardId }: { cardId: string }) => (
    <div data-testid="session-view" data-card={cardId} />
  ),
}))

const HOST = 'local'
const PROJECT = '/home/me/dev/app'

function card(cardId: string): SessionMeta {
  return {
    card_id: cardId,
    project: PROJECT,
    claude_session_id: null,
    permission_mode: null,
    model: null,
    model_label: null,
    model_requested: null,
    status: 'working',
    subagent_active: 0,
    last_activity_at: 1,
    last_assistant_message: null,
    created_at: 1,
    hooks_seen: true,
    agent_id: null,
    agent_connected: true,
    account: null,
    toml_account: null,
  } as unknown as SessionMeta
}

function show() {
  render(
    <MemoryRouter>
      <GroupView host={HOST} project={PROJECT} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  clearSessions()
  globalThis.localStorage.clear()
  useSettingsStore.setState({
    settings: settingsFixture(),
    loading: false,
    lastError: null,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ path: PROJECT, entries: [], truncated: false }),
          { status: 200 },
        ),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PJT 専用画面', () => {
  it('ハンバーガーで左パネルが開閉する', async () => {
    show()
    expect(screen.queryByTestId('project-files-panel')).toBeNull()

    await userEvent.click(screen.getByTestId('project-files-toggle'))
    expect(screen.getByTestId('project-files-panel')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-files-toggle'))
    expect(screen.queryByTestId('project-files-panel')).toBeNull()
  })

  it('開閉が覚えられ、開き直しても保たれる', async () => {
    show()
    await userEvent.click(screen.getByTestId('project-files-toggle'))
    expect(screen.getByTestId('project-files-panel')).toBeInTheDocument()

    // 画面を作り直す＝別の枠を開いた・再読み込みした、と同じこと
    cleanup()
    show()

    // 押し直さずに開いている（**サーバではなくブラウザ側**に覚えている）
    expect(screen.getByTestId('project-files-panel')).toBeInTheDocument()
    expect(globalThis.localStorage.getItem('agentdashboard.project-files-open')).toBe('1')
  })

  it('狭い画面では全幅のドロワーとして出る', async () => {
    show()
    await userEvent.click(screen.getByTestId('project-files-toggle'))
    const panel = screen.getByTestId('project-files-panel')

    // 狭い画面では被せて全幅、広い画面では左に常設（設計§14）。
    // 並べると両方が狭くなり、どちらも読めない
    expect(panel.className).toContain('fixed')
    expect(panel.className).toContain('inset-0')
    expect(panel.className).toContain('md:static')
    expect(panel.className).toContain('md:w-80')
    // 狭い画面用の閉じる操作がある（ハンバーガーが隠れる位置に来るため）
    expect(screen.getByTestId('project-files-close')).toBeInTheDocument()
  })

  it('セッションが0本でも画面が開き、「+」だけが出る', () => {
    show()

    expect(screen.getByTestId('group-view')).toBeInTheDocument()
    expect(screen.getByTestId('spawn-open')).toBeInTheDocument()
    expect(screen.queryByTestId('group-rail')).toBeNull()
    expect(screen.queryAllByTestId('session-view')).toHaveLength(0)
  })

  it('右側のセッション横並びは現行のまま', () => {
    applySessionSnapshot([card('c1'), card('c2')])
    show()

    const rail = screen.getByTestId('group-rail')
    expect(within(rail).getAllByTestId('session-view')).toHaveLength(2)
    // 横スクロールで全件並べる（上限を設けない、という既存の判断）
    expect(rail.className).toContain('overflow-x-auto')
  })
})
