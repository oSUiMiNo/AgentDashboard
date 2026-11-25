import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { OpenInButtons } from '@/components/OpenIn/OpenInButtons'
import {
  AboveRootCrumb,
  CopyFallback,
  CrumbCopyState,
  FolderRow,
  PathMenu,
  type OpenInProp,
} from '@/components/FolderBrowser/parts'
import { useCopyAnswer } from '@/components/FolderBrowser/useCopyAnswer'
import { useFolderTree } from '@/components/FolderBrowser/useFolderTree'
import { listingOf, rowScrollFor, 送り直しを見張る間, type Branch } from '@/lib/folderTree'
import { childOf, crumbsOf, rawUrl, type DirEntry } from '@/lib/hostfs'
import { isOpenedIn } from '@/lib/openIn'

interface Props {
  host: string
  root: string
  loadExpanded: () => string[]
  onExpandedChange: (expanded: string[]) => void
  onPickFile?: (path: string) => void
  current?: string
  openIn?: OpenInProp
}

const 器のクラス = 'flex h-full min-h-0 flex-col gap-2'

export function FolderTree(props: Props) {
  if (props.root === '') {
    return <div data-testid="folder-browser" data-mode="tree" data-path="" className={器のクラス} />
  }
  return <Tree {...props} />
}

function useSteadyOpenIn(openIn: OpenInProp | undefined): OpenInProp | undefined {
  const 使う = openIn?.view.same_machine === true ? openIn : undefined
  const 鍵 = 使う === undefined ? '' : JSON.stringify([使う.view, 使う.busy])
  const [控え, set控え] = useState({ 鍵, 口: 使う })
  if (控え.鍵 !== 鍵 || 控え.口?.open !== 使う?.open) {
    set控え({ 鍵, 口: 使う })
    return 使う
  }
  return 控え.口
}

function 行を引く(箱: HTMLElement, path: string): HTMLElement | undefined {
  return Array.from(箱.querySelectorAll<HTMLElement>('[data-testid="folder-entry"]')).find(
    (each) => each.dataset.path === path,
  )
}

function 送る(箱: HTMLElement, 行: HTMLElement): number {
  const 箱の矩形 = 箱.getBoundingClientRect()
  const 行の矩形 = 行.getBoundingClientRect()
  const いま = 箱.scrollTop
  const 次 = rowScrollFor(
    { 高さ: 箱.clientHeight, いまの位置: いま },
    { 上: 行の矩形.top - 箱の矩形.top + いま, 高さ: 行の矩形.height },
  )
  if (次 !== いま) {
    箱.scrollTop = 次
  }
  return 箱.scrollTop
}

const 利用者の手 = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

function 送り直しを見張る(
  箱: HTMLElement,
  置いた: number,
  行を探す: () => HTMLElement | null | undefined,
): () => void {
  let 見張っている = true
  function 外す() {
    if (!見張っている) {
      return
    }
    見張っている = false
    clearTimeout(時計)
    見張り.disconnect()
    for (const 名 of 利用者の手) {
      箱.removeEventListener(名, 外す)
    }
    箱.removeEventListener('scroll', 動いた)
  }
  function 動いた() {
    if (Math.abs(箱.scrollTop - 置いた) > 1) {
      外す()
    }
  }
  function 大きさが変わった() {
    const 行 = 行を探す()
    if (行 === null) {
      外す()
      return
    }
    if (行 === undefined) {
      return
    }
    const 前 = 箱.scrollTop
    if (送る(箱, 行) !== 前) {
      外す()
    }
  }
  const 時計 = setTimeout(外す, 送り直しを見張る間)
  const 見張り = new ResizeObserver(大きさが変わった)
  for (const 名 of 利用者の手) {
    箱.addEventListener(名, 外す, { passive: true })
  }
  箱.addEventListener('scroll', 動いた, { passive: true })
  見張り.observe(箱)
  return 外す
}

function useRevealCurrent(器: RefObject<HTMLUListElement | null>, current: string | undefined) {
  const 送った = useRef(false)
  const 今のファイル = useRef(current)
  const 見張りを外す = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    今のファイル.current = current
    const 箱 = 器.current
    if (送った.current || current === undefined || 箱 === null) {
      return
    }
    const 行 = 行を引く(箱, current)
    if (行 === undefined) {
      return
    }
    送った.current = true
    const 置いた = 送る(箱, 行)
    見張りを外す.current = 送り直しを見張る(箱, 置いた, () =>
      今のファイル.current === current ? 行を引く(箱, current) : null,
    )
  })

  useLayoutEffect(
    () => () => {
      見張りを外す.current?.()
      見張りを外す.current = null
      送った.current = false
    },
    [],
  )
}

interface TreeRowProps {
  entry: DirEntry
  full: string
  depth: number
  開いている: boolean
  current: boolean
  copyState: 'idle' | 'done' | 'failed'
  host: string
  root: string
  開いている印: boolean
  onToggle: (path: string) => void
  onPickFile: ((path: string) => void) | undefined
  onCopy: (at: string, value: string) => void
}

const TreeRow = memo(function TreeRow({
  entry,
  full,
  depth,
  開いている,
  current,
  copyState,
  host,
  root,
  開いている印,
  onToggle,
  onPickFile,
  onCopy,
}: TreeRowProps) {
  const フォルダ = entry.kind === 'dir'
  return (
    <FolderRow
      as="div"
      density="tree"
      depth={depth}
      twistie={フォルダ ? (開いている ? 'expanded' : 'collapsed') : 'none'}
      expanded={フォルダ ? 開いている : undefined}
      entry={entry}
      full={full}
      host={host}
      root={root}
      onOpen={() => onToggle(full)}
      current={current}
      onPickFile={onPickFile === undefined ? undefined : () => onPickFile(full)}
      copyState={copyState}
      onCopy={(value) => onCopy(full, value)}
      opened={開いている印}
      menu="outside"
    />
  )
})

interface 相手 {
  path: string
  name: string
  kind: DirEntry['kind']
  場所: '行' | 'パンくず'
}

function 相手を引く(target: EventTarget | null, ルート: 相手): 相手 {
  const 行 = target instanceof Element ? target.closest<HTMLElement>('[data-row-path]') : null
  const 印 = 行?.querySelector<HTMLElement>('[data-testid="folder-entry"]') ?? null
  const path = 行?.dataset.rowPath
  const name = 印?.dataset.name
  const kind = 印?.dataset.kind
  if (path === undefined || name === undefined || (kind !== 'dir' && kind !== 'file' && kind !== 'symlink')) {
    return ルート
  }
  return { path, name, kind, 場所: '行' }
}

function TreeMenu({
  host,
  root,
  根の名,
  onPickFile,
  openIn,
  copy,
  children,
}: {
  host: string
  root: string
  根の名: string
  onPickFile: ((path: string) => void) | undefined
  openIn: OpenInProp | undefined
  copy: (at: string, value: string, 場所?: '行' | 'パンくず') => void
  children: ReactElement
}) {
  const ルート = useMemo<相手>(() => ({ path: root, name: 根の名, kind: 'dir', 場所: 'パンくず' }), [root, 根の名])
  const [開いている, set開いている] = useState(false)
  const [今の相手, set今の相手] = useState<相手>(ルート)
  const 候補 = useRef<相手>(ルート)
  return (
    <ContextMenu
      open={開いている}
      onOpenChange={(next) => {
        if (next) {
          set今の相手(候補.current)
        }
        set開いている(next)
      }}
    >
      <ContextMenuTrigger
        asChild
        onPointerDown={(event) => {
          候補.current = 相手を引く(event.target, ルート)
        }}
        onContextMenu={(event) => {
          候補.current = 相手を引く(event.target, ルート)
          set今の相手(候補.current)
        }}
      >
        {children}
      </ContextMenuTrigger>
      <PathMenu
        name={今の相手.name}
        path={今の相手.path}
        kind={今の相手.kind}
        tabUrl={今の相手.kind === 'file' && onPickFile !== undefined ? rawUrl(host, 今の相手.path) : undefined}
        openIn={openIn}
        onCopy={(value) => copy(今の相手.path, value, 今の相手.場所)}
      />
    </ContextMenu>
  )
}

function Tree({ host, root, loadExpanded, onExpandedChange, onPickFile, current, openIn }: Props) {
  const { expanded, branches, toggle } = useFolderTree({ host, root, loadExpanded, onExpandedChange })
  const 展開 = useMemo(() => new Set(expanded), [expanded])
  const { copied, copy, dismiss } = useCopyAnswer()
  const 開く口 = useSteadyOpenIn(openIn)
  const 段 = crumbsOf(root)
  const 根 = 段.at(-1) ?? { label: root, path: root }
  const 外側 = 段.length >= 2 ? 段[段.length - 2] : undefined
  const 器 = useRef<HTMLUListElement>(null)
  useRevealCurrent(器, current)

  const 札 = (at: string) => (
    <CrumbCopyState show={copied?.場所 === 'パンくず' && copied.path === at && copied.state === 'done'} />
  )

  const 知らせ = (path: string, depth: number, 枝: Branch | undefined): ReactNode => {
    const 字下げ = { paddingLeft: `${depth * 12 + 8}px` }
    const 一覧 = listingOf(枝)
    if (枝?.state === 'failed') {
      return (
        <li data-testid="folder-error" data-path={path} className="py-1.5 pr-2 text-xs text-red-400" style={字下げ}>
          {枝.reason}
        </li>
      )
    }
    if (一覧 === null) {
      return (
        <li
          data-testid="folder-branch-loading"
          data-path={path}
          className="text-muted-foreground py-1.5 pr-2 text-xs"
          style={字下げ}
        >
          読み込み中…
        </li>
      )
    }
    if (一覧.entries.length === 0) {
      return (
        <li
          data-testid="folder-branch-empty"
          data-path={path}
          className="text-muted-foreground py-1.5 pr-2 text-xs"
          style={字下げ}
        >
          {path === root ? 'このフォルダは空です' : '空のフォルダ'}
        </li>
      )
    }
    if (一覧.truncated) {
      return (
        <li data-testid="folder-truncated" data-path={path} className="py-1.5 pr-2 text-xs text-amber-300" style={字下げ}>
          多すぎるので途中までしか出していません
        </li>
      )
    }
    return null
  }

  const 中身 = (path: string, depth: number): ReactNode => {
    const 枝 = branches.get(path)
    const 一覧 = listingOf(枝)
    return (
      <>
        {知らせ(path, depth, 枝)}
        {一覧?.entries.map((entry) => {
          const full = childOf(path, entry.name)
          const 開いている = entry.kind === 'dir' && 展開.has(full)
          return (
            <li key={entry.name}>
              <TreeRow
                entry={entry}
                full={full}
                depth={depth}
                開いている={開いている}
                current={current === full}
                copyState={copied?.場所 === '行' && copied.path === full ? copied.state : 'idle'}
                host={host}
                root={root}
                開いている印={開く口 !== undefined && isOpenedIn(開く口.view, full)}
                onToggle={toggle}
                onPickFile={onPickFile}
                onCopy={copy}
              />
              {開いている && (
                <ul
                  data-testid="folder-children"
                  data-path={full}
                  className="folder-tree-branch"
                  style={{ '--folder-tree-guide': `${depth * 12 + 16}px` } as CSSProperties}
                >
                  {中身(full, depth + 1)}
                </ul>
              )}
            </li>
          )
        })}
      </>
    )
  }

  const パンくず = (
    <nav
      data-testid="folder-crumbs"
      aria-label="PJT のフォルダ"
      className={`flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs${開く口 === undefined ? '' : ' min-w-0 flex-1'}`}
    >
      {外側 !== undefined && (
        <AboveRootCrumb
          crumb={外側}
          openIn={開く口}
          onCopy={(value) => copy(外側.path, value, 'パンくず')}
          answer={札(外側.path)}
        />
      )}
      <span className="relative flex items-center gap-1">
        {外側 !== undefined && <span className="text-muted-foreground">/</span>}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <span data-testid="folder-crumb" title={root} className="rounded px-1 py-0.5">
              {根.label}
            </span>
          </ContextMenuTrigger>
          <PathMenu
            name={根.label}
            path={root}
            kind="dir"
            openIn={開く口}
            onCopy={(value) => copy(root, value, 'パンくず')}
          />
        </ContextMenu>
        {札(root)}
      </span>
    </nav>
  )

  return (
    <div data-testid="folder-browser" data-mode="tree" data-path={root} className={器のクラス}>
      {開く口 === undefined ? (
        パンくず
      ) : (
        <div data-testid="folder-crumbs-row" className="flex items-start gap-1">
          {パンくず}
          <OpenInButtons root={root} view={開く口.view} open={開く口.open} busy={開く口.busy} />
        </div>
      )}
      {copied?.state === 'failed' && <CopyFallback value={copied.value} onDismiss={dismiss} />}
      <TreeMenu host={host} root={root} 根の名={根.label} onPickFile={onPickFile} openIn={開く口} copy={copy}>
        <ul
          ref={器}
          data-testid="folder-children"
          data-path={root}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto text-sm"
        >
          {中身(root, 0)}
          <li aria-hidden data-testid="folder-blank" className="min-h-8 flex-1" />
        </ul>
      </TreeMenu>
    </div>
  )
}
