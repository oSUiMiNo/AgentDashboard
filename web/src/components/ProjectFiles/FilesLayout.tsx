/**
 * ファイルのパネルの器（設計§3）。
 *
 * # 2箇所に同じものを書く形を、ここで終わりにする
 *
 * 移設前は `<aside>` が `GroupView.tsx` と `SessionView.tsx` に**クラス文字列まで
 * 一字一句同じもので2つ**あった。中身の部品（`ProjectFiles`）と開閉の記憶
 * （`lib/filesPanel.ts`）は意図して共有してあったのに、その周りの器だけが写してあった。
 *
 * この統合は `イシューグループ_2026-0813-2125` の設計§8 が宣言していたもので、
 * メタ.md の「**どちらか一方で片付けること**」に従って**こちらが代行した**。
 *
 * # 中身の入れ物を返さない
 *
 * 返すのは断片（`<>…</>`）で、**包む `<div>` を作らない。** 作るとそれが取り合いの器の
 * 子になり、中身の列とセッションのあいだに余分な1段が入って `shrink-0` と `flex-1` の
 * 関係が崩れる。
 *
 * # ☰ の状態は受け取る。持たない
 *
 * 開閉の記憶は [`useFilesPanel`] のままで、**呼ぶのは画面側**。☰ のボタンはヘッダの中に
 * 居て（PJT 専用画面とセッション専用画面でヘッダの作りが違う）、こことは別の枝にある。
 * 同じタブの中で `storage` の合図は飛ばないので、**両方が別々に `useFilesPanel()` を
 * 呼ぶと、押しても片方しか変わらない。**
 */

import { AnimatePresence } from 'motion/react'
import { useState } from 'react'
import { FileColumn } from '@/components/ProjectFiles/FileColumn'
import { FolderOverlay } from '@/components/ProjectFiles/FolderOverlay'
import { usePanelWidths } from '@/lib/filesPanel'

interface Props {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /** その枠のパス。起点であり、相対パスの基準でもある */
  project: string
  /** ☰ の状態。**記憶は `useFilesPanel` が持つ**ので、ここでは受け取るだけ */
  open: boolean
  onToggle: () => void
  /** 横ホイールの行き先（設計§8）。PJT 専用画面だけが渡す */
  onWheelX?: (deltaX: number) => void
}

export function FilesLayout({ host, project, open, onToggle, onWheelX }: Props) {
  /*
    いま選んでいるファイル。**覚えない**——リロードで消える（設計§3）。開いていた
    ファイルを戻すかどうかは `イシューグループ_2026-0813-1804` が範囲を切っているので、
    そちらの結論を待つ。

    移設前は `ProjectFiles` のローカル状態だった。ここへ上げたことで、**☰ を畳んでも
    中身の列が残る**（設計§2「ふだん（ファイルを開いている）」）
  */
  const [picked, setPicked] = useState<string | null>(null)
  const [widths, grip] = usePanelWidths()

  return (
    <>
      {/* `initial={false}` で、開いた状態で読み込み直したときに滑らせない */}
      <AnimatePresence initial={false}>
        {open && (
          <FolderOverlay
            key="folder"
            host={host}
            project={project}
            width={widths.folder}
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

      {picked !== null && (
        <FileColumn
          host={host}
          project={project}
          path={picked}
          width={widths.file}
          onClose={() => setPicked(null)}
          onWheelX={onWheelX}
          {...grip}
        />
      )}
    </>
  )
}
