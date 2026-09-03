import { act, fireEvent, render, screen } from '@testing-library/react'
import App from './App'
import { markComposerBusy } from '@/lib/composerBusy'
import { useAuthStore } from '@/stores/auth'
import { useWsStore } from '@/stores/ws'

/**
 * jsdom には本物の WebSocket サーバがないので、接続だけを差し替える。
 * ここで確かめたいのは画面が組み上がることであって、通信そのものではない
 * （通信を含めた確認は Playwright の E2E が実サーバ相手に行う）。
 */
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

/**
 * 鍵の無いローカルモード（実機と同じ形）の `GET /api/me`。
 *
 * **ここを返さないとログイン画面が出る。** 画面は「何を出すべきか」をこの応答だけで
 * 決めており（セルフホスト化設計§8-1）、ブラウザ側で構成を推測しないため。
 */
const OPEN_MODE = JSON.stringify({
  mode: 'open',
  authenticated: true,
  account: null,
  is_admin: false,
  setup_open: false,
  from_loopback: true,
})

/** 差し替えた `location.reload`。呼ばれたかどうかで読み直しを見る。 */
let 読み直した: ReturnType<typeof vi.fn>

/** その版を名乗っているサーバの応答。**版が変わったことを作るのに使う。** */
function 版(version: string) {
  return {
    mode: 'open' as const,
    authenticated: true,
    account: null,
    is_admin: false,
    setup_open: false,
    from_loopback: true,
    version,
  }
}

beforeEach(() => {
  // **鍵の状態を毎回まっさらに戻す。** ストアはモジュールに1つなので、前のテストで
  // 通った状態が残ると「聞く前から入れている」テストができてしまう
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
    // **印も毎回降ろす。** 掛け金なので降ろす口が製品コードに無く、足さないと
    // 一度立った時点で以降の全テストが読み直しを走らせる
    serverChanged: false,
  })
  vi.stubGlobal('WebSocket', FakeWebSocket)
  // 読み直しは実際には起こさせない。`Object.defineProperty(window.location, 'reload')`
  // は jsdom が拒む（[LegacyUnforgeable]）が、`location` ごと差し替えるのは通る。
  // `host` と `protocol` は綴りを保つ——`ws.ts` が繋ぎ先を組み立てるのに読む
  読み直した = vi.fn()
  vi.stubGlobal('location', { ...window.location, reload: 読み直した })
  // 接続時に取りにいく初期スナップショット（設計§4）と、入口の鍵の状態
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
  // 接続はモジュールに1つだけ持たせているので、明示的に畳まないと次のテストが
  // 「もう繋がっている」と判断して接続処理ごと飛ばしてしまう
  useWsStore.getState().disconnect()
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('PJT を追加する入口と一覧の枠が表示される', async () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: 'AgentDashboard' }),
    ).toBeInTheDocument()
    // **聞いてから描く。** 何を出すかはサーバの構成で決まるので、最初の1描画では
    // まだ決まっていない（`GET /api/me` の応答を待つ）
    //
    // 起動の入口は「PJT を追加」に入れ替わった（イシューグループ_2026_0805_0514 §13）。
    // セッションを起こすのは枠の「+」からで、一覧に起動フォームは無い
    expect(await screen.findByTestId('project-add-open')).toBeInTheDocument()
    expect(
      await screen.findByText('セッションはまだありません'),
    ).toBeInTheDocument()
  })

  it('押すまで追加のシートは出ていない', async () => {
    // 一覧は「押して開く」ための画面なので、重ねて出すものが最初から居てはいけない
    render(<App />)

    await screen.findByTestId('project-add-open')
    expect(screen.queryByTestId('project-add-sheet')).toBeNull()
  })

  it('接続時に一覧のスナップショットを取りにいく', async () => {
    render(<App />)

    await screen.findByText('セッションはまだありません')
    expect(fetch).toHaveBeenCalledWith('/api/sessions')
  })

  it('版がタイトルの近くに出る', async () => {
    // **更新したつもりで古い画面を見ている**という取り違えがいちばん時間を溶かす。
    // 値は認証の応答が既に運んでいるので、通信は増えていない
    useAuthStore.setState({
      auth: { ...useAuthStore.getState().auth, authenticated: true, version: '9.9.9' },
      loading: false,
    })
    render(<App />)

    expect(await screen.findByTestId('app-version')).toHaveTextContent('v9.9.9')
  })

  it('版を返さないサーバでは何も出さない', async () => {
    // 古いサーバは返さない。**空の括弧を出すより、出さないほうがよい**
    useAuthStore.setState({
      auth: { ...useAuthStore.getState().auth, authenticated: true, version: undefined },
      loading: false,
    })
    render(<App />)

    await screen.findByTestId('connection-status')
    expect(screen.queryByTestId('app-version')).toBeNull()
  })

  it('自己修復の進行が段階つきで出る', () => {
    // 「勝手に直った」を黙って起こさないための表示（設計§9）。
    // バナーは鍵の外側にある（通っていなくても、直っていることは見せる）
    useWsStore.setState({
      selfheal: { phase: 'repairing', detail: '1/3 回目' },
    })
    render(<App />)

    const banner = screen.getByTestId('selfheal-banner')
    expect(banner).toHaveTextContent('修復セッションが作業しています')
    expect(banner).toHaveTextContent('1/3 回目')
    expect(banner.dataset.phase).toBe('repairing')
  })

  it('直せなかったときは人が気づける見た目にする', () => {
    // 直った・進行中と、人の手が要る状態を同じ見た目にすると見落とす
    useWsStore.setState({
      selfheal: { phase: 'failed', detail: null },
    })
    render(<App />)

    const banner = screen.getByTestId('selfheal-banner')
    expect(banner.className).toContain('red')
  })
})

/**
 * 版が切り替わったら、タブが自分で読み直す。
 *
 * 検知そのものは `stores/auth.test.ts` が、抱えているかの台帳は
 * `lib/composerBusy.test.ts` と `Composer.test.tsx` が見ている。ここで見るのは**分岐**
 * ——抱えていなければ読み直し、抱えていればバナーを出して人に任せることである。
 */
describe('版が切り替わったときの読み直し', () => {
  /** 取り下げ忘れが次のテストへ漏れないようにする（台帳はモジュールに1つ）。 */
  let 取り下げ: (() => void) | null = null

  afterEach(() => {
    取り下げ?.()
    取り下げ = null
  })

  /**
   * **描いたあとに印を立てる。** 立った状態で描く形にすると、効果の依存を `[]` に
   * 壊しても通ってしまう（マウント時に一度だけ走れば足りるため）。
   */
  it('抱えているものが無ければ、自分で読み直す', () => {
    render(<App />)

    act(() => {
      useAuthStore.setState({ serverChanged: true })
    })

    expect(読み直した).toHaveBeenCalledTimes(1)
  })

  it('抱えているタブは読み直さず、バナーを出す', () => {
    取り下げ = markComposerBusy()
    render(<App />)

    act(() => {
      useAuthStore.setState({ serverChanged: true })
    })

    expect(読み直した).not.toHaveBeenCalled()
    expect(screen.getByTestId('server-changed-banner')).toBeTruthy()
  })

  it('印が立っていなければ、読み直しもバナーも無い', () => {
    render(<App />)

    expect(読み直した).not.toHaveBeenCalled()
    expect(screen.queryByTestId('server-changed-banner')).toBeNull()
  })

  /** 抱えているタブにとっては、これが唯一の道。**押せることまで確かめる。** */
  it('抱えていても、「読み込み直す」を押せば読み直す', () => {
    取り下げ = markComposerBusy()
    render(<App />)
    act(() => {
      useAuthStore.setState({ serverChanged: true })
    })

    fireEvent.click(screen.getByText('読み込み直す'))

    expect(読み直した).toHaveBeenCalledTimes(1)
  })

  /**
   * **いちばん重い1本**（設計§17）。印は掛け金で降りないので、依存が `[serverChanged]`
   * だけだと**そのタブの一生で1回しか試さない**——1回目が抱えていて塞がれると、以後
   * どれだけ版が変わっても二度と読み直さなかった。実機で不発だったのがこの形である。
   */
  it('見送ったあと、取り下げてから版が変わると読み直す', () => {
    取り下げ = markComposerBusy()
    render(<App />)
    act(() => {
      useAuthStore.setState({ serverChanged: true, auth: 版('0.1.79') })
    })
    expect(読み直した).not.toHaveBeenCalled()

    取り下げ()
    取り下げ = null
    act(() => {
      useAuthStore.setState({ auth: 版('0.1.81') })
    })

    expect(読み直した).toHaveBeenCalledTimes(1)
  })

  /**
   * **添付の増減では走らせない**（§6）。押していない瞬間に画面が飛ぶと、利用者から
   * 見れば「消したら壊れた」に見える。走るのは版が変わったときだけ。
   */
  it('同じ版のままなら、取り下げても読み直さない', () => {
    取り下げ = markComposerBusy()
    render(<App />)
    act(() => {
      useAuthStore.setState({ serverChanged: true, auth: 版('0.1.79') })
    })

    取り下げ()
    取り下げ = null
    act(() => {
      useAuthStore.setState({ auth: 版('0.1.79') })
    })

    expect(読み直した).not.toHaveBeenCalled()
  })

  /**
   * 抱えているのは**画面の外**でありうる（PJT 専用画面はセッション全数の入力欄を
   * 仮想化なしに描く）。理由を書かないと、なぜ止まっているのかが永久に見えない。
   */
  it('見送ったバナーには、添付が理由だと件数つきで出る', () => {
    取り下げ = markComposerBusy()
    const もう一つ = markComposerBusy()
    render(<App />)
    act(() => {
      useAuthStore.setState({ serverChanged: true })
    })

    const banner = screen.getByTestId('server-changed-banner')
    expect(banner).toHaveTextContent('添付')
    expect(banner).toHaveTextContent('2 件')

    もう一つ()
  })
})

describe('通っていない間の見え方（セルフホスト化設計§8-2）', () => {
  it('ログイン前は接続の様子も導線も出さない', async () => {
    // **動作は正しいのに見た目が嘘をつく**形の回帰テスト。繋ぎに行くのは通ってから
    // なので、出すと必ず「切断」と表示される（実物を見て気づいた）
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/me'
          ? new Response(
              JSON.stringify({
                mode: 'account',
                authenticated: false,
                account: null,
                is_admin: false,
                setup_open: true,
                from_loopback: true,
              }),
              { status: 200 },
            )
          : new Response('[]', { status: 200 }),
      ),
    )
    render(<App />)

    // 最初のセットアップが出る（管理者がまだ居ない）
    expect(await screen.findByTestId('setup-form')).toBeInTheDocument()
    expect(screen.queryByTestId('connection-status')).toBeNull()
    expect(screen.queryByTestId('settings-link')).toBeNull()
    expect(screen.queryByTestId('account-link')).toBeNull()
  })
})
