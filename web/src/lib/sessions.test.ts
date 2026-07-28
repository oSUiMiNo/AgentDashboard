import { act, renderHook } from '@testing-library/react'
import { groupByProject, useNow } from './sessions'
import type { SessionMeta } from './protocol'

function session(cardId: string, project: string): SessionMeta {
  return {
    card_id: cardId,
    project,
    claude_session_id: null,
    status: { kind: 'working' },
    subagent_active: 0,
    last_activity_at: 0,
    last_assistant_message: null,
    created_at: 0,
  }
}

describe('groupByProject', () => {
  it('同じ作業ディレクトリのセッションが1つの箱にまとまる', () => {
    const groups = groupByProject([
      session('a', '/dev/app'),
      session('b', '/dev/other'),
      session('c', '/dev/app'),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0].project).toBe('/dev/app')
    expect(groups[0].sessions.map((item) => item.card_id)).toEqual(['a', 'c'])
    expect(groups[1].sessions.map((item) => item.card_id)).toEqual(['b'])
  })

  it('箱の並びは最初に現れた順で安定する', () => {
    // 更新のたびに箱の位置が入れ替わると、見ている側が目で追えなくなる
    const groups = groupByProject([
      session('a', '/dev/zzz'),
      session('b', '/dev/aaa'),
    ])
    expect(groups.map((group) => group.project)).toEqual(['/dev/zzz', '/dev/aaa'])
  })

  it('セッションが無ければ箱も無い', () => {
    expect(groupByProject([])).toEqual([])
  })
})

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('1秒ごとに現在時刻が進む', () => {
    // 経過時間の表示（「作業中・最終活動 3分前」）はこの時計で動く
    const { result } = renderHook(() => useNow())
    const first = result.current

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBeGreaterThanOrEqual(first + 1000)

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(result.current).toBeGreaterThanOrEqual(first + 3000)
  })

  it('画面から外れたらタイマーを止める', () => {
    const { unmount } = renderHook(() => useNow())
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
