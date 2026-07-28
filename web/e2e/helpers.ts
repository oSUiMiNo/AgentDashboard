import os from 'node:os'
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Terminal } from '@xterm/xterm'

/**
 * E2E 共通の手順。
 *
 * 相手は**ビルドした core サーバ本体**と擬似 claude（`fake-claude`）。本物の CLI を使うと
 * 認証と課金が絡み、出力も毎回変わってテストにならない。実 CLI との結合はテスト計画
 * フェーズ4（`make test-cli`）が担う。
 */

/** 擬似 claude は作業ディレクトリの中身を見ないので、一時ディレクトリで足りる。 */
export const WORK_DIR = os.tmpdir()

/**
 * 端末の内容を読む。
 *
 * WebGL や canvas で描いていると画面の文字は DOM に存在しないため、端末の要素へ
 * 生やしてある取り出し口（`__terminal`）を使う。
 */
export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const container = document.querySelector('[data-testid="terminal"]') as
      | (HTMLDivElement & { __terminal?: Terminal })
      | null
    const term = container?.__terminal
    if (!term) {
      return ''
    }
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
    }
    return lines.join('\n')
  })
}

export async function expectTerminalToContain(page: Page, marker: string) {
  await expect
    .poll(async () => terminalText(page), {
      message: `端末に ${marker} が現れること`,
      timeout: 60_000,
    })
    .toContain(marker)
}

/** 一覧画面を開き、接続が確立するまで待つ。 */
export async function openDashboard(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle('AgentDashboard')
  await expect(page.getByTestId('connection-status')).toHaveAttribute(
    'data-status',
    'open',
  )
}

/** セッションを1つ起動して、その小窓を返す。 */
export async function spawnSession(
  page: Page,
  cwd: string = WORK_DIR,
): Promise<Locator> {
  const before = await page.getByTestId('session-tile').count()
  await page.getByTestId('cwd-input').fill(cwd)
  await page.getByRole('button', { name: 'セッションを起動' }).click()
  await expect(page.getByTestId('session-tile')).toHaveCount(before + 1)
  return page.getByTestId('session-tile').nth(before)
}

/** 小窓をクリックして専用画面を開き、擬似 claude の起動を待つ。 */
export async function openSession(page: Page, tile: Locator) {
  await tile.click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  await expectTerminalToContain(page, '[fake-claude] ready')
}

/** 端末へ1行打ち込む。 */
export async function typeLine(page: Page, line: string) {
  await page.getByTestId('terminal').click()
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

/**
 * 擬似 claude に、注入された settings のフックを実際に起動させる。
 *
 * 本物の CLI と同じ経路（settings → フックのコマンド → `hook-post` → 受信口 → 状態機械）を
 * 通るので、状態表示の確認が課金なしで毎回できる。
 */
export async function fireHook(page: Page, event: string, extra = '') {
  await typeLine(page, extra ? `hook ${event} ${extra}` : `hook ${event}`)
  await expectTerminalToContain(page, `[fake-claude] hook-sent: ${event}`)
}

/**
 * 残っているカードを片付ける。
 *
 * サーバは全テストで共有されるため、片付けないと「前のテストが作ったカードがある状態」を
 * 前提にしたテストになってしまい、単体で流したときと通しで流したときで結果が変わる。
 */
export async function archiveAll(page: Page) {
  // 上限を切っておく。消せないカードがあったときに無限に回り続けないため
  for (let guard = 0; guard < 20; guard += 1) {
    await openDashboard(page)
    const tiles = page.getByTestId('session-tile')
    if ((await tiles.count()) === 0) {
      return
    }
    await tiles.first().click()
    await page.getByRole('button', { name: '削除' }).click()
    // 消えると専用画面は「見つかりません」に変わる。これを消えた合図にする
    await expect(page.getByTestId('not-found')).toBeVisible()
  }
  throw new Error('カードを片付けきれませんでした')
}
