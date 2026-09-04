import { readFileSync } from 'node:fs'
import {
  DISCONNECTED_INK_SCALE,
  statusAccent,
  type SessionStatus,
} from '@/lib/protocol'
import { composite, contrast, rgb } from '@/test/contrast'
import { resolve } from 'node:path'

/**
 * **`import.meta.url` では読めない。** vitest が変換したモジュールの URL は `file:`
 * スキームとは限らず、`?raw` で取り込んでも CSS は既定で差し替えられて空になる。
 * 実体を読むには素朴にファイルを開くしかない。
 *
 * 基準はテストの走る場所（`web/`）。`vite.config.ts` がここに在るので動かない。
 */
function 読む(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src', name), 'utf8')
}

const CSS = 読む('tile.css')
const INDEX = 読む('index.css')

/**
 * カードの動きの定義（`tile.css`）を、**テキストとして**確かめる。
 *
 * # なぜテキストなのか
 *
 * テストは jsdom で走るが、**jsdom は CSS を適用しない**。したがって
 * 「『静止』を選ぶと止まる」「OS が『動きを減らす』と言えば止まる」「ハイコントラストの
 * 環境で枠が実線へ退避する」は、**画面を描いても1つも確かめられない**。
 *
 * ここで確かめられるのは「そう書いてある」ことまでで、**実際に効くかどうかは実物を
 * 見るしかない**（フェーズ6）。それでも書く価値があるのは、**打ち消しが効かなくなる
 * 形が構造で決まっている**からである——下の「hover の詳細度」がまさにそれで、
 * 素の `:hover` を1本足しただけで静けさも OS 設定も黙って効かなくなる。
 *
 * # 依存を増やさない
 *
 * CSS のパーサは入れない（このイシューは新しい依存を1つも入れない方針）。
 * 素朴なブロック分割で足りる。**正規表現は実物に当てて較正してある。**
 */

/** コメントを落とす。中に `{}` が入っているので、先に消さないと分割が狂う */
function 素のCSS(): string {
  return CSS.replace(/\/\*[\s\S]*?\*\//g, '')
}

interface Rule {
  /** セレクタ（`@media` の中なら、その条件を前置した形） */
  selector: string
  /** 宣言の中身 */
  body: string
  /** ファイルの先頭からの位置。**打ち消しが後ろにあること**を見るのに使う */
  at: number
}

/**
 * 規則を平らに取り出す。`@media` は1段だけ展開し、条件をセレクタへ前置する。
 *
 * `@keyframes` の中は入れ子の宣言なので、まとめて1つの塊として飛ばす。
 */
function rules(): Rule[] {
  const source = 素のCSS()
  const found: Rule[] = []
  let index = 0

  while (index < source.length) {
    const open = source.indexOf('{', index)
    if (open === -1) {
      break
    }
    const head = source.slice(index, open).trim()
    const close = 対応する閉じ(source, open)
    const inner = source.slice(open + 1, close)

    if (head.startsWith('@media')) {
      for (const rule of 中を割る(inner, open + 1)) {
        found.push({ ...rule, selector: `${head} ${rule.selector}` })
      }
    } else if (!head.startsWith('@keyframes')) {
      found.push({ selector: head, body: inner, at: index })
    }
    index = close + 1
  }
  return found
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

function 中を割る(inner: string, offset: number): Rule[] {
  const found: Rule[] = []
  let index = 0
  while (index < inner.length) {
    const open = inner.indexOf('{', index)
    if (open === -1) break
    const close = 対応する閉じ(inner, open)
    found.push({
      selector: inner.slice(index, open).trim(),
      body: inner.slice(open + 1, close),
      at: offset + index,
    })
    index = close + 1
  }
  return found
}

const 全規則 = rules()

/** その断片を含むセレクタの規則を拾う */
function 当たる(fragment: string): Rule[] {
  return 全規則.filter((rule) => rule.selector.includes(fragment))
}

/** セレクタが**そのもの**の規則を1つ返す。無ければ落とす（空振りを緑にしない） */
function 規則(selector: string): Rule {
  const found = 全規則.filter((rule) => rule.selector === selector)
  expect(found, selector).toHaveLength(1)
  return found[0]
}

/** `名前: 値` の値を取り出す。無ければ落とす */
function 値(rule: Rule, name: string): string {
  const match = new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+)`).exec(rule.body)
  expect(match, `${rule.selector} に ${name} が無い`).not.toBeNull()
  return (match as RegExpExecArray)[1].trim()
}

/** `12px` → 12 */
function px(text: string): number {
  expect(text).toMatch(/^-?[\d.]+px$/)
  return Number.parseFloat(text)
}

/**
 * カスタムプロパティしか宣言していない規則か。
 *
 * **濃さを載せるだけの規則を「止める規則」と数えないため**（フェーズ8）。
 */
function 濃さだけ(rule: Rule): boolean {
  const 宣言 = rule.body
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  return 宣言.length > 0 && 宣言.every((s) => s.startsWith('--'))
}

/**
 * 9つの姿（カード設計§8 ＋ 設計§14）。**色は4つに畳んであるが、当てるのは状態のほう**
 * なので、群ではなく状態で回す——`ended` は同じ灰でも `ok` の真偽で群が分かれる。
 */
const 全状態: SessionStatus[] = [
  { kind: 'working' },
  { kind: 'stalled' },
  { kind: 'waiting_subagents' },
  { kind: 'waiting_input' },
  { kind: 'waiting_permission' },
  { kind: 'starting' },
  { kind: 'ended', ok: true },
  { kind: 'ended', ok: false },
  { kind: 'unknown' },
]

/**
 * 停滞の休みのタグ（`.tile-tag-rest`）を出す規則か。
 *
 * 止めたとき走る人からタグへ戻す側の規則で、**動きを止めるのではなく見せるものを
 * 替える**（フェーズ17）。止める規則として数えると `animation: none` を求めて空振りする
 */
function 休みのタグを出す(rule: Rule): boolean {
  return rule.selector.endsWith('.tile-tag-rest') && rule.body.includes('display:')
}

describe('動きの定義の読み込み', () => {
  it('index.css から取り込まれている', () => {
    // **書き忘れても、位置を誤っても、このファイルのテストは全部緑のまま通る。**
    // `@import` は他の規則より前でないと捨てられるので、位置まで見る
    const 取り込み = INDEX.indexOf("@import './tile.css'")
    expect(取り込み).toBeGreaterThan(-1)

    const 最初の規則 = INDEX.replace(/\/\*[\s\S]*?\*\//g, '').indexOf('{')
    const 素の位置 = INDEX.replace(/\/\*[\s\S]*?\*\//g, '').indexOf(
      "@import './tile.css'",
    )
    expect(素の位置).toBeLessThan(最初の規則)
  })

  it('較正：分割が実物の規則を拾えている', () => {
    // **正規表現と分割は実物に当てて確かめてから使う**（ガイドライン）。
    // 数え違いをしていれば、以下のテストは「当たらないから通る」空振りになる
    expect(全規則.length).toBeGreaterThan(15)
    expect(当たる('.tile-ring::after')).not.toHaveLength(0)
    expect(当たる('forced-colors')).not.toHaveLength(0)
  })
})

describe('揺れるのは切る枠から内側', () => {
  it('揺れの指定が .tile-frame に付いている', () => {
    const 揺れ = 当たる("[data-motion='shake'] .tile-frame")
    expect(揺れ).toHaveLength(1)
    expect(揺れ[0].body).toContain('tile-shake')
  })

  it('器そのものは揺れない', () => {
    // 判定の枠が揺れると、鎮めるための的そのものが逃げる（カード設計§7）
    for (const rule of 全規則) {
      if (!rule.body.includes('tile-shake')) continue
      expect(rule.selector).toMatch(/\.tile-frame\s*$/)
    }
  })
})

describe('静けさの3段', () => {
  it('「控えめ」が止めるのは作業中のものだけ', () => {
    const 控えめ = 当たる("[data-quiet='calm']")
    // 輪の回転と、**走るアニメーション**（フェーズ13。止める1本＋1コマ目で静止する1本）と、
    // **停滞の休み**（フェーズ17。人を消す1本＋タグを出す1本）と、**スリープの `zzz`**
    // （帯の設計§14-4。消して札へ戻す1本）。当たり先はこの5種に閉じる
    expect(控えめ.length).toBeGreaterThanOrEqual(5)
    for (const rule of 控えめ) {
      expect(rule.selector).toMatch(
        /\[data-motion='spin-fast'\]|\.tile-run-rest|\.tile-tag-rest|\.tile-run|\.tile-zzz/,
      )
    }
    const 当たり先 = 控えめ.map((rule) => rule.selector).join(' ')
    expect(当たり先).toContain("[data-motion='spin-fast']")
    expect(当たり先).toContain('.tile-run i')
    // **停滞の枠線・入力待ち・承認待ちは動いたまま。** ここを広げると、いちばん見つけたい
    // ものの合図まで静けさと引き換えに失う。停滞で止まるのは**走る人だけ**（タグへ戻る）で、
    // 輪の回転（`spin-slow`）には触れない
    for (const 触ってはいけない of ['spin-slow', 'breathe', 'shake']) {
      expect(当たり先).not.toContain(触ってはいけない)
    }
  })

  it('「静止」は回転・呼吸・揺れ・効果線をすべて止める', () => {
    const 静止 = 当たる("[data-quiet='still']")
    const 当たり先 = 静止.map((rule) => rule.selector)
    for (const 層 of ['.tile-ring::after', '.tile-ring', '.tile-frame', '.tile-lines i']) {
      expect(当たり先.some((selector) => selector.endsWith(層))).toBe(true)
    }
    for (const rule of 静止) {
      // **濃さだけを決める規則は「止める規則」ではない**ので数えない（フェーズ8）。
      // 「静止」は明滅を**濃い側で止める**ため `--tile-ink` を上げるが、それは
      // 器へ載せる値であって、動きを止める宣言ではない。**`animation: none` を
      // 書き足して黙らせない**——効きもしない宣言をテストのために置くことになる
      if (濃さだけ(rule)) continue
      // **休みのタグを出す規則も「止める規則」ではない**（フェーズ17）。停滞は止めたとき
      // 走る人からタグへ戻るが、タグ自身は動きを持たないので `animation: none` を書く
      // 相手が無い。人を消す側（`.tile-run-rest i`）は普通に止める規則として数える
      if (休みのタグを出す(rule)) continue
      expect(rule.body).toContain('animation: none')
    }
  })

  it('止めても色は残る', () => {
    // 色・記号・文字が残るので状態は読める（「止めるのではなく弱める」）。
    // `display: none` や色を消す指定を混ぜていないこと
    for (const rule of [...当たる("[data-quiet=")]) {
      expect(rule.body).not.toContain('display: none')
      expect(rule.body).not.toContain('visibility: hidden')
    }
  })
})

describe('OS の「動きを減らす」', () => {
  it('段の選択によらず止める', () => {
    // 要件の完了条件が無条件なので、段で覆せるようにしない（カード設計§9-5-2）
    const 減らす = 当たる('prefers-reduced-motion')
    expect(減らす).not.toHaveLength(0)
    for (const rule of 減らす) {
      // 休みのタグを出す規則は動きを持たない（「静止」と同じ扱い。フェーズ17）
      if (休みのタグを出す(rule)) continue
      expect(rule.body).toContain('animation: none')
      // 段を条件に入れていない＝「賑やか」を選んでいても止まる
      expect(rule.selector).not.toContain('data-quiet')
    }
  })

  it('打ち消しが、止める対象より後ろに書いてある', () => {
    // 詳細度が並ぶので**順序だけで勝つ**。前に書くと1つも止まらない
    const 最後の動き = Math.max(
      ...全規則
        .filter(
          (rule) =>
            /animation:\s*tile-/.test(rule.body) &&
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

describe('hover は詳細度を上げない', () => {
  /**
   * **打ち消しが効くかどうかの、本当の分かれ目。**
   *
   * 素の `:hover` は詳細度を (0,3,0) にするので、静けさ (0,2,0) と OS 設定 (0,2,0) の
   * **両方に勝ってしまう**——「静止」を選んでいても、OS が「動きを減らす」と言って
   * いても、マウスを乗せた瞬間に揺れ出す。
   *
   * `:where()` は中身の詳細度を 0 として数えるので、包めば並びだけで決まる。
   */
  it('すべての hover が :where() で包まれている', () => {
    const hover = 全規則.filter((rule) => rule.selector.includes(':hover'))
    expect(hover).not.toHaveLength(0)
    for (const rule of hover) {
      expect(rule.selector).toContain(':where(:hover)')
    }
  })

  it('鎮まりは、マウスのある機械だけに効く', () => {
    // 指で触れた状態が張り付いて**永久に鎮まる**事故を、原理的に起こさない
    for (const rule of 全規則.filter((r) => r.selector.includes(':hover'))) {
      expect(rule.selector).toContain('hover: hover')
      expect(rule.selector).toContain('pointer: fine')
    }
  })
})

describe('色が消える環境への退避', () => {
  it('切る枠が実線になる', () => {
    // 輪は背景画像なので丸ごと消える（調査§6-4）。カードの境目まで消えないようにする
    const 退避 = 当たる('forced-colors')
    /*
      **選択の退避は別の話なので、ここでは数えない。** あちらが見ているのは
      「どのカードが選ばれているか」で、ここが見ているのは「カードの境目が残るか」。
      同じ `.tile-frame` に当たるが、主語が違う（下の「選ばれたカードは〜」で数える）。
    */
    const 枠 = 退避.filter(
      (rule) =>
        rule.selector.includes('.tile-frame') &&
        !rule.selector.includes('data-selected'),
    )
    expect(枠).toHaveLength(1)
    expect(枠[0].body).toContain('CanvasText')
  })

  it('選ばれたカードは、地が消えても線種で分かる', () => {
    /*
      **面（`--select-face`）は強制配色で丸ごと落ちる。** 印の点も外したので
      （利用者の指定）、**ここが唯一の受け皿**になっている。

      `outline` で作っていないことも見る——中身へ `outline` を書くと、
      **選ばれたカードだけフォーカスの輪を失う**（作者の指定が UA の輪を置き換える）。
      太さを触っていないことも見る——変えると**選択の有無でカードの外寸が動く**。
    */
    const 退避 = 当たる('forced-colors').filter((rule) =>
      rule.selector.includes("[data-selected='true']"),
    )
    expect(退避).toHaveLength(1)
    expect(値(退避[0], 'border-style')).toBe('dashed')
    expect(退避[0].body).not.toContain('outline')
    expect(退避[0].body).not.toMatch(/border-width|(?:^|;)\s*border:/)
  })

  it('状態タグは、地が消えても文言が残る', () => {
    // **地は画像・記号と文言は要素**（フェーズ13）。焼き込むとこの環境で状態が
    // 丸ごと読めなくなり、完了条件「色を伏せても記号と文言だけで8状態が判別できる」を割る
    const 退避 = 当たる('forced-colors')
    // 地（`::before`）を消す規則は別に数える。ここで見るのはタグ本体の退避
    const タグ = 退避.filter((rule) => rule.selector.endsWith(' .tile-tag'))
    expect(タグ).toHaveLength(1)
    expect(タグ[0].body).toContain('CanvasText')
    // 地が無いのに影だけ落ちると、文字の周りに黒い滲みが残る（フェーズ16）。
    // ステッカーも同じ（片方だけ残すと `ANSWER` にだけ灰色の滲みが出る。実測）
    expect(タグ[0].body).toContain('filter: none')
    const ステッカー = 退避.filter((rule) => rule.selector.endsWith(' .tile-sticker'))
    expect(ステッカー).toHaveLength(1)
    expect(ステッカー[0].body).toContain('filter: none')

    // 地は背景なので強制的に落ちるが、明示して消す（フェーズ16）
    const 地 = 退避.filter((rule) => rule.selector.includes('::before'))
    expect(地).toHaveLength(1)
    expect(地[0].selector).toContain('.tile-tag::before')
    expect(地[0].selector).toContain('.tile-sticker::before')
    expect(地[0].body).toContain('display: none')
  })

  it('走るアニメーションは、絵の代わりに文字と記号が出る', () => {
    // あれは**絵そのものが中身**（要件2-3 が「文字も ↻ も要らない」と明示）なので、
    // 消えたときに残るものが無い。**この環境でだけ**退避の文字を出す
    const 退避 = 当たる('forced-colors')
    const 走る = 退避.filter((rule) => rule.selector.includes('.tile-run'))
    expect(走る.length).toBeGreaterThanOrEqual(2)
    const 当たり先 = 走る.map((rule) => rule.selector).join(' ')
    // 絵（3コマ）を消す規則と、退避を出す規則が対で要る
    expect(当たり先).toContain('.tile-run i')
    expect(当たり先).toContain('.tile-run-fallback')
  })
})

describe('選ばれたカードは、面ごと色が変わる（フェーズ7）', () => {
  const 選択 = () => 規則(".tile-body[data-selected='true']")

  it('作業中の面より後ろに書いてある', () => {
    /*
      **これが「作業中のカードでも選択が見える」の機械的な裏取りである。**

      3本とも詳細度が (0,2,0) で並ぶので、勝敗は書いた順だけで決まる。前は
      `bg-primary/10`（Tailwind のユーティリティ層）で書いていたため、
      レイヤ外のこの行に**一度も勝てていなかった**——作業中のカードだけ
      選んでも背景が変わらない、という形で出ていた。
    */
    const 作業中 = 当たる("[data-motion='spin-fast']").filter((rule) =>
      rule.selector.includes('.tile-body'),
    )
    expect(作業中).toHaveLength(1)
    expect(選択().at).toBeGreaterThan(作業中[0].at)
  })

  it('フォーカスの面より後ろに書いてある', () => {
    /*
      **フォーカスは「いまどこか」、選択は「何に効くか」。** 片方が片方を消しては
      いけない。面を譲っても、フォーカスの合図は**輪と左端の帯**が持つ。
    */
    // **`.tile-body:focus-visible` は2本ある**（輪と面）。後ろのほうより後ろに要る
    const フォーカス = 全規則.filter(
      (rule) => rule.selector === '.tile-body:focus-visible',
    )
    expect(フォーカス.length).toBeGreaterThan(0)
    const 最後 = Math.max(...フォーカス.map((rule) => rule.at))
    expect(選択().at).toBeGreaterThan(最後)
  })

  it('面は不透明で、状態の色を読まない', () => {
    /*
      **α を持つと裏の輪（状態の色）が透けて地が消える**（`bg-primary/10` が
      踏んだ穴。琥珀のカードでは文字が読めなくなる）。
      **`--tile-accent` を読むと、色が「選択」ではなく「状態」を表す。**
    */
    expect(値(選択(), 'background-color')).toBe('var(--select-face)')
    expect(選択().body).not.toContain('--tile-accent')

    const 定義 = /--select-face:\s*([^;]+)/.exec(INDEX)
    expect(定義, 'index.css に --select-face が無い').not.toBeNull()
    // 不透明な地を織り込んでいる＝結果も不透明
    expect((定義 as RegExpExecArray)[1]).toContain('var(--card)')
    expect((定義 as RegExpExecArray)[1]).not.toContain('transparent')
  })

  it('面の濃さは、決めた可動域の中にある', () => {
    /*
      **薄いと作業中の面と見分けが付かず、濃いとエラーの文字が 4.5:1 に寄る。**
      印の点を外したぶん一段濃く（26%）してあるが、上下に床と天井を置く。
      **実際の色が違って見えることは、実ブラウザでしか言えない**（E2E が見る）
      ——jsdom は `color-mix` も `oklch` も計算しない。
    */
    const 比 = /--select-face:[^;]*?(\d+)%/.exec(INDEX)
    expect(比, '--select-face の割合が読めない').not.toBeNull()
    const 値 = Number((比 as RegExpExecArray)[1])
    expect(値).toBeGreaterThanOrEqual(22)
    expect(値).toBeLessThanOrEqual(30)
  })

  it('影も枠線も使わない', () => {
    // 影は「物質 2/2」に1本だけ、枠線は状態の色のもの（並べ替え設計§8-3）
    expect(選択().body).not.toContain('box-shadow')
    expect(選択().body).not.toMatch(/(?:^|;)\s*border/)
  })

  it('動きの印を混ぜない', () => {
    // 混ぜると「進行中は Primary Accent を面で出している」が2本一致して落ちる。
    // **混ぜる必要も無い**——選択は状態によらず同じ1色
    expect(選択().selector).not.toContain('data-motion')
  })

  it('浮きは tile.css 側に置かない', () => {
    /*
      **置くと押した手応えに勝ってしまう**（`:active` より後ろに書くため）。
      浮きは TSX の `scale-[1.01]`（Tailwind のユーティリティ層）が持ち、
      レイヤ外の `:active { scale: 0.98 }` に**負けるのが正しい**。
    */
    expect(選択().body).not.toContain('scale')
  })

  it('左端の帯を取らない', () => {
    /*
      **Hover の合図は「帯が出てくること」である。** 選択が常時そこを塗ると、
      乗せても「色が変わる」だけになり、Hover が一段弱る——
      選択を強くするために別の反応を削る取り引きになってしまう。
    */
    const 帯 = 全規則.filter(
      (rule) =>
        /\.tile-body::(before|after)/.test(rule.selector) &&
        rule.body.includes('--select'),
    )
    expect(帯).toHaveLength(0)
  })
})

describe('描き直しを起こさない作りになっている', () => {
  it('will-change を1箇所も書いていない', () => {
    // CSS のアニメーションは**自動で合成の層へ載る**（調査§6-1）。書くと副作用
    // （包含ブロックを作る）だけが残る
    expect(素のCSS()).not.toContain('will-change')
  })

  it('器にはみ出しを切る指定を付けていない', () => {
    // `overflow` / `contain` / `content-visibility` はペイントを内側へ閉じ込めるので、
    // **効果線が切られる**。付けるなら切る枠の側（カード設計§9-0）
    for (const rule of 当たる('.tile-shell')) {
      expect(rule.body).not.toMatch(/overflow|contain|content-visibility/)
    }
  })

  it('位置と大きさそのものは動かさない', () => {
    // **動かしてよいのは回転・移動・濃さ・大きさの4つ**（`scale` は跳ねの着地の
    // つぶれで4つ目に入った。合成段で済むので描き直しは起きない）。
    // ここで禁じているのは**版組をやり直させる指定**で、12枚同時に走ると効く
    const 動く = 素のCSS().match(/@keyframes[\s\S]*?\n}/g) ?? []
    expect(動く).not.toHaveLength(0)
    for (const keyframes of 動く) {
      expect(keyframes).not.toMatch(/^\s*(width|height|top|left|margin|padding):/m)
    }
  })
})

describe('跳ね（権限確認待ち）', () => {
  /** 名前つきの `@keyframes` の中身を、空白をそろえて取り出す */
  function キーフレーム(name: string): string {
    const 塊 = 素のCSS().match(
      new RegExp(`@keyframes\\s+${name}\\s*\\{[\\s\\S]*?\\n\\}`),
    )
    expect(塊).not.toBeNull()
    return (塊 as RegExpMatchArray)[0]
      .replace(new RegExp(`@keyframes\\s+${name}`), '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  it('鎮まり用のキーフレームは、本体と中身が完全に同じ', () => {
    // **名前だけを違えるのが要点**（設計§9-3-1）。`animation-name` を差し替えると
    // 動きが頭から再生されるので、離れた直後は必ず静止の区間から始まる。
    // 中身がずれると「鎮まると形まで変わる」になり、片方だけ直す事故も起きる。
    // いまは注釈しか守っていなかったので、機械に見させる
    expect(キーフレーム('tile-shake-calm')).toBe(キーフレーム('tile-shake'))
  })

  it('動くのは周期の末尾だけ', () => {
    // **間欠であることが「すぐには揺れ直さない」の実体**（設計§9-3）。頭へ動かすと
    // 離れた直後にいきなり跳ね、鎮めた意味が消える
    const 停留点 = [...キーフレーム('tile-shake').matchAll(/([\d.]+)%/g)].map((m) =>
      Number(m[1]),
    )
    const 動く停留点 = 停留点.filter((値) => 値 !== 0 && 値 !== 100)
    expect(動く停留点).not.toHaveLength(0)
    expect(Math.min(...動く停留点)).toBeGreaterThanOrEqual(92.5)
  })
})

describe('DESIGN.md の床を満たしている', () => {
  // `DESIGN.md` は合否を2枚で見る——**禁止事項を守るだけでは合格ではなく**、§8 の
  // 必達要素の最低数を満たして初めて合格になる。ここは**その床が消えたら落ちる**
  // ようにしてある。**目で見て決めたことは、目でしか守れない**ので、せめて
  // 「その規則が居なくなったこと」は機械が気づけるようにする。

  it('切る枠を斜めに切っている（崩し 1/2）', () => {
    // §10.1「Primary Panel …必要に応じて一部 Cut Corner」／§10.2「一角だけ切る」。
    // 禁止事項の「すべてを大きな角丸長方形で構成する」と、判定の「白黒にすると
    // 画面の構成に特徴が何も残らない」の両方が、ここ1つに掛かっている
    const 切る = 当たる('.tile-frame').filter((r) => r.body.includes('clip-path'))
    expect(切る).toHaveLength(1)
    expect(切る[0].body).toMatch(/polygon/)
  })

  it('進行中は Primary Accent を面で出している（面 1/1）', () => {
    // §11.2「Primary Accent は面で出す」——「比率の 10〜15% は、**細い線と小さな
    // バッジだけでは到達しない**。最低1か所は面で出す」。直す前のカードは、
    // その不合格例（「アクセント色が細い線と小バッジにしか出ていない」）だった
    const 面 = 当たる("[data-motion='spin-fast']").filter((r) =>
      r.selector.includes('.tile-body'),
    )
    expect(面).toHaveLength(1)
    expect(面[0].body).toMatch(/background-color:.*--tile-accent/)
  })

  it('ステッカーが物質を持っている（物質 1/2）', () => {
    // §12.3 は貼る場所まで決めている（状態バッジ → ステッカー → 強）。
    // §12.1 の Printed Sticker なので、影で「貼ってある」を作る。
    // **影は `filter: drop-shadow()` で本体に、内側のハイライトは地（`::before`）に**
    // ——同じ要素に `box-shadow` を書いても型抜きで切られて効かない（フェーズ16）
    const ステッカー = 規則('.tile-sticker')
    expect(ステッカー.body).toMatch(/filter: drop-shadow/)
    // 【崩し 2/2】§10.2「一部だけ少し傾ける」
    expect(ステッカー.body).toMatch(/rotate/)
    expect(規則('.tile-sticker::before').body).toMatch(/box-shadow: inset/)
  })

  it('縁が段差を持っている（物質 2/2・ステッカー以外）', () => {
    // §8 の床は「うち1つはステッカー以外」と書いている。不合格例は
    // 「ステッカーだけが物質を持っている」。§12.3 は「パネルの縁 → 紙の厚み・段差 → 弱」
    const 縁 = 当たる('.tile-body').filter((r) => r.body.includes('box-shadow'))
    expect(縁).toHaveLength(1)
    expect(縁[0].body).toMatch(/inset/)
  })

  it('縁の段差を border で作っていない', () => {
    // E2E が「素の状態では枠に border が無い」ことを見ていて、ハイコントラストの
    // 退避（実線1本）と見分けている。**border を足すと、退避が効いているかどうかを
    // 機械が判定できなくなる**
    // `border-radius` は枠線ではないので数えない（Accent Bar が持っている）
    for (const rule of 当たる('.tile-body')) {
      expect(rule.body).not.toMatch(
        /^\s*border(-(width|style|color|top|right|bottom|left))?:/m,
      )
    }
  })

  it('反応が3つある（Hover / Selected / Pressed）', () => {
    // §8 の床「目に見える反応 3」。不合格例は「Selected しか作っていない」。
    // この一覧に「選択」は無いので、**フォーカスを Selected 相当まで引き上げてある**
    // ——§27.3「単なる 1px Border だけで済ませない」
    const 全部 = 素のCSS()
    expect(当たる(':hover').some((r) => r.selector.includes('.tile-body'))).toBe(true)
    expect(全部).toMatch(/\.tile-body:active/)
    expect(当たる(':focus-visible').some((r) => r.body.includes('background-color'))).toBe(
      true,
    )
  })
})

/**
 * **同じ状態は、どこでも同じ色で出る。**
 *
 * ここが台帳を持っていなかったので、**輪だけが明るくなってバーが取り残される**
 * 壊れ方を2度続けて実物で指摘された（フェーズ7-4・8）。数値は床を満たしており、
 * 形も指定どおりで、**それでも同じカードの中で色が食い違っていた**。
 */
describe('濃さは1本の変数から配る', () => {
  /** 規則そのものが濃さを持たなくてよいもの。**理由を書けないものは足さない** */
  const 除外 = [
    // **繋がっているあいだは満輝度のまま**。上に暗い文字が乗るので、状態によって
    // 35〜90% まで動く `--tile-ink` を素の規則へ通すと、スリープの `ANSWER` が読めない。
    // **接続断のときだけ別の規則で `--tile-ink` を通す**（フェーズ22）。
    // 受け皿は下の「右下の札も、輪とまったく同じだけ沈む」
    '.tile-sticker',
    // 同上。状態タグは**文言そのものが状態の答え**なので、薄くして読めなくしない
    '.tile-tag',
    // **濃さはキーフレームが持つ**（素の状態は `opacity: 0` で隠れている）。
    // その中身は下の「効果線もキーフレームで濃さを読む」が見ている
    '.tile-lines i',
  ]

  it('--tile-accent を塗るものは、必ず --tile-ink を通る', () => {
    const 塗る = 全規則.filter(
      (rule) =>
        /background(-color)?:/.test(rule.body) &&
        rule.body.includes('--tile-accent') &&
        // 面のティントは「濃さ」ではなく地に混ぜる色（§11.3 の比率のための面）
        !rule.body.includes('var(--color-card)') &&
        !除外.some((s) => rule.selector.includes(s)),
    )
    expect(塗る.length).toBeGreaterThanOrEqual(2)
    for (const rule of 塗る) {
      expect(rule.body).toContain('--tile-ink')
    }
  })

  it('濃さを決めるのは4行だけ', () => {
    // **散らすと、また片方だけ動く。** 既定＋上書き3つ（接続断・静止・入力待ちの hover）
    const 決める = 全規則.filter((rule) => /--tile-ink:/.test(rule.body))
    expect(決める).toHaveLength(4)
    const 当たり先 = 決める.map((r) => r.selector).join(' ')
    expect(当たり先).toContain('.tile-shell')
    expect(当たり先).toContain("[data-connected='false']")
    expect(当たり先).toContain("[data-quiet='still']")
    expect(当たり先).toContain("[data-motion='breathe']")
  })

  it('呼吸の暗い側は、静止時の濃さではなく床を読む', () => {
    // **1つの値に2つの役割を持たせない**（設計§9-2-2）。兼ねていたころは
    // 75%→100% の 25点しか振れず、**下げると呼吸しない状態まで暗くなる**ので
    // 広げられなかった。`@keyframes` はヘルパが飛ばすので素の CSS へ当てる
    const 呼吸 = 素のCSS().match(/@keyframes\s+tile-breathe\s*\{[\s\S]*?\n\}/)
    expect(呼吸).not.toBeNull()
    expect(呼吸![0]).toContain('var(--tile-floor)')
    expect(呼吸![0]).not.toContain('var(--tile-dim)')
  })

  it('効果線もキーフレームで濃さを読む', () => {
    // 上の除外表で `.tile-lines i` を外したぶんを、ここで受ける。**除外は
    // 「見なくてよい」ではなく「別のところで見る」** でなければ穴になる
    const 効果線 = 素のCSS().match(/@keyframes\s+tile-lines\s*\{[\s\S]*?\n\}/)
    expect(効果線).not.toBeNull()
    expect(効果線![0]).toContain('var(--tile-ink)')
  })

  it('接続断の印は、中身の外まで届く', () => {
    // 輪と効果線は中身の**兄弟**なので、中身にだけ印を付けても CSS が届かない
    // （設計§7-4-4）。器へ出した印を読む規則があること
    const 接続断 = 当たる("[data-connected='false']")
    expect(接続断.length).toBeGreaterThanOrEqual(2)
    expect(接続断.some((r) => !r.selector.includes('.tile-body'))).toBe(true)
  })

  it('接続断が沈む割合は、CSS と TypeScript で同じ数字である', () => {
    // **CSS からは TypeScript の定数を読めない**ので、一致は機械で見張るしかない
    // （設計§9-7-10）。0.1.41 では CSS 側にしか無く、**放った線だけが沈まなかった**
    const 規則 = 当たる("[data-connected='false']").find((r) =>
      /--tile-ink:/.test(r.body),
    )
    expect(規則).toBeDefined()
    expect(規則!.body).toContain(`* ${DISCONNECTED_INK_SCALE}`)
  })
})

/**
 * 停滞の見せ方（カード設計§9-7-10）。
 *
 * **停滞は作業中の弱い側**で、色は同じシアン。分けているのは**太さと濃さと速さ**なので、
 * どれか1つでも外れると作業中と見分けが付かなくなる。
 */
describe('停滞は作業中の弱い側', () => {
  it('輪の外側を地で塗って、見える太さを半分にする', () => {
    // **切る枠の内側余白は動かさない。** そこを停滞だけ細くすると中身の幅が
    // 状態によって変わり、作業中↔停滞のたびに②③行の文字が動く
    const 細く = 当たる("[data-motion='spin-slow']").filter((r) =>
      r.selector.includes('.tile-frame'),
    )
    expect(細く).toHaveLength(1)
    expect(細く[0].body).toContain('inset')
    expect(細く[0].body).toContain('var(--color-background)')
    // 余白そのものを触っていないこと（触ると並びが動く）
    expect(細く[0].body).not.toMatch(/(^|[^-])padding:/)
  })

  it('当て先に data-status を使わない', () => {
    // `data-status` は**中身にしか無い**。器へ複製すると `[data-status=…]` で引いて
    // いる E2E が2件に一致して壊れる——フェーズ7 で `data-card-id` を器と中身の
    // 両方へ付け、`compose.spec.ts` が7本落ちたまま1か月気づかなかったのと同じ形
    expect(素のCSS()).not.toContain('data-status')
  })
})

/**
 * 復旧ボタンの当たり判定（カード設計§7-4）。
 *
 * **0.1.41 まで、これを守るテストが単体にも E2E にも1本も無かった。** 実寸を変えた
 * ときに床を割ったことに気づけるのは、`tile.css` のコメントを読んだ人だけだった。
 */
describe('復旧ボタンは指で押せる', () => {
  it('当たり判定が 44px の床を割らない', () => {
    // 見た目は 36×23px。判定は疑似要素を外へ広げて作る（ボタン自体を大きくすると
    // カードの高さの半分を覆い、①②行の押し場所を食う）
    const 判定 = 当たる('.tile-revive::after')
    expect(判定).toHaveLength(1)
    const inset = 判定[0].body.match(/inset:\s*(-?[\d.]+)px/)
    expect(inset).not.toBeNull()
    const 広げる = Math.abs(Number(inset![1]))
    // 高さが先に床へ当たる。23 + 広げる×2 ≥ 44
    expect(23 + 広げる * 2).toBeGreaterThanOrEqual(44)
  })
})

/**
 * 名前を付ける鉛筆（名前付け設計§9-2・§9-3）。
 *
 * **常時出すと表の1列になる**（`DESIGN.md` §23.3・§33）。出るのは「いま触っている
 * 1枚」——マウスが乗っているか、選ばれているかのどちらか。**タッチに hover は
 * 無い**ので、選択の側が無いとスマホから永久に届かない。
 */
describe('操作の群は、いま触っている1枚にだけ出る', () => {
  it('指で触る画面では常に出る（既定が「出る」）', () => {
    /*
      **隠すほうをメディアクエリの中だけに置く**（細かい修正 設計§4-1）。
      既定を「出る」にしておけば、**hover を持たない端末から永久に届かない、という形が
      構造的に作れない**——鉛筆1つだったころは既定が `opacity: 0` で、選択の側を
      足して届かせていた。
    */
    expect(規則('.tile-ops').body).toMatch(/opacity:\s*1\b/)
  })

  it('マウスのある機械でだけ、乗るまで隠す', () => {
    // 素の `:hover` は指の端末でも「触れたまま」で成立し、常時表示と二重になる
    const 隠す = 当たる('.tile-ops').filter((rule) => /opacity:\s*0\b/.test(rule.body))
    expect(隠す).toHaveLength(1)
    expect(隠す[0].selector).toContain('hover: hover')
    expect(隠す[0].selector).toContain('pointer: fine')
  })

  it('乗っている・選ばれている・中に居るの3つで出る', () => {
    // キーボードで辿り着いたときも出す——見えないボタンに焦点が当たると、
    // どこに居るのか分からなくなる
    for (const selector of [
      '.tile-shell:where(:hover) .tile-ops',
      ".tile-shell[data-selected='true'] .tile-ops",
      '.tile-ops:where(:focus-within)',
    ]) {
      const 出す = 当たる(selector)
      expect(出す.length, selector).toBeGreaterThanOrEqual(1)
      expect(出す.some((rule) => /opacity:\s*1\b/.test(rule.body)), selector).toBe(true)
    }
  })

  it('右上に1つの群として、横一列に並ぶ', () => {
    // 両端に散らすと視線が往復する（細かい修正 設計§4-1）
    const 群 = 規則('.tile-ops').body
    expect(群).toMatch(/position:\s*absolute/)
    expect(群).toMatch(/top:\s*8px/)
    expect(群).toMatch(/right:\s*8px/)
    expect(群).toMatch(/display:\s*flex/)
  })

  it('3つとも当たり判定が 44px の床を割らない', () => {
    // 見た目は変えずに疑似要素で広げる（ボタン自体を大きくすると①②行の押し場所を食う）
    const 広げ幅 = (selector: string) => {
      const 判定 = 当たる(selector)
      expect(判定, selector).toHaveLength(1)
      const inset = 判定[0].body.match(/inset:\s*(-?[\d.]+)px/)
      expect(inset, selector).not.toBeNull()
      return Math.abs(Number(inset![1]))
    }
    // 編集とゴミ箱は 24×24px（印 14px ＋ 余白）、電源は 28×28px
    expect(24 + 広げ幅('.tile-pencil::after') * 2).toBeGreaterThanOrEqual(44)
    expect(24 + 広げ幅('.tile-archive::after') * 2).toBeGreaterThanOrEqual(44)
    expect(28 + 広げ幅('.tile-ops .power::after') * 2).toBeGreaterThanOrEqual(44)
  })
})

/**
 * 右下のタグの厚みと大きさ（フェーズ16）。
 *
 * フェーズ13 は `box-shadow` を**書いたまま効きだけ落としていた**（`mask-image` が
 * 外側の影を切る）。「書いてあること」を見る検査では捕まらないので、**効く形で
 * 書いてあること**——影を描く要素と型抜きされる要素が分かれていること——を見る。
 */
describe('右下のタグは厚みを持ち、1.2倍になっている（フェーズ16）', () => {
  const タグ = () => 規則('.tile-tag')
  const ステッカー = () => 規則('.tile-sticker')

  it('落ち影は本体の filter で描き、型抜きは ::before に閉じる', () => {
    for (const 本体 of ['.tile-tag', '.tile-sticker']) {
      const rule = 規則(本体)
      expect(rule.body).toMatch(/filter: drop-shadow\(/)
      // **同じ要素にマスクを書くと影まで切られる**（filter → mask の順。実測 2026-08-31）
      expect(rule.body).not.toContain('mask-image')
      // 外側の `box-shadow` は効かない。書いてあると「効いている」と読んでしまう
      expect(rule.body).not.toMatch(/box-shadow/)

      const 地 = 規則(`${本体}::before`)
      expect(値(地, 'mask-image')).toBe("url('./assets/tile/tag-plate.png')")
      expect(値(地, 'inset')).toBe('0')
      // 文字の後ろに回す。親の `filter` が stacking context を作るので、カードの後ろへは落ちない
      expect(値(地, 'z-index')).toBe('-1')
    }
  })

  it('タグとステッカーは同じ家族', () => {
    // 2枚出るのは権限確認待ちだけ。片方だけ直すと、そこだけ家族が違って見える（フェーズ13）
    expect(値(タグ(), 'filter')).toBe(値(ステッカー(), 'filter'))
    expect(値(タグ(), 'padding')).toBe(値(ステッカー(), 'padding'))
    expect(値(規則('.tile-tag::before'), 'mask-image')).toBe(
      値(規則('.tile-sticker::before'), 'mask-image'),
    )
  })

  it('寸法はフェーズ13 の 1.2倍', () => {
    // フェーズ13 の値：タグ 11px / 2px 8px / gap 3px、ステッカー 10px / 2px 8px
    expect(px(値(タグ(), 'font-size'))).toBeCloseTo(11 * 1.2, 5)
    expect(px(値(タグ(), 'gap'))).toBeCloseTo(3 * 1.2, 5)
    expect(px(値(ステッカー(), 'font-size'))).toBeCloseTo(10 * 1.2, 5)
    for (const rule of [タグ(), ステッカー()]) {
      const [縦, 横] = 値(rule, 'padding').split(/\s+/).map(px)
      expect(縦).toBeCloseTo(2 * 1.2, 5)
      expect(横).toBeCloseTo(8 * 1.2, 5)
    }
  })

  it('記号の枠は字の大きさに追随する', () => {
    // `1rem` へ戻すと、タグの字だけ大きくなり記号の枠が 16px に据え置かれる
    expect(値(規則('.tile-glyph'), 'width')).toMatch(/^[\d.]+em$/)
  })

  it('2枚出しで重ならない', () => {
    // ANSWER の高さ＝字 × 行送り ＋ 上下の余白。1段上のタグは、その上端より上に載る
    const s = ステッカー()
    const 高さ =
      px(値(s, 'font-size')) * Number.parseFloat(値(s, 'line-height')) +
      px(値(s, 'padding').split(/\s+/)[0]) * 2
    const 逃がし = px(値(規則('.tile-tag-raised'), 'bottom'))
    expect(逃がし).toBeGreaterThanOrEqual(px(値(s, 'bottom')) + 高さ)
  })
})

/**
 * 停滞も走る人（フェーズ17）。
 *
 * 「動いていること」だけを見るとどの周期でも緑になる。**周期の比**と、**遅れが周期から
 * 引かれていること**と、**止めたときタグへ戻る道が3つとも別に在ること**を見る。
 */
describe('停滞も走る人になり、止めたときはタグへ戻る（フェーズ17）', () => {
  it('周期は変数1つから配られ、遅れは周期の 1/3 ずつ', () => {
    // 遅れをリテラル（0 / 0.2 / 0.4秒）へ戻すと、周期だけ変えたとき3枚が重なるか1枚も出ない
    expect(値(規則('.tile-run i'), 'animation')).toMatch(
      /^tile-run var\(--run-period\) steps\(1, end\) infinite$/,
    )
    for (const n of [0, 1, 2]) {
      expect(値(規則(`.tile-run i:nth-child(${n + 1})`), 'animation-delay')).toBe(
        `calc(var(--run-period) * ${n} / 3)`,
      )
    }
  })

  it('作業中だけ速くなり、停滞は据え置かれている', () => {
    /*
      **「停滞は作業中のちょうど3倍で、枠線の回転と比が揃っている」という約束は捨てた**
      （細かい修正 要件21・設計§4-4）。利用者の指定は「作業中だけ 1.4倍。停滞中のカードは
      今のままでOK」なので、**比は必ず崩れる**（1.8 / 0.4286 ＝ 4.2）。

      **枠線との突き合わせも外した。** 揃え続けるには指定されていない3つ目（枠線の速さ）を
      動かすことになり、**約束を守るために見た目を勝手に変える**ことになる。
      枠線の回転（3.2秒 対 9.6秒）は別のテストが据え置きを見ている。
    */
    const 作業中 = Number.parseFloat(値(規則('.tile-run'), '--run-period'))
    const 停滞 = Number.parseFloat(
      値(規則("[data-motion='spin-slow'] .tile-run"), '--run-period'),
    )
    expect(作業中).toBe(0.4286)
    // 停滞は動かしていない。ここが変わったら、指定されていないものを動かしている
    expect(停滞).toBe(1.8)
    // 1.4倍になっていること。**`toBe` で見ない**（0.6 / 0.4286 は割り切れない）
    expect(0.6 / 作業中).toBeCloseTo(1.4, 3)
  })

  it('スリープの zzz は、比を保ったまま 1.8倍になっている', () => {
    /*
      要件20 が名指ししているのは**最大（3文字目）だけ**だが、3つは「後から出るものほど
      大きい」という並びで作ってある——**最大だけ伸ばすと、その並びが崩れる**
      （細かい修正 設計§4-4）。9/11/13 → 16.2/19.8/23.4。
    */
    const 大きさ = (n: number) =>
      Number.parseFloat(値(規則(`.tile-zzz i:nth-child(${n})`), 'font-size'))
    expect(大きさ(3)).toBe(23.4)
    expect(大きさ(2)).toBe(19.8)
    expect(大きさ(1)).toBe(16.2)
    // 比が保たれていること。**後から出るものほど大きい**が崩れていない
    expect(大きさ(1)).toBeLessThan(大きさ(2))
    expect(大きさ(2)).toBeLessThan(大きさ(3))
    for (const n of [1, 2, 3]) {
      expect(大きさ(n) / [9, 11, 13][n - 1]).toBeCloseTo(1.8, 6)
    }
  })

  it('枠線の回転は据え置かれている（走る人だけを速めた）', () => {
    // 上のテストが枠線との比較を外したので、**枠線そのものはここで見る**。
    // 3.2秒 対 9.6秒の3倍は、利用者の指定に入っていないので動かさない
    const 回転 = (selector: string) =>
      Number.parseFloat(/tile-spin ([\d.]+)s/.exec(値(規則(selector), 'animation'))![1])
    expect(回転("[data-motion='spin-fast'] .tile-ring::after")).toBe(3.2)
    expect(回転("[data-motion='spin-slow'] .tile-ring::after")).toBe(9.6)
  })

  it('@keyframes tile-run は比のまま触られていない', () => {
    // 先頭の 1/3 だけ `opacity: 1`。ここを書き換えると作業中まで壊れる
    expect(素のCSS()).toMatch(
      /@keyframes tile-run \{\s*0%,\s*33\.33% \{\s*opacity: 1;\s*\}\s*33\.34%,\s*100% \{\s*opacity: 0;\s*\}\s*\}/,
    )
  })

  it('休みのタグは畳んであり、止める3つの段のどれでも出る', () => {
    // 3つは別の規則。1つ直して3つとも効いたつもりになるのを防ぐ（テスト計画の壊し方）
    expect(値(規則('.tile-tag-rest'), 'display')).toBe('none')
    for (const 段 of ["[data-quiet='calm']", "[data-quiet='still']", 'prefers-reduced-motion']) {
      const 出す = 当たる(段).filter((r) => r.selector.endsWith('.tile-tag-rest'))
      expect(出す, `${段} でタグを出す規則`).toHaveLength(1)
      expect(値(出す[0], 'display')).toBe('inline-flex')
      // 人のほうは消す。**1枚目だけを出す規則より後ろ**に置かないと勝てない（詳細度が同じ）
      const 消す = 当たる(段).filter((r) => r.selector.endsWith('.tile-run-rest i:nth-child(1)'))
      expect(消す, `${段} で人を消す規則`).toHaveLength(1)
      expect(値(消す[0], 'opacity')).toBe('0')
      const 一枚目 = 当たる(段).filter((r) => r.selector.endsWith(' .tile-run i:nth-child(1)'))
      expect(一枚目).toHaveLength(1)
      expect(消す[0].at).toBeGreaterThan(一枚目[0].at)
    }
  })

  it('ハイコントラストでは休みのタグを出さない', () => {
    // あの環境では `.tile-run-fallback` が `‖ 停滞` を出すので、タグまで出すと二重になる。
    // 静けさと OS の規則より後ろに置いて勝たせる
    const 消す = 当たる('forced-colors').filter((r) => r.selector.endsWith('.tile-tag-rest'))
    expect(消す).toHaveLength(1)
    expect(値(消す[0], 'display')).toBe('none')
    const 出す最後 = Math.max(
      ...全規則.filter((r) => r.selector.endsWith('.tile-tag-rest') && r.body.includes('inline-flex')).map((r) => r.at),
    )
    expect(消す[0].at).toBeGreaterThan(出す最後)
  })
})

/**
 * 接続断のカードで、輪も沈む（フェーズ19）。
 *
 * **`--tile-ink` は「いま塗る1つの濃さ」なので、2点を振れる呼吸には使えない。**
 * だから接続断の ×0.6 が呼吸へ掛からず、繋がっていないカードでも山で満輝度まで
 * 上がっていた（設計§24-1）。**率（`--tile-fade`）を変数へ出して、`--tile-ink` を
 * 通れないものと、リテラルで上書きしているものを、そこへ通す。**
 */
describe('接続断のカードで、輪も沈む（フェーズ19）', () => {
  it('呼吸の両端が、沈める率を通っている', () => {
    // **この段の本体。** リテラル（`--tile-floor` と `1`）へ戻すと、接続断で沈まなくなる
    const 塊 = /@keyframes\s+tile-breathe\s*\{[\s\S]*?\n\}/.exec(素のCSS())?.[0] ?? ''
    expect(塊).not.toBe('')
    const 濃さ = [...塊.matchAll(/opacity:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(濃さ).toEqual([
      'calc(var(--tile-floor) * var(--tile-fade))',
      'calc(100% * var(--tile-fade))',
    ])
  })

  it('沈める率を決めるのは2行だけ', () => {
    // **散らすと、また片方だけ動く**（`--tile-ink` の4行と同じ理由）。
    // 既定の1と、接続断の 0.6。3本目を書きたくなったら、それは別の概念である
    const 決める = 全規則.filter((rule) => /--tile-fade:/.test(rule.body))
    expect(決める).toHaveLength(2)
    expect(値(規則('.tile-shell'), '--tile-fade')).toBe('1')
    expect(値(規則("[data-connected='false']"), '--tile-fade')).toBe('0.6')
  })

  it('ホバーと「静止」の持ち上げも、率を通っている', () => {
    // **どちらも接続断より後ろに書いてある**ので、リテラルの `100%` だと減光が
    // 丸ごと捨てられる（テスト計画フェーズ8 が「踏めなかったもの」として残していた）。
    // 率を通しても持ち上げの比は同じ（繋がっているとき 75→100、接続断で 45→60）
    const 持ち上げ = 全規則.filter((rule) => /--tile-ink:/.test(rule.body) && rule.body.includes('100%'))
    expect(持ち上げ).toHaveLength(2)
    const 当たり先 = 持ち上げ.map((rule) => rule.selector).join(' ')
    expect(当たり先).toContain(":where(:hover)")
    expect(当たり先).toContain("[data-quiet='still']")
    for (const rule of 持ち上げ) {
      expect(値(rule, '--tile-ink'), rule.selector).toBe('calc(100% * var(--tile-fade))')
    }
  })

  it('沈めるのは率であって、床ではない', () => {
    // `--tile-floor` は「その色が 3:1 を保てる最小」（§9-2-2）。**接続断のときだけ
    // 率で下げる**のであって、床の値そのものを書き換えるのではない——書き換えると
    // 繋がっているカードの呼吸まで暗くなる
    expect(素のCSS()).not.toMatch(/--tile-floor:\s*/)
  })
})

/**
 * 接続断のカードで、右下の札は**輪とまったく同じだけ**沈む（フェーズ22。設計§27）。
 *
 * # フェーズ21 では足りなかった
 *
 * あちらは**率**（`--tile-fade` ＝ 0.6）を通した。ところが**率は状態によらず一定**なのに
 * 対し、**輪は状態ごとの濃さ（`--tile-dim`）にも率を掛ける**ので、実際の輪は 0.210〜0.540
 * まで散らばる。札だけ 0.600 で高止まりし、**スリープでは 2.86倍明るい**ままだった。
 *
 * 直したのは2つ。**札を `--tile-ink` へ通す**ことと、**接続断では呼吸を止める**こと
 * （呼吸する輪は 0.330〜0.600 を行き来するので、止めないと「周期のどこを見るか」で
 * 一致したりしなかったりする）。
 *
 * # ここは除外表の受け皿である
 *
 * 上の除外表は `.tile-tag` と `.tile-sticker` を `--tile-ink` から外している。
 * **除外は「見なくてよい」ではなく「別のところで見る」でなければ穴になる。**
 */
describe('接続断のカードで、右下の札も、輪とまったく同じだけ沈む（フェーズ22）', () => {
  const 沈む = () =>
    当たる("[data-connected='false']").filter((rule) => rule.selector.includes('::before'))

  it('板は輪と同じ濃さ（--tile-ink）を読む', () => {
    // **この段の本体。** `--tile-fade`（率だけ）へ戻すと、状態ごとのずれが復活する
    const 規則 = 沈む()
    expect(規則).toHaveLength(1)
    expect(規則[0].selector).toContain('.tile-tag::before')
    expect(規則[0].selector).toContain('.tile-sticker::before')
    expect(値(規則[0], 'background')).toBe(
      'color-mix(in srgb, var(--tile-accent) var(--tile-ink), var(--color-card))',
    )
  })

  it('板を `opacity` で沈めていない（フェーズ23）', () => {
    /*
      **`opacity` は要素ごと透かすので、板の裏にあるものが透ける**（設計§28-1）。
      札は3行目のセッション名の上に重なる作りなので、**名前が板越しに出る**——
      0.1.71 でそう見えていた。**混ぜた色を不透明に塗る**のが正しい。

      **`.tile-ring` は別。** 輪は中身の裏にあるので、透けて困るものが無い
      （下の「輪は `opacity` のままでよい」が受ける）。
    */
    for (const rule of 沈む()) {
      expect(rule.body, rule.selector).not.toMatch(/(^|;)\s*opacity:/)
    }
  })

  it('内側のハイライトも同じ率を通す', () => {
    // 沈めないと、**暗い板の上端だけ白い縁が残る**（`opacity` のときは一緒に沈んでいた）
    const 影 = 値(沈む()[0], 'box-shadow')
    expect(影).toContain('inset 0 2.5px 0')
    expect(影).toContain('var(--tile-ink)')
    expect(影).toContain('transparent')
  })

  it('輪は `opacity` のままでよい', () => {
    // **同じ「沈める」でも、重なっているものが在るかどうかで当て方が変わる**（§28-2）。
    // 輪は中身の裏なので透けて困らない。ここまで `color-mix` へ倒すと、
    // **濃さを二重に掛ける**という別の穴（このファイル冒頭の注意）へ近づく
    expect(値(規則('.tile-ring'), 'opacity')).toBe('var(--tile-ink)')
  })

  it('繋がっているときの板には、濃さを書いていない', () => {
    // **今回の指摘は接続断だけ**（§26-6）。素の規則へ濃さを書くと、
    // 繋がっているカードの札まで `--tile-dim` で沈み、暗い文字が読めなくなる
    for (const selector of ['.tile-tag::before', '.tile-sticker::before']) {
      const body = 規則(selector).body
      expect(body, selector).not.toMatch(/(^|;)\s*opacity:/)
      expect(値(規則(selector), 'background'), selector).toBe('var(--tile-accent)')
    }
  })

  it('接続断では呼吸を止める（設計§24-3 を覆した）', () => {
    // 止めないと輪は 0.330〜0.600 を行き来し、**周期のどこを見るかで一致が変わる**。
    // 止めれば輪は `--tile-ink` に座り、板と常に同じ値になる
    const 止める = 当たる("[data-connected='false'][data-motion='breathe']")
    expect(止める).toHaveLength(1)
    expect(止める[0].selector).toContain('.tile-ring')
    expect(止める[0].body).toContain('animation: none')
    // **素の呼吸より後ろに書いてあること**（詳細度は上だが、順序でも守る）
    const 呼吸 = 規則("[data-motion='breathe'] .tile-ring")
    expect(止める[0].at).toBeGreaterThan(呼吸.at)
  })

  it('沈めた板でも、文字は繋がっているときと同じ', () => {
    /*
      **文字を入れ替える規則を置かない**（フェーズ24。利用者の指定・2026-09-02）。
      かつては沈めた板の上で白へ寄せていたが、**床を割る側へ倒した**——
      「**文字以外の要素からぱっと見でステータスを判断できるため、コントラストは許容する**」。

      **白へ戻したくなったら、`tile.css` の理由の段落ごと戻すこと。** 規則だけ足すと、
      **なぜ黒だったのかが消える。**
    */
    const 入れ替え = 当たる("[data-connected='false']").filter((rule) =>
      /(^|\s)color:/.test(rule.body),
    )
    expect(入れ替え, '接続断で文字色を上書きしていないこと').toHaveLength(0)
    for (const 本体 of ['.tile-tag', '.tile-sticker']) {
      expect(値(規則(本体), 'color'), 本体).toBe('#171717')
    }
  })

  it('床を割っていることを、数で残す', () => {
    /*
      **意図して割っている**ので、**割っていること自体を台帳にする**。
      黙って割ると、次に読む人が「壊れている」と読んで白へ戻す——そのとき
      **なぜ黒なのかを知る手掛かりが残らない**。

      模型は `protocol.test.ts` の床の検査と揃える（合成の相手はカードの地）。
      同じ形の判断は §8-4 にもある（輪が 3:1 を割ることを、判別を記号と文言が
      担っているという理由で受け入れた）。
    */
    const カードの地 = rgb('#171717')
    const 文字 = rgb('#171717')
    const 比 = 全状態.map((status) => {
      const 色 = statusAccent(status) as Record<string, string>
      const 濃さ = (Number.parseFloat(色['--tile-dim']) / 100) * DISCONNECTED_INK_SCALE
      return contrast(composite(rgb(色['--tile-accent']), カードの地, 濃さ), 文字)
    })
    // 実測 1.46〜2.75。**全状態で床（4.5）を割る**——これが承知のうえの姿
    expect(Math.min(...比)).toBeGreaterThan(1.4)
    expect(Math.max(...比)).toBeLessThan(4.5)
  })

  it('タグとステッカーは、沈み方も同じ', () => {
    // 2枚出るのは権限確認待ちだけ。**片方だけ直すとまた家族が割れる**（§26-6）
    const 規則 = 沈む()[0]
    expect(規則.selector).toContain('.tile-tag::before')
    expect(規則.selector).toContain('.tile-sticker::before')
  })

  it('記号と文言は消していない', () => {
    // **状態の答えそのもの**（§26-6）。沈めるのは地であって、中身ではない
    for (const rule of 当たる("[data-connected='false']")) {
      expect(rule.body, rule.selector).not.toMatch(/display:\s*none/)
    }
  })
})
