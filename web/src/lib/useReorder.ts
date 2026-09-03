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
 *
 * # 動きの本体と、食い違いの記録は `reorder.css` にある
 *
 * ここが持つのは**動かす量**（FLIP の逆算）だけで、**動き方**——時間・曲線・止める段
 * （静けさ・OS の「動きを減らす」）——は CSS 側にある。**ガイドラインの禁止
 * （「一覧の小窓に `layout` を付けるのも禁止」）との食い違いも、あちらが正本。**
 *
 * # 端での自動送りは、いまどこからも使われていない
 *
 * `scroller` は3つの呼び出し元のどこからも渡していない（実装は在るが死んでいる）。
 * **繋ぐ前に直すことがある**——`rects` は掴んだ瞬間の**画面の座標**で凍結してあるので、
 * 容器がスクロールすると**土台だけが取り残されて落とし先がずれる**。繋ぐなら、
 * 矩形をスクロール量ぶん補正するか、容器の座標で持ち直すこと。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { moveItem, nearestIndex, NO_TARGET, type Point, type Rect } from './reorder'
import { lowerReordering, raiseReordering } from '@/stores/reordering'

/**
 * スクロール容器の端から、これだけ内側に入ったら送り始める（px）。
 *
 * **無いと画面外へ運べない**（方針§2-4）。指が端に触れている間だけ送る。
 */
/**
 * 押しのけられる側が滑る時間（ms）。**`reorder.css` の `--reorder-ms` と同じ値**
 * （検査が突き合わせる）。`DESIGN.md` §28.2 の Normal（140〜220ms）の中。
 */
export const REORDER_SLIDE_MS = 180

/**
 * 離してから「掴んでいる」印を降ろすまで（ms）。
 *
 * **同時に降ろすと、持ち上げが元へ戻る動きが瞬時に切れる。** 滑り終わるまで待つ。
 */
export const REORDER_SETTLE_MS = REORDER_SLIDE_MS + 20

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

/**
 * 掴む側へ渡す3つの合図。
 *
 * **掴み手にも本体にも同じものを渡す。** 受け取った側が `useGrip` へそのまま流す。
 */
export interface Bound {
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
  /**
   * いま並べ替えている最中か。**掴んでいる本人だけでなく、並び全員に配る印。**
   *
   * 押しのけられる側も滑らせるので、`dragging`（1つだけ）とは別に要る。
   * **離してからも滑り終わるまで真のまま**（`REORDER_SETTLE_MS`）。
   */
  reordering: boolean
}

export function useReorder<T extends string>({
  ids,
  onCommit,
  scroller,
}: Options<T>): Reorder<T> {
  const [dragging, setDragging] = useState<T | null>(null)
  const [order, setOrder] = useState<readonly T[]>(ids)
  /**
   * 並び全員に配る「いま並べ替えている」印。**離してからも滑り終わるまで真のまま。**
   */
  const [reordering, setReordering] = useState(false)
  /**
   * 並べ替え中の印の主。**インスタンスごとに安定した札**（`stores/reordering.ts`）。
   *
   * 印はストアが主ごとに持つので、枠の並びとカードの並びが同時にマウントされていても
   * 互いの印を消さない。
   */
  const 主 = useRef<object>({})
  const 降ろす予定 = useRef<ReturnType<typeof setTimeout> | null>(null)
  const elements = useRef(new Map<T, HTMLElement>())
  /**
   * 並びが変わる**直前**の見え方。**変わったときだけ**控える。
   *
   * ここに入っていると、次の描画の直後に FLIP（逆算を当てて 0 へ戻す）が走る。
   */
  const 控え = useRef<Map<T, { left: number; top: number }> | null>(null)
  // 掴んだ瞬間に測った矩形と、掴んだものの元の添字。**運びの最中は動かさない**
  const measured = useRef<{
    rects: Rect[]
    from: number
    base: readonly T[]
    /** いまの落とし先。**変わったときだけ並びを作り直す** */
    to: number
  } | null>(null)
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

  /** いまの見え方を控える。**DOM を読むのはここと、掴んだ瞬間の1回だけ** */
  const 位置を控える = useCallback(() => {
    const 表 = new Map<T, { left: number; top: number }>()
    for (const [id, element] of elements.current) {
      const box = element.getBoundingClientRect()
      表.set(id, { left: box.left, top: box.top })
    }
    return 表
  }, [])

  /*
    **押しのけられる側も滑らせる**（並べ替え設計§7-3 の読み替え・利用者の指摘 2026-09-03）。

    やり方は FLIP——**並びを差し替えた直後に、動いたぶんを逆向きの `transform` で
    打ち消し**（見た目は元の位置のまま）、**1フレームだけ滑りを切って確定させ**、
    **0 へ戻して滑らせる**。動き方（時間・曲線・止める段）は `reorder.css` が持つ。

    **`motion` の `layout` は使わない。** あれは掴んでいなくても効くので、
    禁止（`guideline.md`「一覧の小窓に `layout` を付けるのも禁止」）の射程を越える。
  */
  useLayoutEffect(() => {
    const 前 = 控え.current
    控え.current = null
    if (前 === null) {
      return
    }
    const 動いた: HTMLElement[] = []
    for (const [id, element] of elements.current) {
      const was = 前.get(id)
      if (was === undefined) {
        continue
      }
      const box = element.getBoundingClientRect()
      const dx = was.left - box.left
      const dy = was.top - box.top
      if (dx === 0 && dy === 0) {
        // jsdom は矩形を固定で返すので、**必ずここを通る**（動きは E2E が見る）
        continue
      }
      element.dataset.reorderSnap = 'true'
      element.style.setProperty('--reorder-dx', `${dx}px`)
      element.style.setProperty('--reorder-dy', `${dy}px`)
      動いた.push(element)
    }
    if (動いた.length === 0) {
      return
    }
    /*
      **1回だけ読んで、逆算を「いまの見た目」として確定させる。**
      読まないと、次の行で戻したときにブラウザが「変化が無かった」と畳んでしまい、
      1ピクセルも滑らない。
    */
    void 動いた[0].getBoundingClientRect()
    for (const element of 動いた) {
      delete element.dataset.reorderSnap
      element.style.setProperty('--reorder-dx', '0px')
      element.style.setProperty('--reorder-dy', '0px')
    }
  }, [order])

  // 外れるときに予定も印も残さない（掴んだまま画面が消えることがある）
  useEffect(() => {
    const 札 = 主.current
    return () => {
      if (降ろす予定.current !== null) {
        clearTimeout(降ろす予定.current)
      }
      lowerReordering(札)
    }
  }, [])

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
        measured.current = { rects, from, base, to: from }
        // 離した直後にもう一度掴んだら、降ろす予定は捨てる
        if (降ろす予定.current !== null) {
          clearTimeout(降ろす予定.current)
          降ろす予定.current = null
        }
        setReordering(true)
        // **効果線を止める**（設計§15-1）。引き直しと発射は、印が降りるまで待つ
        raiseReordering(主.current)
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
        /*
          **落とし先が変わったときだけ並びを作り直す。**

          `moveItem` は動かないときも新しい配列を返すので、素朴に呼ぶと
          `pointermove` のたびに描き直しが走る。加えて FLIP は「並びが変わった瞬間」を
          捉える必要があるので、**変わっていないのに控えを取ると、動いていない要素に
          逆算を当てて動かしてしまう**。
        */
        if (target === NO_TARGET || target === held.to) {
          return
        }
        held.to = target
        控え.current = 位置を控える()
        setOrder(moveItem(held.base, held.from, target))
      },
      onDrop: () => {
        const held = measured.current
        measured.current = null
        送り.current = { x: 0, y: 0 }
        setDragging(null)
        /*
          **印は、滑り終わるまで降ろさない。** 同時に降ろすと持ち上げ（1.02倍・1度）が
          元へ戻る動きが瞬時に切れて、離した瞬間にカクつく。
        */
        if (降ろす予定.current !== null) {
          clearTimeout(降ろす予定.current)
        }
        降ろす予定.current = setTimeout(() => {
          降ろす予定.current = null
          setReordering(false)
          // **印が降りたら、`RoamLayer` が場を測り直して1回だけ引き直す**（設計§15-1）。
          // 線は掴む前に測った矩形の上を飛ぶので、並びが変わったのに測り直さないと
          // **もう居ない場所をなぞる**。測り直しは向こうの仕事で、ここは降ろすだけ
          lowerReordering(主.current)
        }, REORDER_SETTLE_MS)
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
  return {
    order: dragging === null ? ids : order,
    dragging,
    bind,
    itemRef,
    reordering,
  }
}
