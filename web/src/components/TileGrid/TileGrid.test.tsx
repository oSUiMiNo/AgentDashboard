import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { ANNOUNCE_DEBOUNCE_MS, TileGrid, 移動の文言 } from './TileGrid'
import type { SessionMeta } from '@/lib/protocol'
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

  /** `GET /api/hosts/{host}/resources` の答えを決める。 */
  function 資源を答える(fits: number | null | 'エラー' | '入館証切れ') {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (fits === 'エラー') {
          return { ok: false, status: 503 } as Response
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

  it('聞けなかったら、歯止め無しで進む（分からないことを理由に止めない）', async () => {
    // 読めない機械（Linux 以外）や版の古い PC がここに当たる
    const revive = vi.fn()
    useWsStore.setState({ revive })
    資源を答える('エラー')
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
