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
import { useCallback, useState, type ReactNode } from 'react'

import { ReorderHandle } from '@/components/ReorderHandle/ReorderHandle'
import { useReorder } from '@/lib/useReorder'
import { toggleSelect } from '@/stores/selection'
import { usePress } from '@/lib/usePress'
import { saveCardOrder } from '@/stores/sessions'
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
  /**
   * 掴み手（並べ替え設計§3-1）。**枠の `header` の左端**に置く——枠に効く操作は
   * 既にそこへ集まっている（「＋」「×」）。
   *
   * 作るのは並びを持っている側（`TileGrid`）。**この箱は自分が何番目かを知らない**ので、
   * ここで作ると並び全体を渡すことになる
   */
  handle?: ReactNode
  /** 落とし先を測るための `ref`。並びを持っている側が矩形を測る */
  rootRef?: (element: HTMLElement | null) => void
  /** いま浮かせているか。**掴んでいる本人だけ** */
  dragging?: boolean
}

export function ProjectGroup({
  host,
  project,
  projectId,
  cards,
  handle,
  rootRef,
  dragging = false,
}: Props) {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const busy = cards.length > 0
  /*
    **枠に効く押し分け。** 記録を持たない箱（カードから逆算したもの）は選べない
    ——まとめて削除の相手にならないので、選んでも何もできない
  */
  const 押し方 = usePress({
    kind: 'project',
    id: projectId ?? '',
    onOpen: () => navigate(projectPath(host, project)),
    // **コメントだけでは実装にならない。** 空文字の ID でも選べてしまっていた
    selectable: projectId !== undefined,
  })

  /*
    箱の中のカードの並べ替え（並べ替え設計§3）。**枠の中で閉じている**ので、
    送り先はこの枠（host ＋ path）だけ。枠をまたいだ移動はやらない
  */
  const 並びを送る = useCallback(
    async (next: readonly string[]) => {
      setError(await saveCardOrder(host, project, next))
    },
    [host, project],
  )
  // **名前を分ける。** この箱自身が浮いているか（`dragging` prop）と、箱の中で
  // どのカードが浮いているかは別物で、混ぜると片方が黙って消える
  const {
    order,
    dragging: 掴んでいるカード,
    bind,
    itemRef,
  } = useReorder<CardId>({
    ids: cards,
    onCommit: (next) => {
      void 並びを送る(next)
    },
  })

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
      ref={rootRef}
      data-testid="project-group"
      data-project={project}
      data-host={host}
      data-dragging={dragging ? 'true' : 'false'}
      /*
        **押し分けは1箇所で決める**（設計§4-1）。枠の余白も、カードと同じ規則で
        「選ぶ／開く」が入れ替わる
      */
      onClick={押し方.onClick}
      onDoubleClick={押し方.onDoubleClick}
      onPointerDown={押し方.onPointerDown}
      onPointerMove={押し方.onPointerMove}
      onPointerUp={押し方.onPointerUp}
      onPointerCancel={押し方.onPointerCancel}
      data-selected={押し方.selected ? 'true' : 'false'}
      // 端末の長押しメニューを抑える（設計§4-4）。素のスタイルで書く理由は SessionTile と同じ
      style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
      /*
        掴んでいる枠は流れから浮かせる（設計§3-5）。**影ではなく `transform` で作る**
        ——`DESIGN.md` §27.5 の4候補（1.02倍・1〜2°の傾き・影・落とし先の反応）は
        「物を掴んで運ぶ操作」のためのもので、こちらはまさにそれに当たる
      */
      className={`border-border hover:border-primary/40 hover:bg-muted/20 cursor-pointer rounded-xl border border-dashed p-3 transition-colors ${
        dragging ? 'relative z-10 scale-[1.02] rotate-[1deg] opacity-90' : ''
      }`}
    >
      <header className="mb-2 flex items-baseline gap-2">
        {handle !== undefined && (
          // 余白のクリック（＝画面を開く）と取り違えない
          <div className="shrink-0 self-center" onClick={(event) => event.stopPropagation()}>
            {handle}
          </div>
        )}
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
            {order.map((cardId) => (
              <SessionTile
                key={cardId}
                cardId={cardId}
                handle={
                  <ReorderHandle
                    kind="card"
                    label="このセッションを掴んで並べ替える"
                    {...bind(cardId)}
                    // 掴まずに離したら選ぶ（設計§4-4 の保険）
                    onTap={() => toggleSelect('card', cardId)}
                  />
                }
                rootRef={itemRef(cardId)}
                dragging={掴んでいるカード === cardId}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </section>
  )
}
