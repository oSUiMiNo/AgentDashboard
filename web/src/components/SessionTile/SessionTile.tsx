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
 *
 * # 動きを付けてよい場所
 *
 * 動かすのは**カードの出入りと、人の対処を待っている印**だけ。状態の変化はフックの
 * 頻度（ツールコールごと）で来るので、そこに演出を足すと画面が騒がしくなり、
 * 「本当に見るべきもの」が埋もれる。要件が言う一覧の目的と逆行する。
 */

import { modelLabel } from '@/lib/models'
import { motion } from 'motion/react'
import { useNavigate } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { formatElapsed } from '@/lib/time'
import {
  isHookSilent,
  needsAttention,
  permissionModeLabel,
  permissionModeTone,
  statusLabel,
  statusTone,
} from '@/lib/protocol'
import type { CardId } from '@/lib/protocol'
import { sessionPath } from '@/lib/routes'
import { useNow } from '@/lib/sessions'
import { useSessionCard } from '@/stores/sessions'
import { agentName, useSettingsStore } from '@/stores/settings'

interface Props {
  cardId: CardId
}

export function SessionTile({ cardId }: Props) {
  const navigate = useNavigate()
  const session = useSessionCard(cardId)
  const agents = useSettingsStore((state) => state.settings.agents)
  const now = useNow()

  if (!session) {
    // 消えた直後の一瞬。構造の更新が届けば親から外れる
    return null
  }
  const attention = needsAttention(session.status)
  // **どの PC のセッションかは一覧で判別できる**（要件4-4）。名前は起動時に読む
  // 設定から引く（`agent_id` は変わらないが、名前は後から変わりうるため）
  const pc = agentName(agents, session.agent_id)
  // 繋がっていないカードは**薄くして印を付ける**。状態そのものは書き換えない——
  // 「作業中（接続断）」が要件2-3 の充足形で、最後に知っていた状態は残す（設計§6-3）
  const stale = !session.agent_connected

  return (
    <motion.button
      type="button"
      // `layout` は付けない。並びが変わるたびに小窓が動き続けることになり、
      // 押そうとした瞬間に的が逃げる。一覧は「押して開く」ための画面なので、
      // 見栄えより狙いやすさを優先する
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      data-testid="session-tile"
      data-card-id={session.card_id}
      data-status={session.status.kind}
      data-connected={session.agent_connected}
      onClick={(event) => {
        // 小窓をクリックしたときは、その1枚だけを開く。止めないと親（グループの余白）へ
        // 伝わってしまい、常に全員の横並びが開いてしまう（仕様§10 の作り分け）
        event.stopPropagation()
        navigate(sessionPath(session.card_id))
      }}
      className={`bg-card flex w-64 flex-col gap-2 rounded-xl border p-3 text-left shadow-sm transition-colors ${
        attention
          ? 'border-amber-500/70 bg-amber-500/5'
          : 'border-border hover:border-primary/60'
      } ${stale ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="relative flex size-2.5 shrink-0">
          {/* 人の対処を待っている間だけ脈打たせる。放っておくと止まったままになる状態 */}
          {attention && (
            <span
              aria-hidden
              className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${statusTone(session.status)}`}
            />
          )}
          <span
            data-testid="status-dot"
            aria-hidden
            className={`relative inline-flex size-2.5 rounded-full transition-colors ${statusTone(session.status)}`}
          />
        </span>
        <span className="text-sm font-medium">
          {statusLabel(session.status)}
        </span>
        {stale && (
          <Badge
            data-testid="disconnected-badge"
            variant="secondary"
            className="text-muted-foreground"
            title="この PC からの報告が届いていません。表示は最後に分かっていた状態です"
          >
            接続断
          </Badge>
        )}
        {session.subagent_active > 0 && (
          <Badge
            data-testid="subagent-badge"
            variant="secondary"
            className="ml-auto text-violet-300"
          >
            サブエージェント {session.subagent_active}
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span data-testid="elapsed" className="text-muted-foreground text-xs">
          最終活動 {formatElapsed(now - session.last_activity_at)}
        </span>
        {/*
          権限モードは一覧にも出す（要件）。**危険なモードほど目立たせ、既定のモードは
          静かに出す** — 全承認をスキップしているセッションが並んでいるのに気づかない、
          という状態を作らないため（設計§8）。

          まだ分からない間は**何も出さない**。状態の「不明」と並ぶと、どちらが不明なのか
          読み取れなくなる。分からないのは起動直後の一瞬（フッタを読むまで）で、
          理由を名指しする必要があるのはセッション画面のほう（そちらは選択肢に出す）
        */}
        {/*
          モデルも一覧に出す（要件「切り替えた結果が一覧の小窓にも反映される」）。
          出すのは CLI が名乗った表示名で、版番号が入る（設計§12）。
          モードと同じく、**まだ分からない間は何も出さない** — 状態の「不明」と
          並ぶと、どちらが不明なのか読み取れなくなる
        */}
        {/*
          右端へ寄せるのは**入れ物のほう**。個々のバッジに `ml-auto` を付けると、
          そのバッジが出ないときに寄せ先ごと消えて並びが崩れる。モデルは起動から
          最初の statusLine までは必ず不明で、`inject_status_line = false` の間は
          ずっと不明なので、片方だけ出る時間は短くない
        */}
        {(session.model !== null ||
          session.permission_mode !== null ||
          pc !== null ||
          session.toml_account !== null) && (
          <div
            data-testid="tile-badges"
            className="ml-auto flex min-w-0 items-center gap-2"
          >
            {pc !== null && (
              <span
                data-testid="agent-badge"
                className="text-muted-foreground min-w-0 truncate text-xs"
                title={`この セッションは「${pc}」で動いています`}
              >
                {pc}
              </span>
            )}
            {session.toml_account !== null && (
              <span
                data-testid="toml-account-badge"
                className="text-muted-foreground min-w-0 truncate text-xs"
                title=".agent-dashboard.toml がこのプロジェクトについて名乗った名前です"
              >
                @{session.toml_account}
              </span>
            )}
            {session.model !== null && (
              <span
                data-testid="model"
                data-model={session.model}
                className="max-w-28 shrink-0 truncate rounded border border-border px-1.5 py-0.5 text-[0.7rem] text-muted-foreground"
                title={session.model}
              >
                {modelLabel(session.model, session.model_label)}
              </span>
            )}
            {session.permission_mode !== null && (
              <span
                data-testid="permission-mode"
                data-mode={session.permission_mode}
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[0.7rem] ${permissionModeTone(session.permission_mode)}`}
              >
                {permissionModeLabel(session.permission_mode)}
              </span>
            )}
          </div>
        )}
      </div>

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
    </motion.button>
  )
}
