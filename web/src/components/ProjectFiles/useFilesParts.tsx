/**
 * ファイルの区画を組み立てて、**置き場所だけ画面に決めさせる**（設計§3・§8）。
 *
 * # なぜ器ではなくフックなのか
 *
 * もとは `FilesLayout` という部品で、サイドバーと中身の列を**並べて**返していた。
 * 2026-08-27 に「**中身の列を、セッションの札と同じようにレールの中へ入れる**」と
 * 決まった（`計画.md` フェーズ8）ので、**2つの子が別々の親へ行く**ことになった
 * ——並べて返す形のままでは置けない。
 *
 * | 案 | 採らなかった理由 |
 * |---|---|
 * | ポータルでレールの中へ差す | React の木と DOM がずれ、次に読む人が置き場所を追えない |
 * | render prop で置き場所を受け取る | 呼び元の見た目が読みにくくなる |
 *
 * **組み立て済みの2つを返し、画面はそれを置くだけにした。** 状態（選んでいるファイル・
 * 幅・掴み）は**ここ1箇所**に残る——これが `イシューグループ_2026-0813-2125` 設計§8
 * の「器を1つにする」で守りたかったことの本体で、**器が1つの `<div>` であることでは
 * なかった。**
 *
 * # 選んでいるファイルを1箇所に持つ
 *
 * サイドバーが選び、中身の列が映す。**2箇所に持つと、選んでも映らない／閉じても残る**
 * 形になる。
 *
 * # サイドバーの開閉は受け取る。持たない
 *
 * 開閉の記憶は [`useFilesPanel`] のままで、**呼ぶのは画面側**。切り替えボタンはヘッダの
 * 中に居て（PJT 専用画面とセッション専用画面でヘッダの作りが違う）、こことは別の枝に
 * ある。同じタブの中で `storage` の合図は飛ばないので、**両方が別々に
 * `useFilesPanel()` を呼ぶと、押しても片方しか変わらない。**
 */

import { AnimatePresence } from 'motion/react'
import { useState, type ReactNode } from 'react'
import { FileColumn } from '@/components/ProjectFiles/FileColumn'
import { Sidebar } from '@/components/ProjectFiles/Sidebar'
import { usePanelWidths } from '@/lib/filesPanel'

interface Args {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /** その枠のパス。起点であり、相対パスの基準でもある */
  project: string
  /** サイドバーが開いているか。**記憶は `useFilesPanel` が持つ**ので、受け取るだけ */
  open: boolean
  onToggle: () => void
}

export interface FilesParts {
  /**
   * **レールの外に置く。** サイドバー本体と、その場所取り。
   *
   * レールと一緒に流れてはいけない——流れると、横へスクロールしたときに
   * 左から出ているものが画面から消える。
   */
  sidebar: ReactNode
  /**
   * **レールの中の、いちばん左に置く**（PJT 専用画面）。セッションの札と同じ扱いで、
   * 一緒に横へ流れる。ファイルを開いていなければ `null`。
   *
   * セッション専用画面には**レールが無い**（セッションを1本しか出さない）ので、
   * あちらでは取り合いの器の兄弟として置く。**片方だけ形が違うのは入れ忘れではなく、
   * 揃える先が存在しないため。**
   */
  column: ReactNode
}

export function useFilesParts({
  host,
  project,
  open,
  onToggle,
}: Args): FilesParts {
  /*
    いま選んでいるファイル。**覚えない**——リロードで消える（設計§3）。開いていた
    ファイルを戻すかどうかは `イシューグループ_2026-0813-1804` が範囲を切っているので、
    そちらの結論を待つ。

    ここに持つことで、**サイドバーを畳んでも中身の列が残る**（設計§2）
  */
  const [picked, setPicked] = useState<string | null>(null)
  const [widths, grip, dragging] = usePanelWidths()

  return {
    sidebar: (
      // `initial={false}` で、開いた状態で読み込み直したときに滑らせない
      <AnimatePresence initial={false}>
        {open && (
          <Sidebar
            key="folder"
            host={host}
            project={project}
            width={widths.folder}
            /*
              **掴んでいる間だけ、場所取りの動きを止める**（`Sidebar.tsx`）。
              渡さないと、幅を引っぱるたびに場所取りがパネルから遅れる
            */
            dragging={dragging}
            /*
              **ファイルを選んでも畳まない**（利用者の判断・2026-08-24）。続けて別の
              ファイルを開けるようにするため（設計§2）
            */
            onPickFile={setPicked}
            onClose={onToggle}
            {...grip}
          />
        )}
      </AnimatePresence>
    ),
    column:
      picked === null ? null : (
        <FileColumn
          host={host}
          project={project}
          path={picked}
          width={widths.file}
          onClose={() => setPicked(null)}
          {...grip}
        />
      ),
  }
}
