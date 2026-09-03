import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionAdd } from './SessionAdd'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'
import type { PastSession } from '@/lib/protocol'
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
  // 既定では過去のセッションを引けない形にしておく（引く道を試すテストが自分で差し替える）
  vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, json: () => Promise.resolve([]) }))
})

afterEach(() => {
  vi.unstubAllGlobals()
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

/**
 * 過去のセッションから起こす（名前付け設計§9-4。テスト計画フェーズ5「過去から起こす」）。
 *
 * **開いたときに1回だけ引く**のが要点。実在を確かめるのに PC へ問い合わせが出るので、
 * 開くたびに引くと、一覧を開き閉じするだけで問い合わせが積み上がる。
 */

const 過去 = (extra: Partial<PastSession> = {}): PastSession => ({
  claude_session_id: '22222222-2222-2222-2222-222222222222',
  nickname: null,
  session_title: null,
  project: PROJECT,
  agent_id: null,
  permission_mode: null,
  last_activity_at: 1,
  exists: true,
  ...extra,
})

/** `GET /api/sessions/past` の答えを差し替え、呼ばれた回数を数える。 */
function 過去を返す(rows: PastSession[]) {
  const calls = { count: 0 }
  vi.stubGlobal('fetch', (path: string) => {
    if (path === '/api/sessions/past') calls.count += 1
    return Promise.resolve({ ok: true, json: () => Promise.resolve(rows) })
  })
  return calls
}

describe('過去のセッションから起こす', () => {
  it('開いたときに1回だけ引く', async () => {
    const calls = 過去を返す([過去()])
    render(<SessionAdd host="local" project={PROJECT} />)
    await userEvent.click(screen.getByTestId('spawn-open'))
    await screen.findByTestId('spawn-past')

    // 閉じて開き直しても引き直さない（問い合わせを積み上げない）
    await userEvent.click(screen.getByTestId('spawn-cancel'))
    await userEvent.click(screen.getByTestId('spawn-open'))
    await screen.findByTestId('spawn-past')

    expect(calls.count).toBe(1)
  })

  it('名前があればそれ、無ければ CLI の名前が出る', async () => {
    過去を返す([
      過去({
        claude_session_id: 'aaaaaaaa-0000-0000-0000-000000000000',
        nickname: 'あとで直すやつ',
        session_title: 'TODOを完了に変更する',
      }),
      過去({
        claude_session_id: 'bbbbbbbb-0000-0000-0000-000000000000',
        session_title: 'CLI が付けた名前',
      }),
    ])
    render(<SessionAdd host="local" project={PROJECT} />)
    await userEvent.click(screen.getByTestId('spawn-open'))
    const picker = await screen.findByTestId('spawn-past')

    // **利用者の名前が CLI の名前より優先される**
    expect(picker.textContent).toContain('あとで直すやつ')
    expect(picker.textContent).not.toContain('TODOを完了に変更する')
    expect(picker.textContent).toContain('CLI が付けた名前')
  })

  it('確かめていないものは、そう分かる形で出て、選べる', async () => {
    // **「確かめていない」を「無い」と混同しない**（設計§8-5）。PC が寝ているだけで
    // 無いとは限らないので、消さずに印を添える
    過去を返す([過去({ nickname: '寝ている PC のやつ', exists: null })])
    render(<SessionAdd host="local" project={PROJECT} />)
    await userEvent.click(screen.getByTestId('spawn-open'))
    const picker = (await screen.findByTestId('spawn-past')) as HTMLSelectElement

    expect(picker.textContent).toContain('（未確認）')
    const option = Array.from(picker.options).find((entry) =>
      entry.textContent?.includes('寝ている PC のやつ'),
    )
    expect(option?.disabled).toBe(false)
  })

  it('選んで押すと、作業ディレクトリを運ばずに呼び戻す', async () => {
    const recall = vi.fn()
    useWsStore.setState({ recall })
    const session = 'cccccccc-0000-0000-0000-000000000000'
    過去を返す([過去({ claude_session_id: session, nickname: '呼び戻すやつ' })])

    render(<SessionAdd host="local" project={PROJECT} />)
    await userEvent.click(screen.getByTestId('spawn-open'))
    const picker = await screen.findByTestId('spawn-past')
    await userEvent.selectOptions(picker, session)
    // ボタンの言葉も変わる（何が起きるかを押す前に伝える）
    expect(screen.getByTestId('spawn-button').textContent).toBe('呼び戻す')
    await userEvent.click(screen.getByTestId('spawn-button'))

    // **`project` を渡していない。** 作業ディレクトリはサーバの記録が持っている
    expect(recall).toHaveBeenCalledWith(session, null, null)
  })

  it('権限モードは選び直せる', async () => {
    // 記録に残っているモードは**既定でしかない**（設計§9-4）
    const recall = vi.fn()
    useWsStore.setState({ recall })
    const session = 'dddddddd-0000-0000-0000-000000000000'
    過去を返す([
      過去({
        claude_session_id: session,
        nickname: '記録は指定なし',
        permission_mode: null,
      }),
    ])

    render(<SessionAdd host="local" project={PROJECT} />)
    await userEvent.click(screen.getByTestId('spawn-open'))
    await userEvent.selectOptions(
      await screen.findByTestId('spawn-past'),
      session,
    )
    await userEvent.selectOptions(modeSelect(), 'acceptEdits')
    await userEvent.click(screen.getByTestId('spawn-button'))

    expect(recall).toHaveBeenCalledWith(session, 'acceptEdits', null)
  })

  it('別の枠のセッションは出ない', async () => {
    // 枠の「＋」は「この PJT で起こす」操作。別の PJT のものを出すと、
    // 押した先に別の枠のカードができる
    過去を返す([
      過去({ nickname: 'この枠のやつ' }),
      過去({
        claude_session_id: 'eeeeeeee-0000-0000-0000-000000000000',
        nickname: 'よその枠のやつ',
        project: '/home/example/dev/other',
      }),
    ])
    render(<SessionAdd host="local" project={PROJECT} />)
    await userEvent.click(screen.getByTestId('spawn-open'))
    const picker = await screen.findByTestId('spawn-past')

    expect(picker.textContent).toContain('この枠のやつ')
    expect(picker.textContent).not.toContain('よその枠のやつ')
  })

  it('過去が1本も無ければ、選ぶところ自体を出さない', async () => {
    過去を返す([])
    render(<SessionAdd host="local" project={PROJECT} />)
    await userEvent.click(screen.getByTestId('spawn-open'))
    await screen.findByTestId('spawn-button')

    expect(screen.queryByTestId('spawn-past')).toBeNull()
  })
})
