import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MachineCard } from '@/components/Settings/MachineCard'
import * as compact from '@/lib/compact'
import type { CompactView } from '@/lib/compact'

const GIB = 1024 * 1024 * 1024

/** 全部読めていて、いま押せる状態。ここから1つずつ崩す。 */
function 様子(上書き: Partial<CompactView> = {}): CompactView {
  return {
    alive_cards: 3,
    claude_procs: 0,
    interactive_shells: 0,
    in_window: true,
    slack_bytes: 80 * GIB,
    vhdx_bytes: 300 * GIB,
    last_compact: null,
    auto_enabled: false,
    auto_blocker: null,
    manual_blocker: null,
    ...上書き,
  }
}

describe('機械の区画', () => {
  let fetchView: ReturnType<typeof vi.spyOn>
  let run: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchView = vi
      .spyOn(compact, 'fetchCompactView')
      .mockResolvedValue(様子()) as never
    run = vi.spyOn(compact, 'runCompact').mockResolvedValue({
      kind: 'fired',
      view: 様子(),
    }) as never
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('空洞と最後に縮めた時刻と打てない理由の3つが出る', async () => {
    render(<MachineCard />)

    // **3つ揃って初めて押しどきが読める**（数字1つとボタン1つで終わらせない）
    await waitFor(() => expect(screen.getByTestId('machine')).toBeTruthy())
    expect(screen.getByTestId('machine-slack')).toHaveTextContent('80.0 GB')
    expect(screen.getByTestId('machine-last')).toBeTruthy()
    expect(screen.getByTestId('machine-blocker')).toBeTruthy()
  })

  it('仮想ディスクの合計も並べて出す', async () => {
    render(<MachineCard />)

    await waitFor(() => expect(screen.getByTestId('machine-slack')).toBeTruthy())
    // 空洞だけでは「全体の何割が無駄か」が読めない
    expect(screen.getByTestId('machine-slack')).toHaveTextContent('300.0 GB')
  })

  it('空洞が読めなければ区画ごと出さない', async () => {
    fetchView.mockResolvedValue(様子({ slack_bytes: null }) as never)
    render(<MachineCard />)

    // **「— GB」と出すと壊れているのと見分けが付かない**ので、まるごと消える
    await waitFor(() => expect(fetchView).toHaveBeenCalled())
    expect(screen.queryByTestId('machine')).toBeNull()
  })

  it('一度も縮めていなければ、そう言う', async () => {
    render(<MachineCard />)

    await waitFor(() => expect(screen.getByTestId('machine-last')).toBeTruthy())
    expect(screen.getByTestId('machine-last')).toHaveTextContent(
      'まだ一度も縮めていません',
    )
  })

  it('縮めた時刻があれば、いつかを出す', async () => {
    fetchView.mockResolvedValue(
      様子({ last_compact: Date.UTC(2026, 8, 14, 2, 30) }) as never,
    )
    render(<MachineCard />)

    await waitFor(() => expect(screen.getByTestId('machine-last')).toBeTruthy())
    expect(screen.getByTestId('machine-last')).toHaveTextContent('2026')
    expect(screen.getByTestId('machine-last')).not.toHaveTextContent(
      'まだ一度も',
    )
  })

  it('打てない理由があるとボタンが押せない', async () => {
    fetchView.mockResolvedValue(
      様子({ manual_blocker: '生きたセッションが 3 本あります' }) as never,
    )
    render(<MachineCard />)

    await waitFor(() => expect(screen.getByTestId('machine-compact')).toBeTruthy())
    expect(screen.getByTestId('machine-compact')).toBeDisabled()
    expect(screen.getByTestId('machine-blocker')).toHaveTextContent(
      '生きたセッションが 3 本あります',
    )
  })

  it('押すと確認が出て、何枚落ちるかの数が入る', async () => {
    render(<MachineCard />)
    await waitFor(() => expect(screen.getByTestId('machine-compact')).toBeTruthy())

    await userEvent.click(screen.getByTestId('machine-compact'))

    expect(screen.getByTestId('machine-compact-confirm')).toHaveTextContent(
      '3 枚',
    )
  })

  it('確認の文面に、claude が全部落ちることが書いてある', async () => {
    render(<MachineCard />)
    await waitFor(() => expect(screen.getByTestId('machine-compact')).toBeTruthy())

    await userEvent.click(screen.getByTestId('machine-compact'))

    // **この操作だけは装飾より文言が先。** 失うものを押す前に見せる
    expect(screen.getByTestId('machine-compact-confirm')).toHaveTextContent(
      '走っている claude が全部落ちます',
    )
  })

  it('やめると口を叩かない', async () => {
    render(<MachineCard />)
    await waitFor(() => expect(screen.getByTestId('machine-compact')).toBeTruthy())
    await userEvent.click(screen.getByTestId('machine-compact'))

    await userEvent.click(screen.getByTestId('machine-compact-cancel'))

    // **返り値ではなく呼び出し回数を見る。** 「やめた」と表示しつつ裏で叩いて
    // いても、返り値の検査は緑のまま通る（このイシューで3度目の形）
    expect(run).not.toHaveBeenCalled()
    expect(screen.queryByTestId('machine-compact-confirm')).toBeNull()
  })

  it('縮めるを押すと口を叩く', async () => {
    render(<MachineCard />)
    await waitFor(() => expect(screen.getByTestId('machine-compact')).toBeTruthy())
    await userEvent.click(screen.getByTestId('machine-compact'))

    await userEvent.click(screen.getByTestId('machine-compact-go'))

    expect(run).toHaveBeenCalledTimes(1)
    // 手で押すぶんは強行しない（道連れの判定はサーバに残す）
    expect(run).toHaveBeenCalledWith('local', false)
  })

  it('返事が返らなかったとき、失敗だと断定しない', async () => {
    run.mockResolvedValue({ kind: 'unknown' } as never)
    render(<MachineCard />)
    await waitFor(() => expect(screen.getByTestId('machine-compact')).toBeTruthy())
    await userEvent.click(screen.getByTestId('machine-compact'))

    await userEvent.click(screen.getByTestId('machine-compact-go'))

    // **縮小は自分を殺す操作**なので、線が切れたことは撃てた証拠でありうる
    await waitFor(() => expect(screen.getByTestId('machine-outcome')).toBeTruthy())
    const 結末 = screen.getByTestId('machine-outcome')
    expect(結末).toHaveTextContent('分かりません')
    expect(結末).not.toHaveTextContent('失敗しました')
  })

  it('断られたときは、その理由をそのまま出す', async () => {
    run.mockResolvedValue({
      kind: 'refused',
      reason: '生きたセッションが 2 本あります',
    } as never)
    render(<MachineCard />)
    await waitFor(() => expect(screen.getByTestId('machine-compact')).toBeTruthy())
    await userEvent.click(screen.getByTestId('machine-compact'))

    await userEvent.click(screen.getByTestId('machine-compact-go'))

    await waitFor(() => expect(screen.getByTestId('machine-outcome')).toBeTruthy())
    expect(screen.getByTestId('machine-outcome')).toHaveTextContent(
      '生きたセッションが 2 本あります',
    )
  })
})
