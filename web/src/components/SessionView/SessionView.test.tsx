import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionView } from './SessionView'
import type { SessionMeta } from '@/lib/protocol'
import { applySessionSnapshot, clearSessions } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { settingsFixture } from '@/test/fixtures'

/**
 * 別の PC の画面が「どれくらいの間隔で届くか」の表示（セルフホスト化設計§11-3）。
 *
 * # なぜこれを固定するのか
 *
 * リモートのターミナルは、何もしていない間は間隔をあけて届く（既定20秒）。数字が
 * 出ていないと、**「相手が止まっている」と「間引かれているだけ」が同じに見える**。
 * 逆に、この PC のセッションでは生バイトがそのまま届くので、出すと嘘になる。
 *
 * 「出る条件」と「出ない条件」の両方を見るのがこのテストの要点で、片方だけだと
 * 「いつも出る」実装でも通ってしまう。
 */

const CARD = '11111111-2222-3333-4444-555555555555'
const NOW = 1_700_000_000_000

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    card_id: CARD,
    project: '/home/example/dev/app',
    claude_session_id: null,
    permission_mode: 'default',
    model: null,
    model_label: null,
    model_requested: null,
    status: { kind: 'working' },
    subagent_active: 0,
    last_activity_at: NOW,
    last_assistant_message: null,
    created_at: NOW,
    hooks_seen: true,
    agent_id: null,
    agent_connected: true,
    account: null,
    toml_account: null,
    ...overrides,
  }
}

function settings(screen_interval_ms: number) {
  useSettingsStore.setState({
    settings: settingsFixture({
      intervals: {
        sync_interval_secs: 20,
        screen_interval_ms,
        scrollback_lines: 1000,
      },
    }),
    loading: false,
  })
}

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

describe('SessionView の更新間隔表示', () => {
  it('別の PC のターミナルを開いていると出る', () => {
    settings(20_000)
    applySessionSnapshot([meta({ agent_id: 'agent-1' })])

    render(<SessionView cardId={CARD} compact />)

    expect(screen.getByTestId('screen-interval')).toHaveTextContent('更新間隔 20秒')
  })

  it('この PC のセッションでは出さない', () => {
    // ローカルは生バイトが直に届くので、間隔という概念が無い（設計§7-2）
    settings(20_000)
    applySessionSnapshot([meta({ agent_id: null })])

    render(<SessionView cardId={CARD} compact />)

    expect(screen.queryByTestId('screen-interval')).toBeNull()
  })

  it('構造化ビューを見ているときは出さない', () => {
    // 更新間隔が効くのは画面配信だけ（要件5-5）。履歴や指示送信は間隔と無関係なので、
    // 構造化ビューの脇に出すと「履歴も20秒遅れる」と誤解させる
    settings(20_000)
    applySessionSnapshot([meta({ agent_id: 'agent-1' })])

    render(<SessionView cardId={CARD} />)

    expect(screen.queryByTestId('screen-interval')).toBeNull()
  })
})

/**
 * セッション専用画面の左パネル（設計§28）。
 *
 * **PJT 専用画面と同じ部品・同じ経路**で出す。ここが別実装になると、片方だけ直した
 * ときに辿り方や相対パスの基準が食い違う——同じ列挙の口を使う部品が2つの作法を
 * 持ってはいけない、という §13 の約束がそのまま効く。
 */
describe('セッション専用画面のファイル', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            path: '/home/example/dev/app',
            entries: [{ name: 'MyDocs', kind: 'dir', is_project: false }],
            truncated: false,
          }),
          { status: 200 },
        ),
      ),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ハンバーガーで左パネルが開き、そのセッションの枠から始まる', async () => {
    clearSessions()
    applySessionSnapshot([meta()])
    useSettingsStore.setState({ settings: settingsFixture(), loading: false, lastError: null })
    render(<SessionView cardId={CARD} />)

    expect(screen.queryByTestId('project-files-panel')).toBeNull()
    await userEvent.click(screen.getByTestId('project-files-toggle'))

    expect(screen.getByTestId('project-files-panel')).toBeInTheDocument()
    // 起点はそのセッションの作業ディレクトリ（PJT 専用画面と同じ根拠）
    await waitFor(() =>
      expect(screen.getByTestId('folder-browser')).toHaveAttribute(
        'data-path',
        '/home/example/dev/app',
      ),
    )
  })

  it('横並び（compact）では出さない', () => {
    clearSessions()
    applySessionSnapshot([meta()])
    useSettingsStore.setState({ settings: settingsFixture(), loading: false, lastError: null })
    render(<SessionView cardId={CARD} compact />)

    // PJT 専用画面が既に持っているので、セッションの数だけ同じものを出さない
    expect(screen.queryByTestId('project-files-toggle')).toBeNull()
  })
})
