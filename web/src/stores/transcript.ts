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
import { BODY_FOLD_LIMIT } from '@/lib/markdown'

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

/** ツリーを平らに並べた1行分。仮想化はこの配列に対して行う。 */
export type FlatRow = NodeRow | RewoundRow

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

/** 中身を開いて見られる種別か。 */
function isExpandable(node: Node, hasChildren: boolean): boolean {
  if (hasChildren) {
    return true
  }
  // 子が無くても、展開すると中身（入力・結果・差分・生データ）が出るもの
  return node.kind === 'tool_call' || node.kind === 'thinking' || node.kind === 'unknown'
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
    const ids = state.children.get(parent)
    if (!ids) {
      return
    }
    for (const id of ids) {
      walkNode(id, depth)
    }
  }
  const walkNode = (id: string, depth: number) => {
    const node = state.byId.get(id)
    if (!node) {
      return
    }
    const hasChildren = (state.children.get(id)?.length ?? 0) > 0
    const expanded = state.expanded.has(id)
    // 長さを見るだけにする。ここで実際に切ると、数万件の履歴で全ノードぶんの
    // 文字列を作ることになる（切る仕事は、描くときで間に合う）
    const foldable = hasFoldableBody(node.node) && node.node.text.length > BODY_FOLD_LIMIT
    rows.push({
      kind: 'node',
      id,
      node: node.node,
      depth,
      expandable: isExpandable(node.node, hasChildren),
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
      for (const id of rewound) {
        walkNode(id, 0)
      }
    }
  }
  for (const id of roots) {
    if (branchOf(state, id) >= latest) {
      walkNode(id, 0)
    }
  }
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
 * [`toggleNode`] とは**別の操作**である。`▸▾` が担うのは「まだ出していないもの（＝子）を
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
