import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 整形した Markdown の見た目を、**テキストとして**確かめる（細かい修正 設計§3-5）。
 *
 * jsdom はカスケードを解決しないので、画面から色を読むことはできない。ここで見られるのは
 * **そう書いてあること**まで——実際にどう見えるかは実機の目で確かめる。
 */
const CSS = readFileSync(resolve(process.cwd(), 'src', 'index.css'), 'utf8')
/** コメントを落とす。中に `{}` が入っているので、先に消さないと分割が狂う */
const 素 = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

describe('Markdown のチェックボックス', () => {
  it('チェックの印が Primary Accent で塗られている', () => {
    // それまで色の指定が**1つも無く**ブラウザ任せ（灰色）だった。
    // 要件の「青基調」は Primary Accent に収まるので、**新しい色を1つも増やさない**
    const 規則 = /\.prose-dashboard input\[type='checkbox'\]\s*\{([^}]*)\}/.exec(素)
    expect(規則, 'チェックボックスの規則が見つからない').not.toBeNull()
    expect(規則![1]).toContain('accent-color: #3dd9e6')
  })

  it('accent-color を書いているのは、この1箇所だけ', () => {
    // 散らすと、Primary Accent を差し替えたときに片方だけ古くなる
    expect(素.match(/accent-color:/g) ?? []).toHaveLength(1)
  })

  it('状態の色（完了の Lime）は使っていない', () => {
    // **これはアプリの「完了」状態ではなく、文書の中身である**（設計§3-5）。
    // ファイルに書いてある字をそのまま描いたものなので、`DESIGN.md` §11.2 の Lime は当てない
    const 規則 = /\.prose-dashboard input\[type='checkbox'\]\s*\{([^}]*)\}/.exec(素)
    expect(規則![1]).not.toContain('#8fd14f')
  })
})
