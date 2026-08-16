import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalKey } from './keys'
import {
  hasWatcher,
  HIDE_SETTLE_MS,
  measure,
  registerProbe,
  KEY_GAP_MS,
  registerTerminal,
  sendTerminalKey,
  setSelecting,
  useSelecting,
  selectingRows,
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

  it('出すのは即座に伝わる', () => {
    const id = card()
    const { result } = renderHook(() => useSelecting(id))
    expect(result.current).toBe(false)
    act(() => setSelecting(id, true))
    expect(result.current).toBe(true)
  })

  /**
   * **消すのを待つのは、実機で輪を踏んだから**（実行レポート フェーズ6 追記）。
   *
   * 十字が出ると端末が縮み、リサイズが PTY まで飛んで TUI が描き直す。その最中の画面は
   * 選択待ちに見えないので消える。消えると端末が伸びて描き直され、また出る——
   * **出す条件が、出したことで変わる輪**である。
   *
   * 時間は偽の時計で進める。**境目は `n-1` で動かない／`n` で動く**を別々に見る——
   * 一気に跨ぐと「待ちが在ること」を確かめたことにならない。
   */
  it('消すのは、落ち着くまで待ってから', () => {
    vi.useFakeTimers()
    try {
      const id = card()
      const { result } = renderHook(() => useSelecting(id))
      act(() => setSelecting(id, true))
      expect(result.current).toBe(true)

      act(() => setSelecting(id, false))
      // **まだ消えない。** ここで消えると、描き直しのたびに明滅する
      expect(result.current, '待っている間は出たまま').toBe(true)

      act(() => {
        vi.advanceTimersByTime(HIDE_SETTLE_MS - 1)
      })
      expect(result.current, '境目の手前ではまだ出たまま').toBe(true)

      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(result.current, '落ち着いたら消える').toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('待っている間に選択待ちへ戻れば、消さずに済ませる', () => {
    vi.useFakeTimers()
    try {
      const id = card()
      const { result } = renderHook(() => useSelecting(id))
      act(() => setSelecting(id, true))
      act(() => setSelecting(id, false))
      act(() => {
        vi.advanceTimersByTime(HIDE_SETTLE_MS - 50)
      })
      // 描き直しが終わってメニューが戻ってきた
      act(() => setSelecting(id, true))
      act(() => {
        vi.advanceTimersByTime(HIDE_SETTLE_MS * 2)
      })
      // **取り消しが取り消されていること。** ここが効かないと、戻ってきたあとに消える
      expect(result.current, '戻ってきたら出たまま').toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('偽が続いても、待ち直さずに消える', () => {
    vi.useFakeTimers()
    try {
      const id = card()
      const { result } = renderHook(() => useSelecting(id))
      act(() => setSelecting(id, true))
      // 描き直しのあいだ、判定は**何度も**偽を返す。**待ち直すと期限が動き続ける**ので、
      // 待ちより長く偽を送り続けたところで見る——待ち直す実装ではここで消えていない
      const 回 = Math.ceil((HIDE_SETTLE_MS * 2) / 10)
      for (let i = 0; i < 回; i += 1) {
        act(() => setSelecting(id, false))
        act(() => {
          vi.advanceTimersByTime(10)
        })
      }
      expect(result.current, '最初の偽から数えて消える').toBe(false)
    } finally {
      vi.useRealTimers()
    }
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

  it('解除したら、表に行そのものが残らない', () => {
    // **答えからは観測できない漏れ。** `useSelecting` は `?? false` で既定へ落ちるので、
    // `false` を書き込んで残しても答えは変わらない——他の3つの表（`watchers` /
    // `terminals` / `queues`）が消えるのに**ここだけ増え続ける**（コードレビュー対応10）
    const before = selectingRows()
    const id = card()
    const release = registerTerminal(id, () => {})

    act(() => setSelecting(id, true))
    expect(selectingRows()).toBe(before + 1)

    act(() => release())

    expect(selectingRows()).toBe(before)
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

/**
 * **見ている人が現れた瞬間に測る**（実機で2度踏んだ穴）。
 *
 * 判定はフレームが届いたときにしか走らないが、**選択待ちの画面は静止している**。
 * タブを開き直すと「メニューは出ているのに一度も判定されない」が起きる。
 */
describe('測る契機', () => {
  it('最初の1人が見に来たら、その場で測る', () => {
    const id = card()
    const release = registerProbe(id, () => true)
    const { result } = renderHook(() => useSelecting(id))
    // 測っていなければ、フレームが来るまで偽のまま
    expect(result.current, '購読した瞬間に測ること').toBe(true)
    release()
  })

  it('2人目では測り直さない', () => {
    const id = card()
    let 回数 = 0
    const release = registerProbe(id, () => {
      回数 += 1
      return true
    })
    renderHook(() => useSelecting(id))
    renderHook(() => useSelecting(id))
    expect(回数, '測るのは最初の1人のときだけ').toBe(1)
    release()
  })

  it('測る手が無ければ何も起きない', () => {
    const id = card()
    const { result } = renderHook(() => useSelecting(id))
    expect(result.current).toBe(false)
    expect(() => measure(id)).not.toThrow()
  })

  it('解除したら測らなくなる', () => {
    const id = card()
    let 回数 = 0
    const release = registerProbe(id, () => {
      回数 += 1
      return true
    })
    release()
    renderHook(() => useSelecting(id))
    expect(回数).toBe(0)
  })
})
