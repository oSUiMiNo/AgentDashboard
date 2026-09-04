import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PermissionModePicker } from './PermissionModePicker'
import type { SessionMeta } from '@/lib/protocol'
import { applySessionSnapshot, clearSessions, getSession } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'
import { settingsFixture } from '@/test/fixtures'

/**
 * セッション画面のモード切替（テスト計画フェーズ5「表示」「購読の粒度」）。
 *
 * 要件が名指しで心配している「1つ変えたら他も変わる」を、ここで固定する。値は
 * `SessionMeta` に載っていてカード単位で購読されるので、**置き場所を間違えなければ
 * 起きない**。逆に言えば、置き場所を変えたときにここが落ちる。
 */

const CARD = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-8888-7777-6666-555555555555'
const NOW = 1_700_000_000_000

function meta(cardId: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    card_id: cardId,
    project: '/home/example/dev/app',
    claude_session_id: null,
    permission_mode: 'default',
    model: null,
    model_label: null,
    model_requested: null,
    status: { kind: 'working' },
    subagent_active: 0,
    last_activity_at: NOW,
    last_assistant_message: null,
    created_at: NOW,
    hooks_seen: true,
    agent_id: null,
    agent_connected: true,
    account: null,
    toml_account: null,
    session_title: null,
    position: 0,
    nickname: null,
    branched_from: null,
    ...overrides,
  }
}

beforeEach(() => {
  clearSessions()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  useSettingsStore.setState({
    settings: settingsFixture({ always_bypass_permissions: false, available_modes: [
        'default',
        'acceptEdits',
        'plan',
        'auto',
        'dontAsk',
        'bypassPermissions',
      ] }),
    loading: false,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearSessions()
})

/**
 * 一覧を開く。**標準の `<select>` をやめたので `selectOptions` は使えない**
 * （帯の設計§4・案B）。jsdom で開くために必要な口は `src/test/setup.ts` が生やしている。
 */
async function 開く() {
  await userEvent.click(screen.getByTestId('permission-mode-picker'))
}

describe('PermissionModePicker', () => {
  it('閉じているときは、いまのモードだけが出る（括弧の補足を出さない）', () => {
    // **要件の後半そのもの。** 以前は `自動（環境によっては切り替えられません）` と
    // 補足まで出ていた。補足は「押す前に知りたいもの」であって、選び終わったあとに
    // 毎回読まされるものではない（帯の設計§4）
    applySessionSnapshot([meta(CARD, { permission_mode: 'auto' })])
    render(<PermissionModePicker cardId={CARD} />)

    const picker = screen.getByTestId('permission-mode-picker')
    expect(picker.dataset.mode).toBe('auto')
    expect(picker.textContent).not.toContain('（')
    expect(picker.textContent).not.toContain('環境によっては')
  })

  it('まだ分からないときは「不明」と出す', () => {
    // 空欄にすると、利用者は何が起きているのか追えない
    applySessionSnapshot([meta(CARD, { permission_mode: null })])
    render(<PermissionModePicker cardId={CARD} />)

    const picker = screen.getByTestId('permission-mode-picker')
    expect(picker).toHaveTextContent('不明')
    expect(picker.dataset.mode).toBe('')
  })

  it('開いたときだけ、到達できないモードに注意書きが並ぶ', async () => {
    // 巡回に入るかどうかは起動条件とアカウントで変わる（設計§11）。
    // 選択肢からは外さず、分かることは押す前に出す。
    //
    // **括弧は付けない**（帯の設計§4）。開いたときに選択肢の下へ小さく置くので、
    // 選んだあとの表示に紛れ込まない
    applySessionSnapshot([meta(CARD)])
    render(<PermissionModePicker cardId={CARD} />)
    await 開く()

    expect(
      screen.getByRole('option', { name: '確認しない' }),
    ).toHaveTextContent('起動時にしか選べません')
    expect(
      screen.getByRole('option', { name: '全承認をスキップ' }),
    ).toHaveTextContent('起動時に選んだ場合のみ')
    // いつでも行けるものには何も足さない
    expect(screen.getByRole('option', { name: 'プラン' })).toHaveTextContent(
      /^プラン$/,
    )
  })

  it('選ぶとサーバへ切替を要求する', async () => {
    const setPermissionMode = vi.fn()
    useWsStore.setState({ setPermissionMode })
    applySessionSnapshot([meta(CARD)])
    render(<PermissionModePicker cardId={CARD} />)

    await 開く()
    await userEvent.click(
      screen
        .getAllByTestId('permission-mode-option')
        .find((option) => option.dataset.value === 'plan')!,
    )
    expect(setPermissionMode).toHaveBeenCalledWith(CARD, 'plan')
  })

  it('表に無いモードが来ても選択肢から消えない', () => {
    // CLI がモードを増やしても、いま何のモードかは出し続ける
    applySessionSnapshot([meta(CARD, { permission_mode: 'まだ知らないモード' })])
    render(<PermissionModePicker cardId={CARD} />)

    const picker = screen.getByTestId('permission-mode-picker')
    expect(picker).toHaveTextContent('まだ知らないモード')
    expect(picker.dataset.mode).toBe('まだ知らないモード')
  })

  it('あるカードのモードが変わっても、他のカードのオブジェクトは変わらない', () => {
    // 要件が名指しで心配している点。値をカードの外に置いた瞬間に壊れる
    applySessionSnapshot([meta(CARD), meta(OTHER)])
    const otherBefore = getSession(OTHER)

    applySessionSnapshot([
      meta(CARD, { permission_mode: 'bypassPermissions' }),
      meta(OTHER),
    ])

    expect(getSession(CARD)?.permission_mode).toBe('bypassPermissions')
    expect(getSession(OTHER)?.permission_mode).toBe('default')
    expect(otherBefore?.permission_mode).toBe('default')
  })
})
