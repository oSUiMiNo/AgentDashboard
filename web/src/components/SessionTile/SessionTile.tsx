/**
 * 一覧画面の小窓1枚（要件「一覧画面（司令塔ビュー）」／設計§10・カード設計§7）。
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
 * # 層は4枚。役割を兼ねさせない（カード設計§7）
 *
 * ```
 * tile-shell   近接判定の器。**ここは揺れない**——揺らす対象と「近づいたか」を測る枠が
 *              同じだと、鎮めるための的そのものが逃げる
 *   tile-frame 切る枠。丸角・はみ出しを切る・内側に 2px。**揺れるのはここから内側**
 *     tile-ring  回る輪。クリックを通さない
 *     tile-body  中身（従来の小窓）。**`<button>` のまま**——`div` にすると
 *                Tab / Enter / Space の到達性を失う
 *   tile-lines 効果線。**切る枠の外**（中に置くと、いちばん見せたい部分が切られる）
 *   revive     復旧ボタン。**揺らさない**（揺れる的を押させない）
 * ```
 *
 * # 動きを付けてよい場所（カード設計§9-6）
 *
 * 初期実装は動きを3つ（カードの出入り・タブの下地・要対処の脈）に限っていた。この工事で
 * **作業中・停滞・入力待ち・押したとき**まで広げている。条件は**位置と大きさを変えない**
 * ことで、色・光・枠線の中だけで表現する。
 *
 * **承認待ちの揺れだけが位置を動かす。** これは例外ではなく、元からある「要対処の脈」の
 * 言い換えである——人が答えないと先へ進まない唯一の状態なので、他と同じ見せ方にしない。
 * 並び順に伴う動きは**引き続き禁止**（押そうとした瞬間に的が逃げる）。
 *
 * **動きの定義そのものは `tile.css` にある。** ここが出すのは `data-motion` と
 * `data-quiet` の印だけで、**止める分岐を JavaScript 側へ散らさない**（§9-5-3）。
 */

import { modelLabel } from '@/lib/models'
import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { formatElapsed } from '@/lib/time'
import {
  isHookSilent,
  permissionModeLabel,
  permissionModeTone,
  reviveReason,
  reviveState,
  statusAccent,
  statusGlyph,
  statusLabel,
  statusMotion,
} from '@/lib/protocol'
import type { CardId } from '@/lib/protocol'
import { sessionPath } from '@/lib/routes'
import { measureField } from '@/lib/roam'
import { useNow } from '@/lib/sessions'
import { ROAM_ACCENT, ROAM_INK, scheduleRoam } from '@/stores/roam'
import { useCardError, useReviving, useSessionCard } from '@/stores/sessions'
import { agentName, agentOf, useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

interface Props {
  cardId: CardId
}

/**
 * 直前の応答を出しておく時間（カード設計§11-2）。
 *
 * **根拠は弱い。**「見に行くかどうかを決めるのに要る時間」以上の裏付けは無いので、
 * 実物を見て決め直す（§16 の7）。
 */
const ECHO_MS = 12_000

/**
 * ②行に並ぶ札（接続断・モデル・モード）の見た目。
 *
 * **ANSWER タグと同じ「作り」を借りる**（利用者の指定・2026-08-26）。0.1.41 までは
 * 枠線1本と薄い文字だけで、ステッカーが持っている**物質感を1つも持っていなかった**。
 * 借りるのは4つ——**地をベタで塗る／内側に白のハイライト（紙の厚み）／角丸を小さく／
 * 字間を開ける**。
 *
 * **ステッカーの印は付けない。** 傾き（`rotate`）と厚い落ち影と
 * アクセント色のベタ塗りは、`.tile-sticker` に取ってある。`DESIGN.md` §23.3 が
 * 「**全行に出したい情報は、ステッカーではない**」「属性は行の静かな要素で示す」と
 * 決めており、§33 の禁止事項に「**状態ステッカーを全行に付けて列にする**」がある——
 * モデル・モードは全行に出る属性なので、そのまま貼ると 12枚ぶんの列ができる。
 *
 * **`--tile-accent` を地に使わない。** 使うと `tile.test.ts` の「`--tile-accent` を
 * 塗るものは必ず `--tile-ink` を通る」に掛かる（除外表はステッカーと効果線の2つだけ）。
 *
 * `tile.css` へ置かずクラス文字列にしてあるのは、**同じプロパティを両側から書かない**
 * ため（取り込んだ CSS は Tailwind のユーティリティに無条件で勝つので、padding や
 * 角丸を `tile.css` に書くと TSX 側が黙って効かなくなる。`tile.css` 冒頭の約束）。
 */
const CHIP =
  'shrink-0 rounded-[3px] border px-1.5 py-0.5 text-[0.7rem] tracking-[0.04em] shadow-[inset_0_1px_0_rgb(255_255_255/10%)]'

/**
 * 札の地を、モードの色と喧嘩させずに足す。
 *
 * `permissionModeTone` は**セッション画面・起動フォーム・ピッカーでも使っている**ので
 * 触らない（このイシューの範囲は一覧のカードだけ）。危ないモードは自分で地を持つが、
 * **既定のモードは持たない**ので、そこにだけ足す。
 *
 * 地を無条件に前へ並べないのは、**Tailwind では同じ種類のクラスの勝敗が
 * class 属性の並び順では決まらない**ため（生成された CSS の順で決まる）。
 * 両方書くと、どちらが出るかがビルドの都合で変わる。
 */
function chipGround(tone: string): string {
  return tone.includes('bg-') ? tone : `${tone} bg-muted`
}

/**
 * 効果線の向きと、**カードの縁のどこから出るか**（カード設計§9-4）。
 *
 * 放射状に等間隔＋±6度のばらつき、という向きの決め方は変えていない。変えたのは
 * **起点**である。
 *
 * 旧版は中心から 140px の円周上へ6本を置いていた。**カードは横長（288×99〜137）なので、
 * 円だと横は縁のすぐ外、縦は縁から 70px も離れる**——上下の2本ずつが隙間を飛び越えて
 * **隣のカードの本文に重なっていた**（フェーズ6 の目視で実測）。要件は「カードの縁から
 * 外へ」なので、円ではなく**縁に沿わせる**のが正しい。
 *
 * `x` / `y` は器（カードと同じ大きさ）に対する百分率で、線はその点から外向きに伸びる。
 * **高さが 99px と 137px で変わっても、縁に付いたまま**になる。
 */
const LINES = [
  { angle: -4, x: 100, y: 50 },
  { angle: 62, x: 78, y: 100 },
  { angle: 117, x: 28, y: 100 },
  { angle: 184, x: 0, y: 50 },
  { angle: 238, x: 24, y: 0 },
  { angle: 304, x: 74, y: 0 },
]

/**
 * 直前の応答が**変わった直後だけ** true を返す。
 *
 * 出しっぱなしにすると、いちばん下の行が常に4行になって「縦を詰める」という要件と
 * 衝突する。**初回マウントでは出さない**——一覧を開くたびに全カードが4行になる。
 */
function useEcho(message: string | null): boolean {
  const previous = useRef<string | null>(message)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (message === previous.current) {
      return
    }
    previous.current = message
    if (message === null) {
      setShown(false)
      return
    }
    setShown(true)
    const timer = setTimeout(() => setShown(false), ECHO_MS)
    return () => clearTimeout(timer)
  }, [message])

  return shown && message !== null
}

export function SessionTile({ cardId }: Props) {
  const navigate = useNavigate()
  const session = useSessionCard(cardId)
  const agents = useSettingsStore((state) => state.settings.agents)
  const quiet = useSettingsStore((state) => state.settings.motion_quiet)
  const frameRef = useRef<HTMLDivElement>(null)
  const revive = useWsStore((state) => state.revive)
  const reviving = useReviving(cardId)
  const cardError = useCardError(cardId)
  const now = useNow()
  const echo = useEcho(session?.last_assistant_message ?? null)

  /*
    **跳ねるたびに、画面を回遊する線を放つ**（§9-7）。

    折り返しを合図に使うと、4.8秒の周期の末尾＝**跳ねた直後**にカード1枚あたり
    ちょうど1回だけ鳴る。タイマも `requestAnimationFrame` も持たないので、時計が
    2つになってずれることがない。

    **React の `onAnimationIteration` では受けられない。** jsdom に `AnimationEvent`
    が無く、合成イベントまで届かないので**テストで1度も確かめられない**——素の
    listener なら実物でもテストでも同じ道を通る。

    **名前で選り分ける。** 弧（`tile-spin`）も呼吸（`tile-breathe`）も無限に折り返す
    ので、見ないと全部の状態で鳴る。鎮まり中は `tile-shake-calm` へ差し替わるので、
    **近づいている間は自然に飛ばない**——あちらは既存の短い線（`tile-lines`）の担当。

    「静止」と OS の「動きを減らす」では `animation: none` なので、**そもそもこの行が
    呼ばれない**。門（`scheduleRoam`）が見るのは保険である。

    **合図はここ、撃つのは後**（2026-08-28）。跳ねと線が連動して見えるという指摘を
    受けて、`scheduleRoam` が**籤で半分見送り、残りも 1.2〜3.6秒 遅らせて**撃つ。
    **場を測るのも撃つ瞬間**なので、ここでは測らず**測り方を渡す**。
  */
  const 跳ねた = useRef<() => void>(undefined)
  跳ねた.current = () => {
    scheduleRoam(quiet, () => {
      const frame = frameRef.current
      if (frame === null || session === undefined) return null
      // **測るのはここ**（カード設計§9-7-4）。在庫の側で測ると、jsdom が矩形を全部 0 で
      // 返すせいで単体テストが縮退した格子を通る。場が無ければ何もしない——一覧の外に
      // カードが置かれた場合に、無い場所へ線を放たない
      const field = measureField(frame)
      if (field === null) return null
      return {
        field,
        // **状態から引かない**（2026-08-28・要件14-6）。効果線だけが役割色の外に出た。
        // **輪・バー・タグは `statusAccentColor` のままである**——外したのはここだけ
        accent: ROAM_ACCENT,
        // **常に不透明。接続が切れていても沈めない**（要件14-4・14-7）。
        // 以前はここへ `statusInk(session.status, session.agent_connected)` を渡して
        // いた（減光は `tile.css` の `[data-connected='false']` にしか無く、この経路は
        // あの CSS を通らないため）。**「一旦」なので、戻すならこの1行を戻す**
        ink: ROAM_INK,
        quiet,
      }
    })
  }

  useEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    const 受ける = (event: Event) => {
      if ((event as AnimationEvent).animationName !== 'tile-shake') return
      跳ねた.current?.()
    }
    frame.addEventListener('animationiteration', 受ける)
    return () => frame.removeEventListener('animationiteration', 受ける)
  }, [])

  if (!session) {
    // 消えた直後の一瞬。構造の更新が届けば親から外れる
    return null
  }
  // **どの PC のセッションかは一覧で判別できる**（要件4-4）。名前は起動時に読む
  // 設定から引く（`agent_id` は変わらないが、名前は後から変わりうるため）
  const pc = agentName(agents, session.agent_id)
  // 繋がっていないカードは**薄くして印を付ける**。状態そのものは書き換えない——
  // 「作業中（接続断）」が要件2-3 の充足形で、最後に知っていた状態は残す（設計§6-3）
  const stale = !session.agent_connected
  // 起こし直せるか（復旧設計§3-2）。`live` のときだけボタンごと出さない——
  // 残りは**出したうえで押せなくする**（出さないと「なぜこのカードにだけ無いのか」を
  // 推測させることになる）
  const revivable = reviveState(session, agentOf(agents, session.agent_id))
  const reviveWhy = reviveReason(revivable)
  const motionKind = statusMotion(session.status)


  return (
    /*
      **器は揺れない。** `data-motion` と `data-quiet` をここに出し、CSS が
      `[data-motion=…] .tile-frame` の形で内側だけを動かす。

      入退場の動きは器へ移した（旧版は中身に付けていた）。枠が中身を切るので、
      中身だけを縮めると裏の輪が覗く。
    */
    <motion.div
      className="tile-shell relative"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      data-testid="tile-shell"
      data-card-id={session.card_id}
      data-motion={motionKind}
      // **賑やかのときは属性ごと出さない**（カード設計§9-5-3）
      data-quiet={quiet === 'lively' ? undefined : quiet}
      // **中身と同じ印を器にも出す**（カード設計§7-4-4）。輪と効果線は中身の
      // **兄弟**なので、中身にだけ印を付けても CSS が届かない——繋がっていない
      // カードでも枠だけ元の明るさで出ていた
      data-connected={session.agent_connected}
      style={statusAccent(session.status)}
    >
      {/*
        **左上だけ角丸を外す。** ここは `clip-path` で斜めに切る角なので（`tile.css`）、
        丸めたままだと**切りと丸めが同じところを削り合って、斜辺が見えない**——14px の
        切りが 12px の角丸に埋もれて、白黒にすると特徴が何も残らなかった（目視で実測）。
        残り3つは §10.3 の Panel（10〜14px）のまま。

        **内側の余白が、そのまま輪の見える太さになる。** 2px から **5px**（2.5倍）へ
        広げた（利用者の指定・2026-08-26）。`DESIGN.md` §14.1「Thin Outline だけの
        体系を主役にしない」と §11.2「細い線と小バッジだけでは比率に到達しない」の
        向きに合う。

        **同時にカードを 288px → 294px へ広げている。** 輪を 3px ぶん太くすると
        中身の内容領域が 260px → 254px に狭まり、**①行のはみ出しがぶり返す**——
        8状態とも右端が 260px ぴったりで通っていた（フェーズ6 の目視）。6px 広げて
        260px を保つ。スマホ幅 390px での余りは 52px → 46px になるが、2枚並べるには
        588px 要るので**1列であることは変わらない**（§10-1-1）。

        中身の角丸も引き直す。枠 2px のときは 12−2＝10px で同心だったので、5px なら
        **7px** になる。
      */}
      <div
        ref={frameRef}
        className="tile-frame relative w-[294px] overflow-hidden rounded-[0_12px_12px_12px] p-[5px]"
      >
        {/* 回る輪。**弧は疑似要素側**にあり、止めるときは弧だけを消す（§9-1） */}
        <span className="tile-ring" aria-hidden />
        <button
          type="button"
          /*
            **薄くするのは中身だけ**（`tile.css` の `[data-connected='false']`）。
            ここへ `opacity` を当てると**地の色ごと透ける**ので、裏の輪が出てきて
            カードが状態の色で全面塗りになる（フェーズ6 の目視で実測）。
          */
          /*
            **密度を2つに分ける**（`DESIGN.md` §9.2「全領域を同じ密度で埋めない」）。
            床（§8）は「Dense な領域 / Loose な領域 各1」を求めていて、不合格例が
            「全領域が同じ行間・同じ密度」——直す前のカードがそれだった。

            ここは行間を詰めて **Dense** にし、①行の側で余白を取って **Loose** にする。
            **高さは 99px のまま**（「縦を詰める」という要件を崩さない）。
          */
          className="tile-body bg-card flex w-full flex-col gap-1 rounded-[7px] px-3 pt-2.5 pb-3 text-left"
          data-testid="session-tile"
          data-card-id={session.card_id}
          data-status={session.status.kind}
          // **`data-status` は据え置く**（既存のテストと E2E の当て先）。終了と異常終了は
          // どちらも `ended` なので、8つの姿を選び分ける印を1つ足す（カード設計§7-2）
          data-status-ok={
            session.status.kind === 'ended' ? String(session.status.ok) : undefined
          }
          data-connected={session.agent_connected}
          onClick={(event) => {
            // 小窓をクリックしたときは、その1枚だけを開く。止めないと親（グループの余白）へ
            // 伝わってしまい、常に全員の横並びが開いてしまう（仕様§10 の作り分け）
            event.stopPropagation()
            navigate(sessionPath(session.card_id))
          }}
        >
          {/*
            ① 状態と最終活動を1行に収める（カード設計§10-1）。

            **復旧ボタンが出ているぶんだけ、右を空けておく。** あのボタンは器の直下に
            絶対配置されているので、①行の右端へ寄る「接続断」やサブエージェントの
            バッジと**同じ場所を取り合う**——空けないと、繋がっていないカードで
            「接続断」がボタンの下へ潜って読めなくなる（フェーズ6 の目視で実測）。
          */}
          <div
            className={`flex items-center gap-2 pb-0.5 ${
              revivable.kind !== 'live' ? 'pr-12' : ''
            }`}
          >
            {/*
              **最長の表記でも収まる幅を先に取る。**「たった今」と「9日前」で字数が
              変わるので、縮む側に置くと1秒ごとに横へ揺れる（§10-2）。数字そのものは
              `tabular-nums` で幅を揃える
            */}
            <span
              data-testid="elapsed"
              className="text-muted-foreground min-w-0 flex-1 truncate text-[11px] whitespace-nowrap tabular-nums"
              title={`最終活動 ${formatElapsed(now - session.last_activity_at)}`}
            >
              最終活動 {formatElapsed(now - session.last_activity_at)}
            </span>
            {/*
              **「接続断」は①行に置く**（要件2-6・設計§10-1-3 の読み替え）。

              §10-1-3 は実測で「①行に接続断は入らない」と決めていた——**使えるのは
              212px なのに 290px 要る**（記号24＋状態ラベル最大84＋最終活動112＋接続断54）。
              **その前提が、状態を右下のタグへ移したことで変わった**。記号とラベルが
              抜けたので要るのは **166px** になり、初めて入る。

              **あの節は消さない。** なぜ一度②行へ移したのかが残っていないと、次に
              誰かが同じ計算をやり直す。
            */}
            {stale && (
              <span
                data-testid="disconnected-badge"
                className={`${CHIP} border-border bg-muted text-muted-foreground`}
                title="この PC からの報告が届いていません。表示は最後に分かっていた状態です"
              >
                接続断
              </span>
            )}
            {session.subagent_active > 0 && (
              <Badge
                data-testid="subagent-badge"
                variant="secondary"
                className="ml-auto shrink-0 text-violet-300"
              >
                サブエージェント {session.subagent_active}
              </Badge>
            )}
          </div>

          {/*
            ② モデル・モード・PC 名（カード設計§10-1）。

            旧版は①行の右端へ寄せていたが、独立した行になったので寄せ先が無い。

            権限モードは一覧にも出す（要件）。**危険なモードほど目立たせ、既定のモードは
            静かに出す** — 全承認をスキップしているセッションが並んでいるのに気づかない、
            という状態を作らないため（設計§8）。モデルも同じく出す（要件「切り替えた
            結果が一覧の小窓にも反映される」）。

            **まだ分からない間は何も出さない**。状態の「不明」と並ぶと、どちらが不明なのか
            読み取れなくなる
          */}
          {(stale ||
            session.model !== null ||
            session.permission_mode !== null ||
            pc !== null ||
            session.toml_account !== null) && (
            <div
              data-testid="tile-badges"
              className="flex min-w-0 items-center gap-2"
            >
              {/*
                **「接続断」はここに居ない**（フェーズ13 で①行へ移した）。あそこは
                「このセッションはどう動いているか」の属性が並ぶ行で、接続断は
                「いまその報告が届いているか」なので、最終活動と同じ行のほうが素直。

                **カプセル（`Badge`）をやめて札に揃える。** 同じ行に丸いカプセルと
                角ばった札が混ざると、1組に見えない
              */}
              {session.model !== null && (
                <span
                  data-testid="model"
                  data-model={session.model}
                  className={`${CHIP} border-border bg-muted text-foreground/80 max-w-28 truncate`}
                  title={session.model}
                >
                  {modelLabel(session.model, session.model_label)}
                </span>
              )}
              {/*
                **モデルにだけ幅の上限があってモードには無い、という非対称を無くす**
                （カード設計§10-2）。押し出された側が切れていたのはこれが原因
              */}
              {session.permission_mode !== null && (
                <span
                  data-testid="permission-mode"
                  data-mode={session.permission_mode}
                  className={`${CHIP} max-w-28 truncate ${chipGround(permissionModeTone(session.permission_mode))}`}
                  title={permissionModeLabel(session.permission_mode)}
                >
                  {permissionModeLabel(session.permission_mode)}
                </span>
              )}
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
            </div>
          )}

          {/*
            条件付きで出るものは**②と③の間**へ置く（カード設計§10-1）。①は必ず1行、
            ③は常に1行と決めているので、そこへ差し込むと約束が崩れる。

            同時に出ることはありうるので、**対処の必要性の高い順**に積む
            （警告 → 断り → 応答）
          */}

          {/* 「不明」の理由を名指しする。原因は利用者が直せるものが多い（設計§11） */}
          {isHookSilent(session) && (
            <span data-testid="hook-warning" className="text-xs text-amber-400">
              フック未受信（設定の注入が効いていない可能性）
            </span>
          )}

          {/*
            断りはそのカードに出す（設計§9-5）。**「まだ押していない」と「押したが
            戻せない」を区別できること**が完了条件に入っている
          */}
          {cardError && (
            <span data-testid="card-error" className="text-xs text-rose-400">
              {cardError}
            </span>
          )}

          {/*
            直前の応答は**変わった直後だけ**戻す（カード設計§11-2）。

            利用時間を予測した唯一の変数は「好奇心」で、カードで好奇心を作っている
            要素はこれ1つだけだった。セッション名は変わらないので好奇心を作らない。
            常時出すと縦が詰まらないので、**変化の直後だけ**という形にしてある。

            出入りに動きは付けない。隣のカードが動いて見える
          */}
          {echo && session.last_assistant_message !== null && (
            <p
              data-testid="session-echo"
              className="text-muted-foreground truncate text-xs"
              title={session.last_assistant_message}
            >
              {session.last_assistant_message.replace(/\s+/g, ' ')}
            </p>
          )}

          {/*
            ③ セッション名（カード設計§11-1）。

            **名前が無くても行の場所は残す。** 名前は最初のターンのあとに付くので、
            起こした直後は必ずこの状態を通る。行ごと消すと、名前が付いた瞬間にカードが
            1行ぶん伸び、**横に並んでいる他のカードまで動く**（器は行の高さまで伸びる）。

            **ただし文字は出さない**（利用者の指定・2026-08-26）。「名前はまだありません」
            と書いても**利用者にできることが1つも無い**——名前は CLI が勝手に付けるもので、
            待つ以外の行動に繋がらない。空けておけば、付いた瞬間に文字が現れる。
            場所を保つのは**改行しない空白**で、`truncate` が効いたまま高さだけが残る。

            マウスを乗せて全体を出すのは補助にとどめる——**タッチにホバーは存在しない**
            ので、スマホからはこの手段に届かない。全体を読む道はカードを開けば必ずある
          */}
          <p
            data-testid="session-title"
            data-named={session.session_title !== null}
            className="text-muted-foreground truncate text-xs"
            title={session.session_title ?? undefined}
          >
            {session.session_title ?? '\u00a0'}
          </p>
        </button>

        {/*
          状態のステッカー（`DESIGN.md` §23.2「種別は形で示し、状態はステッカーで示す」）。

          **貼るのは権限確認待ちだけ。** ANSWER は状態名ではなく**「押して答える」を促す
          語**なので、人が答えないと先へ進まない状態にだけ出す。**状態そのものは、隣の
          状態タグ（`tile-tag`）が全状態ぶん出す**——2つは役割が違うものとして両方出す
          （利用者の判断・2026-08-27）。

          **切る枠の中へ置く。** 器（`tile-shell`）の直下に置くと、**器は行の高さまで
          伸びる**ので、カードが行内でいちばん高くないときにステッカーだけ下へ取り残される
          （目視で実測）。枠は中身ぴったりの高さなので、ここが正しい居場所になる。

          切る枠は左上しか切っていないので、右下は `clip-path` に届かない。中身の**後ろ**へ
          置いて、いちばん下の行へ軽く重ねる。
        */}
        {session.status.kind === 'waiting_permission' && (
          <span className="tile-sticker" data-testid="tile-sticker" aria-hidden>
            ANSWER
          </span>
        )}

        {/*
          状態タグ（要件2-1・2-2・2-5）。**①行にあった記号とラベルが、そのままここへ来た。**

          # 作業中だけタグを持たない（要件2-3）

          あそこは**人が走るアニメーション**になる。文字も `⟳` も出さない——放っておいて
          よい状態なので、読ませるより「動いている」ことだけが伝わればよい。

          # 記号と文言は DOM のテキストのまま置く（**画像へ焼かない**）

          地（プレート）は画像だが、**中身の記号と文言は要素として残す**。
          `forced-colors: active` は**背景画像を強制的に消す**ので、文字を焼き込むと
          あの環境で状態が丸ごと読めなくなり、要件が自分で立てた完了条件
          （「色を伏せても記号と文言だけで8状態が判別できる」「ハイコントラストでも
          8つの姿が見分けられる」）を割る。**消えるのは地だけにする。**

          副産物として、**どの状態にどの素材が当たっているかを字面で検査できる**。
        */}
        {motionKind === 'spin-fast' ? (
          <span
            className="tile-run"
            data-testid="tile-run"
            role="img"
            aria-label={statusLabel(session.status)}
          >
            {/*
              3コマ。**素材は形だけ**をマスクとして使い、塗るのは状態の色（`tile.css`）。
              0.2秒おきに切り替わる
            */}
            <i aria-hidden />
            <i aria-hidden />
            <i aria-hidden />
            {/*
              ハイコントラストでは絵が消えるので、そこでだけ文字と記号が出る（`tile.css`）。
              通常の見た目は変わらない
            */}
            <span className="tile-run-fallback" aria-hidden>
              <span className="tile-glyph">{statusGlyph(session.status)}</span>
              {statusLabel(session.status)}
            </span>
          </span>
        ) : (
          <span
            className={`tile-tag${
              session.status.kind === 'waiting_permission'
                ? ' tile-tag-raised'
                : ''
            }`}
            data-testid="tile-tag"
          >
            <span className="tile-glyph" aria-hidden>
              {statusGlyph(session.status)}
            </span>
            {statusLabel(session.status)}
          </span>
        )}
      </div>

      {/*
        効果線（カード設計§9-4）。**切る枠の外**に置く——中に入れると、いちばん見せたい
        部分が丸角で切られる。近づいて鎮まるのと**同時**に出す（順序が逆だと「気づいた」
        ように見えない）。

        承認待ちのときだけ描く。常時置くと12枚×6要素になる
      */}
      {motionKind === 'shake' && (
        <span className="tile-lines" data-testid="tile-lines" aria-hidden>
          {LINES.map((line) => (
            <i
              key={line.angle}
              style={
                {
                  '--tile-angle': `${line.angle}deg`,
                  '--tile-x': `${line.x}%`,
                  '--tile-y': `${line.y}%`,
                } as CSSAngle
              }
            />
          ))}
        </span>
      )}

      {/*
        押す前に権限モードが見えていること（要件）は、上のバッジが既に満たしている
        ——記録どおりのモードで起き直るので、全承認スキップのまま戻ることが分かる

        **揺らさない**（カード設計§7）。器の直下に置いてあるので、枠が揺れても
        このボタンだけは動かない
      */}
      {revivable.kind !== 'live' && (
        <button
          type="button"
          data-testid="revive-button"
          data-state={revivable.kind}
          disabled={revivable.kind !== 'ready' || reviving}
          title={reviveWhy ?? '元の CLI セッションで起こし直します'}
          onClick={(event) => {
            // 止めないと器（小窓）のクリックまで伝わり、専用画面が開いてしまう
            event.stopPropagation()
            revive(session.card_id)
          }}
          /*
            **押せるものに見せる**（利用者の指摘・2026-08-26）。0.1.41 までは透明な地に
            薄い枠と薄い文字だけで、`DESIGN.md` §27.3 が名指しで避けている
            「単なる 1px Border だけ」そのものだった。§12.3 の「主要操作ボタン →
            マット塗装・プレート」に寄せ、**地・内側ハイライト・落ち影**で板にする。

            **大きさ（36×23px）は変えない。** 変えなければ `tile.css` の
            `.tile-revive::after { inset: -11px }` が作る当たり判定 58×45px が
            44px の床を割らず、①行の `pr-12` の前提も動かない。

            押下は `scale(0.98)`（§27.4 の 0.97〜0.99）。**`Button` 部品へは寄せない**
            ——あちらは押下で `translate-y-px` するので、「復旧ボタンは揺らさない」と
            正面から食い違う。
          */
          className="tile-revive border-border bg-muted text-foreground hover:border-primary/60 hover:bg-accent absolute top-2 right-2 rounded-[3px] border px-1.5 py-0.5 text-[0.7rem] tracking-[0.04em] shadow-[inset_0_1px_0_rgb(255_255_255/10%),0_1px_2px_rgb(0_0_0/35%)] transition-colors active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
        >
          {reviving ? '復旧中…' : '復旧'}
        </button>
      )}
    </motion.div>
  )
}

/** 効果線1本の向き。カスタムプロパティは `CSSProperties` に載らないので逃がす。 */
type CSSAngle = React.CSSProperties &
  Record<'--tile-angle' | '--tile-x' | '--tile-y', string>
