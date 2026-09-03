import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  archiveAll,
  expectTerminalToContain,
  fireHook,
  holdTouch,
  openDashboard,
  openSession,
  spawnSession,
  typeLine,
  writeTranscript,
} from './helpers'

/**
 * 名前を付ける／過去のセッションから起こす（名前付け設計§9。テスト計画フェーズ6）。
 *
 * # 走査元は隔離してある
 *
 * 実在の確認は `<AGENTDASHBOARD_CLAUDE_HOME>/.claude/projects` を舐める。
 * `playwright.config.ts` が `.e2e-state/claude-home` を指しているので、**開発者の
 * 本物のホームを見にいかない**（あちらは 1,119 フォルダあり、遅いうえに機械ごとに
 * 結果が変わる）。履歴はこのテストが自分で置く。
 *
 * # `fleet` は要らない
 *
 * 接続断のカードを作る必要が無いので、既定の1台構成で足りる。
 */

/** E2E 用に隔離した、CLI の履歴の置き場所。 */
const CLAUDE_HOME = path.resolve('.e2e-state/claude-home')

/**
 * 過去のセッションの履歴を1本置く。
 *
 * **フォルダ名は何でもよい。** 走査は総なめなので、パスから作った名前と一致しなくても
 * 見つかる（設計§8-4）。ここで規則どおりの名前を作ってしまうと、**規則に頼っていても
 * 気づけない**テストになる。
 */
function 履歴を置く(claudeSessionId: string) {
  const dir = path.join(CLAUDE_HOME, '.claude', 'projects', 'e2e-どこでもよい')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${claudeSessionId}.jsonl`), '{}\n')
}

/** サーバに聞いて、そのカードの CLI セッションIDを取る。 */
async function セッションIDを取る(page: import('@playwright/test').Page, cardId: string) {
  return await expect
    .poll(
      async () => {
        const rows = await page.evaluate(async () => {
          const response = await fetch('/api/sessions')
          return (await response.json()) as {
            card_id: string
            claude_session_id: string | null
          }[]
        })
        return rows.find((row) => row.card_id === cardId)?.claude_session_id ?? null
      },
      { message: '呼び戻し先が記録に載るのを待つ', timeout: 30_000 },
    )
    .not.toBeNull()
    .then(async () => {
      const rows = await page.evaluate(async () => {
        const response = await fetch('/api/sessions')
        return (await response.json()) as {
          card_id: string
          claude_session_id: string | null
        }[]
      })
      return rows.find((row) => row.card_id === cardId)!.claude_session_id!
    })
}

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('外したセッションを、枠の「＋」から呼び戻せる', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = (await tile.getAttribute('data-card-id'))!
  const session = await セッションIDを取る(page, cardId)

  // 履歴を置いてから外す。**置かないと「実在しない」と判定されて選択肢に出ない**
  履歴を置く(session)
  await archiveAll(page)

  // 枠を作り直して「＋」を開く（`archiveAll` は枠も消す）
  const 次 = await spawnSession(page)
  await 次.click({ button: 'left' })
  await page.getByTestId('spawn-open').first().click()
  const picker = page.getByTestId('spawn-past').first()
  await expect(picker).toBeVisible({ timeout: 30_000 })

  // 外したセッションが選択肢に出ていること
  await expect(picker.locator(`option[value="${session}"]`)).toHaveCount(1)
})

test('実在しないセッションは選択肢に出ない', async ({ page }) => {
  // **確かめて無かったものだけを外す**（設計§8-5）。履歴を置かずに外したので、
  // PC は「無い」と答える
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = (await tile.getAttribute('data-card-id'))!
  const session = await セッションIDを取る(page, cardId)
  await archiveAll(page)

  const 次 = await spawnSession(page)
  await 次.click({ button: 'left' })
  await page.getByTestId('spawn-open').first().click()

  // 選択欄そのものが出ないか、出ても当のセッションは載っていない
  const picker = page.getByTestId('spawn-past').first()
  if (await picker.isVisible().catch(() => false)) {
    await expect(picker.locator(`option[value="${session}"]`)).toHaveCount(0)
  }
})


test('カードから名前を付けると、読み込み直しても残る', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = (await tile.getAttribute('data-card-id'))!
  // **呼び戻し先が決まるまで待つ。** 名前は `claude_session_id` に付くので、
  // 起こした直後に押すと記録側が「まだ名前を付けられません」で断る（設計§5-2）。
  // 待たずに書くと、**速い機械では通り遅い機械では落ちる**テストになる
  await セッションIDを取る(page, cardId)
  const shell = page.locator(`[data-testid="tile-shell"][data-card-id="${cardId}"]`)

  // **鉛筆は小窓の中に居ない**（器の直下の兄弟）。中から探すと 0 件で通ってしまう。
  //
  // **マウスの機械ではホバーで出る**（`hasTouch` を立てていないこの describe は
  // `(hover: hover)` と `(pointer: fine)` になる）。乗る前に見えていないこと・
  // 乗ったら見えることの両方を見ないと、`opacity` を消し忘れても気づけない
  const pencil = shell.getByTestId('nickname-edit')
  await expect(pencil).toHaveCSS('opacity', '0')
  await shell.hover()
  await expect(pencil).toHaveCSS('opacity', '1')
  await pencil.click()
  await page.getByTestId('nickname-input').fill('あとで直すやつ')
  await page.getByTestId('nickname-input').press('Enter')

  const title = page.locator(
    `[data-testid="session-tile"][data-card-id="${cardId}"] [data-testid="session-title"]`,
  )
  await expect(title).toHaveText('あとで直すやつ', { timeout: 30_000 })
  // **利用者が付けた名前**として出ていること（CLI の名前と見分けが付く）
  await expect(title).toHaveAttribute('data-nickname', 'user')

  await page.reload()
  await expect(title).toHaveText('あとで直すやつ', { timeout: 30_000 })
})

test.describe('指で触る端末', () => {
  // **`hasTouch` が `(pointer: coarse)` と `(hover: none)` の両方を立てる**
  // （`isMobile` ではない。`dpad.spec.ts` の実測）
  test.use({ hasTouch: true })

  test('長押しで選ぶと鉛筆が出て、指で押せる', async ({ page }) => {
    // **タッチに hover は無い**ので、選択の側が無いとスマホから永久に届かない
    // （名前付け設計§9-3）
    await openDashboard(page)
    const tile = await spawnSession(page)
    const cardId = (await tile.getAttribute('data-card-id'))!
    const shell = page.locator(`[data-testid="tile-shell"][data-card-id="${cardId}"]`)
    const pencil = shell.getByTestId('nickname-edit')

    // 長押しの前は見えていない（`opacity: 0`）
    await expect(pencil).toHaveCSS('opacity', '0')

    // `touchscreen.tap()` では長押しにならないので CDP で合成する
    await holdTouch(page, tile, { holdMs: 600 })
    await expect(shell).toHaveAttribute('data-selected', 'true')
    await expect(pencil).toHaveCSS('opacity', '1')

    await pencil.tap()
    await page.getByTestId('nickname-input').fill('指で付けた名前')
    await page.getByTestId('nickname-input').press('Enter')

    await expect(
      page.locator(
        `[data-testid="session-tile"][data-card-id="${cardId}"] [data-testid="session-title"]`,
      ),
    ).toHaveText('指で付けた名前', { timeout: 30_000 })
  })
})

test('名前を消すと、CLI の名前が薄く出る側へ戻る', async ({ page }) => {
  // **消すのは「行ごと消す」**（設計§10）。空文字を入れて「空の名前が付いている」
  // 状態にすると、CLI の名前が二度と出てこなくなる
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = (await tile.getAttribute('data-card-id'))!
  // **呼び戻し先が決まるまで待つ。** 名前は `claude_session_id` に付くので、
  // 起こした直後に押すと記録側が「まだ名前を付けられません」で断る（設計§5-2）。
  // 待たずに書くと、**速い機械では通り遅い機械では落ちる**テストになる
  await セッションIDを取る(page, cardId)
  const shell = page.locator(`[data-testid="tile-shell"][data-card-id="${cardId}"]`)
  const title = page.locator(
    `[data-testid="session-tile"][data-card-id="${cardId}"] [data-testid="session-title"]`,
  )

  // まず CLI 側の名前を持たせる（履歴に書かれた題が記録まで届く経路）
  await openSession(page, tile)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')
  await page.goBack()
  await expect(title).toHaveAttribute('data-nickname', 'cli', { timeout: 30_000 })
  const cliの名前 = (await title.textContent())!.trim()

  await shell.hover()
  await shell.getByTestId('nickname-edit').click()
  await page.getByTestId('nickname-input').fill('自分で付けた名前')
  await page.getByTestId('nickname-input').press('Enter')
  await expect(title).toHaveText('自分で付けた名前', { timeout: 30_000 })

  // 空にして確定＝消す
  await shell.hover()
  await shell.getByTestId('nickname-edit').click()
  await page.getByTestId('nickname-input').fill('')
  await page.getByTestId('nickname-input').press('Enter')

  await expect(title).toHaveText(cliの名前, { timeout: 30_000 })
  await expect(title).toHaveAttribute('data-nickname', 'cli')
})

test('名前は、別のページへ行って戻っても残る', async ({ page }) => {
  // リロードは記録から読み直すが、**画面の中の行き来は写しを持ち回る**ので別の道になる。
  // 片方だけ通ると「戻ったら消えた」という形で出る
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = (await tile.getAttribute('data-card-id'))!
  // **呼び戻し先が決まるまで待つ。** 名前は `claude_session_id` に付くので、
  // 起こした直後に押すと記録側が「まだ名前を付けられません」で断る（設計§5-2）。
  // 待たずに書くと、**速い機械では通り遅い機械では落ちる**テストになる
  await セッションIDを取る(page, cardId)
  const shell = page.locator(`[data-testid="tile-shell"][data-card-id="${cardId}"]`)
  const title = page.locator(
    `[data-testid="session-tile"][data-card-id="${cardId}"] [data-testid="session-title"]`,
  )

  await shell.hover()
  await shell.getByTestId('nickname-edit').click()
  await page.getByTestId('nickname-input').fill('行って戻る')
  await page.getByTestId('nickname-input').press('Enter')
  await expect(title).toHaveText('行って戻る', { timeout: 30_000 })

  await openSession(page, tile)
  await page.goBack()

  await expect(title).toHaveText('行って戻る', { timeout: 30_000 })
  await expect(title).toHaveAttribute('data-nickname', 'user')
})

test('セッション名がまだ無いカードにも名前を付けられる', async ({ page }) => {
  // **CLI の名前を待たない。** 起こした直後の「まだ何も無い」カードにこそ、
  // 目印を付けたくなる（要件）
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = (await tile.getAttribute('data-card-id'))!
  // **呼び戻し先が決まるまで待つ。** 名前は `claude_session_id` に付くので、
  // 起こした直後に押すと記録側が「まだ名前を付けられません」で断る（設計§5-2）。
  // 待たずに書くと、**速い機械では通り遅い機械では落ちる**テストになる
  await セッションIDを取る(page, cardId)
  const shell = page.locator(`[data-testid="tile-shell"][data-card-id="${cardId}"]`)
  const title = page.locator(
    `[data-testid="session-tile"][data-card-id="${cardId}"] [data-testid="session-title"]`,
  )

  // まだ CLI の名前が付いていないこと（この前提が崩れると何も確かめていない）
  await expect(title).not.toHaveAttribute('data-nickname', 'cli')

  await shell.hover()
  await shell.getByTestId('nickname-edit').click()
  await page.getByTestId('nickname-input').fill('名無しに付ける')
  await page.getByTestId('nickname-input').press('Enter')

  await expect(title).toHaveText('名無しに付ける', { timeout: 30_000 })
  await expect(title).toHaveAttribute('data-nickname', 'user')
})

test('選んで起こすと、新しいカードに同じ名前が付いていて指示も通る', async ({ page }) => {
  // **要件の本丸。** 名前は `claude_session_id` で引くので、呼び戻し先を先に入れて
  // あれば最初の報告から名前が出る（設計§7-5）。**起こした先が本当に生きている**
  // ところまで見ないと、「名前だけ付いた抜け殻」を作っても気づけない
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = (await tile.getAttribute('data-card-id'))!
  const session = await セッションIDを取る(page, cardId)
  const shell = page.locator(`[data-testid="tile-shell"][data-card-id="${cardId}"]`)

  await shell.hover()
  await shell.getByTestId('nickname-edit').click()
  await page.getByTestId('nickname-input').fill('また開くやつ')
  await page.getByTestId('nickname-input').press('Enter')
  await expect(
    page.locator(
      `[data-testid="session-tile"][data-card-id="${cardId}"] [data-testid="session-title"]`,
    ),
  ).toHaveText('また開くやつ', { timeout: 30_000 })

  履歴を置く(session)
  await archiveAll(page)

  const 次 = await spawnSession(page)
  await 次.click({ button: 'left' })
  await page.getByTestId('spawn-open').first().click()
  const picker = page.getByTestId('spawn-past').first()
  await expect(picker).toBeVisible({ timeout: 30_000 })
  await picker.selectOption(session)
  await page.getByTestId('spawn-button').first().click()

  // 起きたカードに名前が付いていること
  const 起きた = page.locator(
    `[data-testid="session-tile"] [data-testid="session-title"]:text-is("また開くやつ")`,
  )
  await expect(起きた).toHaveCount(1, { timeout: 60_000 })

  // **本当に生きているところまで見る。** 名前だけ付いた抜け殻を作っていないこと
  const 起きたカード = page
    .locator('[data-testid="session-tile"]')
    .filter({ hasText: 'また開くやつ' })
    .first()
  await openSession(page, 起きたカード)
  await typeLine(page, 'echo 起きたよ')
  await expectTerminalToContain(page, '起きたよ')
})

test('起動フォームの選択肢が、開いた状態で読めること', async ({ page }) => {
  // **ここは単体テストでは見られない。** 開いた一覧はブラウザが描く別の面で、
  // DOM に無い。見られるのは `option` 要素に効いている色までだが、**地と文字が
  // 同じ値なら、開いたときに読めないことが確定する**——実際にそうなっていた。
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = (await tile.getAttribute('data-card-id'))!
  const session = await セッションIDを取る(page, cardId)
  履歴を置く(session)
  await archiveAll(page)

  const 次 = await spawnSession(page)
  await 次.click({ button: 'left' })
  await page.getByTestId('spawn-open').first().click()
  const picker = page.getByTestId('spawn-past').first()
  await expect(picker).toBeVisible({ timeout: 30_000 })

  const 色 = await picker.locator('option').first().evaluate((node) => {
    const 計算 = getComputedStyle(node)
    return { 文字: 計算.color, 地: 計算.backgroundColor }
  })

  // **透明のままにしない。** 透明だと OS が明るい地で描き、白文字が消える
  expect(色.地, `地が透明のまま: ${JSON.stringify(色)}`).not.toBe(
    'rgba(0, 0, 0, 0)',
  )
  expect(色.文字, `地と文字が同じ色: ${JSON.stringify(色)}`).not.toBe(色.地)
})
