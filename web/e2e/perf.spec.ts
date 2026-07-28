import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  archiveAll,
  fireHook,
  openDashboard,
  showTerminal,
  spawnSession,
  typeLine,
  WORK_DIR,
} from './helpers'

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
