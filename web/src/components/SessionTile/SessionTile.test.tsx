import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { SessionTile } from './SessionTile'
import type { SessionMeta, SessionStatus } from '@/lib/protocol'
import {
  applySessionSnapshot,
  clearSessions,
  markReviving,
  setCardError,
  upsertSession,
} from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'
import { settingsFixture } from '@/test/fixtures'

/**
 * 小窓の表示（テスト計画フェーズ5「小窓」）。
 *
 * 一覧の主役は状態インジケータなので、6つの状態それぞれが区別できること、人の対処が
 * 要る状態が見分けられること、経過時間が出ることを確かめる。
 *
 * 小窓は中身をストアから購読するので、描く前にストアへ置く。経過時間は共有の時計
 * （[`useNow`]）が返す**実時刻**から求まるので、確かめるときは実時刻を起点に置く。
 */

const NOW = 1_700_000_000_000
const CARD = '11111111-2222-3333-4444-555555555555'

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

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    card_id: CARD,
    project: '/home/example/dev/app',
    claude_session_id: null,
    permission_mode: null,
    model: null,
    model_label: null,
    model_requested: null,
    status: { kind: 'working' },
    subagent_active: 0,
    last_activity_at: NOW,
    last_assistant_message: null,
    created_at: NOW - 60_000,
    hooks_seen: true,
    agent_id: null,
    agent_connected: true,
    account: null,
    toml_account: null,
    ...overrides,
  }
}

function renderTile(session: SessionMeta) {
  applySessionSnapshot([session])
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<SessionTile cardId={session.card_id} />} />
        <Route path="/s/:cardId" element={<p>専用画面</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('SessionTile', () => {
  it.each<[SessionStatus, string]>([
    [{ kind: 'starting' }, '起動中'],
    [{ kind: 'working' }, '作業中'],
    [{ kind: 'waiting_permission' }, '権限確認待ち'],
    [{ kind: 'waiting_input' }, '入力待ち'],
    [{ kind: 'stalled' }, '停滞'],
    [{ kind: 'ended', ok: true }, '終了'],
    [{ kind: 'ended', ok: false }, '異常終了'],
    [{ kind: 'unknown' }, '不明'],
  ])('状態 %o は「%s」と表示される', (status, label) => {
    renderTile(meta({ status }))

    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByTestId('session-tile')).toHaveAttribute(
      'data-status',
      status.kind,
    )
  })

  it('状態ごとに色が変わる', () => {
    const { unmount } = renderTile(meta({ status: { kind: 'working' } }))
    const working = screen.getByTestId('status-dot').className
    unmount()

    renderTile(meta({ status: { kind: 'waiting_permission' } }))
    expect(screen.getByTestId('status-dot').className).not.toBe(working)
  })

  it('人の対処が要る状態は見た目で目立つ', () => {
    // 権限確認待ちを見落とすと、セッションがそこで止まったままになる
    const { unmount } = renderTile(meta({ status: { kind: 'working' } }))
    const calm = screen.getByTestId('session-tile').className
    unmount()

    renderTile(meta({ status: { kind: 'waiting_permission' } }))
    expect(screen.getByTestId('session-tile').className).not.toBe(calm)
  })

  it('最終活動からの経過時間が出る', () => {
    renderTile(meta({ last_activity_at: Date.now() - 3 * 60_000 }))
    expect(screen.getByTestId('elapsed')).toHaveTextContent('最終活動 3分前')
  })

  it('サブエージェントが動いている間だけバッジが出る', () => {
    const { unmount } = renderTile(meta({ subagent_active: 0 }))
    expect(screen.queryByTestId('subagent-badge')).not.toBeInTheDocument()
    unmount()

    renderTile(meta({ subagent_active: 2 }))
    expect(screen.getByTestId('subagent-badge')).toHaveTextContent(
      'サブエージェント 2',
    )
  })

  it('直前の応答があれば要約として出る', () => {
    const { unmount } = renderTile(meta({ last_assistant_message: null }))
    expect(screen.queryByTestId('last-message')).not.toBeInTheDocument()
    unmount()

    renderTile(meta({ last_assistant_message: 'テストが通りました' }))
    expect(screen.getByTestId('last-message')).toHaveTextContent(
      'テストが通りました',
    )
  })

  it('フックが1件も来ていない不明には理由が出る', () => {
    // ただの「不明」では利用者は打つ手が分からない（設計§11）
    const { unmount } = renderTile(
      meta({ status: { kind: 'unknown' }, hooks_seen: false }),
    )
    expect(screen.getByTestId('hook-warning')).toHaveTextContent('フック未受信')
    unmount()

    // フックは届いているのに不明、という別の理由のときは名指ししない
    renderTile(meta({ status: { kind: 'unknown' }, hooks_seen: true }))
    expect(screen.queryByTestId('hook-warning')).not.toBeInTheDocument()
  })

  it('小窓をクリックすると専用画面へ移る', async () => {
    renderTile(meta())
    await userEvent.click(screen.getByTestId('session-tile'))
    expect(screen.getByText('専用画面')).toBeInTheDocument()
  })
})

describe('SessionTile の権限モード', () => {
  it('モードが分かっていれば小窓にも出る', () => {
    // 要件「各小窓と各セッション画面に表示してほしい」の小窓側
    renderTile(meta({ permission_mode: 'bypassPermissions' }))

    const badge = screen.getByTestId('permission-mode')
    expect(badge).toHaveTextContent('全承認をスキップ')
    expect(badge.dataset.mode).toBe('bypassPermissions')
  })

  it('危険なモードは既定のモードより目立つ', () => {
    // 全承認をスキップしているセッションが並んでいるのに気づかない、を作らない
    renderTile(meta({ permission_mode: 'bypassPermissions' }))
    const danger = screen.getByTestId('permission-mode').className
    cleanup()

    renderTile(meta({ permission_mode: 'default' }))
    const calm = screen.getByTestId('permission-mode').className

    expect(danger).not.toBe(calm)
    expect(danger).toContain('red')
  })

  it('モードが分からないうちは何も出さない', () => {
    // 状態の「不明」と並ぶと、どちらが不明なのか読み取れなくなる
    renderTile(meta({ permission_mode: null }))
    expect(screen.queryByTestId('permission-mode')).not.toBeInTheDocument()
  })
})

describe('SessionTile のモデル', () => {
  it('モデルが分かっていれば小窓にも出る', () => {
    // 要件「切り替えた結果が一覧の小窓にも反映される」の小窓側
    renderTile(meta({ model: 'claude-opus-5', model_label: 'Opus 5' }))

    const badge = screen.getByTestId('model')
    expect(badge).toHaveTextContent('Opus 5')
    expect(badge.dataset.model).toBe('claude-opus-5')
  })

  it('モデルが分からないうちは何も出さない', () => {
    renderTile(meta({ model: null }))
    expect(screen.queryByTestId('model')).not.toBeInTheDocument()
  })

  it('モデルが不明でも権限モードのバッジは右端に付く', () => {
    // 寄せる指定を個々のバッジに付けると、そのバッジが出ないときに寄せ先ごと
    // 消えて並びが崩れる。モデルは起動から最初の statusLine まで必ず不明
    renderTile(meta({ model: null, permission_mode: 'default' }))

    expect(screen.getByTestId('permission-mode').parentElement).toHaveClass(
      'ml-auto',
    )
  })

  it('両方あるときも同じ入れ物に並ぶ', () => {
    renderTile(
      meta({
        model: 'claude-opus-5',
        model_label: 'Opus 5',
        permission_mode: 'default',
      }),
    )

    const badges = screen.getByTestId('tile-badges')
    expect(badges).toHaveClass('ml-auto')
    expect(badges).toContainElement(screen.getByTestId('model'))
    expect(badges).toContainElement(screen.getByTestId('permission-mode'))
  })

  it('どちらも分からなければ入れ物ごと出さない', () => {
    // 空の要素を残すと、そのぶん余白（gap）が1つ増える
    renderTile(meta({ model: null, permission_mode: null }))
    expect(screen.queryByTestId('tile-badges')).not.toBeInTheDocument()
  })
})

describe('どの PC のセッションかと、その鮮度（セルフホスト化設計§11-2）', () => {
  const PC = '11111111-1111-1111-1111-111111111111'

  it('PC 名を出し、繋がっていなければ印を付ける', () => {
    // **状態そのものは書き換えない。** 「作業中（接続断）」が要件2-3 の充足形で、
    // 最後に知っていた状態を消してしまうと、何をしていたかが分からなくなる
    useSettingsStore.setState({
      settings: settingsFixture({
        agents: [
          { id: PC, name: '仕事用ノート', last_seen_at: 1, connected: false },
        ],
      }),
      loading: false,
    })
    renderTile(
      meta({ agent_id: PC, agent_connected: false, status: { kind: 'working' } }),
    )

    expect(screen.getByTestId('agent-badge')).toHaveTextContent('仕事用ノート')
    expect(screen.getByTestId('disconnected-badge')).toBeInTheDocument()
    // 状態は最後に知っていたまま
    expect(screen.getByTestId('session-tile').dataset.status).toBe('working')
    expect(screen.getByTestId('session-tile').dataset.connected).toBe('false')
  })

  it('繋がっていれば接続断の印は出ない', () => {
    useSettingsStore.setState({
      settings: settingsFixture({
        agents: [
          { id: PC, name: '仕事用ノート', last_seen_at: 1, connected: true },
        ],
      }),
      loading: false,
    })
    renderTile(meta({ agent_id: PC, agent_connected: true }))

    expect(screen.queryByTestId('disconnected-badge')).toBeNull()
  })

  it('toml が名乗った名前を出す', () => {
    // 帰属（`account`）とは別物。**申告として**そのまま出す（設計§8-5）
    renderTile(meta({ toml_account: 'しごと' }))

    expect(screen.getByTestId('toml-account-badge')).toHaveTextContent('@しごと')
  })
})

/**
 * 小窓の復旧ボタン（復旧設計§9-1・§9-4・§9-5）。
 *
 * ここで見るのは3つ——**器を変えていないこと**（キーボードで到達も起動もできる）、
 * **押しても専用画面へ移らないこと**（伝播を止めている）、**押せない理由が読めること**。
 *
 * 器を `div` にすると `<button>` が担っている Tab / Enter / Space の到達性を失う。
 * それを避けるために「包んで兄弟として重ねる」形にしてあるので、**到達性そのものを
 * 1本押さえておく**。
 */
describe('SessionTile の復旧', () => {
  const PC2 = '77777777-7777-7777-7777-777777777777'
  /** 接続断で、呼び戻し先を持っているカード（＝復旧の本命） */
  function stale(overrides: Partial<SessionMeta> = {}): SessionMeta {
    return meta({
      agent_connected: false,
      claude_session_id: '22222222-2222-2222-2222-222222222222',
      ...overrides,
    })
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
    useWsStore.setState({ revive: vi.fn() })
  })

  it('実体があるカードにはボタンを出さない', () => {
    // 出さないのはこの1通りだけ（設計§3-2）
    renderTile(meta({ agent_connected: true, status: { kind: 'working' } }))
    expect(screen.queryByTestId('revive-button')).toBeNull()
  })

  it('接続断のカードには押せるボタンが出る', () => {
    renderTile(stale())
    const button = screen.getByTestId('revive-button')
    expect(button).toBeEnabled()
    expect(button.dataset.state).toBe('ready')
  })

  it('終了したカードにも出る', () => {
    renderTile(stale({ agent_connected: true, status: { kind: 'ended', ok: true } }))
    expect(screen.getByTestId('revive-button')).toBeEnabled()
  })

  it('押すと、そのカードを起こし直すよう頼む', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    renderTile(stale())

    await userEvent.click(screen.getByTestId('revive-button'))

    expect(revive).toHaveBeenCalledWith(CARD)
  })

  it('押しても画面が切り替わらない', async () => {
    /*
      **伝播の相手は器（小窓）ではなく、その外側の枠である。** ボタンは器の「中」では
      なく `relative` の入れ物の中に**兄弟として**置いてあるので（設計§9-1）、器へは
      構造上そもそも届かない。届くのは `ProjectGroup` の `<section>` で、あそこは
      **余白のクリックで PJT 専用画面へ移る**（同じ場所に2つの意味がある）。

      したがって枠の中に置いて確かめる。**小窓を単体で描いて確かめると、止めるのを
      やめても落ちない**——最初にそう書いて空振りした。
    */
    applySessionSnapshot([stale()])
    const onGroupClick = vi.fn()
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              // ProjectGroup の <section>（余白クリックで PJT 専用画面へ）の役
              <section onClick={onGroupClick}>
                <SessionTile cardId={CARD} />
              </section>
            }
          />
          <Route path="/s/:cardId" element={<p>専用画面</p>} />
        </Routes>
      </MemoryRouter>,
    )

    await userEvent.click(screen.getByTestId('revive-button'))

    expect(onGroupClick).not.toHaveBeenCalled()
    expect(screen.queryByText('専用画面')).toBeNull()
  })

  it('小窓はいままでどおりキーボードで到達でき、Enter で開く', async () => {
    // 器を `div` に変えていないことの担保（設計§9-1）
    renderTile(stale())

    await userEvent.tab()
    expect(screen.getByTestId('session-tile')).toHaveFocus()

    await userEvent.keyboard('{Enter}')
    expect(screen.getByText('専用画面')).toBeInTheDocument()
  })

  it('押せないときも、ボタンは出て理由が読める', () => {
    // 出さないと「なぜこのカードにだけ無いのか」を推測させることになる
    renderTile(stale({ claude_session_id: null }))

    const button = screen.getByTestId('revive-button')
    expect(button).toBeDisabled()
    expect(button.dataset.state).toBe('no-target')
    expect(button).toHaveAttribute('title', '呼び戻す先が記録されていません')
  })

  it('PC が繋がっていなければ、そう言って押させない', () => {
    useSettingsStore.setState({
      settings: settingsFixture({
        agents: [
          {
            id: PC2,
            name: '仕事用ノート',
            last_seen_at: 1,
            connected: false,
            supports_revive: true,
          },
        ],
      }),
      loading: false,
    })
    renderTile(stale({ agent_id: PC2 }))

    const button = screen.getByTestId('revive-button')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'この PC が繋がっていません')
  })

  it('名乗らない PC では、版が古いと言う', () => {
    useSettingsStore.setState({
      settings: settingsFixture({
        agents: [
          { id: PC2, name: '仕事用ノート', last_seen_at: 1, connected: true },
        ],
      }),
      loading: false,
    })
    renderTile(stale({ agent_id: PC2 }))

    expect(screen.getByTestId('revive-button')).toHaveAttribute(
      'title',
      'この PC の版が古くて対応していません',
    )
  })

  it('押している間は「復旧中…」になり、二度押せない', async () => {
    // 席が空くまでカードは1バイトも変わらない（設計§9-4）。印が無いと手応えが出ない
    const revive = vi.fn(() => markReviving(CARD))
    useWsStore.setState({ revive })
    renderTile(stale())

    await userEvent.click(screen.getByTestId('revive-button'))

    const button = screen.getByTestId('revive-button')
    expect(button).toHaveTextContent('復旧中…')
    expect(button).toBeDisabled()
  })

  it('サーバ由来の状態が届いたら、印が消える', () => {
    renderTile(stale())
    act(() => markReviving(CARD))
    expect(screen.getByTestId('revive-button')).toHaveTextContent('復旧中…')

    // 起こし直しが始まると、そのカードの `session_upsert` が流れてくる
    act(() =>
      upsertSession(stale({ status: { kind: 'starting' }, agent_connected: true })),
    )

    expect(screen.queryByTestId('revive-button')).toBeNull()
  })

  it('断りはそのカードに出る', () => {
    // 画面全体の帯ではなく名指しの場所へ（設計§9-5）
    renderTile(stale())
    act(() => setCardError(CARD, 'この PC が繋がっていません'))

    expect(screen.getByTestId('card-error')).toHaveTextContent(
      'この PC が繋がっていません',
    )
    // 断られたのに「復旧中…」が残ると、二度と押せないカードになる
    expect(screen.getByTestId('revive-button')).toHaveTextContent('復旧')
  })

  it('印は押したカードだけに立つ', () => {
    // 全体に持つと、6枚を並べたときに一覧が丸ごと描き直される（設計§9-4）
    const other = '33333333-3333-3333-3333-333333333333'
    applySessionSnapshot([stale(), stale({ card_id: other })])
    render(
      <MemoryRouter initialEntries={['/']}>
        <SessionTile cardId={other} />
      </MemoryRouter>,
    )
    act(() => markReviving(CARD))

    // **部分一致で見ない。**「復旧中…」は「復旧」を含むので、
    // `toHaveTextContent('復旧')` では巻き添えを捕まえられない（実際に空振りした）
    expect(screen.getByTestId('revive-button')).not.toHaveTextContent('復旧中')
  })
})
