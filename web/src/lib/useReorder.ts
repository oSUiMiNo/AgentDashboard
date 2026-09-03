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
 * # 端での自動送りと、スクロールの補正（設計§15-12）
 *
 * `rects` は掴んだ瞬間の**画面の座標**で凍結してある。容器がスクロールすると土台だけが
 * 取り残されるので、**指の側を凍結した座標系へ写す**——判定に渡す点は「指の位置＋
 * （いまのスクロール − 掴んだ瞬間のスクロール）」。矩形は1回しか測らない。
 *
 * 送る箱は呼び元が渡す（一覧は本体の縦の箱、PJT 専用画面はレール）。指を止めたままでも
 * 送り続け、**スクロールが変わったフレームだけ**追従と判定をやり直す。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate } from 'motion'
import {
  autoScrollStep,
  dropTarget,
  headingOf,
  layoutOf,
  moveItem,
  sameOrder,
  velocityOf,
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
 *
 * 曲線は rbd の退避カーブ（＝Material 3 の `standard`）。**助走・素早い退避・文字が
 * 読める長い尾**の3段で、小窓に文字が載るこの道具にそのまま当たる（設計§15-7）。
 */
export const REORDER_SLIDE_MS = 200

/** 持ち上げ・傾きが付く時間（ms）。`DESIGN.md` §28.2 の Micro。押した手応えの延長 */
export const REORDER_LIFT_MS = 120

/**
 * 離してから「掴んでいる」印を降ろすまで（ms）。
 *
 * **同時に降ろすと、持ち上げが元へ戻る動きが瞬時に切れる。** 滑り終わるまで待つ。
 * 本人はバネで収まるので、**バネの終わりも待つ**（両方が済んだときに降ろす）。
 */
export const REORDER_SETTLE_MS = REORDER_SLIDE_MS + 20

/**
 * 落とすときのバネ（設計§15-7）。`motion` が x/y に当てる既定（500／25・わずかに弾む）と
 * Material 3 Expressive の空間の既定（減衰比 0.8）の中間。**実機で決め直す**（設計§15-10）。
 */
export const SPRING_STIFFNESS = 500
export const SPRING_DAMPING = 36

/**
 * 速度に応じた傾き（設計§15-7）。横速度（px/s）に掛けて度にする係数と、その上限。
 * 基準の 1度と合わせて最大 3度。react-tinder-card の ±25° は投げ捨てるカードの値なので
 * 桁を落としてある。**実機で決め直す**（設計§15-10）。
 */
export const TILT_SWING_DEG_PER_PX_S = 0.0015
export const TILT_SWING_MAX_DEG = 2

/** 標本を持つ数の上限。窓（100ms）に収まる数より十分多い */
const SAMPLE_LIMIT = 32

/** 着地の逆算で「動いていない」と見なす差（px） */
const SETTLED_PX = 0.5

/**
 * 離してから、サーバの返事を待つ上限（ms）（設計§15-4）。
 *
 * 返事は実測 18〜70ms で来る。来ないまま手元の並びを見せ続けると**サーバと画面が
 * ずれたまま**になるので、ここで諦めて `ids` へ戻す。
 */
export const ECHO_TIMEOUT_MS = 2_000

interface Options<T extends string> {
  /** いまの並び（サーバから来た順） */
  ids: readonly T[]
  /**
   * 離したときに呼ぶ。**変わったときだけ**呼ばれる。
   *
   * **理由を返せば断り**（設計§15-4）——手元の並びを元へ滑らせて戻す。`null` か
   * `undefined`（何も返さない）なら、サーバの返事（`ids`）が一致するまで手元を保つ。
   */
  onCommit: (next: readonly T[]) => Promise<string | null> | void
  /** 端で送るスクロール容器と、送る軸。無ければ送らない（設計§15-12） */
  scroller?: Scroller
}

/** 端で送る箱。**呼び元が渡す**——3箇所で箱が違うので、フックは探さない */
export interface Scroller {
  get: () => HTMLElement | null
  /** 送る軸。一覧の箱は横に `overflow-x-hidden` でもプログラムからは動くので、軸を限る */
  axis: 'x' | 'y'
}

function scrollOf(box: HTMLElement | null): Point {
  return box === null ? { x: 0, y: 0 } : { x: box.scrollLeft, y: box.scrollTop }
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
  /** 掴んだ瞬間に既に付いていた `translate`（収まる途中の掴み直し）。追従に足す */
  carry: Point
  samples: Sample[]
  /** 最後の指の位置（生）。送っている間の再判定に使う */
  last: Point | null
  /** 掴んだ瞬間の箱のスクロール */
  scroll0: Point
  /** 直前に見た箱のスクロール。変わったフレームだけ追従と判定をやり直す */
  scrollLast: Point
  /** いまのスクロール差分（`scrollLast − scroll0`）。着地の逆算に使う */
  scrollDelta: Point
  /**
   * 掴んだ瞬間に居た帯の向き（軸ごと。−1／0／+1）。**その帯に居続ける間は送らない**
   * ——端の近くで掴んで少し持ち上げただけで画面が流れ始めるのは、意図しない動き。
   * 帯の外へ出るか、反対の端の帯へ入れば 0 になり、以後は普通に送る。
   */
  holdBack: { x: number; y: number }
}

function parseTranslate(value: string): Point {
  if (value === '' || value === 'none') {
    return { x: 0, y: 0 }
  }
  const [x, y = '0px'] = value.split(' ')
  const px = Number.parseFloat(x)
  const py = Number.parseFloat(y)
  return { x: Number.isFinite(px) ? px : 0, y: Number.isFinite(py) ? py : 0 }
}

/** 設定か OS が動きを止めているか。**器の `data-quiet` を読む**（フックに設定を渡さない） */
function 動きを止めるか(element: HTMLElement): boolean {
  if (element.dataset.quiet === 'still') {
    return true
  }
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/**
 * 本人を枠へ収める（設計§15-7）。**値だけ回して、書くのはこちら。**
 *
 * 要素を `animate` に渡すと `transform` を書きに来て、器の `motion.div` と奪い合う
 * （読み替え5 で踏んだ穴）。数値のバネを x・y で別々に回し、`onUpdate` で `translate`
 * を書く——1つの値で進めると初速の向きが変位の向きと違うときに出せない。
 * 初速はポインタの速度そのもの（切り替わった瞬間を作らない）。
 *
 * 戻り値は止める手。止めたときは `onDone` を呼ばない。
 */
function バネで収める(
  element: HTMLElement,
  from: Point,
  velocity: Point,
  onDone: () => void,
): () => void {
  if (動きを止めるか(element)) {
    element.style.translate = ''
    onDone()
    return () => {}
  }
  let x = from.x
  let y = from.y
  let 止めた = false
  let 残り = 2
  const 書く = () => {
    element.style.translate = `${x}px ${y}px`
  }
  const 済んだ = () => {
    if (止めた) {
      return
    }
    残り -= 1
    if (残り === 0) {
      element.style.translate = ''
      onDone()
    }
  }
  const 共通 = {
    type: 'spring' as const,
    stiffness: SPRING_STIFFNESS,
    damping: SPRING_DAMPING,
    // 目に見えない尾を切る（px 単位）。既定（0.01）だと数十 ms 長く回る
    restDelta: 0.5,
    restSpeed: 10,
  }
  書く()
  const ax = animate(from.x, 0, {
    ...共通,
    velocity: velocity.x,
    onUpdate: (v) => {
      x = v
      書く()
    },
    onComplete: 済んだ,
  })
  const ay = animate(from.y, 0, {
    ...共通,
    velocity: velocity.y,
    onUpdate: (v) => {
      y = v
      書く()
    },
    onComplete: 済んだ,
  })
  return () => {
    止めた = true
    ax.stop()
    ay.stop()
  }
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value))
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
  /** 返事を諦める予定 */
  const 諦める予定 = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 運びの世代。**非同期の帰りが古い運びのものなら捨てる** */
  const 世代 = useRef(0)
  /** 離した本人を収めるバネ。着地の直後に張る */
  const バネの相手 = useRef<{ id: T; velocity: Point } | null>(null)
  /** 走っているバネ。掴み直したら止める */
  const バネ = useRef<{ id: T; stop: () => void } | null>(null)
  /** 印を降ろす条件。**滑りの時間とバネの両方**が済んだときに降ろす */
  const 降ろす条件 = useRef<{ timer: boolean; spring: boolean }>({ timer: true, spring: true })

  /** その点で、送る軸の送り量。箱が無ければ 0 */
  const 送り量 = useCallback(
    (point: Point): number => {
      const box = scroller?.get() ?? null
      if (scroller === undefined || box === null) {
        return 0
      }
      const bounds = box.getBoundingClientRect()
      const step = autoScrollStep(point, {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      })
      return scroller.axis === 'x' ? step.x : step.y
    },
    [scroller],
  )

  /**
   * 掴んだ瞬間の帯に居続けているかを更新し、**いま送ってよいか**を返す。
   * 帯の外へ出るか反対の端へ入れば解ける（以後は普通に送る）。
   */
  const 送ってよいか = useCallback(
    (h: Held<T>, along: number): boolean => {
      if (scroller === undefined) {
        return false
      }
      const axis = scroller.axis
      if (h.holdBack[axis] !== 0 && Math.sign(along) !== h.holdBack[axis]) {
        h.holdBack[axis] = 0
      }
      return along !== 0 && h.holdBack[axis] === 0
    },
    [scroller],
  )

  /** 本人を指の下へ。`translate` ＝ 引き継ぎ ＋（指 − 握り点）＋ スクロール差分 */
  const 追従する = useCallback((h: Held<T>, point: Point, now: number) => {
    if (h.origin === null) {
      h.origin = point
    }
    h.followed = {
      x: h.carry.x + point.x - h.origin.x + h.scrollDelta.x,
      y: h.carry.y + point.y - h.origin.y + h.scrollDelta.y,
    }
    const self = elements.current.get(h.base[h.from])
    if (self !== undefined) {
      self.style.translate = translateOf(h.followed)
      // **速度に応じた傾き**（設計§15-7）。基準の1度に、横速度に比例した傾きを足す
      const swing = clamp(velocityOf(h.samples, now).x * TILT_SWING_DEG_PER_PX_S, TILT_SWING_MAX_DEG)
      self.style.setProperty('--reorder-swing', `${swing}deg`)
    }
  }, [])

  /** 落とし先を決め直し、変わっていれば押しのけられる側の行き先を書く */
  const 判定する = useCallback((h: Held<T>, point: Point, now: number) => {
    /*
      **落とし先は「行→矩形→1歩→封印」で決める**（設計§15-3）。目標へ直接飛ばさず、
      1回の判定で動くのは隣の1枚だけ。直前に居た添字へは、指が 10px 動くか向きが
      1 rad 変わるまで戻さない——境界上で毎フレーム往復しないため。

      判定に渡す点は**凍結した座標系へ写した指**（スクロール差分を足す）。
    */
    const judged = { x: point.x + h.scrollDelta.x, y: point.y + h.scrollDelta.y }
    const result = dropTarget({
      rects: h.rects,
      point: judged,
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
  }, [])

  /*
    **端に指がある間だけ送る。掴んでいないときは回さない**（設計§15-12）。

    指を止めていても送り続ける（`pointermove` が来ないと止まる作りでは、端へ着いた
    瞬間に止まる）。送って**スクロールが変わったフレームだけ**、追従と判定をやり直す
    ——指は動いていなくても、凍結した座標系の中では指が動いている。端に着けば
    `scrollBy` が自然に止まり、再判定も止まる。
  */
  useEffect(() => {
    if (dragging === null) {
      return
    }
    let 生きている = true
    const 回す = () => {
      if (!生きている) {
        return
      }
      const h = held.current
      if (h !== null && h.last !== null) {
        const t = performance.now()
        /*
          **指を止めたら傾きは戻る。** 速度は直近 100ms の窓で測るので、標本が古びれば
          0 になる——`pointermove` が来なくても、フレームごとに読み直す
        */
        const self = elements.current.get(h.base[h.from])
        if (self !== undefined) {
          const swing = clamp(velocityOf(h.samples, t).x * TILT_SWING_DEG_PER_PX_S, TILT_SWING_MAX_DEG)
          self.style.setProperty('--reorder-swing', `${swing}deg`)
        }
        const box = scroller?.get() ?? null
        if (scroller !== undefined && box !== null) {
          const bounds = box.getBoundingClientRect()
          const step = autoScrollStep(h.last, {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
          })
          const along = scroller.axis === 'x' ? step.x : step.y
          if (送ってよいか(h, along)) {
            box.scrollBy(scroller.axis === 'x' ? along : 0, scroller.axis === 'y' ? along : 0)
          }
          const now = scrollOf(box)
          if (now.x !== h.scrollLast.x || now.y !== h.scrollLast.y) {
            h.scrollLast = now
            h.scrollDelta = { x: now.x - h.scroll0.x, y: now.y - h.scroll0.y }
            追従する(h, h.last, t)
          }
        }
        /*
          **判定はフレームごとにやり直す。** 1回の判定で動くのは1歩なので、指を大きく
          飛ばして止めたり、ホイールや自動送りで指の下のスロットが遠ざかったりすると、
          `pointermove` 頼みでは1歩手前で止まる。フレームごとなら 60歩/秒で追いつき、
          歩幅は変わらない（封印が往復を止める）。
        */
        判定する(h, h.last, t)
      }
      requestAnimationFrame(回す)
    }
    requestAnimationFrame(回す)
    return () => {
      生きている = false
    }
  }, [dragging, scroller, 追従する, 判定する, 送ってよいか])

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
      element.style.removeProperty('--reorder-swing')
      delete element.dataset.reorderSnap
      delete element.dataset.reorderSettling
    }
  }, [])

  /** 両方の条件が揃ったら印を降ろす */
  const 降ろせるなら降ろす = useCallback(() => {
    const 条件 = 降ろす条件.current
    if (!条件.timer || !条件.spring) {
      return
    }
    setReordering(false)
    書いたものを外す()
    // **印が降りたら、`RoamLayer` が場を測り直して1回だけ引き直す**（設計§15-1）
    lowerReordering(主.current)
  }, [書いたものを外す])

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
    const 相手 = バネの相手.current
    バネの相手.current = null
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
      if (相手 !== null && 相手.id === id) {
        /*
          **本人はバネで収める**（設計§15-7）。CSS の滑りではなく、離した瞬間の速度を
          初速に渡す。`data-reorder-settling` で前面に置き、`translate` の transition を
          切っておく（バネが毎フレーム書くので、滑らせると二重に動く）。
        */
        delete element.dataset.reorderSnap
        element.dataset.reorderSettling = 'true'
        降ろす条件.current.spring = false
        バネ.current?.stop()
        バネ.current = {
          id,
          stop: バネで収める(element, { x: dx, y: dy }, 相手.velocity, () => {
            バネ.current = null
            delete element.dataset.reorderSettling
            降ろす条件.current.spring = true
            降ろせるなら降ろす()
          }),
        }
        continue
      }
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
  }, [shown, dragging, 降ろせるなら降ろす])

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
    if (諦める予定.current !== null) {
      clearTimeout(諦める予定.current)
      諦める予定.current = null
    }
    setShown(null)
  }, [ids])

  // 外れるときに予定も印も、書いたものも残さない（掴んだまま画面が消えることがある）
  useEffect(() => {
    const 札 = 主.current
    return () => {
      if (降ろす予定.current !== null) {
        clearTimeout(降ろす予定.current)
      }
      if (諦める予定.current !== null) {
        clearTimeout(諦める予定.current)
      }
      lowerReordering(札)
    }
  }, [])

  /**
   * 印を、滑り終わってから降ろす。**同時に降ろすと持ち上げが戻る動きが瞬時に切れる。**
   * 本人がバネで収まる途中なら、その終わりも待つ（`降ろす条件`）。
   */
  const 滑り終わったら降ろす = useCallback(() => {
    降ろす条件.current.timer = false
    if (降ろす予定.current !== null) {
      clearTimeout(降ろす予定.current)
    }
    降ろす予定.current = setTimeout(() => {
      降ろす予定.current = null
      降ろす条件.current.timer = true
      降ろせるなら降ろす()
    }, REORDER_SETTLE_MS)
  }, [降ろせるなら降ろす])

  /**
   * 手元の並びを捨てて `ids` へ戻す（断られた・諦めた。設計§15-4）。
   *
   * いまの見え方を控えてから戻すので、React が DOM を並べ替えた直後に着地の FLIP が
   * 走り、**全員が元の場所へ滑って戻る**。理由の表示はフックの仕事ではない（呼び元が
   * `onCommit` の戻り値で出す）。
   */
  const 元へ戻す = useCallback(
    (generation: number) => {
      if (generation !== 世代.current || 返事待ち.current === null) {
        return
      }
      返事待ち.current = null
      if (諦める予定.current !== null) {
        clearTimeout(諦める予定.current)
        諦める予定.current = null
      }
      const 表 = new Map<T, Point>()
      for (const [id, element] of elements.current) {
        const box = element.getBoundingClientRect()
        表.set(id, { x: box.left, y: box.top })
      }
      控え.current = 表
      setReordering(true)
      raiseReordering(主.current)
      setShown(null)
      滑り終わったら降ろす()
    },
    [滑り終わったら降ろす],
  )

  /** 本人の見た目の左上。**矩形ではなく凍結した矩形＋`translate`**（倍率と傾きで箱が膨らむため） */
  const 位置を控える = useCallback((h: Held<T>) => {
    const 表 = new Map<T, Point>()
    for (const [id, element] of elements.current) {
      if (id === h.base[h.from]) {
        // 凍結した矩形はスクロール前の座標。箱が Δ 動いていれば、見た目はそのぶん戻る
        const rect = h.rects[h.from]
        表.set(id, {
          x: rect.left + h.followed.x - h.scrollDelta.x,
          y: rect.top + h.followed.y - h.scrollDelta.y,
        })
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
        世代.current += 1
        // 返事待ちの最中に掴み直したら、前の運びの返事はもう戻さない（土台にはする）
        if (諦める予定.current !== null) {
          clearTimeout(諦める予定.current)
          諦める予定.current = null
        }
        // **掴んだ瞬間の並びを土台にする。** 返事待ちの最中なら、見えている並びが土台
        const base = 返事待ち.current ?? ids
        const from = base.indexOf(id)
        if (from < 0) {
          return
        }
        /*
          **収まる途中に掴み直したら、バネを止めて付いていた `translate` を引き継ぐ**
          （設計§15-7）。見た目が飛ばない。
        */
        let carry = { x: 0, y: 0 }
        if (バネ.current !== null) {
          バネ.current.stop()
          if (バネ.current.id === id) {
            const element = elements.current.get(id)
            carry = parseTranslate(element?.style.translate ?? '')
          }
          バネ.current = null
        }
        降ろす条件.current = { timer: true, spring: true }
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
          followed: carry,
          carry,
          samples: [],
          last: null,
          scroll0: scrollOf(scroller?.get() ?? null),
          scrollLast: scrollOf(scroller?.get() ?? null),
          scrollDelta: { x: 0, y: 0 },
          holdBack: { x: 0, y: 0 },
        }
        // **掴んだ瞬間に帯の中なら、その帯に居続ける間は送らない**
        if (origin !== undefined && scroller !== undefined) {
          held.current.holdBack[scroller.axis] = Math.sign(送り量(origin))
        }
        // 引き継いだぶんを、測った直後に書き戻す（見た目が飛ばない）
        if (carry.x !== 0 || carry.y !== 0) {
          const self = elements.current.get(id)
          if (self !== undefined) {
            self.style.translate = translateOf(carry)
          }
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
        const now = performance.now()
        h.samples.push({ t: now, x: point.x, y: point.y })
        while (h.samples.length > SAMPLE_LIMIT || h.samples[0].t < now - VELOCITY_WINDOW_MS) {
          h.samples.shift()
        }
        h.last = point
        送ってよいか(h, 送り量(point))
        // ホイールで箱が動いていたら、ここで差分を取り込む（送りの輪が無いときのため）
        const box = scroller?.get() ?? null
        if (box !== null) {
          const current = scrollOf(box)
          h.scrollLast = current
          h.scrollDelta = { x: current.x - h.scroll0.x, y: current.y - h.scroll0.y }
        }
        // **本人は指に 1:1 で追従する**（設計§15-2）。React を経由せず、要素へ直接書く
        追従する(h, point, now)
        判定する(h, point, now)
      },
      onDrop: () => {
        const h = held.current
        held.current = null
        if (h === null) {
          return
        }
        const next = h.placement.map((at) => h.base[at])
        const 動いた = next.some((each, at) => each !== h.base[at])
        // 着地の逆算のために、離した瞬間の見え方を控える。本人は離した瞬間の速度でバネへ
        控え.current = 位置を控える(h)
        バネの相手.current = { id, velocity: velocityOf(h.samples, performance.now()) }
        elements.current.get(id)?.style.removeProperty('--reorder-swing')
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
        滑り終わったら降ろす()
        // **変わったときだけ送る。** 掴んで離しただけで書き込みが飛ぶと、
        // 押し間違いのたびにサーバが動く
        if (!動いた) {
          return
        }
        const generation = 世代.current
        if (諦める予定.current !== null) {
          clearTimeout(諦める予定.current)
        }
        諦める予定.current = setTimeout(() => {
          諦める予定.current = null
          元へ戻す(generation)
        }, ECHO_TIMEOUT_MS)
        Promise.resolve(onCommit(next)).then(
          (reason) => {
            if (reason !== null && reason !== undefined) {
              元へ戻す(generation)
            }
          },
          () => {
            元へ戻す(generation)
          },
        )
      },
    }),
    [
      ids,
      onCommit,
      scroller,
      位置を控える,
      書いたものを外す,
      滑り終わったら降ろす,
      元へ戻す,
      追従する,
      判定する,
      送り量,
      送ってよいか,
    ],
  )

  return {
    order: shown ?? ids,
    dragging,
    bind,
    itemRef,
    reordering,
  }
}
