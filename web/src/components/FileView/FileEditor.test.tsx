import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WRITE_DEBOUNCE_MS } from '@/lib/drafts'

import { FileEditor, PAINT_LIMIT } from './FileEditor'

const 色付け = vi.hoisted(() => vi.fn(async () => null))
vi.mock('@/lib/highlight', () => ({ tokenizeFile: 色付け }))

function 出す(上書き: Partial<Parameters<typeof FileEditor>[0]> = {}) {
  const props = {
    value: 'あ\nい\nう',
    onChange: vi.fn(),
    onSave: vi.fn(),
    保存できる: true,
    path: '/dev/app/計画.ts',
    ラベル: '計画.ts を編集',
    ...上書き,
  }
  render(<FileEditor {...props} />)
  return props
}

beforeEach(() => {
  色付け.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('器から大きさを取る', () => {
  it('打つ層は印を持ち、大きさを直書きしていない', () => {
    出す()
    const 欄 = screen.getByTestId('file-editor')
    expect(欄.className).toContain('file-editor')
    for (const 綴り of ['text-sm', 'text-xs', 'leading-relaxed', 'max-w-full', 'h-auto']) {
      expect(欄.className).not.toContain(綴り)
    }
  })

  it('3層が1つの器の中に在る', () => {
    // **器へ1回だけ組版を書き、3層は継承で受け取る**（設計§6-2）。
    // 層が器の外に出ると継承が切れ、ずれがカーソル位置に出る
    出す()
    const 器 = screen.getByTestId('file-editor').parentElement
    expect(器?.className).toContain('file-editor-stack')
    expect(器?.querySelector('.file-editor-gutter')).not.toBeNull()
    expect(器?.querySelector('.file-editor-paint')).not.toBeNull()
  })

  it('3層のどれも、自分で大きさを持たない', () => {
    // **ここが要点。** 1層でも自前の大きさを持つと、器の変数を変えたときに
    // その層だけ動かず、**ずれがカーソル位置に出る**（設計§6-2）。
    // クラスの有無だけを見ていると、直書きされても緑のままになる
    出す()
    const 器 = screen.getByTestId('file-editor').parentElement as HTMLElement
    for (const 綴り of ['.file-editor', '.file-editor-paint', '.file-editor-gutter']) {
      const 層 = 器.querySelector(綴り) as HTMLElement
      expect(層, `${綴り} が器の中に無い`).not.toBeNull()
      expect(層.style.fontSize, `${綴り} が自分で大きさを持っている`).toBe('')
      expect(層.style.lineHeight, `${綴り} が自分で行送りを持っている`).toBe('')
      expect(層.className, `${綴り} に大きさが直書きされている`).not.toMatch(/\btext-(xs|sm|base|lg)\b/)
    }
  })
})

describe('行番号', () => {
  it('行の数だけ出る', () => {
    出す({ value: 'あ\nい\nう' })
    const 番号 = document.querySelector('.file-editor-gutter')
    expect(番号?.textContent).toBe('123')
  })

  it('桁は総行数から決まるので、途中の行で幅が動かない', () => {
    // 999 → 1000 で本文が横へずれないこと（設計§6-5）
    出す({ value: Array.from({ length: 1000 }, (_, i) => String(i)).join('\n') })
    const 番号 = document.querySelector('.file-editor-gutter') as HTMLElement
    expect(番号.style.width).toBe('5ch')
  })

  it('読み上げの対象にしない', () => {
    出す()
    expect(document.querySelector('.file-editor-gutter')?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('Ctrl+S', () => {
  it('保存できるときは保存し、ブラウザの保存ダイアログを止める', () => {
    const props = 出す({ 保存できる: true })
    const 出来事 = fireEvent.keyDown(screen.getByTestId('file-editor'), { key: 's', ctrlKey: true })
    expect(props.onSave).toHaveBeenCalledTimes(1)
    // 止め忘れるとページの保存が始まる
    expect(出来事).toBe(false)
  })

  it('Mac の Cmd+S でも効く', () => {
    const props = 出す({ 保存できる: true })
    fireEvent.keyDown(screen.getByTestId('file-editor'), { key: 's', metaKey: true })
    expect(props.onSave).toHaveBeenCalledTimes(1)
  })

  it('保存できないときは呼ばない。ボタンと同じ述語を読んでいる', () => {
    // **別々に書くと「ボタンは押せないのに鍵盤では保存できる」が起こる**（設計§6-7）
    const props = 出す({ 保存できる: false })
    fireEvent.keyDown(screen.getByTestId('file-editor'), { key: 's', ctrlKey: true })
    expect(props.onSave).not.toHaveBeenCalled()
  })
})

describe('Tab で字下げ', () => {
  it('選択が無ければ、カーソル位置へ足す', () => {
    const props = 出す({ value: 'abc' })
    const 欄 = screen.getByTestId('file-editor') as HTMLTextAreaElement
    欄.setSelectionRange(1, 1)
    fireEvent.keyDown(欄, { key: 'Tab' })
    expect(props.onChange).toHaveBeenCalledWith('a  bc')
  })

  it('Shift+Tab は在れば落とす', () => {
    const props = 出す({ value: '  abc' })
    const 欄 = screen.getByTestId('file-editor') as HTMLTextAreaElement
    欄.setSelectionRange(2, 2)
    fireEvent.keyDown(欄, { key: 'Tab', shiftKey: true })
    expect(props.onChange).toHaveBeenCalledWith('abc')
  })

  it('Tab を奪うので、ブラウザの既定は止まる', () => {
    出す()
    const 欄 = screen.getByTestId('file-editor') as HTMLTextAreaElement
    欄.setSelectionRange(0, 0)
    expect(fireEvent.keyDown(欄, { key: 'Tab' })).toBe(false)
  })
})

describe('Escape の逃げ道', () => {
  it('Escape のあとの Tab は焦点移動に譲る', () => {
    // **奪ったままだと鍵盤だけで画面から出られなくなる**（設計§6-6）
    const props = 出す()
    const 欄 = screen.getByTestId('file-editor') as HTMLTextAreaElement
    欄.setSelectionRange(0, 0)
    fireEvent.keyDown(欄, { key: 'Escape' })
    // 止めない＝ブラウザが次の要素へ移す
    expect(fireEvent.keyDown(欄, { key: 'Tab' })).toBe(true)
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('譲るのは1回だけ。次の Tab はまた字下げになる', () => {
    const props = 出す({ value: 'あ' })
    const 欄 = screen.getByTestId('file-editor') as HTMLTextAreaElement
    欄.setSelectionRange(0, 0)
    fireEvent.keyDown(欄, { key: 'Escape' })
    fireEvent.keyDown(欄, { key: 'Tab' })
    fireEvent.keyDown(欄, { key: 'Tab' })
    expect(props.onChange).toHaveBeenCalledWith('  あ')
  })

  it('Escape は止めない。外側が閉じる道を塞がない', () => {
    出す()
    expect(fireEvent.keyDown(screen.getByTestId('file-editor'), { key: 'Escape' })).toBe(true)
  })

  it('逃げ道を画面に出す。知られていない逃げ道は逃げ道にならない', () => {
    出す()
    expect(screen.getByTestId('file-editor-hint').textContent).toContain('Escape')
  })
})

describe('色付け', () => {
  it('打鍵のたびには走らない。止まってから1回だけ', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <FileEditor
        value="a"
        onChange={vi.fn()}
        onSave={vi.fn()}
        保存できる={false}
        path="/x/a.ts"
        ラベル="a"
      />,
    )
    for (const 次 of ['ab', 'abc', 'abcd']) {
      rerender(
        <FileEditor
          value={次}
          onChange={vi.fn()}
          onSave={vi.fn()}
          保存できる={false}
          path="/x/a.ts"
          ラベル="a"
        />,
      )
      vi.advanceTimersByTime(WRITE_DEBOUNCE_MS - 50)
    }
    expect(色付け).not.toHaveBeenCalled()
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS)
    expect(色付け).toHaveBeenCalledTimes(1)
  })

  it('大きいものは色を付けず、黙らずにそう言う', () => {
    vi.useFakeTimers()
    出す({ value: 'あ'.repeat(PAINT_LIMIT + 1) })
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS * 3)
    expect(色付け).not.toHaveBeenCalled()
    // **黙って色が付かないと、壊れているのと見分けが付かない**
    expect(screen.getByTestId('file-paint-heavy')).toBeInTheDocument()
  })
})
