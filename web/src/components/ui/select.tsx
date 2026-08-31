/**
 * ドロップダウン（帯の設計§4・案B）。
 *
 * # なぜ標準の `<select>` をやめたか
 *
 * 要件は「**一覧には補足を出し、選んだあとは出さない**」だった。
 *
 * ```
 * 一覧を開いたとき   自動（環境によっては切り替えられません）
 * 選んだあと         自動
 * ```
 *
 * 標準の `<select>` は**閉じているときに、選ばれた選択肢の文字をそのまま出す**作りなので、
 * これは原理的にできない。補足を消せば選んだあとも消えるし、残せば選んだあとも残る。
 *
 * # 引き換えに失うもの
 *
 * **スマホで OS 標準の選び方（下から出るホイールやシート）が使えなくなる。** スマホで使う
 * 道具なので、ここは軽くない——**押せて・選べて・閉じられることを実機で確かめるまで、
 * この判断は確定しない**（設計§11-5）。駄目なら案A（補足を別の場所へ移す）へ戻す。
 *
 * # 新しい依存は増えていない
 *
 * `radix-ui` は既に依存に入っており（`button.tsx` と `badge.tsx` が `Slot` を使っている）、
 * その中に `@radix-ui/react-select` が入っている。**このファイルはその一部を、使う形に
 * 束ねているだけ**である。
 *
 * # jsdom では開かない（環境の話）
 *
 * Radix はトリガーを押した瞬間に `hasPointerCapture` を呼ぶ。jsdom はこれを持っていないので、
 * `web/src/test/setup.ts` で生やしてある。**足りないのは環境であって、作りではない。**
 */

import { Select as Primitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

export const Select = Primitive.Root

/**
 * 閉じているときに見えるところ。
 *
 * **中身は呼ぶ側が決める。** `Primitive.Value` を使わないのは、**閉じたときに出したい文字が
 * 選択肢の文字と違う**ため——モデルは「CLI が名乗った表示名（`Opus 5`）」を出すが、選択肢は
 * 別名（`opus`）で、そもそも文字列が一致しない。標準の `<select>` ではここを合わせるために
 * 「現在値の選択肢」を先頭へ足す必要があったが、**自前にするとその小細工ごと要らなくなる。**
 *
 * 目印（`data-testid` など）は呼ぶ側からそのまま渡す。**既存のテストと E2E が読んでいる**
 * ので、綴りは据え置く（設計§4）。
 */
export function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        // 幅は呼ぶ側が決める（帯では 8rem）。ここは中身の並べ方だけを持つ
        'flex items-center justify-between gap-1 rounded border px-1.5 py-0.5 text-xs',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'disabled:pointer-events-none disabled:opacity-50',
        'data-[state=open]:bg-muted/40',
        className,
      )}
      {...props}
    >
      {/* **選んだ値は縮ませる。** 印は最後まで残す——押せることが分からなくなるため */}
      <span className="min-w-0 truncate">{children}</span>
      <Primitive.Icon asChild>
        <svg
          aria-hidden
          className="size-3 shrink-0 opacity-60"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </Primitive.Icon>
    </Primitive.Trigger>
  )
}

/**
 * 開いたときに出るところ。
 *
 * **`position="popper"` にしてある。** 既定（`item-aligned`）は選ばれている項目をトリガーへ
 * 重ねるので、**狭い画面で一覧がトリガーの上に被さり、いま何を選んでいるのかが消える**。
 */
export function SelectContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        position="popper"
        sideOffset={4}
        className={cn(
          'bg-popover text-popover-foreground z-50 overflow-hidden rounded-md border shadow-md',
          // 一覧はトリガーより広くてよい。**補足を読ませるのがこの部品の目的**なので、
          // ここまで 8rem に押し込めると案Bを採った意味が消える
          'max-h-[min(24rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] max-w-[min(22rem,90vw)]',
          className,
        )}
        {...props}
      >
        <Primitive.Viewport className="p-1">{children}</Primitive.Viewport>
      </Primitive.Content>
    </Primitive.Portal>
  )
}

/**
 * 選択肢1件。
 *
 * `note` は**開いたときだけ出る補足**（`（環境によっては切り替えられません）` など）。
 * 括弧を外して2行目に置くのは、**閉じたときに出ないことが要件**だから——同じ行に書くと、
 * 「選んだあとの表示に括弧が出ない」を満たすために結局この部品が要らなくなる。
 */
export function SelectItem({
  className,
  children,
  note,
  ...props
}: React.ComponentProps<typeof Primitive.Item> & { note?: string | null }) {
  return (
    <Primitive.Item
      className={cn(
        'relative flex cursor-default flex-col gap-0.5 rounded-sm px-2 py-1.5 text-xs outline-none select-none',
        'data-[highlighted]:bg-muted data-[highlighted]:text-foreground',
        'data-[state=checked]:text-foreground data-[state=checked]:font-medium',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <Primitive.ItemText>{children}</Primitive.ItemText>
      {note != null && note !== '' && (
        <span className="text-muted-foreground text-[0.65rem] leading-tight">
          {note}
        </span>
      )}
    </Primitive.Item>
  )
}
