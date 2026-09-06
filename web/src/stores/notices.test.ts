import { act, renderHook } from '@testing-library/react'
import type { SessionMeta } from '@/lib/protocol'
import {
  applySessionSnapshot,
  clearCardNotices,
  clearSessions,
  pushCardNotice,
  removeSession,
  useCardError,
  useCardNotices,
} from './sessions'

/**
 * カードに溜まる断りの器（細かい修正 設計§7-1〜§7-3。テスト計画フェーズ4）。
 *
 * 守るべき約束は3つ。
 * - **上書きではなく積む**（続けざまに断られたとき、新しいほうが前のものを消さない）
 * - **寿命は「定位置の行から下ろす」であって「器から捨てる」ではない**（下ろしてもベルに残る）
 * - **器から出るのは「次に同じ操作が通った」「カードが消えた」「溢れた」「読み込み直し」の4つだけ**
 */

const A = 'aaaaaaaa-0000-0000-0000-000000000001'

beforeEach(() => {
  clearSessions()
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  clearSessions()
})

function meta(cardId: string): SessionMeta {
  return {
    card_id: cardId,
    project: '/home/example/dev/app',
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
  } as SessionMeta
}

describe('積む器', () => {
  it('新しい断りが、前の断りを消さない', () => {
    // 1本の文字列だったころは無条件に上書きしていたので、**先に断られた理由が読めなかった**
    const { result } = renderHook(() => useCardNotices(A))
    act(() => pushCardNotice(A, '切り替えられません', 'permission_mode'))
    act(() => pushCardNotice(A, '起こせませんでした', 'revive'))

    expect(result.current).toHaveLength(2)
    expect(result.current.map((n) => n.message)).toEqual([
      '切り替えられません',
      '起こせませんでした',
    ])
  })

  it('定位置に出るのは、いちばん新しい1件', () => {
    const { result } = renderHook(() => useCardError(A))
    act(() => pushCardNotice(A, '古いほう', 'permission_mode'))
    act(() => pushCardNotice(A, '新しいほう', 'model'))

    expect(result.current).toBe('新しいほう')
  })

  it('時刻を持つ（どれがいつのものか分かる）', () => {
    const { result } = renderHook(() => useCardNotices(A))
    act(() => pushCardNotice(A, '起こせません', 'revive'))

    expect(result.current[0].createdAt).toBeGreaterThan(0)
  })

  it('溜まりすぎない。溢れたら古いほうから捨てる', () => {
    // **上限を決めないと、`記録が際限なく育ち、掃除する道が無い` と同じ道を通る**
    const { result } = renderHook(() => useCardNotices(A))
    act(() => {
      for (let i = 0; i < 25; i += 1) {
        pushCardNotice(A, `${i}件目`, 'revive')
      }
    })

    expect(result.current).toHaveLength(20)
    expect(result.current[0].message).toBe('5件目')
    expect(result.current.at(-1)?.message).toBe('24件目')
  })

  it('何も溜まっていないときは、毎回同じ配列を返す', () => {
    // 毎回新しい配列を返すと `useSyncExternalStore` が無限に鳴る
    const { result, rerender } = renderHook(() => useCardNotices(A))
    const 最初 = result.current
    rerender()
    expect(result.current).toBe(最初)
  })
})

describe('寿命', () => {
  it('どの種別も、5秒で定位置の行から下りる', () => {
    /*
      **種別で分けるのはやめた**（2026-09-06・利用者の指定）。かつては復旧・見つからない・
      端末が開けない・枝分かれの4種を「消えない」側に置いていたが、**下ろしてもベルに
      残るなら読める**ので、分ける理由が無くなった。
    */
    const { result } = renderHook(() => useCardError(A))
    for (const kind of [
      'permission_mode',
      'model',
      'send_input',
      'revive',
      'not_found',
      'sub_pty',
      'branch',
      'other',
    ] as const) {
      act(() => {
        clearCardNotices(A)
        pushCardNotice(A, `${kind} が断られました`, kind)
      })
      expect(result.current, kind).toBe(`${kind} が断られました`)

      act(() => void vi.advanceTimersByTime(5_000))

      expect(result.current, kind).toBeNull()
    }
  })

  it('行から下りても、ベルには残る', () => {
    /*
      **ここが 2026-09-06 に直したところ。** かつては寿命が来ると器ごと捨てていたので、
      「5秒で消える」種別は**ベルからも消えていた**——利用者から見ると「消える種別は
      読めなくなり、読める種別は消えない」で、どちらも約束どおりでなかった。
    */
    const 行 = renderHook(() => useCardError(A))
    const ベル = renderHook(() => useCardNotices(A))
    act(() => pushCardNotice(A, '見つかりません', 'not_found'))

    act(() => void vi.advanceTimersByTime(5_000))

    expect(行.result.current, '行からは下りている').toBeNull()
    expect(ベル.result.current, 'ベルには残っている').toHaveLength(1)
    expect(ベル.result.current[0].message).toBe('見つかりません')
    expect(ベル.result.current[0].retired).toBe(true)
  })

  it('5秒より前には下りない', () => {
    const { result } = renderHook(() => useCardError(A))
    act(() => pushCardNotice(A, 'モード', 'permission_mode'))

    act(() => void vi.advanceTimersByTime(4_900))

    expect(result.current).toBe('モード')
  })

  it('下ろす時刻は積んだ瞬間に決まる（あとから寿命の表を変えても遡らない）', () => {
    const { result } = renderHook(() => useCardNotices(A))
    act(() => pushCardNotice(A, 'モード', 'permission_mode'))
    const 焼いた時刻 = result.current[0].expiresAt
    expect(焼いた時刻).not.toBeNull()

    act(() => void vi.advanceTimersByTime(5_000))

    // 下ろしたあとも、焼いた時刻はそのまま残る（読むたびに引き直していない証拠）
    expect(result.current[0].expiresAt).toBe(焼いた時刻)
  })

  it('来たものから順に下り、行には次に新しいものが出る', () => {
    const 行 = renderHook(() => useCardError(A))
    act(() => pushCardNotice(A, '先', 'permission_mode'))
    act(() => void vi.advanceTimersByTime(2_000))
    act(() => pushCardNotice(A, '後', 'model'))
    expect(行.result.current).toBe('後')

    // 先のぶんだけ寿命が来る（後のぶんはあと2秒ある）
    act(() => void vi.advanceTimersByTime(3_000))

    expect(行.result.current, '後のぶんはまだ行に居る').toBe('後')

    act(() => void vi.advanceTimersByTime(2_000))

    expect(行.result.current).toBeNull()
  })
})

describe('消える契機', () => {
  it('次に同じ操作が通ったら、その操作の断りだけが消える', () => {
    const { result } = renderHook(() => useCardNotices(A))
    act(() => {
      pushCardNotice(A, 'モード', 'permission_mode')
      pushCardNotice(A, '起こせません', 'revive')
    })

    act(() => clearCardNotices(A, 'revive'))

    expect(result.current).toHaveLength(1)
    expect(result.current[0].kind).toBe('permission_mode')
  })

  it('種別を省くと、そのカードの断りが全部消える', () => {
    const { result } = renderHook(() => useCardNotices(A))
    act(() => {
      pushCardNotice(A, 'モード', 'permission_mode')
      pushCardNotice(A, '起こせません', 'revive')
    })

    act(() => clearCardNotices(A))

    expect(result.current).toHaveLength(0)
  })

  it('消すものが無いときは、何も起きない', () => {
    const { result } = renderHook(() => useCardNotices(A))
    act(() => pushCardNotice(A, 'モード', 'permission_mode'))

    act(() => clearCardNotices(A, 'revive'))

    expect(result.current).toHaveLength(1)
  })
})

describe('カードごと消えたとき', () => {
  it('溜まっていた断りも一緒に消える（既存の道が生きている）', () => {
    applySessionSnapshot([meta(A)])
    const { result } = renderHook(() => useCardNotices(A))
    act(() => pushCardNotice(A, '起こせません', 'revive'))
    expect(result.current).toHaveLength(1)

    act(() => removeSession(A))

    expect(result.current).toHaveLength(0)
  })
})
