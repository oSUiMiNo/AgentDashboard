/**
 * 一覧画面（司令塔ビュー）の本体（要件「一覧画面」／設計§10）。
 *
 * セッションをプロジェクト単位にまとめて並べる。同じフォルダで並列に走らせることが
 * 多いので、プロジェクトごとの箱にしておかないと、どれがどれの兄弟なのか分からなくなる。
 *
 * 並べ方の規則と経過時間の時計は [`@/lib/sessions`] にある。
 */

import { ProjectGroup } from '@/components/ProjectGroup/ProjectGroup'
import type { SessionMeta } from '@/lib/protocol'
import { groupByProject, useNow } from '@/lib/sessions'

interface Props {
  sessions: SessionMeta[]
}

export function TileGrid({ sessions }: Props) {
  const now = useNow()

  if (sessions.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        セッションはまだありません
      </p>
    )
  }

  return (
    <div data-testid="tile-grid" className="flex flex-col gap-4">
      {groupByProject(sessions).map((group) => (
        <ProjectGroup
          key={group.project}
          project={group.project}
          sessions={group.sessions}
          now={now}
        />
      ))}
    </div>
  )
}
