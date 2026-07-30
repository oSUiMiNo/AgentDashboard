import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelPicker } from './ModelPicker'
import type { SessionMeta } from '@/lib/protocol'
import { applySessionSnapshot, clearSessions, getSession } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

/**
 * セッション画面のモデル切替（テスト計画フェーズ5「表示」「切替」「購読の粒度」）。
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
    model: 'claude-opus-5',
    model_label: 'Opus 5',
    model_requested: null,
    status: { kind: 'working' },
    subagent_active: 0,
    last_activity_at: NOW,
    last_assistant_message: null,
    created_at: NOW,
    hooks_seen: true,
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
      available_modes: ['default'],
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

describe('ModelPicker', () => {
  it('いま動いているモデルを版番号つきで出す', () => {
    // 版番号は CLI が名乗った表示名から来る。値のほうを出すと
    // 「claude-opus-5」になってしまう（設計§12）
    applySessionSnapshot([meta(CARD)])
    render(<ModelPicker cardId={CARD} />)

    expect(screen.getByTestId('model-picker')).toHaveValue('claude-opus-5')
    expect(
      screen.getByRole('option', { name: 'Opus 5' }),
    ).toBeInTheDocument()
  })

  it('まだ名乗っていないときは「不明」と出す', () => {
    // 「モデルが無い」ではなく「まだ CLI が名乗っていない」。
    // 空欄にすると、その区別が画面から消える
    applySessionSnapshot([
      meta(CARD, { model: null, model_label: null }),
    ])
    render(<ModelPicker cardId={CARD} />)

    expect(screen.getByRole('option', { name: '不明' })).toBeInTheDocument()
  })

  it('選ぶとサーバへ切替を要求する', () => {
    const setModel = vi.fn()
    useWsStore.setState({ setModel })
    applySessionSnapshot([meta(CARD)])
    render(<ModelPicker cardId={CARD} />)

    return userEvent
      .selectOptions(screen.getByTestId('model-picker'), 'sonnet')
      .then(() => {
        expect(setModel).toHaveBeenCalledWith(CARD, 'sonnet')
      })
  })

  it('切替中は確定と見分けが付く', () => {
    // 楽観更新を確定と同じ顔で出すと、CLI が拒否したときに画面が嘘をつき続ける（設計§5）
    applySessionSnapshot([meta(CARD, { model_requested: 'sonnet' })])
    render(<ModelPicker cardId={CARD} />)

    const picker = screen.getByTestId('model-picker')
    expect(picker).toHaveAttribute('data-requested', 'sonnet')
    expect(picker).toHaveTextContent('へ切替中')
  })

  it('一度選んだ別名は、CLI が名乗った名前で出る', () => {
    // 括弧で併記せず置き換える（`Opus` ではなく `Opus 5`）
    useSettingsStore.setState({
      settings: {
        always_bypass_permissions: false,
        available_modes: ['default'],
        model_aliases: [
          { alias: 'opus', id: 'claude-opus-5', display_name: 'Opus 5' },
        ],
        model_catalog: [],
      },
      loading: false,
    })
    applySessionSnapshot([meta(CARD)])
    render(<ModelPicker cardId={CARD} />)

    // いま動いているモデルが別名で言い当てられるので、その行が選択状態になる。
    // 「現在値」の行を別に足すと `Opus 5` が2行並んで紛らわしい
    expect(screen.getByTestId('model-picker')).toHaveValue('opus')
    expect(screen.getAllByRole('option', { name: 'Opus 5' })).toHaveLength(1)
    // まだ選んでいない別名は素のまま（実測も対応表も無い）
    expect(screen.getByRole('option', { name: 'Sonnet' })).toBeInTheDocument()
  })

  it('一度も選んでいない別名にも、対応表があれば版番号が出る', () => {
    // 設計§13。CLI 自身から取り出した対応表で、使う前から版番号が分かる
    useSettingsStore.setState({
      settings: {
        always_bypass_permissions: false,
        available_modes: ['default'],
        model_aliases: [],
        model_catalog: [
          { id: 'claude-sonnet-5', family: 'sonnet', display_name: 'Sonnet 5' },
          { id: 'claude-haiku-4-5', family: 'haiku', display_name: 'Haiku 4.5' },
        ],
      },
      loading: false,
    })
    applySessionSnapshot([meta(CARD)])
    render(<ModelPicker cardId={CARD} />)

    expect(screen.getByRole('option', { name: 'Sonnet 5' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Haiku 4.5' })).toBeInTheDocument()
    // 解決先が状況で変わる別名には出さない
    expect(screen.getByRole('option', { name: '既定' })).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'プラン=Opus / 実行=Sonnet' }),
    ).toBeInTheDocument()
  })

  it('選択肢にマウスを乗せると説明が出る', () => {
    applySessionSnapshot([meta(CARD)])
    render(<ModelPicker cardId={CARD} />)

    expect(screen.getByRole('option', { name: 'Haiku' })).toHaveAttribute(
      'title',
      '軽い作業',
    )
    expect(
      screen.getByRole('option', { name: 'プラン=Opus / 実行=Sonnet' }),
    ).toHaveAttribute('title', expect.stringContaining('モードであって'))
  })

  it('表に無いモデルが来ても選択肢から消えない', () => {
    // 利用者が端末で直接フルIDを打った場合など。列挙型にしなかった理由そのもの
    applySessionSnapshot([
      meta(CARD, { model: 'claude-opus-4-6', model_label: 'Opus 4.6' }),
    ])
    render(<ModelPicker cardId={CARD} />)

    expect(screen.getByTestId('model-picker')).toHaveValue('claude-opus-4-6')
    expect(
      screen.getByRole('option', { name: 'Opus 4.6' }),
    ).toBeInTheDocument()
  })

  it('あるカードのモデルが変わっても、他のカードのオブジェクトは変わらない', () => {
    // 要件が名指しで心配している点。値をカードの外に置いた瞬間に壊れる
    applySessionSnapshot([meta(CARD), meta(OTHER)])
    const otherBefore = getSession(OTHER)

    applySessionSnapshot([
      meta(CARD, { model: 'claude-sonnet-5', model_label: 'Sonnet 5' }),
      meta(OTHER),
    ])

    expect(getSession(CARD)?.model).toBe('claude-sonnet-5')
    expect(getSession(OTHER)?.model).toBe('claude-opus-5')
    expect(otherBefore?.model).toBe('claude-opus-5')
  })
})
