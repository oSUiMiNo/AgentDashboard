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

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { PencilGlyph, PowerGlyph, TrashGlyph } from '@/components/ui/glyphs'
import { NicknameInput } from '@/components/SessionNickname/NicknameInput'
import { InputDock } from '@/components/InputDock/InputDock'
import { ModelPicker } from '@/components/ModelPicker/ModelPicker'
import { PermissionModePicker } from '@/components/PermissionModePicker/PermissionModePicker'
import { TerminalPane } from '@/components/TerminalPane/TerminalPane'
import { TranscriptTree } from '@/components/TranscriptTree/TranscriptTree'
import { dropDraft } from '@/lib/drafts'
import { useSnapToFile } from '@/lib/snapToFile'
import { formatElapsed, formatScreenInterval } from '@/lib/time'
import {
  isEnded,
  isHookSilent,
  nicknameOf,
  送る名前,
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
  /**
   * 掴み手（並べ替え設計§3-1・読み替え1）。**`session-ops` の `data-row="1"` の左端**へ
   * 置く——セッションに効く操作はそこに集まっている（`DESIGN.md` §39.2）。
   *
   * **単独のセッション専用画面には出さない。** 並べる相手が1本も無いので、押しても
   * 何も起きないものを置くと壊れているのと見分けが付かない。**置き場所は分岐させず、
   * 有無だけが変わる**（§39.3 が禁じているのは場所の分岐であって、有無ではない）。
   */
  handle?: ReactNode
  /** 落とし先を測るための `ref`。並びを持っている側（`GroupView`）が矩形を測る */
  rootRef?: (element: HTMLElement | null) => void
  /** いま浮かせているか */
  dragging?: boolean
  /** いま並べ替えている最中か。**並び全員に配る**（押しのけられる側も滑らせるため） */
  reordering?: boolean
}

export function SessionView({
  cardId,
  compact = false,
  handle,
  rootRef,
  dragging = false,
  reordering = false,
}: Props) {
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
  const setNickname = useWsStore((state) => state.setNickname)
  /*
    **名前を書き換えている最中か**（名前付け設計§9-5）。`null` は「編集していない」。

    小窓（`SessionTile`）と同じ持ち方にしてある。**手元の表示は書き換えない**——
    確定してもサーバの `session_upsert` が戻るまで名前は変わらない。
  */
  const [draft, setDraft] = useState<string | null>(null)
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
  const { sidebar, column, 開いている一枚 } = useFilesParts({
    host,
    project: session?.project ?? '',
    open: filesOpen,
    onToggle: toggleFiles,
    /*
      **狭い窓では、面は1画面ぶん**（`スマホでファイルビュアを開くと画面が崩れる`
      設計§3）。PJT 専用画面は渡さない——あちらは札が並ぶ場所なので 672px のまま
    */
    狭い窓の幅: '画面',
  })
  const railRef = useRef<HTMLDivElement>(null)
  useSnapToFile(railRef, 開いている一枚)

  if (!session) {
    // 消えた直後の一瞬。単独表示のときは呼び出し側が「見つかりません」を出す
    return null
  }

  // 起こし直せるか（復旧設計§3-2）。**この画面には「接続断」の表示そのものが無い**
  // ので、このボタンがその合図を兼ねる
  const セッション名 = nicknameOf(session)
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
      data-dragging={dragging ? 'true' : 'false'}
      /* 並べ替えの動きは `reorder.css` が持つ（設計§7-3 の読み替え） */
      data-reorder-item=""
      data-reorder-kind="section"
      data-reordering={reordering ? 'true' : 'false'}
      data-quiet={quiet === 'lively' ? undefined : quiet}
      ref={rootRef}
      /*
        掴んでいる区画の浮き（縮み・傾き）は `reorder.css` が持つ（設計§15-7）。
        **ここに `scale-`／`rotate-` を置かない**——二重に掛かる。区画は幅 672px で
        1度傾けると角が 12px ずれるので、1.02倍ではなく 0.97倍に縮める
        （要件「追加要望」1「同じ大きさのまま傾くので端がはみ出る」）
      */
      className={`flex min-h-0 flex-col gap-1 ${
        compact ? 'w-[42rem] shrink-0' : 'min-w-0 flex-1'
      }`}
    >
      {/*
        **画面の帯**（設計§17-1・`DESIGN.md` §39.2）。ここに置くのは
        **画面ぜんぶに効くもの**だけ——サイドバーの開閉・PJT の名前・閉じる。

        **セッションに効くものは、下の列の中へ移した。** `header` は取り合いの器の
        **外**なので、ここへ置くと**サイドバーごと跨いだ全幅の帯**になる。横並びでは
        サイドバーが無いぶん**たまたま**区画の真上に来ていた——**揃っていたのは偶然**で、
        1本しか無い画面では「区画の真上」と「画面の帯」が同じ場所に見えるため、
        **2つ並べて初めて分かる**（§39.2）。

        **横並びでは描かない。** 上の3つはどれも横並びでは出さないので、**中身が1つも
        残らない**。`DESIGN.md` §39.4 が「**空の段を作らない**」と決めているので、器ごと落とす。
        **これは §14-1「横並びでも1行目を出す」の撤回**にあたる——あの行を出したのは
        「始末のボタンと『開く』の置き場所がそこしか無かった」ためで、**その理由ごと消えた**。
      */}
      {!compact && (
        <header
          data-testid="screen-bar"
          className="flex min-w-0 items-center gap-2 text-sm"
        >
          <FilesToggle open={filesOpen} onToggle={toggleFiles} />

          {/*
            **押せない見出しに戻した**（設計§17-3）。移る手段は切替ボタンへ出て行った
            ので、ここは PJT 専用画面の見出しと**同じ役割**になる——§16-2 が
            「同じ文字列を違う役割のまま出す」と但し書きしていたが、**その但し書きごと
            要らなくなった**。**出すのは名前だけ**（設計§14-5）。フルパスは `title` に残す。
          */}
          <h2
            data-testid="project-name"
            className="min-w-0 truncate font-medium"
            title={session.project}
          >
            {名前}
          </h2>

          {/*
            **✕ は画面を閉じる操作**なので帯に残る（設計§17-6）。セッションに効く
            ものと同じ列へ混ぜない——**効く相手が違う**（§39.2）。
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
              // **三項演算子で1回にまとめない。** `navigate` の2つのオーバーロードに
              // `string | number` は当たらず、`tsc -b` で落ちる
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
        </header>
      )}

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
          **レール。** 中身の列とセッションの面をここへ入れ、狭い窓では**2面のページ
          送り**にする（`スマホでファイルビュアを開くと画面が崩れる` 設計§2）。

          **2026-09-04 まで、ここにレールは無かった。** 「セッションを1本しか出さない
          ので揃える先が存在しない」という判断だったが、**中身の列の 672px という寸法は
          「レールが受け止める」前提で選ばれていた**——寸法だけを持ってきて前提を
          持ってこなかったので、狭い窓ではセッションの面が **0px** まで潰れていた。
        */}
        <SessionRail compact={compact} column={column} railRef={railRef}>

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

          **`min-w-full md:min-w-0` にした**（設計§3）。`min-w-0` だけだと、レールの
          中で**隣の 672px に押されて 0px まで潰れる**——縮む側が不足分を全部引き受け
          るためで、これがこのイシューの不具合そのものだった。狭い窓では**1画面ぶんの
          床**を与え、広い窓では今までどおり残りを取る。
        */}
        <div className="relative isolate flex min-h-0 min-w-full flex-1 snap-start snap-always flex-col gap-1.5 md:min-w-0">
        {/*
          **セッションに効く行は、端末／履歴と同じ列の中に置く**（設計§17-1・
          `DESIGN.md` §39.3）。

          **以前は `header` に居た。** あそこは取り合いの器の**外**なので、
          セッション専用画面では**サイドバーごと跨いだ全幅の帯**になっていた。
          横並びはサイドバーが無いぶん**たまたま**区画の真上に来ていただけで、
          **揃っていたのは偶然**である。

          **`compact` で分岐して置き場所を変えない**（§39.3）。分岐で辻褄を合わせると、
          次に片方だけ触った人がまた食い違わせる。
        */}
        <div
          data-testid="session-ops"
          className="flex flex-col gap-0.5 text-sm"
          data-quiet={quiet === 'lively' ? undefined : quiet}
        >
          {/*
            **2行目は状態の行**（設計§2）。縮んでよいのはフック未受信だけで、
            状態のラベルと最終活動は縮ませない——**いちばん読みたいものが「入力 待ち」と
            縦に割れる**壊れ方を、初期実装のフェーズ4で実測している
          */}
          <div data-row="1" className="flex items-center gap-2">
            {handle}
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
              **セッションの名前**（名前付け設計§9-1）。**カードの小窓と同じ見せ方**に
              揃える——利用者が付けたものは通常の濃さ、CLI が付けたものは薄く。
              決め方は `nicknameOf` が1つだけ持つ（2箇所に書くと食い違う）。

              **ここに置くのは、名前がセッション1本に効くから**（`DESIGN.md` §39.2）。
              画面の帯（`screen-bar`）へ上げると、横並びではあの帯ごと描かれないので
              名前だけが消える。**`compact` で分岐させない**——§39.3 が禁じているのは
              場所の分岐である。

              **縮むのはここだけ。** 右の操作は `shrink-0` なので、狭い画面では名前が
              先に切れる。`min-w-0` が無いと `truncate` が効かず、行が横へ溢れる。
            */}
            {draft === null ? (
              セッション名.text !== null && (
                <span
                  data-testid="session-name"
                  data-nickname={セッション名.kind}
                  className={`min-w-0 truncate text-xs ${セッション名.tone}`}
                  title={セッション名.text}
                >
                  {セッション名.text}
                </span>
              )
            ) : (
              <form
                data-testid="nickname-form"
                className="min-w-0 flex-1"
                onSubmit={(event) => {
                  event.preventDefault()
                  setNickname(session.card_id, 送る名前(draft))
                  setDraft(null)
                }}
              >
                <NicknameInput
                  value={draft}
                  onChange={setDraft}
                  onCancel={() => setDraft(null)}
                  // **行の高さを変えない。** 高さは行の中でいちばん高い部品が決めるので、
                  // ここが太ると帯が伸びる（`dashboard.spec.ts` が見ている）
                  className="border-border bg-card text-foreground w-full rounded-[3px] border px-1 py-0 text-xs leading-5"
                />
              </form>
            )}
            {/*
              **名前を付ける鉛筆。** 小窓と違い、ここは器が `<button>` ではないので
              その場に置ける（小窓は絶対配置の兄弟にするしかない）。
            */}
            {draft === null && (
              <button
                type="button"
                data-testid="nickname-edit"
                title="このセッションに名前を付ける"
                aria-label="このセッションに名前を付ける"
                // 下書きの初期値は**利用者の名前だけ**。CLI の名前を入れると、
                // 触っていないのに「自分で付けた」ことになってしまう
                onClick={() => setDraft(session.nickname ?? '')}
                className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
              >
                <PencilGlyph className="size-3.5" />
              </button>
            )}
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

            {/*
              **操作の群**（設計§17-6）。左から **トグル → 拡大／縮小 →（間隔）→
              電源 → 終了**。**間隔で2つに分ける**——左は「見せ方を変える」、右は
              「始末する」で、**押し間違えたときの取り返しの付かなさが違う**
              （§15-2 と同じ作法。分ける場所が帯からこの列へ移っただけ）。

              **状態の行に置いてある。** モデルとモードの行は 8rem が2つで既に埋まって
              おり、そこへ4つ足すと狭い画面で溢れる。**状態の文字は短い**ので、こちらが空く。
            */}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <TerminalToggle
                on={view === 'terminal'}
                onToggle={() =>
                  setView(view === 'terminal' ? 'transcript' : 'terminal')
                }
              />
              <ZoomToggle
                compact={compact}
                onPress={() => {
                  if (compact) {
                    navigate(sessionPath(session.card_id))
                    return
                  }
                  navigate(projectPath(host, session.project))
                }}
              />
              <div className="ml-1.5 flex shrink-0 items-center gap-1.5">
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
                    // **カードを外したら書きかけも忘れる。** 残すと、二度と開かない
                    // 相手の下書きが積み上がる（十字ボタン設計§11）
                    dropDraft(session.card_id, account)
                    archive(session.card_id)
                    // カードが無くなるので、その画面に留まる意味が無い
                    if (!compact) {
                      navigate(HOME)
                    }
                  }}
                >
                  <TrashGlyph />
                </Button>
              </div>
            </div>
          </div>

          {/*
            **3行目は「そのセッションをどう動かすか」の行**（設計§2）。

            終了しているときはモデルとモードのピッカーが消えるので、**そこが空くのと
            入れ替わりに**起こし直しのモードのバッジと `復旧` が入る。したがってこの行は
            どの状態でも空にならない——**4行が3行に化けない**
          */}
          <div data-row="2" className="flex items-center gap-2">
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
            {/* **更新間隔だけが残る。** ボタンは1行目の操作の群へ移った（設計§17-6） */}
            <div className="ml-auto shrink-0">
              <ScreenInterval
                remote={session.agent_id !== null}
                shown={view === 'terminal'}
              />
            </div>
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
          host={host}
          compact={compact}
          terminalShown={view === 'terminal'}
        />
        </div>
        </SessionRail>
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
/**
 * 中身の列とセッションの面を横に並べ、**狭い窓ではページ送りにする**入れ物
 * （`スマホでファイルビュアを開くと画面が崩れる` 設計§2・§4）。
 *
 * # 横並びでは描かない
 *
 * 横並び（`compact`）には中身の列が無いので、レールを描くと**中身が1つだけの段**に
 * なる（`DESIGN.md` §39「空の段を作らない」）。加えて横並びは**既に PJT 専用画面の
 * レールの中に居る**ので、**同じ向きのスクロール容器が二重になる**。
 *
 * **この分岐で作り直しは起きない。** 横並びかどうかは取り付けごとに固定で、走っている
 * 途中では変わらない。**「ファイルを開いているときだけ描く」形にしてはいけない**——
 * 開け閉めのたびにセッションの面が作り直され、**端末が死ぬ**。
 *
 * # 付けないもの
 *
 * | 付けない | なぜ |
 * |---|---|
 * | `relative` | 十字ボタンの重なりの基準は**セッションの面のまま**。ここに付けると基準が増える |
 * | `overflow-anchor: none` | **横方向には効かないと実測した**（面を挿しても消しても送り位置が変わらない）。PJT 専用画面のそれは**並べ替え中の指の位置との干渉**が理由で、こちらには並べ替えが無い |
 *
 * # 端末には漏れ止めを付けない
 *
 * 端末は自分でも横スクロールする（120桁≒720px）。**端まで来たら払いがここへ渡る**——
 * この繋がりは残す（設計§6-1）。塞ぐと**端末の上から面を移れなくなる**。止めるのは
 * 外側だけで、`overscroll-x-contain` が**ブラウザの「戻る」への漏れ**を断つ。
 */
function SessionRail({
  compact,
  column,
  railRef,
  children,
}: {
  compact: boolean
  column: ReactNode
  railRef: RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  if (compact) {
    return children
  }
  return (
    <div
      ref={railRef}
      data-testid="session-rail"
      className="flex min-h-0 min-w-0 flex-1 snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain"
    >
      {column}
      {children}
    </div>
  )
}

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
      <PowerGlyph className="size-3.5" />
    </button>
  )
}

/**
 * 画面の行き来を1つにしたボタン（設計§17-3）。**動画プレイヤーの全画面ボタンと同じ形。**
 *
 * | いま居る画面 | 印 | 押すと |
 * |---|---|---|
 * | PJT 専用画面（`compact`） | **拡大**（四隅へ開く） | そのセッションの専用画面へ |
 * | セッション専用画面 | **縮小**（四隅から閉じる） | その PJT の専用画面へ |
 *
 * **2つの状態は向きだけで分ける。** 色や器を変えると**同じボタンだと分からなくなる**
 * ——利用者が探すのは「行き来するボタン」1つであって、2種類のボタンではない。
 *
 * **`backTargetFor` は使わない。** あれは「戻る先が在るか」を見るものだが、
 * こちらは**常に決まった相手へ行く**。履歴の状態に依らない。
 */
function ZoomToggle({
  compact,
  onPress,
}: {
  /** 横並び（PJT 専用画面）に居るか。居るなら「拡大」 */
  compact: boolean
  onPress: () => void
}) {
  const 言葉 = compact ? 'このセッションを大きく見る' : 'この PJT の画面へ戻る'
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-testid="zoom-toggle"
      data-zoom={compact ? 'in' : 'out'}
      aria-label={言葉}
      title={言葉}
      className="shrink-0"
      onClick={onPress}
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
        {compact ? (
          <>
            <path d="M8 3H5a2 2 0 0 0-2 2v3" />
            <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
            <path d="M3 16v3a2 2 0 0 0 2 2h3" />
            <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
          </>
        ) : (
          <>
            <path d="M8 3v3a2 2 0 0 1-2 2H3" />
            <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
            <path d="M3 16h3a2 2 0 0 1 2 2v3" />
            <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
          </>
        )}
      </svg>
    </Button>
  )
}

/**
 * レールに描く端末の印（設計§17-4）。
 *
 * **`>` とカーソルの2要素まで削ってある。** 参考の端末の絵は陰影の付いた大きなもので、
 * 小さく置くと潰れる（`DESIGN.md` §19.2）。**§18.2 の下限に収まる形へ削る**。
 */
function TerminalMark({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 7l5 5-5 5" />
      <path d="M13 17h6" />
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
      aria-label="ターミナルで見る"
      title="ターミナルで見る"
      /*
        **文字を落とした**（設計§17-4）。何のトグルかは**レールの絵**が言う。
        言葉は `aria-label` と `title` に残す——色も絵も読み上げられない。
      */
      className="termswitch flex shrink-0 items-center rounded-md"
    >
      {/*
        溝・つまみ・絵。**大きさと位置は `controls.css` が持つ**。

        **絵は両端に置き、つまみに隠れていない側だけを出す**（`参考/トグル.png` の方式。
        太陽は左・月は右に出ている）。

        **かつては入っているときだけ出していた。** §17-4 で文字を落としておきながら
        絵を片側にしか置かなかったので、**切れているときだけ手掛かりがゼロ**になっていた
        ——「何のトグルか分からない」（利用者・設計§17-4 の訂正）。
      */}
      <span aria-hidden className="termswitch-track">
        <TerminalMark className="termswitch-mark termswitch-mark--start" />
        <TerminalMark className="termswitch-mark termswitch-mark--end" />
        <span className="termswitch-knob" />
      </span>
    </button>
  )
}
