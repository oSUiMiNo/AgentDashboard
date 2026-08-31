import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
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

  it('実体があるカードには出さない', () => {
    show(meta({ agent_connected: true }))
    expect(screen.queryByTestId('revive-button')).toBeNull()
  })

  it('専用画面に出て、押すと起こし直すよう頼む', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    show(stale())

    await userEvent.click(screen.getByTestId('revive-button'))

    expect(revive).toHaveBeenCalledWith(CARD)
  })

  it('横並び（compact）でも出る', () => {
    // 宛先がカードごとに一意なので、十字ボタンと違って曖昧にならない（設計§9-2）
    show(stale(), true)
    expect(screen.getByTestId('revive-button')).toBeInTheDocument()
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

    const button = screen.getByTestId('revive-button')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'この PC が繋がっていません')
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

  it('押している間は「復旧中…」になり、二度押せない', () => {
    show(stale())
    act(() => markReviving(CARD))

    const button = screen.getByTestId('revive-button')
    expect(button).toHaveTextContent('復旧中…')
    expect(button).toBeDisabled()
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

  it('パスは縮んでよいまま（帯の行数が増えないこと）', () => {
    // `min-w-0` が無いと flex の子は中身より小さくならず `truncate` が効かない。
    // 長いパスのときに状態のラベルが縦に割れる＝**行が増える**（設計§3）
    //
    // **`truncate` は前半の `<span>` へ移した**（設計§3）。リンクは2つに割った中身の
    // 入れ物になったので、リンク自身には `min-w-0` だけが要る
    applySessionSnapshot([meta()])
    renderView()

    const link = screen.getByTestId('to-project')
    expect(link).toHaveClass('min-w-0')
    expect(link).toHaveClass('flex')

    const [head, tail] = Array.from(link.querySelectorAll('span'))
    expect(head).toHaveClass('min-w-0')
    expect(head).toHaveClass('truncate')
    expect(tail).toHaveClass('shrink-0')
  })

  it('パスは前半だけが縮み、末尾2階層は必ず残る', () => {
    // **壊し方**：`min-w-0` を前半から外すと、flex の子は中身より小さくならないので
    // `truncate` が効かず、パスがそのまま行を押し広げる（設計§3・テスト計画フェーズ2の
    // 最後の1項目をここへ送った）
    applySessionSnapshot([meta()])
    renderView()

    const link = screen.getByTestId('to-project')
    const [head, tail] = Array.from(link.querySelectorAll('span'))
    expect(head).toHaveTextContent('/home/example')
    expect(tail).toHaveTextContent('/dev/app')
    // 割っても1文字も落とさない
    expect((head.textContent ?? '') + (tail.textContent ?? '')).toBe(
      '/home/example/dev/app',
    )
  })

  it('「開く」に寄せる指定を付けない（出ないときに並びが崩れるため）', () => {
    applySessionSnapshot([meta()])
    renderView({ compact: true })

    expect(screen.getByTestId('to-session')).not.toHaveClass('ml-auto')
  })
})

/**
 * 帯を4行に決め打ったこと（設計§2・テスト計画フェーズ3）。
 *
 * # なぜ行を機械で見るのか
 *
 * **「4行に収まったか」は目でしか分からないが、「どの要素がどの行に居るか」は機械で
 * 見られる。** 見え方の良し悪しは実機（フェーズ5）に任せ、ここでは**条件付きで出る
 * ものが出ても行が増えないこと**を固定する——これは実機で毎回作れる状況ではない
 * （PC の線を抜く・フックを止める、を組み合わせないと出ない）。
 *
 * 行の目印は `data-row`。1〜3行目は `<header>` の中に、**4行目はタブの行**にある
 * （サイドバーより下の「中身の列」に居るため。設計§2）。
 */
describe('SessionView の帯は4行', () => {
  function rows(): string[] {
    return Array.from(document.querySelectorAll('[data-row]')).map(
      (element) => element.getAttribute('data-row') ?? '',
    )
  }

  /** その要素がどの行に居るか。居なければ `null` */
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
  })

  it('単独画面の帯はちょうど4行', () => {
    show(meta())
    expect(rows()).toEqual(['1', '2', '3', '4'])
  })

  it('どの要素がどの行に居るかが決まっている', () => {
    show(meta({ agent_connected: true }))

    expect(rowOf('project-files-toggle')).toBe('1')
    expect(rowOf('to-project')).toBe('1')
    expect(rowOf('close-session')).toBe('1')
    expect(rowOf('model-picker')).toBe('3')
    expect(rowOf('permission-mode-picker')).toBe('3')
    expect(rowOf('view-tab-transcript')).toBe('4')
    expect(rowOf('view-tab-terminal')).toBe('4')
  })

  it('フック未受信が出ても行が増えない（2行目に収まる）', () => {
    show(meta({ status: { kind: 'unknown' }, hooks_seen: false }))

    expect(rowOf('hook-warning')).toBe('2')
    expect(rows()).toEqual(['1', '2', '3', '4'])
  })

  it('復旧が出ても行が増えない（3行目に収まる）', () => {
    show(
      meta({
        agent_connected: false,
        claude_session_id: '22222222-2222-2222-2222-222222222222',
      }),
    )

    expect(rowOf('revive-button')).toBe('3')
    expect(rows()).toEqual(['1', '2', '3', '4'])
  })

  it('終了したカードでは、起こし直しのモードのバッジと復旧が同じ行に並ぶ', () => {
    // ピッカーが消えた場所へ入れ替わりに入る。**3行目は空にならない**
    show(
      meta({
        status: { kind: 'ended', ok: true },
        agent_connected: false,
        claude_session_id: '22222222-2222-2222-2222-222222222222',
      }),
    )

    expect(screen.queryByTestId('model-picker')).toBeNull()
    expect(rowOf('revive-mode')).toBe('3')
    expect(rowOf('revive-button')).toBe('3')
    expect(rows()).toEqual(['1', '2', '3', '4'])
  })

  it('条件付きのものが重なっても行が増えない', () => {
    // **片方ずつ見ても、重なったときのことは分からない。**
    // `revive-mode` のバッジと「フック未受信」は同時には出ない（前者は `ended`・
    // 後者は `unknown` が条件で、状態は1つしか持てない）ので、数えるのはこの組
    show(
      meta({
        status: { kind: 'unknown' },
        hooks_seen: false,
        agent_connected: false,
        claude_session_id: '22222222-2222-2222-2222-222222222222',
      }),
    )

    expect(screen.getByTestId('hook-warning')).toBeInTheDocument()
    expect(screen.getByTestId('revive-button')).toBeInTheDocument()
    expect(rows()).toEqual(['1', '2', '3', '4'])
  })

  it('最終活動の表記が変わっても、行の数も所属も変わらない', () => {
    // **3件目の要件そのもの。** 放っておくだけで文字数が変わる唯一の要素なので、
    // 折り返す作りだと「画面を見ているだけで行数が入れ替わる」。
    // **高さが動かないことは実ブラウザで見る**（jsdom は幅も高さも測らない）
    // `たった今` → `30秒前` → `3分前` → `12日前`。字数が 4→4→3→5 と動く
    const 経過 = [0, 30_000, 3 * 60_000, 12 * 86_400_000]
    for (const 差 of 経過) {
      clearSessions()
      applySessionSnapshot([meta({ last_activity_at: NOW - 差 })])
      const { unmount } = renderView()
      expect(rows(), `経過 ${差}ms で行が変わった`).toEqual(['1', '2', '3', '4'])
      expect(rowOf('to-project')).toBe('1')
      unmount()
    }
  })

  it('更新間隔が出ても行が増えない（4行目に収まる）', () => {
    // 別の PC のセッションを、ターミナルで見ているときだけ出る（設計§2）
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
    clearSessions()
    applySessionSnapshot([meta({ agent_id: 'agent-1' })])
    renderView({ compact: true })

    expect(rowOf('screen-interval')).toBe('4')
    expect(rows()).toEqual(['2', '3', '4'])
  })

  it('フック未受信と更新間隔が同時に出ても行が増えない', () => {
    // **片方ずつ見ても、重なったときのことは分からない。**
    // 2行目と4行目に1つずつ増える形
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
    clearSessions()
    applySessionSnapshot([
      meta({
        agent_id: 'agent-1',
        status: { kind: 'unknown' },
        hooks_seen: false,
      }),
    ])
    renderView({ compact: true })

    expect(rowOf('hook-warning')).toBe('2')
    expect(rowOf('screen-interval')).toBe('4')
    expect(rows()).toEqual(['2', '3', '4'])
  })

  it('横並びでは1行目を出さない', () => {
    // パスは全カードで同じで、`GroupView` の見出しにも既に出ている（設計§2）
    show(meta(), true)

    expect(rows()).toEqual(['2', '3', '4'])
    expect(screen.queryByTestId('to-project')).toBeNull()
    expect(screen.queryByTestId('project-files-toggle')).toBeNull()
    expect(screen.queryByTestId('close-session')).toBeNull()
  })

  it('横並びでも2〜4行目は出る（1行目だけが違う）', () => {
    show(meta({ agent_connected: true }), true)

    expect(rowOf('model-picker')).toBe('3')
    expect(rowOf('view-tab-terminal')).toBe('4')
    expect(screen.getByRole('button', { name: '終了' })).toBeInTheDocument()
  })

  it('4行目は、左端が「開く」で右端が終了・削除', () => {
    // **「移る」と「消す」を隣り合わせにしない**（設計§2）。以前は折り返し次第で
    // `削除` が左端へ回り込み、「開く」の真上に並んでいた
    show(meta(), true)

    const 行 = screen.getByTestId('to-session').closest('[data-row="4"]')
    expect(行).not.toBeNull()
    const 中身 = Array.from(行!.children)
    expect(中身[0]).toHaveAttribute('data-testid', 'to-session')
    expect(中身[中身.length - 1]).toHaveTextContent('終了')
    expect(中身[中身.length - 1]).toHaveTextContent('削除')
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

  it('横並びには出ない（1行目ごと出ないため）', () => {
    show(true)
    expect(screen.queryByTestId('close-session')).toBeNull()
  })

  it('読み上げ用の名前が付いている', () => {
    // **文字の記号ではなくアイコン**なので（`DESIGN.md` §14.4）、名前が無いと
    // 読み上げでは何も無いのと同じになる
    show()
    expect(screen.getByTestId('close-session')).toHaveAttribute(
      'aria-label',
      '閉じる',
    )
  })
})
