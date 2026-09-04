/**
 * スリープと復旧を1つにした電源ボタン（帯設計§15-1）。
 *
 * # なぜ `ui/` に居るのか
 *
 * **カードでも同じものを出す**（細かい修正 設計§2-1）。もともと `SessionView` の中に
 * 閉じていて外から使えなかったので、**同じ見た目を描き直す**しか道が無かった——
 * グラデーションと多重シャドウを持つ部品なので、写すと片方だけ直したときに気づけない。
 *
 * **CSS は `controls.css` のまま動かしていない。** あのファイルは「帯（数の少ない面）と
 * 小窓（数の多い面）は意図的に分離してある」と断っているが、**分けているのは配置の作法で
 * あって、ボタンの見た目そのものではない**。`controls.css` は `index.css` から取り込まれて
 * 全画面に効くので、**クラス名を付けるだけで足りる**。
 *
 * **帯（まとめて操作）の電源とは別物のまま。** あちらは「選んだうちの何枚に効くか」を
 * 持つ。共有しているのは `PowerGlyph` だけである。
 */

import { useEffect, useRef, useState } from 'react'

import { PowerGlyph } from '@/components/ui/glyphs'
import type { ReviveState } from '@/lib/protocol'

/**
 * 押したあと、これだけのあいだ**次の押下を捨てる**（帯設計§15-1）。
 *
 * **2つのボタンだったときは、連打しても同じものが2回送られるだけだった。**
 * 1つにするとそうではなくなる——`Kill` から `ended` へ変わるまでには間があり
 * （実測の上限は20秒）、**その切り替わりをまたいで2回目を押すと、止めたつもりで
 * 起こす**。「効いたか分からないからもう一度押す」がいちばん起きやすい押し方で、
 * しかも押した直後は輪の色が変わらないので、その動機がそこにある。
 */
const 連打よけ = 500

/**
 * **押せなくするのは「本当に押せないとき」だけにする。** 連打よけで `disabled` に
 * すると、点灯していた輪が 500ms だけ灰色へ落ちて**壊れたように見える**。捨てるのは
 * 押下のほうで、見た目は動かさない。
 *
 * **「状態が切り替わるまで押せなくする」は採らない**（帯設計§15-1）。`Kill` が届か
 * なければ**永久に押せないボタン**になり、しかも押せない理由を出す道が無い。
 */
export function PowerButton({
  on,
  state,
  busy,
  why,
  testId = 'power-card',
  onPress,
}: {
  /** 点いているか（＝実体がある）。消えていれば押すと起きる */
  on: boolean
  /** 起こし直せるかの内訳。押せない理由を目印にも載せる */
  state: ReviveState['kind']
  /** いま起こしている最中か */
  busy: boolean
  /** 押せない理由（押せるときは `null`） */
  why: string | null
  /**
   * 目印。**既定は動かさない**——`e2e/dashboard.spec.ts` がセッション画面の
   * `power-card` を読んでいる。カード側（細かい修正 フェーズ2）は自分の目印を渡す
   */
  testId?: string
  onPress: () => void
}) {
  const [待つ, set待つ] = useState(false)
  const 時計 = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (時計.current !== null) {
        clearTimeout(時計.current)
      }
    },
    [],
  )

  // **色は読み上げられない。** ホバーの反応も文字ではないので、読み上げ環境では
  // ここだけが手がかりになる（帯設計§15-1）
  const 言葉 = on ? 'スリープ' : '復旧'
  const 説明 = busy
    ? '起こしています…'
    : on
      ? 'セッションを止めます（カードは残り、復旧で起こせます）'
      : (why ?? '元の CLI セッションで起こし直します')

  return (
    <button
      type="button"
      className="power"
      data-testid={testId}
      data-power={on ? 'on' : 'off'}
      data-action={on ? 'sleep' : 'revive'}
      data-state={state}
      data-busy={busy ? 'true' : undefined}
      disabled={(!on && state !== 'ready') || busy}
      aria-label={言葉}
      title={説明}
      onClick={() => {
        if (待つ) {
          return
        }
        set待つ(true)
        時計.current = setTimeout(() => set待つ(false), 連打よけ)
        onPress()
      }}
    >
      <PowerGlyph className="size-3.5" />
    </button>
  )
}
