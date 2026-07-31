import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PermissionModePicker } from './PermissionModePicker'
import type { SessionMeta } from '@/lib/protocol'
import { applySessionSnapshot, clearSessions, getSession } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

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
    settings: {
      always_bypass_permissions: false,
      available_modes: [
        'default',
        'acceptEdits',
        'plan',
        'auto',
        'dontAsk',
        'bypassPermissions',
      ],
      model_aliases: [],
      model_catalog: [],
    },
    loading: false,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearSessions()
})

describe('PermissionModePicker', () => {
  it('いまのモードが選ばれた状態で出る', () => {
    applySessionSnapshot([meta(CARD, { permission_mode: 'acceptEdits' })])
    render(<PermissionModePicker cardId={CARD} />)

    const picker = screen.getByTestId('permission-mode-picker')
    expect(picker).toHaveValue('acceptEdits')
    expect(picker.dataset.mode).toBe('acceptEdits')
  })

  it('まだ分からないときは「不明」と出す', () => {
    // 空欄にすると、利用者は何が起きているのか追えない
    applySessionSnapshot([meta(CARD, { permission_mode: null })])
    render(<PermissionModePicker cardId={CARD} />)

    expect(screen.getByTestId('permission-mode-picker')).toHaveValue('')
    expect(screen.getByRole('option', { name: '不明' })).toBeInTheDocument()
  })

  it('切替で到達できないモードには押す前に印を出す', () => {
    // 巡回に入るかどうかは起動条件とアカウントで変わる（設計§11）。
    // 選択肢からは外さず、分かることは押す前に出す
    applySessionSnapshot([meta(CARD)])
    render(<PermissionModePicker cardId={CARD} />)

    expect(
      screen.getByRole('option', { name: '確認しない（起動時にしか選べません）' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', {
        name: '全承認をスキップ（起動時に選んだ場合のみ）',
      }),
    ).toBeInTheDocument()
    // いつでも行けるものには何も足さない
    expect(screen.getByRole('option', { name: 'プラン' })).toBeInTheDocument()
  })

  it('選ぶとサーバへ切替を要求する', async () => {
    const setPermissionMode = vi.fn()
    useWsStore.setState({ setPermissionMode })
    applySessionSnapshot([meta(CARD)])
    render(<PermissionModePicker cardId={CARD} />)

    await userEvent.selectOptions(
      screen.getByTestId('permission-mode-picker'),
      'plan',
    )
    expect(setPermissionMode).toHaveBeenCalledWith(CARD, 'plan')
  })

  it('表に無いモードが来ても選択肢から消えない', () => {
    // CLI がモードを増やしても、いま何のモードかは出し続ける
    applySessionSnapshot([meta(CARD, { permission_mode: 'まだ知らないモード' })])
    render(<PermissionModePicker cardId={CARD} />)

    expect(screen.getByTestId('permission-mode-picker')).toHaveValue(
      'まだ知らないモード',
    )
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
