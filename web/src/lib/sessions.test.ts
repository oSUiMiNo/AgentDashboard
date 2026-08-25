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

  it('タブが表へ戻ったら、時刻を合わせ直す', () => {
    // **裏に回したタブでは、この1秒タイマーが1分に1回まで落とされる**
    // （カード設計§10-2）。戻った瞬間に最大1分ぶん古い経過時間が出たままになるので、
    // 戻ったことを合図に数え直す
    const { result } = renderHook(() => useNow())
    const first = result.current

    // 裏に居る間は間引かれてタイマーが進まない、という状況を作る
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.setSystemTime(first + 45_000)
    expect(result.current).toBe(first)

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(result.current).toBe(first + 45_000)
  })

  it('裏に居る間は合わせ直さない', () => {
    // 隠れたままの通知で数え直しても誰も見ていない。**見えたときだけ**進める
    const { result } = renderHook(() => useNow())
    const first = result.current

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    vi.setSystemTime(first + 45_000)

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(result.current).toBe(first)
  })

  it('誰も見ていなくなったら、戻ったことも聞かなくなる', () => {
    // タイマーと同じで、**畳むときに外す**。外し忘れても画面の見た目は変わらないので
    // （購読者が0なら誰にも通知されない）、**後始末そのものを見るしかない**——
    // 残り続けると、開いては閉じるたびに聞き手が積み上がる
    const 足す = vi.spyOn(document, 'addEventListener')
    const 外す = vi.spyOn(document, 'removeEventListener')

    const { unmount } = renderHook(() => useNow())
    expect(足す).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    unmount()
    expect(外す).toHaveBeenCalledWith(
      'visibilitychange',
      足す.mock.calls.find(([type]) => type === 'visibilitychange')?.[1],
    )
  })
})
