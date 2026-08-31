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
import { useEffect, useState } from 'react'
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
import { splitPathTail } from '@/lib/path'
import { backTargetFor, HOME, projectPath, sessionPath } from '@/lib/routes'
import { hostOf } from '@/lib/reviveBudget'
import type { CardId } from '@/lib/protocol'
import { useNow } from '@/lib/sessions'
import { useAuthStore } from '@/stores/auth'
import {
  setCardError,
  useCardError,
  useReviving,
  useSessionCard,
} from '@/stores/sessions'
import { agentOf, useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

/**
 * 「終了」を押してから `ended` を待つ上限（設計§5）。
 *
 * **実測（フェーズ1）は 80ms ／ 84ms ／ 92ms**（擬似 claude・ローカル・1本ずつ）。
 * いったん5秒（その約50倍）に置いたが、**通しの E2E で足りなかった**（フェーズ5）。
 *
 * **短く置いた側の代償のほうが重い。** 上限を超えると `Archive` を送らないので、
 * **終わっているのに一覧へ残る**。E2E の後片付けはそれを片付けきれず、席が埋まったまま
 * 次のテストが始まって「セッションが起動しない」という**遠い症状**に化けた。
 *
 * `helpers.ts` の `archiveAll` が同じことを先に記録している——「**通しで流すと
 * 往復が既定の5秒に収まらない。単独では出ず通しでだけ、たまに落ちる**」。
 * 相手が別の PC なら A2S の往復も乗る。**待つ相手は機械の速さではなく、その時の混み具合**である。
 *
 * 超えたら **`Archive` は送らない**。プロセスが落ちていないのに一覧から外すと、
 * 走ったままのセッションを画面から辿れなくなる。**待たせるのは、間違って外すより軽い。**
 */
const 終了を待つ上限ミリ秒 = 20_000

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
  // ✕ の行き先（設計§7）。**履歴の件数では判定しない**——判断そのものは
  // `backTargetFor` が持ち、ここは鍵を渡して結果に従うだけ
  const navigate = useNavigate()
  const location = useLocation()
  // 「終了」を押してから `ended` を待っている間だけ立つ。**押した時刻を持つ**のは、
  // 状態が動くたびに待ち時間が延びないようにするため
  const [終了を頼んだ時刻, set終了を頼んだ時刻] = useState<number | null>(null)
  // ファイルのパネルと、PJT 専用画面へのリンクの**両方**で使う。同じ意味の式を
  // 2通りの綴りで置くと、片方だけ直す余地が残る
  const host = hostOf(session?.agent_id)
  const { sidebar, column } = useFilesParts({
    host,
    project: session?.project ?? '',
    open: filesOpen,
    onToggle: toggleFiles,
  })

  const 終了中 = 終了を頼んだ時刻 !== null
  const 終わっている = session ? isEnded(session.status) : false
  /**
   * **「終了」を頼める相手が居ないか**（設計§5・フェーズ5の実測で足した）。
   *
   * PC との線が切れているカードへ `Kill` を送っても届かないので、`ended` は永遠に
   * 返ってこない。**そこで「終了」しか出さないと、そのカードは一覧から二度と外せなくなる**
   * ——`archiveAll`（E2E の後片付け）が丸ごと動かなくなって気づいた。
   *
   * 設計§5 は「走っている＝終了／終わっている＝削除」の2通りしか見ていなかったが、
   * **実際には3通り目（終わってはいないが、届かない）が在る。** 届かないなら、
   * できるのは一覧から外すことだけである。
   */
  const 届かない = session ? !session.agent_connected : false
  const 外すだけ = 終わっている || 届かない
  /**
   * 「終了」を押したあとの段取り（設計§5）。
   *
   * ```
   * Kill を送る → ボタンを「終了中…」にして無効化 → **ended になるのを待つ**
   *   → Archive を送る → 単独画面なら一覧へ
   * ```
   *
   * **`Kill` と `Archive` を同時に送らない。** 先に外すと、飛行中だった報告
   * （`SessionUpsert`）が後から着地して記録が作り直される——**外したカードが一覧へ戻る**
   * という未解決の壊れ方を踏みに行くことになる。
   *
   * `ended` を書くのは PTY の終了（`on_exit`）だけなので、**待つ＝プロセスが本当に
   * 終わったのを待つ**と同じ意味になる（`SessionEnd` フックは状態を動かさない）。
   */
  useEffect(() => {
    if (終了を頼んだ時刻 === null) {
      return
    }
    if (終わっている) {
      // **カードを外したら書きかけも忘れる。** 残すと、二度と開かない相手の
      // 下書きが積み上がる（十字ボタン設計§11）
      dropDraft(cardId, account)
      archive(cardId)
      set終了を頼んだ時刻(null)
      // 横並びでは移らない。その画面はまだ他のセッションを映している
      if (!compact) {
        navigate(HOME)
      }
      return
    }
    // **残り時間で測る。** 状態が動くたびに待ち直すと、上限がいくらでも延びる
    const 残り = 終了を待つ上限ミリ秒 - (Date.now() - 終了を頼んだ時刻)
    const timer = setTimeout(() => {
      set終了を頼んだ時刻(null)
      setCardError(
        cardId,
        '終了の合図が返りませんでした。もう一度押すか、PC の接続を確かめてください',
      )
    }, Math.max(0, 残り))
    return () => clearTimeout(timer)
  }, [終了を頼んだ時刻, 終わっている, cardId, account, archive, compact, navigate])

  if (!session) {
    // 消えた直後の一瞬。単独表示のときは呼び出し側が「見つかりません」を出す
    return null
  }

  // 起こし直せるか（復旧設計§3-2）。**この画面には「接続断」の表示そのものが無い**
  // ので、このボタンがその合図を兼ねる
  const revivable = reviveState(session, agentOf(agents, session.agent_id))
  const reviveWhy = reviveReason(revivable)
  // 前半だけを縮ませ、末尾2階層は必ず残す（設計§3）
  const { head, tail } = splitPathTail(session.project)

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
      <header className="flex flex-col gap-1 text-sm">
        {/*
          **1行目は単独画面だけ**（設計§2）。横並びではパスが全カードで同じで、
          `GroupView` の見出しにも既に出ている。判定は既存の `compact` でできる
        */}
        {!compact && (
          <div data-row="1" className="flex min-w-0 items-center gap-2">
            <FilesToggle open={filesOpen} onToggle={toggleFiles} />
            {/*
              **押すと PJT 専用画面へ移る**（`v0.1.53`）。器を1つも足さないのは、
              置く先に空き余白が無いため——既に在るものを押せるようにすれば行も要素も増えない。

              **割るのはリンクの中身で、リンクそのものは1つのまま。** 2つに割ると押せる的が
              2つになる。`min-w-0` はリンク自身にも要る（flex の入れ物になるため）で、
              `truncate` は前半の `<span>` へ移す（設計§3）
            */}
            <Link
              to={projectPath(host, session.project)}
              data-testid="to-project"
              className="decoration-muted-foreground/40 hover:decoration-foreground flex min-w-0 items-center font-medium underline underline-offset-2"
              title={session.project}
            >
              {head !== '' && (
                <span data-testid="to-project-head" className="min-w-0 truncate">
                  {head}
                </span>
              )}
              {/* **末尾2階層は必ず残す。** 違いが出るのはたいてい末尾（設計§3） */}
              <span className="shrink-0">{tail}</span>
            </Link>
            {/*
              **✕ は1行目の右端、終了は4行目の右端。** 縦に離してあるのは、閉じるつもりで
              終了を押す事故を避けるため（設計§5・§7）。

              **文字の記号は使わない**（`DESIGN.md` §14.4）。`FilesToggle` と同じ作りの
              Outline のアイコンにしてある
            */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-testid="close-session"
              aria-label="閉じる"
              title="閉じる"
              className="ml-auto shrink-0"
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
          </div>
        )}

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
        {/*
          **これが帯の4行目**（設計§2）。`<header>` の中に無いのは、この行がサイドバーより
          下の「中身の列」に居るため——上へ移すと、広い窓でサイドバーの上に跨ってしまう。

          **両端に別々のものを置く。** 左が「開く」（移る）、右が「終了・削除」（消す）。
          **「移る」と「消す」を隣り合わせにしない**——以前は折り返し次第で `削除` が左端へ
          回り込み、長いパスのときに「開く」の真上（約40px）に並んでいた（実測）。
          4行に決め打つと、この回り込みそのものが起きなくなる
        */}
        <div data-row="4" className="flex items-center gap-2">
          {/*
            横並びの区画から、そのセッションの専用画面へ移る（設計§4）。

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
          {/*
            **寄せる指定は、必ず描かれる入れ物のほうへ持たせる**（ガイドライン）。
            中のボタンは状態で入れ替わるので、そちらへ付けると出ないときに寄せ先ごと消える
          */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/*
              **ボタンは常に1つ。状態で意味が変わる**（設計§5・利用者の指定）。

              | 状態 | ボタン | 押すと |
              |---|---|---|
              | 走っている | 終了 | `Kill` → `ended` を待つ → `Archive` → 単独画面なら一覧へ |
              | 終わっている | 削除 | `Archive` だけ |

              走っている間は「削除」が意味を持たないのに並んでおり、狭い画面で2つぶんの
              幅を食っていた。**終わったカードを外す道は残す**——放っておくと消息不明の
              カードが一覧に溜まり、**一覧の小窓には消すボタンが無い**（押すと開くだけ）。

              **確認は挟まない。** `archive` は一覧から外すだけで履歴も記録も残るので、
              押し間違いの重さは**配置**（✕ は1行目・これは4行目）と `title` で吸う。
            */}
            <Button
              variant={外すだけ ? 'ghost' : 'outline'}
              size="sm"
              data-testid="close-card"
              data-mode={外すだけ ? 'archive' : 'kill'}
              disabled={終了中}
              title={
                外すだけ
                  ? 'カードを一覧から外します（履歴は残ります）'
                  : 'セッションを終了し、カードを一覧から外します（履歴は残ります）'
              }
              onClick={() => {
                if (外すだけ) {
                  dropDraft(session.card_id, account)
                  archive(session.card_id)
                  if (!compact) {
                    navigate(HOME)
                  }
                  return
                }
                kill(session.card_id)
                set終了を頼んだ時刻(Date.now())
              }}
            >
              {終了中 ? '終了中…' : 外すだけ ? '削除' : '終了'}
            </Button>
          </div>
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
