/**
 * PC のフォルダを1階層ずつ辿る（イシューグループ_2026_0805_0514 設計§13）。
 *
 * # 1画面に1階層
 *
 * 木を展開していく形は、狭い画面では現在地を見失う。**いま居る階層だけ**を出し、
 * 上へはパンくずで戻る——ブラウザの「戻る」を階層の移動に使うと意味が衝突する。
 *
 * # 開くと選ぶを分ける
 *
 * 行全体が「入る」で、確定は別のボタン（呼び出し側が置く）。同じ場所に2つの意味を
 * 持たせると、押す対象が小さい狭い画面で取り違えが起きる。
 *
 * # 打ち切りと読めない理由は隠さない
 *
 * 黙って切ると「あるはずのフォルダが無い」に見え、原因まで辿れない（設計§8）。
 * 断られた理由もそのまま出す——権限・不在・版が古い、はどれも利用者が直せる（§17）。
 *
 * この部品は**追加のシートと PJT 専用画面の左パネルで共有する**（設計§13）。
 * 同じ列挙の口を使う部品が2つの作法を持つと、片方だけ直したときに食い違う。
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  childOf,
  crumbsOf,
  listDir,
  type DirEntry,
  type DirListing,
} from '@/lib/hostfs'

interface Props {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /**
   * 最初に見せる場所。**省略するとその PC のホーム**（設計§26-2）。
   *
   * 変わると辿り直す。呼び出し側が「最近使った場所」を押したときの移動もこれで起きる。
   */
  start?: string
  /** ここより上へは辿らせない（PJT 専用画面の左パネル用。設計§15） */
  root?: string
  /** いま見ている場所が変わるたびに呼ばれる。確定ボタンの相手を呼び出し側が持つため */
  onPathChange?: (path: string) => void
  /** ファイルを押したとき。省略するとファイルは押せない（選ぶ対象がフォルダだけの場面） */
  onPickFile?: (path: string) => void
}

export function FolderBrowser({
  host,
  start,
  root,
  onPathChange,
  onPickFile,
}: Props) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // `undefined` は「まだ聞いていない」＝ホームから始める（設計§26-2）
  const [path, setPath] = useState<string | undefined>(start)

  useEffect(() => {
    setPath(start)
  }, [start])

  const go = useCallback(
    async (next: string | undefined) => {
      setLoading(true)
      setError(null)
      try {
        const result = await listDir(host, next)
        setListing(result)
        // **着いた先はサーバが返す値を正とする。** 省略して問うたときは
        // ここで初めてホームのパスが分かる
        setPath(result.path)
        onPathChange?.(result.path)
      } catch (err) {
        setError(err instanceof Error ? err.message : '読めませんでした')
        setListing(null)
      } finally {
        setLoading(false)
      }
    },
    [host, onPathChange],
  )

  useEffect(() => {
    void go(path)
    // `path` は `go` の中で更新するので、依存に入れると辿るたびに二重に走る。
    // ここで見たいのは「宛先か始まりが変わったら辿り直す」だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, start])

  // ルートより上は出さない（左パネル用）。**出しても押せない段は作らない**
  const crumbs = crumbsOf(path ?? '/').filter(
    (crumb) => root === undefined || crumb.path.startsWith(root) || root.startsWith(crumb.path),
  )

  return (
    <div data-testid="folder-browser" data-path={path ?? ''} className="flex min-h-0 flex-col gap-2">
      <nav
        data-testid="folder-crumbs"
        aria-label="いまの場所"
        className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs"
      >
        {crumbs.map((crumb, at) => (
          <span key={crumb.path} className="flex items-center gap-1">
            {at > 0 && <span className="text-muted-foreground">/</span>}
            <button
              type="button"
              data-testid="folder-crumb"
              disabled={root !== undefined && !crumb.path.startsWith(root)}
              className="hover:text-primary disabled:text-muted-foreground rounded px-1 py-0.5 underline disabled:no-underline"
              onClick={() => void go(crumb.path)}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>

      {error !== null && (
        <p data-testid="folder-error" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {listing?.truncated === true && (
        <p data-testid="folder-truncated" className="text-xs text-amber-300">
          多すぎるので途中までしか出していません。目的のフォルダが見当たらないときは、
          パスを直に打ち込んでください。
        </p>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto text-sm">
        {loading && (
          <li className="text-muted-foreground px-2 py-1.5 text-xs">読み込み中…</li>
        )}
        {!loading && listing?.entries.length === 0 && (
          <li className="text-muted-foreground px-2 py-1.5 text-xs">
            このフォルダは空です
          </li>
        )}
        {!loading &&
          listing?.entries.map((entry) => (
            <Row
              key={entry.name}
              entry={entry}
              onOpen={() => void go(childOf(listing.path, entry.name))}
              onPickFile={
                onPickFile === undefined
                  ? undefined
                  : () => onPickFile(childOf(listing.path, entry.name))
              }
            />
          ))}
      </ul>
    </div>
  )
}

/**
 * 1行。**行全体が押す対象**（狭い画面では的の大きさがそのまま使い勝手になる）。
 *
 * リンクは辿らない（設計§8）ので、押しても入らない。在ることだけを示す。
 */
function Row({
  entry,
  onOpen,
  onPickFile,
}: {
  entry: DirEntry
  onOpen: () => void
  onPickFile?: () => void
}) {
  const openable = entry.kind === 'dir'
  const pressable = openable || (entry.kind === 'file' && onPickFile !== undefined)

  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        data-testid="folder-entry"
        data-kind={entry.kind}
        data-name={entry.name}
        disabled={!pressable}
        onClick={openable ? onOpen : onPickFile}
        // 行全体を的にする。高さも狭い画面で押しやすい値にしてある
        className="h-auto w-full justify-start gap-2 px-2 py-2 text-left font-normal"
      >
        <span aria-hidden className="shrink-0">
          {entry.kind === 'dir' ? '📁' : entry.kind === 'symlink' ? '🔗' : '📄'}
        </span>
        <span className="min-w-0 truncate">{entry.name}</span>
        {entry.is_project && (
          // 深い階層で「どれが目的地か」を1階層ぶん先に教える（設計§8）
          <span
            data-testid="folder-project-mark"
            title="このフォルダは .git を持っています"
            className="border-primary/40 text-primary ml-auto shrink-0 rounded border px-1 text-[10px]"
          >
            PJT
          </span>
        )}
      </Button>
    </li>
  )
}
