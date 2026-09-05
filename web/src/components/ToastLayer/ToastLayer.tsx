/**
 * 最前面のトースト層（トーストとベル設計§8・§9／スワイプで消す設計§4）。
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
 *
 * # 1件ずつを部品に切り出してある
 *
 * 払って消す動きは**トースト1件ごとに状態を持つ**（どこまで運ばれたか）。
 * 層の側で表に持つと、積まれた枚数だけ添字を配ることになる——
 * **部品にすれば、各自が自分のぶんだけ持つ。**
 */
import { useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CloseGlyph } from '@/components/ui/glyphs'
import { useCoarsePointer } from '@/lib/pointer'
import {
  type SwipeAxis,
  followOffset,
  followOpacity,
  lockAxis,
  shouldDismiss,
} from '@/lib/swipeDismiss'
import {
  TOAST_LIFE_MS,
  type ToastEntry,
  dismissToast,
  pauseToast,
  resumeToast,
  useToasts,
} from '@/stores/appNotices'
import { useSettingsStore } from '@/stores/settings'

interface DragState {
  pointerId: number
  startX: number
  startY: number
  axis: SwipeAxis
}

function ToastItem({ entry }: { entry: ToastEntry }) {
  // **指で触る端末だけ。** PC で引っぱれるようにすると、文言を選んで写せなくなる——
  // あちらは ✕ が狙いやすく、マウスを乗せれば時計も止まるので、得るものが無い
  const coarse = useCoarsePointer()
  const drag = useRef<DragState | null>(null)
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null)
  const id = entry.notice.id

  const 終う = useCallback(() => {
    drag.current = null
    setOffset(null)
  }, [])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!coarse || drag.current) {
        return
      }
      // **✕ の上から始まった動きは取らない。** あれは押して閉じるものなので、
      // 途中で払いに化けると「押したのに閉じない」が起きる
      if ((event.target as HTMLElement).closest('button')) {
        return
      }
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        axis: 'none',
      }
      // **触った瞬間に印を立てる**（動かす前でも）。ゲージが止まるのを
      // これで合わせる——時計だけ止めてゲージが減り続けると、**残り時間の表示が
      // 嘘になる**
      setOffset({ x: 0, y: 0 })
      // **触っている間は消えない。** 指の画面には `:hover` が無いので、
      // 時計を止める道はここしか無い（副産物として、押さえたまま読める）
      pauseToast(id)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [coarse, id],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const いま = drag.current
      if (!いま || いま.pointerId !== event.pointerId) {
        return
      }
      const dx = event.clientX - いま.startX
      const dy = event.clientY - いま.startY
      いま.axis = lockAxis(いま.axis, dx, dy)
      setOffset(followOffset(いま.axis, dx, dy))
    },
    [],
  )

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const いま = drag.current
      if (!いま || いま.pointerId !== event.pointerId) {
        return
      }
      const dx = event.clientX - いま.startX
      const dy = event.clientY - いま.startY
      const 消す = shouldDismiss(いま.axis, dx, dy)
      終う()
      if (消す) {
        // **✕ と同じ即時。** 指が既にそこまで運んでいるので、離してから
        // 改めて動かして見せる必要が無い（`dismissToast` はベルには残す）
        dismissToast(id)
        return
      }
      resumeToast(id)
    },
    [id, 終う],
  )

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drag.current || drag.current.pointerId !== event.pointerId) {
        return
      }
      終う()
      resumeToast(id)
    },
    [id, 終う],
  )

  return (
    <div
      className="toast flex items-center justify-between gap-3 border border-amber-500/40 bg-amber-500/10 px-3 py-2 pb-3 text-sm backdrop-blur-sm"
      data-testid="toast"
      data-source={entry.notice.source}
      data-kind={entry.notice.kind}
      data-origin={entry.notice.origin}
      data-exiting={entry.exiting ? 'true' : undefined}
      // **運んでいる間だけ印を立てる。** CSS はこれを見て、入りの動きと
      // 指への追従が重ならないようにする
      data-swiping={offset ? 'true' : undefined}
      // 消える時計を止める。**ゲージの見た目は CSS の `:hover` が止める**ので、
      // ここで触るのは時計だけ（設計§8-4）
      onMouseEnter={() => pauseToast(entry.notice.id)}
      onMouseLeave={() => resumeToast(entry.notice.id)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{
        ['--toast-life' as string]: `${TOAST_LIFE_MS}ms`,
        ...(offset
          ? {
              translate: `${offset.x}px ${offset.y}px`,
              opacity: followOpacity(offset),
            }
          : null),
      }}
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
  )
}

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
        <ToastItem key={entry.notice.id} entry={entry} />
      ))}
    </div>
  )
}
