import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react'
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core'
import { uploadPlugin } from '@milkdown/kit/plugin/upload'
import { undo, redo, undoDepth, redoDepth } from '@milkdown/kit/prose/history'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { DropdownMenu } from 'radix-ui'
import { ArrowDown, ArrowUp, Copy, MoreHorizontal, Plus, Redo2, Trash2, Undo2 } from 'lucide-react'
import { MarkdownSource } from '../../lib/fileMarkdown'
import { Button } from '../ui/button'
import { markdownEditorConfig } from './markdown/editorConfig'
import { markdownSearch } from './markdown/search'
import type { FileSearchAdapter } from '../../lib/fileSearch'
import { configureSourceSchema, protectedSourceSchema, sourceIdentityPlugin, type SourceSession } from './markdown/sourcePlugin'
import { deleteSelectedBlock, duplicateSelectedBlock, editTable, insertParagraphAfter, moveSelectedBlock, selectedBlock } from './markdown/blockCommands'
import '@milkdown/crepe/theme/common/reset.css'
import '@milkdown/crepe/theme/common/block-edit.css'
import '@milkdown/crepe/theme/common/code-mirror.css'
import '@milkdown/crepe/theme/common/cursor.css'
import '@milkdown/crepe/theme/common/image-block.css'
import '@milkdown/crepe/theme/common/link-tooltip.css'
import '@milkdown/crepe/theme/common/list-item.css'
import '@milkdown/crepe/theme/common/placeholder.css'
import '@milkdown/crepe/theme/common/toolbar.css'
import '@milkdown/crepe/theme/common/table.css'
import '@milkdown/crepe/theme/frame-dark.css'
import { enhanceEditorControls } from './markdown/accessibility'
import './markdown/editor.css'

export type MarkdownEditorHandle = {
  flush: () => boolean
  isComposing: () => boolean
  focus: () => void
}

type Props = {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  readOnly: boolean
  active?: boolean
  label: string
  documentKey: string
  handleRef?: Ref<MarkdownEditorHandle>
  searchRef?: RefObject<HTMLElement | null>
  searchApiRef?: RefObject<FileSearchAdapter | null>
  onCompositionChange?: (composing: boolean) => void
  onSourceRequested?: () => void
  onDocumentChange?: () => void
}

type Controller = {
  crepe: Crepe
  view: EditorView
  session: SourceSession
  canFlush: boolean
  load: (source: string) => boolean
}

export default function MarkdownBlockEditor(props: Props) {
  const { value, documentKey, readOnly, active = true } = props
  const mountRef = useRef<HTMLDivElement>(null)
  const controller = useRef<Controller | null>(null)
  const latest = useRef(props)
  latest.current = props
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 })
  const [protectedCount, setProtectedCount] = useState(0)
  const [position, setPosition] = useState({ first: true, last: true, pinned: false, table: false })
  const pendingSave = useRef(false)
  const deferred = useRef<ReturnType<typeof setTimeout> | null>(null)

  function refreshControls(view: EditorView) {
    setHistoryDepth({ undo: undoDepth(view.state), redo: redoDepth(view.state) })
    const block = selectedBlock(view)
    setPosition({ first: block.index === 0, last: block.index === view.state.doc.childCount - 1, pinned: Boolean(block.node.attrs.pinned), table: block.node.type.name === 'table' })
  }

  function flush() {
    const current = controller.current
    if (!current || !current.canFlush) return true
    if (current.session.composing || current.view.composing || !current.session.book || !current.session.serialize) return false
    try {
      const text = current.session.book.serialize(current.view.state.doc, current.session.serialize)
      if (text !== current.session.lastValue) {
        current.session.lastValue = text
        latest.current.onChange(text)
      }
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Markdownへ変換できませんでした。')
      return false
    }
  }

  useImperativeHandle(props.handleRef, () => ({
    flush,
    isComposing: () => Boolean(controller.current?.session.composing || controller.current?.view.composing),
    focus: () => controller.current?.view.focus(),
  }))

  useEffect(() => {
    const root = mountRef.current
    if (!root) return
    let alive = true
    let initialized = false
    root.inert = true
    const removeAccessibility = enhanceEditorControls(root, () => latest.current.readOnly)
    const session: SourceSession = {
      book: null, serialize: null, composing: false, lastValue: latest.current.value,
      onChange: (text) => {
        if (!alive || !initialized || latest.current.readOnly || latest.current.documentKey !== documentKey) return
        latest.current.onChange(text)
        if (controller.current) refreshControls(controller.current.view)
      },
      onError: (message) => { if (alive) setError(message) },
    }
    const search = markdownSearch()
    const searchApiRef = latest.current.searchApiRef
    const searchDomRef = latest.current.searchRef
    const crepe = new Crepe(markdownEditorConfig(root, (message) => { if (alive) setError(message) }))
    crepe.editor.use(protectedSourceSchema).use(sourceIdentityPlugin(session)).use(search.plugin).config((ctx) => configureSourceSchema(ctx, true))
    setReady(false)
    setComposing(false)
    pendingSave.current = false
    setError(null)
    void crepe.editor.remove(uploadPlugin).then(() => alive ? crepe.create() : null).then(() => {
      if (!alive) {
        void crepe.destroy()
        return
      }
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const parse = ctx.get(parserCtx)
        const serialize = ctx.get(serializerCtx)
        session.serialize = serialize
        const load = (source: string): boolean => {
          initialized = false
          if (controller.current) controller.current.canFlush = false
          root.inert = true
          try {
            const book = new MarkdownSource(source)
            const doc = book.createDoc(parse, serialize, view.state.schema)
            session.book = book
            session.lastValue = source
            view.updateState(EditorState.create({ doc, plugins: view.state.plugins, selection: TextSelection.atStart(doc) }))
            let count = 0
            doc.forEach((node) => { if (node.type.name === 'markdown_source' && !node.attrs.spacer) count++ })
            setProtectedCount(count)
            refreshControls(view)
            crepe.setReadonly(latest.current.readOnly)
            if (controller.current) controller.current.canFlush = true
            initialized = true
            root.inert = false
            setError(null)
            setReady(true)
            return true
          } catch (failure) {
            setReady(false)
            setError(failure instanceof Error ? failure.message : '編集面を読み込めませんでした。ソース編集は引き続き使えます。')
            return false
          }
        }
        controller.current = { crepe, view, session, load, canFlush: false }
        load(latest.current.value)
        view.dom.setAttribute('role', 'textbox')
        view.dom.setAttribute('aria-multiline', 'true')
        view.dom.setAttribute('aria-label', latest.current.label)
        view.dom.setAttribute('data-testid', 'file-markdown-editor')
        view.dom.setAttribute('spellcheck', 'false')
        if (searchDomRef) searchDomRef.current = view.dom
        if (searchApiRef) searchApiRef.current = search.adapter
        latest.current.onDocumentChange?.()
      })
    }).catch((failure: unknown) => {
      if (alive) setError(failure instanceof Error ? failure.message : 'エディタを準備できませんでした。')
    })
    return () => {
      alive = false
      if (searchApiRef?.current === search.adapter) searchApiRef.current = null
      removeAccessibility()
      if (deferred.current !== null) clearTimeout(deferred.current)
      const current = controller.current
      pendingSave.current = false
      if (current?.crepe === crepe) {
        if (searchDomRef?.current === current.view.dom) searchDomRef.current = null
        controller.current = null
        void crepe.destroy()
      }
    }
  }, [documentKey])

  useEffect(() => {
    const current = controller.current
    if (!current || !ready) return
    current.crepe.setReadonly(readOnly)
    current.view.dom.setAttribute('aria-readonly', String(readOnly))
  }, [readOnly, ready])

  useEffect(() => {
    const current = controller.current
    if (!current) return
    if (active && (value !== current.session.lastValue || !current.canFlush) && !current.session.composing) {
      if (current.load(value)) latest.current.onDocumentChange?.()
    }
  }, [value, active])

  function command(run: (view: EditorView) => unknown) {
    const current = controller.current
    if (!current || !current.canFlush || readOnly || current.session.composing || current.view.composing) return
    run(current.view)
    refreshControls(current.view)
  }

  function saveAfterComposition() {
    if (!pendingSave.current) return
    deferred.current = setTimeout(() => {
      deferred.current = null
      pendingSave.current = false
      if (flush()) latest.current.onSave()
    }, 0)
  }

  return (
    <div
      className="markdown-block-editor"
      data-testid="file-markdown-blocks"
      data-readonly={readOnly || undefined}
      onKeyDownCapture={(event) => {
        if (!(event.ctrlKey || event.metaKey)) return
        if (event.key.toLowerCase() === 's') {
          event.preventDefault()
          event.stopPropagation()
          if (readOnly) return
          if (event.nativeEvent.isComposing || controller.current?.session.composing) pendingSave.current = true
          else if (flush()) latest.current.onSave()
        } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault()
          command((view) => moveSelectedBlock(view, event.key === 'ArrowUp' ? -1 : 1))
        }
      }}
      onCompositionStartCapture={() => {
        setComposing(true)
        latest.current.onCompositionChange?.(true)
      }}
      onCompositionEndCapture={() => {
        deferred.current = setTimeout(() => {
          deferred.current = null
          flush()
          setComposing(false)
          latest.current.onCompositionChange?.(false)
          saveAfterComposition()
        }, 0)
      }}
      onKeyUp={() => { const view = controller.current?.view; if (view) refreshControls(view) }}
      onPointerUp={() => { const view = controller.current?.view; if (view) refreshControls(view) }}
      onPasteCapture={(event) => {
        if (event.clipboardData.files.length > 0) {
          event.preventDefault()
          event.stopPropagation()
          setError('画像はURLで指定してください。ファイルの貼り付けには対応していません。')
        }
      }}
      onDropCapture={(event) => {
        if (event.dataTransfer.files.length > 0) {
          event.preventDefault()
          event.stopPropagation()
          setError('画像はURLで指定してください。ファイルのドロップには対応していません。')
        }
      }}
    >
      <div className="md-editor-controls" data-file-find-skip="true">
        <span className="md-editor-mode">{readOnly ? '読み取り専用' : 'ブロック編集'}</span>
        {!readOnly && <div className="md-editor-actions">
          <Button variant="ghost" size="icon-sm" aria-label="元に戻す" title="元に戻す（Ctrl+Z）" disabled={!ready || composing || historyDepth.undo === 0}
            onClick={() => command((view) => { undo(view.state, view.dispatch); view.focus() })}><Undo2 size={15} /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="やり直す" title="やり直す（Ctrl+Shift+Z）" disabled={!ready || composing || historyDepth.redo === 0}
            onClick={() => command((view) => { redo(view.state, view.dispatch); view.focus() })}><Redo2 size={15} /></Button>
          <DropdownMenu.Root onOpenChange={(open) => { if (open && controller.current) refreshControls(controller.current.view) }}>
            <DropdownMenu.Trigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="選択中のブロック操作" title="選択中のブロック操作" disabled={!ready || composing}><MoreHorizontal size={17} /></Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="md-command-menu" align="end" sideOffset={6} onCloseAutoFocus={(event) => event.preventDefault()}>
                <DropdownMenu.Label className="md-command-label">選択中のブロック</DropdownMenu.Label>
                {position.table && <>
                  <DropdownMenu.Item onSelect={() => command((view) => editTable(view, 'addRowAfter'))}><Plus size={16} />下に行を追加</DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => command((view) => editTable(view, 'addColumnAfter'))}><Plus size={16} />右に列を追加</DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => command((view) => editTable(view, 'deleteRow'))}><Trash2 size={16} />この行を削除</DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => command((view) => editTable(view, 'deleteColumn'))}><Trash2 size={16} />この列を削除</DropdownMenu.Item>
                  <DropdownMenu.Separator />
                </>}
                <DropdownMenu.Item onSelect={() => command(insertParagraphAfter)}><Plus size={16} />下にテキストを追加</DropdownMenu.Item>
                <DropdownMenu.Item disabled={position.first || position.pinned} onSelect={() => command((view) => moveSelectedBlock(view, -1))}><ArrowUp size={16} />上へ移動</DropdownMenu.Item>
                <DropdownMenu.Item disabled={position.last || position.pinned} onSelect={() => command((view) => moveSelectedBlock(view, 1))}><ArrowDown size={16} />下へ移動</DropdownMenu.Item>
                <DropdownMenu.Item disabled={position.pinned} onSelect={() => command(duplicateSelectedBlock)}><Copy size={16} />複製</DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item className="md-command-danger" onSelect={() => command(deleteSelectedBlock)}><Trash2 size={16} />削除</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>}
      </div>
      {error && <div className="md-editor-notice" role="alert" data-file-find-skip="true">{error}</div>}
      {!ready && !error && <div className="md-editor-loading" role="status">編集面を準備しています…</div>}
      <div ref={mountRef} className="md-editor-mount" />
      {protectedCount > 0 && <div className="md-editor-preserved" data-file-find-skip="true">
        <span>{protectedCount}箇所の特殊な記法は、原文のまま保持しています。</span>
        {props.onSourceRequested && <button type="button" disabled={composing} onClick={() => { if (flush()) latest.current.onSourceRequested?.() }}>ソースで編集</button>}
      </div>}
    </div>
  )
}
