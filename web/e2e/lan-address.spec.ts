import { expect, test } from '@playwright/test'
import { openDashboard } from './helpers'

/**
 * LAN のアドレスを押すだけで手に入れる（テスト計画フェーズ4）。
 *
 * # ここでしか確かめられないこと
 *
 * 単体（`src/components/LanAddress/LanAddressButton.test.tsx`）が言えるのは
 * 「そう書いてある」ことまでである。**jsdom は `document.execCommand` を持たない**ので、
 * あちらでは必ず「写せなかった」側へ落ちる——**本当にクリップボードへ入るかは、
 * 実物のブラウザでしか言えない。**
 *
 * # 待ち受けは広げられない
 *
 * E2E の `config.toml` は `bind_addr` を書いていないので既定の `127.0.0.1` になり、
 * サーバは `reachable: false` を返す。**広げるには合言葉の登録が要り**
 * （`auth::ensure_lan_password` が無いと起動を拒む）、入れると**他の spec が全部
 * ログイン画面に当たる。**
 *
 * だから widen した構成は作らず、**答えだけ差し替える**。確かめたいのは
 * 「サーバがこう答えたときブラウザがどう振る舞うか」であって、サーバが番号を
 * 数え上げる部分は `server-core` の単体テストが実機の出力で見ている。
 */

/** サーバがこう答えたことにする。**候補を数える部分はここでは測らない。** */
async function 答えを差し替える(
  page: import('@playwright/test').Page,
  view: Record<string, unknown>,
) {
  await page.route('**/api/lan-address', async (route) => {
    await route.fulfill({ json: view })
  })
}

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test('広げていない構成では、ボタンの代わりに案内が出る', async ({ page }) => {
  /*
    **差し替えない。** ここは E2E の既定の構成（`bind_addr` 未指定＝`127.0.0.1`）が
    そのまま材料になる——**押しても死んだアドレスしか渡らないボタンを置かない**
    （設計§8-3）。
  */
  await openDashboard(page)

  await expect(page.getByTestId('lan-address-unreachable')).toBeVisible()
  await expect(page.getByTestId('lan-address-copy')).toHaveCount(0)
})

test('ヘッダのボタンが見えていて、押すとそのまま貼れる形が入る', async ({
  page,
}) => {
  await 答えを差し替える(page, {
    port: 8787,
    bind_addr: '0.0.0.0',
    reachable: true,
    candidates: [{ addr: '192.168.0.12', label: 'Wi-Fi', source: 'windows' }],
    note: null,
  })
  await openDashboard(page)

  const 押す = page.getByTestId('lan-address-copy')
  await expect(押す).toBeVisible()
  await expect(押す).toBeEnabled()

  await 押す.click()

  const 入った = await page.evaluate(() => navigator.clipboard.readText())
  /*
    **`http://` から始まり、末尾が `/` で終わる**（設計§3）。裸の
    `192.168.0.12:8787` だと、Discord がリンクとして認識せず**タップできない**。
  */
  expect(入った).toBe('http://192.168.0.12:8787/')
  expect(入った.startsWith('http://')).toBe(true)
  expect(入った.endsWith('/')).toBe(true)

  // **押したことが分かる。** 黙って何も起きないのが最悪（設計§8-4）
  await expect(page.getByTestId('lan-address-state')).toContainText('合言葉')
})

test('ループバックで開いていると、いま開いているアドレスは候補に入らない', async ({
  page,
}) => {
  /*
    E2E は `127.0.0.1` で開くので、**この端末の origin は配っても意味が無い**
    （相手の手元を指すだけ・設計§4-6）。サーバの推定だけが候補に残る。

    **実機ではここが逆になる**——LAN の端末から開けば origin が先頭に来る。
    そちらは【要人間】の項目（テスト計画フェーズ5）が受け持つ。
  */
  await 答えを差し替える(page, {
    port: 8787,
    bind_addr: '0.0.0.0',
    reachable: true,
    candidates: [{ addr: '192.168.0.12', label: 'Wi-Fi', source: 'windows' }],
    note: null,
  })
  await openDashboard(page)

  // 候補が1本しか無い＝origin が足されていない
  await expect(page.getByTestId('lan-address-more')).toHaveCount(0)

  await page.getByTestId('lan-address-copy').click()
  const 入った = await page.evaluate(() => navigator.clipboard.readText())
  expect(入った).toBe('http://192.168.0.12:8787/')
})
