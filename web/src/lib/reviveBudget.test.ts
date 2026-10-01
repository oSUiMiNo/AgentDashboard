import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ago,
  ASK_LIMIT_MS,
  deadlineIn,
  elapsedMs,
  fetchHostResources,
  hostOf,
  instantNow,
  isPast,
  NO_ANSWER,
  needsRecheck,
  noAnswer,
  planRevive,
  RECHECK_INTERVAL_MS,
  RECHECK_LIMIT_MS,
  remainingMs,
  settleHostResources,
  SIGNED_OUT,
  type HostAnswer,
  type HostFreeState,
  type HostResources,
  type Settled,
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
    host_free_fresh_for_sec: null,
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
   * - `{ 聞かれたら }`：聞かれた時刻で答えを作り、すぐ答える（状態を持つ PC）
   * - `{ status }`：その状態コードで答える
   * - `'止まる'`：打ち切られるまで答えない
   * - `{ 断るまで }`：答えない。打ち切られたら、`断るまで` ミリ秒おいて断る（本物の fetch は
   *   打ち切りをすぐには断らない）
   * - `'投げる'`：通信が失敗する
   *
   * **打ち切りの印を受けたら、本物と同じく reject する。** そうしないと止まる場面の
   * テストは何をしても終わらない
   */
  type 一手 =
    | HostResources
    | { 遅れて: number; 答え: HostResources }
    | { 聞かれたら: () => HostResources }
    | { status: number }
    | { 断るまで: number }
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
        if (typeof 手 === 'object' && '断るまで' in 手) {
          signal?.addEventListener('abort', () => setTimeout(断る, 手.断るまで))
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
        if ('聞かれたら' in 手) {
          返す(手.聞かれたら())
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
      deadline: deadlineIn(RECHECK_LIMIT_MS),
      signal: controller.signal,
      ...options,
    }).then((got) => {
      箱.answer = got
    })
    return { 箱, controller }
  }

  /** 全台の答えを取り出す（まだ返っていない・打ち切られたなら `undefined`） */
  function 表(箱: { answer?: unknown }): Map<string, HostAnswer> | undefined {
    const answer = 箱.answer
    return typeof answer === 'object' && answer !== null && 'answers' in answer
      ? (answer as Settled).answers
      : undefined
  }

  /** 1台ぶんの答えを取り出す */
  function 台(箱: { answer?: unknown }, host: string): HostAnswer | undefined {
    return 表(箱)?.get(host)
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
    const plan = planRevive([target('a', 'local', 1)], 表(箱)!)
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

  /**
   * 新しさの窓が短い、正常な PC。PC 側の規則（設計§2-4・§2-5）を写す：
   *
   * - 期限 1 秒・取得 1 秒。観測は**取得を終えてから 5 秒**まで新しい（`FRESH_AFTER_FINISH`）
   * - 新しい観測があれば `fresh`（残りは切り捨ての秒）。無ければ取得を起こして `stale`
   *   （一度も聞けていなければ `checking`）。取得中に聞かれても2本目は起こさない
   */
  function 窓の短い正常な_PC(): () => HostResources {
    const 期限 = 1_000
    const 取得 = 1_000
    const 終えてから = 5_000
    let 観測: { 始め: number; 終わり: number } | null = null
    let 取得中: { 始め: number; 終わり: number } | null = null
    return () => {
      const t = performance.now()
      if (取得中 !== null && t >= 取得中.終わり) {
        観測 = 取得中
        取得中 = null
      }
      if (観測 !== null) {
        const 残り = Math.max(期限 - (t - 観測.始め), 終えてから - (t - 観測.終わり))
        if (残り > 0) {
          return wsl(4, 'fresh', {
            host_free_age_sec: Math.floor((t - 観測.始め) / 1_000),
            host_free_fresh_for_sec: Math.floor(残り / 1_000),
          })
        }
      }
      if (取得中 === null) {
        取得中 = { 始め: t, 終わり: t + 取得 }
      }
      // 床は「全部入る」と言っている。**数えるのは fresh のときだけ**
      return wsl(9, 観測 === null ? 'checking' : 'stale')
    }
  }

  it('新しさの窓が短い正常な PC は、答えない PC が居ても1秒おきに聞き直し、締切で数えられる', async () => {
    // a は正常だが、観測が新しいのは取得を終えてから 5 秒だけ。b は答えない（1回の上限で切られる）。
    // **全台の答えを揃えてから次を聞くと、a への間隔が約 11 秒に延び**、聞くたびに窓を使い切って
    // stale と取り直しを繰り返し、直接起こせば起こせる a まで締切で 0 枚になっていた（実装レビュー第6回 Astra 4）
    //
    // **締切の瞬間の a の姿は、取り直しのどこに当たるかで決まる。** 1秒おきに聞くと a は 6 秒ごと
    // （6・12…60 秒）に stale を返して取り直す。締切の 65 秒はその隙間に当たらない——最後に聞いた
    // 64 秒の答えは 61 秒に終えた観測で、あと 2 秒新しい
    vi.useFakeTimers()
    const { 回数 } = 偽の口({ a: [{ 聞かれたら: 窓の短い正常な_PC() }], b: ['止まる'] })
    const { 箱 } = 聞かせる(['a', 'b'])
    await vi.advanceTimersByTimeAsync(RECHECK_LIMIT_MS + RECHECK_INTERVAL_MS)

    // **b に合わせて a の間隔を延ばさない**——0〜64 秒の 65 回（揃えてから聞くと 6 回）
    expect(回数.a).toBe(RECHECK_LIMIT_MS / RECHECK_INTERVAL_MS)
    const plan = planRevive([target('a1', 'a', 1), target('b1', 'b', 1)], 表(箱)!)
    expect(plan.hosts.find((host) => host.host === 'a')).toMatchObject({
      fits: 4,
      unconfirmed: null,
    })
    expect(plan.hosts.find((host) => host.host === 'b')).toMatchObject({
      fits: 0,
      unconfirmed: 'no_answer',
    })
    expect(plan.fitting).toEqual(['a1'])
  })

  it('答える時間の違う2台では、遅い PC を待つ間も先に答えた PC を1秒おきに聞き直し、最後の答えで返す', async () => {
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

    // **A の間隔を B に合わせて延ばさない**——B の 3 回（11 秒）の間に、A は 0〜10 秒の 11 回
    expect(回数).toEqual({ a: 11, b: 3 })
    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'fresh', fits_now: 1 })
    expect(台(箱, 'b')).toMatchObject({ host_free_state: 'fresh', fits_now: 5 })
    // 計画も最後の周の数で立つ（A は 2 枚のうち 1 枚しか入らない）
    const plan = planRevive(
      [target('a1', 'a', 1), target('a2', 'a', 2), target('b1', 'b', 1)],
      表(箱)!,
    )
    expect(plan.over).toBe(true)
    expect(plan.fitting.toSorted()).toEqual(['a2', 'b1'])
  })

  it('締切の直前に始めた周が締切で切られても、直前の周で確かめられていた PC を「答え無し」にしない', async () => {
    // 1周は 500ms ＋ 1秒。3周目は締切の 300ms 前に始まり、答えが来る前に締切で切られる
    vi.useFakeTimers()
    const 一周の長さ = 500 + RECHECK_INTERVAL_MS
    偽の口({
      a: [{ 遅れて: 500, 答え: wsl(2, 'fresh') }],
      b: [{ 遅れて: 500, 答え: wsl(9, 'checking') }],
    })
    const { 箱 } = 聞かせる(['a', 'b'], { deadline: deadlineIn(2 * 一周の長さ + 300) })
    await vi.advanceTimersByTimeAsync(3 * 一周の長さ)

    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'fresh', fits_now: 2 })
    const plan = planRevive(
      [target('a1', 'a', 1), target('b1', 'b', 1)],
      表(箱)!,
    )
    expect(plan.fitting).toEqual(['a1'])
    expect(plan.hosts.find((host) => host.host === 'a')).toMatchObject({
      fits: 2,
      unconfirmed: null,
    })
    // b は前の周でも checking だった。**答えが来なかったのではなく、待っても確かめられなかった**
    expect(plan.hosts.find((host) => host.host === 'b')).toMatchObject({
      fits: 0,
      unconfirmed: 'gave_up',
    })
  })

  it('締切で切った周でも、切る前に答えが来なかった PC は「答え無し」のまま', async () => {
    // 3周目、a は締切より前に 503 で答えた。**切られたのではないので前の周へ戻さない**
    vi.useFakeTimers()
    const 一周の長さ = 500 + RECHECK_INTERVAL_MS
    const 前 = wsl(2, 'fresh')
    偽の口({
      a: [{ 遅れて: 500, 答え: 前 }, { 遅れて: 500, 答え: 前 }, { status: 503 }],
      b: [{ 遅れて: 500, 答え: wsl(9, 'checking') }],
    })
    const { 箱 } = 聞かせる(['a', 'b'], { deadline: deadlineIn(2 * 一周の長さ + 300) })
    await vi.advanceTimersByTimeAsync(3 * 一周の長さ)

    expect(台(箱, 'a')).toEqual(noAnswer(前))
  })

  it('1回の上限で切った問い合わせは、断りが届く前に締切が来ても「答え無し」のまま（前の答えへ戻さない）', async () => {
    // 2回目の問い合わせ（1 秒に聞き始める）は 11 秒に上限で切られ、断りは 50ms 遅れて届く。
    // その間（11.02 秒）に締切が来る。**切ったのは上限で、締切ではない**——戻ってきた時点で
    // 締切を見ると、答えなかった PC を前の答え（checking＝待っても確かめられなかった）と取り違える
    vi.useFakeTimers()
    偽の口({ a: [wsl(9, 'checking'), { 断るまで: 50 }] })
    const { 箱 } = 聞かせる(['a'], {
      deadline: deadlineIn(RECHECK_INTERVAL_MS + ASK_LIMIT_MS + 20),
    })
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS + ASK_LIMIT_MS + 100)

    expect(台(箱, 'a')).toEqual(noAnswer(wsl(9, 'checking')))
  })

  it('遅い PC を待つ間に、先に答えた PC の fresh が新しさの残りを使い切ったら、聞き直してから返す', async () => {
    // a は答えるのに 1.5 秒かかり、最初の答えはあと 2 秒しか新しくない（聞き始めた 0 秒から
    // 2 秒まで）。b は答えるのに 3 秒かかる。**b が答えた 3 秒の時点で、a の手元の答えは
    // 使い切っている**——a の次の答え（4 秒に届く）を待たずに返してはいけない
    vi.useFakeTimers()
    const { 回数 } = 偽の口({
      a: [
        {
          遅れて: 1_500,
          答え: wsl(5, 'fresh', { host_free_age_sec: 58, host_free_fresh_for_sec: 2 }),
        },
        {
          遅れて: 1_500,
          答え: wsl(1, 'fresh', { host_free_age_sec: 0, host_free_fresh_for_sec: 60 }),
        },
      ],
      b: [{ 遅れて: 3_000, 答え: wsl(5, 'fresh', { host_free_fresh_for_sec: 48 }) }],
    })
    const { 箱 } = 聞かせる(['a', 'b'])
    await vi.advanceTimersByTimeAsync(3_000)
    // 全台が答えたが、a の値はもう新しくない。**ここで返さない**
    expect(箱.answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS)

    expect(回数.a).toBe(2)
    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'fresh', fits_now: 1 })
    expect(台(箱, 'b')).toMatchObject({ host_free_state: 'fresh', fits_now: 5 })
  })

  it('締切までに新しい値で確かめ直せなければ、その PC は確かめられていない（0 枚）', async () => {
    // a は答えるのに 3 秒かかるのに、毎回あと 2 秒しか新しくない——**届いた時点で毎回使い切って
    // いる**。何度聞き直しても新しい値で確かめられない。1回は 3 秒＋1秒
    vi.useFakeTimers()
    const 一周の長さ = 3_000 + RECHECK_INTERVAL_MS
    const { 回数 } = 偽の口({
      a: [
        {
          遅れて: 3_000,
          答え: wsl(5, 'fresh', { host_free_age_sec: 58, host_free_fresh_for_sec: 2 }),
        },
      ],
      b: [{ 遅れて: 3_000, 答え: wsl(5, 'fresh', { host_free_fresh_for_sec: 48 }) }],
    })
    const { 箱 } = 聞かせる(['a', 'b'], { deadline: deadlineIn(2 * 一周の長さ + 3_500) })
    await vi.advanceTimersByTimeAsync(3 * 一周の長さ)

    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'stale' })
    const plan = planRevive(
      [target('a1', 'a', 1), target('b1', 'b', 1)],
      表(箱)!,
    )
    expect(plan.hosts.find((host) => host.host === 'a')).toMatchObject({
      fits: 0,
      unconfirmed: 'gave_up',
    })
    expect(plan.hosts.find((host) => host.host === 'b')).toMatchObject({
      fits: 5,
      unconfirmed: null,
    })
    expect(plan.fitting).toEqual(['b1'])
    // 締切まで聞き直した（0・4・8 秒）
    expect(回数).toEqual({ a: 3, b: 3 })
  })

  it('最後の周の後に眠って締切を迎えたら、返す瞬間の時刻で新しさを確かめる', async () => {
    // 2周目の終わり（2秒）では a はまだ新しい（あと 1 秒・0.5 秒経過）。眠って締切（2.8 秒）を
    // 越えてから返すので、そのときにはもう新しくない
    vi.useFakeTimers()
    偽の口({
      a: [{ 遅れて: 500, 答え: wsl(5, 'fresh', { host_free_fresh_for_sec: 1 }) }],
      b: [{ 遅れて: 500, 答え: wsl(9, 'checking') }],
    })
    const { 箱 } = 聞かせる(['a', 'b'], { deadline: deadlineIn(2_800) })
    await vi.advanceTimersByTimeAsync(4_000)

    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'stale' })
  })

  it('新しさの残りを送ってこない古い PC は、いまどおり古くなったと読まず、他の PC が答えた時点で返す', async () => {
    vi.useFakeTimers()
    // 古い PC は欄そのものを送ってこない（`null` ではなく、読むと `undefined`）
    const 古い = { ...wsl(5, 'fresh', { host_free_age_sec: 58 }) } as Partial<HostResources>
    delete 古い.host_free_fresh_for_sec
    偽の口({
      a: [古い as HostResources],
      b: [{ 遅れて: 3_000, 答え: wsl(5, 'fresh') }],
    })
    const { 箱 } = 聞かせる(['a', 'b'])
    await vi.advanceTimersByTimeAsync(3_000)

    // **b が答えた 3 秒で返る。** a を古くなったと読むと、ここで返らずに聞き直し続ける
    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'fresh', fits_now: 5 })
  })

  it('入館証が切れたら、その場で打ち切り、同じ周の他の問い合わせも切る', async () => {
    vi.useFakeTimers()
    const { 印 } = 偽の口({ a: [{ status: 401 }], b: ['止まる'] })
    const { 箱 } = 聞かせる(['a', 'b'])
    await vi.advanceTimersByTimeAsync(0)
    expect(箱.answer).toBe(SIGNED_OUT)
    // 1本目は a（答え終えている）。**切るのは、まだ答えていない b**
    expect(印).toHaveLength(2)
    expect(印[1].aborted).toBe(true)
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

  it('何を待っているかは、全台の最初の答えが揃ってから、中身が変わったときだけ知らせる', async () => {
    vi.useFakeTimers()
    偽の口({ a: [wsl(1, 'checking'), wsl(1, 'fresh')], b: ['投げる', '投げる', wsl(1, 'fresh')] })
    const onWaiting = vi.fn()
    聞かせる(['a', 'b'], { onWaiting })
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 3)
    // 1周目：a が Windows 側を確かめている。2周目：答えが来ないのは b だけ
    expect(onWaiting.mock.calls.map((call) => call[0])).toEqual(['windows', 'answer'])
  })

  it('知らせ（onWaiting）が投げて抜けても、残りの PC への聞き直しを裏に残さない', async () => {
    // a は 0 秒に答えて眠る。b が 0.5 秒に答えて全台が揃い、知らせが投げる
    vi.useFakeTimers()
    const { fetch } = 偽の口({
      a: [wsl(9, 'checking')],
      b: [{ 遅れて: 500, 答え: wsl(9, 'checking') }],
    })
    const 落ちた = vi.fn()
    void settleHostResources(['a', 'b'], {
      deadline: deadlineIn(RECHECK_LIMIT_MS),
      signal: new AbortController().signal,
      onWaiting: () => {
        throw new Error('知らせが落ちた')
      },
    }).catch(落ちた)
    await vi.advanceTimersByTimeAsync(500)
    expect(落ちた).toHaveBeenCalledTimes(1)
    const 抜けたとき = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 5)

    expect(fetch).toHaveBeenCalledTimes(抜けたとき)
  })

  it('対象が尽きて外した PC は聞くのも待つのもやめ、残った PC が落ち着いていればその場で返す', async () => {
    // a は即答で落ち着いている。b は答えない。2 秒で b のカードが別の画面から全部外された
    // （実装レビュー第9回 Astra 4）。**外さなければ締切の 65 秒まで a の結果が出ない**
    vi.useFakeTimers()
    const { 回数, 印 } = 偽の口({ a: [wsl(3, 'fresh')], b: ['止まる'] })
    const bを外す = new AbortController()
    const { 箱 } = 聞かせる(['a', 'b'], {
      hostSignals: new Map([['b', bを外す.signal]]),
    })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(箱.answer).toBeUndefined()
    // b への問い合わせは最初の1本（a より後に聞き始めた2本目）
    const bの印 = 印[1]
    expect(bの印.aborted).toBe(false)

    bを外す.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'fresh', fits_now: 3 })
    expect(bの印.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 5)
    expect(回数.b).toBe(1)
  })

  it('外した PC は、表から消さずに「答え無し」で返す（計画に紛れても数えない）', async () => {
    // **表に無い PC を planRevive は「数えない」（歯止め無し）と読む。** 消すと、その PC の
    // カードが計画に紛れたとき、確かめていない数のまま全部送る
    vi.useFakeTimers()
    偽の口({ a: [wsl(3, 'fresh')], b: ['止まる'] })
    const 前回 = wsl(9, 'fresh')
    const bを外す = new AbortController()
    const { 箱 } = 聞かせる(['a', 'b'], {
      previous: new Map([['b', 前回]]),
      hostSignals: new Map([['b', bを外す.signal]]),
    })
    await vi.advanceTimersByTimeAsync(500)
    bを外す.abort()
    await vi.advanceTimersByTimeAsync(0)

    expect(台(箱, 'b')).toEqual(noAnswer(前回))
    const plan = planRevive([target('a1', 'a', 1), target('b1', 'b', 1)], 表(箱)!)
    expect(plan.hosts.find((host) => host.host === 'b')).toMatchObject({
      fits: 0,
      unconfirmed: 'no_answer',
    })
    expect(plan.fitting).toEqual(['a1'])
  })

  it('始めた時点で外れている PC には1回も聞かず、全台が外れていればすぐ返す', async () => {
    vi.useFakeTimers()
    const { 回数 } = 偽の口({ a: [wsl(3, 'fresh')], b: ['止まる'] })
    const 外れている = new AbortController()
    外れている.abort()
    const 片方 = 聞かせる(['a', 'b'], {
      hostSignals: new Map([['b', 外れている.signal]]),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(台(片方.箱, 'a')).toMatchObject({ host_free_state: 'fresh', fits_now: 3 })
    expect(台(片方.箱, 'b')).toEqual(noAnswer(null))
    expect(回数.b).toBeUndefined()

    const 両方 = 聞かせる(['a', 'b'], {
      hostSignals: new Map([
        ['a', 外れている.signal],
        ['b', 外れている.signal],
      ]),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(表(両方.箱)).toEqual(
      new Map([
        ['a', noAnswer(null)],
        ['b', noAnswer(null)],
      ]),
    )
    // a へ聞いたのは片方の1回だけ
    expect(回数).toEqual({ a: 1 })
  })

  it('PC を外したら、何を待っているかを残った PC で言い直す', async () => {
    // a は Windows 側を確かめていて、b は答えが来ない。aを外すと、待っているのは b の答えだけ
    vi.useFakeTimers()
    const { 回数 } = 偽の口({ a: [wsl(1, 'checking')], b: ['投げる'] })
    const aを外す = new AbortController()
    const onWaiting = vi.fn()
    聞かせる(['a', 'b'], {
      onWaiting,
      hostSignals: new Map([['a', aを外す.signal]]),
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(onWaiting.mock.calls.map((call) => call[0])).toEqual(['windows'])
    aを外す.abort()
    // **次の答えを待たずに言い直す**（b が次に答えるのは 1 秒後）
    expect(onWaiting.mock.calls.map((call) => call[0])).toEqual(['windows', 'answer'])
    // 外した a は、b を待ち続けている間も聞き直さない（眠りも切る）
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 3)
    expect(回数.a).toBe(1)
  })

  /** 壁時計（`Date.now()`）だけを `ms` 戻す。**単調時計（`performance.now()`）は動かない** */
  function 時計を巻き戻す(ms: number) {
    vi.setSystemTime(Date.now() - ms)
  }

  it('聞いている間にブラウザの時計が巻き戻っても、新しさの残りを使い切った fresh を新しいと読まない', async () => {
    // a は答えるのに 1.5 秒かかり、最初の答えはあと 2 秒しか新しくない。b は答えるのに 3 秒かかる。
    // a が答える前に時計が 30 秒戻る。**壁時計だけで測ると経過が負になり**、b が答えた 3 秒の時点で
    // 3 秒前に聞いた a を新しいと読んで返していた（Astra 4）
    vi.useFakeTimers()
    const { 回数 } = 偽の口({
      a: [
        { 遅れて: 1_500, 答え: wsl(5, 'fresh', { host_free_fresh_for_sec: 2 }) },
        { 遅れて: 1_500, 答え: wsl(1, 'fresh', { host_free_fresh_for_sec: 60 }) },
      ],
      b: [{ 遅れて: 3_000, 答え: wsl(5, 'fresh', { host_free_fresh_for_sec: 48 }) }],
    })
    const { 箱 } = 聞かせる(['a', 'b'])
    await vi.advanceTimersByTimeAsync(1_000)
    時計を巻き戻す(30_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(箱.answer).toBeUndefined()
    // b の最初の答えも巻き戻りの前に聞いたもの。b が聞き直して答える 7 秒まで返らない
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS + 3_000)

    expect(回数.b).toBe(2)
    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'fresh', fits_now: 1 })
  })

  it('壁時計が巻き戻ったら、単調時計で残りがあっても期限切れとして聞き直す', async () => {
    // a はあと 60 秒新しい。a が答える前に時計が戻ると、何秒経ったのか言えない——切れた側へ倒す。
    // a は答えるのに 1.5 秒かかるので、b が答えた 3 秒の時点で a の手元にあるのは巻き戻りの前に
    // 聞いた答えだけである
    vi.useFakeTimers()
    const { 回数 } = 偽の口({
      a: [
        { 遅れて: 1_500, 答え: wsl(5, 'fresh', { host_free_fresh_for_sec: 60 }) },
        { 遅れて: 1_500, 答え: wsl(2, 'fresh', { host_free_fresh_for_sec: 60 }) },
      ],
      b: [{ 遅れて: 3_000, 答え: wsl(5, 'fresh', { host_free_fresh_for_sec: 48 }) }],
    })
    const { 箱 } = 聞かせる(['a', 'b'])
    await vi.advanceTimersByTimeAsync(1_000)
    時計を巻き戻す(30_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(箱.answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS + 3_000)

    expect(回数.b).toBe(2)
    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'fresh', fits_now: 2 })
  })

  it('壁時計が巻き戻って古くなった答えは、何秒前の値かを言わない（Infinity を画面へ渡さない）', async () => {
    // 1周目は 0.5 秒で終わり、眠っている間に時計が戻り、締切（1.2 秒）で返す
    vi.useFakeTimers()
    偽の口({
      a: [{ 遅れて: 500, 答え: wsl(5, 'fresh', { host_free_fresh_for_sec: 60 }) }],
      b: [{ 遅れて: 500, 答え: wsl(9, 'checking') }],
    })
    const { 箱 } = 聞かせる(['a', 'b'], { deadline: deadlineIn(1_200) })
    await vi.advanceTimersByTimeAsync(1_000)
    時計を巻き戻す(30_000)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'stale', host_free_age_sec: null })
  })

  it('ブラウザの時計が巻き戻っても、65 秒の締切は伸びない', async () => {
    // **壁時計で締切を測ると、戻ったぶんだけ聞き直しが続いていた**（Astra 4）
    vi.useFakeTimers()
    const { fetch } = 偽の口({ local: [wsl(9, 'checking')] })
    const { 箱 } = 聞かせる(['local'])
    await vi.advanceTimersByTimeAsync(10_000)
    時計を巻き戻す(60_000)
    await vi.advanceTimersByTimeAsync(RECHECK_LIMIT_MS - 10_000 + RECHECK_INTERVAL_MS * 2)

    expect(台(箱, 'local')).toMatchObject({ host_free_state: 'checking' })
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(RECHECK_LIMIT_MS / RECHECK_INTERVAL_MS + 2)
  })

  it('数えた枚数の有効期限は、PC ごとの「最後の答えを聞き始めた時刻＋新しさの残り」の最も早いもの', async () => {
    // 先に切れるのは、答えるのに 3 秒かかる b のほう（a は即答で、1 秒おきに聞き直している）
    vi.useFakeTimers()
    偽の口({
      a: [wsl(5, 'fresh', { host_free_fresh_for_sec: 50 })],
      b: [{ 遅れて: 3_000, 答え: wsl(5, 'fresh', { host_free_fresh_for_sec: 30 }) }],
    })
    const { 箱 } = 聞かせる(['a', 'b'])
    await vi.advanceTimersByTimeAsync(3_000)

    const freshUntil = (箱.answer as Settled).freshUntil
    expect(freshUntil).not.toBeNull()
    // 聞き始めたのは 3 秒前。**受け取った時刻から測らない**（運ぶ間に古くなったぶんを足さない）
    expect(remainingMs(freshUntil!, instantNow())).toBe(27_000)
    await vi.advanceTimersByTimeAsync(26_999)
    expect(isPast(freshUntil!, instantNow())).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(isPast(freshUntil!, instantNow())).toBe(true)
  })

  it('期限を持つ答えが無ければ、有効期限は付かない（WSL でない・古い PC・数えない PC）', async () => {
    vi.useFakeTimers()
    const 古い = { ...wsl(5, 'fresh') } as Partial<HostResources>
    delete 古い.host_free_fresh_for_sec
    偽の口({
      old: [古い as HostResources],
      linux: [resources(3)],
      off: [wsl(null, 'fresh', { estimate_mb: 0, host_free_fresh_for_sec: 30 })],
    })
    const { 箱 } = 聞かせる(['old', 'linux', 'off'])
    await vi.advanceTimersByTimeAsync(0)

    expect(箱.answer).toMatchObject({ freshUntil: null })
  })

  it('返す瞬間に古くなっていた PC は、有効期限に数えない（確かめられていない側にいる）', async () => {
    vi.useFakeTimers()
    偽の口({
      a: [{ 遅れて: 500, 答え: wsl(5, 'fresh', { host_free_fresh_for_sec: 1 }) }],
      b: [{ 遅れて: 500, 答え: wsl(9, 'checking') }],
    })
    const { 箱 } = 聞かせる(['a', 'b'], { deadline: deadlineIn(2_800) })
    await vi.advanceTimersByTimeAsync(4_000)

    expect(台(箱, 'a')).toMatchObject({ host_free_state: 'stale' })
    expect(箱.answer).toMatchObject({ freshUntil: null })
  })
})

describe('時計（実装レビュー第3回 Astra 4）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('新しさの経過は単調時計で測り、壁時計の巻き戻りは期限切れとして扱う', async () => {
    vi.useFakeTimers()
    const 期限 = { since: instantNow(), ms: 10_000 }
    await vi.advanceTimersByTimeAsync(4_000)
    expect(remainingMs(期限, instantNow())).toBe(6_000)
    // 聞き始めた時刻より前へ戻す。単調時計ではまだ 4 秒しか経っていない
    vi.setSystemTime(Date.now() - 5_000)
    expect(elapsedMs(期限.since, instantNow())).toBe(Number.POSITIVE_INFINITY)
    expect(isPast(期限, instantNow())).toBe(true)
  })

  it('単調時計が止まっていても（寝ていた間）、壁時計が進んだぶんは経ったとみなす', () => {
    vi.useFakeTimers()
    const 期限 = { since: instantNow(), ms: 10_000 }
    const 起きた = { mono: 期限.since.mono, wall: 期限.since.wall + 60_000 }
    expect(isPast(期限, 起きた)).toBe(true)
  })
})
