import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ago,
  ASK_LIMIT_MS,
  fetchHostResources,
  hostOf,
  NO_ANSWER,
  needsRecheck,
  noAnswer,
  planRevive,
  RECHECK_INTERVAL_MS,
  RECHECK_LIMIT_MS,
  settleHostResources,
  SIGNED_OUT,
  type HostAnswer,
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

  it('「この機械では数えない」と答えた PC は数えない（分からないことを理由に止めない）', () => {
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
    // `unknown` はサーバの受け口（`#[serde(other)]`）が送り直す綴りで、実際に届きうる
    for (const 綴り of ['unknown', 'Fresh', 'FRESH', 'fresh ', 'ok', '']) {
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
    /*
      **`#[serde(other)]` の腕（知らない綴りの受け口）は数えない。** PC は作らないが、
      **ブラウザへは届きうる**——新しい PC の知らない状態を古いサーバが読むとこの腕になり、
      書き出すときは腕の名前（`unknown`）で送り直す。ブラウザ側は知らない綴りを
      「確かめられていない」へ倒している（上の「綴り違いは…」が `unknown` も見ている）ので、
      型に持たなくても同じ側に倒れる
    */
    const 腕: string[] = []
    let 受け口 = false
    for (const 行 of (本体?.[1] ?? '').split('\n')) {
      if (/^\s{4}#\[serde\(other\)\]\s*$/.test(行)) {
        受け口 = true
        continue
      }
      const 名前 = /^\s{4}([A-Z][A-Za-z]*),?\s*$/.exec(行)?.[1]
      if (名前 === undefined) {
        continue
      }
      if (!受け口) {
        腕.push(名前.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase())
      }
      受け口 = false
    }
    const 期待: HostFreeState[] = ['fresh', 'stale', 'checking', 'failed']
    expect(腕).toEqual(期待)
  })
})

describe('needsRecheck', () => {
  it('見積もり0・数えない・状態なしは聞き直さない', () => {
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
 * 資源を聞く口の答えの読み分け（Astra 3）。**通信の失敗を「数えない」と読まない。**
 */
describe('fetchHostResources', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function 答える(response: Partial<Response> | 'throw') {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (response === 'throw') {
          throw new TypeError('Failed to fetch')
        }
        return response as Response
      }),
    )
  }

  it('「この機械では数えない」（501・409）だけが null（歯止め無し）', async () => {
    // 501：メモリの空きを読めない機械（Linux 以外）。409：資源を聞く口を持たない古い PC
    for (const status of [501, 409]) {
      答える({ ok: false, status })
      expect(await fetchHostResources('local'), String(status)).toBeNull()
    }
  })

  it('それ以外の失敗は、答えが来なかったとして言い分ける', async () => {
    // **どれも WSL の PC でも起こる。** null へ畳むと、確かめていない数のまま全部送る
    for (const status of [503, 504, 404, 500, 415]) {
      答える({ ok: false, status })
      expect(await fetchHostResources('local'), String(status)).toBe(NO_ANSWER)
    }
    答える('throw')
    expect(await fetchHostResources('local')).toBe(NO_ANSWER)
    答える({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('本文が途中で切れた')
      },
    })
    expect(await fetchHostResources('local')).toBe(NO_ANSWER)
  })

  it('問い合わせに打ち切りの印を渡す', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 503 }) as Response)
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    await fetchHostResources('local', controller.signal)
    expect(fetch.mock.calls[0]).toEqual([
      '/api/hosts/local/resources',
      { signal: controller.signal },
    ])
  })
})

describe('planRevive の答えが来なかった PC', () => {
  it('0 枚として over を立て、前に聞けた答えは表示にだけ使う', () => {
    // 前に聞けた答えは「全部入る」と言っている。**それで数えない**
    const 前 = wsl(99, 'fresh')
    const plan = planRevive(
      [target('a', 'local', 1), target('b', 'local', 2)],
      new Map([['local', noAnswer(前)]]),
    )
    expect(plan.over).toBe(true)
    expect(plan.fitting).toEqual([])
    expect(plan.hosts[0]).toMatchObject({ fits: 0, unconfirmed: 'no_answer', resources: 前 })
  })

  it('前に聞けた答えが無くても 0 枚', () => {
    const plan = planRevive([target('a', 'local', 1)], new Map([['local', noAnswer(null)]]))
    expect(plan.over).toBe(true)
    expect(plan.hosts[0]).toMatchObject({ fits: 0, unconfirmed: 'no_answer', resources: null })
  })
})

/**
 * 聞き直し（設計§6-3）。**1秒おき、上限 65 秒。毎周すべての PC を聞く。**
 */
describe('settleHostResources', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /**
   * PC ごとの答えの順番。尽きたら最後のものを繰り返す。
   *
   * - `HostResources`：すぐ答える
   * - `{ 遅れて, 答え }`：`遅れて` ミリ秒後に答える
   * - `{ status }`：その状態コードで答える
   * - `'止まる'`：打ち切られるまで答えない
   * - `'投げる'`：通信が失敗する
   *
   * **打ち切りの印を受けたら、本物と同じく reject する。** そうしないと止まる場面の
   * テストは何をしても終わらない
   */
  type 一手 =
    | HostResources
    | { 遅れて: number; 答え: HostResources }
    | { status: number }
    | '止まる'
    | '投げる'

  function 偽の口(列: Record<string, 一手[]>) {
    const 回数: Record<string, number> = {}
    const 印: AbortSignal[] = []
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      const host = decodeURIComponent(url.split('/')[3])
      const at = 回数[host] ?? 0
      回数[host] = at + 1
      const 手 = 列[host][Math.min(at, 列[host].length - 1)]
      const signal = init?.signal ?? null
      if (signal !== null) {
        印.push(signal)
      }
      return new Promise<Response>((resolve, reject) => {
        const 断る = () => reject(new DOMException('aborted', 'AbortError'))
        if (signal?.aborted) {
          断る()
          return
        }
        signal?.addEventListener('abort', 断る)
        const 返す = (answer: HostResources) =>
          resolve({ ok: true, status: 200, json: async () => answer } as unknown as Response)
        if (手 === '止まる') {
          return
        }
        if (手 === '投げる') {
          reject(new TypeError('Failed to fetch'))
          return
        }
        if ('status' in 手) {
          resolve({ ok: 手.status < 300, status: 手.status } as Response)
          return
        }
        if ('遅れて' in 手) {
          setTimeout(() => 返す(手.答え), 手.遅れて)
          return
        }
        返す(手)
      })
    })
    vi.stubGlobal('fetch', fetch)
    return { fetch, 回数, 印 }
  }

  /** 締切まで聞かせて、答えを受け取る箱を返す（promise を await しない——止まる場面で終わらないため） */
  function 聞かせる(
    hosts: string[],
    options: Partial<Parameters<typeof settleHostResources>[1]> = {},
  ) {
    const controller = new AbortController()
    const 箱: { answer?: Awaited<ReturnType<typeof settleHostResources>> } = {}
    void settleHostResources(hosts, {
      deadline: Date.now() + RECHECK_LIMIT_MS,
      signal: controller.signal,
      ...options,
    }).then((got) => {
      箱.answer = got
    })
    return { 箱, controller }
  }

  /** 1台ぶんの答えを取り出す */
  function 台(箱: { answer?: unknown }, host: string): HostAnswer | undefined {
    const answer = 箱.answer
    return answer instanceof Map ? (answer.get(host) as HostAnswer) : undefined
  }

  it('新しい値が返るまで1秒おきに聞き直す', async () => {
    vi.useFakeTimers()
    const { fetch } = 偽の口({ local: [wsl(1, 'checking'), wsl(1, 'stale'), wsl(4, 'fresh')] })
    const { 箱 } = 聞かせる(['local'])

    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(3)

    expect(台(箱, 'local')).toMatchObject({ host_free_state: 'fresh', fits_now: 4 })
  })

  it('failed は聞き直さない', async () => {
    vi.useFakeTimers()
    const { fetch } = 偽の口({ local: [wsl(1, 'failed')] })
    const { 箱 } = 聞かせる(['local'])
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(台(箱, 'local')).toMatchObject({ host_free_state: 'failed' })
  })

  it('見積もり0なら、checking でも1回で終わる', async () => {
    vi.useFakeTimers()
    const { fetch } = 偽の口({ local: [wsl(null, 'checking')] })
    聞かせる(['local'])
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 3)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('上限 65 秒に達したら、最後の周の答えのまま返す', async () => {
    vi.useFakeTimers()
    const { fetch } = 偽の口({ local: [wsl(9, 'checking')] })
    const { 箱 } = 聞かせる(['local'])
    await vi.advanceTimersByTimeAsync(RECHECK_LIMIT_MS - RECHECK_INTERVAL_MS)
    expect(箱.answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 2)
    expect(台(箱, 'local')).toMatchObject({ host_free_state: 'checking' })
    // 1秒おきに 65 回前後。**上限より先に諦めない**
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(RECHECK_LIMIT_MS / RECHECK_INTERVAL_MS)
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(RECHECK_LIMIT_MS / RECHECK_INTERVAL_MS + 2)
  })

  it('「この機械では数えない」と答えたら、いまどおり null（歯止め無し）で1回で終わる', async () => {
    vi.useFakeTimers()
    const { fetch } = 偽の口({ local: [{ status: 501 }] })
    const { 箱 } = 聞かせる(['local'])
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(台(箱, 'local')).toBeNull()
  })

  it('最初から答えが来なければ、null にせず締切まで聞き直して「答え無し」で返す', async () => {
    // **null へ畳むと歯止め無し＝全部送る側になる。** WSL の PC でも通信は失敗する
    vi.useFakeTimers()
    const { fetch } = 偽の口({ local: [{ status: 503 }, '投げる'] })
    const { 箱 } = 聞かせる(['local'])
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 3)
    expect(箱.answer).toBeUndefined()
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(3)
    await vi.advanceTimersByTimeAsync(RECHECK_LIMIT_MS)
    expect(台(箱, 'local')).toEqual(noAnswer(null))
  })

  it('聞き直しの途中で答えが来なくなっても、歯止め無しへ格下げしない', async () => {
    vi.useFakeTimers()
    偽の口({ local: [wsl(9, 'checking'), { status: 503 }] })
    const { 箱 } = 聞かせる(['local'])
    await vi.advanceTimersByTimeAsync(RECHECK_LIMIT_MS + RECHECK_INTERVAL_MS * 2)
    // 前に聞けた答えは表示用に持ち回すだけで、数えない
    expect(台(箱, 'local')).toEqual(noAnswer(wsl(9, 'checking')))
  })

  it('確かめ直しで1周目から答えが来なくても、前回の答えを持ったまま確かめられていない側に留まる', async () => {
    vi.useFakeTimers()
    偽の口({ local: ['投げる'] })
    const 前回 = wsl(9, 'failed')
    const { 箱 } = 聞かせる(['local'], { previous: new Map([['local', 前回]]) })
    await vi.advanceTimersByTimeAsync(RECHECK_LIMIT_MS + RECHECK_INTERVAL_MS * 2)
    expect(台(箱, 'local')).toEqual(noAnswer(前回))
    const plan = planRevive([target('a', 'local', 1)], 箱.answer as Map<string, HostAnswer>)
    expect(plan.hosts[0]).toMatchObject({ fits: 0, unconfirmed: 'no_answer' })
  })

  it('1回の問い合わせが止まっても、上限で切って次の周へ進む', async () => {
    vi.useFakeTimers()
    const { fetch, 印 } = 偽の口({ local: ['止まる', wsl(4, 'fresh')] })
    const { 箱 } = 聞かせる(['local'])
    await vi.advanceTimersByTimeAsync(ASK_LIMIT_MS - 1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(印[0].aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(印[0].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(台(箱, 'local')).toMatchObject({ host_free_state: 'fresh', fits_now: 4 })
  })

  it('PC が2台で片方が止まっても、締切で返す（先に答えた PC は毎周聞き直す）', async () => {
    vi.useFakeTimers()
    const { 回数 } = 偽の口({ a: [wsl(3, 'fresh')], b: ['止まる'] })
    const { 箱 } = 聞かせる(['a', 'b'])
    await vi.advanceTimersByTimeAsync(RECHECK_LIMIT_MS + RECHECK_INTERVAL_MS)
    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'fresh', fits_now: 3 })
    expect(台(箱, 'b')).toEqual(noAnswer(null))
    // 1周は「1回の上限＋1秒」。**止まった1台に合わせて周を締切まで延ばさない**
    expect(回数.a).toBeGreaterThanOrEqual(Math.floor(RECHECK_LIMIT_MS / (ASK_LIMIT_MS + RECHECK_INTERVAL_MS)))
  })

  it('答える時間の違う2台では、毎周すべての PC を聞き、最後の周の答えで返す', async () => {
    // A は即答、B は1回3秒かかり、しばらく checking。**先に答えた A の最初の `fresh` は、
    // B が落ち着く頃には期限切れ**（A は途中で stale を返し、取り直して 1 枚に減っている）
    vi.useFakeTimers()
    const { 回数 } = 偽の口({
      a: [wsl(5, 'fresh', { host_free_age_sec: 58 }), wsl(5, 'stale'), wsl(1, 'fresh')],
      b: [
        { 遅れて: 3_000, 答え: wsl(0, 'checking') },
        { 遅れて: 3_000, 答え: wsl(0, 'checking') },
        { 遅れて: 3_000, 答え: wsl(5, 'fresh') },
      ],
    })
    const { 箱 } = 聞かせる(['a', 'b'])
    await vi.advanceTimersByTimeAsync(3 * 3_000 + 2 * RECHECK_INTERVAL_MS)

    expect(回数).toEqual({ a: 3, b: 3 })
    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'fresh', fits_now: 1 })
    expect(台(箱, 'b')).toMatchObject({ host_free_state: 'fresh', fits_now: 5 })
    // 計画も最後の周の数で立つ（A は 2 枚のうち 1 枚しか入らない）
    const plan = planRevive(
      [target('a1', 'a', 1), target('a2', 'a', 2), target('b1', 'b', 1)],
      箱.answer as Map<string, HostAnswer>,
    )
    expect(plan.over).toBe(true)
    expect(plan.fitting.toSorted()).toEqual(['a2', 'b1'])
  })

  it('入館証が切れたら、その場で打ち切り、同じ周の他の問い合わせも切る', async () => {
    vi.useFakeTimers()
    const { 印 } = 偽の口({ a: [{ status: 401 }], b: ['止まる'] })
    const { 箱 } = 聞かせる(['a', 'b'])
    await vi.advanceTimersByTimeAsync(0)
    expect(箱.answer).toBe(SIGNED_OUT)
    expect(印.every((signal) => signal.aborted)).toBe(true)
  })

  it('打ち切られたら cancelled を返し、進行中の問い合わせも切る', async () => {
    vi.useFakeTimers()
    const { fetch, 印 } = 偽の口({ local: ['止まる'] })
    const { 箱, controller } = 聞かせる(['local'])
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 3)
    expect(箱.answer).toBe('cancelled')
    expect(印[0].aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('聞き直しに入るたびに、何を待っているかを知らせる', async () => {
    vi.useFakeTimers()
    偽の口({ a: [wsl(1, 'checking'), wsl(1, 'fresh')], b: ['投げる', '投げる', wsl(1, 'fresh')] })
    const onWaiting = vi.fn()
    聞かせる(['a', 'b'], { onWaiting })
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 3)
    // 1周目：a が Windows 側を確かめている。2周目：答えが来ないのは b だけ
    expect(onWaiting.mock.calls.map((call) => call[0])).toEqual(['windows', 'answer'])
  })
})
