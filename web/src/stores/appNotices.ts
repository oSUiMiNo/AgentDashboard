/**
 * アプリ全体の知らせ（トーストとベル設計§6-3・§8-5）。
 *
 * # カード単位の断りとは別の器である
 *
 * `stores/sessions.ts` の断り（`Notice`）は**カード1枚に効く**もので、メモリだけに積む。
 * こちらは**アプリ全体に効く**もので、サーバ由来のぶんは記録に残って端末をまたぐ。
 * 統合しないのは、あちらの設計（`細かい修正_2026-0903` §7-5）が「当面は別々」と
 * 決めているため。
 *
 * # 出どころを3つに分ける
 *
 * | 出どころ | どこから来るか | 記録に残るか |
 * |---|---|---|
 * | `server` | 合流点を通ったもの（自己修復・アカウント全体のエラー） | **残る**。端末をまたぐ |
 * | `browser` | 線が切れた・繋ぎ直せない・フレームが壊れていた | 残らない |
 * | `reply` | この接続への返事（起こせなかった・見つからない 等） | 残らない |
 *
 * **`reply` を分けたのは、サーバ側を1行も触らずに済ませるためである**（設計§4-2）。
 * あれは `ws.rs` が合流点を通さずにこの接続へ直接返しているもので、記録へ通すには
 * 6箇所を書き換えることになる。どれも「いまこのタブがやった操作への返事」なので、
 * 跨端末で残す意味が薄い。
 *
 * # 器の作法は `cardNotices` から借りる
 *
 * 時計は**1本だけ**・張り直しは**早いほう優先**・空配列は**使い回す**。3つとも、
 * あちらが実際に踏んで直した形である。
 */
import { useSyncExternalStore } from 'react'
import type { ErrorKind, NoticeView, SelfhealPhase } from '@/lib/protocol'
import { selfhealLabel } from '@/lib/protocol'

/**
 * 知らせの出どころ。
 *
 * **記録に残るかどうかがこれで決まる**ので、混ぜて1つにしない——混ぜると
 * 「なぜこれだけリロードで消えるのか」が誰にも説明できなくなる。
 */
export type NoticeOrigin = 'server' | 'browser' | 'reply'

/** アプリ全体の知らせ1件。 */
export interface AppNotice {
  /** 記録に載っているものはその id、載っていないものは手元で振った id。 */
  id: string
  origin: NoticeOrigin
  /** `'error'` か `'selfheal'`。 */
  source: string
  /** `source` に応じた種別。 */
  kind: string
  message: string
  createdAt: number
  /**
   * 積んだ順の通し番号。
   *
   * **時刻では一意にならない**（同じミリ秒に同じ文言が2件届くことは実際に起きる）。
   * 一覧の `key` はこれで作る。
   */
  seq: number
  /** **付いていなければ未読。** */
  readAt: number | null
}

/**
 * トーストが出ている時間（ミリ秒）。
 *
 * **利用者の希望は「7秒ほど」で、根拠は弱い**（要件.md も「ほど」と書いている）。
 * FAIX は5秒、既存の直前の応答は12秒。**動かせる値として置いてある**ので、実物を
 * 見て決め直すこと。E2E はこの値を読み込んで使う——テストに数字を書き写さない。
 */
export const TOAST_LIFE_MS = 7_000

/**
 * 消えるときの動きの長さ（ミリ秒）。設計§8-3 の確定値。
 *
 * **寿命が尽きてから、この時間だけ「消えかけ」で残る。** 出ていきざまを描くための猶予で、
 * ここを 0 にすると画面から瞬間的に消える。
 */
export const TOAST_EXIT_MS = 200

/**
 * 同時に出すトーストの上限（設計§8-5）。
 *
 * **効果線が同時に出す本数と揃えてある**——画面が同時に許してよい「動くもの」の数。
 * 溢れたぶんはトーストにせず、ベルへ直接積む。
 */
export const TOAST_MAX_VISIBLE = 3

/**
 * ベルに溜めておく上限。
 *
 * **記録側は200件だが、手元はそこまで持たない。** ベルは「見逃したものを拾う」ための
 * もので、古いものほど値打ちが薄い。カード単位の20件より多めなのは、こちらが
 * アプリ全体を受けるため。
 */
export const 溜める上限 = 50

/** 溜まっている知らせ（**古い順**。新しいものが末尾）。 */
let notices: AppNotice[] = []

/** サーバが数えた未読の数。**手元で数え直さない**（設計§6-1）。 */
let unreadFromServer = 0

/** いま画面に出ているトースト（**新しい順**）。 */
let visible: ToastEntry[] = []

/** トースト1件の表示状態。 */
export interface ToastEntry {
  notice: AppNotice
  /** 消えかけか（出ていきざまを描いている最中）。 */
  exiting: boolean
  /** いつ消えるか。マウスを乗せている間は止まるので、離れたときに引き直す。 */
  expiresAt: number
  /** 乗せている間の残り時間。乗っていなければ `null`。 */
  pausedRemaining: number | null
}

let 積んだ数 = 0

const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 何も溜まっていないときに返す不変の配列。**毎回新しい配列を返すと購読が無限に鳴る** */
const 空の知らせ: AppNotice[] = []

/** 同上（トースト用）。 */
const 空のトースト: ToastEntry[] = []

// ---------------------------------------------------------------------------
// 時計
// ---------------------------------------------------------------------------

/** 次に掃きにいく時計。**1本だけ持つ**（`cardNotices` と同じ作法）。 */
let 時計: ReturnType<typeof setTimeout> | null = null

/** いま張ってある時計が指している時刻。**早い予定を押しのけないため**に覚えておく。 */
let 予定 = Number.POSITIVE_INFINITY

function 張り直す(次: number) {
  if (次 === Number.POSITIVE_INFINITY) {
    return
  }
  // **既に、より早い予定が張ってあるなら触らない。** 張り替えると、その早い予定が
  // 遅い時刻へ押しのけられる
  if (時計 !== null && 次 >= 予定) {
    return
  }
  if (時計 !== null) {
    clearTimeout(時計)
  }
  予定 = 次
  時計 = setTimeout(掃く, Math.max(0, 次 - Date.now()))
}

/**
 * 寿命の来たトーストを消しにいく。
 *
 * **2段で消える。** まず「消えかけ」にして出ていきざまを描き、`TOAST_EXIT_MS` 後に
 * 画面から外す。**ベルからは消えない**——トーストは出口の1つでしかない。
 */
function 掃く() {
  時計 = null
  予定 = Number.POSITIVE_INFINITY
  const いま = Date.now()
  let 次 = Number.POSITIVE_INFINITY
  let 動いた = false

  const 残り: ToastEntry[] = []
  for (const entry of visible) {
    // 乗せている間は止まる（設計§8-4）
    if (entry.pausedRemaining !== null) {
      残り.push(entry)
      continue
    }
    if (!entry.exiting) {
      if (entry.expiresAt <= いま) {
        残り.push({ ...entry, exiting: true, expiresAt: いま + TOAST_EXIT_MS })
        次 = Math.min(次, いま + TOAST_EXIT_MS)
        動いた = true
      } else {
        残り.push(entry)
        次 = Math.min(次, entry.expiresAt)
      }
      continue
    }
    // 消えかけの猶予が尽きたら画面から外す
    if (entry.expiresAt <= いま) {
      動いた = true
      continue
    }
    残り.push(entry)
    次 = Math.min(次, entry.expiresAt)
  }

  if (動いた) {
    visible = 残り
    notify()
  }
  張り直す(次)
}

// ---------------------------------------------------------------------------
// 積む
// ---------------------------------------------------------------------------

function 積む(notice: AppNotice) {
  notices = [...notices, notice].slice(-溜める上限)

  // **上限を超えていたらトーストにしない**（設計§8-5）。ベルには残るので読み落とさない
  if (visible.filter((entry) => !entry.exiting).length < TOAST_MAX_VISIBLE) {
    const expiresAt = Date.now() + TOAST_LIFE_MS
    // 新しいものを先頭に積む（画面では上に出る）
    visible = [{ notice, exiting: false, expiresAt, pausedRemaining: null }, ...visible]
    張り直す(expiresAt)
  }
  notify()
}

function 次のSeq() {
  積んだ数 += 1
  return 積んだ数
}

/** 手元で振る id。**記録に載らないものにも `key` が要る。** */
function 手元のId(seq: number) {
  return `local-${seq}`
}

/**
 * サーバの記録から届いた知らせを積む（`notice_created`）。
 *
 * **未読の数はサーバが数えたものを使う。** 手元で数え直すと、別のタブで既読にした
 * ぶんがずれる。
 */
export function pushServerNotice(view: NoticeView, unreadCount: number) {
  unreadFromServer = unreadCount
  積む({
    id: view.id,
    origin: 'server',
    source: view.source,
    kind: view.kind,
    message: view.message,
    createdAt: view.created_at,
    seq: 次のSeq(),
    readAt: view.read_at ?? null,
  })
}

/**
 * ブラウザ自身が気づいたことを積む（線が切れた、など）。
 *
 * **記録に残らない。** サーバへ届いていないので残しようがなく、リロードで消える。
 */
export function pushBrowserNotice(message: string, kind: ErrorKind = 'other') {
  const seq = 次のSeq()
  積む({
    id: 手元のId(seq),
    origin: 'browser',
    source: 'error',
    kind,
    message,
    createdAt: Date.now(),
    seq,
    readAt: null,
  })
}

/**
 * この接続への返事を積む（設計§4-2 の6箇所）。
 *
 * **記録に残らない。** 「いまこのタブがやった操作への返事」なので、別の端末で読み返す
 * 意味が薄い——起こせなかった・見つからない・記録が読めない・壊れたフレーム、など。
 */
export function pushReplyNotice(message: string, kind: ErrorKind = 'other') {
  const seq = 次のSeq()
  積む({
    id: 手元のId(seq),
    origin: 'reply',
    source: 'error',
    kind,
    message,
    createdAt: Date.now(),
    seq,
    readAt: null,
  })
}

/**
 * 自己修復の進み具合を積む（設計§6-2）。
 *
 * **同じ段階が続けて届いたら積まない。** 段階は行ったり来たりするので、そのまま積むと
 * 同じ文が並ぶ。
 *
 * **単一スロットをやめたのはここである。** かつては新しい段階が届くと前のものが黙って
 * 消えていたので、ベルへ溜めようがなかった。
 */
export function pushSelfhealNotice(phase: SelfhealPhase, detail: string | null) {
  const 直前 = notices.at(-1)
  if (直前?.source === 'selfheal' && 直前.kind === phase) {
    return
  }
  const seq = 次のSeq()
  積む({
    id: 手元のId(seq),
    origin: 'browser',
    source: 'selfheal',
    kind: phase,
    // **サーバ側（`SelfhealPhase::label`）と同じ組み立て方にする。** 記録に載るのは
    // あちらが作った文なので、ここだけ書式が違うとベルの中で行ごとに揃わなくなる
    message: detail ? `${selfhealLabel(phase)} ${detail}` : selfhealLabel(phase),
    createdAt: Date.now(),
    seq,
    readAt: null,
  })
}

// ---------------------------------------------------------------------------
// 読む・消す
// ---------------------------------------------------------------------------

/**
 * サーバから取った一覧で入れ替える（開いたときの1回）。
 *
 * **手元だけの知らせは残す。** リロードしていないタブが抱えているぶんまで消すと、
 * 一覧を引き直しただけで画面から知らせが減る。
 */
export function replaceServerNotices(views: NoticeView[], unreadCount: number) {
  unreadFromServer = unreadCount
  const 手元 = notices.filter((notice) => notice.origin !== 'server')
  const 記録 = views.map((view) => ({
    id: view.id,
    origin: 'server' as const,
    source: view.source,
    kind: view.kind,
    message: view.message,
    createdAt: view.created_at,
    seq: 次のSeq(),
    readAt: view.read_at ?? null,
  }))
  // 古い順に並べ直す（器は古い順で持つ）
  notices = [...記録.reverse(), ...手元]
    .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
    .slice(-溜める上限)
  notify()
}

/** 未読の数（バッジ）。**サーバが数えたぶんと、手元だけのぶんを足す。** */
export function unreadCount() {
  const 手元 = notices.filter(
    (notice) => notice.origin !== 'server' && notice.readAt === null,
  ).length
  return unreadFromServer + 手元
}

/** 全部を既読にする（ベルを開いた瞬間。設計§10-3）。 */
export function markAllRead(readAt = Date.now()) {
  unreadFromServer = 0
  notices = notices.map((notice) =>
    notice.readAt === null ? { ...notice, readAt } : notice,
  )
  notify()
}

/** 1件消す。**ベルからも、出ているトーストからも消える。** */
export function removeNotice(id: string) {
  notices = notices.filter((notice) => notice.id !== id)
  visible = visible.filter((entry) => entry.notice.id !== id)
  notify()
}

/** 全部消す。 */
export function clearNotices() {
  notices = []
  visible = []
  unreadFromServer = 0
  notify()
}

/**
 * トーストを1件、手で閉じる。
 *
 * **ベルには残る。** 閉じたのは「いま読んだ」という意思表示であって、無かったことに
 * したいわけではない。
 */
export function dismissToast(id: string) {
  visible = visible.filter((entry) => entry.notice.id !== id)
  notify()
}

/**
 * マウスを乗せている間、消える時計を止める（設計§8-4）。
 *
 * **ゲージの見た目は CSS が止める**（`animation-play-state`）ので、ここは時計だけ。
 * 離れたら**残りぶんだけ**張り直す——読んでいる最中に消えるのを防ぐ。
 */
export function pauseToast(id: string) {
  const いま = Date.now()
  visible = visible.map((entry) =>
    entry.notice.id === id && entry.pausedRemaining === null && !entry.exiting
      ? { ...entry, pausedRemaining: Math.max(0, entry.expiresAt - いま) }
      : entry,
  )
  notify()
}

/** 乗せていた手を離す。**残っていたぶんだけ数え直す。** */
export function resumeToast(id: string) {
  const いま = Date.now()
  let 次 = Number.POSITIVE_INFINITY
  visible = visible.map((entry) => {
    if (entry.notice.id !== id || entry.pausedRemaining === null) {
      return entry
    }
    const expiresAt = いま + entry.pausedRemaining
    次 = Math.min(次, expiresAt)
    return { ...entry, pausedRemaining: null, expiresAt }
  })
  張り直す(次)
  notify()
}

// ---------------------------------------------------------------------------
// 購読
// ---------------------------------------------------------------------------

/** ベルに出す一覧（**新しい順**）。 */
export function useAppNotices(): readonly AppNotice[] {
  return useSyncExternalStore(subscribe, () => notices, () => 空の知らせ)
}

/** いま画面に出ているトースト。 */
export function useToasts(): readonly ToastEntry[] {
  return useSyncExternalStore(subscribe, () => visible, () => 空のトースト)
}

/** 未読の数（バッジ）。 */
export function useUnreadCount(): number {
  return useSyncExternalStore(subscribe, unreadCount, () => 0)
}

/** テスト用の巻き戻し。**製品コードから呼ばない。** */
export function clearAppNotices() {
  notices = []
  visible = []
  unreadFromServer = 0
  積んだ数 = 0
  if (時計 !== null) {
    clearTimeout(時計)
    時計 = null
  }
  予定 = Number.POSITIVE_INFINITY
  notify()
}

/** 購読しない読み取り（テスト用）。 */
export function getAppNotices(): readonly AppNotice[] {
  return notices
}

/** 購読しない読み取り（テスト用）。 */
export function getToasts(): readonly ToastEntry[] {
  return visible
}
