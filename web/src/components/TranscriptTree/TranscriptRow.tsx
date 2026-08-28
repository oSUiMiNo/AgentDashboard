/**
 * 構造化ビューの1行（初期実装設計§10、イシューグループ_2026-0813-2208 設計§2）。
 *
 * 行の種別ごとに見た目を変え、開くと中身（ツールの入力・結果・コードの差分）が出る。
 * 「サブエージェント → ツールコール → 編集差分」と掘れることが要件なので、
 * **開け閉めできること**と**入れ子が見て分かること**を最優先にしている。
 *
 * # 操作は2つある
 *
 * | 操作 | 置き場所 | 何をするか |
 * |---|---|---|
 * | `▸▾` | 見出しの左 | **まだ出していないものを出す** |
 * | 「続きを読む／畳む」 | **本文の中**（末尾） | **切ってある本文を全部読む** |
 *
 * `▸▾` を「この行を開く」と読むと、本文と子が一緒に出入りすることになり、**ツールを
 * 何本も呼んだターンを畳んで会話だけ追う**という読み方ができなくなる。「まだ出して
 * いないものを出す」と読み直すと、種別ごとの違いが例外ではなく帰結になる。
 *
 * | 種別 | 本文 | `▸▾` が出すもの |
 * |---|---|---|
 * | 利用者・アシスタント | **常に出す**（整形）。長ければ畳んで「続きを読む」 | 子だけ |
 * | 思考 | `▸▾` で開く。開いたら整形して全文 | 本文（子を持たない） |
 * | ツールコール・不明 | — | 中身と子 |
 * | サブエージェント | — | 子 |
 */

import { memo, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { HunkTokens } from 'react-diff-view'
import { Diff, Hunk } from 'react-diff-view'
import type { CardId, Node } from '@/lib/protocol'
import { countChanges, toDiffSource } from '@/lib/diff'
import { tokenizeHunks } from '@/lib/highlight'
import { REHYPE_PLUGINS, REMARK_PLUGINS, foldMarkdown } from '@/lib/markdown'
import type { FlatRow, NodeRow, RewoundRow } from '@/stores/transcript'

interface Props {
  cardId: CardId
  row: FlatRow
  /** 行そのものを渡す。巻き戻しの見出し行はノードではないので、IDでは足りない */
  onToggle: (row: FlatRow) => void
  /** 本文の開け閉め。`▸▾` とは別の操作 */
  onToggleBody: (row: NodeRow) => void
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

/**
 * 折り畳んだ状態でも中身の見当がつくように、1行だけの要約を作る。
 *
 * **本文を持つ種別には出さない。** あちらは本文そのものが（整形されて）出ているので、
 * 横に同じものを並べる理由が無い。以前はここでも先頭200文字を出しており、短い本文では
 * **同じ文字が2回並んで**いた。
 *
 * ツールコールとサブエージェントには**残す**。あれは本文ではなく**入力の抜粋**
 * （どのファイルを・どのコマンドを）で、畳んだままでも見当が付く必要がある。
 */
function summary(node: Node): string {
  switch (node.kind) {
    case 'user_message':
    case 'assistant_text':
    case 'thinking':
      return ''
    case 'tool_call':
      return summarizeInput(node.input)
    case 'subagent':
      return `深さ ${node.spawn_depth}`
    case 'unknown':
      return ''
  }
}

/** 本文を常に出す種別か（＝`▸▾` が子だけを担う種別か）。 */
function showsBodyAlways(node: Node): boolean {
  return node.kind === 'user_message' || node.kind === 'assistant_text'
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

/**
 * 履歴の1行。**`memo` で包む。**
 *
 * 履歴が流れている間、ストアはフレームごとに通知する。包まないと、**見えている
 * 行すべてがそのたびにマークダウンを解析し直す**（折りたたみの `foldMarkdown` も同じ回数）。
 *
 * **包むだけでは効かない。** 呼ぶ側が `onToggle` / `onToggleBody` を毎回新しい関数で
 * 渡していると props が変わったことになるので、あちらも `useCallback` で安定させてある
 * （`TranscriptTree.tsx`）。**片方だけでは意味が無い**ので、直すときは2つ揃えること。
 */
export const TranscriptRow = memo(function TranscriptRow({
  cardId,
  row,
  onToggle,
  onToggleBody,
}: Props) {
  if (row.kind === 'rewound') {
    return <RewoundHeader row={row} onToggle={() => onToggle(row)} />
  }
  return (
    <NodeRowView
      cardId={cardId}
      row={row}
      onToggle={() => onToggle(row)}
      onToggleBody={() => onToggleBody(row)}
    />
  )
})

/**
 * 巻き戻し前のやりとりをまとめた見出し（設計§16）。
 *
 * `/rewind` したのに前のやりとりが並んでいると「巻き戻せていないのでは」と読める。
 * かといって消すと、何をやり直したのかが追えなくなる。既定で畳み、開けば読める形にする。
 */
function RewoundHeader({
  row,
  onToggle,
}: {
  row: RewoundRow
  onToggle: () => void
}) {
  return (
    <div
      data-testid="transcript-row"
      data-kind="rewound"
      data-expanded={row.expanded}
      className="border-border/40 border-b py-1 text-sm"
    >
      <button
        type="button"
        data-testid="rewound-toggle"
        onClick={onToggle}
        className="hover:bg-muted/40 flex w-full items-start gap-2 rounded px-1 text-left"
      >
        <span aria-hidden className="text-muted-foreground w-3 shrink-0 text-xs">
          {row.expanded ? '▾' : '▸'}
        </span>
        <span aria-hidden className="shrink-0">
          ⟲
        </span>
        <span className="shrink-0 font-medium text-slate-400">
          巻き戻し前のやりとり {row.count}件
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate">
          {row.expanded ? '' : '（クリックで表示）'}
        </span>
      </button>
    </div>
  )
}

function NodeRowView({
  cardId,
  row,
  onToggle,
  onToggleBody,
}: {
  cardId: CardId
  row: NodeRow
  onToggle: () => void
  onToggleBody: () => void
}) {
  const { icon, label, tone } = heading(row.node)
  const mark = toolMark(row.node)
  const alwaysBody = showsBodyAlways(row.node)

  return (
    <div
      data-testid="transcript-row"
      data-kind={row.node.kind}
      data-depth={row.depth}
      data-expanded={row.expanded}
      data-foldable={row.foldable}
      data-body-open={row.bodyOpen}
      // 入れ子の深さは余白で見せる。1段あたり 1.25rem
      style={{ paddingLeft: `${row.depth * 1.25}rem` }}
      className="border-border/40 border-b py-1 text-sm"
    >
      <button
        type="button"
        disabled={!row.expandable}
        onClick={onToggle}
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

      {/* 本文を持つ種別は `▸▾` に関わらず常に出す。ここを `row.expanded` で囲うと、
          子を畳んだ瞬間に本文まで消えて操作が1つに戻ってしまう */}
      {(alwaysBody || row.expanded) && (
        <RowBody node={row.node} cardId={cardId} row={row} onToggleBody={onToggleBody} />
      )}
    </div>
  )
}

/** 行の中身。本文は整形して出し、ツールの中身は現状のまま出す。 */
function RowBody({
  node,
  cardId,
  row,
  onToggleBody,
}: {
  node: Node
  cardId: CardId
  row: NodeRow
  onToggleBody: () => void
}) {
  void cardId
  switch (node.kind) {
    case 'user_message':
    case 'assistant_text':
      return <MarkdownBody text={node.text} row={row} onToggleBody={onToggleBody} />
    case 'thinking':
      // 思考は畳む相手にしない（開いた時点で全文。設計§2-4）
      return <MarkdownBody text={node.text} row={null} onToggleBody={onToggleBody} />
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

/**
 * 本文をマークダウンとして出す。
 *
 * **生の HTML は素通しする（`skipHtml` を付けない）。** `FileView`（ファイル閲覧）は
 * 消しているが、あちらには「生テキストで見る」という**確かめる先がある**。履歴には
 * 元の JSONL を開く道が画面のどこにも無いので、消すと利用者は消えたことに気づけない。
 * 残った HTML は `react-markdown` がテキストノードへ落とすので、**描かれることは無い**。
 *
 * 改行の決まりは `lib/markdown.ts` の `REMARK_PLUGINS` ／ `REHYPE_PLUGINS` が持つ（素の改行と
 * `<br/>` の2つ。あちらの表を見ること）。**ここと `FileView` は同じ配列を使う**ので、同じ字を
 * 貼れば同じ見え方になる。**`rehype-raw` は入れない**——入れないこと自体が「任意の HTML を
 * 描く道が無い」の実体になっている。
 */
function MarkdownBody({
  text,
  row,
  onToggleBody,
}: {
  text: string
  /** 畳む相手なら行を渡す。畳まない種別（思考）は `null` */
  row: NodeRow | null
  onToggleBody: () => void
}) {
  const folded = row?.foldable === true && !row.bodyOpen
  const body = folded ? foldMarkdown(text).head : text

  return (
    <div className="mt-1 ml-6">
      {/* 本文は**主役**なので、地の色で出す（`FileView` と同じ扱い）。
          要約を横に出していた頃の名残で薄い色にしていると、見出しも強調も
          本文と同じ灰色になって、整形した意味がほとんど消える（実物で確認） */}
      <div data-testid="row-body" className="prose-dashboard text-xs leading-relaxed">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
          {body}
        </ReactMarkdown>
      </div>
      {row?.foldable === true && (
        <button
          type="button"
          data-testid="body-toggle"
          onClick={onToggleBody}
          className="text-muted-foreground hover:text-foreground mt-1 text-xs underline"
        >
          {row.bodyOpen ? '畳む' : '続きを読む'}
        </button>
      )}
    </div>
  )
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
