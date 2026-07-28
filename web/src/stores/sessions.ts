/**
 * 一覧のセッションを持つストア（設計§10 の sessionsStore）。
 *
 * # なぜ React の状態に置かないのか
 *
 * フックはツールコールのたびに飛んでくる。1枚の小窓の状態が変わっただけで一覧全体を
 * 作り直すと、12セッション同時稼働では更新のたびに全部が再レンダリングの判定に入る。
 * PTY のバイトを React に通していないのと同じ理由で、ここも **React の外に持って
 * [`useSyncExternalStore`] でカード単位に購読する**形にしている。
 *
 * # 2種類の購読を分けている
 *
 * | 購読 | 変わるとき |
 * |---|---|
 * | **構造**（[`useProjectGroups`]／[`useProjectCards`]） | カードが増減した・作業ディレクトリが変わった |
 * | **カード1枚**（[`useSessionCard`]） | そのカードの状態・経過時刻・要約が変わった |
 *
 * 状態の更新は毎秒何度も来るが構造はめったに変わらない。分けておくと、状態の更新で
 * 一覧の親（グループの箱）が作り直されることが無くなる。
 *
 * # まとめてから反映する
 *
 * 受信はバースト的に来るので、1件ごとに通知すると描画が追いつかない。届いた更新は
 * いったん待ち行列へ積み、`requestAnimationFrame` の周期で一括で反映する
 * （履歴ストア [`@/stores/transcript`] と同じ手口）。
 */

import { useSyncExternalStore } from 'react'
import type { CardId, SessionMeta, SessionStatus } from '@/lib/protocol'

/** 1つの作業ディレクトリにまとまったカードの並び。 */
export interface ProjectGrouping {
  project: string
  /** そのプロジェクトのカードID（作成順） */
  cards: CardId[]
}

/** `status` メッセージが運ぶ差分。 */
export interface StatusPatch {
  card_id: CardId
  status: SessionStatus
  subagent_active: number
  last_activity_at: number
}

type Op =
  /** REST スナップショット。手元の全体を置き換える */
  | { kind: 'snapshot'; list: SessionMeta[] }
  | { kind: 'upsert'; meta: SessionMeta }
  | { kind: 'remove'; cardId: CardId }
  | { kind: 'status'; patch: StatusPatch }

/** 確定済みの状態。読むのは購読者だけで、書き換えるのは [`flush`] だけ。 */
const metas = new Map<CardId, SessionMeta>()
/** 作成順のカードID。並びは「最初に現れた順」で安定させる */
let order: CardId[] = []
let groups: ProjectGrouping[] = []

const cardListeners = new Map<CardId, Set<() => void>>()
const structureListeners = new Set<() => void>()

/** rAF でまとめて反映するための待ち行列。順序が意味を持つので配列で持つ。 */
let pending: Op[] = []
let scheduled = false

const EMPTY_CARDS: CardId[] = []

function notifyCard(cardId: CardId) {
  const set = cardListeners.get(cardId)
  if (!set) {
    return
  }
  for (const listener of set) {
    listener()
  }
}

function notifyStructure() {
  for (const listener of structureListeners) {
    listener()
  }
}

/**
 * 構造（グループの並びと所属）を組み直す。
 *
 * 箱の並びも中のカードの並びも**最初に現れた順**で安定させる。更新のたびに位置が
 * 入れ替わると、一覧を見ている側が目で追えなくなる。
 */
function rebuildGroups() {
  const next: ProjectGrouping[] = []
  for (const cardId of order) {
    const meta = metas.get(cardId)
    if (!meta) {
      continue
    }
    const found = next.find((group) => group.project === meta.project)
    if (found) {
      found.cards.push(cardId)
    } else {
      next.push({ project: meta.project, cards: [cardId] })
    }
  }
  groups = next
}

/** 待ち行列を確定済みの状態へ流し込む。 */
function flush() {
  scheduled = false
  const batch = pending
  pending = []

  const touched = new Set<CardId>()
  let structureChanged = false

  for (const op of batch) {
    switch (op.kind) {
      case 'snapshot': {
        // 真実はサーバ側にある。手元の全体を捨てて置き換える（再接続時の作り直し）
        for (const cardId of metas.keys()) {
          touched.add(cardId)
        }
        metas.clear()
        order = []
        for (const meta of [...op.list].sort((a, b) => a.created_at - b.created_at)) {
          metas.set(meta.card_id, meta)
          order.push(meta.card_id)
          touched.add(meta.card_id)
        }
        structureChanged = true
        break
      }
      case 'upsert': {
        const known = metas.get(op.meta.card_id)
        metas.set(op.meta.card_id, op.meta)
        if (!known) {
          order.push(op.meta.card_id)
          structureChanged = true
        } else if (known.project !== op.meta.project) {
          structureChanged = true
        }
        touched.add(op.meta.card_id)
        break
      }
      case 'remove': {
        if (metas.delete(op.cardId)) {
          order = order.filter((cardId) => cardId !== op.cardId)
          structureChanged = true
          touched.add(op.cardId)
        }
        break
      }
      case 'status': {
        const known = metas.get(op.patch.card_id)
        if (!known) {
          // まだカードを知らない。`session_upsert` が後から来るので捨ててよい
          break
        }
        metas.set(op.patch.card_id, {
          ...known,
          status: op.patch.status,
          subagent_active: op.patch.subagent_active,
          last_activity_at: op.patch.last_activity_at,
        })
        touched.add(op.patch.card_id)
        break
      }
    }
  }

  if (structureChanged) {
    rebuildGroups()
    notifyStructure()
  }
  for (const cardId of touched) {
    notifyCard(cardId)
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

function enqueue(op: Op) {
  pending.push(op)
  schedule()
}

/**
 * `GET /api/sessions` の結果を取り込む（接続時・再接続時の作り直し）。
 *
 * **これだけは束ねずにその場で反映する。** スナップショットは接続1回につき1度しか
 * 来ないので束ねる意味が無く、束ねると「接続済みと出ているのに一覧がまだ空」という
 * 隙間が生まれる。実際、この隙間で E2E の後片付けが「カードは0枚」と判断して
 * 早々に切り上げ、残ったカードが次のテストへ漏れていた。
 *
 * 待ち行列に積んでから流すのは、先に積まれている差分との順序を崩さないため。
 */
export function applySessionSnapshot(list: SessionMeta[]) {
  pending.push({ kind: 'snapshot', list })
  flush()
}

/** `session_upsert` を取り込む。 */
export function upsertSession(meta: SessionMeta) {
  enqueue({ kind: 'upsert', meta })
}

/** `session_removed` を取り込む。 */
export function removeSession(cardId: CardId) {
  enqueue({ kind: 'remove', cardId })
}

/** `status`（状態だけの差分）を取り込む。 */
export function patchSessionStatus(patch: StatusPatch) {
  enqueue({ kind: 'status', patch })
}

/** テストの後始末用。ストアがモジュール単位で生き残るので、明示的に畳む。 */
export function clearSessions() {
  metas.clear()
  order = []
  groups = []
  pending = []
  scheduled = false
}

function subscribeCard(cardId: CardId, listener: () => void): () => void {
  let set = cardListeners.get(cardId)
  if (!set) {
    set = new Set()
    cardListeners.set(cardId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) {
      cardListeners.delete(cardId)
    }
  }
}

function subscribeStructure(listener: () => void): () => void {
  structureListeners.add(listener)
  return () => structureListeners.delete(listener)
}

/** カード1枚を購読する。他のカードが変わっても呼び出し側は再描画されない。 */
export function useSessionCard(cardId: CardId): SessionMeta | undefined {
  return useSyncExternalStore(
    (listener) => subscribeCard(cardId, listener),
    () => metas.get(cardId),
    () => undefined,
  )
}

/** プロジェクト単位のまとまりを購読する（構造が変わったときだけ変わる）。 */
export function useProjectGroups(): ProjectGrouping[] {
  return useSyncExternalStore(
    subscribeStructure,
    () => groups,
    () => groups,
  )
}

/** 1つのプロジェクトに属するカードIDを購読する。 */
export function useProjectCards(project: string): CardId[] {
  const all = useProjectGroups()
  // 同じ配列を返し続けないと useSyncExternalStore が無限ループするので、
  // 見つからないときは共有の空配列を返す
  return all.find((group) => group.project === project)?.cards ?? EMPTY_CARDS
}

/** 手元のカードを引く（購読しない読み取り。テストや一時的な参照用）。 */
export function getSession(cardId: CardId): SessionMeta | undefined {
  return metas.get(cardId)
}
