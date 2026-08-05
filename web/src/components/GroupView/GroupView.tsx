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
 *
 * # 左にファイル（イシューグループ_2026_0805_0514 設計§14）
 *
 * 左上のハンバーガーで [`ProjectFiles`] を開閉する。**セッション専用画面にも
 * 同じものが出る**（設計§28）——同じ部品・同じ経路で、開閉の記憶も共有する
 * （[`@/lib/filesPanel`]）。
 *
 * この画面だからこそ、**左でパスをコピーして右のセッションの入力欄へ貼る**が1画面で
 * 完結する。配置を選んだ理由そのものなので、右側の横並びには手を入れていない。
 */

import { Link } from 'react-router'
import { ProjectFiles } from '@/components/ProjectFiles/ProjectFiles'
import { SessionAdd } from '@/components/SessionAdd/SessionAdd'
import { SessionView } from '@/components/SessionView/SessionView'
import { Button } from '@/components/ui/button'
import { useFilesPanel } from '@/lib/filesPanel'
import { HOME } from '@/lib/routes'
import { useProjectCards } from '@/stores/sessions'

interface Props {
  /** `agent_id` かローカルを表す `'local'`（設計§16） */
  host: string
  project: string
}

/**
 * 左パネルを開いているか、の置き場所。
 *
 * **ブラウザ側に持つ**（設計§14）。サーバへ置くと他の端末の開閉まで揃ってしまい、
 * 手元では畳んでおきたいのにスマホで開いた状態が飛んでくる、ということが起きる。
 *
 * 枠ごとではなく**1つ**にしてあるのは、これが「ファイルを見ながら作業する人かどうか」
 * という利用者の癖に属するため。枠ごとに覚えると、新しい枠を開くたびに押し直しになる。
 */
export function GroupView({ host, project }: Props) {
  const cards = useProjectCards(host, project)
  const [filesOpen, toggleFiles] = useFilesPanel()

  return (
    <section
      data-testid="group-view"
      data-project={project}
      data-host={host}
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      <header className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="project-files-toggle"
          aria-expanded={filesOpen}
          aria-label="ファイル"
          title="ファイル"
          className="shrink-0"
          onClick={toggleFiles}
        >
          <span aria-hidden>☰</span>
        </Button>

        <h2 className="min-w-0 truncate text-sm font-semibold" title={project}>
          {project}
        </h2>
        <span className="text-muted-foreground shrink-0 text-xs">
          {cards.length}セッション
        </span>

        {/* 0本の枠でも起こせる必要がある（設計§14）。押す前に権限モードを選ぶ形は
            一覧の枠と同じ部品なので、危険度の見え方も揃う */}
        <div className="ml-auto shrink-0">
          <SessionAdd host={host} project={project} compact />
        </div>
        <Link to={HOME} className="text-primary shrink-0 text-xs underline">
          一覧へ戻る
        </Link>
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        {filesOpen && (
          /*
            広い画面では左に常設し、狭い画面では**全幅のドロワー**として被せる
            （設計§14）。並べると両方が狭くなり、どちらも読めない。
          */
          <aside
            data-testid="project-files-panel"
            className="bg-background border-border fixed inset-0 z-40 flex min-h-0 flex-col gap-2 border-r p-3 md:static md:z-auto md:w-80 md:shrink-0 md:p-0 md:pr-3"
          >
            <div className="flex items-center gap-2 md:hidden">
              <span className="text-sm font-semibold">ファイル</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="project-files-close"
                className="ml-auto"
                onClick={toggleFiles}
              >
                閉じる
              </Button>
            </div>
            <ProjectFiles host={host} project={project} />
          </aside>
        )}

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
      </div>
    </section>
  )
}
