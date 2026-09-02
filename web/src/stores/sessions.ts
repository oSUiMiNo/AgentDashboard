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
import { LOCAL_HOST } from '@/lib/routes'
import { getProjects, subscribeProjects } from '@/stores/projects'

/**
 * 一覧に並ぶ箱1つ。
 *
 * **鍵は（PC, パス）の組**（設計§13）。パスだけだと、複数の PC を繋いだときに
 * 同じパスが1つの箱へ混ざり、持ち主も「+」の宛先も決まらなくなる。
 */
export interface ProjectGrouping {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  project: string
  /**
   * 追加した枠なら、その ID。
   *
   * **カードから逆算して出ている箱は持たない**（設計§13）——消す対象が無いので
   * 「×」も出さない。そちらはカードが全部無くなれば自然に消える。
   */
  projectId?: string
  /** その箱のカードID（作成順） */
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

/**
 * 一覧に出す名乗り（`.agent-dashboard.toml` の `account`）の並び。
 *
 * ローカルモードでは**認証ではなく自己整理**として使う（設計§8-5）。攻撃者の居ない
 * 環境で「いまはこのプロジェクト群だけ見たい」を叶えるためのもので、権限とは無関係。
 */
let accounts: string[] = []

/** 絞り込み中の名乗り。`null` は絞り込まない。 */
let accountFilter: string | null = null

/**
 * いま起こし直しを頼んでいるカード（復旧設計§9-4）。
 *
 * **サーバに対応する欄が無い**ので、モデル切替の「楽観更新はしない」は当てはまらない
 * （食い違う相手が居ない）。それでも印が要るのは、**席が空くまでカードが1バイトも
 * 変わらない**ため——6枚を並べれば5枚目・6枚目は数十秒待つ。
 *
 * サーバ由来の状態が1件でも届いたら消す（[`flush`]）。居座らせない。
 */
const reviving = new Set<CardId>()

/**
 * そのカードに出す断りの言葉（復旧設計§9-5）。
 *
 * `ServerMessage::Error` は `card_id` を運んでいるのに、ブラウザは捨てて画面全体の帯へ
 * 出していた。**名指しがあるものはそのカードへ**出す。行き先を決めるのは種別ではなく
 * 名指しの有無なので、経路が増えても迷わない。
 */
const cardErrors = new Map<CardId, string>()

/**
 * 実体が無いカード（＝起こし直しの候補。復旧設計§3-1）。**作成順・絞り込み後**。
 *
 * ここで見るのは記録だけ（接続断か終了か）で、**PC の在否や名乗りは見ていない**。
 * あちらの材料は設定ストアにあるので、最後の絞り込みは押す画面の側で行う（§3-3）。
 *
 * 絞り込み中のカードを入れないのは、**押した人が数を予測できる**ようにするため
 * （見えていないカードまで起こさない）。
 */
let reviveTargets: CardId[] = []

/**
 * 候補の顔ぶれと**内訳が変わったか**を見るための指紋。
 *
 * 顔ぶれだけを比べると、同じカードが「接続断 → 終了」へ移ったときに気づけず、
 * 画面の内訳が古いまま残る。
 */
let reviveFingerprint = ''

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
  const names = new Set<string>()
  const keyOf = (host: string, project: string) => `${host}\u0000${project}`
  const at = new Map<string, number>()

  // ① 追加した枠を先に置く。**カードが0枚でも箱は在る**——これが「セッションの有無に
  //    関係なく PJT を追加できる」の実体（設計§13）
  for (const project of getProjects()) {
    at.set(keyOf(project.host, project.path), next.length)
    next.push({
      host: project.host,
      project: project.path,
      projectId: project.id,
      cards: [],
    })
  }

  // ② カードを流し込む。枠に無いカードは従来どおりカードから箱を作る
  for (const cardId of order) {
    const meta = metas.get(cardId)
    if (!meta) {
      continue
    }
    if (meta.toml_account !== null) {
      names.add(meta.toml_account)
    }
    // 絞り込みが効いているときは、名乗りが一致するカードだけを箱へ入れる。
    // **箱そのものも消す**（空の箱が並ぶと、絞り込んだのに何も減っていないように見える）
    if (accountFilter !== null && meta.toml_account !== accountFilter) {
      continue
    }
    const host = meta.agent_id ?? LOCAL_HOST
    const key = keyOf(host, meta.project)
    const found = at.get(key)
    if (found !== undefined) {
      next[found].cards.push(cardId)
    } else {
      at.set(key, next.length)
      next.push({ host, project: meta.project, cards: [cardId] })
    }
  }

  // ③ **群分けはやめた**（並べ替え設計§2-3）。以前は「セッションが居る箱を上」に
  //    していたが、利用者が自分で並べられるようになると正面から衝突する——
  //    自分で並べた順に並んでいても、**セッションが1本起動しただけで箱が群をまたいで
  //    動く**ことになる。並びの正は `position` の1本だけにする。
  //
  //    以前の見え方（居る箱が上）は、列を足したときのバックフィルで**そのまま焼き
  //    付けてある**ので、入れ替えた瞬間に並びが変わることはない。
  groups = next

  // 絞り込み中は、枠だけの箱を出さない（名乗りで絞ったのに減らないように見える）
  if (accountFilter !== null) {
    groups = next.filter((group) => group.cards.length > 0)
  }
  const sorted = [...names].sort()
  // 同じ内容なら同じ配列を返し続ける（`useSyncExternalStore` が無限に回らないため）
  if (sorted.length !== accounts.length || sorted.some((name, at) => name !== accounts[at])) {
    accounts = sorted
  }
  rebuildReviveTargets()
}

/**
 * 起こし直しの候補を数え直す（復旧設計§3-1・§9-3）。
 *
 * 変わったときだけ配列を差し替えて `true` を返す。呼んだ側が構造の購読者へ知らせる
 * ——**接続断は構造を変えない**（同じ箱に同じカードが並んだまま）ので、これが無いと
 * ホームの内訳だけが古いまま残る。
 */
function rebuildReviveTargets(): boolean {
  const next: CardId[] = []
  const marks: string[] = []
  for (const group of groups) {
    for (const cardId of group.cards) {
      const meta = metas.get(cardId)
      if (!meta) {
        continue
      }
      const ended = meta.status.kind === 'ended'
      if (meta.agent_connected && !ended) {
        continue
      }
      next.push(cardId)
      marks.push(`${cardId}:${ended ? 'e' : 'd'}`)
    }
  }
  const fingerprint = marks.join('|')
  if (fingerprint === reviveFingerprint) {
    return false
  }
  reviveFingerprint = fingerprint
  reviveTargets = next
  return true
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
        // 並びの正は `position`（並べ替え設計§2-3）。カードの `position` は**枠の中で
        // 閉じている**ので、ここで平らに並べても、枠ごとにまとめ直したときの枠内の
        // 相対順が正しくなる。同着は時刻で崩す
        for (const meta of [...op.list].sort(
          (a, b) => a.position - b.position || a.created_at - b.created_at,
        )) {
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
          // カードごと消えたら、そのカードに出していた断りも消す
          cardErrors.delete(op.cardId)
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

  // サーバ由来の状態が届いたカードは、押した側の印を畳む（復旧設計§9-4）。
  // 居座らせると「復旧中…」のまま押せないカードが残る
  //
  // **断りのほうは畳まない。** 起こし直しの最中でなくてもカードは数秒おきに報告を
  // 送ってくる（`statusLine` の再実行など）ので、一緒に畳むと**読む前に消える**。
  // 実際、権限モードの切替が断られたときの理由が E2E で1度も出せなかった。
  // 断りが消えるのは、次に押したときとカードが消えたときだけにする
  for (const cardId of touched) {
    reviving.delete(cardId)
  }

  if (structureChanged) {
    rebuildGroups()
    notifyStructure()
  } else if (rebuildReviveTargets()) {
    // 接続断は構造を変えない。**ここで知らせないとホームの内訳だけが古くなる**
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

// 枠が増減したら箱を組み直す。**カードが1枚も動いていなくても並びは変わる**
// （枠を足した瞬間に、カード0枚の箱が現れる）
subscribeProjects(() => {
  rebuildGroups()
  notifyStructure()
})

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

/**
 * 起こし直しを頼んだ印を立てる（復旧設計§9-4）。
 *
 * **押した側ではなくここで立てる。** 押せる場所が3か所（小窓・セッション画面・ホーム）
 * あるので、押し手ごとに書くと1つ書き漏らしたときだけ手応えが無くなる。
 */
export function markReviving(cardId: CardId) {
  if (reviving.has(cardId)) {
    return
  }
  reviving.add(cardId)
  // 前の理由は消す。押し直したのに古い断りが残っていると、今回の結果と読めてしまう
  clearCardError(cardId)
}

/**
 * そのカードに出ている断りを消す。
 *
 * **押し直す前に呼ぶ。** 古い断りが残っていると、今回の結果と読めてしまう——
 * `markReviving` が前からやっていたことを、名前のある口として切り出した。
 *
 * # 同じ文言が2回続く場合に効く
 *
 * [`useCardError`] は文字列をそのまま返すので、**同じ断りが2回続くと
 * `useSyncExternalStore` が `Object.is` で弾き、React からは変化に見えない。**
 * 送る前にここを通しておけば、断りは毎回 `null → 文言` の変化になる。
 */
export function clearCardError(cardId: CardId) {
  cardErrors.delete(cardId)
  // **カード1枚だけを鳴らす。** 全体に持つと、6枚を並べたときに一覧が丸ごと描き直される
  notifyCard(cardId)
}

/** そのカードを起こし直している最中か。 */
export function useReviving(cardId: CardId): boolean {
  return useSyncExternalStore(
    (listener) => subscribeCard(cardId, listener),
    () => reviving.has(cardId),
    () => false,
  )
}

/**
 * そのカードに出す断りを立てる（復旧設計§9-5）。
 *
 * **印も一緒に外す。** 断られたのに「復旧中…」が残ると、二度と押せないカードになる。
 */
export function setCardError(cardId: CardId, message: string) {
  cardErrors.set(cardId, message)
  reviving.delete(cardId)
  notifyCard(cardId)
}

/** そのカードに出ている断り（無ければ `null`）。 */
export function useCardError(cardId: CardId): string | null {
  return useSyncExternalStore(
    (listener) => subscribeCard(cardId, listener),
    () => cardErrors.get(cardId) ?? null,
    () => null,
  )
}

/** 起こし直しの候補（購読しない読み取り。テスト用）。 */
export function getReviveTargets(): CardId[] {
  return reviveTargets
}

/** 印が立っているか（購読しない読み取り。テスト用）。 */
export function isReviving(cardId: CardId): boolean {
  return reviving.has(cardId)
}

/**
 * 起こし直しの候補を購読する（復旧設計§9-3）。
 *
 * **PC の在否と名乗りはここでは見ていない。** その材料は設定ストアにあるので、
 * 最後の絞り込みは押す画面（`TileGrid`）が `reviveState` で行う。
 */
export function useReviveTargets(): CardId[] {
  return useSyncExternalStore(
    subscribeStructure,
    () => reviveTargets,
    () => reviveTargets,
  )
}

/** テストの後始末用。ストアがモジュール単位で生き残るので、明示的に畳む。 */
export function clearSessions() {
  metas.clear()
  order = []
  groups = []
  accounts = []
  accountFilter = null
  pending = []
  scheduled = false
  reviving.clear()
  cardErrors.clear()
  reviveTargets = []
  reviveFingerprint = ''
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
/** 一覧に出せる名乗りの一覧（絞り込みの選択肢）。 */
export function useTomlAccounts(): string[] {
  return useSyncExternalStore(
    subscribeStructure,
    () => accounts,
    () => accounts,
  )
}

/** いま絞り込んでいる名乗り。 */
export function useAccountFilter(): string | null {
  return useSyncExternalStore(
    subscribeStructure,
    () => accountFilter,
    () => accountFilter,
  )
}

/** 絞り込みを切り替える。**表示だけの操作**で、サーバへは何も送らない。 */
export function setAccountFilter(account: string | null) {
  if (accountFilter === account) {
    return
  }
  accountFilter = account
  rebuildGroups()
  notifyStructure()
}

/** 購読しない読み取り（テスト用）。 */
export function getProjectGroups(): ProjectGrouping[] {
  return groups
}

export function useProjectGroups(): ProjectGrouping[] {
  return useSyncExternalStore(
    subscribeStructure,
    () => groups,
    () => groups,
  )
}

/** 1つの箱に属するカードIDを購読する。**鍵は（PC, パス）の組**（設計§13）。 */
export function useProjectCards(host: string, project: string): CardId[] {
  const all = useProjectGroups()
  // 同じ配列を返し続けないと useSyncExternalStore が無限ループするので、
  // 見つからないときは共有の空配列を返す
  return (
    all.find((group) => group.host === host && group.project === project)
      ?.cards ?? EMPTY_CARDS
  )
}

/** 手元のカードを引く（購読しない読み取り。テストや一時的な参照用）。 */
export function getSession(cardId: CardId): SessionMeta | undefined {
  return metas.get(cardId)
}

/**
 * 手元のカード全部（作成順・購読しない読み取り）。
 *
 * 「最近使った場所」の材料に使う（設計§13）。**PC に問い合わせずに出せる**のが要点で、
 * 過去に起こしたカードの作業ディレクトリはサーバの記録の中に既にある。
 */
export function getSessions(): SessionMeta[] {
  return order.flatMap((cardId) => {
    const meta = metas.get(cardId)
    return meta === undefined ? [] : [meta]
  })
}

/**
 * 1つの枠の中で、カードの並びをサーバへ送る（並べ替え設計§9-1）。
 *
 * **枠を名指す。** カードの `position` は枠の中で閉じているので、宛先が無いと
 * 受け手はどの枠の話か分からない。**枠をまたいだ移動はやらない**ので、
 * その枠に居ないカードは受け手が断る。
 *
 * 手元は先に書き換えない（`session_upsert` で戻ってくる）。戻り値は断られた理由で、
 * 通れば `null`。
 */
export async function saveCardOrder(
  host: string,
  path: string,
  cardIds: readonly string[],
): Promise<string | null> {
  try {
    const response = await fetch('/api/sessions/order', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host, path, card_ids: cardIds }),
    })
    if (!response.ok) {
      return (await response.text()).trim() || '並べ替えを保存できませんでした'
    }
    return null
  } catch {
    return '並べ替えを保存できませんでした'
  }
}
