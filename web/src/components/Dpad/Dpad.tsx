/**
 * 方向キーの代わりになる十字ボタン（十字ボタン設計§7・§12）。
 *
 * # 素の `<button>` を5つ、隙間なく並べる
 *
 * 単一要素の角度ゾーン方式は採らない。あれが解く弱点は2つとも本件では消えるため——
 * **隙間は作らなければ生まれず**、「なぞって方向を変える」は支えないと決めれば要らない
 * （方向は押した瞬間に発火して連射するので、変えたいなら離して押し直すほうが速い）。
 *
 * なぞりを支えないので、**タッチでは `pointerleave` が来ない**という問題自体が発生しない。
 * そして「素の `<button>` を5個」というアクセシビリティの要求ともそのまま両立する。
 *
 * # 逆T字にする
 *
 * ```
 * ┌───────────────┐
 * │       ▲       │  ← 上段まるごと
 * ├─────┬───┬─────┤
 * │  ◀  │ ⏎ │  ▶  │
 * ├─────┴───┴─────┤
 * │       ▼       │  ← 下段まるごと
 * └───────────────┘
 * ```
 *
 * 上下が行をまるごと占めるので、隙間が1ピクセルも生まれない。**中央の `⏎` だけは
 * セルより一回り小さく置く**——余った縁はどのボタンにも属さないので、そこを押しても
 * 何も起きない。これが「決定は見た目より狭く」の実体になる。
 *
 * # 発火の作法を、方向と決定で逆にする
 *
 * 誤爆のコストが非対称だから。方向は押し間違えても押し直せるが、**決定は権限承認や
 * メニュー確定が走って取り消せない**。
 *
 * | | 発火 | 当たり判定 |
 * |---|---|---|
 * | 方向 | `pointerdown`（＋連射） | 見た目より広い（行をまるごと） |
 * | 中央 | `pointerup` | 見た目より狭い（周囲に不活性の縁） |
 *
 * # 寸法は実機で決め直す
 *
 * **CSS px は実機では公称の6割しかない**（調査レポート §3-6）ので、24px は約 4mm ＝
 * 指の腹より小さい。ここに置いてあるのは出発点で、確定は実機（設計§16-4）。
 * 直したときは**この定数と設計§7 の表と単体テストの期待値の3つ**を揃えること。
 */

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { bindRepeater, createRepeater, type Repeater } from '@/lib/repeat'
import type { TerminalKey } from '@/lib/keys'

/** 1マスの大きさ（CSS px）。**実機で決め直す**（設計§16-4）。 */
export const DPAD_CELL_PX = 60

/** 中央の決定ボタンの大きさ。**マスより小さいぶんが不活性の縁になる。** */
export const DPAD_CONFIRM_PX = 44

/**
 * 触り方の指定。**ボタン自身にだけ当てる**——コンテナや `body` に当てると
 * ページ全体のピンチズームが死ぬ。
 *
 * クラス名ではなく素のスタイルで書いてあるのは、**綴りを間違えても黙って効かなくなる
 * 指定**だからで、こうしておけば単体テストから実際の値を読める（`TerminalPane` の
 * `touchAction` と同じ判断）。
 */
const TOUCH_STYLE: CSSProperties = {
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
  WebkitTapHighlightColor: 'transparent',
  // 横向きでは端末の上へ重ねる。**層は素通し、押せるのはボタンだけ**（設計§10）。
  // 縦のときは重ねていないので、この指定は何も変えない
  pointerEvents: 'auto',
}

const BUTTON_CLASS =
  'border-border bg-background/95 text-foreground flex items-center justify-center border text-lg leading-none transition-colors duration-150'

/** 押している間の見た目。**`:active` は使わない**（iOS では発火しない）。 */
const PRESSED_CLASS = 'dpad-pressed bg-accent scale-[0.94] duration-0'

interface Props {
  /** 押されたキーを送る先。**バイト列は知らない**（設計§5） */
  onKey: (key: TerminalKey) => void
}

export function Dpad({ onKey }: Props) {
  return (
    <div
      // `role="toolbar"` は使わない——矢印キーでフォーカスを移す慣習と正面衝突する
      // （ボタンの名前が矢印キーそのものなので、意味の反転が起きる）
      role="group"
      aria-label="方向キー"
      data-testid="dpad"
      className="grid w-fit gap-0"
      style={{
        gridTemplateColumns: `repeat(3, ${DPAD_CELL_PX}px)`,
        gridTemplateRows: `repeat(3, ${DPAD_CELL_PX}px)`,
      }}
    >
      <Direction label="上" glyph="▲" onFire={() => onKey('up')} wide />
      <Direction label="左" glyph="◀" onFire={() => onKey('left')} />
      <Confirm onFire={() => onKey('enter')} />
      <Direction label="右" glyph="▶" onFire={() => onKey('right')} />
      <Direction label="下" glyph="▼" onFire={() => onKey('down')} wide />
    </div>
  )
}

/**
 * 方向キー1つ。**押した瞬間に発火し、押しっぱなしで連射する。**
 *
 * 止める契機は [`bindRepeater`] が持っている。ここで `pointerup` を自前に書き直さない
 * こと——契機ごとに1本ずつ落ちるようにしてある壊し方が潰れる。
 */
function Direction({
  label,
  glyph,
  onFire,
  wide = false,
}: {
  label: string
  glyph: string
  onFire: () => void
  /** 上下は行をまるごと占める（隙間を作らないため） */
  wide?: boolean
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const repeaterRef = useRef<Repeater | null>(null)
  const [pressed, setPressed] = useState(false)
  // 連射の途中で差し替わっても、いつも最新の送り先へ届くようにする
  const fire = useRef(onFire)
  fire.current = onFire

  useEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const repeater = createRepeater({
      fire: () => fire.current(),
      now: () => Date.now(),
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: (handle) => window.clearTimeout(handle),
      // 背面のタブは減速するだけで止まらないので、ティックごとに見る
      hidden: () => document.hidden,
    })
    repeaterRef.current = repeater
    const unbind = bindRepeater(element, repeater)
    return () => {
      unbind()
      repeaterRef.current = null
    }
  }, [])

  return (
    <button
      ref={ref}
      type="button"
      // 十字は物理キーの矢印の代わりなので、Tab の順に4つ割り込ませる意味が無い
      tabIndex={-1}
      aria-label={label}
      data-testid={`dpad-${label}`}
      data-pressed={pressed ? 'true' : 'false'}
      className={`${BUTTON_CLASS} ${pressed ? PRESSED_CLASS : ''}`}
      style={{ ...TOUCH_STYLE, ...(wide ? { gridColumn: '1 / -1' } : {}) }}
      // 端末からフォーカスを奪わない
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={() => {
        setPressed(true)
        buzz()
        repeaterRef.current?.start()
      }}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
    >
      <span aria-hidden>{glyph}</span>
    </button>
  )
}

/**
 * 中央の決定。**離した瞬間に発火する。**
 *
 * # 押してから指をずらすと取りやめられる
 *
 * そのためには `pointerup` が**指の下の要素**へ届く必要がある。ところがタッチは
 * `pointerdown` の時点で**暗黙のポインタキャプチャ**が効いており、放っておくと
 * ずらしても元のボタンへ届いてしまう。押した瞬間に明示的に解く。
 *
 * `releasePointerCapture` は **jsdom に無い**ので `?.()` で呼ぶ。
 */
function Confirm({ onFire }: { onFire: () => void }) {
  const [pressed, setPressed] = useState(false)

  return (
    <div className="flex items-center justify-center">
      <button
        type="button"
        tabIndex={-1}
        aria-label="決定"
        data-testid="dpad-決定"
        data-pressed={pressed ? 'true' : 'false'}
        className={`${BUTTON_CLASS} rounded-full ${pressed ? PRESSED_CLASS : ''}`}
        style={{
          ...TOUCH_STYLE,
          width: `${DPAD_CONFIRM_PX}px`,
          height: `${DPAD_CONFIRM_PX}px`,
        }}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          setPressed(true)
          event.currentTarget.releasePointerCapture?.(event.pointerId)
        }}
        onPointerCancel={() => setPressed(false)}
        onPointerUp={() => {
          setPressed(false)
          buzz()
          onFire()
        }}
      >
        <span aria-hidden>⏎</span>
      </button>
    </div>
  )
}

/**
 * 押した手応え。**iOS では諦める**——Vibration API は非対応で、代替のトリックも
 * 2026-05 に塞がれた（調査レポート §4-1）。Android でだけ短く1回鳴る。
 */
function buzz() {
  navigator.vibrate?.(10)
}
