import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 帯の操作の見た目（`controls.css`）を、**テキストとして**確かめる（設計§15）。
 *
 * # なぜテキストなのか
 *
 * テストは jsdom で走るが、**jsdom は CSS を適用しない**。「静けさで明滅が止まる」
 * 「OS が『動きを減らす』と言えば止まる」「触ると色づく」は、**画面を描いても
 * 1つも確かめられない**。ここで確かめられるのは「そう書いてある」ことまでで、
 * 実際に効くかは実物を見るしかない（テスト計画フェーズ7 の【要人間】）。
 *
 * # `tile.test.ts` より軽い作りにしてある
 *
 * あちらは `@media` を展開する簡易パーサを持っているが、ここで守りたい壊れ方は
 * **「打ち消しより後ろに規則を足してしまう」1つ**に絞れるので、位置の比較で足りる。
 * 数え方を2つに増やすほうが、次に読む人の負担になる。
 *
 * **較正してから使う。** 当たらない正規表現は「落ちないから通る」空振りになる。
 */
function 読む(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src', name), 'utf8')
}

const CSS = 読む('controls.css')
const INDEX = 読む('index.css')
const PROTOCOL = readFileSync(
  resolve(process.cwd(), 'src', 'lib', 'protocol.ts'),
  'utf8',
)

/** コメントを落とす。中に `{}` や `left:` が入っているので、先に消さないと位置が狂う */
const 素 = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** その断片が最初に出る位置。無ければ落とす（空振りを通さない） */
function 位置(断片: string): number {
  const at = 素.indexOf(断片)
  expect(at, `実物に当たらない断片: ${断片}`).toBeGreaterThan(-1)
  return at
}

/** `.termswitch-knob { … }` のような1つの塊から、宣言を1つ取り出す */
function 宣言(selector: string, prop: string): string {
  const at = 位置(selector)
  const 開き = 素.indexOf('{', at)
  const 閉じ = 素.indexOf('}', 開き)
  const 本体 = 素.slice(開き + 1, 閉じ)
  const 当たり = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(本体)
  expect(当たり, `${selector} に ${prop} が無い`).not.toBeNull()
  return (当たり?.[1] ?? '').trim()
}

/** `1.75rem` のような値を数に開く */
function rem(値: string): number {
  const 当たり = /^(-?[\d.]+)rem$/.exec(値)
  expect(当たり, `rem ではない: ${値}`).not.toBeNull()
  return Number(当たり?.[1])
}

describe('取り込みと較正', () => {
  it('index.css から取り込まれている', () => {
    // **書き忘れても、位置を誤っても、このファイルのテストは全部緑のまま通る。**
    // `@import` は他の規則より前でないと CSS の仕様で捨てられるので、位置まで見る
    const 素のINDEX = INDEX.replace(/\/\*[\s\S]*?\*\//g, '')
    const 取り込み = 素のINDEX.indexOf("@import './controls.css'")
    expect(取り込み).toBeGreaterThan(-1)
    expect(取り込み).toBeLessThan(素のINDEX.indexOf('{'))
  })

  it('較正：見たい規則が実物に在る', () => {
    for (const 断片 of [
      '.power {',
      ".power[data-power='on']",
      ".power[data-power='off']:not(:disabled):hover",
      ".power[data-busy='true']",
      '.termswitch-track {',
      '.termswitch-knob {',
      'prefers-reduced-motion',
    ]) {
      expect(素.indexOf(断片), `当たらない: ${断片}`).toBeGreaterThan(-1)
    }
  })
})

describe('地のデザインが変わっても、境目が出ないこと', () => {
  /**
   * **これは見た目の好みではなく、壊れ方の予防である。**
   *
   * 「地はこの色だろう」と推測して不透明に塗ると、**推測が外れた瞬間に円の輪郭が
   * 出る**。実際そう書いて外していた——帯は `--color-card` ではなく `body` の
   * `--color-background` の上に載っている。
   *
   * 半透明の明暗だけで作っておけば、色は**常に「そのとき後ろに在るもの ± わずか」**
   * になり、**背景の設計が変わってもここを直す必要が無い。**
   */
  it('電源ボタンの塗りが、地の色を名指ししていない', () => {
    const at = 位置('.power {')
    const 本体 = 素.slice(素.indexOf('{', at), 素.indexOf('}', 素.indexOf('{', at)))

    // 不透明に塗る宣言そのものを持たない（半透明の重ねだけ）
    expect(本体).not.toMatch(/(^|;|\s)background(-color)?\s*:/)

    /*
      **見るのは塗りだけ。** 輪（`border`）と影は「地の色」ではなく
      「そこに置く色」なので、テーマの token を指してよい——むしろ指すべきである。
    */
    const 塗り = 宣言('.power {', 'background-image')

    // 地の色を持ってくる道を塞ぐ
    for (const 地 of ['--color-card', '--color-background', '--color-popover']) {
      expect(塗り, `地の色を名指ししている: ${地}`).not.toContain(地)
    }

    // 重ねる明暗は、**必ず透明へ向かって**混ぜること。不透明な色を1つでも置くと、
    // そこが地と食い違った瞬間に輪郭が出る
    const 混ぜた = (塗り.match(/color-mix\(/g) ?? []).length
    const 透明へ = (塗り.match(/transparent/g) ?? []).length
    expect(混ぜた).toBeGreaterThan(0)
    expect(透明へ, '透明へ混ぜていない色がある').toBe(混ぜた)
  })

  it('トグルのつまみだけは、地に馴染ませない', () => {
    // ここは**動いて位置を示すもの**なので、後ろが何色でも読めなければならない。
    // テーマで反転する主題色を使う（`white` を直に塗ると明るいテーマで溶ける）
    expect(宣言('.termswitch-knob {', 'background-color')).toBe(
      'var(--color-foreground)',
    )
  })
})

describe('電源ボタン', () => {
  it('点灯が、進行中の色（`DESIGN.md` §11.2 Primary Accent）と同じである', () => {
    /*
      **かつてライム（Positive）だった。** 「状態の●とは別の軸だから別の色でよい」と
      整理していたが、**軸が違うことは色を分ける理由にならない**（同 §11.2 の判定・
      帯設計§17-5）——●も輪も「走っている」という**同じ言葉で説明できる**。

      **色を2箇所へ書くと、片方だけ古くなる。** 役割表を差し替えたときに
      ここが取り残されたら、このテストが落ちて教える。
    */
    const 当たり = /primary:\s*\{[\s\S]*?accent:\s*'([^']+)'/.exec(PROTOCOL)
    expect(当たり, 'protocol.ts の primary.accent を拾えていない').not.toBeNull()
    expect(素).toContain(`--power-lit: ${当たり?.[1]}`)
  })

  it('直径が ✕ の 32px を超えない（帯の高さを変えない）', () => {
    // 設計§15-4。**見た目の訂正が、このイシューの目的（行を増やさない）を
    // 上回ることはない**
    expect(rem(宣言('.power {', 'inline-size'))).toBeLessThanOrEqual(2)
    expect(宣言('.power {', 'block-size')).toBe(宣言('.power {', 'inline-size'))
  })

  it('触ると色づくのは、押せる消灯だけ', () => {
    // **押せる／押せないを分ける唯一の手がかり**（設計§15-1）。押せないほうにも
    // 同じ規則が当たると、この見分けが消える
    const hover = ".power[data-power='off']:not(:disabled):hover"
    expect(素.indexOf(hover)).toBeGreaterThan(-1)
    // 素の `.power:hover` を足すと、詳細度が同じぶん上の絞り込みが無意味になる
    expect(素).not.toMatch(/\.power:hover/)
  })

  it('点灯は輪の色であって、光を撒くことではない', () => {
    // `DESIGN.md` §27.1「常時 Glow させない」。点灯の規則が影を足していないこと
    const at = 位置(".power[data-power='on']")
    const 本体 = 素.slice(素.indexOf('{', at), 素.indexOf('}', 素.indexOf('{', at)))
    expect(本体).not.toContain('box-shadow')
  })
})

describe('動きの止め方', () => {
  const 静けさ = "[data-quiet='calm'] .power[data-busy='true']"

  it('静けさと OS の設定で、明滅が止まる', () => {
    expect(素.indexOf(静けさ)).toBeGreaterThan(-1)
    expect(素).toContain("[data-quiet='still'] .power[data-busy='true']")
    expect(素).toMatch(/prefers-reduced-motion[\s\S]*data-busy/)
  })

  it('打ち消しが、打ち消される規則より後ろに在る', () => {
    // **ここが構造で決まる壊れ方。** 明滅の規則を打ち消しより後ろへ足すと、
    // 詳細度が同じぶん**無言で効かなくなる**（`tile.css` が同じ理由で並びを固定
    // している）
    expect(位置(静けさ)).toBeGreaterThan(位置(".power[data-busy='true'] {"))
    expect(位置('prefers-reduced-motion')).toBeGreaterThan(位置(静けさ))
  })

  it('止めても輪の色は残る（消さない）', () => {
    // 静けさを選んでも「いま起こしている最中だ」は読めなければならない
    const at = 位置(静けさ)
    const 本体 = 素.slice(素.indexOf('{', at), 素.indexOf('}', 素.indexOf('{', at)))
    expect(本体).toContain('animation: none')
    expect(本体).toContain('border-color')
    expect(本体).not.toContain('display: none')
  })
})

describe('ターミナルのトグルは、文字を落として絵にした', () => {
  it('§15-3 の 1.3倍から、さらに大きくなっている', () => {
    // **文字が消えた以上、何のトグルかを言うのは絵だけ**（設計§17-4）。
    // 小さいと `DESIGN.md` §18.2 の下限を割り、**文字を落とした意味が消える**
    expect(rem(宣言('.termswitch-track {', 'block-size'))).toBeGreaterThan(1.3)
    expect(rem(宣言('.termswitch-track {', 'inline-size'))).toBeGreaterThan(2.275)
    expect(rem(宣言('.termswitch-knob {', 'inline-size'))).toBeGreaterThan(0.975)
  })

  it('つまみの左右が対称である', () => {
    // **§15-3 で直した非対称を、大きくするたびに作り直さない。**
    // 元の実装は入っているときにつまみが右端へ密着していた
    const 枠 = 0.0625 * 2
    const 中身 = rem(宣言('.termswitch-track {', 'inline-size')) - 枠
    const つまみ = rem(宣言('.termswitch-knob {', 'inline-size'))
    const 左余白 = rem(宣言('.termswitch-knob {', 'left'))
    const 入り = rem(宣言(".termswitch[aria-checked='true'] .termswitch-knob", 'left'))
    expect(中身 - 入り - つまみ).toBeCloseTo(左余白, 4)
  })

  it('絵は消さずに沈める（切り替えで位置が飛ばない）', () => {
    // 切れているときも同じ場所に在って濃さだけが落ちる（設計§17-4）
    const at = 位置('.termswitch-mark {')
    const 本体 = 素.slice(素.indexOf('{', at), 素.indexOf('}', 素.indexOf('{', at)))
    expect(本体).toContain('opacity: 0')
    expect(本体).not.toContain('display: none')
    expect(素).toContain(".termswitch[aria-checked='true'] .termswitch-mark")
  })

  it('入っているときの面は夜空で、紫青ではない', () => {
    /*
      `DESIGN.md` §11.4・§33——**同じ青でも Purple → Blue へ寄せると
      「AI SaaS 感」の側へ落ちる**。濃紺の側に紫を混ぜていないことを見る。

      **透明へ向けて混ぜてある**ことも見る（同 §11.4「画面でいちばん派手な面に
      しない」）。地が明るくなれば一緒に薄まる。
    */
    const at = 位置(".termswitch[aria-checked='true'] .termswitch-track")
    const 本体 = 素.slice(素.indexOf('{', at), 素.indexOf('}', 素.indexOf('{', at)))
    expect(本体).toContain('#0b2545')
    expect(本体).toContain('#3dd9e6')
    for (const 紫 of ['purple', 'violet', 'indigo', '#7', '#8', '#9']) {
      expect(本体.toLowerCase(), `紫へ寄っている: ${紫}`).not.toContain(紫)
    }
    const 混ぜた = (本体.match(/color-mix\(/g) ?? []).length
    const 透明へ = (本体.match(/transparent/g) ?? []).length
    expect(混ぜた).toBeGreaterThan(0)
    expect(透明へ).toBe(混ぜた)
  })
})
