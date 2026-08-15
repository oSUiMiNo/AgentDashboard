import { expect, test } from '@playwright/test'
import {
  archiveAll,
  FIXTURES,
  fireHook,
  openDashboard,
  openSession,
  showTerminal,
  showTranscript,
  spawnSession,
  writeTranscript,
} from './helpers'

/**
 * 構造化ビューの通し確認（フェーズ3 / M3）。
 *
 * 実物のフィクスチャ（本物の claude が書いた JSONL）を擬似 claude に書かせ、
 * 「フック → パーサ → WebSocket → 画面」を端から端まで通す。単体テストは各層の中しか
 * 見ないので、経路が繋がっているかはここでしか分からない。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

/** セッションを起動し、トランスクリプトの場所を core に知らせるところまで。 */
async function startSession(page: Parameters<typeof openDashboard>[0]) {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)
  return tile
}

test('フィクスチャの履歴が構造化ビューに出る', async ({ page }) => {
  await startSession(page)

  // まだ何も書いていないので空
  await showTranscript(page)
  await expect(page.getByTestId('transcript-status')).toHaveAttribute('data-row-count', '0')

  // 打ち込む先は端末なので、書かせるときはターミナルへ戻す
  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')

  await showTranscript(page)
  await expect
    .poll(
      async () =>
        Number(
          await page.getByTestId('transcript-status').getAttribute('data-row-count'),
        ),
      { message: '履歴が届くこと', timeout: 30_000 },
    )
    .toBeGreaterThan(0)

  // ユーザの指示とアシスタントの本文が根に並ぶ
  await expect(page.locator('[data-testid="transcript-row"][data-kind="user_message"]')).toHaveCount(
    1,
  )
  await expect(
    page.locator('[data-testid="transcript-row"][data-kind="assistant_text"]').first(),
  ).toBeVisible()
})

test('ツールコールを開くとコードの差分が出る', async ({ page }) => {
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')
  await showTranscript(page)

  // Edit のツールコールを探して開く
  const editRow = page
    .locator('[data-testid="transcript-row"][data-kind="tool_call"]')
    .filter({ hasText: 'Edit' })
    .first()
  await expect(editRow).toBeVisible({ timeout: 30_000 })
  await editRow.getByRole('button').first().click()

  await expect(editRow.getByTestId('diff-view')).toBeVisible()
  // 差分の中身（消えた行・増えた行）が実際に描かれている
  await expect(editRow.getByTestId('diff-view')).toContainText('TODO')
})

test('サブエージェントの中まで掘れる', async ({ page }) => {
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/subagent/session.jsonl')
  await showTranscript(page)

  const agentRow = page
    .locator('[data-testid="transcript-row"][data-kind="tool_call"]')
    .filter({ hasText: 'Agent' })
    .first()
  await expect(agentRow).toBeVisible({ timeout: 30_000 })
  await agentRow.getByRole('button').first().click()

  // サブエージェントの行が現れ、開くとその中の作業が見える
  const subagent = page.locator('[data-testid="transcript-row"][data-kind="subagent"]').first()
  await expect(subagent).toBeVisible()
  await subagent.getByRole('button').first().click()
  await expect(
    page.locator('[data-testid="transcript-row"][data-kind="tool_call"]').filter({
      hasText: 'Glob',
    }),
  ).toBeVisible()
})

test('巻き戻し前のやりとりは畳まれ、開けば読める', async ({ page }) => {
  // `/rewind` は JSONL を物理的に巻き戻さず、同じファイルに2つ目の根として追記する
  // （設計§16 の実測）。そのまま全部並べると「巻き戻したのに前のやりとりが見えている」
  // という見え方になる
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'synthetic/rewound/session.jsonl')
  await showTranscript(page)

  const rewound = page.locator('[data-testid="transcript-row"][data-kind="rewound"]')
  await expect(rewound).toBeVisible({ timeout: 30_000 })
  await expect(rewound).toContainText('巻き戻し前のやりとり 2件')

  // 畳んでいる間は、最新の枝の発言だけが見える
  await expect(
    page.getByText('やっぱり2つ目の TODO のほうを書き換えて。').first(),
  ).toBeVisible()
  await expect(page.getByText('notes.md の1つ目の TODO を DONE に書き換えて。')).toHaveCount(0)

  // 開けば読める（捨ててはいない）
  await page.getByTestId('rewound-toggle').click()
  await expect(
    page.getByText('notes.md の1つ目の TODO を DONE に書き換えて。').first(),
  ).toBeVisible()
})

/**
 * 本文の見せ方（イシューグループ_2026-0813-2208 テスト計画フェーズ5）。
 *
 * 単体では各層の中しか見ない。**パーサ → WebSocket → 画面が端から端まで繋がったこと**は
 * ここでしか分からない。使うのは狙って作った合成フィクスチャで、**切れ目が記法の途中へ
 * 来るように長さを合わせてある**（実物では境目を作れない）。
 */
async function loadMarkdownBodies(page: Parameters<typeof openDashboard>[0]) {
  await startSession(page)
  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'synthetic/markdown-bodies/session.jsonl')
  await showTranscript(page)
  await expect
    .poll(
      async () =>
        Number(await page.getByTestId('transcript-status').getAttribute('data-row-count')),
      { message: '履歴が届くこと', timeout: 30_000 },
    )
    .toBeGreaterThan(0)
}

/** 畳む相手の行（しきい値を超えた本文）。 */
function foldableRow(page: Parameters<typeof openDashboard>[0]) {
  return page.locator('[data-testid="transcript-row"][data-foldable="true"]').first()
}

test('長い本文は畳まれて出て、押すと全文になる', async ({ page }) => {
  await loadMarkdownBodies(page)

  const row = foldableRow(page)
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-body-open', 'false')

  const folded = (await row.innerText()).length
  await row.getByTestId('body-toggle').click()

  await expect(row).toHaveAttribute('data-body-open', 'true')
  expect((await row.innerText()).length).toBeGreaterThan(folded)
})

test('表と箇条書きが要素として出る', async ({ page }) => {
  // 記号のまま並んでいたら、この画面の存在理由（読みやすさ）が立たない
  await loadMarkdownBodies(page)

  const body = foldableRow(page).getByTestId('row-body')
  await expect(body.locator('table')).toHaveCount(1)
  await expect(body.locator('li')).toHaveCount(3)
  await expect(body.locator('pre code')).toHaveCount(1)
  // 見出しの横に本文の先頭が出ていない（二重の消滅）
  await expect(foldableRow(page).getByRole('button').first()).not.toContainText('フォルダの決まり')
})

test('`<br/>` を含む本文でも行が消えない', async ({ page }) => {
  // このリポジトリのドキュメントの作法を引用した応答が、行ごと消えて見えないこと
  await loadMarkdownBodies(page)

  const row = page
    .locator('[data-testid="transcript-row"][data-kind="assistant_text"]')
    .filter({ hasText: '区切りの作法' })
  await expect(row.getByTestId('row-body').locator('br')).toHaveCount(2)
  await expect(row).toContainText('つぎの見出し')
})

test('高さの違う行が混ざっていても、末尾に居るかどうかを正しく判定する', async ({ page }) => {
  // 本文を常に出すようになって行の高さがばらけた（29px の行と 1,000px 超の行が混ざる）。
  // **数万ノードは確かめていない**（フェーズ1 の判断。数万件は `flatten` の単体で通す）
  await loadMarkdownBodies(page)
  const tree = page.getByTestId('transcript-tree')

  await tree.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(page.getByTestId('transcript-status')).toHaveAttribute('data-at-end', 'true')

  await tree.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(page.getByTestId('transcript-status')).toHaveAttribute('data-at-end', 'false')
})

test('遡っている最中に履歴が増えても、引き戻されない', async ({ page }) => {
  // 読んでいる途中で勝手に飛ぶのが、この画面でいちばん困る挙動（初期実装設計§10）
  await loadMarkdownBodies(page)
  const tree = page.getByTestId('transcript-tree')
  const status = page.getByTestId('transcript-status')

  await tree.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(status).toHaveAttribute('data-at-end', 'false')
  const before = Number(await status.getAttribute('data-row-count'))

  // **構造化ビューを見たまま**追記する。入力欄はタブの外に常設されているので、
  // ターミナルへ切り替えずに擬似 claude へ命令を送れる（切り替えると、隠れている間の
  // 追記になって「引き戻されるか」を確かめられない）
  await page.getByTestId('composer-input').fill(`jsonl ${FIXTURES}/v2.1.220/basic-tools/session.jsonl`)
  await page.keyboard.press('Control+Enter')

  await expect
    .poll(async () => Number(await status.getAttribute('data-row-count')), {
      message: '行が増えること',
      timeout: 30_000,
    })
    .toBeGreaterThan(before)
  // 増えたあとも、見ている場所は動かない
  expect(await tree.evaluate((el) => el.scrollTop)).toBe(0)
})

test('タブを往復してもターミナルの内容が残る', async ({ page }) => {
  // 切り替えのたびに端末を作り直すと、スクロールバックが消えて操作の続きができなくなる
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')

  await showTranscript(page)
  await expect(page.getByTestId('session-view')).toHaveAttribute('data-view', 'transcript')

  await showTerminal(page)
  await expect(page.getByTestId('session-view')).toHaveAttribute('data-view', 'terminal')
  // 戻ってきても、それまでの出力がそのまま残っている
  await expect(page.getByTestId('terminal-status')).toHaveAttribute('data-flow', 'running')
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const container = document.querySelector('[data-testid="terminal"]') as
          | (HTMLDivElement & { __terminal?: { buffer: { active: { length: number } } } })
          | null
        return container?.__terminal?.buffer.active.length ?? 0
      }),
    )
    .toBeGreaterThan(0)
})
