/**
 * 右クリックで出すメニュー（細かい修正 設計§2-4・§8-4）。
 *
 * # 新しい依存は増えていない
 *
 * `radix-ui` は既に依存に入っており（`button.tsx` と `badge.tsx` が `Slot` を、
 * `select.tsx` が `Select` を使っている）、その中に `@radix-ui/react-context-menu` が
 * 入っている。**このファイルはその一部を、使う形に束ねているだけ**である。
 *
 * # なぜ自前で組まないのか
 *
 * **メニューは見た目より、焦点まわりのほうが難しい。** 開いている間の焦点の閉じ込め、
 * Esc、外側を押したときの閉じ、読み上げの役割——これらを自前で作ると、`select.tsx` が
 * 既に解いた問題をもう一度解くことになる。
 *
 * # jsdom では穴を踏む（環境の話）
 *
 * Radix のメニューは `hasPointerCapture` を呼ぶ。jsdom はこれを持っていないので
 * `web/src/test/setup.ts` で生やしてある（`select.tsx` と同じ穴）。**足りないのは環境で
 * あって、作りではない。** テストが落ちたらまずここを疑う。
 */

import { ContextMenu as Primitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

export const ContextMenu = Primitive.Root

/** 右クリックを受ける範囲。**中身は呼ぶ側が決める。** */
export const ContextMenuTrigger = Primitive.Trigger

/** 開いたときに出るところ。 */
export function ContextMenuContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        className={cn(
          'bg-popover text-popover-foreground z-50 min-w-40 overflow-hidden rounded-md border p-1 shadow-md',
          className,
        )}
        {...props}
      >
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  )
}

/**
 * メニューの見出し。**押せない。**
 *
 * # なぜ `ContextMenuItem` を流用しないのか
 *
 * **押せるものの中に押せないものが混ざる。** `Item` は押せる見た目（当たったら色が
 * 変わる）を持っているので、それで見出しを出すと、**押してみるまで押せないと
 * 分からない**。見出しは見出しの部品で出す。
 *
 * # 長いものが来る前提で作る
 *
 * 呼ぶ側は**ファイル名をそのまま**渡してくる。深い階層の長い名前でメニューが横へ
 * 伸びると、狭い画面では画面の外へ出る。**折り返して、伸びるのは縦だけにする。**
 */
export function ContextMenuLabel({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label
      className={cn(
        'text-muted-foreground px-2 py-1.5 text-xs font-medium',
        // **長い名前で横へ伸びない。** 器の上限までで折り返す
        'max-w-64 break-all',
        className,
      )}
      {...props}
    >
      {children}
    </Primitive.Label>
  )
}

/** 区切り線。**見出しと選択肢の間を分ける。** */
export function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Separator>) {
  return (
    <Primitive.Separator
      className={cn('bg-border -mx-1 my-1 h-px', className)}
      {...props}
    />
  )
}

/** 選択肢1件。**目印は呼ぶ側から渡させる。** */
export function ContextMenuItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none select-none',
        'data-[highlighted]:bg-muted data-[highlighted]:text-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </Primitive.Item>
  )
}
