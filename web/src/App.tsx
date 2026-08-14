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
    <main className="flex h-svh flex-col gap-4 p-6">
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
 * **勝手に読み込み直さない。** 入力欄に書きかけの指示があると消える。
 *
 * 自己修復と枠を分けてあるのは、あちらが単一スロットで、片方がもう片方を
 * 押し出してしまうため（設計§11）。
 */
function ServerChangedBanner() {
  const serverChanged = useAuthStore((state) => state.serverChanged)

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
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <ProjectAdd disabled={status !== 'open'} />
      <TileGrid />
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
