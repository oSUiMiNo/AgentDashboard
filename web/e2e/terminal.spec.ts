import os from 'node:os'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { Terminal } from '@xterm/xterm'

/**
 * フェーズ1（M1: 動くターミナル）の通し確認。
 *
 * ビルドした core サーバ本体に繋ぎ、擬似 claude を相手に
 * 「起動 → 画面に出力が出る → キー入力が届く → 大量出力でフロー制御が働く → 終了 → 削除」
 * までをブラウザから行う。設計§4/§10 が定める経路が実際に通っていることの検証にあたる。
 */

/**
 * サーバは全テストで共有されるため、残ったカードを片付けてから次へ渡す。
 *
 * 片付けないと「前のテストが作ったカードがある状態」を前提にしたテストになってしまい、
 * 単体で流したときと通しで流したときで結果が変わる。
 */
test.afterEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('connection-status')).toHaveAttribute(
    'data-status',
    'open',
  )
  const remove = page.getByRole('button', { name: '削除' })
  for (let count = await remove.count(); count > 0; count -= 1) {
    await remove.first().click()
    await expect(page.getByTestId('session-card')).toHaveCount(count - 1)
  }
})

/** 端末の内容を読む。WebGL や canvas で描いていると DOM から文字を読めないため。 */
async function terminalText(page: Page): Promise<string> {
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

async function expectTerminalToContain(page: Page, marker: string) {
  await expect
    .poll(async () => terminalText(page), {
      message: `端末に ${marker} が現れること`,
      timeout: 60_000,
    })
    .toContain(marker)
}

async function startSession(page: Page) {
  await page.goto('/')

  // 単一バイナリが web を配信できていること
  await expect(page).toHaveTitle('AgentDashboard')
  await expect(page.getByTestId('connection-status')).toHaveAttribute(
    'data-status',
    'open',
  )

  // 擬似 claude は中身を見ないので一時ディレクトリで足りる
  await page.getByTestId('cwd-input').fill(os.tmpdir())
  await page.getByRole('button', { name: 'セッションを起動' }).click()

  const card = page.getByTestId('session-card')
  await expect(card).toHaveCount(1)
  await card.getByText(os.tmpdir()).click()

  await expect(page.getByTestId('terminal')).toBeVisible()
  await expectTerminalToContain(page, '[fake-claude] ready')
  return card
}

test('セッションを起動してブラウザのターミナルから操作できる', async ({ page }) => {
  const card = await startSession(page)

  // キー入力が PTY まで届き、応答が戻ってくる
  await page.getByTestId('terminal').click()
  await page.keyboard.type('こんにちは')
  await page.keyboard.press('Enter')
  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')

  // 終了させると状態が変わり、削除すると一覧から消える
  await card.getByRole('button', { name: '終了' }).click()
  await expect(card).toHaveAttribute('data-status', 'ended')

  await card.getByRole('button', { name: '削除' }).click()
  await expect(page.getByTestId('session-card')).toHaveCount(0)
})

test('大量出力でフロー制御が働き、最後まで取りこぼさず届く', async ({ page }) => {
  const card = await startSession(page)

  // E2E 用の設定はしきい値を小さくしてある（web/e2e/config.toml）ので、
  // 数MBでウォーターマークに到達する
  const floodBytes = 8 * 1024 * 1024
  await page.getByTestId('terminal').click()
  await page.keyboard.type(`flood ${floodBytes}`)
  await page.keyboard.press('Enter')

  // 出力の途中で少なくとも1回は停止を要求していること
  await expect
    .poll(
      async () =>
        Number(
          await page.getByTestId('terminal-status').getAttribute('data-pause-count'),
        ),
      { message: 'フロー制御が発火すること', timeout: 60_000 },
    )
    .toBeGreaterThan(0)

  // 止めても捨てていないので、最後まで届く
  await expectTerminalToContain(page, '[fake-claude] flood-end')

  const status = page.getByTestId('terminal-status')
  // 落ち着いたら再開している（止まりっぱなしにならない）
  await expect(status).toHaveAttribute('data-flow', 'running')

  // 受け取った量が要求量を下回っていない＝取りこぼしていない
  const totalBytes = Number(await status.getAttribute('data-total-bytes'))
  expect(totalBytes).toBeGreaterThanOrEqual(floodBytes)

  await card.getByRole('button', { name: '終了' }).click()
  await expect(card).toHaveAttribute('data-status', 'ended')
})

test('存在しない作業ディレクトリを指定すると理由が表示される', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('connection-status')).toHaveAttribute(
    'data-status',
    'open',
  )

  await page.getByTestId('cwd-input').fill('/存在しないはずのディレクトリ')
  await page.getByRole('button', { name: 'セッションを起動' }).click()

  await expect(page.getByTestId('error-banner')).toContainText(
    '作業ディレクトリが存在しません',
  )
  await expect(page.getByTestId('session-card')).toHaveCount(0)
})
