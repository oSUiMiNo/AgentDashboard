import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, StrictMode, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderBrowser } from "@/components/FolderBrowser/FolderBrowser";
import { FolderTree } from "@/components/FolderBrowser/FolderTree";
import type { OpenInProp } from "@/components/FolderBrowser/parts";
import { コピー表示を畳むまで } from "@/components/FolderBrowser/useCopyAnswer";
import { putExpanded, readExpanded } from "@/lib/filesPlace";
import { 送り直しを見張る間 } from "@/lib/folderTree";
import { putListing, readListing, resetListings } from "@/lib/folderListings";
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

describe("読めないルートの読み直し", () => {
  it("取り付けた時にルートが読めず断り文が出た後、10秒の読み直しでルートが読めると、断り文が消えて中身が並び、覚えていた枝も読まれる", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 口 = 偽の口({ ...基本, [ROOT]: { status: 504, body: "PC が応じません" } });
    置く({ loadExpanded: () => [`${ROOT}/MyDocs`] });
    await 流す();
    const 断り = screen.getAllByTestId("folder-error");
    expect(断り).toHaveLength(1);
    expect(断り[0].getAttribute("data-path")).toBe(ROOT);
    expect(断り[0].textContent).toBe("PC が応じません");
    口.表.set(ROOT, 基本[ROOT]);
    口.問い.length = 0;

    await 十秒進める();
    await 流す();

    expect(口.問い).toContain(ROOT);
    expect(screen.queryAllByTestId("folder-error")).toHaveLength(0);
    expect(行(`${ROOT}/計画.md`)).not.toBeNull();
    expect(行(`${ROOT}/MyDocs/メモ.md`)).not.toBeNull();
  });

  it("読めないルートの読み直しが飛んでいる間も、また失敗しても、断り文はそのまま出続け、「読み込み中…」や控えの行に入れ替わらない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    putListing("local", ROOT, {
      path: ROOT,
      truncated: false,
      entries: [{ name: "古い.md", kind: "file", is_project: false }],
    });
    const 口 = 偽の口({ [ROOT]: { status: 504, body: "PC が応じません" } });
    置く();
    await 流す();
    expect(screen.getByTestId("folder-error").textContent).toBe("PC が応じません");
    expect(行(`${ROOT}/古い.md`)).toBeNull();
    口.表.set(ROOT, "止める");
    口.問い.length = 0;
    const 見張り = new MutationObserver(() => {});
    見張り.observe(document.body, { childList: true, subtree: true });

    await 十秒進める();

    expect(口.問い).toEqual([ROOT]);
    expect(口.止めた.map((each) => each.path)).toEqual([ROOT]);
    expect(screen.getByTestId("folder-error").textContent).toBe("PC が応じません");

    口.止めた.shift()?.返す({ status: 504, body: "まだ応じません" });
    await 流す();
    const 足された = 見張り.takeRecords().flatMap((each) => Array.from(each.addedNodes));
    見張り.disconnect();
    const 出た = 足された.filter(
      (node) =>
        node instanceof Element &&
        (node.matches('[data-testid="folder-branch-loading"], [data-testid="folder-entry"]') ||
          node.querySelector('[data-testid="folder-branch-loading"], [data-testid="folder-entry"]') !==
            null),
    );

    expect(screen.getByTestId("folder-error").textContent).toBe("PC が応じません");
    expect(行(`${ROOT}/古い.md`)).toBeNull();
    expect(出た).toHaveLength(0);
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
    const 見張り = new MutationObserver(() => {});
    見張り.observe(document.body, { childList: true, subtree: true });
    置く({ loadExpanded: () => [`${ROOT}/MyDocs`] });
    const 出入り = 見張り
      .takeRecords()
      .flatMap((each) => [...Array.from(each.addedNodes), ...Array.from(each.removedNodes)]);
    見張り.disconnect();
    const 一度でも出た = 出入り.filter(
      (node) =>
        node instanceof Element &&
        (node.matches('[data-testid="folder-branch-loading"]') ||
          node.querySelector('[data-testid="folder-branch-loading"]') !== null),
    );
    expect(出入り.length).toBeGreaterThan(0);
    expect(一度でも出た).toHaveLength(0);

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

describe("取り外した後", () => {
  it("取り外した後に、覚えからの読みの 404 が返っても覚えを書き直さず、成功した答えは中身の控えにだけ入る", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 口 = 偽の口({
      [ROOT]: ["MyDocs", "src", "計画.md"],
      [`${ROOT}/MyDocs`]: "止める",
      [`${ROOT}/src`]: "止める",
    });
    const { unmount, onExpandedChange } = 置く({
      loadExpanded: () => [`${ROOT}/MyDocs`, `${ROOT}/src`],
    });
    await 流す();
    expect(口.止めた.map((each) => each.path).sort()).toEqual(
      [`${ROOT}/MyDocs`, `${ROOT}/src`].sort(),
    );

    unmount();
    口.止めた
      .find((each) => each.path === `${ROOT}/MyDocs`)
      ?.返す({ status: 404, body: "その場所は見つかりません" });
    口.止めた.find((each) => each.path === `${ROOT}/src`)?.返す(["main.ts"]);
    await 流す();

    expect(onExpandedChange).not.toHaveBeenCalled();
    expect(readListing("local", `${ROOT}/src`)?.entries.map((each) => each.name)).toEqual([
      "main.ts",
    ]);
  });

  it("取り外した後、待っていた覚えからの読みは飛ばない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 名前 = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];
    const 枝 = 名前.map((each) => `${ROOT}/${each}`);
    const 口 = 偽の口({
      [ROOT]: 名前,
      ...Object.fromEntries(枝.map((each) => [each, "止める" as const])),
    });
    const { unmount } = 置く({ loadExpanded: () => 枝 });
    await 流す();
    expect(口.止めた).toHaveLength(4);
    const 前 = 口.問い.length;
    expect(前).toBe(5);

    unmount();
    while (口.止めた.length > 0) {
      口.止めた.shift()?.返す(["x.md"]);
      await 流す();
    }

    expect(口.問い).toHaveLength(前);
  });

  it("StrictMode で取り付けても、覚えていた枝が1本も抜けず1回ずつ読まれ、消えていた枝は覚えから外れ、同時に4本を越えない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 名前 = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];
    const 枝 = 名前.map((each) => `${ROOT}/${each}`);
    const 口 = 偽の口({
      [ROOT]: 名前,
      ...Object.fromEntries(枝.map((each) => [each, "止める" as const])),
    });
    putListing("local", ROOT, {
      path: ROOT,
      truncated: false,
      entries: 名前.map((name) => ({ name, kind: "dir" as const, is_project: false })),
    });
    const 覚えた = vi.fn();
    render(
      <StrictMode>
        <FolderTree host="local" root={ROOT} loadExpanded={() => 枝} onExpandedChange={覚えた} />
      </StrictMode>,
    );
    await 流す();

    while (口.止めた.length > 0) {
      const 次 = 口.止めた.shift();
      次?.返す(次.path === 枝[7] ? { status: 404, body: "その場所は見つかりません" } : ["x.md"]);
      await 流す();
    }

    for (const each of 枝.slice(0, 7)) {
      expect(行(`${each}/x.md`)).not.toBeNull();
    }
    for (const each of 枝) {
      expect(口.問い.filter((path) => path === each)).toHaveLength(1);
    }
    expect(覚えた).toHaveBeenLastCalledWith(枝.slice(0, 7));
    expect(口.最大).toBeLessThanOrEqual(4);
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
          return 矩形(500 - (子の一覧(ROOT)?.scrollTop ?? 0), 28);
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

  const 送り直しの目当て = `${ROOT}/MyDocs/sub/a.md`;

  function 送りの場(目当て: string[] = [送り直しの目当て]) {
    let 器の高さ = 100;
    const 器か = (each: Element) =>
      each.getAttribute("data-testid") === "folder-children" &&
      each.getAttribute("data-path") === ROOT;
    const 矩形 = (top: number, height: number) =>
      ({ top, height, left: 0, right: 200, bottom: top + height, width: 200, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const 測る = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (器か(this)) {
          return 矩形(0, 器の高さ);
        }
        if (
          this.getAttribute("data-testid") === "folder-entry" &&
          目当て.includes(this.getAttribute("data-path") ?? "")
        ) {
          return 矩形(500 - (子の一覧(ROOT)?.scrollTop ?? 0), 28);
        }
        return 矩形(0, 0);
      });
    const 高さ = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return 器か(this) ? 器の高さ : 0;
      });
    const 見張り: { 主: ResizeObserver; 的: Element; 呼ぶ: ResizeObserverCallback }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly 呼ぶ: ResizeObserverCallback;
        constructor(呼ぶ: ResizeObserverCallback) {
          this.呼ぶ = 呼ぶ;
        }
        observe(的: Element) {
          見張り.push({ 主: this as unknown as ResizeObserver, 的, 呼ぶ: this.呼ぶ });
        }
        unobserve() {}
        disconnect() {
          for (let i = 見張り.length - 1; i >= 0; i -= 1) {
            if (見張り[i].主 === (this as unknown as ResizeObserver)) {
              見張り.splice(i, 1);
            }
          }
        }
      },
    );
    return {
      縮める(次の高さ: number) {
        器の高さ = 次の高さ;
      },
      器を見張っている: () => 見張り.some((each) => 器か(each.的)),
      知らせる() {
        for (const each of 見張り.filter((e) => 器か(e.的))) {
          each.呼ぶ([{ target: each.的 } as ResizeObserverEntry], each.主);
        }
      },
      戻す() {
        測る.mockRestore();
        高さ.mockRestore();
      },
    };
  }

  const 送り直しの覚え = () => [`${ROOT}/MyDocs`, `${ROOT}/MyDocs/sub`];

  async function 送った器を開く(): Promise<{ 器: HTMLElement; unmount: () => void; rerender: (ui: ReactNode) => void }> {
    偽の口(基本);
    const 描いた = 置く({ loadExpanded: 送り直しの覚え, current: 送り直しの目当て });
    for (let i = 0; i < 10 && 行(送り直しの目当て) === null; i += 1) {
      await 流す();
    }
    要る行(送り直しの目当て);
    const 器 = 子の一覧(ROOT);
    if (器 === null) {
      throw new Error("最上段の器が無い");
    }
    return { 器, unmount: 描いた.unmount, rerender: 描いた.rerender };
  }

  it("開き直した後に器が縮んで送った行が器の外へ出たら、1回だけ送り直す（自分の送りで起きた scroll は利用者の操作と取り違えない）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 場 = 送りの場();
    try {
      const { 器 } = await 送った器を開く();
      expect(器.scrollTop).toBe(428);
      expect(場.器を見張っている()).toBe(true);

      場.知らせる();
      expect(器.scrollTop).toBe(428);
      fireEvent.scroll(器);
      expect(場.器を見張っている()).toBe(true);

      場.縮める(86);
      場.知らせる();
      expect(器.scrollTop).toBe(442);
      expect(場.器を見張っている()).toBe(false);

      場.縮める(72);
      場.知らせる();
      expect(器.scrollTop).toBe(442);
    } finally {
      場.戻す();
    }
  });

  it("送った後に利用者が器を動かしたら（ホイール・指・押す・キー・送りの位置が動く scroll）、器が縮んでも送り直さない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 操作: [string, (器: HTMLElement) => void, number][] = [
      ["ホイール", (器) => fireEvent.wheel(器), 428],
      ["指", (器) => fireEvent.touchStart(器), 428],
      ["押す", (器) => fireEvent.pointerDown(器), 428],
      ["キー", (器) => fireEvent.keyDown(器, { key: "PageDown" }), 428],
      [
        "送りの位置が動く scroll",
        (器) => {
          器.scrollTop = 300;
          fireEvent.scroll(器);
        },
        300,
      ],
    ];
    for (const [名, 動かす, 動かした後] of 操作) {
      resetListings();
      const 場 = 送りの場();
      try {
        const { 器, unmount } = await 送った器を開く();
        expect(器.scrollTop, 名).toBe(428);
        expect(場.器を見張っている(), 名).toBe(true);

        動かす(器);
        expect(場.器を見張っている(), 名).toBe(false);

        場.縮める(86);
        場.知らせる();
        expect(器.scrollTop, 名).toBe(動かした後);
        unmount();
      } finally {
        場.戻す();
      }
    }
  });

  it("送った後にいま開いているファイルが変わったら、見張りを外し、器が縮んでも前の行へ送り直さない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 場 = 送りの場();
    try {
      const { 器, rerender } = await 送った器を開く();
      expect(器.scrollTop).toBe(428);
      expect(場.器を見張っている()).toBe(true);

      rerender(
        <FolderTree
          host="local"
          root={ROOT}
          loadExpanded={送り直しの覚え}
          onExpandedChange={vi.fn()}
          onPickFile={vi.fn()}
          current={`${ROOT}/MyDocs/メモ.md`}
        />,
      );
      expect(要る行(`${ROOT}/MyDocs/メモ.md`).getAttribute("aria-current")).toBe("page");
      場.縮める(86);
      場.知らせる();
      expect(器.scrollTop).toBe(428);
      expect(場.器を見張っている()).toBe(false);
    } finally {
      場.戻す();
    }
  });

  it("取り外すと見張りを外し、StrictMode の2回目の取り付けでも送って見張る", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 場 = 送りの場();
    try {
      const { 器, unmount } = await 送った器を開く();
      expect(器.scrollTop).toBe(428);
      expect(場.器を見張っている()).toBe(true);
      unmount();
      expect(場.器を見張っている()).toBe(false);

      render(
        <StrictMode>
          <FolderTree
            host="local"
            root={ROOT}
            loadExpanded={送り直しの覚え}
            onExpandedChange={vi.fn()}
            onPickFile={vi.fn()}
            current={送り直しの目当て}
          />
        </StrictMode>,
      );
      const 二度目の器 = 子の一覧(ROOT);
      expect(行(送り直しの目当て)).not.toBeNull();
      expect(二度目の器?.scrollTop).toBe(428);
      expect(場.器を見張っている()).toBe(true);
      場.縮める(86);
      場.知らせる();
      expect(二度目の器?.scrollTop).toBe(442);
    } finally {
      場.戻す();
    }
  });

  it("送ってから2秒たつと見張りを外し、器が縮んでも送り直さない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const 場 = 送りの場();
    try {
      const { 器 } = await 送った器を開く();
      expect(器.scrollTop).toBe(428);

      act(() => vi.advanceTimersByTime(送り直しを見張る間 - 1));
      expect(場.器を見張っている()).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(場.器を見張っている()).toBe(false);

      場.縮める(86);
      場.知らせる();
      expect(器.scrollTop).toBe(428);
    } finally {
      場.戻す();
    }
  });

  const 止める枝 = `${ROOT}/MyDocs/sub`;

  async function 止まるまで(口: 偽の口の記録, path: string) {
    await waitFor(() => expect(口.止めた.some((each) => each.path === path)).toBe(true));
  }

  function 止めたのを返す(口: 偽の口の記録, path: string, 中身: 定義) {
    for (const each of 口.止めた.filter((e) => e.path === path)) {
      each.返す(中身);
    }
  }

  function 最上段の器(): HTMLElement {
    const 器 = 子の一覧(ROOT);
    if (器 === null) {
      throw new Error("最上段の器が無い");
    }
    return 器;
  }

  it("畳んだ枝の中のファイルを開いたまま取り付け、利用者がその枝を押しても、キーで展開しても、器を送らない", async () => {
    const 的 = `${ROOT}/src/main.ts`;
    const 場面: [string, () => Promise<void>][] = [
      [
        "押して展開",
        async () => {
          await userEvent.click(要る行(`${ROOT}/src`));
        },
      ],
      [
        "キーで展開",
        async () => {
          要る行(`${ROOT}/src`).focus();
          await userEvent.keyboard("{Enter}");
        },
      ],
    ];
    for (const [名, 展開する] of 場面) {
      resetListings();
      const 場 = 送りの場([的]);
      try {
        偽の口(基本);
        const { unmount } = 置く({ current: 的 });
        await 出るまで(`${ROOT}/src`);
        await 展開する();
        await 出るまで(的);
        await 流す();
        const 器 = 最上段の器();
        expect(要る行(的).getBoundingClientRect().top + 器.scrollTop, 名).toBeGreaterThanOrEqual(100);
        expect(器.scrollTop, 名).toBe(0);
        expect(場.器を見張っている(), 名).toBe(false);
        unmount();
      } finally {
        場.戻す();
      }
    }
  });

  it("取り付けた後、行が描かれる前に利用者が器に触ったら（ホイール・指・押す・click だけ・キー・送りの位置が動く scroll）、あとで行が描かれても送らない", async () => {
    const 操作: [string, (器: HTMLElement) => void, number][] = [
      ["ホイール", (器) => fireEvent.wheel(器), 0],
      ["指", (器) => fireEvent.touchStart(器), 0],
      ["押す", (器) => fireEvent.pointerDown(器), 0],
      ["click だけ", (器) => fireEvent.click(器), 0],
      ["キー", (器) => fireEvent.keyDown(器, { key: "PageDown" }), 0],
      [
        "送りの位置が動く scroll",
        (器) => {
          器.scrollTop = 300;
          fireEvent.scroll(器);
        },
        300,
      ],
    ];
    for (const [名, 触る, 触った後] of 操作) {
      resetListings();
      const 場 = 送りの場();
      try {
        const 口 = 偽の口({ ...基本, [止める枝]: "止める" });
        const { unmount } = 置く({ loadExpanded: 送り直しの覚え, current: 送り直しの目当て });
        await 出るまで(止める枝);
        await 止まるまで(口, 止める枝);
        const 器 = 最上段の器();
        expect(行(送り直しの目当て), 名).toBeNull();
        expect(器.scrollTop, 名).toBe(0);

        触る(器);
        止めたのを返す(口, 止める枝, ["a.md"]);
        await 流す();
        await 出るまで(送り直しの目当て);
        expect(器.scrollTop, 名).toBe(触った後);
        expect(場.器を見張っている(), 名).toBe(false);
        unmount();
      } finally {
        場.戻す();
      }
    }
  });

  it("利用者が器に触る前に読みが届いて行が遅れて描かれたら、そのとき1回送って見張る（送りの位置が動かない scroll は触ったとみなさない）", async () => {
    const 場 = 送りの場();
    try {
      const 口 = 偽の口({ ...基本, [止める枝]: "止める" });
      置く({ loadExpanded: 送り直しの覚え, current: 送り直しの目当て });
      await 出るまで(止める枝);
      await 止まるまで(口, 止める枝);
      const 器 = 最上段の器();
      expect(行(送り直しの目当て)).toBeNull();
      expect(器.scrollTop).toBe(0);

      fireEvent.scroll(器);
      止めたのを返す(口, 止める枝, ["a.md"]);
      await 流す();
      await 出るまで(送り直しの目当て);
      expect(器.scrollTop).toBe(428);
      expect(場.器を見張っている()).toBe(true);
    } finally {
      場.戻す();
    }
  });

  it("取り付けた後にいま開いているファイルが変わったら、その後どの行が描かれても送らない（取り付けた時のファイルへ戻しても送らない）", async () => {
    const 取り付けた時 = `${ROOT}/src/main.ts`;
    const 別の = 送り直しの目当て;
    const 場 = 送りの場([取り付けた時, 別の]);
    try {
      const 口 = 偽の口({ ...基本, [止める枝]: "止める", [`${ROOT}/src`]: "止める" });
      const 覚え = () => [`${ROOT}/MyDocs`, 止める枝, `${ROOT}/src`];
      const 描く = (current: string) => (
        <FolderTree
          host="local"
          root={ROOT}
          loadExpanded={覚え}
          onExpandedChange={vi.fn()}
          onPickFile={vi.fn()}
          current={current}
        />
      );
      const { rerender } = 置く({ loadExpanded: 覚え, current: 取り付けた時 });
      await 出るまで(止める枝);
      await 止まるまで(口, 止める枝);
      await 止まるまで(口, `${ROOT}/src`);
      const 器 = 最上段の器();

      rerender(描く(別の));
      止めたのを返す(口, 止める枝, ["a.md"]);
      await 流す();
      await 出るまで(別の);
      expect(器.scrollTop, "別のファイルへ変わった後").toBe(0);
      expect(場.器を見張っている(), "別のファイルへ変わった後").toBe(false);

      rerender(描く(取り付けた時));
      止めたのを返す(口, `${ROOT}/src`, ["main.ts"]);
      await 流す();
      await 出るまで(取り付けた時);
      expect(器.scrollTop, "取り付けた時のファイルへ戻した後").toBe(0);
      expect(場.器を見張っている(), "取り付けた時のファイルへ戻した後").toBe(false);
    } finally {
      場.戻す();
    }
  });

  it("打ち切った後は、描き直しても行を探さない", async () => {
    偽の口(基本);
    const 的 = `${ROOT}/src/main.ts`;
    const 覚え = (): string[] => [];
    const 描く = () => (
      <FolderTree
        host="local"
        root={ROOT}
        loadExpanded={覚え}
        onExpandedChange={vi.fn()}
        onPickFile={vi.fn()}
        current={的}
      />
    );
    const { rerender } = 置く({ loadExpanded: 覚え, current: 的 });
    await 出るまで(`${ROOT}/src`);
    await 流す();
    const 器 = 最上段の器();
    const 探す = vi.spyOn(器, "querySelectorAll");
    const 探した = () =>
      探す.mock.calls.filter(([what]) => what === '[data-testid="folder-entry"]').length;
    try {
      rerender(描く());
      expect(探した(), "打ち切る前の描き直し").toBeGreaterThan(0);

      fireEvent.wheel(器);
      const 打ち切った時 = 探した();
      rerender(描く());
      rerender(描く());
      fireEvent.click(要る行(`${ROOT}/MyDocs`));
      await 出るまで(`${ROOT}/MyDocs/sub`);
      await 流す();
      expect(探した(), "打ち切った後の描き直し").toBe(打ち切った時);
    } finally {
      探す.mockRestore();
    }
  });

  it("StrictMode で取り付けても、行が描かれる前に利用者が器に触ったら、あとで行が描かれても送らない", async () => {
    const 場 = 送りの場();
    try {
      const 口 = 偽の口({ ...基本, [止める枝]: "止める" });
      render(
        <StrictMode>
          <FolderTree
            host="local"
            root={ROOT}
            loadExpanded={送り直しの覚え}
            onExpandedChange={vi.fn()}
            onPickFile={vi.fn()}
            current={送り直しの目当て}
          />
        </StrictMode>,
      );
      await 出るまで(止める枝);
      await 止まるまで(口, 止める枝);
      const 器 = 最上段の器();
      expect(行(送り直しの目当て)).toBeNull();

      fireEvent.wheel(器);
      止めたのを返す(口, 止める枝, ["a.md"]);
      await 流す();
      await 出るまで(送り直しの目当て);
      expect(器.scrollTop).toBe(0);
      expect(場.器を見張っている()).toBe(false);
    } finally {
      場.戻す();
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

  it("overflow-clip-margin が効かないブラウザでは、ツリーの行の焦点の輪を内側に描く指定がある（Chromium では効かない枝なので CSS の字で守る）", () => {
    const 中身 = readFileSync(resolve(process.cwd(), "src", "folderTree.css"), "utf8");
    expect(中身).toMatch(
      /@supports not \(overflow-clip-margin: 4px\)\s*\{[^@]*\.folder-tree-row :focus-visible\s*\{[^}]*--tw-ring-inset:\s*inset/,
    );
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

describe("ファイルの行は、ブラウザの新しいタブへ開けるリンク", () => {
  const FILE = `${ROOT}/計画.md`;
  const FOLDER = `${ROOT}/MyDocs`;
  const RAW = `/api/hosts/local/file?path=${encodeURIComponent(FILE)}&as=raw`;

  function 置く押せる形(onPickFile = vi.fn()) {
    偽の口(基本);
    置く({ onPickFile });
    return onPickFile;
  }

  async function ファイルの行() {
    return await 出るまで(FILE);
  }

  async function フォルダの行() {
    return await 出るまで(FOLDER);
  }

  it("見出しはファイルの行にも出る", async () => {
    置く押せる形();
    await 右クリック(await ファイルの行());

    expect(await screen.findByTestId("folder-name-full")).toHaveTextContent("計画.md");
  });

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

    it("印（testid・kind・name）と中身が、いままでどおり引ける", async () => {
      置く押せる形();
      const 行 = await ファイルの行();

      expect(行).toHaveAttribute("data-kind", "file");
      expect(行).toHaveAttribute("data-name", "計画.md");
      expect(行).toHaveTextContent("計画.md");
      expect(行.querySelector('[data-testid="folder-entry-icon"]')).not.toBeNull();
      expect(行.className).toContain("flex-1");
      expect(行.className).toContain("justify-start");
    });
  });

  describe("押し方の分岐", () => {
    it("素の左クリックは奪って、アプリの中で開く", async () => {
      const 押された = 置く押せる形();
      const 行 = await ファイルの行();

      expect(fireEvent.click(行, { button: 0 })).toBe(false);
      expect(押された).toHaveBeenCalledTimes(1);
      expect(押された).toHaveBeenCalledWith(FILE);
    });

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

    it("フォルダの行は、修飾キーを押しても展開する（リンクではないので分岐が要らない）", async () => {
      置く押せる形();

      fireEvent.click(await フォルダの行(), { button: 0, ctrlKey: true });

      await waitFor(() => expect(要る行(FOLDER)).toHaveAttribute("aria-expanded", "true"));
      await 出るまで(`${FOLDER}/sub`);
      expect(子の一覧(FOLDER)).not.toBeNull();
    });
  });

  describe("周りを壊していない", () => {
    it("ファイルの行でも、右クリックのメニューが出る", async () => {
      置く押せる形();

      expect(await 右クリック(await ファイルの行())).toBeInTheDocument();
    });

    it("ファイルのメニューに『ブラウザの新しいタブで開く』が出る", async () => {
      置く押せる形();
      await 右クリック(await ファイルの行());
      const 項目 = await screen.findByTestId("folder-menu-open-tab");

      expect(項目.tagName).toBe("A");
      expect(項目).toHaveAttribute("href", RAW);
      expect(項目).toHaveAttribute("target", "_blank");
      expect(項目).toHaveAttribute("rel", "noopener");
      expect(項目).toHaveTextContent("ブラウザの新しいタブで開く");
    });

    it("開くほうが、コピーより先に並ぶ", async () => {
      置く押せる形();
      const 中身 = await 右クリック(await ファイルの行());
      const 並び = Array.from(中身.querySelectorAll("[data-testid^='folder-menu-']")).map((e) =>
        e.getAttribute("data-testid"),
      );

      expect(並び).toEqual(["folder-menu-open-tab", "folder-menu-copy-abs", "folder-menu-copy-name"]);
    });

    it("フォルダのメニューには出さない（行き先の URL が無い）", async () => {
      置く押せる形();
      await 右クリック(await フォルダの行());

      await screen.findByTestId("folder-menu-copy-abs");
      expect(screen.queryByTestId("folder-menu-open-tab")).toBeNull();
    });

    it("『絶対パスをコピー』は、項目が増えても今までどおり効く", async () => {
      const 写した = 写せる();
      置く押せる形();

      await 右クリック(await ファイルの行());
      await userEvent.click(await screen.findByTestId("folder-menu-copy-abs"));

      await waitFor(() => expect(写した).toEqual([FILE]));
    });

    it("コピーの的はボタンのまま（中クリックで新しいタブが開かない）", async () => {
      置く押せる形();
      await ファイルの行();
      const 的 = コピーの的(FILE);

      expect(的.tagName).toBe("BUTTON");
      expect(的).not.toHaveAttribute("href");
    });
  });

  it("ファイルの行では「ファイル名をコピー」で名前だけが写る", async () => {
    const 写した = 写せる();
    置く押せる形();

    await 右クリック(await ファイルの行());
    const 項目 = await screen.findByTestId("folder-menu-copy-name");
    expect(項目).toHaveTextContent("ファイル名をコピー");
    await userEvent.click(項目);

    await waitFor(() => expect(写した).toEqual(["計画.md"]));
    await waitFor(() => expect(行の答え(FILE)).toBe("コピーしました"));
  });
});

describe("サイドバーの出し分けと押した先", () => {
  const FOLDER = `${ROOT}/MyDocs`;
  const FILE = `${ROOT}/計画.md`;
  const PJT = `${ROOT}/sub`;

  function 開く口つきで置く(openIn?: OpenInProp) {
    偽の口({
      [ROOT]: ["MyDocs", "計画.md", { name: "sub", kind: "dir", is_project: true }],
      [FOLDER]: [],
      [PJT]: [],
    });
    return 置く({ openIn });
  }

  async function 行を右クリック(path: string) {
    return await 右クリック(await 出るまで(path));
  }

  it("親PC でないと分かったら、何も出さない", async () => {
    開く口つきで置く({ view: view({ same_machine: false, same_machine_reason: "LAN の端末" }), open: vi.fn(), busy: false });
    await 出るまで(FILE);
    expect(screen.queryByTestId("open-in-buttons")).toBeNull();
    expect(screen.queryByTestId("folder-crumbs-row")).toBeNull();
    const メニュー = await 行を右クリック(FILE);
    expect(within(メニュー).queryByTestId("folder-menu-open-explorer")).toBeNull();
    expect(within(メニュー).queryByTestId("folder-menu-open-vscode")).toBeNull();
  });

  it("親PC なら、2つのボタンと2つの項目が出る", async () => {
    開く口つきで置く({ view: view(), open: vi.fn(), busy: false });
    await 出るまで(FILE);
    const 器 = screen.getByTestId("open-in-buttons");
    expect(within(器).getByTestId("open-in-explorer")).toBeEnabled();
    expect(within(器).getByTestId("open-in-vscode")).toBeEnabled();
    const 外枠 = screen.getByTestId("folder-crumbs-row");
    expect(Array.from(外枠.children).map((e) => e.getAttribute("data-testid"))).toEqual([
      "folder-crumbs",
      "open-in-buttons",
    ]);

    for (const path of [FILE, FOLDER]) {
      const メニュー = await 行を右クリック(path);
      expect(within(メニュー).getByTestId("folder-menu-open-explorer")).toHaveTextContent("エクスプローラで開く");
      expect(within(メニュー).getByTestId("folder-menu-open-vscode")).toHaveTextContent("VSCode で開く");
      await メニューを閉じる();
    }
  });

  it("右クリックの項目は「新しいタブで開く」の後、「絶対パスをコピー」の前に並ぶ", async () => {
    開く口つきで置く({ view: view(), open: vi.fn(), busy: false });
    const メニュー = await 行を右クリック(FILE);
    const 並び = Array.from(メニュー.querySelectorAll("[data-testid^='folder-menu-']")).map((e) =>
      e.getAttribute("data-testid"),
    );
    expect(並び).toEqual([
      "folder-menu-open-tab",
      "folder-menu-open-explorer",
      "folder-menu-open-vscode",
      "folder-menu-copy-abs",
      "folder-menu-copy-name",
    ]);
  });

  it("使えない道具は押せず、理由が出る", async () => {
    const エクスプローラの理由 = "WSL の上で動いていないので、エクスプローラはありません";
    const VSCodeの理由 = "VSCode が見つかりません（PATH と既定の入れ場所を探しました）";
    開く口つきで置く({
      view: view({
        explorer: { available: false, reason: エクスプローラの理由 },
        vscode: { available: false, reason: VSCodeの理由 },
      }),
      open: vi.fn(),
      busy: false,
    });
    await 出るまで(FILE);
    const エクスプローラ = screen.getByTestId("open-in-explorer");
    const VSCode = screen.getByTestId("open-in-vscode");
    const エクスプローラの説明 = `エクスプローラで開く（使えません：${エクスプローラの理由}）`;
    const VSCodeの説明 = `VSCode で開く（使えません：${VSCodeの理由}）`;
    expect(エクスプローラ).toBeDisabled();
    expect(エクスプローラ).toHaveAttribute("title", エクスプローラの説明);
    expect(エクスプローラ).toHaveAttribute("aria-label", エクスプローラの説明);
    expect(エクスプローラ.parentElement).toHaveAttribute("title", エクスプローラの説明);
    expect(VSCode).toBeDisabled();
    expect(VSCode).toHaveAttribute("title", VSCodeの説明);
    expect(VSCode).toHaveAttribute("aria-label", VSCodeの説明);
    expect(VSCode.parentElement).toHaveAttribute("title", VSCodeの説明);
    expect(エクスプローラ.getAttribute("aria-label")).not.toBe(VSCode.getAttribute("aria-label"));

    const メニュー = await 行を右クリック(FILE);
    const 項目1 = within(メニュー).getByTestId("folder-menu-open-explorer");
    const 項目2 = within(メニュー).getByTestId("folder-menu-open-vscode");
    expect(項目1).toHaveAttribute("data-disabled");
    expect(項目1).toHaveAttribute("title", エクスプローラの理由);
    expect(項目2).toHaveAttribute("data-disabled");
    expect(項目2).toHaveAttribute("title", VSCodeの理由);
    expect(項目1.querySelector("span[title]")).toHaveAttribute("title", エクスプローラの理由);
  });

  it("ボタンは PJT のルートを、項目はその行のパスを開く", async () => {
    const open = vi.fn();
    開く口つきで置く({ view: view(), open, busy: false });
    await 出るまで(FILE);
    await userEvent.click(screen.getByTestId("open-in-explorer"));
    await userEvent.click(screen.getByTestId("open-in-vscode"));
    expect(open.mock.calls).toEqual([
      ["explorer", ROOT],
      ["vscode", ROOT],
    ]);

    let メニュー = await 行を右クリック(FILE);
    await userEvent.click(within(メニュー).getByTestId("folder-menu-open-vscode"));
    await waitFor(() => expect(screen.queryAllByTestId("folder-menu")).toHaveLength(0));
    メニュー = await 行を右クリック(FOLDER);
    await userEvent.click(within(メニュー).getByTestId("folder-menu-open-explorer"));
    expect(open.mock.calls.slice(2)).toEqual([
      ["vscode", FILE],
      ["explorer", FOLDER],
    ]);
  });

  it("VSCode で開いているものには印が付き、文言が変わる", async () => {
    開く口つきで置く({
      view: view({
        opened: [
          { path: ROOT, real: ROOT, kind: "dir", since_ms: 1 },
          { path: FILE, real: FILE, kind: "file", since_ms: 2 },
        ],
      }),
      open: vi.fn(),
      busy: false,
    });
    const ファイル = await 出るまで(FILE);
    const VSCode = screen.getByTestId("open-in-vscode");
    expect(VSCode).toHaveAttribute("data-open", "true");
    expect(VSCode).toHaveAttribute("title", "VSCode で開いています：app（押すと窓を前に出します）");
    expect(screen.getByTestId("open-in-explorer")).not.toHaveAttribute("data-open");

    const 印たち = screen.getAllByTestId("folder-opened-mark");
    expect(印たち).toHaveLength(1);
    expect(ファイル.contains(印たち[0])).toBe(true);
    expect(要る行(FOLDER).querySelector("[data-testid='folder-opened-mark']")).toBeNull();

    const メニュー = await 行を右クリック(FILE);
    expect(within(メニュー).getByTestId("folder-menu-open-vscode")).toHaveTextContent(
      "VSCode で開いています（前に出す）",
    );
  });

  it("別の書き方（symlink・CLI）で開かれたものも、実体のパスが合えば印が付く", async () => {
    開く口つきで置く({
      view: view({
        opened: [{ path: "/home/me/近道", real: ROOT, kind: "dir", since_ms: 1 }],
      }),
      open: vi.fn(),
      busy: false,
    });
    await 出るまで(FILE);
    expect(screen.getByTestId("open-in-vscode")).toHaveAttribute("data-open", "true");
  });

  it("PJT の札と開いている印は、両方とも行末に並ぶ", async () => {
    開く口つきで置く({
      view: view({ opened: [{ path: PJT, real: PJT, kind: "dir", since_ms: 1 }] }),
      open: vi.fn(),
      busy: false,
    });
    const 行sub = await 出るまで(PJT);
    const 印 = within(行sub).getByTestId("folder-opened-mark");
    const 札 = within(行sub).getByTestId("folder-project-mark");
    expect(印.parentElement).toBe(札.parentElement);
    expect(Array.from(印.parentElement?.children ?? [])).toEqual([印, 札]);
    expect(印.parentElement?.className).toContain("ml-auto");
    expect(札.className).not.toContain("ml-auto");
  });

  it("開く口が無ければ、PJT の札は今のまま行末へ寄る", async () => {
    開く口つきで置く(undefined);
    const 札 = within(await 出るまで(PJT)).getByTestId("folder-project-mark");
    expect(札.className).toContain("ml-auto");
    expect(札).toHaveTextContent("PJT");
  });

  it("答えを待つ間のボタンは薄くせず、aria-busy だけ立てる", async () => {
    開く口つきで置く({ view: view(), open: vi.fn(), busy: true });
    await 出るまで(FILE);
    for (const id of ["open-in-explorer", "open-in-vscode"]) {
      const ボタン = screen.getByTestId(id);
      expect(ボタン).toHaveAttribute("aria-busy", "true");
      expect(ボタン).toBeEnabled();
    }
  });

  async function パンくずを右クリック(名前: "app" | "…") {
    await 出るまで(FILE);
    return await 右クリック(名前 === "app" ? PJT名の段() : 起点より上の段());
  }

  it("親PC なら、パンくずのメニューにも2つの項目が出て、その段のフォルダを開く", async () => {
    const open = vi.fn();
    開く口つきで置く({ view: view(), open, busy: false });

    let メニュー = await パンくずを右クリック("app");
    expect(within(メニュー).getByTestId("folder-name-full")).toHaveTextContent("app");
    expect(
      Array.from(メニュー.querySelectorAll("[data-testid^='folder-menu-']")).map((e) =>
        e.getAttribute("data-testid"),
      ),
    ).toEqual(["folder-menu-open-explorer", "folder-menu-open-vscode", "folder-menu-copy-abs", "folder-menu-copy-name"]);
    await userEvent.click(within(メニュー).getByTestId("folder-menu-open-vscode"));
    await waitFor(() => expect(screen.queryAllByTestId("folder-menu")).toHaveLength(0));

    メニュー = await パンくずを右クリック("…");
    expect(within(メニュー).getByTestId("folder-name-full")).toHaveTextContent("dev");
    await userEvent.click(within(メニュー).getByTestId("folder-menu-open-explorer"));

    expect(open.mock.calls).toEqual([
      ["vscode", ROOT],
      ["explorer", 上],
    ]);
  });

  it("親PC でない・開く口が無いときは、パンくずのメニューはコピーだけ", async () => {
    for (const openIn of [
      undefined,
      { view: view({ same_machine: false, same_machine_reason: "LAN の端末" }), open: vi.fn(), busy: false },
    ]) {
      const { unmount } = 開く口つきで置く(openIn);
      for (const 名前 of ["app", "…"] as const) {
        const メニュー = await パンくずを右クリック(名前);
        expect(within(メニュー).getByTestId("folder-menu-copy-abs")).toBeInTheDocument();
        expect(within(メニュー).queryByTestId("folder-menu-open-explorer")).toBeNull();
        expect(within(メニュー).queryByTestId("folder-menu-open-vscode")).toBeNull();
        await メニューを閉じる();
      }
      unmount();
    }
  });
});
