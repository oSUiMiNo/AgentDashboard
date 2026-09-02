import { fireEvent, render, screen } from '@testing-library/react'
import {
  HANDLE_HIT_COARSE_PX,
  HANDLE_HIT_PX,
  ReorderHandle,
} from './ReorderHandle'
import type { Point } from '@/lib/reorder'

/**
 * 掴み手の握り方（テスト計画フェーズ4「掴む」）。
 *
 * **`FilesResizer.test.tsx` の6つの `describe` をそのまま写している。** あちらで実機を
 * 踏んで決まった作法なので、書き直さない。
 *
 * # `user-event` は使わない
 *
 * `fireEvent.pointerDown` / `pointerMove` / `pointerUp` に座標を渡す形で書く。
 * `vi.useFakeTimers()` の下では `user-event` の全 API が固まる（`Dpad.test.tsx` の前例）。
 *
 * # ここで確かめないもの
 *
 * **実際に落とし先が決まること。** jsdom は要素の幅を常に 800・左端を常に 0 で返すので
 * （`test/setup.ts`）、位置から添字を出す経路は縮退した同じ数字しか通らない。
 * 決める側は `lib/reorder.test.ts` が矩形を字で書いて確かめている。
 */

function 置く() {
  const moves: Point[] = []
  const 記録: string[] = []
  render(
    <ReorderHandle
      label="テストの掴み手"
      kind="card"
      onGrab={() => 記録.push('grab')}
      onMove={(point) => moves.push(point)}
      onDrop={() => 記録.push('drop')}
    />,
  )
  return { 掴み手: screen.getByTestId('reorder-handle'), moves, 記録 }
}

describe('掴み手の見た目と印', () => {
  it('何の並びかが `data-kind` に出る', () => {
    const { 掴み手 } = 置く()
    expect(掴み手).toHaveAttribute('data-kind', 'card')
    expect(掴み手).toHaveAttribute('aria-label', 'テストの掴み手')
  })

  it('掴める範囲は、見た目の印より広い', () => {
    // 印は 10×16 の SVG。当たり判定はそれより広く取る
    const { 掴み手 } = 置く()
    expect(掴み手.style.minWidth).toBe(`${HANDLE_HIT_PX}px`)
    expect(掴み手.style.minHeight).toBe(`${HANDLE_HIT_PX}px`)
    expect(HANDLE_HIT_PX).toBe(8)
  })

  it('指で触る端末では、当たり判定をさらに広く取る', () => {
    // **数を字で書く。** 定数から期待値を組み立てると、一緒に動いて通ってしまう
    expect(HANDLE_HIT_COARSE_PX).toBe(44)
    expect(HANDLE_HIT_COARSE_PX).toBeGreaterThan(HANDLE_HIT_PX)
  })
})

describe('触り方の指定', () => {
  it('`touch-action: none` が素のスタイルで付いている', () => {
    // クラス名にしない。**綴りを間違えても黙って効かなくなる**指定なので、
    // 単体テストから実値を読めるようにしておく
    const { 掴み手 } = 置く()
    expect(掴み手.style.touchAction).toBe('none')
  })
})

describe('掴む', () => {
  it('1回目の `pointermove` で握る', () => {
    // `preventDefault()` が効くのは `cancelable` が真のあいだだけ。**戻り値 `false`**
    // が「既定の動きを止めた」＝握ったことの印
    const { 掴み手 } = 置く()
    fireEvent.pointerDown(掴み手, { pointerId: 1, clientX: 0, clientY: 0 })
    const 握った = fireEvent.pointerMove(掴み手, {
      pointerId: 1,
      clientX: 1,
      clientY: 1,
      cancelable: true,
    })
    expect(握った).toBe(false)
  })

  it('掴んだ時点で、DOM を動かす合図が先に出る', () => {
    // **キャプチャは DOM を動かした後**（方針§4-2）。順序が逆だと、動かした拍子に
    // 要素を見失う。ここでは `onGrab` が `setPointerCapture` より先に呼ばれること
    const 順序: string[] = []
    render(
      <ReorderHandle
        label="順序の掴み手"
        kind="project"
        onGrab={() => 順序.push('grab')}
        onMove={() => {}}
        onDrop={() => {}}
      />,
    )
    const 掴み手 = screen.getByTestId('reorder-handle')
    // jsdom では読み取り専用なので、差し替えは `defineProperty` で
    Object.defineProperty(掴み手, 'setPointerCapture', {
      configurable: true,
      value: () => 順序.push('capture'),
    })
    fireEvent.pointerDown(掴み手, { pointerId: 1, clientX: 0, clientY: 0 })
    expect(順序).toEqual(['grab', 'capture'])
  })

  it('しきい値に届かないうちは、運ばない', () => {
    const { 掴み手, moves } = 置く()
    fireEvent.pointerDown(掴み手, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(掴み手, { pointerId: 1, clientX: 101, clientY: 101 })
    expect(moves).toEqual([])
  })

  it('しきい値を超えたら、座標がそのまま渡る', () => {
    const { 掴み手, moves } = 置く()
    fireEvent.pointerDown(掴み手, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(掴み手, { pointerId: 1, clientX: 110, clientY: 120 })
    expect(moves).toEqual([{ x: 110, y: 120 }])
  })

  it('一度動き出したら、しきい値の内側へ戻っても動き続ける', () => {
    const { 掴み手, moves } = 置く()
    fireEvent.pointerDown(掴み手, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(掴み手, { pointerId: 1, clientX: 110, clientY: 100 })
    fireEvent.pointerMove(掴み手, { pointerId: 1, clientX: 100, clientY: 100 })
    expect(moves).toHaveLength(2)
  })

  it('掴んでいない指の動きは拾わない', () => {
    const { 掴み手, moves } = 置く()
    fireEvent.pointerMove(掴み手, { pointerId: 1, clientX: 200, clientY: 200 })
    expect(moves).toEqual([])
  })

  it('二本目の指では乗っ取られない', () => {
    const { 掴み手, moves } = 置く()
    fireEvent.pointerDown(掴み手, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerDown(掴み手, { pointerId: 2, clientX: 500, clientY: 500 })
    fireEvent.pointerMove(掴み手, { pointerId: 2, clientX: 600, clientY: 600 })
    expect(moves).toEqual([])
  })

  it('`setPointerCapture` が無い環境でも落ちない', () => {
    // jsdom には無い。`?.()` で呼んでいることの担保
    const { 掴み手, 記録 } = 置く()
    expect(() =>
      fireEvent.pointerDown(掴み手, { pointerId: 1, clientX: 0, clientY: 0 }),
    ).not.toThrow()
    expect(記録).toEqual(['grab'])
  })
})

describe('止める契機は3つ', () => {
  function 掴んだ状態() {
    const 台 = 置く()
    fireEvent.pointerDown(台.掴み手, { pointerId: 1, clientX: 0, clientY: 0 })
    return 台
  }

  it('`pointerup` で止まる', () => {
    const { 掴み手, 記録 } = 掴んだ状態()
    fireEvent.pointerUp(掴み手, { pointerId: 1 })
    expect(記録).toEqual(['grab', 'drop'])
  })

  it('`pointercancel` で止まる', () => {
    const { 掴み手, 記録 } = 掴んだ状態()
    fireEvent.pointerCancel(掴み手, { pointerId: 1 })
    expect(記録).toEqual(['grab', 'drop'])
  })

  it('`lostpointercapture` で止まる', () => {
    const { 掴み手, 記録 } = 掴んだ状態()
    fireEvent.lostPointerCapture(掴み手, { pointerId: 1 })
    expect(記録).toEqual(['grab', 'drop'])
  })

  it('**`pointerleave` では止まらない**', () => {
    // タッチは `pointerdown` で暗黙のキャプチャが効いていて発火しない。
    // **止まることと同じだけ、止まらないことを確かめる**
    const { 掴み手, 記録 } = 掴んだ状態()
    fireEvent.pointerLeave(掴み手, { pointerId: 1 })
    expect(記録).toEqual(['grab'])
  })

  it('離したことが1回だけ伝わる', () => {
    // `pointerup` のあとブラウザがキャプチャを自動で解くので、
    // `lostpointercapture` が続けて飛ぶ
    const { 掴み手, 記録 } = 掴んだ状態()
    fireEvent.pointerUp(掴み手, { pointerId: 1 })
    fireEvent.lostPointerCapture(掴み手, { pointerId: 1 })
    expect(記録).toEqual(['grab', 'drop'])
  })
})

describe('掴んでいることの見せ方', () => {
  it('掴んでいる間だけ `data-dragging` が立つ', () => {
    const { 掴み手 } = 置く()
    expect(掴み手).toHaveAttribute('data-dragging', 'false')
    fireEvent.pointerDown(掴み手, { pointerId: 1, clientX: 0, clientY: 0 })
    expect(掴み手).toHaveAttribute('data-dragging', 'true')
    fireEvent.pointerUp(掴み手, { pointerId: 1 })
    expect(掴み手).toHaveAttribute('data-dragging', 'false')
  })

  it('掴んでいる間だけ、周りの文字が選べなくなる', () => {
    // 掴み手ではなく `body` に当てる（選択が始まるのは掴み手の外）。
    // **元の値を控えて戻す**ので、他が当てていても壊さない
    document.body.style.userSelect = 'auto'
    const { 掴み手 } = 置く()
    fireEvent.pointerDown(掴み手, { pointerId: 1, clientX: 0, clientY: 0 })
    expect(document.body.style.userSelect).toBe('none')
    fireEvent.pointerUp(掴み手, { pointerId: 1 })
    expect(document.body.style.userSelect).toBe('auto')
  })
})

describe('落とし先をホバーで検出していない', () => {
  it('ポインタが乗り降りしても、運びの合図は出ない', () => {
    // キャプチャ中は `pointerover` / `pointerleave` が飛ばないので、
    // **ホバーに頼った実装は動かない**。座標だけで決めていることの担保
    const { 掴み手, moves } = 置く()
    fireEvent.pointerDown(掴み手, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerOver(掴み手, { pointerId: 1, clientX: 300, clientY: 300 })
    fireEvent.pointerEnter(掴み手, { pointerId: 1, clientX: 300, clientY: 300 })
    expect(moves).toEqual([])
  })
})
