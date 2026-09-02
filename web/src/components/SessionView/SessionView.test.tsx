import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
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
    position: 0,
    ...overrides,
  }
}

/**
 * `SessionView` は行き来の導線（`Link`）を持つので、**ルータの中でしか描けない**。
 * 被せ方の前例は `GroupView.test.tsx`。
 */
function renderView(props: { compact?: boolean; handle?: ReactNode } = {}) {
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
  /*
    **記憶はファイル全体で消す。** 以前はファイルの節の中だけで消していたので、
    あの節が書いた「サイドバーが開いている」が**後ろの8節へ漏れていた**——
    あちらは fetch を差し替えていないので、素の口へ問い合わせに行く形になっていた。

    主張の対象がそこに触っていなかったから緑だっただけで、前提としては壊れている。
    覚える鍵が増えるほど漏れ方も増えるので、入口を1つにする。
  */
  globalThis.localStorage.clear()
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
/**
 * 画面の行き来（設計§17-3）。**入り口が2つに割れていたのを1つにした。**
 *
 * 以前は「横並びは文字の『開く』、単独画面は PJT 名のリンク」で、**片側だけに出す
 * 正しい例**として扱っていた（行き先がいま居る画面になるため）。**切替ボタンには
 * その理由が当たらない**——あれは常に別の画面へ行く。
 */
describe('SessionView の行き来は、1つの切替ボタン', () => {
  const PROJECT = encodeURIComponent('/home/example/dev/app')

  function show(compact = false) {
    clearSessions()
    applySessionSnapshot([meta()])
    return render(
      <MemoryRouter initialEntries={[`/s/${CARD}`]}>
        <Routes>
          <Route path="/" element={<p>一覧に居ます</p>} />
          <Route path="/p/:host/:project" element={<p>PJT の画面です</p>} />
          <Route path="/s/:cardId" element={<SessionView compact={compact} cardId={CARD} />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
    useWsStore.setState({ kill: vi.fn(), archive: vi.fn(), revive: vi.fn() })
  })

  it('両方の画面に出て、向きだけが変わる', () => {
    // **同じボタンだと分かることが要件**（設計§17-3）。色や器で分けない
    show()
    expect(screen.getByTestId('zoom-toggle')).toHaveAttribute('data-zoom', 'out')
    cleanup()

    show(true)
    expect(screen.getByTestId('zoom-toggle')).toHaveAttribute('data-zoom', 'in')
  })

  it('単独画面では、押すと PJT の画面へ移る', async () => {
    show()
    await userEvent.click(screen.getByTestId('zoom-toggle'))
    expect(screen.getByText('PJT の画面です')).toBeInTheDocument()
  })

  it('別の PC のセッションでも、その PC の PJT 画面を指す', async () => {
    const PC = '77777777-7777-7777-7777-777777777777'
    clearSessions()
    applySessionSnapshot([meta({ agent_id: PC })])
    render(
      <MemoryRouter initialEntries={[`/s/${CARD}`]}>
        <Routes>
          <Route
            path={`/p/${PC}/${PROJECT}`}
            element={<p>その PC の画面です</p>}
          />
          <Route path="/s/:cardId" element={<SessionView cardId={CARD} />} />
        </Routes>
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByTestId('zoom-toggle'))
    expect(screen.getByText('その PC の画面です')).toBeInTheDocument()
  })

  it('「開く」の文字とパスのリンクは、どちらも無くなっている', () => {
    show(true)
    expect(screen.queryByTestId('to-session')).toBeNull()
    expect(screen.queryByTestId('to-project')).toBeNull()
    expect(screen.queryByText('開く')).toBeNull()
  })
})

/**
 * 帯とセッションの操作列（設計§17-1・`DESIGN.md` §39.2・§39.3）。
 *
 * **置き場所は「効く相手」で決まる。** 画面ぜんぶに効くものは帯、セッション1本に
 * 効くものはその区画の真上。**1本しか無い画面では両者が同じ場所に見える**ので、
 * **横並びと単独画面の両方で見る**——片方だけ見ている限り取り違えに気づけない。
 */
describe('SessionView の操作列は、区画の真上', () => {
  function rowOf(testId: string): string | null {
    const element = screen.queryByTestId(testId)
    return element?.closest('[data-row]')?.getAttribute('data-row') ?? null
  }

  function show(session: SessionMeta, compact = false) {
    clearSessions()
    applySessionSnapshot([session])
    renderView({ compact })
  }

  /** その目印が、操作列（＝端末と同じ列）の中に居るか */
  function 列の中(testId: string): boolean {
    return screen.getByTestId(testId).closest('[data-testid="session-ops"]') !== null
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
    useWsStore.setState({ kill: vi.fn(), archive: vi.fn(), revive: vi.fn() })
  })

  it('セッションに効くものは、両方の画面で操作列の中に居る', () => {
    /*
      **これが §39.3 の本体。** 以前は `header`（取り合いの器の外）に居たので、
      セッション専用画面では**サイドバーごと跨いだ全幅の帯**になっていた。
      横並びはサイドバーが無いぶん**たまたま**区画の真上に来ていただけである。
    */
    for (const compact of [false, true]) {
      show(meta({ agent_connected: true }), compact)
      for (const 目印 of [
        'elapsed',
        'model-picker',
        'permission-mode-picker',
        'terminal-toggle',
        'zoom-toggle',
        'power-card',
        'close-card',
      ]) {
        expect(列の中(目印), `${目印} が操作列の外に居る（compact=${compact}）`).toBe(true)
      }
      cleanup()
    }
  })

  it('画面に効くものは帯に残る', () => {
    show(meta())
    const 帯 = screen.getByTestId('screen-bar')
    expect(帯.querySelector('[data-testid="project-files-toggle"]')).not.toBeNull()
    expect(帯.querySelector('[data-testid="close-session"]')).not.toBeNull()
    // 逆に、セッションに効くものが紛れ込んでいないこと
    expect(帯.querySelector('[data-testid="power-card"]')).toBeNull()
    expect(帯.querySelector('[data-testid="zoom-toggle"]')).toBeNull()
  })

  it('横並びでは帯そのものを描かない（空の段を作らない）', () => {
    // サイドバー・PJT 名・✕ はどれも横並びでは出さないので、**中身が1つも残らない**
    // （`DESIGN.md` §39.4）。**§14-1「横並びでも1行目を出す」の撤回**
    show(meta(), true)
    expect(screen.queryByTestId('screen-bar')).toBeNull()
    expect(screen.getByTestId('session-ops')).toBeInTheDocument()
  })

  it('操作列はちょうど2行で、どこに何が居るかが決まっている', () => {
    show(meta({ agent_connected: true }))
    const ops = screen.getByTestId('session-ops')
    expect(ops.querySelectorAll('[data-row]')).toHaveLength(2)

    expect(rowOf('elapsed')).toBe('1')
    expect(rowOf('terminal-toggle')).toBe('1')
    expect(rowOf('zoom-toggle')).toBe('1')
    expect(rowOf('power-card')).toBe('1')
    expect(rowOf('close-card')).toBe('1')
    expect(rowOf('model-picker')).toBe('2')
    expect(rowOf('permission-mode-picker')).toBe('2')
  })

  it('操作の群は、間隔で2つに分かれている', () => {
    // 左は「見せ方を変える」、右は「始末する」（設計§17-6）。
    // **押し間違えたときの取り返しの付かなさが違う**
    show(meta({ agent_connected: true }))
    const 始末 = screen.getByTestId('power-card').parentElement
    expect(始末?.className).toContain('ml-')
    expect(始末?.querySelector('[data-testid="close-card"]')).not.toBeNull()
    expect(始末?.querySelector('[data-testid="terminal-toggle"]')).toBeNull()
  })

  it('条件付きのものが重なっても、行が増えない', () => {
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
    expect(
      screen.getByTestId('session-ops').querySelectorAll('[data-row]'),
    ).toHaveLength(2)
  })

  it('最終活動の表記が変わっても、行の数も所属も変わらない', () => {
    // **放っておくだけで文字数が変わる唯一の要素**（このイシューの3件目）
    for (const 差 of [0, 30_000, 3 * 60_000, 12 * 86_400_000]) {
      show(meta({ last_activity_at: NOW - 差 }))
      expect(
        screen.getByTestId('session-ops').querySelectorAll('[data-row]'),
      ).toHaveLength(2)
      expect(rowOf('elapsed')).toBe('1')
      cleanup()
    }
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

  it('帯にはこれだけが残る（始末のボタンは操作列へ移った）', () => {
    /*
      **§15-2 の「間隔で分ける」は、分ける場所が移った**（設計§17-6・§17-7）。
      電源とゴミ箱は**セッションに効く**ので操作列へ、✕ は**画面に効く**ので帯に残る
      ——`DESIGN.md` §39.2「操作は、それが効く相手と同じ入れ子に置く」。
    */
    show()
    const 帯 = screen.getByTestId('screen-bar')
    const 並び = Array.from(帯.querySelectorAll('button')).map(
      (b) => b.dataset.testid,
    )
    expect(並び).toEqual(['project-files-toggle', 'close-session'])
    expect(screen.getByTestId('close-session').className).toContain('ml-auto')
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

describe('掴み手の居場所は、2つの画面で同じ', () => {
  it('渡された掴み手は `session-ops` の中に居る（横並びでも単独でも）', () => {
    // **セッションに効く操作は、そのセッションの区画の真上**（`DESIGN.md` §39.2）。
    // 帯へ上げると単独画面と場所が食い違い、**片方の画面だけを見ている限り
    // 気づけない**。§39.3 が禁じているのは**場所の分岐**なので、ここは分岐させない
    const 手 = <button data-testid="ため-の-掴み手" type="button" />
    applySessionSnapshot([meta()])

    renderView({ handle: 手 })
    expect(
      screen.getByTestId('ため-の-掴み手').closest('[data-testid="session-ops"]'),
    ).not.toBeNull()

    cleanup()
    renderView({ compact: true, handle: 手 })
    expect(
      screen.getByTestId('ため-の-掴み手').closest('[data-testid="session-ops"]'),
    ).not.toBeNull()
  })
})

describe('単独のセッション専用画面には掴み手を出さない', () => {
  it('並べる相手が1本も無いので、掴み手そのものが無い', () => {
    // **押しても何も起きないものを置くと、壊れているのと見分けが付かない**
    // （設計§3-1）。置き場所は分岐させず、有無だけが変わる——`GroupView` が
    // 横並びのときにだけ渡す形にしてある
    applySessionSnapshot([meta()])
    renderView()
    expect(screen.queryByTestId('reorder-handle')).toBeNull()

    // **横並びでも、渡されなければ出ない。** 出す・出さないを決めるのは
    // 並びを持っている側（`GroupView`）で、この区画は受け取るだけ
    cleanup()
    renderView({ compact: true })
    expect(screen.queryByTestId('reorder-handle')).toBeNull()
  })
})
