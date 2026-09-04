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
import { HostFsError, readBlob } from '@/lib/hostfs'
import { hostOf } from '@/lib/reviveBudget'
import { useSessionCard } from '@/stores/sessions'
import { countChanges, toDiffSource } from '@/lib/diff'
import { tokenizeHunks } from '@/lib/highlight'
import {
  REHYPE_PLUGINS,
  REMARK_PLUGINS,
  activitySummary,
  fadeDepthOf,
  foldDecisionOf,
  foldMarkdownByLines,
  summarizeInput,
} from '@/lib/markdown'
import { bodyTextOf, isMachine, originLabel, originOf } from '@/lib/messageOrigin'
import type { ActivityRow, FlatRow, NodeRow, QueuedMoreRow, RewoundRow } from '@/stores/transcript'

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
    // **待ちも利用者の発言である**（作業中に送った追加メッセージ 設計§7-1・
    // 2026-09-05 に作り直し）。読まれれば同じ文がこの種別で出てくるので、
    // **読まれる前と後で名乗りを変えない**。
    //
    // どちらも [`showsHeading`] が偽なので**この値は描かれない**。switch が総当たりを
    // 求めるので置いてあるだけで、**ここへ「待機中」と書き足さないこと**——状態は
    // 色で伝えると決めた（要件1-4）
    case 'queued_message':
      return { label: 'あなた', tone: 'text-sky-300' }
    case 'assistant_text':
      return { label: 'アシスタント', tone: 'text-emerald-300' }
    case 'thinking':
      return { label: '思考', tone: 'text-muted-foreground' }
    case 'tool_call':
      // **活動の行は暗く**（要望1・設計§12-1）。発言との主従を、明度でさらに開ける
      return { label: node.name, tone: 'text-violet-300/60' }
    case 'subagent':
      return { label: `サブエージェント ${node.agent_type}`, tone: 'text-amber-300' }
    case 'image':
      return { label: '画像', tone: 'text-sky-300' }
    case 'unknown':
      // 同上。**未知のレコードは、いちばん静かでよい**（読む相手が居ないことのほうが多い）
      return { label: `未知のレコード（${node.record_type}）`, tone: 'text-orange-300/60' }
  }
}

/**
 * 見出しの行を出す種別か（設計§5-3）。
 *
 * **発言には出さない。** 利用者の発言は右寄せの吹き出しで、アシスタントの本文は
 * 太く明るい本文そのもので読み分ける——**主従はウェイトと明度で付ける**ので、
 * 箱にも罫線にも頼らない。
 *
 * **待ちにも出さない**（作業中に送った追加メッセージ 設計§7-1・2026-09-05 に作り直し）。
 * 「待機中」というラベルも `…` の記号も出さず、**状態は吹き出しの地の色だけで言う**
 * （要件1-4）。位置（常にいちばん下）と色の2つで読めるので、語は要らない。
 */
function showsHeading(node: Node): boolean {
  return (
    node.kind !== 'user_message' &&
    node.kind !== 'assistant_text' &&
    node.kind !== 'queued_message'
  )
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

/**
 * ツールの状態を1文字で表す。
 *
 * **待ちには出さない**（作業中に送った追加メッセージ 設計§7-2・2026-09-05 に作り直し）。
 * 一時は `…` を借りていたが、待ちは**見出しごと持たない**器（吹き出し）へ移ったので、
 * 記号を置く場所そのものが無くなった。状態は色で言う（要件1-4）。
 */
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
    // 待ちも本文を常に全部出す器（吹き出し）に入ったので、要約する相手ではなくなった。
    // そもそも [`showsHeading`] が偽なので、この値は描かれない
    case 'queued_message':
      return ''
    case 'tool_call':
      return summarizeInput(node.input)
    case 'subagent':
      return `深さ ${node.spawn_depth}`
    case 'image':
      // **元の名前を出す**（画像添付 設計§10-1）。ディスク上は採番した名前なので、
      // それを出しても押した人には何のことか分からない
      return node.file_name ?? ''
    case 'unknown':
      return ''
  }
}

/** 本文を常に出す種別か（＝開け閉めが子だけを担う種別か）。 */
function showsBodyAlways(node: Node): boolean {
  return (
    node.kind === 'user_message' ||
    node.kind === 'assistant_text' ||
    // **待ちも常に出す**（作業中に送った追加メッセージ 設計§7-1・2026-09-05 に作り直し）。
    // 先頭1行だけを覗かせる扱いをやめ、**利用者の発言とまったく同じ道**を通す
    // ——長ければ「続きを読む」で畳む。独自の規則を作らない（要件1-2）
    node.kind === 'queued_message' ||
    // 画像も常に出す。**畳んで名前だけにすると、何を送ったのかが読めない**
    // ——絵そのものが本文にあたる種別である（画像添付 設計§10-3）
    node.kind === 'image'
  )
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
  // **`FlatRow` を増やしたら、必ずここへ腕を足す。** この並びは `if` で書かれていて
  // 最後が `NodeRowView` へ落ちるので、**型検査では捕まらない**（新しい行が
  // `row.node` の無いまま流れ込む）
  if (row.kind === 'queued-more') {
    return <QueuedMore row={row} />
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
 * 出し切らなかった待ちの数だけを言う行
 * （作業中に送った追加メッセージ 設計§7-3 の天井）。
 *
 * **開けない。** 待ちは数秒で消えるものなので、全部読む道を作っても読み終わる前に
 * 入れ替わる。**押せないものを押せる顔にしない**ので、記号も出さない。
 *
 * **吹き出しにしない。** ここは件数を言うだけの静かな行で、**待ちそのものではない**
 * ——器を与えると、出し切らなかったぶんが1件の指示に見える。
 *
 * **置き場所は待ちの塊の中**（`stores/transcript.ts` の `pushQueued`）。塊ごと画面の
 * いちばん下へ回るので、**この行だけが届いた順の位置に取り残されることは無い**。
 */
function QueuedMore({ row }: { row: QueuedMoreRow }) {
  return (
    <div
      data-testid="transcript-row"
      data-kind="queued-more"
      data-count={row.count}
      className="text-muted-foreground py-1 pl-1 text-sm"
    >
      ほか {row.count} 件が待っています
    </div>
  )
}

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
      data-expandable="true"
      data-expanded={row.expanded}
      className="py-1 text-sm"
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
      data-expandable="true"
      data-expanded={row.expanded}
      data-member-count={row.members.length}
      style={{ paddingLeft: `${row.depth * 1.25}rem` }}
      className="py-1 text-sm"
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
  // 思考は畳んでいても先頭1行を覗かせる（設計§8）。開くまで中身の見当がつかない行を残さない。
  //
  // **待ちはここに入らなくなった**（2026-09-05）。本文を常に全部出す側
  // （[`showsBodyAlways`]）へ移ったので、覗かせる必要そのものが消えた
  const peeking = row.node.kind === 'thinking'

  return (
    <div
      data-testid="transcript-row"
      data-kind={row.node.kind}
      data-depth={row.depth}
      // **開けるかどうかを出す。** `data-expanded` は開けない行でも `true` になりうるので、
      // これだけを見て「開いている」と読むと**ほぼ全部の行に当たる**（実際に踏んだ——
      // Selected の印が全行に付き、「選ばれたもの」を示さなくなっていた）
      data-expandable={row.expandable}
      data-expanded={row.expanded}
      data-foldable={row.foldable}
      data-body-open={row.bodyOpen}
      // 入れ子の深さは余白で見せる。1段あたり 1.25rem
      style={{ paddingLeft: `${row.depth * 1.25}rem` }}
      className="py-1 text-sm"
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
      {/* **器の作り分けは `MarkdownBody` が持つ**（フェーズ11・設計§6-7-2）。帯を器そのものへ
          敷くようになったので、器を知っているのは帯を出す側でなければならない——ここで
          吹き出しを巻くと、**帯を出す判断と器が別の部品に分かれて必ずずれる** */}
      {(alwaysBody || peeking || row.expanded) && (
        <RowBody node={row.node} cardId={cardId} row={row} onToggleBody={onToggleBody} />
      )}
    </div>
  )
}

/**
 * 送った画像を出す（画像添付 設計§10-3）。
 *
 * **`Node` に絵は載っていない。** 載っているのは置き場所だけなので、ここで
 * **生ファイルの口から取り返す**——履歴を配るたびに画像が線に乗るのを避けるための
 * 分け方で、`FileView` が画像を出すのと同じ道である。
 *
 * **`<img src>` に口の URL を直に渡さない。** `<img>` の失敗は理由を運べないので、
 * 断られたのか壊れているのかを画面が言えなくなる（`readBlob` が先に状態を見る）。
 *
 * # 消えた添付は「読めません」と言い分ける
 *
 * 添付は3カ月で掃かれるが、**記録には置き場所が残り続ける**（掃除は記録を触らない）。
 * だから古い履歴を開くと 404 になる。これは壊れているのではなく**期限が来ただけ**
 * なので、そう言う（§10-5）。
 */
function ImageBody({
  node,
  cardId,
}: {
  node: Extract<Node, { kind: 'image' }>
  cardId: CardId
}) {
  const session = useSessionCard(cardId)
  const host = hostOf(session?.agent_id)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const path = node.path

  useEffect(() => {
    if (path === null) {
      return
    }
    // **前のぶんを戻してから読みに行く。** 戻さないと、一度失敗した行が
    // `host` の変化で読み直せても「読めませんでした」を出したままになる
    // （描画が `error !== null` で先に返るため）。`url` も同じで、後始末が古い
    // `blob:` を捨てたあとに残っていると、**捨てた URL を `<img src>` へ渡す**。
    //
    // `host` は `useSessionCard(cardId)` から引くので、**カードがストアへ入る前に
    // 一度描画される**経路が現にある——絵に描いた餅ではない
    setError(null)
    setUrl(null)
    let alive = true
    let made: string | null = null
    void (async () => {
      try {
        const found = await readBlob(host, path)
        made = found.url
        if (alive) {
          setUrl(found.url)
        } else {
          URL.revokeObjectURL(found.url)
          made = null
        }
      } catch (err) {
        if (alive) {
          setError(
            err instanceof HostFsError && err.status === 404
              ? 'この画像は保管期間を過ぎました'
              : err instanceof Error
                ? err.message
                : '画像を読めませんでした',
          )
        }
      }
    })()
    return () => {
      alive = false
      // **作った URL は必ず捨てる。** 忘れると、開くたびにブラウザの中で溜まる
      if (made !== null) {
        URL.revokeObjectURL(made)
      }
    }
  }, [host, path])

  // 置き場所そのものが無い（claude がクリップボードから直に受けた画像。§21 読み替え1）。
  // **絵は出せないが、画像があったことは出せる**
  if (path === null) {
    return (
      <p className="text-muted-foreground mt-1 ml-6 text-xs">
        画像（この画像は手元に残っていません）
      </p>
    )
  }
  if (error !== null) {
    return (
      <p className="text-muted-foreground mt-1 ml-6 text-xs">{error}</p>
    )
  }
  if (url === null) {
    return (
      <p className="text-muted-foreground mt-1 ml-6 text-xs">読み込み中…</p>
    )
  }
  return (
    <img
      src={url}
      alt={node.file_name ?? '添付した画像'}
      className="mt-1 ml-6 max-h-96 max-w-full rounded border border-border object-contain"
    />
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
  switch (node.kind) {
    case 'user_message':
    // **待ちも同じ腕を通す**（作業中に送った追加メッセージ 設計§7-1・2026-09-05 に
    // 作り直し）。待ちは**まだ読まれていない利用者の発言**そのものなので、
    // 器・畳み方・しきい値のどれも別立てにしない（要件1-1・1-2）。
    //
    // **待ちであることは、器の地の色だけで言う**——[`MarkdownBody`] が
    // `speech-bubble-queued` を足し、`index.css` が `--bubble-ground` を青から
    // 灰色側へ寄せた値へ差し替える。**派生元を差し替える形にしてある**ので、
    // 吹き出しの中の囲みコード・表・引用も自動で付いてくる（要件1-3）
    case 'queued_message':
    case 'assistant_text':
      // 発言は**主**。太めのウェイトと明るい前景色で、活動の行と読み分ける（設計§5-3）
      //
      // **器は種別で分ける**（フェーズ11・設計§6-7-2）。利用者は吹き出し、アシスタントは
      // 平たい器。**アシスタントにも器を用意する**のは、帯を器そのものへ敷くようになった
      // ためで、無いと帯がページの地へ直に透ける（要望③の実体）。**片方だけ直さないこと**
      return (
        <MarkdownBody
          // **スラッシュコマンドは、打った形のうしろに展開を継いだものが本文**になる
          // （設計§6-8）。継ぐ判断は `bodyTextOf` が持つ——ここで `if` を書かない
          text={bodyTextOf(node)}
          row={row}
          inset={false}
          shell={node.kind === 'assistant_text' ? 'panel' : 'bubble'}
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
          shell="none"
          tone="text-muted-foreground"
          onToggleBody={onToggleBody}
        />
      )
    case 'tool_call':
      return <ToolCallBody input={node.input} result={node.result} />
    case 'image':
      return <ImageBody node={node} cardId={cardId} />
    case 'unknown':
      return (
        <pre className="row-shell text-muted-foreground mt-1 ml-6 max-h-64 overflow-auto text-xs">
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
  shell,
  tone,
  onToggleBody,
}: {
  text: string
  /** 畳む相手なら行を渡す。畳まない種別（思考）は `null` */
  row: NodeRow | null
  /** 見出しの行がある種別だけ、見出しのぶん字下げする */
  inset: boolean
  /**
   * 帯を敷く器（フェーズ11・設計§6-7-2）。
   *
   * **帯は器そのものに敷く。** 本文の箱に敷くと、吹き出しの内側余白のぶんだけ
   * 左右と下が届かず、「中に貼った紙」に見える（要望①の実体）。
   */
  shell: 'bubble' | 'panel' | 'none'
  /** 主従を付けるウェイトと明度（設計§5-3） */
  tone: string
  onToggleBody: () => void
}) {
  // 畳んでいる行だけを持つ。**種別を引くために行そのものが要る**——1段目は器ごとに
  // 違う（設計§4-6）ので、判断する純関数に `kind` を渡す。**ここで `if (isUser)` を
  // 書かないこと**——しきい値の在り処が2つになる（設計§4-5）
  const foldedRow = row?.foldable === true && !row.bodyOpen ? row : null
  const body = foldedRow
    ? foldMarkdownByLines(text, foldDecisionOf(foldedRow.node).lines).head
    : text
  // 畳んだときだけ末尾をフェードさせる（設計§6-4）。`fadeDepthOf` は畳まない本文へ `null` を
  // 返すので、**猶予に入って畳まなかった本文にも出ない**——ここで条件を書き足さないこと
  const fade = foldedRow ? fadeDepthOf(foldedRow.node) : null

  // **帯の高さの段は器が持つ**（設計§6-7-2）。`--fade-band` は `.body-fade` が定義して
  // 子へ継承させるので、器へ載せれば内側の `.body-fade-text` にもそのまま届く
  const fadeClass = fade ? ` body-fade body-fade-${fade}` : ''

  // まだ読まれていない待ちか（作業中に送った追加メッセージ 設計§7-1・2026-09-05）。
  //
  // **色は `index.css` が持つ。** ここで足すのはクラス1つだけで、値は1文字も書かない
  // ——`--bubble-ground` を1箇所で持つ約束（`index.css` の `.speech-bubble`）が、
  // 本体としっぽと中の面の全部を同時に動かす仕掛けである
  const queued = row?.node.kind === 'queued_message'
  const queuedClass = queued ? ' speech-bubble-queued' : ''

  // 人が打っていないものか（`人が打っていないものを、人の発言として出さない` 設計§6）。
  //
  // **判断は `messageOrigin.ts` の純関数が持つ。** ここで `?? 'unmarked'` を書かない
  // ——既定への倒し込みが2箇所になる（設計§2-5）
  const machine = row != null && isMachine(row.node)
  const label = row != null && machine ? originLabel(originOf(row.node)) : ''

  const inner = (
    <>
      {/* 本文は**主役**なので、地の色で出す（`FileView` と同じ扱い）。
          要約を横に出していた頃の名残で薄い色にしていると、見出しも強調も
          本文と同じ灰色になって、整形した意味がほとんど消える（実物で確認） */}
      {/* **層を2つに分ける**（設計§6-6）。`mask-image` は**その要素の擬似要素にも効く**ので、
          マスクを掛けた要素へ色のティントを足すと、**帯がいちばん濃くあるべき末尾で、
          ティントごと消される**。外（器）が色、中（本文）が文字を消すマスク。

          **`prose-dashboard` は内側のまま**にする。`> :first-child` などが**直下の子**を
          見ているので、間に箱を挟むと余白が変わる */}
      <div
        data-testid="row-body"
        data-fade={fade ?? undefined}
        // **ウェイトと色はここに残す**（継承するので内側でも効く）。行の主従を読む側は
        // `row-body` を見るので、ここから動かすと「発言が強い」の検査が空振りする
        className={tone}
      >
        <div className={`prose-dashboard text-xs leading-relaxed${fade ? ' body-fade-text' : ''}`}>
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
            {body}
          </ReactMarkdown>
        </div>
      </div>
      {/* **帯そのものを押せるようにする**（設計§6-7-5・要望10）。畳んでいるあいだだけ、
          帯の**下9割**に押す面を1枚重ねる。**擬似要素では押せない**ので実要素で足す
          （フェーズ11 で実測。`elementFromPoint` の返り先にならない）。

          **上1割は残す。** 帯の上端はほぼ透明で本文と見分けが付かないので、そこまで
          押せるようにすると**本文を読むためのクリックが開く操作になる** */}
      {row?.foldable === true && fade && (
        <div
          data-testid="body-hitbox"
          aria-hidden
          onClick={onToggleBody}
          className="body-hitbox"
        />
      )}
      {row?.foldable === true && (
        <button
          type="button"
          data-testid="body-toggle"
          onClick={onToggleBody}
          // **ただの文字にする**（要望10）。地・枠・影・角丸は持たない——押せることは
          // **面の広さと文字の大きさ**が伝える（`DESIGN.md` §13.2 の Main Item へ上げてある）。
          //
          // 畳んでいるあいだは帯の上へ重ね、**左右中央・帯の中央よりやや下**に置く。
          // 開いているときは重ねる相手が無いので流れの中に置く
          // **明るく出す。** プレートを外した以上、地を持たないぶんを**コントラストで
          // 読ませる**しかない——くすんだ色のままだと、薄れかけの本文と混ざって
          // 読めなくなる（狭い窓で実際にそうなった）。装飾ではなく可読性の手当てである
          // **行の高さを詰める**（`leading-none`）。既定の行送りだと箱が 20px になり、
          // **いちばん浅い段の帯（1行＝19.5px）より背が高くなって、帯からはみ出す**——
          // 狭い窓ではフェード中の最終行と重なった。字の大きさは変えずに箱だけ詰めれば、
          // どの段でも帯の中へ収まり、「中央よりやや下」も成立する
          // **開いているときも左右中央**（要望11）。**浮かせない**——帯が無いので重ねる
          // 相手が無い（設計§6-7-3）。流れの中で中央に置き、**上の余白は倍**（`mt-2`）
          className={`text-foreground body-toggle text-sm leading-none font-medium${
            fade ? ' body-toggle-float' : ' mx-auto mt-2 block'
          }`}
        >
          {row.bodyOpen ? '畳む' : '続きを読む'}
        </button>
      )}
    </>
  )

  if (shell === 'bubble') {
    // 利用者の発言だけを右寄せの吹き出しにする（設計§5-3）。幅いっぱいにすると
    // 右寄せであることが読み取れなくなるので、本文の70%を上限にする
    // **しっぽの分だけ右を空ける**（設計§5-4）。しっぽは吹き出しの右外へ出るので、
    // 空けないと窓の端で切れる
    //
    // **まだ読まれていない待ちも、この器に入る**（作業中に送った追加メッセージ
    // 設計§7-1・2026-09-05）。**足すのは1クラスだけ**で、形も幅もしっぽも動かさない
    // ——動かすと、読まれた瞬間に同じ文の見た目が変わってしまう（要件1-6）
    // **人が打っていないものは、逆側（左）から出す**（利用者の指定・設計§6-4）。
    // しっぽの向きと角丸も左右を入れ替える——`.speech-bubble-machine` が持つ
    return (
      <div className={machine ? 'flex justify-start pl-2' : 'flex justify-end pr-2'}>
        <div
          data-testid="user-bubble"
          // 読まれる前かどうかを、機械が読める形でも出す。**色だけを見て確かめると、
          // 派生の計算（`color-mix`）まで背負うことになる**
          data-queued={queued ? 'true' : undefined}
          // 誰が入れたかも、機械が読める形で出す（色と位置を見て確かめずに済む）
          data-origin={row != null && machine ? originOf(row.node).kind : undefined}
          // **フェードの地を渡す必要は無い**（設計§6-2）。ティントは半透明なので、
          // 透けるのは実際にこの吹き出しの地である。
          //
          // 角丸としっぽは `.speech-bubble` が持つ（設計§5-4）。**地の色もあちらが
          // 1箇所で持つ**ので、ここで `bg-*` を重ねないこと——2箇所になった時点でずれる
          className={`speech-bubble row-shell mt-1 max-w-[70%] px-3 py-2${
            machine ? ' speech-bubble-machine' : ''
          }${queuedClass}${fadeClass}`}
        >
          {/* **誰が入れたかを名乗らせる**（利用者の指定・設計§1-1）。開かないと
              出どころが分からない状態にしない。**この1行は本文の外**なので、
              畳みの行数には数えない */}
          {label !== '' && (
            <div data-testid="origin-label" className="mb-1 text-[11px] font-medium text-amber-200/80">
              {label}
            </div>
          )}
          {inner}
        </div>
      </div>
    )
  }

  if (shell === 'panel') {
    // アシスタントの器。**吹き出しより弱い地**にして、誰の発言かをシルエットで
    // 読み分ける仕掛け（設計§5-3）を壊さない
    return <div className={`body-shell row-shell mt-1${fadeClass}`}>{inner}</div>
  }

  return <div className={inset ? 'row-shell mt-1 ml-6' : 'row-shell mt-1'}>{inner}</div>
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
    <div className="row-shell mt-1 ml-6 space-y-2">
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
