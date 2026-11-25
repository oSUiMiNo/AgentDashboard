import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { addProject, archiveAll, openDashboard, WORK_DIR } from "./helpers";

const 器 = '[data-testid="project-files-panel"]';
const 最上段 = `${器} [data-testid="folder-browser"] > ul`;
const 長い = `とても長い名前のファイルで、サイドバーの幅に収まらないことを確かめるためのもの_${"あいうえお".repeat(4)}.md`;

test.use({ trace: "off" });

test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    globalThis.localStorage?.removeItem("agentdashboard.project-files-open");
    globalThis.localStorage?.removeItem("agentdashboard.project-files-width");
    globalThis.localStorage?.removeItem("agentdashboard.project-files-place");
  });
  await page.reload();
  await archiveAll(page);
});

function 行(scope: Locator, p: string): Locator {
  return scope.locator(`[data-testid="folder-entry"][data-path="${p}"]`);
}

function 確かめを書く(名: string, 値: unknown) {
  console.log(`[check] ${名} ${JSON.stringify(値)}`);
}

async function 二つの絵(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

const 大きな違い = 16;

async function 絵の違い(page: Page, a: Buffer, b: Buffer) {
  const 白紙 = await page.context().newPage();
  try {
    return await 白紙.evaluate(
      async ({ a, b, 閾 }) => {
        const 読む = async (s: string) => {
          const bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
          const c = new OffscreenCanvas(bm.width, bm.height);
          const g = c.getContext("2d");
          if (g === null) throw new Error("2d の描き先が無い");
          g.drawImage(bm, 0, 0);
          return g.getImageData(0, 0, bm.width, bm.height);
        };
        const A = await 読む(a);
        const B = await 読む(b);
        if (A.width !== B.width || A.height !== B.height) return { 違う: -1, 大きい: -1, 最大: -1 };
        let 違う = 0;
        let 大きい = 0;
        let 最大 = 0;
        for (let i = 0; i < A.data.length; i += 4) {
          const d = Math.max(
            Math.abs(A.data[i] - B.data[i]),
            Math.abs(A.data[i + 1] - B.data[i + 1]),
            Math.abs(A.data[i + 2] - B.data[i + 2]),
          );
          if (d > 0) 違う += 1;
          if (d > 閾) 大きい += 1;
          最大 = Math.max(最大, d);
        }
        return { 違う, 大きい, 最大 };
      },
      { a: a.toString("base64"), b: b.toString("base64"), 閾: 大きな違い },
    );
  } finally {
    await 白紙.close();
  }
}

async function 閉じる(page: Page, panel: Locator) {
  const ボタン = panel.getByTestId("project-files-close");
  if (await ボタン.isVisible()) {
    await ボタン.click();
  } else {
    await page.getByTestId("project-files-toggle").click();
  }
  await expect(panel).toBeHidden();
}

const 重い = path.join(WORK_DIR, "adash-e2e-folder-tree-weight");
const 重い多い先 = path.join(重い, "たくさん");
const 重い枝たち = [1, 2, 3, 4, 5, 6].map((n) => path.join(重い, `枝-${n}`));
const 上限 = 1000;
const 回数 = 3;
const 開閉の覚え = "agentdashboard.project-files-open";
const 出力先 = process.env.FOLDER_TREE_OUT;

function 重い題材を作る() {
  fs.rmSync(重い, { recursive: true, force: true });
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const 書く = (rel: string, body: string | Buffer = "x\n") => {
    const p = path.join(重い, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  書く(".claude/docs/knowledge/このリポジトリの読み方.md", "# このリポジトリの読み方\n");
  書く(".claude/docs/knowledge/いま動いているもの.md", "# いま動いているもの\n");
  書く(".claude/docs/guideline.md", "# ガイドライン\n");
  書く(".claude/settings.json", "{}\n");
  for (const d of ["assets", "docs", "fixtures", "scripts", "server", "tools", "web"]) {
    書く(`${d}/README.md`, `# ${d}\n`);
  }
  書く("MyDocs/段1/段2/段3/段4/段5/段6/奥.md", "# 奥\n");
  書く("MyDocs/計画.md", "# 計画\n");
  書く(`MyDocs/${長い}`, "# 長い名前\n");
  書く(`MyDocs/${"とても長い名前のフォルダ".repeat(3)}/中身.md`, "# 中身\n");
  書く("README.md", "# 題材\n");
  書く("要件.md", "# 要件\n");
  書く("main.rs", "fn main() {}\n");
  書く("index.ts", "export {}\n");
  書く("package.json", "{}\n");
  書く("図.png", PNG);
  fs.mkdirSync(path.join(重い, "空のフォルダ"), { recursive: true });
  fs.symlinkSync("MyDocs", path.join(重い, "MyDocsへのリンク"));
  const 拡張子 = [".md", ".ts", ".json", ".txt", ".png"];
  for (let i = 1; i <= 1200; i += 1) {
    const ext = 拡張子[i % 拡張子.length];
    書く(`たくさん/項目-${String(i).padStart(4, "0")}${ext}`, ext === ".png" ? PNG : "x\n");
  }
  for (let b = 1; b <= 6; b += 1) {
    for (let i = 1; i <= 300; i += 1) {
      書く(`枝-${b}/項目-${String(i).padStart(3, "0")}.md`);
    }
  }
  書く("読めないフォルダ/中身.md");
}

async function 冷えた状態で開く(page: Page): Promise<Locator> {
  await page.evaluate((k) => {
    localStorage.setItem(k, "0");
    localStorage.removeItem("agentdashboard.project-files-place");
  }, 開閉の覚え);
  await page.goto(`/p/local/${encodeURIComponent(重い)}`);
  await expect(page.getByTestId("group-view")).toBeVisible();
  const panel = page.getByTestId("project-files-panel");
  await expect(panel).toBeHidden();
  await page.getByTestId("project-files-toggle").click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("folder-browser")).toHaveAttribute("data-mode", "tree");
  await expect(行(panel, 重い多い先)).toBeVisible();
  return panel;
}

async function 展開する(panel: Locator, p: string, 子の数: number) {
  await 行(panel, p).click();
  await expect(行(panel, p)).toHaveAttribute("aria-expanded", "true");
  await expect(
    panel.locator(`[data-testid="folder-children"][data-path="${p}"] [data-testid="folder-entry"]`),
  ).toHaveCount(子の数);
}

async function 全部を展開して開く(page: Page): Promise<Locator> {
  await openDashboard(page);
  await addProject(page, 重い);
  const panel = await 冷えた状態で開く(page);
  for (const 枝 of 重い枝たち) {
    await 展開する(panel, 枝, 300);
  }
  await 展開する(panel, 重い多い先, 上限);
  return panel;
}

async function 閉じて開き直す(page: Page, panel: Locator) {
  await 閉じる(page, panel);
  await page.waitForTimeout(1_500);
  await page.getByTestId("project-files-toggle").click();
  await expect(panel).toBeVisible();
}

async function 開き直しを測る(page: Page, panel: Locator, 種類: string) {
  const 全 = await panel.getByTestId("folder-entry").count();
  const 値たち: Record<string, unknown>[] = [];
  for (let 回 = 1; 回 <= 回数; 回 += 1) {
    await 閉じる(page, panel);
    await page.waitForTimeout(1_500);
    await 測り始める(page, {
      器,
      rows: 全,
      path: null,
      問い合わせ: null,
      押す相手: '[data-testid="project-files-toggle"]',
    });
    await page.getByTestId("project-files-toggle").click();
    const 値 = await 終わりを待つ(page);
    console.log(`[perf] folder-tree kind=${種類} run=${回} rows=${全} load1=${os.loadavg()[0].toFixed(2)} ${並べる(値)}`);
    値たち.push(値);
    await expect(panel.getByTestId("folder-entry")).toHaveCount(全);
    await expect(panel.locator('[data-testid="folder-branch-loading"]')).toHaveCount(0);
  }
  console.log(`[perf] folder-tree kind=${種類} summary ${要約(値たち)}`);
}

interface 終わりの条件 {
  器: string;
  rows: number;
  path: string | null;
  問い合わせ: string | null;
  押す相手: string;
}

async function 測り始める(page: Page, 条件: 終わりの条件) {
  await page.evaluate((c) => {
    performance.clearResourceTimings();
    performance.setResourceTimingBufferSize(2000);
    type 長い = { start: number; dur: number; blocking: number };
    const probe = {
      t0: -1,
      domAt: -1,
      paintedAt: -1,
      longtasks: [] as 長い[],
      loaf: [] as 長い[],
      observers: [] as PerformanceObserver[],
      listener: (ev: Event) => {
        if (probe.t0 < 0 && ev.target instanceof Element && ev.target.closest(c.押す相手) !== null) {
          probe.t0 = ev.timeStamp;
        }
      },
      finished: null as Promise<Record<string, number | boolean | string | null>> | null,
    };
    (window as unknown as { __treeProbe: typeof probe }).__treeProbe = probe;
    document.addEventListener("click", probe.listener, { capture: true });
    const loafSupported = PerformanceObserver.supportedEntryTypes.includes("long-animation-frame");
    const lt = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        probe.longtasks.push({ start: e.startTime, dur: e.duration, blocking: Math.max(0, e.duration - 50) });
      }
    });
    lt.observe({ type: "longtask", buffered: false });
    probe.observers.push(lt);
    if (loafSupported) {
      const lo = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const f = e as PerformanceEntry & { blockingDuration?: number };
          probe.loaf.push({ start: f.startTime, dur: f.duration, blocking: f.blockingDuration ?? 0 });
        }
      });
      lo.observe({ type: "long-animation-frame", buffered: false });
      probe.observers.push(lo);
    }
    const 揃った = () => {
      const box = document.querySelector(c.器);
      if (box === null) return false;
      if (c.path !== null) {
        const fb = box.querySelector<HTMLElement>('[data-testid="folder-browser"]');
        if (fb?.dataset.path !== c.path) return false;
      }
      return box.querySelectorAll('[data-testid="folder-entry"]').length >= c.rows;
    };
    const 次の絵 = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    probe.finished = (async () => {
      const 締切 = performance.now() + 60_000;
      while (performance.now() < 締切) {
        await 次の絵();
        if (probe.t0 >= 0 && 揃った()) {
          probe.domAt = performance.now();
          break;
        }
      }
      if (probe.domAt < 0) {
        return { error: "60秒たっても揃わなかった", t0: probe.t0 };
      }
      await 次の絵();
      probe.paintedAt = performance.now();
      const 中の行 = Array.from(
        document.querySelectorAll<HTMLElement>(`${c.器} .folder-tree-row [data-testid="folder-entry"]`),
      );
      const 描けた =
        中の行.length > 0 && typeof 中の行[0].checkVisibility === "function"
          ? 中の行.filter((e) => e.checkVisibility({ contentVisibilityAuto: true } as CheckVisibilityOptions)).length
          : null;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      for (const o of probe.observers) o.disconnect();
      document.removeEventListener("click", probe.listener, { capture: true });
      const 内 = (s: number) => s >= probe.t0 - 1 && s <= probe.paintedAt;
      const lts = probe.longtasks.filter((e) => 内(e.start));
      const loafs = probe.loaf.filter((e) => 内(e.start));
      const 問い = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).find(
        (e) =>
          e.name.includes("/dir?") &&
          e.startTime >= probe.t0 - 1 &&
          (c.問い合わせ === null || decodeURIComponent(e.name).includes(c.問い合わせ)),
      );
      const box = document.querySelector(c.器);
      const 合計 = (xs: 長い[], k: "dur" | "blocking") => Math.round(xs.reduce((a, e) => a + e[k], 0));
      const 最長 = (xs: 長い[]) => Math.round(xs.reduce((a, e) => Math.max(a, e.dur), 0));
      const 後 = probe.longtasks.filter((e) => e.start > probe.paintedAt);
      const 空く = probe.longtasks
        .filter((e) => e.start >= probe.t0 - 1)
        .reduce((a, e) => Math.max(a, e.start + e.dur), probe.paintedAt);
      return {
        totalMs: Math.round(probe.paintedAt - probe.t0),
        domMs: Math.round(probe.domAt - probe.t0),
        fetchEndMs: 問い ? Math.round(問い.responseEnd - probe.t0) : null,
        renderMs: 問い ? Math.round(probe.paintedAt - 問い.responseEnd) : null,
        longtasks: lts.length,
        longtaskTotalMs: 合計(lts, "dur"),
        longtaskMaxMs: 最長(lts),
        loafSupported,
        loafCount: loafs.length,
        loafBlockingMs: 合計(loafs, "blocking"),
        loafMaxMs: 最長(loafs),
        rows: box?.querySelectorAll('[data-testid="folder-entry"]').length ?? 0,
        nodes: box?.querySelectorAll("*").length ?? 0,
        afterLongtasks: 後.length,
        afterLongtaskTotalMs: 合計(後, "dur"),
        afterLongtaskMaxMs: 最長(後),
        busyUntilMs: Math.round(空く - probe.t0),
        renderedRowsAtPaint: 描けた,
      };
    })();
  }, 条件);
}

async function 終わりを待つ(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(
    () =>
      (window as unknown as { __treeProbe: { finished: Promise<Record<string, unknown>> } }).__treeProbe
        .finished,
  );
}

function 並べる(値: Record<string, unknown>): string {
  return Object.entries(値)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}

function 要約(値たち: Record<string, unknown>[]): string {
  const 鍵 = [
    "totalMs",
    "domMs",
    "fetchEndMs",
    "renderMs",
    "longtasks",
    "longtaskTotalMs",
    "loafBlockingMs",
    "nodes",
    "afterLongtasks",
    "afterLongtaskMaxMs",
    "busyUntilMs",
    "renderedRowsAtPaint",
  ];
  return 鍵
    .map((k) => {
      const 生 = 値たち.map((v) => v[k]);
      const xs = 生.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
      const 中 = xs.length === 0 ? null : xs[Math.floor(xs.length / 2)];
      const 大 = xs.length === 0 ? null : xs[xs.length - 1];
      return `${k}=[${生.map(String).join(",")}] median=${中} max=${大}`;
    })
    .join(" ");
}

test.describe("サイドバーのツリー（手当ての確かめと重さ）", () => {
  test.beforeAll(() => {
    重い題材を作る();
  });

  test.afterAll(() => {
    fs.rmSync(重い, { recursive: true, force: true });
  });

  test("画面の外の行は描かず、行の外枠の仮の高さが本物と同じで、送っても全体の高さが変わらない", async ({ page }) => {
    test.setTimeout(600_000);
    await 全部を展開して開く(page);
    const 直下 = fs.readdirSync(重い).length;
    const 値 = await page.evaluate(async (sel) => {
      const ul = document.querySelector<HTMLElement>(sel);
      if (ul === null) return null;
      const 次の絵 = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      const 外枠 = Array.from(ul.querySelectorAll<HTMLElement>(".folder-tree-row"));
      const cs = 外枠.length > 0 ? getComputedStyle(外枠[0]) : null;
      const heights = 外枠.slice(0, 25).map((e) => Math.round(e.getBoundingClientRect().height * 100) / 100);
      const 今 = ul.scrollHeight;
      ul.scrollTop = ul.scrollHeight;
      await 次の絵();
      await 次の絵();
      const 下 = ul.scrollHeight;
      ul.scrollTop = 0;
      await 次の絵();
      await 次の絵();
      const 上 = ul.scrollHeight;
      const 印 = 外枠
        .map((e) => e.querySelector<HTMLElement>('[data-testid="folder-entry"]'))
        .filter((e): e is HTMLElement => e !== null);
      const rendered =
        印.length > 0 && typeof 印[0].checkVisibility === "function"
          ? 印.filter((e) => e.checkVisibility({ contentVisibilityAuto: true } as CheckVisibilityOptions)).length
          : null;
      return {
        rows: 外枠.length,
        contentVisibility: cs?.contentVisibility ?? null,
        containIntrinsicHeight: cs?.containIntrinsicHeight ?? null,
        heights,
        scrollHeights: [今, 下, 上],
        rendered,
      };
    }, 最上段);
    確かめを書く("N19", { 直下, ...値 });
    expect(値).not.toBeNull();
    if (値 === null) return;
    expect(値.rows).toBe(直下 + 重い枝たち.length * 300 + 上限);
    expect(値.contentVisibility).toBe("auto");
    expect(String(値.containIntrinsicHeight).replace(/\s+/g, " ").trim()).toBe("auto 28px");
    expect(値.heights).toEqual(Array.from({ length: 25 }, () => 28));
    expect(new Set(値.scrollHeights).size).toBe(1);
    expect(値.rendered).not.toBeNull();
    expect(値.rendered ?? 0).toBeGreaterThan(0);
    expect(値.rendered ?? 0).toBeLessThan(値.rows);
  });

  test("ページ内検索の代わりに window.find で、画面の外の行の名前も見つかり、その行が器の中へ来る", async ({ page }) => {
    test.setTimeout(600_000);
    await 全部を展開して開く(page);
    const 値 = await page.evaluate(
      async ({ sel, 多い }) => {
        const ul = document.querySelector<HTMLElement>(sel);
        if (ul === null) return { error: "器が無い" };
        const 次の絵 = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        const find = (window as unknown as { find?: (s: string) => boolean }).find;
        if (typeof find !== "function") return { error: "window.find が無い" };
        const 選んだ行 = () => {
          const n = window.getSelection()?.anchorNode ?? null;
          const e = n instanceof Element ? n : (n?.parentElement ?? null);
          return e?.closest<HTMLElement>('[data-testid="folder-entry"]')?.dataset.path ?? null;
        };
        const u = ul.getBoundingClientRect();
        const 印 = Array.from(ul.querySelectorAll<HTMLElement>('[data-testid="folder-entry"]'));
        const 見える = 印.find((e) => {
          const r = e.getBoundingClientRect();
          return r.height > 0 && r.top >= u.top && r.bottom <= u.bottom && (e.dataset.name ?? "").length > 0;
        });
        const 多い中 = Array.from(
          ul.querySelectorAll<HTMLElement>(`[data-testid="folder-children"][data-path="${多い}"] [data-testid="folder-entry"]`),
        );
        const 遠い = 多い中[Math.min(多い中.length - 1, 949)];
        const 見える名 = 見える?.dataset.name ?? null;
        window.getSelection()?.removeAllRanges();
        const 対照 = 見える名 === null ? null : find.call(window, 見える名);
        const 対照の行 = 選んだ行();
        window.getSelection()?.removeAllRanges();
        const 遠い名 = 遠い?.dataset.name ?? null;
        const 遠いは描かれていた =
          遠い !== undefined && typeof 遠い.checkVisibility === "function"
            ? 遠い.checkVisibility({ contentVisibilityAuto: true } as CheckVisibilityOptions)
            : null;
        const 外 = 遠い名 === null ? null : find.call(window, 遠い名);
        const 外の行 = 選んだ行();
        await 次の絵();
        await 次の絵();
        const 遠いが描かれた =
          遠い !== undefined && typeof 遠い.checkVisibility === "function"
            ? 遠い.checkVisibility({ contentVisibilityAuto: true } as CheckVisibilityOptions)
            : null;
        const r = 遠い?.getBoundingClientRect();
        return {
          見える名,
          対照,
          対照の行,
          見える行: 見える?.dataset.path ?? null,
          遠い名,
          遠い行: 遠い?.dataset.path ?? null,
          遠いは描かれていた,
          外,
          外の行,
          遠いが描かれた,
          遠いが器の中: r === undefined ? null : r.top >= u.top && r.bottom <= u.bottom,
          scrollTop: ul.scrollTop,
        };
      },
      { sel: 最上段, 多い: 重い多い先 },
    );
    確かめを書く("N20", 値);
    if ("error" in 値) throw new Error(String(値.error));
    expect(値.対照, "見えている行の名前を window.find で見つけられる（対照）").toBe(true);
    expect(値.遠いは描かれていた, "探す前は、遠い行は描かれていない").toBe(false);
    expect(値.外, "画面の外の行の名前を window.find で見つけられる").toBe(true);
    expect(値.遠いが描かれた).toBe(true);
    expect(値.遠いが器の中, "見つけた行が器の中へ来る").toBe(true);
  });

  test("焦点の輪が行の外枠で切れない（content-visibility を切った対照と比べて、輪の画素が欠けていない）", async ({ page }) => {
    test.setTimeout(600_000);
    await openDashboard(page);
    await addProject(page, 重い);
    const panel = await 冷えた状態で開く(page);
    await 展開する(panel, 重い枝たち[0], 300);
    await 閉じて開き直す(page, panel);
    await page.mouse.move(0, 0);
    const 枝行 = 行(panel, 重い枝たち[0]);
    await expect(枝行).toBeVisible();
    const 箱 = await 枝行.locator("xpath=..").boundingBox();
    const clip =
      箱 === null
        ? null
        : { x: Math.max(0, 箱.x - 8), y: Math.max(0, 箱.y - 8), width: 箱.width + 16, height: 箱.height + 16 };
    expect(clip).not.toBeNull();
    if (clip === null) return;
    const 焦点なし = await page.screenshot({ clip, animations: "disabled" });
    await 枝行.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await 二つの絵(page);
    const 焦点 = await page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      return { path: e?.dataset.path ?? null, focusVisible: e?.matches(":focus-visible") ?? false };
    });
    const 焦点あり = await page.screenshot({ clip, animations: "disabled" });
    await page.addStyleTag({
      content: ".folder-tree-row{content-visibility:visible!important;contain:none!important}",
    });
    await 二つの絵(page);
    const 焦点2 = await page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      return { path: e?.dataset.path ?? null, focusVisible: e?.matches(":focus-visible") ?? false };
    });
    const 対照 = await page.screenshot({ clip, animations: "disabled" });
    if (出力先 !== undefined) {
      fs.writeFileSync(path.join(出力先, "ring-none.png"), 焦点なし);
      fs.writeFileSync(path.join(出力先, "ring-cv.png"), 焦点あり);
      fs.writeFileSync(path.join(出力先, "ring-control.png"), 対照);
    }
    const 対照との違い = await 絵の違い(page, 焦点あり, 対照);
    const 焦点なしとの違い = await 絵の違い(page, 焦点あり, 焦点なし);
    確かめを書く("N21", {
      焦点,
      焦点2,
      clip,
      同じ: 焦点あり.equals(対照),
      対照との違い,
      焦点なしとの違い,
      saved: 出力先 !== undefined,
    });
    await test.info().attach("ring-none", { body: 焦点なし, contentType: "image/png" });
    await test.info().attach("ring-cv", { body: 焦点あり, contentType: "image/png" });
    await test.info().attach("ring-control", { body: 対照, contentType: "image/png" });
    expect(焦点).toEqual({ path: 重い枝たち[0], focusVisible: true });
    expect(焦点2).toEqual({ path: 重い枝たち[0], focusVisible: true });
    expect(焦点なしとの違い.大きい, "焦点の輪が切り抜きの中に写っている").toBeGreaterThan(0);
    expect(対照との違い.大きい, "content-visibility の切り取りで輪が欠けていない（対照と大きく違う画素が無い）").toBe(0);
  });

  test("重さ（記録だけ）：枝を6つ展開した上で、1,000件のフォルダを展開する", async ({ page }) => {
    test.setTimeout(900_000);
    await openDashboard(page);
    await addProject(page, 重い);
    const 値たち: Record<string, unknown>[] = [];
    for (let 回 = 1; 回 <= 回数; 回 += 1) {
      const panel = await 冷えた状態で開く(page);
      for (const 枝 of 重い枝たち) {
        await 展開する(panel, 枝, 300);
      }
      const 前 = await panel.getByTestId("folder-entry").count();
      if (回 === 1 && 出力先 !== undefined) {
        await panel.screenshot({ path: path.join(出力先, "tree-headless.png") });
      }
      await page.waitForTimeout(1_500);
      await 測り始める(page, {
        器,
        rows: 前 + 上限,
        path: null,
        問い合わせ: 重い多い先,
        押す相手: `[data-testid="folder-entry"][data-path="${重い多い先}"]`,
      });
      await 行(panel, 重い多い先).click();
      const 値 = await 終わりを待つ(page);
      console.log(`[perf] folder-tree kind=expand run=${回} rowsBefore=${前} load1=${os.loadavg()[0].toFixed(2)} ${並べる(値)}`);
      値たち.push(値);
      await expect(panel.locator(`[data-testid="folder-truncated"][data-path="${重い多い先}"]`)).toBeVisible();
      await expect(panel.getByTestId("folder-entry")).toHaveCount(前 + 上限);
    }
    console.log(`[perf] folder-tree kind=expand summary ${要約(値たち)}`);
  });

  test("重さ（記録だけ）：2,800行あまりを展開したまま、サイドバーを閉じて開き直し、送る", async ({ page }) => {
    test.setTimeout(900_000);
    const panel = await 全部を展開して開く(page);
    await 開き直しを測る(page, panel, "reopen");
    const 送り = await page.evaluate(async (sel) => {
      const ul = document.querySelector<HTMLElement>(sel);
      if (ul === null) return { error: "器が無い" };
      const 全 = ul.scrollHeight - ul.clientHeight;
      const 歩 = 40;
      const 間: number[] = [];
      let 前 = performance.now();
      for (let i = 1; i <= 歩; i += 1) {
        ul.scrollTop = Math.round((全 * i) / 歩);
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        const 今 = performance.now();
        間.push(今 - 前);
        前 = 今;
      }
      間.sort((a, b) => a - b);
      const scrollHeightAfter = ul.scrollHeight;
      ul.scrollTop = 0;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const scrollHeightBack = ul.scrollHeight;
      return {
        scrollHeight: scrollHeightAfter,
        scrollHeightAfter,
        scrollHeightBack,
        clientHeight: ul.clientHeight,
        steps: 歩,
        frameMedianMs: Math.round(間[Math.floor(間.length / 2)]),
        frameMaxMs: Math.round(間[間.length - 1]),
        over50: 間.filter((x) => x > 50).length,
      };
    }, 最上段);
    console.log(`[perf] folder-tree kind=scroll ${並べる(送り)}`);
  });
});
