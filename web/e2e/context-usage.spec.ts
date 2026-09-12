import { expect, test } from '@playwright/test'
import {
  archiveAll,
  fireHook,
  openDashboard,
  openSession,
  showTranscript,
  spawnSession,
  typeLine,
  writeTranscript,
} from './helpers'

/**
 * コンテキストの使い具合を、実物のブラウザで通す（`コンテキストの残量を、打たずに
 * 常に見えるようにする` テスト計画フェーズ4・6）。
 *
 * # なぜ e2e が要るのか — **1度も通していなかった穴を埋める段である**
 *
 * このイシューは**テスト計画に「画面に組んだ状態｜E2E｜`make e2e`」を層として挙げながら、
 * 計画のフェーズに回す段を1つも作らなかった**。`make ci` は `lint test build` で
 * **e2e を含まない**ので、緑のまま最後まで進んだ。
 *
 * **その結果、レビューで11件の指摘が出た。** いちばん重かったのが
 * **「軽い便がブラウザで捨てられていた」**——`stores/ws.ts` に受け取る腕が無く、
 * 型は合い、単体テストは通り、コミットも push も済んでいるのに、**画面には何も
 * 届いていなかった**。人が読んで見つけたが、**これは e2e なら一撃で出る類**である。
 *
 * したがってここで見るのは「値が正しいか」ではなく、**端から端まで繋がっているか**——
 * 擬似 claude が statusLine を吐き、PC 側が読み、便が飛び、ブラウザが受け取り、
 * 画面に出る、という道が1本通っていることである。**途中のどこを切っても落ちる。**
 */

/**
 * statusLine の周期で値が届くまで待つ。
 *
 * e2e の設定は `status_line_refresh_secs = 1` だが、**待つのは周期ではなく状態**。
 * 秒数で待つと、届いたから緑なのか待ち時間で緑なのかが区別できない。
 */
const 届くまで = { timeout: 20_000 }

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('コンテキストのゲージが、擬似 claude の値で動く', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  const ゲージ = page.getByTestId('session-view').getByTestId('ctx-gauge')

  /*
    **まず届くこと。** ここが `false` のままなら、statusLine → 受け口 → 関門 →
    便 → ブラウザの腕、のどこかが切れている。**実装を消しても単体は緑になるので、
    切れていることが分かるのはここだけ。**
  */
  await expect(ゲージ).toBeVisible()
  await expect(ゲージ).toHaveAttribute('data-known', 'true', 届くまで)
  await expect(ゲージ).toContainText('24%', 届くまで)

  /*
    **値が動くこと。** 固定値が1度届くだけなら、関門（値が変わったときだけ配る）が
    素通しでも通ってしまう。**動かして初めて「配る側」が生きていると言える。**
  */
  await typeLine(page, 'context 87')
  await expect(ゲージ).toContainText('87%', 届くまで)
  await expect(ゲージ).toHaveAttribute('data-known', 'true')

  /*
    **消えること。** 起こした直後と `/compact` 直後は**割合が `null` で届く**（フェーズ0 で実測）。
    **0% と区別できることが要件**なので、器は出したまま中身だけが落ちる形を見る。
  */
  await typeLine(page, 'context none')
  await expect(ゲージ).toHaveAttribute('data-known', 'false', 届くまで)
  await expect(ゲージ).toContainText('—')
  await expect(ゲージ).toBeVisible()
})

test('/context の長い報告が絵で出て、原文は畳まれたまま残る', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'synthetic/context-usage/session.jsonl')
  await showTranscript(page)

  await expect
    .poll(
      async () =>
        Number(await page.getByTestId('transcript-status').getAttribute('data-row-count')),
      { message: '履歴が届くこと', timeout: 30_000 },
    )
    .toBeGreaterThan(0)

  /*
    **絵が出ること。** 分類（`machineMessage`）と読み取り（`contextReport`）は
    それぞれ単体で落ちるが、**2つが緑でも `head` へ差す配線が抜けていれば画面には
    何も出ない**。繋がりを見られるのはここだけである。
  */
  const 絵 = page.getByTestId('context-usage-card')
  await expect(絵).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('context-usage-categories')).toBeVisible()

  /*
    **原文は捨てていない。畳んであるだけ**（要件の段1）。

    末尾の3表（MCP ツール・カスタムエージェント・スキル）が**12KB の正体**なので、
    畳まれている間は出ず、開くと出ることを1本で見る。**「出ない」だけを見ると、
    原文ごと捨てる実装でも通ってしまう。**
  */
  const 行 = page
    .locator('[data-testid="transcript-row"][data-foldable="true"]')
    .first()
  await expect(行).toHaveAttribute('data-body-open', 'false')
  await expect(行).not.toContainText('example-skill-10')

  await 行.getByTestId('body-toggle').click()
  await expect(行).toHaveAttribute('data-body-open', 'true')
  await expect(行).toContainText('example-skill-10')
})
