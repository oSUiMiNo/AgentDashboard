import { describe, expect, it } from 'vitest'
import {
  autoScrollStep,
  AUTO_SCROLL_EDGE_PX,
  AUTO_SCROLL_STEP_PX,
} from './useReorder'

/**
 * 端で送る量の計算（並べ替え設計§3-5・方針§2-4）。
 *
 * **DOM を読まない部分だけをここで確かめる。** 実際に送れることは、jsdom が
 * スクロールを持たないので言えない——それは E2E の仕事。
 */

const 容器 = { left: 100, top: 100, width: 400, height: 300 }
// 右端は 500、下端は 400

describe('端に指があるあいだだけ送る', () => {
  it('真ん中では送らない', () => {
    expect(autoScrollStep({ x: 300, y: 250 }, 容器)).toEqual({ x: 0, y: 0 })
  })

  it('左端では左へ、右端では右へ', () => {
    // 端から 48px 内側までが「端」。数を字で書く
    expect(AUTO_SCROLL_EDGE_PX).toBe(48)
    expect(autoScrollStep({ x: 140, y: 250 }, 容器).x).toBe(-AUTO_SCROLL_STEP_PX)
    expect(autoScrollStep({ x: 470, y: 250 }, 容器).x).toBe(AUTO_SCROLL_STEP_PX)
    // 149 は左端から 49px。**まだ端ではない**
    expect(autoScrollStep({ x: 149, y: 250 }, 容器).x).toBe(0)
  })

  it('上端では上へ、下端では下へ', () => {
    expect(autoScrollStep({ x: 300, y: 140 }, 容器).y).toBe(-AUTO_SCROLL_STEP_PX)
    expect(autoScrollStep({ x: 300, y: 370 }, 容器).y).toBe(AUTO_SCROLL_STEP_PX)
  })

  it('角では両方へ同時に送る', () => {
    // 折り返しの2次元（一覧のカード）では、斜めに運ぶことがある
    expect(autoScrollStep({ x: 110, y: 110 }, 容器)).toEqual({
      x: -AUTO_SCROLL_STEP_PX,
      y: -AUTO_SCROLL_STEP_PX,
    })
  })

  it('容器の外まで出ても、向きは変わらない', () => {
    // 指が容器から出ることはある（掴んだままスクロールの外へ運ぶ）。
    // **出た瞬間に送りが止まると、画面外へ運べない**
    expect(autoScrollStep({ x: -50, y: 250 }, 容器).x).toBe(-AUTO_SCROLL_STEP_PX)
    expect(autoScrollStep({ x: 900, y: 250 }, 容器).x).toBe(AUTO_SCROLL_STEP_PX)
  })
})
