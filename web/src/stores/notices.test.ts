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
 * - **寿命は種別で割る**（読む前に消えてよいものと、そうでないものがある）
 * - **消えるのは「時間が来た」か「次に同じ操作が通った」ときだけ**
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
  it('モードの切替・モデルの切替・入力の送信は5秒で消える', () => {
    const { result } = renderHook(() => useCardNotices(A))
    act(() => {
      pushCardNotice(A, 'モード', 'permission_mode')
      pushCardNotice(A, 'モデル', 'model')
      pushCardNotice(A, '送信', 'send_input')
    })
    expect(result.current).toHaveLength(3)

    act(() => void vi.advanceTimersByTime(5_000))

    expect(result.current).toHaveLength(0)
  })

  it('5秒より前には消えない', () => {
    const { result } = renderHook(() => useCardNotices(A))
    act(() => pushCardNotice(A, 'モード', 'permission_mode'))

    act(() => void vi.advanceTimersByTime(4_900))

    expect(result.current).toHaveLength(1)
  })

  it('復旧の失敗は消えない', () => {
    /*
      **空きメモリ不足のような、解消を観測する手段が無いもの**が混ざる。5秒で消すと、
      押した理由そのものが読めなくなる（設計§7-3）。
    */
    const { result } = renderHook(() => useCardNotices(A))
    act(() => pushCardNotice(A, '空きが足りません', 'revive'))

    act(() => void vi.advanceTimersByTime(60_000))

    expect(result.current).toHaveLength(1)
  })

  it('カードが見つからない・端末が開けない も消えない', () => {
    const { result } = renderHook(() => useCardNotices(A))
    act(() => {
      pushCardNotice(A, '見つかりません', 'not_found')
      pushCardNotice(A, '端末を開けません', 'sub_pty')
    })

    act(() => void vi.advanceTimersByTime(60_000))

    expect(result.current).toHaveLength(2)
  })

  it('種別を持たない断りは、その他として5秒で消える', () => {
    // 欄を持たない古いサーバから来たものがここに落ちる
    const { result } = renderHook(() => useCardNotices(A))
    act(() => pushCardNotice(A, '何かに失敗しました'))

    act(() => void vi.advanceTimersByTime(5_000))

    expect(result.current).toHaveLength(0)
  })

  it('消える時刻は積んだ瞬間に決まる（あとから寿命の表を変えても遡らない）', () => {
    const { result } = renderHook(() => useCardNotices(A))
    act(() => pushCardNotice(A, 'モード', 'permission_mode'))
    expect(result.current[0].expiresAt).not.toBeNull()
    act(() => {
      clearCardNotices(A)
      pushCardNotice(A, '起こせません', 'revive')
    })
    expect(result.current[0].expiresAt).toBeNull()
  })

  it('寿命の違うものが混ざっていても、来たものから順に消える', () => {
    const { result } = renderHook(() => useCardNotices(A))
    act(() => {
      pushCardNotice(A, 'モード', 'permission_mode')
      pushCardNotice(A, '起こせません', 'revive')
    })

    act(() => void vi.advanceTimersByTime(5_000))

    expect(result.current).toHaveLength(1)
    expect(result.current[0].kind).toBe('revive')
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
