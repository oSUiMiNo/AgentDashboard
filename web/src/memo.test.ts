import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * メモの吹き出しの操作の定義（`memo.css`）を、**テキストとして**確かめる。
 *
 * # なぜテキストなのか
 *
 * **jsdom は CSS を適用しない。** 「指の画面では出る」「見えていないものは押せない」は
 * 画面を描いても1つも確かめられない。ここで見られるのは**そう書いてあること**までで、
 * 実際に効くかどうかは実機の目で確かめる（`tile.test.ts` と同じ立場）。
 *
 * それでも書く価値があるのは、**壊れ方が構造で決まっている**からである——`opacity` を
 * 0 にしただけで `pointer-events` を戻し忘れると、**見えないボタンが押せる**状態が
 * 黙って戻る。`v0.1.138` はまさにその形だった。
 *
 * # 依存を増やさない
 *
 * CSS のパーサは入れない。素朴なブロック分割で足りる（`tile.test.ts` と同じ作り）。
 */
function 読む(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src', name), 'utf8')
}

/** コメントを落とす。中に `{}` が入っているので、先に消さないと分割が狂う */
const 素 = 読む('memo.css').replace(/\/\*[\s\S]*?\*\//g, '')

interface Rule {
  /** セレクタ（`@media` の中なら、その条件を前置した形） */
  selector: string
  /** 宣言の中身 */
  body: string
}

/** 入れ子を数えて、対応する `}` の位置を返す */
function 対応する閉じ(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return source.length - 1
}

/** 規則を平らに取り出す。`@media` は1段だけ展開し、条件をセレクタへ前置する */
function rules(source: string, prefix = ''): Rule[] {
  const found: Rule[] = []
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('{', index)
    if (open === -1) break
    const head = source.slice(index, open).trim()
    const close = 対応する閉じ(source, open)
    const inner = source.slice(open + 1, close)
    if (head.startsWith('@media')) {
      found.push(...rules(inner, `${head} `))
    } else {
      found.push({ selector: `${prefix}${head}`, body: inner })
    }
    index = close + 1
  }
  return found
}

const 全規則 = rules(素)

/**
 * その規則が**群そのもの**を指しているか。
 *
 * **`includes('.memo-ops')` で見てはいけない。** `.memo-ops-なにか` を書いても通って
 * しまう——実際、この検査を最初に書いたとき**わざと壊しても落ちなかった**
 * （`gap-1` が `p-1` を含むのと同じ形）。**末尾で見る。**
 */
function 群を指す(rule: Rule): boolean {
  // 末尾の一続きが `.memo-ops` で始まること。擬似クラスは許すが、
  // **語が続く（`.memo-ops-なにか`）のは許さない**
  return /\.memo-ops(?![\w-])[^\s]*$/.test(rule.selector.trim())
}

/** セレクタが**そのもの**の規則を1つ返す。無ければ落とす（空振りを緑にしない） */
function 規則(selector: string): Rule {
  const found = 全規則.filter((rule) => rule.selector === selector)
  expect(found, selector).toHaveLength(1)
  return found[0]
}

describe('吹き出しの操作（memo.css）', () => {
  it('取り込まれている', () => {
    /*
      **取り込み忘れると、この一式が丸ごと黙って効かない。** しかも画面は動くので、
      指摘されるまで気づけない。**`@import` は他の規則より前**（CSS の規則）。
    */
    const index = 読む('index.css')
    expect(index).toContain("@import './memo.css'")
    const 取り込み位置 = index.indexOf("@import './memo.css'")
    const 最初の規則 = index.search(/^[^@\s/][^\n{]*\{/m)
    expect(取り込み位置, '@import が規則より後ろにあると捨てられる').toBeLessThan(最初の規則)
  })

  it('既定は見えないだけでなく、触れない', () => {
    /*
      **`opacity` だけ 0 にすると、群は場所を占めたまま当たり判定が残る。**
      メモでは「片付ける」に当たり、**触った吹き出しが黙って上段へ飛ぶ**ので、
      消えたように見える（`v0.1.138` の形）。

      **見た目だけ消して危険を残す直しになっていないか**を見る。
    */
    const 既定 = 規則('.memo-ops')
    expect(既定.body).toMatch(/opacity:\s*0\b/)
    expect(既定.body).toMatch(/pointer-events:\s*none\b/)
  })

  it('出す規則には、必ず当たり判定が戻る', () => {
    /*
      **戻し忘れると、こんどは見えているのに押せないボタンになる。**
      だから「既定が `none`」と「出す規則が `auto`」を対で見張る（`tile-ops` と同じ）。
    */
    const 出す規則 = 全規則.filter(
      (rule) => 群を指す(rule) && /opacity:\s*1\b/.test(rule.body),
    )
    expect(出す規則.length, '出す道が数えられない').toBeGreaterThanOrEqual(3)
    for (const rule of 出す規則) {
      expect(rule.body, rule.selector).toMatch(/pointer-events:\s*auto\b/)
    }
  })

  it('キーボードで中に入る道は、媒体条件の外にある', () => {
    /*
      **中へ入れると、指の画面に外付けキーボードを繋いだとき Tab で移動しても
      何も見えない**（`tile-ops` が同じ理由で外に出してある）。
    */
    const 焦点 = 規則('.memo-ops:where(:focus-within)')
    expect(焦点.body).toMatch(/opacity:\s*1\b/)
  })

  it('マウスの道は媒体条件の中にある', () => {
    /*
      **外へ出すと、指の端末では「触れたまま」で成立してしまい、常時表示と同じになる。**
    */
    const マウス = 全規則.filter((rule) => 群を指す(rule) && rule.selector.includes(':hover)'))
    expect(マウス, 'hover の規則が見つからない').toHaveLength(1)
    expect(マウス[0].selector).toMatch(/@media\s*\(hover:\s*hover\)/)
    expect(マウス[0].selector).toMatch(/pointer:\s*fine/)
  })

  it('指の画面では出しておく', () => {
    /*
      **吹き出しに「選んだ」状態は無い**ので、`tile-ops` の
      `[data-selected='true']` にあたる逃げ道が作れない。**塞ぐだけだと、指の画面から
      3つのボタンへ永久に届かなくなる。**

      重なりを構造で解いた（時刻の行へ移した）ので、**常に出しても本文を隠さない。**
    */
    const 指 = 全規則.filter(
      (rule) => /@media\s*\(hover:\s*none\)/.test(rule.selector) && 群を指す(rule),
    )
    expect(指, '指の画面への道が無い').toHaveLength(1)
    expect(指[0].body).toMatch(/opacity:\s*1\b/)
    expect(指[0].body).toMatch(/pointer-events:\s*auto\b/)
  })
})
