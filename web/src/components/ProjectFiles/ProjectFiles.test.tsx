/**
 * PJT 専用画面の左パネル（設計§14・§15。テスト計画 フェーズ4「ファイルの見せ方」）。
 *
 * 器そのものより、**起点より上へ辿れないこと**が要点。相対パスの基準が壊れると、
 * コピーした値が貼られた側で別の場所を指す。
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectFiles } from '@/components/ProjectFiles/ProjectFiles'

const ROOT = '/home/me/dev/app'

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/file?')) {
        const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
        return new Response(
          JSON.stringify({ path, text: '# 中身\n', truncated: false, bytes: 8 }),
          { status: 200 },
        )
      }
      const at = new URL(url, 'http://x').searchParams.get('path') ?? ROOT
      return new Response(
        JSON.stringify({
          path: at,
          entries: [
            { name: 'MyDocs', kind: 'dir', is_project: false },
            { name: '計画.md', kind: 'file', is_project: false },
          ],
          truncated: false,
        }),
        { status: 200 },
      )
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('左パネル', () => {
  it('起点から始まり、起点より上へは辿れない', async () => {
    render(<ProjectFiles host="local" project={ROOT} />)

    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        ROOT,
      ),
    )

    // 上の段は出るが押せない。**出しても押せない段は作らない**のではなく、
    // 現在地までの道筋は見せたうえで、外側だけを塞ぐ
    const crumbs = screen.getAllByTestId('folder-crumb')
    const labels = crumbs.map((crumb) => crumb.textContent)
    expect(labels).toContain('app')
    for (const crumb of crumbs) {
      if (crumb.textContent === 'app') {
        expect(crumb).toBeEnabled()
      } else {
        expect(crumb).toBeDisabled()
      }
    }
  })

  it('ファイルを押すと中身が出る', async () => {
    render(<ProjectFiles host="local" project={ROOT} />)

    const file = await screen.findByRole('button', { name: /計画\.md/ })
    await userEvent.click(file)

    const view = await screen.findByTestId('file-view')
    expect(view).toHaveAttribute('data-path', `${ROOT}/計画.md`)
    // 基準は枠のパス。パネルの起点と同じものであることが要る
    expect(screen.getByTestId('file-relative-base')).toHaveTextContent(ROOT)
  })

  it('閉じると一覧だけに戻る', async () => {
    render(<ProjectFiles host="local" project={ROOT} />)

    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))
    await screen.findByTestId('file-view')

    await userEvent.click(screen.getByTestId('file-close'))
    expect(screen.queryByTestId('file-view')).toBeNull()
    expect(screen.getByTestId('folder-browser')).toBeInTheDocument()
  })
})
