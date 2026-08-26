import { describe, expect, it } from 'vitest'
import {
  MARGIN,
  ROAM_STOPS,
  ROAM_TURN,
  type RoamField,
  type RoamRect,
  planRoute,
  routeVars,
} from '@/lib/roam'

/**
 * 回遊の経路（`lib/roam.ts`）。
 *
 * **ここで確かめられるのは経路の計算だけ。** 実際に線が飛ぶかどうかは CSS が決めるので
 * E2E（`web/e2e/roam.spec.ts`）が見る。
 *
 * # 測る側は、ここでは呼ばない
 *
 * `measureField` は DOM を読むが、jsdom の `getBoundingClientRect` は**全部 0 を返す**
 * ので、ここで呼ぶと**縮退した格子を通って緑になる**——「何も証明しない経路」になる。
 * 純関数だけを相手にし、測った結果は手で組み立てる。
 */

/** カード3枚が2列に並んだ、ありふれた一覧。**通路が立つ形**にしてある */
const CARDS: RoamRect[] = [
  { x: 12, y: 60, w: 288, h: 120 },
  { x: 312, y: 60, w: 288, h: 120 },
  { x: 12, y: 192, w: 288, h: 120 },
]
const GROUP: RoamRect = { x: 0, y: 40, w: 900, h: 300 }

const FIELD: RoamField = {
  width: 1200,
  height: 900,
  card: CARDS[0],
  rects: [GROUP, ...CARDS],
}

/** 場の内側に収まっているか（**ボックスの角まで**含めて） */
function 内側(点: { x: number; y: number }): boolean {
  return (
    点.x >= MARGIN &&
    点.x <= FIELD.width - MARGIN &&
    点.y >= MARGIN &&
    点.y <= FIELD.height - MARGIN
  )
}

describe('回遊の経路', () => {
  it('停留点は決めた数だけ', () => {
    // `roam.css` のキーフレームと揃う。ずれると、最後の点だけ使われない／
    // 存在しない変数を読む形になる
    expect(planRoute(FIELD, 1)).toHaveLength(ROAM_STOPS)
  })

  it('最初の点はカードの右上の角', () => {
    // **左上には切り欠きがある**（`tile.css` の `clip-path`）ので、そちらは使わない。
    // 右上は空いている——復旧ボタンは `revivable.kind !== 'live'` のときだけ出るが、
    // 跳ねるのは生きた権限確認待ちのカードなので同時に存在しない（設計§9-7-2）
    const [先頭] = planRoute(FIELD, 1)
    expect(先頭.x).toBe(CARDS[0].x + CARDS[0].w)
    expect(先頭.y).toBe(CARDS[0].y)
  })

  it('2点目以降は、枠から取った通路の上にある', () => {
    /*
      **これが「意味のある動き」を守っている唯一の自動検査である。**

      前の版は画面内へランダムに散らした点を巡っていて、線が何も語らなかった
      （設計§9-7-1）。枠の外側 6px に立てた線の上にしか点が来ないことを見れば、
      ランダム散らしへ戻した瞬間に落ちる。
    */
    const xs = new Set<number>()
    const ys = new Set<number>()
    for (const r of FIELD.rects) {
      xs.add(Math.round(r.x - 6))
      xs.add(Math.round(r.x + r.w + 6))
      ys.add(Math.round(r.y - 6))
      ys.add(Math.round(r.y + r.h + 6))
    }
    // 場の縁も道になる
    xs.add(MARGIN)
    xs.add(FIELD.width - MARGIN)
    ys.add(MARGIN)
    ys.add(FIELD.height - MARGIN)

    for (const seed of [1, 2, 3, 17, 99]) {
      for (const 点 of planRoute(FIELD, seed).slice(1)) {
        expect(xs).toContain(点.x)
        expect(ys).toContain(点.y)
      }
    }
  })

  it('曲がるときは必ず直角', () => {
    // **ランダムなのは「曲がるかどうか」であって、角度ではない**（設計§9-7-4）。
    // 道そのものは読めるまま、分岐だけが予測できない——生き物っぽさをここで出す
    for (const seed of [1, 5, 42]) {
      const 経路 = planRoute(FIELD, seed)
      for (let i = 1; i < 経路.length - 1; i += 1) {
        const dx = 経路[i + 1].x - 経路[i].x
        const dy = 経路[i + 1].y - 経路[i].y
        // 縦か横のどちらか一方しか動かない＝軸に沿っている
        expect(dx === 0 || dy === 0).toBe(true)
      }
    }
  })

  it('場の内側に収まる', () => {
    // 外へ出すと見切れるだけでなく、**スクロールできる範囲を押し広げる**
    // （CSS Overflow 3 §3.5 は「包含ブロックである子孫の変形後のボーダーボックス」を
    // 数える）。`MARGIN` は回転と尺取り虫の拡大を織り込んだ半対角ぶん
    for (const seed of [1, 2, 3, 17, 99]) {
      for (const 点 of planRoute(FIELD, seed)) {
        expect(内側(点)).toBe(true)
      }
    }
  })

  it('同じ種なら同じ経路になる', () => {
    // **乱数を使わない。** 使うとテストが揺れるし、壊し方を当てても再現しない
    expect(planRoute(FIELD, 7)).toEqual(planRoute(FIELD, 7))
  })

  it('種が違えば経路も違う', () => {
    // 較正。同じ経路しか作れないなら、上のテストは「当たらないから通る」空振りになる
    expect(planRoute(FIELD, 7)).not.toEqual(planRoute(FIELD, 8))
  })

  it('風に流される向きは、種ごとに違う', () => {
    // ②の飛散。**3本が揃って同じ方向へ出ると「風」に見えない**（設計§9-7-2）
    const 行き先 = [1, 2, 3].map((seed) => {
      const [, 二点目] = planRoute(FIELD, seed)
      return `${二点目.x},${二点目.y}`
    })
    expect(new Set(行き先).size).toBeGreaterThan(1)
  })

  it('矩形が1つも無くても、歩けて場の内側に収まる', () => {
    // 縮退。**無いままにすると無限ループか `NaN` が本番でだけ出る**——場の縁だけを
    // 道にして歩く
    const 空 = { ...FIELD, rects: [] }
    const 経路 = planRoute(空, 3)
    expect(経路).toHaveLength(ROAM_STOPS)
    for (const 点 of 経路) {
      expect(Number.isFinite(点.x)).toBe(true)
      expect(Number.isFinite(点.y)).toBe(true)
      expect(内側(点)).toBe(true)
    }
  })

  it('場が余白より狭くても、点が裏返らない', () => {
    // 極端に狭い窓では左右の境が交差する。挟む先が無いので真ん中へ寄せる
    const 狭い = { width: 10, height: 10, card: CARDS[0], rects: [] }
    for (const 点 of planRoute(狭い, 3)) {
      expect(Number.isFinite(点.x)).toBe(true)
      expect(Number.isFinite(点.y)).toBe(true)
    }
  })
})

describe('停留点を CSS 変数へ写す', () => {
  it('点ごとに x / y / r の3つを出す', () => {
    const vars = routeVars(planRoute(FIELD, 2))
    // 点ごとの3つ ＋ 転回の1つ
    expect(Object.keys(vars)).toHaveLength(ROAM_STOPS * 3 + 1)
    for (let i = 0; i < ROAM_STOPS; i += 1) {
      expect(vars[`--roam-x${i}`]).toMatch(/^-?\d+px$/)
      expect(vars[`--roam-y${i}`]).toMatch(/^-?\d+px$/)
      expect(vars[`--roam-r${i}`]).toMatch(/^-?\d+deg$/)
    }
  })

  it('転回のぶんが、角度へ織り込まれている', () => {
    /*
      ③の1回転（設計§9-7-2）。**`animation-composition: add` を使わずに作ってある**
      ——停留点1の座標を据え置いたまま向きだけ `--roam-turn` へ回し、以降の角度にも
      同じだけ足しておくと、1本のキーフレームのまま「その場で1回転」になる。

      **足し忘れると、線は回らずに素通りする**（見た目は自然なので気づけない）。
    */
    const 経路 = planRoute(FIELD, 2)
    const vars = routeVars(経路)

    expect(vars['--roam-turn']).toBe(`${Math.round(経路[1].r) + ROAM_TURN}deg`)
    // 0 と 1 には足さない（①発生と②飛散は、進む向きを向いているだけ）
    expect(vars['--roam-r0']).toBe(`${Math.round(経路[0].r)}deg`)
    expect(vars['--roam-r1']).toBe(`${Math.round(経路[1].r)}deg`)
    for (let i = 2; i < ROAM_STOPS; i += 1) {
      expect(vars[`--roam-r${i}`]).toBe(`${Math.round(経路[i].r) + ROAM_TURN}deg`)
    }
  })
})
