import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  archiveAll,
  keyPayload,
  openDashboard,
  spawnSession,
  takeSentFrames,
  watchSentFrames,
  WORK_DIR,
} from './helpers'

/**
 * PJT 専用画面のレールを、マウスで横へ送る（`PJT画面の横スクロールをどこからでも効かせる`
 * テスト計画フェーズ5。作法は `DESIGN.md` §50）。
 *
 * # ここでしか確かめられないこと
 *
 * 単体テストは合成したイベントを作り物の DOM へ当てているので、「**本物のブラウザが
 * どう届けるか**」については何も言っていない。とくに次の3つは、実物でしか分からない。
 *
 * | 確かめたいこと | なぜ単体では分からないか |
 * |---|---|
 * | 端末の上のホイールが外へ抜けるか | xterm が実際に何を購読しているかは、本物の端末を建てないと現れない |
 * | Shift ＋ 縦回しがどう届くか | `deltaX` に入るか `deltaY` ＋ `shiftKey` で来るかは**ブラウザが決める** |
 * | 矢印キーが claude へ飛んでいないか | 送っているのは線の上なので、画面を見ても分からない |
 */

/** 実物のセッションを並べる先。中身が決まっていないと主張が書けない。 */
const PROJECT_DIR = path.join(WORK_DIR, 'adash-e2e-rail-pan')
/** 生テキストの材料。**横に溢れていないと「内側が消費する」を確かめられない** */
const WIDE = '長い行.md'

/**
 * 並べる札の数。**3本。**
 *
 * 窓は 1280、札は1枚 672（`w-[42rem]`）、隙間は 16（`gap-4`）。**2本では
 * 672×2＋16 ＝ 1360 で、溢れが 80px しか無い**——中ドラッグは 150px 動かすので、
 * **端で止まって「動かない」と見分けが付かなくなる**。3本なら 2048 で 768px 溢れる。
 */
const 札の数 = 3

test.beforeAll(() => {
  const docs = path.join(PROJECT_DIR, 'MyDocs')
  fs.mkdirSync(docs, { recursive: true })
  // **折り返さない長さの行**を並べる。生テキストは自分で横へ動く側なので、
  // 動く余地が無いと「内側が消費した」のか「誰も動かなかった」のか言えない
  const 行 = `| ${'長い見出しと値をつないだ列'.repeat(12)} |`
  fs.writeFileSync(path.join(docs, WIDE), `${行}\n`.repeat(40), 'utf8')
})

// **片付けは後ろで行う**（`newtab.spec.ts` と同じ作法）。前で片付けようとすると、
// まだ画面を開いていないので繋がるのを待つところからやり直すことになる
test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

/**
 * 札を3本並べて PJT 専用画面を開き、**レールが実際に溢れていることを確かめて**返す。
 *
 * **溢れの確認を飛ばしてはいけない。** 窓が広い機械では溢れなくなり、
 * **「動かないのが正しい」に化けて全部緑になる**——何も確かめていないテストが、
 * いちばん気づかれにくい形で残る。
 */
async function 三本並べて開く(page: Page): Promise<Locator> {
  await openDashboard(page)
  for (let i = 0; i < 札の数; i += 1) {
    await spawnSession(page, PROJECT_DIR)
  }

  const group = page.locator(
    `[data-testid="project-group"][data-project="${PROJECT_DIR}"]`,
  )
  await group.dblclick({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('group-view')).toBeVisible()
  await expect(page.getByTestId('session-view')).toHaveCount(札の数)

  const rail = page.getByTestId('group-rail')
  const 溢れ = await rail.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(
    溢れ,
    'レールが実際に溢れていること（溢れていないと、動かないのが正しいに化ける）',
  ).toBeGreaterThan(200)
  return rail
}

/** 部品の真ん中で中ボタンを押し、横へ `dx` 動かして離す。 */
async function 中ドラッグ(page: Page, target: Locator, dx: number) {
  const box = await target.boundingBox()
  expect(box, '掴む相手が画面に出ていること').not.toBeNull()
  const x = box!.x + box!.width / 2
  const y = box!.y + box!.height / 2
  // **`down` と `up` を分けて書く**のは `newtab.spec.ts` と同じ作法。
  // **あいだに `move` を挟む**——しきい値は 3px なので、動かさないと掴まない
  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(x + dx, y, { steps: 8 })
  await page.mouse.up({ button: 'middle' })
}

test('端末の上で横へ回すと、レールが動く', async ({ page }) => {
  const rail = await 三本並べて開く(page)
  const 前 = await rail.evaluate((el) => el.scrollLeft)

  // **`hover()` を使う。`click()` は使わない**——あちらは要素を可視域へ運ぶので、
  // **測定そのものがレールを動かす**
  await page.getByTestId('terminal').first().hover()
  await page.mouse.wheel(200, 0)

  await expect
    .poll(async () => rail.evaluate((el) => el.scrollLeft), {
      message: '端末の上の横ホイールが、レールへ届くこと',
    })
    .toBeGreaterThan(前)
})

test('端末の上で横へ回しても、端末の中身は動かない', async ({ page }) => {
  const rail = await 三本並べて開く(page)
  const 端末 = page.getByTestId('terminal').first()
  // 端末は `cols` 固定なので、札の幅では必ず横に溢れている。**渡し損ねると
  // こちらが動く**——それがこのテストの見張っているところ
  const 端末の溢れ = await 端末.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(端末の溢れ, '端末が横に溢れていること').toBeGreaterThan(0)

  const レール前 = await rail.evaluate((el) => el.scrollLeft)
  const 端末前 = await 端末.evaluate((el) => el.scrollLeft)

  await 端末.hover()
  await page.mouse.wheel(200, 0)

  await expect
    .poll(async () => rail.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(レール前)
  expect(
    await 端末.evaluate((el) => el.scrollLeft),
    '端末の中身は1ピクセルも動かないこと（動いたら、外へ渡せていない）',
  ).toBe(端末前)
})

test('Shift ＋ 縦回しでも、レールが動く', async ({ page }) => {
  const rail = await 三本並べて開く(page)
  const 前 = await rail.evaluate((el) => el.scrollLeft)

  // **ブラウザは `deltaX` へ変換して届けない。** `deltaY` ＋ `shiftKey` のまま来て、
  // 既定動作だけが横になる——だから `deltaX` だけを見ていると素通りする
  await page.getByTestId('terminal').first().hover()
  await page.keyboard.down('Shift')
  await page.mouse.wheel(0, 200)
  await page.keyboard.up('Shift')

  await expect
    .poll(async () => rail.evaluate((el) => el.scrollLeft), {
      message: 'Shift ＋ 縦回しも、レールの横送りになること',
    })
    .toBeGreaterThan(前)
})

test('Shift ＋ 縦回しで、claude へ矢印キーが飛ばない', async ({ page }) => {
  /*
    **このテストには前提がある。外すと嘘になる。**

    矢印キーを送る購読は、**スクロールバックがまだ無いあいだだけ**働く。出力が
    溜まると分岐ごと閉じるので、**溜まった端末では塞ぐ側を消しても緑のまま通る**
    ——何も確かめていないテストになる。

    したがって**起こした直後の、何も打っていないセッション**で測ること。
    `say()` や `typeLine()` をここより前で呼んではいけない。**セットアップを
    共通化したくなったら、この段落を読んでから決めること。**
  */
  await watchSentFrames(page)
  const rail = await 三本並べて開く(page)
  const 前 = await rail.evaluate((el) => el.scrollLeft)
  // ここまでに送られたぶんは捨てる。見たいのは、このあとの1回だけ
  await takeSentFrames(page)

  await page.getByTestId('terminal').first().hover()
  await page.keyboard.down('Shift')
  await page.mouse.wheel(0, 200)
  await page.keyboard.up('Shift')

  // **レールが動いたことを先に確かめる。** 動いていなければ、そもそもホイールが
  // 処理されていないので「飛んでいない」と言っても何の意味も無い
  await expect
    .poll(async () => rail.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(前)

  const { keys } = await takeSentFrames(page)
  const 矢印 = keys.filter((key) => {
    const payload = keyPayload(key)
    // `ESC [ A`（上）と `ESC [ B`（下）
    return (
      payload[0] === 0x1b &&
      payload[1] === 0x5b &&
      (payload[2] === 0x41 || payload[2] === 0x42)
    )
  })
  expect(
    矢印,
    '矢印キーが1本も飛んでいないこと（飛ぶと、選択式の質問の答えが勝手に動く）',
  ).toHaveLength(0)
})

test('区画の中で中ドラッグすると、レールが動く', async ({ page }) => {
  const rail = await 三本並べて開く(page)
  const 前 = await rail.evaluate((el) => el.scrollLeft)

  // 左へ送る＝中身を左へ動かす＝`scrollLeft` は増える
  await 中ドラッグ(page, page.getByTestId('terminal').first(), -150)

  await expect
    .poll(async () => rail.evaluate((el) => el.scrollLeft), {
      message: '区画の中の中ドラッグが、レールの横送りになること',
    })
    .toBeGreaterThan(前)
})

test('区画の外では、中ドラッグが効かない', async ({ page }) => {
  const rail = await 三本並べて開く(page)
  const 前 = await rail.evaluate((el) => el.scrollLeft)

  /*
    **札と札のあいだの隙間**を掴む。3本並べても溢れているので画面の中に余白は
    無いが、`gap-4` の 16px は**レールの中で、どの区画にも属さない**——
    「区画の外では効かない」を確かめられる唯一の場所である。
  */
  const 一枚目 = await page.getByTestId('session-view').first().boundingBox()
  expect(一枚目, '札が画面に出ていること').not.toBeNull()
  const x = 一枚目!.x + 一枚目!.width + 8
  const y = 一枚目!.y + 一枚目!.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(x - 150, y, { steps: 8 })
  await page.mouse.up({ button: 'middle' })

  expect(
    await rail.evaluate((el) => el.scrollLeft),
    '区画の外では動かないこと（動いたら、名指しが効いていない）',
  ).toBe(前)
})

test('入力欄の上では、中ドラッグで動かない', async ({ page }) => {
  const rail = await 三本並べて開く(page)
  const 前 = await rail.evaluate((el) => el.scrollLeft)

  // **字を打つ場所では掴まない。** 文字を選ぼうとした操作が横送りに化けると、
  // 選べなくなる。Linux の貼り付けを優先する既決の判断でもある（`DESIGN.md` §50.3）
  await 中ドラッグ(page, page.getByTestId('composer-input').first(), -150)

  expect(
    await rail.evaluate((el) => el.scrollLeft),
    '入力欄の上では動かないこと',
  ).toBe(前)
})

test('生テキストの上では、レールは動かない', async ({ page }) => {
  const rail = await 三本並べて開く(page)

  // 中身の列を開いて、生テキストへ切り替える
  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await panel.getByTestId('folder-entry').filter({ hasText: 'MyDocs' }).click()
  await panel.getByTestId('folder-entry').filter({ hasText: WIDE }).click()
  await expect(page.getByTestId('file-column')).toBeVisible()
  // フォルダを畳む——被さったままだと列の上を押せない
  await page.getByTestId('project-files-toggle').click()
  await expect(panel).toBeHidden()
  // **生テキストの面はエディタへ置き換わった**（`ファイルビュアにエディタ機能を追加`）。
  // **横スクロールを持つ層がこちらへ移っている**ので、見る相手だけを移した——
  // ホイールを回す段と材料はそのまま
  await page.getByTestId('file-toggle-mode').click()

  const pre = page.getByTestId('file-editor')
  await expect(pre).toBeVisible()
  const 生の溢れ = await pre.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(生の溢れ, '生テキストが横に溢れていること').toBeGreaterThan(0)

  const レール前 = await rail.evaluate((el) => el.scrollLeft)
  const 生前 = await pre.evaluate((el) => el.scrollLeft)

  await pre.hover()
  await page.mouse.wheel(200, 0)

  /*
    **内側が先に消費する**のが既定の振る舞いで、ここは手を入れていない。
    レールが**全子孫から奪う**作りにすると、生テキストの続きが読めないまま
    レールが流れる——**それを見張っているのがこのテストである。**

    隣の `project-files.spec.ts` の `生テキストの上では、その中が横へ動く` は
    **内側が動くこと**を見ている。あちらとこちらは向きが逆で、片方だけでは
    塞げない。
  */
  await expect
    .poll(async () => pre.evaluate((el) => el.scrollLeft), {
      message: '生テキストは自分で横へ動くこと',
    })
    .toBeGreaterThan(生前)
  expect(
    await rail.evaluate((el) => el.scrollLeft),
    'レールは動かないこと（動いたら、全子孫から奪っている）',
  ).toBe(レール前)
})
