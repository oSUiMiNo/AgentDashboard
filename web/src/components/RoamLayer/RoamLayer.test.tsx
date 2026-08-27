import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoamLayer } from '@/components/RoamLayer/RoamLayer'
import { ROAM_STOPS } from '@/lib/roam'
import {
  ROAM_BIRTH_MS,
  ROAM_LIFE_MS,
  emitRoam,
  resetRoam,
} from '@/stores/roam'
import { useSettingsStore } from '@/stores/settings'

/**
 * 回遊の層（`components/RoamLayer`）。
 *
 * **ここが見るのは「並べ方」だけ。** 飛ぶかどうかは在庫（`stores/roam.ts`）が、
 * 止まるかどうかは CSS（`web/src/roam.test.ts`）が、それぞれ別に見ている。
 */

const 種 = {
  // 跳ねた瞬間に測った場の様子。**手で組み立てる**（jsdom の矩形は全部 0）
  field: {
    width: 1200,
    height: 900,
    card: { x: 12, y: 60, w: 288, h: 120 },
    rects: [
      { x: 0, y: 40, w: 900, h: 300 },
      { x: 12, y: 60, w: 288, h: 120 },
      { x: 312, y: 60, w: 288, h: 120 },
    ],
  },
  accent: '#f5a623',
  ink: '75%',
  quiet: 'lively' as const,
}

function 静けさ(値: 'lively' | 'calm' | 'still'): void {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, motion_quiet: 値 },
  }))
}

beforeEach(() => {
  resetRoam()
  静けさ('lively')
})

afterEach(() => {
  resetRoam()
  静けさ('lively')
})

describe('回遊の層', () => {
  it('線が無ければ何も描かない', () => {
    render(<RoamLayer />)
    expect(screen.getByTestId('roam-layer').children).toHaveLength(0)
  })

  it('読み上げの対象にしない', () => {
    // 状態は色・記号・文字が持っている。線は**飾り**なので読み上げさせない
    render(<RoamLayer />)
    expect(screen.getByTestId('roam-layer')).toHaveAttribute('aria-hidden', 'true')
  })

  it('在庫の線を1本ずつ並べる', () => {
    emitRoam(種)
    render(<RoamLayer />)
    const 本数 = screen.getAllByTestId('roam-line').length
    expect(本数).toBeGreaterThanOrEqual(2)
    expect(screen.getByTestId('roam-layer').children).toHaveLength(本数)
  })

  it('線には経路と色と濃さが載る', () => {
    // **層は DOM を1度も読まない。** 値は在庫から来る
    emitRoam({ ...種, accent: '#123456', ink: '42%' })
    render(<RoamLayer />)
    const 線 = screen.getAllByTestId('roam-line')[0]
    expect(線.getAttribute('style')).toContain('--roam-accent: #123456')
    // **濃さもカードから配られる**（カード設計§9-7）。固定値で塗ると、同じ状態
    // なのに輪と線で色が食い違う
    expect(線.getAttribute('style')).toContain('--roam-ink: 42%')
    for (let i = 0; i < ROAM_STOPS; i += 1) {
      expect(線.getAttribute('style')).toContain(`--roam-x${i}:`)
      expect(線.getAttribute('style')).toContain(`--roam-y${i}:`)
      expect(線.getAttribute('style')).toContain(`--roam-r${i}:`)
    }
    // **③の転回の変数は消えた。** 経路そのものが回るので要らない（設計§9-7-7 B）
    expect(線.getAttribute('style')).not.toContain('--roam-turn:')
  })

  it('線の中に紙片が1枚だけ入る', () => {
    /*
      **外側と内側で役割を分けてある**（設計§9-7-2）。外は「道と向き」、内は
      「紙のたわみ」で、1つの要素に載せると進行方向を向く回転と尺取り虫が
      同じ `transform-origin` を取り合う。

      形は種から選ぶ——**同じ棒が3本並ぶと手書きに見えない**
    */
    emitRoam(種)
    render(<RoamLayer />)
    const 線 = screen.getAllByTestId('roam-line')
    const 紙 = screen.getAllByTestId('roam-paper')
    expect(紙).toHaveLength(線.length)
    for (const [i, 一枚] of 紙.entries()) {
      expect(一枚.parentElement).toBe(線[i])
      expect(一枚).toHaveAttribute('data-shape')
      // **内側にも秒数を渡す。** 出どころを1つに保つ約束は内側にも掛かる。
      // 内は寿命ではなく**尺取り虫の長さ**（設計§9-7-9）。ひらひらをやめたので
      // 1本だけになった（2026-08-28）——**2本のまま残すと、残ったほうが繰り上がって
      // 別の秒数を食う**
      expect((一枚 as HTMLElement).style.animationDuration).toBe(`${ROAM_BIRTH_MS}ms`)
    }
  })

  it('飛ぶ時間は層が渡す', () => {
    // **秒数の出どころを1つにする。** CSS 側へ書くと、寿命のタイマと見た目の長さが
    // 別々に育って食い違う（線が消える前に見えなくなる／消えたあとも残る）
    emitRoam(種)
    render(<RoamLayer />)
    expect(screen.getAllByTestId('roam-line')[0].style.animationDuration).toBe(
      `${ROAM_LIFE_MS}ms, ${ROAM_LIFE_MS}ms`,
    )
  })
})

describe('静けさの印', () => {
  it('賑やかのときは属性を出さない', () => {
    // カードの器と同じ作法（設計§9-5-3）。出さないことが「何も止めない」を表す
    静けさ('lively')
    render(<RoamLayer />)
    expect(screen.getByTestId('roam-layer')).not.toHaveAttribute('data-quiet')
  })

  it('控えめ・静止のときは段を印として出す', () => {
    // **止める分岐は CSS 側に置く。** ここで線を消すと、CSS の打ち消しが空振りしても
    // 気づけなくなる（二枚重ねの意味が消える）
    for (const 段 of ['calm', 'still'] as const) {
      静けさ(段)
      const { unmount } = render(<RoamLayer />)
      expect(screen.getByTestId('roam-layer')).toHaveAttribute('data-quiet', 段)
      unmount()
    }
  })
})
