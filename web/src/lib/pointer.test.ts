import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCoarsePointer, useLandscape } from './pointer'

/**
 * 機械の触り方の判定（テスト計画フェーズ3「部品」）。
 *
 * # `matches` は getter にする
 *
 * プロパティで持たせると、`matchMedia()` を呼んだ瞬間の値で固まる。あとから切り替えても
 * 反映されず、**「途中で変わる」を確かめたつもりのテスト**になる（調査レポート §11-5）。
 *
 * # 購読を必ず畳む
 *
 * `pointer.ts` は最後の1人が離れたら問い合わせを捨てる。畳まないまま次のテストへ進むと、
 * **前のスタブを掴んだまま**になる。各テストで `unmount` している。
 */

const COARSE = '(pointer: coarse) and (hover: none)'
const LANDSCAPE = '(orientation: landscape)'

function stubMedia(initial: Record<string, boolean>) {
  const state: Record<string, boolean> = { ...initial }
  const listeners = new Map<string, Set<() => void>>()

  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return state[query] ?? false
    },
    media: query,
    addEventListener: (_type: string, handler: () => void) => {
      const set = listeners.get(query) ?? new Set()
      set.add(handler)
      listeners.set(query, set)
    },
    removeEventListener: (_type: string, handler: () => void) => {
      listeners.get(query)?.delete(handler)
    },
  }))

  return {
    set(query: string, value: boolean) {
      state[query] = value
      for (const handler of listeners.get(query) ?? []) {
        handler()
      }
    },
    /** まだ誰かが購読しているか。片付けの確認に使う */
    watching(query: string) {
      return (listeners.get(query)?.size ?? 0) > 0
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useCoarsePointer', () => {
  it('粗いポインタで、かつ重ねられないときだけ真', () => {
    stubMedia({ [COARSE]: true })
    const view = renderHook(() => useCoarsePointer())
    expect(view.result.current).toBe(true)
    view.unmount()
  })

  it('条件を満たさなければ偽', () => {
    // マウス付きタブレット（粗いポインタだが重ねられる）はここで弾かれる
    stubMedia({ [COARSE]: false })
    const view = renderHook(() => useCoarsePointer())
    expect(view.result.current).toBe(false)
    view.unmount()
  })

  it('途中で切り替わる', () => {
    const media = stubMedia({ [COARSE]: false })
    const view = renderHook(() => useCoarsePointer())
    expect(view.result.current).toBe(false)

    // Bluetooth キーボードを繋いだ／外した、など
    act(() => media.set(COARSE, true))
    expect(view.result.current).toBe(true)

    act(() => media.set(COARSE, false))
    expect(view.result.current).toBe(false)
    view.unmount()
  })

  it('最後の1人が離れたら購読を畳む', () => {
    const media = stubMedia({ [COARSE]: true })
    const first = renderHook(() => useCoarsePointer())
    const second = renderHook(() => useCoarsePointer())
    expect(media.watching(COARSE)).toBe(true)

    first.unmount()
    expect(media.watching(COARSE)).toBe(true)

    second.unmount()
    expect(media.watching(COARSE)).toBe(false)
  })

  it('addEventListener を持たない実装でも落ちず、値は正しいまま', () => {
    // 古い Safari（`addListener` だけ）・一部の WebView・部分的なテストスタブ。
    // **購読の中で例外が飛ぶと、飛ぶ先は `useSyncExternalStore` なのでセッション画面ごと落ちる**
    const handlers = new Set<() => void>()
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === COARSE,
      media: query,
      addListener: (handler: () => void) => handlers.add(handler),
      removeListener: (handler: () => void) => handlers.delete(handler),
    }))

    const view = renderHook(() => useCoarsePointer())

    // **偽へ倒さない。** 倒すと、古い Safari から十字が丸ごと消える
    expect(view.result.current).toBe(true)
    // 古い口があるなら、そちらで追随もできている
    expect(handlers.size).toBe(1)
    view.unmount()
    expect(handlers.size).toBe(0)
  })

  it('どちらの口も無ければ、追随しないだけで値は読める', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === COARSE,
      media: query,
    }))

    const view = renderHook(() => useCoarsePointer())

    expect(view.result.current).toBe(true)
    view.unmount()
  })

  it('matchMedia が無い環境では偽になり、落ちない', () => {
    vi.stubGlobal('matchMedia', undefined)
    const view = renderHook(() => useCoarsePointer())
    expect(view.result.current).toBe(false)
    view.unmount()
  })
})

describe('useLandscape', () => {
  it('同じ形で動く', () => {
    const media = stubMedia({ [LANDSCAPE]: false })
    const view = renderHook(() => useLandscape())
    expect(view.result.current).toBe(false)

    act(() => media.set(LANDSCAPE, true))
    expect(view.result.current).toBe(true)
    view.unmount()
  })

  it('入力方式とは別に持つ', () => {
    const media = stubMedia({ [COARSE]: true, [LANDSCAPE]: false })
    const pointer = renderHook(() => useCoarsePointer())
    const orientation = renderHook(() => useLandscape())

    act(() => media.set(LANDSCAPE, true))
    expect(orientation.result.current).toBe(true)
    // 向きが変わっても入力方式は変わらない
    expect(pointer.result.current).toBe(true)

    pointer.unmount()
    orientation.unmount()
  })
})
