/**
 * プロジェクト内の全セッションを横並びにする画面（設計§10）。
 *
 * 兄弟セッションを見比べるための画面。**レイアウトの作り込みはフェーズ4**（計画）なので、
 * ここでは「どのセッションが対象になるか」が分かるところまでを出す。ルーティングと
 * クリックの作り分けはフェーズ2の担当なので、遷移先として先に用意しておく。
 */

import { Link } from 'react-router'
import type { SessionMeta } from '@/lib/protocol'
import { statusLabel, statusTone } from '@/lib/protocol'
import { HOME, sessionPath } from '@/lib/routes'

interface Props {
  project: string
  sessions: SessionMeta[]
}

export function GroupView({ project, sessions }: Props) {
  return (
    <section
      data-testid="group-view"
      data-project={project}
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      <header className="flex items-baseline gap-3">
        <h2 className="truncate text-sm font-semibold" title={project}>
          {project}
        </h2>
        <span className="text-muted-foreground text-xs">
          {sessions.length}セッション
        </span>
        <Link to={HOME} className="text-primary ml-auto text-xs underline">
          一覧へ戻る
        </Link>
      </header>

      {sessions.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          このプロジェクトのセッションはありません
        </p>
      ) : (
        <ul className="flex flex-wrap gap-3">
          {sessions.map((session) => (
            <li key={session.card_id}>
              <Link
                to={sessionPath(session.card_id)}
                data-testid="group-member"
                data-card-id={session.card_id}
                className="border-input hover:border-primary/60 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
              >
                <span
                  aria-hidden
                  className={`size-2.5 rounded-full ${statusTone(session.status)}`}
                />
                {statusLabel(session.status)}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="text-muted-foreground text-xs">
        全セッションを横並びで表示する画面はフェーズ4で作ります。
      </p>
    </section>
  )
}
