import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { PowerButton } from '@/components/ui/power-button'

/**
 * 電源ボタンを外から使えること（細かい修正 設計§2-1）。
 *
 * **`SessionView` の中に閉じていたので、カードでは同じ見た目を描き直すしか無かった。**
 * グラデーションと多重シャドウを持つ部品なので、写すと片方だけ直したときに気づけない。
 */
function 置く(over: Partial<Parameters<typeof PowerButton>[0]> = {}) {
  const onPress = vi.fn()
  render(
    <PowerButton on={false} state="ready" busy={false} why={null} onPress={onPress} {...over} />,
  )
  return onPress
}

describe('電源ボタン', () => {
  it('目印の既定は power-card（E2E が読んでいるので動かさない）', () => {
    置く()
    expect(screen.getByTestId('power-card')).toBeInTheDocument()
  })

  it('目印は呼ぶ側から変えられる（カードは別の目印を渡す）', () => {
    置く({ testId: 'power-tile' })
    expect(screen.getByTestId('power-tile')).toBeInTheDocument()
    expect(screen.queryByTestId('power-card')).toBeNull()
  })

  it('見た目は controls.css の .power から来る（クラスを写していない）', () => {
    置く()
    expect(screen.getByTestId('power-card').className).toBe('power')
  })

  it('点いていれば「スリープ」、消えていれば「復旧」', () => {
    置く({ on: true })
    const b = screen.getByTestId('power-card')
    expect(b).toHaveAttribute('aria-label', 'スリープ')
    expect(b).toHaveAttribute('data-power', 'on')
    expect(b).toHaveAttribute('data-action', 'sleep')
  })

  it('連打よけは押下だけを捨てる。見た目は動かさない', async () => {
    // **`disabled` にすると、点灯していた輪が 500ms だけ灰色へ落ちて壊れて見える**
    const user = userEvent.setup()
    const onPress = 置く({ on: true })
    const b = screen.getByTestId('power-card')
    await user.click(b)
    await user.click(b)
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(b).not.toBeDisabled()
  })

  it('起こせないときは押せず、理由が目印に出る', () => {
    置く({ state: 'no-target', why: '元のセッションが見つかりません' })
    const b = screen.getByTestId('power-card')
    expect(b).toBeDisabled()
    expect(b).toHaveAttribute('data-state', 'no-target')
    expect(b).toHaveAttribute('title', '元のセッションが見つかりません')
  })

  it('起こしている最中は押せず、動きで分かる', () => {
    置く({ busy: true })
    const b = screen.getByTestId('power-card')
    expect(b).toBeDisabled()
    expect(b).toHaveAttribute('data-busy', 'true')
    expect(b).toHaveAttribute('title', '起こしています…')
  })
})
