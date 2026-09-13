import {
  formatDateTime,
  formatDuration,
  formatElapsed,
  formatScreenInterval,
  formatUntil,
} from './time'

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

describe('formatUntil', () => {
  it('5秒未満は「まもなく」', () => {
    expect(formatUntil(0)).toBe('まもなく')
    expect(formatUntil(4_999)).toBe('まもなく')
  })

  it('分・時間・日で切り替わる', () => {
    expect(formatUntil(30_000)).toBe('あと30秒')
    expect(formatUntil(5 * 60_000)).toBe('あと5分')
    expect(formatUntil(3 * 3_600_000)).toBe('あと3時間')
    expect(formatUntil(2 * 86_400_000)).toBe('あと2日')
  })

  it('過ぎている（負）ときは 0 へ丸める', () => {
    // **「リセット済み」はここで言わない。** 使用上限固有の言い回しなので、
    // 時刻の書式化には混ぜず、呼ぶ側が判定する
    expect(formatUntil(-1)).toBe('まもなく')
    expect(formatUntil(-86_400_000)).toBe('まもなく')
  })
})

/**
 * 期間の整形（テスト計画フェーズ5「セッションごとの費用」）。
 *
 * **`formatElapsed` との取り違えを主に見る。** 同じ「3分」でも、あちらは「3分前」を
 * 返すので、所要時間へ当てると**最終更新時刻に読める**。数字が同じで意味が変わる
 * 取り違えなので、**向きの語が付いていないこと**を明示的に確かめる。
 */
describe('formatDuration', () => {
  it('向きの語を付けない（formatElapsed との取り違えを防ぐ）', () => {
    // **ここが本題。** 「3分前」でも「あと3分」でもない
    expect(formatDuration(3 * 60_000)).toBe('3分')
    expect(formatDuration(3 * 60_000)).not.toContain('前')
    expect(formatDuration(3 * 60_000)).not.toContain('あと')
  })

  it('1分未満は秒、1時間未満は分', () => {
    expect(formatDuration(0)).toBe('0秒')
    expect(formatDuration(45_000)).toBe('45秒')
    // 境界。59秒は秒のまま、60秒で分へ繰り上がる
    expect(formatDuration(59_000)).toBe('59秒')
    expect(formatDuration(60_000)).toBe('1分')
    expect(formatDuration(59 * 60_000)).toBe('59分')
  })

  it('1時間を超えたら分を併記する', () => {
    // **相対表現の2つと粗さが違う。** あちらは「止まっていないか」を見るので
    // 「2時間」で足りるが、これは実績なので「2時間」と「2時間55分」を
    // 同じに見せると費用の見当が付かない
    expect(formatDuration(3_600_000)).toBe('1時間')
    expect(formatDuration(2 * 3_600_000 + 15 * 60_000)).toBe('2時間15分')
    expect(formatDuration(2 * 3_600_000 + 55 * 60_000)).toBe('2時間55分')
  })

  it('ちょうどの時間は分を出さない', () => {
    expect(formatDuration(2 * 3_600_000)).toBe('2時間')
    expect(formatDuration(2 * 3_600_000)).not.toContain('0分')
  })

  it('負は 0 へ丸める', () => {
    expect(formatDuration(-1)).toBe('0秒')
  })
})
