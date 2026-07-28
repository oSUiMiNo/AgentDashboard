/**
 * 一覧画面の小窓1枚（要件「一覧画面（司令塔ビュー）」／設計§10）。
 *
 * 小窓の主役は**ログの縮小表示ではなく状態インジケータ**。「AIが止まらずちゃんと働いて
 * いるか」を一瞥で確かめるのが目的なので、状態の色と最終活動からの経過時間を最も大きく出す。
 *
 * 経過時間を必ず並べるのは、「作業中」の表示のままハングしているケースを見逃さないため。
 * 状態ラベルだけでは、動いているのか固まっているのかが区別できない。
 *
 * # 自分のカードだけを購読する
 *
 * カードIDだけを受け取り、中身はストアから直接購読する（設計§10）。親から中身を配ると、
 * 1枚の状態が変わっただけで親が作り直され、他の小窓まで再レンダリングの判定に入る。
 */

import { useNavigate } from 'react-router'
import { formatElapsed } from '@/lib/time'
import {
  isHookSilent,
  needsAttention,
  statusLabel,
  statusTone,
} from '@/lib/protocol'
import type { CardId } from '@/lib/protocol'
import { sessionPath } from '@/lib/routes'
import { useNow } from '@/lib/sessions'
import { useSessionCard } from '@/stores/sessions'

interface Props {
  cardId: CardId
}

export function SessionTile({ cardId }: Props) {
  const navigate = useNavigate()
  const session = useSessionCard(cardId)
  const now = useNow()

  if (!session) {
    // 消えた直後の一瞬。構造の更新が届けば親から外れる
    return null
  }
  const attention = needsAttention(session.status)

  return (
    <button
      type="button"
      data-testid="session-tile"
      data-card-id={session.card_id}
      data-status={session.status.kind}
      onClick={(event) => {
        // 小窓をクリックしたときは、その1枚だけを開く。止めないと親（グループの余白）へ
        // 伝わってしまい、常に全員の横並びが開いてしまう（仕様§10 の作り分け）
        event.stopPropagation()
        navigate(sessionPath(session.card_id))
      }}
      className={`flex w-64 flex-col gap-2 rounded-lg border p-3 text-left transition-colors ${
        attention
          ? 'border-amber-500/70 bg-amber-500/5'
          : 'border-input hover:border-primary/60'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          data-testid="status-dot"
          aria-hidden
          className={`size-2.5 shrink-0 rounded-full ${statusTone(session.status)}`}
        />
        <span className="text-sm font-medium">
          {statusLabel(session.status)}
        </span>
        {session.subagent_active > 0 && (
          <span
            data-testid="subagent-badge"
            className="ml-auto rounded-full bg-violet-500/15 px-2 py-0.5 text-xs text-violet-300"
          >
            サブエージェント {session.subagent_active}
          </span>
        )}
      </div>

      <span data-testid="elapsed" className="text-muted-foreground text-xs">
        最終活動 {formatElapsed(now - session.last_activity_at)}
      </span>

      {/* 「不明」の理由を名指しする。原因は利用者が直せるものが多い（設計§11） */}
      {isHookSilent(session) && (
        <span data-testid="hook-warning" className="text-xs text-amber-400">
          フック未受信（設定の注入が効いていない可能性）
        </span>
      )}

      {session.last_assistant_message && (
        <p
          data-testid="last-message"
          className="text-muted-foreground line-clamp-2 text-xs"
        >
          {session.last_assistant_message}
        </p>
      )}
    </button>
  )
}
