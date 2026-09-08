import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fromInnerControl,
  suppressesAutoscroll,
  useOpenInNewTab,
  wantsNewTab,
  受けたら止める,
} from './openInNewTab'

/**
 * 「新しいタブで開く」の押し方（イシュー `カードと枠を、中クリックで新しいタブに開く`）。
 *
 * **上半分は純関数**なので、jsdom が何を返すかに関係なく確かめられる。下半分（フック）は
 * `window.open` を差し替えて、**何が渡ったか**と**後ろの押し分けが走らないか**を見る。
 *
 * **新しいタブが本当に開くかは、ここでは言えない**（E2E の仕事）。
 */

/**
 * 中クリックを撃つ。
 *
 * **`fireEvent.auxClick` はこの版の testing-library に無い**ので、素の `MouseEvent` を
 * 作って投げる。React 19 は `onAuxClick` を native の `auxclick` に繋いでいる。
 */
function 中クリック(element: Element, button = 1): boolean {
  return fireEvent(
    element,
    new MouseEvent('auxclick', { bubbles: true, cancelable: true, button }),
  )
}

function 押し(type: string, over: Partial<{ button: number; ctrlKey: boolean; metaKey: boolean }> = {}) {
  return { type, button: 0, ctrlKey: false, metaKey: false, ...over }
}

describe('wantsNewTab', () => {
  it('中クリック（auxclick の button 1）は新しいタブ', () => {
    expect(wantsNewTab(押し('auxclick', { button: 1 }))).toBe(true)
  })

  it('Ctrl＋左クリックは新しいタブ', () => {
    expect(wantsNewTab(押し('click', { ctrlKey: true }))).toBe(true)
  })

  it('Cmd＋左クリック（Mac）も新しいタブ', () => {
    expect(wantsNewTab(押し('click', { metaKey: true }))).toBe(true)
  })

  it('素のクリックは新しいタブにしない——既存の押し分けへ渡す', () => {
    expect(wantsNewTab(押し('click'))).toBe(false)
  })

  it('Shift だけでは新しいタブにしない。**Shift は取らないと決めた**', () => {
    // `shiftKey` は判定に渡していないので、素のクリックと同じ扱いになる
    expect(wantsNewTab(押し('click'))).toBe(false)
  })

  it('右ボタンの auxclick は新しいタブにしない', () => {
    expect(wantsNewTab(押し('auxclick', { button: 2 }))).toBe(false)
  })

  it('click で button 1 が来ても受けない。**入口は auxclick 1つ**——両方拾うと2枚開く', () => {
    expect(wantsNewTab(押し('click', { button: 1 }))).toBe(false)
  })

  it('修飾キー付きでも、左ボタンでなければ受けない', () => {
    expect(wantsNewTab(押し('click', { button: 2, ctrlKey: true }))).toBe(false)
  })
})

describe('fromInnerControl', () => {
  it('data-no-grab の中から出た合図は弾く', () => {
    render(
      <div data-testid="body">
        <span data-no-grab="">
          <b data-testid="inner">中</b>
        </span>
      </div>,
    )
    expect(fromInnerControl(screen.getByTestId('inner'))).toBe(true)
  })

  it('本体そのものは弾かない', () => {
    render(<div data-testid="body">地</div>)
    expect(fromInnerControl(screen.getByTestId('body'))).toBe(false)
  })

  it('要素でないものは弾かない', () => {
    expect(fromInnerControl(null)).toBe(false)
  })
})

describe('suppressesAutoscroll', () => {
  it('中ボタンの mousedown は止める', () => {
    expect(suppressesAutoscroll(押し('mousedown', { button: 1 }))).toBe(true)
  })

  it('主ボタンの mousedown は止めない。**止めると焦点が動かなくなる**', () => {
    expect(suppressesAutoscroll(押し('mousedown', { button: 0 }))).toBe(false)
  })

  it('mousedown 以外は止めない', () => {
    expect(suppressesAutoscroll(押し('auxclick', { button: 1 }))).toBe(false)
  })
})

describe('受けたら止める', () => {
  it('受けたら、後ろを1つも走らせない', () => {
    const 後ろ = vi.fn()
    受けたら止める(
      () => true,
      後ろ,
    )(null)
    expect(後ろ).not.toHaveBeenCalled()
  })

  it('受けなければ、後ろを順に走らせる', () => {
    const 順 : string[] = []
    受けたら止める(
      () => false,
      () => 順.push('1'),
      undefined,
      () => 順.push('2'),
    )(null)
    expect(順).toEqual(['1', '2'])
  })
})

/**
 * フック側。**`window.open` を差し替えて、渡った引数を見る。**
 *
 * 器を英字で名づけているのは `oxlint` の `rules-of-hooks` が名前の1文字目で判定するため
 * （`useGrip.test.tsx` と同じ理由）。
 */
function 置く(path = '/s/card-1') {
  const 押し分け = vi.fn()
  function Harness() {
    const 新しいタブ = useOpenInNewTab(path)
    return (
      <div
        data-testid="body"
        onClick={受けたら止める(新しいタブ.onClick, 押し分け)}
        onAuxClick={新しいタブ.onAuxClick}
        onMouseDown={新しいタブ.onMouseDown}
      >
        <button type="button" data-testid="inner" data-no-grab="">
          中のボタン
        </button>
      </div>
    )
  }
  render(<Harness />)
  return { 押し分け, 本体: screen.getByTestId('body'), 中: screen.getByTestId('inner') }
}

describe('useOpenInNewTab', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('中クリックで、行き先を noopener 付きの新しいタブに開く', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { 本体 } = 置く('/s/card-1')
    中クリック(本体)
    expect(open).toHaveBeenCalledWith('/s/card-1', '_blank', 'noopener')
  })

  it('Ctrl＋左クリックでも開く', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { 本体 } = 置く('/p/local/x')
    fireEvent.click(本体, { button: 0, ctrlKey: true })
    expect(open).toHaveBeenCalledWith('/p/local/x', '_blank', 'noopener')
  })

  it('**受けたら、後ろの押し分けが走らない**——開いたうえに選ばれるのを防ぐ', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const { 本体, 押し分け } = 置く()
    fireEvent.click(本体, { button: 0, ctrlKey: true })
    expect(押し分け).not.toHaveBeenCalled()
  })

  it('素のクリックは、後ろの押し分けへそのまま渡す', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { 本体, 押し分け } = 置く()
    fireEvent.click(本体)
    expect(open).not.toHaveBeenCalled()
    expect(押し分け).toHaveBeenCalledTimes(1)
  })

  it('器の中の押せるものを中クリックしても開かない', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { 中 } = 置く()
    中クリック(中)
    expect(open).not.toHaveBeenCalled()
  })

  it('受けたら、泡立ちを止める', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const 親 = vi.fn()
    function Harness() {
      const 新しいタブ = useOpenInNewTab('/s/card-1')
      return (
        <div onAuxClick={親}>
          <div data-testid="body" onAuxClick={新しいタブ.onAuxClick} />
        </div>
      )
    }
    render(<Harness />)
    中クリック(screen.getByTestId('body'))
    expect(親).not.toHaveBeenCalled()
  })

  it('受けなければ、泡立ちを止めない', () => {
    const 親 = vi.fn()
    function Harness() {
      const 新しいタブ = useOpenInNewTab('/s/card-1')
      return (
        <div onAuxClick={親}>
          <div data-testid="body" onAuxClick={新しいタブ.onAuxClick} />
        </div>
      )
    }
    render(<Harness />)
    中クリック(screen.getByTestId('body'), 2)
    expect(親).toHaveBeenCalledTimes(1)
  })

  it('中ボタンの mousedown で、ブラウザの自動スクロールを止める', () => {
    const { 本体 } = 置く()
    const down = fireEvent.mouseDown(本体, { button: 1 })
    // `fireEvent` は「既定の動作が残ったか」を返す。止めていれば偽
    expect(down).toBe(false)
  })

  it('主ボタンの mousedown は止めない', () => {
    const { 本体 } = 置く()
    expect(fireEvent.mouseDown(本体, { button: 0 })).toBe(true)
  })
})
