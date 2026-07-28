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

import { useEffect } from 'react'
import { BrowserRouter, Link, Route, Routes, useParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { GroupView } from '@/components/GroupView/GroupView'
import { SessionView } from '@/components/SessionView/SessionView'
import { TileGrid } from '@/components/TileGrid/TileGrid'
import { SpawnForm } from '@/components/SpawnForm/SpawnForm'
import { HOME } from '@/lib/routes'
import { useSessionCard } from '@/stores/sessions'
import { useWsStore } from '@/stores/ws'

const CONNECTION_LABEL: Record<string, string> = {
  connecting: '接続中…',
  open: '接続済み',
  closed: '切断',
}

function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  )
}

function Shell() {
  const status = useWsStore((state) => state.status)
  const lastError = useWsStore((state) => state.lastError)
  const connect = useWsStore((state) => state.connect)
  const clearError = useWsStore((state) => state.clearError)

  useEffect(() => {
    void connect()
  }, [connect])

  return (
    <main className="flex h-svh flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <Link to={HOME} className="text-xl font-semibold tracking-tight">
          <h1>AgentDashboard</h1>
        </Link>
        <span
          data-testid="connection-status"
          data-status={status}
          className="text-muted-foreground text-sm"
        >
          {CONNECTION_LABEL[status]}
        </span>
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

      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/p/:projectId" element={<GroupPage />} />
        <Route path="/s/:cardId" element={<SessionPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </main>
  )
}

function HomePage() {
  const status = useWsStore((state) => state.status)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <SpawnForm disabled={status !== 'open'} />
      <TileGrid />
    </div>
  )
}

function GroupPage() {
  const { projectId } = useParams()
  // react-router が符号を戻してくれるので、そのまま作業ディレクトリの絶対パスになる
  return <GroupView project={projectId ?? ''} />
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
