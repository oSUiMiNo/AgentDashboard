/**
 * ファイルの中身を見せる側を包む、**独立した列**（設計§2・§3）。
 *
 * # 動きを付けない
 *
 * 列が現れるとセッションが右へずれる。一覧で禁じている「**押す的が逃げる**」と同じ
 * 考え方をここにも持ち込む（設計§6）。
 *
 * # 広い画面ではフローの中、狭い画面では被さる層
 *
 * 広い画面では `relative`（`static` ではない）にしてある——縁を自分の右端へ絶対配置
 * するには、自分が位置の基準になっている必要があるため。位置は `md:inset-auto` で
 * 解いてあるので、**見た目は `static` と1ピクセルも変わらない。**
 *
 * 狭い画面ではフォルダ（`z-40`）の奥（`z-30`）に全幅で敷く。ファイルを選んでも
 * フォルダは閉じないので、**読むときだけ ☰ で畳む**（設計§2）。
 *
 * # 幅の上限を CSS で持たない
 *
 * `md:max-w-[50%]` のような保険を足したくなるが、**足してはいけない。** 足すと
 * 「clamp を外す」壊し方を当てても画面がはみ出さなくなり、テスト計画フェーズ4
 * 「幅の上限を外す → はみ出さないことだけが落ちる」が**狙った1本を落とせなくなる**。
 * 上限は `panelWidth.ts` の1箇所だけが持つ。
 */

import type { CSSProperties } from 'react'
import { FileView } from '@/components/FileView/FileView'
import { FilesResizer } from '@/components/ProjectFiles/FilesResizer'
import type { PanelEdge } from '@/lib/panelWidth'

interface Props {
  host: string
  /** 相対パスの基準（その枠のパス） */
  project: string
  /** 読むファイルの絶対パス */
  path: string
  width: number
  /** 閉じる。**列ごと消え、セッションが左へ寄る**（設計§2） */
  onClose: () => void
  onGrab: () => void
  onMove: (edge: PanelEdge, width: number) => void
  onDrop: () => void
  /**
   * 横ホイールの行き先（設計§8）。**PJT 専用画面だけが渡す**（セッション専用画面に
   * レールが無い）。中身の列の上でホイールを横へ回したら、レールが動く
   */
  onWheelX?: (deltaX: number) => void
}

export function FileColumn({
  host,
  project,
  path,
  width,
  onClose,
  onGrab,
  onMove,
  onDrop,
  onWheelX,
}: Props) {
  return (
    <div
      data-testid="file-column"
      style={{ '--files-file-w': `${width}px` } as CSSProperties}
      className="bg-background fixed inset-0 z-30 flex min-h-0 flex-col gap-2 p-3 md:relative md:inset-auto md:z-auto md:w-[var(--files-file-w,42rem)] md:shrink-0 md:p-0 md:pr-3"
      onWheel={(event) => {
        // **`preventDefault()` は呼ばない。** React は `wheel` を passive で張るので
        // 効かない。呼ばなくても、祖先に横へ動ける箱が1つも無いのでブラウザは何もしない
        if (onWheelX === undefined || event.deltaX === 0) {
          return
        }
        if (列の中で横へ動くか(event.target, event.currentTarget, event.deltaX)) {
          return
        }
        onWheelX(event.deltaX)
      }}
    >
      {/*
        **高さの鎖の最後の輪**（設計§7）。`FileView` の `h-full` はこの段に対して
        解決される。移設前の `flex-[1.4]`（縦の取り合い）がここに置き換わる——
        縦に積むのをやめたので、配分そのものが消える
      */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <FileView host={host} root={project} path={path} onClose={onClose} />
      </div>

      <FilesResizer
        edge="file"
        width={width}
        label="ファイルの中身の幅"
        onGrab={onGrab}
        onMove={onMove}
        onDrop={onDrop}
      />
    </div>
  )
}

/**
 * その位置から横へ動かせる入れ物が、列の中に居るか。
 *
 * 列の中に横スクロールを持つのは生テキスト表示の `<pre>`（`overflow-x-auto`）だけ
 * なので、**そこだけは自分で受け取り、それ以外は素通しにする**（設計§8）。
 */
function 列の中で横へ動くか(
  from: EventTarget,
  stop: Element,
  deltaX: number,
): boolean {
  let at: Element | null = from instanceof Element ? from : null
  while (at !== null && at !== stop) {
    const style = getComputedStyle(at)
    const 横に開いている =
      style.overflowX === 'auto' || style.overflowX === 'scroll'
    if (横に開いている && at.scrollWidth > at.clientWidth) {
      const 残り =
        deltaX < 0 ? at.scrollLeft : at.scrollWidth - at.clientWidth - at.scrollLeft
      if (残り > 0) {
        return true
      }
    }
    at = at.parentElement
  }
  return false
}
