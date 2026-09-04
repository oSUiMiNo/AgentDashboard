/**
 * そのカードに溜まっている断りを、ベルから読ませる（細かい修正 設計§7-4）。
 *
 * # 1件以上あるときだけ出す
 *
 * 常に出すと、**押す意味のない印が画面に居座る**。要件が消したかったのは
 * 「ずっと出続けて邪魔」な表示なので、代わりに常駐する印を建てては本末転倒になる。
 *
 * # 置き場所は呼ぶ側が決める
 *
 * セッションの区画では**断りの定位置**（内容の真上）、カードでは**②行のバッジ列の中**。
 * どちらも**既にある段**なので、新しい絶対配置も空の段も増えない
 * （`DESIGN.md` §39.4「空の段を作らない」）。
 *
 * # 動きを止めていても出す
 *
 * 静けさの3段（賑やか／控えめ／静止）は**動きを止めるだけ**で、印と文字は残す
 * （`tile.css` の `zzz` と同じ作法）。ベルはもともと動かないので、3段のどれでも同じに見える。
 */

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { BellGlyph } from '@/components/ui/glyphs'
import type { Notice } from '@/stores/sessions'

/** 時刻を「いま起きたことか、昔のことか」が読める最小の形で出す。 */
function 時刻(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function NoticeBell({ notices }: { notices: readonly Notice[] }) {
  if (notices.length === 0) {
    return null
  }
  // **新しい順**。いま起きたことから読みたい（設計§7-4）
  const 新しい順 = [...notices].reverse()
  return (
    <Popover>
      <PopoverTrigger
        data-testid="notice-bell"
        /*
          **掴みと、外側の押下から切り離す。** カードの本体は `<button>`（`tile-body`）で、
          ベルはその中に居る——押下をそのまま通すと**ベルを押すとセッションが開き**、
          `pointerdown` は**並べ替えの掴みを始める**。`data-no-grab` は `useGrip` が見る印。
        */
        data-no-grab=""
        onClick={(event) => event.stopPropagation()}
        aria-label={`溜まっている知らせ ${notices.length}件`}
        title={`溜まっている知らせ ${notices.length}件`}
        className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <BellGlyph className="size-3.5" />
        <span data-testid="notice-bell-count">{notices.length}</span>
      </PopoverTrigger>
      <PopoverContent data-testid="notice-list">
        <ul className="flex flex-col gap-2">
          {新しい順.map((notice) => (
            <li
              key={notice.seq}
              data-testid="notice-item"
              data-kind={notice.kind}
              className="flex flex-col gap-0.5"
            >
              {/* **時刻を添える。** どれがいつのものか分からないと、いま起きたことか
                  昔のことか判断できない（設計§7-4） */}
              <time className="text-muted-foreground text-[0.65rem]">
                {時刻(notice.createdAt)}
              </time>
              <span className="text-xs">{notice.message}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
