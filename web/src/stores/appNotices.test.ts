/**
 * アプリ全体の知らせの器（トーストとベル テスト計画フェーズ4）。
 *
 * **カード単位の断り（`notices.test.ts`）とは別のファイルにしてある。** 器が別物なので、
 * 同じファイルへ混ぜると「どちらの話か」を読むたびに考えることになる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TOAST_EXIT_MS,
  TOAST_LIFE_MS,
  TOAST_MAX_VISIBLE,
  clearAppNotices,
  dismissToast,
  getAppNotices,
  getToasts,
  markAllRead,
  pauseToast,
  pushBrowserNotice,
  pushReplyNotice,
  pushSelfhealNotice,
  pushServerNotice,
  removeNotice,
  replaceServerNotices,
  resumeToast,
  unreadCount,
  溜める上限,
} from './appNotices'
import type { NoticeView } from '@/lib/protocol'

function view(over: Partial<NoticeView> = {}): NoticeView {
  return {
    id: over.id ?? crypto.randomUUID(),
    source: over.source ?? 'error',
    kind: over.kind ?? 'other',
    message: over.message ?? 'サーバからの知らせ',
    created_at: over.created_at ?? Date.now(),
    read_at: over.read_at,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  clearAppNotices()
})

afterEach(() => {
  clearAppNotices()
  vi.useRealTimers()
})

describe('積む器', () => {
  it('上書きではなく積む', () => {
    pushBrowserNotice('ひとつめ')
    pushBrowserNotice('ふたつめ')
    expect(getAppNotices().map((n) => n.message)).toEqual(['ひとつめ', 'ふたつめ'])
  })

  it('出どころを型で分けて持つ', () => {
    pushServerNotice(view({ message: 'きろく' }), 1)
    pushBrowserNotice('せんがきれた')
    pushReplyNotice('おこせなかった')
    expect(getAppNotices().map((n) => n.origin)).toEqual(['server', 'browser', 'reply'])
  })

  it('上限を超えたら古いものから捨てる', () => {
    for (let i = 0; i < 溜める上限 + 5; i += 1) {
      pushBrowserNotice(`${i}`)
    }
    const 溜まり = getAppNotices()
    expect(溜まり).toHaveLength(溜める上限)
    // **古い5件が落ちている**
    expect(溜まり[0]?.message).toBe('5')
  })

  it('同じ段階の自己修復を続けて積まない', () => {
    pushSelfhealNotice('canary', null)
    pushSelfhealNotice('canary', null)
    expect(getAppNotices()).toHaveLength(1)
    // 段階が変われば積む
    pushSelfhealNotice('testing', null)
    expect(getAppNotices()).toHaveLength(2)
  })

  it('自己修復は押し出さずに積み重なる', () => {
    // **かつては単一スロットで、新しい段階が来ると前が黙って消えていた**（設計§6-2）
    pushSelfhealNotice('detected', null)
    pushSelfhealNotice('canary', null)
    pushSelfhealNotice('repairing', null)
    expect(getAppNotices().map((n) => n.kind)).toEqual(['detected', 'canary', 'repairing'])
  })
})

describe('トーストの寿命', () => {
  it('寿命が尽きると消えかけになり、その後で画面から外れる', () => {
    pushBrowserNotice('きえる')
    expect(getToasts()).toHaveLength(1)
    expect(getToasts()[0]?.exiting).toBe(false)

    vi.advanceTimersByTime(TOAST_LIFE_MS)
    expect(getToasts()[0]?.exiting).toBe(true)

    vi.advanceTimersByTime(TOAST_EXIT_MS)
    expect(getToasts()).toHaveLength(0)
  })

  it('トーストが消えてもベルには残る', () => {
    pushBrowserNotice('のこる')
    vi.advanceTimersByTime(TOAST_LIFE_MS + TOAST_EXIT_MS)
    expect(getToasts()).toHaveLength(0)
    // **トーストは出口の1つでしかない**（設計§1）
    expect(getAppNotices()).toHaveLength(1)
  })

  it('寿命の手前では消えない', () => {
    pushBrowserNotice('まだ')
    vi.advanceTimersByTime(TOAST_LIFE_MS - 1)
    expect(getToasts()[0]?.exiting).toBe(false)
  })

  it('同時に出るのは上限までで、溢れたぶんはベルへ直行する', () => {
    for (let i = 0; i < TOAST_MAX_VISIBLE + 2; i += 1) {
      pushBrowserNotice(`${i}`)
    }
    expect(getToasts()).toHaveLength(TOAST_MAX_VISIBLE)
    // **ベルには全部ある**——読み落とさない、で説明が足りる（設計§8-5）
    expect(getAppNotices()).toHaveLength(TOAST_MAX_VISIBLE + 2)
  })

  it('新しいものが先頭に積まれる', () => {
    pushBrowserNotice('ふるい')
    pushBrowserNotice('あたらしい')
    expect(getToasts().map((e) => e.notice.message)).toEqual(['あたらしい', 'ふるい'])
  })
})

describe('マウスを乗せている間は止まる', () => {
  it('止めている間は寿命が尽きない', () => {
    pushBrowserNotice('よんでいる')
    const id = getToasts()[0]!.notice.id

    vi.advanceTimersByTime(TOAST_LIFE_MS / 2)
    pauseToast(id)
    // **止めたまま寿命ぶん待っても消えない**（読んでいる最中に消えるのを防ぐ）
    vi.advanceTimersByTime(TOAST_LIFE_MS * 2)
    expect(getToasts()[0]?.exiting).toBe(false)
  })

  it('離すと残りぶんだけ数え直す', () => {
    pushBrowserNotice('よみおわった')
    const id = getToasts()[0]!.notice.id

    vi.advanceTimersByTime(TOAST_LIFE_MS / 2)
    pauseToast(id)
    vi.advanceTimersByTime(TOAST_LIFE_MS * 2)
    resumeToast(id)

    // **残りは半分。** 全部ではない——止めた時点の残りだけを数え直す
    vi.advanceTimersByTime(TOAST_LIFE_MS / 2 - 1)
    expect(getToasts()[0]?.exiting).toBe(false)
    vi.advanceTimersByTime(1)
    expect(getToasts()[0]?.exiting).toBe(true)
  })
})

describe('消す道', () => {
  it('手で閉じてもベルには残る', () => {
    pushBrowserNotice('とじる')
    const id = getToasts()[0]!.notice.id
    dismissToast(id)
    expect(getToasts()).toHaveLength(0)
    // **閉じたのは「いま読んだ」という意思表示**であって、無かったことにしたいわけではない
    expect(getAppNotices()).toHaveLength(1)
  })

  it('1件消すとベルからもトーストからも消える', () => {
    pushBrowserNotice('けす')
    const id = getAppNotices()[0]!.id
    removeNotice(id)
    expect(getAppNotices()).toHaveLength(0)
    expect(getToasts()).toHaveLength(0)
  })
})

describe('未読', () => {
  it('サーバが数えたぶんと手元のぶんを足す', () => {
    // サーバ由来は**サーバが数えた値**を使う（設計§6-1）
    pushServerNotice(view(), 3)
    pushBrowserNotice('てもと')
    expect(unreadCount()).toBe(4)
  })

  it('全部既読にすると0になる', () => {
    pushServerNotice(view(), 3)
    pushBrowserNotice('てもと')
    markAllRead()
    expect(unreadCount()).toBe(0)
  })
})

describe('記録から取り直す', () => {
  it('手元だけの知らせは残る', () => {
    pushBrowserNotice('てもとのぶん')
    replaceServerNotices([view({ message: 'きろくのぶん' })], 1)

    const 溜まり = getAppNotices()
    expect(溜まり.map((n) => n.message).sort()).toEqual(['きろくのぶん', 'てもとのぶん'])
  })

  it('取り直しても古い順のまま', () => {
    const 基準 = Date.now()
    replaceServerNotices(
      [
        view({ message: 'あたらしい', created_at: 基準 }),
        view({ message: 'ふるい', created_at: 基準 - 1000 }),
      ],
      2,
    )
    expect(getAppNotices().map((n) => n.message)).toEqual(['ふるい', 'あたらしい'])
  })
})

/**
 * **値そのものを見る。** 他のテストは `TOAST_LIFE_MS` を import して期待値に使うので、
 * 定数を書き換えると期待値まで一緒に動き、**1本も落ちない**（テスト計画の「壊し方を当てる」で
 * 実際に確かめた）。振る舞いは守られているが、数そのものは誰も見ていなかった。
 *
 * 数を変えるとここが落ちる。**落ちたら直すのではなく、変えてよい数かを考えること。**
 * 7秒は利用者が「7秒ほど」と言った値で、実物を見て決め直す前提の数である（設計§8-3）。
 */
describe('決めた数を、そのまま見張る', () => {
  it('トーストは7秒で消える', () => {
    expect(TOAST_LIFE_MS).toBe(7_000)
  })

  it('出ていくのに200ミリ秒かける', () => {
    expect(TOAST_EXIT_MS).toBe(200)
  })

  it('同時に出るのは3件まで', () => {
    expect(TOAST_MAX_VISIBLE).toBe(3)
  })
})
