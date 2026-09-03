import { expect, type Locator, type Page } from '@playwright/test'

/**
 * 並べ替えの手触りを測るための助け（並べ替え設計§15-9）。
 *
 * **`*.spec.ts` ではないので Playwright は拾わない**（`helpers.ts` と同じ扱い）。
 * `web/e2e` は `tsc -b` の外なので、書いたら走らせて確かめること。
 */

export interface XY {
  x: number
  y: number
}

/** 1フレーム待つ。**`mouse.move` を束ねさせないため**（設計§15-9「踏むと緑になる形」①） */
export async function 一フレーム待つ(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  )
}

/** 矩形の中心 */
export async function 中心(target: Locator): Promise<XY> {
  const box = await target.boundingBox()
  if (!box) {
    throw new Error('位置が取れません')
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * 押して、しきい値（3px）を越えて掴む。**離さない。** 戻り値は握り点。
 *
 * 本体を掴む（`move`）のと掴み手を掴む（`press`）のと、どちらにも効く。
 */
export async function 掴む(page: Page, at: XY): Promise<XY> {
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 4, at.y)
  await 一フレーム待つ(page)
  return at
}

/** 点まで、各ステップで1フレーム待ちながら運ぶ。通った点を返す */
export async function フレームごとに運ぶ(
  page: Page,
  from: XY,
  to: XY,
  steps: number,
): Promise<XY[]> {
  const points: XY[] = []
  for (let step = 1; step <= steps; step += 1) {
    const point = {
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
    }
    await page.mouse.move(point.x, point.y)
    await 一フレーム待つ(page)
    points.push(point)
  }
  return points
}

/** 個別プロパティの計算値。`none` は 0／1／0 に読み替える */
export async function 変形を読む(
  target: Locator,
): Promise<{ translate: XY; scale: number; rotate: number }> {
  return target.evaluate((el) => {
    const style = getComputedStyle(el)
    const parse = (value: string): XY => {
      if (value === 'none') return { x: 0, y: 0 }
      const [x, y = '0px'] = value.split(' ')
      return { x: Number.parseFloat(x), y: Number.parseFloat(y) }
    }
    return {
      translate: parse(style.translate),
      scale: style.scale === 'none' ? 1 : Number.parseFloat(style.scale),
      rotate: style.rotate === 'none' ? 0 : Number.parseFloat(style.rotate),
    }
  })
}

/** `style` の書き換えを数え始める。戻り値の名で [`書き換えの数`] が読む */
export async function 書き換えを数え始める(target: Locator, name: string): Promise<void> {
  await target.evaluate((el, key) => {
    const w = window as unknown as { __writes?: Record<string, number> }
    w.__writes ??= {}
    w.__writes[key] = 0
    new MutationObserver((records) => {
      w.__writes![key] += records.length
    }).observe(el, { attributes: true, attributeFilter: ['style'] })
  }, name)
}

export async function 書き換えの数(page: Page, name: string): Promise<number> {
  return page.evaluate(
    (key) => (window as unknown as { __writes: Record<string, number> }).__writes[key] ?? 0,
    name,
  )
}

/** ノードを控えて、`lostpointercapture` を数え始める */
export async function ノードを控える(target: Locator): Promise<void> {
  await target.evaluate((el) => {
    const w = window as unknown as { __node: Element; __lost: number }
    w.__node = el
    w.__lost = 0
    el.addEventListener('lostpointercapture', () => {
      w.__lost += 1
    })
  })
}

/** 控えたノードと同じか、`lostpointercapture` が何回来たか */
export async function ノードの様子(target: Locator): Promise<{ same: boolean; lost: number }> {
  return target.evaluate((el) => {
    const w = window as unknown as { __node: Element; __lost: number }
    return { same: w.__node === el, lost: w.__lost }
  })
}

/**
 * これから n フレームぶん、要素の左上を標本する。**張ってから離すこと。**
 * 戻り値は `[フレーム][要素]` の左上。
 */
export async function 標本を張る(page: Page, selector: string, frames: number): Promise<void> {
  await page.evaluate(
    ({ selector, frames }) => {
      const w = window as unknown as { __samples: { x: number; y: number }[][]; __sampling: Promise<void> }
      w.__samples = []
      w.__sampling = new Promise<void>((resolve) => {
        let left = frames
        const tick = () => {
          const row = [...document.querySelectorAll(selector)].map((el) => {
            const box = el.getBoundingClientRect()
            return { x: box.left, y: box.top }
          })
          w.__samples.push(row)
          left -= 1
          if (left > 0) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
    },
    { selector, frames },
  )
}

export async function 標本を読む(page: Page): Promise<XY[][]> {
  return page.evaluate(async () => {
    const w = window as unknown as { __samples: XY[][]; __sampling: Promise<void> }
    await w.__sampling
    return w.__samples
  })
}

/** その枠の中のカードの並び（カードID） */
export async function カードの並び(group: Locator): Promise<string[]> {
  return group.getByTestId('tile-shell').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-card-id') ?? ''),
  )
}

/** カードを id で引く */
export function カード(page: Page, id: string): Locator {
  return page.locator(`[data-testid="tile-shell"][data-card-id="${id}"]`)
}

/** 差が 1px 以内 */
export function 近い(a: XY, b: XY, tolerance = 1): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
}

/**
 * 入場の動きが終わるまで待つ。**起こした直後の器は `motion` が `style` を書き続ける**ので、
 * 書き換えを数える前・矩形を凍結する前に待つ。
 */
export async function 落ち着くまで待つ(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          [...document.querySelectorAll('[data-testid="tile-shell"]')].reduce(
            (sum, el) => sum + el.getAnimations().length,
            0,
          ),
        ),
      { message: '入場の動きが終わること' },
    )
    .toBe(0)
}

/** これから n フレームぶん、枠の中のカードの並びを標本する。**張ってから離すこと** */
export async function 並びを標本する(page: Page, group: Locator, frames: number): Promise<void> {
  const selector = await group.evaluate((el) => {
    el.setAttribute('data-sampling', '')
    return '[data-sampling] [data-testid="tile-shell"]'
  })
  await page.evaluate(
    ({ selector, frames }) => {
      const w = window as unknown as { __orders: string[][]; __ordering: Promise<void> }
      w.__orders = []
      w.__ordering = new Promise<void>((resolve) => {
        let left = frames
        const tick = () => {
          w.__orders.push(
            [...document.querySelectorAll(selector)].map((el) => el.getAttribute('data-card-id') ?? ''),
          )
          left -= 1
          if (left > 0) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
    },
    { selector, frames },
  )
}

export async function 並びの標本(page: Page): Promise<string[][]> {
  return page.evaluate(async () => {
    const w = window as unknown as { __orders: string[][]; __ordering: Promise<void> }
    await w.__ordering
    return w.__orders
  })
}

export { expect }
