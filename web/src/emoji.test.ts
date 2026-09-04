import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 製品コードの絵文字が**増えていない**ことを数える（`DESIGN.md` §35.1）。
 *
 * # なぜ「0件」ではなく「増えていない」なのか
 *
 * §35.1 は「見つけたら、まず違反として記録する。**その場で直さなくてよい**」
 * 「**新しく書くコードで違反を増やさない**」という運用規則である。0件を要求すると、
 * 既知の違反を直すまで他の工事が1つも進められなくなる。
 *
 * # なぜこのテストが要ったのか
 *
 * **§35.1 には機械の見張りが1つも無かった。** 運用規則だけがあり、守られたかどうかは
 * 人が気づくかどうかに掛かっていた——`細かい修正_2026-0903` のテスト計画が
 * 「製品コードに絵文字が1つも増えていないこと」を求めていたのに、**それを見る手段が
 * 存在しなかった**ので、ここで足した。
 *
 * # コメントは数えない
 *
 * 束ねるときに落ちるので、利用者には届かない。**絵文字を使うなという注意書きが
 * 絵文字を含むせいで落ちる**、という形を避ける意味もある。
 */

/** 出す側の絵。`\p{Extended_Pictographic}` は `▶` や `☕` のような記号も拾う */
const 絵 = /\p{Extended_Pictographic}/u

function 歩く(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      歩く(p, out)
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

/** コメントを落とす。束ねると消えるものは、利用者に届かない */
function 素(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * いま在るもの。**この表を増やす変更は通らない。**
 *
 * | 種類 | どれ |
 * |---|---|
 * | **状態と向きの記号**（意図して出している） | `▶` `☕` `◀`——`README.md` の状態の表と、十字ボタンの向き |
 * | **`DESIGN.md` §35.1 の既知違反**（直す先は別のイシュー） | `fileKind.ts` と `FolderBrowser.tsx` のファイル種別の絵 |
 */
const 台帳: Readonly<Record<string, string>> = {
  'components/Dpad/Dpad.tsx': '▶◀',
  'components/FolderBrowser/FolderBrowser.tsx': '📁🔗',
  'lib/fileKind.ts': '🌐📄📝🖼',
  'lib/keys.ts': '▶',
  'lib/protocol.ts': '▶☕',
}

describe('絵文字は増やさない（DESIGN.md §35.1）', () => {
  it('台帳と実物が食い違っていない', () => {
    const 根 = resolve(process.cwd(), 'src')
    const 実物: Record<string, string> = {}
    for (const f of 歩く(根)) {
      const 当たり = [...素(readFileSync(f, 'utf8'))].filter((c) => 絵.test(c))
      if (当たり.length > 0) {
        const 鍵 = f.slice(根.length + 1).replace(/\\/g, '/')
        実物[鍵] = [...new Set(当たり)].sort().join('')
      }
    }
    // **どのファイルに何が在るか**まで見る。数だけだと、1つ消して1つ足したときに通る
    expect(実物).toEqual(台帳)
  })
})
