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
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { InputDock } from '@/components/InputDock/InputDock'
import { ModelPicker } from '@/components/ModelPicker/ModelPicker'
import { PermissionModePicker } from '@/components/PermissionModePicker/PermissionModePicker'
import { TerminalPane } from '@/components/TerminalPane/TerminalPane'
import { TranscriptTree } from '@/components/TranscriptTree/TranscriptTree'
import { dropDraft } from '@/lib/drafts'
import { formatElapsed, formatScreenInterval } from '@/lib/time'
import {
  isEnded,
  isHookSilent,
  permissionModeLabel,
  permissionModeTone,
  reviveReason,
  reviveState,
  statusLabel,
  statusTone,
} from '@/lib/protocol'
import { FilesToggle } from '@/components/ProjectFiles/FilesToggle'
import { useFilesParts } from '@/components/ProjectFiles/useFilesParts'
import { useFilesPanel } from '@/lib/filesPanel'
import { projectPath, sessionPath } from '@/lib/routes'
import { hostOf } from '@/lib/reviveBudget'
import type { CardId } from '@/lib/protocol'
import { useNow } from '@/lib/sessions'
import { useAuthStore } from '@/stores/auth'
import { useCardError, useReviving, useSessionCard } from '@/stores/sessions'
import { agentOf, useSettingsStore } from '@/stores/settings'
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
  const revive = useWsStore((state) => state.revive)
  const reviving = useReviving(cardId)
  const cardError = useCardError(cardId)
  const agents = useSettingsStore((state) => state.settings.agents)
  // 外したカードの書きかけを忘れるのに要る。**下書きの鍵はアカウントごと**
  const account = useAuthStore((state) => state.auth.account)
  // 中身は自分で購読する。横並びのとき、隣のセッションの状態変化で作り直されないため
  const session = useSessionCard(cardId)
  const now = useNow()
  // 単独で開いたときは履歴が主役。横並びのときは一望して即操作したいのでターミナル
  const [view, setView] = useState<View>(compact ? 'terminal' : 'transcript')
  // PJT 専用画面と**同じ部品・同じ経路**（設計§28）。開閉の記憶も共有する
  const [filesOpen, toggleFiles] = useFilesPanel()
  // ファイルのパネルと、PJT 専用画面へのリンクの**両方**で使う。同じ意味の式を
  // 2通りの綴りで置くと、片方だけ直す余地が残る
  const host = hostOf(session?.agent_id)
  const { sidebar, column } = useFilesParts({
    host,
    project: session?.project ?? '',
    open: filesOpen,
    onToggle: toggleFiles,
  })

  if (!session) {
    // 消えた直後の一瞬。単独表示のときは呼び出し側が「見つかりません」を出す
    return null
  }

  // 起こし直せるか（復旧設計§3-2）。**この画面には「接続断」の表示そのものが無い**
  // ので、このボタンがその合図を兼ねる
  const revivable = reviveState(session, agentOf(agents, session.agent_id))
  const reviveWhy = reviveReason(revivable)

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
      {/*
        **折り返せるようにしておく。** 狭い画面では右側の道具（モデル・モード・
        終了・削除）だけで画面幅を超える。はみ出したままだと、
        **ページの横幅が画面より広くなる**——モバイルの `fixed` はその広い幅を
        基準にするので、左パネルのドロワーの右端（閉じる・コピー）が画面の外へ出る。
      */}
      <header className="flex flex-wrap items-center gap-2 text-sm">
        {!compact && <FilesToggle open={filesOpen} onToggle={toggleFiles} />}
        <span
          aria-hidden
          className={`size-2.5 shrink-0 rounded-full ${statusTone(session.status)}`}
        />
        {/*
          縮んでよいのは作業ディレクトリだけ。`min-w-0` を付けないと flex の子は
          中身の幅より小さくならず、`truncate` が効かない。実際、長いパスのときに
          状態のラベルが「入力 待ち」と縦に割れていた（**一番読みたいものが読めない**）
        */}
        {/*
          **単独画面のときだけ押せるようにする。** 横並びのときは既にその PJT の
          画面に居るので、リンクにすると自分自身へ移ることになる——「押せるのに
          何も起きない」は、壊れているのと見分けが付かない。

          器を1つも足さないのは、置く先の帯に空き余白が無いため（設計§2）。
          既に在るものを押せるようにすれば、行も要素も増えない。
        */}
        {compact ? (
          <span className="min-w-0 truncate font-medium" title={session.project}>
            {session.project}
          </span>
        ) : (
          <Link
            to={projectPath(host, session.project)}
            data-testid="to-project"
            className="decoration-muted-foreground/40 hover:decoration-foreground min-w-0 truncate font-medium underline underline-offset-2"
            title={session.project}
          >
            {session.project}
          </Link>
        )}
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

        <div className="ml-auto flex flex-wrap items-center gap-2">
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
          {/*
            **起こし直しは `compact` の分岐の外**に置く（設計§9-2）。宛先がカードごとに
            一意なので、十字ボタンを横並びで出さなかった理由（どの端末へ撃つのか
            曖昧になる）は当てはまらない。終了・削除が横並びでも出ているのと同じ扱い
          */}
          {revivable.kind !== 'live' && (
            <>
              {/*
                押す前に権限モードを見せる（要件）。**終了したカードではピッカーが
                出ない**ので、そのときだけ静的なバッジで補う——実機の記録では
                23枚とも `bypassPermissions` だった（設計§15-4）ので、これは飾りではない
              */}
              {isEnded(session.status) && session.permission_mode !== null && (
                <span
                  data-testid="revive-mode"
                  data-mode={session.permission_mode}
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[0.7rem] ${permissionModeTone(session.permission_mode)}`}
                  title="このモードで起こし直します"
                >
                  {permissionModeLabel(session.permission_mode)}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                data-testid="revive-button"
                data-state={revivable.kind}
                disabled={revivable.kind !== 'ready' || reviving}
                title={reviveWhy ?? '元の CLI セッションで起こし直します'}
                onClick={() => revive(session.card_id)}
              >
                {reviving ? '復旧中…' : '復旧'}
              </Button>
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
            onClick={() => {
              // **カードを外したら書きかけも忘れる。** 残すと、二度と開かない相手の
              // 下書きが積み上がる（十字ボタン設計§11）
              dropDraft(session.card_id, account)
              archive(session.card_id)
            }}
          >
            削除
          </Button>
        </div>
      </header>

      {/*
        断りはそのカードに出す（設計§9-5）。画面全体の帯へ出すと、横並びのときに
        **どのカードの話なのか分からなくなる**
      */}
      {cardError && (
        <p data-testid="card-error" className="text-xs text-rose-400">
          {cardError}
        </p>
      )}

      {/*
        取り合いの器。**`relative` を足す**（PJT 専用画面と同じ理由。設計§2）——
        サイドバーは広い画面で `absolute` になり、この箱を基準にする。
        下の右列が持つ `relative isolate` はそのまま——あれは十字ボタンを端末の脇へ
        重ねるための基準で、こちらとは別の話
      */}
      <div className="relative flex min-h-0 flex-1 gap-4">
        {/*
          **横並び（compact）では丸ごと出さない。** サイドバーも中身の列も切り替えボタンも
          出さない——あちらは PJT 専用画面が既に持っており、宛先が一意でない操作を
          横並びに出さない、という既存の判断をそのまま引き継ぐ
        */}
        {!compact && sidebar}
        {/*
          **ここにレールは無い**（セッションを1本しか出さない）ので、中身の列は
          取り合いの器の兄弟のまま。**PJT 専用画面だけ形が違うのは入れ忘れではなく、
          揃える先が存在しないため**（`useFilesParts` の JSDoc）
        */}
        {!compact && column}

        {/*
          **重ねる基準はここ**（十字ボタン設計§10）。横向きのとき、十字ボタンは
          `InputDock` の中に居ながら端末の脇へ重なる。`isolate` を先に置いてあるのは、
          `motion` が `initial` を当てた瞬間に重なりの文脈を作るためで、恒久的な文脈を
          先に持たせておけば喧嘩しない（見た目は何も変わらない）
        */}
        {/*
          **`min-w-0` が要る。** 端末の格子は 120桁で固定してあり（`TerminalPane` の
          `TERMINAL_GRID`）、横に入りきらないぶんは**端末の入れ物の中**でスクロールさせる。
          ところが flex の子は既定で「中身より小さくならない」ので、これが無いと
          **格子の幅（720px）がこの列の下限になり、ページ全体が横へ広がる**——狭い画面では
          帯も入力欄も一緒に流れることになり、窓にした意味が消える（実測で踏んだ）。
        */}
        <div className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          {/*
            横並びの区画から、そのセッションの専用画面へ移る（設計§4）。

            **終了とは行の反対の端に置く。** 「隣を見に行くつもり」と「これを
            終わらせる」を取り違えたときの被害が釣り合わないので、いちばん遠くへ離す。

            **`ml-auto` を付けない。** これは `compact` のときだけ出る＝出たり
            消えたりする要素で、寄せる指定を付けると出ないときに寄せ先ごと消えて
            並びが崩れる（モデル不明のときバッジが左詰まりした事故と同じ形）。
          */}
          {compact && (
            <Link
              to={sessionPath(session.card_id)}
              data-testid="to-session"
              className="text-primary shrink-0 text-xs underline"
            >
              開く
            </Link>
          )}
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
        <div
          className={`flex min-h-0 min-w-0 flex-1 flex-col ${view === 'terminal' ? '' : 'hidden'}`}
        >
          <TerminalPane key={session.card_id} cardId={session.card_id} />
        </div>

        <InputDock
          cardId={session.card_id}
          status={session.status}
          compact={compact}
          terminalShown={view === 'terminal'}
        />
        </div>
      </div>
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
