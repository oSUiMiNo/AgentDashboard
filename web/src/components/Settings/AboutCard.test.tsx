import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutCard } from '@/components/Settings/AboutCard'
import { useVersionsStore, type VersionsView } from '@/stores/versions'

/** サーバの応答を流し込む。 */
function show(overrides: Partial<VersionsView> = {}) {
  useVersionsStore.setState({
    versions: {
      supported: true,
      editable: true,
      entries: [],
      selected: null,
      outcome: null,
      latest: null,
      stranded_cards: 0,
    zombie_children: null,
      install: null,
      install_unavailable: null,
      pointer_path: '/tmp/使い捨て/version-current',
      running: '0.1.5',
      // 2026-08-04 09:00 JST 相当
      binary_at: 1_785_888_000_000,
      started_at: 1_785_891_600_000,
      ...overrides,
    },
    loading: false,
  })
  render(<AboutCard />)
}

describe('このダッシュボードについて', () => {
  beforeEach(() => {
    // 読み込みに行かせない（見たいのは描き方であって通信ではない）
    vi.spyOn(useVersionsStore.getState(), 'load').mockResolvedValue(undefined)
  })

  it('いま動いている版と、2つの時刻を出す', () => {
    // **時刻が2つ要る。** 片方だけだと「更新したのか、再起動しただけなのか」が
    // 区別できない
    show()

    expect(screen.getByTestId('about-running')).toHaveTextContent('v0.1.5')
    expect(screen.getByTestId('about-binary-at')).toHaveTextContent('2026')
    expect(screen.getByTestId('about-started-at')).toHaveTextContent('2026')
  })

  it('読めない時刻は「不明」と書く', () => {
    // **推測で埋めない。** 嘘の日付を出すと、更新の判断を誤らせる
    show({ binary_at: null })

    expect(screen.getByTestId('about-binary-at')).toHaveTextContent('不明')
  })

  it('走っている版より新しい版があれば、そう出す', () => {
    show({
      latest: {
        version: '0.2.0',
        prerelease: false,
        has_artifact: true,
        checked_at: 1_785_891_600_000,
      },
    })

    expect(screen.getByTestId('about-behind')).toHaveTextContent('0.2.0')
    expect(screen.queryByTestId('about-uptodate')).toBeNull()
  })

  it('最新版と同じなら「最新です」と出す', () => {
    show({
      latest: {
        version: '0.1.5',
        prerelease: false,
        has_artifact: true,
        checked_at: 1_785_891_600_000,
      },
    })

    expect(screen.getByTestId('about-uptodate')).toBeInTheDocument()
    expect(screen.queryByTestId('about-behind')).toBeNull()
  })

  it('一度も見に行けていなければ、そう書く', () => {
    show({ latest: null })

    expect(screen.getByTestId('about-checked-at')).toHaveTextContent(
      'まだ一度も見に行けていません',
    )
  })

  it('版を切り替えられない構成でも中身は出て、その旨を添える', () => {
    // **箱でこそ要る。** 切り替えられないからといって、何が動いているかまで
    // 隠すと、更新されているか確かめる手段が画面から消える
    show({ supported: false })

    expect(screen.getByTestId('about-running')).toHaveTextContent('v0.1.5')
    expect(screen.getByTestId('about-binary-at')).toHaveTextContent('2026')
    expect(screen.getByTestId('about-unsupported')).toBeInTheDocument()
  })
})
