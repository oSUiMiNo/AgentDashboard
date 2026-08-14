import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalKey } from './keys'
import {
  hasWatcher,
  KEY_GAP_MS,
  registerTerminal,
  sendTerminalKey,
  setSelecting,
  useSelecting,
} from './terminalBridge'

/**
 * 端末と画面をつなぐ橋（テスト計画フェーズ3「部品」）。
 *
 * # カードIDはテストごとに変える
 *
 * 橋はモジュールに状態を持つ（`stores/sessions.ts` と同じ形）。同じIDを使い回すと、
 * 前のテストが残した値を見て通ってしまう。
 */

let seq = 0
const card = () => `card-${(seq += 1)}`

describe('上り（いま選択待ちか）', () => {
  /**
   * **「同じ値では通知しない」は、ここでは確かめていない。**
   *
   * 壊し方（同値の門を外す）を当てても**1本も落ちなかった**。`useSyncExternalStore` は
   * 通知を受けても `getSnapshot` の値が同じなら再描画しないので、**門が在っても無くても
   * 画面からは同じに見える**ためである。
   *
   * 門が省いているのは再描画ではなく、**フレームごとに listener を全部呼ぶ仕事**のほう
   * （`onWriteParsed` は毎フレーム呼ばれる）。それを外から観測するには、モジュールの中へ
   * 数える口を1つ足すことになる——**製品コードへ検証用の口を増やす判断**なので、ここでは
   * 足さずに「確かめていない」と書き残す（PJTガイドライン）。
   *
   * 下のテストは、**値の意味**（同じ値を何度渡しても結果が動かない）だけを固定する。
   */
  it('同じ値を何度渡しても結果は動かない', () => {
    const id = card()
    const { result } = renderHook(() => useSelecting(id))
    act(() => setSelecting(id, true))
    expect(result.current).toBe(true)
    act(() => setSelecting(id, true))
    expect(result.current).toBe(true)
  })

  it('値が変われば伝わる', () => {
    const id = card()
    const { result } = renderHook(() => useSelecting(id))
    expect(result.current).toBe(false)
    act(() => setSelecting(id, true))
    expect(result.current).toBe(true)
    act(() => setSelecting(id, false))
    expect(result.current).toBe(false)
  })

  it('見ている人が0なら hasWatcher は偽', () => {
    const id = card()
    expect(hasWatcher(id)).toBe(false)
    const view = renderHook(() => useSelecting(id))
    expect(hasWatcher(id)).toBe(true)
    view.unmount()
    expect(hasWatcher(id)).toBe(false)
  })

  it('enabled が偽なら購読せず、常に偽を返す', () => {
    const id = card()
    const { result } = renderHook(() => useSelecting(id, false))
    // PC ではここが0のまま。端末は画面を組み立てない
    expect(hasWatcher(id)).toBe(false)
    act(() => setSelecting(id, true))
    expect(result.current).toBe(false)
  })

  it('通知はカード単位で、隣を巻き込まない', () => {
    const a = card()
    const b = card()
    let rendersB = 0
    renderHook(() => useSelecting(a))
    renderHook(() => {
      rendersB += 1
      return useSelecting(b)
    })
    expect(rendersB).toBe(1)
    act(() => setSelecting(a, true))
    expect(rendersB).toBe(1)
  })
})

describe('下り（キーを送る）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function terminal(id: string) {
    const sent: TerminalKey[] = []
    const release = registerTerminal(id, (key) => sent.push(key))
    return { sent, release }
  }

  it('受け口が無ければ黙って捨てる', () => {
    const id = card()
    // 落ちないことが要件。閉じた直後に届いたぶんで壊さない
    expect(() => sendTerminalKey(id, 'up')).not.toThrow()
  })

  it('1発目は待たずに送る', () => {
    const id = card()
    const { sent, release } = terminal(id)
    sendTerminalKey(id, 'up')
    expect(sent).toEqual(['up'])
    release()
  })

  it('続けて頼むと、前回から間隔を空けて送る', () => {
    const id = card()
    const { sent, release } = terminal(id)
    sendTerminalKey(id, 'up')
    sendTerminalKey(id, 'down')
    expect(sent).toEqual(['up'])

    vi.advanceTimersByTime(KEY_GAP_MS - 1)
    expect(sent).toEqual(['up'])

    vi.advanceTimersByTime(1)
    expect(sent).toEqual(['up', 'down'])
    release()
  })

  it('間隔が空いていれば待たせない', () => {
    const id = card()
    const { sent, release } = terminal(id)
    sendTerminalKey(id, 'up')
    vi.advanceTimersByTime(KEY_GAP_MS)
    sendTerminalKey(id, 'down')
    // 常に遅らせる実装だと、ここが1件のままになる
    expect(sent).toEqual(['up', 'down'])
    release()
  })

  it('3つ続けても順序どおりに届く', () => {
    const id = card()
    const { sent, release } = terminal(id)
    sendTerminalKey(id, 'up')
    sendTerminalKey(id, 'down')
    sendTerminalKey(id, 'enter')
    vi.advanceTimersByTime(KEY_GAP_MS * 3)
    expect(sent).toEqual(['up', 'down', 'enter'])
    release()
  })
})

/**
 * 解除。**3つを別々のテストで見る**——1つ忘れても他が通ってしまうため。
 */
describe('解除', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('受け口が外れる', () => {
    const id = card()
    const sent: TerminalKey[] = []
    const release = registerTerminal(id, (key) => sent.push(key))
    release()
    sendTerminalKey(id, 'up')
    vi.advanceTimersByTime(1_000)
    expect(sent).toEqual([])
  })

  it('待っていたキーが、あとから届かない', () => {
    const id = card()
    const sent: TerminalKey[] = []
    const release = registerTerminal(id, (key) => sent.push(key))
    sendTerminalKey(id, 'up')
    sendTerminalKey(id, 'down')
    release()
    vi.advanceTimersByTime(1_000)
    // 消えた端末へ、待っていたキーが遅れて届く形を作らない
    expect(sent).toEqual(['up'])
  })

  /**
   * **列を捨てていることは、ここでしか確かめられない。**
   *
   * 上の2本は、受け口を消すか列を捨てるかの**どちらか片方が効いていれば通る**
   * （壊し方を当てて実際にそうなった）。開き直した相手を用意して初めて、
   * 「列を捨てる」だけが効く場面になる。
   */
  it('開き直した端末へ、前の依頼が届かない', () => {
    const id = card()
    const release = registerTerminal(id, () => {})
    sendTerminalKey(id, 'up')
    sendTerminalKey(id, 'down')
    release()

    const next: TerminalKey[] = []
    const releaseNext = registerTerminal(id, (key) => next.push(key))
    vi.advanceTimersByTime(1_000)
    // 列を捨てていないと、新しい端末が頼んでもいないキーを受け取る
    expect(next).toEqual([])
    releaseNext()
  })

  it('選択待ちの値が偽へ戻る', () => {
    const id = card()
    const release = registerTerminal(id, () => {})
    const { result } = renderHook(() => useSelecting(id))
    act(() => setSelecting(id, true))
    expect(result.current).toBe(true)
    act(() => release())
    // カードが消えたあとも「選択待ちだった」が残らない
    expect(result.current).toBe(false)
  })

  it('登録し直された相手は巻き添えにしない', () => {
    const id = card()
    const first: TerminalKey[] = []
    const second: TerminalKey[] = []
    const releaseFirst = registerTerminal(id, (key) => first.push(key))
    registerTerminal(id, (key) => second.push(key))
    releaseFirst()
    sendTerminalKey(id, 'up')
    expect(first).toEqual([])
    expect(second).toEqual(['up'])
  })
})
