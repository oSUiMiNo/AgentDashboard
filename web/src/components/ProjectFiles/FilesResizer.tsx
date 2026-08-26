/**
 * 幅を変える縁（設計§4）。**フォルダのオーバーレイと中身の列が同じものを使う。**
 *
 * # 判断はここに置かない
 *
 * 「いまの幅と指の移動量から次の幅を決める」規則は [`@/lib/panelWidth`] にある純関数で、
 * ここがやるのは配線と採寸だけ。jsdom は要素の幅を常に 800・左端を常に 0 で返すので
 * （`test/setup.ts`）、**測る側と決める側が同じ関数に居ると、テストを書いても縮退した
 * 同じ数字しか通らない**（設計§4）。
 *
 * # 握り方
 *
 * `.claude/docs/guideline.md`「ブラウザ側のストアを触るとき」の実測を、そのまま実装
 * 仕様にしてある。
 *
 * | 決めごと | なぜ |
 * |---|---|
 * | **1回目の `pointermove` で握る** | `preventDefault()` が効くのは `cancelable` が真のあいだだけ。1回目で握らないと2回目から偽になる |
 * | `touch-action: none` | 指定しないと、1回目に握っても3回目から落ちる |
 * | しきい値は「幅を動かすかどうか」にだけ使う | 握るかどうかは1回目に決まっているので、役割を分ける |
 * | 止める契機は `pointerup` ／ `pointercancel` ／ `lostpointercapture` の3つ | 止め損ねると、指を離したのに幅が追いかけ続ける |
 * | `pointerleave` は使わない | タッチは `pointerdown` の時点で暗黙のキャプチャが効いており、発火しない |
 *
 * # `setPointerCapture` は**取る**
 *
 * このリポジトリに取る前例は無い（`Dpad.tsx` は逆に `releasePointerCapture` で解いて
 * いる——押した先から指をずらして取りやめられるようにするため）。それでも取るのは、
 * **取らないと `lostpointercapture` が一度も飛ばない**から——上の表の3つ目が、
 * 書いてあるだけで効いていない状態になる。
 *
 * 取ったうえで `pointermove` と止める契機を**すべてこの要素に張る**。タッチは元から
 * 暗黙のキャプチャでこの要素へ届くので、マウスにも同じ経路を通すことになり、
 * **入力方式で分岐しない1本の道**になる。`window` へ張る形は採らない——外す契機を
 * 3つとアンマウントぶん自前で数えることになり、取り外し漏れの面が広い。
 *
 * jsdom には `setPointerCapture` が無いので `?.()` で呼ぶ（実測）。**テストでは
 * `fireEvent` がこの要素へ直接配るので、キャプチャの有無は結果を変えない。**
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { passedThreshold, widthFromDrag, type PanelEdge } from '@/lib/panelWidth'
import { useCoarsePointer } from '@/lib/pointer'

/**
 * 縁の当たり判定の幅（CSS px）。**見た目は 1px の線だが、掴める範囲は見た目より広く取る**
 * （設計§4）。
 *
 * **実機で決め直す**（設計§11）——細すぎると掴めず、太すぎると邪魔になる。直したときは
 * ここと設計§4 と単体テストの期待値の3つを揃えること。
 */
export const RESIZER_HIT_PX = 8

/**
 * 指で触る端末での当たり判定。根拠は `DESIGN.md` §24.3（Mobile / Touch 48〜60px）
 * ——寸法をそのまま使うのではなく、「**指で押す的はマウスより大きく要る**」という
 * 規定があることを根拠にする。同じく実機で決め直す。
 */
export const RESIZER_HIT_COARSE_PX = 24

/**
 * 触り方の指定。**クラス名ではなく素のスタイルで書く**——綴りを間違えても黙って効かなく
 * なる指定なので、単体テストから実値を読めるようにしておく（`Dpad.tsx` の `TOUCH_STYLE`
 * と同じ判断）。
 */
const GRIP_STYLE: CSSProperties = {
  touchAction: 'none',
  WebkitTapHighlightColor: 'transparent',
}

interface Props {
  /** どちらの縁か。`data-edge` にそのまま出る */
  edge: PanelEdge
  /** いまの幅（px）。掴んだ時点の基準になる */
  width: number
  /** 読み上げ用の名前 */
  label: string
  /** 掴んだ。**ここから離すまで別のタブの合図を無視する**（設計§5） */
  onGrab: () => void
  /** 動かしている最中。**画面だけ変える。書かない**（設計§5） */
  onMove: (edge: PanelEdge, width: number) => void
  /** 離した。**ここでだけ書く**（設計§5） */
  onDrop: () => void
}

/** 掴んでいる指と、掴んだ時点の控え。`null` は掴んでいない。 */
interface Grip {
  pointerId: number
  /** 掴んだ位置（`clientX`） */
  x: number
  /** 掴んだ時点の幅 */
  width: number
  /** しきい値を超えたか。**一度超えたら戻さない**（超えたり戻ったりで幅が跳ねる） */
  moved: boolean
}

export function FilesResizer({
  edge,
  width,
  label,
  onGrab,
  onMove,
  onDrop,
}: Props) {
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
    **引っぱるたびに周りの文字が選択されるのを防ぐ**（設計§4）。縁そのものではなく
    `body` に当てるのは、選択が始まるのが**縁の外**（隣の本文）だから。掴んでいる間だけで、
    離すと元へ戻す（元の値を控えて戻すので、他が当てていても壊さない）
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

  const hit = coarse ? RESIZER_HIT_COARSE_PX : RESIZER_HIT_PX

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-testid="files-resizer"
      data-edge={edge}
      data-dragging={dragging ? 'true' : 'false'}
      /*
        **狭い画面には出さない**（設計§2）。両方とも全幅で被さるので、引っぱる縁が
        物理的に存在しない。`md` は JS から読まない——`hidden md:block` で足りる
      */
      className="group/resizer absolute inset-y-0 z-10 hidden cursor-col-resize md:block"
      // 当たり判定の幅と位置は指かマウスかで変わるので、クラスではなく素のスタイルで渡す
      style={{ ...GRIP_STYLE, width: `${hit}px`, right: `${-hit / 2}px` }}
      onPointerDown={(event) => {
        if (grip.current !== null) {
          // 既に別の指が掴んでいる。二本目で乗っ取らない
          return
        }
        grip.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          width,
          moved: false,
        }
        setDragging(true)
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
        // 以後どれだけ呼んでも効かない（設計§4）
        if (event.cancelable) {
          event.preventDefault()
        }
        const delta = event.clientX - held.x
        if (!held.moved && !passedThreshold(delta)) {
          // 握ってはいるが、まだ幅は動かさない。**握るかどうかとは別の判断**
          return
        }
        held.moved = true
        // **測るのはここ。** 決めるのは `panelWidth.ts` の純関数（設計§4）
        onMove(edge, widthFromDrag(edge, held.width, delta, globalThis.innerWidth))
      }}
      /*
        **契機を1つずつ別の行に書く。** まとめると、1通り壊しただけで全部落ちて、
        テストが何本ぶんの働きをしているのか分からなくなる（`lib/repeat.ts` の
        `bindRepeater` と同じ理由）
      */
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
    >
      {/*
        見せ方（設計§4）。Default は 1px の静かな線、Hover で Primary Accent が現れ、
        Dragging で太く明るくなる。**傾けたり拡大したりはしない**——`DESIGN.md` §27.5 の
        前2つは「物を掴んで運ぶ」ための候補で、境界線には意味を持たない
      */}
      <span
        aria-hidden
        className="bg-border group-hover/resizer:bg-primary group-data-[dragging=true]/resizer:bg-primary group-data-[dragging=true]/resizer:w-0.5 absolute inset-y-0 left-1/2 w-px -translate-x-1/2"
      />
    </div>
  )
}
