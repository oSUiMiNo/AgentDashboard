/**
 * `/context` の報告を**絵で出す**（コンテキストの残量 設計§8・段1）。
 *
 * # 何を直しているのか
 *
 * `/context` を打つと、構造化ビューには**12,422 文字のマークダウン**が届く。画面には
 * `Category / Tokens / Percentage` の表が延々と続き、**末尾を占める3つの表**
 * （MCP ツール・カスタムエージェント・スキル）が長さの正体である。利用者の言葉——
 * 「**ビジュアル的に分かりにくい**」。
 *
 * **ダッシュボードは何も間違えていない。** claude が寄越したマークダウンをそのとおり
 * 描いている。**元が長いから長い。**
 *
 * # だから、削るのではなく上に出す
 *
 * **原文は捨てない**（要件）。先頭の見たいところだけをここで絵にし、原文は
 * [`CONTEXT_USAGE_FOLD_LINES`] で畳む。**畳めば末尾の3表は自動的に隠れる**ので、
 * 3表を取り除く加工はしていない——押せば全部読める。
 *
 * # 新しいものを作っていない
 *
 * 帯は `controls.css` の `.ctxgauge` ／ `.ctxgauge-fill` を**そのまま使う**
 * （セッションの区画に出ているゲージと同じもの）。**色も演出もフェーズ4 で通った形**
 * なので、`DESIGN.md` の判定をやり直さずに済む——しきい値で色を変えない／色は固定
 * するが抜かない／**演出を止めても長さは残る**。
 *
 * 畳み／展開の仕掛けも持たない。**原文の開閉は `MarkdownBody` が既に持っている。**
 */

import type { ContextReport } from '@/lib/contextReport'

/**
 * 読み取れた報告を描く。
 *
 * **呼ぶ側が `null` を渡さない前提にしない。** 分類が当たっても中身が読めないこと
 * （claude の版が変わって見出しの字が変わる等）は起こりうるので、ここでも受ける——
 * そのときは**何も描かず、原文だけが出る**。
 */
export function ContextUsageCard({ report }: { report: ContextReport | null }) {
  if (report === null) {
    return null
  }
  return (
    <div data-testid="context-usage-card" className="mt-1 mb-2 flex flex-col gap-1.5 text-xs">
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="ctxgauge">
          {/*
            **長さは報告の数字をそのまま使う。割り直さない**——丸めているのは
            claude 側で、こちらで割り直すと `/context` の表示と1ずれる（設計§3）。
          */}
          <span className="ctxgauge-fill" style={{ inlineSize: `${report.percent}%` }} />
        </span>
        <span className="font-medium tabular-nums">{report.percent}%</span>
        {/* 実数は**従**（要件「使用率を主、実数を従とする」） */}
        <span className="text-muted-foreground tabular-nums">{report.tokens}</span>
        {report.model !== null && (
          <span className="text-muted-foreground truncate">{report.model}</span>
        )}
      </div>
      {report.categories.length > 0 && (
        <ul data-testid="context-usage-categories" className="flex flex-col gap-0.5">
          {report.categories.map((category) => (
            <li key={category.name} className="flex items-center gap-1.5">
              <span className="text-muted-foreground w-28 shrink-0 truncate">{category.name}</span>
              <span aria-hidden className="ctxgauge">
                <span className="ctxgauge-fill" style={{ inlineSize: `${category.percent}%` }} />
              </span>
              <span className="text-muted-foreground tabular-nums">{category.tokens}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
