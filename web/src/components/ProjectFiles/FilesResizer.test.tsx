import { fireEvent, render, screen } from '@testing-library/react'
import {
  FilesResizer,
  RESIZER_HIT_COARSE_PX,
  RESIZER_HIT_PX,
} from './FilesResizer'
import type { PanelEdge } from '@/lib/panelWidth'

/**
 * 幅を変える縁の握り方（テスト計画フェーズ3「縁を掴む」）。
 *
 * # `user-event` は使わない
 *
 * `fireEvent.pointerDown` / `pointerMove` / `pointerUp` に `clientX` を渡す形で書く。
 * `vi.useFakeTimers()` の下では `user-event` の全 API が固まる（`Dpad.test.tsx` の
 * 前例）。**なお `Dpad.test.tsx` は `pointerMove` も `clientX` も使っていない**ので、
 * 座標を渡す形の前例は `TerminalPane.test.tsx` の Touch 側にある。
 *
 * # ここで確かめないもの
 *
 * **実際に幅が当たること。** jsdom は要素の幅を常に 800、左端を常に 0 で返すので
 * （`test/setup.ts`）、位置から幅を出す経路は縮退した同じ数字しか通らない。
 * 当たることは E2E でしか言えない。
 */

/** 掴む・動かす・離す、を1本にまとめた見物台。 */
function 置く(edge: PanelEdge = 'folder', width = 320) {
  const moves: { edge: PanelEdge; width: number }[] = []
  const grabs: string[] = []
  render(
    <FilesResizer
      edge={edge}
      width={width}
      label="テストの縁"
      onGrab={() => grabs.push('grab')}
      onMove={(e, w) => moves.push({ edge: e, width: w })}
      onDrop={() => grabs.push('drop')}
    />,
  )
  return { 縁: screen.getByTestId('files-resizer'), moves, grabs }
}

/** 最後に届いた幅。届いていなければ `null`。 */
function 最後の幅(moves: { width: number }[]): number | null {
  return moves.length === 0 ? null : moves[moves.length - 1].width
}

beforeEach(() => {
  // 広い画面。**画面比の上限が絶対値に届かない側**にしておくと、範囲が素直に出る
  Object.defineProperty(globalThis, 'innerWidth', {
    configurable: true,
    value: 1920,
  })
})

describe('縁の見た目と印', () => {
  it('どちらの縁かが `data-edge` に出る', () => {
    const { 縁 } = 置く('file')
    expect(縁).toHaveAttribute('data-edge', 'file')
  })

  it('狭い画面には出さない（`md` から）', () => {
    // 両方とも全幅で被さるので、引っぱる縁が物理的に存在しない（設計§2）。
    // **`md` を JS から読まない**ので、出し分けはクラスに任せる
    const { 縁 } = 置く()
    expect(縁.className).toContain('hidden')
    expect(縁.className).toContain('md:block')
  })

  it('掴める範囲は、見た目の線より広い', () => {
    const { 縁 } = 置く()
    // 見た目は中の `span` の 1px。当たり判定は親のこの幅
    expect(縁.style.width).toBe(`${RESIZER_HIT_PX}px`)
    expect(RESIZER_HIT_PX).toBeGreaterThan(1)
    // 線を中心に左右へ均等に広げる
    expect(縁.style.right).toBe(`${-RESIZER_HIT_PX / 2}px`)
  })

  it('指で触る端末では、当たり判定をさらに広く取る', () => {
    // `DESIGN.md` §24.3（Mobile / Touch 48〜60px）が「指で押す的はマウスより
    // 大きく要る」と規定していることが根拠。実値は実機で決め直す（設計§11）
    expect(RESIZER_HIT_COARSE_PX).toBeGreaterThan(RESIZER_HIT_PX)
  })
})

describe('触り方の指定', () => {
  it('`touch-action: none` が素のスタイルで付いている', () => {
    // **クラス名ではなく素のスタイルで書く**——綴りを間違えても黙って効かなくなる
    // 指定なので、ここから実値を読めるようにしておく（`Dpad.tsx` と同じ判断）。
    // 指定しないと、1回目に握っても3回目から落ちる
    const { 縁 } = 置く()
    expect(縁.style.touchAction).toBe('none')
  })
})

describe('掴む', () => {
  it('1回目の `pointermove` で握る', () => {
    // `preventDefault()` が効くのは `cancelable` が真のあいだだけで、1回目で握らないと
    // 2回目から偽になる。**「しきい値を超えてから握る」は成立しない**（設計§4）
    const { 縁 } = 置く()
    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })

    // しきい値（3px）に届かない動き。**幅は動かさないが、握ってはいる**
    const 握った = fireEvent.pointerMove(縁, { pointerId: 1, clientX: 321 })
    expect(握った).toBe(false)
  })

  it('しきい値に届かないうちは、幅を動かさない', () => {
    const { 縁, moves } = 置く()
    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })
    fireEvent.pointerMove(縁, { pointerId: 1, clientX: 322 })

    // 握るかどうかとしきい値は**役割が違う**（設計§4）
    expect(moves).toEqual([])
  })

  it('しきい値を超えたら、移動量ぶん幅が変わる', () => {
    const { 縁, moves } = 置く('folder', 320)
    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })
    fireEvent.pointerMove(縁, { pointerId: 1, clientX: 360 })

    expect(最後の幅(moves)).toBe(360)
    expect(moves[0].edge).toBe('folder')
  })

  it('一度動き出したら、しきい値の内側へ戻っても動き続ける', () => {
    // 超えたり戻ったりで幅が跳ねないように、`moved` は戻さない
    const { 縁, moves } = 置く('folder', 320)
    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })
    fireEvent.pointerMove(縁, { pointerId: 1, clientX: 360 })
    fireEvent.pointerMove(縁, { pointerId: 1, clientX: 321 })

    expect(最後の幅(moves)).toBe(321)
  })

  it('掴んでいない指の動きは拾わない', () => {
    const { 縁, moves } = 置く()
    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })
    fireEvent.pointerMove(縁, { pointerId: 2, clientX: 500 })

    expect(moves).toEqual([])
  })

  it('二本目の指では乗っ取られない', () => {
    const { 縁, moves } = 置く('folder', 320)
    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })
    fireEvent.pointerDown(縁, { pointerId: 2, clientX: 700 })
    fireEvent.pointerMove(縁, { pointerId: 1, clientX: 360 })

    // 1本目の基準（320）のままであること。乗っ取られていれば 700 が基準になる
    expect(最後の幅(moves)).toBe(360)
  })

  it('`setPointerCapture` が無い環境でも落ちない', () => {
    // jsdom には無い（実測）。`?.()` で呼んでいないと、ここで投げる。
    // **取ること自体が要る**——取らないと `lostpointercapture` が一度も飛ばず、
    // 止める契機の3つ目が書いてあるだけで効かなくなる（設計§4）
    const { 縁 } = 置く()
    expect(() =>
      fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 }),
    ).not.toThrow()
  })
})

describe('止める契機は3つ', () => {
  /** 掴んで動かし、指定の合図で止め、そのあとさらに動かして届くかを見る。 */
  function 止まるか(合図: (縁: HTMLElement) => void) {
    const { 縁, moves } = 置く('folder', 320)
    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })
    fireEvent.pointerMove(縁, { pointerId: 1, clientX: 360 })
    合図(縁)
    fireEvent.pointerMove(縁, { pointerId: 1, clientX: 500 })
    return 最後の幅(moves)
  }

  // **1つずつ確かめる。** まとめて1本にすると、どれが効いているか分からない
  it('`pointerup` で止まる', () => {
    expect(止まるか((縁) => fireEvent.pointerUp(縁, { pointerId: 1 }))).toBe(360)
  })

  it('`pointercancel` で止まる', () => {
    expect(止まるか((縁) => fireEvent.pointerCancel(縁, { pointerId: 1 }))).toBe(
      360,
    )
  })

  it('`lostpointercapture` で止まる', () => {
    expect(
      止まるか((縁) => fireEvent.lostPointerCapture(縁, { pointerId: 1 })),
    ).toBe(360)
  })

  it('**`pointerleave` では止まらない**', () => {
    // タッチは `pointerdown` の時点で暗黙のキャプチャが効いており、これは発火しない。
    // 止める契機にすると**指では止まらない**（設計§4）
    expect(止まるか((縁) => fireEvent.pointerLeave(縁, { pointerId: 1 }))).toBe(
      500,
    )
  })

  it('離したことが1回だけ伝わる', () => {
    const { 縁, grabs } = 置く()
    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })
    fireEvent.pointerUp(縁, { pointerId: 1 })
    // `pointerup` のあとブラウザがキャプチャを自動で解くので、続けて飛んでくる
    fireEvent.lostPointerCapture(縁, { pointerId: 1 })

    expect(grabs).toEqual(['grab', 'drop'])
  })
})

describe('掴んでいることの見せ方', () => {
  it('掴んでいる間だけ `data-dragging` が立つ', () => {
    const { 縁 } = 置く()
    expect(縁).toHaveAttribute('data-dragging', 'false')

    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })
    expect(縁).toHaveAttribute('data-dragging', 'true')

    fireEvent.pointerUp(縁, { pointerId: 1 })
    expect(縁).toHaveAttribute('data-dragging', 'false')
  })

  it('掴んでいる間だけ、周りの文字が選べなくなる', () => {
    // 縁そのものではなく `body` に当てる——選択が始まるのは**縁の外**（隣の本文）。
    // 元の値を控えて戻すので、他が当てていても壊さない
    const { 縁 } = 置く()
    expect(document.body.style.userSelect).toBe('')

    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })
    expect(document.body.style.userSelect).toBe('none')

    fireEvent.pointerUp(縁, { pointerId: 1 })
    expect(document.body.style.userSelect).toBe('')
  })
})

describe('範囲の配線', () => {
  // 規則そのものは `panelWidth.test.ts` が見ているので、ここは繋がっていることだけ
  it('下限より狭くならない', () => {
    const { 縁, moves } = 置く('folder', 320)
    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })
    fireEvent.pointerMove(縁, { pointerId: 1, clientX: -9999 })

    expect(最後の幅(moves)).toBe(160)
  })

  it('上限より広くならない', () => {
    const { 縁, moves } = 置く('folder', 320)
    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })
    fireEvent.pointerMove(縁, { pointerId: 1, clientX: 9999 })

    expect(最後の幅(moves)).toBe(640)
  })

  it('0 にはならない', () => {
    // 縁で 0 まで縮めた状態とボタンで畳んだ状態は**見た目が同じなのに戻し方が違う**。
    // 縮めきったのに戻せない、が起きるのがいちばん困るので、畳むのはボタンの仕事
    const { 縁, moves } = 置く('folder', 320)
    fireEvent.pointerDown(縁, { pointerId: 1, clientX: 320 })
    fireEvent.pointerMove(縁, { pointerId: 1, clientX: 0 })

    expect(最後の幅(moves)).toBeGreaterThan(0)
  })
})
