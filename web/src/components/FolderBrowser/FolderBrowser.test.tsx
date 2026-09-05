/**
 * 一覧のコピー（設計「フォルダとファイル一覧のコピーボタンが効かない」§5）。
 *
 * **写せなかったときの側を見る。** 写せたときは既存の2本
 * （`useFilesParts.test.tsx` ／ `ProjectAdd.test.tsx`）が見ているが、
 * **写せなかったときは単体も E2E も1本も無かった**——それがこのイシューの症状
 * そのもので、スマホでは値を手に入れる手段が1つも残らなかった。
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderBrowser } from "@/components/FolderBrowser/FolderBrowser";

const ROOT = "/home/me/dev/app";

function listing(path: string, names: string[]) {
  return {
    path,
    entries: names.map((name) => ({
      name,
      kind: name.includes(".") ? ("file" as const) : ("dir" as const),
      is_project: false,
    })),
    truncated: false,
  };
}

beforeEach(() => {
  /**
   * **安全でないオリジンを、そのまま写した形。**
   *
   * `navigator.clipboard` は**存在しない**——「呼ぶと失敗する」のではなく居ない。
   * そして jsdom は `document.execCommand` も持たないので、**三層のうち①②が
   * どちらも使えず、逃げ道まで落ちる**。スマホで踏んでいるのと同じ形になる。
   */
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(listing(ROOT, ["MyDocs", "計画.md"])), {
          status: 200,
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function 置く() {
  render(<FolderBrowser host="local" start={ROOT} root={ROOT} />);
}

async function 行たち() {
  return await screen.findAllByTestId("folder-copy");
}

/**
 * その行のコピーの答え。**押す前は `null`**。
 *
 * ボタンは絵になったので（要件23・設計§8-3）、**押す前は字を1つも持たない**。
 * 「コピー」という字が出ているかで押す前かどうかを見ていた形は、ここで成立しなくなった
 * ——答えの有無で見る。**絵にしたのはボタンだけで、結果は字のまま**である。
 */
function 答え(ボタン: HTMLElement): string | null {
  return (
    ボタン.querySelector('[data-testid="folder-copy-state"]')?.textContent ??
    null
  );
}

describe("写せなかったとき", () => {
  it("値がパネルの上に出て、そこから取れる", async () => {
    置く();
    await userEvent.click((await 行たち())[0]);

    await waitFor(() =>
      expect(screen.getByTestId("folder-copy-failed")).toHaveTextContent(
        "コピーできません",
      ),
    );
    // **フォルダは末尾に `/`。** 逃げ道から取った値も、押して入る値と同じでなければ意味が無い
    expect(screen.getByTestId("folder-copy-fallback")).toHaveTextContent(
      "MyDocs/",
    );
  });

  it("値は選べる形で出る（指でなぞれば全体が取れる）", async () => {
    // **字で「選べます」と書くのではなく、選べる指定そのものを見る。**
    // スマホには `title` を読む操作が無いので、ここが唯一の受け皿になる
    置く();
    await userEvent.click((await 行たち())[0]);

    await waitFor(() =>
      expect(screen.getByTestId("folder-copy-fallback")).toHaveClass(
        "select-all",
      ),
    );
  });

  it("押した行のボタンにも「コピーできません」と出る", async () => {
    置く();
    const 行 = await 行たち();
    await userEvent.click(行[0]);

    await waitFor(() => expect(答え(行[0])).toBe("コピーできません"));
    // 押していない行は手つかずのまま
    expect(答え(行[1])).toBeNull();
    // **絵は消えない。** 答えが出るのは押した行だけで、押す道は全部の行に在り続ける
    expect(行[1].querySelector("svg")).not.toBeNull();
  });

  it("別の行を押すと、前の行の答えは消える", async () => {
    // **答えは1組しか持たない**（設計§5）。覚え続けると上に何行も並び、
    // どれが最後に押したものか分からなくなる
    置く();
    const 行 = await 行たち();

    await userEvent.click(行[0]);
    await waitFor(() =>
      expect(screen.getByTestId("folder-copy-fallback")).toHaveTextContent(
        "MyDocs/",
      ),
    );

    await userEvent.click(行[1]);
    await waitFor(() =>
      expect(screen.getByTestId("folder-copy-fallback")).toHaveTextContent(
        "計画.md",
      ),
    );
    // 逃げ道は1つだけ。**前のぶんが残らない**
    expect(screen.getAllByTestId("folder-copy-fallback")).toHaveLength(1);
    expect(行[0]).not.toHaveTextContent("コピーできません");
  });

  it("次の行を押した瞬間に、前の答えは消える（返ってくるのを待たない）", async () => {
    // **待つと、押したのに前の行の値が出たままになる。**「1組だけ持つ」の意味は
    // 「最後に押したものだけが答え」なので、**押した瞬間**に前のぶんは無効になる。
    //
    // 答えが返るまでを自分で握らないと、この差は見えない——`waitFor` で待つと、
    // 消してから入れ直したのか、入れ替わっただけなのかが区別できない
    // 入れ物へ入れて渡す。素の変数だと、TS が「コールバックの中の代入」を
    // 見てくれず `null` のまま絞り込む
    const 待ち: { 返す?: () => void } = {};
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(
          () =>
            new Promise<void>((done) => {
              待ち.返す = done;
            }),
        ),
      },
    });

    置く();
    const 行 = await 行たち();

    await userEvent.click(行[0]);
    待ち.返す?.();
    await waitFor(() => expect(答え(行[0])).toBe("コピーしました"));

    // 2行目を押す。**まだ答えは返していない**
    await userEvent.click(行[1]);
    expect(答え(行[0])).toBeNull();
    expect(答え(行[1])).toBeNull();
  });

  it("押すまでは、逃げ道を出さない", async () => {
    置く();
    await 行たち();

    expect(screen.queryByTestId("folder-copy-failed")).toBeNull();
  });

  it("押しても階層は動かない", async () => {
    // 開く的とコピーの的は分けてある（設計§13）。逃げ道を足しても崩れていないこと
    置く();
    await userEvent.click((await 行たち())[0]);

    await waitFor(() =>
      expect(screen.getByTestId("folder-copy-failed")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("folder-browser")).toHaveAttribute(
      "data-path",
      ROOT,
    );
  });
});

describe("写せたとき", () => {
  it("逃げ道は出さず、押した行だけが「コピーしました」になる", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });

    置く();
    const 行 = await 行たち();
    await userEvent.click(行[0]);

    await waitFor(() => expect(答え(行[0])).toBe("コピーしました"));
    // **写せたのに逃げ道が出ると、押せていないように見える**
    expect(screen.queryByTestId("folder-copy-failed")).toBeNull();
    expect(答え(行[1])).toBeNull();
  });
});

/**
 * 1つ上へ出る道（要件3・細かい修正 設計§8-2）。
 *
 * **既存の設計と正面から衝突する項目だった。** `ファイル設計§15` は「左パネルは
 * その枠のパスから始まり、**上へは出られない**——相対パスの基準が壊れるため」と
 * 決めている。**ルートで押せなくすれば基準は壊れない**ので、設計を覆さずに両立する。
 */
describe("1つ上へ", () => {
  it("パンくずの左に居て、起点では押せない", async () => {
    置く();
    await 行たち();

    const 上 = screen.getByTestId("folder-up");
    // **起点＝ルートなので、これより上へは出られない**
    expect(上).toBeDisabled();
    expect(上).toHaveAttribute("aria-label", "1つ上のフォルダへ");
    // 押せない理由を、押す前に読める形で出す
    expect(上.getAttribute("title")).toContain("起点");
  });

  it("中へ入ると押せるようになり、押すと1つ上へ戻る", async () => {
    /*
      **既定のモックは、頼んだパスによらず起点を返す**（写せなかったときを見るための
      作りなので、階層は動かなくてよかった）。ここは階層が動くことそのものを見るので、
      **頼まれたパスをそのまま返す**形へ差し替える。
    */
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const 頼まれた =
          new URL(url, "http://x").searchParams.get("path") ?? ROOT;
        return new Response(
          JSON.stringify(listing(頼まれた, ["MyDocs", "計画.md"])),
          { status: 200 },
        );
      }),
    );
    置く();
    // `MyDocs` を開く（`folder-entry` の1つ目がフォルダ）
    const 行 = await screen.findAllByTestId("folder-entry");
    await userEvent.click(行[0]);

    await waitFor(() =>
      expect(screen.getByTestId("folder-browser")).toHaveAttribute(
        "data-path",
        `${ROOT}/MyDocs`,
      ),
    );

    const 上 = screen.getByTestId("folder-up");
    expect(上).not.toBeDisabled();
    // 行き先が押す前に読める（パンくずの末尾から2番目）
    expect(上.getAttribute("title")).toContain(ROOT);

    await userEvent.click(上);
    await waitFor(() =>
      expect(screen.getByTestId("folder-browser")).toHaveAttribute(
        "data-path",
        ROOT,
      ),
    );
  });

  it("印は文字ではなく図形で描いてある", async () => {
    置く();
    await 行たち();

    expect(screen.getByTestId("folder-up").querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("folder-up").textContent).toBe("");
  });

  it("パスの文字に紛れない太さで、軸のある矢印になっている", async () => {
    // **細い山形（`^`）は、パスの区切りや文字と見分けが付かなかった**（2026-09-05 の指定）。
    // ここはパンくずという**文字が並ぶ場所**なので、印の側が文字より強くないと読めない。
    //
    // 太さ3は `DESIGN.md` §18.2 の**記号型の下限**（グリッドの 1/8＝24 なら 3px）。
    置く();
    await 行たち();

    const svg = screen.getByTestId("folder-up").querySelector("svg");
    expect(svg?.getAttribute("stroke-width")).toBe("3");
    // **軸を必ず描く。** 矢じりだけにすると山形へ戻り、区別が消える
    const 線 = [...(svg?.querySelectorAll("path") ?? [])].map((p) =>
      p.getAttribute("d"),
    );
    expect(線).toHaveLength(2);
    expect(線.some((d) => d?.includes("V"))).toBe(true);
  });

  it("枠を持っていて、押せるものだと分かる", async () => {
    // 絵を強くするだけでは、**文字の隣に置いたときに「押せる」までは伝わらない**。
    // 既存の `outline` を使う——自前で枠を書くと、他のボタンと反応が揃わなくなる
    置く();
    await 行たち();

    // **`border` だけを見ないこと。** 基底が `border border-transparent` を持っているので、
    // どの variant でも当たってしまう（実際にこれで空振りした）。
    // `outline` だけが持つ `border-border` を見る
    expect(screen.getByTestId("folder-up").className).toContain("border-border");
  });
});

/**
 * コピーは絵になった（要件23・設計§8-3）。
 *
 * **絵にしたのはボタンだけで、結果ではない。** 結果まで絵にすると、成功と失敗が
 * 見分けられなくなる。
 */
describe("コピーの見た目", () => {
  it("押す前は絵だけで、字を持たない", async () => {
    置く();
    const 行 = await 行たち();

    expect(行[0].querySelector("svg")).not.toBeNull();
    expect(行[0].textContent).toBe("");
  });

  it("読み上げ名に、何をコピーするのかと基準が入っている", async () => {
    置く();
    const 行 = await 行たち();

    /*
      **絵だけになると、読み上げでは何をコピーするのか分からなくなる**（設計§8-3）。
      `title` は指で触る画面では読めないので、**両方に持たせる**。
    */
    const 名前 = 行[0].getAttribute("aria-label") ?? "";
    expect(名前).toContain("パスをコピー");
    expect(名前).toContain("MyDocs/");
    expect(名前).toContain(`${ROOT} からの相対パス`);
  });
});

/**
 * 右クリックのメニュー（要件27・設計§8-4）。
 *
 * 中身はまず「絶対パスをコピー」だけ。**押した結果は行のコピーと同じ道を通す**ので、
 * 写せない環境の逃げ道（`folder-copy-fallback`）が右クリック経由でも出る。
 */
describe("右クリックのメニュー", () => {
  it("右クリックで開き、絶対パスをコピーできる", async () => {
    const 写した: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async (v: string) => void 写した.push(v)) },
    });

    置く();
    const 行 = await screen.findAllByTestId("folder-entry");
    expect(screen.queryByTestId("folder-menu")).toBeNull();

    await userEvent.pointer({ keys: "[MouseRight]", target: 行[0] });
    await userEvent.click(await screen.findByTestId("folder-menu-copy-abs"));

    // **絶対パス**（行のコピーは相対パスなので、値が違うことに意味がある）
    await waitFor(() => expect(写した).toEqual([`${ROOT}/MyDocs`]));
  });

  it("写せない環境でも、右クリック経由で逃げ道が出る", async () => {
    // 別の道を作ると、ここだけ逃げ道が出なくなる
    置く();
    const 行 = await screen.findAllByTestId("folder-entry");

    await userEvent.pointer({ keys: "[MouseRight]", target: 行[0] });
    await userEvent.click(await screen.findByTestId("folder-menu-copy-abs"));

    await waitFor(() =>
      expect(screen.getByTestId("folder-copy-fallback")).toHaveTextContent(
        `${ROOT}/MyDocs`,
      ),
    );
  });
});
