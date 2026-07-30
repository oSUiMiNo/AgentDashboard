import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SpawnForm } from './SpawnForm'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

/**
 * 起動ボタン（テスト計画フェーズ5「起動ボタン」）。
 *
 * ボタンの数がそのまま「どの権限モードで起動できるか」なので、**数と、押したときに
 * サーバへ渡る値**の両方を固定する。「指定なし」が `null` として渡ることが特に大事で、
 * ここで `manual` を補うと利用者の `permissions.defaultMode` を無視することになる。
 */

const WORK_DIR = '/home/example/dev/app'

function setToggle(value: boolean) {
  useSettingsStore.setState({
    settings: {
      always_bypass_permissions: value,
      available_modes: ['default', 'acceptEdits', 'bypassPermissions'],
      model_aliases: [],
      model_catalog: [],
    },
    loading: false,
  })
}

beforeEach(() => {
  setToggle(false)
})

describe('SpawnForm', () => {
  it('既定では起動ボタンが3つ出る', () => {
    render(<SpawnForm disabled={false} />)

    const modes = screen
      .getAllByTestId('spawn-button')
      .map((button) => button.dataset.mode)
    expect(modes).toEqual(['', 'acceptEdits', 'bypassPermissions'])
  })

  it('トグルが ON なら全承認をスキップの1つだけになる', () => {
    setToggle(true)
    render(<SpawnForm disabled={false} />)

    const buttons = screen.getAllByTestId('spawn-button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].dataset.mode).toBe('bypassPermissions')
  })

  it('押したボタンに対応するモードでサーバへ起動を要求する', async () => {
    const spawn = vi.fn()
    useWsStore.setState({ spawn })
    render(<SpawnForm disabled={false} />)

    await userEvent.type(screen.getByLabelText('作業ディレクトリ'), WORK_DIR)
    const buttons = screen.getAllByTestId('spawn-button')

    await userEvent.click(buttons[1])
    expect(spawn).toHaveBeenCalledWith(WORK_DIR, 'acceptEdits')

    await userEvent.click(buttons[2])
    expect(spawn).toHaveBeenCalledWith(WORK_DIR, 'bypassPermissions')
  })

  it('「指定なし」は null を渡す', async () => {
    // 利用者の permissions.defaultMode を尊重するという意味。
    // ここで 'default' を補うと、その設定を黙って無視することになる
    const spawn = vi.fn()
    useWsStore.setState({ spawn })
    render(<SpawnForm disabled={false} />)

    await userEvent.type(screen.getByLabelText('作業ディレクトリ'), WORK_DIR)
    await userEvent.click(screen.getAllByTestId('spawn-button')[0])

    expect(spawn).toHaveBeenCalledWith(WORK_DIR, null)
  })

  it('作業ディレクトリが空のうちはどのボタンも押せない', () => {
    render(<SpawnForm disabled={false} />)
    for (const button of screen.getAllByTestId('spawn-button')) {
      expect(button).toBeDisabled()
    }
  })
})
