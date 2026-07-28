/**
 * プロジェクト内の全セッションを横並びにする画面（要件「グループの余白クリック」／設計§10）。
 *
 * 同じフォルダで並列に走らせた兄弟セッションを**見比べる**ための画面。1本ずつ開いて
 * 行き来すると、どちらが先に進んでいるのかが分からなくなる。
 *
 * # 表示数に上限を設けない
 *
 * 設計§13 が「最大表示数・レイアウトはフェーズ4で決める」としていた点。**上限は設けず、
 * 全件を横スクロールで並べる**ことにした。個人ツールで、同じフォルダの並列は多くて
 * 数本という前提のため。上限を設けると「見比べたい相手が切り捨てられる」という、
 * この画面の存在意義そのものを損なう失敗が起きうる。
 *
 * # 兄弟は既定でターミナル
 *
 * 並べたときに知りたいのは「いま何が起きているか」なので、[`SessionView`] の
 * `compact` はターミナルから始まる（その判断はコンポーネント側にある）。
 */

import { Link } from 'react-router'
import { SessionView } from '@/components/SessionView/SessionView'
import type { SessionMeta } from '@/lib/protocol'
import { HOME } from '@/lib/routes'
import { useNow } from '@/lib/sessions'

interface Props {
  project: string
  sessions: SessionMeta[]
}

export function GroupView({ project, sessions }: Props) {
  // 経過時間の時計は親が1つだけ持つ。セッションごとに持たせると数だけタイマーが増える
  const now = useNow()

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
        <div
          data-testid="group-rail"
          className="flex min-h-0 flex-1 gap-4 overflow-x-auto pb-2"
        >
          {sessions.map((session) => (
            <SessionView
              key={session.card_id}
              session={session}
              now={now}
              compact
            />
          ))}
        </div>
      )}
    </section>
  )
}
