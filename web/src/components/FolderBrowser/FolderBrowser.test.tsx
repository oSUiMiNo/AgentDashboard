/**
 * 一覧のコピー（設計「フォルダとファイル一覧のコピーボタンが効かない」§5）。
 *
 * **写せなかったときの側を見る。** 写せたときは既存の2本
 * （`useFilesParts.test.tsx` ／ `ProjectAdd.test.tsx`）が見ているが、
 * **写せなかったときは単体も E2E も1本も無かった**——それがこのイシューの症状
 * そのもので、スマホでは値を手に入れる手段が1つも残らなかった。
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FolderBrowser,
  コピー表示を畳むまで,
} from "@/components/FolderBrowser/FolderBrowser";
import { TOAST_LIFE_MS } from "@/stores/appNotices";

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

/**
 * 結果が出るまで進める。**描画を1つ挟むのが肝**（項目5-b）。
 *
 * `copy` は `then` の中でさらに `requestAnimationFrame` を1つ挟んでいる——
 * **押し直しを目に見せるため**に、いったん消えた状態を1度描いてから出し直す。
 * マイクロタスクだけ流しても、まだ答えは出ていない。
 *
 * **`requestAnimationFrame` は偽物にしない。** 下のテストが偽物にするのは
 * `setTimeout` だけで、フレームは本物のまま待つ。
 */
async function 答えが出るまで() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
  });
}

/**
 * 出したものが引っ込むまで（項目5）。
 *
 * **`setTimeout` だけを偽物にする。** 一覧の読み込みは実タイマーで進むので、
 * 行を掴むところまでは本物のまま済ませ、**押す直前に切り替える**。
 */
describe("出したものが引っ込む", () => {
  it("成功は 4 秒で消える。その手前では、まだ出ている", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    置く();
    const 行 = await 行たち();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(行[0]);
      await 答えが出るまで();
      expect(答え(行[0])).toBe("コピーしました");

      /*
        **手前と当日の両方を見る**（2026-09-08）。ここまで上（消えること）しか見て
        いなかったので、**うっかり 100ms にしても緑のまま**だった——短すぎる側は
        「押したのに何も出ない」に見えるので、症状としてはむしろ重い。
      */
      act(() => vi.advanceTimersByTime(コピー表示を畳むまで - 1));
      expect(答え(行[0])).toBe("コピーしました");

      act(() => vi.advanceTimersByTime(1));
      expect(答え(行[0])).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * **値そのものを見る。** 他のテストは定数を import して期待値に使うので、
   * **定数を書き換えると期待値ごと動いて緑のまま通る**。ここだけが数字を留める。
   *
   * トーストの7秒とは別物であることも同時に留める——揃えようとして戻されると、
   * 利用者の指定（4秒・2026-09-08）が黙って消える。
   */
  it("長さは 4 秒で、トーストの寿命とは別物である", () => {
    expect(コピー表示を畳むまで).toBe(4000);
    expect(コピー表示を畳むまで).toBeLessThan(TOAST_LIFE_MS);
  });

  it("失敗は時間では消えない——消えると逃げ道として使えない", async () => {
    // 既定の stub は写せない（`navigator.clipboard` が居ない）
    置く();
    const 行 = await 行たち();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(行[0]);
      await 答えが出るまで();
      expect(screen.getByTestId("folder-copy-failed")).toBeInTheDocument();

      // 成功と同じだけ待っても、**まだ在る**
      act(() => vi.advanceTimersByTime(コピー表示を畳むまで * 3));
      expect(screen.getByTestId("folder-copy-failed")).toBeInTheDocument();
      expect(screen.getByTestId("folder-copy-fallback")).toBeInTheDocument();

      // 消すのは人の手だけ
      fireEvent.click(screen.getByTestId("folder-copy-failed-dismiss"));
      expect(screen.queryByTestId("folder-copy-failed")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("同じ行を続けて押すと、いったん消えてから出直す", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    置く();
    const 行 = await 行たち();

    fireEvent.click(行[0]);
    await 答えが出るまで();
    expect(答え(行[0])).toBe("コピーしました");

    // **押した瞬間に消える。** ここが消えないと、2回目が起きたことが目に見えない
    fireEvent.click(行[0]);
    expect(答え(行[0])).toBeNull();

    // そして出直す
    await 答えが出るまで();
    expect(答え(行[0])).toBe("コピーしました");
  });

  it("別の行を押すと、前のタイマーは新しい表示を消しに来ない", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    置く();
    const 行 = await 行たち();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(行[0]);
      await 答えが出るまで();

      // 消える手前まで進めてから、別の行を押す
      act(() => vi.advanceTimersByTime(コピー表示を畳むまで - 1_000));
      fireEvent.click(行[1]);
      await 答えが出るまで();
      expect(答え(行[1])).toBe("コピーしました");

      // **前の行の期限を跨いでも、新しい表示は生きている**
      act(() => vi.advanceTimersByTime(2_000));
      expect(答え(行[1])).toBe("コピーしました");
    } finally {
      vi.useRealTimers();
    }
  });

  it("畳んでもタイマーは残らない", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    const 画面 = render(<FolderBrowser host="local" start={ROOT} root={ROOT} />);
    const 行 = await screen.findAllByTestId("folder-copy");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(行[0]);
      await 答えが出るまで();
      画面.unmount();

      // **消えた画面へ向けて発火しない。** 落とし忘れるとここで警告か例外になる
      expect(() => act(() => vi.advanceTimersByTime(コピー表示を畳むまで * 2))).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

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

/**
 * 名前が見切れたときに、全体を読む道（イシュー「ファイル一覧で名前に
 * マウスオーバーしたら全体を出す」）。
 *
 * # 道が2本あるのは、片方が指では効かないから
 *
 * 乗せたら出す指定はマウスのある環境でしか効かない。ところが**幅が狭くていちばん
 * 見切れるのはスマホ**なので、それだけだと**困っている側が救われない**。
 * だから**同じ名前を、長押しで開くメニューの見出しにも出している**。
 *
 * **ここで確かめられないこと**：乗せたときに実際に吹き出しが出るのはブラウザの既定の
 * 動作で、jsdom には無い。見張れるのは**指定が付いていて中身が正しいこと**まで。
 * 本物は実機で踏む（テスト計画フェーズ2）。
 */
describe("名前の全体を読む道", () => {
  it("名前に、全体が読める指定が付く", async () => {
    置く();
    const 行たち = await screen.findAllByTestId("folder-entry");

    // フォルダもファイルも。**見切れるのは種別を問わない**
    expect(行たち[0].querySelector('[title="MyDocs"]')).not.toBeNull();
    expect(行たち[1].querySelector('[title="計画.md"]')).not.toBeNull();
  });

  it("出すのは名前だけで、パスではない", async () => {
    // フルパスは同じ行のコピーが担っているので、役割を重ねない
    置く();
    const 行 = (await screen.findAllByTestId("folder-entry"))[0];
    const 名前 = 行.querySelector('[title="MyDocs"]');

    expect(名前).toHaveTextContent("MyDocs");
    expect(名前?.getAttribute("title")).not.toContain(ROOT);
  });

  it("長押し（右クリック）のメニューに、名前の全体が見出しとして出る", async () => {
    置く();
    const 行 = (await screen.findAllByTestId("folder-entry"))[0];

    await userEvent.pointer({ keys: "[MouseRight]", target: 行 });

    expect(await screen.findByTestId("folder-name-full")).toHaveTextContent(
      "MyDocs",
    );
  });

  it("見出しはファイルの行にも出る", async () => {
    // 「新しいタブで開く」はファイルだけだが、**名前は種別を問わず出す**。
    // **`onPickFile` を渡さないとファイルの行は据え置き**なので、ここでは渡す
    render(
      <FolderBrowser
        host="local"
        start={ROOT}
        root={ROOT}
        onPickFile={vi.fn()}
      />,
    );
    const 行 = (await screen.findAllByTestId("folder-entry"))[1];

    await userEvent.pointer({ keys: "[MouseRight]", target: 行 });

    expect(await screen.findByTestId("folder-name-full")).toHaveTextContent(
      "計画.md",
    );
  });

  it("見出しは押せない（選択肢に混ざっていない）", async () => {
    置く();
    await userEvent.pointer({
      keys: "[MouseRight]",
      target: (await screen.findAllByTestId("folder-entry"))[0],
    });

    const 見出し = await screen.findByTestId("folder-name-full");
    const 中身 = await screen.findByTestId("folder-menu");
    const 押せるもの = Array.from(中身.querySelectorAll('[role="menuitem"]'));

    // **見出しが押せるものの中に居ないこと**を、実際の並びで見る。
    // `role` を直接見るだけだと、空のときも通ってしまい何も見張れない
    expect(押せるもの).not.toContain(見出し);
    // フォルダの行なので、押せるのは「絶対パスをコピー」の1つだけ。
    // `Label` を `Item` に取り替えると、ここが2つになって落ちる
    expect(押せるもの).toHaveLength(1);
  });

  it("見出しを足しても、コピーの道は今までどおり効く", async () => {
    置く();
    await userEvent.pointer({
      keys: "[MouseRight]",
      target: (await screen.findAllByTestId("folder-entry"))[0],
    });

    await userEvent.click(await screen.findByTestId("folder-menu-copy-abs"));

    await waitFor(() =>
      expect(screen.getByTestId("folder-copy-fallback")).toHaveTextContent(
        `${ROOT}/MyDocs`,
      ),
    );
  });
});

/**
 * ファイルの行を、ブラウザの新しいタブへ開けるようにした（イシュー
 * 「サイドバーのファイルを、中クリックでブラウザの新しいタブに開く」）。
 *
 * # ここで確かめられることと、確かめられないこと
 *
 * **中クリックで実際に新しいタブが開くのは、こちらのコードではなくブラウザの既定の
 * 動作である。** jsdom には再現できないので、ここで見張れるのは
 * **「`preventDefault` を呼んでいないこと」＝ブラウザに任せていること**までである。
 * 本物は実機で踏む（テスト計画フェーズ6）。
 *
 * だから判定はすべて **`fireEvent` の戻り値**で見る。`dispatchEvent` は
 * `preventDefault` が呼ばれると `false` を返すので、**奪ったかどうかがそのまま出る**。
 */
describe("ファイルの行は、ブラウザの新しいタブへ開けるリンク", () => {
  const FILE = `${ROOT}/計画.md`;
  /** `lib/hostfs.ts` の `rawUrl` と同じ形。**画面で組み立てないことを、ここでも組み立てずに見る** */
  const RAW = `/api/hosts/local/file?path=${encodeURIComponent(FILE)}&as=raw`;

  /** 押せる形で置く。**`onPickFile` を渡さないとファイルの行は据え置き**なので、ここでは渡す */
  function 置く押せる形(onPickFile = vi.fn()) {
    render(
      <FolderBrowser
        host="local"
        start={ROOT}
        root={ROOT}
        onPickFile={onPickFile}
      />,
    );
    return onPickFile;
  }

  /** `folder-entry` の2つ目がファイル（1つ目は `MyDocs`＝フォルダ） */
  async function ファイルの行() {
    return (await screen.findAllByTestId("folder-entry"))[1];
  }

  async function フォルダの行() {
    return (await screen.findAllByTestId("folder-entry"))[0];
  }

  /*
    **走らせると「Not implemented: navigation to another Document」が5行出る。**
    あれは雑音ではなく**証拠**である——奪わなかった5つの押し方
    （Ctrl／Cmd／Shift／Alt／中ボタン）で、jsdom が本当に辿ろうとした跡なので、
    **消さずに残す。** 消すと「ブラウザに任せている」ことの手触りが無くなる。

    （`console.error` を差し替えても消えない。jsdom は自前の口へ出しているため。）
  */

  describe("姿", () => {
    it("ファイルの行はリンクで、行き先は rawUrl と一致する", async () => {
      置く押せる形();
      const 行 = await ファイルの行();

      expect(行.tagName).toBe("A");
      expect(行).toHaveAttribute("href", RAW);
    });

    it("target を付けない（付けると素の左クリックまで外へ出る）", async () => {
      置く押せる形();
      expect(await ファイルの行()).not.toHaveAttribute("target");
    });

    it("rel に noopener を付ける（開いた先から元の窓を触らせない）", async () => {
      置く押せる形();
      expect(await ファイルの行()).toHaveAttribute("rel", "noopener");
    });

    it("フォルダの行はボタンのまま（行き先の URL が無い）", async () => {
      置く押せる形();
      expect((await フォルダの行()).tagName).toBe("BUTTON");
    });

    it("onPickFile を渡さないと、ファイルの行はボタンで disabled のまま", async () => {
      置く();
      const 行 = (await screen.findAllByTestId("folder-entry"))[1];

      expect(行.tagName).toBe("BUTTON");
      expect(行).toBeDisabled();
    });

    it("印（testid・kind・name）と中身が、いままでどおり引ける", async () => {
      置く押せる形();
      const 行 = await ファイルの行();

      expect(行).toHaveAttribute("data-kind", "file");
      expect(行).toHaveAttribute("data-name", "計画.md");
      expect(行).toHaveTextContent("計画.md");
      // アイコンの位置も変わっていない（行の中に居る）
      expect(行.querySelector('[data-testid="folder-entry-icon"]')).not.toBeNull();
      // 的の大きさを決めているクラスが移っている
      expect(行.className).toContain("flex-1");
      expect(行.className).toContain("justify-start");
    });
  });

  describe("押し方の分岐", () => {
    it("素の左クリックは奪って、アプリの中で開く", async () => {
      const 押された = 置く押せる形();
      const 行 = await ファイルの行();

      // `false` ＝ `preventDefault` が呼ばれた＝ブラウザは移動しない
      expect(fireEvent.click(行, { button: 0 })).toBe(false);
      expect(押された).toHaveBeenCalledTimes(1);
      expect(押された).toHaveBeenCalledWith(FILE);
    });

    /**
     * **修飾キー付きは1つも奪わない。** 奪った瞬間に新しいタブは開かなくなるので、
     * ここが「効くこと」の実質的な確認になる。
     *
     * `Shift`（新しい窓）と `Alt`（保存）は要望に無いが、**リンクの標準として
     * ついてくる**——止めないという同じ判断の裏返しである。
     */
    it.each([
      ["Ctrl", { ctrlKey: true }],
      ["Cmd（meta）", { metaKey: true }],
      ["Shift", { shiftKey: true }],
      ["Alt", { altKey: true }],
    ])("%s ＋左クリックは奪わず、ブラウザに任せる", async (_名, 修飾) => {
      const 押された = 置く押せる形();
      const 行 = await ファイルの行();

      expect(fireEvent.click(行, { button: 0, ...修飾 })).toBe(true);
      expect(押された).not.toHaveBeenCalled();
    });

    it("中ボタンが click として届く環境でも奪わない（保険）", async () => {
      const 押された = 置く押せる形();
      const 行 = await ファイルの行();

      expect(fireEvent.click(行, { button: 1 })).toBe(true);
      expect(押された).not.toHaveBeenCalled();
    });

    it("Enter で開く（リンクのキーボード操作）", async () => {
      const 押された = 置く押せる形();
      const 行 = await ファイルの行();

      行.focus();
      await userEvent.keyboard("{Enter}");

      expect(押された).toHaveBeenCalledWith(FILE);
    });

    /*
      **Ctrl／Cmd＋Enter は、ここでは確かめられない**（隣の枝の規則2・2026-09-08 追加）。

      書いてみたが、**jsdom は `Ctrl＋Enter` でクリックを1つも出さなかった**——
      「押されなかったこと」だけを見る形にすると、**クリックが飛んでいないだけでも
      緑になる**（実際に一度そうなった）。**確かめられないものを、確かめたことに
      しない。**

      こちらのコードから言えるのは、**修飾キーが立った `click` を奪わない**ことだけで、
      それは上の `it.each` が見ている。**キーボードから本当に新しいタブが開くかは
      実機で踏む**（テスト計画 6-13）。
    */

    it("フォルダの行は、修飾キーを押しても辿る（リンクではないので分岐が要らない）", async () => {
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
      置く押せる形();

      fireEvent.click(await フォルダの行(), { button: 0, ctrlKey: true });

      await waitFor(() =>
        expect(screen.getByTestId("folder-browser")).toHaveAttribute(
          "data-path",
          `${ROOT}/MyDocs`,
        ),
      );
    });
  });

  describe("周りを壊していない", () => {
    it("ファイルの行でも、右クリックのメニューが出る", async () => {
      置く押せる形();
      const 行 = await ファイルの行();

      await userEvent.pointer({ keys: "[MouseRight]", target: 行 });

      expect(await screen.findByTestId("folder-menu")).toBeInTheDocument();
    });

    it("コピーの的はボタンのまま（中クリックで新しいタブが開かない）", async () => {
      置く押せる形();
      const 的 = (await screen.findAllByTestId("folder-copy"))[1];

      expect(的.tagName).toBe("BUTTON");
      expect(的).not.toHaveAttribute("href");
    });
  });
});
