import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 整形した Markdown の見た目を、**テキストとして**確かめる（細かい修正 設計§3-5）。
 *
 * jsdom はカスケードを解決しないので、画面から色を読むことはできない。ここで見られるのは
 * **そう書いてあること**まで——実際にどう見えるかは実機の目で確かめる。
 */
const CSS = readFileSync(resolve(process.cwd(), "src", "index.css"), "utf8");
/** コメントを落とす。中に `{}` が入っているので、先に消さないと分割が狂う */
const 素 = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

describe("Markdown のチェックボックス", () => {
  it("チェックの印が Primary Accent で塗られている", () => {
    // それまで色の指定が**1つも無く**ブラウザ任せ（灰色）だった。
    // 要件の「青基調」は Primary Accent に収まるので、**新しい色を1つも増やさない**
    const 規則 =
      /\.prose-dashboard input\[type='checkbox'\]\s*\{([^}]*)\}/.exec(素);
    expect(規則, "チェックボックスの規則が見つからない").not.toBeNull();
    expect(規則![1]).toContain("accent-color: #3dd9e6");
  });

  it("accent-color を書いているのは、この1箇所だけ", () => {
    // 散らすと、Primary Accent を差し替えたときに片方だけ古くなる
    expect(素.match(/accent-color:/g) ?? []).toHaveLength(1);
  });

  it("状態の色（完了の Lime）は使っていない", () => {
    // **これはアプリの「完了」状態ではなく、文書の中身である**（設計§3-5）。
    // ファイルに書いてある字をそのまま描いたものなので、`DESIGN.md` §11.2 の Lime は当てない
    const 規則 =
      /\.prose-dashboard input\[type='checkbox'\]\s*\{([^}]*)\}/.exec(素);
    expect(規則![1]).not.toContain("#8fd14f");
  });
});

describe("Markdown の見出し", () => {
  function 大きさ(tag: "h1" | "h2" | "h3"): string {
    const 当たり = new RegExp(
      `\\.prose-dashboard ${tag} \\{ font-size: ([^;]+); \\}`,
    ).exec(素);
    expect(当たり, `${tag} の指定が見つからない`).not.toBeNull();
    return 当たり![1];
  }

  it("上ほど大きく開いている", () => {
    // 以前は 1.3 / 1.15 / 1.05 で、**3段の差が 0.25em しかなく階層が読めなかった**
    expect(大きさ("h1")).toBe("1.6em");
    expect(大きさ("h2")).toBe("1.35em");
    expect(大きさ("h3")).toBe("1.15em");
  });

  it("段差が、前より広がっている", () => {
    // 数字を1つずつ見るだけだと、**3つとも同じ値にしても通る**
    const 数 = (t: "h1" | "h2" | "h3") => Number.parseFloat(大きさ(t));
    expect(数("h1") - 数("h2")).toBeGreaterThan(0.15);
    expect(数("h2") - 数("h3")).toBeGreaterThan(0.15);
  });

  it("整形は1つしかなく、ファイルビュアと構造化ビューが分かれていない", async () => {
    /*
      **見出しを大きくすると、セッションの履歴の見出しも一緒に大きくなる**
      （細かい修正 設計§8-5）。`README.md` が「同じ字を貼れば同じ見え方になる」と
      約束しているので、**片方だけ大きくするとその約束が崩れる**。

      ファイルビュア専用のクラスを足す案は採らなかった——約束を壊すうえ、
      **同じ整形が2つに分かれる**。ここでは「分かれていないこと」を見る。
    */
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const 読む = (rel: string) =>
      readFileSync(resolve(process.cwd(), "src", rel), "utf8");

    expect(読む("components/FileView/FileView.tsx")).toContain(
      "prose-dashboard",
    );
    expect(読む("components/TranscriptTree/TranscriptRow.tsx")).toContain(
      "prose-dashboard",
    );
    // 見出しの大きさを決める規則は、この3行だけ（別クラスへ写していない）
    expect(
      素.match(/font-size: 1\.6em|font-size: 1\.35em|font-size: 1\.15em/g),
    ).toHaveLength(3);
  });
});
