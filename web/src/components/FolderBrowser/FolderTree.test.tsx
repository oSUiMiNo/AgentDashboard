import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderBrowser } from "@/components/FolderBrowser/FolderBrowser";
import { FolderTree } from "@/components/FolderBrowser/FolderTree";
import type { OpenInProp } from "@/components/FolderBrowser/parts";
import { コピー表示を畳むまで } from "@/components/FolderBrowser/useCopyAnswer";
import { putExpanded, readExpanded } from "@/lib/filesPlace";
import { resetListings } from "@/lib/folderListings";
import type { OpenInView } from "@/lib/openIn";
import { 一覧を引き直す間隔 } from "@/lib/poll";

const ROOT = "/home/me/dev/app";
const 上 = "/home/me/dev";

type 項目 = string | { name: string; kind: "dir" | "file" | "symlink"; is_project?: boolean };
type 定義 =
  | 項目[]
  | { names: 項目[]; truncated: boolean }
  | { status: number; body: string }
  | "止める";

interface 偽の口の記録 {
  表: Map<string, 定義>;
  問い: string[];
  飛んでいる: number;
  最大: number;
  止めた: { path: string; 返す: (定義: 定義) => void }[];
}

function 項目に(each: 項目) {
  if (typeof each === "string") {
    return {
      name: each,
      kind: each.includes(".") ? ("file" as const) : ("dir" as const),
      is_project: false,
    };
  }
  return { is_project: false, ...each };
}

function 応答(path: string, 中身: 定義 | undefined): Response {
  if (中身 === undefined || 中身 === "止める") {
    return new Response("その場所は見つかりません", { status: 404 });
  }
  if (Array.isArray(中身)) {
    return new Response(
      JSON.stringify({ path, entries: 中身.map(項目に), truncated: false }),
      { status: 200 },
    );
  }
  if ("status" in 中身) {
    return new Response(中身.body, { status: 中身.status });
  }
  return new Response(
    JSON.stringify({ path, entries: 中身.names.map(項目に), truncated: 中身.truncated }),
    { status: 200 },
  );
}

function 偽の口(初め: Record<string, 定義>): 偽の口の記録 {
  const 記録: 偽の口の記録 = {
    表: new Map(Object.entries(初め)),
    問い: [],
    飛んでいる: 0,
    最大: 0,
    止めた: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url, "http://x").searchParams.get("path") ?? "";
      記録.問い.push(path);
      記録.飛んでいる += 1;
      記録.最大 = Math.max(記録.最大, 記録.飛んでいる);
      try {
        let 中身 = 記録.表.get(path);
        if (中身 === "止める") {
          中身 = await new Promise<定義>((resolve) => {
            記録.止めた.push({ path, 返す: resolve });
          });
        }
        return 応答(path, 中身);
      } finally {
        記録.飛んでいる -= 1;
      }
    }),
  );
  return 記録;
}

const 基本: Record<string, 定義> = {
  [ROOT]: ["MyDocs", "src", "計画.md", "README.md"],
  [`${ROOT}/MyDocs`]: ["sub", "メモ.md"],
  [`${ROOT}/MyDocs/sub`]: ["a.md"],
  [`${ROOT}/src`]: ["main.ts"],
};

function 置く({
  root = ROOT,
  loadExpanded = () => [],
  onExpandedChange = vi.fn(),
  onPickFile = vi.fn(),
  current,
  openIn,
}: {
  root?: string;
  loadExpanded?: () => string[];
  onExpandedChange?: (expanded: string[]) => void;
  onPickFile?: (path: string) => void;
  current?: string;
  openIn?: OpenInProp;
} = {}) {
  const 結果 = render(
    <FolderTree
      host="local"
      root={root}
      loadExpanded={loadExpanded}
      onExpandedChange={onExpandedChange}
      onPickFile={onPickFile}
      current={current}
      openIn={openIn}
    />,
  );
  return { ...結果, onExpandedChange, onPickFile };
}

function 行(path: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="folder-entry"][data-path="${path}"]`,
  );
}

function 要る行(path: string): HTMLElement {
  const 見つけた = 行(path);
  if (見つけた === null) {
    throw new Error(`行 ${path} が無い`);
  }
  return 見つけた;
}

async function 出るまで(path: string): Promise<HTMLElement> {
  return await waitFor(() => 要る行(path));
}

function 子の一覧(path: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="folder-children"][data-path="${path}"]`,
  );
}

function コピーの的(path: string): HTMLElement {
  const 的 = 要る行(path).parentElement?.querySelector<HTMLElement>(
    '[data-testid="folder-copy"]',
  );
  if (的 === null || 的 === undefined) {
    throw new Error(`行 ${path} のコピーの的が無い`);
  }
  return 的;
}

function 行の答え(path: string): string | null {
  return (
    コピーの的(path).querySelector('[data-testid="folder-copy-state"]')?.textContent ?? null
  );
}

function PJT名の段(): HTMLElement {
  const 段 = screen
    .getAllByTestId("folder-crumb")
    .find((each) => each.getAttribute("title") === ROOT);
  if (段 === undefined) {
    throw new Error("PJT 名の段が無い");
  }
  return 段;
}

function 起点より上の段(): HTMLElement {
  const 段 = screen
    .getAllByTestId("folder-crumb")
    .find((each) => each.textContent === "…");
  if (段 === undefined || 段.parentElement === null) {
    throw new Error("「…」の段が無い");
  }
  return 段.parentElement;
}

function 写せる(): string[] {
  const 写した: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async (v: string) => void 写した.push(v)) },
  });
  return 写した;
}

async function 流す() {
  await act(async () => {
    for (let i = 0; i < 40; i += 1) {
      await Promise.resolve();
    }
  });
}

async function 十秒進める() {
  await act(async () => {
    vi.advanceTimersByTime(一覧を引き直す間隔);
  });
  await 流す();
}

async function 答えが出るまで() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
  });
}

async function 右クリック(target: Element) {
  await userEvent.pointer({ keys: "[MouseRight]", target });
  return await screen.findByTestId("folder-menu");
}

async function 長押し(target: Element) {
  await userEvent.pointer({ keys: "[TouchA>]", target });
  await new Promise((done) => setTimeout(done, 900));
  await userEvent.pointer({ keys: "[/TouchA]", target });
}

async function メニューを閉じる() {
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryAllByTestId("folder-menu")).toHaveLength(0));
}

async function 項目を押す(testid: string) {
  await userEvent.click(screen.getByTestId(testid));
  await 答えが出るまで();
}

function 印の色(path: string): string {
  const 印 = 要る行(path).querySelector<SVGElement>('[data-testid="folder-entry-icon"] svg');
  return 印?.style.color ?? "";
}

function view(over: Partial<OpenInView> = {}): OpenInView {
  return {
    same_machine: true,
    same_machine_reason: null,
    explorer: { available: true, reason: null },
    vscode: { available: true, reason: null },
    opened: [],
    ...over,
  };
}

beforeEach(() => {
  resetListings();
  localStorage.clear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("展開と畳み", () => {
  it("フォルダを押すとその場で展開して子が1段下に出て、もう一度押すと畳んで子の一覧が木から外れる", async () => {
    偽の口(基本);
    置く();
    const MyDocs = await 出るまで(`${ROOT}/MyDocs`);
    expect(MyDocs.style.paddingLeft).toBe("8px");

    fireEvent.click(MyDocs);
    const sub = await 出るまで(`${ROOT}/MyDocs/sub`);
    expect(sub.style.paddingLeft).toBe("20px");
    expect(要る行(`${ROOT}/MyDocs/メモ.md`).style.paddingLeft).toBe("20px");
    expect(子の一覧(`${ROOT}/MyDocs`)).not.toBeNull();
    expect(要る行(`${ROOT}/計画.md`).style.paddingLeft).toBe("8px");

    fireEvent.click(MyDocs);
    expect(子の一覧(`${ROOT}/MyDocs`)).toBeNull();
    expect(行(`${ROOT}/MyDocs/sub`)).toBeNull();
  });

  it("見出しの行は「… / PJT 名」のままで、1つ上へのボタンが無く、器は PJT のルートとツリーの印を持つ", async () => {
    偽の口(基本);
    置く();
    const MyDocs = await 出るまで(`${ROOT}/MyDocs`);
    fireEvent.click(MyDocs);
    await 出るまで(`${ROOT}/MyDocs/sub`);

    const 見出し = screen.getByTestId("folder-crumbs");
    expect(見出し.textContent).toBe("…/app");
    expect(見出し.getAttribute("aria-label")).toBe("PJT のフォルダ");
    expect(screen.queryByTestId("folder-up")).toBeNull();
    const 器 = screen.getByTestId("folder-browser");
    expect(器.getAttribute("data-path")).toBe(ROOT);
    expect(器.getAttribute("data-mode")).toBe("tree");
  });

  it("展開すると、その枝の1段だけを1回読む", async () => {
    const 口 = 偽の口(基本);
    置く();
    const MyDocs = await 出るまで(`${ROOT}/MyDocs`);
    expect(口.問い).toEqual([ROOT]);

    fireEvent.click(MyDocs);
    await 出るまで(`${ROOT}/MyDocs/sub`);
    await 流す();

    expect(口.問い).toEqual([ROOT, `${ROOT}/MyDocs`]);
  });

  it("aria-expanded はフォルダの行にだけ付いて展開と畳みで切り替わり、aria-controls は付かない", async () => {
    偽の口({
      ...基本,
      [ROOT]: ["MyDocs", "計画.md", { name: "リンク", kind: "symlink" }],
    });
    置く();
    const MyDocs = await 出るまで(`${ROOT}/MyDocs`);
    expect(MyDocs.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(MyDocs);
    await 出るまで(`${ROOT}/MyDocs/sub`);
    expect(MyDocs.getAttribute("aria-expanded")).toBe("true");
    expect(要る行(`${ROOT}/MyDocs/sub`).getAttribute("aria-expanded")).toBe("false");

    expect(要る行(`${ROOT}/計画.md`).hasAttribute("aria-expanded")).toBe(false);
    expect(要る行(`${ROOT}/MyDocs/メモ.md`).hasAttribute("aria-expanded")).toBe(false);
    expect(要る行(`${ROOT}/リンク`).hasAttribute("aria-expanded")).toBe(false);

    fireEvent.click(MyDocs);
    expect(MyDocs.getAttribute("aria-expanded")).toBe("false");

    for (const each of screen.getAllByTestId("folder-entry")) {
      expect(each.hasAttribute("aria-controls")).toBe(false);
    }
  });

  it("キーボードでは、フォルダの行は Enter と Space で展開・畳みをし、ファイルの行は Enter で開いて Space では開かない", async () => {
    偽の口(基本);
    const { onPickFile } = 置く();
    const MyDocs = await 出るまで(`${ROOT}/MyDocs`);

    MyDocs.focus();
    await userEvent.keyboard("{Enter}");
    expect(MyDocs.getAttribute("aria-expanded")).toBe("true");
    await 出るまで(`${ROOT}/MyDocs/sub`);
    await userEvent.keyboard("{Enter}");
    expect(MyDocs.getAttribute("aria-expanded")).toBe("false");
    await userEvent.keyboard(" ");
    expect(MyDocs.getAttribute("aria-expanded")).toBe("true");
    await 出るまで(`${ROOT}/MyDocs/sub`);
    await userEvent.keyboard(" ");
    expect(MyDocs.getAttribute("aria-expanded")).toBe("false");

    const ファイル = 要る行(`${ROOT}/計画.md`);
    ファイル.focus();
    await userEvent.keyboard(" ");
    expect(onPickFile).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onPickFile).toHaveBeenCalledTimes(1);
    expect(onPickFile).toHaveBeenCalledWith(`${ROOT}/計画.md`);
  });

  it("親を畳んで展開し直すと、中で展開していた子も前のとおり展開して出る", async () => {
    偽の口(基本);
    置く();
    const MyDocs = await 出るまで(`${ROOT}/MyDocs`);
    fireEvent.click(MyDocs);
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs/sub`));
    await 出るまで(`${ROOT}/MyDocs/sub/a.md`);

    fireEvent.click(MyDocs);
    expect(行(`${ROOT}/MyDocs/sub`)).toBeNull();
    expect(行(`${ROOT}/MyDocs/sub/a.md`)).toBeNull();

    fireEvent.click(MyDocs);
    await 出るまで(`${ROOT}/MyDocs/sub/a.md`);
    expect(要る行(`${ROOT}/MyDocs/sub`).getAttribute("aria-expanded")).toBe("true");
  });

  it("素早く展開・畳み・展開をしても、古い答えで上書きされない", async () => {
    const 口 = 偽の口({ ...基本, [`${ROOT}/MyDocs`]: "止める" });
    置く();
    const MyDocs = await 出るまで(`${ROOT}/MyDocs`);

    fireEvent.click(MyDocs);
    fireEvent.click(MyDocs);
    fireEvent.click(MyDocs);
    expect(口.止めた.map((each) => each.path)).toEqual([`${ROOT}/MyDocs`, `${ROOT}/MyDocs`]);
    const [古い問い, 新しい問い] = 口.止めた;

    新しい問い.返す(["新しい.md"]);
    await 出るまで(`${ROOT}/MyDocs/新しい.md`);

    古い問い.返す(["古い.md"]);
    await 流す();

    expect(行(`${ROOT}/MyDocs/古い.md`)).toBeNull();
    expect(行(`${ROOT}/MyDocs/新しい.md`)).not.toBeNull();
  });
});

describe("読めないとき", () => {
  it("人が展開して読めないときは、その枝に理由が出て、中身は出ない", async () => {
    偽の口({ ...基本, [`${ROOT}/MyDocs`]: { status: 403, body: "読む権限がありません" } });
    置く();
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));

    const 理由 = await screen.findByTestId("folder-error");
    expect(理由.getAttribute("data-path")).toBe(`${ROOT}/MyDocs`);
    expect(理由.textContent).toBe("読む権限がありません");
    const 枝 = 子の一覧(`${ROOT}/MyDocs`);
    expect(枝).not.toBeNull();
    expect(枝?.querySelectorAll('[data-testid="folder-entry"]')).toHaveLength(0);
  });

  it("覚えから展開した枝が消えていた（404）ときは、断り文を出さずに黙って畳み、覚えから外す", async () => {
    const 口 = 偽の口({ [ROOT]: ["MyDocs", "src", "計画.md"] });
    const { onExpandedChange } = 置く({ loadExpanded: () => [`${ROOT}/MyDocs`] });
    const MyDocs = await 出るまで(`${ROOT}/MyDocs`);
    await waitFor(() => expect(onExpandedChange).toHaveBeenCalled());
    await 流す();

    expect(口.問い).toContain(`${ROOT}/MyDocs`);
    expect(screen.queryAllByTestId("folder-error")).toHaveLength(0);
    expect(MyDocs.getAttribute("aria-expanded")).toBe("false");
    expect(子の一覧(`${ROOT}/MyDocs`)).toBeNull();
    expect(onExpandedChange).toHaveBeenLastCalledWith([]);
  });

  it("覚えから展開した枝が読めないだけ（404 以外）なら、理由を出して展開したまま", async () => {
    偽の口({ ...基本, [`${ROOT}/MyDocs`]: { status: 504, body: "PC が応じません" } });
    const { onExpandedChange } = 置く({ loadExpanded: () => [`${ROOT}/MyDocs`] });

    const 理由 = await screen.findByTestId("folder-error");
    expect(理由.getAttribute("data-path")).toBe(`${ROOT}/MyDocs`);
    expect(理由.textContent).toBe("PC が応じません");
    expect(要る行(`${ROOT}/MyDocs`).getAttribute("aria-expanded")).toBe("true");
    expect(onExpandedChange).not.toHaveBeenCalled();
  });

  it("覚えがルートの外を指していても、ルートの外は読まない", async () => {
    const 外 = [上, "/etc", "/home/me/dev/app-old", "/home/me/dev/app/../x"];
    const 口 = 偽の口({
      ...基本,
      [上]: ["app", "app-old"],
      "/etc": ["hosts"],
      "/home/me/dev/app-old": ["古い.md"],
    });
    置く({ loadExpanded: () => 外 });
    await 出るまで(`${ROOT}/MyDocs`);
    await 流す();

    for (const each of 外) {
      expect(口.問い).not.toContain(each);
    }
    expect(口.問い).toEqual([ROOT]);
  });
});

describe("知らせ", () => {
  it("空・読み込み中・打ち切りの知らせは、その枝の最初の行に、子と同じ字下げで出る", async () => {
    偽の口({
      [ROOT]: ["空っぽ", "遅い", "多い"],
      [`${ROOT}/空っぽ`]: [],
      [`${ROOT}/遅い`]: "止める",
      [`${ROOT}/多い`]: { names: ["x.md"], truncated: true },
    });
    置く();
    for (const name of ["空っぽ", "遅い", "多い"]) {
      fireEvent.click(await 出るまで(`${ROOT}/${name}`));
    }
    await 出るまで(`${ROOT}/多い/x.md`);
    await waitFor(() => expect(screen.getByTestId("folder-branch-empty")).toBeTruthy());

    const 空 = screen.getByTestId("folder-branch-empty");
    expect(空.getAttribute("data-path")).toBe(`${ROOT}/空っぽ`);
    expect(空.textContent).toBe("空のフォルダ");
    expect(子の一覧(`${ROOT}/空っぽ`)?.firstElementChild).toBe(空);
    expect(空.style.paddingLeft).toBe("20px");

    const 中 = screen.getByTestId("folder-branch-loading");
    expect(中.getAttribute("data-path")).toBe(`${ROOT}/遅い`);
    expect(中.textContent).toBe("読み込み中…");
    expect(子の一覧(`${ROOT}/遅い`)?.firstElementChild).toBe(中);
    expect(中.style.paddingLeft).toBe("20px");

    const 打ち切り = screen.getByTestId("folder-truncated");
    expect(打ち切り.getAttribute("data-path")).toBe(`${ROOT}/多い`);
    expect(打ち切り.textContent).toBe("多すぎるので途中までしか出していません");
    expect(打ち切り.textContent).not.toContain("打ち込んで");
    expect(子の一覧(`${ROOT}/多い`)?.firstElementChild).toBe(打ち切り);
    expect(打ち切り.style.paddingLeft).toBe("20px");
    expect(要る行(`${ROOT}/多い/x.md`).style.paddingLeft).toBe("20px");
  });
});

describe("10秒の読み直し", () => {
  it("10秒の読み直しは、見えている枝（ルートを含む）だけを読み、畳んだ枝は読まない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 口 = 偽の口(基本);
    置く();
    await 流す();
    fireEvent.click(要る行(`${ROOT}/MyDocs`));
    await 流す();
    fireEvent.click(要る行(`${ROOT}/src`));
    await 流す();
    fireEvent.click(要る行(`${ROOT}/src`));
    await 流す();
    expect(行(`${ROOT}/src/main.ts`)).toBeNull();
    口.問い.length = 0;

    await 十秒進める();

    expect([...口.問い].sort()).toEqual([ROOT, `${ROOT}/MyDocs`].sort());
  });

  it("10秒の読み直しは、断り文の枝と、人の操作や覚えからの読みが飛んでいる枝を読まず、その回もほかの見えている枝は読む", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 口 = 偽の口({
      [ROOT]: ["MyDocs", "src", "壊れ", "古い"],
      [`${ROOT}/MyDocs`]: ["メモ.md"],
      [`${ROOT}/src`]: "止める",
      [`${ROOT}/壊れ`]: { status: 403, body: "読む権限がありません" },
      [`${ROOT}/古い`]: "止める",
    });
    置く({ loadExpanded: () => [`${ROOT}/古い`] });
    await 流す();
    fireEvent.click(要る行(`${ROOT}/MyDocs`));
    await 流す();
    fireEvent.click(要る行(`${ROOT}/壊れ`));
    await 流す();
    fireEvent.click(要る行(`${ROOT}/src`));
    await 流す();
    expect(screen.getByTestId("folder-error").getAttribute("data-path")).toBe(`${ROOT}/壊れ`);
    expect(口.止めた.map((each) => each.path).sort()).toEqual([`${ROOT}/src`, `${ROOT}/古い`].sort());
    口.問い.length = 0;

    await 十秒進める();

    expect([...口.問い].sort()).toEqual([ROOT, `${ROOT}/MyDocs`].sort());
  });

  it("10秒の読み直しの失敗は黙り、前の中身を残す", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 口 = 偽の口(基本);
    置く();
    await 流す();
    fireEvent.click(要る行(`${ROOT}/MyDocs`));
    await 流す();
    expect(行(`${ROOT}/MyDocs/メモ.md`)).not.toBeNull();
    口.表.set(ROOT, { status: 504, body: "PC が応じません" });
    口.表.set(`${ROOT}/MyDocs`, { status: 504, body: "PC が応じません" });
    口.問い.length = 0;

    await 十秒進める();

    expect([...口.問い].sort()).toEqual([ROOT, `${ROOT}/MyDocs`].sort());
    expect(screen.queryAllByTestId("folder-error")).toHaveLength(0);
    expect(screen.queryByText("PC が応じません")).toBeNull();
    expect(行(`${ROOT}/MyDocs/メモ.md`)).not.toBeNull();
    expect(行(`${ROOT}/計画.md`)).not.toBeNull();
  });

  it("10秒の読み直しで中身が同じなら、描き直さない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 口 = 偽の口(基本);
    const 描いた = vi.fn();
    render(
      <Profiler id="木" onRender={描いた}>
        <FolderTree host="local" root={ROOT} loadExpanded={() => []} onExpandedChange={vi.fn()} />
      </Profiler>,
    );
    await 流す();
    fireEvent.click(要る行(`${ROOT}/MyDocs`));
    await 流す();
    expect(行(`${ROOT}/MyDocs/メモ.md`)).not.toBeNull();
    描いた.mockClear();
    口.問い.length = 0;

    await 十秒進める();

    expect([...口.問い].sort()).toEqual([ROOT, `${ROOT}/MyDocs`].sort());
    expect(描いた).not.toHaveBeenCalled();
  });

  it("覚えからの読みと10秒の読み直しは、同時に4本までしか飛ばない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 名前 = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];
    const 枝 = 名前.map((each) => `${ROOT}/${each}`);
    const 口 = 偽の口({
      [ROOT]: 名前,
      ...Object.fromEntries(枝.map((each) => [each, "止める" as const])),
    });
    置く({ loadExpanded: () => 枝 });
    await 流す();
    expect(口.止めた).toHaveLength(4);
    expect(口.最大).toBe(4);

    while (口.止めた.length > 0) {
      口.止めた.shift()?.返す(["x.md"]);
      await 流す();
    }
    expect(口.問い).toHaveLength(9);
    expect(口.最大).toBe(4);
    expect(行(`${ROOT}/f8/x.md`)).not.toBeNull();

    口.表.set(ROOT, "止める");
    for (const each of 枝) {
      口.表.set(each, "止める");
    }
    口.最大 = 0;
    await 十秒進める();
    expect(口.止めた).toHaveLength(4);
    expect(口.最大).toBe(4);

    let 返した = 0;
    while (口.止めた.length > 0) {
      const 次 = 口.止めた.shift();
      返した += 1;
      次?.返す(次.path === ROOT ? 名前 : ["x.md"]);
      await 流す();
    }
    expect(返した).toBe(9);
    expect(口.最大).toBe(4);
  });

  it("人が展開した1本は、覚えからの読みや読み直しの列に並ばず、すぐ投げる", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 名前 = ["f1", "f2", "f3", "f4", "f5", "f6"];
    const 枝 = 名前.map((each) => `${ROOT}/${each}`);
    const 口 = 偽の口({
      [ROOT]: [...名前, "人用"],
      [`${ROOT}/人用`]: ["y.md"],
      ...Object.fromEntries(枝.map((each) => [each, "止める" as const])),
    });
    置く({ loadExpanded: () => 枝 });
    await 流す();
    expect(口.止めた).toHaveLength(4);
    expect(口.問い).not.toContain(`${ROOT}/f5`);

    fireEvent.click(要る行(`${ROOT}/人用`));
    expect(口.問い).toContain(`${ROOT}/人用`);
    expect(口.最大).toBe(5);
    await 流す();

    expect(行(`${ROOT}/人用/y.md`)).not.toBeNull();
    expect(口.問い).not.toContain(`${ROOT}/f5`);
    expect(口.問い).not.toContain(`${ROOT}/f6`);
  });

  it("取り付け直したとき（サイドバーを閉じて開き直したとき）は、中身の控えを先に出し、「読み込み中…」を出さない", async () => {
    const 口 = 偽の口(基本);
    const 一回目 = 置く();
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));
    await 出るまで(`${ROOT}/MyDocs/sub`);
    一回目.unmount();

    口.表.set(ROOT, "止める");
    口.表.set(`${ROOT}/MyDocs`, "止める");
    置く({ loadExpanded: () => [`${ROOT}/MyDocs`] });

    expect(screen.queryAllByTestId("folder-branch-loading")).toHaveLength(0);
    expect(行(`${ROOT}/計画.md`)).not.toBeNull();
    expect(行(`${ROOT}/MyDocs/sub`)).not.toBeNull();
    await 流す();
    expect(口.止めた.map((each) => each.path).sort()).toEqual([ROOT, `${ROOT}/MyDocs`].sort());
    expect(screen.queryAllByTestId("folder-branch-loading")).toHaveLength(0);
    expect(行(`${ROOT}/MyDocs/sub`)).not.toBeNull();
  });

  it("展開しても、覚えの書き込みで読み直しが走らない", async () => {
    const 口 = 偽の口(基本);
    function Parent() {
      const [覚え, set覚え] = useState<string[]>([]);
      return (
        <FolderTree host="local" root={ROOT} loadExpanded={() => 覚え} onExpandedChange={set覚え} />
      );
    }
    render(<Parent />);
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));
    await 出るまで(`${ROOT}/MyDocs/sub`);
    await 流す();

    expect(口.問い).toEqual([ROOT, `${ROOT}/MyDocs`]);
  });
});

describe("右クリックと長押し", () => {
  it("子の行を右クリックしても長押ししても、メニューはちょうど1つ", async () => {
    偽の口(基本);
    置く();
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));
    const sub = await 出るまで(`${ROOT}/MyDocs/sub`);

    await 右クリック(sub);
    expect(screen.getAllByTestId("folder-menu")).toHaveLength(1);
    expect(screen.getByTestId("folder-name-full")).toHaveTextContent("sub");
    await メニューを閉じる();

    await 長押し(sub);
    await screen.findByTestId("folder-menu");
    expect(screen.getAllByTestId("folder-menu")).toHaveLength(1);
    expect(screen.getByTestId("folder-name-full")).toHaveTextContent("sub");
  });

  it("行を長押ししても、行のメニューが1つだけ開く（余白のメニューは重ならない）", async () => {
    偽の口(基本);
    置く();
    const MyDocs = await 出るまで(`${ROOT}/MyDocs`);

    await 長押し(MyDocs);

    expect(await screen.findByTestId("folder-name-full")).toHaveTextContent("MyDocs");
    expect(screen.getAllByTestId("folder-menu")).toHaveLength(1);
  });

  it("余白の右クリックの相手は PJT のルートで、コピーの答えは PJT 名の段の真下に出る", async () => {
    偽の口(基本);
    const 写した = 写せる();
    置く();
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));
    await 出るまで(`${ROOT}/MyDocs/sub`);

    await 右クリック(screen.getByTestId("folder-blank"));
    expect(screen.getByTestId("folder-name-full")).toHaveTextContent("app");
    await 項目を押す("folder-menu-copy-abs");

    expect(写した).toEqual([ROOT]);
    const 札 = screen.getByTestId("folder-crumb-copy-state");
    expect(札.parentElement).toBe(PJT名の段().parentElement);
    expect(札).toHaveTextContent("コピーしました");
  });

  it("パンくずの答えは行へ漏れず、行の答えはパンくずへ漏れない", async () => {
    偽の口(基本);
    写せる();
    置く();
    await 出るまで(`${ROOT}/MyDocs`);

    await 右クリック(PJT名の段());
    await 項目を押す("folder-menu-copy-abs");
    expect(screen.getAllByTestId("folder-crumb-copy-state")).toHaveLength(1);
    expect(screen.queryAllByTestId("folder-copy-state")).toHaveLength(0);

    fireEvent.click(コピーの的(`${ROOT}/MyDocs`));
    await 答えが出るまで();
    expect(行の答え(`${ROOT}/MyDocs`)).toBe("コピーしました");
    expect(screen.queryAllByTestId("folder-crumb-copy-state")).toHaveLength(0);
  });

  it("「…」は押しても何も起きず、右クリックすると起点より上のフォルダを相手にメニューが出る", async () => {
    const 口 = 偽の口(基本);
    const 写した = 写せる();
    置く();
    await 出るまで(`${ROOT}/MyDocs`);
    await 流す();
    const 問いの数 = 口.問い.length;
    const 行の数 = screen.getAllByTestId("folder-entry").length;

    const 段 = 起点より上の段();
    const ボタン = 段.querySelector("button");
    expect(ボタン?.disabled).toBe(true);
    fireEvent.click(段);
    if (ボタン !== null) {
      fireEvent.click(ボタン);
    }
    await 流す();
    expect(口.問い).toHaveLength(問いの数);
    expect(screen.getAllByTestId("folder-entry")).toHaveLength(行の数);
    expect(screen.getByTestId("folder-browser").getAttribute("data-path")).toBe(ROOT);
    expect(screen.queryAllByTestId("folder-menu")).toHaveLength(0);

    await 右クリック(段);
    expect(screen.getByTestId("folder-name-full")).toHaveTextContent("dev");
    await 項目を押す("folder-menu-copy-abs");
    expect(写した).toEqual([上]);
  });

  it("PJT 名の段は押しても何も起きず、押せる見た目（下線・乗せた色）を持たない", async () => {
    const 口 = 偽の口(基本);
    置く();
    await 出るまで(`${ROOT}/MyDocs`);
    await 流す();
    const 問いの数 = 口.問い.length;
    const 段 = PJT名の段();

    expect(段.tagName).toBe("SPAN");
    expect(段.textContent).toBe("app");
    expect(段.className).not.toContain("underline");
    expect(段.className).not.toContain("hover:text-primary");

    fireEvent.click(段);
    await 流す();
    expect(口.問い).toHaveLength(問いの数);
    expect(screen.queryAllByTestId("folder-menu")).toHaveLength(0);
    expect(要る行(`${ROOT}/MyDocs`).getAttribute("aria-expanded")).toBe("false");
  });
  it("右クリックの的はツリーに1つで、行ごとには持たない", async () => {
    偽の口(基本);
    置く();
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));
    await 出るまで(`${ROOT}/MyDocs/sub`);

    expect(子の一覧(ROOT)).toHaveAttribute("data-state", "closed");
    const 行たち = screen.getAllByTestId("folder-entry");
    expect(行たち).toHaveLength(6);
    for (const each of 行たち) {
      expect(each.parentElement).not.toHaveAttribute("data-state");
    }
    expect(screen.getByTestId("folder-blank")).not.toHaveAttribute("data-state");
    for (const each of 行たち) {
      expect(each.parentElement).toHaveAttribute("data-row-path", each.getAttribute("data-path") ?? "");
    }
  });

  it("キーボード（メニューキー・Shift+F10）で開くと、焦点のある行が相手になる", async () => {
    偽の口(基本);
    const 写した = 写せる();
    置く();
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));
    (await 出るまで(`${ROOT}/MyDocs/sub`)).focus();

    fireEvent.contextMenu(document.activeElement as Element);
    expect(await screen.findByTestId("folder-name-full")).toHaveTextContent("sub");
    await 項目を押す("folder-menu-copy-abs");
    expect(写した).toEqual([`${ROOT}/MyDocs/sub`]);
    await waitFor(() => expect(screen.queryAllByTestId("folder-menu")).toHaveLength(0));

    コピーの的(`${ROOT}/src`).focus();
    fireEvent.contextMenu(document.activeElement as Element);
    expect(await screen.findByTestId("folder-name-full")).toHaveTextContent("src");
  });

  it("押した行が相手になる：別の行を続けて右クリック・長押ししても、見出しと写す値はそのつど押した行で、知らせの行は PJT のルート", async () => {
    偽の口({ ...基本, [`${ROOT}/src`]: [] });
    const 写した = 写せる();
    置く();
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));
    await 出るまで(`${ROOT}/MyDocs/sub`);
    fireEvent.click(要る行(`${ROOT}/src`));
    const 空 = await screen.findByTestId("folder-branch-empty");
    expect(空.getAttribute("data-path")).toBe(`${ROOT}/src`);

    await 右クリック(要る行(`${ROOT}/MyDocs`));
    expect(screen.getByTestId("folder-name-full")).toHaveTextContent("MyDocs");
    await メニューを閉じる();

    await 右クリック(要る行(`${ROOT}/MyDocs/メモ.md`));
    expect(screen.getByTestId("folder-name-full")).toHaveTextContent("メモ.md");
    await 項目を押す("folder-menu-copy-abs");
    expect(写した).toEqual([`${ROOT}/MyDocs/メモ.md`]);
    await waitFor(() => expect(screen.queryAllByTestId("folder-menu")).toHaveLength(0));

    await 長押し(要る行(`${ROOT}/MyDocs/sub`));
    expect(await screen.findByTestId("folder-name-full")).toHaveTextContent("sub");
    await メニューを閉じる();

    await 右クリック(空);
    expect(screen.getByTestId("folder-name-full")).toHaveTextContent("app");
    await 項目を押す("folder-menu-copy-abs");
    expect(写した).toEqual([`${ROOT}/MyDocs/メモ.md`, ROOT]);
    const 札 = screen.getByTestId("folder-crumb-copy-state");
    expect(札.parentElement).toBe(PJT名の段().parentElement);
    expect(札).toHaveTextContent("コピーしました");
  });
});

describe("送り", () => {
  it("開き直したとき、いま開いているファイルの行を1回だけ器の中で送り、枝は展開しない", async () => {
    const 目当て = `${ROOT}/MyDocs/sub/a.md`;
    const 器か = (each: Element) =>
      each.getAttribute("data-testid") === "folder-children" &&
      each.getAttribute("data-path") === ROOT;
    const 矩形 = (top: number, height: number) =>
      ({ top, height, left: 0, right: 200, bottom: top + height, width: 200, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const 測る = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (器か(this)) {
          return 矩形(0, 100);
        }
        if (
          this.getAttribute("data-testid") === "folder-entry" &&
          this.getAttribute("data-path") === 目当て
        ) {
          return 矩形(500, 28);
        }
        return 矩形(0, 0);
      });
    const 高さ = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return 器か(this) ? 100 : 0;
      });
    const 送り = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      const 口 = 偽の口(基本);
      const 閉じた枝の中 = 置く({ current: `${ROOT}/src/main.ts` });
      await 出るまで(`${ROOT}/src`);
      await 流す();
      expect(要る行(`${ROOT}/src`).getAttribute("aria-expanded")).toBe("false");
      expect(口.問い).not.toContain(`${ROOT}/src`);
      expect(子の一覧(ROOT)?.scrollTop).toBe(0);
      閉じた枝の中.unmount();

      置く({ loadExpanded: () => [`${ROOT}/MyDocs`, `${ROOT}/MyDocs/sub`], current: 目当て });
      await 出るまで(目当て);
      const 器 = 子の一覧(ROOT);
      expect(器?.scrollTop).toBe(428);
      expect(要る行(目当て).getAttribute("aria-current")).toBe("page");

      if (器 !== null) {
        器.scrollTop = 0;
      }
      fireEvent.click(要る行(`${ROOT}/src`));
      await 出るまで(`${ROOT}/src/main.ts`);
      expect(器?.scrollTop).toBe(0);
      expect(送り).not.toHaveBeenCalled();
    } finally {
      測る.mockRestore();
      高さ.mockRestore();
      送り.mockRestore();
    }
  });
});

describe("root が無いとき", () => {
  it("root が空文字なら、何も読まず、覚えを読みも書きもしない", async () => {
    const 口 = 偽の口(基本);
    const loadExpanded = vi.fn(() => [`${ROOT}/MyDocs`]);
    const { onExpandedChange } = 置く({ root: "", loadExpanded });
    await 流す();

    expect(口.問い).toHaveLength(0);
    expect(loadExpanded).not.toHaveBeenCalled();
    expect(onExpandedChange).not.toHaveBeenCalled();
    const 器 = screen.getByTestId("folder-browser");
    expect(器.getAttribute("data-path")).toBe("");
    expect(器.getAttribute("data-mode")).toBe("tree");
    expect(screen.queryAllByTestId("folder-entry")).toHaveLength(0);
  });
});

describe("印と名前", () => {
  it("閉じた枝のフォルダの印は沈んだ色で、展開した枝のフォルダの印は今の琥珀", async () => {
    偽の口(基本);
    置く();
    const MyDocs = await 出るまで(`${ROOT}/MyDocs`);
    expect(印の色(`${ROOT}/MyDocs`)).toBe("var(--type-folder-closed)");
    expect(印の色(`${ROOT}/src`)).toBe("var(--type-folder-closed)");

    fireEvent.click(MyDocs);
    await 出るまで(`${ROOT}/MyDocs/sub`);
    expect(印の色(`${ROOT}/MyDocs`)).toBe("var(--type-folder)");
    expect(印の色(`${ROOT}/src`)).toBe("var(--type-folder-closed)");
    expect(印の色(`${ROOT}/MyDocs/sub`)).toBe("var(--type-folder-closed)");
    expect(印の色(`${ROOT}/計画.md`)).not.toContain("folder");
  });

  it("追加シートのフォルダの印は、ツリーの色を使わず今の琥珀のまま", async () => {
    偽の口(基本);
    render(<FolderBrowser host="local" start={ROOT} root={ROOT} />);
    const 行たち = await screen.findAllByTestId("folder-entry");
    const MyDocs = 行たち.find((each) => each.getAttribute("data-name") === "MyDocs");
    const 印 = MyDocs?.querySelector<SVGElement>('[data-testid="folder-entry-icon"] svg');
    expect(印?.style.color).toBe("var(--type-folder)");
    expect(document.querySelectorAll('[data-testid="folder-twistie"]')).toHaveLength(0);
  });

  it("ツリーの行にも、名前の全体を読む指定とメニューの見出しが出る", async () => {
    const 長い = "とても長い名前の打ち合わせのメモ.md";
    偽の口({ ...基本, [`${ROOT}/MyDocs`]: [長い] });
    置く();
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));
    const 深い = await 出るまで(`${ROOT}/MyDocs/${長い}`);

    const 名前 = Array.from(深い.querySelectorAll("span")).find((each) => each.textContent === 長い);
    expect(名前?.getAttribute("title")).toBe(長い);

    await 右クリック(深い);
    expect(screen.getByTestId("folder-name-full")).toHaveTextContent(長い);
  });

  it("ツリーの行の外枠には、画面の外では描かない印（folder-tree-row）が付き、追加シートの行には付かない", async () => {
    偽の口(基本);
    const { unmount } = 置く();
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));
    await 出るまで(`${ROOT}/MyDocs/sub`);
    const 行たち = screen.getAllByTestId("folder-entry");
    expect(行たち).toHaveLength(6);
    for (const each of 行たち) {
      expect(each.parentElement).toHaveClass("folder-tree-row");
    }
    unmount();

    render(<FolderBrowser host="local" start={ROOT} root={ROOT} />);
    expect(await screen.findAllByTestId("folder-entry")).not.toHaveLength(0);
    expect(document.querySelectorAll(".folder-tree-row")).toHaveLength(0);
  });

  it("ツリーの行末は、開いている行だけ印と PJT の札が1つの入れ物に並び、開いていない行の PJT の札は、開く口があっても札そのものが行末へ寄る", async () => {
    偽の口({
      [ROOT]: [
        { name: "甲", kind: "dir", is_project: true },
        { name: "乙", kind: "dir", is_project: true },
        "計画.md",
      ],
    });
    const 口: OpenInProp = {
      view: view({ opened: [{ path: `${ROOT}/甲`, real: `${ROOT}/甲`, kind: "dir", since_ms: 0 }] }),
      open: vi.fn(),
      busy: false,
    };
    const { unmount } = 置く({ openIn: 口 });
    const 甲 = await 出るまで(`${ROOT}/甲`);
    const 甲の印 = 甲.querySelector('[data-testid="folder-opened-mark"]');
    const 甲の札 = 甲.querySelector('[data-testid="folder-project-mark"]');
    expect(甲の印).not.toBeNull();
    expect(甲の札).not.toBeNull();
    expect(甲の印?.parentElement).toBe(甲の札?.parentElement);
    expect(甲の札?.parentElement).toHaveClass("ml-auto");
    expect(甲の札).not.toHaveClass("ml-auto");
    const 乙 = 要る行(`${ROOT}/乙`);
    expect(乙.querySelector('[data-testid="folder-opened-mark"]')).toBeNull();
    expect(乙.querySelector('[data-testid="folder-project-mark"]')).toHaveClass("ml-auto");
    unmount();

    置く();
    const 乙2 = await 出るまで(`${ROOT}/乙`);
    expect(乙2.querySelector('[data-testid="folder-project-mark"]')).toHaveClass("ml-auto");
  });
});

describe("コピー（深い枝）", () => {
  const 深い枝: Record<string, 定義> = {
    ...基本,
    [`${ROOT}/MyDocs/sub`]: ["深い", "a.md", { name: "リンク", kind: "symlink" }],
    [`${ROOT}/MyDocs/sub/深い`]: [],
  };

  async function 深くまで展開する() {
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs/sub`));
    await 出るまで(`${ROOT}/MyDocs/sub/a.md`);
  }

  it("深い枝の行のコピーとメニューは、その行を相手にする", async () => {
    偽の口(深い枝);
    const 写した = 写せる();
    置く();
    await 深くまで展開する();

    const sub = コピーの的(`${ROOT}/MyDocs/sub`);
    expect(sub.getAttribute("data-value")).toBe("MyDocs/sub/");
    expect(sub.getAttribute("title")).toContain(`（${ROOT} からの相対パス）`);
    expect(sub.getAttribute("aria-label")).toContain(`（${ROOT} からの相対パス）`);
    expect(コピーの的(`${ROOT}/MyDocs/sub/深い`).getAttribute("data-value")).toBe("MyDocs/sub/深い/");
    const ファイル = コピーの的(`${ROOT}/MyDocs/sub/a.md`);
    expect(ファイル.getAttribute("data-value")).toBe("MyDocs/sub/a.md");
    expect(ファイル.getAttribute("aria-label")).toContain(`（${ROOT} からの相対パス）`);

    fireEvent.click(sub);
    await 答えが出るまで();
    expect(写した.at(-1)).toBe("MyDocs/sub/");

    await 右クリック(要る行(`${ROOT}/MyDocs/sub/a.md`));
    await 項目を押す("folder-menu-copy-abs");
    expect(写した.at(-1)).toBe(`${ROOT}/MyDocs/sub/a.md`);
    expect(行の答え(`${ROOT}/MyDocs/sub/a.md`)).toBe("コピーしました");
    expect(screen.queryAllByTestId("folder-crumb-copy-state")).toHaveLength(0);

    await 右クリック(要る行(`${ROOT}/MyDocs/sub/a.md`));
    await 項目を押す("folder-menu-copy-name");
    expect(写した.at(-1)).toBe("a.md");

    await 右クリック(要る行(`${ROOT}/MyDocs/sub/深い`));
    expect(screen.getByTestId("folder-menu-copy-name")).toHaveTextContent("フォルダ名をコピー");
    await 項目を押す("folder-menu-copy-abs");
    expect(写した.at(-1)).toBe(`${ROOT}/MyDocs/sub/深い`);
    await 右クリック(要る行(`${ROOT}/MyDocs/sub/深い`));
    await 項目を押す("folder-menu-copy-name");
    expect(写した.at(-1)).toBe("深い");
    expect(行の答え(`${ROOT}/MyDocs/sub/深い`)).toBe("コピーしました");

    await 右クリック(要る行(`${ROOT}/MyDocs/sub/リンク`).parentElement as HTMLElement);
    expect(screen.getByTestId("folder-menu-copy-name")).toHaveTextContent("名前をコピー");
    await 項目を押す("folder-menu-copy-name");
    expect(写した.at(-1)).toBe("リンク");
    expect(screen.queryAllByTestId("folder-crumb-copy-state")).toHaveLength(0);
  });

  it("答えはツリーでも1組で、押した行（絶対パス）にだけ出る", async () => {
    偽の口({
      [ROOT]: ["MyDocs", "docs", "計画.md"],
      [`${ROOT}/MyDocs`]: ["docs"],
    });
    写せる();
    置く();
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));
    await 出るまで(`${ROOT}/MyDocs/docs`);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(コピーの的(`${ROOT}/MyDocs/docs`));
    await 答えが出るまで();
    expect(行の答え(`${ROOT}/MyDocs/docs`)).toBe("コピーしました");
    expect(行の答え(`${ROOT}/docs`)).toBeNull();

    fireEvent.click(コピーの的(`${ROOT}/docs`));
    await 答えが出るまで();
    expect(行の答え(`${ROOT}/docs`)).toBe("コピーしました");
    expect(行の答え(`${ROOT}/MyDocs/docs`)).toBeNull();
    expect(screen.getAllByTestId("folder-copy-state")).toHaveLength(1);

    act(() => vi.advanceTimersByTime(コピー表示を畳むまで - 1));
    expect(行の答え(`${ROOT}/docs`)).toBe("コピーしました");
    act(() => vi.advanceTimersByTime(1));
    expect(行の答え(`${ROOT}/docs`)).toBeNull();
  });

  it("写せない環境では、どこから押しても一覧の上の逃げ道の欄が閉じるまで残る", async () => {
    偽の口(深い枝);
    置く();
    await 深くまで展開する();
    expect(screen.queryAllByTestId("folder-copy-failed")).toHaveLength(0);

    const 逃げ道 = () => {
      expect(screen.getAllByTestId("folder-copy-failed")).toHaveLength(1);
      return screen.getByTestId("folder-copy-fallback").textContent;
    };

    fireEvent.click(コピーの的(`${ROOT}/MyDocs/sub/a.md`));
    await 答えが出るまで();
    expect(逃げ道()).toBe("MyDocs/sub/a.md");
    expect(行の答え(`${ROOT}/MyDocs/sub/a.md`)).toBe("コピーできません");

    await 右クリック(要る行(`${ROOT}/MyDocs/sub/深い`));
    await 項目を押す("folder-menu-copy-abs");
    expect(逃げ道()).toBe(`${ROOT}/MyDocs/sub/深い`);

    await 右クリック(PJT名の段());
    await 項目を押す("folder-menu-copy-name");
    expect(逃げ道()).toBe("app");
    expect(screen.queryAllByTestId("folder-crumb-copy-state")).toHaveLength(0);

    await 右クリック(起点より上の段());
    await 項目を押す("folder-menu-copy-abs");
    expect(逃げ道()).toBe(上);
    expect(screen.queryAllByTestId("folder-crumb-copy-state")).toHaveLength(0);

    await 右クリック(screen.getByTestId("folder-blank"));
    await 項目を押す("folder-menu-copy-name");
    expect(逃げ道()).toBe("app");
    expect(screen.queryAllByTestId("folder-crumb-copy-state")).toHaveLength(0);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => vi.advanceTimersByTime(コピー表示を畳むまで * 3));
    expect(逃げ道()).toBe("app");

    fireEvent.click(screen.getByTestId("folder-copy-failed-dismiss"));
    expect(screen.queryAllByTestId("folder-copy-failed")).toHaveLength(0);
  });
});

describe("展開以外の押し方", () => {
  it("展開以外の押し方（コピーのボタン・中クリック・右クリック）では、展開の状態が変わらない", async () => {
    const 口 = 偽の口(基本);
    写せる();
    置く();
    fireEvent.click(await 出るまで(`${ROOT}/MyDocs`));
    await 出るまで(`${ROOT}/MyDocs/sub`);
    await 流す();

    const 見る = () => ({
      MyDocs: 要る行(`${ROOT}/MyDocs`).getAttribute("aria-expanded"),
      src: 要る行(`${ROOT}/src`).getAttribute("aria-expanded"),
      行の数: screen.getAllByTestId("folder-entry").length,
      問いの数: 口.問い.length,
    });
    const 前 = 見る();
    expect(前.MyDocs).toBe("true");
    expect(前.src).toBe("false");

    for (const path of [`${ROOT}/MyDocs`, `${ROOT}/src`]) {
      fireEvent.click(コピーの的(path));
      await 答えが出るまで();
      expect(見る()).toEqual(前);

      fireEvent(要る行(path), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
      await 流す();
      expect(見る()).toEqual(前);

      await 右クリック(要る行(path));
      await メニューを閉じる();
      await 流す();
      expect(見る()).toEqual(前);
    }
  });

  it("いま開いているファイルの行は、深い枝の中でもその1行だけが強調される", async () => {
    偽の口({
      ...基本,
      [ROOT]: ["MyDocs", "a.md"],
    });
    const 目当て = `${ROOT}/MyDocs/sub/a.md`;
    置く({ loadExpanded: () => [`${ROOT}/MyDocs`, `${ROOT}/MyDocs/sub`], current: 目当て });
    const 深い = await 出るまで(目当て);
    const 浅い = 要る行(`${ROOT}/a.md`);

    expect(深い.getAttribute("aria-current")).toBe("page");
    expect(深い.className).toContain("folder-entry-current");
    expect(浅い.hasAttribute("aria-current")).toBe(false);
    expect(浅い.className).not.toContain("folder-entry-current");
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("リンクの行は押せず、展開もしない", async () => {
    const 口 = 偽の口({
      ...基本,
      [ROOT]: ["MyDocs", { name: "リンク", kind: "symlink" }],
      [`${ROOT}/リンク`]: ["中.md"],
    });
    置く();
    const リンク = await 出るまで(`${ROOT}/リンク`);
    await 流す();
    const 問いの数 = 口.問い.length;

    expect((リンク as HTMLButtonElement).disabled).toBe(true);
    expect(リンク.hasAttribute("aria-expanded")).toBe(false);
    const 山形の入れ物 = リンク.querySelector('[data-testid="folder-twistie"]');
    expect(山形の入れ物).not.toBeNull();
    expect(山形の入れ物?.querySelector(".folder-tree-twistie")).toBeNull();
    expect(山形の入れ物?.querySelector("svg")).toBeNull();

    fireEvent.click(リンク);
    await 流す();
    expect(口.問い).toHaveLength(問いの数);
    expect(子の一覧(`${ROOT}/リンク`)).toBeNull();
  });
});

describe("余白", () => {
  it("余白は、ルートが読み込み中・空・読めないときも最上段の末尾に出て、ルートのメニューが出る", async () => {
    const 場面: { 名: string; 定義: 定義; testid: string; 字: string }[] = [
      { 名: "読み込み中", 定義: "止める", testid: "folder-branch-loading", 字: "読み込み中…" },
      { 名: "空", 定義: [], testid: "folder-branch-empty", 字: "このフォルダは空です" },
      { 名: "読めない", 定義: { status: 403, body: "読む権限がありません" }, testid: "folder-error", 字: "読む権限がありません" },
    ];
    for (const each of 場面) {
      偽の口({ [ROOT]: each.定義 });
      const 写した = 写せる();
      const { unmount } = 置く();
      const 知らせ = await screen.findByTestId(each.testid);
      expect(知らせ.getAttribute("data-path")).toBe(ROOT);
      expect(知らせ.textContent).toBe(each.字);
      const 器 = 子の一覧(ROOT);
      expect(器?.firstElementChild).toBe(知らせ);
      if (each.testid !== "folder-error") {
        expect(screen.queryAllByTestId("folder-error")).toHaveLength(0);
      }

      const 余白たち = screen.getAllByTestId("folder-blank");
      expect(余白たち).toHaveLength(1);
      expect(器?.lastElementChild).toBe(余白たち[0]);
      expect(余白たち[0].getAttribute("aria-hidden")).toBe("true");

      await 右クリック(余白たち[0]);
      expect(screen.getAllByTestId("folder-menu")).toHaveLength(1);
      expect(screen.getByTestId("folder-name-full")).toHaveTextContent("app");
      await 項目を押す("folder-menu-copy-abs");
      expect(写した).toEqual([ROOT]);
      unmount();
      vi.unstubAllGlobals();
    }
  });
});

describe("読み直しの細部", () => {
  it("10秒の読み直しが飛んでいる間も、展開している枝に「読み込み中…」を出さず、前の中身を見せたまま", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 口 = 偽の口(基本);
    置く();
    await 流す();
    fireEvent.click(要る行(`${ROOT}/MyDocs`));
    await 流す();
    expect(行(`${ROOT}/MyDocs/メモ.md`)).not.toBeNull();
    口.表.set(ROOT, "止める");
    口.表.set(`${ROOT}/MyDocs`, "止める");

    await 十秒進める();

    expect(口.止めた.map((each) => each.path).sort()).toEqual([ROOT, `${ROOT}/MyDocs`].sort());
    expect(screen.queryAllByTestId("folder-branch-loading")).toHaveLength(0);
    expect(行(`${ROOT}/MyDocs/メモ.md`)).not.toBeNull();
    expect(行(`${ROOT}/計画.md`)).not.toBeNull();
  });

  it("外で増えた子が、展開している枝にも読み込み直さずに並ぶ", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 口 = 偽の口(基本);
    置く();
    await 流す();
    fireEvent.click(要る行(`${ROOT}/MyDocs`));
    await 流す();
    expect(行(`${ROOT}/MyDocs/新しい.md`)).toBeNull();
    口.表.set(`${ROOT}/MyDocs`, ["sub", "メモ.md", "新しい.md"]);

    await 十秒進める();

    expect(行(`${ROOT}/MyDocs/新しい.md`)).not.toBeNull();
    expect(要る行(`${ROOT}/MyDocs/新しい.md`).style.paddingLeft).toBe("20px");
  });

  it("画面が裏にある間は10秒たっても読まず、表へ戻るとその場で読み直す", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const 口 = 偽の口(基本);
    let 見え方: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => 見え方,
    });
    try {
      置く();
      await 流す();
      fireEvent.click(要る行(`${ROOT}/MyDocs`));
      await 流す();
      expect(行(`${ROOT}/MyDocs/メモ.md`)).not.toBeNull();

      見え方 = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      口.問い.length = 0;
      await 十秒進める();
      await 十秒進める();
      expect(口.問い).toHaveLength(0);

      見え方 = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await 流す();
      expect([...口.問い].sort()).toEqual([ROOT, `${ROOT}/MyDocs`].sort());
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });
});

describe("開く口と別のタブ", () => {
  it("親PC の形では、PJT 名の段・「…」・余白のメニューにも開く2項目が出る", async () => {
    偽の口(基本);
    const open = vi.fn();
    const 場所 = () => [
      { 名: "PJT 名の段", 的: PJT名の段(), 相手: ROOT },
      { 名: "…", 的: 起点より上の段(), 相手: 上 },
      { 名: "余白", 的: screen.getByTestId("folder-blank"), 相手: ROOT },
    ];

    const 親PC = 置く({ openIn: { view: view(), open, busy: false } });
    await 出るまで(`${ROOT}/MyDocs`);
    for (const each of 場所()) {
      await 右クリック(each.的);
      expect(screen.getByTestId("folder-menu-open-explorer")).toHaveTextContent("エクスプローラで開く");
      expect(screen.getByTestId("folder-menu-open-vscode")).toHaveTextContent("VSCode で開く");
      open.mockClear();
      await userEvent.click(screen.getByTestId("folder-menu-open-explorer"));
      expect(open).toHaveBeenCalledWith("explorer", each.相手);
      await 右クリック(each.的);
      await userEvent.click(screen.getByTestId("folder-menu-open-vscode"));
      expect(open).toHaveBeenLastCalledWith("vscode", each.相手);
    }
    親PC.unmount();

    for (const openIn of [undefined, { view: view({ same_machine: false }), open, busy: false }]) {
      const 形 = 置く({ openIn });
      await 出るまで(`${ROOT}/MyDocs`);
      for (const each of 場所()) {
        await 右クリック(each.的);
        expect(screen.queryAllByTestId("folder-menu-open-explorer")).toHaveLength(0);
        expect(screen.queryAllByTestId("folder-menu-open-vscode")).toHaveLength(0);
        expect(screen.getByTestId("folder-menu-copy-abs")).toBeTruthy();
        await メニューを閉じる();
      }
      形.unmount();
    }
  });

  it("別のタブが覚えを書き換えても、展開は動かない", async () => {
    const 口 = 偽の口(基本);
    putExpanded("local", ROOT, [`${ROOT}/MyDocs`]);
    render(
      <FolderTree
        host="local"
        root={ROOT}
        loadExpanded={() => readExpanded("local", ROOT)}
        onExpandedChange={(x) => putExpanded("local", ROOT, x)}
      />,
    );
    await 出るまで(`${ROOT}/MyDocs/sub`);
    await 流す();
    const 見る = () => ({
      MyDocs: 要る行(`${ROOT}/MyDocs`).getAttribute("aria-expanded"),
      src: 要る行(`${ROOT}/src`).getAttribute("aria-expanded"),
      行の数: screen.getAllByTestId("folder-entry").length,
      問いの数: 口.問い.length,
    });
    const 前 = 見る();
    expect(前.MyDocs).toBe("true");
    expect(前.src).toBe("false");

    putExpanded("local", ROOT, [`${ROOT}/src`]);
    expect(readExpanded("local", ROOT)).toEqual([`${ROOT}/src`]);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "agentdashboard.project-files-place" }),
      );
    });
    await 流す();

    expect(見る()).toEqual(前);
  });
});
