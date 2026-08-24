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

/**
 * 場所ごとの遅れ（ミリ秒）。**返る順を押した順と入れ替える**ために使う。
 *
 * 跨いだ配置では1回に最大5秒かかりうるので、速く辿れば現実に起きる。
 */
let slow: Record<string, number> = {}

beforeEach(() => {
  slow = {}
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
      const delay = slow[at] ?? 0
      if (delay > 0) {
        await new Promise((done) => setTimeout(done, delay))
      }
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

  it('別の枠へ移ると、その枠の起点から始まる', async () => {
    // **回帰テスト。** 直す前は、辿り直す効果が「変わる前の場所」を掴んでいたので、
    // 起点が変わっても**古い枠の中身を出し続けた**（一覧のシートでは一瞬だけ
    // 新しい場所が見えて戻る、という形で表に出ていた）
    const other = '/home/me/dev/other'
    const view = render(<ProjectFiles host="local" project={ROOT} />)
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute('data-path', ROOT),
    )

    view.rerender(<ProjectFiles host="local" project={other} />)
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute('data-path', other),
    )

    // 落ち着いたあとも新しい枠のままであること（戻らない）
    await new Promise((done) => setTimeout(done, 50))
    expect(screen.getByTestId('folder-browser')).toHaveAttribute('data-path', other)
  })

  it('速く辿っても、古い応答が新しい表示を上書きしない', async () => {
    // **回帰テスト。** 問いに世代を持たせる前は、遅い応答が後から届くと
    // そこへ表示が戻っていた。左パネルは作り直されないので、そのまま表に出る
    render(<ProjectFiles host="local" project={ROOT} />)
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute('data-path', ROOT),
    )

    // 掘る先だけを遅らせる（跨いだ配置の遅れを真似る）
    slow[`${ROOT}/MyDocs`] = 80
    const into = screen
      .getAllByTestId('folder-entry')
      .find((row) => row.getAttribute('data-name') === 'MyDocs')
    await userEvent.click(into as HTMLElement)
    // 答えを待たずに、起点へ戻る（こちらは即答）
    const back = screen
      .getAllByTestId('folder-crumb')
      .find((crumb) => crumb.textContent === 'app')
    await userEvent.click(back as HTMLElement)

    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute('data-path', ROOT),
    )

    // 遅れていた答えが届いたあとも、起点のままであること
    await new Promise((done) => setTimeout(done, 150))
    expect(screen.getByTestId('folder-browser')).toHaveAttribute('data-path', ROOT)
  })

  it('フォルダ行から相対パスをコピーできる', async () => {
    // 要件が名指ししている用途（「エージェントに**フォルダやファイル**のパスを
    // 渡す」）。ファイルを開かないと取れない状態だと、フォルダのパスは渡せない
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async (text: string) => void written.push(text)) },
    })

    render(<ProjectFiles host="local" project={ROOT} />)
    const rows = await screen.findAllByTestId('folder-copy')
    await userEvent.click(rows[0])

    // 基準は枠のパス。絶対パスではなく**貼れる形**で取れること。
    // **フォルダは末尾に `/`**（入れ物だと一目で分かる）
    expect(written).toEqual(['MyDocs/'])
    expect(rows[0]).toHaveAttribute('data-value', 'MyDocs/')

    // **ファイルには付かない。** 付けると、貼られた側で存在しない場所を指す
    await userEvent.click(rows[1])
    expect(written).toEqual(['MyDocs/', '計画.md'])
  })

  it('コピーを押しても階層は変わらない', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    })

    render(<ProjectFiles host="local" project={ROOT} />)
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute('data-path', ROOT),
    )

    await userEvent.click((await screen.findAllByTestId('folder-copy'))[0])
    // 開く的とコピーの的は別（設計§13）。混ざると、渡す値を取るだけのつもりで
    // 階層が動く
    expect(screen.getByTestId('folder-browser')).toHaveAttribute('data-path', ROOT)
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

/**
 * サムネイルを出さない、の実体（`ファイル閲覧で画像とHTMLも表示する` 設計§7-5。
 * テスト計画フェーズ4）。
 *
 * **「出さない」は見た目では確かめられない。** 出ていないことを目で見ても、
 * 「まだ描かれていないだけ」と区別が付かない。**呼び出しの回数で言う。**
 */
describe('一覧は画像を先読みしない', () => {
  it('画像だらけのフォルダを描いても、画像を1枚も取りに行かない', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return new Response(
          JSON.stringify({
            path: ROOT,
            entries: [
              { name: '一枚目.png', kind: 'file', is_project: false },
              { name: '二枚目.jpg', kind: 'file', is_project: false },
              { name: '三枚目.svg', kind: 'file', is_project: false },
            ],
            truncated: false,
          }),
          { status: 200 },
        )
      }),
    )

    render(<ProjectFiles host="local" project={ROOT} />)
    await screen.findByText('一枚目.png')

    // **一覧の1回だけ。** 画像の数だけ問答が走ると、跨いだ配置では
    // 1件あたり最大5秒の時間切れがその数だけ並ぶ
    expect(calls).toHaveLength(1)
    expect(calls.filter((url) => url.includes('as=raw'))).toHaveLength(0)
  })
})
