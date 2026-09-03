import { describe, expect, it } from 'vitest'
import {
  centerOf,
  dropTarget,
  headingOf,
  HEADING_MIN_PX,
  SEAL_RELEASE_PX,
  VELOCITY_WINDOW_MS,
  type Seal,
  moveItem,
  nearestIndex,
  NO_TARGET,
  passedThreshold,
  type Point,
  type Rect,
} from './reorder'

/**
 * 落とし先を決める規則（並べ替え設計§3-4・テスト計画フェーズ4）。
 *
 * **DOM を1つも読まない。** jsdom は要素の幅を常に 800・左端を常に 0 で返すので、
 * 測る側と混ざると**何も確かめていない状態で緑になる**。ここは矩形を字で書く。
 *
 * **期待値も字で書く。** 実装と同じ定数から組み立てると、定数が動いたときに
 * 期待値も一緒に動いて、通ったままになる。
 */

/** 左上と大きさから矩形を作るだけの助け（**実装の関数は使わない**）。 */
function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height }
}

describe('矩形の中心', () => {
  it('左上と大きさから出す', () => {
    expect(centerOf(rect(10, 20, 100, 40))).toEqual({ x: 60, y: 40 })
  })
})

describe('落とし先は、いちばん近い中心で決まる', () => {
  // 3つの並び方を**同じ関数**へ通す。次元ごとの分岐が無いことの担保

  it('縦1列（枠の並び）', () => {
    const rects = [rect(0, 0, 200, 100), rect(0, 100, 200, 100), rect(0, 200, 200, 100)]
    // 中心は y = 50 / 150 / 250
    expect(nearestIndex(rects, { x: 100, y: 10 })).toBe(0)
    expect(nearestIndex(rects, { x: 100, y: 140 })).toBe(1)
    expect(nearestIndex(rects, { x: 100, y: 999 })).toBe(2)
  })

  it('横1列（PJT 専用画面の区画）', () => {
    const rects = [rect(0, 0, 100, 300), rect(100, 0, 100, 300), rect(200, 0, 100, 300)]
    // 中心は x = 50 / 150 / 250
    expect(nearestIndex(rects, { x: 20, y: 150 })).toBe(0)
    expect(nearestIndex(rects, { x: 160, y: 150 })).toBe(1)
    expect(nearestIndex(rects, { x: 280, y: 150 })).toBe(2)
  })

  it('折り返しの2次元（一覧のカード）', () => {
    // 2列×2行。中心は (50,50) (150,50) (50,150) (150,150)
    const rects = [
      rect(0, 0, 100, 100),
      rect(100, 0, 100, 100),
      rect(0, 100, 100, 100),
      rect(100, 100, 100, 100),
    ]
    expect(nearestIndex(rects, { x: 10, y: 10 })).toBe(0)
    expect(nearestIndex(rects, { x: 190, y: 10 })).toBe(1)
    expect(nearestIndex(rects, { x: 10, y: 190 })).toBe(2)
    expect(nearestIndex(rects, { x: 190, y: 190 })).toBe(3)
    // **折り返しの端**。行をまたいで近いほうへ寄る（横だけを見ていると 1 になる）
    expect(nearestIndex(rects, { x: 130, y: 140 })).toBe(3)
  })

  it('同じ距離なら、先に出てきたほうを採る', () => {
    // 中心が x = 50 と x = 150、指はちょうど真ん中の 100
    const rects = [rect(0, 0, 100, 100), rect(100, 0, 100, 100)]
    expect(nearestIndex(rects, { x: 100, y: 50 })).toBe(0)
  })
})

describe('決められないときは、先頭へ倒さない', () => {
  // 0 は「先頭へ落とす」という立派な答えなので、混ぜると**測れなかったときに
  // 黙って先頭へ飛ぶ**

  it('矩形が1つも無ければ NO_TARGET', () => {
    expect(nearestIndex([], { x: 10, y: 10 })).toBe(-1)
    expect(NO_TARGET).toBe(-1)
  })

  it('指の座標が数でなければ NO_TARGET', () => {
    const rects = [rect(0, 0, 100, 100)]
    expect(nearestIndex(rects, { x: Number.NaN, y: 10 })).toBe(-1)
    expect(nearestIndex(rects, { x: 10, y: Number.POSITIVE_INFINITY })).toBe(-1)
  })

  it('測れなかった矩形は飛ばし、測れたものから選ぶ', () => {
    const rects = [
      { left: Number.NaN, top: 0, width: 100, height: 100 },
      rect(100, 0, 100, 100),
    ]
    expect(nearestIndex(rects, { x: 0, y: 0 })).toBe(1)
  })
})

describe('並びを入れ替える', () => {
  it('前から後ろへ', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
  })

  it('後ろから前へ', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('動かないときは同じ配列を返す', () => {
    // 毎フレーム呼ぶので、中身が同じでも新しい配列を返すと描き直しが止まらない
    const items = ['a', 'b', 'c']
    expect(moveItem(items, 1, 1)).toBe(items)
    expect(moveItem(items, -1, 0)).toBe(items)
    expect(moveItem(items, 0, 9)).toBe(items)
    expect(moveItem(items, 0, NO_TARGET)).toBe(items)
  })
})

describe('運び始めるしきい値', () => {
  it('斜めでも同じ距離で始まる', () => {
    // 3px。**縦横のどちらか一方だけで数えると、斜めに引いたときだけ始まらない**
    expect(passedThreshold(3, 0)).toBe(true)
    expect(passedThreshold(0, -3)).toBe(true)
    // **斜めは斜辺で数える。** 縦横それぞれが 3px に届いていなくても、
    // 実際に指が動いた長さが 3px を超えていれば始まる
    expect(passedThreshold(2.2, 2.2)).toBe(true) // 斜辺は約 3.11
    expect(passedThreshold(2, 2)).toBe(false) // 約 2.83。**まだ始まらない**
    expect(passedThreshold(1, 1)).toBe(false) // 約 1.41
  })

  it('数でなければ始まらない', () => {
    expect(passedThreshold(Number.NaN, 0)).toBe(false)
  })
})

/*
  **実寸を字で書く**（設計§15-9）。jsdom の矩形は固定なので、折り返しの縦横比は
  自分で書くしかない。値は `DESIGN.md`／実装の実測：カード 294×200・隙間 12px・3列、
  枠は幅 940・隙間 16、区画は 672×900・隙間 16。**実装の定数は使わない。**
*/

/** 一覧のカード：294×200・隙間 12・3列。左端 0/306/612、上端 0/212/424 */
function 格子(枚数: number): Rect[] {
  const out: Rect[] = []
  for (let i = 0; i < 枚数; i += 1) {
    out.push(rect((i % 3) * 306, Math.floor(i / 3) * 212, 294, 200))
  }
  return out
}

/** 枠：幅 940・隙間 16・高さは引数どおり縦に積む */
function 枠の並び(高さ: number[]): Rect[] {
  const out: Rect[] = []
  let top = 0
  for (const h of 高さ) {
    out.push(rect(0, top, 940, h))
    top += h + 16
  }
  return out
}

/** 区画：672×900・隙間 16・横に並べる */
function 区画の並び(本数: number): Rect[] {
  const out: Rect[] = []
  for (let i = 0; i < 本数; i += 1) {
    out.push(rect(i * (672 + 16), 0, 672, 900))
  }
  return out
}

function 判定(rects: Rect[], point: Point, current: number, seal: Seal | null = null, heading: Point | null = null) {
  return dropTarget({ rects, point, current, seal, heading })
}

describe('nearestIndex は判定に使わない（対照）', () => {
  it('折り返しで 2px 動くと、中心距離は列数ぶん飛ぶが、行→矩形→1歩なら1歩', () => {
    /*
      **調査レポートの実測そのもの**（設計§15-3）。格子の角では4つの中心から等距離に
      なる点があり、そこから 2px 動くと中心距離は添字を3つ飛ばす。1歩なら隣だけ。
    */
    const rects = 格子(6)
    expect(nearestIndex(rects, { x: 453, y: 205 })).toBe(1)
    expect(nearestIndex(rects, { x: 453, y: 207 })).toBe(4)
    expect(判定(rects, { x: 453, y: 207 }, 1).index).toBe(2)
  })

  it('高さの不揃いな枠では、中心距離だと境界が背の高い枠の内側に食い込む', () => {
    // h₁=1300・h₂=45：中心距離の境界は y ≈ 994。**枠は y=1300 まで見えている**
    const rects = 枠の並び([1300, 45])
    expect(nearestIndex(rects, { x: 470, y: 1000 })).toBe(1)
    expect(判定(rects, { x: 470, y: 1000 }, 0).index).toBe(0)
  })
})

describe('落とし先は、行→矩形→1歩で決まる', () => {
  it('格子の角の4等距離点から 1px 動かしても、1歩しか動かない', () => {
    // (300,206) は 0・1・3・4 の中心から等距離。1px 動かして 4 へ向かっても、動くのは 1 だけ
    const rects = 格子(6)
    expect(判定(rects, { x: 301, y: 207 }, 0).index).toBe(1)
    expect(判定(rects, { x: 299, y: 205 }, 4).index).toBe(3)
  })

  it('箱の内側に居る限り動かず、封印も同じ参照を返す', () => {
    const rects = 格子(6)
    const seal = null
    for (const point of [
      { x: 1, y: 1 },
      { x: 293, y: 199 },
      { x: 150, y: 100 },
    ]) {
      const result = 判定(rects, point, 0, seal)
      expect(result.index).toBe(0)
      expect(result.seal).toBe(seal)
    }
  })

  it('同じ行では矩形までの距離で選び、隙間の真ん中では動かない', () => {
    // 0 の右端は 294、1 の左端は 306。真ん中（300）はどちらからも 6px——**current を優先**
    const rects = 格子(3)
    expect(判定(rects, { x: 300, y: 100 }, 0).index).toBe(0)
    expect(判定(rects, { x: 302, y: 100 }, 0).index).toBe(1)
  })

  it('行が違うときは、その行の中で中心 x が近いものへ向かう', () => {
    // 2行目の帯（212〜412）へ入った。current（0）は1行目なので中心 x で選ぶ → 4 へ向かって1歩
    const rects = 格子(6)
    expect(判定(rects, { x: 453, y: 300 }, 0).index).toBe(1)
  })

  it('行が1つ（区画）でも同じ規則で決まる', () => {
    const rects = 区画の並び(3)
    expect(判定(rects, { x: 700, y: 450 }, 0).index).toBe(1)
    expect(判定(rects, { x: 300, y: 450 }, 0).index).toBe(0)
  })

  it('高さ 1300 と 45 の枠で、境界が隙間に来る', () => {
    const rects = 枠の並び([1300, 45])
    expect(判定(rects, { x: 470, y: 1000 }, 0).index).toBe(0)
    expect(判定(rects, { x: 470, y: 1299 }, 0).index).toBe(0)
    expect(判定(rects, { x: 470, y: 1317 }, 0).index).toBe(1)
  })

  it('測れなかった矩形は行に入れず、残りで決める', () => {
    const rects = 格子(3)
    rects[1] = rect(Number.NaN, Number.NaN, 0, 0)
    // 1 は無いものとして、0 から 2 へ向かう1歩は 1（スロットは飛ばない）
    expect(判定(rects, { x: 700, y: 100 }, 0).index).toBe(1)
  })

  it('決められないときは、いまの添字と封印をそのまま返す', () => {
    const seal: Seal = { index: 2, at: { x: 0, y: 0 }, heading: null }
    expect(判定([], { x: 10, y: 10 }, 1, seal)).toEqual({ index: 1, seal })
    expect(判定(格子(3), { x: Number.NaN, y: 10 }, 1, seal).seal).toBe(seal)
  })
})

describe('封印：直前に居た添字へは戻さない', () => {
  const rects = 格子(3)

  it('境界上で ±2px 往復させても戻らない', () => {
    // 302 で 0→1 へ動き、0 を封印。以後 298／302 を往復しても 1 のまま
    let result = 判定(rects, { x: 302, y: 100 }, 0)
    expect(result.index).toBe(1)
    expect(result.seal?.index).toBe(0)
    let current = 1
    for (let i = 0; i < 10; i += 1) {
      const x = i % 2 === 0 ? 298 : 302
      result = 判定(rects, { x, y: 100 }, current, result.seal)
      expect(result.index, `${i}回目`).toBe(1)
      current = result.index
    }
  })

  it('封印から離れる歩は通る', () => {
    const 封印 = 判定(rects, { x: 302, y: 100 }, 0).seal
    const result = 判定(rects, { x: 620, y: 100 }, 1, 封印)
    expect(result.index).toBe(2)
    expect(result.seal?.index).toBe(1)
  })

  it('封印した点から 10px 動けば解ける', () => {
    const 封印 = 判定(rects, { x: 302, y: 100 }, 0).seal
    expect(判定(rects, { x: 302 - SEAL_RELEASE_PX + 1, y: 100 }, 1, 封印).index).toBe(1)
    expect(判定(rects, { x: 302 - SEAL_RELEASE_PX, y: 100 }, 1, 封印).index).toBe(0)
  })

  it('進行方向が 1 rad 変われば解ける', () => {
    const 封印 = 判定(rects, { x: 302, y: 100 }, 0, null, { x: 1, y: 0 }).seal
    expect(封印?.heading).toEqual({ x: 1, y: 0 })
    // 同じ向きのままなら戻らない
    expect(判定(rects, { x: 298, y: 100 }, 1, 封印, { x: 1, y: 0 }).index).toBe(1)
    // 逆を向いたら戻れる
    expect(判定(rects, { x: 298, y: 100 }, 1, 封印, { x: -1, y: 0 }).index).toBe(0)
  })

  it('動かないときは、渡した封印と同じ参照を返す', () => {
    const 封印 = 判定(rects, { x: 302, y: 100 }, 0).seal
    const result = 判定(rects, { x: 299, y: 100 }, 1, 封印)
    expect(result.seal).toBe(封印)
  })
})

describe('進行方向', () => {
  it('窓の中の最古→最新の変位から、単位ベクトルを出す', () => {
    expect(
      headingOf(
        [
          { t: 0, x: 0, y: 0 },
          { t: 50, x: 3, y: 4 },
          { t: 90, x: 6, y: 8 },
        ],
        100,
      ),
    ).toEqual({ x: 0.6, y: 0.8 })
  })

  it('窓の外の標本は捨てる', () => {
    const 古い = { t: 0, x: -100, y: 0 }
    const いま = [{ t: 150, x: 0, y: 0 }, { t: 190, x: 0, y: 8 }]
    expect(headingOf([古い, ...いま], 150 + VELOCITY_WINDOW_MS)).toEqual({ x: 0, y: 1 })
  })

  it('変位が下限に届かなければ立たない', () => {
    // ±2px の揺れ（幅 4px）では方向が立たない
    expect(headingOf([{ t: 0, x: 0, y: 0 }, { t: 50, x: HEADING_MIN_PX - 1, y: 0 }], 60)).toBeNull()
    expect(headingOf([{ t: 0, x: 0, y: 0 }], 60)).toBeNull()
    expect(headingOf([], 60)).toBeNull()
  })
})
