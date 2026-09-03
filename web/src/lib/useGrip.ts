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
 * # WCAG 2.2 SC 2.5.7（ドラッグ以外の単一ポインタ手段）の満たし方
 *
 * **一覧のカードと枠は満たした**（2026-09-03・並べ替え設計§15-6）。掴んで運ぶ以外の道は
 * (1) 帯の「前へ／後ろへ」「上へ／下へ」（`TileGrid.tsx`。1つ選んでいるときだけ）、
 * (2) Space で選び Enter で開く（`usePress.ts`）。**ここ（掴む作法）に道は無い**——
 * 見に行く先は上の2つ。
 *
 * **区画（PJT 専用画面の横並び）は保留**（設計§15-10）。区画には「選ぶ」も帯も無いので
 * 同じ形が置けない。記録は `ReorderHandle.tsx` の冒頭にある。
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
  /** 掴んだ。**DOM を動かすならここ**（キャプチャはこの後で取る）。引数は押した点（握り点） */
  onGrab: (origin?: Point) => void
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
    /**
     * **運びと終わりは窓で受けるので、ここには置かない。**
     *
     * 要素の上で受けると、掴む前に指が外へ出たときに届かない。窓なら届くうえ、
     * **`click` の行き先も変わらない**（キャプチャを早く取ると `click` が
     * キャプチャした要素へ飛び、中身の押し分けが効かなくなる）。
     */
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
      onGrab(now.origin)
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

  /**
   * 運ぶ。**窓（`window`）から呼ばれる。**
   *
   * 要素の上で受けないのは、**掴む前に指が外へ出ると届かなくなる**ため。
   */
  const 動かす = useCallback(
    (event: PointerEvent) => {
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
      /*
        **前の運びの印を、ここで捨てる。**

        `onClickCapture` は「運んだ直後の `click`」を1回だけ捨てるが、
        **指で運んだときは `click` がそもそも飛ばないことがある**（`touchmove` を
        止めているため合成の `click` が抑えられる）。捨て損ねた印が残ると、
        **次のタップが1回だけ食われる**——押しても何も起きないので、
        壊れているのと見分けが付かない。

        押し直した時点で「直後」ではなくなるので、ここで落とすのが正しい。
      */
      運んだ.current = false
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
        return
      }

      /*
        **運びと終わりは窓（`window`）で受ける。要素の上では受けない。**

        `move` と `hold` は押した時点ではまだ掴まない。**掴まないあいだに指やマウスが
        要素の外へ出ると、要素へ届く `pointermove` が来なくなる**——1回目の移動で
        いきなり隣の枠まで飛ぶ運び方をすると、**握る機会そのものが来ない**
        （E2E で枠が1つも動かなかった）。

        **ここでキャプチャを取ってはいけない。** 一度そう直したが、**続く `click` が
        キャプチャした要素へ飛ぶ**ので、中身に付いている押し分け（選ぶ・開く）が
        丸ごと効かなくなった——**カードを押して始まるテストが24本落ちた**。

        窓で受ければ、要素の外へ出ても届き、`click` の行き先も変わらない。
        **キャプチャは掴んだあとだけ**取る（`掴む()` の中）——そこから先は運びであって
        押し分けではないので、`click` を奪って構わない。
      */
      const 窓で受ける = (native: Event) => {
        const pointer = native as PointerEvent
        if (native.type === 'pointermove') {
          動かす(pointer)
          return
        }
        if (held.current !== null && held.current.pointerId !== pointer.pointerId) {
          return
        }
        stop()
      }
      window.addEventListener('pointermove', 窓で受ける)
      window.addEventListener('pointerup', 窓で受ける)
      window.addEventListener('pointercancel', 窓で受ける)
      const 前の後始末 = now.detach
      now.detach = () => {
        前の後始末?.()
        window.removeEventListener('pointermove', 窓で受ける)
        window.removeEventListener('pointerup', 窓で受ける)
        window.removeEventListener('pointercancel', 窓で受ける)
      }
    },
    [enabled, when, 掴む, stop, 動かす],
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
      /*
        **止める契機は3つある**（`pointerup` ／ `pointercancel` ／
        `lostpointercapture`）。前の2つは窓で受けるので、ここに残るのは3つ目だけ。
      */
      onLostPointerCapture: stop,
      onClickCapture,
    },
  }
}
