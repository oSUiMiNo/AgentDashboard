import { act, renderHook } from '@testing-library/react'
import type { SessionMeta } from '@/lib/protocol'
import {
  applySessionSnapshot,
  clearSessions,
  getSession,
  patchSessionStatus,
  removeSession,
  upsertSession,
  useProjectCards,
  useProjectGroups,
  useSessionCard,
} from './sessions'

/**
 * 一覧のストア（テスト計画フェーズ5「ストア」）。
 *
 * 守るべき約束は3つ。
 * - 受信は **rAF でまとめてから一括で反映**する（1件ごとに通知しない）
 * - **カード単位に通知**する（1枚の状態変化で他の小窓を巻き込まない）
 * - **構造（箱の並びと所属）は状態の変化では動かない**（一覧の親が作り直されない）
 */

const A = 'aaaaaaaa-0000-0000-0000-000000000001'
const B = 'bbbbbbbb-0000-0000-0000-000000000002'
const PROJECT = '/home/example/dev/app'
const OTHER = '/home/example/dev/other'

/** ストアは rAF でまとめてから反映するので、テストでは即座に流す。 */
beforeEach(() => {
  clearSessions()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearSessions()
})

function meta(cardId: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    card_id: cardId,
    project: PROJECT,
    claude_session_id: null,
    permission_mode: null,
    model: null,
    model_label: null,
    model_requested: null,
    status: { kind: 'working' },
    subagent_active: 0,
    last_activity_at: 1_700_000_000_000,
    last_assistant_message: null,
    created_at: 1_700_000_000_000,
    hooks_seen: true,
    agent_id: null,
    agent_connected: true,
    account: null,
    toml_account: null,
    ...overrides,
  }
}

describe('一覧ストア', () => {
  it('カード1枚の購読は自分の変化だけを受け取る', () => {
    // ここが崩れると、フックがツールコールのたびに飛んでくるたびに
    // 12枚ぶんの小窓が再レンダリングの判定に入る
    applySessionSnapshot([meta(A), meta(B)])

    const cardA = renderHook(() => useSessionCard(A))
    const cardB = renderHook(() => useSessionCard(B))
    const rendersB = () => cardB.result.current

    const beforeB = rendersB()
    act(() => {
      patchSessionStatus({
        card_id: A,
        status: { kind: 'waiting_permission' },
        subagent_active: 0,
        last_activity_at: 1_700_000_001_000,
      })
    })

    expect(cardA.result.current?.status).toEqual({ kind: 'waiting_permission' })
    // B は同じオブジェクトのまま＝React から見て「変わっていない」
    expect(rendersB()).toBe(beforeB)
  })

  it('状態の差分では構造が変わらない', () => {
    applySessionSnapshot([meta(A), meta(B)])
    const { result } = renderHook(() => useProjectGroups())
    const before = result.current

    act(() => {
      patchSessionStatus({
        card_id: A,
        status: { kind: 'stalled' },
        subagent_active: 3,
        last_activity_at: 1_700_000_001_000,
      })
    })

    // 同じ配列を返し続ける＝一覧の親（箱）は作り直されない
    expect(result.current).toBe(before)
  })

  it('カードが増減すると構造が変わる', () => {
    const { result } = renderHook(() => useProjectGroups())
    expect(result.current).toHaveLength(0)

    act(() => upsertSession(meta(A)))
    expect(result.current).toHaveLength(1)
    expect(result.current[0].cards).toEqual([A])

    act(() => upsertSession(meta(B, { project: OTHER })))
    expect(result.current.map((group) => group.project)).toEqual([PROJECT, OTHER])

    act(() => removeSession(A))
    expect(result.current.map((group) => group.project)).toEqual([OTHER])
  })

  it('箱の並びも中の並びも最初に現れた順で安定する', () => {
    // 更新のたびに位置が入れ替わると、一覧を見ている側が目で追えなくなる
    applySessionSnapshot([
      meta('c', { project: '/dev/zzz', created_at: 1 }),
      meta('a', { project: '/dev/aaa', created_at: 2 }),
      meta('d', { project: '/dev/zzz', created_at: 3 }),
    ])
    const { result } = renderHook(() => useProjectGroups())

    expect(result.current.map((group) => group.project)).toEqual([
      '/dev/zzz',
      '/dev/aaa',
    ])
    expect(result.current[0].cards).toEqual(['c', 'd'])
  })

  it('まとめて届いた更新は一括で反映される', () => {
    applySessionSnapshot([meta(A)])
    const { result } = renderHook(() => useSessionCard(A))

    // 反映を保留させて「何フレーム要求したか」を数える
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })

    // バースト。1件ごとに通知していたら、この回数だけ描画が走る
    for (let index = 1; index <= 5; index += 1) {
      patchSessionStatus({
        card_id: A,
        status: { kind: 'working' },
        subagent_active: index,
        last_activity_at: 1_700_000_000_000 + index,
      })
    }

    expect(frames).toHaveLength(1)
    // 流す前は手元の値が動いていない（＝1件ごとに反映していない）
    expect(result.current?.subagent_active).toBe(0)

    act(() => frames[0](0))
    // 流したあとは最後の値になっている（途中の値は画面に出ない）
    expect(result.current?.subagent_active).toBe(5)
  })

  it('プロジェクト単位のカードは同じ配列を返し続ける', () => {
    // 毎回新しい配列を返すと useSyncExternalStore が無限に描き直す
    applySessionSnapshot([meta(A)])
    const found = renderHook(() => useProjectCards('local', PROJECT))
    const missing = renderHook(() => useProjectCards('local', '/dev/nowhere'))

    expect(found.result.current).toEqual([A])
    expect(missing.result.current).toEqual([])

    const before = missing.result.current
    missing.rerender()
    expect(missing.result.current).toBe(before)
  })

  it('知らないカードへの状態差分は捨てる', () => {
    // `session_upsert` より先に `status` が届くことがある。落ちてはいけない
    act(() =>
      patchSessionStatus({
        card_id: A,
        status: { kind: 'working' },
        subagent_active: 0,
        last_activity_at: 1,
      }),
    )
    const { result } = renderHook(() => useSessionCard(A))
    expect(result.current).toBeUndefined()
  })

  it('スナップショットは手元を置き換える', () => {
    // 再接続したときの作り直し。真実は常にサーバ側にある
    applySessionSnapshot([meta(A), meta(B)])
    applySessionSnapshot([meta(B)])

    const { result } = renderHook(() => useProjectGroups())
    expect(result.current[0].cards).toEqual([B])
  })

  it('スナップショットはフレームを待たずにその場で反映される', () => {
    // 「接続済みと出ているのに一覧がまだ空」という隙間を作らないための約束。
    // ここが崩れると、一覧が出るより先に「カードは0枚」と判断されてしまう
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })

    applySessionSnapshot([meta(A)])
    // rAF を1度も回していないのに、もう読める
    expect(getSession(A)).toBeDefined()
  })
})
