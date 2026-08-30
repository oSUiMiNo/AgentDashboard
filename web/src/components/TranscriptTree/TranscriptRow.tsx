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
 * | `›` ／ `⌄` | **テキストのすぐ後ろ**（設計§5-2） | **まだ出していないものを出す** |
 * | 「続きを読む／畳む」 | **本文の中**（末尾） | **切ってある本文を全部読む** |
 *
 * 記号を「この行を開く」と読むと、本文と子が一緒に出入りすることになり、**ツールを
 * 何本も呼んだターンを畳んで会話だけ追う**という読み方ができなくなる。「まだ出して
 * いないものを出す」と読み直すと、種別ごとの違いが例外ではなく帰結になる。
 *
 * | 種別 | 本文 | 記号が出すもの |
 * |---|---|---|
 * | 利用者・アシスタント | **常に出す**（整形）。長ければ畳んで「続きを読む」 | **無い**（子はまとめ行へ移った） |
 * | 思考 | 畳んでいても**先頭1行**を覗かせる。開けば全文 | 本文（子を持たない） |
 * | まとめ行 | — | 束ねた活動 |
 * | ツールコール・不明 | — | 中身と子 |
 * | サブエージェント | — | 子 |
 *
 * # 見出しと吹き出し（イシューグループ_2026-0820-2129 設計§5）
 *
 * **絵文字は使わない。** 種別の読み分けは、利用者＝**右寄せの吹き出し**、アシスタント＝
 * **見出しごと無しの太く明るい本文**、それ以外＝**見出しのラベルと色**の3通りで作る。
 * **主従はウェイトと明度で付ける**ので、箱にも罫線にも頼らない。
 */

import { memo, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { HunkTokens } from 'react-diff-view'
import { Diff, Hunk } from 'react-diff-view'
import type { CardId, Node } from '@/lib/protocol'
import { countChanges, toDiffSource } from '@/lib/diff'
import { tokenizeHunks } from '@/lib/highlight'
import {
  REHYPE_PLUGINS,
  REMARK_PLUGINS,
  activitySummary,
  fadeDepth,
  foldDecision,
  foldMarkdownByLines,
  summarizeInput,
} from '@/lib/markdown'
import type { ActivityRow, FlatRow, NodeRow, RewoundRow } from '@/stores/transcript'

interface Props {
  cardId: CardId
  row: FlatRow
  /** 行そのものを渡す。巻き戻しの見出し行はノードではないので、IDでは足りない */
  onToggle: (row: FlatRow) => void
  /** 本文の開け閉め。子を出す操作とは別 */
  onToggleBody: (row: NodeRow) => void
}

/**
 * 種別ごとの見出し（ラベルと色）。
 *
 * **絵文字は使わない**（設計§5-1）。`DESIGN.md` §14.4 が正式 UI に OS 絵文字を使わないと
 * 定めており、行の見た目を作り直す今回は §35 の言う「新しく書くコード」に当たる。
 *
 * **発言には見出しが無い**（[`showsHeading`]）。利用者は右の吹き出し、アシスタントは
 * 本文そのもので読み分ける（設計§5-3）。
 */
function heading(node: Node): { label: string; tone: string } {
  switch (node.kind) {
    case 'user_message':
      return { label: 'あなた', tone: 'text-sky-300' }
    case 'assistant_text':
      return { label: 'アシスタント', tone: 'text-emerald-300' }
    case 'thinking':
      return { label: '思考', tone: 'text-muted-foreground' }
    case 'tool_call':
      return { label: node.name, tone: 'text-violet-300' }
    case 'subagent':
      return { label: `サブエージェント ${node.agent_type}`, tone: 'text-amber-300' }
    case 'unknown':
      return { label: `未知のレコード（${node.record_type}）`, tone: 'text-orange-300' }
  }
}

/**
 * 見出しの行を出す種別か（設計§5-3）。
 *
 * **発言には出さない。** 利用者の発言は右寄せの吹き出しで、アシスタントの本文は
 * 太く明るい本文そのもので読み分ける——**主従はウェイトと明度で付ける**ので、
 * 箱にも罫線にも頼らない。
 */
function showsHeading(node: Node): boolean {
  return node.kind !== 'user_message' && node.kind !== 'assistant_text'
}

/**
 * 開け閉めの記号（設計§5-2）。
 *
 * **テキストのすぐ後ろに置く。** 右端揃えにすると、深いところで字下げが積み上がった
 * ときに尻の記号が潰れ、横並び（PJT 専用画面）では列が狭くてテキストと遠く離れる。
 */
function chevron(expanded: boolean): string {
  return expanded ? '⌄' : '›'
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

/** 本文を常に出す種別か（＝開け閉めが子だけを担う種別か）。 */
function showsBodyAlways(node: Node): boolean {
  return node.kind === 'user_message' || node.kind === 'assistant_text'
}

/**
 * 畳んだ思考に覗かせる先頭1行（設計§8）。
 *
 * **長さで畳む側へは入れない。** 短い思考まで出っぱなしになると会話の本文と
 * 見分けが付かなくなる（直前の工事の判断）ので、常に1行だけにする。
 */
function firstLine(text: string): string {
  const trimmed = text.trimStart()
  const cut = trimmed.indexOf('\n')
  return cut < 0 ? trimmed : trimmed.slice(0, cut)
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
  if (row.kind === 'activity') {
    return <ActivityHeader row={row} onToggle={() => onToggle(row)} />
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
        {/* 記号は他の行と揃えて**テキストの直後**に置く（設計§5-2） */}
        <span aria-hidden className="shrink-0">
          ⟲
        </span>
        <span className="shrink-0 font-medium text-slate-400">
          巻き戻し前のやりとり {row.count}件
        </span>
        <span className="text-muted-foreground min-w-0 shrink truncate">
          {row.expanded ? '' : '（クリックで表示）'}
        </span>
        <span aria-hidden className="text-muted-foreground shrink-0 text-xs">
          {chevron(row.expanded)}
        </span>
      </button>
    </div>
  )
}

/**
 * 発言と発言の間の活動をまとめた行（設計§2・§3）。
 *
 * **ツール名を出さず、「やったこと」を過去形で書く。** 文言の組み立ては
 * `activitySummary()`（`lib/markdown.ts`）が持つ——**画面を描かずに機械で確かめられる
 * 判断**なので、部品側には置かない（設計§4-5）。
 *
 * **箱に入れない。** 吹き出しは利用者の発言だけに使い、活動は通常のウェイトと
 * くすんだ前景色で従に見せる（設計§5-3）。
 */
function ActivityHeader({ row, onToggle }: { row: ActivityRow; onToggle: () => void }) {
  return (
    <div
      data-testid="transcript-row"
      data-kind="activity"
      data-depth={row.depth}
      data-expanded={row.expanded}
      data-member-count={row.members.length}
      style={{ paddingLeft: `${row.depth * 1.25}rem` }}
      className="border-border/40 border-b py-1 text-sm"
    >
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-muted/40 flex w-full items-start gap-2 rounded px-1 text-left"
      >
        <span className="text-muted-foreground min-w-0 shrink truncate">
          {activitySummary(row.counts)}
        </span>
        {row.diff && (
          <span data-testid="activity-diff" className="shrink-0 text-xs">
            <span className="text-emerald-400">+{row.diff.added}</span>{' '}
            <span className="text-red-400">-{row.diff.removed}</span>
          </span>
        )}
        <span aria-hidden className="text-muted-foreground shrink-0 text-xs">
          {chevron(row.expanded)}
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
  const { label, tone } = heading(row.node)
  const mark = toolMark(row.node)
  const alwaysBody = showsBodyAlways(row.node)
  const withHeading = showsHeading(row.node)
  const isUser = row.node.kind === 'user_message'
  // 思考は畳んでいても先頭1行を覗かせる（設計§8）。開くまで中身の見当がつかない行を残さない
  const peeking = row.node.kind === 'thinking'

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
      {withHeading && (
        <button
          type="button"
          disabled={!row.expandable}
          onClick={onToggle}
          className="hover:bg-muted/40 flex w-full items-start gap-2 rounded px-1 text-left disabled:cursor-default"
        >
          <span className={`shrink-0 font-medium ${tone}`}>{label}</span>
          {mark && (
            <span
              data-testid="tool-status"
              className={row.node.kind === 'tool_call' && row.node.status === 'error' ? 'text-red-400' : 'text-muted-foreground'}
            >
              {mark}
            </span>
          )}
          <span className="text-muted-foreground min-w-0 shrink truncate">{summary(row.node)}</span>
          {/* 記号は**テキストのすぐ後ろ**。右端へ寄せない（設計§5-2） */}
          {row.expandable && (
            <span aria-hidden className="text-muted-foreground shrink-0 text-xs">
              {chevron(row.expanded)}
            </span>
          )}
        </button>
      )}

      {/* 本文を持つ種別は開け閉めに関わらず常に出す。ここを `row.expanded` で囲うと、
          子を畳んだ瞬間に本文まで消えて操作が1つに戻ってしまう */}
      {(alwaysBody || peeking || row.expanded) &&
        (isUser ? (
          // 利用者の発言だけを右寄せの吹き出しにする（設計§5-3）。幅いっぱいにすると
          // 右寄せであることが読み取れなくなるので、本文の70%を上限にする
          <div className="flex justify-end">
            <div
              data-testid="user-bubble"
              // **フェードの地を渡す必要は無い**（設計§6-2）。マスクは文字を透明にする
              // だけなので、透けるのは実際にこの吹き出しの地である
              className="bg-muted/60 mt-1 max-w-[70%] rounded-2xl px-3 py-2"
            >
              <RowBody node={row.node} cardId={cardId} row={row} onToggleBody={onToggleBody} />
            </div>
          </div>
        ) : (
          <RowBody node={row.node} cardId={cardId} row={row} onToggleBody={onToggleBody} />
        ))}
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
      // 発言は**主**。太めのウェイトと明るい前景色で、活動の行と読み分ける（設計§5-3）
      return (
        <MarkdownBody
          text={node.text}
          row={row}
          inset={false}
          tone="text-foreground font-medium"
          onToggleBody={onToggleBody}
        />
      )
    case 'thinking':
      // 思考は長さで畳む相手にしない（開いた時点で全文。設計§2-4）。畳んでいるあいだは
      // 先頭1行だけを覗かせる（設計§8）——開くまで中身の見当がつかない行を残さないため
      return (
        <MarkdownBody
          text={row.expanded ? node.text : firstLine(node.text)}
          row={null}
          inset
          tone="text-muted-foreground"
          onToggleBody={onToggleBody}
        />
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
  inset,
  tone,
  onToggleBody,
}: {
  text: string
  /** 畳む相手なら行を渡す。畳まない種別（思考）は `null` */
  row: NodeRow | null
  /** 見出しの行がある種別だけ、見出しのぶん字下げする */
  inset: boolean
  /** 主従を付けるウェイトと明度（設計§5-3） */
  tone: string
  onToggleBody: () => void
}) {
  const folded = row?.foldable === true && !row.bodyOpen
  const body = folded ? foldMarkdownByLines(text, foldDecision(text).lines).head : text
  // 畳んだときだけ末尾をフェードさせる（設計§6-4）。`fadeDepth` は畳まない本文へ `null` を
  // 返すので、**猶予に入って畳まなかった本文にも出ない**——ここで条件を書き足さないこと
  const fade = folded ? fadeDepth(text) : null

  return (
    <div className={inset ? 'mt-1 ml-6' : 'mt-1'}>
      {/* 本文は**主役**なので、地の色で出す（`FileView` と同じ扱い）。
          要約を横に出していた頃の名残で薄い色にしていると、見出しも強調も
          本文と同じ灰色になって、整形した意味がほとんど消える（実物で確認） */}
      <div
        data-testid="row-body"
        data-fade={fade ?? undefined}
        className={`prose-dashboard text-xs leading-relaxed ${tone}${fade ? ` body-fade body-fade-${fade}` : ''}`}
      >
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

/**
 * ツールコールの中身（設計§7-1）。
 *
 * **「入力」と「結果」を分けて書くことは残し、畳むのをやめた。** 分けてあること自体は
 * 利用者が要ると言っているもので、畳みだけが要らない。
 *
 * **外すともう1つ直る。** `<details>` はブラウザが持つ状態なので、仮想化で画面外へ出て
 * DOM が消えると開閉が失われる。畳まなければ、その食い違いも消える。
 *
 * 長い出力は**箱の中でスクロールさせる**（`max-h-64`）。外へ伸びないので行の高さが
 * 暴れず、文字数そのものの上限は要らない（パーサ側が既に 256KB で切り詰めている）。
 */
function ToolCallBody({ input, result }: { input: unknown; result: unknown }) {
  const diff = toDiffSource(result)

  return (
    <div className="mt-1 ml-6 space-y-2">
      <div>
        <div className="text-muted-foreground text-xs">入力</div>
        <pre className="text-muted-foreground max-h-64 overflow-auto text-xs">
          {JSON.stringify(input, null, 2)}
        </pre>
      </div>

      {diff ? (
        <DiffView diff={diff} />
      ) : (
        result != null && (
          <div>
            <div className="text-muted-foreground text-xs">結果</div>
            <pre className="text-muted-foreground max-h-64 overflow-auto text-xs">
              {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
            </pre>
          </div>
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
