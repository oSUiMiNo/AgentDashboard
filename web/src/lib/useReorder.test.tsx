import { act, render, screen } from '@testing-library/react'
import { useRef, type MutableRefObject } from 'react'
import { clearReorderingStore, isReordering } from '@/stores/reordering'
import {
  useReorder,
  ECHO_TIMEOUT_MS,
  REORDER_SETTLE_MS,
  type Reorder,
  type Scroller,
} from './useReorder'
import type { Rect } from './reorder'

/**
 * `useReorder` の振る舞い（設計§15-2・§15-11）。
 *
 * jsdom は矩形を固定で返す（`test/setup.ts`）ので、**要素ごとに `getBoundingClientRect`
 * を差し替えて**凍結する矩形を与える。CSS は適用されないので、滑ることそのものは
 * E2E が見る。ここで言えるのは「DOM を動かさない」「誰に何を書くか」「離したあと何を
 * 返すか」まで。
 */

/** 一覧のカード：294×200・隙間 12・3列 */
function 格子(枚数: number): Rect[] {
  const out: Rect[] = []
  for (let i = 0; i < 枚数; i += 1) {
    out.push({ left: (i % 3) * 306, top: Math.floor(i / 3) * 212, width: 294, height: 200 })
  }
  return out
}

interface 器の口 {
  current: Reorder<string> | null
}

/*
  **この器だけは英字で名づける。** `oxlint` の `rules-of-hooks` はフックを呼んでよい相手を
  名前の1文字目で判定する（`useGrip.test.tsx` と同じ理由）。
*/
function Harness({
  ids,
  out,
  onCommit,
  scroller,
}: {
  ids: readonly string[]
  out: MutableRefObject<Reorder<string> | null>
  onCommit: (next: readonly string[]) => Promise<string | null> | void
  scroller?: Scroller
}) {
  const reorder = useReorder<string>({ ids, onCommit, scroller })
  out.current = reorder
  return (
    <div>
      {reorder.order.map((id) => (
        <div
          key={id}
          data-testid={id}
          data-reorder-item=""
          data-dragging={reorder.dragging === id ? 'true' : 'false'}
          data-reordering={reorder.reordering ? 'true' : 'false'}
          // **「静止」にしておく。** バネを通らず、その場で収まる（決定的に試験できる）。
          // バネそのものは E2E が見る
          data-quiet="still"
          ref={reorder.itemRef(id)}
        />
      ))}
    </div>
  )
}

function Outer({
  ids,
  onCommit,
  outRef,
  scroller,
}: {
  ids: readonly string[]
  onCommit: (next: readonly string[]) => Promise<string | null> | void
  outRef: (口: 器の口) => void
  scroller?: Scroller
}) {
  const out = useRef<Reorder<string> | null>(null)
  outRef(out)
  return <Harness ids={ids} out={out} onCommit={onCommit} scroller={scroller} />
}

function 置く(
  ids: readonly string[],
  rects: Rect[],
  answer: (next: readonly string[]) => Promise<string | null> | void = () => {},
  scroller?: Scroller,
) {
  const 送った: (readonly string[])[] = []
  let 口: 器の口 = { current: null }
  const view = render(
    <Outer
      ids={ids}
      onCommit={(next) => {
        送った.push(next)
        return answer(next)
      }}
      outRef={(o) => (口 = o)}
      scroller={scroller}
    />,
  )
  // **要素ごとに矩形を差し替える。** プロトタイプの固定値に勝つ
  ids.forEach((id, at) => {
    const rect = rects[at]
    Object.defineProperty(screen.getByTestId(id), 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        x: rect.left,
        y: rect.top,
        toJSON: () => ({}),
      }),
    })
  })
  const 並び = () =>
    [...view.container.querySelectorAll('[data-reorder-item]')].map(
      (node) => node.getAttribute('data-testid') ?? '',
    )
  return { 送った, 口: () => 口.current as Reorder<string>, 並び, view }
}

beforeEach(() => {
  clearReorderingStore()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('運んでいる間は DOM を並べ替えない', () => {
  it('掴んで運んでも並びは変わらず、押しのけられる側の translate だけが動く', () => {
    const { 口, 並び } = 置く(['a', 'b', 'c'], 格子(3))
    act(() => 口().bind('a').onGrab({ x: 100, y: 100 }))
    // a を b の上まで（隙間の真ん中 300 を越えて）運ぶ
    act(() => 口().bind('a').onMove({ x: 420, y: 100 }))

    expect(並び()).toEqual(['a', 'b', 'c'])
    expect(screen.getByTestId('b').style.translate).toBe('-306px 0px')
    expect(screen.getByTestId('c').style.translate).toBe('')
  })

  it('本人は指の移動量そのもの（1:1）で追従する', () => {
    const { 口 } = 置く(['a', 'b', 'c'], 格子(3))
    act(() => 口().bind('a').onGrab({ x: 100, y: 100 }))
    act(() => 口().bind('a').onMove({ x: 137, y: 105 }))
    expect(screen.getByTestId('a').style.translate).toBe('37px 5px')
    act(() => 口().bind('a').onMove({ x: 140, y: 90 }))
    expect(screen.getByTestId('a').style.translate).toBe('40px -10px')
  })

  it('握り点が無ければ、最初の onMove の点を握り点にする', () => {
    const { 口 } = 置く(['a', 'b', 'c'], 格子(3))
    act(() => 口().bind('a').onGrab())
    act(() => 口().bind('a').onMove({ x: 100, y: 100 }))
    expect(screen.getByTestId('a').style.translate).toBe('0px 0px')
    act(() => 口().bind('a').onMove({ x: 110, y: 100 }))
    expect(screen.getByTestId('a').style.translate).toBe('10px 0px')
  })

  it('離すと並びが仮想の並びになり、書いたものは滑り終わりに消える', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { 口, 並び, 送った } = 置く(['a', 'b', 'c'], 格子(3))
    act(() => 口().bind('a').onGrab({ x: 100, y: 100 }))
    act(() => 口().bind('a').onMove({ x: 420, y: 100 }))
    act(() => 口().bind('a').onDrop())

    expect(並び()).toEqual(['b', 'a', 'c'])
    expect(送った).toEqual([['b', 'a', 'c']])
    expect(口().reordering).toBe(true)
    act(() => {
      vi.advanceTimersByTime(REORDER_SETTLE_MS)
    })
    expect(口().reordering).toBe(false)
    expect(screen.getByTestId('a').style.translate).toBe('')
    expect(screen.getByTestId('b').style.translate).toBe('')
  })

  it('変わっていなければ送らない', () => {
    const { 口, 送った } = 置く(['a', 'b', 'c'], 格子(3))
    act(() => 口().bind('a').onGrab({ x: 100, y: 100 }))
    act(() => 口().bind('a').onMove({ x: 120, y: 100 }))
    act(() => 口().bind('a').onDrop())
    expect(送った).toEqual([])
  })
})

describe('離した後は手元の並びを保つ', () => {
  it('ids が一致するまで手元を返し、一致したら ids に追従する', () => {
    const { 口, 並び, view } = 置く(['a', 'b', 'c'], 格子(3))
    act(() => 口().bind('a').onGrab({ x: 100, y: 100 }))
    act(() => 口().bind('a').onMove({ x: 420, y: 100 }))
    act(() => 口().bind('a').onDrop())
    expect(並び()).toEqual(['b', 'a', 'c'])

    // 古い並びのまま描き直されても、手元を保つ（返事はまだ）
    view.rerender(
      <Outer ids={['a', 'b', 'c']} onCommit={() => {}} outRef={() => {}} />,
    )
    expect(並び()).toEqual(['b', 'a', 'c'])

    // 返事が一致した。以後は ids に追従する
    view.rerender(
      <Outer ids={['b', 'a', 'c']} onCommit={() => {}} outRef={() => {}} />,
    )
    expect(並び()).toEqual(['b', 'a', 'c'])
    view.rerender(
      <Outer ids={['c', 'b', 'a']} onCommit={() => {}} outRef={() => {}} />,
    )
    expect(並び()).toEqual(['c', 'b', 'a'])
  })
})

describe('印', () => {
  it('掴むと立ち、滑り終わると降りる', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { 口 } = 置く(['a', 'b'], 格子(2))
    expect(isReordering()).toBe(false)
    act(() => 口().bind('a').onGrab({ x: 100, y: 100 }))
    expect(isReordering()).toBe(true)
    act(() => 口().bind('a').onDrop())
    expect(isReordering()).toBe(true)
    act(() => {
      vi.advanceTimersByTime(REORDER_SETTLE_MS)
    })
    expect(isReordering()).toBe(false)
  })

  it('外れるときに印も書いたものも残さない', () => {
    const { 口, view } = 置く(['a', 'b'], 格子(2))
    act(() => 口().bind('a').onGrab({ x: 100, y: 100 }))
    act(() => 口().bind('a').onMove({ x: 420, y: 100 }))
    view.unmount()
    expect(isReordering()).toBe(false)
  })
})

describe('断られたら、元へ戻す', () => {
  it('理由が返ってきたら ids の並びへ戻し、滑り終わるまで印を立てる', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { 口, 並び } = 置く(['a', 'b', 'c'], 格子(3), () => Promise.resolve('だめ'))
    act(() => 口().bind('a').onGrab({ x: 100, y: 100 }))
    act(() => 口().bind('a').onMove({ x: 420, y: 100 }))
    act(() => 口().bind('a').onDrop())
    expect(並び()).toEqual(['b', 'a', 'c'])

    // 返事（断り）が届く
    await act(async () => {
      await Promise.resolve()
    })
    expect(並び()).toEqual(['a', 'b', 'c'])
    expect(口().reordering).toBe(true)
    act(() => {
      vi.advanceTimersByTime(REORDER_SETTLE_MS)
    })
    expect(口().reordering).toBe(false)
  })

  it('2秒返事が無ければ、ids の並びへ戻す', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { 口, 並び } = 置く(['a', 'b', 'c'], 格子(3))
    act(() => 口().bind('a').onGrab({ x: 100, y: 100 }))
    act(() => 口().bind('a').onMove({ x: 420, y: 100 }))
    act(() => 口().bind('a').onDrop())
    expect(並び()).toEqual(['b', 'a', 'c'])
    act(() => {
      vi.advanceTimersByTime(ECHO_TIMEOUT_MS - 1)
    })
    expect(並び()).toEqual(['b', 'a', 'c'])
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(並び()).toEqual(['a', 'b', 'c'])
  })

  it('掴み直した後に届いた古い断りは、いまの運びを戻さない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let 答え: (reason: string | null) => void = () => {}
    const { 口, 並び } = 置く(
      ['a', 'b', 'c'],
      格子(3),
      () =>
        new Promise<string | null>((resolve) => {
          答え = resolve
        }),
    )
    act(() => 口().bind('a').onGrab({ x: 100, y: 100 }))
    act(() => 口().bind('a').onMove({ x: 420, y: 100 }))
    act(() => 口().bind('a').onDrop())
    const 一度目の答え = 答え
    // 返事が来る前に掴み直して運ぶ（見えている並びが土台）
    act(() => 口().bind('c').onGrab({ x: 700, y: 100 }))
    act(() => 口().bind('c').onMove({ x: 300, y: 100 }))
    act(() => 口().bind('c').onDrop())
    expect(並び()).toEqual(['b', 'c', 'a'])
    // 古い運びの断りが今ごろ届いても、いまの並びは動かない
    await act(async () => {
      一度目の答え('だめ')
      await Promise.resolve()
    })
    expect(並び()).toEqual(['b', 'c', 'a'])
  })
})

/** 偽のスクロール箱。`scrollBy` で `scrollTop` が動く */
function 偽の箱(bounds: Rect) {
  const box = {
    scrollTop: 0,
    scrollLeft: 0,
    scrolled: [] as { x: number; y: number }[],
    getBoundingClientRect: () => ({
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      right: bounds.left + bounds.width,
      bottom: bounds.top + bounds.height,
      x: bounds.left,
      y: bounds.top,
      toJSON: () => ({}),
    }),
    scrollBy(x: number, y: number) {
      box.scrollLeft += x
      box.scrollTop += y
      box.scrolled.push({ x, y })
    },
  }
  return box
}

describe('端での自動送りと、スクロールの補正', () => {
  it('端に指を止めると、深さに比例して箱を送り続ける', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    const box = 偽の箱({ left: 0, top: 0, width: 1000, height: 600 })
    const scroller: Scroller = { get: () => box as unknown as HTMLElement, axis: 'y' }
    const { 口 } = 置く(['a', 'b', 'c'], 格子(3), () => {}, scroller)
    act(() => 口().bind('a').onGrab({ x: 100, y: 100 }))
    // 下端（600）の帯の中、深さ 32 → 8px/フレーム
    act(() => 口().bind('a').onMove({ x: 100, y: 600 - 32 }))
    act(() => {
      vi.advanceTimersToNextFrame()
      vi.advanceTimersToNextFrame()
    })
    expect(box.scrolled).toEqual([
      { x: 0, y: 8 },
      { x: 0, y: 8 },
    ])
    act(() => 口().bind('a').onDrop())
  })

  it('送っている間は、指を動かさなくても本人が追従し、落とし先を判定し直す', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    // 縦1列の枠（高さ 100・隙間 16）。指を 2 枚目の下端付近に止め、箱が送られる
    const rects: Rect[] = [0, 1, 2, 3].map((i) => ({ left: 0, top: i * 116, width: 940, height: 100 }))
    const box = 偽の箱({ left: 0, top: 0, width: 1000, height: 200 })
    const scroller: Scroller = { get: () => box as unknown as HTMLElement, axis: 'y' }
    const { 口 } = 置く(['a', 'b', 'c', 'd'], rects, () => {}, scroller)
    act(() => 口().bind('a').onGrab({ x: 100, y: 50 }))
    // 箱の下端（200）に指を置く。判定の点は y=50+Δ… ここでは Δ=0 で 1 枚目の中
    act(() => 口().bind('a').onMove({ x: 100, y: 200 }))
    // 1フレームで 16px 送られる。指は止めたまま
    act(() => {
      vi.advanceTimersToNextFrame()
    })
    expect(box.scrollTop).toBe(16)
    // 追従：translate ＝（200 − 50）＋ Δ(16) ＝ 166
    expect(screen.getByTestId('a').style.translate).toBe('0px 166px')
    // 何フレームか送ると、判定の点（200 + Δ）が 2 枚目の帯（116〜216）を越えて 3 枚目へ向かう
    act(() => {
      for (let i = 0; i < 6; i += 1) vi.advanceTimersToNextFrame()
    })
    expect(box.scrollTop).toBe(16 * 7)
    // 1 歩ずつ：a は 1 → 2 と進み、b は上へ 116、c も上へ 116
    expect(screen.getByTestId('b').style.translate).toBe('0px -116px')
    expect(screen.getByTestId('c').style.translate).toBe('0px -116px')
    act(() => 口().bind('a').onDrop())
  })

  it('ホイールで箱が動いても、判定は凍結した座標系で行う', () => {
    const rects: Rect[] = [0, 1, 2].map((i) => ({ left: 0, top: i * 116, width: 940, height: 100 }))
    const box = 偽の箱({ left: 0, top: 0, width: 1000, height: 600 })
    const scroller: Scroller = { get: () => box as unknown as HTMLElement, axis: 'y' }
    const { 口 } = 置く(['a', 'b', 'c'], rects, () => {}, scroller)
    act(() => 口().bind('a').onGrab({ x: 100, y: 50 }))
    // ホイールで 116px 送られた（画面の中身が上へ動いた）。指は同じ画面位置（y=50）のまま
    box.scrollTop = 116
    act(() => 口().bind('a').onMove({ x: 100, y: 50 }))
    // 凍結した座標系では指は y=166 ＝ 2 枚目の中 → 1 歩
    expect(screen.getByTestId('b').style.translate).toBe('0px -116px')
    // 本人は Δ ぶん余計に動いて、画面上は指の下に居る
    expect(screen.getByTestId('a').style.translate).toBe('0px 116px')
    act(() => 口().bind('a').onDrop())
  })
})
