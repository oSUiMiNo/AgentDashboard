import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { BASE_TITLE } from '@/lib/documentTitle'
import type { ProjectView, SessionMeta } from '@/lib/protocol'
import { useAuthStore } from '@/stores/auth'
import { applyProjectSnapshot, clearProjects } from '@/stores/projects'
import { applySessionSnapshot, clearSessions } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'
import { settingsFixture } from '@/test/fixtures'

/**
 * タブの名前の配線（テスト計画フェーズ4）。
 *
 * # なぜ `App.test.tsx` に足さないのか
 *
 * あちらの `beforeEach` は読み直しを見るために **`location` を静的なオブジェクトへ
 * 差し替えている**ので、`pathname` が固まる。`pushState` しても react-router が見る
 * 場所が動かず、**`/p/…` も `/s/…` も開けない**。観点でファイルを割る（`TranscriptTree`
 * の `.image` / `.scroll` と同じ）。
 *
 * # なぜ `App` ごと描くのか
 *
 * 名前を出すのは `GroupPage` と `SessionPage` で、**どちらも export されていない**。
 * 「ページ層に置く」という設計そのものを確かめたいので、ルートを別に組み直さず
 * `App` の持つルート表をそのまま通す。
 */

const CARD = '11111111-2222-3333-4444-555555555555'
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

function project(path: string, overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    id: path,
    host: 'local',
    path,
    created_at: NOW,
    position: 0,
    ...overrides,
  }
}

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    card_id: CARD,
    project: WORK_DIR,
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
    session_title: null,
    position: 0,
    nickname: null,
    ...overrides,
  }
}

/** その URL で `App` を描く。**`App` は `BrowserRouter` を内に持つ**ので、履歴を先に積む。 */
function 開く(path: string) {
  window.history.pushState({}, '', path)
  return render(<App />)
}

beforeEach(() => {
  document.title = BASE_TITLE
  // 権限モードの選択肢はサーバから届く設定に入っている。**空のままだと
  // `PermissionModePicker` が描けず**、セッションの区画ごと落ちる
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/me'
        ? new Response(OPEN_MODE, { status: 200 })
        : new Response('[]', { status: 200 }),
    ),
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

describe('タブの名前', () => {
  it('PJT 専用画面では、その PJT の名前が先に出る', async () => {
    applyProjectSnapshot([project(WORK_DIR)])

    開く(`/p/local/${encodeURIComponent(WORK_DIR)}`)

    // **ルートは `GET /api/me` の答えを待ってから描かれる**（それまでは何も出さない）
    // ので、同期に読むと既定のままの姿を見てしまう。
    //
    // 名前が先、既定が後。**タブが狭まったときに残るのは前半**なので、ここが逆だと
    // この工事そのものが消える
    await waitFor(() => expect(document.title).toBe(`家計簿 — ${BASE_TITLE}`))
  })

  it('セッション専用画面では、そのカードが属する PJT の名前が出る', async () => {
    applyProjectSnapshot([project(WORK_DIR)])
    applySessionSnapshot([meta()])

    開く(`/s/${CARD}`)

    await waitFor(() => expect(document.title).toBe(`家計簿 — ${BASE_TITLE}`))
  })

  it('同名の PJT を開くと、タブにも番号が付く', async () => {
    /*
      **ここが「帯と同じ関数を通している」ことの唯一の番人。** 名前を自前で
      組み立てても（末尾を取るだけでも）他の断言は全部通ってしまうので、
      **番号が要る場面を作らないと、通し方の違いが表に出ない。**
    */
    const 別の道 = '/home/example/other/家計簿'
    applyProjectSnapshot([
      project(WORK_DIR, { id: 'a', created_at: NOW }),
      project(別の道, { id: 'b', created_at: NOW + 1, position: 1 }),
    ])

    開く(`/p/local/${encodeURIComponent(別の道)}`)

    await waitFor(() =>
      expect(document.title).toBe(`家計簿 (2) — ${BASE_TITLE}`),
    )
  })

  it('カードが届く前は、既定のまま待つ', async () => {
    // URL に入っているのはカードの ID だけなので、届くまで PJT は分からない。
    // **空にはしない**——空にするとブラウザが URL を代わりに出し、ID がタブに並ぶ
    開く(`/s/${CARD}`)

    expect(await screen.findByTestId('not-found')).toBeInTheDocument()
    expect(document.title).toBe(BASE_TITLE)
  })

  it('一覧では既定のまま', async () => {
    applyProjectSnapshot([project(WORK_DIR)])

    開く('/')

    expect(await screen.findByTestId('project-add-open')).toBeInTheDocument()
    expect(document.title).toBe(BASE_TITLE)
  })
})
