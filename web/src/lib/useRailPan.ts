/**
 * ホイールを、PJT 画面のレール（横並びの入れ物）の横送りへ渡す（設計「ホイールをレールへ手渡す」）。
 *
 * # なぜ手渡しが要るのか
 *
 * 端末を包む箱は `overflowX: auto` を持つ（`components/TerminalPane`）。桁行を 120×40 に
 * 固定してあるので、42rem の札では**必ず横にはみ出す**。したがって端末の上にカーソルを
 * 置いたまま横へ回すと、**レールではなく端末の中身が動く**——これが「カーソルを余白へ
 * 逃がさないと横スクロールできない」の正体だった。
 *
 * **CSS は消さない。** 消せばブラウザのスクロール連鎖が自然に届くが、**指で払う道と
 * スクロールバーも一緒に消える**。あの2つは「端末の横をホイールでは読めなくする」と
 * 決めたときの代償の担保そのものなので、ここは JS で横取りするほうを選んだ。
 *
 * # 測るのはここ、決めるのは `lib/railPan.ts`
 *
 * このファイルが持つのは4つだけ——**購読の張り／外し**、**実測**（見え幅と行の高さ）、
 * **相手の名指し**、**`scrollLeft` の読み書き**。どのホイールをどれだけ送るかの判定は
 * `railPan.ts` の純関数が持つ。ここに `if (shiftKey)` を書いたら二重実装である。
 *
 * # 端末のホイール購読は2つあり、止め方が違う
 *
 * **ここで止まるのは片方だけである。** もう片方は `TerminalPane` 側の
 * `attachCustomWheelEventHandler` でしか止まらない（あちらのコメントに対で書いてある）。
 * **重複して見えるが重複していない。**
 *
 * | 購読 | 何をする | 止め方 |
 * |---|---|---|
 * | 内部スクロール | 端末の箱を横へ動かす | 入口で `defaultPrevented` を見るので、**ここの `preventDefault()` で止まる** |
 * | 矢印キー送出 | スクロールバックが無い間、縦回しを ↑/↓ として claude へ送る | `defaultPrevented` を**見ない**ので、**あちらの口でしか止まらない** |
 */

import { useEffect, type RefObject } from 'react'
import { wheelPanDelta } from '@/lib/railPan'

/**
 * `deltaMode` が「行」で届いたときの換算に使う、1行ぶんの高さ（px）。
 *
 * **`railPan.ts` へ持ち込まない。** あちらは測らない側なので、既定値も測る側が持つ。
 */
const 行の高さの既定 = 16

/** 実測できないときに使う見え幅（px）。jsdom は幅を 0 で返すことがある。 */
const 見え幅の既定 = 672

/**
 * 1行ぶんの高さを読む。**`normal` は数にならない**ので既定へ落とす。
 */
function 行の高さ(element: Element): number {
  const 値 = Number.parseFloat(getComputedStyle(element).lineHeight)
  return Number.isFinite(値) && 値 > 0 ? 値 : 行の高さの既定
}

/**
 * レールの上のホイールを、横送りへ渡す。
 *
 * **購読はキャプチャ段で張る。** 端末の中の購読より**先に**走らないと、あちらが
 * 自分で横へ動かしたあとになり、レールと端末が二重に動く。
 *
 * **`stopPropagation()` は呼ばない。** 伝播ごと断つと、**内側で消費されるべきもの**
 * （生テキストの `<pre>` が自分の中を横へ動かすなど）まで奪ってしまう。止めたいのは
 * 既定動作だけなので `preventDefault()` で足りる。
 */
export function useRailPan(railRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const rail = railRef.current
    if (!rail) {
      return
    }

    const 横へ渡す = (event: WheelEvent) => {
      /*
        **相手を名指しする。** 全子孫から奪うと、生テキストのように「自分の中を
        横へ動かすのが正しい」ものまで動かなくなる。横取りしてよいのは端末だけ
      */
      const target = event.target
      if (!(target instanceof Element) || !target.closest('[data-testid="terminal"]')) {
        return
      }

      const 送り量 = wheelPanDelta(
        {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          shiftKey: event.shiftKey,
        },
        {
          lineHeight: 行の高さ(target),
          pageWidth: rail.clientWidth || 見え幅の既定,
        },
      )

      /*
        **0 のときは何もしない**（`preventDefault()` も呼ばない）。修飾なしの縦回しが
        ここで抜ける——あれは端末の遡りに残す
      */
      if (送り量 === 0) {
        return
      }

      rail.scrollLeft += 送り量
      event.preventDefault()
    }

    // **`passive: false` でないと `preventDefault()` が効かない。**
    // 効かないと端末の箱が自分でも横へ動き、二重になる
    rail.addEventListener('wheel', 横へ渡す, { passive: false, capture: true })
    return () => {
      // **外すときにも `capture` を渡す。** 渡さないと別の購読とみなされて外れない
      rail.removeEventListener('wheel', 横へ渡す, { capture: true })
    }
  }, [railRef])
}
