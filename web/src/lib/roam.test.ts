import { describe, expect, it } from 'vitest'
import { ROAM_STOPS, planRoute, routeVars } from '@/lib/roam'

/**
 * 回遊の経路（`lib/roam.ts`）。
 *
 * **ここで確かめられるのは経路の計算だけ。** 実際に線が飛ぶかどうかは CSS が決めるので
 * E2E（`web/e2e/roam.spec.ts`）が見る。
 */

const VIEWPORT = { width: 1600, height: 900 }
const CARD = { left: 300, top: 400, width: 294 }

describe('回遊の経路', () => {
  it('停留点は5つ', () => {
    // `roam.css` のキーフレームが 0/8/35/65/100% の5点で書いてある。
    // ここがずれると、最後の点だけ使われない／存在しない変数を読む形になる
    expect(planRoute(CARD, VIEWPORT, 1)).toHaveLength(ROAM_STOPS)
  })

  it('最初の点はカードの上辺の中央', () => {
    // **跳ねた勢いで上へ抜ける読みにする。** 中心から出すと、飛び出しの向きが
    // カードの内側から始まって「湧いた」ように見える
    const [先頭] = planRoute(CARD, VIEWPORT, 1)
    expect(先頭.x).toBe(CARD.left + CARD.width / 2)
    expect(先頭.y).toBe(CARD.top)
  })

  it('2点目以降は画面の内側に収まる', () => {
    // 画面の外へ出すと見切れるだけでなく、**`fixed` の要素がスクロールできる範囲を
    // 押し広げる**——一覧に無用の余白が生まれる
    for (const seed of [1, 2, 3, 17, 99]) {
      for (const 点 of planRoute(CARD, VIEWPORT, seed).slice(1)) {
        expect(点.x).toBeGreaterThanOrEqual(24)
        expect(点.x).toBeLessThanOrEqual(VIEWPORT.width - 24)
        expect(点.y).toBeGreaterThanOrEqual(24)
        expect(点.y).toBeLessThanOrEqual(VIEWPORT.height - 24)
      }
    }
  })

  it('同じ種なら同じ経路になる', () => {
    // **乱数を使わない。** 使うとテストが揺れるし、壊し方を当てても再現しない
    expect(planRoute(CARD, VIEWPORT, 7)).toEqual(planRoute(CARD, VIEWPORT, 7))
  })

  it('種が違えば経路も違う', () => {
    // 較正。同じ経路しか作れないなら、上のテストは「当たらないから通る」空振りになる
    expect(planRoute(CARD, VIEWPORT, 7)).not.toEqual(planRoute(CARD, VIEWPORT, 8))
  })

  it('向きは、次の点へ進む向きと一致する', () => {
    // 線は進行方向を向く＝漫画のスピード線の読みになる
    const 経路 = planRoute(CARD, VIEWPORT, 5)
    for (let i = 0; i < 経路.length - 1; i += 1) {
      const 期待 =
        (Math.atan2(経路[i + 1].y - 経路[i].y, 経路[i + 1].x - 経路[i].x) * 180) /
        Math.PI
      expect(経路[i].r).toBeCloseTo(期待, 6)
    }
  })

  it('画面が余白より狭くても、点が裏返らない', () => {
    // 極端に狭い窓（幅 40px）では左右の境が交差する。挟む先が無いので真ん中へ寄せる
    for (const 点 of planRoute(CARD, { width: 40, height: 40 }, 3).slice(1)) {
      expect(Number.isFinite(点.x)).toBe(true)
      expect(Number.isFinite(点.y)).toBe(true)
      expect(点.x).toBeCloseTo(20, 6)
      expect(点.y).toBeCloseTo(20, 6)
    }
  })
})

describe('停留点を CSS 変数へ写す', () => {
  it('点ごとに x / y / r の3つを出す', () => {
    const vars = routeVars(planRoute(CARD, VIEWPORT, 2))
    expect(Object.keys(vars)).toHaveLength(ROAM_STOPS * 3)
    for (let i = 0; i < ROAM_STOPS; i += 1) {
      expect(vars[`--roam-x${i}`]).toMatch(/^-?\d+px$/)
      expect(vars[`--roam-y${i}`]).toMatch(/^-?\d+px$/)
      expect(vars[`--roam-r${i}`]).toMatch(/^-?\d+deg$/)
    }
  })
})
