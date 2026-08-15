import { formatDateTime, formatElapsed, formatScreenInterval } from './time'

/**
 * 経過時間の表示（テスト計画フェーズ5「小窓」の経過時間表示）。
 *
 * 一覧の目的は「止まっていないか」を一瞥で確かめることなので、粒度が用途に合っている
 * ことを確かめる。1分未満は秒まで、それ以上は分・時間・日で丸める。
 */
describe('formatElapsed', () => {
  it('ごく最近はたった今と出る', () => {
    expect(formatElapsed(0)).toBe('たった今')
    expect(formatElapsed(4_999)).toBe('たった今')
  })

  it('1分未満は秒で出る', () => {
    expect(formatElapsed(5_000)).toBe('5秒前')
    expect(formatElapsed(59_000)).toBe('59秒前')
  })

  it('1分以上は分で丸める', () => {
    expect(formatElapsed(60_000)).toBe('1分前')
    expect(formatElapsed(3 * 60_000 + 40_000)).toBe('3分前')
  })

  it('1時間以上は時間で丸める', () => {
    expect(formatElapsed(3_600_000)).toBe('1時間前')
    expect(formatElapsed(5 * 3_600_000)).toBe('5時間前')
  })

  it('1日以上は日で丸める', () => {
    expect(formatElapsed(86_400_000)).toBe('1日前')
  })

  it('時計のずれで負になっても壊れない', () => {
    // サーバとブラウザの時計は完全には一致しない
    expect(formatElapsed(-5_000)).toBe('たった今')
  })
})

describe('formatScreenInterval', () => {
  it('秒に直して読ませる', () => {
    // 既定は20秒（設計§13-3）
    expect(formatScreenInterval(20_000)).toBe('20秒')
    expect(formatScreenInterval(1_000)).toBe('1秒')
  })

  it('1秒未満は小数のままにする', () => {
    // いちばん細かい選択肢。ミリ秒で出すと他の選択肢と桁が揃わない
    expect(formatScreenInterval(50)).toBe('0.05秒')
    // 0.05秒 と 1秒 の谷を埋める選択肢。**整形は一切直していない**——
    // この作りが元から 1秒未満をそのまま出すので、数字を足すだけで読める
    expect(formatScreenInterval(300)).toBe('0.3秒')
  })
})

describe('formatDateTime', () => {
  it('epoch ミリ秒を読める絶対時刻にする', () => {
    // 版の話では「3日前」より、いつのことかが分かるほうが手掛かりになる
    const text = formatDateTime(1_785_888_000_000)
    expect(text).not.toBeNull()
    expect(text).toContain('2026')
  })

  it('読めないものは null にする（推測で埋めない）', () => {
    // 実行ファイルの時刻は読めないことがある。嘘の日付は更新の判断を誤らせる
    expect(formatDateTime(null)).toBeNull()
    expect(formatDateTime(undefined)).toBeNull()
    expect(formatDateTime(0)).toBeNull()
    expect(formatDateTime(-1)).toBeNull()
    expect(formatDateTime(Number.NaN)).toBeNull()
  })
})
