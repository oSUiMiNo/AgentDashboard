import { describe, expect, it } from 'vitest'
import { parseStats } from '@/lib/stats'

/**
 * Stats の解析（テスト計画 フェーズ6）。
 *
 * **この段の項目は失敗側に偏っている。** 「読めなければ諦める」だけを確かめると
 * **何も出さない実装でも通る**ので、**「読めたときに出る」を必ず対で置く**
 * （テスト計画がこれを名指ししている）。
 *
 * **実物を写さない。** `~/.claude/stats-cache.json` には利用者の PJT 名・モデル名・
 * 費用が入っており、**ここは公開リポジトリである。** キーの一覧と型だけ写して、
 * 値は作り物にしてある。
 */

/** 実物と同じキーの顔ぶれ。**値は作り物。** */
function 材料(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 3,
    lastComputedDate: '2026-09-08',
    firstSessionDate: '2026-04-02',
    totalSessions: 412,
    totalMessages: 9001,
    dailyActivity: [
      { date: '2026-09-07', messageCount: 30, sessionCount: 3, toolCallCount: 120 },
      { date: '2026-09-08', messageCount: 50, sessionCount: 5, toolCallCount: 200 },
    ],
    dailyModelTokens: [{ date: '2026-09-08', tokensByModel: { 'model-a': 10 } }],
    dailyModelTokensVersion: 1,
    hourCounts: { '0': 1, '13': 20 },
    longestSession: {
      duration: 7200,
      messageCount: 90,
      sessionId: 'ses-xxxx',
      timestamp: '2026-09-01T10:00:00Z',
    },
    modelUsage: {
      'model-a': {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 10,
        contextWindow: 200000,
        costUSD: 0,
        maxOutputTokens: 64000,
        webSearchRequests: 0,
      },
      'model-b': {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        contextWindow: 200000,
        costUSD: 0,
        maxOutputTokens: 8192,
        webSearchRequests: 0,
      },
    },
    ...extra,
  })
}

describe('Stats の解析', () => {
  it('読めたときに、日次活動とモデル別累計が出る', () => {
    const stats = parseStats(材料())

    // **これが無いと、この段は「何も出さない実装」でも緑になる**
    expect(stats).not.toBeNull()
    expect(stats?.dailyActivity).toHaveLength(2)
    expect(stats?.modelUsage).toHaveLength(2)
    // 値そのものを突き合わせる。**要素の数だけ見ると、中身が空でも通る**
    expect(stats?.dailyActivity[0]).toEqual({
      date: '2026-09-08',
      messageCount: 50,
      sessionCount: 5,
      toolCallCount: 200,
    })
  })

  it('新しい日が先に並ぶ', () => {
    const stats = parseStats(材料())

    // 材料は古い日を先に置いてある。**並べ替えを消すと落ちる**
    expect(stats?.dailyActivity.map((d) => d.date)).toEqual(['2026-09-08', '2026-09-07'])
  })

  it('使ったトークンが多いモデルが先に並ぶ', () => {
    const stats = parseStats(材料())

    expect(stats?.modelUsage.map((m) => m.model)).toEqual(['model-a', 'model-b'])
  })

  it('計算した日をそのまま持つ', () => {
    const stats = parseStats(材料())

    // **値を突き合わせる。** 欄の存在だけ見ると、空でも通る
    expect(stats?.lastComputedDate).toBe('2026-09-08')
  })

  it('費用は取り出さない', () => {
    const stats = parseStats(材料())

    // 【実測 2026-09-13】`costUSD` は12モデルすべて `0` で、埋まる条件が分からない。
    // **0 を出すと「使っていない」と読まれる**ので、欄ごと作らない
    // **部分一致で広く禁じない。** `cost` で引くと将来 `cacheCost` のような別の語にも
    // 当たり、**欄を足せなくなる**（PJTガイドライン「部分一致の検査は空になる」の裏側）
    expect(JSON.stringify(stats)).not.toContain('costUSD')
  })

  it('セッションの識別子を取り出さない', () => {
    const stats = parseStats(材料())

    // **識別子をそのまま出すと、記録へ書き写すときの持ち込み禁止に触れる**
    expect(JSON.stringify(stats)).not.toContain('ses-xxxx')
  })

  it('知らないキーが増えても壊れない', () => {
    // **11キーちょうどで試すと、多いときの経路を通らない。** 数は6回外れている
    const stats = parseStats(
      材料({
        将来の欄1: 1,
        将来の欄2: 'x',
        将来の欄3: { a: 1 },
        将来の欄4: [1, 2],
        将来の欄5: null,
        将来の欄6: true,
      }),
    )

    expect(stats?.dailyActivity).toHaveLength(2)
    expect(stats?.modelUsage).toHaveLength(2)
  })

  it('JSON として壊れていたら諦める', () => {
    // **空文字で代用しない。** 空文字も落ちるが、**壊れ方が1種類しか通らない**
    expect(parseStats('{"dailyActivity": [')).toBeNull()
    expect(parseStats('これは JSON ではない')).toBeNull()
  })

  it('JSON だが形が違えば諦める', () => {
    // 版が上がってキーの名前が変わった場合。**空の面を出すより出さない**
    expect(parseStats('[]')).toBeNull()
    expect(parseStats('"文字列"')).toBeNull()
    expect(parseStats('{"別の名前": {}}')).toBeNull()
  })

  it('日付が無い行は落とす', () => {
    const stats = parseStats(
      材料({
        dailyActivity: [
          { messageCount: 1, sessionCount: 1, toolCallCount: 1 },
          { date: '2026-09-08', messageCount: 50, sessionCount: 5, toolCallCount: 200 },
        ],
      }),
    )

    // **日付が無いと並べ替えの基準が無い。** 出しても読めないので落とす
    expect(stats?.dailyActivity).toHaveLength(1)
  })

  it('数であるべき欄に別の型が来ても落ちない', () => {
    const stats = parseStats(
      材料({
        totalSessions: '412',
        dailyActivity: [{ date: '2026-09-08', messageCount: null, sessionCount: 5 }],
      }),
    )

    // **非公開の内部ファイルなので、型が変わりうる。** 0 へ倒して出し続ける
    expect(stats?.totalSessions).toBe(0)
    expect(stats?.dailyActivity[0].messageCount).toBe(0)
  })
})
