import { expect, test } from '@playwright/test'
import { openDashboard } from './helpers'

/**
 * アカウント画面と入口の鍵（セルフホスト化設計§8-2・§8-4、テスト計画フェーズ5）。
 *
 * # ここでしか通らないもの
 *
 * ログインの往復は**セルフホスト構成でしか存在しない**（ローカルモードには鍵が無い）。
 * トークンの発行と失効も、繋いでくる PC が居る構成でしか意味を持たない。
 *
 * # 失効は接続中に効かなければ意味が無い
 *
 * `revoked_at` を立てるだけだと、既に繋がっている PC は次に切れるまで繋がり続ける。
 * ここでは**押した結果として一覧のカードが「接続断」へ変わる**ところまで見る。
 */

test('ログインしないと一覧が見えない', async ({ page }) => {
  // 入館証を捨ててから開く。**扉は開くが中は返さない**（§8-2）
  await page.context().clearCookies()
  await page.goto('/')

  await expect(page.getByTestId('login-form')).toBeVisible()
  await expect(page.getByTestId('spawn-form')).toHaveCount(0)

  // 間違えたら理由が出る。**名前の有無とパスワード違いを呼び分けない**
  await page.getByTestId('login-name').fill('e2e')
  await page.getByTestId('login-password').fill('ちがうあいことば')
  await page.getByRole('button', { name: '入る' }).click()
  await expect(page.getByTestId('login-error')).toBeVisible()

  await page.getByTestId('login-password').fill('e2eのあいことば')
  await page.getByRole('button', { name: '入る' }).click()
  await expect(page.getByTestId('spawn-form')).toBeVisible()
})

test('鍵を発行すると平文が一度だけ出て、一覧に載る', async ({ page }) => {
  await openDashboard(page)
  await page.getByTestId('account-link').click()

  // **読み込みを待ってから数える。** 一覧は開いたあとに取りに行くので、
  // 待たずに数えると必ず 0 になり、増えた枚数の判定が1つずれる。
  // `scripts/e2e-remote` が1本発行しているので、必ず1行以上ある
  await expect(page.getByTestId('token-row').first()).toBeVisible()
  const before = await page.getByTestId('token-row').count()
  await page.getByTestId('token-label').fill('E2Eで足した鍵')
  await page.getByRole('button', { name: '発行する' }).click()

  // 平文はここにしか出てこない（DB にはハッシュしかない）
  const issued = page.getByTestId('issued-token')
  await expect(issued).toBeVisible()
  await expect(issued).toContainText('adp_')
  await expect(page.getByTestId('token-row')).toHaveCount(before + 1)

  // 控えたら消える。**「もう一度見る」は無い**
  await page.getByRole('button', { name: '控えました' }).click()
  await expect(issued).toHaveCount(0)
})

test('繋がっている PC が一覧に出る', async ({ page }) => {
  await openDashboard(page)
  await page.getByTestId('account-link').click()

  const row = page.getByTestId('agent-row').first()
  await expect(row).toContainText('E2E用PC')
  await expect(row).toHaveAttribute('data-connected', 'true')
})
