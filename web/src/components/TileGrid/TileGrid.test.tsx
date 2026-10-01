import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import {
  ANNOUNCE_DEBOUNCE_MS,
  TileGrid,
  WAITING_SHOW_DELAY_MS,
  移動の文言,
} from './TileGrid'
import type { SessionMeta } from '@/lib/protocol'
import { ASK_LIMIT_MS, RECHECK_LIMIT_MS, type HostResources } from '@/lib/reviveBudget'
import {
  applySessionSnapshot,
  clearSessions,
  getSessions,
  upsertSession,
} from '@/stores/sessions'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'
import { clearSelection, getSelection, toggleSelect } from '@/stores/selection'
import { remoteAgent, settingsFixture } from '@/test/fixtures'

/**
 * 一覧の絞り込み（セルフホスト化設計§8-5、テスト計画フェーズ5）。
 *
 * `.agent-dashboard.toml` の名乗りは、ローカルモードでは**認証ではなく一覧の
 * フィルタとしてのみ**働く。攻撃者の居ない環境での自己整理機能で、権限とは無関係。
 */

const NOW = 1_700_000_000_000

function meta(cardId: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    card_id: cardId,
    project: `/dev/${cardId}`,
    claude_session_id: null,
    resumed_from: null,
    permission_mode: null,
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
    branched_from: null,
    context_usage: null,
    rate_limits: null,
    cost: null,
    ...overrides,
  }
}

/**
 * **「全て復旧」は廃止された**ので、まとめて起こす道は「選ぶ → 帯の電源」だけになった
 * （細かい修正 要件13・設計§4-2）。**取り返しの付かない範囲を、押す人が決められる。**
 *
 * 以前は `revive-all` を1回押すだけだった。ここが増えたぶんは、**選ばずに全部起こす道が
 * 無くなったこと**そのものである。
 */
async function 選んで起こす(...cardIds: string[]) {
  const 対象 = cardIds.length > 0 ? cardIds : getSessions().map((m) => m.card_id)
  act(() => {
    // **必ず地ならしする。** `toggleSelect` は既に選ばれているものを外すので、
    // 前の選択が残っていると狙いと逆に働く
    clearSelection()
    for (const id of 対象) {
      toggleSelect('card', id)
    }
  })
  await userEvent.click(screen.getByTestId('bulk-revive'))
}

function renderGrid() {
  return render(
    <MemoryRouter>
      <TileGrid />
    </MemoryRouter>,
  )
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

describe('名乗りによる絞り込み', () => {
  it('名乗ったカードが無ければ選択肢を出さない', () => {
    // 使わない操作を常に置くと、一覧の主役（状態インジケータ）が埋もれる
    applySessionSnapshot([meta('a'), meta('b')])
    renderGrid()

    expect(screen.queryByTestId('account-filter')).toBeNull()
  })

  it('選んだ名乗りのカードだけになる', async () => {
    applySessionSnapshot([
      meta('a', { toml_account: 'しごと' }),
      meta('b', { toml_account: 'あそび' }),
      meta('c'),
    ])
    renderGrid()

    expect(screen.getAllByTestId('session-tile')).toHaveLength(3)

    await userEvent.selectOptions(
      screen.getByTestId('account-filter'),
      'しごと',
    )
    const shown = screen.getAllByTestId('session-tile')
    expect(shown).toHaveLength(1)
    expect(shown[0].dataset.cardId).toBe('a')

    // 戻せる。**サーバへは何も送っていない**（表示だけの操作）
    await userEvent.selectOptions(screen.getByTestId('account-filter'), '')
    expect(screen.getAllByTestId('session-tile')).toHaveLength(3)
  })

  it('絞り込んだ結果が空でも、理由が分かる文言を出す', async () => {
    // 「まだありません」と出すと、絞り込んでいることを忘れて起動していないと思う
    applySessionSnapshot([meta('a', { toml_account: 'しごと' })])
    renderGrid()

    await userEvent.selectOptions(
      screen.getByTestId('account-filter'),
      'しごと',
    )
    // ストアの更新は React の外から来るので、描き直しを待ってから見る
    act(() => {
      applySessionSnapshot([])
    })

    expect(screen.getByText(/「しごと」/)).toBeInTheDocument()
  })
})

/**
 * ホームの「全て復旧」（復旧設計§9-3）。
 *
 * 押す前に**内訳**を出す。「全て」の中身が分からないと押せない、というのが要件で、
 * 雛形は版の切替の「いま入れ替えると N 枚が抜け殻になります」——あちらも**押す
 * ボタンより上に**数を置いている。**0枚なら0枚と言う**（沈黙させない）。
 *
 * 数はブラウザが手元のカードから数える。版の切替と違い、**全カードを既に持っている**
 * ので、サーバに数えさせる理由が無い。
 */
describe('全て復旧', () => {
  const PC = '77777777-7777-7777-7777-777777777777'

  /** 接続断で、呼び戻し先を持っているカード */
  function stale(cardId: string, overrides: Partial<SessionMeta> = {}) {
    return meta(cardId, {
      agent_connected: false,
      claude_session_id: `2222${cardId}`,
      ...overrides,
    })
  }

  beforeEach(() => {
    // **選択を持ち越さない。** まとめて起こす道が「選ぶ → 帯の電源」になったので、
    // 前のテストの選択が残っていると `toggleSelect` が**外す側**に働いて数が合わなくなる
    clearSelection()
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
    useWsStore.setState({ revive: vi.fn() })
    /*
      **メモリの歯止めはここでは見ない**（下の「メモリの歯止め」の describe が見る）。
      PC は「この機械では数えない」（501）と答える＝歯止め無しで進む。
      以前は `fetch` を偽らず、相対 URL で投げた失敗を「聞けなかった＝歯止め無し」に
      頼っていた——**通信の失敗はもう歯止め無しに倒れない**ので、意図を名指しする
    */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 501 }) as Response),
    )
  })

  it('起こせるカードが1枚も無ければ、帯の電源は押せない', () => {
    /*
      **「全て復旧」の行は廃止した**（細かい修正 要件13・設計§4-2）。0枚を言葉で
      出していた場所も一緒に消えたので、**押せないことは帯の電源が示す**。

      内訳（`接続断 X枚／終了 Y枚`）は**帯へ移さずに落とした**。帯は選んだものについての
      面なので、**選んでいないものの集計を置くと意味が食い違う**。
    */
    applySessionSnapshot([meta('a'), meta('b')])
    renderGrid()
    act(() => toggleSelect('card', 'a'))

    expect(screen.getByTestId('bulk-revive')).toBeDisabled()
  })

  it('「全て復旧」の行そのものが無くなっている', () => {
    applySessionSnapshot([stale('a'), meta('b')])
    renderGrid()

    expect(screen.queryByTestId('revive-all-row')).toBeNull()
    expect(screen.queryByTestId('revive-all')).toBeNull()
    expect(screen.queryByTestId('revive-breakdown')).toBeNull()
  })

  it('帯の電源は、選んだうち起こせる枚数を名乗る', () => {
    // **押す前に数が出る**（要件）。選んでいないものは数に入らない
    applySessionSnapshot([stale('a'), stale('b'), meta('c')])
    renderGrid()
    act(() => {
      toggleSelect('card', 'a')
      toggleSelect('card', 'c')
    })

    expect(screen.getByTestId('bulk-revive')).toHaveAttribute(
      'aria-label',
      '選んだうち、止まっている 1枚を起こす',
    )
  })

  it('押すと、対象ぶんだけ起こし直すよう頼む', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    applySessionSnapshot([stale('a'), meta('b'), stale('c')])
    renderGrid()

    await 選んで起こす()

    expect(revive).toHaveBeenCalledTimes(2)
    expect(revive).toHaveBeenCalledWith('a')
    expect(revive).toHaveBeenCalledWith('c')
    // 実体があるカードは巻き込まない
    expect(revive).not.toHaveBeenCalledWith('b')
  })

  it('押しても断られるカードは数にも対象にも入れない', async () => {
    // **押した人が数を予測できること**（要件）。数えたものと送るものを一致させる
    const revive = vi.fn()
    useWsStore.setState({ revive })
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
    applySessionSnapshot([
      stale('a'),
      // 繋がっていない PC のカードと、呼び戻し先の無いカード
      stale('b', { agent_id: PC }),
      stale('c', { claude_session_id: null }),
    ])
    renderGrid()

    await 選んで起こす()
    expect(revive).toHaveBeenCalledTimes(1)
    expect(revive).toHaveBeenCalledWith('a')
  })

  it('絞り込みで見えていないカードは起こさない', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    applySessionSnapshot([
      stale('a', { toml_account: 'しごと' }),
      stale('b', { toml_account: 'あそび' }),
    ])
    renderGrid()

    await userEvent.selectOptions(screen.getByTestId('account-filter'), 'しごと')

    await 選んで起こす()
    expect(revive).toHaveBeenCalledTimes(1)
    expect(revive).toHaveBeenCalledWith('a')
  })

  it('接続断になった瞬間に、帯の数え直しが効く', () => {
    /*
      **接続断は構造を変えない**（同じ箱に同じカードが並んだまま）ので、構造の購読だけに
      任せると数が古いまま残る。内訳の文言は落としたが（要件13）、**数え直しそのものは
      帯の電源が引き継いでいる**ので、ここで見る相手を替えて残す。
    */
    applySessionSnapshot([meta('a')])
    renderGrid()
    act(() => toggleSelect('card', 'a'))
    expect(screen.getByTestId('bulk-revive')).toBeDisabled()

    act(() => {
      upsertSession(stale('a'))
    })

    expect(screen.getByTestId('bulk-revive')).toBeEnabled()
    expect(screen.getByTestId('bulk-revive')).toHaveAttribute(
      'aria-label',
      '選んだうち、止まっている 1枚を起こす',
    )
  })
})

/**
 * メモリの歯止め（起こし直し設計§18-5）。
 *
 * **枚数だけでは資源が読めない。** 26枚が約 20GB を要求することは内訳からは分からず、
 * 押すと機械が固まる。数えるのは PC 側で、ここがやるのは比べることだけ。
 */
describe('全て復旧のメモリの歯止め', () => {
  function stale(cardId: string, lastActivityAt: number) {
    return meta(cardId, {
      agent_connected: false,
      claude_session_id: `2222${cardId}`,
      last_activity_at: lastActivityAt,
    })
  }

  /** 実体が居るカード。**戻せる相手ではない** */
  function live(cardId: string) {
    return meta(cardId, {
      agent_connected: true,
      claude_session_id: `2222${cardId}`,
      status: { kind: 'waiting_input' },
    })
  }

  /**
   * `GET /api/hosts/{host}/resources` の答えを決める。
   *
   * `外側` は WSL の外側（Windows）の状態。**既定は WSL でない機械**（両方 `null`）で、
   * いまと同じ見た目になる。
   */
  function 資源を答える(
    fits: number | null | 'エラー' | '入館証切れ' | { status: number },
    外側: Partial<HostResources> = {
      host_free_mb: null,
      counted_mb: null,
    },
  ) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (fits === 'エラー') {
          return { ok: false, status: 503 } as Response
        }
        if (fits !== null && typeof fits === 'object') {
          return { ok: false, status: fits.status } as Response
        }
        // **401 だけは「聞けなかった」と別扱い**（コードレビュー対応13）
        if (fits === '入館証切れ') {
          return { ok: false, status: 401 } as Response
        }
        return {
          ok: true,
          json: async () => ({
            total_mb: 16_000,
            available_mb: 13_000,
            swap_free_mb: 0,
            estimate_mb: 780,
            headroom_mb: 2_048,
            fits_now: fits,
            ...外側,
          }),
        } as unknown as Response
      }),
    )
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
    useWsStore.setState({ revive: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('全部入るなら、ダイアログを出さずにそのまま進む', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    資源を答える(10)
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 選んで起こす()

    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
    expect(revive).toHaveBeenCalledTimes(2)
  })

  it('WSL でない機械では、外側の行が出ない（いまと同じ見た目）', async () => {
    // **`counted_mb` が null なら行そのものが出ない。** WSL でない機械の答えは
    // 1ビットも変わらないという約束を、画面の側でも固定する
    useWsStore.setState({ revive: vi.fn() })
    資源を答える(1)
    applySessionSnapshot([stale('a', 1), stale('b', 2), stale('c', 3)])
    renderGrid()

    await 選んで起こす()

    expect(screen.getByTestId('revive-budget-dialog')).toBeInTheDocument()
    expect(
      screen.queryByTestId('revive-budget-outside'),
    ).not.toBeInTheDocument()
  })

  it('WSL で外側を確かめられたら、何で抑えたのかが画面に出る', async () => {
    useWsStore.setState({ revive: vi.fn() })
    資源を答える(1, {
      host_free_mb: 1_792,
      counted_mb: 1_792,
      host_free_state: 'fresh',
      host_free_age_sec: 12,
      effective_mb: 1_792,
    })
    applySessionSnapshot([stale('a', 1), stale('b', 2), stale('c', 3)])
    renderGrid()

    await 選んで起こす()

    const 行 = screen.getByTestId('revive-budget-outside')
    expect(行).toHaveTextContent('Windows 側の空き 1.8 GB（12 秒前に確認）／使える空き 1.8 GB')
    // **WSL のときは「WSL の中の空き」と呼び分ける**（設計§6-3）
    expect(screen.getByTestId('revive-budget-available')).toHaveTextContent('WSL の中の空き')
    expect(screen.queryByTestId('revive-budget-reserved')).not.toBeInTheDocument()
  })

  it('古い PC が外側をまだ聞けていないと答えても、「もう一度押すと反映されます」とは書かない', async () => {
    // 押し直す必要は無くなった（判定が確かめ直す）ので、残すと嘘になる（設計§6-3）。
    // 古い PC は状態の欄を送ってこないので、いまの規則で数える（設計§12-6）
    useWsStore.setState({ revive: vi.fn() })
    資源を答える(1, { host_free_mb: null, counted_mb: 3_000 })
    applySessionSnapshot([stale('a', 1), stale('b', 2), stale('c', 3)])
    renderGrid()

    await 選んで起こす()

    const 行 = screen.getByTestId('revive-budget-outside')
    expect(行).toHaveTextContent('まだ聞けていません')
    expect(screen.getByTestId('revive-budget-dialog')).not.toHaveTextContent('もう一度押す')
    expect(screen.getByTestId('revive-budget-fits')).toHaveTextContent('1枚')
  })

  it('入りきらないとダイアログが出て、押すまで1枚も送らない', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    資源を答える(1)
    applySessionSnapshot([stale('a', 1), stale('b', 2), stale('c', 3)])
    renderGrid()

    await 選んで起こす()

    expect(screen.getByTestId('revive-budget-dialog')).toBeInTheDocument()
    // **数と、いま入る枚数の両方を出す。** 枚数だけでは資源が読めない
    expect(screen.getByTestId('revive-budget-targets')).toHaveTextContent('3枚')
    expect(screen.getByTestId('revive-budget-fits')).toHaveTextContent('1枚')
    expect(revive).not.toHaveBeenCalled()
  })

  it('入るぶんだけ戻すと、その枚数だけを新しい順に送る', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    資源を答える(2)
    applySessionSnapshot([stale('古い', 100), stale('新しい', 300), stale('中', 200)])
    renderGrid()

    await 選んで起こす()
    await userEvent.click(screen.getByTestId('revive-budget-fitting'))

    expect(revive).toHaveBeenCalledTimes(2)
    expect(revive).toHaveBeenCalledWith('新しい')
    expect(revive).toHaveBeenCalledWith('中')
    expect(revive).not.toHaveBeenCalledWith('古い')
    // 押したら閉じる
    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
  })

  it('それでも全部戻すを選べる（押すのは人）', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    資源を答える(1)
    applySessionSnapshot([stale('a', 1), stale('b', 2), stale('c', 3)])
    renderGrid()

    await 選んで起こす()
    await userEvent.click(screen.getByTestId('revive-budget-all'))

    expect(revive).toHaveBeenCalledTimes(3)
  })

  it('やめると1枚も送らない', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    資源を答える(0)
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 選んで起こす()
    await userEvent.click(screen.getByTestId('revive-budget-cancel'))

    expect(revive).not.toHaveBeenCalled()
    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
  })

  it('1枚も入らないなら「入るぶんだけ」は押せない', async () => {
    資源を答える(0)
    applySessionSnapshot([stale('a', 1)])
    renderGrid()

    await 選んで起こす()

    expect(screen.getByTestId('revive-budget-fitting')).toBeDisabled()
    expect(screen.getByTestId('revive-budget-all')).toBeEnabled()
  })

  it('数えないと言われたら、ダイアログを出さずに進む', async () => {
    // `revive_estimate_mb = 0`＝歯止めを外している（コードレビュー対応2）。
    // **「聞けなかった」と同じ扱いでよい**——どちらも歯止め無しで進む側である
    const revive = vi.fn()
    useWsStore.setState({ revive })
    資源を答える(null)
    applySessionSnapshot([stale('a', 1), stale('b', 2), stale('c', 3)])
    renderGrid()

    await 選んで起こす()

    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
    expect(revive).toHaveBeenCalledTimes(3)
  })

  /*
    ダイアログを開けたまま対象が変わっても、**送るのはいま戻せる相手だけ**
    （コードレビュー対応3）。凍結したまま送ると、既に live なカードへも送って
    「このカードは復旧中です」が並ぶ。

    **壊し方**：`送る` の絞り込みを外すと、この2本が落ちる。
  */
  it('ダイアログを開けている間に戻ったカードへは送らない', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    資源を答える(1)
    applySessionSnapshot([stale('a', 1), stale('b', 2), stale('c', 3)])
    renderGrid()

    await 選んで起こす()
    expect(screen.getByTestId('revive-budget-dialog')).toBeInTheDocument()

    // 開けている間に、別の画面から `b` が戻った（＝もう抜け殻ではない）
    act(() => {
      applySessionSnapshot([stale('a', 1), live('b'), stale('c', 3)])
    })
    await userEvent.click(screen.getByTestId('revive-budget-all'))

    const 送った = revive.mock.calls.map((call) => call[0])
    expect(送った).not.toContain('b')
    expect(送った.toSorted()).toEqual(['a', 'c'])
  })

  it('ダイアログを開けている間に消えたカードへは送らない', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    資源を答える(1)
    applySessionSnapshot([stale('a', 1), stale('b', 2), stale('c', 3)])
    renderGrid()

    await 選んで起こす()
    act(() => {
      applySessionSnapshot([stale('a', 1), stale('c', 3)])
    })
    await userEvent.click(screen.getByTestId('revive-budget-all'))

    expect(revive.mock.calls.map((call) => call[0]).toSorted()).toEqual([
      'a',
      'c',
    ])
  })

  it.each([
    [501, '読めない機械（Linux 以外）'],
    [409, '資源を聞く口を持たない古い版の PC'],
  ])('「この機械では数えない」（%i：%s）なら、歯止め無しで進む（分からないことを理由に止めない）', async (status) => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    資源を答える({ status })
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 選んで起こす()

    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
    expect(revive).toHaveBeenCalledTimes(2)
  })

  it('入館証が切れていたら、ログイン画面へ移して1枚も送らない', async () => {
    // **「聞けなかった」と混ぜてはいけない**（コードレビュー対応13）。あちらは
    // 歯止め無しで進む側だが、こちらで進むと**ログイン画面へ落ちずに26枚流す**
    const revive = vi.fn()
    useWsStore.setState({ revive })
    useAuthStore.setState({
      auth: {
        mode: 'lan_password',
        authenticated: true,
        account: null,
        is_admin: false,
        setup_open: false,
        from_loopback: false,
      },
    })
    資源を答える('入館証切れ')
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 選んで起こす()

    expect(revive).not.toHaveBeenCalled()
    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
    // 他の取得口（`stores/settings.ts` ほか）と同じ約束＝`markSignedOut()` を呼ぶ
    expect(useAuthStore.getState().auth.authenticated).toBe(false)
  })

  it('2台以上のとき、ダイアログは生の_agent_id_ではなく_PC_名を出す', async () => {
    // 生の UUID が並ぶと**どちらを間引くかを決められない**——このダイアログの
    // 目的そのものが果たせない（コードレビュー対応10）
    useSettingsStore.setState({
      settings: settingsFixture(remoteAgent('11111111-2222-3333-4444-555555555555', 'OMEN')),
      loading: false,
    })
    資源を答える(1)
    applySessionSnapshot([
      stale('a', 1),
      stale('b', 2),
      meta('c', {
        agent_connected: false,
        claude_session_id: '2222c',
        last_activity_at: 3,
        agent_id: '11111111-2222-3333-4444-555555555555',
      }),
    ])
    renderGrid()

    await 選んで起こす()

    const 行 = screen.getAllByTestId('revive-budget-host')
    const 文 = 行.map((row) => row.textContent ?? '').join('\n')
    expect(文).toContain('OMEN')
    expect(文).not.toContain('11111111-2222-3333-4444-555555555555')
  })
})

/**
 * Windows 側の空きを確かめてから計画する（寝ているカードばかりなのに、メモリ不足で
 * セッションを起こせない 設計§6-3・§8-5・§12-6）。
 *
 * **確かめられていない数で「何枚戻すか」を決めない。** `checking`・`stale` は聞き直し、
 * 確かめられなかった PC は 0 枚として必ずダイアログを出す。
 */
describe('まとめて復旧は、Windows 側の空きを確かめてから数える', () => {
  const PC = '11111111-2222-3333-4444-555555555555'

  function stale(cardId: string, lastActivityAt: number, agentId: string | null = null) {
    return meta(cardId, {
      agent_connected: false,
      claude_session_id: `2222${cardId}`,
      last_activity_at: lastActivityAt,
      agent_id: agentId,
    })
  }

  function 答え(
    fits: number | null,
    state: 'fresh' | 'stale' | 'checking' | 'failed',
    overrides: Partial<HostResources> = {},
  ): HostResources {
    return {
      total_mb: 24_000,
      available_mb: 19_072,
      swap_free_mb: 6_144,
      estimate_mb: 780,
      headroom_mb: 2_048,
      fits_now: fits,
      host_free_mb: state === 'checking' ? null : 5_408,
      counted_mb: 5_408,
      host_free_age_sec: state === 'checking' ? null : state === 'stale' ? 240 : 12,
      host_free_state: state,
      host_free_fresh_for_sec: null,
      host_free_error: state === 'failed' ? 'powershell.exe を起動できません' : null,
      effective_mb: 5_408,
      ...overrides,
    }
  }

  /**
   * PC ごとに答えを順に返す。尽きたら最後のものを返し続ける。
   *
   * `'止まる'` は打ち切られるまで答えない、`'投げる'` は通信が失敗する、`{ status }` は
   * その状態コードで答える。**打ち切りの印を受けたら、本物と同じく reject する**
   */
  type 一手 = HostResources | { status: number } | '止まる' | '投げる'
  const 渡された印: AbortSignal[] = []
  function 順に答える(列: Record<string, 一手[]>) {
    const 回数: Record<string, number> = {}
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      const host = decodeURIComponent(url.split('/')[3])
      const answers = 列[host]
      const at = 回数[host] ?? 0
      回数[host] = at + 1
      const 手 = answers[Math.min(at, answers.length - 1)]
      const signal = init?.signal ?? null
      if (signal !== null) {
        渡された印.push(signal)
      }
      return new Promise<Response>((resolve, reject) => {
        const 断る = () => reject(new DOMException('aborted', 'AbortError'))
        if (signal?.aborted) {
          断る()
          return
        }
        signal?.addEventListener('abort', 断る)
        if (手 === '止まる') {
          return
        }
        if (手 === '投げる') {
          reject(new TypeError('Failed to fetch'))
          return
        }
        if ('status' in 手) {
          resolve({ ok: false, status: 手.status } as Response)
          return
        }
        resolve({ ok: true, status: 200, json: async () => 手 } as unknown as Response)
      })
    })
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  /** 偽の時計の下で押す。`userEvent` は偽の時計で止まるので `fireEvent` を使う */
  async function 押す(...cardIds: string[]) {
    act(() => {
      clearSelection()
      for (const id of cardIds) {
        toggleSelect('card', id)
      }
    })
    fireEvent.click(screen.getByTestId('bulk-revive'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  async function 進める(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    clearSelection()
    渡された印.length = 0
    useSettingsStore.setState({
      settings: settingsFixture(remoteAgent(PC, 'OMEN')),
      loading: false,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('checking なら聞き直し、新しい値で全部入るならダイアログを出さずに送る', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    const fetch = 順に答える({ local: [答え(0, 'checking'), 答え(0, 'checking'), 答え(5, 'fresh')] })
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 押す('a', 'b')
    // **床が 0 枚と言っていても、それで決めない。** まだ1枚も送らず、ボタンは忙しい
    expect(revive).not.toHaveBeenCalled()
    expect(screen.getByTestId('bulk-revive')).toBeDisabled()
    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()

    await 進める(1_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    await 進める(1_000)

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
    expect(revive.mock.calls.map((call) => call[0]).toSorted()).toEqual(['a', 'b'])
  })

  it('stale も聞き直してから数える', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    順に答える({ local: [答え(9, 'stale'), 答え(1, 'fresh')] })
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 押す('a', 'b')
    // **前回の値が「全部入る」と言っても送らない**
    expect(revive).not.toHaveBeenCalled()
    await 進める(1_000)

    expect(screen.getByTestId('revive-budget-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('revive-budget-fits')).toHaveTextContent('1枚')
    expect(revive).not.toHaveBeenCalled()
  })

  it('上限 65 秒まで確かめられなければ、0 枚としてダイアログを必ず出す', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    // **床は「全部入る」と答えている。** それで黙って全部送る道を塞ぐ（設計§8-5）
    順に答える({ local: [答え(99, 'stale')] })
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 押す('a', 'b')
    await 進める(64_000)
    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
    await 進める(2_000)

    const dialog = screen.getByTestId('revive-budget-dialog')
    expect(dialog).toHaveAttribute('aria-label', 'Windows 側の空きを確かめられていません')
    expect(screen.getByTestId('revive-budget-title')).toHaveTextContent(
      'Windows 側の空きを確かめられていません',
    )
    expect(screen.getByTestId('revive-budget-outside')).toHaveTextContent(
      'Windows 側の空き 5.3 GB（4 分前の値・確かめ直しましたが答えが来ませんでした）',
    )
    expect(screen.getByTestId('revive-budget-fits')).toHaveTextContent('0枚')
    expect(screen.getByTestId('revive-budget-fitting')).toBeDisabled()
    expect(screen.getByTestId('revive-budget-recheck')).toBeEnabled()
    expect(revive).not.toHaveBeenCalled()
  })

  it('failed なら聞き直さず、理由を添えてダイアログを出す', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    const fetch = 順に答える({ local: [答え(99, 'failed')] })
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 押す('a', 'b')

    expect(fetch).toHaveBeenCalledTimes(1)
    const dialog = screen.getByTestId('revive-budget-dialog')
    expect(dialog).toHaveAttribute('aria-label', 'Windows 側の空きを確かめられませんでした')
    expect(screen.getByTestId('revive-budget-title')).toHaveTextContent(
      'Windows 側の空きを確かめられませんでした',
    )
    expect(screen.getByTestId('revive-budget-outside')).toHaveTextContent(
      'Windows 側の空きを確かめられませんでした（powershell.exe を起動できません）',
    )
    expect(screen.getByTestId('revive-budget-fits')).toHaveTextContent('0枚')
    // 「それでも全部戻す」は残す（判定が確かめ直す）が、そう添える
    expect(screen.getByTestId('revive-budget-all')).toBeEnabled()
    expect(dialog).toHaveTextContent('起こすときに PC 側が確かめ直し')
    // 確かめられた PC が無いので「空きを超え」とは言わない
    expect(dialog).not.toHaveTextContent('空きを超え')
    expect(revive).not.toHaveBeenCalled()
  })

  it('checking のまま上限に達したら、確かめている途中ではなく「確かめられていない」と出す', async () => {
    // 打ち切った後に「確かめています」と出すと、まだ待てば答えが来るように読める
    useWsStore.setState({ revive: vi.fn() })
    順に答える({ local: [答え(99, 'checking')] })
    applySessionSnapshot([stale('a', 1)])
    renderGrid()

    await 押す('a')
    await 進める(66_000)

    const outside = screen.getByTestId('revive-budget-outside')
    expect(outside).toHaveTextContent('Windows 側の空きを確かめられていません')
    expect(outside).not.toHaveTextContent('確かめています')
    // 注意書きの文の途中に、改行由来の半角スペースを混ぜない
    expect(screen.getByRole('dialog').textContent).not.toMatch(/[。、] [^ ]/)
  })

  it('見積もり0なら、checking でも待たずに全部送る', async () => {
    // 数えないのだから、確かめる値が要らない（設計§12-6 の順1）
    const revive = vi.fn()
    useWsStore.setState({ revive })
    const fetch = 順に答える({ local: [答え(null, 'checking')] })
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 押す('a', 'b')

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(revive).toHaveBeenCalledTimes(2)
  })

  it('PC が2台で片方だけ確かめられないとき、入るぶんには確かめられた PC のぶんだけが入る', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    順に答える({ local: [答え(99, 'failed')], [PC]: [答え(5, 'fresh')] })
    applySessionSnapshot([
      stale('a1', 1),
      stale('a2', 2),
      stale('b1', 1, PC),
      stale('b2', 2, PC),
    ])
    renderGrid()

    await 押す('a1', 'a2', 'b1', 'b2')

    expect(screen.getByTestId('revive-budget-fitting')).toHaveTextContent('2枚')
    fireEvent.click(screen.getByTestId('revive-budget-fitting'))
    expect(revive.mock.calls.map((call) => call[0]).toSorted()).toEqual(['b1', 'b2'])
  })

  it('起こしている途中のぶんが制約なら、使える空きは差し引いた値で、引いたぶんを言う', async () => {
    useWsStore.setState({ revive: vi.fn() })
    順に答える({ local: [答え(0, 'fresh', { effective_mb: 2_400 })] })
    applySessionSnapshot([stale('a', 1)])
    renderGrid()

    await 押す('a')

    // **「使える空き」は CLI・断りの文面と同じく `effective_mb`**（予約を引く前の 5.3 GB ではない）
    const outside = screen.getByTestId('revive-budget-outside')
    expect(outside).toHaveTextContent('／使える空き 2.3 GB')
    expect(outside).not.toHaveTextContent('使える空き 5.3 GB')
    // 引いたぶん（5408 − 2400 MB）を、何から引いたのかと一緒に言う
    expect(screen.getByTestId('revive-budget-reserved')).toHaveTextContent(
      '使える空きは、起こしている途中のぶん 2.9 GB を差し引いた値です',
    )
    expect(screen.getByTestId('revive-budget-dialog')).toHaveAttribute(
      'aria-label',
      '起こし直せますが、メモリが足りません',
    )
  })

  it('WSL でない機械で起こしている途中のぶんが制約なら、使える空きを値ごと出す', async () => {
    // 外側の行が出ない機械では、使える空きはここでしか読めない（差分だけだと結果が消える）
    useWsStore.setState({ revive: vi.fn() })
    順に答える({
      local: [
        答え(0, 'fresh', {
          host_free_state: null,
          host_free_mb: null,
          host_free_age_sec: null,
          counted_mb: null,
          effective_mb: 9_000,
        }),
      ],
    })
    applySessionSnapshot([stale('a', 1)])
    renderGrid()

    await 押す('a')

    expect(screen.queryByTestId('revive-budget-outside')).not.toBeInTheDocument()
    // 19072 − 9000 MB を差し引いて 9000 MB
    expect(screen.getByTestId('revive-budget-reserved')).toHaveTextContent(
      '使える空き 8.8 GB（起こしている途中のぶん 9.8 GB を差し引いた値）',
    )
  })

  it('確かめられていない PC には、起こしている途中のぶんの行を出さない', async () => {
    // 数えていないので、引いた値も判断材料にならない
    useWsStore.setState({ revive: vi.fn() })
    順に答える({ local: [答え(99, 'failed', { effective_mb: 1_000 })] })
    applySessionSnapshot([stale('a', 1)])
    renderGrid()

    await 押す('a')

    expect(screen.getByTestId('revive-budget-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('revive-budget-reserved')).not.toBeInTheDocument()
  })

  it('聞き直しの途中で画面を離れたら、遅れて届いた答えで送らない', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    順に答える({ local: [答え(0, 'checking'), 答え(9, 'fresh')] })
    applySessionSnapshot([stale('a', 1)])
    const view = renderGrid()

    await 押す('a')
    view.unmount()
    await 進める(5_000)

    expect(revive).not.toHaveBeenCalled()
  })

  it('聞き直しの間に戻ったカードには送らず、増えたカードも足さない', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    順に答える({ local: [答え(0, 'checking'), 答え(9, 'fresh')] })
    applySessionSnapshot([stale('a', 1), stale('b', 2), stale('c', 3)])
    renderGrid()

    await 押す('a', 'b')
    act(() => {
      // b が別の画面から戻り、d が新しく抜け殻になった
      applySessionSnapshot([
        stale('a', 1),
        meta('b', { claude_session_id: '2222b', status: { kind: 'waiting_input' } }),
        stale('c', 3),
        stale('d', 4),
      ])
    })
    await 進める(1_000)

    expect(revive.mock.calls.map((call) => call[0])).toEqual(['a'])
  })

  it('もう一度確かめて新しい値で全部入ると分かっても、黙って送らず、押させる', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    const fetch = 順に答える({ local: [答え(99, 'failed'), 答え(0, 'checking'), 答え(5, 'fresh')] })
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 押す('a', 'b')
    fireEvent.click(screen.getByTestId('revive-budget-recheck'))
    await 進める(0)
    // 確かめている間は忙しさを出し、「やめる」以外は押せない
    expect(screen.getByTestId('revive-budget-recheck')).toBeDisabled()
    expect(screen.getByTestId('revive-budget-recheck')).toHaveTextContent('確かめています')
    expect(screen.getByTestId('revive-budget-all')).toBeDisabled()
    expect(screen.getByTestId('revive-budget-cancel')).toBeEnabled()
    await 進める(1_000)

    expect(fetch).toHaveBeenCalledTimes(3)
    // **押したのは「確かめる」で「戻す」ではない。** 計画を見せて、押すまで送らない
    expect(revive).not.toHaveBeenCalled()
    const dialog = screen.getByTestId('revive-budget-dialog')
    expect(dialog).toHaveAttribute('aria-label', '全部起こし直せます')
    expect(screen.getByTestId('revive-budget-fits')).toHaveTextContent('5枚')
    // 押す場所は1つ。「入るぶんだけ」と「それでも全部」を二重に出さない
    expect(screen.queryByTestId('revive-budget-fitting')).not.toBeInTheDocument()
    expect(screen.queryByTestId('revive-budget-recheck')).not.toBeInTheDocument()
    expect(dialog).not.toHaveTextContent('新しい順')
    expect(screen.getByTestId('revive-budget-all')).toHaveTextContent('全部戻す（2枚）')
    expect(screen.getByTestId('revive-budget-all')).not.toHaveTextContent('それでも')

    fireEvent.click(screen.getByTestId('revive-budget-all'))
    expect(revive.mock.calls.map((call) => call[0]).toSorted()).toEqual(['a', 'b'])
    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
  })

  it('確かめ直している途中でやめたら、遅れた答えで送らず、開き直さない', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    順に答える({ local: [答え(99, 'failed'), 答え(0, 'checking'), 答え(5, 'fresh')] })
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 押す('a', 'b')
    fireEvent.click(screen.getByTestId('revive-budget-recheck'))
    await 進める(0)
    fireEvent.click(screen.getByTestId('revive-budget-cancel'))
    await 進める(5_000)

    expect(revive).not.toHaveBeenCalled()
    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
  })

  it('確かめ直しても確かめられなければ、ダイアログが新しい答えで残る', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    順に答える({ local: [答え(99, 'failed'), 答え(2, 'fresh', { effective_mb: 3_000 })] })
    applySessionSnapshot([stale('a', 1), stale('b', 2), stale('c', 3)])
    renderGrid()

    await 押す('a', 'b', 'c')
    fireEvent.click(screen.getByTestId('revive-budget-recheck'))
    await 進める(0)

    // 確かめられたが足りない → いつもの見出しへ戻り、「もう一度確かめる」は消える
    expect(screen.getByTestId('revive-budget-dialog')).toHaveAttribute(
      'aria-label',
      '起こし直せますが、メモリが足りません',
    )
    expect(screen.getByTestId('revive-budget-fits')).toHaveTextContent('2枚')
    expect(screen.queryByTestId('revive-budget-recheck')).not.toBeInTheDocument()
    expect(revive).not.toHaveBeenCalled()
  })
  it('確かめ直しの1周目で通信が失敗しても、全部送らずにダイアログを残す', async () => {
    // **前回の PC 別の答えを引き継ぎ、新しい有効な答えを得るまで確かめられていないまま**
    // （Astra 3）。以前は答え無しを「歯止め無し」と読み、閉じて全部送っていた
    const revive = vi.fn()
    useWsStore.setState({ revive })
    順に答える({ local: [答え(99, 'failed'), '投げる'] })
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 押す('a', 'b')
    fireEvent.click(screen.getByTestId('revive-budget-recheck'))
    await 進める(0)
    expect(revive).not.toHaveBeenCalled()
    expect(screen.getByTestId('revive-budget-dialog')).toBeInTheDocument()

    await 進める(66_000)
    expect(revive).not.toHaveBeenCalled()
    expect(screen.getByTestId('revive-budget-dialog')).toHaveAttribute(
      'aria-label',
      'PC の空きメモリを聞けませんでした',
    )
    expect(screen.getByTestId('revive-budget-fits')).toHaveTextContent('0枚')
    expect(screen.getByTestId('revive-budget-recheck')).toBeEnabled()
  })

  it('最初から答えが来なければ、全部送らずに聞き直し、締切でダイアログを出す', async () => {
    // **「この機械では数えない」（501・409）以外の失敗は、WSL の PC でも起こる。**
    // 歯止め無しへ倒すと、確かめていない数のまま全部送る
    const revive = vi.fn()
    useWsStore.setState({ revive })
    順に答える({ local: [{ status: 504 }, '投げる'] })
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 押す('a', 'b')
    expect(revive).not.toHaveBeenCalled()
    // 答えそのものが来ていないので「Windows 側」とは言わない
    const 帯の文 = screen.getByTestId('bulk-count')
    expect(帯の文).toHaveTextContent('空きメモリの答えを待っています…')
    expect(帯の文).not.toHaveTextContent('Windows')

    await 進める(66_000)
    expect(revive).not.toHaveBeenCalled()
    const dialog = screen.getByTestId('revive-budget-dialog')
    expect(dialog).toHaveAttribute('aria-label', 'PC の空きメモリを聞けませんでした')
    expect(screen.getByTestId('revive-budget-outside')).toHaveTextContent(
      'この PC から空きメモリの答えが来ませんでした',
    )
    expect(dialog).not.toHaveTextContent('Windows')
    // 前に聞けた答えが無くても、対象と 0 枚は出す（画面から消さない）
    expect(screen.getByTestId('revive-budget-targets')).toHaveTextContent('2枚')
    expect(screen.getByTestId('revive-budget-fits')).toHaveTextContent('0枚')
    expect(screen.getByTestId('revive-budget-fitting')).toBeDisabled()
  })

  it('問い合わせが止まっても、締切でダイアログを出し、止まった問い合わせを切る', async () => {
    // 以前は `fetch()` に打ち切りが無く、65 秒を過ぎても「確かめています」のままだった（Astra 2）
    const revive = vi.fn()
    useWsStore.setState({ revive })
    順に答える({ local: ['止まる'] })
    applySessionSnapshot([stale('a', 1)])
    renderGrid()

    await 押す('a')
    await 進める(ASK_LIMIT_MS)
    expect(渡された印[0].aborted).toBe(true)
    await 進める(66_000 - ASK_LIMIT_MS)

    expect(screen.getByTestId('revive-budget-dialog')).toHaveAttribute(
      'aria-label',
      'PC の空きメモリを聞けませんでした',
    )
    expect(revive).not.toHaveBeenCalled()
  })

  it('PC が2台で片方が止まっても、締切で、答えた PC のぶんだけを「入るぶん」に入れる', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    順に答える({ local: [答え(5, 'fresh')], [PC]: ['止まる'] })
    applySessionSnapshot([stale('a1', 1), stale('a2', 2), stale('b1', 1, PC)])
    renderGrid()

    await 押す('a1', 'a2', 'b1')
    await 進める(66_000)

    expect(screen.getByTestId('revive-budget-fitting')).toHaveTextContent('2枚')
    fireEvent.click(screen.getByTestId('revive-budget-fitting'))
    expect(revive.mock.calls.map((call) => call[0]).toSorted()).toEqual(['a1', 'a2'])
  })

  /** その PC へ聞いた回数 */
  function 聞いた回数(fetch: ReturnType<typeof 順に答える>, host: string): number {
    return fetch.mock.calls.filter(([url]) => url.includes(`/api/hosts/${host}/`)).length
  }

  it('答えない PC のカードが別の画面で全部外されたら、待つのをやめて、答えた PC のぶんをすぐ送る', async () => {
    // **問い合わせる PC を始めた時点で固めると、締切の 65 秒まで a1 も起こせなかった**
    // （実装レビュー第9回 Astra 4）
    const revive = vi.fn()
    useWsStore.setState({ revive })
    const fetch = 順に答える({ local: [答え(5, 'fresh')], [PC]: ['止まる'] })
    applySessionSnapshot([stale('a1', 1), stale('b1', 1, PC)])
    renderGrid()

    await 押す('a1', 'b1')
    await 進める(2_000)
    expect(revive).not.toHaveBeenCalled()
    expect(聞いた回数(fetch, PC)).toBe(1)
    const PCの印 = 渡された印[fetch.mock.calls.findIndex(([url]) => url.includes(PC))]
    expect(PCの印.aborted).toBe(false)

    act(() => {
      // b1 が別の画面から外された
      applySessionSnapshot([stale('a1', 1)])
    })
    await 進める(0)

    expect(revive.mock.calls.map((call) => call[0])).toEqual(['a1'])
    expect(PCの印.aborted).toBe(true)
    expect(screen.getByTestId('bulk-revive')).toBeEnabled()
    await 進める(5_000)
    expect(聞いた回数(fetch, PC)).toBe(1)
  })

  it('外した PC のカードが戻ってきても、足さない（確かめていない数で送らない）', async () => {
    // PC が一度切れて繋がり直すと、そのカードは「起こせない」から「起こせる」へ戻る。
    // **その PC へはもう聞いていないので、足すと確かめていない数で送る**
    const revive = vi.fn()
    useWsStore.setState({ revive })
    const fetch = 順に答える({
      local: [
        答え(0, 'checking'),
        答え(0, 'checking'),
        答え(0, 'checking'),
        答え(0, 'checking'),
        答え(5, 'fresh'),
      ],
      [PC]: ['止まる'],
    })
    applySessionSnapshot([stale('a1', 1), stale('b1', 1, PC)])
    renderGrid()

    await 押す('a1', 'b1')
    await 進める(2_500)
    const PCの印 = 渡された印[fetch.mock.calls.findIndex(([url]) => url.includes(PC))]
    act(() => {
      applySessionSnapshot([stale('a1', 1)])
    })
    await 進める(0)
    // **local を待っている間でも、外した PC への問い合わせはその場で切る**
    expect(PCの印.aborted).toBe(true)
    await 進める(1_000)
    act(() => {
      applySessionSnapshot([stale('a1', 1), stale('b1', 1, PC)])
    })
    // local は 4 秒に新しい値を返す
    await 進める(1_000)

    expect(revive.mock.calls.map((call) => call[0])).toEqual(['a1'])
    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
    expect(聞いた回数(fetch, PC)).toBe(1)
  })

  it('待っている間に増えた PC のカードには、その PC へ聞かず、送りもしない', async () => {
    // **対象は減らすだけ。** 縮めるついでに、いまの対象で組み直すと増えたものまで入る
    const revive = vi.fn()
    useWsStore.setState({ revive })
    const fetch = 順に答える({
      local: [答え(0, 'checking'), 答え(5, 'fresh')],
      [PC]: [答え(9, 'fresh')],
    })
    applySessionSnapshot([stale('a1', 1)])
    renderGrid()

    await 押す('a1')
    act(() => {
      applySessionSnapshot([stale('a1', 1), stale('b1', 1, PC)])
      toggleSelect('card', 'b1')
    })
    await 進める(1_000)

    expect(聞いた回数(fetch, PC)).toBe(0)
    expect(revive.mock.calls.map((call) => call[0])).toEqual(['a1'])
  })

  it('答えない PC を1台外しても、残った PC を待つのは元の締切まで（組み直して延ばさない）', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    順に答える({ local: ['止まる'], [PC]: ['止まる'] })
    applySessionSnapshot([stale('a1', 1), stale('b1', 1, PC)])
    renderGrid()

    await 押す('a1', 'b1')
    await 進める(30_000)
    act(() => {
      applySessionSnapshot([stale('a1', 1)])
    })
    await 進める(RECHECK_LIMIT_MS - 30_000 - 100)
    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
    await 進める(100)

    const dialog = screen.getByTestId('revive-budget-dialog')
    expect(dialog).toHaveAttribute('aria-label', 'PC の空きメモリを聞けませんでした')
    // **外した PC は出さない**（2台なら PC 名が並ぶ）
    expect(dialog).not.toHaveTextContent('OMEN')
    expect(screen.getByTestId('revive-budget-fits')).toHaveTextContent('0枚')
    expect(revive).not.toHaveBeenCalled()
  })

  it('ダイアログを開いた後に答えない PC のカードが外されたら、「もう一度確かめる」はその PC へ聞き直さない', async () => {
    // 押した時点の対象から確かめ直すと、カードの無い PC をまた 65 秒待つ
    const revive = vi.fn()
    useWsStore.setState({ revive })
    const fetch = 順に答える({ local: [答え(5, 'fresh')], [PC]: ['止まる'] })
    applySessionSnapshot([stale('a1', 1), stale('b1', 1, PC)])
    renderGrid()

    await 押す('a1', 'b1')
    await 進める(66_000)
    expect(screen.getByTestId('revive-budget-dialog')).toHaveAttribute(
      'aria-label',
      'PC の空きメモリを聞けませんでした',
    )
    const 開いたとき = 聞いた回数(fetch, PC)

    act(() => {
      applySessionSnapshot([stale('a1', 1)])
    })
    fireEvent.click(screen.getByTestId('revive-budget-recheck'))
    await 進める(0)

    expect(聞いた回数(fetch, PC)).toBe(開いたとき)
    expect(screen.getByTestId('revive-budget-dialog')).toHaveAttribute(
      'aria-label',
      '全部起こし直せます',
    )
    expect(revive).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('revive-budget-all'))
    expect(revive.mock.calls.map((call) => call[0])).toEqual(['a1'])
  })

  it('「もう一度確かめる」の時点で戻す相手が1枚も残っていなければ、聞かずにダイアログを閉じる', async () => {
    // 「全部戻す（0枚）」を押させても何も起きない
    const revive = vi.fn()
    useWsStore.setState({ revive })
    const fetch = 順に答える({ local: [答え(5, 'fresh')], [PC]: ['止まる'] })
    applySessionSnapshot([stale('a1', 1), stale('b1', 1, PC)])
    renderGrid()

    await 押す('a1', 'b1')
    await 進める(66_000)
    const 開いたとき = fetch.mock.calls.length

    act(() => {
      // a1 は別の画面から戻り、b1 は外された
      applySessionSnapshot([
        meta('a1', { claude_session_id: '2222a1', status: { kind: 'waiting_input' } }),
      ])
    })
    fireEvent.click(screen.getByTestId('revive-budget-recheck'))
    await 進める(0)

    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(開いたとき)
    expect(revive).not.toHaveBeenCalled()
  })

  it('画面を離れたら、進行中の問い合わせを切る', async () => {
    useWsStore.setState({ revive: vi.fn() })
    順に答える({ local: ['止まる'] })
    applySessionSnapshot([stale('a', 1)])
    const view = renderGrid()

    await 押す('a')
    expect(渡された印[0].aborted).toBe(false)
    view.unmount()
    expect(渡された印[0].aborted).toBe(true)
  })

  it('聞き直している間は帯に何を待っているかと「やめる」を出し、やめたら打ち切って送らない', async () => {
    // **最長 65 秒聞き直すので、止める手段が要る**（Fable 5）
    const revive = vi.fn()
    useWsStore.setState({ revive })
    const fetch = 順に答える({ local: [答え(0, 'checking'), 答え(0, 'checking'), 答え(5, 'fresh')] })
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 押す('a', 'b')
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('Windows 側の空きを確かめています…')
    const やめる = screen.getByTestId('bulk-revive-stop')
    expect(やめる).toHaveTextContent('やめる')
    expect(screen.getByTestId('bulk-revive')).toBeDisabled()

    fireEvent.click(やめる)
    await 進める(5_000)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(revive).not.toHaveBeenCalled()
    expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('bulk-revive-stop')).not.toBeInTheDocument()
    // 忙しさも戻り、数の文へ戻る
    expect(screen.getByTestId('bulk-revive')).toBeEnabled()
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('2枚を選んでいます')
  })

  it('1周目の答えが遅いときも、少し待ってから「やめる」を出し、押せば止まった問い合わせを切る', async () => {
    // **押した瞬間には出さない**（普段は数十ミリ秒で返るので、帯の文が一瞬入れ替わって戻る）
    useWsStore.setState({ revive: vi.fn() })
    順に答える({ local: ['止まる'] })
    applySessionSnapshot([stale('a', 1)])
    renderGrid()

    await 押す('a')
    expect(screen.queryByTestId('bulk-revive-stop')).not.toBeInTheDocument()
    await 進める(WAITING_SHOW_DELAY_MS)
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('空きメモリを確かめています…')

    fireEvent.click(screen.getByTestId('bulk-revive-stop'))
    expect(渡された印[0].aborted).toBe(true)
    expect(screen.queryByTestId('bulk-revive-stop')).not.toBeInTheDocument()
  })

  it('待っている間に選択を外しても、帯と「やめる」は隠れない', async () => {
    // 隠すと、裏で聞き直しが続いたまま止める手段が見えなくなる
    useWsStore.setState({ revive: vi.fn() })
    順に答える({ local: [答え(0, 'checking')] })
    applySessionSnapshot([stale('a', 1)])
    renderGrid()

    await 押す('a')
    act(() => {
      clearSelection()
    })

    const 帯 = screen.getByTestId('bulk-row')
    expect(帯).not.toHaveClass('invisible')
    expect(帯).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByTestId('bulk-revive-stop')).toBeInTheDocument()
  })

  /*
    **ダイアログを出した後も、数えた枚数は古くなる**（実装レビュー第3回 Astra 3）。
    `答え()` の既定は新しさの残りが `null`（期限なし）なので、ここでは必ず値を渡す
  */
  describe('ダイアログを開けている間に、数えた枚数が古くなったら', () => {
    it('「入るぶんだけ戻す」を押しても送らずに確かめ直し、結果をダイアログに出す', async () => {
      const revive = vi.fn()
      useWsStore.setState({ revive })
      const fetch = 順に答える({
        local: [
          答え(1, 'fresh', { host_free_fresh_for_sec: 30 }),
          答え(0, 'checking'),
          答え(0, 'fresh', { host_free_fresh_for_sec: 60 }),
        ],
      })
      applySessionSnapshot([stale('a', 1), stale('b', 2)])
      renderGrid()

      await 押す('a', 'b')
      expect(screen.getByTestId('revive-budget-fitting')).toHaveTextContent('1枚')
      await 進める(30_000)
      fireEvent.click(screen.getByTestId('revive-budget-fitting'))
      await 進める(0)

      // **古い数で送らない。** 確かめている間は忙しさを出す（全台確かめられていても出す）
      expect(revive).not.toHaveBeenCalled()
      expect(screen.getByTestId('revive-budget-recheck')).toHaveTextContent('確かめています')
      expect(screen.getByTestId('revive-budget-recheck')).toBeDisabled()
      expect(screen.getByTestId('revive-budget-fitting')).toBeDisabled()
      await 進める(1_000)

      expect(fetch).toHaveBeenCalledTimes(3)
      expect(revive).not.toHaveBeenCalled()
      expect(screen.getByTestId('revive-budget-fits')).toHaveTextContent('0枚')
      expect(screen.getByTestId('revive-budget-fitting')).toBeDisabled()
      // 押したのに送られなかったわけを言う
      expect(screen.getByTestId('revive-budget-dialog')).toHaveTextContent(
        '枚数が古くなっていたので、送らずに確かめ直しました',
      )
    })

    it('期限の内なら、いまどおり数えたぶんを送る', async () => {
      const revive = vi.fn()
      useWsStore.setState({ revive })
      const fetch = 順に答える({ local: [答え(1, 'fresh', { host_free_fresh_for_sec: 30 })] })
      applySessionSnapshot([stale('a', 1), stale('b', 2)])
      renderGrid()

      await 押す('a', 'b')
      await 進める(29_000)
      fireEvent.click(screen.getByTestId('revive-budget-fitting'))

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(revive.mock.calls.map((call) => call[0])).toEqual(['b'])
      expect(screen.queryByTestId('revive-budget-dialog')).not.toBeInTheDocument()
    })

    it('確かめ直しの後の「全部戻す」も、古くなっていたら送らずに確かめ直す', async () => {
      // **「全部起こし直せます」を古い数のまま残さない**
      const revive = vi.fn()
      useWsStore.setState({ revive })
      const fetch = 順に答える({
        local: [
          答え(99, 'failed'),
          答え(5, 'fresh', { host_free_fresh_for_sec: 30 }),
          答え(1, 'fresh', { host_free_fresh_for_sec: 60 }),
        ],
      })
      applySessionSnapshot([stale('a', 1), stale('b', 2)])
      renderGrid()

      await 押す('a', 'b')
      fireEvent.click(screen.getByTestId('revive-budget-recheck'))
      await 進める(0)
      expect(screen.getByTestId('revive-budget-dialog')).toHaveAttribute(
        'aria-label',
        '全部起こし直せます',
      )

      await 進める(30_000)
      fireEvent.click(screen.getByTestId('revive-budget-all'))
      await 進める(0)

      expect(fetch).toHaveBeenCalledTimes(3)
      expect(revive).not.toHaveBeenCalled()
      expect(screen.getByTestId('revive-budget-dialog')).toHaveAttribute(
        'aria-label',
        '起こし直せますが、メモリが足りません',
      )
      expect(screen.getByTestId('revive-budget-fitting')).toHaveTextContent('1枚')
    })

    it('「それでも全部戻す」は枚数を見ない操作なので、古くなっていてもそのまま送る', async () => {
      // 起こすときに PC 側の判定が確かめ直す（設計§6-3）
      const revive = vi.fn()
      useWsStore.setState({ revive })
      const fetch = 順に答える({ local: [答え(1, 'fresh', { host_free_fresh_for_sec: 30 })] })
      applySessionSnapshot([stale('a', 1), stale('b', 2)])
      renderGrid()

      await 押す('a', 'b')
      await 進める(31_000)
      fireEvent.click(screen.getByTestId('revive-budget-all'))

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(revive.mock.calls.map((call) => call[0]).toSorted()).toEqual(['a', 'b'])
    })

    it('新しさの残りを送ってこない古い PC は、いまどおり期限が付かない', async () => {
      const revive = vi.fn()
      useWsStore.setState({ revive })
      const 古い = { ...答え(1, 'fresh') } as Partial<HostResources>
      delete 古い.host_free_fresh_for_sec
      const fetch = 順に答える({ local: [古い as HostResources] })
      applySessionSnapshot([stale('a', 1), stale('b', 2)])
      renderGrid()

      await 押す('a', 'b')
      await 進める(10 * 60_000)
      fireEvent.click(screen.getByTestId('revive-budget-fitting'))

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(revive.mock.calls.map((call) => call[0])).toEqual(['b'])
    })

    it('ブラウザの時計が巻き戻ったら、残りがあっても古くなったとみなして確かめ直す', async () => {
      // **壁時計で測ると、巻き戻ったぶんだけ新しく見える**（Astra 4）
      const revive = vi.fn()
      useWsStore.setState({ revive })
      const fetch = 順に答える({
        local: [
          答え(1, 'fresh', { host_free_fresh_for_sec: 30 }),
          答え(1, 'fresh', { host_free_fresh_for_sec: 60 }),
        ],
      })
      applySessionSnapshot([stale('a', 1), stale('b', 2)])
      renderGrid()

      await 押す('a', 'b')
      await 進める(5_000)
      act(() => {
        vi.setSystemTime(Date.now() - 60_000)
      })
      fireEvent.click(screen.getByTestId('revive-budget-fitting'))
      await 進める(0)

      expect(fetch).toHaveBeenCalledTimes(2)
      expect(revive).not.toHaveBeenCalled()
      expect(screen.getByTestId('revive-budget-dialog')).toBeInTheDocument()
    })
  })

  it('確かめ直しで、枚数を数えない設定の PC が返ったら、空いた数ではなく数えない理由を出す', async () => {
    // 通信が失敗して確かめ直したら、見積もり 0（歯止めを外している）の答えが返った（Astra 5）。
    // 以前は「いま入るのは 枚」と数が空いていた
    const revive = vi.fn()
    useWsStore.setState({ revive })
    const 列: Record<string, 一手[]> = { local: ['投げる'] }
    順に答える(列)
    applySessionSnapshot([stale('a', 1), stale('b', 2)])
    renderGrid()

    await 押す('a', 'b')
    await 進める(66_000)
    expect(screen.getByTestId('revive-budget-dialog')).toHaveAttribute(
      'aria-label',
      'PC の空きメモリを聞けませんでした',
    )

    列.local.push(答え(null, 'fresh', { estimate_mb: 0, host_free_fresh_for_sec: 60 }))
    fireEvent.click(screen.getByTestId('revive-budget-recheck'))
    await 進める(0)

    const dialog = screen.getByTestId('revive-budget-dialog')
    expect(dialog).toHaveAttribute('aria-label', '全部起こし直せます')
    const 行 = screen.getByTestId('revive-budget-fits')
    expect(行).not.toHaveTextContent('いま入るのは')
    expect(行).toHaveTextContent('この PC は枚数を数えない設定です')
    // 見積もっていないものを「何も要らない」と読ませない
    expect(dialog).not.toHaveTextContent('必要')
    expect(dialog).not.toHaveTextContent('約0MB')
    // 確かめていない数を「全部入ります」と言わない
    expect(dialog).not.toHaveTextContent('全部入ります')
    expect(dialog).toHaveTextContent('数えない PC のぶんは、空きを確かめずに送ります')

    fireEvent.click(screen.getByTestId('revive-budget-all'))
    expect(revive.mock.calls.map((call) => call[0]).toSorted()).toEqual(['a', 'b'])
  })
  it('「この機械では数えない」と答えた PC は、足元の文で「設定」と言わない', async () => {
    // 501（読めない機械）・409（古い版）は設定で外したのではない。片方の PC が入りきらないと
    // ダイアログが出て、数えない PC のぶんも「入るぶん」に入る
    useWsStore.setState({ revive: vi.fn() })
    順に答える({ local: [答え(1, 'fresh')], [PC]: [{ status: 501 }] })
    applySessionSnapshot([stale('a1', 1), stale('a2', 2), stale('b1', 1, PC)])
    renderGrid()

    await 押す('a1', 'a2', 'b1')

    const dialog = screen.getByTestId('revive-budget-dialog')
    expect(dialog).toHaveTextContent('数えない PC のぶんは、空きを確かめずに送ります')
    expect(dialog).not.toHaveTextContent('設定')
    expect(screen.getByTestId('revive-budget-fitting')).toHaveTextContent('2枚')
  })
})

describe('選択モードから出る道', () => {
  // **入れる道を作ったら、出る道も作る**（並べ替え設計§4-2）。出られないと、
  // 触る画面ではシングルタップが「選ぶ」のままになり、**二度と開けなくなる**

  beforeEach(() => {
    clearSelection()
  })

  it('地（枠でもカードでもないところ）を押すと全部外れる', async () => {
    applySessionSnapshot([meta('a')])
    renderGrid()
    await userEvent.click(screen.getByTestId('session-tile'))
    expect(getSelection().ids).toHaveLength(1)

    await userEvent.click(screen.getByTestId('tile-grid-ground'))
    expect(getSelection().ids).toEqual([])
  })

  it('Esc でも全部外れる', async () => {
    applySessionSnapshot([meta('a')])
    renderGrid()
    await userEvent.click(screen.getByTestId('session-tile'))
    expect(getSelection().ids).toHaveLength(1)

    await userEvent.keyboard('{Escape}')
    expect(getSelection().ids).toEqual([])
  })
})

describe('まとめて操作の帯', () => {
  beforeEach(() => {
    clearSelection()
  })

  it('1枚選んだ時点から見えるが、場所は最初から空いている', async () => {
    // **「複数選んだときだけ」にしない**（設計§5-2）。2枚目を選んだ瞬間に
    // ボタンが生えて画面が跳ねる。
    //
    // **そして「選んだときだけ器ごと作る」のも駄目だった。** 1打目で器が生まれると
    // 下の一覧がずれ、**ダブルクリックの2打目が別の場所に当たって開けなくなる**
    // （E2E がこれで落ちた）。器は最初から置き、見え方だけを変える
    applySessionSnapshot([meta('a')])
    renderGrid()
    // **jsdom は Tailwind の CSS を読まない**ので `toBeVisible()` では見分けられない。
    // 見えるのはクラス名と属性まで
    const 帯 = screen.getByTestId('bulk-row')
    expect(帯.className).toContain('invisible')
    expect(帯).toHaveAttribute('aria-hidden', 'true')

    await userEvent.click(screen.getByTestId('session-tile'))
    const 出た = screen.getByTestId('bulk-row')
    expect(出た.className).not.toContain('invisible')
    expect(出た).toHaveAttribute('aria-hidden', 'false')
  })

  it('電源マークは、止まっているものだけを数える', async () => {
    // **走っているカードには触らない**（設計§5-3）。押し間違いで作業中の claude を
    // 止めないため。**何枚が対象で何枚を飛ばすかを、押す前に数で出す**
    // **起こし直せるカードには、戻る先（`claude_session_id`）が要る。**
    // 走っているカードと止まっているカードを1枚ずつ選ぶ
    applySessionSnapshot([
      meta('a', { status: { kind: 'working' } }),
      meta('b', {
        status: { kind: 'ended', ok: true },
        agent_connected: false,
        claude_session_id: '2222b',
      }),
    ])
    renderGrid()
    const tiles = screen.getAllByTestId('session-tile')
    await userEvent.click(tiles[0])
    await userEvent.click(tiles[1])

    expect(screen.getByTestId('bulk-count')).toHaveTextContent('2枚を選んでいます')
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('走っている 1枚は触りません')
  })

  it('走っているカードしか選んでいなければ、電源マークは押せない', async () => {
    applySessionSnapshot([meta('a', { status: { kind: 'working' } })])
    renderGrid()
    await userEvent.click(screen.getByTestId('session-tile'))

    expect(screen.getByTestId('bulk-revive')).toBeDisabled()
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('起こせるのは 0枚')
  })

  /** 並びを送る口の `fetch` を偽り、送った body を控える */
  function 送り先を偽る(status = 200, body = '') {
    const 送った: { url: string; body: unknown }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        送った.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
        return { ok: status < 400, status, text: async () => body } as unknown as Response
      }),
    )
    return 送った
  }

  /** 同じ枠のカード。**枠が違うと「並び」は1枚しか無い**（帯のボタンは同じ枠の中で動かす） */
  const 同じ枠 = (id: string) => meta(id, { project: '/dev/same' })

  it('1つだけ選んでいるときに「前へ」「後ろへ」が出て、2つ選ぶと消える', async () => {
    // **ドラッグ以外の道**（設計§15-6・WCAG 2.2 SC 2.5.7）。2つ以上では宛先が定まらない
    applySessionSnapshot([同じ枠('a'), 同じ枠('b')])
    renderGrid()
    expect(screen.queryByTestId('bulk-move-back')).not.toBeInTheDocument()

    const tiles = screen.getAllByTestId('session-tile')
    await userEvent.click(tiles[0])
    expect(screen.getByTestId('bulk-move-back')).toBeInTheDocument()
    expect(screen.getByTestId('bulk-move-forward')).toBeInTheDocument()

    await userEvent.click(tiles[1])
    expect(screen.queryByTestId('bulk-move-back')).not.toBeInTheDocument()
  })

  it('先頭では「前へ」が押せず、末尾では「後ろへ」が押せない', async () => {
    applySessionSnapshot([同じ枠('a'), 同じ枠('b')])
    renderGrid()
    const tiles = screen.getAllByTestId('session-tile')
    await userEvent.click(tiles[0])
    expect(screen.getByTestId('bulk-move-back')).toBeDisabled()
    expect(screen.getByTestId('bulk-move-forward')).toBeEnabled()
  })

  it('「後ろへ」を押すと、そのカードの枠の並びをドラッグと同じ口で送る', async () => {
    const 送った = 送り先を偽る()
    applySessionSnapshot([同じ枠('a'), 同じ枠('b')])
    renderGrid()
    await userEvent.click(screen.getAllByTestId('session-tile')[0])
    await userEvent.click(screen.getByTestId('bulk-move-forward'))

    expect(送った).toHaveLength(1)
    expect(送った[0].url).toBe('/api/sessions/order')
    expect(送った[0].body).toMatchObject({ card_ids: ['b', 'a'] })
  })

  it('動かした結果は、帯の外の status に読み上げの文言として出る', async () => {
    送り先を偽る()
    applySessionSnapshot([同じ枠('a'), 同じ枠('b')])
    renderGrid()
    await userEvent.click(screen.getAllByTestId('session-tile')[0])
    await userEvent.click(screen.getByTestId('bulk-move-forward'))

    const live = await screen.findByText(/移動しました/)
    expect(live).toHaveAttribute('role', 'status')
    // **帯の中に置くと、何も選んでいないとき `aria-hidden` ごと消えて読まれない**
    expect(screen.getByTestId('bulk-row').contains(live)).toBe(false)
  })

  it('断られたら、理由を読み上げる', async () => {
    送り先を偽る(409, 'いまは並べ替えられません')
    applySessionSnapshot([同じ枠('a'), 同じ枠('b')])
    renderGrid()
    await userEvent.click(screen.getAllByTestId('session-tile')[0])
    await userEvent.click(screen.getByTestId('bulk-move-forward'))

    expect(await screen.findByText('いまは並べ替えられません', { selector: '[role="status"]' })).toBeInTheDocument()
  })

  it('連打しても、文言の差し替えは 100ms に1回', async () => {
    送り先を偽る()
    applySessionSnapshot([同じ枠('a'), 同じ枠('b'), 同じ枠('c')])
    renderGrid()
    await userEvent.click(screen.getAllByTestId('session-tile')[0])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fireEvent.click(screen.getByTestId('bulk-move-forward'))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      fireEvent.click(screen.getByTestId('bulk-move-forward'))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByTestId('bulk-live')).toHaveTextContent('')
      act(() => {
        vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS)
      })
      expect(screen.getByTestId('bulk-live')).toHaveTextContent(/移動しました/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('帯の高さは固定のまま（増やしたボタンで崩していない）', async () => {
    applySessionSnapshot([meta('a')])
    renderGrid()
    await userEvent.click(screen.getByTestId('session-tile'))
    const 帯 = screen.getByTestId('bulk-row')
    for (const 字 of ['h-10', 'flex-nowrap', 'overflow-hidden']) {
      expect(帯.className).toContain(字)
    }
  })

  it('印だけで、文字は使わない', async () => {
    // **利用者の指定**（設計§5-2）。何をするものかはマウスを乗せたときと、
    // 読み上げ用の名前で伝える
    applySessionSnapshot([meta('a')])
    renderGrid()
    await userEvent.click(screen.getByTestId('session-tile'))

    for (const id of ['bulk-move-back', 'bulk-move-forward', 'bulk-revive', 'bulk-remove']) {
      const button = screen.getByTestId(id)
      expect(button.textContent).toBe('')
      expect(button.getAttribute('aria-label')).toBeTruthy()
      expect(button.getAttribute('title')).toBeTruthy()
    }
  })
})

describe('移動の文言', () => {
  it('前後とも居れば「あいだへ」', () => {
    expect(移動の文言('B', ['A', 'B', 'C'], 1)).toBe('「B」を「A」と「C」のあいだへ移動しました')
  })

  it('先頭と末尾は名指しで言う', () => {
    expect(移動の文言('A', ['A', 'B'], 0)).toBe('「A」を先頭へ移動しました（「B」の前）')
    expect(移動の文言('B', ['A', 'B'], 1)).toBe('「B」を末尾へ移動しました（「A」の後ろ）')
  })
})
