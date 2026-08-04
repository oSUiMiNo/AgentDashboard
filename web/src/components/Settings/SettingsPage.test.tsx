import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '@/components/Settings/SettingsPage'
import { useSettingsStore, type Settings } from '@/stores/settings'

/**
 * サーバの応答を流し込む。
 *
 * `loading` を偽にするのは、**読み込み中も `disabled` になる**ため。ここで見たいのは
 * 「変えられない構成だから無効」のほうなので、読み込みの都合を混ぜない。
 */
function show(overrides: Partial<Settings> = {}) {
  useSettingsStore.setState({
    settings: {
      always_bypass_permissions: false,
      always_bypass_editable: true,
      available_modes: ['default'],
      model_tables: {},
      agents: [],
      intervals: {
        sync_interval_secs: 20,
        screen_interval_ms: 20000,
        scrollback_lines: 1000,
      },
      lan_password: { supported: false, configured: false, editable: false },
      ...overrides,
    },
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

  it('変えられる構成では押せて、断りも出ない', () => {
    show({ always_bypass_editable: true })

    expect(screen.getByTestId('always-bypass-toggle')).toBeEnabled()
    expect(screen.getByTestId('always-bypass-label')).toHaveAttribute(
      'data-editable',
      'true',
    )
    expect(screen.queryByTestId('always-bypass-readonly')).toBeNull()
  })

  it('変えられない構成では、押せないことが見て分かる', () => {
    // **押せないこと自体は正しい**（持ち主は PC 側の agent.toml）。ここで守るのは
    // 「押せる顔をしていない」ほう——素のチェックボックスは暗い配色だと無効の
    // 淡色化がほぼ見えないので、ラベルごと薄くする印を付けてある
    show({ always_bypass_editable: false })

    expect(screen.getByTestId('always-bypass-toggle')).toBeDisabled()

    const label = screen.getByTestId('always-bypass-label')
    expect(label).toHaveAttribute('data-editable', 'false')
    expect(label.className).toMatch(/opacity-/)
    expect(label.className).toMatch(/cursor-not-allowed/)

    // 理由は、押そうとした場所のすぐ近くで読めること
    expect(screen.getByTestId('always-bypass-readonly')).toBeInTheDocument()
  })
})
