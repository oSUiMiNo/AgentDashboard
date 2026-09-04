import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 「閉じる」と「やめる」の線引きを、**ファイルをまたいで**固定する（細かい修正 設計§9-1）。
 *
 * # なぜ画面ではなくソースを読むのか
 *
 * ここで守りたいのは**1つの画面の中身ではなく、9箇所に散った線引き**である。
 * 画面から見ると、それぞれの部品に別々のテストを書くことになり、**線引きそのものは
 * どこにも書かれない**——1箇所を戻しても、他が緑なら気づけない。
 *
 * # 線引き
 *
 * **面を閉じるのは ✕、操作をやめるのは文字。** 理屈は `DESIGN.md` §39.6 と同じで、
 * **取り返しの付かなさが違うものを、隣に並べない**。閉じるのはいつでもやり直せるが、
 * 「やめる」は選択の1つである。
 */

function 読む(rel: string): string {
  return readFileSync(resolve(process.cwd(), 'src', rel), 'utf8')
}

/** 目印から、その部品の終わりまでを切り出す。属性と中身の両方をここで見る */
function 部品(src: string, testId: string, 終わり: string): string {
  const 頭 = src.indexOf(`data-testid="${testId}"`)
  expect(頭, `${testId} が見つからない`).toBeGreaterThan(-1)
  const 尻 = src.indexOf(終わり, 頭)
  expect(尻, `${testId} の閉じタグが見つからない`).toBeGreaterThan(-1)
  return src.slice(頭, 尻)
}

/**
 * 面を閉じるもの。**7箇所**。
 *
 * かつては8箇所あり、うち2つが `App.tsx` の帯（`error-banner-close` と
 * `selfheal-banner-close`）だった。**トーストへ移したので、代わりに `toast-close` が
 * 入っている**（トーストとベル設計§12-2）——作法そのものは1つも緩めていない。
 */
const 閉じる: ReadonlyArray<readonly [string, string]> = [
  ['components/ToastLayer/ToastLayer.tsx', 'toast-close'],
  ['components/Composer/Composer.tsx', 'composer-preview-close'],
  ['components/ProjectFiles/Sidebar.tsx', 'project-files-close'],
  ['components/FileView/FileView.tsx', 'file-close'],
  ['components/ProjectAdd/ProjectAdd.tsx', 'project-add-close'],
  ['components/SessionView/SessionView.tsx', 'close-session'],
  ['components/GroupView/GroupView.tsx', 'close-group'],
]

/** 操作をやめるもの。**3箇所とも文字のまま**（ダイアログの選択肢） */
const やめる: ReadonlyArray<readonly [string, string]> = [
  ['components/TileGrid/ReviveBudgetDialog.tsx', 'revive-budget-cancel'],
  ['components/Settings/VersionsCard.tsx', 'versions-confirm-cancel'],
  ['components/SessionAdd/SessionAdd.tsx', 'spawn-cancel'],
]

describe('面を閉じるのは ✕', () => {
  it.each(閉じる)('%s の %s が絵になっている', (file, testId) => {
    const 中 = 部品(読む(file), testId, '</Button>')
    expect(中).toContain('<CloseGlyph />')
    // **文字を絵に置き換えたまま**であること。両方あると、絵の横に字が出る
    expect(中).not.toMatch(/>\s*閉じる\s*</)
  })

  it.each(閉じる)('%s の %s に読み上げ用の名前が残っている', (file, testId) => {
    // **絵だけになると、読み上げでは何のボタンか分からなくなる**（設計§9-1）
    const 中 = 部品(読む(file), testId, '</Button>')
    expect(中).toContain('aria-label="閉じる"')
  })
})

describe('操作をやめるのは文字', () => {
  it.each(やめる)('%s の %s は文字のまま', (file, testId) => {
    const 中 = 部品(読む(file), testId, '</Button>')
    expect(中).toContain('やめる')
    // **取り返しが付かない操作の取り消しを、絵にしない**
    expect(中).not.toContain('CloseGlyph')
  })
})

describe('設定は歯車', () => {
  it('絵になっていて、読み上げ用の名前が残っている', () => {
    const 中 = 部品(読む('App.tsx'), 'settings-link', '</Link>')
    expect(中).toContain('<GearGlyph />')
    expect(中).toContain('aria-label="設定"')
    expect(中).not.toMatch(/>\s*設定\s*</)
  })

  it('隣の「アカウント」は文字のまま', () => {
    // **要件が名指ししているのは「設定」だけ。** 言われていないものを、
    // 揃えるためだけに変えない
    const 中 = 部品(読む('App.tsx'), 'account-link', '</Link>')
    expect(中).toContain('アカウント')
    expect(中).not.toContain('Glyph')
  })
})
