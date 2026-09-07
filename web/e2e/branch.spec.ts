import { expect, test } from '@playwright/test'
import {
  addProject,
  archiveAll,
  fireHook,
  openDashboard,
  openSession,
  spawnSession,
  typeLine,
  WORK_DIR,
} from './helpers'

/**
 * 枝分かれ（ブランチ設計§7。テスト計画フェーズ5）。
 *
 * **実物のブラウザでしか見られないものに絞る。** jsdom は配置も色の解決もしないので、
 * 「PJT 専用画面にだけ出る」「押している間は押せない」「元がその場に残り枝が右隣へ入る」は
 * ここでしか通しで確かめられない。
 *
 * 相手は擬似 claude なので課金しない。**擬似は `/branch` を教えてある**（フェーズ1）
 * ——受け取ると名乗る CLI 側のIDだけを張り替え、席はそのまま生き続ける。
 */

/**
 * 枠の宛先を控える。**一覧に居るうちに呼ぶこと**——セッション専用画面には枠が
 * 描かれていないので、あちらから引くと空の枠を掴む（実際に踏んだ）。
 */
async function 枠を控える(page: import('@playwright/test').Page) {
  const group = await addProject(page, WORK_DIR)
  return {
    host: (await group.getAttribute('data-host')) ?? '',
    project: (await group.getAttribute('data-project')) ?? '',
  }
}

/** 控えた宛先で PJT 専用画面を開く。 */
async function PJT専用画面へ(
  page: import('@playwright/test').Page,
  枠: { host: string; project: string },
) {
  await page.goto(`/p/${encodeURIComponent(枠.host)}/${encodeURIComponent(枠.project)}`)
}

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('横並びから押すと、元はその場に残り枝が右隣へ入る', async ({ page }) => {
  /*
    **枠に2枚居る状態で確かめる。** 1枚しか無いと**どこへ置いても隣り合う**ので、
    位置のずれが露出しない——実際、その形で緑のまま出したものが実機で外れた
    （2026-09-06。2枚とも右端へ動き、左右も逆だった）。
  */
  await openDashboard(page)
  // **枝分かれする席を先に起こす。** 新しいカードは枠の先頭へ入る（項目13）ので、
  // あとから起こした先客がその左へ回る。**枝分かれする席が先頭だと**「いつも先頭へ
  // 寄せる」実装でも通ってしまい、席を基準にしていることを確かめられない
  const tile = await spawnSession(page)
  const cardId = await tile.getAttribute('data-card-id')
  const 先客 = await spawnSession(page)
  const 先客Id = await 先客.getAttribute('data-card-id')
  const 枠 = await 枠を控える(page)

  // 入力待ちへ倒す。**起動直後は押せない**（§3-4）ので、ここを飛ばすと断られる。
  // **応答も載せる**——本物の CLI は1ターンも会話していない席の `/branch` を断るので、
  // 段取り役も送る前に断る（`No conversation to branch`。2026-09-05 実測）
  await openSession(page, tile)
  await fireHook(page, 'Stop', '{"last_assistant_message":"はい"}')

  await PJT専用画面へ(page, 枠)
  // **添字ではなく card-id で掴む。** 添字は並び順の変更で静かにずれ、しかも
  // 「押せない別のカードを掴んでいる」という分かりにくい形で落ちる
  const ボタン = page
    .locator(`[data-testid="session-view"][data-card-id="${cardId}"]`)
    .getByTestId('branch-card')
  await expect(ボタン).toBeVisible()
  await expect(ボタン).toBeEnabled({ timeout: 30_000 })
  await ボタン.click()

  // 段取りが終わると区画が3つになる（先客＋枝＋呼び戻した元）
  await expect(page.getByTestId('session-view')).toHaveCount(3, { timeout: 60_000 })

  /*
    **先客・元・枝の順。** 押した席はその場（先客の右）に残り、**枝はその1つ右隣**へ
    入る（§3-3）。**呼び戻した席を基準にしない**——あれは新しいカードなので枠の末尾に
    付き、そこを基準にすると2枚とも右端へ動く。
  */
  const 並び = page.getByTestId('session-view')
  await expect(並び.nth(0)).toHaveAttribute('data-card-id', 先客Id ?? '')
  await expect(並び.nth(2)).toHaveAttribute('data-card-id', cardId ?? '')

  // 枝の側にだけ札が出る（§7-5）
  await expect(並び.nth(2).getByTestId('branch-badge')).toBeVisible()
  await expect(並び.nth(1).getByTestId('branch-badge')).toHaveCount(0)
})

test('呼び戻した元から、続けてもう1本ぶん枝を作れる', async ({ page }) => {
  // **本命の使い方**（利用者のユースケース）：よく育った1本から何本も分け、各セッションが
  // 毎回 PJT 把握にコストを割くのを抑える。
  //
  // **かつてはここで詰まっていた**（2026-09-06）。門が `last_assistant_message` だけを
  // 見ており、**呼び戻した席はそれを持たない**ので、1本目を作ると2本目が作れなかった。
  //
  // **呼び戻した席へ `Stop` を撃たずに押す**のが要点である。撃つと直前の応答が載って
  // しまい、古い門でも通ってしまう——それでは元の壊れ方を捕まえられない。
  await openDashboard(page)
  const tile = await spawnSession(page)
  const 枠 = await 枠を控える(page)

  // 会話を1つ書き残してから入力待ちへ倒す。**呼び戻した席が読むのはこの履歴**である
  await openSession(page, tile)
  await typeLine(page, 'said 把握しました')
  await fireHook(page, 'Stop', '{"last_assistant_message":"把握しました"}')

  await PJT専用画面へ(page, 枠)
  await page.getByTestId('branch-card').first().click()
  await expect(page.getByTestId('session-view')).toHaveCount(2, { timeout: 60_000 })

  // 左が元（その場に残ったほう）。**そこから続けてもう1本**
  const 元 = page.getByTestId('session-view').nth(0)
  const 次の枝 = 元.getByTestId('branch-card')
  await expect(次の枝).toBeEnabled({ timeout: 30_000 })
  await 次の枝.click()

  await expect(page.getByTestId('session-view')).toHaveCount(3, { timeout: 60_000 })
})

test('セッション専用画面には出ない', async ({ page }) => {
  // §7-1。あちらには「右隣」が無いので、押しても置き先が無い
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)
  await fireHook(page, 'Stop', '{"last_assistant_message":"はい"}')

  await expect(page.getByTestId('session-view')).toBeVisible()
  await expect(page.getByTestId('branch-card')).toHaveCount(0)
})

test('作業中でも押せて、待っていると分かる', async ({ page }) => {
  // §3-4（2026-09-07 に覆した）。**割り込んで走っている作業を中止させない**ために、
  // かつては作業中を断っていた。いまは押せて、**サーバがターンの終わりを待ってから撃つ**。
  //
  // 断っていた間は「作業を中止させる」か「押せない」かの二択で、**「いまの作業が
  // 終わったら枝を作る」ができなかった**（利用者の指定）。
  await openDashboard(page)
  const tile = await spawnSession(page)
  const 枠 = await 枠を控える(page)

  // 会話のある席にしてから作業中へ倒す
  await openSession(page, tile)
  await fireHook(page, 'Stop', '{"last_assistant_message":"はい"}')
  await fireHook(page, 'UserPromptSubmit')

  await PJT専用画面へ(page, 枠)
  const ボタン = page.getByTestId('branch-card')
  await expect(ボタン).toBeVisible()
  await expect(ボタン).toBeEnabled({ timeout: 30_000 })
  await ボタン.click()

  // **待っていることが読める**（押したあと何も出ないと、効かなかったのか
  // 待てばよいのかが区別できない）
  const 進行 = page.getByTestId('branch-progress')
  await expect(進行).toBeVisible()
  await expect(進行).toContainText('作業が終わって')
})

test('操作列は、枝分かれを足しても2行のまま', async ({ page }) => {
  // **罠2**（§10-2）。折り返した瞬間に、行数を数えている単体4箇所が落ちる。
  // 実物のブラウザでは**溢れる**という別の壊れ方をしうるので、ここでも見る
  await openDashboard(page)
  await spawnSession(page)
  const 枠 = await 枠を控える(page)
  await PJT専用画面へ(page, 枠)

  const 操作列 = page.getByTestId('session-ops').first()
  await expect(操作列.locator('[data-row]')).toHaveCount(2)

  // 横に溢れていないこと（`flex-wrap` を持たないので、溢れると外へはみ出す）
  const はみ出し = await 操作列.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  )
  expect(はみ出し, '操作列が横へ溢れている').toBeLessThanOrEqual(1)
})
