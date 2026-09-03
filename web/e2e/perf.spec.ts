import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  archiveAll,
  fireHook,
  openDashboard,
  openSession,
  showTerminal,
  spawnSession,
  typeLine,
  WORK_DIR,
} from './helpers'
import { ROAM_MAX } from '../src/stores/roam'

/**
 * 並列負荷の通し確認（テスト計画フェーズ6「並列負荷」のブラウザ側）。
 *
 * # 何を自動判定にして、何を記録に留めるか
 *
 * フレームレートは実行機の混み具合で上下するので、**60fps を割ったら失敗**にすると
 * 「他の作業をしていると落ちるテスト」になる。役に立たないので採らない。
 *
 * 自動判定にするのは**マシンの速さに左右されない性質**だけ。
 *
 * - 12セッションぶんの小窓が全部出ること
 * - 高出力の最中でも状態の更新が届くこと
 * - 画面が固まっていないこと（描画が完全に止まっていない、という緩い下限）
 *
 * 実測値は `[perf]` の印を付けて標準出力へ流し、`make perf` で拾って実行レポートに残す。
 */

/** 設計が想定する規模（設計§4 の「12セッション同時稼働」）。 */
const SESSIONS = 12

/** 高出力にするセッションの数。 */
const NOISY = 3

/** 「完全に固まっていない」ことの下限。60fps の判定ではない。 */
const MIN_FPS = 10

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('12セッション同時稼働でも一覧が追従する', async ({ page }) => {
  test.setTimeout(180_000)
  await openDashboard(page)

  for (let index = 0; index < SESSIONS; index += 1) {
    await spawnSession(page, WORK_DIR)
  }
  await expect(page.getByTestId('session-tile')).toHaveCount(SESSIONS)

  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="session-tile"]')].map(
      (tile) => (tile as HTMLElement).dataset.cardId ?? '',
    ),
  )

  // 数本を高出力にする。端末を閉じても PTY は動き続けるので、負荷は残る
  for (const cardId of cards.slice(0, NOISY)) {
    await page.goto(`/s/${cardId}`)
    await showTerminal(page)
    await typeLine(page, `flood ${4 * 1024 * 1024}`)
  }

  // 高出力の最中に、別のセッションで状態を変える。フックが届いてから画面に出るまでを測る
  const target = cards[SESSIONS - 1]
  await page.goto(`/s/${target}`)
  await showTerminal(page)
  await fireHook(page, 'UserPromptSubmit')

  const started = Date.now()
  await expect(page.getByTestId('session-view')).toHaveAttribute(
    'data-status',
    'working',
    { timeout: 30_000 },
  )
  const latency = Date.now() - started

  // 一覧へ戻っても、12枚そろって状態が反映されている
  await openDashboard(page)
  await expect(page.getByTestId('session-tile')).toHaveCount(SESSIONS)
  await expect(
    page.locator(`[data-testid="session-tile"][data-card-id="${target}"]`),
  ).toHaveAttribute('data-status', 'working')

  const fps = await measureFps(page)
  console.log(
    `[perf] sessions=${SESSIONS} noisy=${NOISY} fps=${fps} statusLatencyMs=${latency}`,
  )

  expect(fps).toBeGreaterThan(MIN_FPS)
})

/** 一覧を見ている状態で、1秒間に描けたフレーム数。 */
async function measureFps(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0
        const start = performance.now()
        const tick = () => {
          frames += 1
          if (performance.now() - start < 1000) {
            requestAnimationFrame(tick)
          } else {
            resolve(frames)
          }
        }
        requestAnimationFrame(tick)
      }),
  )
}

/**
 * 並べ替えの計測（並べ替え設計§15-9・テスト計画フェーズ8「効果線（性能）」）。
 *
 * # なぜ線を溜めてから測るのか
 *
 * 「たまにカクつく」の主犯は並べ替えではなく、**同時に走っている効果線の引き直し**
 * だった（調査レポート：同じ操作が線の有無だけで 7.7倍違う。単発 805ms）。
 * **線が0本なら費用は本当にゼロ**なので、線0本で測ると必ず通る——承認待ちのカードを
 * 置き、線が上限まで溜まってから運ぶ。
 *
 * # 何を採るか
 *
 * - `rafMaxGapMs`：描けたフレームの最大の隙間（調査レポートの maxGap と同じ物差し）
 * - Long Animation Frames（`blockingDuration` の合計と最大、帰属の上位）。**製品コードには
 *   1行も入れない**（jsdom に `PerformanceObserver` が無い）。ここの `page.evaluate` に閉じる
 *
 * # 門は末尾に置く
 *
 * `make perf` は落ちた時点で打ち切られる（ガイドライン「負荷に左右される数値をテストに
 * するとき」）。値は先に印字し、門はテストのいちばん最後で見る。**門の値は出発点**で、
 * 直す前後の2〜3回の値を見て据える（設計§15-10）。
 */

/** 並べ替えの計測の規模（設計§15-9：線34本・20枚・端から端へ） */
const REORDER_CARDS = 20

/** 承認待ちにする枚数。線は跳ねの折り返しごとに籤で撃たれるので、複数枚で早く溜まる */
const WAITING = 3

/** 運びのステップ数。**各ステップで1フレーム待つ**（束ねられると追従も費用も測れない） */
const DRAG_STEPS = 40

/**
 * 門（設計§15-9「値を見て据える」）。**堅い物差しは JS の時間だけ。**
 *
 * 線が 32本あると、**触らなくても** SVG と CSS アニメーションの描き直しだけでフレームが
 * 34〜50ms まで伸び、運搬中は 60〜83ms で揺れる（調査レポート：33本で maxGap 50ms・41fps）。
 * 直す前後で JS の帰属は 34〜79ms → 0ms に落ちたが、**隙間の最大値は前後で変わらなかった**
 * ——残っているのは描き直しの費用で、効果線の上限の話（設計§15-10）。この工事の約束は
 * 「並べ替えが JS で固まらない」なので、門は JS の時間に置き、隙間は印字して残す。
 *
 * - `loafScriptMs`：長いフレームの中で JS が走った時間の合計。**直す前は赤、直した後は 0**
 * - `rafMaxGap`：印字のみ。**明らかに固まった**（500ms）ときだけ落とす
 */
const MAX_SCRIPT_MS = 30
const FROZEN_GAP_MS = 500
/** 運ぶ前に隙間を測る時間 */
const IDLE_SAMPLE_MS = 2_000

interface PerfProbe {
  alive: boolean
  /** 運ぶ前の最大の隙間（線だけが動いている状態） */
  idleMaxGap: number
  /** 運び始めてからの最大の隙間 */
  rafMaxGap: number
  /** 運び始めたら真。それまでの隙間は idle 側へ積む */
  dragging: boolean
  loafSupported: boolean
  loaf: { count: number; blocking: number; max: number; byScript: Record<string, number> }
}

/** 権限確認待ち（承認待ち）にして、一覧へ戻る。`roam.spec.ts` の作法そのまま */
async function 承認待ちにする(page: Page, tile: Locator): Promise<void> {
  await openSession(page, tile)
  await fireHook(page, 'Notification', '{"notification_type":"permission_prompt"}')
  await page.goto('/')
}

/** 1フレーム待つ。`mouse.move` を束ねさせないため */
async function 一フレーム待つ(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  )
}

test('線が多いときに、端から端へ運んでも固まらない', async ({ page }) => {
  test.setTimeout(600_000)
  await openDashboard(page)

  for (let index = 0; index < REORDER_CARDS; index += 1) {
    await spawnSession(page, WORK_DIR)
  }
  await expect(page.getByTestId('session-tile')).toHaveCount(REORDER_CARDS)

  for (let index = 0; index < WAITING; index += 1) {
    await 承認待ちにする(page, page.getByTestId('session-tile').nth(index))
  }
  await expect(
    page.locator('[data-testid="tile-shell"][data-motion="shake"]'),
  ).toHaveCount(WAITING)

  // **線が上限まで溜まるのを待つ。** 籤の外れで揺れるので、上限は長めに取る
  await expect
    .poll(() => page.getByTestId('roam-line').count(), {
      message: '効果線が上限まで溜まること',
      timeout: 240_000,
    })
    .toBeGreaterThanOrEqual(ROAM_MAX)
  const lines = await page.getByTestId('roam-line').count()

  // **20枚が全部見える高さにしてから測る。** 端から端へを、スクロール無しで運ぶため。
  // 起こす・承認待ちにする手順は既定の窓で行う（端末へ打ち込む手順が窓の高さに
  // 影響されないように）。広げた直後は寸法の見張りが1回引き直すので、収まるまで待つ
  await page.setViewportSize({ width: 1280, height: 2000 })
  await page.waitForTimeout(1_000)

  await page.evaluate(() => {
    const probe: PerfProbe = {
      alive: true,
      idleMaxGap: 0,
      rafMaxGap: 0,
      dragging: false,
      loafSupported: PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'),
      loaf: { count: 0, blocking: 0, max: 0, byScript: {} },
    }
    ;(window as unknown as { __perf: PerfProbe }).__perf = probe
    let last = performance.now()
    const tick = (now: number) => {
      if (probe.dragging) {
        probe.rafMaxGap = Math.max(probe.rafMaxGap, now - last)
      } else {
        probe.idleMaxGap = Math.max(probe.idleMaxGap, now - last)
      }
      last = now
      if (probe.alive) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    if (probe.loafSupported) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const frame = entry as PerformanceEntry & {
            blockingDuration?: number
            scripts?: { sourceURL?: string; sourceFunctionName?: string; duration: number }[]
          }
          probe.loaf.count += 1
          probe.loaf.blocking += frame.blockingDuration ?? 0
          probe.loaf.max = Math.max(probe.loaf.max, frame.duration)
          for (const script of frame.scripts ?? []) {
            const key = `${script.sourceURL ?? '?'}#${script.sourceFunctionName ?? '?'}`
            probe.loaf.byScript[key] = (probe.loaf.byScript[key] ?? 0) + script.duration
          }
        }
      })
      observer.observe({ type: 'long-animation-frame', buffered: false })
      ;(window as unknown as { __perfObserver: PerformanceObserver }).__perfObserver = observer
    }
  })

  // **承認待ちでない**最後のカードを先頭へ。承認待ちのカードは運搬中も跳ね続ける
  // （`still` になるのは掴んでいる本人だけ）ので、線を撃つ側の門が実際に働く条件になる
  const group = page.getByTestId('project-group').first()
  const shells = group.getByTestId('tile-shell')
  const 運ぶ = shells.nth(REORDER_CARDS - 1)
  const 先頭 = shells.first()
  const 運ぶID = await 運ぶ.getAttribute('data-card-id')
  const from = await 運ぶ.boundingBox()
  const to = await 先頭.boundingBox()
  if (!from || !to || !運ぶID) {
    throw new Error('運ぶカードの位置が取れません')
  }
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  const goal = { x: to.x + to.width / 2, y: to.y + to.height / 2 }

  // **運ぶ前の隙間を採る。** 線だけが動いている状態の費用が、比べる相手
  await page.waitForTimeout(IDLE_SAMPLE_MS)
  await page.evaluate(() => {
    ;(window as unknown as { __perf: PerfProbe }).__perf.dragging = true
  })

  const started = Date.now()
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    await page.mouse.move(
      start.x + ((goal.x - start.x) * step) / DRAG_STEPS,
      start.y + ((goal.y - start.y) * step) / DRAG_STEPS,
    )
    await 一フレーム待つ(page)
  }
  await page.mouse.up()
  await expect
    .poll(
      async () =>
        (
          await shells.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('data-card-id') ?? ''),
          )
        )[0],
      { message: '運んだカードが先頭に来ること' },
    )
    .toBe(運ぶID)
  await expect(
    page.locator(`[data-testid="tile-shell"][data-card-id="${運ぶID}"]`),
  ).toHaveAttribute('data-reordering', 'false', { timeout: 5_000 })
  const dragMs = Date.now() - started

  const probe = await page.evaluate(() => {
    const w = window as unknown as { __perf: PerfProbe; __perfObserver?: PerformanceObserver }
    w.__perf.alive = false
    w.__perfObserver?.disconnect()
    return w.__perf
  })
  const 帰属 = Object.entries(probe.loaf.byScript).sort((a, b) => b[1] - a[1])
  const scriptMs = 帰属.reduce((sum, [, ms]) => sum + ms, 0)
  const top = 帰属
    .slice(0, 3)
    .map(([key, ms]) => `${key}=${Math.round(ms)}`)
    .join(',')
  console.log(
    `[perf] reorder cards=${REORDER_CARDS} waiting=${WAITING} lines=${lines} dragMs=${dragMs}` +
      ` idleMaxGapMs=${Math.round(probe.idleMaxGap)} rafMaxGapMs=${Math.round(probe.rafMaxGap)}` +
      ` loafSupported=${probe.loafSupported} loafCount=${probe.loaf.count}` +
      ` loafBlockingMs=${Math.round(probe.loaf.blocking)} loafMaxMs=${Math.round(probe.loaf.max)}` +
      ` loafScriptMs=${Math.round(scriptMs)} loafTop=${top}`,
  )

  // **門はいちばん最後。** 値が先に残るように。絶対値ではなく、運ぶ前との比で見る
  expect(probe.rafMaxGap).toBeLessThan(FROZEN_GAP_MS)
  if (probe.loafSupported) {
    expect(scriptMs).toBeLessThan(MAX_SCRIPT_MS)
  } else {
    test.info().annotations.push({ type: 'note', description: 'Long Animation Frames 非対応' })
  }
})
