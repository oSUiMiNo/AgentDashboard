import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatsPanel } from '@/components/Stats/StatsPanel'
import type { Stats } from '@/lib/stats'

/**
 * 活動の記録の画面（テスト計画 フェーズ6）。
 *
 * **この段の項目は失敗側に偏っている。** 「読めなければ出さない」だけを確かめると
 * **何も描かない実装でも通る**ので、**「読めたときに出る」を対で置く。**
 */

function 記録(extra: Partial<Stats> = {}): Stats {
  return {
    lastComputedDate: '2026-09-08',
    totalSessions: 412,
    totalMessages: 9001,
    dailyActivity: [
      { date: '2026-09-08', messageCount: 50, sessionCount: 5, toolCallCount: 200 },
      { date: '2026-09-07', messageCount: 30, sessionCount: 3, toolCallCount: 120 },
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
    ...extra,
  }
}

describe('活動の記録', () => {
  it('読めたときに、日ごとのやりとりとモデルごとのトークンが出る', () => {
    render(<StatsPanel stats={記録()} />)

    // **これが無いと、何も描かない実装でも緑になる**
    expect(screen.getAllByTestId('stats-day')).toHaveLength(2)
    expect(screen.getAllByTestId('stats-model')).toHaveLength(1)
    expect(screen.getByTestId('stats-total-sessions').textContent).toBe('412')
    expect(screen.getByTestId('stats-total-messages').textContent).toBe('9,001')
  })

  it('読めなかったら面ごと出さない', () => {
    render(<StatsPanel stats={null} />)

    // **「ありません」も出さない。** 非公開の内部ファイルなので「無いのが普通」の
    // 環境があり、毎回言うと壊れているように見える
    expect(screen.queryByTestId('stats-panel')).toBeNull()
  })

  it('読めなかったときエラーを画面に出さない', () => {
    const { container } = render(<StatsPanel stats={null} />)

    // **人が押して開いたわけではない**ので、黙って消えるのが正しい。
    // ファイル閲覧は赤字でエラーを出すが、**あちらは人が選んだ結果**である
    expect(container.textContent).toBe('')
  })

  it('claude が計算した日を併記する', () => {
    render(<StatsPanel stats={記録()} />)

    // **値を突き合わせる。** 欄の存在だけ見ると、空でも通る。
    // 【実測 2026-09-13】これが5日古かった——併記しないと今の数字に見える
    expect(screen.getByTestId('stats-computed-at').textContent).toContain('2026-09-08')
  })

  it('費用を画面に出さない', () => {
    const { container } = render(<StatsPanel stats={記録()} />)

    // 【実測】`costUSD` は12モデルすべて `0`。**0 を出すと「使っていない」と読まれる**
    expect(container.textContent).not.toContain('$')
    expect(container.textContent).not.toContain('costUSD')
  })

  it('帯は読み上げの対象にせず、数字を本体にする', () => {
    render(<StatsPanel stats={記録()} />)

    const 行 = screen.getAllByTestId('stats-day')[0]
    const 帯 = 行.querySelector('.ctxgauge')

    // **帯が在ることを先に確かめる。** `帯?.getAttribute(...)` だけ見ると、
    // 帯そのものが無いとき `undefined` が返って検査が空振りする
    expect(帯).not.toBeNull()
    // **帯は aria-hidden。** 連続値の帯は正確な量を伝えないので、
    // これだけにすると読み上げで何も読めない
    expect(帯?.getAttribute('aria-hidden')).not.toBeNull()
    // 数字が本文に在ること
    expect(行.textContent).toContain('50')
  })

  it('モデル名は短くするが、知らない形はそのまま出す', () => {
    render(
      <StatsPanel
        stats={記録({
          modelUsage: [
            {
              model: 'claude-sonnet-4-5-20250929',
              totals: {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
              },
            },
            {
              model: '将来の別名',
              totals: {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
              },
            },
          ],
        })}
      />,
    )

    const 行 = screen.getAllByTestId('stats-model')
    expect(行[0].textContent).toContain('sonnet-4-5')
    // **訳せないものを捨てない。** 届いているのに画面に無い状態を作らない
    expect(行[1].textContent).toContain('将来の別名')
  })

  it('計算した日が古くても、そのまま出す', () => {
    render(<StatsPanel stats={記録({ lastComputedDate: '2020-01-01' })} />)

    // **古いこと自体は異常ではない。** claude が数え直すまで動かないので、
    // **隠すのではなくそのまま出して併記する**——隠すと「無い」と見分けが付かない。
    // 【実測 2026-09-13】実物は5日古かった
    expect(screen.getByTestId('stats-panel')).not.toBeNull()
    expect(screen.getByTestId('stats-computed-at').textContent).toContain('2020-01-01')
    expect(screen.getAllByTestId('stats-day')).toHaveLength(2)
  })

  it('日ごとの行が1件も無くても落ちない', () => {
    render(<StatsPanel stats={記録({ dailyActivity: [] })} />)

    // 帯の基準を最大値から作っているので、**空だと 0 除算になりうる**
    expect(screen.getByTestId('stats-panel')).not.toBeNull()
    expect(screen.queryAllByTestId('stats-day')).toHaveLength(0)
  })
})
