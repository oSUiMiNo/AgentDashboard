import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelPicker } from './ModelPicker'
import type { SessionMeta } from '@/lib/protocol'
import { applySessionSnapshot, clearSessions, getSession } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'
import { localModelTable, settingsFixture } from '@/test/fixtures'

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
    agent_id: null,
    agent_connected: true,
    account: null,
    toml_account: null,
    session_title: null,
    position: 0,
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
    settings: settingsFixture({ always_bypass_permissions: false, available_modes: ['default'] }),
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
  await userEvent.click(screen.getByTestId('model-picker'))
}

describe('ModelPicker', () => {
  it('閉じているときは、いま動いているモデルが版番号つきで出る', () => {
    // 版番号は CLI が名乗った表示名から来る。値のほうを出すと
    // 「claude-opus-5」になってしまう（設計§12）
    applySessionSnapshot([meta(CARD)])
    render(<ModelPicker cardId={CARD} />)

    const picker = screen.getByTestId('model-picker')
    expect(picker).toHaveTextContent('Opus 5')
    expect(picker.dataset.model).toBe('claude-opus-5')
  })

  it('まだ名乗っていないときは「不明」と出す', () => {
    // 「モデルが無い」ではなく「まだ CLI が名乗っていない」。
    // 空欄にすると、その区別が画面から消える
    applySessionSnapshot([
      meta(CARD, { model: null, model_label: null }),
    ])
    render(<ModelPicker cardId={CARD} />)

    expect(screen.getByTestId('model-picker')).toHaveTextContent('不明')
  })

  it('選ぶとサーバへ切替を要求する', async () => {
    const setModel = vi.fn()
    useWsStore.setState({ setModel })
    applySessionSnapshot([meta(CARD)])
    render(<ModelPicker cardId={CARD} />)

    await 開く()
    await userEvent.click(
      screen
        .getAllByTestId('model-option')
        .find((option) => option.dataset.value === 'sonnet')!,
    )
    expect(setModel).toHaveBeenCalledWith(CARD, 'sonnet')
  })

  it('切替中は確定と見分けが付く', () => {
    // 楽観更新を確定と同じ顔で出すと、CLI が拒否したときに画面が嘘をつき続ける（設計§5）
    applySessionSnapshot([meta(CARD, { model_requested: 'sonnet' })])
    render(<ModelPicker cardId={CARD} />)

    const picker = screen.getByTestId('model-picker')
    expect(picker).toHaveAttribute('data-requested', 'sonnet')
    expect(picker).toHaveTextContent('へ切替中')
  })

  it('切替中は選び直せない', () => {
    // 連打するとサーバ側でロック待ちの行列ができ、他のカードの切替まで後ろへずれる。
    // サーバも同じ理由で断るが、押せてしまう画面のままだと理由が分からない
    applySessionSnapshot([meta(CARD, { model_requested: 'sonnet' })])
    render(<ModelPicker cardId={CARD} />)

    expect(screen.getByTestId('model-picker')).toBeDisabled()
  })

  it('確定すればまた選べる', () => {
    applySessionSnapshot([meta(CARD, { model_requested: null })])
    render(<ModelPicker cardId={CARD} />)

    expect(screen.getByTestId('model-picker')).toBeEnabled()
  })

  it('一度選んだ別名は、CLI が名乗った名前で出る', async () => {
    // 括弧で併記せず置き換える（`Opus` ではなく `Opus 5`）
    useSettingsStore.setState({
      settings: settingsFixture({ always_bypass_permissions: false, available_modes: ['default'], ...localModelTable([
          { alias: 'opus', id: 'claude-opus-5', display_name: 'Opus 5' },
        ], []) }),
      loading: false,
    })
    applySessionSnapshot([meta(CARD)])
    render(<ModelPicker cardId={CARD} />)

    // **「現在値」の行はもう足していない**（帯の設計§4）。閉じたときに出す文字を
    // 自分で決められるので、`Opus 5` が2行並ぶ心配ごと消えた
    expect(screen.getByTestId('model-picker')).toHaveTextContent('Opus 5')
    await 開く()
    expect(screen.getAllByRole('option', { name: 'Opus 5' })).toHaveLength(1)
    // まだ選んでいない別名は素のまま（実測も対応表も無い）
    expect(screen.getByRole('option', { name: 'Sonnet' })).toBeInTheDocument()
  })

  it('一度も選んでいない別名にも、対応表があれば版番号が出る', async () => {
    // 設計§13。CLI 自身から取り出した対応表で、使う前から版番号が分かる
    useSettingsStore.setState({
      settings: settingsFixture({ always_bypass_permissions: false, available_modes: ['default'], ...localModelTable([], [
          { id: 'claude-sonnet-5', family: 'sonnet', display_name: 'Sonnet 5' },
          { id: 'claude-haiku-4-5', family: 'haiku', display_name: 'Haiku 4.5' },
        ]) }),
      loading: false,
    })
    applySessionSnapshot([meta(CARD)])
    render(<ModelPicker cardId={CARD} />)
    await 開く()

    expect(screen.getByRole('option', { name: 'Sonnet 5' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Haiku 4.5' })).toBeInTheDocument()
    // 解決先が状況で変わる別名には出さない
    expect(screen.getByRole('option', { name: '既定' })).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'プラン=Opus / 実行=Sonnet' }),
    ).toBeInTheDocument()
  })

  it('選択肢を開くと、説明がその場に並ぶ', async () => {
    // **以前は `title` に逃がしていた。** マウスを乗せないと読めない＝
    // **スマホでは誰にも読めなかった**（帯の設計§4）
    applySessionSnapshot([meta(CARD)])
    render(<ModelPicker cardId={CARD} />)
    await 開く()

    // **親（一覧の入れ物）ではなく選択肢そのものを見る。** 親は全部の選択肢を
    // 含むので、どこかに書いてあるだけで通ってしまう
    expect(screen.getByRole('option', { name: 'Haiku' })).toHaveTextContent(
      '軽い作業',
    )
    expect(
      screen.getByRole('option', { name: 'プラン=Opus / 実行=Sonnet' }),
    ).toHaveTextContent('モードであって')
  })

  it('表に無いモデルが来ても、いま何で動いているかは出し続ける', async () => {
    // 利用者が端末で直接フルIDを打った場合など。列挙型にしなかった理由そのもの。
    // **一覧には出ない**（切り替え先ではないため）が、閉じているときの表示は残る
    applySessionSnapshot([
      meta(CARD, { model: 'claude-opus-4-6', model_label: 'Opus 4.6' }),
    ])
    render(<ModelPicker cardId={CARD} />)

    const picker = screen.getByTestId('model-picker')
    expect(picker).toHaveTextContent('Opus 4.6')
    expect(picker.dataset.model).toBe('claude-opus-4-6')

    // 言い当てられないので、どの選択肢にも印は付かない
    await 開く()
    const 印の付いた選択肢 = screen
      .getAllByTestId('model-option')
      .filter((option) => option.dataset.state === 'checked')
    expect(印の付いた選択肢).toHaveLength(0)
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

describe('モデルの表は PC ごと（セルフホスト化設計§13-4）', () => {
  const PC = '11111111-1111-1111-1111-111111111111'

  it('そのセッションが属する PC の表を見る', async () => {
    // **1台ぶんで全部の選択肢を作ると、その PC に無いモデルが並ぶ。** CLI の版は
    // PC ごとに違うので、引くのは `agent_id` の表（ローカルは `"local"`）
    useSettingsStore.setState({
      settings: settingsFixture({
        model_tables: {
          local: {
            aliases: [
              { alias: 'opus', id: 'claude-opus-4', display_name: 'Opus 4' },
            ],
          },
          [PC]: {
            aliases: [
              { alias: 'opus', id: 'claude-opus-5', display_name: 'Opus 5' },
            ],
          },
        },
      }),
      loading: false,
    })
    applySessionSnapshot([meta(CARD, { agent_id: PC })])

    render(<ModelPicker cardId={CARD} />)
    await userEvent.click(screen.getByTestId('model-picker'))

    const labels = screen
      .getAllByRole('option')
      .map((option) => option.textContent ?? '')
      .join('\n')
    expect(labels).toContain('Opus 5')
    // **手元（ローカル）の表は混ざらない**
    expect(labels).not.toContain('Opus 4\n')
  })
})
