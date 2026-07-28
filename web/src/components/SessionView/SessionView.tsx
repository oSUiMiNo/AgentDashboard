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

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Composer } from '@/components/Composer/Composer'
import { TerminalPane } from '@/components/TerminalPane/TerminalPane'
import { TranscriptTree } from '@/components/TranscriptTree/TranscriptTree'
import { formatElapsed } from '@/lib/time'
import { isEnded, statusLabel, statusTone } from '@/lib/protocol'
import type { CardId } from '@/lib/protocol'
import { useNow } from '@/lib/sessions'
import { useSessionCard } from '@/stores/sessions'
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
        <span className="truncate font-medium" title={session.project}>
          {session.project}
        </span>
        <span className="text-muted-foreground">
          {statusLabel(session.status)}
        </span>
        <span className="text-muted-foreground text-xs">
          最終活動 {formatElapsed(now - session.last_activity_at)}
        </span>

        <div className="ml-auto flex gap-2">
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

      <div role="tablist" className="flex gap-1 text-sm">
        <ViewTab current={view} value="transcript" onSelect={setView}>
          構造化ビュー
        </ViewTab>
        <ViewTab current={view} value="terminal" onSelect={setView}>
          ターミナル
        </ViewTab>
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

function ViewTab({
  current,
  value,
  onSelect,
  children,
}: {
  current: View
  value: View
  onSelect: (view: View) => void
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
      className={`rounded-md px-2 py-1 ${
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
