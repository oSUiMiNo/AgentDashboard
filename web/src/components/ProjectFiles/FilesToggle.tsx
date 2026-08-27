/**
 * サイドバーを開け閉めするボタン（設計§3）。
 *
 * **状態を持たない。** 開閉の記憶は [`useFilesPanel`] が持ち、それを呼ぶのは画面側。
 * ここが自前で呼ぶと、同じタブの中で `FilesLayout` と食い違う——`storage` の合図は
 * 自分の窓には飛ばないので、押しても片方しか変わらない。
 *
 * # 印は ☰ ではない
 *
 * **枠の中に左寄りの縦線が1本**——「左の区画を出し入れする」ことをそのまま描いた形で、
 * ☰ のような「一般のメニュー」とは別物であることが見て分かる（2026-08-27・利用者の
 * 指定）。呼び名も**サイドバー**に揃えてあり、「ハンバーガー」とは呼ばない。
 *
 * **文字の記号は使わない**（`DESIGN.md` §14.4）。操作アイコンなので Outline で可
 * （§14.3 の Expand 系）。線の太さは、24 の枠を 16px で描くので実効 1.3px 前後になり、
 * **同じ画面の本文の太さと揃う**（§15.4）。
 *
 * **開いていても閉じていても同じ印を出す。** 状態は `aria-expanded` が持っている。
 * 押す前に形が変わると、何を押すことになるのか分からなくなる。
 *
 * # なぜアイコンのライブラリを使わないか
 *
 * `lucide-react` は依存に入っているが、**web/src からは1件も import されていない。**
 * 1個のためにライブラリの最初の利用者になるより、線の太さを自分で握れるほうが大きい
 * （上の §15.4）。**増えてきたら、そのときに寄せればよい。**
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
      aria-label="サイドバー"
      title="サイドバー"
      className="shrink-0"
      onClick={onToggle}
    >
      {/* 寸法はボタン側が当てる（`[&_svg:not([class*='size-'])]:size-4`） */}
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18" />
      </svg>
    </Button>
  )
}
