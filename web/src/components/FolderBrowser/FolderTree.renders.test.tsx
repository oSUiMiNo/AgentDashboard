import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderTree } from "@/components/FolderBrowser/FolderTree";
import { FolderRow, type OpenInProp } from "@/components/FolderBrowser/parts";
import { resetListings } from "@/lib/folderListings";
import type { OpenInView } from "@/lib/openIn";

vi.mock("@/components/FolderBrowser/parts", async (importOriginal) => {
  const 元 = await importOriginal<typeof import("@/components/FolderBrowser/parts")>();
  return { ...元, FolderRow: vi.fn(元.FolderRow) };
});

const ROOT = "/home/me/dev/app";
const 一覧: Record<string, string[]> = {
  [ROOT]: ["MyDocs", "src", "計画.md", "README.md"],
};

function 偽の口() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url, "http://x").searchParams.get("path") ?? "";
      const names = 一覧[path];
      if (names === undefined) {
        return new Response("その場所は見つかりません", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          path,
          entries: names.map((name) => ({
            name,
            kind: name.includes(".") ? "file" : "dir",
            is_project: false,
          })),
          truncated: false,
        }),
        { status: 200 },
      );
    }),
  );
}

function 開く口(opened: OpenInView["opened"], open: OpenInProp["open"]): OpenInProp {
  return {
    view: {
      same_machine: true,
      same_machine_reason: null,
      explorer: { available: true, reason: null },
      vscode: { available: true, reason: null },
      opened,
    },
    open,
    busy: false,
  };
}

function 呼ばれた行(): string[] {
  return vi.mocked(FolderRow).mock.calls.map(([props]) => props.full);
}

const 受け取り物 = {
  host: "local",
  root: ROOT,
  loadExpanded: () => [],
  onExpandedChange: vi.fn(),
  onPickFile: vi.fn(),
};

beforeEach(() => {
  resetListings();
  localStorage.clear();
  vi.mocked(FolderRow).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("行を描き直さない", () => {
  it("開く口の答えが届いても、開いている印の変わらない行は描き直さない", async () => {
    偽の口();
    const { rerender } = render(<FolderTree {...受け取り物} />);
    await waitFor(() => expect(screen.getAllByTestId("folder-entry")).toHaveLength(4));

    const open = vi.fn();
    const src = { path: `${ROOT}/src`, real: `${ROOT}/src`, kind: "dir" as const, since_ms: 0 };
    vi.mocked(FolderRow).mockClear();
    rerender(<FolderTree {...受け取り物} openIn={開く口([src], open)} />);
    await waitFor(() => expect(screen.getAllByTestId("folder-opened-mark")).toHaveLength(1));
    expect(呼ばれた行()).toEqual([`${ROOT}/src`]);

    vi.mocked(FolderRow).mockClear();
    rerender(<FolderTree {...受け取り物} openIn={開く口([{ ...src }], open)} />);
    expect(screen.getAllByTestId("folder-opened-mark")).toHaveLength(1);
    expect(呼ばれた行()).toEqual([]);
  });

  it("行の右クリックでメニューを開いて閉じても、行は描き直さない", async () => {
    偽の口();
    render(<FolderTree {...受け取り物} />);
    await waitFor(() => expect(screen.getAllByTestId("folder-entry")).toHaveLength(4));
    const MyDocs = screen
      .getAllByTestId("folder-entry")
      .find((each) => each.getAttribute("data-name") === "MyDocs");
    if (MyDocs === undefined) {
      throw new Error("MyDocs の行が無い");
    }

    vi.mocked(FolderRow).mockClear();
    await userEvent.pointer({ keys: "[MouseRight]", target: MyDocs });
    expect(await screen.findByTestId("folder-name-full")).toHaveTextContent("MyDocs");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryAllByTestId("folder-menu")).toHaveLength(0));
    expect(呼ばれた行()).toEqual([]);
  });
});
