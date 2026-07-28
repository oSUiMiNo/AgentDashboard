import { formatElapsed } from './time'

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
