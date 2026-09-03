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
import { useCallback, useState } from 'react'

import { useReorder, type Bound } from '@/lib/useReorder'
import { useGrip } from '@/lib/useGrip'
import { 重ねる } from '@/lib/handlers'
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
   * 並べ替えの3つの合図（並べ替え設計§3・読み替え4）。
   *
   * **掴み手は出さない。枠の本体（余白・見出し）をそのまま掴む**（利用者の指定・
   * 2026-09-03）。渡ってこなければ掴めない（記録を持たない箱）。
   *
   * 作るのは並びを持っている側（`TileGrid`）。**この箱は自分が何番目かを知らない**ので、
   * ここで作ると並び全体を渡すことになる
   */
  grab?: Bound
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
  grab,
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
  /*
    **枠の本体をそのまま掴む**（読み替え4）。押し分け（`usePress`）と同じ `pointerdown` を
    見るが、**取り合わない**——マウスは押した瞬間には掴まず 3px で、指は長押しが
    成立するまで掴まない。長押しの計測（8px で捨てる）より先に掴むことがない。
  */
  const 掴み = useGrip({
    enabled: grab !== undefined,
    when: (event) => (event.pointerType === 'mouse' ? 'move' : 'hold'),
    onGrab: () => grab?.onGrab(),
    onMove: (point) => grab?.onMove(point),
    onDrop: () => grab?.onDrop(),
  })
  const 押し方 = usePress({
    kind: 'project',
    id: projectId ?? '',
    // 長押しで選んだら、**そのまま掴めるようにする**
    onLongPress: 掴み.arm,
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
      /*
        **押し分けと掴みを重ねる**（`lib/handlers.ts`）。順番は「先に押し分け、次に掴み」
        ——長押しの計測を張ってから掴みの記録を作る。
      */
      onPointerDown={重ねる(押し方.onPointerDown, 掴み.handlers.onPointerDown)}
      onPointerMove={重ねる(押し方.onPointerMove, 掴み.handlers.onPointerMove)}
      onPointerUp={重ねる(押し方.onPointerUp, 掴み.handlers.onPointerUp)}
      onPointerCancel={重ねる(押し方.onPointerCancel, 掴み.handlers.onPointerCancel)}
      onLostPointerCapture={掴み.handlers.onLostPointerCapture}
      // **運んだ直後の `click` を捨てる。** 捨てないと並べ替えるたびに選択が入れ替わる
      onClickCapture={掴み.handlers.onClickCapture}
      data-selected={押し方.selected ? 'true' : 'false'}
      // 端末の長押しメニューを抑える（設計§4-4）。素のスタイルで書く理由は SessionTile と同じ
      style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
      /*
        掴んでいる枠は流れから浮かせる（設計§3-5）。**影ではなく `transform` で作る**
        ——`DESIGN.md` §27.5 の4候補（1.02倍・1〜2°の傾き・影・落とし先の反応）は
        「物を掴んで運ぶ操作」のためのもので、こちらはまさにそれに当たる。

        # 選ばれた枠（§27.3・利用者の指摘 2026-09-03）

        枠は**状態の色を1つも持たない**ので、カードより自由に使える。§27.3 の候補から
        **3つ**当てる——**背景 Tint**・**左側の Accent**（左端 3px の帯）・**枠線の色**。
        §27.3 が避けている「単なる 1px Border だけ」には当たらない。

        **選択と Hover を同じ class 属性に両方置いてはいけない。** Tailwind では
        `hover:bg-muted/20`（詳細度 0,2,0）が `bg-select-field`（0,1,0）に**必ず勝つ**ので、
        **選ばれた枠にマウスを乗せた瞬間に選択の色が消える**。三項で排他にすれば、
        選ばれているときは選択用の Hover（一段だけ上げる）だけが残る。

        **`tile.css` 側へ書かないこと。** あちらはレイヤ外なので Hover に無条件で勝ち、
        **選ばれた枠では Hover が一切効かなくなる**。枠の色は className が全部持つ。

        **破線は外さない。** 破線は「枠の内側そのものが押せる」ことを示しているので、
        選んだからといって押せなくなるわけではない。線種は変えず**色だけ**変える。

        **Pressed は作らない**（§35.1）。`:active` は**押した要素の先祖にも当たる**ので、
        `active:` を足すと**中のカードを押すたびに枠ごと縮む**。§8 の床「反応3つ」は
        画面単位で数えるもので、この画面では小窓が4つとも持っている。

        `transition-colors` から広げているのは、**左端の帯（`box-shadow`）が瞬間で出ると、
        色だけがなめらかに変わって帯だけ飛び出す**ため。
      */
      className={`cursor-pointer rounded-xl border border-dashed p-3 transition-[color,background-color,border-color,box-shadow] ${
        押し方.selected
          ? 'border-select bg-select-field hover:bg-select-field-hover shadow-[inset_3px_0_0_var(--select)]'
          : 'border-border hover:border-primary/40 hover:bg-muted/20'
      } ${dragging ? 'relative z-10 scale-[1.02] rotate-[1deg] opacity-90' : ''}`}
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
        {/* **押しても掴まない。** `click` を止めるだけでは `pointerdown` が素通りする */}
        <div
          className="ml-auto shrink-0"
          data-no-grab=""
          onClick={(event) => event.stopPropagation()}
        >
          <SessionAdd host={host} project={project} compact />
        </div>
        {projectId !== undefined && (
          <Button
            type="button"
            variant="ghost"
            data-testid="project-remove"
            data-no-grab=""
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
                grab={bind(cardId)}
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
