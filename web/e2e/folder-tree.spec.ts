import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  addProject,
  archiveAll,
  holdTouch,
  openDashboard,
  openSession,
  spawnSession,
  WORK_DIR,
  フォルダを展開した状態にする,
} from "./helpers";

const ROOT = path.join(WORK_DIR, "adash-e2e-folder-tree");
const 根の名 = path.basename(ROOT);
const MYDOCS = path.join(ROOT, "MyDocs");
const 計画 = path.join(MYDOCS, "計画.md");
const 段たち = [1, 2, 3, 4, 5, 6].map((n) =>
  path.join(MYDOCS, ...Array.from({ length: n }, (_, i) => `段${i + 1}`)),
);
const 長い = `とても長い名前のファイルで、サイドバーの幅に収まらないことを確かめるためのもの_${"あいうえお".repeat(4)}.md`;
const 奥の長い = path.join(段たち[5], 長い);
const 上のdocs = path.join(ROOT, "docs");
const 中のdocs = path.join(MYDOCS, "docs");
const 最上段のREADME = path.join(ROOT, "README.md");
const たくさん = path.join(ROOT, "たくさん");
const 器 = '[data-testid="project-files-panel"]';
const 最上段 = `${器} [data-testid="folder-browser"] > ul`;
const 指の判定 = "(pointer: coarse) and (hover: none)";
const 透明 = "rgba(0, 0, 0, 0)";

function 題材を作る() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const 書く = (rel: string, body = "x\n") => {
    const p = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
  };
  書く("README.md", "# 題材\n");
  書く("MyDocs/計画.md", "# 計画\n");
  書く(`MyDocs/${長い}`, "# 長い名前\n");
  書く(`MyDocs/段1/段2/段3/段4/段5/段6/${長い}`, "# 奥の長い名前\n");
  書く("MyDocs/段1/段2/段3/段4/段5/段6/奥.md", "# 奥\n");
  書く("MyDocs/docs/README.md", "# 中の docs\n");
  書く("docs/README.md", "# 上の docs\n");
  for (let i = 1; i <= 120; i += 1) {
    書く(`たくさん/項目-${String(i).padStart(3, "0")}.md`);
  }
}

test.beforeAll(() => {
  題材を作る();
});

test.afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

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

function 枝(scope: Locator, p: string): Locator {
  return scope.locator(`[data-testid="folder-children"][data-path="${p}"]`);
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

async function サイドバーを開く(page: Page): Promise<Locator> {
  const toggle = page.getByTestId("project-files-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const panel = page.getByTestId("project-files-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("folder-browser")).toHaveAttribute("data-path", ROOT);
  await expect(行(panel, MYDOCS)).toBeVisible();
  return panel;
}

async function PJT専用画面を開く(page: Page): Promise<Locator> {
  await openDashboard(page);
  const group = await addProject(page, ROOT);
  await group.dblclick({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId("group-view")).toBeVisible();
  return await サイドバーを開く(page);
}

async function URLでPJT専用画面を開く(page: Page): Promise<Locator> {
  await openDashboard(page);
  const group = await addProject(page, ROOT);
  const host = (await group.getAttribute("data-host")) ?? "local";
  await page.goto(`/p/${host}/${encodeURIComponent(ROOT)}`);
  await expect(page.getByTestId("group-view")).toBeVisible();
  return await サイドバーを開く(page);
}

async function MyDocsを展開する(panel: Locator) {
  await フォルダを展開した状態にする(panel, "MyDocs", MYDOCS);
  await expect(行(panel, 計画)).toBeVisible();
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

async function 行の高さを測る(page: Page) {
  return await page.evaluate(
    ({ sel, 指, 閉じたフォルダ, ファイル, 深いファイル }) => {
      const ul = document.querySelector<HTMLElement>(sel);
      const 高さ = (e: Element | null | undefined) =>
        e ? Math.round(e.getBoundingClientRect().height * 100) / 100 : null;
      const 測る = (p: string) => {
        const e = document.querySelector<HTMLElement>(`${sel} [data-testid="folder-entry"][data-path="${p}"]`);
        return {
          entry: 高さ(e),
          row: 高さ(e?.closest(".folder-tree-row")),
          li: 高さ(e?.closest("li")),
        };
      };
      const 上の行 = Array.from(ul?.children ?? []).filter(
        (e): e is HTMLElement => e instanceof HTMLLIElement && e.dataset.testid !== "folder-blank",
      );
      const 間隔: number[] = [];
      for (let i = 0; i + 1 < 上の行.length; i += 1) {
        if (上の行[i].querySelector('[data-testid="folder-children"]') !== null) continue;
        if (上の行[i].querySelector('[data-testid="folder-entry"]') === null) continue;
        間隔.push(
          Math.round((上の行[i + 1].getBoundingClientRect().top - 上の行[i].getBoundingClientRect().top) * 100) / 100,
        );
      }
      return {
        matches: matchMedia(指).matches,
        dir: 測る(閉じたフォルダ),
        file: 測る(ファイル),
        deepFile: 測る(深いファイル),
        pitch: 間隔,
      };
    },
    { sel: 最上段, 指: 指の判定, 閉じたフォルダ: 上のdocs, ファイル: 最上段のREADME, 深いファイル: 計画 },
  );
}

function 高さを揃えて見る(値: Awaited<ReturnType<typeof 行の高さを測る>>, 期待: number) {
  for (const 場所 of [値.dir, 値.file, 値.deepFile]) {
    expect(場所.entry).toBe(期待);
    expect(場所.row).toBe(期待);
    expect(場所.li).toBe(期待);
  }
  expect(値.pitch.length).toBeGreaterThan(0);
  expect(値.pitch).toEqual(値.pitch.map(() => 期待));
}

async function 落ち着いた面(row: Locator): Promise<string> {
  return await row.evaluate(async (e) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(e.getAnimations().map((a) => a.finished.catch(() => undefined)));
    return getComputedStyle(e).backgroundColor;
  });
}


async function その場で展開して畳む(page: Page, panel: Locator) {
  const 控える = async () => ({
    crumbs: await panel.getByTestId("folder-crumb").allTextContents(),
    path: await panel.getByTestId("folder-browser").getAttribute("data-path"),
    url: page.url(),
  });
  const 前 = await 控える();
  expect(前.crumbs.at(-1)).toBe(根の名);
  expect(前.path).toBe(ROOT);
  await 行(panel, MYDOCS).click();
  await expect(行(panel, MYDOCS)).toHaveAttribute("aria-expanded", "true");
  await expect(枝(panel, MYDOCS)).toHaveCount(1);
  await expect(行(panel, 計画)).toBeVisible();
  expect(await 控える()).toEqual(前);
  await 行(panel, MYDOCS).click();
  await expect(行(panel, MYDOCS)).toHaveAttribute("aria-expanded", "false");
  await expect(枝(panel, MYDOCS)).toHaveCount(0);
  await expect(行(panel, 計画)).toHaveCount(0);
  expect(await 控える()).toEqual(前);
}

async function 余白を見る(page: Page) {
  return await page.evaluate((sel) => {
    const ul = document.querySelector<HTMLElement>(sel);
    if (ul === null) return null;
    const last = ul.lastElementChild as HTMLElement | null;
    return {
      lastTestid: last?.dataset.testid ?? null,
      height: last ? Math.round(last.getBoundingClientRect().height * 100) / 100 : 0,
      blanksInBranches: ul.querySelectorAll(':scope [data-testid="folder-children"] [data-testid="folder-blank"]').length,
      blanks: ul.querySelectorAll('[data-testid="folder-blank"]').length,
      scrollHeight: ul.scrollHeight,
      clientHeight: ul.clientHeight,
    };
  }, 最上段);
}

async function 送りを見張る(page: Page, 名: string) {
  await page.evaluate(
    ({ sel, 名 }) => {
      type 点 = {
        t: number;
        ulH: number | null;
        crumbsH: number | null;
        crumbsRow: boolean;
        scrollTop: number | null;
      };
      const 記録: 点[] = [];
      const t0 = performance.now();
      const 回す = () => {
        const ul = document.querySelector<HTMLElement>(sel);
        const fb = ul?.parentElement ?? null;
        const crumbs = (fb?.firstElementChild as HTMLElement | null | undefined) ?? null;
        記録.push({
          t: Math.round(performance.now() - t0),
          ulH: ul?.clientHeight ?? null,
          crumbsH: crumbs ? Math.round(crumbs.getBoundingClientRect().height) : null,
          crumbsRow: fb?.querySelector('[data-testid="folder-crumbs-row"]') != null,
          scrollTop: ul?.scrollTop ?? null,
        });
        if (performance.now() - t0 < 2_000) requestAnimationFrame(回す);
      };
      requestAnimationFrame(回す);
      (window as unknown as Record<string, 点[]>)[名] = 記録;
    },
    { sel: 最上段, 名 },
  );
}

function 変わり目(記録: Record<string, unknown>[]): Record<string, unknown>[] {
  const 出す: Record<string, unknown>[] = [];
  let 前 = "";
  for (const each of 記録) {
    const { t, ...rest } = each;
    const 鍵 = JSON.stringify(rest);
    if (鍵 !== 前) {
      出す.push({ t, ...rest });
      前 = 鍵;
    }
  }
  return 出す;
}

test.describe("サイドバーのツリー（マウス）", () => {
  test("PJT 専用画面で、フォルダを押すとその場で展開し、パンくずは動かない。もう一度押すと畳む", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    await その場で展開して畳む(page, panel);
  });

  test("セッション専用画面でも、フォルダを押すとその場で展開し、パンくずは動かない。もう一度押すと畳む", async ({ page }) => {
    await openDashboard(page);
    const tile = await spawnSession(page, ROOT);
    await openSession(page, tile);
    await expect(page.getByTestId("session-view")).toBeVisible();
    const panel = await サイドバーを開く(page);
    await その場で展開して畳む(page, panel);
  });

  test("深さ1の行の名前は、深さ0の行より 12px 右から始まる", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    await MyDocsを展開する(panel);
    const 名の左 = async (p: string) =>
      await 行(panel, p)
        .locator(`span[title="${path.basename(p)}"]`)
        .evaluate((e) => e.getBoundingClientRect().left);
    const 深さ0 = await 名の左(MYDOCS);
    const 深さ1 = await 名の左(段たち[0]);
    確かめを書く("N3", { 深さ0, 深さ1, 差: 深さ1 - 深さ0 });
    expect(Math.abs(深さ1 - 深さ0 - 12)).toBeLessThanOrEqual(0.5);
  });

  test("展開した枝の縦の線は、親の山形の真ん中に引かれる", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    await MyDocsを展開する(panel);
    await フォルダを展開した状態にする(panel, "段1", 段たち[0]);
    await expect(行(panel, 段たち[1])).toBeVisible();
    const 値 = await page.evaluate(
      ({ sel, 親たち }) =>
        親たち.map((p) => {
          const ul = document.querySelector<HTMLElement>(`${sel} [data-testid="folder-children"][data-path="${p}"]`);
          const 山形 = document.querySelector<HTMLElement>(
            `${sel} [data-testid="folder-entry"][data-path="${p}"] [data-testid="folder-twistie"]`,
          );
          if (ul === null || 山形 === null) return null;
          const left = getComputedStyle(ul, "::before").left;
          const u = ul.getBoundingClientRect();
          const t = 山形.getBoundingClientRect();
          return { left, lineX: u.left + parseFloat(left), twistieCenter: t.left + t.width / 2 };
        }),
      { sel: 最上段, 親たち: [MYDOCS, 段たち[0]] },
    );
    確かめを書く("N4", 値);
    expect(値[0]?.left).toBe("16px");
    expect(値[1]?.left).toBe("28px");
    for (const each of 値) {
      expect(each).not.toBeNull();
      if (each === null) return;
      expect(Math.abs(each.lineX - each.twistieCenter)).toBeLessThanOrEqual(1);
    }
  });

  test("閉じた枝と展開した枝で、フォルダの印の色が違う", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    const 印の色 = async (p: string) =>
      await 行(panel, p)
        .locator('[data-testid="folder-entry-icon"] svg')
        .evaluate((e) => getComputedStyle(e).color);
    await MyDocsを展開する(panel);
    const 展開 = await 印の色(MYDOCS);
    const 閉じ = await 印の色(上のdocs);
    await 行(panel, MYDOCS).click();
    await expect(行(panel, MYDOCS)).toHaveAttribute("aria-expanded", "false");
    const 畳んだ後 = await 印の色(MYDOCS);
    const 試し札 = await page.evaluate(() => {
      const 札 = document.createElement("span");
      札.style.color = "color-mix(in oklch, var(--type-folder) 55%, var(--card))";
      document.body.appendChild(札);
      const 色 = getComputedStyle(札).color;
      札.remove();
      return 色;
    });
    確かめを書く("N5", { 展開, 閉じ, 畳んだ後, 試し札 });
    expect(展開).not.toBe(閉じ);
    expect(畳んだ後).toBe(閉じ);
    expect(閉じ).toBe(試し札);
  });

  test("展開した行には灰色の面が付かず、乗せたときは閉じた行に乗せたときと同じ色になる", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    await MyDocsを展開する(panel);
    await page.mouse.move(1200, 700);
    await expect.poll(() => 落ち着いた面(行(panel, MYDOCS))).toBe(透明);
    await expect.poll(() => 落ち着いた面(行(panel, 上のdocs))).toBe(透明);
    await 行(panel, 上のdocs).hover();
    await expect.poll(() => 落ち着いた面(行(panel, 上のdocs))).not.toBe(透明);
    const 閉じた行に乗せた = await 落ち着いた面(行(panel, 上のdocs));
    await 行(panel, MYDOCS).hover();
    await expect.poll(() => 落ち着いた面(行(panel, MYDOCS))).toBe(閉じた行に乗せた);
    const 展開した行に乗せた = await 落ち着いた面(行(panel, MYDOCS));
    await page.mouse.move(1200, 700);
    const 離した後 = await 落ち着いた面(行(panel, MYDOCS));
    確かめを書く("N6", { 閉じた行に乗せた, 展開した行に乗せた, 離した後 });
    expect(離した後).toBe(透明);
  });

  test("マウスで使う画面では、行の高さが 28px", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    await MyDocsを展開する(panel);
    const 値 = await 行の高さを測る(page);
    確かめを書く("N7", 値);
    expect(値.matches).toBe(false);
    高さを揃えて見る(値, 28);
  });

  test("余白の行は最上段の末尾にだけあり、最低 32px で、右クリックの相手は PJT のルート", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    const menu = page.getByTestId("folder-menu");
    const 見る = async (名: string) => {
      const 値 = await 余白を見る(page);
      確かめを書く(名, 値);
      expect(値).not.toBeNull();
      if (値 === null) return null;
      expect(値.lastTestid).toBe("folder-blank");
      expect(値.height).toBeGreaterThanOrEqual(32);
      expect(値.blanksInBranches).toBe(0);
      expect(値.blanks).toBe(1);
      await panel.getByTestId("folder-blank").click({ button: "right" });
      await expect(menu).toHaveCount(1);
      await expect(page.getByTestId("folder-name-full")).toHaveText(根の名);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      return 値;
    };
    await 見る("N8-short");
    await フォルダを展開した状態にする(panel, "たくさん", たくさん);
    await expect(行(panel, path.join(たくさん, "項目-001.md"))).toBeVisible();
    const 長い一覧 = await 見る("N8-long");
    expect(長い一覧?.scrollHeight ?? 0).toBeGreaterThan(長い一覧?.clientHeight ?? 0);
  });

  test("開き直したとき、いま開いているファイルの行が最上段の器の中に見え、レールとページの送りは動かない", async ({ page }) => {
    await openDashboard(page);
    await spawnSession(page, ROOT);
    await page.locator(`[data-testid="project-group"][data-project="${ROOT}"]`).dblclick({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId("group-view")).toBeVisible();
    const panel = await サイドバーを開く(page);
    await MyDocsを展開する(panel);
    await フォルダを展開した状態にする(panel, "段1", 段たち[0]);
    await フォルダを展開した状態にする(panel, "たくさん", たくさん);
    const 的 = path.join(たくさん, "項目-100.md");
    await 行(panel, 的).click();
    await expect(行(panel, 的)).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("file-column")).toBeVisible();
    const 対照 = await page.evaluate(
      ({ sel, p }) => {
        const ul = document.querySelector<HTMLElement>(sel);
        const row = document.querySelector<HTMLElement>(`${sel} [data-testid="folder-entry"][data-path="${p}"]`);
        if (ul === null || row === null) return null;
        ul.scrollTop = 0;
        return { rowTop: row.getBoundingClientRect().top, ulBottom: ul.getBoundingClientRect().bottom };
      },
      { sel: 最上段, p: 的 },
    );
    expect(対照).not.toBeNull();
    if (対照 === null) return;
    expect(対照.rowTop).toBeGreaterThanOrEqual(対照.ulBottom);
    await 閉じる(page, panel);
    const rail = page.getByTestId("group-rail");
    const 流した = await rail.evaluate((el) => {
      el.scrollLeft = 9999;
      return el.scrollLeft;
    });
    expect(流した).toBeGreaterThan(0);
    const 送りを読む = async () =>
      await page.evaluate(() => ({
        rail: document.querySelector<HTMLElement>('[data-testid="group-rail"]')?.scrollLeft ?? null,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      }));
    const 前 = await 送りを読む();
    await 送りを見張る(page, "__n9");
    await page.getByTestId("project-files-toggle").click();
    const 直後 = await 送りを読む();
    await expect(panel).toBeVisible();
    await expect(行(panel, 的)).toHaveAttribute("aria-current", "page");
    await expect(panel.getByTestId("folder-crumbs-row")).toBeVisible();
    await page.waitForTimeout(2_100);
    const 値 = await page.evaluate(
      ({ sel, p }) => {
        const ul = document.querySelector<HTMLElement>(sel);
        const row = document.querySelector<HTMLElement>(`${sel} [data-testid="folder-entry"][data-path="${p}"]`);
        const 記録 = (window as unknown as Record<string, Record<string, unknown>[] | undefined>).__n9 ?? [];
        if (ul === null || row === null) return { error: "器か行が無い", 記録 };
        const u = ul.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        return {
          ulTop: u.top,
          ulBottom: u.bottom,
          rowTop: r.top,
          rowBottom: r.bottom,
          scrollTop: ul.scrollTop,
          ariaCurrent: row.getAttribute("aria-current"),
          rail: document.querySelector<HTMLElement>('[data-testid="group-rail"]')?.scrollLeft ?? null,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          記録,
        };
      },
      { sel: 最上段, p: 的 },
    );
    const { 記録, ...残り } = 値;
    確かめを書く("N9", { 前, 直後, ...残り, 変わり目: 変わり目(記録) });
    expect("error" in 値).toBe(false);
    if ("error" in 値) return;
    expect(値.ariaCurrent).toBe("page");
    expect(値.rowTop).toBeGreaterThanOrEqual(値.ulTop - 0.5);
    expect(値.rowBottom).toBeLessThanOrEqual(値.ulBottom + 0.5);
    expect(値.rail).toBe(前.rail);
    expect(値.scrollX).toBe(前.scrollX);
    expect(値.scrollY).toBe(前.scrollY);
  });

  test("開き直してすぐ器を回したら、そのあと器が縮んでも送り直さない", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    await MyDocsを展開する(panel);
    await フォルダを展開した状態にする(panel, "たくさん", たくさん);
    await expect(行(panel, path.join(たくさん, "項目-001.md"))).toBeVisible();
    await 行(panel, 計画).click();
    await expect(行(panel, 計画)).toHaveAttribute("aria-current", "page");
    await 閉じる(page, panel);
    await page.waitForTimeout(1_500);
    await 送りを見張る(page, "__n10");
    const t0 = Date.now();
    await page.getByTestId("project-files-toggle").click();
    const 開いた = await page.evaluate(
      async ({ sel, p }) => {
        const 次の絵 = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        const 締切 = performance.now() + 10_000;
        const 引く = () => ({
          ul: document.querySelector<HTMLElement>(sel),
          row: document.querySelector<HTMLElement>(`${sel} [data-testid="folder-entry"][data-path="${p}"]`),
          crumbsRow: document.querySelector('[data-testid="folder-crumbs-row"]') !== null,
        });
        let いま = 引く();
        let 前の左: number | null = null;
        let 止まった = 0;
        while (performance.now() < 締切) {
          const 左 = いま.ul?.getBoundingClientRect().left ?? null;
          止まった = 左 !== null && 左 === 前の左 ? 止まった + 1 : 0;
          前の左 = 左;
          if (いま.ul !== null && いま.row?.getAttribute("aria-current") === "page" && いま.crumbsRow && 止まった >= 2) break;
          await 次の絵();
          いま = 引く();
        }
        const { ul, row, crumbsRow } = いま;
        const 記録 = (window as unknown as Record<string, { scrollTop: number | null }[] | undefined>).__n10 ?? [];
        if (ul === null || row === null) return null;
        const u = ul.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        return {
          ariaCurrent: row.getAttribute("aria-current"),
          crumbsRow,
          scrollTop: ul.scrollTop,
          ulTop: u.top,
          ulBottom: u.bottom,
          ulLeft: u.left,
          ulWidth: u.width,
          rowTop: r.top,
          rowBottom: r.bottom,
          scrollTopsBeforeWheel: [...new Set(記録.map((e) => e.scrollTop).filter((v) => v !== null))],
        };
      },
      { sel: 最上段, p: 計画 },
    );
    expect(開いた).not.toBeNull();
    if (開いた === null) return;
    expect(開いた.ariaCurrent).toBe("page");
    expect(開いた.crumbsRow).toBe(true);
    expect(開いた.scrollTop).toBe(0);
    expect(開いた.rowTop).toBeGreaterThanOrEqual(開いた.ulTop - 0.5);
    expect(開いた.rowBottom).toBeLessThanOrEqual(開いた.ulBottom + 0.5);
    await page.mouse.move(開いた.ulLeft + 開いた.ulWidth / 2, (開いた.ulTop + 開いた.ulBottom) / 2);
    await page.mouse.wheel(0, 300);
    const 回した = await page.evaluate(
      async ({ sel, p }) => {
        const 次の絵 = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        const ul = document.querySelector<HTMLElement>(sel);
        const row = document.querySelector<HTMLElement>(`${sel} [data-testid="folder-entry"][data-path="${p}"]`);
        if (ul === null || row === null) return null;
        const 締切 = performance.now() + 2_000;
        let 前 = ul.scrollTop;
        let 同じ = 0;
        while (performance.now() < 締切) {
          await 次の絵();
          const 今 = ul.scrollTop;
          同じ = 今 === 前 && 今 > 0 ? 同じ + 1 : 0;
          前 = 今;
          if (同じ >= 2) break;
        }
        return {
          S2: ul.scrollTop,
          H1: ul.clientHeight,
          ulTop: ul.getBoundingClientRect().top,
          rowBottom: row.getBoundingClientRect().bottom,
        };
      },
      { sel: 最上段, p: 計画 },
    );
    expect(回した).not.toBeNull();
    if (回した === null) return;
    await page.setViewportSize({ width: 1280, height: 560 });
    const t1 = Date.now();
    const 縮めた = await page.evaluate(
      async ({ sel, H1 }) => {
        const 次の絵 = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        const ul = document.querySelector<HTMLElement>(sel);
        if (ul === null) return null;
        const 締切 = performance.now() + 2_000;
        while (performance.now() < 締切 && ul.clientHeight >= H1) {
          await 次の絵();
        }
        const 縮んだ直後 = ul.clientHeight;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { clientHeight: 縮んだ直後, scrollTop: ul.scrollTop };
      },
      { sel: 最上段, H1: 回した.H1 },
    );
    確かめを書く("N10", { 開いた, 回した, 縮めた, 経過ms: t1 - t0 });
    expect(回した.S2).toBeGreaterThan(0);
    expect(回した.rowBottom).toBeLessThan(回した.ulTop);
    expect(t1 - t0).toBeLessThan(1_800);
    expect(縮めた).not.toBeNull();
    if (縮めた === null) return;
    expect(縮めた.clientHeight).toBeLessThan(回した.H1);
    expect(Math.abs(縮めた.scrollTop - 回した.S2)).toBeLessThanOrEqual(1);
  });

  test("前の版が書いた覚え（掘った場所だけで展開の並びが無い）を読むと、その場所までの枝が展開した形で出る", async ({ page }) => {
    await openDashboard(page);
    const group = await addProject(page, ROOT);
    const host = (await group.getAttribute("data-host")) ?? "local";
    const 生 = JSON.stringify({ [JSON.stringify([host, ROOT])]: { dir: 段たち[1], pick: null, picks: [] } });
    const 読み直した = await page.evaluate(
      ({ k, v }) => {
        localStorage.setItem(k, v);
        return localStorage.getItem(k);
      },
      { k: "agentdashboard.project-files-place", v: 生 },
    );
    expect(読み直した).toBe(生);
    await page.goto(`/p/${host}/${encodeURIComponent(ROOT)}`);
    await expect(page.getByTestId("group-view")).toBeVisible();
    const panel = await サイドバーを開く(page);
    for (const p of [MYDOCS, 段たち[0], 段たち[1]]) {
      await expect(行(panel, p)).toHaveAttribute("aria-expanded", "true");
    }
    await expect(行(panel, 段たち[2])).toBeVisible();
    await expect(行(panel, 段たち[2])).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByTestId("folder-error")).toHaveCount(0);
  });

  test("同じ名前のフォルダが違う段にあっても、data-path で引き分けられ、押した方だけが展開する", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    await MyDocsを展開する(panel);
    await expect(panel.locator('[data-testid="folder-entry"][data-name="docs"]')).toHaveCount(2);
    await フォルダを展開した状態にする(panel, "docs", 中のdocs);
    await expect(行(panel, 上のdocs)).toHaveAttribute("aria-expanded", "false");
    await expect(行(panel, path.join(中のdocs, "README.md"))).toHaveCount(1);
    await expect(行(panel, path.join(上のdocs, "README.md"))).toHaveCount(0);
    await フォルダを展開した状態にする(panel, "docs", 上のdocs);
    await expect(行(panel, path.join(中のdocs, "README.md"))).toHaveCount(1);
    await expect(行(panel, path.join(上のdocs, "README.md"))).toHaveCount(1);
    await expect(panel.locator('[data-testid="folder-entry"][data-name="README.md"]')).toHaveCount(3);
  });

  test("1つの枝の答えが遅れても、その枝に「読み込み中…」が出て、別の枝の展開は待たされない", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    let 遅らせた = 0;
    await page.route(
      (url) => url.pathname.endsWith("/dir") && url.searchParams.get("path") === 上のdocs,
      async (route) => {
        遅らせた += 1;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await route.continue();
      },
    );
    try {
      await 行(panel, 上のdocs).click();
      const 読み込み中 = panel.locator(`[data-testid="folder-branch-loading"][data-path="${上のdocs}"]`);
      await expect(読み込み中).toBeVisible();
      await 行(panel, MYDOCS).click();
      await expect(行(panel, 計画)).toBeVisible({ timeout: 1_500 });
      await expect(読み込み中).toHaveCount(1);
      await expect(行(panel, path.join(上のdocs, "README.md"))).toBeVisible();
      確かめを書く("N13", { 遅らせた });
      expect(遅らせた).toBeGreaterThan(0);
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  test("右クリックとキーボードの相手は、押した行と余白で分かれる", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    await MyDocsを展開する(panel);
    const menu = page.getByTestId("folder-menu");
    await 行(panel, 計画).click({ button: "right" });
    await expect(menu).toHaveCount(1);
    await expect(page.getByTestId("folder-name-full")).toHaveText("計画.md");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await panel.getByTestId("folder-blank").click({ button: "right" });
    await expect(menu).toHaveCount(1);
    await expect(page.getByTestId("folder-name-full")).toHaveText(根の名);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await 行(panel, 計画).focus();
    await page.keyboard.press("Shift+F10");
    await page.waitForTimeout(1_000);
    const 数 = await menu.count();
    const 見出し = 数 > 0 ? await page.getByTestId("folder-name-full").first().textContent() : null;
    確かめを書く("N14", { menus: 数, name: 見出し, expected: "計画.md" });
    if (数 > 0) {
      await page.keyboard.press("Escape");
    }
  });
});

test.describe("サイドバーのツリー（指）", () => {
  test.use({ hasTouch: true });

  test("指で触る端末では、行の高さが今と同じ 38px のまま", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    expect(await page.evaluate((q) => matchMedia(q).matches, 指の判定)).toBe(true);
    await MyDocsを展開する(panel);
    const 値 = await 行の高さを測る(page);
    確かめを書く("N15", 値);
    expect(値.matches).toBe(true);
    高さを揃えて見る(値, 38);
  });

  test("子の行（深さ1以上）を長押ししても、メニューはちょうど1つ", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    await MyDocsを展開する(panel);
    await フォルダを展開した状態にする(panel, "段1", 段たち[0]);
    await expect(行(panel, 段たち[1])).toBeVisible();
    const menu = page.getByTestId("folder-menu");
    const 長押し = async (相手: Locator, 見出し: string) => {
      await 相手.scrollIntoViewIfNeeded();
      await holdTouch(page, 相手, { holdMs: 900 });
      await expect(menu).toHaveCount(1);
      await expect(page.getByTestId("folder-name-full")).toHaveText(見出し);
      await page.waitForTimeout(1_000);
      const 一秒後 = await menu.count();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      return 一秒後;
    };
    const ファイル = await 長押し(行(panel, 計画), "計画.md");
    const フォルダ = await 長押し(行(panel, 段たち[1]), "段2");
    await expect(行(panel, 段たち[1])).toHaveAttribute("aria-expanded", "false");
    const 余白 = await 長押し(panel.getByTestId("folder-blank"), 根の名);
    確かめを書く("N16", { ファイル, フォルダ, 余白 });
    expect(ファイル).toBe(1);
    expect(フォルダ).toBe(1);
    expect(余白).toBe(1);
  });

  test("指で触る端末でも、行の外枠の仮の高さが本物の行の高さと同じ", async ({ page }) => {
    const panel = await PJT専用画面を開く(page);
    await MyDocsを展開する(panel);
    const 値 = await page.evaluate(
      ({ sel, 指 }) => {
        const ul = document.querySelector<HTMLElement>(sel);
        if (ul === null) return null;
        const 外枠 = Array.from(ul.querySelectorAll<HTMLElement>(".folder-tree-row"));
        const cs = 外枠.length > 0 ? getComputedStyle(外枠[0]) : null;
        return {
          matches: matchMedia(指).matches,
          rows: 外枠.length,
          heights: 外枠.map((e) => Math.round(e.getBoundingClientRect().height * 100) / 100),
          containIntrinsicHeight: cs?.containIntrinsicHeight ?? null,
        };
      },
      { sel: 最上段, 指: 指の判定 },
    );
    確かめを書く("N17", 値);
    expect(値).not.toBeNull();
    if (値 === null) return;
    expect(値.matches).toBe(true);
    expect(値.rows).toBeGreaterThan(0);
    expect(値.heights).toEqual(値.heights.map(() => 38));
    expect(String(値.containIntrinsicHeight).replace(/\s+/g, " ").trim()).toBe("auto 38px");
  });
});

test.describe("サイドバーのツリー（狭い画面）", () => {
  test("狭い画面で6段まで展開して長い名前の行を出しても、サイドバーの中は横へはみ出さない", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    const panel = await URLでPJT専用画面を開く(page);
    await expect
      .poll(async () => Math.abs((await panel.boundingBox())?.x ?? Number.POSITIVE_INFINITY))
      .toBeLessThanOrEqual(0.5);
    await フォルダを展開した状態にする(panel, "MyDocs", MYDOCS);
    for (const p of 段たち) {
      await フォルダを展開した状態にする(panel, path.basename(p), p);
    }
    const 奥 = 行(panel, 奥の長い);
    await 奥.scrollIntoViewIfNeeded();
    await 二つの絵(page);
    await expect(奥).toHaveCount(1);
    await expect(行(panel, 段たち[5])).toHaveCount(1);
    const 描けた = await 奥.evaluate((e) => ({
      width: e.getBoundingClientRect().width,
      visible: e.checkVisibility({ contentVisibilityAuto: true } as CheckVisibilityOptions),
    }));
    expect(描けた.width).toBeGreaterThan(0);
    expect(描けた.visible).toBe(true);
    const 値 = await page.evaluate((sel) => {
      const p = document.querySelector<HTMLElement>('[data-testid="project-files-panel"]');
      const ul = document.querySelector<HTMLElement>(sel);
      if (p === null || ul === null) return null;
      const 右 = p.getBoundingClientRect().right;
      const はみ出し = Array.from(p.querySelectorAll<HTMLElement>("*"))
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0 && r.right > 右 + 0.5)
        .slice(0, 20)
        .map(({ e, r }) => ({
          testid: e.dataset.testid ?? null,
          tag: e.tagName.toLowerCase(),
          className: typeof e.className === "string" ? e.className.slice(0, 120) : null,
          right: Math.round(r.right * 100) / 100,
        }));
      return {
        panelRight: 右,
        はみ出し,
        panelScrollWidth: p.scrollWidth,
        panelClientWidth: p.clientWidth,
        ulScrollWidth: ul.scrollWidth,
        ulClientWidth: ul.clientWidth,
      };
    }, 最上段);
    確かめを書く("N18", { 描けた, ...値 });
    expect(値).not.toBeNull();
    if (値 === null) return;
    expect(値.はみ出し).toEqual([]);
    expect(値.panelScrollWidth).toBeLessThanOrEqual(値.panelClientWidth);
    expect(値.ulScrollWidth).toBeLessThanOrEqual(値.ulClientWidth);
  });
});
