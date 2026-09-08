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

describe("構造化ビューの文字の大きさ（細かい修正 項目11・12）", () => {
  const 読む = (rel: string) =>
    readFileSync(resolve(process.cwd(), "src", rel), "utf8");

  function 規則(セレクタ: string): string {
    const 当たり = new RegExp(
      `${セレクタ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    ).exec(素);
    expect(当たり, `${セレクタ} の規則が見つからない`).not.toBeNull();
    return 当たり![1];
  }

  it("器が大きさを持ち、機械の吹き出しだけ小さい", () => {
    // 3種（既定・完了通知・他セッションの連絡）は器のクラスが共通なので、
    // この1つの上書きで自動的に揃う
    expect(規則(".speech-bubble,\n.body-shell")).toContain(
      "--body-size: 0.9rem",
    );
    expect(規則(".speech-bubble.speech-bubble-machine")).toContain(
      "--body-size: 0.6875rem",
    );
  });

  it("機械の側を、2クラスの特異度で書いている", () => {
    // 単クラスだと `.speech-bubble` と同じ (0,1,0) で、**記述順に頼る**形になる。
    // 待ちの `.speech-bubble.speech-bubble-queued` が同じ理由で2クラス書きである
    expect(素).toContain(".speech-bubble.speech-bubble-machine {");
    expect(素).not.toMatch(/^\.speech-bubble-machine \{\s*--body-size/m);
  });

  it("大きさを rem で持ち、画素で直書きしていない", () => {
    // 端数（14.4px・11px）を持つので、根の大きさから引ける形にしておく
    const 大きさ = 素.match(/--body-size:\s*([^;]+);/g) ?? [];
    expect(大きさ.length).toBeGreaterThanOrEqual(2);
    for (const 行 of 大きさ) expect(行).not.toContain("px");
  });

  it("10.8px（0.9倍そのもの）を採っていない", () => {
    // `DESIGN.md` の情報階層で Badge の帯（10〜12）へ落ち、**本文が札の大きさになる**。
    // 11px なら Secondary Info に留まるので、階層の表を書き換えずに済む
    expect(素).not.toContain("0.675rem");
  });

  it("本文が器から読み、器の外では 12px のままである", () => {
    // フォールバックが元の値であることが、ファイルビュアが動かない担保そのもの
    expect(規則(".prose-body")).toContain("font-size: var(--body-size, 0.75rem)");
  });

  it("直書きの text-xs が外れ、prose-body が付いている", () => {
    /*
      **このフェーズ最大の落とし穴。** 共用クラスは `font-size` を1つも持っておらず、
      **同じ要素に直書きされた `text-xs` が全部決めていた**。器へトークンを足すだけでは
      ユーティリティが勝つので、**見た目が1ミリも変わらないまま緑になる**。
    */
    for (const rel of [
      "components/TranscriptTree/TranscriptRow.tsx",
      "components/TranscriptTree/SlashCommandLine.tsx",
    ]) {
      expect(読む(rel), rel).not.toContain("prose-dashboard text-xs");
      expect(読む(rel), rel).toContain("prose-dashboard prose-body");
    }
  });

  it("ファイルビュアの text-sm は残っている", () => {
    // 巻き添えを防ぐ。あちらは器を持たないので、外すと 12px へ落ちる
    expect(読む("components/FileView/FileView.tsx")).toContain(
      "prose-dashboard text-sm",
    );
  });

  /*
    **行間も同じ作りで器から取る**（利用者の指定・2026-09-08）。
    大きさのときと同じ落とし穴——直書きの `leading-relaxed` が残っていると、
    器へトークンを足しても**見た目が1ミリも変わらないまま緑になる**。
  */
  it("左から出る機械の吹き出しだけ、行間のトークンを持つ", () => {
    expect(規則(".speech-bubble.speech-bubble-machine")).toContain(
      "--body-line: 1.3",
    );
    // 利用者の青い吹き出しと平たい器は巻き込まない。持たなければフォールバックが効く
    expect(規則(".speech-bubble,\n.body-shell")).not.toContain("--body-line");
  });

  it("本文が行間を器から読み、器の外では leading-relaxed のままである", () => {
    // フォールバックの 1.625 は Tailwind の `leading-relaxed` そのもの
    expect(規則(".prose-body")).toContain("line-height: var(--body-line, 1.625)");
  });

  it("1.3 が、もとの 1.625 のちょうど 0.8 倍である", () => {
    // 片方だけ動かすと比が崩れる。**数の関係そのもの**を見張る
    const 元 = Number(
      /line-height:\s*var\(--body-line,\s*([\d.]+)\)/.exec(素)![1],
    );
    const 機械 = Number(/--body-line:\s*([\d.]+);/.exec(素)![1]);
    expect(機械 / 元).toBeCloseTo(0.8, 5);
  });

  it("直書きの leading-relaxed が外れている", () => {
    for (const rel of [
      "components/TranscriptTree/TranscriptRow.tsx",
      "components/TranscriptTree/SlashCommandLine.tsx",
    ]) {
      expect(読む(rel), rel).not.toContain("prose-body leading-relaxed");
    }
    // ファイルビュアは器の外なので、こちらは残す（外すと行間まで巻き添えで変わる）
    expect(読む("components/FileView/FileView.tsx")).toContain(
      "text-sm leading-relaxed",
    );
  });

  it("フェードの1行ぶんは、器のトークンから導かない", () => {
    // **行間を変えても、畳む仕掛けの帯は動かさない。** 器のトークンから導くと
    // 既定の器で 19.5px → 23.4px へ育ち、設計が言う「帯 ÷ 行 = 約2行」が
    // 1.17倍にずれる（`e2e/transcript.spec.ts` の「畳む仕掛けの高さ」が捕まえる）。
    // 器ごとに追従させるかどうかは、見た目を決め直す別の話
    expect(素).toContain("--fade-line: calc(0.75rem * 1.625)");
    expect(素).not.toContain("--fade-line: calc(var(");
  });
});

describe("構造化ビューの段落の空き（細かい修正 項目12）", () => {
  it("器が 0.78em を持っている", () => {
    // 利用者の選択＝**書いてある値（0.6em）の1.3倍**。いま見えている値の1.3倍だと、
    // 項目11で文字が大きくなったぶんと相殺して +0.72px にしかならない
    expect(素).toContain("--prose-gap: 0.78em");
  });

  it("段落と見出しの余白が、器から取る形になっている", () => {
    expect(素).toContain("margin: var(--prose-gap, 0.6em) 0;");
    expect(素).toContain(
      "margin: var(--prose-head-top, 1.2em) 0 var(--prose-head-bottom, 0.5em);",
    );
  });

  it("フォールバックが元の値なので、ファイルビュアは動かない", () => {
    // `.prose-dashboard` の値そのものは1つも動かしていない。
    // 動かしたのは「どこから取るか」だけである
    expect(素).not.toContain("margin: 0.6em 0;");
    expect(素).toContain("--prose-head-top: 1.56em");
    expect(素).toContain("--prose-head-bottom: 0.65em");
  });
});

describe("畳まれた行の要約を沈める（細かい修正 項目8）", () => {
  const 読む = (rel: string) =>
    readFileSync(resolve(process.cwd(), "src", rel), "utf8");
  const ROW = 読む("components/TranscriptTree/TranscriptRow.tsx");

  it("専用のトークンを持ち、地に対して床を越えている", () => {
    // 0.62 は地（oklch(0.145 0 0)）に対して 5.44:1。
    // **下限ぎりぎり（0.5736＝4.5 ちょうど）は採らない**——地が動いたときに一発で割る
    expect(素).toContain("--fold-muted: oklch(0.62 0 0)");
    expect(素).toContain("--color-fold-muted: var(--fold-muted)");
  });

  it("既存の muted-foreground は動かしていない", () => {
    // 30ファイル・117箇所で使われている。動かすと**画面中が同じだけ沈む**
    expect(素).toContain("--muted-foreground: oklch(0.708 0 0)");
  });

  it("3種の折りたたみ行が、そろって同じトークンを読む", () => {
    // 1つだけ沈めると、隣り合う行で濃さが食い違う
    const 要約 = ROW.match(/className="text-fold-muted min-w-0 shrink truncate"/g) ?? [];
    expect(要約).toHaveLength(3);
  });

  it("記号は据え置く", () => {
    // `›` は「押せる場所」の手がかりなので、一緒に沈めると弱くなる
    const 記号 = ROW.match(/chevron-mark text-muted-foreground/g) ?? [];
    expect(記号).toHaveLength(3);
    expect(ROW).not.toContain("chevron-mark text-fold-muted");
  });

  it("要約以外へ広げていない", () => {
    // ツールの状態ラベル・思考の行・入力/結果の pre は本文であって要約ではない
    expect((ROW.match(/text-fold-muted/g) ?? []).length).toBe(3);
  });
});

describe("コントラストの床が DESIGN.md に書いてある（細かい修正 項目8）", () => {
  const DESIGN = readFileSync(
    resolve(process.cwd(), "..", "DESIGN.md"),
    "utf8",
  );

  it("小さい字 4.5 と大きい字 3.0 が、数として書いてある", () => {
    // これまで**基準そのものはどこにも書かれておらず**、「もう少しだけ暗く」を
    // 止める仕掛けが決まりの中に無かった
    const 節 = /### コントラストの床([\s\S]*?)\n---/.exec(DESIGN);
    expect(節, "コントラストの床の節が見つからない").not.toBeNull();
    expect(節![1]).toContain("4.5:1");
    expect(節![1]).toContain("3.0:1");
  });

  it("承知のうえで割っている色があることを、1行添えてある", () => {
    /*
      **書かないと、明文化した床が既存の記録を「違反」として消しに行く。**
      機械の吹き出しの地は「見た目を取って読みやすさを下げた取引」として
      数字ごと残されている。
    */
    const 節 = /### コントラストの床([\s\S]*?)\n---/.exec(DESIGN);
    expect(節![1]).toContain("承知のうえで床を割っている");
  });
});

describe("大きさを持つ隣の部品は据え置く（細かい修正 項目11-f）", () => {
  const ROW = readFileSync(
    resolve(process.cwd(), "src", "components/TranscriptTree/TranscriptRow.tsx"),
    "utf8",
  );

  it("「続きを読む／畳む」の帯は 14px のままである", () => {
    /*
      **あれは本文ではなく操作である。** しかも「地を持たないぶんをコントラストで
      読ませる」形へ既に直されているので、本文と一緒に縮めると**そのとき直した問題へ戻る**。
    */
    expect(ROW).toContain("body-toggle text-sm");
    expect(ROW).not.toContain("body-toggle prose-body");
  });

  it("注記や入力/結果の pre は、本文と一緒に上げていない", () => {
    // 本文だけを割る話なので、器の中の注記まで巻き込まない。
    // **`prose-body` が付くのは本文の1箇所だけ**である
    expect((ROW.match(/prose-body/g) ?? []).length).toBe(1);
  });
});

describe("畳んだ末尾の色をやめる（細かい修正 項目9）", () => {
  /**
   * 消してよいのは**トークンと、それを塗っていた擬似要素の2つだけ**である。
   * 同じ名前を読む4箇所と、包み箱の役目は残る。**消すと押す面と「続きを読む」が
   * 親の外へ飛ぶ**ので、残っていることを1件ずつ見張る。
   */
  it("色のトークンが消えている", () => {
    expect(素).not.toContain("--fade-tint");
  });

  it("ティントを塗っていた擬似要素が消えている", () => {
    expect(/\.body-fade::before\s*\{/.test(素)).toBe(false);
  });

  it("帯の高さの変数は残り、読む側が4箇所ある", () => {
    // 定義（`.body-fade`）＋差し替え2つ（浅い・深い）で3件、読む側が
    // マスク2行・押す判定・帯の位置で4件。**どちらが欠けても壊れる**
    expect(/--fade-band:\s*calc\(2 \* var\(--fade-line\)\)/.test(素)).toBe(true);
    expect(素.match(/var\(--fade-band\)/g) ?? []).toHaveLength(4);
  });

  it("器の位置指定が残っている（押す面と「続きを読む」の包み箱）", () => {
    const 規則 = /\.body-fade\s*\{([^}]*)\}/.exec(素);
    expect(規則, ".body-fade の規則が見つからない").not.toBeNull();
    expect(規則![1]).toContain("position: relative");
  });

  it("文字のマスクが残っている（字が薄れること自体はこちらの仕事）", () => {
    const 規則 = /\.body-fade-text\s*\{([^}]*)\}/.exec(素);
    expect(規則, ".body-fade-text の規則が見つからない").not.toBeNull();
    expect(規則![1]).toContain("mask-image:");
  });

  it("出典が、消えた名前を指していない", () => {
    // **コメントを落とす前の生の字面で見る。** 引用はコメントの中に在るので、
    // `素` を見ると検査が素通りする
    const TILE = readFileSync(resolve(process.cwd(), "src", "tile.css"), "utf8");
    expect(CSS).not.toContain("--fade-tint");
    expect(TILE).not.toContain("--fade-tint");
  });
});
