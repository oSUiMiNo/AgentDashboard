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
 *
 * 購読するのは**この箱に入るカードIDの並び**だけ。中身は [`SessionView`] が自分で
 * 購読するので、1本の状態が変わっても隣が作り直されない。
 */

import { Link } from 'react-router'
import { SessionView } from '@/components/SessionView/SessionView'
import { HOME } from '@/lib/routes'
import { useProjectCards } from '@/stores/sessions'

interface Props {
  /** `agent_id` かローカルを表す `'local'`（設計§16） */
  host: string
  project: string
}

export function GroupView({ host, project }: Props) {
  const cards = useProjectCards(host, project)

  return (
    <section
      data-testid="group-view"
      data-project={project}
      data-host={host}
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      <header className="flex items-baseline gap-3">
        <h2 className="min-w-0 truncate text-sm font-semibold" title={project}>
          {project}
        </h2>
        <span className="text-muted-foreground shrink-0 text-xs">
          {cards.length}セッション
        </span>
        <Link
          to={HOME}
          className="text-primary ml-auto shrink-0 text-xs underline"
        >
          一覧へ戻る
        </Link>
      </header>

      {cards.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          このプロジェクトのセッションはありません
        </p>
      ) : (
        <div
          data-testid="group-rail"
          className="flex min-h-0 flex-1 gap-4 overflow-x-auto pb-2"
        >
          {cards.map((cardId) => (
            <SessionView key={cardId} cardId={cardId} compact />
          ))}
        </div>
      )}
    </section>
  )
}
