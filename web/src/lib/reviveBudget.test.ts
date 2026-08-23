import { describe, expect, it } from 'vitest'

import { hostOf, planRevive, type HostResources } from '@/lib/reviveBudget'

function resources(fits: number | null): HostResources {
  return {
    total_mb: 16_000,
    available_mb: 13_000,
    swap_free_mb: 0,
    estimate_mb: 780,
    headroom_mb: 2_048,
    fits_now: fits,
  }
}

function target(cardId: string, host: string, lastActivityAt: number) {
  return { cardId, host, lastActivityAt }
}

describe('planRevive', () => {
  it('数えない（歯止めを外している）と言われたら、間引かない', () => {
    // `revive_estimate_mb = 0` のとき PC は `null` を返す（コードレビュー対応2）。
    // **番兵の巨大な数を運んでいた頃は、たまたま `list.length <= fits` で通っていた**
    // ——意味が型に出ていなかったので、見せるところで1つずつ潰す必要があった
    const plan = planRevive(
      [target('a', 'local', 1), target('b', 'local', 2)],
      new Map([['local', resources(null)]]),
    )
    expect(plan.over).toBe(false)
    expect(plan.fitting).toEqual(['a', 'b'])
  })

  it('全部入るならダイアログを出さない', () => {
    const plan = planRevive(
      [target('a', 'local', 1), target('b', 'local', 2)],
      new Map([['local', resources(10)]]),
    )
    expect(plan.over).toBe(false)
    expect(plan.fitting).toEqual(['a', 'b'])
  })

  it('入りきらないと over になり、入るぶんだけを新しい順に選ぶ', () => {
    const plan = planRevive(
      [
        target('古い', 'local', 100),
        target('新しい', 'local', 300),
        target('中くらい', 'local', 200),
      ],
      new Map([['local', resources(2)]]),
    )
    expect(plan.over).toBe(true)
    // **新しい順**。黙って選ぶと理由が分からないので、画面にも1行出す
    expect(plan.fitting).toEqual(['新しい', '中くらい'])
    expect(plan.all).toHaveLength(3)
  })

  it('ちょうど入るときは over にならない', () => {
    const plan = planRevive(
      [target('a', 'local', 1), target('b', 'local', 2)],
      new Map([['local', resources(2)]]),
    )
    expect(plan.over).toBe(false)
    expect(plan.fitting).toHaveLength(2)
  })

  it('0枚しか入らないなら1枚も選ばない', () => {
    const plan = planRevive(
      [target('a', 'local', 1)],
      new Map([['local', resources(0)]]),
    )
    expect(plan.over).toBe(true)
    expect(plan.fitting).toEqual([])
  })

  it('聞けなかった PC は数えない（分からないことを理由に止めない）', () => {
    const plan = planRevive(
      [target('a', 'old-pc', 1), target('b', 'old-pc', 2)],
      new Map([['old-pc', null]]),
    )
    expect(plan.over).toBe(false)
    expect(plan.fitting).toEqual(['a', 'b'])
    expect(plan.hosts[0].fits).toBeNull()
  })

  it('PC ごとに別々に数える（メモリは PC ごとに別）', () => {
    const plan = planRevive(
      [
        target('a1', 'pc-a', 1),
        target('a2', 'pc-a', 2),
        target('a3', 'pc-a', 3),
        target('b1', 'pc-b', 1),
      ],
      new Map([
        ['pc-a', resources(1)],
        ['pc-b', resources(5)],
      ]),
    )
    expect(plan.over).toBe(true)
    // pc-a は新しい1枚だけ、pc-b は全部
    expect(plan.fitting).toEqual(['a3', 'b1'])
    expect(plan.hosts).toHaveLength(2)
  })

  it('片方の PC が入りきらないだけでも over になる', () => {
    const plan = planRevive(
      [target('a1', 'pc-a', 1), target('b1', 'pc-b', 1)],
      new Map([
        ['pc-a', resources(0)],
        ['pc-b', resources(9)],
      ]),
    )
    expect(plan.over).toBe(true)
  })
})

describe('hostOf', () => {
  it('ローカルモードのカードは local になる', () => {
    // `agent_id` が無いのは PC という単位が無い構成（設計§19）
    expect(hostOf(null)).toBe('local')
    expect(hostOf(undefined)).toBe('local')
  })

  it('繋いだ PC はその ID', () => {
    expect(hostOf('11111111-2222-3333-4444-555555555555')).toBe(
      '11111111-2222-3333-4444-555555555555',
    )
  })
})
