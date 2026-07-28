/**
 * セッション専用画面（設計§10）。
 *
 * フェーズ2の時点で載っているのはターミナルビューだけ。`/rewind` のような TUI 内の
 * メニュー操作はここで行う。構造化ビュー（ネスト履歴）はフェーズ3、指示送信の
 * Composer はフェーズ4で足す。
 */

import { Button } from '@/components/ui/button'
import { TerminalPane } from '@/components/TerminalPane/TerminalPane'
import { formatElapsed } from '@/lib/time'
import { isEnded, statusLabel, statusTone } from '@/lib/protocol'
import type { SessionMeta } from '@/lib/protocol'
import { useWsStore } from '@/stores/ws'

interface Props {
  session: SessionMeta
  now: number
  /** 横並び表示（グループビュー）で使うときは幅を固定する */
  compact?: boolean
}

export function SessionView({ session, now, compact = false }: Props) {
  const kill = useWsStore((state) => state.kill)
  const archive = useWsStore((state) => state.archive)

  return (
    <section
      data-testid="session-view"
      data-card-id={session.card_id}
      data-status={session.status.kind}
      className={`flex min-h-0 flex-col gap-2 ${
        compact ? 'w-[42rem] shrink-0' : 'min-w-0 flex-1'
      }`}
    >
      <header className="flex items-center gap-2 text-sm">
        <span
          aria-hidden
          className={`size-2.5 shrink-0 rounded-full ${statusTone(session.status)}`}
        />
        <span className="truncate font-medium" title={session.project}>
          {session.project}
        </span>
        <span className="text-muted-foreground">
          {statusLabel(session.status)}
        </span>
        <span className="text-muted-foreground text-xs">
          最終活動 {formatElapsed(now - session.last_activity_at)}
        </span>

        <div className="ml-auto flex gap-2">
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
      </header>

      {/* カードごとに端末を作り直すため key を付ける */}
      <TerminalPane key={session.card_id} cardId={session.card_id} />
    </section>
  )
}
