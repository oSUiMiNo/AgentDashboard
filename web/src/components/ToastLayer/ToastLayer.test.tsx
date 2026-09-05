/**
 * 最前面のトースト層（トーストとベル テスト計画フェーズ4）。
 *
 * **重なり順と `pointer-events` の実効性は jsdom では確かめられない。** ここで見るのは
 * 「印が出ているか」までで、実際に前へ出るか・下の操作を食わないかは E2E が見る。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastLayer } from './ToastLayer'
import { SWIPE_DISMISS_PX } from '@/lib/swipeDismiss'
import {
  clearAppNotices,
  getAppNotices,
  pushBrowserNotice,
  pushSelfhealNotice,
} from '@/stores/appNotices'
import { useSettingsStore } from '@/stores/settings'
import { settingsFixture } from '@/test/fixtures'

const COARSE = '(pointer: coarse) and (hover: none)'

/**
 * 指で触る端末のふり。
 *
 * **`matches` は getter で持つ**——プロパティにすると `matchMedia()` を呼んだ
 * 瞬間の値で固まる（`pointer.test.ts` と同じ作法）。
 */
function 指の端末にする(coarse: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === COARSE ? coarse : false
    },
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

/** 帯を、始点から相対で払う。 */
function 払う(帯: HTMLElement, dx: number, dy: number) {
  fireEvent.pointerDown(帯, { pointerId: 1, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(帯, { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy })
  fireEvent.pointerUp(帯, { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy })
}

beforeEach(() => {
  vi.useFakeTimers()
  clearAppNotices()
  useSettingsStore.setState({ settings: settingsFixture(), loading: false })
})

afterEach(() => {
  clearAppNotices()
  vi.useRealTimers()
  vi.unstubAllGlobals()
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

/**
 * 払って消す（スワイプで消す テスト計画フェーズ2）。
 *
 * **実際に指が届くか・端末のジェスチャと取り合わないかは jsdom では確かめられない。**
 * ここで見るのは「どの向きで消えて、どの向きで消えないか」までで、
 * 取り合いは実機（【要人間】）が見る。
 */
describe('ToastLayer（払って消す）', () => {
  it.each([
    ['左', -SWIPE_DISMISS_PX, 0],
    ['右', SWIPE_DISMISS_PX, 0],
    ['上', 0, -SWIPE_DISMISS_PX],
  ])('%sへ払うと消える', (_name, dx, dy) => {
    指の端末にする(true)
    pushBrowserNotice('はらう')
    render(<ToastLayer />)
    払う(screen.getByTestId('toast'), dx, dy)
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('**下へ払っても消えない**', () => {
    // トーストは画面のいちばん上に出る。下は引き下げ更新の持ち場である
    指の端末にする(true)
    pushBrowserNotice('した')
    render(<ToastLayer />)
    払う(screen.getByTestId('toast'), 0, SWIPE_DISMISS_PX * 3)
    expect(screen.getByTestId('toast')).toBeInTheDocument()
  })

  it('境目に届かなければ戻る', () => {
    指の端末にする(true)
    pushBrowserNotice('とどかない')
    render(<ToastLayer />)
    払う(screen.getByTestId('toast'), -(SWIPE_DISMISS_PX - 1), 0)
    const 帯 = screen.getByTestId('toast')
    expect(帯).toBeInTheDocument()
    // 運んでいた印も畳む——**残ると、次に触るまでゲージが止まったままになる**
    expect(帯).not.toHaveAttribute('data-swiping')
  })

  it('**PC では払えない**', () => {
    // 引っぱれるようにすると、文言を選んで写せなくなる。
    // あちらは ✕ が狙いやすく、マウスを乗せれば時計も止まる
    指の端末にする(false)
    pushBrowserNotice('ぴーしー')
    render(<ToastLayer />)
    払う(screen.getByTestId('toast'), -SWIPE_DISMISS_PX * 3, 0)
    expect(screen.getByTestId('toast')).toBeInTheDocument()
  })

  it('触っている間は印が立ち、ゲージが止まる', () => {
    指の端末にする(true)
    pushBrowserNotice('ふれる')
    render(<ToastLayer />)
    const 帯 = screen.getByTestId('toast')
    // **動かす前から立てる。** 時計だけ止めてゲージが減り続けると、
    // 残り時間の表示が嘘になる
    fireEvent.pointerDown(帯, { pointerId: 1, clientX: 100, clientY: 100 })
    expect(帯).toHaveAttribute('data-swiping', 'true')
  })

  it('途中でやめても（cancel）戻る', () => {
    指の端末にする(true)
    pushBrowserNotice('やめる')
    render(<ToastLayer />)
    const 帯 = screen.getByTestId('toast')
    fireEvent.pointerDown(帯, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(帯, { pointerId: 1, clientX: 40, clientY: 100 })
    fireEvent.pointerCancel(帯, { pointerId: 1, clientX: 40, clientY: 100 })
    expect(screen.getByTestId('toast')).toBeInTheDocument()
    expect(screen.getByTestId('toast')).not.toHaveAttribute('data-swiping')
  })

  it('**✕ の上から始めた動きは払いにしない**', () => {
    // 押して閉じるものが途中で払いに化けると「押したのに閉じない」が起きる
    指の端末にする(true)
    pushBrowserNotice('ばつ')
    render(<ToastLayer />)
    const 閉じる = screen.getByTestId('toast-close')
    fireEvent.pointerDown(閉じる, { pointerId: 1, clientX: 100, clientY: 100 })
    expect(screen.getByTestId('toast')).not.toHaveAttribute('data-swiping')
  })

  it('触った1枚だけが消える', () => {
    指の端末にする(true)
    pushBrowserNotice('いちまいめ')
    pushBrowserNotice('にまいめ')
    render(<ToastLayer />)
    const 帯 = screen.getAllByTestId('toast')
    expect(帯).toHaveLength(2)
    払う(帯[0], -SWIPE_DISMISS_PX, 0)
    expect(screen.getAllByTestId('toast')).toHaveLength(1)
  })

  it('払って消しても、ベルには残る', () => {
    // 閉じたのは「いま読んだ」という意思表示であって、無かったことにしたいわけではない。
    // **ここが崩れると、払うのが「捨てる」になる**——気軽に払えなくなる
    指の端末にする(true)
    pushBrowserNotice('のこる')
    render(<ToastLayer />)
    払う(screen.getByTestId('toast'), -SWIPE_DISMISS_PX, 0)
    expect(screen.queryByTestId('toast')).toBeNull()
    expect(getAppNotices()).toHaveLength(1)
  })
})
