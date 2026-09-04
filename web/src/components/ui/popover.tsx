/**
 * 軽く開いて閉じる面（細かい修正 設計§2-4・§7-4）。溜まった知らせをベルから出すのに使う。
 *
 * **暗幕を持つダイアログにしない。** 読むだけの面なので、後ろを操作できなくする理由が無い
 * ——閉じるために1手増えるほうが邪魔になる。
 *
 * 依存と jsdom の穴については `context-menu.tsx` の冒頭と同じ（同じ `radix-ui` の中にある）。
 */

import { Popover as Primitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

export const Popover = Primitive.Root

/** 押すと開くところ。**中身は呼ぶ側が決める。** */
export const PopoverTrigger = Primitive.Trigger

/** 開いたときに出るところ。 */
export function PopoverContent({
  className,
  align = 'end',
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground z-50 rounded-md border p-2 shadow-md',
          // **溜まったものを読ませるのが目的**なので、押した相手の幅に縛られない
          'max-h-[min(24rem,var(--radix-popover-content-available-height))] w-[min(22rem,90vw)] overflow-y-auto',
          className,
        )}
        {...props}
      >
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  )
}
