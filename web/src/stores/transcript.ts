/**
 * 構造化ビューの履歴を持つストア（設計§10 の transcriptStore）。
 *
 * # なぜ zustand の中に置かないのか
 *
 * 履歴はツールコールのたびに流れてきて、数千ノードまで育つ。一覧のストア（`stores/ws.ts`）に
 * 同居させると、履歴が1件届くたびに一覧を見ているコンポーネントまで再描画の判定に入る。
 * PTY のバイトを React に通していないのと同じ理由で、ここも **React の外に持って
 * `useSyncExternalStore` で購読する**形にしている。
 *
 * # 追記は「上書き」でもある
 *
 * サーバから来る `transcript_append` は、同じノードIDのものが再び届くことがある
 * （ツールコールは結果が届いてから同じIDで送り直される）。積むのではなく差し替える。
 *
 * # まとめてから反映する
 *
 * 受信はバースト的に来るので、1件ごとに再描画すると描画が追いつかない。
 * `requestAnimationFrame` の周期でまとめてから通知する。
 */

import { useSyncExternalStore } from 'react'
import type { CardId, Node, NodeId, TreeNode } from '@/lib/protocol'
import type { ActivitySummaryInput } from '@/lib/markdown'
import { shouldFoldBody } from '@/lib/markdown'
import { countChanges, toDiffSource } from '@/lib/diff'

/** ツリーの1ノードに対応する行。 */
export interface NodeRow {
  kind: 'node'
  id: NodeId
  node: Node
  /** 入れ子の深さ（インデントに使う） */
  depth: number
  /** 開け閉めできるか */
  expandable: boolean
  expanded: boolean
  /** 子を持っているか（開いても中身が無い場合と区別する） */
  hasChildren: boolean
  /**
   * 本文がしきい値を超えるか（＝畳む相手か）。
   *
   * 長さの判断を**行が持つ**ので、描く側は本文の長さを知らなくてよい。
   * 本文を持たない種別（ツールコール・サブエージェント）では常に偽になる。
   */
  foldable: boolean
  /** 本文を開いているか。[`foldable`] が偽なら意味を持たない */
  bodyOpen: boolean
}

/**
 * 巻き戻して分岐する前のやりとりをまとめた見出し行（設計§16）。
 *
 * `/rewind` は JSONL を物理的に巻き戻さず同じファイルに追記するので、巻き戻して
 * 捨てたはずのやりとりが履歴に残り続ける。そのまま全部並べると「巻き戻したのに前の
 * やりとりが見えている」という見え方になるため、**既定では畳んでおく**。
 * 消してしまわないのは、何をやり直したのかを後から追えるようにするため。
 */
export interface RewoundRow {
  kind: 'rewound'
  id: string
  /** 畳んでいる根の数 */
  count: number
  expanded: boolean
}

/**
 * 発言と発言の間の活動を1行に束ねた行（設計§2）。
 *
 * 実ノードと1対1に対応しない合成行で、[`RewoundRow`] と同じ格好をしている。
 * 束ねる相手は**ツールコールと未知のレコードだけ**——発言・思考・サブエージェントは
 * 入らない（[`isActivity`]）ので、発言がそのまま境目になる。
 */
export interface ActivityRow {
  kind: 'activity'
  /** 束ねた中身が変わらない限り不変であること（設計§2-2） */
  id: string
  /** 束ねた子のIDの並び。開いたときはこの順で出す */
  members: NodeId[]
  /** 束ねた子と同じ深さ。**開いても増やさない**（設計§2-4） */
  depth: number
  expanded: boolean
  /** 種類ごとの件数。文言は `activitySummary()` が組み立てる（設計§3-1） */
  counts: ActivitySummaryInput
  /** 子の差分の合計（設計§3-2）。編集を1つも含まなければ `null` */
  diff: { added: number; removed: number } | null
}

/** ツリーを平らに並べた1行分。仮想化はこの配列に対して行う。 */
/**
 * 待ちが続いたときに、出し切らずに残りの数だけを言う行
 * （作業中に送った追加メッセージ 設計§7-3 の天井）。
 *
 * **実測では、ほとんど出ない。** 待ち行列の深さは9割方1で、3以上は数%しか無い。
 * これは**模型が破綻したときに画面が埋まるのを止める歯止め**であって、
 * 普段の見え方を決めるものではない。
 *
 * **開けない。** 開く道を作ると「待ちを全部読む」という用途が生まれるが、
 * 待ちは数秒で消えるものなので、読み終わる前に行が入れ替わる。
 */
export interface QueuedMoreRow {
  kind: 'queued-more'
  id: string
  /** 出さなかった件数 */
  count: number
}

/** ツリーを平らに並べた1行分。仮想化はこの配列に対して行う。 */
export type FlatRow = NodeRow | RewoundRow | ActivityRow | QueuedMoreRow

/**
 * 続けて出す待ちの上限（設計§7-3 の天井）。
 *
 * **ゼロにしない。** 同じ場所の床が「最低1行は必ず行として出す」と定めている——
 * 弱くする規則だけを書くと、実装はゼロへ落ちる（`DESIGN.md` §8.3）。
 */
const MAX_QUEUED_ROWS = 3

/** 「ほか N 件」の行のID。[`ROOT`] と同じ理由で `#` から始める。 */
export const QUEUED_MORE_PREFIX = '#queued-more:'

/**
 * 根の子を入れておくキー。`Map` のキーに `null` を使えないため。
 *
 * `#` で始めるのは、ノードIDが `#` を含まないと決めてあるから（PJTガイドライン。
 * ノードIDは `?before=<id>` の形で URL に載るため `#` を使えない）。実在のIDと
 * ぶつからないことが、この値の唯一の要件になる。
 */
const ROOT = '#root'

/** 巻き戻しの見出し行のID。[`ROOT`] と同じ理由で `#` から始める。 */
export const REWOUND_ROW_ID = '#rewound'

/**
 * まとめ行のIDの接頭辞。[`ROOT`] と同じ理由で `#` から始める。
 *
 * **種にするのは先頭の子のID**である（設計§2-2）。仮想化は `getItemKey` に `row.id` を
 * そのまま渡しており（`TranscriptTree.tsx`）、**同じ行に対して毎回同じ値でないと実測した
 * 高さが捨てられる**——遡っている最中に画面が跳ねる。活動は末尾へ足されるので、先頭の子は
 * 後から増えても変わらない。
 *
 * | 採らない案 | 何が起きるか |
 * |---|---|
 * | 連番 | 上に活動が増えるたび、下のまとめ行の番号が全部ずれる |
 * | 束ねた全IDのハッシュ | 活動が1つ増えるだけで別の行になる（走っているセッションでは増え続ける） |
 *
 * [`REWOUND_ROW_ID`] が固定の文字列でよかったのは、あちらがカードあたり高々1個しか
 * 無いためである。まとめ行は何個も出るので同じ手は使えない。
 */
export const ACTIVITY_ROW_PREFIX = '#activity:'

interface CardState {
  byId: Map<string, TreeNode>
  /** 親ID（根は [`ROOT`]）→ 子IDの並び（届いた順） */
  children: Map<string, string[]>
  expanded: Set<string>
  /**
   * 本文を開いている行。
   *
   * **コンポーネントに置けない。** 構造化ビューは仮想化しているので、画面の外へ出た行は
   * DOM ごと消える。`useState` に置くと遡って戻ってきたときに畳み直され、しかも実測した
   * 高さがそのたびに変わる——**遡っている最中に画面が跳ねる**という、この画面でいちばん
   * 困る形になる。
   */
  bodyOpen: Set<string>
  /**
   * 開いているまとめ行（鍵は [`ACTIVITY_ROW_PREFIX`] で始まる合成ID）。
   *
   * **[`CardState.expanded`] と混ぜない**（設計§2-5）。あちらの鍵は実ノードのIDで、
   * こちらは合成ID——意味が違うものを同じ集合へ入れると、どちらの由来か分からなくなる。
   */
  expandedActivity: Set<string>
  /** 巻き戻し前の枝を開いているか */
  showRewound: boolean
  /** 平らにした結果。変化したら捨てて作り直す */
  flat: FlatRow[] | null
}

const cards = new Map<string, CardState>()
const listeners = new Map<string, Set<() => void>>()

/** rAF でまとめて反映するための待ち行列。 */
const pending = new Map<string, TreeNode[]>()
let scheduled = false

function stateOf(cardId: CardId): CardState {
  let state = cards.get(cardId)
  if (!state) {
    state = {
      byId: new Map(),
      children: new Map(),
      expanded: new Set(),
      bodyOpen: new Set(),
      expandedActivity: new Set(),
      showRewound: false,
      flat: null,
    }
    cards.set(cardId, state)
  }
  return state
}

/** 既定で開いておく種別。会話の本文は開いた状態で見せ、詳細は畳んでおく。 */
function opensByDefault(node: Node): boolean {
  return node.kind === 'user_message' || node.kind === 'assistant_text'
}

/**
 * 常に出す本文を持つ種別か。
 *
 * 思考は**読まなくてよいもの**として既定で畳んである（開けば整形して全文が出る）。
 * 長さで決める規則を当てると短い思考が全部出っぱなしになり、会話の本文と見分けが
 * 付かなくなるので、こちらには入れない。
 */
function hasFoldableBody(node: Node): node is Extract<Node, { kind: 'user_message' | 'assistant_text' }> {
  return node.kind === 'user_message' || node.kind === 'assistant_text'
}

/**
 * 行にせず、並びから落とす思考か（設計§8-2）。
 *
 * **Claude Code が書く JSONL の思考ブロックは、本文が空である。** 入っているのは
 * 暗号化された `signature` だけで、これは次のターンで API へ送り返すために要るもの——
 * 本文は書き出す時点で落とされている。実測すると、CLI の版（2.1.220〜2.1.251）も
 * モデルもまたいで例外が無かった（実セッション 1,555件・フィクスチャ 23件・
 * 走行中の木 409ノードで、**本文があるものは0件**）。
 *
 * 開く操作を出しているのに何も出ない行は、**壊れているのと見分けが付かない**。
 * 残す値も無いので、行にしない。
 *
 * **種別で決め打たず、本文が空かどうかで決める。** Claude Code が本文を書くように
 * なるか、暗号化思考でないモデルを使えば中身は入る。決め打つと**本物の思考まで消え、
 * しかも誰も気づかない**——空で判定しておけば、勝手に元へ戻る。
 *
 * **子を持つものは落とさない。** いまは1件も無いが、パーサは直前に出したノードを
 * 次のレコードの親にするので（`transcript-parser` の `last_emitted`）、**思考が親に
 * なりうる**。落とすと、その子が置き場所を失う。
 */
function droppableThinking(state: CardState, id: string): boolean {
  const node = state.byId.get(id)
  if (node?.node.kind !== 'thinking' || node.node.text.trim() !== '') {
    return false
  }
  return (state.children.get(id) ?? []).length === 0
}

/**
 * 読まれた（あるいは取り消された）待ちの行か（作業中に送った追加メッセージ 設計§4）。
 *
 * **消すのではなく、行にしない。** 単一ノードを消す手段は経路上のどこにも無い
 * （`ParserEvent`・`ServerMessage`・DB・このストア、すべて）。消せる粒度はカード丸ごと
 * だけなので、**ノードは残したまま並びから落とす**——上の中身の無い思考と同じ手である。
 *
 * これで「同じ本文が2つ並ばない」が**約束ではなく機構**になる。読まれると本物の
 * `user` レコードが出るので、待ちを落とさないと**同じ文字が2回並ぶ**。
 */
function droppableQueued(state: CardState, id: string): boolean {
  const node = state.byId.get(id)
  return node?.node.kind === 'queued_message' && node.node.taken
}

/**
 * 行にせず、並びから落とすか。
 *
 * **判断を1箇所にまとめる。** 落とす相手が2種類（中身の無い思考・畳んだ待ち）に増えたが、
 * 呼ぶ側（[`flatten`] の2箇所）はどちらかを知らなくてよい——**散らすと、片方だけ
 * 落とし忘れた並びができる**。
 */
function droppable(state: CardState, id: string): boolean {
  return droppableThinking(state, id) || droppableQueued(state, id)
}

/** 中身を開いて見られる種別か。 */
function isExpandable(node: Node, hasChildren: boolean): boolean {
  if (hasChildren) {
    return true
  }
  // 子が無くても、展開すると中身（入力・結果・差分・生データ）が出るもの。
  // **待ちの行も入る**——畳んでいるあいだは先頭1行だけを覗かせ、開けば全文が出る
  // （作業中に送った追加メッセージ 設計§7-3）
  return (
    node.kind === 'tool_call' ||
    node.kind === 'thinking' ||
    node.kind === 'queued_message' ||
    node.kind === 'unknown'
  )
}

/**
 * まとめ行へ束ねる種別か（設計§2-3）。
 *
 * **発言・思考・サブエージェントは入らない。** 発言が入らないことで「発言と発言の間を
 * 1行にまとめる」が自動的に成立する——パーサが「ツールコールは直前のアシスタント本文の
 * 子」と決めているので、**同じ親の下**＝**発言と発言の間**になる。
 */
function isActivity(node: Node): boolean {
  // **待ちの行は入れない**（作業中に送った追加メッセージ 設計§11-2）。まとめ行へ沈めると
  // 「送ったものが受理された」という手応えが1行の中に埋もれ、出す意味が消える
  return node.kind === 'tool_call' || node.kind === 'unknown'
}

/**
 * ツールの名前から、まとめ行の件数へ振り分ける（設計§3-1）。
 *
 * **名前を持つものは配列、持たないものは件数**で受ける。コマンドに短い名前が無いのが
 * 分かれ目で、この区別は `ActivitySummaryInput` の側が決めている。
 */
function tally(counts: ActivitySummaryInput, node: Node) {
  if (node.kind === 'unknown') {
    counts.unknown += 1
    return
  }
  if (node.kind !== 'tool_call') {
    return
  }
  switch (node.name) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      counts.edited.push(pathOf(node.input, node.name))
      return
    case 'Bash':
      counts.ran += 1
      return
    case 'Read':
      counts.read.push(pathOf(node.input, node.name))
      return
    default:
      counts.used += 1
  }
}

/**
 * 編集・読み取りの相手のパス。
 *
 * 取れなかったらツール名で代える。**空文字を返さない**のは、文言が「編集済み 」で
 * 途切れて何のことか分からなくなるためで、名乗れるものが他に無い以上ツール名が最善である。
 */
function pathOf(input: unknown, fallback: string): string {
  if (typeof input !== 'object' || input === null) {
    return fallback
  }
  const record = input as Record<string, unknown>
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  return fallback
}

/**
 * 子1件ぶんの差分を覚えておく場所。
 *
 * [`flatten`] は `state.flat` が捨てられるたびに**根から全部作り直す**ので、素直に書くと
 * **確定して二度と変わらない古い差分**まで、無関係なノードが1件届くたびに数え直すことに
 * なる（`walkNode` の「ここで実際に切らない」と同じ理屈）。
 *
 * [`upsert`] は更新のたび**新しい `TreeNode` へ差し替える**ので、鍵をオブジェクトの参照に
 * しておくと、**結果が届いたときだけ**取り直される。`WeakMap` なので、ノードが参照を
 * 失えば一緒に消える。
 */
const diffCache = new WeakMap<TreeNode, { added: number; removed: number } | null>()

/** 子1件の増減。差分が届いていなければ `null`（設計§3-2）。 */
function diffOf(child: TreeNode): { added: number; removed: number } | null {
  const known = diffCache.get(child)
  if (known !== undefined) {
    return known
  }
  const source = child.node.kind === 'tool_call' ? toDiffSource(child.node.result) : null
  const counted = source ? countChanges(source.hunks) : null
  diffCache.set(child, counted)
  return counted
}

function upsert(state: CardState, node: TreeNode) {
  const key = node.id
  const known = state.byId.get(key)
  state.byId.set(key, node)

  if (known) {
    // 既にある＝結果が付いて送り直された。並びは変えない
    return
  }
  const parent = node.parent ?? ROOT
  const siblings = state.children.get(parent)
  if (siblings) {
    siblings.push(key)
  } else {
    state.children.set(parent, [key])
  }
  if (opensByDefault(node.node)) {
    state.expanded.add(key)
  }
}

/** そのノードが属する会話の枝（未着なら 0）。 */
function branchOf(state: CardState, id: string): number {
  return state.byId.get(id)?.branch ?? 0
}

function flatten(state: CardState): FlatRow[] {
  const rows: FlatRow[] = []
  const walkFrom = (parent: string, depth: number) => {
    walkSiblings(state.children.get(parent) ?? [], depth)
  }

  /** その位置が活動か。並びの端を越えたら偽。 */
  const activityAt = (ids: string[], index: number): boolean => {
    if (index >= ids.length) {
      return false
    }
    const node = state.byId.get(ids[index])
    return node !== undefined && isActivity(node.node)
  }

  /**
   * 同じ親の下の並びを、**連続する活動を束ねながら**積む（設計§2-3）。
   *
   * **子を回す道は3つある**——親の下・根・巻き戻し前の枝。3つともここを通す必要がある。
   * パーサは直前にアシスタント本文が無ければツールコールを**根の直下**へ置くので
   * （`transcript-parser` の `turn_anchor` が発言のたびに外れる）、根の並びにも活動が現れる。
   * ここを素通しすると「根の直下の活動だけ束ねられない」という非対称ができる。
   *
   * **中身の無い思考は、ここで並びから落とす**（設計§8-3）。**束ねるより前でなければ
   * ならない**——描くときに隠すだけだと、思考は境目として残ったままなので、**その前後の
   * 活動が別々のまとめ行に割れる**。並びから抜いて初めて、ひと続きの1行になる。
   */
  /** その位置が、まだ読まれていない待ちか。並びの端を越えたら偽。 */
  const queuedAt = (ids: string[], index: number): boolean => {
    if (index >= ids.length) {
      return false
    }
    return state.byId.get(ids[index])?.node.kind === 'queued_message'
  }

  const walkSiblings = (all: string[], depth: number) => {
    const ids = all.filter((id) => !droppable(state, id))
    let index = 0
    while (index < ids.length) {
      // 待ちが続いたら、頭から3つだけ出して残りは数で言う（設計§7-3 の天井）。
      // **活動の束ねより先に見る**——待ちは活動ではないので、ここで拾わないと
      // 1件ずつ全部並ぶ
      if (queuedAt(ids, index)) {
        const start = index
        while (queuedAt(ids, index)) {
          index += 1
        }
        const run = ids.slice(start, index)
        for (const id of run.slice(0, MAX_QUEUED_ROWS)) {
          walkNode(id, depth)
        }
        const 残り = run.length - MAX_QUEUED_ROWS
        if (残り > 0) {
          rows.push({
            kind: 'queued-more',
            id: `${QUEUED_MORE_PREFIX}${run[0]}`,
            count: 残り,
          })
        }
        continue
      }
      if (!activityAt(ids, index)) {
        walkNode(ids[index], depth)
        index += 1
        continue
      }
      // 最長の並びを取る。**種類は混ぜる**ので、ツールコールと未知が隣り合っても切らない
      const start = index
      while (activityAt(ids, index)) {
        index += 1
      }
      pushActivity(ids.slice(start, index), depth)
    }
  }

  const pushActivity = (members: string[], depth: number) => {
    const id = `${ACTIVITY_ROW_PREFIX}${members[0]}`
    const expanded = state.expandedActivity.has(id)
    const counts: ActivitySummaryInput = { edited: [], ran: 0, read: [], used: 0, unknown: 0 }
    let added = 0
    let removed = 0
    // 差分が1件も取れなければ出さない（設計§3-2）。0 と「無い」を区別するために数で見ない
    let edits = false
    for (const memberId of members) {
      const child = state.byId.get(memberId)
      if (!child) {
        continue
      }
      tally(counts, child.node)
      const diff = diffOf(child)
      if (diff) {
        added += diff.added
        removed += diff.removed
        edits = true
      }
    }
    rows.push({ kind: 'activity', id, members, depth, expanded, counts, diff: edits ? { added, removed } : null })
    if (expanded) {
      for (const memberId of members) {
        // **[`walkSiblings`] を通してはいけない。** members は定義上すべて活動なので、
        // その場でもう一度束ね直され、同じ id のまとめ行が入れ子で出る
        walkNode(memberId, depth)
      }
    }
  }

  const walkNode = (id: string, depth: number) => {
    const node = state.byId.get(id)
    if (!node) {
      return
    }
    // **落とす思考を除いてから数える。** ここを生の並びで数えると、子が中身の無い思考
    // だけの行が「開ける」ことになり、**開いても何も出ない**——いま直しているものと
    // 同じ壊れ方を、1つ内側に作ることになる
    const childIds = (state.children.get(id) ?? []).filter((childId) => !droppable(state, childId))
    const hasChildren = childIds.length > 0
    // **活動はまとめ行へ移るので、本文の行では「開けば出るもの」として数えない**（設計§2-5）。
    // これでアシスタント本文の expandable が偽になり、本文にトグルが出なくなる（要望1）。
    //
    // **本文を持つ種別に限る。** 全種別へ当てると、子がツールコールだけのサブエージェントが
    // 開けなくなり、その下のまとめ行へ**辿り着く道が無くなる**（掘れることは要件そのもの）。
    // 本文の行だけが「本文が既に出ているので、子を出す操作が要らない」という立場にある。
    //
    // 再帰そのものは hasChildren（生の構造）で判断する——ここを偽にすると、子を回さなく
    // なって**まとめ行そのものが出なくなる**
    const ownChildren = hasFoldableBody(node.node)
      ? childIds.some((childId) => {
          const child = state.byId.get(childId)
          return child === undefined || !isActivity(child.node)
        })
      : hasChildren
    const expanded = state.expanded.has(id)
    // 畳む相手かを見るだけにする。ここで実際に切ると、数万件の履歴で全ノードぶんの
    // 文字列を作ることになる（切る仕事は、描くときで間に合う）
    const foldable =
      hasFoldableBody(node.node) && shouldFoldBody(node.node.text, node.node.kind)
    rows.push({
      kind: 'node',
      id,
      node: node.node,
      depth,
      expandable: isExpandable(node.node, ownChildren),
      expanded,
      hasChildren,
      foldable,
      bodyOpen: state.bodyOpen.has(id),
    })
    if (expanded && hasChildren) {
      walkFrom(id, depth + 1)
    }
  }

  const roots = state.children.get(ROOT) ?? []
  // 巻き戻すと同じファイルに2つ目の根が生える（設計§16）。最新の枝だけを主役にし、
  // それより前は1行にまとめて畳む。捨てはしないので、開けば元どおり読める
  const latest = roots.reduce((max, id) => Math.max(max, branchOf(state, id)), 0)
  const rewound = roots.filter((id) => branchOf(state, id) < latest)

  if (rewound.length > 0) {
    rows.push({
      kind: 'rewound',
      id: REWOUND_ROW_ID,
      count: rewound.length,
      expanded: state.showRewound,
    })
    if (state.showRewound) {
      walkSiblings(rewound, 0)
    }
  }
  walkSiblings(
    roots.filter((id) => branchOf(state, id) >= latest),
    0,
  )
  return rows
}

function notify(cardId: string) {
  const set = listeners.get(cardId)
  if (!set) {
    return
  }
  for (const listener of set) {
    listener()
  }
}

function flush() {
  scheduled = false
  const batch = new Map(pending)
  pending.clear()

  for (const [cardId, nodes] of batch) {
    const state = stateOf(cardId)
    for (const node of nodes) {
      upsert(state, node)
    }
    state.flat = null
    notify(cardId)
  }
}

function schedule() {
  if (scheduled) {
    return
  }
  scheduled = true
  // jsdom やテスト環境で rAF が無い場合もあるので、無ければ即座に反映する
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(flush)
  } else {
    scheduled = false
    flush()
  }
}

/** サーバからの `transcript_append` を取り込む。 */
export function appendNodes(cardId: CardId, nodes: TreeNode[]) {
  if (nodes.length === 0) {
    return
  }
  const queued = pending.get(cardId)
  if (queued) {
    queued.push(...nodes)
  } else {
    pending.set(cardId, [...nodes])
  }
  schedule()
}

/** `transcript_reset`（巻き戻り・購読し直し）を取り込む。 */
export function resetTranscript(cardId: CardId) {
  pending.delete(cardId)
  cards.delete(cardId)
  notify(cardId)
}

/** 開け閉めを切り替える。 */
export function toggleNode(cardId: CardId, nodeId: NodeId) {
  const state = stateOf(cardId)
  if (state.expanded.has(nodeId)) {
    state.expanded.delete(nodeId)
  } else {
    state.expanded.add(nodeId)
  }
  state.flat = null
  notify(cardId)
}

/**
 * 本文の開け閉めを切り替える。
 *
 * [`toggleNode`] とは**別の操作**である。開け閉めの記号が担うのは「まだ出していないもの（＝子）を
 * 出すこと」で、こちらは「切ってある本文を全部読むこと」。同じ操作にまとめると、
 * ツールを何本も呼んだターンを畳んで会話だけ追う、という読み方ができなくなる。
 */
export function toggleBody(cardId: CardId, nodeId: NodeId) {
  const state = stateOf(cardId)
  if (state.bodyOpen.has(nodeId)) {
    state.bodyOpen.delete(nodeId)
  } else {
    state.bodyOpen.add(nodeId)
  }
  state.flat = null
  notify(cardId)
}

/**
 * まとめ行の開け閉めを切り替える。
 *
 * [`toggleNode`] とは**別の集合**を使う（設計§2-5）。あちらの鍵は実ノードのID、こちらは
 * 合成ID（[`ACTIVITY_ROW_PREFIX`]）で、意味が違うものを同じ `Set` へ入れない。
 */
export function toggleActivity(cardId: CardId, rowId: string) {
  const state = stateOf(cardId)
  if (state.expandedActivity.has(rowId)) {
    state.expandedActivity.delete(rowId)
  } else {
    state.expandedActivity.add(rowId)
  }
  state.flat = null
  notify(cardId)
}

/** 巻き戻し前の枝を開け閉めする。 */
export function toggleRewound(cardId: CardId) {
  const state = stateOf(cardId)
  state.showRewound = !state.showRewound
  state.flat = null
  notify(cardId)
}

/** テストの後始末用。ストアがモジュール単位で生き残るので、明示的に畳む。 */
export function clearAllTranscripts() {
  cards.clear()
  pending.clear()
  scheduled = false
}

const EMPTY: FlatRow[] = []

function snapshot(cardId: CardId): FlatRow[] {
  const state = cards.get(cardId)
  if (!state) {
    // 同じ配列を返し続けないと useSyncExternalStore が無限ループする
    return EMPTY
  }
  if (!state.flat) {
    state.flat = flatten(state)
  }
  return state.flat
}

function subscribe(cardId: CardId, listener: () => void): () => void {
  let set = listeners.get(cardId)
  if (!set) {
    set = new Set()
    listeners.set(cardId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) {
      listeners.delete(cardId)
    }
  }
}

/** いまの行の並びを取る（購読しない読み取り）。 */
export function getRows(cardId: CardId): FlatRow[] {
  return snapshot(cardId)
}

/** 平らにした履歴を購読する。 */
export function useTranscript(cardId: CardId): FlatRow[] {
  return useSyncExternalStore(
    (listener) => subscribe(cardId, listener),
    () => snapshot(cardId),
    () => EMPTY,
  )
}

/** ノード1件を引く（差分表示などで中身が要るとき）。 */
export function getNode(cardId: CardId, nodeId: NodeId): TreeNode | undefined {
  return cards.get(cardId)?.byId.get(nodeId)
}
