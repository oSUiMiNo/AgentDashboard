import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, useState } from 'react'
import MarkdownBlockEditor, { type MarkdownEditorHandle } from './MarkdownBlockEditor'
import { MarkdownSource } from '../../lib/fileMarkdown'

function Harness({ source = '# 見出し\n\n本文', readOnly = false }: { source?: string; readOnly?: boolean }) {
  const [value, setValue] = useState(source)
  return <>
    <MarkdownBlockEditor value={value} onChange={setValue} onSave={() => {}} readOnly={readOnly} label="文書を編集" documentKey="doc" />
    <output data-testid="markdown-value">{value}</output>
  </>
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Markdownブロック編集面', () => {
  it('編集基盤を実際に起動して本文を編集可能にする', async () => {
    render(<Harness />)
    const editor = await screen.findByRole('textbox', { name: '文書を編集' })
    expect(editor).toHaveAttribute('contenteditable', 'true')
    expect(editor.querySelector('h1')).toHaveTextContent('見出し')
    expect(editor.querySelector('p')).toHaveTextContent('本文')
    expect(screen.getByTestId('markdown-value')).toHaveTextContent('# 見出し')
  })

  it('普通の段落はその場で入力できる', async () => {
    const user = userEvent.setup()
    render(<Harness source="本文" />)
    const editor = await screen.findByRole('textbox', { name: '文書を編集' })
    await user.click(editor)
    await user.keyboard('追記')
    await waitFor(() => expect(screen.getByTestId('markdown-value').textContent).toContain('追記'))
  })

  it('チェック項目をキーボードから変更してMarkdownへ戻す', async () => {
    const user = userEvent.setup()
    render(<Harness source="- [ ] 未完了" />)
    const checkbox = await screen.findByRole('checkbox', { name: '未完了' })
    checkbox.focus()
    await user.keyboard(' ')
    await waitFor(() => expect(screen.getByTestId('markdown-value').textContent).toMatch(/[-*+] \[x\] 未完了/))
    expect(await screen.findByRole('checkbox', { name: '未完了' })).toBeChecked()
  })

  it('コードの編集面を読み込み、各行を欠落させない', async () => {
    render(<Harness source={'```typescript\nconst text = "一行目"\nconsole.log(text)\n```\n'} />)
    const editor = await screen.findByRole('textbox', { name: '文書を編集' })
    await waitFor(() => expect(Array.from(editor.querySelectorAll('.cm-content .cm-line'), (line) => line.textContent))
      .toEqual(['const text = "一行目"', 'console.log(text)']))
  })

  it('画像の代替テキストとタイトルを数値へ書き換えない', async () => {
    const source = '![景色の説明](https://example.com/photo.png "画像の題")\n\n本文'
    const changed = vi.fn()
    render(<MarkdownBlockEditor value={source} onChange={changed} onSave={() => {}} readOnly={false} label="文書を編集" documentKey="image" />)
    const editor = await screen.findByRole('textbox', { name: '文書を編集' })
    expect(editor.querySelector('.md-source-block')).toBeNull()
    expect(changed).not.toHaveBeenCalled()
  })

  it('操作メニューは日本語でキーボードから開ける', async () => {
    const user = userEvent.setup()
    render(<Harness source="本文" />)
    await screen.findByRole('textbox', { name: '文書を編集' })
    const trigger = screen.getByRole('button', { name: '選択中のブロック操作' })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('menuitem', { name: '複製' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '上へ移動' })).toHaveAttribute('data-disabled')
  })

  it('読み取り専用なら操作群を出さず入力も許可しない', async () => {
    render(<Harness readOnly />)
    const editor = await screen.findByRole('textbox', { name: '文書を編集' })
    expect(editor).toHaveAttribute('contenteditable', 'false')
    expect(screen.queryByRole('button', { name: '選択中のブロック操作' })).toBeNull()
  })

  it('同じ値の通知や非表示への切替で編集DOMを作り直さない', async () => {
    const props = { value: '本文', onChange: vi.fn(), onSave: vi.fn(), readOnly: false, label: '文書を編集', documentKey: 'same' }
    const { rerender } = render(<MarkdownBlockEditor {...props} />)
    const editor = await screen.findByRole('textbox', { name: '文書を編集' })
    rerender(<MarkdownBlockEditor {...props} active={false} />)
    rerender(<MarkdownBlockEditor {...props} active />)
    expect(screen.getByRole('textbox', { name: '文書を編集' })).toBe(editor)
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('別文書へ変えたときだけ内容を読み込み直す', async () => {
    const props = { onChange: vi.fn(), onSave: vi.fn(), readOnly: false, label: '文書を編集' }
    const { rerender } = render(<MarkdownBlockEditor {...props} value="最初" documentKey="one" />)
    await screen.findByRole('textbox', { name: '文書を編集' })
    rerender(<MarkdownBlockEditor {...props} value="次の文書" documentKey="two" />)
    await waitFor(() => expect(screen.getAllByRole('textbox', { name: '文書を編集' })).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '文書を編集' })).toHaveTextContent('次の文書'))
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('ソース再読込が失敗しても古い本文を書き戻さず、修正後に復帰する', async () => {
    const changed = vi.fn()
    const handle = createRef<MarkdownEditorHandle>()
    const props = { onChange: changed, onSave: vi.fn(), readOnly: false, label: '文書を編集', documentKey: 'recover', handleRef: handle }
    const { rerender } = render(<MarkdownBlockEditor {...props} value="最初の本文" />)
    const editor = await screen.findByRole('textbox', { name: '文書を編集' })
    vi.spyOn(MarkdownSource.prototype, 'createDoc').mockImplementationOnce(() => { throw new Error('試験の変換失敗') })
    rerender(<MarkdownBlockEditor {...props} value="ソースで加えた大切な編集" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('試験の変換失敗')
    expect(handle.current?.flush()).toBe(true)
    expect(changed).not.toHaveBeenCalled()
    expect((editor.closest('.md-editor-mount') as HTMLElement).inert).toBe(true)
    rerender(<MarkdownBlockEditor {...props} value="修正したソース" />)
    await waitFor(() => expect(editor).toHaveTextContent('修正したソース'))
    expect((editor.closest('.md-editor-mount') as HTMLElement).inert).toBe(false)
    expect(changed).not.toHaveBeenCalled()
  })

  it('変換中の保存を確定後へ送る', async () => {
    const save = vi.fn()
    const handle = createRef<MarkdownEditorHandle>()
    render(<MarkdownBlockEditor value="本文" onChange={() => {}} onSave={save} readOnly={false} label="文書を編集" documentKey="ime" handleRef={handle} />)
    const editor = await screen.findByRole('textbox', { name: '文書を編集' })
    fireEvent.compositionStart(editor)
    expect(handle.current?.isComposing()).toBe(true)
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true, isComposing: true })
    expect(save).not.toHaveBeenCalled()
    fireEvent.compositionEnd(editor, { data: '' })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  })
})
