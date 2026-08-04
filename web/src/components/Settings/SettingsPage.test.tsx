import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '@/components/Settings/SettingsPage'
import { settingsFixture } from '@/test/fixtures'
import { useSettingsStore, type Settings } from '@/stores/settings'

/**
 * サーバの応答を流し込む。
 *
 * `loading` を偽にするのは、**読み込み中は `disabled` になる**ため。ここで見たいのは
 * 描き方であって、読み込みの都合ではない。
 */
function show(overrides: Partial<Settings> = {}) {
  useSettingsStore.setState({
    settings: settingsFixture(overrides),
    loading: false,
    lastError: null,
  })
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  )
}

describe('常に権限確認スキップモードで開く', () => {
  beforeEach(() => {
    // 読み込みに行かせない（見たいのは描き方であって通信ではない）
    vi.spyOn(useSettingsStore.getState(), 'load').mockResolvedValue(undefined)
  })

  it('どの構成でも押せる', () => {
    // 保存先がアカウントごとの記録になったので、**構成による出し分けが無い**
    // （持ち出し設計§6）。ここが無効になるなら、どこかに出し分けが残っている
    show()

    expect(screen.getByTestId('always-bypass-toggle')).toBeEnabled()
  })

  it('変えられない断りと、その印は残っていない', () => {
    // 0.1.3 で「変えられないと見て分かる」ために入れたもの。**変えられるように
    // なったので残してはいけない**——薄い文字と断りが出たままだと、押せるのに
    // 押せない顔をしていることになる
    show()

    expect(screen.queryByTestId('always-bypass-readonly')).toBeNull()
    const label = screen.getByTestId('always-bypass-label')
    expect(label).not.toHaveAttribute('data-editable')
    expect(label.className).not.toMatch(/opacity-/)
    expect(label.className).not.toMatch(/cursor-not-allowed/)
  })

  it('読み込み中だけは押せない', () => {
    // サーバの値が届く前に押させると、届いた瞬間に見た目が戻る
    useSettingsStore.setState({ settings: settingsFixture(), loading: true })
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('always-bypass-toggle')).toBeDisabled()
  })
})
