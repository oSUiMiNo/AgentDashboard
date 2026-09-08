import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  fromInnerControl,
  isTextEntry,
  suppressesAutoscroll,
  wantsNewTab,
  wantsNewTabByKey,
  type PressLike,
} from './openInNewTab'

/**
 * 「新しいタブで開く」かどうかの規則
 * （イシュー `カードと枠を、中クリックで新しいタブに開く` テスト計画フェーズ1）。
 *
 * **ここは純関数だけ**なので、jsdom が何を返すかに左右されない。**配線されたときに
 * どう振る舞うか**は `usePress` を通す側（`SessionTile` / `ProjectGroup` のテスト）が見る
 * ——押し分けと同じ場所に置いてあるので、そちらでしか「開いたうえに選ばれないか」を
 * 確かめられない。
 */

function 押し(
  type: string,
  over: Partial<Omit<PressLike, 'type'>> = {},
): PressLike {
  return {
    type,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  }
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

  it('**Shift だけでは新しいタブにしない。** 新しいウィンドウは自前で実装しない', () => {
    expect(wantsNewTab(押し('click', { shiftKey: true }))).toBe(false)
  })

  it('**Alt だけでも新しいタブにしない。** ブラウザではあれは保存である', () => {
    expect(wantsNewTab(押し('click', { altKey: true }))).toBe(false)
  })

  it('**Ctrl＋Shift＋クリックは弾かない**——ブラウザでもあれは「新しいタブ（前面）」', () => {
    expect(wantsNewTab(押し('click', { ctrlKey: true, shiftKey: true }))).toBe(true)
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

describe('wantsNewTabByKey', () => {
  const キー = (over: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean }> = {}) => ({
    key: 'Enter',
    ctrlKey: false,
    metaKey: false,
    ...over,
  })

  it('Ctrl＋Enter は新しいタブ', () => {
    expect(wantsNewTabByKey(キー({ ctrlKey: true }))).toBe(true)
  })

  it('Cmd＋Enter も新しいタブ', () => {
    expect(wantsNewTabByKey(キー({ metaKey: true }))).toBe(true)
  })

  it('素の Enter は今までどおり——いまのタブで開く', () => {
    expect(wantsNewTabByKey(キー())).toBe(false)
  })

  it('Ctrl＋Space は関係ない', () => {
    expect(wantsNewTabByKey(キー({ key: ' ', ctrlKey: true }))).toBe(false)
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

describe('isTextEntry', () => {
  it('入力欄の中は真——**Linux の中クリック貼り付けを殺さない**', () => {
    render(<input data-testid="field" defaultValue="" />)
    expect(isTextEntry(screen.getByTestId('field'))).toBe(true)
  })

  it('`contenteditable` の中も真', () => {
    render(
      <div contentEditable data-testid="rich" suppressContentEditableWarning>
        <span data-testid="inner">字</span>
      </div>,
    )
    expect(isTextEntry(screen.getByTestId('inner'))).toBe(true)
  })

  it('ただの箱は偽', () => {
    render(<div data-testid="body">地</div>)
    expect(isTextEntry(screen.getByTestId('body'))).toBe(false)
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
