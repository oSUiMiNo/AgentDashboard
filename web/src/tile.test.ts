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
 * 8つの姿（カード設計§8）。**色は4つに畳んであるが、当てるのは状態のほう**なので、
 * 群ではなく状態で回す——`ended` は同じ灰でも `ok` の真偽で群が分かれる。
 */
const 全状態: SessionStatus[] = [
  { kind: 'working' },
  { kind: 'stalled' },
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
    const 枠 = 退避.filter((rule) => rule.selector.includes('.tile-frame'))
    expect(枠).toHaveLength(1)
    expect(枠[0].body).toContain('CanvasText')
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
    // 上に暗い文字が乗る。薄くすると `ANSWER` が読めない（`tile.css` に同じ理由）。
    // **`--tile-ink` を通さないだけで、沈まないわけではない**——接続断のときは
    // `--tile-fade` を通って沈む（フェーズ21）。受け皿は下の「右下の札も沈む」
    '.tile-sticker',
    // 同上。状態タグは**文言そのものが状態の答え**なので、薄くして読めなくしない。
    // こちらも率は通る（フェーズ21）
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

  it('停滞の周期は作業中のちょうど3倍で、枠線の回転と比が揃っている', () => {
    // 利用者の指定は「1/3 のスピード」（2026-08-31）。1.0秒でも 0.6秒でも「動いている」ので、
    // 比で見る。**枠線と同じ3倍**なので、片方だけ動かすと下の突き合わせで落ちる
    const 作業中 = Number.parseFloat(値(規則('.tile-run'), '--run-period'))
    const 停滞 = Number.parseFloat(
      値(規則("[data-motion='spin-slow'] .tile-run"), '--run-period'),
    )
    expect(作業中).toBe(0.6)
    // **`toBe` で見ない。** 1.8 / 0.6 は 2.9999999999999996 になる（二進小数の丸め）
    expect(停滞 / 作業中).toBeCloseTo(3, 10)

    // 枠線の回転（3.2秒 対 9.6秒）と同じ比。**揃えると決めた**ので、揃っていることを見る
    const 回転 = (selector: string) =>
      Number.parseFloat(/tile-spin ([\d.]+)s/.exec(値(規則(selector), 'animation'))![1])
    const 速い = 回転("[data-motion='spin-fast'] .tile-ring::after")
    const 遅い = 回転("[data-motion='spin-slow'] .tile-ring::after")
    expect(遅い / 速い).toBeCloseTo(停滞 / 作業中, 10)
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
 * 接続断のカードで、右下の札も沈む（フェーズ21。設計§26）。
 *
 * **「接続断なのに沈まない」族の3つ目にして最後。** ①回遊する線はフェーズ12、
 * ②輪の呼吸とホバーはフェーズ19 で潰したが、**③右下の札だけが満輝度で残っていた**
 * （実測：輪 0.6 に対し板 1.0。色は同じ）。②を直したぶん③が浮いて目立っていた。
 *
 * # ここは除外表の受け皿である
 *
 * 上の除外表は `.tile-tag` と `.tile-sticker` を `--tile-ink` から外している。
 * **除外は「見なくてよい」ではなく「別のところで見る」でなければ穴になる**——
 * `.tile-lines i` にはキーフレームの受け皿があったが、**札には受け皿が無かった**。
 * その穴がそのまま③として残っていたので、ここで塞ぐ。
 */
describe('接続断のカードで、右下の札も沈む（フェーズ21）', () => {
  const 板 = ['.tile-tag::before', '.tile-sticker::before']

  it('板は沈める率を通っている', () => {
    // **この段の本体。** 消すと接続断でも満輝度のままへ戻る
    for (const selector of 板) {
      expect(値(規則(selector), 'opacity'), selector).toBe('var(--tile-fade)')
    }
  })

  it('板だけ別の数字を書いていない', () => {
    // **率は1本に保つ**（§24-2）。`opacity: 0.8` のようなリテラルへ書き換えると、
    // 輪（0.6）とのずれが戻る——利用者の指摘そのものが「枠色とずれている」だった
    for (const selector of 板) {
      expect(値(規則(selector), 'opacity'), selector).not.toMatch(/[\d.]/)
    }
    // 率の出どころは2本のまま（上の「沈める率を決めるのは2行だけ」と対）
    expect(全規則.filter((rule) => /--tile-fade:/.test(rule.body))).toHaveLength(2)
  })

  it('沈めた板の文字は、色の対応表から来る', () => {
    // **色を CSS へ直書きすると表が2箇所に割れる**（設計§8）。どちらを当てるかは
    // 板の明るさで決まり、それを知っているのは `STATUS_TONES` のほうである
    const 入れ替え = 当たる("[data-connected='false']").filter((rule) =>
      /(^|\s)color:/.test(rule.body),
    )
    expect(入れ替え).toHaveLength(1)
    expect(入れ替え[0].selector).toContain('.tile-tag')
    expect(入れ替え[0].selector).toContain('.tile-sticker')
    expect(値(入れ替え[0], 'color')).toBe('var(--tile-sunk-ink)')
  })

  it('文字の入れ替えは詳細度を上げない', () => {
    // **上げるとハイコントラストの退避に勝つ。** あの環境では板が丸ごと消えるので、
    // 勝った瞬間に文字が地の上へ浮いて読めなくなる。`:where()` で包み、
    // **後ろに書いてある退避が勝つ**という素直な形にしてある
    const 入れ替え = 当たる("[data-connected='false']").find((rule) =>
      /(^|\s)color:/.test(rule.body),
    )
    expect(入れ替え).toBeDefined()
    expect(入れ替え!.selector).toContain(":where([data-connected='false'])")
    // 退避より前に書いてあること（詳細度が同じなので、順序が効く）
    const 退避 = 当たる('forced-colors').filter((rule) =>
      rule.selector.endsWith(' .tile-tag'),
    )
    expect(退避).toHaveLength(1)
    expect(入れ替え!.at).toBeLessThan(退避[0].at)
  })

  it('接続断でも、文字が 4.5:1 を割らない', () => {
    /*
      **除外表が守ろうとしたのはここである。** 数字で守らないと同じ穴がまた開く
      （設計§26-5）。

      模型は `protocol.test.ts` の床の検査と揃える——**合成の相手はカードの地**
      （`--card` = `#171717`。札は `.tile-body` の上に載っている）、**判定の相手は
      文字**。沈める率は CSS と同じ `DISCONNECTED_INK_SCALE` から引く。
    */
    const カードの地 = rgb('#171717')
    for (const status of 全状態) {
      const 色 = statusAccent(status) as Record<string, string>
      const 沈めた板 = composite(
        rgb(色['--tile-accent']),
        カードの地,
        DISCONNECTED_INK_SCALE,
      )
      const 比 = contrast(沈めた板, rgb(色['--tile-sunk-ink']))
      expect(比, `${status.kind}：${色['--tile-accent']} の板`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('文字色が1つでは足りないことを、数で残す', () => {
    /*
      **「なぜ2色なのか」を、次に読む人が測り直さずに済むように置いておく。**
      黒だけにすると灰（3.96）とコーラル（3.33）で割り、白だけにするとシアン（4.01）で
      割る。**どちらか一方に寄せると必ずどこかが落ちる**ので、片方へ揃える整理を
      入れたくなったら、このテストが止める。
    */
    const カードの地 = rgb('#171717')
    const 板 = (status: SessionStatus) =>
      composite(
        rgb((statusAccent(status) as Record<string, string>)['--tile-accent']),
        カードの地,
        DISCONNECTED_INK_SCALE,
      )
    for (const 単色 of ['#000000', '#ffffff']) {
      const 割る = 全状態.filter((s) => contrast(板(s), rgb(単色)) < 4.5)
      expect(割る.length, `${単色} だけで足りてしまっている`).toBeGreaterThan(0)
    }
  })

  it('繋がっているときの札は変わっていない', () => {
    // **今回の指摘は接続断だけ**（§26-6）。両方動かすと、どちらが効いたか分からなくなる。
    // 率は 1 に解決されるので板は満輝度のまま、文字は暗いまま
    for (const 本体 of ['.tile-tag', '.tile-sticker']) {
      expect(値(規則(本体), 'color')).toBe('#171717')
    }
    const カードの地 = rgb('#171717')
    for (const status of 全状態) {
      const 色 = statusAccent(status) as Record<string, string>
      const 比 = contrast(rgb(色['--tile-accent']), rgb('#171717'))
      expect(比, `${status.kind}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(カードの地).toEqual([23, 23, 23])
  })

  it('タグとステッカーは、沈み方も同じ', () => {
    // 2枚出るのは権限確認待ちだけ。**片方だけ直すとまた家族が割れる**（§26-6）
    expect(値(規則('.tile-tag::before'), 'opacity')).toBe(
      値(規則('.tile-sticker::before'), 'opacity'),
    )
  })

  it('記号と文言は消していない', () => {
    // **状態の答えそのもの**（§26-6）。沈めるのは地であって、中身ではない
    const 触った = 当たる("[data-connected='false']").filter(
      (rule) => rule.selector.includes('.tile-tag') || rule.selector.includes('.tile-sticker'),
    )
    expect(触った.length).toBeGreaterThan(0)
    for (const rule of 触った) {
      expect(rule.body, rule.selector).not.toMatch(/display:\s*none/)
      expect(rule.body, rule.selector).not.toMatch(/content:/)
    }
  })
})
