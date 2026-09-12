import { describe, expect, it } from 'vitest'

import { formatTokens } from '@/lib/contextUsage'

describe('トークン数の畳み方', () => {
  it('`/context` の見出しと同じ形になる', () => {
    // 実測した見出しは `241.5k / 1m tokens (24%)`。**この2つが揃うことが目的**で、
    // 利用者はここを突き合わせて「合っているか」を判断する
    expect(formatTokens(241_479)).toBe('241.5k')
    expect(formatTokens(1_000_000)).toBe('1m')
  })

  it('ちょうどの桁で `.0` が出ない', () => {
    // 分母はちょうど `1000000` で届く。落とさないと `1.0m` になって実物と食い違う
    expect(formatTokens(1_000)).toBe('1k')
    expect(formatTokens(2_000_000)).toBe('2m')
  })

  it('千に満たない数はそのまま出す', () => {
    // 起こした直後は `0` で届く。**`0` を `0.0k` と出すと、桁の意味が変わって見える**
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('境目で単位が変わる', () => {
    expect(formatTokens(999_999)).toBe('1000k')
    expect(formatTokens(1_000_001)).toBe('1m')
  })
})
