/**
 * PJT を追加する入口（設計§13。テスト計画 フェーズ4「一覧」）。
 *
 * ここが起動の唯一の入口になったので、**押せない・選べない状態が残ると
 * セッションを1本も起こせなくなる**。
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectAdd } from '@/components/ProjectAdd/ProjectAdd'
import type { ProjectView } from '@/lib/protocol'
import { applyProjectSnapshot, clearProjects } from '@/stores/projects'
import { clearSessions } from '@/stores/sessions'
import { settingsFixture } from '@/test/fixtures'
import { useSettingsStore } from '@/stores/settings'

/** `/api/hosts/{host}/dir` の応答。**着いた先は必ず返す**（設計§26-2） */
function listing(path: string, names: string[], truncated = false) {
  return {
    path,
    entries: names.map((name) => ({
      name,
      kind: 'dir' as const,
      is_project: name === 'app',
    })),
    truncated,
  }
}

let dirCalls: string[] = []

beforeEach(() => {
  clearProjects()
  clearSessions()
  dirCalls = []
  useSettingsStore.setState({
    settings: settingsFixture(),
    loading: false,
    lastError: null,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/hosts/')) {
        dirCalls.push(url)
        const asked = new URL(url, 'http://x').searchParams.get('path')
        // 省略＝ホーム。PC 側が解決した結果が返る、という形をそのまま真似る
        const at = asked ?? '/home/me'
        return new Response(
          JSON.stringify(listing(at, at === '/home/me' ? ['dev'] : ['app'])),
          { status: 200 },
        )
      }
      if (url === '/api/projects' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            project: { id: 'p1', host: 'local', path: '/x', created_at: 1 },
            spawned: false,
          }),
          { status: 200 },
        )
      }
      return new Response('[]', { status: 200 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function openSheet() {
  render(<ProjectAdd disabled={false} />)
  await userEvent.click(screen.getByTestId('project-add-open'))
  return screen.getByTestId('project-add-sheet')
}

describe('PJT を追加', () => {
  it('押すまでシートは出ない', async () => {
    render(<ProjectAdd disabled={false} />)
    expect(screen.queryByTestId('project-add-sheet')).toBeNull()
  })

  it('打ち込む道で足せる', async () => {
    const sheet = await openSheet()
    await userEvent.type(
      within(sheet).getByTestId('project-add-path'),
      '/dev/app',
    )
    await userEvent.click(within(sheet).getByTestId('project-add-submit'))

    await waitFor(() => {
      const posted = vi
        .mocked(fetch)
        .mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')
      expect(posted).toBeDefined()
    })
  })

  it('辿る道で足せる（着いた先が確定の相手になる）', async () => {
    const sheet = await openSheet()
    // 開いた時点でホームへ着いている（省略して問うている）
    await screen.findByTestId('folder-browser')
    expect(dirCalls[0]).not.toContain('path=')

    await userEvent.click(await screen.findByTestId('folder-entry'))
    await waitFor(() =>
      expect(within(sheet).getByTestId('project-add-target')).toHaveTextContent(
        '/home/me/dev',
      ),
    )
    expect(within(sheet).getByTestId('project-add-submit')).toBeEnabled()
  })

  it('1画面に1階層で、パンくずで上へ戻れる', async () => {
    await openSheet()
    await screen.findByTestId('folder-browser')
    // いま居る階層のぶんだけが出ている（木は展開しない）
    expect(screen.getAllByTestId('folder-entry')).toHaveLength(1)

    await userEvent.click(screen.getByTestId('folder-entry'))
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        '/home/me/dev',
      ),
    )

    const crumbs = screen.getAllByTestId('folder-crumb')
    await userEvent.click(crumbs[1])
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        '/home',
      ),
    )
  })

  it('最近使った場所が並び、追加済みが分かる', () => {
    const frames: ProjectView[] = [
      { id: 'p1', host: 'local', path: '/dev/already', created_at: 1 },
    ]
    applyProjectSnapshot(frames)
    render(<ProjectAdd disabled={false} />)
    void userEvent.click(screen.getByTestId('project-add-open'))

    return waitFor(() => {
      const items = screen.getAllByTestId('project-add-recent-item')
      expect(items).toHaveLength(1)
      expect(items[0]).toHaveAttribute('data-added', 'true')
      expect(items[0]).toHaveTextContent('追加済み')
    })
  })

  it('最近使った場所を押すと、そこへ移動して戻らない', async () => {
    // **回帰テスト。** 直す前は「一瞬だけ移動して元へ戻る」——辿り直す効果が
    // 変わる前の値を掴んでいたため、古い場所を引き直して上書きしていた
    applyProjectSnapshot([
      { id: 'p1', host: 'local', path: '/dev/already', created_at: 1 },
    ])
    const sheet = await openSheet()
    await screen.findByTestId('folder-browser')

    await userEvent.click(within(sheet).getByTestId('project-add-recent-item'))

    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        '/dev/already',
      ),
    )
    // 押しただけで確定の相手になる（辿り着くのを待たせない）
    expect(within(sheet).getByTestId('project-add-target')).toHaveTextContent(
      '/dev/already',
    )

    // **戻らないこと。** 直す前はここで元の場所へ戻っていた
    await new Promise((done) => setTimeout(done, 50))
    expect(screen.getByTestId('folder-browser')).toHaveAttribute(
      'data-path',
      '/dev/already',
    )
  })

  it('同じ行をもう一度押しても、そこへ戻れる', async () => {
    applyProjectSnapshot([
      { id: 'p1', host: 'local', path: '/dev/already', created_at: 1 },
    ])
    const sheet = await openSheet()
    await screen.findByTestId('folder-browser')

    const row = within(sheet).getByTestId('project-add-recent-item')
    await userEvent.click(row)
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        '/dev/already',
      ),
    )

    // 掘ってから、同じ行をもう一度押す
    await userEvent.click(screen.getAllByTestId('folder-entry')[0])
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        '/dev/already/app',
      ),
    )

    await userEvent.click(row)
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        '/dev/already',
      ),
    )
  })

  it('フォルダ行から絶対パスをコピーできる', async () => {
    // 追加のシートには基準になる PJT がまだ無いので、**絶対パス**を取る
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async (text: string) => void written.push(text)) },
    })

    await openSheet()
    const copy = (await screen.findAllByTestId('folder-copy'))[0]
    await userEvent.click(copy)

    expect(written).toEqual(['/home/me/dev'])
    // 押しても階層は動かない（開く的と分かれている）
    expect(screen.getByTestId('folder-browser')).toHaveAttribute(
      'data-path',
      '/home/me',
    )
  })

  it('PC が2台以上のときは選択が出て、既定が選ばれていない', async () => {
    useSettingsStore.setState({
      settings: settingsFixture({
        agents: [
          { id: 'a1', name: 'ノート', connected: true, last_seen_at: null, version: null },
          { id: 'a2', name: 'デスクトップ', connected: true, last_seen_at: null, version: null },
        ],
      }),
      loading: false,
      lastError: null,
    })
    const sheet = await openSheet()

    const picker = within(sheet).getByTestId('project-add-host') as HTMLSelectElement
    // **既定を作らない。** 勝手に1台目を選ぶと、意図しない PC を辿ることになる
    expect(picker.value).toBe('')
    // 選ぶまでは辿る先も決まらない
    expect(screen.queryByTestId('folder-browser')).toBeNull()
    await userEvent.type(within(sheet).getByTestId('project-add-path'), '/dev/app')
    expect(within(sheet).getByTestId('project-add-submit')).toBeDisabled()

    await userEvent.selectOptions(picker, 'a2')
    expect(within(sheet).getByTestId('project-add-submit')).toBeEnabled()
  })

  it('1台のときは選択そのものを出さない', async () => {
    const sheet = await openSheet()
    expect(within(sheet).queryByTestId('project-add-host')).toBeNull()
  })
})
