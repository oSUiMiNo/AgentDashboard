/**
 * ダッシュボード自身の版を切り替える（CICD設計§10・§14、テスト計画フェーズ5）。
 *
 * # なぜ土台を分けてあるか
 *
 * 既定の土台は版の機能ごと塞いである（`AGENTDASHBOARD_VERSION_SUPPORTED=0`）ので、
 * そちらでは「出ないこと」しか確かめられない。1つの土台で切り替えると、版と
 * 無関係な全テストが版のカードを抱えて走ることになる。
 *
 * # 保管庫はテスト側から置く
 *
 * E2E はサーバと同じ機械で走るので、保管庫へ直に置ける。**門を通す必要がある**ので、
 * 偽の実行ファイルは形の一覧だけ本物へ委ねる——名前を書き写すと、migration が
 * 増えた日にここだけ古くなる。
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { openDashboard } from './helpers'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SERVER_BINARY = path.join(REPO_ROOT, 'server/target/debug/agentdashboard')
const VERSIONS_DIR = path.join(
  REPO_ROOT,
  'web/.e2e-state/versions-state/versions',
)

/** 門を通れる一式を保管庫へ置く。 */
function placeVersion(version: string) {
  const dir = path.join(VERSIONS_DIR, version)
  fs.mkdirSync(dir, { recursive: true })

  // 形の一覧だけ本物へ委ねる。**書き写すと migration が増えた日にここだけ古くなる**
  fs.writeFileSync(
    path.join(dir, 'agentdashboard'),
    `#!/bin/sh
case "$1" in
  --version) echo "agentdashboard ${version}" ;;
  migrations) exec ${SERVER_BINARY} migrations ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(dir, 'agentdashboard-agent'),
    `#!/bin/sh\necho "agentdashboard-agent ${version}"\n`,
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(dir, 'transcript-parser'),
    `#!/bin/sh\nprintf '{"ev":"hello","parser_version":"${version}"}\\n'\n`,
    { mode: 0o755 },
  )
}

test.beforeEach(async ({ page }) => {
  fs.rmSync(VERSIONS_DIR, { recursive: true, force: true })
  placeVersion('9.9.9')
  await openDashboard(page)
  await page.getByTestId('settings-link').click()
  await expect(page.getByTestId('versions')).toHaveAttribute(
    'data-supported',
    'true',
  )
})

test.afterEach(async ({ page }) => {
  // **予約を先に外す。** 残したまま次へ行くと、E2E のサーバが次の起動で
  // 偽の実行ファイルへ乗り換えようとする
  await page.request.delete('/api/versions/selected')
  fs.rmSync(VERSIONS_DIR, { recursive: true, force: true })
})

test('版を選ぶと予約として出て、取り消せる', async ({ page }) => {
  await page.getByTestId('versions-picker').selectOption('9.9.9')

  await expect(page.getByTestId('versions-reservation')).toContainText('9.9.9')
  await expect(page.getByTestId('versions-picker')).toHaveValue('9.9.9')

  await page.getByTestId('versions-cancel').click()

  await expect(page.getByTestId('versions-reservation')).toHaveCount(0)
  await expect(page.getByTestId('versions-picker')).toHaveValue('')
})

test('選んだだけではセッションが落ちない', async ({ page }) => {
  // **要件が名指しで恐れている点。** 選ぶことと効かせることは別の操作である
  const before = await page.request.get('/api/sessions')
  const cards = ((await before.json()) as unknown[]).length

  await page.getByTestId('versions-picker').selectOption('9.9.9')
  await expect(page.getByTestId('versions-reservation')).toBeVisible()

  const after = await page.request.get('/api/sessions')
  expect(((await after.json()) as unknown[]).length).toBe(cards)
  // 画面も繋がったまま
  await expect(page.getByTestId('connection-status')).toHaveAttribute(
    'data-status',
    'open',
  )
})

test('入れ替えを押す前に、何が失われるかが出る', async ({ page }) => {
  await page.getByTestId('versions-picker').selectOption('9.9.9')

  // 枚数と、戻ってこないかもしれないことの両方を出す（設計§10）
  await expect(page.getByTestId('versions-stranded')).toBeVisible()
  await expect(page.getByTestId('versions-reservation')).toContainText(
    '端末で',
  )
  await expect(page.getByTestId('versions-restart')).toBeVisible()
})

test('いま走っている版と次に起こす版を別々に出す', async ({ page }) => {
  await expect(page.getByTestId('versions-running')).toBeVisible()
  await expect(page.getByTestId('versions-picker')).toHaveValue('')

  await page.getByTestId('versions-picker').selectOption('9.9.9')

  // 走っている版は選んでも変わらない（効くのは次に起こしたとき）
  await expect(page.getByTestId('versions-running')).not.toContainText('9.9.9')
  await expect(page.getByTestId('versions-picker')).toHaveValue('9.9.9')
})
