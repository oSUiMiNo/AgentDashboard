import { readFileSync } from 'node:fs'
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
  it('「控えめ」が止めるのは作業中の回転だけ', () => {
    const 控えめ = 当たる("[data-quiet='calm']")
    expect(控えめ).toHaveLength(1)
    // **停滞・入力待ち・承認待ちは動いたまま。** ここを広げると、いちばん見つけたい
    // ものの合図まで静けさと引き換えに失う
    expect(控えめ[0].selector).toContain("[data-motion='spin-fast']")
    for (const 触ってはいけない of ['spin-slow', 'breathe', 'shake']) {
      expect(控えめ[0].selector).not.toContain(触ってはいけない)
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
    expect(退避).toHaveLength(1)
    expect(退避[0].selector).toContain('.tile-frame')
    expect(退避[0].body).toContain('CanvasText')
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
    // §12.1 の Printed Sticker なので、影で「貼ってある」を作る
    const ステッカー = 当たる('.tile-sticker')
    expect(ステッカー).toHaveLength(1)
    expect(ステッカー[0].body).toMatch(/box-shadow/)
    // 【崩し 2/2】§10.2「一部だけ少し傾ける」
    expect(ステッカー[0].body).toMatch(/rotate/)
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
    // 上に暗い文字が乗る。薄くすると `ANSWER` が読めない（`tile.css` に同じ理由）
    '.tile-sticker',
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
})
