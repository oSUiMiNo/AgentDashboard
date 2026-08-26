/**
 * ファイルのパネルを開閉するボタン（設計§3）。
 *
 * **状態を持たない。** 開閉の記憶は [`useFilesPanel`] が持ち、それを呼ぶのは画面側。
 * ここが自前で呼ぶと、同じタブの中で `FilesLayout` と食い違う——`storage` の合図は
 * 自分の窓には飛ばないので、押しても片方しか変わらない。
 */

import { Button } from '@/components/ui/button'

interface Props {
  open: boolean
  onToggle: () => void
}

export function FilesToggle({ open, onToggle }: Props) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-testid="project-files-toggle"
      aria-expanded={open}
      aria-label="ファイル"
      title="ファイル"
      className="shrink-0"
      onClick={onToggle}
    >
      <span aria-hidden>☰</span>
    </Button>
  )
}
