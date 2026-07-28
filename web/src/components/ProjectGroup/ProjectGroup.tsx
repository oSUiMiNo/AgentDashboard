/**
 * 同じプロジェクト（作業ディレクトリ）で走っているセッションのまとまり（設計§10）。
 *
 * # 余白と小窓でクリックの意味を変える
 *
 * - **グループの余白** をクリック → そのプロジェクトの全セッションを横並びで開く
 * - **小窓** をクリック → そのセッション1つだけを開く
 *
 * 同じ場所に2つの意味を持たせているので、小窓側は `stopPropagation` で親へ伝えない
 * （[`SessionTile`]）。兄弟セッションを見比べたいときと、1本に集中したいときの
 * 使い分けが、追加のボタン無しで成立する。
 */

import { useNavigate } from 'react-router'
import { SessionTile } from '@/components/SessionTile/SessionTile'
import type { SessionMeta } from '@/lib/protocol'
import { projectPath } from '@/lib/routes'

interface Props {
  project: string
  sessions: SessionMeta[]
  now: number
}

export function ProjectGroup({ project, sessions, now }: Props) {
  const navigate = useNavigate()

  return (
    <section
      data-testid="project-group"
      data-project={project}
      onClick={() => navigate(projectPath(project))}
      className="border-input hover:border-primary/40 cursor-pointer rounded-xl border border-dashed p-3 transition-colors"
    >
      <header className="mb-2 flex items-baseline gap-2">
        <h2 className="truncate text-sm font-semibold" title={project}>
          {project}
        </h2>
        <span className="text-muted-foreground text-xs">
          {sessions.length}セッション
        </span>
      </header>

      <div className="flex flex-wrap gap-3">
        {sessions.map((session) => (
          <SessionTile key={session.card_id} session={session} now={now} />
        ))}
      </div>
    </section>
  )
}
