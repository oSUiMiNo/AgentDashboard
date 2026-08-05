/**
 * PJT 専用画面の左パネル（イシューグループ_2026_0805_0514 設計§14・§15）。
 *
 * # 器でしかない
 *
 * 辿るのは [`FolderBrowser`]、見せるのは [`FileView`] で、ここは2つを縦に積むだけ。
 * **辿り方を自前で書かない**のが要点で、一覧の「PJT を追加」のシートと同じ部品を
 * 使っているから、押し方・パンくず・打ち切りの出し方が自動的に揃う（設計§13）。
 * 同じ列挙の口を使う部品が2つの作法を持つと、片方だけ直したときに食い違う。
 *
 * # 起点より上へは辿らせない
 *
 * `root` にその枠のパスを渡す。相対パスの基準が壊れると、コピーした値が貼られた側で
 * 別の場所を指すため（設計§15）。**口そのものに範囲の制限は無い**（`方針.md`）ので、
 * 制限しているのはこの画面の起点だけになる。
 */

import { useState } from 'react'
import { FileView } from '@/components/FileView/FileView'
import { FolderBrowser } from '@/components/FolderBrowser/FolderBrowser'

interface Props {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /** その枠のパス。起点であり、相対パスの基準でもある */
  project: string
}

export function ProjectFiles({ host, project }: Props) {
  const [picked, setPicked] = useState<string | null>(null)

  return (
    <div
      data-testid="project-files"
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden"
    >
      {/* 一覧のスクロールは `FolderBrowser` の中が持つ（親で二重に持たない） */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <FolderBrowser
          host={host}
          start={project}
          root={project}
          onPickFile={setPicked}
        />
      </div>

      {picked !== null && (
        <div className="min-h-0 flex-[1.4] overflow-hidden">
          <FileView
            host={host}
            root={project}
            path={picked}
            onClose={() => setPicked(null)}
          />
        </div>
      )}
    </div>
  )
}
