import { afterEach, describe, expect, it } from 'vitest'
import { edgeOf, installEdgeFades, measureEdge } from './edgeFade'

function 寸法(element: HTMLElement, 中身: number, 見える: number, いま = 0) {
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: 中身 })
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: 見える })
  element.scrollLeft = いま
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('端のぼかし', () => {
  it('続きがある側だけを言い、あふれていなければ何も言わない', () => {
    expect(edgeOf({ scrollLeft: 0, clientWidth: 200, scrollWidth: 600 })).toBe('end')
    expect(edgeOf({ scrollLeft: 100, clientWidth: 200, scrollWidth: 600 })).toBe('both')
    expect(edgeOf({ scrollLeft: 400, clientWidth: 200, scrollWidth: 600 })).toBe('start')
    expect(edgeOf({ scrollLeft: 0, clientWidth: 200, scrollWidth: 200 })).toBeNull()
  })

  it('行番号のあるコードでは、行番号の幅だけぼかし始めをずらす', () => {
    document.body.innerHTML = '<div class="markdown-block-editor"><div class="cm-scroller"><div class="cm-gutters"></div><div class="cm-content"></div></div></div>'
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!
    Object.defineProperty(scroller.querySelector('.cm-gutters')!, 'offsetWidth', { configurable: true, value: 30 })
    寸法(scroller, 800, 300, 120)
    measureEdge(scroller)
    expect(scroller).toHaveAttribute('data-edge', 'both')
    expect(scroller.style.getPropertyValue('--edge-start')).toBe('30px')
    寸法(scroller, 300, 300, 0)
    measureEdge(scroller)
    expect(scroller).not.toHaveAttribute('data-edge')
  })

  it('あとから足されたコードや表にも印を付け、送ると付け直す', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const 止める = installEdgeFades(root)
    root.innerHTML = '<div class="prose-dashboard"><pre><code>長い行</code></pre></div>'
    const code = root.querySelector<HTMLElement>('pre > code')!
    寸法(code, 900, 300, 0)
    await new Promise((done) => requestAnimationFrame(() => done(null)))
    expect(code).toHaveAttribute('data-edge', 'end')
    寸法(code, 900, 300, 600)
    code.dispatchEvent(new Event('scroll'))
    await new Promise((done) => requestAnimationFrame(() => done(null)))
    expect(code).toHaveAttribute('data-edge', 'start')
    止める()
  })
})
