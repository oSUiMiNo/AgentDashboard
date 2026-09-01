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

import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
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
  statusDetail,
  statusLabel,
  statusTone,
} from '@/lib/protocol'
import { FilesToggle } from '@/components/ProjectFiles/FilesToggle'
import { useFilesParts } from '@/components/ProjectFiles/useFilesParts'
import { useFilesPanel } from '@/lib/filesPanel'
import { projectDisplayName } from '@/lib/path'
import { backTargetFor, HOME, projectPath, sessionPath } from '@/lib/routes'
import { hostOf } from '@/lib/reviveBudget'
import type { CardId, ReviveState } from '@/lib/protocol'
import { useNow } from '@/lib/sessions'
import { useAuthStore } from '@/stores/auth'
import { useCardError, useReviving, useSessionCard } from '@/stores/sessions'
import { agentOf, useSettingsStore } from '@/stores/settings'
import { useProjects } from '@/stores/projects'
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
  // 復旧中の明滅を止めるのに要る。**印だけを出し、止める分岐は CSS 側に置く**
  // （小窓と同じ作法。設計§15-5）
  const quiet = useSettingsStore((state) => state.settings.motion_quiet)
  // 外したカードの書きかけを忘れるのに要る。**下書きの鍵はアカウントごと**
  const account = useAuthStore((state) => state.auth.account)
  // 中身は自分で購読する。横並びのとき、隣のセッションの状態変化で作り直されないため
  const session = useSessionCard(cardId)
  // 名前の番号は**一覧ぜんぶ**を見て決まる（同じ名前が複数あるときだけ付く）
  const projects = useProjects()
  const now = useNow()
  // 単独で開いたときは履歴が主役。横並びのときは一望して即操作したいのでターミナル
  const [view, setView] = useState<View>(compact ? 'terminal' : 'transcript')
  // PJT 専用画面と**同じ部品・同じ経路**（設計§28）。開閉の記憶も共有する
  const [filesOpen, toggleFiles] = useFilesPanel()
  // ✕ の行き先（設計§7）。**履歴の件数では判定しない**——判断そのものは
  // `backTargetFor` が持ち、ここは鍵を渡して結果に従うだけ
  const navigate = useNavigate()
  const location = useLocation()
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
  // **名前だけを出す**（設計§14-5）。同じ名前が複数あるときだけ番号が付く。
  // フルパスは `title` に残すので、確かめたいときは乗せれば読める
  const 名前 = projectDisplayName(session.project, projects)

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
        **4行に決め打つ。行の中では折り返さない**（設計§2）。

        以前は `flex-wrap` の1行に10個以上を詰めて折り返しに任せていた。どこで折れるかが
        幅次第だと、**行数も、どれとどれが同じ行に来るかも、そのつど変わる**——狭い画面ほど
        行が増えて本文の高さを削り、しかも**最終活動の文字数が変わっただけで行が入れ替わる**
        （`たった今` と `5秒前` の2文字差で 1行⇄2行。実測）。下の本文ごと上下に動くので、
        読んでいる場所が逃げる。

        **折り返しは置き忘れではなく防具だった。** はみ出したままだとページの横幅が画面より
        広くなり、狭い窓のサイドバー（`fixed`）の右端が画面の外へ出る。**外すぶんは、行ごとに
        「溢れたとき何が縮むか」を決めて埋める**（1行目はパスの前半、2行目はフック未受信。
        3行目と4行目は固定幅しか無いので、そもそも溢れさせない）。

        **4行目はここに無い。** タブの行はサイドバーより下の「中身の列」に居るので、
        あれがそのまま4行目になる。上へ移すと、広い窓でサイドバーの上に跨ってしまう。
      */}
      <header
        className="flex flex-col gap-1 text-sm"
        data-quiet={quiet === 'lively' ? undefined : quiet}
      >
        {/*
          **1行目は単独画面だけ**（設計§2）。横並びではパスが全カードで同じで、
          `GroupView` の見出しにも既に出ている。判定は既存の `compact` でできる
        */}
        {/*
          **1行目は「行き先と始末の行」**（設計§14-1）。**横並びでも出す**——始末の
          ボタンと「開く」の置き場所がここしか無いため。出さないのは**パスと
          サイドバーと ✕** の3つで、どれも横並びでは意味を持たない。

          **左が「移る」、右が「消す」。** 反対の端に置く原則は §2 のまま生きている。
        */}
        <div data-row="1" className="flex min-w-0 items-center gap-2">
          {!compact && <FilesToggle open={filesOpen} onToggle={toggleFiles} />}
          {compact ? (
            /*
              横並びの区画から、そのセッションの専用画面へ移る（設計§4）。
              **`ml-auto` を付けない**——出たり消えたりする要素に寄せる指定を付けると、
              出ないときに寄せ先ごと消えて並びが崩れる
            */
            <Link
              to={sessionPath(session.card_id)}
              data-testid="to-session"
              className="text-primary shrink-0 text-xs underline"
            >
              開く
            </Link>
          ) : (
            /*
              **押すと PJT 専用画面へ移る**（`v0.1.53`）。器を1つも足さないのは、
              置く先に空き余白が無いため。

              **出すのは名前だけ**（設計§14-5）。この行には始末のボタンも並ぶので、
              パスの長さに幅を明け渡せない。**フルパスは `title` に残す。**
            */
            <Link
              to={projectPath(host, session.project)}
              data-testid="to-project"
              className="decoration-muted-foreground/40 hover:decoration-foreground min-w-0 truncate font-medium underline underline-offset-2"
              title={session.project}
            >
              {名前}
            </Link>
          )}

          {/*
            **始末の2つ**（設計§14-2・§15-1）。送るものは変わっていない。

            | ボタン | 送るもの |
            |---|---|
            | **電源** | 点いていれば `Kill`（止めるだけ）／消えていれば `Revive`（起こす） |
            | **ゴミ箱**（終了） | `Archive`（カードを一覧から外す） |

            **電源が1つで済むのは偶然ではない。** 「スリープが出る条件」と
            「復旧が出る条件」は互いの否定そのもの（`reviveState` の `live` が
            `走っている && 繋がっている`）なので、**常にどちらか片方しか出ていない**。

            **ゴミ箱はいつでも押せる。** 届かないカードを一覧から外す道が、ここしか無い。

            **並びは「カードに効くもの」→ 間隔 →「画面に効くもの」**（設計§15-2）。
            §14-6 は ✕ との取り違えを「アイコンと文字」で分けていたが、**訂正で
            3つとも記号になった**ので、代わりに**間隔と大きさ**で群を作る。
          */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <PowerButton
              on={revivable.kind === 'live'}
              state={revivable.kind}
              busy={reviving}
              why={reviveWhy}
              onPress={() => {
                if (revivable.kind === 'live') {
                  kill(session.card_id)
                  return
                }
                revive(session.card_id)
              }}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="close-card"
              aria-label="終了"
              title="カードを一覧から外します（履歴は残ります）"
              onClick={() => {
                // **カードを外したら書きかけも忘れる。** 残すと、二度と開かない相手の
                // 下書きが積み上がる（十字ボタン設計§11）
                dropDraft(session.card_id, account)
                archive(session.card_id)
                // カードが無くなるので、その画面に留まる意味が無い
                if (!compact) {
                  navigate(HOME)
                }
              }}
            >
              <TrashIcon />
            </Button>
            {/*
              **✕ はいちばん右**（設計§14-6）。**押し間違えても何も壊れない側を端に置く**。

              **「形で分ける」はもう効かない**（訂正その2で3つとも記号になった）ので、
              代わりに**間隔と大きさで分ける**（設計§15-2）——電源とゴミ箱は 28px で
              近く、✕ だけ 32px で `ml-2` ぶん離す。**カードに効くもの**と
              **画面に効くもの**の境目が、そこにある。
            */}
            {!compact && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid="close-session"
                aria-label="閉じる"
                title="閉じる"
                className="ml-2 shrink-0"
                onClick={() => {
                  // **三項演算子で1回にまとめない。** `navigate` の2つのオーバーロード
                  // （行き先 / 何個戻るか）に `string | number` は当たらず、`tsc -b` で落ちる
                  if (backTargetFor(location.key) === 'back') {
                    navigate(-1)
                    return
                  }
                  navigate(HOME)
                }}
              >
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </Button>
            )}
          </div>
        </div>

        {/*
          **2行目は状態の行**（設計§2）。縮んでよいのはフック未受信だけで、
          状態のラベルと最終活動は縮ませない——**いちばん読みたいものが「入力 待ち」と
          縦に割れる**壊れ方を、初期実装のフェーズ4で実測している
        */}
        <div data-row="2" className="flex items-center gap-2">
          <span
            aria-hidden
            className={`size-2.5 shrink-0 rounded-full ${statusTone(session.status)}`}
          />
          {/*
            `ended` は「消息不明」1本（設計§6）。**正常に終わったのか落ちたのかは
            `title` に回してある**——捨てたのではなく、置き場所を移しただけ
          */}
          <span
            className="text-muted-foreground shrink-0"
            title={statusDetail(session.status)}
          >
            {statusLabel(session.status)}
          </span>
          {/*
            **この行で唯一、放っておくだけで文字数が変わる要素。** 1秒ごとに数え直すので、
            行の中で折り返す作りだと**画面を見ているだけで行数が入れ替わる**（設計§2）
          */}
          <span
            data-testid="elapsed"
            className="text-muted-foreground shrink-0 text-xs"
          >
            最終活動 {formatElapsed(now - session.last_activity_at)}
          </span>
          {isHookSilent(session) && (
            <span
              data-testid="hook-warning"
              className="min-w-0 truncate text-xs text-amber-400"
            >
              フック未受信
            </span>
          )}
        </div>

        {/*
          **3行目は「そのセッションをどう動かすか」の行**（設計§2）。

          終了しているときはモデルとモードのピッカーが消えるので、**そこが空くのと
          入れ替わりに**起こし直しのモードのバッジと `復旧` が入る。したがってこの行は
          どの状態でも空にならない——**4行が3行に化けない**
        */}
        <div data-row="3" className="flex items-center gap-2">
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
            **起こし直すボタンは1行目の電源へ移った**（設計§15-1）。ここに残るのは
            **どのモードで起こすか**の札だけである——3行目はモデルとモードの行なので、
            モードの話はこちらに居るのが筋。ボタンに付いて動かすと、モードの話が
            2つの行に割れる。

            押す前に権限モードを見せる（要件）。**終了したカードではピッカーが出ない**
            ので、そのときだけ静的な札で補う——実機の記録では23枚とも
            `bypassPermissions` だった（復旧設計§15-4）ので、これは飾りではない。
          */}
          {revivable.kind !== 'live' &&
            isEnded(session.status) &&
            session.permission_mode !== null && (
              <span
                data-testid="revive-mode"
                data-mode={session.permission_mode}
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[0.7rem] ${permissionModeTone(session.permission_mode)}`}
                title="このモードで起こし直します"
              >
                {permissionModeLabel(session.permission_mode)}
              </span>
            )}
          {/*
            **タブをやめてトグルにした**（設計§14-3）。2つの器が並ぶより1つの
            スイッチのほうが簡単で、**行を1つ丸ごと減らせる**。

            **既定は切れている＝構造化ビュー。** 別イシューで予定している
            「既定を構造化ビューにする」と噛み合う（横並びだけは入った状態で始まる）。

            **更新間隔もこの行へ。** ターミナルの話なので、トグルの隣が意味のまとまりに合う。
          */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <ScreenInterval
              remote={session.agent_id !== null}
              shown={view === 'terminal'}
            />
            <TerminalToggle
              on={view === 'terminal'}
              onToggle={() =>
                setView(view === 'terminal' ? 'transcript' : 'terminal')
              }
            />
          </div>
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

/**
 * ターミナルで見るかどうかのスイッチ（設計§14-3）。
 *
 * **2つのタブをやめた。** 「どちらを見るか」ではなく「**ターミナルで見るか**」に
 * 言い換えると、器が1つで済み、帯の行を1つ減らせる。既定（切れている状態）が
 * 構造化ビューなので、**別イシューで予定している「既定を構造化ビューにする」とも
 * 噛み合う**。
 *
 * **`role="switch"` にしてある。** 見た目はトグルでも、読み上げに「押しボタン」と
 * 伝わると、いまどちらを見ているのかが分からない。
 *
 * 入っているときの下地は **Primary Accent の面**（`DESIGN.md` §8 の床・§11.2）。
 * 選択を面で出す1か所を、タブから引き継いでいる。
 */
/**
 * 押したあと、これだけのあいだ**次の押下を捨てる**（設計§15-1）。
 *
 * **2つのボタンだったときは、連打しても同じものが2回送られるだけだった。**
 * 1つにするとそうではなくなる——`Kill` から `ended` へ変わるまでには間があり
 * （実測の上限は20秒）、**その切り替わりをまたいで2回目を押すと、止めたつもりで
 * 起こす**。「効いたか分からないからもう一度押す」がいちばん起きやすい押し方で、
 * しかも押した直後は輪の色が変わらないので、その動機がそこにある。
 */
const 連打よけ = 500

/**
 * スリープと復旧を1つにした電源ボタン（設計§15-1）。
 *
 * **押せなくするのは「本当に押せないとき」だけにする。** 連打よけで `disabled` に
 * すると、点灯していた輪が 500ms だけ灰色へ落ちて**壊れたように見える**。捨てるのは
 * 押下のほうで、見た目は動かさない。
 *
 * **「状態が切り替わるまで押せなくする」は採らない**（設計§15-1）。`Kill` が届か
 * なければ**永久に押せないボタン**になり、しかも押せない理由を出す道が無い。
 */
function PowerButton({
  on,
  state,
  busy,
  why,
  onPress,
}: {
  /** 点いているか（＝実体がある）。消えていれば押すと起きる */
  on: boolean
  /** 起こし直せるかの内訳。押せない理由を目印にも載せる */
  state: ReviveState['kind']
  /** いま起こしている最中か */
  busy: boolean
  /** 押せない理由（押せるときは `null`） */
  why: string | null
  onPress: () => void
}) {
  const [待つ, set待つ] = useState(false)
  const 時計 = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (時計.current !== null) {
        clearTimeout(時計.current)
      }
    },
    [],
  )

  // **色は読み上げられない。** ホバーの反応も文字ではないので、読み上げ環境では
  // ここだけが手がかりになる（設計§15-1）
  const 言葉 = on ? 'スリープ' : '復旧'
  const 説明 = busy
    ? '起こしています…'
    : on
      ? 'セッションを止めます（カードは残り、復旧で起こせます）'
      : (why ?? '元の CLI セッションで起こし直します')

  return (
    <button
      type="button"
      className="power"
      data-testid="power-card"
      data-power={on ? 'on' : 'off'}
      data-action={on ? 'sleep' : 'revive'}
      data-state={state}
      data-busy={busy ? 'true' : undefined}
      disabled={(!on && state !== 'ready') || busy}
      aria-label={言葉}
      title={説明}
      onClick={() => {
        if (待つ) {
          return
        }
        set待つ(true)
        時計.current = setTimeout(() => set待つ(false), 連打よけ)
        onPress()
      }}
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3v9" />
        <path d="M18.4 7a9 9 0 1 1-12.8 0" />
      </svg>
    </button>
  )
}

/** 「終了」の印（設計§15-2）。**言葉は `aria-label` と `title` に残してある** */
function TrashIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m19 6-1 14H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

function TerminalToggle({
  on,
  onToggle,
}: {
  on: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-testid="terminal-toggle"
      onClick={onToggle}
      title="ターミナルで見る"
      /*
        **上下の余白を持たない**（設計§15-3）。溝そのものが高さを持つので、
        ここにも余白を付けると 1.3倍にしたときに3行目が伸びる。
      */
      className={`termswitch flex shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors ${
        on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {/*
        溝とつまみ。**大きさと位置は `controls.css` が持つ**——「入っている位置
        だけは 1.3倍ではない」理由を、数字のすぐ隣に書いておきたいため。
      */}
      <span aria-hidden className="termswitch-track">
        <span className="termswitch-knob" />
      </span>
      ターミナル
    </button>
  )
}
