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
