/**
 * フェーズ1（M1: 動くターミナル）の最小ダッシュボード。
 *
 * セッションを起動し、ブラウザのターミナルから操作できることを確かめるための画面。
 * 一覧を小窓（タイル）で並べる本来の司令塔ビューはフェーズ2、グループの横並びと
 * 見た目のリッチ化はフェーズ4で作る。ここでは経路が通っていることを優先している。
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TerminalPane } from '@/components/TerminalPane/TerminalPane'
import { isEnded, statusLabel } from '@/lib/protocol'
import type { CardId, SessionMeta } from '@/lib/protocol'
import { useWsStore } from '@/stores/ws'

const CONNECTION_LABEL: Record<string, string> = {
  connecting: '接続中…',
  open: '接続済み',
  closed: '切断',
}

function App() {
  const status = useWsStore((state) => state.status)
  const sessions = useWsStore((state) => state.sessions)
  const lastError = useWsStore((state) => state.lastError)
  const connect = useWsStore((state) => state.connect)
  const clearError = useWsStore((state) => state.clearError)

  const [cwd, setCwd] = useState('')
  const [selected, setSelected] = useState<CardId | null>(null)

  useEffect(() => {
    connect()
  }, [connect])

  // 消えたカードを選んだままにしない
  useEffect(() => {
    if (selected && !sessions.some((session) => session.card_id === selected)) {
      setSelected(null)
    }
  }, [sessions, selected])

  const current = sessions.find((session) => session.card_id === selected) ?? null

  return (
    <main className="flex h-svh flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">AgentDashboard</h1>
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

      <SpawnForm cwd={cwd} onChangeCwd={setCwd} disabled={status !== 'open'} />

      <div className="flex min-h-0 flex-1 gap-4">
        <SessionList
          sessions={sessions}
          selected={selected}
          onSelect={setSelected}
        />
        <section className="flex min-h-0 flex-1 flex-col gap-2">
          {current ? (
            <>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{current.project}</span>
                <span className="text-muted-foreground">
                  {statusLabel(current.status)}
                </span>
              </div>
              {/* カードごとに端末を作り直すため key を付ける */}
              <TerminalPane key={current.card_id} cardId={current.card_id} />
            </>
          ) : (
            <p className="text-muted-foreground m-auto text-sm">
              セッションを選ぶとターミナルが開きます
            </p>
          )}
        </section>
      </div>
    </main>
  )
}

function SpawnForm({
  cwd,
  onChangeCwd,
  disabled,
}: {
  cwd: string
  onChangeCwd: (value: string) => void
  disabled: boolean
}) {
  const spawn = useWsStore((state) => state.spawn)

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const trimmed = cwd.trim()
        if (trimmed) {
          spawn(trimmed)
        }
      }}
    >
      <input
        data-testid="cwd-input"
        aria-label="作業ディレクトリ"
        placeholder="/home/example/dev/プロジェクト"
        value={cwd}
        onChange={(event) => onChangeCwd(event.target.value)}
        className="border-input bg-background focus-visible:ring-ring flex-1 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
      />
      <Button type="submit" disabled={disabled || cwd.trim() === ''}>
        セッションを起動
      </Button>
    </form>
  )
}

function SessionList({
  sessions,
  selected,
  onSelect,
}: {
  sessions: SessionMeta[]
  selected: CardId | null
  onSelect: (cardId: CardId) => void
}) {
  const kill = useWsStore((state) => state.kill)
  const archive = useWsStore((state) => state.archive)

  if (sessions.length === 0) {
    return (
      <aside className="w-72 shrink-0">
        <p className="text-muted-foreground text-sm">
          セッションはまだありません
        </p>
      </aside>
    )
  }

  return (
    <aside
      data-testid="session-list"
      className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto"
    >
      {sessions.map((session) => (
        <div
          key={session.card_id}
          data-testid="session-card"
          data-card-id={session.card_id}
          data-status={session.status.kind}
          className={`rounded-md border p-3 text-sm ${
            session.card_id === selected ? 'border-primary' : 'border-input'
          }`}
        >
          <button
            type="button"
            className="w-full text-left"
            onClick={() => onSelect(session.card_id)}
          >
            <span className="block truncate font-medium">
              {session.project}
            </span>
            <span className="text-muted-foreground block">
              {statusLabel(session.status)}
            </span>
          </button>
          <div className="mt-2 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={isEnded(session.status)}
              onClick={() => kill(session.card_id)}
            >
              終了
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => archive(session.card_id)}
            >
              削除
            </Button>
          </div>
        </div>
      ))}
    </aside>
  )
}

export default App
