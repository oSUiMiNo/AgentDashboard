import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * メニューの部品が jsdom で開くこと（細かい修正 設計§2-4）。
 *
 * **開くことを見るのが目的である。** 焦点の閉じ込め・Esc・外側クリックは `radix-ui` が
 * 既に解いているので、ここで作り直さない——**確かめるのは「使う形に束ねられているか」**。
 *
 * jsdom は `hasPointerCapture` を持たないので `src/test/setup.ts` が生やしている
 * （`select.tsx` と同じ穴）。**落ちたらまずそこを疑う。**
 */
describe('右クリックのメニュー', () => {
  it('右クリックで開き、選択肢が読める', async () => {
    const user = userEvent.setup()
    render(
      <ContextMenu>
        <ContextMenuTrigger data-testid="範囲">ファイル</ContextMenuTrigger>
        <ContextMenuContent data-testid="メニュー">
          <ContextMenuItem data-testid="絶対パス">絶対パスをコピー</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    expect(screen.queryByTestId('メニュー')).toBeNull()
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('範囲') })
    expect(await screen.findByTestId('メニュー')).toBeInTheDocument()
    expect(screen.getByTestId('絶対パス')).toHaveTextContent('絶対パスをコピー')
  })

  it('押すまでは開いていない（新しい絶対配置を増やさない）', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger data-testid="範囲">ファイル</ContextMenuTrigger>
        <ContextMenuContent data-testid="メニュー">
          <ContextMenuItem>絶対パスをコピー</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    expect(screen.queryByTestId('メニュー')).toBeNull()
  })
})

describe('軽く開いて閉じる面', () => {
  it('押すと開き、溜まったものが読める', async () => {
    const user = userEvent.setup()
    render(
      <Popover>
        <PopoverTrigger data-testid="ベル">3</PopoverTrigger>
        <PopoverContent data-testid="中身">いまのモードを読み取れませんでした</PopoverContent>
      </Popover>,
    )
    expect(screen.queryByTestId('中身')).toBeNull()
    await user.click(screen.getByTestId('ベル'))
    expect(await screen.findByTestId('中身')).toHaveTextContent(
      'いまのモードを読み取れませんでした',
    )
  })

  it('Esc で閉じる（自前で作り直していない）', async () => {
    const user = userEvent.setup()
    render(
      <Popover>
        <PopoverTrigger data-testid="ベル">3</PopoverTrigger>
        <PopoverContent data-testid="中身">溜まった知らせ</PopoverContent>
      </Popover>,
    )
    await user.click(screen.getByTestId('ベル'))
    expect(await screen.findByTestId('中身')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('中身')).toBeNull()
  })
})

describe('新しい依存を増やしていない', () => {
  it('radix-ui は既に入っているものを使っている', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies['radix-ui']).toBeDefined()
    // 個別パッケージ（`@radix-ui/react-*`）を直に足していないこと
    const 個別 = Object.keys(pkg.dependencies).filter((n) => n.startsWith('@radix-ui/'))
    expect(個別).toHaveLength(0)
  })
})
