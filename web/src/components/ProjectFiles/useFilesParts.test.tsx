/**
 * ファイルの区画（設計§2・§3・§8。テスト計画フェーズ3・6・7）。
 *
 * **`ProjectFiles.test.tsx` を引き継いだもの。** あちらは「フォルダと中身を縦に積む器」
 * のテストで、器の役割が変わったのでここへ移した。**8本のうち7本はそのまま生きる**
 * ——起点・辿り方・コピーは何も変えていないため。1本だけ意味が変わる（下記）。
 *
 * ここで確かめないもの：**レイアウト**。jsdom は幅を常に 800・左端を常に 0 で返すので、
 * 位置から幅を出す経路は縮退した同じ数字しか通らない。当たることは E2E でしか言えない。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useFilesParts } from '@/components/ProjectFiles/useFilesParts'

const ROOT = '/home/me/dev/app'

/** 場所ごとの遅れ（ミリ秒）。**返る順を押した順と入れ替える**ために使う。 */
let slow: Record<string, number> = {}

/**
 * 場所ごとに返す失敗の番号。**「無い」と「読めない」を撃ち分ける**ために使う。
 *
 * 復元が落ちる先は 404 のときだけなので、403・503 と区別できないとこの節は書けない。
 */
let 失敗: Record<string, number> = {}

/** 覚えている場所を、テスト側から直に置く。綴りは実装から import しない */
function 覚えさせる(place: { dir?: string; pick?: string }, project = ROOT) {
  globalThis.localStorage.setItem(
    'agentdashboard.project-files-place',
    JSON.stringify({ [JSON.stringify(['local', project])]: place }),
  )
}

/** 覚えている中身を読み戻す。**忘れたかどうか**を見るのに要る */
function 覚えている(project = ROOT): { dir?: unknown; pick?: unknown } {
  const raw = globalThis.localStorage.getItem(
    'agentdashboard.project-files-place',
  )
  const table = JSON.parse(raw ?? '{}') as Record<string, never>
  return table[JSON.stringify(['local', project])] ?? {}
}

/**
 * **実物と同じ置き方をする。** `useFilesParts` は組み立て済みの2つを返すだけで、
 * どこへ置くかは画面が決める——**サイドバーはレールの外、中身の列はレールの中**
 * （`GroupView.tsx`）。ここで並べて置いてしまうと、置き場所の取り違えを見逃す。
 *
 * **名前だけ英語なのは、フックの規則に従うため。** `react-hooks(rules-of-hooks)` は
 * 「フックを呼ぶ関数は、大文字で始まる部品か `use` で始まるフック」しか認めない。
 */
function Placement({
  host,
  project,
  open,
  onToggle,
}: {
  host: string
  project: string
  open: boolean
  onToggle: () => void
}) {
  const { sidebar, column } = useFilesParts({ host, project, open, onToggle })
  return (
    <div className="relative flex min-h-0 flex-1 gap-4">
      {sidebar}
      <div data-testid="group-rail" className="flex min-h-0 min-w-0 flex-1 gap-4">
        {column}
      </div>
    </div>
  )
}

/** サイドバーが開いている状態で置く。畳んだ状態を見たいテストは `open` を渡す。 */
function 置く(props: { project?: string; open?: boolean } = {}) {
  const toggles: string[] = []
  const view = render(
    <Placement
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
  失敗 = {}
  globalThis.localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/file?')) {
        const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
        const 番号 = 失敗[path]
        if (番号 !== undefined) {
          return new Response('読めません', { status: 番号 })
        }
        return new Response(
          JSON.stringify({ path, text: '# 中身\n', truncated: false, bytes: 8 }),
          { status: 200 },
        )
      }
      const at = new URL(url, 'http://x').searchParams.get('path') ?? ROOT
      const 番号 = 失敗[at]
      if (番号 !== undefined) {
        return new Response('読めません', { status: 番号 })
      }
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

describe('サイドバー', () => {
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
      <Placement host="local" project={other} open onToggle={() => {}} />,
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

  it('サイドバーが畳まれていれば、フォルダは出ない', () => {
    置く({ open: false })
    expect(screen.queryByTestId('project-files-panel')).toBeNull()
  })

  it('狭い画面用の「閉じる」は、切り替えボタンと同じ手を呼ぶ', async () => {
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
    **サイドバーは開いたまま**である（設計§2）。
  */
  it('「閉じる」で列ごと消えるが、サイドバーは開いたまま', async () => {
    置く()

    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))
    await screen.findByTestId('file-view')

    await userEvent.click(screen.getByTestId('file-close'))

    expect(screen.queryByTestId('file-column')).toBeNull()
    expect(screen.getByTestId('project-files-panel')).toBeInTheDocument()
    expect(screen.getByTestId('folder-browser')).toBeInTheDocument()
  })

  it('ファイルを選んでもサイドバーは畳まれず、続けて別のファイルを開ける', async () => {
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

  it('サイドバーを畳んでも、中身の列は残る', async () => {
    // 移設前は `picked` が `ProjectFiles` の中にあったので、パネルを畳むと消えていた。
    // 器へ上げたことで「ふだん（ファイルを開いている）」の並びが成立する（設計§2）
    const { view } = 置く()

    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))
    await screen.findByTestId('file-view')

    view.rerender(
      <Placement host="local" project={ROOT} open={false} onToggle={() => {}} />,
    )

    await waitFor(() =>
      expect(screen.queryByTestId('project-files-panel')).toBeNull(),
    )
    expect(screen.getByTestId('file-column')).toBeInTheDocument()
  })

  it('選んでいたファイルを覚えていて、置き直すと戻る', async () => {
    /*
      **以前は「覚えていない」ことを主張していた**（`イシューグループ_2026-0813-1804`
      の結論待ちとして）。結論が出たので反転させた——覚える側が正しい姿である。

      押した1枚と復元した1枚は**落とし方が違う**ので、ここで見ているのは復元した側。
    */
    const { view } = 置く()
    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))
    await screen.findByTestId('file-view')

    view.unmount()
    置く()

    const 戻った = await screen.findByTestId('file-view')
    expect(戻った).toHaveAttribute('data-path', `${ROOT}/計画.md`)
  })

  it('掘っていた場所を覚えていて、置き直すと戻る', async () => {
    覚えさせる({ dir: `${ROOT}/MyDocs` })
    置く()

    // **起点が1フレームも見えないこと**は目でしか言えないが、着く先はここで言える
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        `${ROOT}/MyDocs`,
      ),
    )
  })

  it('畳んで開き直しても、掘っていた場所を覚えている', async () => {
    const { view } = 置く()
    await screen.findByTestId('folder-browser')
    const into = screen
      .getAllByTestId('folder-entry')
      .find((row) => row.getAttribute('data-name') === 'MyDocs')
    await userEvent.click(into as HTMLElement)
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        `${ROOT}/MyDocs`,
      ),
    )

    // 畳む → 開き直す。**「リロードでは覚えているのに畳むと戻る」を作らない**
    view.rerender(
      <Placement host="local" project={ROOT} open={false} onToggle={() => {}} />,
    )
    view.rerender(
      <Placement host="local" project={ROOT} open onToggle={() => {}} />,
    )

    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        `${ROOT}/MyDocs`,
      ),
    )
  })

  it('枠が空文字から実体へ変わっても、前の枠のファイルを読みに行かない', async () => {
    /*
      **セッション専用画面は、セッションが届くまで枠が空文字である**（設計§5-6）。
      相手の変化を効果で拾うと「新しい枠＋古い開いていたファイル」の描画が1回
      コミットされ、中身の列が**前の枠のファイルを実際に取りに行く**。
      描画中に直していれば、その問い合わせは1本も出ない。
    */
    覚えさせる({ pick: `${ROOT}/計画.md` })
    const { view } = 置く({ project: '' })
    await new Promise((done) => setTimeout(done, 20))

    view.rerender(
      <Placement host="local" project={ROOT} open onToggle={() => {}} />,
    )
    await screen.findByTestId('file-view')

    // **出さないことは、回数でしか言えない**
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string][] } })
      .mock.calls.map(([url]) => url)
    expect(calls.filter((url) => url.includes('/file?'))).toHaveLength(1)
  })

  it('開いている最中に掘っても、読み直しは走らない', async () => {
    /*
      **覚えた値を `start` へ流し続けない**（設計§5-2）。流すと `start` が変わる
      たびに辿り直しの効果が走り、**移動1回につき問い合わせが2回**になる。
      跨いだ配置では1回あたり最大5秒かかるので、実害が出る。
    */
    置く()
    await screen.findByTestId('folder-browser')
    const 前 = (globalThis.fetch as unknown as { mock: { calls: [string][] } })
      .mock.calls.length

    const into = screen
      .getAllByTestId('folder-entry')
      .find((row) => row.getAttribute('data-name') === 'MyDocs')
    await userEvent.click(into as HTMLElement)
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        `${ROOT}/MyDocs`,
      ),
    )
    await new Promise((done) => setTimeout(done, 50))

    const 後 = (globalThis.fetch as unknown as { mock: { calls: [string][] } })
      .mock.calls.length
    expect(後 - 前).toBe(1)
  })

  it('覚えていた場所が無ければ、黙って起点へ落ちる', async () => {
    覚えさせる({ dir: `${ROOT}/消えた` })
    失敗[`${ROOT}/消えた`] = 404
    置く()

    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        ROOT,
      ),
    )
    // **断り文を出さない。** 覚えていた場所は利用者がいま押したものではない
    expect(screen.queryByTestId('folder-error')).toBeNull()
  })

  it('覚えていた場所が「読めない」だけなら、落とさずに理由を出す', async () => {
    覚えさせる({ dir: `${ROOT}/MyDocs` })
    失敗[`${ROOT}/MyDocs`] = 403
    置く()

    /*
      **起点へ行き直さない。** 寝ている PC では起点も同じ理由で失敗するので、
      見える結果は変わらないまま時間切れが2回並ぶ（設計§6-3）。
      記憶も残るので、PC が起きれば戻る。
    */
    expect(await screen.findByTestId('folder-error')).toBeInTheDocument()
    expect(screen.getByTestId('folder-browser')).not.toHaveAttribute(
      'data-path',
      ROOT,
    )
  })

  it('覚えていたファイルが読めなければ、列ごと畳む', async () => {
    覚えさせる({ pick: `${ROOT}/消えた.md` })
    失敗[`${ROOT}/消えた.md`] = 404
    置く()

    await screen.findByTestId('folder-browser')
    // **赤い1行を出したまま開かない。** 開いた瞬間に断り文で出迎えることになる
    await waitFor(() =>
      expect(screen.queryByTestId('file-column')).toBeNull(),
    )
  })

  it('覚えていた場所が「繋がっていない」だけなら、落とさずに理由を出す', async () => {
    覚えさせる({ dir: `${ROOT}/MyDocs` })
    失敗[`${ROOT}/MyDocs`] = 503
    置く()

    // **寝ている PC で記憶を消さない。** 起点も同じ理由で失敗するので、
    // 行き直しても見える結果は変わらないまま時間切れが2回並ぶ（設計§6-3）
    expect(await screen.findByTestId('folder-error')).toBeInTheDocument()
    expect(覚えている().dir).toBe(`${ROOT}/MyDocs`)
  })

  it('起点へ落ちたあと、覚えていた場所が起点で上書きされる', async () => {
    覚えさせる({ dir: `${ROOT}/消えた` })
    失敗[`${ROOT}/消えた`] = 404
    置く()

    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        ROOT,
      ),
    )
    /*
      **専用の「忘れる」通知を持たずに済んでいること**（設計§6-2）。
      起点へ着けば `onPathChange` が飛ぶので、死んだ値はその場で上書きされる。
    */
    await waitFor(() => expect(覚えている().dir).toBe(ROOT))
  })

  it('覚えていたファイルが「無い」ときは忘れ、「読めない」ときは忘れない', async () => {
    覚えさせる({ pick: `${ROOT}/消えた.md` })
    失敗[`${ROOT}/消えた.md`] = 404
    const 一度目 = 置く()
    // **忘れる＝行から鍵を消すのではなく `null` を書く**（`putPick(…, null)`）
    await waitFor(() => expect(覚えている().pick).toBeNull())
    一度目.view.unmount()

    // **寝ている PC で忘れると、起きたときに戻る先が消えている**（設計§6-5）
    globalThis.localStorage.clear()
    覚えさせる({ pick: `${ROOT}/眠い.md` })
    失敗[`${ROOT}/眠い.md`] = 503
    置く()
    await screen.findByTestId('folder-browser')
    await waitFor(() =>
      expect(screen.queryByTestId('file-column')).toBeNull(),
    )
    // **畳むのは全部の失敗で、忘れるのは「無い」ときだけ**
    expect(覚えている().pick).toBe(`${ROOT}/眠い.md`)
  })

  it('押したファイルが読めなければ、畳まずに理由を出す', async () => {
    失敗[`${ROOT}/計画.md`] = 404
    置く()

    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))

    // **押した1枚には知らせ先を渡していない。** 押した人には理由を見せる
    expect(await screen.findByTestId('file-error')).toBeInTheDocument()
    expect(screen.getByTestId('file-column')).toBeInTheDocument()
  })

  it('覚えが無ければ、中身の列は出ない', async () => {
    置く()
    await screen.findByTestId('folder-browser')
    expect(screen.queryByTestId('file-column')).toBeNull()
  })

  it('別の枠は、別の記憶を引く', async () => {
    const { view } = 置く()
    await userEvent.click(await screen.findByRole('button', { name: /計画\.md/ }))
    await screen.findByTestId('file-view')

    view.unmount()
    // **鍵に PJT が入っている**ので、隣の枠へは持ち越さない
    置く({ project: '/home/me/dev/other' })
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

/**
 * 器が1つであることの台帳（設計§3）。
 *
 * # なぜ画面を描いて確かめないのか
 *
 * **「2箇所に写しがある」は、描いても分からない。** 写しは同じものを描くので、
 * 片方だけ見ても両方見ても、食い違うまでは正しく見える。**食い違ってから気づく**
 * のでは遅く、しかもそのとき片方は普通に動いているので「直った」と読める。
 *
 * だからテキストで見る。出所は `web/src/roam.test.ts` ／ `tile.test.ts` の
 * 「定義をテキストとして確かめる」と同じ考え方。
 */

describe('広い窓で押しのける（場所取り）', () => {
  /*
    **狭い窓は被さったまま、広い窓では被せない**（設計§2 の 2026-08-27 の変更）。
    押しのけているのは、パネルの隣に置いた「場所取り」——パネル自身はフローの外に
    居続ける（`Sidebar.tsx` の JSDoc）。

    **どれだけ押しのけたかは、ここでは測れない。** jsdom は幅を常に 800・左端を常に 0
    で返すので、位置から出す経路は縮退した同じ数字しか通らない。実際に右へずれることは
    E2E でしか言えない。ここで見るのは**居ることと、綴りと、読み上げに出ないこと**。
  */
  it('サイドバーが開いていると、場所取りが出る', async () => {
    置く()

    await waitFor(() =>
      expect(screen.getByTestId('sidebar-space')).toBeInTheDocument(),
    )
  })

  it('畳んでいれば、場所取りは出ない', () => {
    置く({ open: false })

    expect(screen.queryByTestId('sidebar-space')).toBeNull()
  })

  it('場所取りは、フォルダの幅ぶんの場所を取る', async () => {
    置く()

    // 既定は 320px（`panelWidth.ts` の `PANEL_RANGE`）。**この幅ぶん右がずれる**
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-space')).toHaveStyle({ width: '320px' }),
    )
  })

  it('場所取りは、狭い窓では消える綴りになっている', async () => {
    置く()

    /*
      **`hidden md:block` が安全弁。** 狭い窓では `display:none` になるので、
      framer が当てるインラインの `width` が1ピクセルも効かない——`fixed inset-0` へ
      `width` が加わると `right` が捨てられ、**全幅のドロワーが 320px の帯に化ける**
      という罠（フェーズ1 の実測）を、これで踏まずに済む
    */
    const space = await screen.findByTestId('sidebar-space')
    expect(space).toHaveClass('hidden')
    expect(space).toHaveClass('md:block')
  })

  it('場所取りは、読み上げには出ない', async () => {
    置く()

    // 見せるものが何も無く、場所を作ることだけが仕事なので
    const space = await screen.findByTestId('sidebar-space')
    expect(space).toHaveAttribute('aria-hidden')
  })
})

describe('狭い窓の膜', () => {
  /*
    **地が黒い画面では、目で見ても膜の有無が分からない。** 参考の動画を最初は「膜は
    無い」と読み違え、**フレームの画素を測って初めて**分かった——ヘッダも本文も入力欄も
    255→131・32→17 と同じ比で落ちており、**画面全体を覆う約半分の黒**だった。

    だから**綴りで見張る**。見た目の確認では戻されても気づけない。
  */
  it('サイドバーを開くと、膜が出る', async () => {
    置く()

    const 膜 = await screen.findByTestId('sidebar-scrim')
    expect(膜).toHaveClass('bg-black/50')
    // 広い窓では敷かない（あちらは押しのけるので、裏に隠れるものが無い）
    expect(膜).toHaveClass('md:hidden')
  })

  it('畳んでいれば、膜は出ない', () => {
    置く({ open: false })

    expect(screen.queryByTestId('sidebar-scrim')).toBeNull()
  })

  it('膜を押すと畳む', async () => {
    /*
      **参考の動画では確かめられていない**（閉じるボタンしか押されていない）。それでも
      入れるのは、**膜が裏への操作を塞ぐ**から——押しても何も起きない膜は行き止まりに
      なる。閉じるボタンと合わせて出口を2つ持たせる
    */
    const { toggles } = 置く()

    await userEvent.click(await screen.findByTestId('sidebar-scrim'))

    expect(toggles).toEqual(['toggle'])
  })

  it('膜は、読み上げには出ない', async () => {
    置く()

    expect(await screen.findByTestId('sidebar-scrim')).toHaveAttribute('aria-hidden')
  })
})

describe('器が1つであること', () => {
  /**
   * コメントを落とす。**中に `<aside>` と書いてある**ので、先に消さないと自分の
   * 説明文を拾ってしまう（出所は `roam.test.ts` の `素のCSS`）。
   */
  const 素のコード = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const 読む = (path: string) =>
    素のコード(readFileSync(resolve(process.cwd(), 'src', path), 'utf8'))

  const 画面 = {
    'PJT 専用画面': 読む('components/GroupView/GroupView.tsx'),
    'セッション専用画面': 読む('components/SessionView/SessionView.tsx'),
  }

  it('どちらの画面も、同じところで区画を組み立てている', () => {
    /*
      **器が1つの `<div>` であることではなく、状態が1箇所にあることを見る**
      （`useFilesParts` の JSDoc）。中身の列だけレールの中へ入れたので、
      2つの子は別々の親へ行く——それでも**組み立てているのは1箇所**である
    */
    for (const [名前, 中身] of Object.entries(画面)) {
      expect(中身, `${名前} が useFilesParts を使っていること`).toContain(
        'useFilesParts(',
      )
    }
  })

  /*
    **どちらの画面にもレールが在る**（`スマホでファイルビュアを開くと画面が崩れる`
    設計§2）。**2026-09-04 まではセッション専用画面に無く、ここも PJT 専用画面しか
    見ていなかった**——その結果、狭い窓でセッションの面が 0px まで潰れる不具合を、
    このテストは1度も捕まえられなかった。**片方だけ見る形に戻さないこと。**

    ここが見るのは**置き場所**だけ。**幅そのものは jsdom では測れない**（配置を
    持たないので 0 を返す）ので、E2E が受け持つ（設計§9）。
  */
  const レールの目印 = {
    'PJT 専用画面': 'data-testid="group-rail"',
    'セッション専用画面': 'data-testid="session-rail"',
  } as const

  /**
   * **レールを置いている場所**（呼び出し側）と、**そこへ何を渡しているか**。
   *
   * # 目印の位置では見られない
   *
   * セッション専用画面のレールは**ファイルの末尾で定義したローカル部品**なので、
   * `data-testid="session-rail"` が出てくるのは**呼び出し側よりずっと後ろ**である。
   * 目印から後ろを切り出す形だと、**呼び出し側でサイドバーをレールの中へ入れても
   * 素通りする**——「レールの外に置いてある」を主張しているのに、何も見張っていない
   * 状態になっていた（レビューで指摘され、実際に骨抜きだった）。
   *
   * **だから画面ごとに「レールが始まる字」と「列を渡す字」を持つ。**
   */
  const レール = {
    'PJT 専用画面': { 始まり: 'data-testid="group-rail"', 列: '{column}' },
    'セッション専用画面': { 始まり: '<SessionRail', 列: 'column={column}' },
  } as const
  const 取る = (名前: string) => レール[名前 as keyof typeof レール]

  it('中身の列は、どちらの画面でもレールへ渡っている', () => {
    for (const [名前, 中身] of Object.entries(画面)) {
      const { 始まり, 列 } = 取る(名前)
      const 位置 = 中身.indexOf(始まり)
      expect(位置, `${名前} にレールが在ること`).toBeGreaterThan(-1)
      expect(
        中身.slice(位置),
        `${名前} がレールへ列を渡していること`,
      ).toContain(列)
    }
  })

  it('サイドバーは、どちらの画面でもレールの外に置いてある', () => {
    /*
      一緒に流れると、横へ動かしたとき左から出ているものが画面から消える。

      **呼び出し側の並びで見る。** サイドバーはレールが始まる字より前に居なければ
      ならない——`{!compact && sidebar}` と `{sidebar}` で綴りが違うので、
      画面ごとの字ではなく `sidebar` という語の**最後の出現**で測る。
    */
    for (const [名前, 中身] of Object.entries(画面)) {
      const { 始まり } = 取る(名前)
      expect(
        中身.lastIndexOf('sidebar'),
        `${名前} のサイドバーがレールより前＝レールの外に居ること`,
      ).toBeLessThan(中身.indexOf(始まり))
    }
  })

  it('レールに位置の基準を持たせていない', () => {
    /*
      **十字ボタンの重なりの基準はセッションの面**（十字ボタン設計§10）。レールに
      `relative` を付けると、より近い祖先ができて基準がずれる。PJT 専用画面の
      レールも同じ理由で持っていない。

      ここは**実物の要素**を見たいので、呼び出し側ではなく目印の側から測る。
    */
    for (const [名前, 中身] of Object.entries(画面)) {
      const 目印 = レールの目印[名前 as keyof typeof レールの目印]
      const 開始 = 中身.indexOf(目印)
      expect(開始, `${名前} にレールの目印が在ること`).toBeGreaterThan(-1)
      // 目印からクラス名の終わりまでを切り出して、その中だけを見る
      const 断片 = 中身.slice(開始, 中身.indexOf('>', 開始))
      expect(断片, `${名前} のレールに relative が無いこと`).not.toMatch(
        /className="[^"]*\brelative\b/,
      )
    }
  })

  it('`<aside>` の写しが、どちらにも残っていない', () => {
    // 移設前はここに**クラス文字列まで一字一句同じもの**が2つあった。
    // 戻すと、片方だけ直る形がまた作れてしまう
    for (const [名前, 中身] of Object.entries(画面)) {
      expect(中身, `${名前} に <aside> が残っていないこと`).not.toContain(
        '<aside',
      )
      expect(中身, `${名前} に project-files-panel が残っていないこと`).not.toContain(
        'project-files-panel',
      )
    }
  })

  it('切り替えボタンも、どちらの画面も同じ部品を使っている', () => {
    for (const [名前, 中身] of Object.entries(画面)) {
      expect(中身, `${名前} が FilesToggle を使っていること`).toContain(
        '<FilesToggle',
      )
      expect(中身, `${名前} に ☰ の直書きが残っていないこと`).not.toContain(
        'project-files-toggle',
      )
    }
  })

  it('取り合いの器が、サイドバーの基準になっている', () => {
    // サイドバーは広い画面で `md:absolute` になるので、**祖先に位置の基準が要る**。
    // 無いと `fixed` と同じく画面の上端から被さり、アプリのヘッダまで覆う
    for (const [名前, 中身] of Object.entries(画面)) {
      expect(中身, `${名前} の取り合いの器に relative があること`).toContain(
        'className="relative flex min-h-0 flex-1 gap-4"',
      )
    }
  })
})
