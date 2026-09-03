import { fireEvent, render, screen } from '@testing-library/react'
import { useGrip, type GrabWhen } from './useGrip'
import type { Point } from './reorder'

/**
 * 掴む作法のうち、**本体で掴む2つ**（`move` と `hold`）を確かめる。
 *
 * `press`（区画の掴み手）は `ReorderHandle` のテストが見ているので、ここでは扱わない
 * ——**同じことを2箇所で数えない**。
 *
 * jsdom は矩形を固定で返すので、**運んだ結果どう並ぶかは言えない**（E2E の仕事）。
 * ここで言えるのは「**いつ掴むか**」と「**掴まないときに何もしないか**」まで。
 */

interface 記録 {
  grabs: number
  moves: Point[]
  drops: number
  taps: number
}

function 置く(when: GrabWhen, options: { enabled?: boolean } = {}) {
  const 記録: 記録 = { grabs: 0, moves: [], drops: 0, taps: 0 }
  let arm: (() => void) | null = null

  function 器() {
    const 掴み = useGrip({
      enabled: options.enabled,
      when: () => when,
      onGrab: () => {
        記録.grabs += 1
      },
      onMove: (point) => 記録.moves.push(point),
      onDrop: () => {
        記録.drops += 1
      },
      onTap: () => {
        記録.taps += 1
      },
    })
    arm = 掴み.arm
    return (
      <div
        data-testid="body"
        data-dragging={掴み.dragging ? 'true' : 'false'}
        {...掴み.handlers}
      >
        <button type="button" data-testid="inner" data-no-grab="">
          中のボタン
        </button>
      </div>
    )
  }

  render(<器 />)
  return { 記録, 本体: screen.getByTestId('body'), arm: () => arm?.() }
}

/** 押す→動かす→離す。**座標は呼び元が決める** */
function 運ぶ(本体: HTMLElement, から: Point, まで: Point) {
  fireEvent.pointerDown(本体, { pointerId: 1, clientX: から.x, clientY: から.y })
  fireEvent.pointerMove(本体, { pointerId: 1, clientX: まで.x, clientY: まで.y })
  fireEvent.pointerUp(本体, { pointerId: 1 })
}

describe('マウスは、動かしてから掴む', () => {
  it('しきい値に届かないうちは掴まない', () => {
    // **押しただけでは掴まない。** 本体を押すことには「選ぶ」「開く」がある
    const { 記録, 本体 } = 置く('move')
    fireEvent.pointerDown(本体, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(本体, { pointerId: 1, clientX: 101, clientY: 101 })

    expect(記録.grabs).toBe(0)
    expect(記録.moves).toEqual([])
  })

  it('しきい値を超えたら掴んで、そのまま運ぶ', () => {
    const { 記録, 本体 } = 置く('move')
    運ぶ(本体, { x: 100, y: 100 }, { x: 120, y: 100 })

    expect(記録.grabs).toBe(1)
    expect(記録.moves).toEqual([{ x: 120, y: 100 }])
    expect(記録.drops).toBe(1)
  })

  it('掴まずに離したら、落とす合図も出さない', () => {
    // **運びは始まっていない。** ここで `onDrop` を呼ぶと、押しただけで書き込みが飛ぶ
    const { 記録, 本体 } = 置く('move')
    fireEvent.pointerDown(本体, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(本体, { pointerId: 1 })

    expect(記録.drops).toBe(0)
  })
})

describe('指は、長押しが成立してから掴む', () => {
  it('`arm()` が呼ばれるまで、いくら動かしても掴まない', () => {
    /*
      **しきい値を見ない。** 見ると、長押しの計測（8px で捨てる）より先に 3px で
      掴んでしまい、**なぞってスクロールするつもりが運びになる**。
    */
    const { 記録, 本体 } = 置く('hold')
    fireEvent.pointerDown(本体, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(本体, { pointerId: 1, clientX: 140, clientY: 100 })

    expect(記録.grabs).toBe(0)
    expect(記録.moves).toEqual([])
  })

  it('`arm()` が呼ばれたら掴み、そのあとは運べる', () => {
    const { 記録, 本体, arm } = 置く('hold')
    fireEvent.pointerDown(本体, { pointerId: 1, clientX: 100, clientY: 100 })
    arm()

    expect(記録.grabs).toBe(1)

    fireEvent.pointerMove(本体, { pointerId: 1, clientX: 140, clientY: 100 })
    expect(記録.moves).toEqual([{ x: 140, y: 100 }])
  })

  it('押していないときに `arm()` が来ても、何も起きない', () => {
    // 長押しの計測は押していないときにも成立しうる（外れた直後など）
    const { 記録, arm } = 置く('hold')
    arm()

    expect(記録.grabs).toBe(0)
  })
})

describe('掴ませない場所', () => {
  it('中のボタンを押しても掴まない', () => {
    /*
      本体で掴めるようにすると、**中のボタンを押しただけでも掴んでしまう**。
      `click` を止めるだけでは足りない——`pointerdown` は別に止める必要がある。
    */
    const { 記録, 本体 } = 置く('move')
    const 中 = screen.getByTestId('inner')
    fireEvent.pointerDown(中, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(本体, { pointerId: 1, clientX: 140, clientY: 100 })

    expect(記録.grabs).toBe(0)
  })

  it('掴めない設定なら、合図を1つも出さない', () => {
    // 記録を持たない箱。**動かせても何も残らないものは、壊れているのと見分けが付かない**
    const { 記録, 本体 } = 置く('move', { enabled: false })
    運ぶ(本体, { x: 100, y: 100 }, { x: 140, y: 100 })

    expect(記録).toEqual({ grabs: 0, moves: [], drops: 0, taps: 0 })
  })
})

describe('運んだ直後の `click` を捨てる', () => {
  it('運んだら1回だけ捨てる', () => {
    // 捨てないと、**並べ替えるたびに選択が入れ替わる**（マウスのシングルは「選ぶ」）
    const { 本体 } = 置く('move')
    運ぶ(本体, { x: 100, y: 100 }, { x: 140, y: 100 })

    const 一度目 = fireEvent.click(本体)
    // `preventDefault` された＝捨てられた
    expect(一度目).toBe(false)
    // 2回目は素通り
    expect(fireEvent.click(本体)).toBe(true)
  })

  it('運んでいなければ捨てない', () => {
    // 押して離しただけなら「選ぶ」。ここで捨てると**選べなくなる**
    const { 本体 } = 置く('move')
    fireEvent.pointerDown(本体, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(本体, { pointerId: 1 })

    expect(fireEvent.click(本体)).toBe(true)
  })

  it('次に押したら、前の運びの印は残らない', () => {
    /*
      **指で運んだときは `click` がそもそも飛ばないことがある**（`touchmove` を
      止めているため合成の `click` が抑えられる）。捨て損ねた印が残ると、
      **次のタップが1回だけ食われる**——押しても何も起きないので、壊れているのと
      見分けが付かない。押し直した時点で「直後」ではなくなる。
    */
    const { 本体 } = 置く('move')
    運ぶ(本体, { x: 100, y: 100 }, { x: 140, y: 100 })
    // `click` が来ないまま、次の操作へ入る
    fireEvent.pointerDown(本体, { pointerId: 1, clientX: 200, clientY: 200 })
    fireEvent.pointerUp(本体, { pointerId: 1 })

    expect(fireEvent.click(本体)).toBe(true)
  })
})
