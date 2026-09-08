/**
 * ファイル1つの見せ方（設計§15。テスト計画 フェーズ4「ファイルの見せ方」）。
 *
 * ここで守っているのは2つ。**貼れる値が正しく取れること**と、**整形が嘘をつかないこと**。
 * とくに生の HTML は、通してしまっても画面は普通に見えるので、目視では気づけない。
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileView } from "@/components/FileView/FileView";
import { rawUrl } from "@/lib/hostfs";

const ROOT = "/home/me/dev/app";

type FileViewProps = ComponentProps<typeof FileView>;
type 埋める = "tabs" | "onSelectTab" | "onCloseTab" | "onReorderTab";
type ViewerProps = Omit<FileViewProps, 埋める> &
  Partial<Pick<FileViewProps, 埋める>>;

/**
 * タブの受け口を既定で埋める包み。
 *
 * ここの検査のほとんどは**1枚だけ開いている状態**を見ているので、`tabs` は既定で
 * そのパス1枚にする。**タブそのものの振る舞いは `FileTabs.test.tsx` と、この下の
 * 「タブ帯」で見る。**
 */
function Viewer({
  tabs,
  onSelectTab,
  onCloseTab,
  onReorderTab,
  ...rest
}: ViewerProps) {
  return (
    <FileView
      {...rest}
      tabs={tabs ?? [rest.path]}
      onSelectTab={onSelectTab ?? (() => {})}
      onCloseTab={onCloseTab ?? (() => {})}
      onReorderTab={onReorderTab ?? (() => {})}
    />
  );
}

/** `/api/hosts/{host}/file` の応答。 */
function content(text: string, truncated = false) {
  return {
    path: `${ROOT}/計画.md`,
    text,
    truncated,
    bytes: text.length,
  };
}

let written: string[] = [];
/** `createObjectURL` で作ったもの／捨てたもの（下の「画像と HTML」で数える）。 */
const made: { url: string; size: number }[] = [];
const revoked: string[] = [];

function serve(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

beforeEach(() => {
  written = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        written.push(text);
      }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function show(path = `${ROOT}/計画.md`) {
  render(<Viewer host="local" root={ROOT} path={path} />);
}

describe("ファイルの見せ方", () => {
  it("タブに名前が出て、絶対パスと基準は title に残る", async () => {
    /*
      **相対パスの chip をタブ帯が置き換えた**（`サイドバーで開いたファイルを、タブで
      並べて切り替える` 要件）。役目が同じ（いま何を見ているか）なので置き換えられる。

      **`title` は引き継ぐ。** `ファイル設計§15`「基準の分からない相対パスは貼られた
      側で解釈できない」は**消えていない要求**で、要件26・細かい修正 設計§8-6 が
      「画面の面積を使わずに満たす」形へ移しただけである——ここを落とすと要求ごと落ちる。
    */
    serve(content("# 計画"));
    show(`${ROOT}/MyDocs/計画.md`);

    const タブ = await screen.findByTestId("file-tab");
    expect(タブ).toHaveTextContent("計画.md");
    expect(screen.queryByTestId("file-relative-path")).toBeNull();
    expect(screen.queryByTestId("file-relative-base")).toBeNull();
    // **丸ごと一致では見ない。** 並べ替えの道（WCAG 2.5.7）も同じ `title` に
    // 書いてあるので、**足すたびに落ちる検査**になってしまう
    const title = タブ.getAttribute("title") ?? "";
    expect(title).toContain(`${ROOT}/MyDocs/計画.md`);
    expect(title).toContain(`${ROOT} からの相対パス`);
  });

  it("「パスをコピー」は無くなり、写す道はサイドバーだけになった", async () => {
    /*
      要件24。**コピーの逃げ道（写せない環境で値を選ばせる道）も一緒に消える**が、
      サイドバー側（`folder-copy-fallback`）は残っているので、**写せない環境で
      詰まる形にはならない**。右クリックの「絶対パスをコピー」も同じ道を通る。
    */
    serve(content("# 計画"));
    show(`${ROOT}/MyDocs/計画.md`);

    await screen.findByTestId("file-tab");
    expect(screen.queryByTestId("file-copy")).toBeNull();
    expect(screen.queryByTestId("file-copied")).toBeNull();
    expect(screen.queryByTestId("file-copy-fallback")).toBeNull();
    expect(written).toEqual([]);
  });

  it("Markdown が整形され、チェックボックスの入り／未入りが読める", async () => {
    serve(content("# 計画\n\n- [x] 済んだこと\n- [ ] まだのこと\n"));
    show();

    const boxes = await screen.findAllByRole("checkbox");
    // 進捗そのものなので、入り／未入りが**別々に読める**ことまで見る
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("計画");
  });

  it("生の HTML が実行も表示もされない", async () => {
    serve(
      content(
        '# 見出し\n\n<img src="x" onerror="alert(1)">\n\n<script>alert(2)</script>\n\n```html\n<div>コードブロックの中</div>\n```\n',
      ),
    );
    const { container } = render(
      <Viewer host="local" root={ROOT} path={`${ROOT}/計画.md`} />,
    );
    await screen.findByTestId("file-markdown");

    // **タグとして出ていないこと**を見る
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // **字面としても出ていないこと**（`skipHtml`。設計§27）。フェーズ0 で
    // 「字面が無いこと」を条件にして落ちたのは、逃がされて残っていたため——
    // いまは木から取り除いているので、無いことが正しい条件になる
    expect(screen.getByTestId("file-markdown").textContent).not.toContain(
      "onerror",
    );
    // **コードブロックの中は消えない。** 取り除くのは HTML のノードだけで、
    // 囲まれた中身はただの文字列として残る（ここを壊すのが唯一の怖い副作用）
    expect(
      screen.getByText("<div>コードブロックの中</div>"),
    ).toBeInTheDocument();
    // 整形自体は効いている（丸ごと素通ししているわけではない）
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "見出し",
    );
  });

  it("素の改行が、改行として出る", async () => {
    // **履歴と同じ配列を使っている**ことの現れ（`構造化ビューでメッセージの改行が
    // 反映されない` 設計§5）。同じ字を貼れば同じ見え方になる
    serve(content("あいう\nかきく\n"));
    const { container } = render(
      <Viewer host="local" root={ROOT} path={`${ROOT}/計画.md`} />,
    );
    await screen.findByTestId("file-markdown");

    expect(container.querySelectorAll("br")).toHaveLength(1);
  });

  it("`<br/>` も改行として出る（`skipHtml` があっても消えない）", async () => {
    // **`skipHtml` は rehype が走った「あと」に効く。** 先に `br` 要素へ変わったものは
    // 残り、残りの生 HTML はいままでどおり落ちる。このリポジトリのドキュメントは
    // 節の区切りに `<br/>` を2行置く作法なので、**意図した行間がここで戻る**
    serve(content("# 見出し\n\n---\n<br/>\n<br/>\n\n本文\n"));
    const { container } = render(
      <Viewer host="local" root={ROOT} path={`${ROOT}/計画.md`} />,
    );
    await screen.findByTestId("file-markdown");

    expect(container.querySelectorAll("br")).toHaveLength(2);
    // 字面としては出ない（`skipHtml` は効いたまま）
    expect(screen.getByTestId("file-markdown").textContent).not.toContain(
      "<br",
    );
  });

  it("囲みコードの中の改行は、二重にならない", async () => {
    serve(content("```\n1行目\n2行目\n```\n"));
    const { container } = render(
      <Viewer host="local" root={ROOT} path={`${ROOT}/計画.md`} />,
    );
    await screen.findByTestId("file-markdown");

    expect(container.querySelectorAll("br")).toHaveLength(0);
    expect(screen.getByText(/1行目/).textContent).toContain("1行目\n2行目");
  });

  it("生テキストへ切り替えられる", async () => {
    serve(content("# 計画\n\n本文\n"));
    show();

    await screen.findByTestId("file-markdown");
    await userEvent.click(screen.getByTestId("file-toggle-raw"));

    // 整形が嘘をついたときに確かめる先が要る（設計§15）
    expect(screen.getByTestId("file-raw")).toHaveTextContent("# 計画");
    expect(screen.queryByTestId("file-markdown")).toBeNull();

    await userEvent.click(screen.getByTestId("file-toggle-raw"));
    expect(await screen.findByTestId("file-markdown")).toBeInTheDocument();
  });

  it("Markdown ではないファイルは、最初から生テキストで出る", async () => {
    serve(content("const a = 1\n"));
    show(`${ROOT}/src/index.ts`);

    expect(await screen.findByTestId("file-raw")).toHaveTextContent(
      "const a = 1",
    );
    // 切り替える意味が無いので、切替そのものを出さない
    expect(screen.queryByTestId("file-toggle-raw")).toBeNull();
  });

  it("打ち切られた中身が、打ち切られたと分かる", async () => {
    serve(content("先頭だけ", true));
    show();

    // 黙って切ると「そこで終わっている」と読めてしまう（設計§9）
    expect(await screen.findByTestId("file-truncated")).toBeInTheDocument();
  });

  it("大きい Markdown は整形せずに始まり、なぜそうしたかが出る", async () => {
    // **`bytes` で決まる**ので、材料そのものを大きくしなくても道は通る。
    // 整形は大きさに対して超線形に伸び、3 MiB では終わらない（実測。`FileView.tsx`）
    serve({
      path: `${ROOT}/大きい.md`,
      text: "# 大きい文書",
      truncated: false,
      bytes: 512 * 1024,
    });
    show(`${ROOT}/大きい.md`);

    expect(await screen.findByTestId("file-raw")).toHaveTextContent(
      "# 大きい文書",
    );
    expect(screen.queryByTestId("file-markdown")).toBeNull();
    // **黙って生テキストにしない。** 何も言わずに出すと、整形が壊れたように見える
    expect(screen.getByTestId("file-heavy")).toBeInTheDocument();
  });

  it("大きくても、整形そのものは禁じない", async () => {
    serve({
      path: `${ROOT}/大きい.md`,
      text: "# 大きい文書",
      truncated: false,
      bytes: 512 * 1024,
    });
    show(`${ROOT}/大きい.md`);

    await screen.findByTestId("file-raw");
    await userEvent.click(screen.getByTestId("file-toggle-raw"));

    // 待つと決めるのは利用者。押せば整形するし、断り書きは引っ込む
    expect(await screen.findByTestId("file-markdown")).toBeInTheDocument();
    expect(screen.queryByTestId("file-heavy")).toBeNull();
  });

  it("上限の内側なら、今までどおり整形で始まる", async () => {
    serve({
      path: `${ROOT}/計画.md`,
      text: "# 計画",
      truncated: false,
      bytes: 256 * 1024,
    });
    show();

    // 境目ちょうどは整形の側。**上げたことで普段の文書の出方を変えない**
    expect(await screen.findByTestId("file-markdown")).toBeInTheDocument();
    expect(screen.queryByTestId("file-heavy")).toBeNull();
  });

  it("読めないときは理由がそのまま出る", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("大きすぎます（343 KB）", { status: 413 }),
      ),
    );
    show();

    // 権限・不在・大きすぎ、はどれも利用者が直せる（設計§17）
    expect(await screen.findByTestId("file-error")).toHaveTextContent(
      "大きすぎます",
    );
  });
});

/**
 * 画像と HTML（`ファイル閲覧で画像とHTMLも表示する` 設計§7。テスト計画フェーズ4）。
 *
 * **否定側の主張が多いので、肯定側と対で書く。** 「叩かない」「出さない」は、
 * 探し方が間違っているときにも同じ答えを返す。
 */
describe("ブラウザで開く", () => {
  /**
   * 押す道はリンク（`ファイルの中身に掛けた隔離を、script の1段だけ解く` 設計§6-2）。
   *
   * **`window.open` を呼ぶボタンにしない。** 中クリック・修飾キー・キーボード操作・
   * ブラウザ自身の「新しいタブで開く」を、こちらで作り直すことになる。
   */
  it("宛先は rawUrl と字で一致する——画面で継ぎ足さない", async () => {
    serve(content("# 計画"));
    show();

    const 開く = await screen.findByTestId("file-open-tab");
    // **`rawUrl` の戻りと字で突き合わせる**（設計§6-3）。画面で組み立てると、
    // 符号化の仕方が2通りになる
    expect(開く).toHaveAttribute("href", rawUrl("local", `${ROOT}/計画.md`));
    expect(開く).toHaveAttribute("target", "_blank");
    expect(開く).toHaveAttribute("rel", "noopener");
  });

  /**
   * 文字から記号へ移した（項目3）。**落とすのは見える字だけ。**
   *
   * 読み上げ用の名前とマウスを乗せたときの説明を一緒に落とすと、**何のボタンか
   * 確かめる手段が画面から消える**。記号は意味を持たない絵なので、言葉の側が正になる。
   */
  it("記号になっても、リンクのままで名前が残る", async () => {
    serve(content("# 計画"));
    show();

    const 開く = await screen.findByTestId("file-open-tab");
    // **`<a>` のまま。** ボタンにすると中クリック・修飾キー・キーボード操作を作り直す
    expect(開く.tagName).toBe("A");
    // 言葉は両方に残す（読み上げと、マウスを乗せたとき）
    expect(開く).toHaveAttribute("aria-label", "ブラウザで開く");
    expect(開く).toHaveAttribute("title", "ブラウザで開く");
    // **見える字は消えている。** 記号の `svg` は `aria-hidden` なので字を持たない
    expect(開く.textContent?.trim()).toBe("");
    expect(開く.querySelector("svg")).not.toBeNull();
  });

  it("記号は隣の閉じると同じ作りで描かれている", async () => {
    // 帯の中で浮かないこと。**同じ器の大きさ・同じ線の太さ**で並ぶ
    serve(content("# 計画"));
    render(
      <Viewer
        host="local"
        root={ROOT}
        path={`${ROOT}/計画.md`}
        onClose={() => {}}
      />,
    );

    const 開く = await screen.findByTestId("file-open-tab");
    const 閉じる = screen.getByTestId("file-close");
    const 開くの絵 = 開く.querySelector("svg");
    const 閉じるの絵 = 閉じる.querySelector("svg");

    // 24 のグリッドで、線の太さは 2 以上（`DESIGN.md` §18.2 の下限）
    expect(開くの絵?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(
      Number(開くの絵?.getAttribute("stroke-width")),
    ).toBeGreaterThanOrEqual(2);
    // **要素は3つ以下**（§18.2）。四角と矢印の2つで描いてある
    expect(開くの絵?.children.length).toBeLessThanOrEqual(3);
    // 太さは隣と揃える
    expect(開くの絵?.getAttribute("stroke-width")).toBe(
      閉じるの絵?.getAttribute("stroke-width"),
    );
  });

  it("種別で出し分けない——どのファイルでも出る", async () => {
    // 要件が「ファイルによって表示するか判別する必要は今のところない」と明記している。
    // 口を広げたので、押して意味の無い相手でも**字か理由のどちらかは必ず出る**（設計§6-6）
    for (const name of ["計画.md", "メモ.txt", "組み込み.js"]) {
      serve(content("中身"));
      const { unmount } = render(
        <Viewer host="local" root={ROOT} path={`${ROOT}/${name}`} />,
      );
      expect(await screen.findByTestId("file-open-tab")).toBeInTheDocument();
      unmount();
    }
  });

  it("閉じるは右端に残る", async () => {
    // いちばん結果の重い操作が、押し間違いで動かない位置に居ること（設計§6-1）
    serve(content("# 計画"));
    render(
      <Viewer
        host="local"
        root={ROOT}
        path={`${ROOT}/計画.md`}
        onClose={() => {}}
      />,
    );

    await screen.findByTestId("file-open-tab");
    /*
      **3つの工事が同じ帯へ入ったので、間に部品が増えている**（探す・文字の大きさ）。
      それでも見ているのは「いちばん結果の重い操作が右端に居ること」で、意味は変わらない。
    */
    const 並び = [
      "file-find-open",
      "file-zoom",
      "file-toggle-raw",
      "file-open-tab",
      "file-close",
    ].map((id) => screen.getByTestId(id));
    for (let at = 0; at + 1 < 並び.length; at += 1) {
      expect(
        並び[at].compareDocumentPosition(並び[at + 1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });
});

describe("画像と HTML", () => {
  /** 呼ばれた URL を全部控える。**「叩かない」を数で言うため。** */
  function record(handler: (url: string) => Response) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        return handler(url);
      }),
    );
    return calls;
  }

  beforeEach(() => {
    // jsdom は `createObjectURL` を持たない。**捨てたかどうかを数えたい**ので、
    // 作った URL と捨てた URL の両方を控える形にする
    made.length = 0;
    revoked.length = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        const url = `blob:偽物/${made.length}`;
        made.push({ url, size: blob.size });
        return url;
      }),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn((url: string) => {
        revoked.push(url);
      }),
    });
  });

  it("画像は生の口から取って img に渡す。テキストの口は1回も叩かない", async () => {
    const calls = record(
      () =>
        new Response(
          new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
          {
            status: 200,
            headers: { "content-type": "image/png" },
          },
        ),
    );
    render(<Viewer host="local" root={ROOT} path={`${ROOT}/撮った.png`} />);

    const image = await screen.findByTestId("file-image");
    expect(image).toHaveAttribute("src", "blob:偽物/0");
    // **二度運ばない**（設計§7-2）。`as=raw` の1本だけが叩かれていること
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("as=raw");
    // 生テキストは出さず、代わりに素性を出す（設計§7-4）
    expect(screen.queryByTestId("file-toggle-raw")).toBeNull();
    expect(screen.getByTestId("file-meta")).toHaveTextContent("image/png");
  });

  it("断られたら、本文をそのまま断り欄へ出す", async () => {
    record(
      () => new Response("大きすぎます（9000000 バイト）", { status: 413 }),
    );
    render(<Viewer host="local" root={ROOT} path={`${ROOT}/大きい.png`} />);

    expect(await screen.findByTestId("file-error")).toHaveTextContent(
      "大きすぎます（9000000 バイト）",
    );
    // 断られたときは箱も画像も出さない
    expect(screen.queryByTestId("file-image")).toBeNull();
  });

  it("中身が画像でないときは、断られたのとは別の言い方をする", async () => {
    record(
      () =>
        new Response(
          new Blob(["これは画像ではありません"], { type: "image/png" }),
          {
            status: 200,
            headers: { "content-type": "image/png" },
          },
        ),
    );
    render(<Viewer host="local" root={ROOT} path={`${ROOT}/嘘.png`} />);

    const image = await screen.findByTestId("file-image");
    // jsdom は画像を解こうとしないので、`onError` を自分で起こす
    fireEvent.error(image);

    const broken = await screen.findByTestId("file-broken");
    expect(broken).toHaveTextContent("画像として読めません");
    // **断り欄とは別の場所に出ること。** 同じ言葉に潰すと、直す場所が分からなくなる
    expect(screen.queryByTestId("file-error")).toBeNull();
  });

  it("別のファイルへ移ると、作った URL を捨てる", async () => {
    record(
      () =>
        new Response(new Blob([new Uint8Array([1])], { type: "image/png" }), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const view = render(
      <Viewer host="local" root={ROOT} path={`${ROOT}/一枚目.png`} />,
    );
    await screen.findByTestId("file-image");
    expect(revoked).toHaveLength(0);

    view.rerender(
      <Viewer host="local" root={ROOT} path={`${ROOT}/二枚目.png`} />,
    );
    await waitFor(() => expect(revoked).toContain("blob:偽物/0"));
  });

  it("HTML は先にテキストの口で読んでから、隔離した箱に入れる", async () => {
    const calls = record(
      () =>
        new Response(
          JSON.stringify({
            path: `${ROOT}/理解.html`,
            text: "<!doctype html><p>理解</p>",
            truncated: false,
            bytes: 26,
          }),
          { status: 200 },
        ),
    );
    render(<Viewer host="local" root={ROOT} path={`${ROOT}/理解.html`} />);

    const frame = await screen.findByTestId("file-frame");
    // **鍵の片方。** 許すのは script の1段だけで、**`allow-same-origin` は書かない**
    // （`ファイルの中身に掛けた隔離を、script の1段だけ解く` 設計§4-2）
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("src")).toContain("as=raw");
    expect(frame.getAttribute("src")).toContain(
      encodeURIComponent(`${ROOT}/理解.html`),
    );
    // 先に叩くのはテキストの口（`as=raw` を含まない）
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("as=raw");
  });

  it("大きい HTML も箱に入る（整形を止める線を持ち込まない）", async () => {
    // **同じ `readFile` を通るからといって、Markdown と同じ扱いにしない。**
    // 箱の中を描くのはブラウザ自身のパーサ（別の文書）なので、`ReactMarkdown` の
    // 重さは当てはまらない。取り違えて `<pre>` へ落とした前科がある
    record(
      () =>
        new Response(
          JSON.stringify({
            path: `${ROOT}/理解.html`,
            text: "<!doctype html><p>理解</p>",
            truncated: false,
            bytes: 2 * 1024 * 1024,
          }),
          { status: 200 },
        ),
    );
    render(<Viewer host="local" root={ROOT} path={`${ROOT}/理解.html`} />);

    expect(await screen.findByTestId("file-frame")).toBeInTheDocument();
    expect(screen.queryByTestId("file-raw")).toBeNull();
    // 断り書きも出ない。**説明することが無い**（重くないので）
    expect(screen.queryByTestId("file-heavy")).toBeNull();
  });

  it("HTML が読めなかったら、箱を出さずに理由だけを出す", async () => {
    record(() => new Response("その場所は見つかりません", { status: 404 }));
    render(<Viewer host="local" root={ROOT} path={`${ROOT}/無い.html`} />);

    expect(await screen.findByTestId("file-error")).toHaveTextContent(
      "その場所は見つかりません",
    );
    expect(screen.queryByTestId("file-frame")).toBeNull();
  });

  it("SVG も同じ箱に入る（img へ落ちない）", async () => {
    record(
      () =>
        new Response(
          JSON.stringify({
            path: `${ROOT}/図.svg`,
            text: "<svg></svg>",
            truncated: false,
            bytes: 11,
          }),
          { status: 200 },
        ),
    );
    render(<Viewer host="local" root={ROOT} path={`${ROOT}/図.svg`} />);

    expect(await screen.findByTestId("file-frame")).toHaveAttribute(
      "sandbox",
      "allow-scripts",
    );
    expect(screen.queryByTestId("file-image")).toBeNull();
  });

  it("箱は出自を名乗れない——allow-same-origin を書かない", async () => {
    record(
      () =>
        new Response(
          JSON.stringify({
            path: `${ROOT}/理解.html`,
            text: "<!doctype html><p>理解</p>",
            truncated: false,
            bytes: 26,
          }),
          { status: 200 },
        ),
    );
    render(<Viewer host="local" root={ROOT} path={`${ROOT}/理解.html`} />);

    // **両方付くと隔離が実質消える。** 箱がダッシュボードと同じ出自を名乗れて、
    // script が自分で `sandbox` を外せる（設計§4-2）。**ここが崩れても画面は普通に
    // 動く**ので、字で見るしかない
    const sandbox = (await screen.findByTestId("file-frame")).getAttribute(
      "sandbox",
    );
    expect(sandbox).not.toContain("allow-same-origin");
    // 足していない許可も名指しで見る。**黙って増えないこと**が要点（設計§4-3）
    for (const 足していない of [
      "allow-popups",
      "allow-modals",
      "allow-forms",
      "allow-top-navigation",
    ]) {
      expect(sandbox).not.toContain(足していない);
    }
  });

  it("HTML でも生テキストへ行き来できる", async () => {
    record(
      () =>
        new Response(
          JSON.stringify({
            path: `${ROOT}/理解.html`,
            text: "<!doctype html><p>理解</p>",
            truncated: false,
            bytes: 26,
          }),
          { status: 200 },
        ),
    );
    render(<Viewer host="local" root={ROOT} path={`${ROOT}/理解.html`} />);
    await screen.findByTestId("file-frame");

    await userEvent.click(screen.getByTestId("file-toggle-raw"));

    expect(screen.getByTestId("file-raw")).toHaveTextContent("<p>理解</p>");
    expect(screen.queryByTestId("file-frame")).toBeNull();
  });
});

/** Ctrl+F を画面全体へ撃つ。**奪ったかどうかは `defaultPrevented` で言える** */
function CtrlF(): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  globalThis.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * 中を探す（`ファイルビュアの中を Ctrl+F で探せるようにする` テスト計画フェーズ3）。
 *
 * **探せるのはテキストとして出している2つだけで、これは選択ではなく制約である。**
 * 画像は文字を持たず、HTML ／ SVG の箱は外から中身に触れない——**触れないのは隔離が
 * 効いている証拠**であって、直すべき不具合ではない。
 */
describe("中を探す", () => {
  it("整形した Markdown では入口が出る", async () => {
    serve(content("# 計画"));
    show();
    expect(await screen.findByTestId("file-find-open")).toBeInTheDocument();
  });

  it("生テキストで見ているときも出る", async () => {
    serve(content("# 計画"));
    show();
    await userEvent.click(await screen.findByTestId("file-toggle-raw"));
    expect(screen.getByTestId("file-find-open")).toBeInTheDocument();
  });

  it("画像のときは出ない", async () => {
    // **押せるのに何も起きないものは、壊れているのと見分けが付かない**
    serve(content("なにか"));
    show(`${ROOT}/撮った.png`);
    await waitFor(() => {
      expect(screen.queryByTestId("file-find-open")).toBeNull();
    });
  });

  it("プレビュー（HTML）でも入口は出る", async () => {
    /*
      **2026-09-08 に覆った。** 箱の中は外から触れないので入口を出していなかったが、
      **利用者から見ると「探せない道具」に見えていた**。いまは**押したら生テキストへ
      連れていく**——同じ中身の別の見せ方であり、元から用意してある逃げ道でもある。
    */
    serve(content("<p>あ</p>"));
    show(`${ROOT}/理解.html`);
    await screen.findByTestId("file-frame");
    expect(screen.getByTestId("file-find-open")).toBeInTheDocument();
  });

  it("プレビューで探すと、生テキストへ切り替わって理由が出る", async () => {
    // **黙って見せ方を変えない。** 押した人から見ると画面が別物になる
    serve(content("<p>あか</p>"));
    show(`${ROOT}/理解.html`);
    await userEvent.click(await screen.findByTestId("file-find-open"));

    expect(await screen.findByTestId("file-raw")).toBeInTheDocument();
    expect(screen.queryByTestId("file-frame")).toBeNull();
    expect(screen.getByTestId("file-find")).toBeInTheDocument();
    expect(screen.getByTestId("file-find-switched")).toHaveTextContent(
      "生テキストに切り替えました",
    );
  });

  it("自分で見せ方を戻したら、切り替えの断りは消える", async () => {
    // そこから先は押した人が選んだ見せ方であって、こちらが切り替えた結果ではない
    serve(content("<p>あか</p>"));
    show(`${ROOT}/理解.html`);
    await userEvent.click(await screen.findByTestId("file-find-open"));
    expect(screen.getByTestId("file-find-switched")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("file-toggle-raw"));
    expect(screen.queryByTestId("file-find-switched")).toBeNull();
  });

  it("入口を押すと窓が出て、すぐ打てる", async () => {
    serve(content("# 計画"));
    show();
    await userEvent.click(await screen.findByTestId("file-find-open"));
    expect(screen.getByTestId("file-find")).toBeInTheDocument();
    expect(screen.getByTestId("file-find-input")).toHaveFocus();
  });

  it("探せるときの Ctrl+F は、ブラウザから奪う", async () => {
    /*
      **奪わないと成立しない。** ブラウザの探索は画面全体が対象で、この画面には
      セッションの区画・履歴・入力欄・サイドバーのファイル名が同居している。
    */
    serve(content("# 計画"));
    show();
    await screen.findByTestId("file-find-open");

    expect(CtrlF()).toBe(true);
    // **画面の外から撃った合図なので、反映を待つ**（React の更新は同期しない）
    expect(await screen.findByTestId("file-find")).toBeInTheDocument();
  });

  it("プレビューでも Ctrl+F を奪い、生テキストへ連れていく", async () => {
    /*
      **奪っておいて何もしないのが、いちばん悪い形である。** 前は奪わずに逃げ道だけを
      言っていたが、**押した結果が画面に出ない**ので「効かない」と読まれていた。
    */
    serve(content("<p>あか</p>"));
    show(`${ROOT}/理解.html`);
    await screen.findByTestId("file-frame");

    expect(CtrlF()).toBe(true);
    expect(await screen.findByTestId("file-find")).toBeInTheDocument();
    expect(screen.getByTestId("file-raw")).toBeInTheDocument();
  });

  it("切り替えの断りは、押されるまで出さない", async () => {
    // HTML を開くたびに書いてあると、探すつもりの無い人には雑音でしかない
    serve(content("<p>あ</p>"));
    show(`${ROOT}/理解.html`);
    await screen.findByTestId("file-frame");
    expect(screen.queryByTestId("file-find-switched")).toBeNull();
  });

  it("Ctrl+G でも開く", async () => {
    serve(content("# 計画"));
    show();
    await screen.findByTestId("file-find-open");

    const event = new KeyboardEvent("keydown", {
      key: "g",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    globalThis.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByTestId("file-find")).toBeInTheDocument();
  });

  it("画像のときは Ctrl+F を奪わない", async () => {
    // **連れていく先が無い。** 文字を持たないので、生テキストにしても読めない
    serve(content("なにか"));
    show(`${ROOT}/撮った.png`);
    await waitFor(() => {
      expect(screen.queryByTestId("file-find-open")).toBeNull();
    });
    expect(CtrlF()).toBe(false);
  });

  it("探す窓は、遡る箱の中に入っていない", async () => {
    /*
      **`position: absolute` の子は、スクロールする箱の中に置くと中身と一緒に流れる。**
      少し送っただけで窓が画面の外へ消えるので、基準は**箱を包む流れない段**でなければ
      ならない。**中に入れ直すとこの1本だけが落ちる。**
    */
    serve(content("# 計画"));
    show();
    await userEvent.click(await screen.findByTestId("file-find-open"));

    const 窓 = screen.getByTestId("file-find");
    const 箱 = screen.getByTestId("file-body");
    expect(箱.contains(窓)).toBe(false);
    // それでも同じ段に居る（浮かせる基準が共通の親であること）
    expect(窓.parentElement).toBe(箱.parentElement);
    expect(窓.parentElement?.className).toContain("relative");
  });

  it("ファイルを切り替えると、窓は畳まれる", async () => {
    // 前のファイルで打った語が残ると、当たりの数だけが別の文書のものに見える
    serve(content("# 計画"));
    const { rerender } = render(
      <Viewer host="local" root={ROOT} path={`${ROOT}/a.md`} />,
    );
    await userEvent.click(await screen.findByTestId("file-find-open"));
    expect(screen.getByTestId("file-find")).toBeInTheDocument();

    rerender(<Viewer host="local" root={ROOT} path={`${ROOT}/b.md`} />);

    await waitFor(() => {
      expect(screen.queryByTestId("file-find")).toBeNull();
    });
  });
});

/**
 * 文字の大きさ（`ファイルビュアの文字を小さめに始め…` テスト計画フェーズ2・3）。
 *
 * **jsdom は CSS を当てないので、実際に何ピクセルで出るかは見られない。** ここで
 * 確かめるのは**器が倍率を持ち、本文が直書きを持たないこと**まで。
 */
describe("文字の大きさ", () => {
  it("帯に「−」「＋」と倍率が出る", async () => {
    serve(content("# 計画"));
    show();
    await screen.findByTestId("file-zoom");
    expect(screen.getByTestId("file-zoom-out")).toBeInTheDocument();
    expect(screen.getByTestId("file-zoom-in")).toBeInTheDocument();
    expect(screen.getByTestId("file-zoom-reset")).toHaveTextContent("100%");
  });

  it("押すと段で動く", async () => {
    serve(content("# 計画"));
    show();
    await userEvent.click(await screen.findByTestId("file-zoom-in"));
    expect(screen.getByTestId("file-zoom-reset")).toHaveTextContent("110%");
    await userEvent.click(screen.getByTestId("file-zoom-out"));
    expect(screen.getByTestId("file-zoom-reset")).toHaveTextContent("100%");
  });

  it("倍率を押すと既定へ戻る", async () => {
    // **ボタンを1つ増やさずに済み、いまどの段に居るかが常に見える**
    serve(content("# 計画"));
    show();
    await userEvent.click(await screen.findByTestId("file-zoom-in"));
    await userEvent.click(screen.getByTestId("file-zoom-in"));
    expect(screen.getByTestId("file-zoom-reset")).toHaveTextContent("125%");

    await userEvent.click(screen.getByTestId("file-zoom-reset"));
    expect(screen.getByTestId("file-zoom-reset")).toHaveTextContent("100%");
  });

  it("上限・下限では押せない", async () => {
    // **押せるのに何も起きないものは、壊れているのと見分けが付かない**
    globalThis.localStorage.setItem("agentdashboard.file-zoom", "200");
    serve(content("# 計画"));
    show();
    await screen.findByTestId("file-zoom");
    expect(screen.getByTestId("file-zoom-in")).toBeDisabled();
    expect(screen.getByTestId("file-zoom-out")).not.toBeDisabled();

    globalThis.localStorage.setItem("agentdashboard.file-zoom", "80");
  });

  it("器が倍率を持ち、本文は直書きを持たない", async () => {
    /*
      **要素へ直接効くユーティリティに、器の側の変数は勝てない。** 直書きを外す
      ところまでが1組である（`index.css` の `.prose-body` が同じ理由で同じ形）。
    */
    globalThis.localStorage.setItem("agentdashboard.file-zoom", "100");
    serve(content("# 計画"));
    show();

    const 器 = await screen.findByTestId("file-view");
    expect(器.className).toContain("file-zoom");
    expect(器.getAttribute("style")).toContain("--file-zoom: 1");

    const 本文 = screen.getByTestId("file-markdown");
    expect(本文.className).toContain("file-prose");
    expect(本文.className).not.toContain("text-sm");
    expect(本文.className).not.toContain("leading-relaxed");
  });

  it("生テキストにも直書きが残っていない", async () => {
    serve(content("# 計画"));
    show();
    await userEvent.click(await screen.findByTestId("file-toggle-raw"));
    const 素 = screen.getByTestId("file-raw");
    expect(素.className).toContain("file-raw");
    expect(素.className).not.toContain("text-xs");
  });

  it("プレビューの箱が、倍率を読むクラスを持っている", async () => {
    // **jsdom は CSS を当てない。** 実際に何倍で出るかは実機で見る（フェーズ5）
    serve(content("<p>あ</p>"));
    show(`${ROOT}/理解.html`);
    const 箱 = await screen.findByTestId("file-frame");
    expect(箱.className).toContain("file-frame");
    expect(箱.parentElement?.className).toContain("file-frame-box");
    // 倍率は器（`file-view`）が持ち、箱がそれを読む
    expect(screen.getByTestId("file-view").getAttribute("style")).toContain(
      "--file-zoom",
    );
  });

  it("画像や箱を開いていても、大きさの操作は消えない", async () => {
    // **中身が変わらないだけで、操作は消えない**（帯の並びが窓の中身で動かない）
    serve(content("<p>あ</p>"));
    show(`${ROOT}/理解.html`);
    await screen.findByTestId("file-frame");
    expect(screen.getByTestId("file-zoom")).toBeInTheDocument();
  });
});

/**
 * ヘッダが1行に収まること（3つの要件がどれも完了条件に挙げている）。
 *
 * **実際に折り返すかは実機でしか言えない**（jsdom に幅が無い）。ここで固定するのは
 * **折り返さない綴りであること**と、**右の群が縮まないこと**まで。
 */
describe("ヘッダは1行", () => {
  it("折り返しを許さない", async () => {
    serve(content("# 計画"));
    show();
    await screen.findByTestId("file-tabs");
    const 帯 = screen.getByTestId("file-view").querySelector("header");
    expect(帯?.className).not.toContain("flex-wrap");
  });

  it("右の群は縮まない", async () => {
    // **`file-close` は閉じる手を渡したときだけ出る**（列を持たない場面では出さない）
    serve(content("# 計画"));
    render(
      <Viewer
        host="local"
        root={ROOT}
        path={`${ROOT}/計画.md`}
        onClose={() => {}}
      />,
    );
    const 群 = (await screen.findByTestId("file-close")).parentElement;
    expect(群?.className).toContain("shrink-0");
  });

  it("狭い窓では「生テキストで見る」が印だけになる", async () => {
    /*
      **折り返しを禁じたぶん、いちばん広い部品が入らなくなる**（約120px）。
      `DESIGN.md` §39.6 のターミナルトグルが同じことをしている。
      **言葉は `aria-label` と `title` に残る。**
    */
    serve(content("# 計画"));
    show();
    const 切替 = await screen.findByTestId("file-toggle-raw");
    expect(切替).toHaveAttribute("aria-label", "生テキストで見る");
    expect(切替.querySelector("svg")?.getAttribute("class")).toContain(
      "md:hidden",
    );
    expect(切替.querySelector("span")?.className).toContain("hidden");
    expect(切替.querySelector("span")?.className).toContain("md:inline");
  });
});
