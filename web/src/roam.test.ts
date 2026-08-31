import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROAM_FLING, ROAM_INK_PX, ROAM_LOOP, roamSpans } from '@/lib/roam'
import {
  ROAM_ACT_MS,
  ROAM_EXIT_MS,
  ROAM_FLIP_FRAMES,
  ROAM_FLIP_MS,
  ROAM_LIFE_MS,
} from '@/stores/roam'

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

/** 呼び値の道のりから、slide の節目（% と steps）を引く。**CSS と同じ出どころ** */
function 滑りの設計図() {
  const 列 = roamSpans()
  const 総 = 列.reduce((a, b) => a + b, 0)
  const 尾 = 総 - 30 // 窓の尻が走る道のり（全長 − 窓）
  const 飛散 = 列.slice(0, ROAM_FLING).reduce((a, b) => a + b, 0)
  const 巻き = 列.slice(ROAM_FLING, ROAM_FLING + ROAM_LOOP).reduce((a, b) => a + b, 0)
  const p1 = (飛散 / 尾) * 100
  const p2 = ((飛散 + 巻き) / 尾) * 100
  const 秒 = ROAM_LIFE_MS / 1000
  return {
    p1,
    p2,
    // **コマ/秒はここが唯一の出どころ**——飛散・巻きは 12.2（今のまま）、
    // 回遊は 6（要件15-6・2026-08-28 の要件変更）
    steps飛散: Math.round(12.2 * 秒 * (p1 / 100)),
    steps巻き: Math.round(12.2 * 秒 * ((p2 - p1) / 100)),
    steps回遊: Math.round(6 * 秒 * ((100 - p2) / 100)),
  }
}

describe('回遊の定義の読み込み', () => {
  it('index.css から取り込まれている', () => {
    // **書き忘れても、位置を誤っても、このファイルのテストは全部緑のまま通る。**
    // `@import` は他の規則より前でないと捨てられるので、位置まで見る
    expect(INDEX.indexOf("@import './roam.css'")).toBeGreaterThan(-1)

    const 素のINDEX = INDEX.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(素のINDEX.indexOf("@import './roam.css'")).toBeLessThan(素のINDEX.indexOf('{'))
  })

  it('較正：分割が実物の規則を拾えている', () => {
    // 数え違いをしていれば、以下のテストは「当たらないから通る」空振りになる
    expect(当たる('.roam-layer')).not.toHaveLength(0)
    expect(当たる('.roam-paper')).not.toHaveLength(0)
    expect(素のCSS()).toContain('@keyframes roam-slide')
  })
})

describe('層は場所を取らず、何も塗らない', () => {
  it('中身と一緒にスクロールし、押す邪魔をしない', () => {
    // **`absolute` でなければならない**（カード設計§9-7-5）。`fixed` だと画面に
    // 貼り付いて、スクロールしたとき線だけが取り残される
    const 層 = 全規則.filter((rule) => rule.selector.trim() === '.roam-layer')
    expect(層).toHaveLength(1)
    expect(層[0].body).toContain('position: absolute')
    expect(層[0].body).not.toContain('position: fixed')
    expect(層[0].body).toContain('pointer-events: none')
  })

  it('層も SVG も塗らない', () => {
    // 塗ると**画面いっぱいの合成テクスチャが1枚生える**。塗ってよいのは線（stroke）だけ
    for (const セレクタ of ['.roam-layer', '.roam-svg']) {
      const [規則] = 全規則.filter((rule) => rule.selector.trim() === セレクタ)
      expect(規則, セレクタ).toBeDefined()
      for (const 禁止 of ['background', 'filter', 'transform', 'will-change']) {
        expect(規則.body, `${セレクタ} に ${禁止}`).not.toContain(禁止)
      }
    }
  })

  it('z-index を書かない', () => {
    // `z-index: auto` の絶対配置は DOM 順で「中身より上」に自然に収まる
    expect(素のCSS()).not.toContain('z-index')
  })

  it('will-change を書かない', () => {
    expect(素のCSS()).not.toContain('will-change')
  })
})

describe('キーフレーム', () => {
  it('動かすのは、決めた3つだけ', () => {
    /*
      **白リストの顔ぶれが フェーズ18 で丸ごと替わった。**

      箱の時代は `translate` / `rotate` / `scale` / `opacity` / `clip-path` だった。
      経路が `d` へ移り箱が消えたので、位置も向きも形も**キーフレームでは動かない**
      ——動くのは**窓**（長さ＝`stroke-dasharray`、位置＝`stroke-dashoffset`）と
      **コマの入れ替え**（`opacity`）だけである。

      **`stroke-*` を開ける判断はフェーズ18 の関門で済ませた**（設計§23-5・
      `参考/2026-08-28 フェーズ18_関門の実測.md`）——`<path>`＋窓は 512本でも
      60.2fps（箱＋`clip-path` は 34.9fps）。**測ってから開けている。**

      **`transform` 系が1つも無いこと自体が番人である**——箱の作りへ戻ると
      ここが落ちる。
    */
    const 許す = new Set(['stroke-dasharray', 'stroke-dashoffset', 'opacity'])
    const 塊 = 素のCSS().match(/@keyframes\s+[\w-]+\s*\{[\s\S]*?\n\}/g) ?? []
    expect(塊).not.toHaveLength(0)
    for (const keyframes of 塊) {
      for (const [, 名前] of keyframes.matchAll(/^\s*([a-z-]+)\s*:/gm)) {
        if (名前 === 'animation-timing-function') continue
        expect(許す).toContain(名前)
      }
    }
  })

  it('較正：キーフレームを塊ごと拾えている', () => {
    const 塊 = 素のCSS().match(/@keyframes\s+[\w-]+\s*\{[\s\S]*?\n\}/g) ?? []
    expect(塊.map((k) => /@keyframes\s+([\w-]+)/.exec(k)?.[1]).sort()).toEqual([
      'roam-birth',
      'roam-exit',
      'roam-koma-0',
      'roam-koma-1',
      'roam-koma-2',
      'roam-koma-3',
      'roam-slide',
    ])
  })

  it('プロパティの持ち主は1つずつ', () => {
    /*
      **フェーズ15 の「後勝ち」より単純になった設計を、単純なまま保つ番人。**

      発生と退場＝窓の長さ、移動＝窓の位置、コマ＝濃さ。**持ち主が分かれている限り、
      「どちらが勝つか」を考える場面が無い**——フェーズ15 はそこを静的検査で見られず
      E2E を新設する羽目になった（2026-08-28 に「規則は書いてあるがどちらが勝つかを
      見ていなかった」で1度踏んでいる）。
    */
    const 持ち主: Record<string, string> = {
      'roam-birth': 'stroke-dasharray',
      'roam-exit': 'stroke-dasharray',
      'roam-slide': 'stroke-dashoffset',
      'roam-koma-0': 'opacity',
      'roam-koma-1': 'opacity',
      'roam-koma-2': 'opacity',
      'roam-koma-3': 'opacity',
    }
    for (const [名, 財産] of Object.entries(持ち主)) {
      const 塊 = new RegExp(`@keyframes\\s+${名}\\s*\\{[\\s\\S]*?\\n\\}`).exec(素のCSS())?.[0] ?? ''
      expect(塊, 名).not.toBe('')
      for (const [, プロパティ] of 塊.matchAll(/^\s*([a-z-]+)\s*:/gm)) {
        if (プロパティ === 'animation-timing-function') continue
        expect(プロパティ, 名).toBe(財産)
      }
    }
  })

  it('移動の % と steps は、道のりから引いた値になっている', () => {
    /*
      **手で数えない**（ガイドライン）。% は「窓の尻が走る道のり」への比、steps は
      区間の時間 × コマ/秒。**寿命・区間数・コマ/秒のどれを変えても、引き直すまで
      ここが落ち続ける**——「落ちたら壊した」ではなく「引き直しがまだ」である。

      回遊が毎秒6コマ・飛散と巻きが12.2コマ/秒（要件15-6：**落とすのは回遊だけ**）。
    */
    const 図 = 滑りの設計図()
    const 塊 = /@keyframes\s+roam-slide\s*\{[\s\S]*?\n\}/.exec(素のCSS())?.[0] ?? ''
    expect(塊).not.toBe('')
    const 割合 = [...塊.matchAll(/^\s*([\d.]+)%\s*\{/gm)].map((m) => Number(m[1]))
    expect(割合).toEqual([0, Number(図.p1.toFixed(4)), Number(図.p2.toFixed(4)), 100])
    const 段 = [...塊.matchAll(/steps\((\d+)\)/g)].map((m) => Number(m[1]))
    expect(段).toEqual([図.steps飛散, 図.steps巻き, 図.steps回遊])
    // 節目の変数を読む。**s4 は無い**（4つ目の節目を増やしたら % も増やすこと）
    for (const 変数 of ['--roam-s1', '--roam-s2', '--roam-s3']) {
      expect(塊).toContain(`var(${変数})`)
    }
    expect(塊).not.toContain('--roam-s4')
    // 始まりは 0（窓の尻は経路の頭から出る）
    expect(塊).toContain('stroke-dashoffset: 0px')
  })

  it('回遊のコマ送りは毎秒6コマ、絵の切り替えは毎秒2.5コマ', () => {
    /*
      **2つのコマ数を混同しない番人**（要件15-6 と、フェーズ15 で通った絵の切り替え）。

      | 何 | どこ | コマ/秒 |
      |---|---|---|
      | 移動（窓の位置） | `roam-slide` の回遊区間 | **6**（利用者の指定・2026-08-28） |
      | 絵（コマの入れ替え） | `roam-koma-*` | **2.5**（利用者が「今のまま」と明示） |
    */
    const 図 = 滑りの設計図()
    const 回遊秒 = (ROAM_LIFE_MS / 1000) * ((100 - 図.p2) / 100)
    const 毎秒 = 図.steps回遊 / 回遊秒
    expect(毎秒).toBeGreaterThan(5.5)
    expect(毎秒).toBeLessThan(6.5)

    const 絵 = ROAM_FLIP_FRAMES / (ROAM_FLIP_MS / 1000)
    expect(絵).toBeGreaterThanOrEqual(2)
    expect(絵).toBeLessThanOrEqual(3)
  })

  it('コマは4枚が順に1枚ずつ、濃さはカードから配られる', () => {
    /*
      コマ k は1巡のうち [k/4, (k+1)/4) だけ見える。**同時に2枚見えると波が濁り、
      0枚だと点滅する**。濃さは `var(--roam-ink)`——固定値で塗ると、輪と線で
      濃さが食い違う（フェーズ8 が塞いだ形）。
    */
    for (let k = 0; k < ROAM_FLIP_FRAMES; k += 1) {
      const 塊 = new RegExp(`@keyframes\\s+roam-koma-${k}\\s*\\{[\\s\\S]*?\\n\\}`).exec(素のCSS())?.[0] ?? ''
      expect(塊, `roam-koma-${k}`).not.toBe('')
      expect(塊).toContain('var(--roam-ink)')
      const 入り = k * 25
      // 見える区間の頭で ink、その手前と直後の区間は 0
      const 行 = [...塊.matchAll(/^\s*([\d.]+)%\s*\{\s*\n\s*opacity:\s*([^;]+);/gm)].map((m) => ({
        at: Number(m[1]),
        値: m[2].trim(),
      }))
      const 見える = 行.find((r) => r.at === 入り)
      expect(見える?.値, `roam-koma-${k} の ${入り}%`).toBe('var(--roam-ink)')
    }
  })

  it('退場はぷくっと2回＝2Hz。閃光の下限に当たらない', () => {
    /*
      `jello` の8段減衰を写すと**1秒に3回の閾値**（SC 2.3.1）に当たる。
      小芝居は 1000ms で puff 2回＝2Hz に抑えてある（`ROAM_ACT_MS` の約束）。
      **3回に増やすと、ここが落ちる。**
    */
    const 塊 = /@keyframes\s+roam-exit\s*\{[\s\S]*?\n\}/.exec(素のCSS())?.[0] ?? ''
    expect(塊).not.toBe('')
    const puff = [...塊.matchAll(/--roam-dash-puff/g)]
    expect(puff).toHaveLength(2)
    // 最後は閉じる（窓 0＝消えた）
    const 行 = [...塊.matchAll(/^\s*([\d.]+)%\s*\{\s*\n\s*stroke-dasharray:\s*var\((--[\w-]+)\)/gm)]
    const 最後 = 行[行.length - 1]
    expect(最後?.[1]).toBe('100')
    expect(最後?.[2]).toBe('--roam-dash-closed')
    // 後半加速の節目は、小芝居と消える瞬間の比から引く（88.5%）
    const 節 = ((ROAM_ACT_MS / ROAM_EXIT_MS) * 100).toFixed(1)
    expect(塊).toContain(`${節}%`)
  })
})

describe('紙片＝path', () => {
  it('線の太さが、CSS と定数で揃っている', () => {
    // `lib/roam.ts` の `ROAM_INK_PX` が波の焼き幅の根拠を持つ。片方だけ動かすと
    // 「波が線幅に埋もれる／飛び出す」が黙って起きる
    const [紙] = 全規則.filter((rule) => rule.selector.trim() === '.roam-paper')
    expect(紙).toBeDefined()
    expect(紙.body).toContain(`stroke-width: ${ROAM_INK_PX}px`)
    expect(紙.body).toContain('fill: none')
    expect(紙.body).toContain('stroke-linecap: round')
  })

  it('4つのリストは1つも省かない', () => {
    /*
      CSS は**リストが足りないと先頭から繰り返す**——`1, 1` のままだとコマの
      `infinite` が消えて1回で止まり、`ease-out, ease-out` のままだとコマ送りが
      滑らかな補間になる。**どちらもエラーにならず、画面は動き続けるので目で
      気づけない**（フェーズ15 で確立した作法）。
    */
    const [紙] = 全規則.filter((rule) => rule.selector.trim() === '.roam-paper')
    for (const 欄 of [
      'animation-timing-function: ease-out, steps(1), linear, ease-in-out',
      'animation-iteration-count: 1, infinite, 1, 1',
      'animation-fill-mode: none, none, both, forwards',
    ]) {
      expect(紙.body).toContain(欄)
    }
  })

  it('止める規則に勝てる場所にしか、動きの名前を書かない', () => {
    /*
      **2026-08-28 に実際に踏んだ後戻りへの番人。** `animation-name` を属性つきの
      選び方（詳細度 (0,2,0)）へ書くと、末尾の `prefers-reduced-motion` の打ち消し
      （(0,1,0)・順序で勝つ）に**詳細度で勝ってしまう**。

      いまの置き場所は `.roam-koma-N`（単一クラス＝(0,1,0)）だけ。**それ以外の
      セレクタに `animation-name` が現れたら、この形が崩れている。**
    */
    for (const 規則 of 全規則) {
      if (!規則.body.includes('animation-name')) continue
      expect(規則.selector.trim()).toMatch(/^\.roam-koma-\d$/)
    }
    // 打ち消し側は「静けさ」と OS 設定の2枚。**両方とも animation: none と不可視**
    const 止め = 全規則.filter((rule) => rule.body.includes('animation: none'))
    expect(止め.length).toBeGreaterThanOrEqual(2)
    for (const 規則 of 止め) {
      expect(規則.body).toContain('opacity: 0')
    }
    const 静けさ = 止め.filter((rule) => rule.selector.includes('[data-quiet'))
    const 減らす = 止め.filter((rule) => rule.selector.includes('prefers-reduced-motion'))
    expect(静けさ.length).toBeGreaterThan(0)
    expect(減らす.length).toBeGreaterThan(0)
    // **OS 設定の打ち消しはファイルの最後。** 詳細度が (0,1,0) で並ぶので順序だけが頼り
    const 最後の規則 = 全規則[全規則.length - 1]
    expect(最後の規則.selector).toContain('prefers-reduced-motion')
  })

  it('箱の残骸が無い', () => {
    /*
      **箱の作りへ戻る扉を閉める。** `clip-path`・`roam-flutter`・`--roam-turn`・
      `roam-drift` は全部、箱1つで線を作っていた時代のもの——どれかが復活したら、
      「経路の一部を見せる」設計（§23）から外れ始めている。
    */
    for (const 残骸 of ['clip-path', 'roam-flutter', '--roam-turn', 'roam-drift', 'roam-fade', '--roam-x0']) {
      expect(素のCSS(), 残骸).not.toContain(残骸)
    }
  })
})

describe('寿命・道のり・速さの連動', () => {
  it('速さは 25.68px/秒 前後＝要件15-7 の 0.8倍（99.0%）', () => {
    /*
      **3つは連動する**（設計§23-4。テスト計画「1つだけ変えると落ちる形にする」）。
      寿命だけ変えると速さが動き、区間数だけ変えると道のりが動く——**この検査は
      その組を1つの数（速さ）で束ねる**。

      0.8倍ちょうど（20.54px/秒）にはならない。区間は整数なので 28区間＝100.9% が
      いちばん近い（27 は 97.7%・29 は 104.2%）。**2026-08-31 に 25.68 → 20.73px/秒**
      （寿命 70→84秒・要件15-9。設計§23-5）。
    */
    const 総 = roamSpans().reduce((a, b) => a + b, 0)
    const 速さ = 総 / (ROAM_LIFE_MS / 1000)
    expect(速さ).toBeGreaterThan(20.4)
    expect(速さ).toBeLessThan(21.0)
  })
})
