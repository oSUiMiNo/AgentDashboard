import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ago,
  fetchSettledHostResources,
  hostOf,
  needsRecheck,
  planRevive,
  RECHECK_INTERVAL_MS,
  RECHECK_LIMIT_MS,
  SIGNED_OUT,
  type HostFreeState,
  type HostResources,
} from '@/lib/reviveBudget'

function resources(fits: number | null): HostResources {
  return {
    total_mb: 16_000,
    available_mb: 13_000,
    swap_free_mb: 0,
    estimate_mb: 780,
    headroom_mb: 2_048,
    fits_now: fits,
    // **WSL でない機械の姿。** 抑えていないので両方 `null`
    host_free_mb: null,
    counted_mb: null,
    host_free_age_sec: null,
    host_free_state: null,
    host_free_error: null,
    effective_mb: 13_000,
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

/**
 * WSL の機械の答え（寝ているカードばかりなのに、メモリ不足でセッションを起こせない 設計§5）。
 * `fits` は PC が床や前回の値で数えた参考の枚数
 */
function wsl(
  fits: number | null,
  state: HostFreeState,
  overrides: Partial<HostResources> = {},
): HostResources {
  return {
    ...resources(fits),
    host_free_mb: state === 'checking' ? null : 5_400,
    counted_mb: 5_400,
    host_free_age_sec: state === 'checking' ? null : 12,
    host_free_state: state,
    host_free_error: state === 'failed' ? 'powershell.exe を起動できません' : null,
    effective_mb: 5_400,
    ...overrides,
  }
}

/**
 * 画面の分岐の順（設計§12-6）。**`host_free_state` が無い答えは、いまと同じ計画になる。**
 */
describe('planRevive の分岐の順（設計§12-6）', () => {
  const 三枚 = [target('a', 'local', 1), target('b', 'local', 2), target('c', 'local', 3)]

  it('見積もり0なら、確かめられていない状態でも制限なし', () => {
    // 数えないのだから、確かめる値が要らない（順1）
    for (const state of ['checking', 'stale', 'failed'] as const) {
      const plan = planRevive(三枚, new Map([['local', wsl(null, state)]]))
      expect(plan.over, state).toBe(false)
      expect(plan.fitting, state).toEqual(['a', 'b', 'c'])
      expect(plan.hosts[0].unconfirmed, state).toBeNull()
    }
  })

  it('WSL でない機械（状態なし）は、いまの規則のまま', () => {
    expect(planRevive(三枚, new Map([['local', resources(1)]]))).toMatchObject({
      over: true,
      fitting: ['c'],
    })
    expect(planRevive(三枚, new Map([['local', resources(5)]]))).toMatchObject({
      over: false,
      fitting: ['a', 'b', 'c'],
    })
  })

  it('期限0の設定（状態なし・counted_mb なし）は、いまの規則のまま', () => {
    const 期限0 = { ...resources(2), host_free_state: null, counted_mb: null }
    const plan = planRevive(三枚, new Map([['local', 期限0]]))
    expect(plan.over).toBe(true)
    expect(plan.fitting).toEqual(['c', 'b'])
    expect(plan.hosts[0].unconfirmed).toBeNull()
  })

  it('古い形式の応答（新しい欄が1つも無い）は、いまの規則のまま', () => {
    // **古い PC は欄そのものを送ってこない**。実行時には `undefined` が来る
    const 古い = JSON.parse(
      '{"total_mb":16000,"available_mb":13000,"swap_free_mb":0,"estimate_mb":780,' +
        '"headroom_mb":2048,"fits_now":1,"host_free_mb":null,"counted_mb":3000}',
    ) as HostResources
    const plan = planRevive(三枚, new Map([['local', 古い]]))
    expect(plan.over).toBe(true)
    expect(plan.fitting).toEqual(['c'])
    expect(plan.hosts[0].unconfirmed).toBeNull()
  })

  it('fresh なら PC の数えた枚数どおり', () => {
    const plan = planRevive(三枚, new Map([['local', wsl(2, 'fresh')]]))
    expect(plan.over).toBe(true)
    expect(plan.fitting).toEqual(['c', 'b'])
    expect(plan.hosts[0].unconfirmed).toBeNull()
  })

  it('failed の PC は、床が「全部入る」と言っても 0 枚として over を立てる', () => {
    // **黙って全部送る道を塞ぐ**（設計§6-3・§8-5）
    const plan = planRevive(三枚, new Map([['local', wsl(99, 'failed')]]))
    expect(plan.over).toBe(true)
    expect(plan.fitting).toEqual([])
    expect(plan.hosts[0]).toMatchObject({ fits: 0, unconfirmed: 'failed' })
  })

  it('聞き直した後も checking・stale のままなら、上限到達として 0 枚', () => {
    for (const state of ['checking', 'stale'] as const) {
      const plan = planRevive(三枚, new Map([['local', wsl(99, state)]]))
      expect(plan.over, state).toBe(true)
      expect(plan.fitting, state).toEqual([])
      expect(plan.hosts[0], state).toMatchObject({ fits: 0, unconfirmed: 'gave_up' })
    }
  })

  it('PC が2台で片方だけ確かめられないとき、入るぶんには確かめられた PC のぶんだけが入る', () => {
    const plan = planRevive(
      [
        target('a1', 'pc-a', 1),
        target('a2', 'pc-a', 2),
        target('b1', 'pc-b', 1),
        target('b2', 'pc-b', 2),
      ],
      new Map([
        ['pc-a', wsl(99, 'failed')],
        ['pc-b', wsl(5, 'fresh')],
      ]),
    )
    expect(plan.over).toBe(true)
    expect(plan.fitting).toEqual(['b1', 'b2'])
    expect(plan.all).toHaveLength(4)
  })
})

/**
 * **`host_free_state` の4つの綴りを固定する**（設計§5）。Rust↔TS の見張り
 * （`資源の欄はブラウザ側の型にも全部ある`）は欄の名前しか見ないので、
 * 値の綴りが1字ずれても誰も気づかない。
 */
describe('host_free_state の綴り', () => {
  const 三枚 = [target('a', 'local', 1), target('b', 'local', 2), target('c', 'local', 3)]

  /** PC が送ってくる生の JSON から読む。型の付いた値を手で作ると、綴りを確かめていない */
  function 生の答え(state: string): HostResources {
    return JSON.parse(
      JSON.stringify({ ...wsl(99, 'fresh'), host_free_state: state }),
    ) as HostResources
  }

  it('4つの綴りで、それぞれ振る舞いが変わる', () => {
    // fresh は数える
    expect(planRevive(三枚, new Map([['local', 生の答え('fresh')]])).over).toBe(false)
    expect(needsRecheck(生の答え('fresh'))).toBe(false)
    // stale・checking は聞き直す
    expect(needsRecheck(生の答え('stale'))).toBe(true)
    expect(needsRecheck(生の答え('checking'))).toBe(true)
    // failed は聞き直さずに 0 枚
    expect(needsRecheck(生の答え('failed'))).toBe(false)
    expect(planRevive(三枚, new Map([['local', 生の答え('failed')]])).hosts[0]).toMatchObject(
      { fits: 0, unconfirmed: 'failed' },
    )
  })

  it('綴り違いは、確かめられていない側（0枚）へ倒れる', () => {
    for (const 綴り of ['Fresh', 'FRESH', 'fresh ', 'ok', '']) {
      const plan = planRevive(三枚, new Map([['local', 生の答え(綴り)]]))
      expect(plan.over, 綴り).toBe(true)
      expect(plan.fitting, 綴り).toEqual([])
      expect(needsRecheck(生の答え(綴り)), 綴り).toBe(false)
    }
  })

  it('Rust 側の列挙と同じ4つの綴り', () => {
    // `#[serde(rename_all = "snake_case")]` の `HostFreeState` を読んで突き合わせる
    const 源 = readFileSync(
      resolve(process.cwd(), '..', 'server', 'crates', 'protocol', 'src', 'lib.rs'),
      'utf8',
    )
    const 本体 = /#\[serde\(rename_all = "snake_case"\)\]\s*pub enum HostFreeState \{([\s\S]*?)\n\}/.exec(
      源,
    )
    // **該当0件で黙って通さない**
    expect(本体, 'HostFreeState が見つからない').not.toBeNull()
    const 腕 = [...(本体?.[1] ?? '').matchAll(/^\s{4}([A-Z][A-Za-z]*),?\s*$/gm)].map((m) =>
      m[1].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(),
    )
    const 期待: HostFreeState[] = ['fresh', 'stale', 'checking', 'failed']
    expect(腕).toEqual(期待)
  })
})

describe('needsRecheck', () => {
  it('見積もり0・聞けなかった・状態なしは聞き直さない', () => {
    expect(needsRecheck(null)).toBe(false)
    expect(needsRecheck(wsl(null, 'checking'))).toBe(false)
    expect(needsRecheck(resources(3))).toBe(false)
  })
})

describe('ago', () => {
  it('秒・分・時間で言う', () => {
    expect(ago(12)).toBe('12 秒前')
    expect(ago(240)).toBe('4 分前')
    expect(ago(7_300)).toBe('2 時間前')
  })
})

/**
 * 聞き直し（設計§6-3）。**1秒おき、上限 65 秒。**
 */
describe('fetchSettledHostResources', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** 答えを順に返す。尽きたら最後のものを返し続ける */
  function 順に答える(...answers: (HostResources | 'エラー')[]) {
    let at = 0
    const fetch = vi.fn(async () => {
      const answer = answers[Math.min(at, answers.length - 1)]
      at += 1
      if (answer === 'エラー') {
        return { ok: false, status: 503 } as Response
      }
      return { ok: true, status: 200, json: async () => answer } as unknown as Response
    })
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('新しい値が返るまで1秒おきに聞き直す', async () => {
    vi.useFakeTimers()
    const fetch = 順に答える(wsl(1, 'checking'), wsl(1, 'stale'), wsl(4, 'fresh'))
    const settled = fetchSettledHostResources('local', Date.now() + RECHECK_LIMIT_MS, () => false)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(3)

    const answer = await settled
    expect(answer).toMatchObject({ host_free_state: 'fresh', fits_now: 4 })
  })

  it('failed は聞き直さない', async () => {
    const fetch = 順に答える(wsl(1, 'failed'))
    const answer = await fetchSettledHostResources('local', Date.now() + RECHECK_LIMIT_MS, () => false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(answer).toMatchObject({ host_free_state: 'failed' })
  })

  it('見積もり0なら、checking でも1回で終わる', async () => {
    const fetch = 順に答える(wsl(null, 'checking'))
    await fetchSettledHostResources('local', Date.now() + RECHECK_LIMIT_MS, () => false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('上限 65 秒に達したら、最後の答えのまま返す', async () => {
    vi.useFakeTimers()
    const fetch = 順に答える(wsl(9, 'checking'))
    let answer: unknown = undefined
    void fetchSettledHostResources('local', Date.now() + RECHECK_LIMIT_MS, () => false).then(
      (got) => {
        answer = got
      },
    )
    await vi.advanceTimersByTimeAsync(RECHECK_LIMIT_MS - RECHECK_INTERVAL_MS)
    expect(answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 2)
    expect(answer).toMatchObject({ host_free_state: 'checking' })
    // 1秒おきに 65 回前後。**上限より先に諦めない**
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(RECHECK_LIMIT_MS / RECHECK_INTERVAL_MS)
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(RECHECK_LIMIT_MS / RECHECK_INTERVAL_MS + 2)
  })

  it('聞き直しの途中で聞けなくなっても、歯止め無しへ格下げしない', async () => {
    // `null` へ格下げすると、塞ぎたい道（黙って全部送る）が開く
    vi.useFakeTimers()
    順に答える(wsl(9, 'checking'), 'エラー')
    let answer: unknown = undefined
    void fetchSettledHostResources('local', Date.now() + RECHECK_LIMIT_MS, () => false).then(
      (got) => {
        answer = got
      },
    )
    await vi.advanceTimersByTimeAsync(RECHECK_LIMIT_MS + RECHECK_INTERVAL_MS * 2)
    expect(answer).not.toBeNull()
    expect(answer).toMatchObject({ host_free_state: 'checking' })
  })

  it('最初から聞けなければ、いまどおり null（歯止め無し）', async () => {
    順に答える('エラー')
    const answer = await fetchSettledHostResources('local', Date.now() + RECHECK_LIMIT_MS, () => false)
    expect(answer).toBeNull()
  })

  it('入館証が切れたら、その場で打ち切る', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401 }) as Response),
    )
    const answer = await fetchSettledHostResources('local', Date.now() + RECHECK_LIMIT_MS, () => false)
    expect(answer).toBe(SIGNED_OUT)
  })

  it('打ち切られたら cancelled を返し、それ以上聞かない', async () => {
    vi.useFakeTimers()
    const fetch = 順に答える(wsl(9, 'checking'), wsl(9, 'checking'), wsl(9, 'fresh'))
    let cancelled = false
    const settled = fetchSettledHostResources('local', Date.now() + RECHECK_LIMIT_MS, () => cancelled)
    await vi.advanceTimersByTimeAsync(0)
    cancelled = true
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 3)
    expect(await settled).toBe('cancelled')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
