import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 回遊の定義（`roam.css`）を、**テキストとして**確かめる。
 *
 * # なぜテキストなのか
 *
 * jsdom は CSS を適用しないので、「『控えめ』で止まる」「OS が『動きを減らす』と言えば
 * 止まる」は画面を描いても1つも確かめられない（`tile.test.ts` の冒頭と同じ理由）。
 * ここで言えるのは「そう書いてある」ことまでで、**実際に効くかは E2E と実物が見る**。
 *
 * それでも書く価値があるのは、**打ち消しが効かなくなる形が構造で決まっている**ため
 * ——順序が1つ入れ替わるだけで、静けさも OS 設定も黙って効かなくなる。
 *
 * # パーサを複製している
 *
 * 下の分割は `web/src/tile.test.ts` からの**写し**である。共有ヘルパへ切り出すと
 * 台帳そのもの（あちら）に手が入るので、**削らずそのまま複製して出所を書く**
 * （ガイドライン「ヘルパを写すなら削らずそのまま＋出所をコメント」）。
 */

function 読む(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src', name), 'utf8')
}

const CSS = 読む('roam.css')
const INDEX = 読む('index.css')

/** コメントを落とす。中に `{}` が入っているので、先に消さないと分割が狂う */
function 素のCSS(): string {
  return CSS.replace(/\/\*[\s\S]*?\*\//g, '')
}

interface Rule {
  selector: string
  body: string
  /** ファイルの先頭からの位置。**打ち消しが後ろにあること**を見るのに使う */
  at: number
}

/** 素朴なブロック分割。`@media` は1段だけ展開し、`@keyframes` は塊ごと飛ばす */
function 分ける(): Rule[] {
  const src = 素のCSS()
  const rules: Rule[] = []
  let i = 0
  while (i < src.length) {
    const 開き = src.indexOf('{', i)
    if (開き === -1) break
    const セレクタ = src.slice(i, 開き).trim()
    let 深さ = 1
    let j = 開き + 1
    while (j < src.length && 深さ > 0) {
      if (src[j] === '{') 深さ += 1
      if (src[j] === '}') 深さ -= 1
      j += 1
    }
    const 中身 = src.slice(開き + 1, j - 1)
    if (セレクタ.startsWith('@media')) {
      // 条件をセレクタへ前置して、1段だけ中を開く
      let k = 0
      while (k < 中身.length) {
        const 内開き = 中身.indexOf('{', k)
        if (内開き === -1) break
        const 内閉じ = 中身.indexOf('}', 内開き)
        rules.push({
          selector: `${セレクタ} ${中身.slice(k, 内開き).trim()}`,
          body: 中身.slice(内開き + 1, 内閉じ),
          at: 開き,
        })
        k = 内閉じ + 1
      }
    } else if (!セレクタ.startsWith('@keyframes')) {
      rules.push({ selector: セレクタ, body: 中身, at: 開き })
    }
    i = j
  }
  return rules
}

const 全規則 = 分ける()

function 当たる(部分: string): Rule[] {
  return 全規則.filter((rule) => rule.selector.includes(部分))
}

describe('回遊の定義の読み込み', () => {
  it('index.css から取り込まれている', () => {
    // **書き忘れても、位置を誤っても、このファイルのテストは全部緑のまま通る。**
    // `@import` は他の規則より前でないと捨てられるので、位置まで見る
    expect(INDEX.indexOf("@import './roam.css'")).toBeGreaterThan(-1)

    const 素のINDEX = INDEX.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(素のINDEX.indexOf("@import './roam.css'")).toBeLessThan(
      素のINDEX.indexOf('{'),
    )
  })

  it('較正：分割が実物の規則を拾えている', () => {
    // 数え違いをしていれば、以下のテストは「当たらないから通る」空振りになる。
    // **規則の数そのものは見ない**——数で見ると、規則を1本消す壊し方のたびに
    // ここまで落ちて、狙ったテストが1本だけ落ちたのかが読めなくなる
    expect(当たる('.roam-layer')).not.toHaveLength(0)
    expect(当たる('.roam-line')).not.toHaveLength(0)
    expect(素のCSS()).toContain('@keyframes roam-drift')
  })
})

describe('層は場所を取らず、何も塗らない', () => {
  it('画面に貼りついていて、押す邪魔をしない', () => {
    // `fixed` なのは、一覧のスクロールする入れ物にもカードの切る枠にも
    // **切られないため**。`absolute` にすると両方に切られる
    const 層 = 全規則.filter((rule) => rule.selector.trim() === '.roam-layer')
    expect(層).toHaveLength(1)
    expect(層[0].body).toContain('position: fixed')
    expect(層[0].body).toContain('pointer-events: none')
  })

  it('層そのものを塗らない', () => {
    // 塗ると**画面いっぱいの合成テクスチャが1枚生える**。塗ってよいのは線だけ
    const 層 = 全規則.filter((rule) => rule.selector.trim() === '.roam-layer')
    for (const 禁止 of ['background', 'filter', 'opacity', 'transform', 'will-change']) {
      expect(層[0].body).not.toContain(禁止)
    }
  })

  it('z-index を書かない', () => {
    // `z-index: auto` の `fixed` は DOM 順で「中身より上・ダイアログより下」に
    // 自然に収まる。書き足すと重なりの文脈が増えるだけ（`tile.css` と同じ方針）
    expect(素のCSS()).not.toContain('z-index')
  })

  it('will-change を書かない', () => {
    // 動く変形は自動で合成層に載る。書くと副作用だけが残る（調査§6-10）
    expect(素のCSS()).not.toContain('will-change')
  })

  it('位置と大きさそのものは動かさない', () => {
    const 動く = 素のCSS().match(/@keyframes[\s\S]*?\n}/g) ?? []
    expect(動く).not.toHaveLength(0)
    for (const keyframes of 動く) {
      expect(keyframes).not.toMatch(/^\s*(width|height|top|left|margin|padding):/m)
    }
  })

  it('飛ぶ時間を CSS 側に書かない', () => {
    // **秒数の出どころは層（TSX）1箇所。** ここへ書くと、寿命のタイマと見た目の
    // 長さが別々に育って食い違う
    const 線 = 全規則.filter((rule) => rule.selector.trim() === '.roam-line')
    expect(線).toHaveLength(1)
    expect(線[0].body).not.toMatch(/animation-duration/)
    expect(線[0].body).not.toMatch(/animation:\s*[^;]*\d+m?s/)
  })
})

describe('止める道', () => {
  it('控えめでも静止でも、回遊は止まる', () => {
    // **ここが `tile.css` の3段と違う。** あちらの「控えめ」は作業中の回転だけを
    // 止めて承認待ちの跳ねは残すが、画面じゅうを飛び回る動きはいちばん静めたい
    for (const 段 of ['calm', 'still']) {
      const 規則 = 当たる(`[data-quiet='${段}']`)
      expect(規則).not.toHaveLength(0)
      for (const rule of 規則) {
        expect(rule.selector).toContain('.roam-line')
        expect(rule.body).toContain('animation: none')
      }
    }
  })

  it('段の選択によらず止める', () => {
    // 要件の完了条件が無条件なので、段で覆せるようにしない（設計§9-5-2）
    const 減らす = 当たる('prefers-reduced-motion')
    expect(減らす).not.toHaveLength(0)
    for (const rule of 減らす) {
      expect(rule.body).toContain('animation: none')
      expect(rule.selector).not.toContain('data-quiet')
    }
  })

  it('打ち消しが、止める対象より後ろに書いてある', () => {
    // 詳細度が並ぶので**順序だけで勝つ**。前に書くと1つも止まらない
    const 最後の動き = Math.max(
      ...全規則
        .filter(
          (rule) =>
            /animation-name:\s*roam-/.test(rule.body) &&
            !rule.selector.includes('prefers-reduced-motion'),
        )
        .map((rule) => rule.at),
    )
    const 最初の打ち消し = Math.min(
      ...当たる('prefers-reduced-motion').map((rule) => rule.at),
    )
    expect(最初の打ち消し).toBeGreaterThan(最後の動き)
  })
})
