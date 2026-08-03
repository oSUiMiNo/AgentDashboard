import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SpawnForm } from './SpawnForm'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'
import { settingsFixture } from '@/test/fixtures'

/**
 * 起動時の権限モードの選択（テスト計画フェーズ5「起動ボタン」）。
 *
 * 選択肢の顔ぶれがそのまま「どの権限モードで起動できるか」なので、**選択肢と、
 * 押したときにサーバへ渡る値**の両方を固定する。「指定なし」が `null` として渡ることが
 * 特に大事で、ここで `manual` を補うと利用者の `permissions.defaultMode` を無視することになる。
 *
 * トグルが決めるのは**既定の選択**であって、選択肢の数ではない。
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

/** 選択欄の値（`''` が「指定なし」）。 */
function modeSelect(): HTMLSelectElement {
  return screen.getByTestId('spawn-mode') as HTMLSelectElement
}

beforeEach(() => {
  setToggle(false)
})

describe('SpawnForm', () => {
  it('選択肢は3つで、既定は「スキップの指定は無し」', () => {
    render(<SpawnForm disabled={false} />)

    const options = Array.from(modeSelect().options).map(
      (option) => option.value,
    )
    expect(options).toEqual(['', 'acceptEdits', 'bypassPermissions'])
    expect(modeSelect().value).toBe('')
  })

  it('トグルが ON なら既定が「全承認をスキップ」になる（選択肢は減らない）', () => {
    // トグルは**既定を決めるだけ**。他のモードで起こす道は残す
    setToggle(true)
    render(<SpawnForm disabled={false} />)

    expect(modeSelect().value).toBe('bypassPermissions')
    expect(modeSelect().options).toHaveLength(3)
  })

  it('選んだモードでサーバへ起動を要求する', async () => {
    const spawn = vi.fn()
    useWsStore.setState({ spawn })
    render(<SpawnForm disabled={false} />)

    await userEvent.type(screen.getByLabelText('作業ディレクトリ'), WORK_DIR)

    await userEvent.selectOptions(modeSelect(), 'acceptEdits')
    await userEvent.click(screen.getByTestId('spawn-button'))
    // 宛先は null（繋がっている PC が1台以下なら選ばせない）
    expect(spawn).toHaveBeenCalledWith(WORK_DIR, 'acceptEdits', null)

    await userEvent.selectOptions(modeSelect(), 'bypassPermissions')
    await userEvent.click(screen.getByTestId('spawn-button'))
    expect(spawn).toHaveBeenCalledWith(WORK_DIR, 'bypassPermissions', null)
  })

  it('「指定なし」は null を渡す', async () => {
    // 利用者の permissions.defaultMode を尊重するという意味。
    // ここで 'default' を補うと、その設定を黙って無視することになる
    const spawn = vi.fn()
    useWsStore.setState({ spawn })
    render(<SpawnForm disabled={false} />)

    await userEvent.type(screen.getByLabelText('作業ディレクトリ'), WORK_DIR)
    await userEvent.click(screen.getByTestId('spawn-button'))

    expect(spawn).toHaveBeenCalledWith(WORK_DIR, null, null)
  })

  it('起動したら選択は既定へ戻る', async () => {
    // 前回の選択が残っていると、次の1本を**意図しないモードで起こす**。
    // トグルが ON の人にとっては「別のモードで1本だけ起こす」がそのまま成立する形になる
    setToggle(true)
    const spawn = vi.fn()
    useWsStore.setState({ spawn })
    render(<SpawnForm disabled={false} />)

    await userEvent.type(screen.getByLabelText('作業ディレクトリ'), WORK_DIR)
    await userEvent.selectOptions(modeSelect(), '')
    await userEvent.click(screen.getByTestId('spawn-button'))

    expect(spawn).toHaveBeenCalledWith(WORK_DIR, null, null)
    expect(modeSelect().value).toBe('bypassPermissions')
  })

  it('設定が後から届いても既定に反映される', async () => {
    // 設定は `GET /api/settings` の応答で後から来る。初期値を焼き込むと反映されない
    render(<SpawnForm disabled={false} />)
    expect(modeSelect().value).toBe('')

    act(() => setToggle(true))
    expect(modeSelect().value).toBe('bypassPermissions')

    // ただし利用者が選んだあとは、その選択が勝つ
    await userEvent.selectOptions(modeSelect(), 'acceptEdits')
    expect(modeSelect().value).toBe('acceptEdits')
  })

  it('作業ディレクトリが空のうちは起動できない', () => {
    render(<SpawnForm disabled={false} />)
    expect(screen.getByTestId('spawn-button')).toBeDisabled()
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
    await userEvent.click(screen.getByTestId('spawn-button'))
    expect(spawn).toHaveBeenCalledWith(WORK_DIR, null, null)
  })

  it('2台以上なら選ぶまで起動できない', async () => {
    // **既定を作らない。** 勝手に1台目を選ぶと、意図しない PC で本物の claude が起動する
    connect(2)
    const spawn = vi.fn()
    useWsStore.setState({ spawn })
    render(<SpawnForm disabled={false} />)

    await userEvent.type(screen.getByTestId('cwd-input'), WORK_DIR)
    expect(screen.getByTestId('spawn-button')).toBeDisabled()

    await userEvent.selectOptions(screen.getByTestId('spawn-target'), PC_B)
    await userEvent.click(screen.getByTestId('spawn-button'))
    expect(spawn).toHaveBeenCalledWith(WORK_DIR, null, PC_B)
  })
})
