import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { NoticeBell } from './NoticeBell'
import type { Notice } from '@/stores/sessions'

/** ベル（細かい修正 設計§7-4。テスト計画フェーズ4・5）。 */
function notice(over: Partial<Notice> = {}): Notice {
  return {
    kind: 'revive',
    message: '起こせません',
    createdAt: Date.parse('2026-09-05T01:23:45'),
    expiresAt: null,
    ...over,
  }
}

describe('ベル', () => {
  it('1件も無ければ出ない', () => {
    // **常に出すと、押す意味のない印が画面に居座る**。要件が消したかったのは
    // 「ずっと出続けて邪魔」な表示なので、代わりに常駐する印を建てては本末転倒
    render(<NoticeBell notices={[]} />)
    expect(screen.queryByTestId('notice-bell')).toBeNull()
  })

  it('1件以上あれば出て、件数が読める', () => {
    render(<NoticeBell notices={[notice(), notice({ message: '2件目' })]} />)
    expect(screen.getByTestId('notice-bell')).toBeInTheDocument()
    expect(screen.getByTestId('notice-bell-count')).toHaveTextContent('2')
  })

  it('言葉は読み上げに残す（絵だけにしない）', () => {
    render(<NoticeBell notices={[notice()]} />)
    expect(screen.getByTestId('notice-bell')).toHaveAttribute(
      'aria-label',
      '溜まっている知らせ 1件',
    )
  })

  it('押すまでは一覧が開いていない', () => {
    render(<NoticeBell notices={[notice()]} />)
    expect(screen.queryByTestId('notice-list')).toBeNull()
  })

  it('押すと、新しい順に、時刻つきで読める', async () => {
    // **どれがいつのものか分からないと、いま起きたことか昔のことか判断できない**
    const user = userEvent.setup()
    render(
      <NoticeBell
        notices={[
          notice({ message: '古いほう', createdAt: Date.parse('2026-09-05T01:00:00') }),
          notice({ message: '新しいほう', createdAt: Date.parse('2026-09-05T02:00:00') }),
        ]}
      />,
    )
    await user.click(screen.getByTestId('notice-bell'))

    const items = await screen.findAllByTestId('notice-item')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('新しいほう')
    expect(items[1]).toHaveTextContent('古いほう')
    expect(items[0].querySelector('time')?.textContent).not.toBe('')
  })

  it('種別が目印に出る（どの操作の断りかを機械から見られる）', async () => {
    const user = userEvent.setup()
    render(<NoticeBell notices={[notice({ kind: 'permission_mode' })]} />)
    await user.click(screen.getByTestId('notice-bell'))

    expect((await screen.findAllByTestId('notice-item'))[0]).toHaveAttribute(
      'data-kind',
      'permission_mode',
    )
  })
})
