import { expect, test, type Page } from '@playwright/test'
import {
  archiveAll,
  attachImage,
  openDashboard,
  openSession,
  spawnSession,
} from './helpers'

/**
 * 版が切り替わったら、タブが自分で読み直す。
 *
 * 検知（`stores/auth.ts`）・台帳（`lib/composerBusy.ts`）・分岐（`App.tsx`）は、それぞれ
 * 単体テストが見ている。**ここでしか見られないのは輪の閉じ方**である——線が切れて繋ぎ直り、
 * `/api/me` を聞き直して印が立ち、**本物の `location.reload()` が走り**、新しいページが
 * また `/api/me` を取り直して**今度は印を立てない**（一度きり）。jsdom は
 * `location.reload()` を実装していないので、この輪は単体では1本も通らない。
 *
 * **実ブラウザの読み直しが `pagehide` を飛ばして書きかけを守る**ことも、ここでしか見られない
 * （`lib/drafts.ts` は打鍵を 300ms でまとめ、`pagehide` で確定させる）。
 *
 * # なぜ `handover.spec.ts` に足さないのか
 *
 * あちらは本当に版を乗り換えるが、**乗り換え先が自分自身の複製**なので
 * `env!("CARGO_PKG_VERSION")` が同じ値を返す——**版が変わらないので印が原理的に立たない**。
 * しかも `chromium-handover` は `make e2e` からも CI からも走らない（`package.json` の
 * `e2e` は3つの project しか名指ししていない）。**そこへ置くと、立たないうえに誰も
 * 走らせないテストになる。**
 *
 * ここは既定の `chromium` project に載る（`playwright.config.ts` の `testIgnore` に
 * 引っかからない綴り）ので、`make e2e` で毎回走る。
 */

/** 差し替えて名乗らせる版。実物とぶつからない値にしてある。 */
const 新しい版 = '99.99.99-e2e'

/**
 * 以後の `GET /api/me` に、違う版を名乗らせる。
 *
 * **実サーバの応答を取ってから `version` だけ差し替える**（`route.fetch()`）。`mode` や
 * `setup_open` を手で書くと、構成が変わったときに嘘の応答を返し続けることになり、
 * `openDashboard()` が「ログイン画面か一覧か」で待ち続けて落ちる。
 *
 * **`openDashboard()` のあとに入れること。** 初回は素通しで実物の版を覚えさせ、以後だけ
 * 差し替える——`load()` は「一度でも版を知っていて、それが変わったら」印を立てるので、
 * 最初から差し替えていると比べる相手が無く、いつまでも立たない。
 */
async function 版を差し替える(page: Page) {
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    await route.fulfill({
      response,
      json: { ...body, version: 名乗る版 },
    })
  })
}

/**
 * いま名乗っている版。**書き換えると、次の `/api/me` から新しい版になる。**
 *
 * 「見送ったあと、次の版で試し直す」を通すのに要る——版を2回変える必要があり、
 * 定数のままでは1回しか作れない。
 */
let 名乗る版 = 新しい版

/**
 * ページの中で作られた WebSocket を控えて、あとから落とせるようにする。
 *
 * **`page.goto` より前に呼ぶこと**（`addInitScript` は次の読み込みから効く）。
 *
 * `extends` で包むのは、`stores/ws.ts` が `WebSocket.CLOSED` を、`helpers.ts` の
 * `watchSentFrames` が `WebSocket.prototype.send` を触るためである——静的なものも
 * prototype も、継承なら素通しで残る。
 */
async function 線を控える(page: Page) {
  await page.addInitScript(() => {
    const 箱: WebSocket[] = []
    ;(window as unknown as { __sockets: WebSocket[] }).__sockets = 箱
    const 元 = window.WebSocket
    class 見張り付き extends 元 {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args)
        箱.push(this)
      }
    }
    window.WebSocket = 見張り付き as unknown as typeof WebSocket
  })
}

/**
 * いちばん新しい線を落とす。
 *
 * 自分から切ったことにはならない（`closedByUs` が立つのは `disconnect()` のときだけ）
 * ので、`stores/ws.ts` は 500ms 後に繋ぎ直し、`onopen` が `/api/me` を聞き直す。
 */
async function 線を落とす(page: Page) {
  await page.evaluate(() => {
    const 箱 = (window as unknown as { __sockets?: WebSocket[] }).__sockets
    箱?.at(-1)?.close()
  })
}

test.beforeEach(() => {
  名乗る版 = 新しい版
})

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('版が変わると、押さずに読み直す', async ({ page }) => {
  await 線を控える(page)
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // 書きかけを置く。**読み直しても残ること**が、この工事の前提そのもの
  const 書きかけ = 'あとで続きを書く'
  await page.getByTestId('composer-input').fill(書きかけ)

  let 読み直した = 0
  page.on('load', () => {
    読み直した += 1
  })
  await 版を差し替える(page)

  // 落とす**前**に待ち受けを作る（読み直しが速いと取り逃がす）
  const 読み直しを待つ = page.waitForEvent('load', { timeout: 30_000 })
  await 線を落とす(page)
  await 読み直しを待つ

  await expect(page.getByTestId('connection-status')).toHaveAttribute(
    'data-status',
    'open',
    { timeout: 30_000 },
  )
  // **輪になっていない。** 読み直した先では版を知らない状態から始まるので、印は立たない
  await expect(page.getByTestId('server-changed-banner')).toHaveCount(0)
  expect(読み直した).toBe(1)
  // **書きかけは残る**（`lib/drafts.ts` が `pagehide` で書き切る）。jsdom では
  // `location.reload()` が動かないので、これを確かめられるのはここだけ
  await expect(page.getByTestId('composer-input')).toHaveValue(書きかけ)
})

test('添付を抱えたタブは読み直さず、バナーを出す', async ({ page }) => {
  await 線を控える(page)
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await attachImage(page)
  await expect(page.getByTestId('composer-attachments')).toBeVisible()

  let 読み直した = 0
  page.on('load', () => {
    読み直した += 1
  })
  await 版を差し替える(page)
  await 線を落とす(page)

  // **バナーが見えた時点で、判定はもう済んでいる**（効果はバナーを描くのと同じ
  // commit で走る）ので、待ち時間を勘で置く必要が無い
  await expect(page.getByTestId('server-changed-banner')).toBeVisible({
    timeout: 30_000,
  })
  expect(読み直した).toBe(0)
  await expect(page.getByTestId('composer-attachments')).toBeVisible()

  // 抱えているタブにとっては、これが唯一の道。**人の手は生きている**
  const 読み直しを待つ = page.waitForEvent('load', { timeout: 30_000 })
  await page.getByRole('button', { name: '読み込み直す' }).click()
  await 読み直しを待つ
  expect(読み直した).toBe(1)
})

/**
 * **いちばん重い1本**（設計§17）。印は掛け金で降りないので、依存が `[serverChanged]`
 * だけだと**そのタブの一生で1回しか試さない**——1回目が抱えていて塞がれると、以後
 * どれだけ版が変わっても二度と読み直さなかった。実機で不発だったのがこの形である。
 *
 * 単体（`App.test.tsx`）はストアへ直に値を置いて同じことを見ているが、**ここは
 * 本物の線が切れて繋ぎ直り、`/api/me` を2回聞き直す経路**を通る。
 */
test('見送ったあと、添付を外して次の版が来ると読み直す', async ({ page }) => {
  await 線を控える(page)
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await attachImage(page)
  await expect(page.getByTestId('composer-attachments')).toBeVisible()

  let 読み直した = 0
  page.on('load', () => {
    読み直した += 1
  })

  // 1回目：抱えているので見送る。**理由が画面に出る**
  await 版を差し替える(page)
  await 線を落とす(page)
  const banner = page.getByTestId('server-changed-banner')
  await expect(banner).toBeVisible({ timeout: 30_000 })
  await expect(banner).toContainText('添付')
  expect(読み直した).toBe(0)

  // 添付を外す。**ここでは読み直さない**——添付の増減では走らせない（§6）
  await page.getByTestId('composer-attachment-remove').click()
  await expect(page.getByTestId('composer-attachments')).toHaveCount(0)
  expect(読み直した).toBe(0)

  // 2回目：次の版が来たら試し直す
  名乗る版 = '99.99.100-e2e'
  const 読み直しを待つ = page.waitForEvent('load', { timeout: 30_000 })
  await 線を落とす(page)
  await 読み直しを待つ

  expect(読み直した).toBe(1)
  await expect(page.getByTestId('connection-status')).toHaveAttribute(
    'data-status',
    'open',
    { timeout: 30_000 },
  )
})
