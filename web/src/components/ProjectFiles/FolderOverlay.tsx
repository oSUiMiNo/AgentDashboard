/**
 * フォルダを辿る側を包む、**被さる層**（設計§2・§3）。
 *
 * # 広い画面でも被さる
 *
 * 常設の列にしない（設計§2）。**広い画面と狭い画面で作りを分けない**ので、
 * 「フォルダは被さる層、中身はその下の面」という1つの心の模型がそのまま通る。
 *
 * 広い画面では `absolute`、狭い画面では `fixed` にする。**`fixed` のまま広い画面へ
 * 持っていくと、画面の上端から被さってアプリのヘッダ（設定・アカウント）まで覆う。**
 * `absolute` なら取り合いの器の左端と高さがそのまま枠になり、中身の列にちょうど重なる。
 * どちらもフローの外なので、設計§7 の「取り合いに参加しない」は満たしている。
 *
 * # 幅は CSS 変数で運ぶ
 *
 * **`style={{ width }}` を直に当ててはいけない。** 狭い画面の `fixed inset-0` は
 * `left` と `right` の両方が 0 で、そこへ `width` が加わると過剰指定になり `right` が
 * 捨てられる——**全幅のドロワーが 320px の帯に化ける。**
 *
 * Tailwind のクラスは静的なので、動く値は変数で渡して `md:` の側で受ける。こうすると
 * **幅が当たるのは広い画面だけ**になり、`md` を JS から読まずに済む（web/src には
 * JS から読んでいる箇所が1件も無い）。
 *
 * # 出入りに動きを付ける
 *
 * 左からスライド（設計§6・`DESIGN.md` §28.2 の Panel 段）。OS の「動きを減らす」は
 * `App.tsx` の `<MotionConfig reducedMotion="user">` が引き受けるので、ここでは見ない。
 */

import { motion } from 'motion/react'
import type { CSSProperties } from 'react'
import { FolderBrowser } from '@/components/FolderBrowser/FolderBrowser'
import { FilesResizer } from '@/components/ProjectFiles/FilesResizer'
import { Button } from '@/components/ui/button'
import type { PanelEdge } from '@/lib/panelWidth'

interface Props {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /** その枠のパス。起点であり、相対パスの基準でもある */
  project: string
  /** 幅（px）。**利用者が縁で決める**ので動的 */
  width: number
  onPickFile: (path: string) => void
  /** ☰ と同じ手。狭い画面では ☰ が隠れる位置に来るので、ここにも出す */
  onClose: () => void
  onGrab: () => void
  onMove: (edge: PanelEdge, width: number) => void
  onDrop: () => void
}

export function FolderOverlay({
  host,
  project,
  width,
  onPickFile,
  onClose,
  onGrab,
  onMove,
  onDrop,
}: Props) {
  return (
    <motion.aside
      data-testid="project-files-panel"
      initial={{ x: '-100%' }}
      animate={{ x: 0 }}
      exit={{ x: '-100%' }}
      // 180〜300ms の中（設計§6）。速すぎると被さったことに気づかず、遅いと待たされる
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      style={{ '--files-folder-w': `${width}px` } as CSSProperties}
      className="bg-background fixed inset-0 z-40 flex min-h-0 flex-col gap-2 p-3 md:absolute md:inset-y-0 md:right-auto md:left-0 md:w-[var(--files-folder-w,20rem)] md:p-0 md:pr-3"
    >
      <div className="flex items-center gap-2 md:hidden">
        <span className="text-sm font-semibold">ファイル</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="project-files-close"
          className="ml-auto"
          onClick={onClose}
        >
          閉じる
        </Button>
      </div>

      {/*
        **高さの鎖の最後の輪**（設計§7）。`FolderBrowser` の `h-full` はこの段に対して
        解決される。一覧のスクロールは `FolderBrowser` の中が持つので、ここでは二重に
        持たない（移設前の `ProjectFiles` の1段目をそのまま運んできたもの）
      */}
      <div data-testid="project-files" className="min-h-0 flex-1 overflow-hidden">
        <FolderBrowser
          host={host}
          start={project}
          root={project}
          onPickFile={onPickFile}
        />
      </div>

      <FilesResizer
        edge="folder"
        width={width}
        label="フォルダの幅"
        onGrab={onGrab}
        onMove={onMove}
        onDrop={onDrop}
      />
    </motion.aside>
  )
}
