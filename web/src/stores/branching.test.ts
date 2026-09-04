import { act, renderHook } from '@testing-library/react'
import type { SessionMeta } from '@/lib/protocol'
import {
  applySessionSnapshot,
  clearSessions,
  markBranching,
  pushCardNotice,
  useBranching,
  useCardNotices,
} from './sessions'

/**
 * 枝分かれの進行中と、失敗したときの復旧（ブランチ設計§4-3・§7-4。テスト計画フェーズ4）。
 *
 * 守るべき約束は3つ。
 * - **押した手応えが出る**（段取りには2回の待ちがあり、その間カードは1バイトも変わらない）
 * - **終わりは「元の会話が別の席に立った」とき**（枝ができただけでは終わりではない）
 * - **席を失ったときは、そのまま押せる道が残る**（利用者は UUID を読まない）
 */

const 押した席 = 'aaaaaaaa-0000-0000-0000-000000000001'
const 戻った席 = 'aaaaaaaa-0000-0000-0000-000000000002'
const 元の会話 = 'bbbbbbbb-0000-0000-0000-000000000001'
const 枝の会話 = 'bbbbbbbb-0000-0000-0000-000000000002'

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

function meta(cardId: string, claudeSessionId: string | null): SessionMeta {
  return {
    card_id: cardId,
    project: '/home/example/dev/app',
    claude_session_id: claudeSessionId,
    permission_mode: null,
    model: null,
    model_label: null,
    model_requested: null,
    status: { kind: 'waiting_input' },
    subagent_active: 0,
    last_activity_at: 1_700_000_000_000,
    last_assistant_message: null,
    created_at: 1_700_000_000_000,
    hooks_seen: true,
    agent_id: null,
    agent_connected: true,
    account: null,
    toml_account: null,
    nickname: null,
    branched_from: null,
  } as SessionMeta
}

describe('進行中の印', () => {
  it('頼んだら立ち、押した手応えになる', () => {
    const { result } = renderHook(() => useBranching(押した席))
    expect(result.current).toBe(false)
    act(() => markBranching(押した席, 元の会話))
    expect(result.current).toBe(true)
  })

  it('枝ができただけでは降りない（元が席を持って初めて終わり）', () => {
    // **ここが要点。** 押した席のIDが枝へ張り替わっただけで降ろすと、呼び戻しが
    // 失敗して席を1つ失っている最中でも「終わった」ように見える
    const { result } = renderHook(() => useBranching(押した席))
    act(() => markBranching(押した席, 元の会話))
    act(() => applySessionSnapshot([meta(押した席, 枝の会話)]))
    expect(result.current).toBe(true)
  })

  it('元の会話が別の席に立ったら降りる', () => {
    const { result } = renderHook(() => useBranching(押した席))
    act(() => markBranching(押した席, 元の会話))
    act(() =>
      applySessionSnapshot([meta(押した席, 枝の会話), meta(戻った席, 元の会話)]),
    )
    expect(result.current).toBe(false)
  })

  it('断りが来たら降りる（押せないカードが残らない）', () => {
    const { result } = renderHook(() => useBranching(押した席))
    act(() => markBranching(押した席, 元の会話))
    act(() => pushCardNotice(押した席, '枝分かれできませんでした', 'branch'))
    expect(result.current).toBe(false)
  })
})

describe('席を失ったときの復旧', () => {
  it('断りが、そのまま押せる呼び戻しを抱えている', () => {
    const { result } = renderHook(() => useCardNotices(押した席))
    act(() => markBranching(押した席, 元の会話))
    act(() => pushCardNotice(押した席, '元の会話を呼び戻せませんでした', 'branch'))
    expect(result.current[0]?.recover).toEqual({
      label: 'もう一度呼び戻す',
      claudeSessionId: 元の会話,
    })
  })

  it('枝分かれの断りは、時間では消えない', () => {
    // 5秒で消すと、**会話が消えた**と読まれる（設計§4-3）
    const { result } = renderHook(() => useCardNotices(押した席))
    act(() => markBranching(押した席, 元の会話))
    act(() => pushCardNotice(押した席, '呼び戻せませんでした', 'branch'))
    act(() => vi.advanceTimersByTime(30_000))
    expect(result.current).toHaveLength(1)
    expect(result.current[0]?.expiresAt).toBeNull()
  })

  it('押していない断りには、押せる道を付けない', () => {
    // 控えを持っていないのに道を出すと、**どこへ戻るのか決まっていない**ボタンになる
    const { result } = renderHook(() => useCardNotices(押した席))
    act(() => pushCardNotice(押した席, '枝分かれできませんでした', 'branch'))
    expect(result.current[0]?.recover).toBeUndefined()
  })

  it('枝分かれ以外の断りには付かない', () => {
    const { result } = renderHook(() => useCardNotices(押した席))
    act(() => markBranching(押した席, 元の会話))
    act(() => pushCardNotice(押した席, '起こし直せません', 'revive'))
    expect(result.current[0]?.recover).toBeUndefined()
  })
})
