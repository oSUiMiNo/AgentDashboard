/**
 * 掴んで並べ替えるための掴み手（並べ替え設計§3-1〜§3-3）。
 *
 * # 配線は `FilesResizer` から踏襲する
 *
 * ポインタの扱いは**実機で1つずつ踏んで決まった作法**なので、思いつきで変えない
 * （設計§3-3）。踏襲するのは次の7つ。
 *
 * - **1回目の `pointermove` で握る**（`preventDefault()` が効くのは `cancelable` が
 *   真のあいだだけ。「しきい値を超えてから握る」は成立しない）
 * - `touch-action: none` を**素のスタイル**で当てる（指定しないと3回目から落ちる）
 * - 止める契機は `pointerup` ／ `pointercancel` ／ `lostpointercapture` の**3つ**を
 *   **1つずつ別の行**に書く
 * - **`pointerleave` は使わない**（タッチは暗黙のキャプチャが効いていて発火しない）
 * - `setPointerCapture` は `?.()` で呼ぶ（jsdom に無い）
 * - **二本目の指で乗っ取らない**
 * - 掴んでいる間は `document.body` の `user-select` を控えて戻す
 *
 * # この工事で新しいもの
 *
 * **`setPointerCapture()` は、DOM を動かした「後」に呼ぶ**（方針§4-2）。並べ替えは
 * DOM を動かす操作そのものなので、先に呼ぶと**動かした拍子に要素を見失う**。
 * ここでは `onGrab()` を呼んでからキャプチャを取る順序で、それを守っている。
 *
 * **落とし先はホバーで検出しない。** キャプチャ中は `pointerover` / `pointerenter` /
 * `pointerleave` / `pointerout` が飛ばないので、ホバーに頼った実装は動かない。
 * 落とし先は座標から決める（`lib/reorder.ts`）。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useCoarsePointer } from '@/lib/pointer'
import { passedThreshold, type Point } from '@/lib/reorder'

/** マウスでの当たり判定（px）。`FilesResizer` と同じ値を、同じ理由で採る。 */
export const HANDLE_HIT_PX = 8

/**
 * 指で触る端末での当たり判定（px）。
 *
 * 根拠は `DESIGN.md` §24.3（Mobile / Touch 48〜60px）と、`一覧のカードのレイアウトを
 * 変える` が復旧ボタンで採った「指で押す部品は 44px」。**実機で決め直す**（フェーズ6）。
 */
export const HANDLE_HIT_COARSE_PX = 44

/**
 * 触り方の指定。**クラス名ではなく素のスタイルで書く**——綴りを間違えても黙って
 * 効かなくなる指定なので、単体テストから実値を読めるようにしておく。
 */
const GRIP_STYLE: CSSProperties = {
  touchAction: 'none',
  WebkitTapHighlightColor: 'transparent',
}

interface Grip {
  pointerId: number
  origin: Point
  moved: boolean
}

interface Props {
  /** 読み上げ用の名前。「〇〇を掴んで並べ替える」 */
  label: string
  /** 何の並びか。`data-kind` にそのまま出る（`project` ／ `card`） */
  kind: 'project' | 'card'
  /** 掴んだ。**DOM を動かすならここで動かす**（キャプチャはこの後で取る） */
  onGrab: () => void
  /** 運んでいる。座標をそのまま渡す（決めるのは `lib/reorder.ts` の純関数） */
  onMove: (point: Point) => void
  /** 離した・取り消された */
  onDrop: () => void
}

export function ReorderHandle({ label, kind, onGrab, onMove, onDrop }: Props) {
  // **幅では判定しない**（`lib/pointer.ts` 冒頭）。タッチ対応 PC も折りたたみもある
  const coarse = useCoarsePointer()
  const [dragging, setDragging] = useState(false)
  const grip = useRef<Grip | null>(null)

  const stop = useCallback(() => {
    if (grip.current === null) {
      // 何度呼ばれてもよい形にしておく。`pointerup` のあとブラウザがキャプチャを
      // 自動で解くので、`lostpointercapture` が続けて飛ぶ
      return
    }
    grip.current = null
    setDragging(false)
    onDrop()
  }, [onDrop])

  /*
    **引っぱるたびに周りの文字が選択されるのを防ぐ。** 掴み手そのものではなく `body` に
    当てるのは、選択が始まるのが**掴み手の外**（隣のカードの文字）だから。掴んでいる間
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

  const hit = coarse ? HANDLE_HIT_COARSE_PX : HANDLE_HIT_PX

  return (
    <button
      type="button"
      aria-label={label}
      data-testid="reorder-handle"
      data-kind={kind}
      data-dragging={dragging ? 'true' : 'false'}
      className="grid shrink-0 cursor-grab place-items-center rounded text-slate-500 hover:text-slate-200 active:cursor-grabbing"
      // 当たり判定は指かマウスかで変わるので、クラスではなく素のスタイルで渡す
      style={{ ...GRIP_STYLE, minWidth: `${hit}px`, minHeight: `${hit}px` }}
      onPointerDown={(event) => {
        if (grip.current !== null) {
          // 既に別の指が掴んでいる。二本目で乗っ取らない
          return
        }
        grip.current = {
          pointerId: event.pointerId,
          origin: { x: event.clientX, y: event.clientY },
          moved: false,
        }
        setDragging(true)
        // **DOM を動かすのはここ。** キャプチャはこの後で取る（方針§4-2）——
        // 先に取ると、動かした拍子に要素を見失う
        onGrab()
        // jsdom に無い。**取れないときも、テストは要素へ直接配るので結果は変わらない**
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }}
      onPointerMove={(event) => {
        const held = grip.current
        if (held === null || held.pointerId !== event.pointerId) {
          return
        }
        // **1回目で握る。** しきい値を待つと2回目から `cancelable` が偽になり、
        // 以後どれだけ呼んでも効かない（設計§3-3）
        if (event.cancelable) {
          event.preventDefault()
        }
        const dx = event.clientX - held.origin.x
        const dy = event.clientY - held.origin.y
        if (!held.moved && !passedThreshold(dx, dy)) {
          // 握ってはいるが、まだ動かさない。**握るかどうかとは別の判断**
          return
        }
        held.moved = true
        // **測るのは呼び元。** 決めるのは `lib/reorder.ts` の純関数（設計§3-4）
        onMove({ x: event.clientX, y: event.clientY })
      }}
      /*
        **契機を1つずつ別の行に書く。** まとめると、1通り壊しただけで全部落ちて、
        テストが何本ぶんの働きをしているのか分からなくなる
      */
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
    >
      {/*
        掴めることを示す印。**6つの点**——「掴んで動かせる」を表す形として広く通じており、
        矢印（向きを示す）とも `☰`（一覧を出す）とも取り違えられない
      */}
      <svg
        viewBox="0 0 10 16"
        aria-hidden="true"
        className="h-4 w-2.5"
        fill="currentColor"
      >
        <circle cx="3" cy="3" r="1.4" />
        <circle cx="7" cy="3" r="1.4" />
        <circle cx="3" cy="8" r="1.4" />
        <circle cx="7" cy="8" r="1.4" />
        <circle cx="3" cy="13" r="1.4" />
        <circle cx="7" cy="13" r="1.4" />
      </svg>
    </button>
  )
}
