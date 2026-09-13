import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RateLimitWindows } from "@/components/RateLimits/RateLimitWindows";

/** 基準時刻を固定する。`resets_at` は**エポック秒**なので、比べる側も秒で作る。 */
const NOW = 1_757_700_000_000;
const NOW_SEC = NOW / 1000;

function window(name: string, used: number, resetsInSec: number) {
  return { name, used_percentage: used, resets_at: NOW_SEC + resetsInSec };
}

describe("使用上限の窓", () => {
  it("窓の本数を固定しない", () => {
    const { rerender } = render(
      <RateLimitWindows
        limits={{
          windows: [
            window("five_hour", 41, 3600),
            window("seven_day", 63, 86_400),
          ],
        }}
        now={NOW}
      />,
    );
    expect(screen.getAllByTestId("rate-limit-window")).toHaveLength(2);

    // **3本目を足したら3本出る。** 既知の2つに決め打ちしていたらここで落ちる
    rerender(
      <RateLimitWindows
        limits={{
          windows: [
            window("five_hour", 41, 3600),
            window("seven_day", 63, 86_400),
            window("spend_limit", 12, 172_800),
          ],
        }}
        now={NOW}
      />,
    );
    const rows = screen.getAllByTestId("rate-limit-window");
    expect(rows).toHaveLength(3);
    // 知らない名前は**そのまま出す**（訳せないものを捨てない）
    expect(rows[2]).toHaveTextContent("spend_limit");
  });

  it("100 を超えても頭打ちにしない", () => {
    render(
      <RateLimitWindows
        limits={{ windows: [window("spend_limit", 120, 3600)] }}
        now={NOW}
      />,
    );
    // **数字はそのまま。** `Math.min` を書くとここが 100% になる
    expect(screen.getByTestId("rate-limit-percent")).toHaveTextContent("120%");
  });

  it("過ぎた窓は「リセット済み」と言う", () => {
    render(
      <RateLimitWindows
        limits={{ windows: [window("five_hour", 41, -60)] }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("rate-limit-reset")).toHaveTextContent(
      "リセット済み",
    );
  });

  it("過ぎていない窓は、リセットまでの時間が読める", () => {
    // **完了条件1 の後半。** 「過ぎたときだけ何か言う」画面は、他を全部満たしながら
    // ここを落とす——パーセントだけ並べても、いつ戻るかが分からない
    render(
      <RateLimitWindows
        limits={{ windows: [window("five_hour", 41, 3 * 3600)] }}
        now={NOW}
      />,
    );
    const reset = screen.getByTestId("rate-limit-reset");
    expect(reset).toHaveTextContent("あと3時間で戻ります");
    // 絶対時刻は `title` に添える（正確さが要るときのため）
    expect(reset.getAttribute("title")).toMatch(/に戻ります$/);
  });

  it("「無い」と「0%」を別に描く", () => {
    const { rerender } = render(<RateLimitWindows limits={null} now={NOW} />);
    expect(screen.getByTestId("rate-limits")).toHaveAttribute(
      "data-known",
      "false",
    );

    rerender(
      <RateLimitWindows
        limits={{ windows: [window("five_hour", 0, 3600)] }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("rate-limits")).toHaveAttribute(
      "data-known",
      "true",
    );
    expect(screen.getByTestId("rate-limit-percent")).toHaveTextContent("0%");
  });

  it("使用率の数字は読み上げ対象で、帯は装飾である", () => {
    // **これが落ちると完了条件1 が落ちる。** 帯だけにすると読み上げで何も読めず、
    // 「静止｜色・記号・文字は残るので状態は読める」にも反する
    const { container } = render(
      <RateLimitWindows
        limits={{ windows: [window("five_hour", 41, 3600)] }}
        now={NOW}
      />,
    );
    const bar = container.querySelector(".ctxgauge");
    expect(bar).toHaveAttribute("aria-hidden");

    const percent = screen.getByTestId("rate-limit-percent");
    expect(percent).not.toHaveAttribute("aria-hidden");
    expect(percent.closest("[aria-hidden]")).toBeNull();
  });

  it("帯の長さは材料の数字をそのまま使う", () => {
    // 自分で割り直すと**丸めが二重になり `/status` と1ずれる**（1件目と同じ判断）
    const { container } = render(
      <RateLimitWindows
        limits={{ windows: [window("five_hour", 41, 3600)] }}
        now={NOW}
      />,
    );
    expect(
      container.querySelector<HTMLElement>(".ctxgauge-fill")?.style.inlineSize,
    ).toBe("41%");
  });

  it("色をしきい値で変えない", () => {
    // 高い値でも低い値でも**同じクラス**であること。一覧のコーラル（エラー）・
    // 琥珀（あなたの番）と衝突させない
    const low = render(
      <RateLimitWindows
        limits={{ windows: [window("five_hour", 5, 3600)] }}
        now={NOW}
      />,
    );
    const lowClass = low.container.querySelector(".ctxgauge-fill")?.className;
    low.unmount();

    const high = render(
      <RateLimitWindows
        limits={{ windows: [window("five_hour", 98, 3600)] }}
        now={NOW}
      />,
    );
    expect(high.container.querySelector(".ctxgauge-fill")?.className).toBe(
      lowClass,
    );
  });
});
