import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoamLayer } from '@/components/RoamLayer/RoamLayer'
import { ROAM_STOPS } from '@/lib/roam'
import { emitRoam, resetRoam } from '@/stores/roam'
import { useSettingsStore } from '@/stores/settings'

/**
 * 回遊の層（`components/RoamLayer`）。
 *
 * **ここが見るのは「並べ方」だけ。** 飛ぶかどうかは在庫（`stores/roam.ts`）が、
 * 止まるかどうかは CSS（`web/src/roam.test.ts`）が、それぞれ別に見ている。
 */

const 種 = {
  rect: { left: 300, top: 400, width: 294 },
  accent: '#f5a623',
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

  it('線には経路と色が載る', () => {
    // **層は DOM を1度も読まない。** 値は在庫から来る
    emitRoam({ ...種, accent: '#123456' })
    render(<RoamLayer />)
    const 線 = screen.getAllByTestId('roam-line')[0]
    expect(線.getAttribute('style')).toContain('--roam-accent: #123456')
    for (let i = 0; i < ROAM_STOPS; i += 1) {
      expect(線.getAttribute('style')).toContain(`--roam-x${i}:`)
      expect(線.getAttribute('style')).toContain(`--roam-y${i}:`)
      expect(線.getAttribute('style')).toContain(`--roam-r${i}:`)
    }
  })

  it('飛ぶ時間は層が渡す', () => {
    // **秒数の出どころを1つにする。** CSS 側へ書くと、寿命のタイマと見た目の長さが
    // 別々に育って食い違う（線が消える前に見えなくなる／消えたあとも残る）
    emitRoam(種)
    render(<RoamLayer />)
    expect(screen.getAllByTestId('roam-line')[0].style.animationDuration).toContain(
      '15000ms',
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
