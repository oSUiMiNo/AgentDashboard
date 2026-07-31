import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SpawnForm } from './SpawnForm'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'
import { settingsFixture } from '@/test/fixtures'

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
    settings: settingsFixture({
      always_bypass_permissions: value,
      available_modes: ['default', 'acceptEdits', 'bypassPermissions'],
    }),
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
    // 宛先は null（繋がっている PC が1台以下なら選ばせない）
    expect(spawn).toHaveBeenCalledWith(WORK_DIR, 'acceptEdits', null)

    await userEvent.click(buttons[2])
    expect(spawn).toHaveBeenCalledWith(WORK_DIR, 'bypassPermissions', null)
  })

  it('「指定なし」は null を渡す', async () => {
    // 利用者の permissions.defaultMode を尊重するという意味。
    // ここで 'default' を補うと、その設定を黙って無視することになる
    const spawn = vi.fn()
    useWsStore.setState({ spawn })
    render(<SpawnForm disabled={false} />)

    await userEvent.type(screen.getByLabelText('作業ディレクトリ'), WORK_DIR)
    await userEvent.click(screen.getAllByTestId('spawn-button')[0])

    expect(spawn).toHaveBeenCalledWith(WORK_DIR, null, null)
  })

  it('作業ディレクトリが空のうちはどのボタンも押せない', () => {
    render(<SpawnForm disabled={false} />)
    for (const button of screen.getAllByTestId('spawn-button')) {
      expect(button).toBeDisabled()
    }
  })
})

describe('起動する PC の選択（セルフホスト化設計§5-1）', () => {
  const PC_A = '11111111-1111-1111-1111-111111111111'
  const PC_B = '22222222-2222-2222-2222-222222222222'

  function connect(count: number) {
    useSettingsStore.setState({
      settings: settingsFixture({
        agents: [
          { id: PC_A, name: '仕事用ノート', last_seen_at: 1, connected: true },
          { id: PC_B, name: '自宅デスクトップ', last_seen_at: 1, connected: true },
        ].slice(0, count),
      }),
      loading: false,
    })
  }

  it('繋がっているのが1台なら選ばせない', async () => {
    // 選ぶ余地が無いときに選択肢を出すと、迷わせるだけになる
    connect(1)
    const spawn = vi.fn()
    useWsStore.setState({ spawn })
    render(<SpawnForm disabled={false} />)

    expect(screen.queryByTestId('spawn-target')).toBeNull()
    await userEvent.type(screen.getByTestId('cwd-input'), WORK_DIR)
    await userEvent.click(screen.getAllByTestId('spawn-button')[0])
    expect(spawn).toHaveBeenCalledWith(WORK_DIR, null, null)
  })

  it('2台以上なら選ぶまで起動できない', async () => {
    // **既定を作らない。** 勝手に1台目を選ぶと、意図しない PC で本物の claude が起動する
    connect(2)
    const spawn = vi.fn()
    useWsStore.setState({ spawn })
    render(<SpawnForm disabled={false} />)

    await userEvent.type(screen.getByTestId('cwd-input'), WORK_DIR)
    for (const button of screen.getAllByTestId('spawn-button')) {
      expect(button).toBeDisabled()
    }

    await userEvent.selectOptions(screen.getByTestId('spawn-target'), PC_B)
    await userEvent.click(screen.getAllByTestId('spawn-button')[0])
    expect(spawn).toHaveBeenCalledWith(WORK_DIR, null, PC_B)
  })
})
