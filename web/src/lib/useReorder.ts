/**
 * 掴んで並べ替えるときの配線（並べ替え設計§3-4・§15-2・§15-11）。
 *
 * # ここは「測る側」
 *
 * 矩形を測り、要素へ書き、状態を持つ。**決めるのは `lib/reorder.ts` の純関数**
 * （[`dropTarget`]・[`virtualOffsets`]・[`layoutOf`]）で、あちらは `window` も
 * `document` も読まない。分けてある理由は `lib/reorder.ts` の冒頭にある。
 *
 * # 運んでいる間は DOM を並べ替えない（設計§15-11）
 *
 * React に並びを差し替えさせると、**後ろへ動く要素のノードだけが外して差し直される**
 * （`insertBefore`）。右（下）へ運ぶと動かされるのは掴んでいる本人で、外れた瞬間に
 * ポインタキャプチャが落ちて掴みが終わる——「右へ1回動かすと掴みが解ける」の正体。
 * 走っている `transition` も切れる。
 *
 * だから**離すまで `order` は掴んだ瞬間の並びのまま**返し、見た目の並びは各要素の
 * `translate` で作る。本人は指に 1:1 で追従し（設計§15-2）、他は凍結した矩形と
 * 仮想の並びから出した行き先へ滑る。離したときだけ `order` を確定して React に
 * 並べ替えさせ、直後に新しい位置を測って `translate` を 0 へ戻す（差が 0 なら動かない）。
 *
 * # React の状態は3つだけ
 *
 * 「掴んでいるのは誰か」「見せる並び」「並べ替え中か」。座標・仮想の並び・封印・標本は
 * すべて `useRef`。**`pointermove` で `setState` を呼ばない**——60回/秒の描き直しは
 * 追従を1フレーム遅らせる。要素へ直接書くのは `style.translate` と `data-reorder-snap`
 * だけで、React が持つ属性には触らない。
 *
 * # 矩形は掴んだ瞬間の1回だけ測る
 *
 * 運んでいる最中に測り直さない。**判断の土台が動くと、指を止めていても落とし先が揺れる**。
 *
 * # 動きの本体と、食い違いの記録は `reorder.css` にある
 *
 * ここが持つのは**動かす量**だけで、**動き方**——時間・曲線・止める段——は CSS 側にある。
 *
 * # 端での自動送りは、いまどこからも使われていない
 *
 * `scroller` は3つの呼び出し元のどこからも渡していない。**繋ぐ前に直すことがある**
 * ——`rects` は掴んだ瞬間の**画面の座標**で凍結してあるので、容器がスクロールすると
 * 土台だけが取り残されて落とし先がずれる。繋ぐなら、指の位置をスクロール差分で
 * 補正すること（設計§15-12）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  dropTarget,
  headingOf,
  layoutOf,
  moveItem,
  sameOrder,
  virtualOffsets,
  type Layout,
  type Point,
  type Rect,
  type Sample,
  type Seal,
  VELOCITY_WINDOW_MS,
} from './reorder'
import { lowerReordering, raiseReordering } from '@/stores/reordering'

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

/** 標本を持つ数の上限。窓（100ms）に収まる数より十分多い */
const SAMPLE_LIMIT = 32

/** 着地の逆算で「動いていない」と見なす差（px） */
const SETTLED_PX = 0.5

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
  /** 掴んだ。引数は押した点（握り点）。無ければ最初の `onMove` の点を握り点にする */
  onGrab: (origin?: Point) => void
  onMove: (point: Point) => void
  onDrop: () => void
}

export interface Reorder<T extends string> {
  /**
   * いま描くべき並び。
   *
   * **運んでいる間は掴んだ瞬間の並びのまま**（React に DOM を動かさせない）。
   * 離したら仮想の並びになり、サーバの返事（`ids`）が一致したら `ids` へ戻る。
   */
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

/** 掴んでいる間だけ在る、運びの土台。**離すまで書き換えるのは仮想の並びと封印だけ** */
interface Held<T> {
  /** 掴んだ瞬間の並び（＝DOM の並び。離すまで固定） */
  base: readonly T[]
  /** 凍結した矩形（`base` 順＝スロット） */
  rects: Rect[]
  layout: Layout
  /** 本人の `base` での添字 */
  from: number
  /** 仮想の並び。`placement[スロット] = base の添字` */
  placement: number[]
  /** 本人がいま居る仮想のスロット */
  current: number
  seal: Seal | null
  /** 握り点。押した点か、無ければ最初の `onMove` の点 */
  origin: Point | null
  /** 本人の最後の `translate`（着地の逆算に使う） */
  followed: Point
  samples: Sample[]
}

function translateOf(point: Point): string {
  return `${point.x}px ${point.y}px`
}

export function useReorder<T extends string>({
  ids,
  onCommit,
  scroller,
}: Options<T>): Reorder<T> {
  const [dragging, setDragging] = useState<T | null>(null)
  /**
   * 見せる並び。掴んだ瞬間＝`base`（DOM と同じ）、離した後＝仮想の並び、
   * サーバの返事が一致したら `null`（＝`ids` をそのまま返す）。
   */
  const [shown, setShown] = useState<readonly T[] | null>(null)
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
  const held = useRef<Held<T> | null>(null)
  /**
   * 着地の直前の見え方（左上）。**離した瞬間にだけ**入る。
   *
   * ここに入っていると、次の描画の直後に FLIP（逆算を当てて 0 へ戻す）が走る。
   */
  const 控え = useRef<Map<T, Point> | null>(null)
  /** 離した後、サーバの返事を待っている並び。一致したら `shown` を捨てる */
  const 返事待ち = useRef<readonly T[] | null>(null)
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

  /** 書いた `translate` と印を全部外す。**React が持つ属性には触らない** */
  const 書いたものを外す = useCallback(() => {
    for (const element of elements.current.values()) {
      element.style.translate = ''
      delete element.dataset.reorderSnap
    }
  }, [])

  /*
    **着地**（設計§15-11）。離した直後、React が DOM を並べ替えた**後**に走る。

    運んでいる間は各要素が `translate` で仮想の位置に居る。並べ替えた DOM の位置は
    その見た目と一致するはずなので、①全員の `translate` を外して滑りを切り、②新しい
    位置を測り、③差があるものにだけ逆算を当てて 0 へ滑らせる。理想どおりなら差は 0 で
    誰も動かない（E2E ⑪）。最後の1歩の途中で離したときは残りを滑って繋がる。

    **「差が 0 なら何もしない」ではなく FLIP を通す**のは、`getBoundingClientRect` が
    `translate` を含んだ見た目の位置を返すため——途中で離しても飛ばない。
  */
  useLayoutEffect(() => {
    const 前 = 控え.current
    控え.current = null
    if (前 === null) {
      return
    }
    for (const element of elements.current.values()) {
      element.dataset.reorderSnap = 'true'
      element.style.translate = ''
    }
    const 動いた: HTMLElement[] = []
    for (const [id, element] of elements.current) {
      const was = 前.get(id)
      if (was === undefined) {
        delete element.dataset.reorderSnap
        continue
      }
      const box = element.getBoundingClientRect()
      const dx = was.x - box.left
      const dy = was.y - box.top
      if (Math.abs(dx) <= SETTLED_PX && Math.abs(dy) <= SETTLED_PX) {
        // jsdom は矩形を固定で返すので、**必ずここを通る**（動きは E2E が見る）
        delete element.dataset.reorderSnap
        continue
      }
      element.style.translate = translateOf({ x: dx, y: dy })
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
      element.style.translate = '0px 0px'
    }
  }, [shown, dragging])

  /*
    **サーバの返事が手元の並びと一致したら、手元を捨てる**（設計§15-4）。
    並びは同じなので DOM は動かない。
  */
  useEffect(() => {
    const waiting = 返事待ち.current
    if (waiting === null || !sameOrder(ids, waiting)) {
      return
    }
    返事待ち.current = null
    setShown(null)
  }, [ids])

  // 外れるときに予定も印も、書いたものも残さない（掴んだまま画面が消えることがある）
  useEffect(() => {
    const 札 = 主.current
    return () => {
      if (降ろす予定.current !== null) {
        clearTimeout(降ろす予定.current)
      }
      lowerReordering(札)
    }
  }, [])

  /** 本人の見た目の左上。**矩形ではなく凍結した矩形＋`translate`**（倍率と傾きで箱が膨らむため） */
  const 位置を控える = useCallback((h: Held<T>) => {
    const 表 = new Map<T, Point>()
    for (const [id, element] of elements.current) {
      if (id === h.base[h.from]) {
        const rect = h.rects[h.from]
        表.set(id, { x: rect.left + h.followed.x, y: rect.top + h.followed.y })
        continue
      }
      const box = element.getBoundingClientRect()
      表.set(id, { x: box.left, y: box.top })
    }
    return 表
  }, [])

  const bind = useCallback(
    (id: T): Bound => ({
      onGrab: (origin) => {
        // **掴んだ瞬間の並びを土台にする。** 返事待ちの最中なら、見えている並びが土台
        const base = 返事待ち.current ?? ids
        const from = base.indexOf(id)
        if (from < 0) {
          return
        }
        /*
          **測る前に、書いたものを全部外す。** 着地の途中（滑り残り）で掴み直すと、
          `translate` を含んだ矩形を凍結してしまう。
        */
        書いたものを外す()
        // **ここが唯一の測定**。以後は指の座標だけが答えを決める
        const rects = base.map((each) => {
          const element = elements.current.get(each)
          if (element === undefined) {
            return { left: Number.NaN, top: Number.NaN, width: 0, height: 0 }
          }
          const box = element.getBoundingClientRect()
          return { left: box.left, top: box.top, width: box.width, height: box.height }
        })
        held.current = {
          base,
          rects,
          layout: layoutOf(rects),
          from,
          placement: base.map((_, at) => at),
          current: from,
          seal: null,
          origin: origin ?? null,
          followed: { x: 0, y: 0 },
          samples: [],
        }
        // 離した直後にもう一度掴んだら、降ろす予定は捨てる
        if (降ろす予定.current !== null) {
          clearTimeout(降ろす予定.current)
          降ろす予定.current = null
        }
        setReordering(true)
        // **効果線を止める**（設計§15-1）。引き直しと発射は、印が降りるまで待つ
        raiseReordering(主.current)
        /*
          **掴んだ瞬間の並びを見せ続ける。** これが「運んでいる間は DOM を並べ替えない」
          の実体——`shown` が `base` と同じなので、React は何も動かさない。
        */
        setShown(base)
        setDragging(id)
      },
      onMove: (point) => {
        const h = held.current
        if (h === null) {
          return
        }
        if (h.origin === null) {
          h.origin = point
        }
        const now = performance.now()
        h.samples.push({ t: now, x: point.x, y: point.y })
        while (h.samples.length > SAMPLE_LIMIT || h.samples[0].t < now - VELOCITY_WINDOW_MS) {
          h.samples.shift()
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
        // **本人は指に 1:1 で追従する**（設計§15-2）。React を経由せず、要素へ直接書く
        h.followed = { x: point.x - h.origin.x, y: point.y - h.origin.y }
        const self = elements.current.get(h.base[h.from])
        if (self !== undefined) {
          self.style.translate = translateOf(h.followed)
        }
        /*
          **落とし先は「行→矩形→1歩→封印」で決める**（設計§15-3）。目標へ直接飛ばさず、
          1回の `pointermove` で動くのは隣の1枚だけ。直前に居た添字へは、指が 10px
          動くか向きが 1 rad 変わるまで戻さない——境界上で毎フレーム往復しないため。
        */
        const result = dropTarget({
          rects: h.rects,
          point,
          current: h.current,
          seal: h.seal,
          heading: headingOf(h.samples, now),
        })
        h.seal = result.seal
        if (result.index === h.current) {
          return
        }
        h.placement = moveItem(h.placement, h.current, result.index).slice()
        h.current = result.index
        /*
          **押しのけられる側の行き先を書く。** DOM は動かさず、凍結した矩形と仮想の並び
          から出した差を `translate` に入れる。滑り方（時間・曲線）は CSS が持つ。
        */
        const offsets = virtualOffsets(h.rects, h.placement, h.layout)
        for (let at = 0; at < h.base.length; at += 1) {
          if (at === h.from) {
            continue
          }
          const element = elements.current.get(h.base[at])
          if (element === undefined) {
            continue
          }
          // **動かない要素には書かない。** 1歩で書き換わるのは隣の1枚だけ（E2E が数える）
          const next = offsets[at].x === 0 && offsets[at].y === 0 ? '' : translateOf(offsets[at])
          if (element.style.translate !== next) {
            element.style.translate = next
          }
        }
      },
      onDrop: () => {
        const h = held.current
        held.current = null
        送り.current = { x: 0, y: 0 }
        if (h === null) {
          return
        }
        const next = h.placement.map((at) => h.base[at])
        const 動いた = next.some((each, at) => each !== h.base[at])
        // 着地の逆算のために、離した瞬間の見え方を控える
        控え.current = 位置を控える(h)
        setDragging(null)
        /*
          **離した後も手元の並びを見せ続ける**（設計§15-4）。いったん `ids` へ戻すと、
          サーバの返事が届くまでの 2〜4 フレーム、掴む前の並びが描かれて跳ぶ。
        */
        if (動いた) {
          返事待ち.current = next
          setShown(next)
        } else {
          返事待ち.current = null
          setShown(null)
        }
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
          書いたものを外す()
          // **印が降りたら、`RoamLayer` が場を測り直して1回だけ引き直す**（設計§15-1）
          lowerReordering(主.current)
        }, REORDER_SETTLE_MS)
        // **変わったときだけ送る。** 掴んで離しただけで書き込みが飛ぶと、
        // 押し間違いのたびにサーバが動く
        if (動いた) {
          onCommit(next)
        }
      },
    }),
    [ids, onCommit, scroller, 位置を控える, 書いたものを外す],
  )

  return {
    order: shown ?? ids,
    dragging,
    bind,
    itemRef,
    reordering,
  }
}
