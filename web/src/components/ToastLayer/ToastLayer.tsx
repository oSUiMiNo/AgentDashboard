/**
 * 最前面のトースト層（トーストとベル設計§8・§9）。
 *
 * # 効果線の層と、置き場所が違う
 *
 * あちらは `HomePage` の中（場の直下）に置いてあるので**一覧にしか出ない**。
 * こちらは `Shell` の直下に置く——PJT 専用画面でもセッション専用画面でも、
 * 知らせは出なければならない。
 *
 * # 層は触れない。個々のトーストだけが触れる
 *
 * 層は画面いっぱいに貼るので、`pointer-events` を戻すと**下の操作を全部食う**。
 * 触れるのは ✕ とマウスオーバーだけでよいので、戻すのは1件ずつの側だけ。
 *
 * # 7秒で消えるものは、見ていない人には無かったのと同じになる
 *
 * だから `role="status"` と `aria-live="polite"` を付ける。既存の断り
 * （`SessionTile` / `SessionView`）と同じ理屈で、遮らない `polite` を選ぶ。
 */
import { Button } from '@/components/ui/button'
import { CloseGlyph } from '@/components/ui/glyphs'
import {
  TOAST_LIFE_MS,
  dismissToast,
  pauseToast,
  resumeToast,
  useToasts,
} from '@/stores/appNotices'
import { useSettingsStore } from '@/stores/settings'

export function ToastLayer() {
  const toasts = useToasts()
  const quiet = useSettingsStore((s) => s.settings.motion_quiet)

  // 1件も無いときは層ごと出さない。**空の `fixed` を残さない**——
  // 開発者ツールで見たときに「何か貼ってある」と読めてしまう
  if (toasts.length === 0) {
    return null
  }

  return (
    <div
      className="toast-layer"
      data-testid="toast-layer"
      // **賑やかのときは属性ごと出さない**（既存の層と揃えた作法）
      data-quiet={quiet === 'lively' ? undefined : quiet}
      role="status"
      aria-live="polite"
    >
      {toasts.map((entry) => (
        <div
          key={entry.notice.id}
          className="toast flex items-center justify-between gap-3 border border-amber-500/40 bg-amber-500/10 px-3 py-2 pb-3 text-sm backdrop-blur-sm"
          data-testid="toast"
          data-source={entry.notice.source}
          data-kind={entry.notice.kind}
          data-origin={entry.notice.origin}
          data-exiting={entry.exiting ? 'true' : undefined}
          // 消える時計を止める。**ゲージの見た目は CSS の `:hover` が止める**ので、
          // ここで触るのは時計だけ（設計§8-4）
          onMouseEnter={() => pauseToast(entry.notice.id)}
          onMouseLeave={() => resumeToast(entry.notice.id)}
          style={{ ['--toast-life' as string]: `${TOAST_LIFE_MS}ms` }}
        >
          <span>{entry.notice.message}</span>
          {/*
            **面を閉じるのは ✕**（細かい修正 設計§9-1）。`close.test.ts` が
            ファイルを横断してこの作法を機械で守らせている——`<Button>` で包み、
            絵だけを置き、読み上げ用の名前を残す。
          */}
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="toast-close"
            aria-label="閉じる"
            title="閉じる"
            onClick={() => dismissToast(entry.notice.id)}
          >
            <CloseGlyph />
          </Button>
          <span className="toast-gauge bg-amber-400" aria-hidden="true" />
        </div>
      ))}
    </div>
  )
}
