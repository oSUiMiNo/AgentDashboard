import { deflateSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import {
  archiveAll,
  openDashboard,
  openSession,
  showTranscript,
  spawnSession,
} from './helpers'

/**
 * 添付した画像が、構造化ビューの幅からはみ出していないことを見張る。
 *
 * # なぜ別の spec なのか
 *
 * `transcript.spec.ts` にも横のはみ出しを見る試験があるが、**あちらが読ませる
 * フィクスチャに画像が1枚も無い**ので、`<img>` 固有のはみ出しは素通りしていた。
 * ここは**実際に画像を添えて送る**（`composer-file` → 擬似 claude → 履歴）ので、
 * 添付の経路まで通っている。
 *
 * # 細い画像では素通りする
 *
 * `max-width` に当たるのは**入れ物より広い画像**だけである。1×1 の PNG では
 * 何も起きないので、**わざと横に広い絵を組んで**送る。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

/** 横に広い PNG。**細い画像では `max-w-full` に当たらない。** */
function png(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const at = y * (1 + width * 3)
    raw[at] = 0
    for (let x = 0; x < width; x += 1) {
      raw[at + 1 + x * 3] = 0x80
      raw[at + 2 + x * 3] = 0x40
      raw[at + 3 + x * 3] = 0xc0
    }
  }
  const idat = deflateSync(raw)

  const table: number[] = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const head = Buffer.concat([Buffer.from(type, 'ascii'), body])
    let crc = 0xffffffff
    for (const b of head) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8)
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([len, head, crcBuf])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('横に広い画像を添えても、構造化ビューは横へはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await page
    .getByTestId('composer-file')
    .setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: png(1600, 200) })
  await page.getByTestId('composer-input').fill('これを見て')
  await page.keyboard.press('Control+Enter')

  await showTranscript(page)
  const img = page.locator('[data-testid="transcript-tree"] img').first()
  await expect(img).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(500)

  const 測り = await page.getByTestId('transcript-tree').evaluate((el) => {
    const image = el.querySelector('img')
    const 親 = image?.parentElement
    return {
      横のはみ出し: el.scrollWidth - el.clientWidth,
      窓: el.clientWidth,
      画像の幅: image ? Math.round(image.getBoundingClientRect().width) : null,
      画像の右端: image ? Math.round(image.getBoundingClientRect().right) : null,
      親の右端: 親 ? Math.round(親.getBoundingClientRect().right) : null,
    }
  })
  console.log('測り', JSON.stringify(測り))

  expect(測り.横のはみ出し).toBeLessThanOrEqual(1)
})
