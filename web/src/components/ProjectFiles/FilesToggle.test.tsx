/**
 * サイドバーの切り替えボタン（設計§3。テスト計画フェーズ6）。
 *
 * **印が☰でなくなったことを、ここで押さえる。** 印は見た目なので普段はテストの対象に
 * しないが、これは**戻っても画面が壊れない**——☰ に戻しても押せるし開くので、E2E も
 * 単体も緑のまま通ってしまう。**気づけるのは、字で見張っているときだけ。**
 */

import { render, screen } from '@testing-library/react'
import { FilesToggle } from '@/components/ProjectFiles/FilesToggle'

function 置く(open = false) {
  const pressed: string[] = []
  const { unmount } = render(
    <FilesToggle open={open} onToggle={() => pressed.push('toggle')} />,
  )
  return { pressed, unmount, button: screen.getByTestId('project-files-toggle') }
}

it('印は文字ではなく図形で描いてある', () => {
  const { button } = 置く()

  // `DESIGN.md` §14.4（正式UIに文字の記号・絵文字を使わない）
  expect(button.querySelector('svg')).not.toBeNull()
  expect(button.textContent).toBe('')
})

it('☰ は、もう出てこない', () => {
  const { button } = 置く()

  // **印だけを名指しで見る。** 「文字が無い」だけだと、別の記号へ替えても通る
  expect(button.innerHTML).not.toContain('☰')
})

it('読み上げ名は「サイドバー」', () => {
  const { button } = 置く()

  expect(button).toHaveAttribute('aria-label', 'サイドバー')
  expect(button).toHaveAttribute('title', 'サイドバー')
})

it('開いていても閉じていても、印は同じ', () => {
  const { button: 閉, unmount } = 置く(false)
  const 閉じた印 = 閉.innerHTML
  const 閉じたときの状態 = 閉.getAttribute('aria-expanded')
  // **片付けてから置き直す。** 同じ器へ2回描くと、目印が2つになって掴めなくなる
  unmount()

  const { button: 開 } = 置く(true)

  /*
    **状態は `aria-expanded` が持つ。** 押す前に形が変わると、何を押すことになるのか
    分からなくなる（`FilesToggle.tsx` の JSDoc）
  */
  expect(開.innerHTML).toBe(閉じた印)
  expect(開).toHaveAttribute('aria-expanded', 'true')
  expect(閉じたときの状態).toBe('false')
})
