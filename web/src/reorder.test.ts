import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REORDER_LIFT_MS, REORDER_SETTLE_MS, REORDER_SLIDE_MS } from '@/lib/useReorder'

/**
 * 並べ替えの動きの定義（`reorder.css`）を、**テキストとして**確かめる。
 *
 * # なぜテキストなのか
 *
 * テストは jsdom で走るが、**jsdom は CSS を適用せず、矩形も固定で返す**。
 * したがって「掴んでいる間だけ滑る」「静止なら止まる」「OS が『動きを減らす』と
 * 言えば止まる」は、**画面を描いても1つも確かめられない**（実際に滑ることは E2E が見る）。
 *
 * それでも書く価値があるのは、**この規則が「順序と既定値」で成り立っている**からで、
 * そこが崩れる形は構造で決まっている——`--reorder-ms` の既定が `0ms` でなくなるか、
 * 打ち消しが前へ動くかの2つ。どちらもテキストで捕まえられる。
 *
 * **`tile.css` の検査から作法を写している**（依存を増やさず、素朴な分割で足りる）。
 */

function 読む(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src', name), 'utf8')
}

const CSS = 読む('reorder.css')
const INDEX = 読む('index.css')

interface Rule {
  selector: string
  body: string
  /** ファイルの先頭からの位置。**打ち消しが後ろにあること**を見るのに使う */
  at: number
}

/** コメントを落とす。中に `{}` が入っているので、先に消さないと分割が狂う */
function 素のCSS(): string {
  return CSS.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 規則を平らに取り出す。`@media` は1段だけ展開し、条件をセレクタへ前置する */
function rules(): Rule[] {
  const source = 素のCSS()
  const found: Rule[] = []
  let index = 0
  let 条件 = ''
  let 媒体の終わり = -1

  while (index < source.length) {
    const open = source.indexOf('{', index)
    if (open === -1) {
      break
    }
    const head = source.slice(index, open).trim()
    if (head.startsWith('@media')) {
      条件 = head
      媒体の終わり = source.lastIndexOf('}')
      index = open + 1
      continue
    }
    const close = source.indexOf('}', open)
    if (close === -1) {
      break
    }
    if (条件 !== '' && open > 媒体の終わり) {
      条件 = ''
    }
    found.push({
      selector: (条件 === '' ? head : `${条件} ${head}`).trim(),
      body: source.slice(open + 1, close).trim(),
      at: open,
    })
    index = close + 1
  }
  return found
}

const 全規則 = rules()

function 規則(selector: string): Rule {
  const found = 全規則.filter((rule) => rule.selector === selector)
  expect(found, selector).toHaveLength(1)
  return found[0]
}

function 値(rule: Rule, name: string): string {
  const match = new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+)`).exec(rule.body)
  expect(match, `${rule.selector} に ${name} が無い`).not.toBeNull()
  return (match as RegExpExecArray)[1].trim()
}

describe('動きの定義の読み込み', () => {
  it('`index.css` から取り込まれている', () => {
    // **`@import` は他の規則より前に置くこと**——末尾へ足すと無言で捨てられる
    const 取り込み = INDEX.indexOf("@import './reorder.css'")
    expect(取り込み).toBeGreaterThan(0)
    expect(取り込み).toBeLessThan(INDEX.indexOf('@custom-variant'))
  })

  it('較正：分割が実物の規則を拾えている', () => {
    // **空振りを緑にしない。** 分割が壊れたら、下の検査は全部「無い」で通ってしまう
    expect(全規則.length).toBeGreaterThanOrEqual(5)
    expect(
      全規則.filter((rule) => rule.selector.includes('data-reordering')).length,
    ).toBeGreaterThan(0)
  })
})

describe('掴んでいる間だけ動く', () => {
  it('滑る規則は、掴んでいる印の中にしか無い', () => {
    /*
      **これが「禁止の射程を越えていない」ことの機械的な裏取りである。**

      ガイドラインは「一覧の小窓に `layout` を付けるのも禁止 — 押そうとした瞬間に
      的が逃げる」と決めている。掴んでいる最中は**利用者自身が的を動かしている**ので
      当たらないが、**掴んでいないときに1px でも動くと当たる**。
    */
    const 滑る = 全規則.filter((rule) => rule.body.includes('transition:'))
    expect(滑る.length).toBeGreaterThan(0)
    for (const rule of 滑る) {
      if (値(rule, 'transition') === 'none') {
        // 逆算を当てる1フレームだけ切るもの。これは滑らせる側ではない
        continue
      }
      expect(rule.selector, '掴んでいる印の外で滑っている').toContain(
        "[data-reordering='true']",
      )
    }
  })

  it('動かす指定も、掴んでいる印の中にしかない', () => {
    // 掴んでいなければ**変形そのものが存在しない**（包含ブロックも作らない）
    // **個別プロパティも数える。** `transform` だけを見ると、`translate:` で動かす規則を見逃す
    const 動かす = 全規則.filter((rule) =>
      /(?:^|;)\s*(?:transform|translate|scale|rotate):/.test(rule.body),
    )
    expect(動かす.length).toBeGreaterThan(0)
    for (const rule of 動かす) {
      expect(rule.selector).toContain("[data-reordering='true']")
    }
  })

  it('所要時間の既定は 0ms', () => {
    // **既定が 0 でないと、印が付いていない場面で滑る道ができる**
    expect(値(規則('[data-reorder-item]'), '--reorder-ms')).toBe('0ms')
  })

  it('押しのけの曲線は、rbd の退避カーブ（M3 standard）', () => {
    // 助走・素早い退避・文字が読める長い尾（設計§15-7）
    expect(値(規則('[data-reorder-item]'), '--reorder-ease')).toBe('cubic-bezier(0.2, 0, 0, 1)')
  })

  it('持ち上げの時間も、TypeScript 側の定数と一致する', () => {
    const 中 = 規則("[data-reorder-item][data-reordering='true']")
    expect(値(中, '--reorder-lift-ms')).toBe(`${REORDER_LIFT_MS}ms`)
    expect(REORDER_LIFT_MS).toBeLessThan(REORDER_SLIDE_MS)
  })

  it('本人と、収まる途中のものは、translate を滑らせない', () => {
    // 追従は 1:1、収まるのはバネが毎フレーム書く（設計§15-2・§15-7）
    for (const selector of [
      "[data-reorder-item][data-reordering='true'][data-dragging='true']",
      "[data-reorder-item][data-reordering='true'][data-reorder-settling='true']",
    ]) {
      expect(値(規則(selector), 'transition')).not.toContain('translate')
    }
  })

  it('滑る時間は、TypeScript 側の定数と一致する', () => {
    /*
      **同じ数字を2箇所へ書かない。** ずれると「印を降ろすまで待つ時間」が
      滑り終わりとずれ、離した瞬間にカクつく。
    */
    const 中 = 規則("[data-reorder-item][data-reordering='true']")
    expect(値(中, '--reorder-ms')).toBe(`${REORDER_SLIDE_MS}ms`)
    expect(REORDER_SETTLE_MS).toBeGreaterThan(REORDER_SLIDE_MS)
  })
})

describe('止める段', () => {
  it('「静止」は滑らせない', () => {
    // 設定は「すべて止める」と宣言している。**例外にすると約束が嘘になる**
    const 静止 = 規則("[data-reorder-item][data-quiet='still']")
    expect(値(静止, '--reorder-ms')).toBe('0ms')
    expect(値(静止, '--reorder-lift-ms')).toBe('0ms')
  })

  it('OS の「動きを減らす」も滑らせない', () => {
    /*
      `MotionConfig reducedMotion="user"` は `motion` の transform と layout にしか
      効かず、**CSS の `transition` には届かない**ので、ここに自分で書く必要がある。
    */
    const 打ち消し = 全規則.filter((rule) =>
      rule.selector.includes('prefers-reduced-motion'),
    )
    expect(打ち消し).toHaveLength(1)
    expect(値(打ち消し[0], '--reorder-ms')).toBe('0ms')
    expect(値(打ち消し[0], '--reorder-lift-ms')).toBe('0ms')
  })

  it('打ち消しは、止める対象より後ろに書いてある', () => {
    // **詳細度が並ぶので、順序だけで勝つ。** 前へ動かすと黙って効かなくなる
    const 中 = 規則("[data-reorder-item][data-reordering='true']")
    const 静止 = 規則("[data-reorder-item][data-quiet='still']")
    const OS = 全規則.filter((rule) =>
      rule.selector.includes('prefers-reduced-motion'),
    )[0]
    expect(静止.at).toBeGreaterThan(中.at)
    expect(OS.at).toBeGreaterThan(静止.at)
    // **この下に規則を足さないこと**が守られているか
    expect(OS.at).toBe(Math.max(...全規則.map((rule) => rule.at)))
  })
})

describe('持っているものの見せ方', () => {
  it('倍率と傾きは `DESIGN.md` §27.5 の候補そのまま', () => {
    // **利用者が「コミカルでいい感じ」と言っている値。** 変えるときは実物を見てから
    const 持つ = 規則("[data-reorder-item][data-reordering='true'][data-dragging='true']")
    expect(値(持つ, '--reorder-lift')).toBe('1.02')
    expect(値(持つ, '--reorder-tilt')).toBe('1deg')
  })

  it('枠と区画は縮め、カードは持ち上げる', () => {
    /*
      **1度傾けると、角が `寸法 × 0.0175` だけはみ出す**（要件「追加要望」1・設計§15-7）。
      カード（294×200）は 1.02倍でも隙間 12px に収まるが、枠（940×600 級）と区画
      （1000×900 級）は収まらない。大きいものは 0.97 に縮める——Pressed と同じ数
    */
    const 縮める = 全規則.filter((rule) => rule.selector.includes("data-reorder-kind='frame'"))
    expect(縮める.length).toBeGreaterThan(0)
    const 倍率 = 縮める.find((rule) => rule.body.includes('--reorder-lift'))
    expect(倍率).toBeDefined()
    expect(値(倍率 as Rule, '--reorder-lift')).toBe('0.97')
    expect((倍率 as Rule).selector).toContain("data-reorder-kind='section'")
    // カードの持ち上げは据え置き。**縮める規則がカードに当たってはいけない**
    expect((倍率 as Rule).selector).not.toContain("data-reorder-kind='card'")
  })

  it('`transform` は書かない。`motion` のもの', () => {
    // 個別プロパティで書く（設計§15-2）。`transform` を書くと入場の `y` と奪い合う
    for (const rule of 全規則) {
      expect(rule.body).not.toMatch(/(?:^|;)\s*transform:/)
    }
  })

  it('影は使わない', () => {
    // カードは `mask-image` を使う層を持ち、**外へ描くものは切られる**（設計§8-2）
    for (const rule of 全規則) {
      expect(rule.body).not.toContain('box-shadow')
    }
  })

  it('新しい動きの型を作らない', () => {
    /*
      `@keyframes` を作ると「勝手に動き続けるもの」が増える。ここは**利用者が
      指を置いている間だけ**の動きなので、`transition` で足りる。
      `will-change` も書かない（`tile.css` と同じ理由）。
    */
    // **コメントを外した本体を見る。** 説明としての言及（`tile.css` の許可表の
    // 引用など）まで禁じると、理由を書けなくなる
    expect(素のCSS()).not.toContain('@keyframes')
    expect(素のCSS()).not.toContain('will-change')
  })
})
