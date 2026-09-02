/**
 * 掴んで運ぶためのポインタの作法（並べ替え設計§3-3）。
 *
 * # ここが唯一の持ち主
 *
 * もとは掴み手（`ReorderHandle`）が抱えていた。本体（カード・PJT枠）でも掴めるように
 * したので、**同じ作法を2箇所に書かないため**に取り出してある。**掴み手と本体は、
 * 同じこの関数を通る。**
 *
 * # 踏襲する7つ（実機で1つずつ踏んで決まった作法。思いつきで変えない）
 *
 * - **1回目の `pointermove` で握る**（`preventDefault()` が効くのは `cancelable` が
 *   真のあいだだけ。「しきい値を超えてから握る」は成立しない）
 * - 止める契機は `pointerup` ／ `pointercancel` ／ `lostpointercapture` の**3つ**を
 *   **1つずつ別の行**に書く
 * - **`pointerleave` は使わない**（タッチは暗黙のキャプチャが効いていて発火しない）
 * - `setPointerCapture` は `?.()` で呼ぶ（jsdom に無い）
 * - **二本目の指で乗っ取らない**
 * - 掴んでいる間は `document.body` の `user-select` を控えて戻す
 * - **`setPointerCapture()` は、DOM を動かした「後」に呼ぶ**（方針§4-2）。並べ替えは
 *   DOM を動かす操作そのものなので、先に呼ぶと**動かした拍子に要素を見失う**
 *
 * `touch-action: none` だけは**ここへ移していない**。あれは「掴み手だけが持ってよい」
 * ものだからで、本体に付けると**一覧の縦スクロールが死ぬ**（下記）。
 *
 * # 「いつ掴むか」だけが違う
 *
 * | 何 | いつ掴むか | なぜ |
 * |---|---|---|
 * | `press` | `pointerdown` で即 | 掴み手は**押すこと自体に他の意味が無い** |
 * | `move` | 3px 動いたら | 本体をマウスで押すことには「選ぶ／開く」がある |
 * | `hold` | `arm()` が呼ばれるまで掴まない | 本体を指で押すと、長押しで初めて掴む |
 *
 * # 指のときは、押した瞬間に握って、掴むまで1本も止めない
 *
 * `touch-action` はジェスチャの開始時に評価されるので、**途中で書き換えても効かない**。
 * かといって最初から `none` にすると縦スクロールが死ぬ。そこで `{ passive: false }` の
 * `touchmove` を**押した瞬間に張り**、**止めるかどうかは掴んでから決める**
 * （`TerminalPane` と同じ形）。
 *
 * **成立してから張っては間に合わない。** effect でも `setTimeout` でも1フレーム遅れ、
 * その隙に入った `touchmove` でページが流れ始める。
 *
 * 張り先は**掴む要素そのもの**。`document` や `body` に当てると、ページ全体の
 * ピンチズームが死ぬ（`Dpad` の判断）。
 *
 * # 満たしていない基準（`DESIGN.md` §35.1 の作法で残す）
 *
 * **WCAG 2.2 SC 2.5.7（ドラッグ以外の単一ポインタ手段）に適合していない。**
 * 並べ替えは掴んで運ぶ以外の道が無く、**キーボードでも、押すだけの操作でも
 * 並べ替えられない**。
 *
 * **しかも後退した。** カードと PJT枠から掴み手を外したので（利用者の指定・2026-09-03）、
 * 「押すだけで動かす」道の芽そのものが無くなっている。
 *
 * **承知のうえで、いまは決めていない**（並べ替え設計§13）。**「できなくてよい」と
 * 決めたのではない**——必要になったときに別のイシューとして起こす。起こすなら、
 * 上下へ動かすボタンか、キーボードで掴んで矢印で動かす形になる。
 *
 * **消さないこと。** ここを消すと、次に読む人には「満たしている」と読める。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { passedThreshold, type Point } from './reorder'

/** いつ掴むか。**押した瞬間に1回だけ決める**（途中で変えない）。 */
export type GrabWhen = 'press' | 'move' | 'hold'

/**
 * 掴ませない目印。**掴める本体の中にあるボタン**（復旧・＋・×）へ付ける。
 *
 * 本体で掴めるようにすると、中のボタンを押しただけでも掴んでしまう。`click` を
 * 止めるだけでは足りない——**`pointerdown` は別に止める必要がある**。
 */
export const NO_GRAB_ATTR = 'data-no-grab'

interface Options {
  /** 掴めるか。偽なら合図を1つも出さない（記録を持たない枠） */
  enabled?: boolean
  /** いつ掴むか。**押した瞬間に1回だけ聞く** */
  when: (event: ReactPointerEvent) => GrabWhen
  /** 掴んだ。**DOM を動かすならここ**（キャプチャはこの後で取る） */
  onGrab: () => void
  /** 運んでいる。座標をそのまま渡す（決めるのは `lib/reorder.ts` の純関数） */
  onMove: (point: Point) => void
  /** 離した・取り消された */
  onDrop: () => void
  /** **掴まずに離した**（＝叩いた）。`press` のときだけ意味を持つ */
  onTap?: () => void
}

interface Held {
  pointerId: number
  origin: Point
  when: GrabWhen
  /** 掴んだか。`move` と `hold` は押した時点ではまだ掴んでいない */
  grabbed: boolean
  /** しきい値を超えて動かしたか */
  moved: boolean
  element: Element
  /** 指のときだけ張る、`{ passive: false }` の `touchmove` */
  detach: (() => void) | null
}

export interface Grip {
  /** いま運んでいるか。**掴んでいる本人だけ** */
  dragging: boolean
  /** 長押しが成立した合図。**`hold` のときだけ効く** */
  arm: () => void
  handlers: {
    onPointerDown: (event: ReactPointerEvent) => void
    onPointerMove: (event: ReactPointerEvent) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onLostPointerCapture: () => void
    /** **運んだ直後の `click` を1回だけ捨てる** */
    onClickCapture: (event: {
      stopPropagation: () => void
      preventDefault: () => void
    }) => void
  }
}

export function useGrip({
  enabled = true,
  when,
  onGrab,
  onMove,
  onDrop,
  onTap,
}: Options): Grip {
  const [dragging, setDragging] = useState(false)
  const held = useRef<Held | null>(null)
  /** 直前の運びで実際に動かしたか。**続く `click` を捨てるためだけに持つ** */
  const 運んだ = useRef(false)

  const stop = useCallback(() => {
    const now = held.current
    if (now === null) {
      // 何度呼ばれてもよい形にしておく。`pointerup` のあとブラウザがキャプチャを
      // 自動で解くので、`lostpointercapture` が続けて飛ぶ
      return
    }
    held.current = null
    now.detach?.()
    if (!now.grabbed) {
      // 掴む前に離した。**運びは始まっていないので、落とす合図も出さない**
      return
    }
    setDragging(false)
    運んだ.current = now.moved
    onDrop()
    // **一度も動かさずに離したら「叩いた」。** 長押しの抑止が効かない端末への保険
    if (!now.moved) {
      onTap?.()
    }
  }, [onDrop, onTap])

  /** 掴む。**DOM を動かしてから、キャプチャを取る**（方針§4-2） */
  const 掴む = useCallback(
    (now: Held) => {
      now.grabbed = true
      setDragging(true)
      onGrab()
      // jsdom に無い。**取れないときも、テストは要素へ直接配るので結果は変わらない**
      ;(
        now.element as Element & {
          setPointerCapture?: (id: number) => void
        }
      ).setPointerCapture?.(now.pointerId)
    },
    [onGrab],
  )

  /*
    **引っぱるたびに周りの文字が選択されるのを防ぐ。** 掴んでいる要素ではなく `body` に
    当てるのは、選択が始まるのが**その外**（隣のカードの文字）だから。掴んでいる間
    だけで、離すと元へ戻す（元の値を控えて戻すので、他が当てていても壊さない）
  */
  useEffect(() => {
    if (!dragging) {
      return
    }
    const 控え = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.userSelect = 控え
    }
  }, [dragging])

  // 外れるときに握りを残さない（押したまま画面が消えることがある）
  useEffect(() => {
    return () => {
      held.current?.detach?.()
      held.current = null
    }
  }, [])

  const arm = useCallback(() => {
    const now = held.current
    if (now === null || now.when !== 'hold' || now.grabbed) {
      return
    }
    掴む(now)
  }, [掴む])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (!enabled || held.current !== null) {
        // 掴めない、または既に別の指が掴んでいる。二本目で乗っ取らない
        return
      }
      if (
        event.target instanceof Element &&
        event.target.closest(`[${NO_GRAB_ATTR}]`) !== null
      ) {
        // 掴める本体の中のボタン。**押しても掴まない**
        return
      }
      const element = event.currentTarget
      const now: Held = {
        pointerId: event.pointerId,
        origin: { x: event.clientX, y: event.clientY },
        when: when(event),
        grabbed: false,
        moved: false,
        element,
        detach: null,
      }
      held.current = now

      /*
        指のときだけ、`{ passive: false }` の `touchmove` を**押した瞬間に**張る。
        **掴む前は1本も止めない**ので、長押しが成立しなければ縦スクロールは普通に効く。
      */
      if (event.pointerType !== 'mouse') {
        // **`Event` で受ける。** `Element` の型表には `touchmove` が無く、
        // 使うのは `cancelable` と `preventDefault()` だけなので素の `Event` で足りる
        const 指を止める = (touch: Event) => {
          if (held.current?.grabbed !== true) {
            return
          }
          if (!touch.cancelable) {
            // もうページが流れ始めている。**譲る**——運びとスクロールを同時に走らせない
            stop()
            return
          }
          touch.preventDefault()
        }
        element.addEventListener('touchmove', 指を止める, { passive: false })
        now.detach = () => {
          element.removeEventListener('touchmove', 指を止める)
        }
      }

      if (now.when === 'press') {
        掴む(now)
      }
    },
    [enabled, when, 掴む, stop],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const now = held.current
      if (now === null || now.pointerId !== event.pointerId) {
        return
      }
      // **1回目で握る。** しきい値を待つと2回目から `cancelable` が偽になり、
      // 以後どれだけ呼んでも効かない（設計§3-3）
      if (event.cancelable) {
        event.preventDefault()
      }
      const dx = event.clientX - now.origin.x
      const dy = event.clientY - now.origin.y
      const 超えた = passedThreshold(dx, dy)
      if (!now.grabbed) {
        /*
          **`hold` はしきい値を見ない。** 見ると、長押しの計測（8px で捨てる）より
          先に 3px で掴んでしまい、**なぞってスクロールするつもりが運びになる**。
          `hold` が掴むのは `arm()` が呼ばれたときだけ。
        */
        if (now.when !== 'move' || !超えた) {
          return
        }
        掴む(now)
      }
      if (!now.moved && !超えた) {
        // 握ってはいるが、まだ動かさない。**握るかどうかとは別の判断**
        return
      }
      now.moved = true
      // **測るのは呼び元。** 決めるのは `lib/reorder.ts` の純関数（設計§3-4）
      onMove({ x: event.clientX, y: event.clientY })
    },
    [掴む, onMove],
  )

  const onClickCapture = useCallback(
    (event: { stopPropagation: () => void; preventDefault: () => void }) => {
      if (!運んだ.current) {
        return
      }
      /*
        **運んだ直後の `click` を1回だけ捨てる。**

        本体で掴めるようにすると、離したときに `click` が続けて飛ぶ。捨てないと
        **並べ替えるたびに選択が入れ替わる**（マウスのシングルは「選ぶ」なので）。
        `capture` 相で走らせるのは、押し分け（`usePress`）より先に止めるため。
      */
      運んだ.current = false
      event.stopPropagation()
      event.preventDefault()
    },
    [],
  )

  return {
    dragging,
    arm,
    handlers: {
      onPointerDown,
      onPointerMove,
      /*
        **契機を1つずつ別の行に書く。** まとめると、1通り壊しただけで全部落ちて、
        テストが何本ぶんの働きをしているのか分からなくなる
      */
      onPointerUp: stop,
      onPointerCancel: stop,
      onLostPointerCapture: stop,
      onClickCapture,
    },
  }
}
