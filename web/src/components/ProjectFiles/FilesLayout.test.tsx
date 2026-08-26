/**
 * ファイルのパネルの器（設計§2・§3。テスト計画フェーズ3）。
 *
 * **`ProjectFiles.test.tsx` を引き継いだもの。** あちらは「フォルダと中身を縦に積む器」
 * のテストで、器の役割が変わったのでここへ移した。**8本のうち7本はそのまま生きる**
 * ——起点・辿り方・コピーは何も変えていないため。1本だけ意味が変わる（下記）。
 *
 * ここで確かめないもの：**レイアウト**。jsdom は幅を常に 800・左端を常に 0 で返すので、
 * 位置から幅を出す経路は縮退した同じ数字しか通らない。当たることは E2E でしか言えない。
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FilesLayout } from '@/components/ProjectFiles/FilesLayout'

const ROOT = '/home/me/dev/app'

/** 場所ごとの遅れ（ミリ秒）。**返る順を押した順と入れ替える**ために使う。 */
let slow: Record<string, number> = {}

/** ☰ が開いている状態で置く。畳んだ状態を見たいテストは `open` を渡す。 */
function 置く(props: { project?: string; open?: boolean } = {}) {
  const toggles: string[] = []
  const view = render(
    <FilesLayout
      host="local"
      project={props.project ?? ROOT}
      open={props.open ?? true}
      onToggle={() => toggles.push('toggle')}
    />,
  )
  return { view, toggles }
}

beforeEach(() => {
  slow = {}
  globalThis.localStorage.clear()
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

describe('フォルダのオーバーレイ', () => {
  it('起点から始まり、起点より上へは辿れない', async () => {
    置く()

    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        ROOT,
      ),
    )

    // 上の段は出るが押せない。**出しても押せない段は作らない**のではなく、
    // 現在地までの道筋は見せたうえで、外側だけを塞ぐ
    const crumbs = screen.getAllByTestId('folder-crumb')
    expect(crumbs.map((crumb) => crumb.textContent)).toContain('app')
    for (const crumb of crumbs) {
      if (crumb.textContent === 'app') {
        expect(crumb).toBeEnabled()
      } else {
        expect(crumb).toBeDisabled()
      }
    }
  })

  it('別の枠へ移ると、その枠の起点から始まる', async () => {
    const other = '/home/me/dev/other'
    const { view } = 置く()
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        ROOT,
      ),
    )

    view.rerender(
      <FilesLayout host="local" project={other} open onToggle={() => {}} />,
    )
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        other,
      ),
    )

    // 落ち着いたあとも新しい枠のままであること（戻らない）
    await new Promise((done) => setTimeout(done, 50))
    expect(screen.getByTestId('folder-browser')).toHaveAttribute(
      'data-path',
      other,
    )
  })

  it('速く辿っても、古い応答が新しい表示を上書きしない', async () => {
    置く()
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        ROOT,
      ),
    )

    slow[`${ROOT}/MyDocs`] = 80
    const into = screen
      .getAllByTestId('folder-entry')
      .find((row) => row.getAttribute('data-name') === 'MyDocs')
    await userEvent.click(into as HTMLElement)
    const back = screen
      .getAllByTestId('folder-crumb')
      .find((crumb) => crumb.textContent === 'app')
    await userEvent.click(back as HTMLElement)

    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        ROOT,
      ),
    )
    await new Promise((done) => setTimeout(done, 150))
    expect(screen.getByTestId('folder-browser')).toHaveAttribute(
      'data-path',
      ROOT,
    )
  })

  it('フォルダ行から相対パスをコピーできる', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async (text: string) => void written.push(text)),
      },
    })

    置く()
    const rows = await screen.findAllByTestId('folder-copy')
    await userEvent.click(rows[0])

    // **フォルダは末尾に `/`**（入れ物だと一目で分かる）
    expect(written).toEqual(['MyDocs/'])
    // **ファイルには付かない。** 付けると、貼られた側で存在しない場所を指す
    await userEvent.click(rows[1])
    expect(written).toEqual(['MyDocs/', '計画.md'])
  })

  it('コピーを押しても階層は変わらない', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    })

    置く()
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        ROOT,
      ),
    )

    await userEvent.click((await screen.findAllByTestId('folder-copy'))[0])
    expect(screen.getByTestId('folder-browser')).toHaveAttribute(
      'data-path',
      ROOT,
    )
  })

  it('☰ が畳まれていれば、オーバーレイは出ない', () => {
    置く({ open: false })
    expect(screen.queryByTestId('project-files-panel')).toBeNull()
  })

  it('狭い画面用の「閉じる」は、☰ と同じ手を呼ぶ', async () => {
    const { toggles } = 置く()
    await userEvent.click(screen.getByTestId('project-files-close'))
    expect(toggles).toEqual(['toggle'])
  })
})

describe('ファイルの中身の列', () => {
  it('ファイルを選んでいないときは、列そのものが出ない', async () => {
    置く()
    await screen.findByTestId('folder-browser')

    expect(screen.queryByTestId('file-column')).toBeNull()
    expect(screen.queryByTestId('file-view')).toBeNull()
  })

  it('ファイルを押すと列が現れ、中身が出る', async () => {
    置く()

    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))

    const view = await screen.findByTestId('file-view')
    expect(view).toHaveAttribute('data-path', `${ROOT}/計画.md`)
    expect(screen.getByTestId('file-column')).toBeInTheDocument()
    // 基準は枠のパス。パネルの起点と同じものであることが要る
    expect(screen.getByTestId('file-relative-base')).toHaveTextContent(ROOT)
  })

  /*
    **`ProjectFiles.test.tsx` の「閉じると一覧だけに戻る」から意味が変わった1本。**

    移設前は縦に積んでいたので「閉じる＝下half が畳まれて一覧だけになる」だった。
    列に切り出したいまは「閉じる＝**列ごと消えてセッションが左へ寄る**」で、
    **フォルダのオーバーレイは開いたまま**である（設計§2）。
  */
  it('「閉じる」で列ごと消えるが、オーバーレイは開いたまま', async () => {
    置く()

    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))
    await screen.findByTestId('file-view')

    await userEvent.click(screen.getByTestId('file-close'))

    expect(screen.queryByTestId('file-column')).toBeNull()
    expect(screen.getByTestId('project-files-panel')).toBeInTheDocument()
    expect(screen.getByTestId('folder-browser')).toBeInTheDocument()
  })

  it('ファイルを選んでもオーバーレイは畳まれず、続けて別のファイルを開ける', async () => {
    // **利用者が名指しで決めた振る舞い**（2026-08-24）。実装の都合で変えないこと
    const { toggles } = 置く()

    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))
    await screen.findByTestId('file-view')

    expect(screen.getByTestId('project-files-panel')).toBeInTheDocument()
    // 畳む手は1度も呼ばれていない
    expect(toggles).toEqual([])
    // 一覧がそのまま残っているので、続けて別のファイルを押せる
    expect(screen.getByTestId('folder-browser')).toBeInTheDocument()
  })

  it('☰ を畳んでも、中身の列は残る', async () => {
    // 移設前は `picked` が `ProjectFiles` の中にあったので、パネルを畳むと消えていた。
    // 器へ上げたことで「ふだん（ファイルを開いている）」の並びが成立する（設計§2）
    const { view } = 置く()

    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))
    await screen.findByTestId('file-view')

    view.rerender(
      <FilesLayout
        host="local"
        project={ROOT}
        open={false}
        onToggle={() => {}}
      />,
    )

    await waitFor(() =>
      expect(screen.queryByTestId('project-files-panel')).toBeNull(),
    )
    expect(screen.getByTestId('file-column')).toBeInTheDocument()
  })

  it('選んでいるファイルを覚えていない', async () => {
    // 開いていたファイルを戻すかどうかは `イシューグループ_2026-0813-1804` が
    // 範囲を切っているので、そちらの結論を待つ（設計§3）
    const { view } = 置く()
    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))
    await screen.findByTestId('file-view')

    view.unmount()
    置く()
    await screen.findByTestId('folder-browser')

    expect(screen.queryByTestId('file-column')).toBeNull()
  })

  it('`FileView` が `h-full` を持ったまま運ばれている', async () => {
    /*
      **高さの鎖**（設計§7）。クローズ済みイシュー `ファイルの中身をスクロールできない`
      は「器から高さを渡す形」を採らず、「**器の側で渡すと、別の場所へ置いた瞬間に
      同じ症状が復活する**」と書き残した。今回はまさに「別の場所へ置く」に当たる。

      **字でしか言えない。** 実際に遡れるかは jsdom に配置が無いので E2E でしか
      確かめられない（テスト計画フェーズ4）。
    */
    置く()
    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))

    const view = await screen.findByTestId('file-view')
    expect(view.className).toContain('h-full')
  })
})

describe('縁', () => {
  it('フォルダと中身の両方に出る', async () => {
    置く()
    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))
    await screen.findByTestId('file-view')

    const edges = screen
      .getAllByTestId('files-resizer')
      .map((el) => el.getAttribute('data-edge'))
    expect(edges.sort()).toEqual(['file', 'folder'])
  })

  it('ファイルを開いていなければ、縁はフォルダの1本だけ', async () => {
    置く()
    await screen.findByTestId('folder-browser')

    const edges = screen.getAllByTestId('files-resizer')
    expect(edges).toHaveLength(1)
    expect(edges[0]).toHaveAttribute('data-edge', 'folder')
  })
})

/**
 * サムネイルを出さない、の実体（`ファイル閲覧で画像とHTMLも表示する` 設計§7-5）。
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

    置く()
    await screen.findByText('一枚目.png')

    // **一覧の1回だけ。** 画像の数だけ問答が走ると、跨いだ配置では
    // 1件あたり最大5秒の時間切れがその数だけ並ぶ
    expect(calls).toHaveLength(1)
    expect(calls.filter((url) => url.includes('as=raw'))).toHaveLength(0)
  })
})
