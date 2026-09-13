import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '@/components/Settings/SettingsPage'
import { remoteAgent, settingsFixture } from '@/test/fixtures'
import { useSettingsStore, type Settings } from '@/stores/settings'
import { loadStats } from '@/lib/stats'

/*
  活動の記録は PC のファイルを読む。**通信させない。**

  **既定を「読めなかった」にしてある**——非公開の内部ファイルなので、
  **読めない環境のほうが普通**である。読めた場合を見たいテストだけが差し替える。
*/
vi.mock('@/lib/stats', async (実物) => ({
  ...(await 実物<typeof import('@/lib/stats')>()),
  loadStats: vi.fn(() => Promise.resolve(null)),
}))

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

/**
 * 一覧の動き（カード設計§9-5-2）。
 *
 * **画面の中に止める道が要る。** 規範は「5秒を超えて自動的に動くものには一時停止・
 * 停止・非表示の手段」を要求しており、達成手段の一覧に OS 設定は1つも入っていない。
 * この道具は配る前提なので、「自分は該当しないから要らない」が成り立たない。
 */
describe('一覧の動き', () => {
  beforeEach(() => {
    vi.spyOn(useSettingsStore.getState(), 'load').mockResolvedValue(undefined)
  })

  /** 選択肢を、出ている順に読む。 */
  function choices(): string[] {
    return Array.from(
      screen.getByTestId('motion-quiet-select').querySelectorAll('option'),
      (option) => option.value,
    )
  }

  it('3段が、静かになっていく順で並ぶ', () => {
    // **一時停止ボタン1つだと「全部止める」しか選べない**——止めると承認待ちまで
    // 止まり、いちばん見つけたいものの合図を失う
    show()

    expect(choices()).toEqual(['lively', 'calm', 'still'])
  })

  it('既定は賑やか', () => {
    // 画は変えない。12枚の輪が回る画面は要望そのもの（設計§9-6-2）
    show()

    expect(screen.getByTestId('motion-quiet-select')).toHaveValue('lively')
  })

  it('日本語で読める形で出る', () => {
    show()

    expect(screen.getByRole('option', { name: '控えめ' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '静止' })).toBeInTheDocument()
  })

  it('選ぶと、その項目だけを送る', async () => {
    const update = vi.fn().mockResolvedValue(true)
    useSettingsStore.setState({ update })
    show()

    await userEvent.selectOptions(
      screen.getByTestId('motion-quiet-select'),
      'calm',
    )

    // **数値へ決め打ちで変換していないこと。** していれば `NaN` が飛ぶ
    expect(update).toHaveBeenCalledWith({ motion_quiet: 'calm' })
  })

  it('いま効いている段が選ばれた状態で出る', () => {
    show({ motion_quiet: 'still' })

    expect(screen.getByTestId('motion-quiet-select')).toHaveValue('still')
  })

  it('OS 設定のほうが強いことを、画面にも書いてある', () => {
    // 段で覆せるようにしていない（要件の完了条件が無条件）。**選べるのに効かない**
    // という形になるので、そう書いておかないと不具合に見える
    show()

    expect(
      screen.getByText(/OS の「動きを減らす」設定を入れている間は/),
    ).toBeInTheDocument()
  })
})

describe('メモの保持（要件10）', () => {
  /** その選択の `<option>` の値を並べる。 */
  function 選択肢(testId: string): string[] {
    return Array.from(
      screen.getByTestId(`${testId}-select`).querySelectorAll('option'),
    ).map((option) => option.value)
  }

  it('**「無期限」を作らない。** 期間の上限は12か月である', () => {
    /*
      要件10 が明記している——**「これはあくまで作業のための一時的なメモ機能なので
      無期限と無制限は必要無い」**。

      **選択肢に足しても画面は動く**ので、機械は何も言わない。ここで固定する。
    */
    show()

    const 日数 = 選択肢('memo-retention').map(Number)
    expect(日数.length).toBeGreaterThan(0)
    // **12か月 = 360日**（この道具は1か月を30日として数える）。365 にすると
    // 面に「365日で消えます」と出て、要件の言い方と食い違う
    expect(Math.max(...日数)).toBe(360)
    expect(日数.every((日) => 日 > 0 && 日 <= 360)).toBe(true)
  })

  it('**「無制限」を作らない。** 容量の上限は 20GB である', () => {
    show()

    const バイト = 選択肢('memo-max-bytes').map(Number)
    expect(バイト.length).toBeGreaterThan(0)
    expect(Math.max(...バイト)).toBe(20 * 1024 * 1024 * 1024)
    expect(バイト.every((b) => b > 0)).toBe(true)
  })

  it('いま効いている値が選ばれた状態で出る', () => {
    show({ memo_limits: { retention_days: 30, max_bytes: 5 * 1024 * 1024 * 1024 } })

    expect(screen.getByTestId('memo-retention-select')).toHaveValue('30')
    expect(screen.getByTestId('memo-max-bytes-select')).toHaveValue(
      String(5 * 1024 * 1024 * 1024),
    )
  })

  it('選ぶと、その項目だけを送る', async () => {
    const update = vi.fn().mockResolvedValue(true)
    useSettingsStore.setState({ update })
    show()

    await userEvent.selectOptions(screen.getByTestId('memo-retention-select'), '30')

    // **触っていない項目を送らない**（他のタブの変更を巻き戻さないため）
    expect(update).toHaveBeenCalledWith({ memo_retention_days: 30 })
  })

  it('期間は「N か月」で読める（メモの面の文言と綴りを揃える）', () => {
    show()

    // **面には「N か月で消えます」と出る。** ここが「90日」だと、同じものが
    // 2つの言い方で出ることになる
    expect(screen.getByRole('option', { name: '3か月' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '12か月' })).toBeInTheDocument()
  })
})

describe('この機械の使用上限（status 完了条件1）', () => {
  beforeEach(() => {
    vi.spyOn(useSettingsStore.getState(), 'load').mockResolvedValue(undefined)
  })

  /** いまから1時間後に戻る窓。**過ぎていない材料**を作るために未来を指す。 */
  function future(percent: number, name = 'five_hour') {
    return { name, used_percentage: percent, resets_at: Math.floor(Date.now() / 1000) + 3600 }
  }

  it('使用率が数字として読める（帯だけでは完了条件1 が落ちる）', () => {
    // **帯は `aria-hidden` の装飾なので、帯の有無を見ても「読める」ことは確かめられない。**
    // PC の一覧の点には「点が言っていることを文字で二度言わない」という約束があるが、
    // **あれは点が2値だから冗長**なのであって、連続値の帯は正確な割合を伝えない。
    // 写すと数字が落ち、**それでも make ci は緑になる**——だからこのテストが要る
    show({ machine_rate_limits: { windows: [future(41)] } })

    expect(screen.getByTestId('rate-limit-percent')).toHaveTextContent('41%')
  })

  it('過ぎていない窓のリセット時刻も読める', () => {
    // **「リセット済み」のテストだけ置くと空振りする。** パーセントだけ並べて
    // 期限切れ時だけ「リセット済み」と出す画面は、他の項目を全部満たしながら
    // 完了条件1（使用率**とリセット時刻**が読める）を落とす
    show({ machine_rate_limits: { windows: [future(41)] } })

    const reset = screen.getByTestId('rate-limit-reset')
    expect(reset).toHaveTextContent('で戻ります')
    expect(reset).not.toHaveTextContent('リセット済み')
  })

  it('ローカルモード（PC が1台も無い）でこそ出る', () => {
    // **実機はローカルモードである。** セルフホストの「PC の一覧の各行」だけに
    // 出す形だと、実機では1つも読めない（`no_agents()` が行を作らない）
    show({ agents: [], machine_rate_limits: { windows: [future(41)] } })

    expect(screen.getByTestId('rate-limits')).toHaveAttribute('data-known', 'true')
  })

  it('PC が繋がっている構成では、ここには出さない（出し先は排他）', () => {
    // **同じ数字が画面に2枚並ばないこと。** セルフホストでは PC の一覧の各行に
    // 出るので、ここへも出すと同じ値が2箇所に見える
    show({
      ...remoteAgent('bbbbbbbb-0000-0000-0000-000000000002', '別の PC'),
      machine_rate_limits: { windows: [future(41)] },
    })

    expect(screen.queryByTestId('rate-limits')).toBeNull()
  })

  it('まだ届いていないときは、0% と別に描く', () => {
    // 届く形が同じなので、0% と区別できないと「使っていない」に見える——
    // 実際は「まだ分からない」である
    show({ machine_rate_limits: null })

    expect(screen.getByTestId('rate-limits')).toHaveAttribute('data-known', 'false')
  })

  it('近似の断りが、この画面に1つだけ出る', () => {
    // **画面ごとに一箇所。** 部品ごとに書くと同じ断りが何度も出るが、**画面をまたぐと
    // 同時に目に入らない**ので、画面ごとには1つ要る（費用＝カードの区画／
    // 使用上限と活動の記録＝この画面）。**1つだけであることを数える**——
    // 部品ごとに足す実装へ戻ると2つ以上になる
    show({ agents: [], machine_rate_limits: { windows: [future(41)] } })

    expect(screen.getAllByTestId('approx-note')).toHaveLength(1)
  })

  it('概算であることと、請求と違うことが文字で読める', () => {
    // **`title` に頼らない。** ホバーでしか読めず、狭い窓とタッチでは読めない。
    // **要素を先に取る**——`?.textContent` の形で書くと、要素が無いとき `undefined` が
    // 返って検査が素通りする（フェーズ6 で空振りを1件踏んだ）。
    // **語1つではなく句で見る**——「概算」だけだと、請求との違いを消しても通る
    show({ agents: [], machine_rate_limits: { windows: [future(41)] } })

    const note = screen.getByTestId('approx-note')
    expect(note).toHaveTextContent('概算')
    expect(note).toHaveTextContent('実際の請求とは異なります')
  })

  it('PC が繋がっている構成では、断りも出さない（覆う数字がここに無い）', () => {
    // **断りだけが残らないこと。** 使用上限と活動の記録は `hasRemote` で排他なので、
    // 断りも同じ条件でなければ「何も無い画面に断りだけ」という形になる
    show({
      ...remoteAgent('bbbbbbbb-0000-0000-0000-000000000002', '別の PC'),
      machine_rate_limits: { windows: [future(41)] },
    })

    expect(screen.queryByTestId('approx-note')).toBeNull()
  })
})

describe('活動の記録', () => {
  const 記録 = {
    lastComputedDate: '2026-09-08',
    totalSessions: 412,
    totalMessages: 9001,
    dailyActivity: [
      { date: '2026-09-08', messageCount: 50, sessionCount: 5, toolCallCount: 200 },
    ],
    modelUsage: [
      {
        model: 'claude-sonnet-4-5-20250929',
        totals: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 50,
          cacheCreationInputTokens: 10,
        },
      },
    ],
  }

  beforeEach(() => {
    vi.spyOn(useSettingsStore.getState(), 'load').mockResolvedValue(undefined)
    // **既定へ戻す。** 前のテストが差し替えたまま残ると、読めない側の検査が空振りする
    vi.mocked(loadStats).mockResolvedValue(null)
    // **呼び出しの履歴も消す。** `mockResolvedValue` は戻り値を替えるだけなので、
    // 消さないと**他の describe のぶんまで数えてしまい**「呼ばれていない」が成り立たない
    vi.mocked(loadStats).mockClear()
  })

  it('読めたら区画が出る', async () => {
    vi.mocked(loadStats).mockResolvedValue(記録)
    show()

    // **描画は非同期。** `useEffect` の解決を待たないと、まだ `null` のまま見ることになる
    expect(await screen.findByTestId('stats-panel')).toBeInTheDocument()
    expect(screen.getByTestId('stats-total-sessions').textContent).toBe('412')
  })

  it('読めなかったら区画ごと出さない', async () => {
    show()

    // **枠も見出しも出さない。** 部品だけ黙っても、空の枠が残ると「壊れている」に見える
    await waitFor(() => {
      expect(vi.mocked(loadStats)).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('stats-panel')).toBeNull()
    expect(screen.queryByText('活動の記録')).toBeNull()
  })

  it('別の PC が繋がっている構成では読みに行かない', async () => {
    show(remoteAgent('pc-1', 'OMEN'))

    // **どの機械の記録かが一意に決まらない**ので、選ばせる問いを作らずに出さない。
    // 使用上限の区画と同じ `hasRemote` で分けてある
    await waitFor(() => {
      expect(screen.getByTestId('settings-page')).toBeInTheDocument()
    })
    expect(vi.mocked(loadStats)).not.toHaveBeenCalled()
    expect(screen.queryByTestId('stats-panel')).toBeNull()
  })
})
