import {
  DRAG_THRESHOLD_PX,
  PANEL_RANGE,
  normalizeWidth,
  panelBounds,
  passedThreshold,
  resolveWidth,
  widthFromDrag,
} from './panelWidth'

/**
 * ファイルのパネルの幅を決める規則（テスト計画フェーズ2「幅を決める規則」）。
 *
 * **期待値は数を字で書く。** 実装と同じ定数から組み立てると、表を直したときに
 * テストも一緒に動いて通ってしまい、番人にならない。
 *
 * ここで確かめられないもの：**実際に幅が当たること**。jsdom は要素の幅を常に 800、
 * 左端を常に 0 で返すので（`test/setup.ts`）、配置から幅を出す経路は縮退した同じ数字
 * しか通らない。当たることは E2E でしか言えない。
 */

/** 広い画面。画面比の上限が絶対値に届かない側 */
const WIDE = 1920
/** ふつうのノート。画面比の上限が絶対値より狭くなる側 */
const LAPTOP = 1280
/** `md` の下端。**下限と上限がいちばん近づく** */
const MD = 768

describe('幅の既定', () => {
  it('移設前の実装の値をそのまま採っている', () => {
    // フォルダは `md:w-80`、中身は横並び1区画ぶんの `w-[42rem]`
    expect(PANEL_RANGE.folder.default).toBe(320)
    expect(PANEL_RANGE.file.default).toBe(672)
  })

  it('下限と上限は、既定の半分と倍になっている', () => {
    expect(PANEL_RANGE.folder.min).toBe(160)
    expect(PANEL_RANGE.folder.max).toBe(640)
    expect(PANEL_RANGE.file.min).toBe(336)
    expect(PANEL_RANGE.file.max).toBe(1344)
  })
})

describe('幅の範囲', () => {
  it('下限より狭い値を渡すと、下限で止まる', () => {
    expect(resolveWidth('folder', 10, WIDE)).toBe(160)
    expect(resolveWidth('file', 10, WIDE)).toBe(336)
  })

  it('上限より広い値を渡すと、上限で止まる', () => {
    expect(resolveWidth('folder', 9999, WIDE)).toBe(640)
    // 中身の列は 1920 では画面比（50%）のほうが狭いので、そちらで止まる
    expect(resolveWidth('file', 9999, WIDE)).toBe(960)
  })

  it('絶対値と画面比の、狭いほうが上限になる（フォルダ）', () => {
    // 1920 × 0.4 = 768 なので、絶対値の 640 が勝つ
    expect(panelBounds('folder', WIDE).max).toBe(640)
    // 1280 × 0.4 = 512 なので、画面比が勝つ
    expect(panelBounds('folder', LAPTOP).max).toBe(512)
  })

  it('絶対値と画面比の、狭いほうが上限になる（中身の列）', () => {
    // 1920 × 0.5 = 960 なので、画面比が勝つ
    expect(panelBounds('file', WIDE).max).toBe(960)
    // 4096 × 0.5 = 2048 なので、絶対値の 1344 が勝つ
    expect(panelBounds('file', 4096).max).toBe(1344)
  })

  it('md の下端では、まだ下限のほうが狭い', () => {
    // 768 × 0.4 = 307.2 → 切り捨てて 307。**割合を1pxでも超えない側へ倒す**
    expect(panelBounds('folder', MD)).toEqual({ min: 160, max: 307 })
  })

  it('極端に狭い窓でも範囲が破綻せず、上限が勝つ', () => {
    // 100 × 0.4 = 40。ここで下限（160）をそのまま置くと、下限が上限を追い越して
    // 範囲が消える。**「起きないはず」を式の外に置かない**（設計§4）
    expect(panelBounds('folder', 100)).toEqual({ min: 40, max: 40 })
    expect(resolveWidth('folder', 320, 100)).toBe(40)
  })

  it('画面幅が読めなくても、絶対値の範囲だけで答えを出す', () => {
    // 0 や NaN を掛けると幅が消える。**画面幅が読めないことと、画面が狭いことは別**
    expect(panelBounds('folder', 0)).toEqual({ min: 160, max: 640 })
    expect(panelBounds('folder', Number.NaN)).toEqual({ min: 160, max: 640 })
  })
})

describe('引っぱったときの幅', () => {
  it('移動量が 0 なら、1px も動かない', () => {
    // 掴んだだけで幅が変わると、押し間違いで幅が動く
    expect(widthFromDrag('folder', 320, 0, WIDE)).toBe(320)
    expect(widthFromDrag('file', 672, 0, WIDE)).toBe(672)
  })

  it('右へ引けば広がり、左へ引けば縮む', () => {
    expect(widthFromDrag('folder', 320, 40, WIDE)).toBe(360)
    expect(widthFromDrag('folder', 320, -40, WIDE)).toBe(280)
  })

  it('向きは、フォルダも中身の列も同じ', () => {
    // どちらも左端にあり、縁はその右側にある
    expect(widthFromDrag('file', 672, 40, WIDE)).toBe(712)
    expect(widthFromDrag('file', 672, -40, WIDE)).toBe(632)
  })

  it('引っぱっても、範囲の外へは出ない', () => {
    expect(widthFromDrag('folder', 320, -9999, WIDE)).toBe(160)
    expect(widthFromDrag('folder', 320, 9999, WIDE)).toBe(640)
  })
})

describe('覚えるときの正規化', () => {
  it('画面幅を見ない', () => {
    // **窓を狭めた状態で画面比まで当てた値を覚えると、窓を戻したときに元の幅へ
    // 戻れない**（設計§4）。だからここは絶対値の範囲だけで丸める
    expect(normalizeWidth('folder', 600)).toBe(600)
  })

  it('数値でない・NaN・Infinity は既定へ落ちる', () => {
    expect(normalizeWidth('folder', 'あ')).toBe(320)
    expect(normalizeWidth('folder', null)).toBe(320)
    expect(normalizeWidth('folder', Number.NaN)).toBe(320)
    expect(normalizeWidth('folder', Number.POSITIVE_INFINITY)).toBe(320)
    expect(normalizeWidth('file', undefined)).toBe(672)
  })

  it('負・範囲外は、絶対値の下限と上限へ寄せる', () => {
    expect(normalizeWidth('folder', -100)).toBe(160)
    expect(normalizeWidth('folder', 9999)).toBe(640)
    expect(normalizeWidth('file', 1)).toBe(336)
  })

  it('覚えている幅そのものは、画面幅が変わっても書き換わらない', () => {
    // 狭い画面では clamp した値が当たるが、**覚えている 600 は生き残る**ので、
    // 窓を戻せば 600 に戻る
    const 覚えている = 600
    expect(resolveWidth('folder', 覚えている, LAPTOP)).toBe(512)
    expect(resolveWidth('folder', 覚えている, WIDE)).toBe(600)
  })
})

describe('幅を動かし始めるしきい値', () => {
  it('しきい値に届くまでは動かさない', () => {
    expect(DRAG_THRESHOLD_PX).toBe(3)
    expect(passedThreshold(2)).toBe(false)
    expect(passedThreshold(-2)).toBe(false)
  })

  it('しきい値ちょうどで動き出す', () => {
    expect(passedThreshold(3)).toBe(true)
    expect(passedThreshold(-3)).toBe(true)
  })
})
