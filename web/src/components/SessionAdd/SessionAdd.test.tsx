import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionAdd } from './SessionAdd'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'
import { settingsFixture } from '@/test/fixtures'

/**
 * 枠から1本起こすときの権限モード（初期実装 設計§8。テスト計画フェーズ5「起動ボタン」）。
 *
 * 起動の入口が「PJT を追加」へ移り、**危険度の判断が要る瞬間はここだけ**になった。
 * 選択肢の顔ぶれがそのまま「どの権限モードで起動できるか」なので、選択肢と、
 * 押したときにサーバへ渡る値の両方を固定する。「指定なし」が `null` として渡ることが
 * 特に大事で、ここで `manual` を補うと利用者の `permissions.defaultMode` を無視することになる。
 *
 * トグルが決めるのは**既定の選択**であって、選択肢の数ではない。
 */

const PROJECT = '/home/example/dev/app'
const PC = '11111111-1111-1111-1111-111111111111'

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

/** 「＋」を押して、モードを選べる状態にする。 */
async function open(host = 'local') {
  render(<SessionAdd host={host} project={PROJECT} />)
  await userEvent.click(screen.getByTestId('spawn-open'))
}

beforeEach(() => {
  setToggle(false)
  useWsStore.setState({ status: 'open' })
})

describe('枠からセッションを起こす', () => {
  it('選択肢は3つで、既定は「スキップの指定は無し」', async () => {
    await open()

    const options = Array.from(modeSelect().options).map((option) => option.value)
    expect(options).toEqual(['', 'acceptEdits', 'bypassPermissions'])
    expect(modeSelect().value).toBe('')
  })

  it('トグルが ON なら既定が「全承認をスキップ」になる（選択肢は減らない）', async () => {
    // トグルは**既定を決めるだけ**。他のモードで起こす道は残す
    setToggle(true)
    await open()

    expect(modeSelect().value).toBe('bypassPermissions')
    expect(modeSelect().options).toHaveLength(3)
  })

  it('選んだモードと、枠が持つ宛先でサーバへ起動を要求する', async () => {
    const spawn = vi.fn()
    useWsStore.setState({ spawn })
    await open(PC)

    await userEvent.selectOptions(modeSelect(), 'acceptEdits')
    await userEvent.click(screen.getByTestId('spawn-button'))

    // 作業ディレクトリと宛先は**枠が持っている**（打ち込ませない）
    expect(spawn).toHaveBeenCalledWith(PROJECT, 'acceptEdits', PC)
  })

  it('ローカルは宛先として指名しない', async () => {
    const spawn = vi.fn()
    useWsStore.setState({ spawn })
    await open('local')

    await userEvent.click(screen.getByTestId('spawn-button'))

    // ローカルモードには PC という単位が無い。指名するとサーバが断る
    expect(spawn).toHaveBeenCalledWith(PROJECT, null, null)
  })

  it('「指定なし」は null を渡す', async () => {
    // 利用者の permissions.defaultMode を尊重するという意味。
    // ここで 'default' を補うと、その設定を黙って無視することになる
    const spawn = vi.fn()
    useWsStore.setState({ spawn })
    await open(PC)

    await userEvent.click(screen.getByTestId('spawn-button'))

    expect(spawn).toHaveBeenCalledWith(PROJECT, null, PC)
  })

  it('起動したら選択は既定へ戻る', async () => {
    // 前回の選択が残っていると、次の1本を**意図しないモードで起こす**。
    // トグルが ON の人にとっては「別のモードで1本だけ起こす」がそのまま成立する形になる
    setToggle(true)
    useWsStore.setState({ spawn: vi.fn() })
    await open(PC)

    await userEvent.selectOptions(modeSelect(), '')
    await userEvent.click(screen.getByTestId('spawn-button'))

    // 畳まれるので、開き直して見る
    await userEvent.click(screen.getByTestId('spawn-open'))
    expect(modeSelect().value).toBe('bypassPermissions')
  })

  it('設定が後から届いても既定に反映される', async () => {
    // 設定は `GET /api/settings` の応答で後から来る。初期値を焼き込むと反映されない
    await open(PC)
    expect(modeSelect().value).toBe('')

    act(() => setToggle(true))
    expect(modeSelect().value).toBe('bypassPermissions')

    // ただし利用者が選んだあとは、その選択が勝つ
    await userEvent.selectOptions(modeSelect(), 'acceptEdits')
    expect(modeSelect().value).toBe('acceptEdits')
  })

  it('繋がっていないうちは起こせない', async () => {
    useWsStore.setState({ status: 'connecting' })
    render(<SessionAdd host={PC} project={PROJECT} />)

    expect(screen.getByTestId('spawn-open')).toBeDisabled()
  })
})
