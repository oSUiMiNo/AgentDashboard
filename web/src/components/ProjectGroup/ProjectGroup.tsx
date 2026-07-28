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
 *
 * 破線の枠にしてあるのは、**枠の内側そのものが押せる**ことを見た目で示すため。
 */

import { AnimatePresence } from 'motion/react'
import { useNavigate } from 'react-router'
import { SessionTile } from '@/components/SessionTile/SessionTile'
import type { CardId } from '@/lib/protocol'
import { projectPath } from '@/lib/routes'

interface Props {
  project: string
  /** この箱に入るカードID。中身は小窓が自分で購読する（設計§10） */
  cards: CardId[]
}

export function ProjectGroup({ project, cards }: Props) {
  const navigate = useNavigate()

  return (
    <section
      data-testid="project-group"
      data-project={project}
      onClick={() => navigate(projectPath(project))}
      className="border-border hover:border-primary/40 hover:bg-muted/20 cursor-pointer rounded-xl border border-dashed p-3 transition-colors"
    >
      <header className="mb-2 flex items-baseline gap-2">
        {/* 縮んでよいのはパスだけ。`min-w-0` が無いと `truncate` が効かず、
            隣のセッション数が縦に割れる */}
        <h2 className="min-w-0 truncate text-sm font-semibold" title={project}>
          {project}
        </h2>
        <span className="text-muted-foreground shrink-0 text-xs">
          {cards.length}セッション
        </span>
      </header>

      <div className="flex flex-wrap gap-3">
        {/* 起動と削除が分かるように出入りだけ動かす（増減はめったに起きない） */}
        <AnimatePresence initial={false}>
          {cards.map((cardId) => (
            <SessionTile key={cardId} cardId={cardId} />
          ))}
        </AnimatePresence>
      </div>
    </section>
  )
}
