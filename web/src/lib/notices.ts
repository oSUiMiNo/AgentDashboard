/**
 * アプリ全体の知らせを、記録から読む・記録の側を直す（トーストとベル設計§6-1）。
 *
 * # まず全体を取り、以後は差分だけを見る
 *
 * `/api/sessions` と同じ原則。開いたときにここで一覧と未読数を取り、あとは
 * WebSocket の `notice_created` を見る。
 *
 * # 失敗しても画面を止めない
 *
 * 記録が読めなくても、**その場で届く知らせ（トースト）は出る**。ベルの中身が
 * 前回のままになるだけなので、断りを出してまで知らせることではない——
 * 知らせが読めないことを知らせるのは、輪になりかけている。
 */
import type { NoticeView } from '@/lib/protocol'
import { replaceServerNotices } from '@/stores/appNotices'

interface NoticePage {
  notices: NoticeView[]
  has_more: boolean
  unread_count: number
}

/**
 * 記録から一覧を取り、手元の器へ入れ替える。
 *
 * **手元だけの知らせ（線が切れた・この接続への返事）は残る**——器の側が
 * 出どころを見て残す。
 */
export async function loadServerNotices(): Promise<void> {
  try {
    const response = await fetch('/api/notices')
    if (!response.ok) {
      return
    }
    const page = (await response.json()) as NoticePage
    replaceServerNotices(page.notices, page.unread_count)
  } catch {
    // 読めなくても画面は動く（このファイルの冒頭）
  }
}

/** 未読をまとめて既読にする。 */
export async function markServerNoticesRead(): Promise<void> {
  try {
    await fetch('/api/notices/read', { method: 'POST' })
  } catch {
    // 手元は先に 0 にしてある。往復が失敗しても戻さない
  }
}

/** 記録から1件消す。 */
export async function removeServerNotice(id: string): Promise<void> {
  try {
    await fetch(`/api/notices/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch {
    // 手元は先に消してある
  }
}

/** 記録から全部消す。 */
export async function clearServerNotices(): Promise<void> {
  try {
    await fetch('/api/notices', { method: 'DELETE' })
  } catch {
    // 同上
  }
}
