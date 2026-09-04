/**
 * 画面の組み立てとルーティング（設計§10）。
 *
 * URL は3つ。
 *
 * | URL | 画面 |
 * |---|---|
 * | `/` | 一覧（司令塔ビュー）。プロジェクト単位にまとめた小窓 |
 * | `/p/:projectId` | プロジェクト内の全セッションを横並び |
 * | `/s/:cardId` | セッション専用画面 |
 *
 * WebSocket の接続はここで1度だけ張る。画面を移っても繋ぎ直さないよう、ルーティングの
 * 内側ではなく外側に置いている。
 */

import { MotionConfig } from 'motion/react'
import { useEffect } from 'react'
import { BrowserRouter, Link, Route, Routes, useParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { CloseGlyph, GearGlyph } from '@/components/ui/glyphs'
import { AccountPage } from '@/components/Account/AccountPage'
import { AuthGate } from '@/components/Auth/AuthGate'
import { GroupView } from '@/components/GroupView/GroupView'
import { SessionView } from '@/components/SessionView/SessionView'
import { SettingsPage } from '@/components/Settings/SettingsPage'
import { TileGrid } from '@/components/TileGrid/TileGrid'
import { ProjectAdd } from '@/components/ProjectAdd/ProjectAdd'
import { RoamLayer } from '@/components/RoamLayer/RoamLayer'
import { report } from '@/lib/clientLogs'
import { composerBusyCount } from '@/lib/composerBusy'
import { useDocumentTitle } from '@/lib/documentTitle'
import { projectDisplayName } from '@/lib/path'
import { connectionDot, selfhealLabel } from '@/lib/protocol'
import { ACCOUNT, HOME, LOCAL_HOST, SETTINGS } from '@/lib/routes'
import { canEnter, useAuthStore } from '@/stores/auth'
import { useProjects } from '@/stores/projects'
import { useSessionCard } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

const CONNECTION_LABEL: Record<string, string> = {
  connecting: '接続中…',
  open: '接続済み',
  closed: '切断',
}

/**
 * 版が変わったと知らせてから、実際に読み直すまでの間（ミリ秒。設計§18）。
 *
 * **無言で画面が入れ替わると、押していない人には故障に見える**（利用者の指定
 * 2026-09-05）。**ただし承認は求めない**——待つのは一言を読ませるためだけで、
 * 押さなくても読み直る。
 *
 * **1200ms は「短い1文を読める最短」から取った。** これより短いと読む前に消え、
 * 長いと「早く読み直せ」という待たされ感になる。**`DESIGN.md` §28 の「最長450ms」は
 * 当たらない**——あれは動きの長さの上限で、こちらは文字を読ませる時間である。
 *
 * **待っている間に押せる。** バナーのボタンは残してあるので、待てない人はそちらへ行ける。
 */
export const 読み直すまでの間 = 1200


function App() {
  return (
    /*
      **既定は `"never"` で、何もしないと OS の「動きを減らす」設定を無視する**
      （十字ボタン設計§13）。効く範囲は画面全体だが、入れないほうが既定として
      不適切なので、ここで1回だけ置く。

      有効時に切られるのは transform と layout のアニメーションだけで `opacity` は
      残る——「止めるのではなく弱める」がそのまま実装される。
    */
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </MotionConfig>
  )
}

function Shell() {
  const status = useWsStore((state) => state.status)
  const lastError = useWsStore((state) => state.lastError)
  const parserState = useWsStore((state) => state.parserState)
  const parserDetail = useWsStore((state) => state.parserDetail)
  const busState = useWsStore((state) => state.busState)
  const busDetail = useWsStore((state) => state.busDetail)
  const connect = useWsStore((state) => state.connect)
  const clearError = useWsStore((state) => state.clearError)
  const loadSettings = useSettingsStore((state) => state.load)
  const auth = useAuthStore((state) => state.auth)
  const authLoading = useAuthStore((state) => state.loading)
  const loadAuth = useAuthStore((state) => state.load)

  // **まず「何を出すべきか」を聞く。** 鍵の有無はサーバの構成で決まるので、
  // 繋いでから 401 で気づく形にすると、一瞬だけ空の一覧が描かれる
  useEffect(() => {
    void loadAuth()
  }, [loadAuth])

  const entered = canEnter(auth, authLoading)
  useEffect(() => {
    if (!entered) {
      return
    }
    void connect()
    // 起動ボタンの数と切替の選択肢がこれで決まるので、接続と同時に読む
    void loadSettings()
  }, [entered, connect, loadSettings])

  return (
    <main
      /*
        **外周と段の間隔**（帯設計§17-2・`DESIGN.md` §39.4）。ここが**いちばん外**なので、
        内側はここから半分以下に細くしていく。**上だけ更に詰めてある**——利用者の言葉が
        「**セッションの真上**が広すぎる」だったため。
      */
      className="flex h-dvh flex-col gap-2 p-3 pt-2 md:gap-4 md:p-6 md:pt-4"
    >
      <header className="flex items-center gap-3">
        <Link to={HOME} className="text-xl font-semibold tracking-tight">
          <h1>AgentDashboard</h1>
        </Link>
        {/*
          **版を常に見えるところへ出す**（バージョン表示イシュー）。更新したつもりで
          古い画面を見ている、という取り違えがいちばん時間を溶かす。値は認証の応答が
          既に運んでいるので通信は増えない。古いサーバは返さないので、無ければ出さない
        */}
        {auth.version && (
          <span
            data-testid="app-version"
            title="いま動いているダッシュボードの版"
            className="text-muted-foreground text-xs"
          >
            v{auth.version}
          </span>
        )}
        {/*
          **通っていない間は接続の様子も導線も出さない。** 繋ぎに行くのは通ってから
          なので、出すと必ず「切断」と表示される——動作は正しいのに、**見た目だけが
          「壊れている」と嘘をつく**。設定への導線も、押した先で同じログイン画面へ
          戻るだけになる
        */}
        {entered && (
          <>
            <span
              data-testid="connection-status"
              data-status={status}
              title={CONNECTION_LABEL[status]}
              className="flex shrink-0 items-center"
            >
              <span
                aria-hidden
                className={`size-2 rounded-full ${connectionDot(status)}`}
              />
              {/* **色は読み上げられない。** 文字を消しても、意味は残す */}
              <span className="sr-only">{CONNECTION_LABEL[status]}</span>
            </span>
            <div className="ml-auto flex items-center gap-3">
              {auth.mode === 'account' && (
                <Link
                  to={ACCOUNT}
                  data-testid="account-link"
                  className="text-muted-foreground hover:text-foreground text-sm underline"
                >
                  アカウント
                </Link>
              )}
              {/*
                **歯車にする**（設計§9-2）。**絵文字（`⚙️`）は使わない**——
                `DESIGN.md` §14.4 が禁止例に名指しで挙げている。隣の「アカウント」は
                文字のまま：要件が名指ししているのは「設定」だけで、**言われていない
                ものを揃えるために変えない**。
              */}
              <Button asChild variant="ghost" size="icon-sm">
                <Link
                  to={SETTINGS}
                  data-testid="settings-link"
                  aria-label="設定"
                  title="設定"
                >
                  <GearGlyph />
                </Link>
              </Button>
            </div>
          </>
        )}
      </header>

      {lastError && (
        <div
          data-testid="error-banner"
          className="flex items-center justify-between gap-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm"
        >
          <span>{lastError}</span>
          {/*
            **面を閉じるのは ✕、操作をやめるのは文字**（細かい修正 設計§9-1）。
            取り返しの付かなさが違うものを、同じ形にしない——閉じるのはいつでも
            やり直せるが、「やめる」は選択の1つである。**読み上げ用の名前は残す。**
          */}
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="error-banner-close"
            aria-label="閉じる"
            title="閉じる"
            onClick={clearError}
          >
            <CloseGlyph />
          </Button>
        </div>
      )}

      {/*
        構造化ビューだけが壊れている状態を、はっきり見せる（設計§11）。
        「履歴が出ないのでツールごと使えない」と思わせないことが目的で、
        ターミナルと指示送信が無傷であることを明記する
      */}
      {parserState === 'degraded' && (
        <div
          data-testid="parser-banner"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
        >
          構造化ビューは縮退中です。ターミナルと指示送信はそのまま使えます。
          {parserDetail && (
            <span className="text-muted-foreground ml-2 text-xs">
              {parserDetail}
            </span>
          )}
        </div>
      )}

      {/*
        サーバ同士の連絡が切れている状態を、はっきり見せる（セルフホスト化設計§12）。
        このサーバの中で完結する更新は届き続けるので、症状は「一部だけ古い」という
        分かりにくい形になる。何が止まっているかまで書かないと読み解けない
      */}
      {busState === 'degraded' && (
        <div
          data-testid="bus-banner"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
        >
          サーバ同士の連絡が切れています。別のサーバに繋がっている PC
          の更新だけが止まります。
          {busDetail && (
            <span className="text-muted-foreground ml-2 text-xs">
              {busDetail}
            </span>
          )}
        </div>
      )}

      <SelfhealBanner />
      <ServerChangedBanner />

      {/*
        通っていない間は中身を出さない。**扉は開いているが中は返さない**という
        サーバ側の作り（設計§8-2）と、画面側でも形を揃えてある
      */}
      {authLoading ? null : entered ? (
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/p/:host/:projectId" element={<GroupPage />} />
          <Route path="/s/:cardId" element={<SessionPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      ) : (
        <AuthGate />
      )}

    </main>
  )
}

/**
 * 自己修復の進み具合を出す（設計§9）。
 *
 * 「勝手に直った」ことを黙って起こさないための表示。修復セッション自体は一覧に
 * 通常のセッションとして現れるので、ここで出すのは**いま何段目か**だけにしてある。
 *
 * 更新はフォーマット変更のときにしか来ない低頻度の出来事なので、まとめて反映する
 * 仕組みも動きも付けない（一覧やターミナルの経路とは性質が違う）。
 */
function SelfhealBanner() {
  const selfheal = useWsStore((state) => state.selfheal)
  const clearSelfheal = useWsStore((state) => state.clearSelfheal)

  if (!selfheal) {
    return null
  }
  // 直せなかった・戻したは、人が次の一手を決める必要があるので目立たせる
  const needsAttention =
    selfheal.phase === 'failed' || selfheal.phase === 'rolled_back'

  return (
    <div
      data-testid="selfheal-banner"
      data-phase={selfheal.phase}
      className={`flex items-center justify-between gap-4 rounded-md border px-3 py-2 text-sm ${
        needsAttention
          ? 'border-red-500/40 bg-red-500/10'
          : 'border-sky-500/40 bg-sky-500/10'
      }`}
    >
      <span>
        自己修復：{selfhealLabel(selfheal.phase)}
        {selfheal.detail && (
          <span className="text-muted-foreground ml-2 text-xs">
            {selfheal.detail}
          </span>
        )}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="selfheal-banner-close"
        aria-label="閉じる"
        title="閉じる"
        onClick={clearSelfheal}
      >
        <CloseGlyph />
      </Button>
    </div>
  )
}

/**
 * 画面より新しいサーバが応答していることを知らせる（CICD設計§11）。
 *
 * 画面は実行ファイルへ焼き込まれるので、版を切り替えればサーバごと入れ替わる。
 * ところが開きっぱなしのタブは古い画面のまま喋り続け、**知らない知らせは黙って
 * 捨てられる**——壊れ方が「エラーが出る」ではなく「一部が黙って更新されなくなる」
 * になるので、気づける形にしておく。
 *
 * # 抱えているものが無ければ、自分で読み直す
 *
 * **かつては「勝手に読み込み直さない——書きかけの指示が消える」としていたが、その理由は
 * もう成り立たない。** 入力欄の書きかけは `lib/drafts.ts` が `localStorage` に置くので、
 * 読み直しても残る（十字ボタンの工事で入った）。フォルダの掘った位置もサイドバーの幅も
 * 同じく残る。**読み直して実際に消えるのは、添付した画像だけ**である。
 *
 * **「版を勝手に入れ替えない」と「タブを勝手に読み直さない」は別の話。** 前者は走っている
 * セッションが道連れになるので押すのは人のままだが、**読み直しはその決定の後始末**で
 * あって、新しい決定ではない（利用者の確認済み・2026-09-03）。
 *
 * したがって、抱えているものが無ければ読み直し、抱えているタブにだけバナーを出す。
 * 抱えているかは `lib/composerBusy.ts` が答える。
 *
 * **判定は「版が変わるたびに、その時点の状態で1度だけ」**（設計§17）。添付を1枚外した
 * 直後にページが飛ぶと、利用者から見れば「消したら壊れた」に見えるので、**添付の増減では
 * 走らせない**——バナーを出したなら、その版のあいだは押すまで待つ。
 *
 * **かつては「印が立った瞬間の1度だけ」だった。** 印は掛け金で降りないので、依存を
 * `[serverChanged]` だけにすると**そのタブの一生で1回しか試さない**——1回目が抱えていて
 * 塞がれたら、以後どれだけ版が変わっても二度と読み直さなかった。実機で不発だったのを
 * 追ってこれが分かり、依存へ `version` を足した。
 *
 * **見送ったときは、理由を画面に出す。** 抱えているのは**画面の外**でありうる（PJT 専用
 * 画面はセッション全数の入力欄を仮想化なしに描く）ので、書かないと「なぜ自動で読み直さ
 * ないのか」が利用者から永久に見えない。
 *
 * **輪にはならない。** 読み直すとページごと作り直され、ストアの初期値に `version` が
 * 無い（`undefined`）ので、`load()` の `known !== undefined` が偽になって印が立たない。
 * 「初回は立たない」がそのまま「読み直しは一度きり」になっているので、**読み直したことを
 * 覚える置き場所（`sessionStorage` 等）は要らない**。記憶を持つと「いつ消すか」を決める
 * ことになり、消し忘れれば**本当に新しくなったのに読み直さない**という逆の壊れ方を作る。
 *
 * **残る穴を1つ。** 印の立ち上がりと添付の追加が**同一の commit** に畳まれた場合、効果は
 * 木の順に走るのでこちらが先になり、台帳が空のまま読み直す。踏むには「画像を貼った瞬間と、
 * 入れ替え後の再接続の応答が同じバッチに乗る」ことが要る。失うのはその瞬間に貼った1枚
 * だけなので、塞ぐために効果を `<Routes>` の後ろへ移す案は採らない——**JSX の並びが仕様に
 * なり、テストで固定できない暗黙の依存を作る**ため。
 *
 * 自己修復と枠を分けてあるのは、あちらが単一スロットで、片方がもう片方を
 * 押し出してしまうため（設計§11）。
 */
function ServerChangedBanner() {
  const serverChanged = useAuthStore((state) => state.serverChanged)
  const version = useAuthStore((state) => state.auth.version)
  const 抱えている数 = composerBusyCount()

  // **早期 return より前に置く**（フックの規則）。
  //
  // **依存に `version` を足してあるのは、版が変わるたびに試し直すため**（設計§17）。
  // 印は掛け金で降りないので、`[serverChanged]` だけにすると**そのタブの一生で1回しか
  // 試さない**——1回目が抱えていて塞がれたら、以後どれだけ版が変わっても二度と読み直さない。
  //
  // **台帳は依然として依存に入れない。** 入れると「添付を外したら読み直す」になり、
  // 押していない瞬間に画面が飛ぶ（§6 で退けた形）。**版が変わったときだけ試し直す。**
  useEffect(() => {
    if (!serverChanged) {
      return
    }
    const 抱えている = composerBusyCount()
    if (抱えている > 0) {
      report(
        'version_reload',
        'INFO',
        `版が変わったが、読み直しを見送った：抱えている入力欄が ${抱えている} 件`,
      )
      return
    }
    // **積んでから読み直す。** `location.reload()` は `pagehide` を発火させ、
    // `installClientLogs` がそこで `sendBeacon` へ載せ替えるので、この1行は持ち出される
    report('version_reload', 'INFO', '版が変わったので、この画面を読み直す')
    // **一言出してから読み直す**（設計§18・利用者の指定 2026-09-05）。無言で画面が
    // 入れ替わると、押していない人には故障に見える。**承認は求めない**——待つのは
    // 読ませるためだけで、押さなくても読み直る
    const 時計 = setTimeout(() => window.location.reload(), 読み直すまでの間)
    return () => clearTimeout(時計)
  }, [serverChanged, version])

  if (!serverChanged) {
    return null
  }
  return (
    <div
      data-testid="server-changed-banner"
      className="flex items-center justify-between gap-4 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm"
    >
      <span>
        ダッシュボードの版が変わりました。
        <span className="text-muted-foreground ml-2 text-xs">
          {/*
            **読み直す側では「してください」と言わない。** 頼んでいないのに
            勝手に読み直すので、指示の形にすると嘘になる（§18）
          */}
          {抱えている数 > 0
            ? `添付があるため、自動では読み直しません（${抱えている数} 件）`
            : 'この画面を読み直します'}
        </span>
      </span>
      <Button size="sm" onClick={() => window.location.reload()}>
        読み込み直す
      </Button>
    </div>
  )
}

function HomePage() {
  const status = useWsStore((state) => state.status)

  return (
    /*
      **横のはみ出しを明示で殺す。** `overflow-y-auto` は片方しか書かないので、
      横は `auto` に計算される（CSS Overflow 3 §3.2）。回遊する線が1本でもはみ出すと
      横スクロールバーが生え、**バーが生えると可視領域が変わってタイルが再レイアウト
      され、次に測る矩形がずれる**——直った直後にまた狂う輪になる。
    */
    <div
      // **並べ替えの端で送る箱**（並べ替え設計§15-12）。`overflow-anchor: none` は、並びが
      // 変わるとスクロール固定が位置を動かして指の位置の計算と干渉するため
      data-scroll-box="home"
      className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto [overflow-anchor:none]"
    >
      {/*
        **場**（カード設計§9-7-5）。一覧の中身を包む in-flow のラッパで、
        **高さが中身の全高と一致する**。

        回遊する層をこの中へ置くと、(1) 線が中身と一緒にスクロールし、(2) 層の矩形が
        場の矩形と一致するので経路のクランプが `scrollHeight` を読まずに決まり、
        (3) 座標変換が矩形の引き算だけで済む（スクロール中に取得のタイミングが
        ずれる事故が消える）。

        **スクロールする入れ物の直下ではいけない。** あそこの絶対配置は
        **パディングボックス**に対して解決される＝層の高さが可視1画面ぶんになる。
      */}
      <div data-roam-field className="relative flex flex-col gap-4">
        <ProjectAdd disabled={status !== 'open'} />
        <TileGrid />
        {/*
          画面を回遊する効果線（カード設計§9-7）。**カードの中から出すと切られる**
          ので、場の直下に1枚だけ置く——カードの切る枠には `overflow` が掛かっている。

          場所を取らず（`absolute`）、線が1本も無ければ何も描かない。
        */}
        <RoamLayer />
      </div>
    </div>
  )
}

function GroupPage() {
  const { host, projectId } = useParams()
  // react-router が符号を戻してくれるので、そのまま作業ディレクトリの絶対パスになる。
  // **鍵に PC が入る**（設計§16）——パスだけでは別の PC の同名 PJT を指し分けられない
  const project = projectId ?? ''
  const projects = useProjects()
  /*
    タブの名前（タブ設計「書き手はページ層に置く」）。**帯と同じ関数で決める**ので、
    同名の PJT に付く番号までタブと画面で揃う。ここは URL に作業ディレクトリが
    入っているので、**開いた最初の瞬間から名乗れる**（番号だけは枠の一覧を待つ）。
  */
  useDocumentTitle(projectDisplayName(project, projects))
  return <GroupView host={host ?? LOCAL_HOST} project={project} />
}

function SessionPage() {
  const { cardId } = useParams()
  const session = useSessionCard(cardId ?? '')
  const projects = useProjects()
  /*
    **早期 return より前で呼ぶ**（フックの規則）。カードが届くまでは PJT が分からない
    ので何も渡さず、既定のまま待つ——**空にするとブラウザが URL を代わりに出す**ので、
    カードの ID がタブに並んでいまより読みにくくなる。
  */
  useDocumentTitle(session && projectDisplayName(session.project, projects))

  if (!session) {
    return (
      <NotFound message="このセッションは見つかりません（削除されたか、まだ届いていません）" />
    )
  }
  return <SessionView cardId={session.card_id} />
}

function NotFoundPage() {
  return <NotFound message="そのURLの画面はありません" />
}

function NotFound({ message }: { message: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3">
      <p data-testid="not-found" className="text-muted-foreground text-sm">
        {message}
      </p>
      <Link to={HOME} className="text-primary text-sm underline">
        一覧へ戻る
      </Link>
    </div>
  )
}

export default App
