import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fileSearch from '@/lib/fileSearch'
import type { FileSearchAdapter } from '@/lib/fileSearch'
import { FileFind } from './FileFind'

function setup() {
  const adapter = {
    search: vi.fn((query: string) => query ? 2 : 0),
    show: vi.fn(),
    clear: vi.fn(),
  }
  const props = {
    bodyRef: { current: null },
    searchApiRef: { current: adapter as FileSearchAdapter | null },
    本文: '検索語と検索語',
    contentKey: 'file:viewer:1',
    合図: 1,
    onClose: vi.fn(),
  }
  const rendered = render(<FileFind {...props} />)
  return { ...rendered, props, adapter, input: screen.getByTestId('file-find-input') }
}

function tick(milliseconds = 150) {
  act(() => vi.advanceTimersByTime(milliseconds))
}

function search(input: HTMLElement) {
  fireEvent.change(input, { target: { value: '検索語' } })
  tick()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('FileFindの検索adapter', () => {
  it('150ms待って検索し、件数と移動をadapterへつなぐ', () => {
    const { adapter, input } = setup()
    adapter.search.mockClear()
    fireEvent.change(input, { target: { value: '検索語' } })
    tick(149)
    expect(adapter.search).not.toHaveBeenCalled()
    tick(1)
    expect(adapter.search).toHaveBeenCalledExactlyOnceWith('検索語')
    expect(adapter.show).toHaveBeenLastCalledWith(0)
    expect(screen.getByTestId('file-find-count')).toHaveTextContent('1 / 2')
    expect(input).toHaveFocus()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(adapter.show).toHaveBeenLastCalledWith(1)
    expect(screen.getByTestId('file-find-count')).toHaveTextContent('2 / 2')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(adapter.show).toHaveBeenLastCalledWith(0)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(adapter.show).toHaveBeenLastCalledWith(1)
    expect(input).toHaveFocus()
  })

  it('本文だけ変わり件数とindexが同じでも、待って検索位置を示し直す', () => {
    const { adapter, input, props, rerender } = setup()
    search(input)
    adapter.search.mockClear()
    adapter.show.mockClear()

    rerender(<FileFind {...props} 本文="前置きを追加 検索語と検索語" />)
    tick(149)
    expect(adapter.search).not.toHaveBeenCalled()
    expect(adapter.show).not.toHaveBeenCalled()
    tick(1)
    expect(adapter.search).toHaveBeenCalledExactlyOnceWith('検索語')
    expect(adapter.show).toHaveBeenCalledExactlyOnceWith(0)
    expect(screen.getByTestId('file-find-count')).toHaveTextContent('1 / 2')
  })

  it('作成待ちのrefが埋まったらcontentKeyの更新で探し直す', () => {
    const { adapter, input, props, rerender } = setup()
    props.searchApiRef.current = null
    rerender(<FileFind {...props} contentKey="file:viewer:loading" />)
    search(input)
    expect(screen.getByTestId('file-find-count')).toHaveTextContent('見つかりません')
    adapter.search.mockClear()
    adapter.show.mockClear()

    props.searchApiRef.current = adapter
    rerender(<FileFind {...props} contentKey="file:viewer:ready" />)
    expect(adapter.search).toHaveBeenCalledExactlyOnceWith('検索語')
    expect(adapter.show).toHaveBeenCalledExactlyOnceWith(0)
    expect(screen.getByTestId('file-find-count')).toHaveTextContent('1 / 2')
  })

  it('DOM Range、textarea、iframeの経路を走らせない', () => {
    const domSearch = vi.spyOn(fileSearch, 'findMatches')
    const textSearch = vi.spyOn(fileSearch, 'findTextMatches')
    const paint = vi.spyOn(fileSearch, 'paintMatches')
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    const editor = document.createElement('textarea')
    const selection = vi.spyOn(editor, 'setSelectionRange')
    const { props, input, rerender, unmount } = setup()
    rerender(<FileFind {...props} frameRef={{ current: frame }} editorRef={{ current: editor }} />)
    search(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    unmount()

    expect(domSearch).not.toHaveBeenCalled()
    expect(textSearch).not.toHaveBeenCalled()
    expect(paint).not.toHaveBeenCalled()
    expect(selection).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
    frame.remove()
  })

  it('検索窓を外すとadapterの印を消す', () => {
    const { adapter, input, unmount } = setup()
    search(input)
    adapter.clear.mockClear()
    unmount()
    expect(adapter.clear).toHaveBeenCalledTimes(1)
  })

  it('モード切替ではrefの新しい中身でなく、検索したadapterを消す', () => {
    const { adapter, input, props, rerender } = setup()
    search(input)
    adapter.clear.mockClear()
    const replacement = { search: vi.fn(() => 0), show: vi.fn(), clear: vi.fn() }
    props.searchApiRef.current = replacement
    rerender(<FileFind {...props} searchApiRef={undefined} contentKey="file:source:1" />)
    expect(adapter.clear).toHaveBeenCalledTimes(1)
    expect(replacement.clear).not.toHaveBeenCalled()
  })
})
