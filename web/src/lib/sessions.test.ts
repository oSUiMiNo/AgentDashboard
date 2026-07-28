import { act, renderHook } from '@testing-library/react'
import { useNow } from './sessions'

/**
 * 経過時間の時計（テスト計画フェーズ5「小窓」の土台）。
 *
 * 守るべき約束は2つ。**購読者が何人いてもタイマーは1本**であること
 * （小窓の数だけタイマーが増えない）と、**誰も見ていなければ止まる**こと。
 */

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('1秒ごとに現在時刻が進む', () => {
    // 経過時間の表示（「作業中・最終活動 3分前」）はこの時計で動く
    const { result } = renderHook(() => useNow())
    const first = result.current

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBeGreaterThanOrEqual(first + 1000)

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(result.current).toBeGreaterThanOrEqual(first + 3000)
  })

  it('何人が購読してもタイマーは1本しか動かない', () => {
    // 小窓ごとにタイマーを持たせると、セッションが増えるほど更新の時刻が散らばる
    const first = renderHook(() => useNow())
    const second = renderHook(() => useNow())
    const third = renderHook(() => useNow())

    expect(vi.getTimerCount()).toBe(1)

    first.unmount()
    second.unmount()
    expect(vi.getTimerCount()).toBe(1)

    third.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('画面から外れたらタイマーを止める', () => {
    const { unmount } = renderHook(() => useNow())
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
