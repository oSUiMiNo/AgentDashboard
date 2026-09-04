/**
 * アプリ全体の知らせを、ヘッダのベルから読ませる（トーストとベル設計§10）。
 *
 * # 既存のベルとは別物である
 *
 * `NoticeBell`（カード用）は**そのカードの断り**を出す。こちらは**アプリ全体の知らせ**で、
 * サーバ由来のぶんは記録に残り**端末をまたぐ**。
 *
 * **同じ画面に両方が映る場面がある**（PJT 専用画面には、カードのベルとヘッダのベルが
 * 同時に出る）。似ていると、どちらを押したのか分からなくなる——だから置き場所・
 * 見た目・testid・読み上げの文言をすべて分けてある。
 *
 * | | カード用 | これ |
 * |---|---|---|
 * | 見た目 | 小さいインライン文字列 | **アイコンボタン＋未読バッジ** |
 * | testid | `notice-bell` 系 | **`app-notice-bell` 系** |
 * | 読み上げ | 「溜まっている知らせ N件」 | **「アプリ全体の知らせ N件」** |
 *
 * **アイコン自体は同じベルでよい。** 別の絵にすると、今度は「ベルではない何か」に見える。
 *
 * # 開いた瞬間に全件を既読にする
 *
 * 1件ずつの既読は作らない（設計§10-3）。溜まる数が知れているので、開いて見た＝読んだ、
 * で足りる。
 */
import { useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { BellGlyph, CloseGlyph } from '@/components/ui/glyphs'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  clearNotices,
  markAllRead,
  removeNotice,
  useAppNotices,
  useUnreadCount,
} from '@/stores/appNotices'
import { clearServerNotices, markServerNoticesRead, removeServerNotice } from '@/lib/notices'

/** 時刻を「いま起きたことか、昔のことか」が読める最小の形で出す。 */
function 時刻(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function AppNoticeBell() {
  const notices = useAppNotices()
  const unread = useUnreadCount()

  const 開いたら既読にする = useCallback((open: boolean) => {
    if (!open) {
      return
    }
    // **手元を先に0にする。** 往復を待つと、押した直後にバッジが残って見える
    markAllRead()
    // 記録の側も既読にする。**失敗しても手元は戻さない**——バッジが行ったり来たり
    // するほうが、次に開いたときにもう一度 0 になるより悪い
    void markServerNoticesRead()
  }, [])

  const 全部消す = useCallback(() => {
    clearNotices()
    void clearServerNotices()
  }, [])

  const 一件消す = useCallback((id: string, origin: string) => {
    removeNotice(id)
    // 記録に載っていないものは、消す先が無い
    if (origin === 'server') {
      void removeServerNotice(id)
    }
  }, [])

  // **1件も無ければ出さない。** 押す意味の無い印を画面に居座らせない
  // （カード用のベルと同じ判断）
  if (notices.length === 0) {
    return null
  }

  // **新しい順。** いま起きたことから読みたい
  const 新しい順 = [...notices].reverse()

  return (
    <Popover onOpenChange={開いたら既読にする}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="app-notice-bell"
          aria-label={`アプリ全体の知らせ ${notices.length}件`}
          title={`アプリ全体の知らせ ${notices.length}件`}
          className="relative"
        >
          <BellGlyph />
          {/*
            **未読が無いときはバッジを出さない。** ベル自体は出したまま——
            「読んだもの」を後から拾う道が消えると、ベルの用が無くなる
          */}
          {unread > 0 && (
            <span
              data-testid="app-notice-unread"
              className="bg-destructive text-destructive-foreground absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full px-1 text-[0.6rem] leading-3.5"
            >
              {unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent data-testid="app-notice-list" className="w-80">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-muted-foreground text-xs">
            アプリ全体の知らせ {notices.length}件
          </span>
          {/*
            **「全部消す」は文字**（細かい修正 設計§9-1）。面を閉じるのは ✕ だが、
            これは操作なので文字にする——取り返しの付かなさが違う
          */}
          <Button
            variant="ghost"
            size="sm"
            data-testid="app-notice-clear"
            onClick={全部消す}
          >
            全部消す
          </Button>
        </div>
        <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {新しい順.map((notice) => (
            <li
              key={notice.id}
              data-testid="app-notice-item"
              data-source={notice.source}
              data-kind={notice.kind}
              data-origin={notice.origin}
              className="flex items-start justify-between gap-2"
            >
              <div className="flex flex-col gap-0.5">
                <time className="text-muted-foreground text-[0.65rem]">
                  {時刻(notice.createdAt)}
                </time>
                <span className="text-xs">{notice.message}</span>
              </div>
              {/*
                **1行の ✕ は「面を閉じる ✕」ではない。** 読み上げは「閉じる」ではなく、
                何を消すのかが分かる文言にする（設計§10-3）
              */}
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="app-notice-item-remove"
                aria-label="この知らせを消す"
                title="この知らせを消す"
                onClick={() => 一件消す(notice.id, notice.origin)}
              >
                <CloseGlyph />
              </Button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
