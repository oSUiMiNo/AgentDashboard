import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionView } from './SessionView'
import type { SessionMeta } from '@/lib/protocol'
import {
  applySessionSnapshot,
  clearSessions,
  markReviving,
  setCardError,
} from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'
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
    session_title: null,
    ...overrides,
  }
}

/**
 * `SessionView` は行き来の導線（`Link`）を持つので、**ルータの中でしか描けない**。
 * 被せ方の前例は `GroupView.test.tsx`。
 */
function renderView(props: { compact?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <SessionView cardId={CARD} {...props} />
    </MemoryRouter>,
  )
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

    renderView({ compact: true })

    expect(screen.getByTestId('screen-interval')).toHaveTextContent('更新間隔 20秒')
  })

  it('この PC のセッションでは出さない', () => {
    // ローカルは生バイトが直に届くので、間隔という概念が無い（設計§7-2）
    settings(20_000)
    applySessionSnapshot([meta({ agent_id: null })])

    renderView({ compact: true })

    expect(screen.queryByTestId('screen-interval')).toBeNull()
  })

  it('構造化ビューを見ているときは出さない', () => {
    // 更新間隔が効くのは画面配信だけ（要件5-5）。履歴や指示送信は間隔と無関係なので、
    // 構造化ビューの脇に出すと「履歴も20秒遅れる」と誤解させる
    settings(20_000)
    applySessionSnapshot([meta({ agent_id: 'agent-1' })])

    renderView()

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

  it('切り替えボタンでサイドバーが開き、そのセッションの枠から始まる', async () => {
    clearSessions()
    applySessionSnapshot([meta()])
    useSettingsStore.setState({ settings: settingsFixture(), loading: false, lastError: null })
    renderView()

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
    renderView({ compact: true })

    // PJT 専用画面が既に持っているので、セッションの数だけ同じものを出さない
    expect(screen.queryByTestId('project-files-toggle')).toBeNull()
  })
})

/**
 * セッション画面の復旧ボタン（復旧設計§9-2・§9-4・§9-5）。
 *
 * **「セッション画面」は2つを指す**——専用画面（`/s/:cardId`）と、PJT 専用画面に
 * 横並びで出る各区画（`compact`）である（利用者の語法）。道具列は `compact` の分岐の
 * 外にあるので、そこへ置けば両方へ出る。**十字ボタンを横並びで出さなかった前例に
 * 引きずられない**——あれは宛先が1つに定まらないためで、復旧は宛先がカードごとに一意。
 *
 * この画面には**「接続断」の表示そのものが無い**ので、このボタンがその合図を兼ねる。
 */
describe('SessionView の復旧', () => {
  const PC = '77777777-7777-7777-7777-777777777777'

  function stale(overrides: Partial<SessionMeta> = {}): SessionMeta {
    return meta({
      agent_connected: false,
      claude_session_id: '22222222-2222-2222-2222-222222222222',
      ...overrides,
    })
  }

  function show(session: SessionMeta, compact = false) {
    clearSessions()
    applySessionSnapshot([session])
    renderView({ compact })
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
    useWsStore.setState({ revive: vi.fn() })
  })

  it('実体があるカードでは、同じボタンが点灯している', () => {
    // **消えるのではなく、意味が入れ替わる**（設計§15-1）。畳めるのは
    // 「スリープが出る条件」と「復旧が出る条件」が互いの否定だから
    show(meta({ agent_connected: true }))
    const button = screen.getByTestId('power-card')
    expect(button).toHaveAttribute('data-power', 'on')
    expect(button).toHaveAttribute('data-action', 'sleep')
    expect(button).toHaveAttribute('aria-label', 'スリープ')
  })

  it('どの状態でも、電源ボタンはちょうど1つ', () => {
    // **これが「畳めた」ことの証明そのもの。** 2つ出る＝両方の条件が真、
    // 0個＝両方偽で、どちらも起きないことが畳んだ根拠だった
    for (const 場面 of [
      meta({ agent_connected: true }),
      stale(),
      stale({ status: { kind: 'ended', ok: true } }),
      stale({ claude_session_id: null }),
    ]) {
      show(場面)
      expect(screen.getAllByTestId('power-card')).toHaveLength(1)
      cleanup()
    }
  })

  it('専用画面に出て、押すと起こし直すよう頼む', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    show(stale())

    await userEvent.click(screen.getByTestId('power-card'))

    expect(revive).toHaveBeenCalledWith(CARD)
  })

  it('連打しても、2回目は捨てられる', async () => {
    // **1つに畳んだことで生まれた危険**（設計§15-1）。`Kill` から `ended` までには
    // 間があり、切り替わりをまたいだ2回目は**止めたつもりで起こす**ことになる
    const revive = vi.fn()
    useWsStore.setState({ revive })
    show(stale())

    const button = screen.getByTestId('power-card')
    await userEvent.click(button)
    await userEvent.click(button)

    expect(revive).toHaveBeenCalledTimes(1)
  })

  it('捨てているあいだも、見た目は動かさない', async () => {
    // `disabled` にすると点灯の輪が一瞬だけ灰色へ落ち、**壊れたように見える**
    useWsStore.setState({ revive: vi.fn() })
    show(stale())

    const button = screen.getByTestId('power-card')
    await userEvent.click(button)

    expect(button).toBeEnabled()
  })

  it('横並び（compact）でも出る', () => {
    // 宛先がカードごとに一意なので、十字ボタンと違って曖昧にならない（設計§9-2）
    show(stale(), true)
    const button = screen.getByTestId('power-card')
    expect(button).toHaveAttribute('data-power', 'off')
    expect(button).toHaveAttribute('data-action', 'revive')
  })

  it('押せないときも出て、理由が読める', () => {
    useSettingsStore.setState({
      settings: settingsFixture({
        agents: [
          {
            id: PC,
            name: '仕事用ノート',
            last_seen_at: 1,
            connected: false,
            supports_revive: true,
          },
        ],
      }),
      loading: false,
    })
    show(stale({ agent_id: PC }))

    const button = screen.getByTestId('power-card')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'この PC が繋がっていません')
    // **理由は目印にも載せる。** 押せない3通りを見分ける道を消さない（設計§15-1）
    expect(button).toHaveAttribute('data-state', 'pc-offline')
  })

  it('終了したカードでは、起こし直すモードを静的に見せる', () => {
    // 終了するとピッカーが消えるので、**押す前にモードが見えなくなる**。
    // 実機の記録では23枚とも bypassPermissions だった（設計§15-4）ので飾りではない
    show(
      stale({
        status: { kind: 'ended', ok: true },
        permission_mode: 'bypassPermissions',
      }),
    )

    const badge = screen.getByTestId('revive-mode')
    expect(badge).toHaveTextContent('全承認をスキップ')
    expect(badge.dataset.mode).toBe('bypassPermissions')
  })

  it('接続断（未終了）ではピッカーが出ているので、二重に出さない', () => {
    show(stale({ permission_mode: 'bypassPermissions' }))
    expect(screen.queryByTestId('revive-mode')).toBeNull()
  })

  it('押している間は印が付き、二度押せない', () => {
    // **文字を出す場所が無くなった**ので、進んでいることは動きで伝える（設計§15-1）。
    // 「止まっているから押せない」のか「働いているから押せない」のかを分ける
    show(stale())
    act(() => markReviving(CARD))

    const button = screen.getByTestId('power-card')
    expect(button).toHaveAttribute('data-busy', 'true')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', '起こしています…')
  })

  it('断りはこの画面に出る', () => {
    // 横並びのとき、画面全体の帯へ出すとどのカードの話か分からなくなる（設計§9-5）
    show(stale(), true)
    act(() => setCardError(CARD, 'この PC の版が古くて対応していません'))

    expect(screen.getByTestId('card-error')).toHaveTextContent(
      'この PC の版が古くて対応していません',
    )
  })
})

/**
 * 行き来の導線（設計§3・§4）。
 *
 * **「セッション画面」は2つを指す**——単独の専用画面（`/s/:cardId`）と、PJT 専用画面に
 * 横並びで出る各区画（`compact`）である。行き先はその2つで**逆になる**：単独画面からは
 * その PJT へ、区画からはそのセッションへ。
 *
 * どちらの側でも「在るもの」と「無いもの」を**対で**見る。**無いことだけを見る主張は、
 * セレクタが的外れでも通る**ので、片方だけだと「何も描かれていない」実装でも緑になる。
 */
describe('SessionView の行き来', () => {
  const PC = '77777777-7777-7777-7777-777777777777'
  const PROJECT = encodeURIComponent('/home/example/dev/app')

  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
  })

  it('単独画面では、パスが PJT 専用画面を指す', () => {
    applySessionSnapshot([meta()])
    renderView()

    expect(screen.getByTestId('to-project')).toHaveAttribute(
      'href',
      `/p/local/${PROJECT}`,
    )
  })

  it('単独画面に「開く」は出ない（行き先が自分自身になるため）', () => {
    applySessionSnapshot([meta()])
    renderView()

    expect(screen.getByTestId('to-project')).toBeInTheDocument()
    expect(screen.queryByTestId('to-session')).toBeNull()
  })

  it('横並びでは、「開く」がそのセッションの専用画面を指す', () => {
    applySessionSnapshot([meta()])
    renderView({ compact: true })

    expect(screen.getByTestId('to-session')).toHaveAttribute('href', `/s/${CARD}`)
  })

  it('横並びのパスはリンクにしない（既にその PJT の画面に居るため）', () => {
    applySessionSnapshot([meta()])
    renderView({ compact: true })

    expect(screen.getByTestId('to-session')).toBeInTheDocument()
    expect(screen.queryByTestId('to-project')).toBeNull()
  })

  it('別の PC のセッションは、その PC の PJT 専用画面を指す', () => {
    // 同じパスはどの PC にも在りうるので、鍵に PC が入る
    applySessionSnapshot([meta({ agent_id: PC })])
    renderView()

    expect(screen.getByTestId('to-project')).toHaveAttribute(
      'href',
      `/p/${PC}/${PROJECT}`,
    )
  })

  it('ローカルモード（PC という単位が無い構成）でも行ける', () => {
    applySessionSnapshot([meta({ agent_id: null })])
    renderView()

    expect(screen.getByTestId('to-project')).toHaveAttribute(
      'href',
      `/p/local/${PROJECT}`,
    )
  })

  it('出すのは PJT の名前だけで、フルパスは title に残る', () => {
    // **1行目には始末のボタンも並ぶ**ので、パスの長さに幅を明け渡せない（設計§14-5）。
    // 名前だけでは「どの機械のどこか」が分からなくなるので、フルパスは `title` へ
    applySessionSnapshot([meta()])
    renderView()

    const link = screen.getByTestId('to-project')
    expect(link).toHaveTextContent('app')
    expect(link).not.toHaveTextContent('/home/example')
    expect(link).toHaveAttribute('title', '/home/example/dev/app')
  })

  it('名前は縮んでよいまま（帯の行数が増えないこと）', () => {
    // `min-w-0` が無いと flex の子は中身より小さくならず `truncate` が効かない。
    // 長い名前のときに始末のボタンが押し出される
    applySessionSnapshot([meta()])
    renderView()

    const link = screen.getByTestId('to-project')
    expect(link).toHaveClass('min-w-0')
    expect(link).toHaveClass('truncate')
  })

  it('「開く」に寄せる指定を付けない（出ないときに並びが崩れるため）', () => {
    applySessionSnapshot([meta()])
    renderView({ compact: true })

    expect(screen.getByTestId('to-session')).not.toHaveClass('ml-auto')
  })
})

/**
 * 帯を3行に決め打ったこと（設計§14-1・テスト計画フェーズ6）。
 *
 * # なぜ行を機械で見るのか
 *
 * **「3行に収まったか」は目でしか分からないが、「どの要素がどの行に居るか」は機械で
 * 見られる。** 見え方の良し悪しは実機に任せ、ここでは**条件付きで出るものが出ても
 * 行が増えないこと**を固定する——これは実機で毎回作れる状況ではない。
 *
 * **4行から3行になった**（要件の訂正・2026-09-01）。タブの行が消え、始末のボタンが
 * 1行目へ来て、**横並びでも1行目が出る**ようになった。
 */
describe('SessionView の帯は3行', () => {
  function rows(): string[] {
    return Array.from(document.querySelectorAll('[data-row]')).map(
      (element) => element.getAttribute('data-row') ?? '',
    )
  }

  function rowOf(testId: string): string | null {
    const element = screen.queryByTestId(testId)
    return element?.closest('[data-row]')?.getAttribute('data-row') ?? null
  }

  function show(session: SessionMeta, compact = false) {
    clearSessions()
    applySessionSnapshot([session])
    renderView({ compact })
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
    useWsStore.setState({ kill: vi.fn(), archive: vi.fn() })
  })

  it('単独画面の帯はちょうど3行', () => {
    show(meta())
    expect(rows()).toEqual(['1', '2', '3'])
  })

  it('横並びでも3行（1行目は中身が違うだけ）', () => {
    // **§2 の「1行目は出さない」を覆した。** あの行は当時パスの行だったが、
    // いまは「行き先と始末の行」なので、横並びにも要る（設計§14-1）
    show(meta(), true)
    expect(rows()).toEqual(['1', '2', '3'])
  })

  it('どの要素がどの行に居るかが決まっている', () => {
    show(meta({ agent_connected: true }))

    expect(rowOf('project-files-toggle')).toBe('1')
    expect(rowOf('to-project')).toBe('1')
    expect(rowOf('power-card')).toBe('1')
    expect(rowOf('close-card')).toBe('1')
    expect(rowOf('close-session')).toBe('1')
    expect(rowOf('model-picker')).toBe('3')
    expect(rowOf('permission-mode-picker')).toBe('3')
    expect(rowOf('terminal-toggle')).toBe('3')
  })

  it('横並びの1行目は、左端が「開く」で右端が始末', () => {
    // **「移る」と「消す」を反対の端に置く**（設計§2 の原則はそのまま生きている）。
    // パス・サイドバー・✕ は出ない
    show(meta(), true)

    expect(rowOf('to-session')).toBe('1')
    expect(rowOf('close-card')).toBe('1')
    expect(screen.queryByTestId('to-project')).toBeNull()
    expect(screen.queryByTestId('project-files-toggle')).toBeNull()
    expect(screen.queryByTestId('close-session')).toBeNull()

    const 行 = screen.getByTestId('to-session').closest('[data-row="1"]')
    const 中身 = Array.from(行!.children)
    expect(中身[0]).toHaveAttribute('data-testid', 'to-session')
    // 右端は始末の群。**横並びでは ✕ を出さない**ので、末尾はゴミ箱になる
    const 右端 = Array.from(
      中身[中身.length - 1].querySelectorAll('button'),
    ).map((b) => b.dataset.testid)
    expect(右端).toEqual(['power-card', 'close-card'])
  })

  it('フック未受信が出ても行が増えない（2行目に収まる）', () => {
    show(meta({ status: { kind: 'unknown' }, hooks_seen: false }))
    expect(rowOf('hook-warning')).toBe('2')
    expect(rows()).toEqual(['1', '2', '3'])
  })

  it('復旧が出ても行が増えない（3行目に収まる）', () => {
    show(
      meta({
        agent_connected: false,
        claude_session_id: '22222222-2222-2222-2222-222222222222',
      }),
    )
    // **起こし直す道は1行目へ移った**（設計§15-1）。3行目に残るのはモードの札だけ
    expect(rowOf('power-card')).toBe('1')
    expect(rows()).toEqual(['1', '2', '3'])
  })

  it('更新間隔も3行目（ターミナルの話なので、トグルの隣）', () => {
    useSettingsStore.setState({
      settings: settingsFixture({
        intervals: {
          sync_interval_secs: 20,
          screen_interval_ms: 20_000,
          scrollback_lines: 1000,
        },
      }),
      loading: false,
    })
    show(meta({ agent_id: 'agent-1' }), true)

    expect(rowOf('screen-interval')).toBe('3')
    expect(rows()).toEqual(['1', '2', '3'])
  })

  it('スリープしたカードでは、起こし直しのモードの札だけが3行目に残る', () => {
    show(
      meta({
        status: { kind: 'ended', ok: true },
        agent_connected: false,
        claude_session_id: '22222222-2222-2222-2222-222222222222',
      }),
    )

    // **札はボタンに付いて動かさない**（設計§15-1）。3行目はモデルとモードの行
    // なので、モードの話はこちらに居るのが筋——動かすと2つの行に割れる
    expect(screen.queryByTestId('model-picker')).toBeNull()
    expect(rowOf('revive-mode')).toBe('3')
    expect(rowOf('power-card')).toBe('1')
    expect(rows()).toEqual(['1', '2', '3'])
  })

  it('条件付きのものが重なっても行が増えない', () => {
    show(
      meta({
        status: { kind: 'unknown' },
        hooks_seen: false,
        agent_connected: false,
        claude_session_id: '22222222-2222-2222-2222-222222222222',
      }),
    )
    expect(screen.getByTestId('hook-warning')).toBeInTheDocument()
    expect(screen.getByTestId('power-card')).toHaveAttribute('data-power', 'off')
    expect(rows()).toEqual(['1', '2', '3'])
  })

  it('最終活動の表記が変わっても、行の数も所属も変わらない', () => {
    const 経過 = [0, 30_000, 3 * 60_000, 12 * 86_400_000]
    for (const 差 of 経過) {
      clearSessions()
      applySessionSnapshot([meta({ last_activity_at: NOW - 差 })])
      const { unmount } = renderView()
      expect(rows(), `経過 ${差}ms で行が変わった`).toEqual(['1', '2', '3'])
      unmount()
    }
  })

  it('モデルとモードは同じ幅で、ラベルの文字を出さない', () => {
    show(meta({ agent_connected: true, permission_mode: 'default' }))

    const モデル = screen.getByTestId('model-picker')
    const モード = screen.getByTestId('permission-mode-picker')
    expect(モデル).toHaveClass('w-32')
    expect(モード).toHaveClass('w-32')
    expect(モデル).not.toHaveTextContent('モデル')
    expect(モード).not.toHaveTextContent('モード')
    expect(モデル).toHaveAttribute('aria-label', 'モデル')
    expect(モード).toHaveAttribute('aria-label', '権限モード')
  })
})

describe('SessionView のターミナルのトグル', () => {
  function show(compact = false) {
    clearSessions()
    applySessionSnapshot([meta()])
    renderView({ compact })
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
  })

  it('単独画面は切れた状態（構造化ビュー）で始まる', () => {
    // **別イシューで予定している「既定を構造化ビューにする」と噛み合う**（設計§14-3）
    show()
    expect(screen.getByTestId('terminal-toggle')).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.getByTestId('session-view')).toHaveAttribute(
      'data-view',
      'transcript',
    )
  })

  it('横並びは入った状態（ターミナル）で始まる', () => {
    show(true)
    expect(screen.getByTestId('terminal-toggle')).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('押すと行き来する', async () => {
    show()
    const toggle = screen.getByTestId('terminal-toggle')

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('session-view')).toHaveAttribute(
      'data-view',
      'terminal',
    )

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('押しボタンではなくスイッチとして読み上げられる', () => {
    // 見た目がトグルでも「押しボタン」と伝わると、いまどちらを見ているのか分からない
    show()
    expect(screen.getByTestId('terminal-toggle')).toHaveAttribute(
      'role',
      'switch',
    )
  })
})

describe('SessionView の ✕（閉じる）', () => {
  function show(compact = false) {
    clearSessions()
    applySessionSnapshot([meta()])
    renderView({ compact })
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
  })

  it('単独画面に出る', () => {
    show()
    expect(screen.getByTestId('close-session')).toBeInTheDocument()
  })

  it('横並びには出ない', () => {
    show(true)
    expect(screen.queryByTestId('close-session')).toBeNull()
  })

  it('読み上げ用の名前が付いている', () => {
    show()
    expect(screen.getByTestId('close-session')).toHaveAttribute(
      'aria-label',
      '閉じる',
    )
  })

  it('いちばん右に置き、始末の2つとは間隔で分ける', () => {
    /*
      **§14-6 の「形で分ける」はもう効かない。** 訂正その2で3つとも記号に
      なったので（設計§15-2）、代わりに**間隔**で群を作る——電源とゴミ箱は
      カードに効き、✕ は画面に効く。押し間違えても何も壊れない側が端に居る。
    */
    show()
    const 行 = screen.getByTestId('close-session').closest('[data-row="1"]')
    const 並び = Array.from(行!.querySelectorAll('button')).map(
      (b) => b.dataset.testid,
    )
    expect(並び.slice(-3)).toEqual(['power-card', 'close-card', 'close-session'])
    // ✕ の前だけ間隔が空いている（`ml-2`）
    expect(screen.getByTestId('close-session').className).toContain('ml-2')
    expect(screen.getByTestId('close-card').className).not.toContain('ml-2')
  })
})

/**
 * スリープと終了（設計§14-2・テスト計画フェーズ6）。
 *
 * **結合をやめ、名前を入れ替えた。** 「スリープ」が `Kill` だけ（カードは残る）、
 * 「終了」が `Archive` だけ。
 */
describe('SessionView のスリープと終了', () => {
  function show(session: SessionMeta, compact = false) {
    clearSessions()
    applySessionSnapshot([session])
    return render(
      <MemoryRouter initialEntries={[`/s/${CARD}`]}>
        <Routes>
          <Route path="/" element={<p>一覧に居ます</p>} />
          <Route
            path="/s/:cardId"
            element={<SessionView cardId={CARD} compact={compact} />}
          />
        </Routes>
      </MemoryRouter>,
    )
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
    useWsStore.setState({ kill: vi.fn(), archive: vi.fn() })
  })

  it('走っているカードには、点いた電源とゴミ箱が両方出る', () => {
    // **文字は記号になったが、言葉は消えていない**（設計§15-1・§15-2）。
    // 色もホバーの反応も読み上げられないので、ここが唯一の手がかりになる
    show(meta({ agent_connected: true }))
    expect(screen.getByTestId('power-card')).toHaveAttribute(
      'aria-label',
      'スリープ',
    )
    expect(screen.getByTestId('close-card')).toHaveAttribute(
      'aria-label',
      '終了',
    )
    expect(screen.getByTestId('close-card').querySelector('svg')).not.toBeNull()
  })

  it('スリープを押すと Kill だけが送られ、カードは残る', async () => {
    // **結合との違いそのもの。** 以前は `Kill` のあと `Archive` まで送っていた
    const kill = vi.fn()
    const archive = vi.fn()
    useWsStore.setState({ kill, archive })
    show(meta({ agent_connected: true }))

    await userEvent.click(screen.getByTestId('power-card'))

    expect(kill).toHaveBeenCalledWith(CARD)
    expect(archive).not.toHaveBeenCalled()
    // 画面もそのまま（一覧へ移らない）
    expect(screen.queryByText('一覧に居ます')).toBeNull()
  })

  it('スリープしたカードでは、電源が消えていて Kill を送らない', async () => {
    // 止まっている相手へ送っても届かない。**畳んだので「出さない」ではなく
    // 「消灯して意味が入れ替わる」**（設計§15-1）
    const kill = vi.fn()
    useWsStore.setState({ kill, archive: vi.fn(), revive: vi.fn() })
    show(meta({ status: { kind: 'ended', ok: true } }))

    const button = screen.getByTestId('power-card')
    expect(button).toHaveAttribute('data-power', 'off')
    expect(button).toHaveAttribute('aria-label', '復旧')
    expect(screen.getByTestId('close-card')).toBeInTheDocument()

    await userEvent.click(button)
    expect(kill).not.toHaveBeenCalled()
  })

  it('線が切れているカードでも、電源は消えている', () => {
    show(meta({ agent_connected: false, status: { kind: 'working' } }))
    expect(screen.getByTestId('power-card')).toHaveAttribute('data-power', 'off')
  })

  it('終了を押すと Archive だけが送られ、単独画面なら一覧へ移る', async () => {
    const kill = vi.fn()
    const archive = vi.fn()
    useWsStore.setState({ kill, archive })
    show(meta({ agent_connected: true }))

    await userEvent.click(screen.getByTestId('close-card'))

    expect(archive).toHaveBeenCalledWith(CARD)
    expect(kill).not.toHaveBeenCalled()
    expect(screen.getByText('一覧に居ます')).toBeInTheDocument()
  })

  it('線が切れているカードでも、終了は押せる', async () => {
    // **一覧から外す道が、ここしか無い**（設計§14-2）
    const archive = vi.fn()
    useWsStore.setState({ kill: vi.fn(), archive })
    show(meta({ agent_connected: false, status: { kind: 'working' } }))

    await userEvent.click(screen.getByTestId('close-card'))

    expect(archive).toHaveBeenCalledWith(CARD)
  })

  it('横並びでは、終了を押しても移らない', async () => {
    const archive = vi.fn()
    useWsStore.setState({ kill: vi.fn(), archive })
    show(meta({ agent_connected: true }), true)

    await userEvent.click(screen.getByTestId('close-card'))

    expect(archive).toHaveBeenCalledWith(CARD)
    expect(screen.queryByText('一覧に居ます')).toBeNull()
  })
})
