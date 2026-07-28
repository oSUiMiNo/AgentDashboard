// Vitest の共通セットアップ。toBeInTheDocument などの DOM 向けマッチャを有効にする。
import '@testing-library/jest-dom/vitest'

/**
 * jsdom に足りないものを補う。
 *
 * jsdom はレイアウトを持たないので、**要素の大きさが常に 0** で返り、`ResizeObserver`
 * そのものが存在しない。仮想化（TanStack Virtual）は「表示領域の大きさ」から描く行を
 * 決めるため、このままだと 1 行も描かれず、表示の検証ができない。
 *
 * ここで補うのはテスト環境の欠落であって、製品コードの都合ではない。コンポーネント側に
 * テスト専用の分岐を入れずに済ませるため、埋めるのはこの1箇所に閉じている。
 */
const VIEWPORT = { width: 800, height: 600 }
const ROW = 30

// xterm.js は端末を開くときに画面の解像度倍率を `matchMedia` で見る。jsdom には無い
if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof globalThis.matchMedia
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    private readonly callback: ResizeObserverCallback

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }

    observe(target: Element) {
      // 監視を始めた時点で1回知らせる。実ブラウザも初回に必ず1回呼ぶ
      this.callback(
        [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      )
    }

    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

// 大きさを持たせる。スクロール領域は表示領域ぶん、行は1行ぶんの高さを返す
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value(this: HTMLElement): DOMRect {
    const isRow = this.dataset.index !== undefined
    const height = isRow ? ROW : VIEWPORT.height
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: VIEWPORT.width,
      bottom: height,
      width: VIEWPORT.width,
      height,
      toJSON: () => ({}),
    } as DOMRect
  },
})

for (const [property, value] of [
  ['clientWidth', VIEWPORT.width],
  ['clientHeight', VIEWPORT.height],
  ['offsetWidth', VIEWPORT.width],
  ['offsetHeight', VIEWPORT.height],
] as const) {
  Object.defineProperty(HTMLElement.prototype, property, {
    configurable: true,
    get() {
      return value
    },
  })
}
