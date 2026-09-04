/**
 * 最前面のトースト層（トーストとベル テスト計画フェーズ4）。
 *
 * **重なり順と `pointer-events` の実効性は jsdom では確かめられない。** ここで見るのは
 * 「印が出ているか」までで、実際に前へ出るか・下の操作を食わないかは E2E が見る。
 */
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastLayer } from './ToastLayer'
import { clearAppNotices, pushBrowserNotice, pushSelfhealNotice } from '@/stores/appNotices'
import { useSettingsStore } from '@/stores/settings'
import { settingsFixture } from '@/test/fixtures'

beforeEach(() => {
  vi.useFakeTimers()
  clearAppNotices()
  useSettingsStore.setState({ settings: settingsFixture(), loading: false })
})

afterEach(() => {
  clearAppNotices()
  vi.useRealTimers()
})

describe('ToastLayer', () => {
  it('1件も無ければ層ごと出さない', () => {
    render(<ToastLayer />)
    // **空の `fixed` を残さない**——開発者ツールで見たときに「何か貼ってある」と読める
    expect(screen.queryByTestId('toast-layer')).toBeNull()
  })

  it('積むと出る', () => {
    pushBrowserNotice('でた')
    render(<ToastLayer />)
    expect(screen.getByTestId('toast')).toHaveTextContent('でた')
  })

  it('読み上げの札が付いている', () => {
    pushBrowserNotice('よみあげ')
    render(<ToastLayer />)
    const layer = screen.getByTestId('toast-layer')
    // **7秒で消えるものは、見ていない人には無かったのと同じになる**（設計§8-2）
    expect(layer).toHaveAttribute('role', 'status')
    expect(layer).toHaveAttribute('aria-live', 'polite')
  })

  it('賑やかのときは静けさの印を出さない', () => {
    pushBrowserNotice('にぎやか')
    useSettingsStore.setState({
      settings: { ...settingsFixture(), motion_quiet: 'lively' },
      loading: false,
    })
    render(<ToastLayer />)
    // **属性ごと出さない**のが既存の層と揃えた作法
    expect(screen.getByTestId('toast-layer')).not.toHaveAttribute('data-quiet')
  })

  it.each(['calm', 'still'] as const)('%s のときは印を出す', (quiet) => {
    pushBrowserNotice('しずか')
    useSettingsStore.setState({
      settings: { ...settingsFixture(), motion_quiet: quiet },
      loading: false,
    })
    render(<ToastLayer />)
    expect(screen.getByTestId('toast-layer')).toHaveAttribute('data-quiet', quiet)
  })

  it('出どころと種別を印として持つ', () => {
    pushSelfhealNotice('canary', null)
    render(<ToastLayer />)
    const toast = screen.getByTestId('toast')
    expect(toast).toHaveAttribute('data-source', 'selfheal')
    expect(toast).toHaveAttribute('data-kind', 'canary')
    expect(toast).toHaveAttribute('data-origin', 'browser')
  })

  it('閉じるボタンが作法どおり', () => {
    pushBrowserNotice('とじる')
    render(<ToastLayer />)
    const close = screen.getByTestId('toast-close')
    // **面を閉じるのは ✕。読み上げ用の名前は残す**（`close.test.ts` が機械で守る作法）
    expect(close).toHaveAttribute('aria-label', '閉じる')
    expect(close.textContent).toBe('')
  })
})
