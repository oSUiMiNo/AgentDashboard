import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { BASE_TITLE } from '@/lib/documentTitle'
import type { ProjectView, SessionMeta } from '@/lib/protocol'
import { useAuthStore } from '@/stores/auth'
import { applyProjectSnapshot, clearProjects } from '@/stores/projects'
import {
  applySessionSnapshot,
  clearSessions,
  upsertSession,
} from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'
import { settingsFixture } from '@/test/fixtures'

/**
 * 見ていた会話が別の席へ移ったときに付いて行く配線（ブランチ設計§7-6）。
 *
 * # なぜこの試験が要るのか
 *
 * **セッション専用画面は席（カード）を見ているが、枝分かれは席の中身を入れ替える。**
 * 押した人と見ていた人が別の端末だと、**見ていた側は何もしていないのに会話が
 * すり替わる**——2026-09-07 に利用者が実機で踏んだ。
 *
 * # なぜ `App.title.test.tsx` の隣に置くのか
 *
 * あちらと同じく **URL を動かす**必要があり、`App.test.tsx` の `beforeEach` は
 * `location` を静的なオブジェクトへ差し替えているので `/s/…` が開けない。
 * 観点でファイルを割る、という既にある割り方に従う。
 */

const 見ている席 = '11111111-2222-3333-4444-555555555555'
const 戻った席 = '99999999-8888-7777-6666-555555555555'
const 会話A = 'aaaaaaaa-1111-2222-3333-444444444444'
const 枝の会話 = 'bbbbbbbb-1111-2222-3333-444444444444'
const WORK_DIR = '/home/example/dev/家計簿'
const NOW = 1_700_000_000_000

const OPEN_MODE = JSON.stringify({
  mode: 'open',
  authenticated: true,
  account: null,
  is_admin: false,
  setup_open: false,
  from_loopback: true,
})

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  binaryType = 'blob'
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  send() {}
  close() {}
}

function project(path: string): ProjectView {
  return { id: path, host: 'local', path, created_at: NOW, position: 0 }
}

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    card_id: 見ている席,
    project: WORK_DIR,
    claude_session_id: 会話A,
    resumed_from: null,
    permission_mode: 'default',
    model: null,
    model_label: null,
    model_requested: null,
    status: { kind: 'waiting_input' },
    subagent_active: 0,
    last_activity_at: NOW,
    last_assistant_message: 'はい',
    created_at: NOW,
    hooks_seen: true,
    agent_id: null,
    agent_connected: true,
    account: null,
    toml_account: null,
    session_title: null,
    position: 0,
    nickname: null,
    branched_from: null,
    context_usage: null,
    ...overrides,
  }
}

function 開く(path: string) {
  window.history.pushState({}, '', path)
  return render(<App />)
}

/** 見ている席が枝に置き換わる（`/branch` が効いた瞬間の形）。 */
function 枝にする() {
  upsertSession(
    meta({ claude_session_id: 枝の会話, branched_from: 会話A }),
  )
}

/** 元の会話が別の席で立つ（呼び戻しが済んだ形）。 */
function 元が戻る() {
  upsertSession(
    meta({ card_id: 戻った席, claude_session_id: 会話A, position: 1 }),
  )
}

beforeEach(() => {
  document.title = BASE_TITLE
  useSettingsStore.setState({ settings: settingsFixture() })
  useAuthStore.setState({
    auth: {
      mode: 'open',
      authenticated: false,
      account: null,
      is_admin: false,
      setup_open: false,
      from_loopback: false,
    },
    loading: true,
    lastError: null,
    serverChanged: false,
  })
  vi.stubGlobal('WebSocket', FakeWebSocket)
  /*
    **設定は本物の形で返す。** ここを `[]` にすると `loadSettings()` が選択肢を
    潰し、**待ち時間の長い試験でだけ**権限モードの部品が落ちる（短い試験は
    取得が終わる前に済んでしまうので表に出ない）
  */
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/me') {
        return new Response(OPEN_MODE, { status: 200 })
      }
      if (url === '/api/settings') {
        return new Response(JSON.stringify(settingsFixture()), { status: 200 })
      }
      return new Response('[]', { status: 200 })
    }),
  )
})

afterEach(() => {
  useWsStore.getState().disconnect()
  clearSessions()
  clearProjects()
  vi.unstubAllGlobals()
  window.history.pushState({}, '', '/')
  document.title = BASE_TITLE
})

describe('見ていた会話が移ったら、付いて行く', () => {
  it('席が枝に置き換わり、元の会話が別の席で立ったら、そちらへ移る', async () => {
    applyProjectSnapshot([project(WORK_DIR)])
    applySessionSnapshot([meta()])
    開く(`/s/${見ている席}`)
    await screen.findByTestId('session-view')

    枝にする()
    元が戻る()

    // **一言出してから移る**（承認は求めない）
    expect(
      await screen.findByTestId('conversation-moved-banner'),
    ).toHaveAttribute('data-state', 'found')
    await waitFor(
      () => expect(window.location.pathname).toBe(`/s/${戻った席}`),
      { timeout: 4_000 },
    )
  })

  it('元の会話がまだ立っていない間は、待つ（勝手に飛ばない）', async () => {
    /*
      呼び戻しには claude の起動が含まれるので、枝になった瞬間には行き先が無い。
      **ここで諦めて飛ばすと、どこへ行ったか分からなくなる。**
    */
    applyProjectSnapshot([project(WORK_DIR)])
    applySessionSnapshot([meta()])
    開く(`/s/${見ている席}`)
    await screen.findByTestId('session-view')

    枝にする()

    expect(
      await screen.findByTestId('conversation-moved-banner'),
    ).toHaveAttribute('data-state', 'searching')
    expect(window.location.pathname).toBe(`/s/${見ている席}`)
  })

  it('もとから枝だった席を開いただけでは、動かない', async () => {
    /*
      **枝になった瞬間を目撃していなければ追わない。** 利用者が自分で開いた枝を、
      勝手に別の席へ飛ばさないためである。ここが無いと、枝を読みに来た人が
      毎回きっかけなく元へ飛ばされる。
    */
    applyProjectSnapshot([project(WORK_DIR)])
    applySessionSnapshot([
      meta({ claude_session_id: 枝の会話, branched_from: 会話A }),
      meta({ card_id: 戻った席, claude_session_id: 会話A, position: 1 }),
    ])
    開く(`/s/${見ている席}`)
    await screen.findByTestId('session-view')

    expect(screen.queryByTestId('conversation-moved-banner')).toBeNull()
    expect(window.location.pathname).toBe(`/s/${見ている席}`)
  })

  it('別の席で枝分かれが起きても、こちらは動かない', async () => {
    applyProjectSnapshot([project(WORK_DIR)])
    applySessionSnapshot([meta()])
    開く(`/s/${見ている席}`)
    await screen.findByTestId('session-view')

    // 隣の席が枝になっただけ。見ている席の中身は変わっていない
    upsertSession(
      meta({
        card_id: 戻った席,
        claude_session_id: 枝の会話,
        resumed_from: null,
        branched_from: 'cccccccc-1111-2222-3333-444444444444',
        position: 1,
      }),
    )

    await waitFor(() =>
      expect(screen.queryByTestId('conversation-moved-banner')).toBeNull(),
    )
    expect(window.location.pathname).toBe(`/s/${見ている席}`)
  })
})
