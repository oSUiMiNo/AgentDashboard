import type { Stats } from '@/lib/stats'

/**
 * モデル名を短くする。**訳さない。**
 *
 * 【実測 2026-09-13】キーは `claude-sonnet-4-5-20250929` のような完全な識別子で、
 * **版の日付まで入っている。** そのまま並べると横に溢れるので、**先頭の `claude-` と
 * 末尾の日付だけ落とす**。知らない形が来たら**そのまま出す**——訳せないものを
 * 捨てると、届いているのに画面に無い状態になる（`RateLimitWindows` の窓名と同じ作法）。
 */
function modelLabel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

/** 千区切り。**桁が揃わないと大小が読めない。** */
function thousands(value: number): string {
  return value.toLocaleString('ja-JP')
}

/**
 * 活動の記録を出す（`statusコマンド相当の情報を画面から見えるようにする` 設計「引きの経路（Stats）」）。
 *
 * # 読めなければ何も描かない
 *
 * **`null` のとき「まだ届いていません」すら出さない。** `RateLimitWindows` は出すが、
 * **あちらは届く前提のもの**（3秒ごとに来る）で、**こちらは非公開の内部ファイルなので
 * 「無いのが普通」の環境がある**（claude を入れ直した直後、`stats-cache.json` を作らない版）。
 * **無い環境で毎回「ありません」と言うのは、壊れているように見える。**
 *
 * **エラーも出さない。** **人が押して開いたわけではない**ので、黙って消えるのが正しい
 * ——ファイル閲覧は読めないとき赤字でエラーを出すが、**あちらは人が選んで開いた結果**
 * なので黙ると押した意味が分からない。**同じ「読めなかった」でも、理由が逆である。**
 *
 * # 帯は装飾で、数字が本体
 *
 * **帯は `aria-hidden`。** 連続値の帯は正確な量を伝えないので、読み上げで何も読めなく
 * なる（`RateLimitWindows` と同じ解き方）。
 *
 * # 計算した日を必ず併記する
 *
 * 【実測 2026-09-13】`lastComputedDate` が**5日古かった。** claude が数え直すまで動かない
 * ので、**併記しないと古い数字が今の数字に見える。**
 */
export function StatsPanel({ stats }: { stats: Stats | null }) {
  if (stats === null) return null

  const 最大 = Math.max(...stats.dailyActivity.map((d) => d.messageCount), 1)

  return (
    <div data-testid="stats-panel" className="flex flex-col gap-3">
      <p data-testid="stats-computed-at" className="text-muted-foreground text-xs">
        claude が <strong className="font-medium">{stats.lastComputedDate}</strong>{' '}
        に数えたものです。claude が数え直すまで変わりません。
      </p>

      <dl className="flex gap-4 text-sm">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">セッション</dt>
          <dd data-testid="stats-total-sessions" className="tabular-nums font-medium">
            {thousands(stats.totalSessions)}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">やりとり</dt>
          <dd data-testid="stats-total-messages" className="tabular-nums font-medium">
            {thousands(stats.totalMessages)}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-1">
        <h4 className="text-muted-foreground text-xs">日ごとのやりとり</h4>
        <ul data-testid="stats-daily" className="flex flex-col gap-1">
          {stats.dailyActivity.map((day) => (
            <li
              key={day.date}
              data-testid="stats-day"
              data-date={day.date}
              className="flex items-center gap-2 text-xs"
            >
              <span className="text-muted-foreground w-20 shrink-0 tabular-nums">
                {day.date}
              </span>
              <span aria-hidden className="ctxgauge">
                <span
                  className="ctxgauge-fill"
                  style={{ inlineSize: `${(day.messageCount / 最大) * 100}%` }}
                />
              </span>
              <span className="w-10 shrink-0 text-right tabular-nums">
                {thousands(day.messageCount)}
              </span>
              <span className="text-muted-foreground/70 truncate">
                {day.sessionCount} セッション・道具 {thousands(day.toolCallCount)} 回
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <h4 className="text-muted-foreground text-xs">モデルごとのトークン</h4>
        <ul data-testid="stats-models" className="flex flex-col gap-1">
          {stats.modelUsage.map(({ model, totals }) => (
            <li
              key={model}
              data-testid="stats-model"
              data-model={model}
              className="flex items-center gap-2 text-xs"
            >
              <span className="w-40 shrink-0 truncate" title={model}>
                {modelLabel(model)}
              </span>
              <span className="text-muted-foreground tabular-nums">
                入 {thousands(totals.inputTokens)}
              </span>
              <span className="text-muted-foreground tabular-nums">
                出 {thousands(totals.outputTokens)}
              </span>
              <span className="text-muted-foreground/70 tabular-nums">
                控え {thousands(totals.cacheReadInputTokens)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
