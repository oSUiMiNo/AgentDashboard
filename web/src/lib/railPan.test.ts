import { describe, expect, it } from 'vitest'
import {
  DELTA_LINE,
  DELTA_PAGE,
  DELTA_PIXEL,
  panScrollDelta,
  passedPanThreshold,
  RAIL_PAN_THRESHOLD_PX,
  wheelPanDelta,
  type WheelScale,
} from '@/lib/railPan'

/**
 * ホイールと中ドラッグを、レールの横の送り量へ畳む規則（テスト計画フェーズ2）。
 *
 * **DOM を1つも読まない。** jsdom は要素の幅を常に 800・左端を常に 0 で返すので、
 * 測る側と混ざると**何も確かめていない状態で緑になる**。ここは移動量も座標も字で書く。
 *
 * **期待値も字で書く。** 実装と同じ定数から組み立てると、定数が動いたときに
 * 期待値も一緒に動いて、通ったままになる。
 *
 * ここで確かめられないもの：**実際にレールが動くこと**。購読を張って `scrollLeft` を
 * 書くのは `useRailPan.ts` の担当で、それが端末の上でも効くことは e2e でしか言えない。
 */

/** 単位の換算に使う実測値。**本来はフックが測って渡す。** */
const SCALE: WheelScale = { lineHeight: 16, pageWidth: 672 }

/** 届いたホイールを組み立てるだけの助け。既定は px 単位・修飾なし。 */
function wheel(partial: Partial<Parameters<typeof wheelPanDelta>[0]>) {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: DELTA_PIXEL,
    shiftKey: false,
    ...partial,
  }
}

describe('ホイールを横の送り量へ畳む', () => {
  it('純粋な横回しは、そのまま送り量になる', () => {
    expect(wheelPanDelta(wheel({ deltaX: 120 }), SCALE)).toBe(120)
  })

  it('**修飾なしの縦回しは送らない。** 端末の遡りに残す', () => {
    // 壊し方：無条件に deltaY を送ると、ここが 120 になって落ちる
    expect(wheelPanDelta(wheel({ deltaY: 120 }), SCALE)).toBe(0)
  })

  it('**Shift ＋ 縦回しは、横として送る**', () => {
    // ブラウザは Shift ＋ ホイールを deltaY のまま届け、既定動作だけを横にする。
    // 壊し方：shiftKey を見ないと、上の項目と一緒にしか動かせなくなる
    expect(wheelPanDelta(wheel({ deltaY: 120, shiftKey: true }), SCALE)).toBe(120)
  })

  it('**純横は、Shift ＋ 縦より先に効く**', () => {
    // 両方入っていても横回しが勝つ。判定の順序を入れ替えると 999 になって落ちる
    expect(
      wheelPanDelta(wheel({ deltaX: 120, deltaY: 999, shiftKey: true }), SCALE),
    ).toBe(120)
  })

  it('縦も横も 0 なら、送らない', () => {
    expect(wheelPanDelta(wheel({ shiftKey: true }), SCALE)).toBe(0)
  })

  it('負の向きも、符号を保って送る', () => {
    expect(wheelPanDelta(wheel({ deltaX: -120 }), SCALE)).toBe(-120)
  })
})

describe('単位を px へ畳む', () => {
  it('行で届いた量は、行の高さを掛ける', () => {
    // 壊し方：単位を無視して生の値を返すと 3 になって落ちる
    expect(
      wheelPanDelta(wheel({ deltaY: 3, deltaMode: DELTA_LINE, shiftKey: true }), SCALE),
    ).toBe(48)
  })

  it('ページで届いた量は、見え幅を掛ける', () => {
    expect(wheelPanDelta(wheel({ deltaX: 1, deltaMode: DELTA_PAGE }), SCALE)).toBe(672)
  })

  it('px で届いた量は、そのまま', () => {
    expect(wheelPanDelta(wheel({ deltaX: 50, deltaMode: DELTA_PIXEL }), SCALE)).toBe(50)
  })

  it('**知らない単位は px とみなす。** 握りつぶさない', () => {
    // 握りつぶすと「何も動かない」という分かりにくい形で出る
    expect(wheelPanDelta(wheel({ deltaX: 50, deltaMode: 99 }), SCALE)).toBe(50)
  })
})

describe('掴みは、しきい値に届いてから始まる', () => {
  it('しきい値は 3px', () => {
    expect(RAIL_PAN_THRESHOLD_PX).toBe(3)
  })

  it('**届かないうちは始まらない**', () => {
    // 壊し方：しきい値を 0 にすると、ここが真になって落ちる
    expect(passedPanThreshold(2)).toBe(false)
  })

  it('**ちょうど届いたら始まる**（超えてからではない）', () => {
    expect(passedPanThreshold(3)).toBe(true)
  })

  it('**左へ動かしたときも、同じ距離で始まる**', () => {
    // 壊し方：Math.abs を外すと、負の側だけ始まらなくなって落ちる
    expect(passedPanThreshold(-3)).toBe(true)
  })

  it('動いていなければ始まらない', () => {
    expect(passedPanThreshold(0)).toBe(false)
  })
})

describe('掴んでいる間の送り量', () => {
  it('**ポインタを左へ動かすと、`scrollLeft` が増える**（中身を掴んで動かす向き）', () => {
    // 壊し方：符号を反転すると -60 になって落ちる
    expect(panScrollDelta(100, 40)).toBe(60)
  })

  it('**ポインタを右へ動かすと、`scrollLeft` が減る**', () => {
    expect(panScrollDelta(100, 160)).toBe(-60)
  })

  it('動いていなければ 0', () => {
    expect(panScrollDelta(100, 100)).toBe(0)
  })

  it('**1 対 1 で送る。** 倍率も慣性も掛けない', () => {
    // 壊し方：係数を掛けると、この2つが同じ比で動かなくなる
    expect(panScrollDelta(0, -10)).toBe(10)
    expect(panScrollDelta(0, -20)).toBe(20)
  })
})
