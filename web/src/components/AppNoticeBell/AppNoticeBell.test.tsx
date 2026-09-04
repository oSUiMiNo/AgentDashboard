/**
 * アプリ全体のベル（トーストとベル テスト計画フェーズ4）。
 *
 * **既存のカード用ベル（`NoticeBell.test.tsx`）とは別物を見ている。** 同じ画面に両方が
 * 映る場面があるので、testid と読み上げが分かれていることもここで見張る。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppNoticeBell } from './AppNoticeBell'
import {
  clearAppNotices,
  getAppNotices,
  pushBrowserNotice,
  pushServerNotice,
  unreadCount,
} from '@/stores/appNotices'
import type { NoticeView } from '@/lib/protocol'

function view(over: Partial<NoticeView> = {}): NoticeView {
  return {
    id: over.id ?? crypto.randomUUID(),
    source: over.source ?? 'error',
    kind: over.kind ?? 'other',
    message: over.message ?? 'サーバからの知らせ',
    created_at: over.created_at ?? Date.now(),
    read_at: over.read_at,
  }
}

beforeEach(() => {
  clearAppNotices()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
})

afterEach(() => {
  clearAppNotices()
  vi.unstubAllGlobals()
})

describe('AppNoticeBell', () => {
  it('1件も無ければ出さない', () => {
    render(<AppNoticeBell />)
    expect(screen.queryByTestId('app-notice-bell')).toBeNull()
  })

  it('溜まっていれば出る', () => {
    pushBrowserNotice('たまった')
    render(<AppNoticeBell />)
    expect(screen.getByTestId('app-notice-bell')).toBeInTheDocument()
  })

  it('読み上げの文言がカード用と違う', () => {
    pushBrowserNotice('よみあげ')
    render(<AppNoticeBell />)
    // **同じ画面に両方映る**ので、読み上げで混同しないようにする（設計§10-1）
    expect(screen.getByTestId('app-notice-bell')).toHaveAttribute(
      'aria-label',
      'アプリ全体の知らせ 1件',
    )
  })

  it('未読の数をバッジに出す', () => {
    pushServerNotice(view(), 3)
    render(<AppNoticeBell />)
    expect(screen.getByTestId('app-notice-unread')).toHaveTextContent('3')
  })

  it('未読が無ければバッジは出ないが、ベルは残る', () => {
    pushServerNotice(view({ read_at: Date.now() }), 0)
    render(<AppNoticeBell />)
    expect(screen.queryByTestId('app-notice-unread')).toBeNull()
    // **ベル自体は出したまま**——読んだものを後から拾う道が消えると用が無くなる
    expect(screen.getByTestId('app-notice-bell')).toBeInTheDocument()
  })

  it('開くと新しい順に並び、時刻が付く', async () => {
    const user = userEvent.setup()
    pushBrowserNotice('ふるい')
    pushBrowserNotice('あたらしい')
    render(<AppNoticeBell />)

    await user.click(screen.getByTestId('app-notice-bell'))
    const items = screen.getAllByTestId('app-notice-item')
    expect(items[0]).toHaveTextContent('あたらしい')
    expect(items[1]).toHaveTextContent('ふるい')
    expect(items[0]?.querySelector('time')).not.toBeNull()
  })

  it('開いた瞬間に全件が既読になる', async () => {
    const user = userEvent.setup()
    pushServerNotice(view(), 2)
    render(<AppNoticeBell />)
    expect(unreadCount()).toBe(2)

    await user.click(screen.getByTestId('app-notice-bell'))
    // **1件ずつの既読は作らない**（設計§10-3）
    expect(unreadCount()).toBe(0)
  })

  it('1件消せる', async () => {
    const user = userEvent.setup()
    pushBrowserNotice('けす')
    pushBrowserNotice('のこす')
    render(<AppNoticeBell />)

    await user.click(screen.getByTestId('app-notice-bell'))
    const removes = screen.getAllByTestId('app-notice-item-remove')
    // 新しい順なので先頭が「のこす」。**2件目（＝「けす」）を押す**
    await user.click(removes[1]!)
    expect(getAppNotices().map((n) => n.message)).toEqual(['のこす'])
  })

  it('1行の ✕ は「閉じる」と名乗らない', async () => {
    const user = userEvent.setup()
    pushBrowserNotice('けす')
    render(<AppNoticeBell />)
    await user.click(screen.getByTestId('app-notice-bell'))
    // **面を閉じる ✕ ではない**ので、何を消すのかが分かる文言にする（設計§10-3）
    expect(screen.getByTestId('app-notice-item-remove')).toHaveAttribute(
      'aria-label',
      'この知らせを消す',
    )
  })

  it('全部消せる', async () => {
    const user = userEvent.setup()
    pushBrowserNotice('ひとつめ')
    pushBrowserNotice('ふたつめ')
    render(<AppNoticeBell />)

    await user.click(screen.getByTestId('app-notice-bell'))
    await user.click(screen.getByTestId('app-notice-clear'))
    expect(getAppNotices()).toHaveLength(0)
  })

  it('出どころと種別を印として持つ', async () => {
    const user = userEvent.setup()
    pushServerNotice(view({ source: 'selfheal', kind: 'swapped' }), 1)
    render(<AppNoticeBell />)
    await user.click(screen.getByTestId('app-notice-bell'))

    const item = screen.getByTestId('app-notice-item')
    expect(item).toHaveAttribute('data-source', 'selfheal')
    expect(item).toHaveAttribute('data-kind', 'swapped')
    expect(item).toHaveAttribute('data-origin', 'server')
  })
})
