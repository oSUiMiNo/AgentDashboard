/**
 * 一覧画面（司令塔ビュー）の本体（要件「一覧画面」／設計§10）。
 *
 * セッションをプロジェクト単位にまとめて並べる。同じフォルダで並列に走らせることが
 * 多いので、プロジェクトごとの箱にしておかないと、どれがどれの兄弟なのか分からなくなる。
 *
 * 購読するのは**構造だけ**（どの箱にどのカードが入るか）。状態の変化はここまで
 * 伝わってこないので、ツールコールのたびに一覧全体が作り直されることはない。
 * まとまりの組み立てと並びの安定は [`@/stores/sessions`] が持つ。
 */

import { ProjectGroup } from '@/components/ProjectGroup/ProjectGroup'
import { useProjectGroups } from '@/stores/sessions'

export function TileGrid() {
  const groups = useProjectGroups()

  if (groups.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        セッションはまだありません
      </p>
    )
  }

  return (
    <div data-testid="tile-grid" className="flex flex-col gap-4">
      {groups.map((group) => (
        <ProjectGroup
          key={group.project}
          project={group.project}
          cards={group.cards}
        />
      ))}
    </div>
  )
}
