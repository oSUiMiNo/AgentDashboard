/**
 * 構造化ビューの1行（設計§10）。
 *
 * 行の種別ごとに見た目を変え、開くと中身（ツールの入力・結果・コードの差分）が出る。
 * 「サブエージェント → ツールコール → 編集差分」と掘れることが要件なので、
 * **開け閉めできること**と**入れ子が見て分かること**を最優先にしている。
 */

import { useEffect, useState } from 'react'
import type { HunkTokens } from 'react-diff-view'
import { Diff, Hunk } from 'react-diff-view'
import type { CardId, Node } from '@/lib/protocol'
import { countChanges, toDiffSource } from '@/lib/diff'
import { tokenizeHunks } from '@/lib/highlight'
import type { FlatRow } from '@/stores/transcript'

interface Props {
  cardId: CardId
  row: FlatRow
  onToggle: (id: string) => void
}

/** 種別ごとの見出し（記号・ラベル・色）。 */
function heading(node: Node): { icon: string; label: string; tone: string } {
  switch (node.kind) {
    case 'user_message':
      return { icon: '👤', label: 'あなた', tone: 'text-sky-300' }
    case 'assistant_text':
      return { icon: '🤖', label: 'アシスタント', tone: 'text-emerald-300' }
    case 'thinking':
      return { icon: '💭', label: '思考', tone: 'text-muted-foreground' }
    case 'tool_call':
      return { icon: '🔧', label: node.name, tone: 'text-violet-300' }
    case 'subagent':
      return { icon: '🧩', label: `サブエージェント ${node.agent_type}`, tone: 'text-amber-300' }
    case 'unknown':
      return { icon: '❔', label: `未知のレコード（${node.record_type}）`, tone: 'text-orange-300' }
  }
}

/** ツールの状態を1文字で表す。 */
function toolMark(node: Node): string {
  if (node.kind !== 'tool_call') {
    return ''
  }
  switch (node.status) {
    case 'ok':
      return '✓'
    case 'error':
      return '✗'
    case 'pending':
      return '…'
  }
}

/** 折り畳んだ状態でも中身の見当がつくように、1行だけの要約を作る。 */
function summary(node: Node): string {
  switch (node.kind) {
    case 'user_message':
    case 'assistant_text':
    case 'thinking':
      return node.text.replace(/\s+/g, ' ').slice(0, 200)
    case 'tool_call':
      return summarizeInput(node.input)
    case 'subagent':
      return `深さ ${node.spawn_depth}`
    case 'unknown':
      return ''
  }
}

function summarizeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return ''
  }
  const record = input as Record<string, unknown>
  // よく使うツールは「何に対して何をしたか」が1つの項目に入っている
  for (const key of ['file_path', 'command', 'pattern', 'path', 'description', 'prompt']) {
    const value = record[key]
    if (typeof value === 'string') {
      return value.replace(/\s+/g, ' ').slice(0, 200)
    }
  }
  return JSON.stringify(input).slice(0, 200)
}

export function TranscriptRow({ cardId, row, onToggle }: Props) {
  const { icon, label, tone } = heading(row.node)
  const mark = toolMark(row.node)

  return (
    <div
      data-testid="transcript-row"
      data-kind={row.node.kind}
      data-depth={row.depth}
      data-expanded={row.expanded}
      // 入れ子の深さは余白で見せる。1段あたり 1.25rem
      style={{ paddingLeft: `${row.depth * 1.25}rem` }}
      className="border-border/40 border-b py-1 text-sm"
    >
      <button
        type="button"
        disabled={!row.expandable}
        onClick={() => onToggle(row.id)}
        className="hover:bg-muted/40 flex w-full items-start gap-2 rounded px-1 text-left disabled:cursor-default"
      >
        <span aria-hidden className="w-3 shrink-0 text-xs text-muted-foreground">
          {row.expandable ? (row.expanded ? '▾' : '▸') : ''}
        </span>
        <span aria-hidden className="shrink-0">
          {icon}
        </span>
        <span className={`shrink-0 font-medium ${tone}`}>{label}</span>
        {mark && (
          <span
            data-testid="tool-status"
            className={row.node.kind === 'tool_call' && row.node.status === 'error' ? 'text-red-400' : 'text-muted-foreground'}
          >
            {mark}
          </span>
        )}
        <span className="text-muted-foreground min-w-0 flex-1 truncate">{summary(row.node)}</span>
      </button>

      {row.expanded && <RowBody node={row.node} cardId={cardId} />}
    </div>
  )
}

/** 展開したときに出る中身。 */
function RowBody({ node, cardId }: { node: Node; cardId: CardId }) {
  void cardId
  switch (node.kind) {
    case 'thinking':
    case 'user_message':
    case 'assistant_text':
      return (
        <pre className="text-muted-foreground mt-1 ml-6 whitespace-pre-wrap text-xs">
          {node.text}
        </pre>
      )
    case 'tool_call':
      return <ToolCallBody input={node.input} result={node.result} />
    case 'unknown':
      return (
        <pre className="text-muted-foreground mt-1 ml-6 max-h-64 overflow-auto text-xs">
          {JSON.stringify(node.raw, null, 2)}
        </pre>
      )
    default:
      return null
  }
}

function ToolCallBody({ input, result }: { input: unknown; result: unknown }) {
  const diff = toDiffSource(result)

  return (
    <div className="mt-1 ml-6 space-y-2">
      <details>
        <summary className="text-muted-foreground cursor-pointer text-xs">入力</summary>
        <pre className="text-muted-foreground max-h-64 overflow-auto text-xs">
          {JSON.stringify(input, null, 2)}
        </pre>
      </details>

      {diff ? (
        <DiffView diff={diff} />
      ) : (
        result != null && (
          <details>
            <summary className="text-muted-foreground cursor-pointer text-xs">結果</summary>
            <pre className="text-muted-foreground max-h-64 overflow-auto text-xs">
              {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
            </pre>
          </details>
        )
      )}
    </div>
  )
}

/**
 * コードの差分。
 *
 * ハイライトは**この行が開かれてから**読み込む。閉じたままのツールコールのために
 * ハイライタを起動しない（設計§10 の「可視行のみ」）。
 */
function DiffView({ diff }: { diff: NonNullable<ReturnType<typeof toDiffSource>> }) {
  const [tokens, setTokens] = useState<HunkTokens | null>(null)
  const { added, removed } = countChanges(diff.hunks)

  useEffect(() => {
    let alive = true
    void tokenizeHunks(diff.hunks, diff.filePath).then((result) => {
      if (alive) {
        setTokens(result)
      }
    })
    return () => {
      alive = false
    }
  }, [diff])

  return (
    <div data-testid="diff-view" data-highlighted={tokens !== null}>
      <div className="text-muted-foreground mb-1 text-xs">
        <span className="font-mono">{diff.filePath}</span>{' '}
        <span className="text-emerald-400">+{added}</span>{' '}
        <span className="text-red-400">-{removed}</span>
      </div>
      <div className="overflow-x-auto rounded border border-border/60 text-xs">
        <Diff viewType="unified" diffType={diff.diffType} hunks={diff.hunks} tokens={tokens}>
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      </div>
    </div>
  )
}
