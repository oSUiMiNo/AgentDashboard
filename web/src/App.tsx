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
import { AccountPage } from '@/components/Account/AccountPage'
import { AuthGate } from '@/components/Auth/AuthGate'
import { GroupView } from '@/components/GroupView/GroupView'
import { SessionView } from '@/components/SessionView/SessionView'
import { SettingsPage } from '@/components/Settings/SettingsPage'
import { TileGrid } from '@/components/TileGrid/TileGrid'
import { ProjectAdd } from '@/components/ProjectAdd/ProjectAdd'
import { RoamLayer } from '@/components/RoamLayer/RoamLayer'
import { anyComposerBusy } from '@/lib/composerBusy'
import { selfhealLabel } from '@/lib/protocol'
import { ACCOUNT, HOME, LOCAL_HOST, SETTINGS } from '@/lib/routes'
import { canEnter, useAuthStore } from '@/stores/auth'
import { useSessionCard } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

const CONNECTION_LABEL: Record<string, string> = {
  connecting: '接続中…',
  open: '接続済み',
  closed: '切断',
}

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
              className="text-muted-foreground text-sm"
            >
              {CONNECTION_LABEL[status]}
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
              <Link
                to={SETTINGS}
                data-testid="settings-link"
                className="text-muted-foreground hover:text-foreground text-sm underline"
              >
                設定
              </Link>
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
          <Button variant="ghost" size="sm" onClick={clearError}>
            閉じる
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
      <Button variant="ghost" size="sm" onClick={clearSelfheal}>
        閉じる
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
 * **判定は印が立った瞬間の1度だけで、あとから読み直さない。** 添付を1枚外した直後に
 * ページが飛ぶと、利用者から見れば「消したら壊れた」に見える。バナーを出したなら、
 * 押すまで待つ。
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

  // **早期 return より前に置く**（フックの規則）。依存は `serverChanged` だけにする
  // ——台帳を依存に入れると「添付を外したら読み直す」が1行で書けてしまい、上で退けた形に
  // なる。`[]` では印があとから立つので一度も反応しない
  useEffect(() => {
    if (!serverChanged || anyComposerBusy()) {
      return
    }
    window.location.reload()
  }, [serverChanged])

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
          この画面は古いままなので、読み込み直してください
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
  return <GroupView host={host ?? LOCAL_HOST} project={projectId ?? ''} />
}

function SessionPage() {
  const { cardId } = useParams()
  const session = useSessionCard(cardId ?? '')

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
