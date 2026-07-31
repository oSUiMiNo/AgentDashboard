/**
 * セッション専用画面（設計§10）。
 *
 * 構造化ビュー（履歴のネスト表示）とターミナルビューをタブで切り替える。要件が言う
 * 「普段は構造化ビュー、対話的操作の瞬間だけターミナル」という使い分けにそのまま対応する。
 *
 * # 切り替えても作り直さない
 *
 * どちらのビューも**常にマウントしたまま**にして、非表示側は CSS で隠すだけにする。
 * ターミナルを外すと xterm のインスタンスとスクロールバックが消え、戻るたびに
 * 作り直しになる。構造化ビュー側も展開状態とスクロール位置を失う。
 *
 * 隠している間はターミナルの寸法が 0 になるが、`TerminalPane` の見張りは
 * 「大きさ 0 のときは採寸しない」ようにしてあるので、再表示で自動的に測り直される。
 *
 * 指示を送る [`Composer`] はタブの**外側**に常設する。構造化ビューを見ながら指示を出す、
 * というのが要件の使い方なので、送るたびにターミナルへ切り替えさせない。
 */

import { motion } from 'motion/react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Composer } from '@/components/Composer/Composer'
import { ModelPicker } from '@/components/ModelPicker/ModelPicker'
import { PermissionModePicker } from '@/components/PermissionModePicker/PermissionModePicker'
import { TerminalPane } from '@/components/TerminalPane/TerminalPane'
import { TranscriptTree } from '@/components/TranscriptTree/TranscriptTree'
import { formatElapsed, formatScreenInterval } from '@/lib/time'
import { isEnded, isHookSilent, statusLabel, statusTone } from '@/lib/protocol'
import type { CardId } from '@/lib/protocol'
import { useNow } from '@/lib/sessions'
import { useSessionCard } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

type View = 'transcript' | 'terminal'

interface Props {
  cardId: CardId
  /** 横並び表示（グループビュー）で使うときは幅を固定する */
  compact?: boolean
}

export function SessionView({ cardId, compact = false }: Props) {
  const kill = useWsStore((state) => state.kill)
  const archive = useWsStore((state) => state.archive)
  // 中身は自分で購読する。横並びのとき、隣のセッションの状態変化で作り直されないため
  const session = useSessionCard(cardId)
  const now = useNow()
  // 単独で開いたときは履歴が主役。横並びのときは一望して即操作したいのでターミナル
  const [view, setView] = useState<View>(compact ? 'terminal' : 'transcript')

  if (!session) {
    // 消えた直後の一瞬。単独表示のときは呼び出し側が「見つかりません」を出す
    return null
  }

  return (
    <section
      data-testid="session-view"
      data-card-id={session.card_id}
      data-status={session.status.kind}
      data-view={view}
      className={`flex min-h-0 flex-col gap-2 ${
        compact ? 'w-[42rem] shrink-0' : 'min-w-0 flex-1'
      }`}
    >
      <header className="flex items-center gap-2 text-sm">
        <span
          aria-hidden
          className={`size-2.5 shrink-0 rounded-full ${statusTone(session.status)}`}
        />
        {/*
          縮んでよいのは作業ディレクトリだけ。`min-w-0` を付けないと flex の子は
          中身の幅より小さくならず、`truncate` が効かない。実際、長いパスのときに
          状態のラベルが「入力 待ち」と縦に割れていた（**一番読みたいものが読めない**）
        */}
        <span className="min-w-0 truncate font-medium" title={session.project}>
          {session.project}
        </span>
        <span className="text-muted-foreground shrink-0">
          {statusLabel(session.status)}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs">
          最終活動 {formatElapsed(now - session.last_activity_at)}
        </span>
        {isHookSilent(session) && (
          <span
            data-testid="hook-warning"
            className="shrink-0 text-xs text-amber-400"
          >
            フック未受信
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/*
            モードとモデルは小窓とセッション画面の両方に出す（要件）。ここは切替も兼ねる。
            並びは モデル → モード。モデルのほうが長い文字列になるので、
            幅の変動を右端の固定幅ボタンから遠ざける
          */}
          {!isEnded(session.status) && (
            <>
              <ModelPicker cardId={session.card_id} />
              <PermissionModePicker cardId={session.card_id} />
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={isEnded(session.status)}
            onClick={() => kill(session.card_id)}
          >
            終了
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => archive(session.card_id)}
          >
            削除
          </Button>
        </div>
      </header>

      <div className="flex items-center gap-2">
        <div
          role="tablist"
          className="border-border bg-background/60 flex w-fit gap-1 rounded-lg border p-0.5 text-sm"
        >
          <ViewTab
            current={view}
            value="transcript"
            onSelect={setView}
            cardId={cardId}
          >
            構造化ビュー
          </ViewTab>
          <ViewTab
            current={view}
            value="terminal"
            onSelect={setView}
            cardId={cardId}
          >
            ターミナル
          </ViewTab>
        </div>
        <ScreenInterval remote={session.agent_id !== null} shown={view === 'terminal'} />
      </div>

      {/* 表示していない側もマウントしたまま隠す（作り直さないため） */}
      <div className={`flex min-h-0 flex-1 flex-col ${view === 'transcript' ? '' : 'hidden'}`}>
        <TranscriptTree key={session.card_id} cardId={session.card_id} />
      </div>
      <div className={`flex min-h-0 flex-1 flex-col ${view === 'terminal' ? '' : 'hidden'}`}>
        <TerminalPane key={session.card_id} cardId={session.card_id} />
      </div>

      <Composer cardId={session.card_id} status={session.status} />
    </section>
  )
}

/**
 * 別の PC の画面がどれくらいの間隔で届くかを小さく出す（セルフホスト化設計§11-3）。
 *
 * # 出さないと区別がつかない
 *
 * 無操作のあいだ、リモートの画面は間隔をあけて届く（既定20秒）。数字が無いと
 * **「相手が止まっている」と「間引かれているだけ」が同じに見える**。入力した直後だけは
 * 細かく届く（ホットウィンドウ。§7-5）ので、ここに出るのは「何もしていないとき」の話。
 *
 * この PC のセッション（ローカル）では生バイトがそのまま届くので、出す値が無い。
 */
function ScreenInterval({ remote, shown }: { remote: boolean; shown: boolean }) {
  const intervalMs = useSettingsStore(
    (state) => state.settings.intervals.screen_interval_ms,
  )
  if (!remote || !shown) {
    return null
  }
  return (
    <span
      data-testid="screen-interval"
      className="text-muted-foreground text-xs"
      title="別の PC の画面は、何もしていない間はこの間隔で届きます（入力した直後は細かく届きます）"
    >
      更新間隔 {formatScreenInterval(intervalMs)}
    </span>
  )
}

function ViewTab({
  current,
  value,
  onSelect,
  cardId,
  children,
}: {
  current: View
  value: View
  onSelect: (view: View) => void
  /** 下地の共有IDに混ぜる。横並び表示では同じ画面に複数のタブ列が並ぶため */
  cardId: CardId
  children: React.ReactNode
}) {
  const active = current === value
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={`view-tab-${value}`}
      onClick={() => onSelect(value)}
      className={`relative rounded-md px-3 py-1 transition-colors ${
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {/* 選択中の下地だけを動かす。切り替えたことが分かればよく、中身は動かさない */}
      {active && (
        <motion.span
          layoutId={`view-tab-active-${cardId}`}
          transition={{ type: 'spring', stiffness: 400, damping: 32 }}
          className="bg-muted absolute inset-0 rounded-md shadow-sm"
        />
      )}
      <span className="relative">{children}</span>
    </button>
  )
}
