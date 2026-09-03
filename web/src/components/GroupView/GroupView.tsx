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
 * # 左にファイル（イシューグループ_2026-0826-1146 設計§2・§3）
 *
 * 左上の切り替えボタンで [`useFilesParts`] の区画を開閉する。**セッション専用画面にも同じものが
 * 出る**——`<aside>` を2箇所に写していた形は終わりにしたので、片方だけ直る状態が
 * 構造的に作れない。開閉の記憶は [`@/lib/filesPanel`] が持つ。
 *
 * **場所を取り合う列は2つだけ**（設計§2）——中身の列とレール。フォルダはその上に
 * 一時的に乗るだけで、取り合いに参加しない。
 *
 * この画面だからこそ、**左でパスをコピーして右のセッションの入力欄へ貼る**が1画面で
 * 完結する。配置を選んだ理由そのものなので、右側の横並びには手を入れていない。
 */

import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { FilesToggle } from '@/components/ProjectFiles/FilesToggle'
import { useFilesParts } from '@/components/ProjectFiles/useFilesParts'
import { SessionAdd } from '@/components/SessionAdd/SessionAdd'
import { ReorderHandle } from '@/components/ReorderHandle/ReorderHandle'
import { SessionView } from '@/components/SessionView/SessionView'
import { useFilesPanel } from '@/lib/filesPanel'
import { projectDisplayName } from '@/lib/path'
import { backTargetFor, HOME } from '@/lib/routes'
import { saveCardOrder, useProjectCards } from '@/stores/sessions'
import { useReorder } from '@/lib/useReorder'
import { toggleSelect } from '@/stores/selection'
import { useProjects } from '@/stores/projects'

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
  const [orderError, setOrderError] = useState<string | null>(null)
  /*
    区画の並べ替え（並べ替え設計§3・読み替え1）。**ホームのカードと同じ並び**を
    動かしている——正が1本なので、こちらで動かせばあちらにも出る
  */
  const { order, dragging, bind, itemRef, reordering } = useReorder<string>({
    ids: cards,
    onCommit: (next) => {
      void saveCardOrder(host, project, next).then(setOrderError)
    },
  })
  const [filesOpen, toggleFiles] = useFilesPanel()
  const projects = useProjects()
  const navigate = useNavigate()
  const location = useLocation()
  /*
    **セッション専用画面と同じ関数で出す**（設計§16-2）。同じ規則で同じ番号が付く
    ことが「揃える」の中身で、**別々に実装すると、同じ PJT が画面によって違う名前で出る**。
  */
  const 名前 = projectDisplayName(project, projects)
  /*
    **置き場所はこちらが決める**（`useFilesParts`）。サイドバーはレールの外、
    中身の列はレールの中のいちばん左。**横ホイールの受け渡しは要らなくなった**
    ——列がレールの中に居れば、ブラウザのスクロール連鎖がそのまま届く
  */
  const { sidebar, column } = useFilesParts({
    host,
    project,
    open: filesOpen,
    onToggle: toggleFiles,
  })

  return (
    <section
      data-testid="group-view"
      data-project={project}
      data-host={host}
      className="flex min-h-0 flex-1 flex-col gap-1 md:gap-2"
    >
      {/*
        **セッション専用画面の1行目と同じ骨格にする**（設計§16-1）。

        | 位置 | 置くもの |
        |---|---|
        | 左端 | サイドバーの開閉 |
        | その右 | **PJT の名前**（どちらも `projectDisplayName`） |
        | 続けて | **その画面に効く操作**（ここでは `+`） |
        | `ml-auto` の右端 | **✕**（画面を閉じる） |

        **右端が「画面に効く」場所**なのは §15-2 で決めた分け方。`+` は**その PJT に
        効く**ので、名前の隣に置く——何に対する操作かが位置で分かる。
      */}
      <header className="flex items-center gap-2">
        <FilesToggle open={filesOpen} onToggle={toggleFiles} />

        {/* **画面の主題**なので見出しのまま。フルパスは `title` に残す（設計§16-2） */}
        <h2 className="min-w-0 truncate text-sm font-semibold" title={project}>
          {名前}
        </h2>

        {/* 0本の枠でも起こせる必要がある（設計§14）。押す前に権限モードを選ぶ形は
            一覧の枠と同じ部品なので、危険度の見え方も揃う */}
        <div className="shrink-0">
          <SessionAdd host={host} project={project} compact />
        </div>

        <span className="text-muted-foreground shrink-0 text-xs">
          {cards.length}セッション
        </span>

        {/*
          **「一覧へ戻る」をやめて ✕ にする**（設計§16-3）。振る舞いはセッション
          専用画面と同じ——開いた画面なので「戻る」でよく、**いきなり `/p/...` を
          開いたときだけ一覧へ落とす**。

          **目印は `close-session` と別にする。** 同じにすると、テストが
          どちらの画面の ✕ を掴んでいるのか読めなくなる。
        */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="close-group"
          aria-label="閉じる"
          title="閉じる"
          className="ml-auto shrink-0"
          onClick={() => {
            // **三項演算子で1つにまとめない**（`navigate` の2つのオーバーロードに
            // `string | number` は当たらず、`tsc -b` で落ちる。§7 で踏んでいる）
            if (backTargetFor(location.key) === 'back') {
              navigate(-1)
              return
            }
            navigate(HOME)
          }}
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </Button>
      </header>

      {/*
        取り合いの器。**`relative` を足す**——サイドバーは広い画面で
        `absolute` になり、この箱の左端と高さを基準にする（設計§2）。`fixed` のままだと
        画面の上端から被さり、アプリのヘッダ（設定・アカウント）まで覆う
      */}
      <div className="relative flex min-h-0 flex-1 gap-4">
        {/* **レールの外。** 一緒に流れると、横へ動かしたとき左のものが消える */}
        {sidebar}

        {/*
          **レールは、セッションが0本でも描く**（2026-08-27）。以前は0本のとき
          レールごと描いていなかったが、**中身の列をこの中へ入れた**ので、そのままだと
          **セッションが0本の PJT でファイルを開いても何も出なくなる**。条件を足すより、
          「ありません」の1行をここへ入れて**分岐を消す**ほうが穴が無い。

          **`min-w-0` を足す。** `overflow-x-auto` を持つ箱では flex の
          `min-width: auto` が仕様上すでに 0 に解決されているので、**見た目は
          1ピクセルも変わらない**。足すのは、あとで `overflow` を変えた誰かが
          ページを横へ広げるのを防ぐ字としての保険（設計§7）
        */}
        <div
          data-testid="group-rail"
          className="flex min-h-0 min-w-0 flex-1 gap-4 overflow-x-auto pb-2"
        >
          {/*
            **いちばん左。セッションの札と同じ扱い**（設計§8 の 2026-08-27 の変更）。
            横へ流すと札と一緒に流れる——**流しても見えたままだった利点は、意図して
            捨てた**（利用者の判断）。不具合ではない
          */}
          {column}

          {orderError !== null && (
            <p
              data-testid="card-order-error"
              className="text-destructive shrink-0 self-center text-xs"
            >
              {orderError}
            </p>
          )}

          {cards.length === 0 ? (
            <p className="text-muted-foreground shrink-0 text-sm">
              このプロジェクトのセッションはありません
            </p>
          ) : (
            order.map((cardId) => (
              <SessionView
                key={cardId}
                cardId={cardId}
                compact
                /*
                  **横並びのときだけ掴み手を出す。** 単独のセッション専用画面には
                  並べる相手が1本も無い（設計§3-1）。置き場所は分岐させず、
                  有無だけが変わる
                */
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
                dragging={dragging === cardId}
                reordering={reordering}
              />
            ))
          )}
        </div>
      </div>
    </section>
  )
}
