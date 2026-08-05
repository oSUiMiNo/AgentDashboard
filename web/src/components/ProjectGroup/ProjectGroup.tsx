/**
 * 同じプロジェクト（PC ＋ 作業ディレクトリ）のまとまり（設計§10・§13）。
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
 * **セッションが0本でも余白は押せる**（イシューグループ_2026_0805_0514 §14）。
 * 枠だけを足した直後がその状態で、開いた先には「+」だけが出る。
 *
 * # 「×」が消すのは枠だけ
 *
 * カードでも履歴でもない（§13）。**セッションが1本でも居るあいだは押せない**——
 * 走っている作業を巻き添えにしないため。押せない理由は画面に出す。
 *
 * カードから逆算して出ている箱には「×」を出さない。消す対象を持たないので、
 * そちらはカードが全部無くなれば自然に消える。
 *
 * 破線の枠にしてあるのは、**枠の内側そのものが押せる**ことを見た目で示すため。
 */

import { AnimatePresence } from 'motion/react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { SessionAdd } from '@/components/SessionAdd/SessionAdd'
import { SessionTile } from '@/components/SessionTile/SessionTile'
import { Button } from '@/components/ui/button'
import type { CardId } from '@/lib/protocol'
import { projectPath } from '@/lib/routes'

interface Props {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  project: string
  /** 追加した枠の ID。カードから逆算した箱では省略される */
  projectId?: string
  /** この箱に入るカードID。中身は小窓が自分で購読する（設計§10） */
  cards: CardId[]
}

export function ProjectGroup({ host, project, projectId, cards }: Props) {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const busy = cards.length > 0

  const remove = async () => {
    if (projectId === undefined) {
      return
    }
    setError(null)
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        setError((await response.text()).trim() || '消せませんでした')
      }
      // 消えたことは `project_removed` で届く（**書けてから配られる**。設計§11）
    } catch {
      setError('消せませんでした')
    }
  }

  return (
    <section
      data-testid="project-group"
      data-project={project}
      data-host={host}
      onClick={() => navigate(projectPath(host, project))}
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
        {/* 起動の入口はここ（設計§13）。追加は「枠を置く」操作なので、
            危険度の判断が要るのは起こす瞬間だけになる */}
        <div className="ml-auto shrink-0" onClick={(event) => event.stopPropagation()}>
          <SessionAdd host={host} project={project} compact />
        </div>
        {projectId !== undefined && (
          <Button
            type="button"
            variant="ghost"
            data-testid="project-remove"
            disabled={busy}
            aria-label="この PJT を一覧から外す"
            title={
              busy
                ? 'セッションが動いているので外せません（先にセッションを終了してください）'
                : 'この PJT を一覧から外す（履歴は残ります）'
            }
            className="shrink-0 px-2 py-0.5 text-xs"
            onClick={(event) => {
              // 余白のクリック（＝画面を開く）と取り違えない
              event.stopPropagation()
              void remove()
            }}
          >
            ×
          </Button>
        )}
      </header>

      {error !== null && (
        <p
          data-testid="project-remove-error"
          className="mb-2 text-xs text-red-400"
        >
          {error}
        </p>
      )}

      {cards.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          セッションはまだありません。開いて「+」で起こせます。
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {/* 起動と削除が分かるように出入りだけ動かす（増減はめったに起きない） */}
          <AnimatePresence initial={false}>
            {cards.map((cardId) => (
              <SessionTile key={cardId} cardId={cardId} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </section>
  )
}
