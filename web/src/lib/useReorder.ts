/**
 * 掴んで並べ替えるときの配線（並べ替え設計§3-4・§3-5）。
 *
 * # ここは「測る側」
 *
 * 矩形を測り、スクロールを動かし、状態を持つ。**決めるのは [`nearestIndex`] と
 * [`moveItem`]**（`lib/reorder.ts` の純関数）で、あちらは `window` も `document` も
 * 読まない。分けてある理由は `lib/reorder.ts` の冒頭にある。
 *
 * # 矩形は掴んだ瞬間の1回だけ測る
 *
 * 運んでいる最中に測り直さない。場所取りが動くたびに周りの位置は変わるので、
 * **判断の土台が動くと、指を止めていても落とし先が揺れる**。
 *
 * # 並びは3箇所にあるが、規則は1つ
 *
 * 一覧のカード（折り返しの2次元）・枠（縦1列）・PJT 専用画面の区画（横1列）を、
 * 同じフックで扱う。**次元ごとに分岐を書かない**（設計§3-4）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { moveItem, nearestIndex, NO_TARGET, type Point, type Rect } from './reorder'
import { resetField } from './roam'

/**
 * スクロール容器の端から、これだけ内側に入ったら送り始める（px）。
 *
 * **無いと画面外へ運べない**（方針§2-4）。指が端に触れている間だけ送る。
 */
export const AUTO_SCROLL_EDGE_PX = 48

/** 1フレームあたりの送り量（px）。 */
export const AUTO_SCROLL_STEP_PX = 12

/**
 * その点が容器の端にいるとき、どちらへどれだけ送るか。**純粋な計算。**
 *
 * 戻り値は `{ x, y }` の送り量（px）。端にいなければどちらも 0。
 */
export function autoScrollStep(point: Point, bounds: Rect): { x: number; y: number } {
  const right = bounds.left + bounds.width
  const bottom = bounds.top + bounds.height
  let x = 0
  let y = 0
  if (point.x - bounds.left < AUTO_SCROLL_EDGE_PX) {
    x = -AUTO_SCROLL_STEP_PX
  } else if (right - point.x < AUTO_SCROLL_EDGE_PX) {
    x = AUTO_SCROLL_STEP_PX
  }
  if (point.y - bounds.top < AUTO_SCROLL_EDGE_PX) {
    y = -AUTO_SCROLL_STEP_PX
  } else if (bottom - point.y < AUTO_SCROLL_EDGE_PX) {
    y = AUTO_SCROLL_STEP_PX
  }
  return { x, y }
}

interface Options<T extends string> {
  /** いまの並び（サーバから来た順） */
  ids: readonly T[]
  /** 離したときに呼ぶ。**変わったときだけ**呼ばれる */
  onCommit: (next: readonly T[]) => void
  /** 端で送るスクロール容器。無ければ送らない */
  scroller?: () => HTMLElement | null
}

interface Bound {
  onGrab: () => void
  onMove: (point: Point) => void
  onDrop: () => void
}

export interface Reorder<T extends string> {
  /** いま描くべき並び。掴んでいなければ `ids` そのまま */
  order: readonly T[]
  /** いま浮かせているもの。掴んでいなければ `null` */
  dragging: T | null
  /** 掴み手へ渡す3つの合図 */
  bind: (id: T) => Bound
  /** 並びの中の要素を覚えるための `ref` */
  itemRef: (id: T) => (element: HTMLElement | null) => void
}

export function useReorder<T extends string>({
  ids,
  onCommit,
  scroller,
}: Options<T>): Reorder<T> {
  const [dragging, setDragging] = useState<T | null>(null)
  const [order, setOrder] = useState<readonly T[]>(ids)
  const elements = useRef(new Map<T, HTMLElement>())
  // 掴んだ瞬間に測った矩形と、掴んだものの元の添字。**運びの最中は動かさない**
  const measured = useRef<{ rects: Rect[]; from: number; base: readonly T[] } | null>(null)
  const 送り = useRef<{ x: number; y: number }>({ x: 0, y: 0 })


  // 端に指がある間だけ送る。**掴んでいないときは回さない**
  useEffect(() => {
    if (dragging === null || scroller === undefined) {
      return
    }
    let 生きている = true
    const 回す = () => {
      if (!生きている) {
        return
      }
      const box = scroller()
      const step = 送り.current
      if (box !== null && (step.x !== 0 || step.y !== 0)) {
        box.scrollBy(step.x, step.y)
      }
      requestAnimationFrame(回す)
    }
    requestAnimationFrame(回す)
    return () => {
      生きている = false
      送り.current = { x: 0, y: 0 }
    }
  }, [dragging, scroller])

  const itemRef = useCallback(
    (id: T) => (element: HTMLElement | null) => {
      if (element === null) {
        elements.current.delete(id)
      } else {
        elements.current.set(id, element)
      }
    },
    [],
  )

  const bind = useCallback(
    (id: T): Bound => ({
      onGrab: () => {
        // **掴んだ瞬間の並びを土台にする。** 以後はここから動かす
        const base = ids
        const from = base.indexOf(id)
        if (from < 0) {
          return
        }
        // **ここが唯一の測定**。以後は指の座標だけが答えを決める
        const rects = base.map((each) => {
          const element = elements.current.get(each)
          if (element === undefined) {
            return { left: Number.NaN, top: Number.NaN, width: 0, height: 0 }
          }
          const box = element.getBoundingClientRect()
          return { left: box.left, top: box.top, width: box.width, height: box.height }
        })
        measured.current = { rects, from, base }
        /*
          **掴んだ瞬間に、手元の並びへ土台を入れる。**

          掴んでいない間は渡された並びをそのまま返しているので、手元の状態は
          **マウント時のまま古い**（枠は起動後に足されるので、多くの場合は空）。
          入れずに掴むと、掴んだ瞬間に一覧が空になる——**実際にそうなった。**
        */
        setOrder(base)
        setDragging(id)
      },
      onMove: (point) => {
        const held = measured.current
        if (held === null) {
          return
        }
        const box = scroller?.() ?? null
        if (box !== null) {
          const bounds = box.getBoundingClientRect()
          送り.current = autoScrollStep(point, {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
          })
        }
        const target = nearestIndex(held.rects, point)
        if (target === NO_TARGET) {
          return
        }
        setOrder(moveItem(held.base, held.from, target))
      },
      onDrop: () => {
        const held = measured.current
        measured.current = null
        送り.current = { x: 0, y: 0 }
        setDragging(null)
        // **並べ替えたら、回遊する線の場を測り直す**（設計§8-1）。線は掴む前に測った
        // 矩形の上を飛ぶので、並びが変わったのに測り直さないと**もう居ない場所を
        // なぞる**。掴んでいる間は `data-motion` が `still` なので線そのものは
        // 撃たれておらず、ここで捨てておけば次に撃つときに測り直される
        resetField()
        if (held === null) {
          return
        }
        // **変わったときだけ送る。** 掴んで離しただけで書き込みが飛ぶと、
        // 押し間違いのたびにサーバが動く
        setOrder((now) => {
          const 動いた = now.length === held.base.length && now.some((each, at) => each !== held.base[at])
          if (動いた) {
            onCommit(now)
          }
          return now
        })
      },
    }),
    [ids, onCommit, scroller],
  )

  /*
    **掴んでいないあいだは、渡された並びをそのまま返す。**

    状態へ写して effect で追いかける形にしていたが、それだと**新しいものが現れてから
    描かれるまでに1周ぶんの遅れ**が出る——一覧に来たばかりのカードが1フレームだけ
    居ない状態になり、**「起こした直後に掴もうとすると見つからない」という揺らぎ**を
    生んだ（E2E が負荷時にだけ落ちる形で出た）。

    運んでいる最中だけは手元の並び（場所取りを動かしたもの）を返す。**外から新しい
    並びが来ても、指の下では動かさない。**
  */
  return { order: dragging === null ? ids : order, dragging, bind, itemRef }
}
