import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BASE_TITLE, documentTitle, useDocumentTitle } from './documentTitle'
import { projectDisplayName } from './path'

/**
 * タブの名前（テスト計画フェーズ1〜3）。
 *
 * # 3つ目の describe だけ、製品の振る舞いを見ていない
 *
 * この工事でいちばん壊れやすいのは「`document.title` へ書く場所が1つであること」で、
 * **`SessionView` へ足しても普段は動いてしまう**（PJT 専用画面を開いたときだけ、
 * 複数の書き手が競って名前が暴れる）。振る舞いからは捕まえにくいので、
 * **コードの形そのものを数える。**
 */

/*
  **`import.meta.url` は使えない。** Vite が配る URL は `file:` ではないので
  `fileURLToPath()` が落ちる。vitest の根は `web/` なので、そこから辿る。
  取り違えたまま**0件を数えて緑になる**のが最悪なので、無ければその場で止める。
*/
const SRC = join(process.cwd(), 'src')
const INDEX_HTML = join(process.cwd(), 'index.html')
if (!existsSync(SRC) || !existsSync(INDEX_HTML)) {
  throw new Error(`見張りの起点が見つからない：${process.cwd()}`)
}

/** `document.title` へ**代入している**行だけを拾う（読むだけの行は書き手ではない）。 */
const 代入 = /document\s*\.\s*title\s*=[^=]/

/**
 * 製品コードの `.ts` / `.tsx` を数え上げる。
 *
 * **テストは除く。** テスト側が `document.title` を読み書きするのは当たり前で、
 * 混ぜると「見張りが自分自身に引っかかる」だけになる。
 */
function 製品コード(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'test') {
        製品コード(path, acc)
      }
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(path)
    }
  }
  return acc
}

describe('documentTitle（決める側）', () => {
  it('名前を渡すと、PJT 名と既定が区切りで並ぶ', () => {
    expect(documentTitle('家計簿')).toBe('家計簿 | AgentDashboard')
  })

  it('PJT 名が先、既定が後になる', () => {
    // **狭いタブは後ろから切られる。** 逆に置くと、切られた瞬間にどのタブも
    // `AgentDashboa…` になって見分けが付かなくなる（この工事が消える）
    const title = documentTitle('家計簿')
    expect(title.startsWith('家計簿')).toBe(true)
    expect(title.startsWith(BASE_TITLE)).toBe(false)
  })

  it('名前が無ければ既定だけになる', () => {
    expect(documentTitle()).toBe(BASE_TITLE)
    expect(documentTitle('')).toBe(BASE_TITLE)
  })

  it('同名の PJT に付く番号は、そのままタブの名前に乗る', () => {
    // 帯と同じ関数を通すことが「揃える」の中身なので、**番号の付いた名前を
    // 食わせて、落とさずに運ぶ**ことだけをここで見る（番号の正しさ自体は
    // `path.test.ts` が持っている）
    const projects = [
      { path: '/home/example/a/app', created_at: 1 },
      { path: '/home/example/b/app', created_at: 2 },
    ]
    const 名前 = projectDisplayName('/home/example/b/app', projects)

    expect(名前).toBe('app (2)')
    expect(documentTitle(名前)).toBe('app (2) | AgentDashboard')
  })
})

describe('useDocumentTitle（書く側）', () => {
  beforeEach(() => {
    // jsdom の初期値は空文字。**既定から始める**ことで「戻った」を見分けられる
    document.title = BASE_TITLE
  })

  afterEach(() => {
    document.title = BASE_TITLE
  })

  it('回すとタブの名前が変わる', () => {
    renderHook(() => useDocumentTitle('家計簿'))

    expect(document.title).toBe('家計簿 | AgentDashboard')
  })

  it('離れると既定へ戻る', () => {
    // 戻さないと、一覧へ帰ったタブに前の PJT 名が残ったままになる
    const { unmount } = renderHook(() => useDocumentTitle('家計簿'))
    expect(document.title).toBe('家計簿 | AgentDashboard')

    unmount()

    expect(document.title).toBe(BASE_TITLE)
  })

  it('名前が変わると追随する', () => {
    // **タブを開き直さなくてよい**（画面を移ったら名前も移る）
    const { rerender } = renderHook(({ 名前 }) => useDocumentTitle(名前), {
      initialProps: { 名前: '家計簿' as string | undefined },
    })
    expect(document.title).toBe('家計簿 | AgentDashboard')

    rerender({ 名前: '日記' })

    expect(document.title).toBe('日記 | AgentDashboard')
  })
})

describe('見張り', () => {
  it('タブの名前を書いているのは、このファイルだけ', () => {
    const 書き手 = 製品コード(SRC)
      .filter((path) => 代入.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path))

    // **増えていたらここで止まる。** `SessionView` は PJT 専用画面で複数枚
    // 描かれるので、あそこへ1行足すと書き手がセッションの本数だけ増える
    expect(書き手).toEqual(['lib/documentTitle.ts'])
  })

  it('既定の名前が、最初に出る `index.html` の名前と揃っている', () => {
    // 最初の1描画までは `index.html` の `<title>` が出ている。食い違うと
    // **開いた瞬間だけ別の名前が見える**
    const title = /<title>([^<]*)<\/title>/.exec(readFileSync(INDEX_HTML, 'utf8'))

    expect(title?.[1]).toBe(BASE_TITLE)
  })
})
