import type { RateLimits } from "@/lib/protocol";
import { formatDateTime, formatUntil } from "@/lib/time";

/**
 * 窓の名前を読める形にする。**既知の2つだけを訳し、それ以外はそのまま出す。**
 *
 * **本数も名前も固定しない**（status 設計§窓の本数を固定しない）。公式は `spend_limit` も
 * 挙げており、**いま2本しか来ないことと、2本前提で作ってよいことは別**である。
 * 知らない名前が来たら**そのまま出す**——訳せないものを捨てると、届いているのに
 * 画面に無い状態になる。
 */
function windowLabel(name: string): string {
  switch (name) {
    case "five_hour":
      return "5時間";
    case "seven_day":
      return "7日";
    default:
      return name;
  }
}

/**
 * 使用上限の窓を並べる。**PC の一覧の各行と、設定画面の「この機械」の区画の両方から使う。**
 *
 * # 2箇所から使うので部品にしてある
 *
 * 出し先が構成で割れる（ローカルモードは設定画面、セルフホストは PC の一覧）。
 * **部品にしないと片方だけ直る**——`.claude/CLAUDE.md`「片方だけに実装して『入れた』と
 * 言わない」と同じ形である。
 *
 * # 帯は装飾で、数字が本体である
 *
 * **帯は `aria-hidden`。読み上げ対象は数字のほう。** PC の一覧の点は「点が言っている
 * ことを文字で二度言わない」という約束を持つが、**あれは点が2値だから冗長になる**
 * のであって、**連続値の帯は正確な割合を伝えない**。帯だけにすると読み上げで何も
 * 読めず、`README.md`「静止｜色・記号・文字は残るので状態は読める」にも反する。
 * **1件目のゲージが同じ解き方をしている**（帯を `aria-hidden` にして数字を別に出す）。
 *
 * # 色は固定し、形で表す
 *
 * **しきい値で色を変えない**（status 設計）。一覧のコーラルはエラー、琥珀は「あなたの
 * 番」なので、**使用率が高いだけのものが別の意味に見える**。`DESIGN.md` §11.2 が
 * 「軸が違っても、利用者が受け取るのは1つの画面」として名指しで禁じている。
 * 帯は1件目のゲージと同じ `.ctxgauge` を使う——**新しいクラスを作らない。**
 *
 * # 100 を超えても頭打ちにしない
 *
 * `spend_limit` は 100 を超えうる。**数字はそのまま出す**（`120%` と読める）。
 * 帯は `.ctxgauge` の `overflow: hidden` で自然に 100% で止まるので、
 * **`Math.min` を書かない**——書くと数字まで丸めたくなる。
 */
export function RateLimitWindows({
  limits,
  now = Date.now(),
}: {
  limits: RateLimits | null;
  /** 「あと何時間か」の基準。**テストが時刻を固定するために受ける。** */
  now?: number;
}) {
  // **「無い」と「0%」を別に描く**（1件目と同じ判断）。届く形が同じなので、
  // 0% と区別できないと「使っていない」に見える——実際は「まだ分からない」
  const known = limits !== null && limits.windows.length > 0;

  if (!known) {
    return (
      <p
        data-testid="rate-limits"
        data-known="false"
        className="text-muted-foreground text-sm"
      >
        まだ届いていません
      </p>
    );
  }

  return (
    <ul
      data-testid="rate-limits"
      data-known="true"
      className="flex flex-col gap-1.5"
    >
      {limits.windows.map((window) => {
        const resetsAtMs = window.resets_at * 1000;
        const passed = resetsAtMs <= now;
        const absolute = formatDateTime(resetsAtMs);

        return (
          <li
            key={window.name}
            data-testid="rate-limit-window"
            data-window={window.name}
            className="flex items-center gap-2 text-sm"
          >
            <span className="w-16 shrink-0">{windowLabel(window.name)}</span>
            <span aria-hidden className="ctxgauge">
              <span
                className="ctxgauge-fill"
                style={{ inlineSize: `${window.used_percentage}%` }}
              />
            </span>
            <span data-testid="rate-limit-percent" className="tabular-nums">
              {window.used_percentage}%
            </span>
            <span
              data-testid="rate-limit-reset"
              className="text-muted-foreground/70 truncate"
              {...(absolute === null
                ? {}
                : { title: `${absolute} に戻ります` })}
            >
              {passed
                ? "リセット済み"
                : `${formatUntil(resetsAtMs - now)}で戻ります`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
