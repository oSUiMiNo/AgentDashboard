/**
 * ファイル1つを見せる（イシューグループ_2026_0805_0514 設計§15）。
 *
 * # 何のための画面か
 *
 * 目的は2つで、どちらも「エージェントへ指示を出す前の一手」にあたる。
 *
 * - **相対パスを渡す** … 実 PC の VSCode を見に行かずに、貼れる形の値を取る
 * - **進捗を確かめる** … `計画.md` のチェックボックスが入っているかを見る
 *
 * だから整形は Markdown に寄せてあり、**チェックボックスが読めること**がこの画面の
 * 価値のほとんどを占める。
 *
 * # 生の HTML は通さない
 *
 * この画面はインターネットへ出ていることがある。`react-markdown` は既定で生の HTML を
 * 素通ししないので、**`rehype-raw` を入れないこと自体が安全条件**になっている
 * （設計§15・フェーズ0 の実測）。入れる場合は `rehype-sanitize` と組にする必要があるが、
 * 設計は「通さない」と決めている。
 *
 * # 整形が嘘をついたときの逃げ道を残す
 *
 * 整形すると、元の字面との対応が見えなくなる。**生テキストへ切り替えられる**ように
 * してあるのはそのためで、確かめる先が無い整形は信じられない。
 */

import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { readFile, relativeOf, type FileContent } from '@/lib/hostfs'

interface Props {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /** 相対パスの基準（その枠のパス）。**画面にも出す** */
  root: string
  /** 読むファイルの絶対パス */
  path: string
  /** 閉じる。省略すると閉じる操作を出さない */
  onClose?: () => void
}

/** Markdown として整形してよいか。拡張子だけで決める（中身を推測しない）。 */
function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

export function FileView({ host, root, path, onClose }: Props) {
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // 整形できる相手のときだけ意味を持つ。既定は整形（進捗を読むのが目的のため）
  const [raw, setRaw] = useState(false)
  // `CopyPath`（`FolderBrowser`）と同じ3つの状態。**片方だけ黙る作りにしない**
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setCopied('idle')
    setRaw(false)
    void (async () => {
      try {
        const result = await readFile(host, path)
        if (alive) {
          setContent(result)
        }
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : '読めませんでした')
          setContent(null)
        }
      } finally {
        if (alive) {
          setLoading(false)
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [host, path])

  const relative = relativeOf(root, path)

  const copy = useCallback(async () => {
    // **黙って失敗させない。** 使えない環境（http の別ホスト・古いブラウザ）では
    // 選べる形で出して、利用者が自分で取れるようにする
    try {
      await navigator.clipboard.writeText(relative)
      setCopied('done')
    } catch {
      setCopied('failed')
    }
  }, [relative])

  const markdown = isMarkdown(path)

  return (
    <section
      data-testid="file-view"
      data-path={path}
      className="border-border flex min-h-0 flex-col gap-2 border-t pt-2"
    >
      <header className="flex flex-wrap items-center gap-1.5">
        {/* **何からの相対パスかを必ず出す。** 基準の分からない相対パスは、
            貼られた側で解釈できない（設計§15） */}
        <code
          data-testid="file-relative-path"
          className="bg-muted min-w-0 truncate rounded px-1.5 py-0.5 text-xs"
          title={path}
        >
          {relative}
        </code>
        <span
          data-testid="file-relative-base"
          className="text-muted-foreground shrink-0 text-[11px]"
        >
          （{root} からの相対パス）
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="file-copy"
            onClick={() => void copy()}
          >
            パスをコピー
          </Button>
          {markdown && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="file-toggle-raw"
              aria-pressed={raw}
              onClick={() => setRaw((now) => !now)}
            >
              {raw ? '整形して見る' : '生テキストで見る'}
            </Button>
          )}
          {onClose !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="file-close"
              onClick={onClose}
            >
              閉じる
            </Button>
          )}
        </div>
      </header>

      {copied === 'done' && (
        <p data-testid="file-copied" className="text-xs text-emerald-400">
          コピーしました
        </p>
      )}

      {copied === 'failed' && (
        <p data-testid="file-copied" className="text-xs text-amber-300">
          コピーできません。この値を選んで取ってください：{' '}
          <code
            data-testid="file-copy-fallback"
            className="bg-muted/60 rounded px-1 py-0.5 font-mono select-all"
          >
            {relative}
          </code>
        </p>
      )}

      {error !== null && (
        <p data-testid="file-error" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {content?.truncated === true && (
        <p data-testid="file-truncated" className="text-xs text-amber-300">
          長すぎるので途中までしか出していません（全体は {content.bytes} バイト）。
        </p>
      )}

      {loading && (
        <p className="text-muted-foreground text-xs">読み込み中…</p>
      )}

      {!loading && content !== null && (
        <div className="min-h-0 flex-1 overflow-auto">
          {markdown && !raw ? (
            <div
              data-testid="file-markdown"
              className="prose-dashboard text-sm leading-relaxed"
            >
              {/* 生の HTML は通さない。`rehype-raw` を入れていないことが、
                  そのまま「通さない」の実体になっている（設計§15）。

                  `skipHtml` は、その HTML を**字面としても出さない**（設計§27）。
                  外すと `<br/>` のような綴りが本文に混ざる——このリポジトリの
                  ドキュメントは段落の間隔に使っているので、節のたびに出る。
                  外して困らないのは、消えた中身を「生テキストで見る」で確かめられるため */}
              <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
                {content.text}
              </ReactMarkdown>
            </div>
          ) : (
            <pre
              data-testid="file-raw"
              className="text-muted-foreground overflow-x-auto text-xs whitespace-pre-wrap"
            >
              {content.text}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}
