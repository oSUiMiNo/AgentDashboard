import { act, renderHook } from '@testing-library/react'
import {
  clearReorderingStore,
  isReordering,
  lowerReordering,
  raiseReordering,
  subscribeReordering,
  useReordering,
} from './reordering'

/**
 * 並べ替え中の印（並べ替え設計§15-1）。
 *
 * **主ごとに持つこと**と**0と1を跨ぐときだけ通知すること**が、このストアの契約の全部。
 * 効果線の門そのものは `RoamLayer.test.tsx` と `roam.test.ts` が見る。
 */

beforeEach(() => {
  clearReorderingStore()
})

describe('印は主ごとに持つ', () => {
  it('立てた主が1つでも居れば立っている', () => {
    const 枠 = {}
    expect(isReordering()).toBe(false)
    raiseReordering(枠)
    expect(isReordering()).toBe(true)
  })

  it('同じ主が二度立てても、一度降ろせば降りる', () => {
    // 離した直後に掴み直すと、降ろす前にもう一度立てる。**数える形だとここで狂う**
    const 枠 = {}
    raiseReordering(枠)
    raiseReordering(枠)
    lowerReordering(枠)
    expect(isReordering()).toBe(false)
  })

  it('別の主が降ろしても、立てている主が残れば降りない', () => {
    // 枠のカードの並びと枠の並びは別のインスタンス。**片方が降ろしても、掴んでいる側は残る**
    const 枠 = {}
    const カード = {}
    raiseReordering(枠)
    raiseReordering(カード)
    lowerReordering(枠)
    expect(isReordering()).toBe(true)
    lowerReordering(カード)
    expect(isReordering()).toBe(false)
  })

  it('知らない主が降ろしても、何も起きない', () => {
    const 枠 = {}
    let 呼ばれた = 0
    subscribeReordering(() => {
      呼ばれた += 1
    })
    lowerReordering(枠)
    expect(isReordering()).toBe(false)
    expect(呼ばれた).toBe(0)
  })
})

describe('購読', () => {
  it('0と1を跨ぐときだけ通知する', () => {
    const 枠 = {}
    const カード = {}
    let 呼ばれた = 0
    subscribeReordering(() => {
      呼ばれた += 1
    })
    raiseReordering(枠)
    expect(呼ばれた).toBe(1)
    // 2つ目が立っても「並べ替え中」は変わらない
    raiseReordering(カード)
    expect(呼ばれた).toBe(1)
    lowerReordering(カード)
    expect(呼ばれた).toBe(1)
    lowerReordering(枠)
    expect(呼ばれた).toBe(2)
  })

  it('解除したあとは呼ばれない', () => {
    let 呼ばれた = 0
    const 解除 = subscribeReordering(() => {
      呼ばれた += 1
    })
    解除()
    raiseReordering({})
    expect(呼ばれた).toBe(0)
  })

  it('フックは立ち下がりを描画に映す', () => {
    const 枠 = {}
    const { result } = renderHook(() => useReordering())
    expect(result.current).toBe(false)
    act(() => raiseReordering(枠))
    expect(result.current).toBe(true)
    act(() => lowerReordering(枠))
    expect(result.current).toBe(false)
  })
})
