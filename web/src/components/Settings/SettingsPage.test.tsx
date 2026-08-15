import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '@/components/Settings/SettingsPage'
import { remoteAgent, settingsFixture } from '@/test/fixtures'
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

describe('PJT を追加したらセッションを1本起こす', () => {
  beforeEach(() => {
    vi.spyOn(useSettingsStore.getState(), 'load').mockResolvedValue(undefined)
  })

  it('既定は OFF', () => {
    // 枠を置くことと作業を始めることは別の意思なので、押していない側が既定
    // （イシューグループ_2026_0805_0514 §12）
    show()
    expect(screen.getByTestId('project-autostart-toggle')).not.toBeChecked()
  })

  it('記録が ON なら入った状態で出る', () => {
    show({ project_autostart_session: true })
    expect(screen.getByTestId('project-autostart-toggle')).toBeChecked()
  })

  it('押すと、その項目だけを送る', async () => {
    // 1項目のために全部を送り直すと、別のタブで開いている変更を巻き戻す
    const update = vi.fn().mockResolvedValue(true)
    useSettingsStore.setState({ update })
    show()

    await userEvent.click(screen.getByTestId('project-autostart-toggle'))

    expect(update).toHaveBeenCalledWith({ project_autostart_session: true })
  })

  it('読み込み中は押せない', () => {
    useSettingsStore.setState({
      settings: settingsFixture(),
      loading: true,
      lastError: null,
    })
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('project-autostart-toggle')).toBeDisabled()
  })
})

/**
 * 画面の更新間隔（要件「0.05秒と1秒の間が20倍空いている」）。
 *
 * **PC を1台繋いだ状態で描くこと。** この欄は繋がっている PC が無いと**欄ごと出ない**
 * （ローカルモードには画面配信そのものが無い）ので、素の雛形では1つも見つからない。
 */
describe('画面の更新間隔', () => {
  beforeEach(() => {
    vi.spyOn(useSettingsStore.getState(), 'load').mockResolvedValue(undefined)
  })

  /** 選択肢のミリ秒を、出ている順に読む。 */
  function choices(): string[] {
    return Array.from(
      screen.getByTestId('screen-interval-select').querySelectorAll('option'),
      (option) => option.value,
    )
  }

  it('0.05秒 と 1秒 の間に 0.3秒 が入る', () => {
    // **並びが要点。** 末尾に足すと、粗い側の途中に細かい値が現れて選びにくくなる
    show(remoteAgent('pc-1', 'OMEN'))

    expect(choices()).toEqual(['50', '300', '1000', '5000', '10000', '20000'])
  })

  it('0.3秒 と読める形で出る', () => {
    // ミリ秒のまま出すと、20秒 と桁が揃わず比べられない
    show(remoteAgent('pc-1', 'OMEN'))

    expect(screen.getByRole('option', { name: '0.3秒' })).toBeInTheDocument()
  })

  it('選ぶと、その項目だけを送る', async () => {
    const update = vi.fn().mockResolvedValue(true)
    useSettingsStore.setState({ update })
    show(remoteAgent('pc-1', 'OMEN'))

    await userEvent.selectOptions(
      screen.getByTestId('screen-interval-select'),
      '300',
    )

    expect(update).toHaveBeenCalledWith({ screen_interval_ms: 300 })
  })

  it('いま効いている値が選ばれた状態で出る', () => {
    // **足すだけで既定は動かさない**（要件「やらないこと」）。既定そのものは
    // サーバ側で固定してあるので（`db::settings` の `選択肢を足しても既定は動かない`）、
    // ここは渡された値をそのまま選んでいることを見る
    show(remoteAgent('pc-1', 'OMEN'))

    expect(screen.getByTestId('screen-interval-select')).toHaveValue('20000')
  })

  it('選択肢に無い値でも、黙って別の値を選んだ顔をしない', () => {
    // 設定ファイルや CLI から入った値・別の版で選んだ値は、選択肢に無いことがある。
    // **先頭に足して出す**ので、既に 0.3秒 を手で入れていた人の画面も壊れない
    // （要件「選択肢に無い値でも壊れない作りになっている」）
    show({
      ...remoteAgent('pc-1', 'OMEN'),
      intervals: {
        sync_interval_secs: 20,
        screen_interval_ms: 777,
        scrollback_lines: 1000,
      },
    })

    expect(choices()[0]).toBe('777')
    expect(screen.getByTestId('screen-interval-select')).toHaveValue('777')
  })
})
