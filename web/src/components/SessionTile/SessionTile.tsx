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
import { usePress } from '@/lib/usePress'
import { motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  /**
   * 掴み手（並べ替え設計§3-1）。**器（`tile-shell`）の直下**、復旧ボタンと同じ層に
   * 置く——**器は揺れない**ので、承認待ちでカタカタしていても掴み手は動かない。
   * 切る枠の内側に置くと、揺れる的を掴ませることになる。
   *
   * 作るのは並びを持っている側（`ProjectGroup`）。**小窓は自分が何番目かを知らない。**
   */
  handle?: ReactNode
  /** 落とし先を測るための `ref`。並びを持っている側が矩形を測る */
  rootRef?: (element: HTMLElement | null) => void
  /** いま浮かせているか。**掴んでいる本人だけ** */
  dragging?: boolean
}

/**
 * 直前の応答を出しておく時間（カード設計§11-2）。
 *
 * **根拠は弱い。**「見に行くかどうかを決めるのに要る時間」以上の裏付けは無いので、
 * 実物を見て決め直す（§16 の7）。
 */
/**
 * 器の `transform` を、`motion` に奪わせないための型紙。
 *
 * **クラスで傾けても画面には出ていなかった。**
 *
 * `motion` は `y` のような変形の値を1つでも持つと `style.transform` を自分で書き、
 * **値が既定（`y: 0`）に戻った瞬間に `transform: none` をインラインで書き込む**
 * （`motion-dom` の `buildTransform`）。インラインはクラスに勝つので、
 * 掴んだときの `scale-[1.02] rotate-[1deg]` は**一度も効いていなかった**。
 *
 * 型紙を渡すと `none` を書く分岐そのものを通らなくなる。何も動かしていないときは
 * 空文字を返すので、**インラインの指定が消えてクラスが効く**。
 *
 * **モジュール直下に置くこと。** 毎回作ると `motion` が描き直しの判定に入る。
 */
const 変形の型紙 = (_: unknown, generated: string) => generated

const ECHO_MS = 12_000

/**
 * ②行に並ぶ札（接続断・モデル・モード）の見た目。
 *
 * **ANSWER タグと同じ「作り」を借りる**（利用者の指定・2026-08-26）。0.1.41 までは
 * 枠線1本と薄い文字だけで、ステッカーが持っている**物質感を1つも持っていなかった**。
 *
 * # フェーズ12 は借り方が足りなかった（フェーズ20 で作り直し・設計§25）
 *
 * 「地と内側ハイライトを付けた」と記録しているが、**落ち影が1つも無く、ハイライトも
 * 1px / 10%** で、実物では見えなかった（右下の札は `0 2.5px 2.5px / 45%` と 2.5px / 35%）。
 * **枠線を引いただけの矩形**にしか見えない——`DESIGN.md` §27.3 が名指しで避けている形で、
 * 実物を見た利用者に「以前と変わらない。何の面白みも無い」と言われた（2026-09-01）。
 *
 * **ステッカーの印は付けない。** 傾き（`rotate`）と型抜きとアクセント色のベタ塗りは
 * `.tile-sticker` に取ってある。`DESIGN.md` §23.3 が「**全行に出したい情報は、
 * ステッカーではない**」「属性は行の静かな要素で示す」と決めており、§33 の禁止事項に
 * 「**状態ステッカーを全行に付けて列にする**」がある——モデル・モード・接続断は全行に
 * 出る属性なので、そのまま貼ると 12枚ぶんの列ができ、**ANSWER の例外性まで道連れになる**。
 * §12.3 の表でここは「中」＝印刷面・貼り紙である。
 *
 * そこで**傾けず型抜きせずに物質を足す**。3つ入れてある。
 *
 * | 何 | 何が起きるか |
 * |---|---|
 * | **落ち影** | 面が持ち上がる。**これが「板になる」の本体** |
 * | **上のハイライト＋下の暗い縁** | 上下で光と影が付き、**厚みの側面**ができる |
 * | **左下だけ角丸を大きく** | 矩形でなくなり、**荷札の輪郭**になる |
 *
 * **`clip-path` で角を切らない。** あれは `box-shadow` を切る（フェーズ16 が札で踏んだ
 * filter → clip → mask の順序）。**角丸なら影は形に沿う**ので、影を残したまま輪郭を変えられる。
 *
 * 左の帯（`border-l-[3px]`）は**その札自身の枠の色**を太らせたもの。モードは自分の色を
 * 持つので**危ないモードほど背骨が濃く出る**。カードの左端の Accent Bar と同じ語彙
 * （`DESIGN.md` の Accent Element → Bar）で、**尺が違うので繰り返しには見えない**。
 * `pl-[5px]` は帯のぶんを戻して、字の位置を動かさないため。
 *
 * **`--tile-accent` を地に使わない。** 使うと `tile.test.ts` の「`--tile-accent` を
 * 塗るものは必ず `--tile-ink` を通る」に掛かる（除外表はステッカーと効果線の2つだけ）。
 *
 * `tile.css` へ置かずクラス文字列にしてあるのは、**同じプロパティを両側から書かない**
 * ため（取り込んだ CSS は Tailwind のユーティリティに無条件で勝つので、padding や
 * 角丸を `tile.css` に書くと TSX 側が黙って効かなくなる。`tile.css` 冒頭の約束）。
 */
const CHIP =
  'shrink-0 rounded-[3px_3px_3px_10px] border border-l-[3px] py-0.5 pr-1.5 pl-[5px] text-[0.7rem] tracking-[0.04em] shadow-[inset_0_2px_0_rgb(255_255_255/28%),inset_0_-1px_0_rgb(0_0_0/30%),0_1.5px_3px_rgb(0_0_0/40%)]'

/**
 * 札の地。**`--muted`（`oklch(0.269)`）ではカードの地（`oklch(0.205)`）と差が小さく、
 * 落ち影を足しても浮かない。** 一段だけ起こす。
 *
 * トークンにしていないのは、**この明るさを使うのが一覧の札だけ**だからである
 * （`--secondary` も `--accent` も `--muted` と同じ値なので、どれを借りても同じ問題になる）。
 */
const CHIP_GROUND = 'bg-[oklch(0.32_0_0)]'

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

export function SessionTile({
  cardId,
  handle,
  rootRef,
  dragging = false,
}: Props) {
  const navigate = useNavigate()
  const session = useSessionCard(cardId)
  const agents = useSettingsStore((state) => state.settings.agents)
  const quiet = useSettingsStore((state) => state.settings.motion_quiet)
  const frameRef = useRef<HTMLDivElement>(null)
  const revive = useWsStore((state) => state.revive)
  const 押し方 = usePress({
    kind: 'card',
    id: cardId,
    onOpen: () => navigate(sessionPath(cardId)),
  })
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
  /*
    右下に走る人を描くのは、作業中と停滞（フェーズ17）。**`statusMotion` は触らない**
    ——あちらを変えると枠線の回転まで巻き込む（設計§22-5）。停滞だけ「休み」の印を
    持ち、止めたときにタグへ戻る（下のコメント）
  */
  const running = motionKind === 'spin-fast' || motionKind === 'spin-slow'
  const resting = motionKind === 'spin-slow'
  /**
   * スリープは**札ではなく `zzz` が浮かぶ**（設計§14-4・利用者の指定）。
   *
   * 作業中と停滞が「札ではなく人が走る」のと同じ扱いで、**止めたら札へ戻す**ところまで
   * 停滞に合わせてある——止めた画面でも状態が読めることが、要件の完了条件だった。
   */
  const sleeping = session.status.kind === 'ended'


  return (
    /*
      **器は揺れない。** `data-motion` と `data-quiet` をここに出し、CSS が
      `[data-motion=…] .tile-frame` の形で内側だけを動かす。

      入退場の動きは器へ移した（旧版は中身に付けていた）。枠が中身を切るので、
      中身だけを縮めると裏の輪が覗く。
    */
    <motion.div
      ref={rootRef}
      /*
        掴んでいるものを流れから浮かせる（設計§3-5・§8-2）。**影ではなく `transform`
        で作る**——カードは `mask-image` を使っており、外へ描くものは切られる。
        倍率と傾きは `DESIGN.md` §27.5 の候補そのまま。

        **掴んでいないときは1文字も足さない。** 骨格を字で固定しているテストがあり、
        末尾に空白が1つ入るだけで落ちる（実際に落ちた）
      */
      className={
        dragging
          ? 'tile-shell relative z-10 scale-[1.02] rotate-[1deg]'
          : 'tile-shell relative'
      }
      transformTemplate={変形の型紙}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      data-testid="tile-shell"
      data-card-id={session.card_id}
      data-dragging={dragging ? 'true' : 'false'}
      /*
        **掴んでいる間は揺れを止める**（設計§8-1）。揺れながら動くと落とし先が読めない。
        `still` は「動きを止める」段と同じ扱いなので、承認待ちのカタカタも止まる
      */
      data-motion={dragging ? 'still' : motionKind}
      // **賑やかのときは属性ごと出さない**（カード設計§9-5-3）
      data-quiet={quiet === 'lively' ? undefined : quiet}
      // **中身と同じ印を器にも出す**（カード設計§7-4-4）。輪と効果線は中身の
      // **兄弟**なので、中身にだけ印を付けても CSS が届かない——繋がっていない
      // カードでも枠だけ元の明るさで出ていた
      data-connected={session.agent_connected}
      /*
        **選択の印も器へ複製する**（カード設計§7-4-4）。切る枠（`.tile-frame`）は
        中身の**親**なので、中身に付けた印では CSS が届かない。**色が消える環境で
        選択を伝えるのは、その枠の線種だけ**になるため、届く必要がある。
      */
      data-selected={押し方.selected ? 'true' : 'false'}
      /*
        **カードの押しは枠へ渡さない。**

        `click` は前から止めていた（中身の側）のに、`pointerdown` は素通しだった。
        指で長押しすると、カードの 400ms と枠の 400ms が同時に走り、カードが選ばれた
        直後に枠が上書きする（`stores/selection.ts` の「種類が違えば選び直す」）
        ——**掴もうとしたカードではなく枠が選ばれる。**

        **中身ではなく器で止める。** 中身で止めると、その外側に居る**このカード自身の
        掴み**まで止まる。

        枠の余白・見出し・「＋」「×」はカードの外なので、そちらを押したときは
        今までどおり枠へ届く。
      */
      onPointerDown={(event) => event.stopPropagation()}
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
          /*
            **選ばれた見た目は、枠線の色で表さない**（設計§8-3）。枠線は状態の色が
            使っているので、そこへ足すと**状態と選択が同じ場所を取り合う**。
            使うのは**地の色**と**わずかな浮き**の2つ（印の点は置かない）。

            **地はここに書かない。** `tile.css` が作業中の面をレイヤ外で持っており、
            **ここへ何を書いても勝てない**——`bg-primary/10` が作業中のカードで一度も
            効いていなかったのがその実例で、さらに α0.1 だったので**不透明な地が消えて
            裏の輪が透けていた**。地は `tile.css` の `[data-selected='true']` が持つ。

            **浮きだけはここに残す。** `scale-[1.01]` は Tailwind のユーティリティ層に
            居るので、`tile.css` の `:active { scale: 0.98 }`（レイヤ外）に必ず負ける
            ——**押した手応えが選択に潰されない**のは、この非対称のおかげである。
            影ではなく `transform` なのは、カードが `mask-image` を使っており
            外へ描くものが切られるため（設計§8-2）。
          */
          className={`tile-body bg-card flex w-full flex-col gap-1 rounded-[7px] px-3 pt-2.5 pb-3 text-left ${
            押し方.selected ? 'scale-[1.01]' : ''
          }`}
          data-testid="session-tile"
          data-card-id={session.card_id}
          data-status={session.status.kind}
          // **`data-status` は据え置く**（既存のテストと E2E の当て先）。終了と異常終了は
          // どちらも `ended` なので、8つの姿を選び分ける印を1つ足す（カード設計§7-2）
          data-status-ok={
            session.status.kind === 'ended' ? String(session.status.ok) : undefined
          }
          data-connected={session.agent_connected}
          data-selected={押し方.selected ? 'true' : 'false'}
          /*
            **選ばれていることを、見た目以外でも伝える。**

            印の点を外したので（利用者の指定）、**合図が 100% 色になった**——
            色が見えない人には、ここが唯一の道である。`role` を変えずに済むので
            `aria-pressed` を使う（`aria-selected` は listbox 等の中でしか意味を持たない）。
          */
          aria-pressed={押し方.selected}
          /*
            **端末の長押しメニューを抑える**（設計§4-4）。iOS Safari は `contextmenu` を
            発火しないので `preventDefault()` で止める道が無く、使えるのはこの2枚だけ。
            **素のスタイルで書く**——綴りを間違えても黙って効かなくなる指定なので、
            単体テストから実値を読めるようにしておく
          */
          style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
          /*
            **押し分けは1箇所で決める**（設計§4-1）。PC はシングルで選びダブルで開く、
            触る画面はシングルで開き長押しで選ぶ——この分岐をここへ書かない。

            止めているのは、親（グループの余白）へ伝わると常に全員の横並びが
            開いてしまうため（仕様§10 の作り分け）
          */
          onClick={押し方.onClick}
          onDoubleClick={押し方.onDoubleClick}
          onPointerDown={押し方.onPointerDown}
          onPointerMove={押し方.onPointerMove}
          onPointerUp={押し方.onPointerUp}
          onPointerCancel={押し方.onPointerCancel}
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
                className={`${CHIP} border-border ${CHIP_GROUND} text-muted-foreground`}
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
                  className={`${CHIP} border-border ${CHIP_GROUND} text-foreground/80 max-w-28 truncate`}
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
        {running && (
          <span
            className={`tile-run${resting ? ' tile-run-rest' : ''}`}
            data-testid="tile-run"
            role="img"
            aria-label={statusLabel(session.status)}
          >
            {/*
              3コマ。**素材は形だけ**をマスクとして使い、塗るのは状態の色（`tile.css`）。
              作業中は 0.2秒おき、停滞はその半分の速さで切り替わる（設計§22-1）
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
        )}
        {/*
          スリープの `zzz`（設計§14-4）。**走る人と同じ居場所・同じ作法**で、
          止めたら札へ戻る（下の `tile-tag-rest`）。

          **文字として置く。** 地を画像で作らない——`forced-colors: active` は背景画像を
          消すので、焼き込むとあの環境で状態が読めなくなる（走る人が同じ理由で
          `tile-run-fallback` を持っている）。

          **走る人とは同時に出ない。** 状態は1つしか持てないので、`ended` と
          `working`/`stalled` が重なることは無い。
        */}
        {sleeping && (
          <span
            className="tile-zzz"
            data-testid="tile-zzz"
            role="img"
            aria-label={statusLabel(session.status)}
          >
            <i aria-hidden>z</i>
            <i aria-hidden>z</i>
            <i aria-hidden>z</i>
            <span className="tile-run-fallback" aria-hidden>
              <span className="tile-glyph">{statusGlyph(session.status)}</span>
              {statusLabel(session.status)}
            </span>
          </span>
        )}
        {/*
          # 停滞は、走る人とタグの**両方**を描く（設計§22-3）

          動いている間は走る人だけが見え、**止めたとき（控えめ・静止・OS の「動きを
          減らす」）はタグへ戻る**。走る人だけにすると、止めたとき作業中と停滞がどちらも
          「静止した人」になり、残る手がかりが濃さと輪の太さだけになる——要件の完了条件
          「止めても色・記号・文字で状態が読める」を割る。

          **どちらを見せるかは CSS が決める**（§9-5-3「判定を JS へ散らさない」）。ここは
          両方を置くだけで、`tile-tag-rest` の表示を静けさの印と `@media` が切り替える。
          `forced-colors` の `.tile-run-fallback` と同じ作法。

          休みのタグは `aria-hidden`——読み上げは走る人の `aria-label` が担うので、
          同じ状態名を二度読ませない
        */}
        {(!running || resting) && (
          <span
            className={`tile-tag${
              session.status.kind === 'waiting_permission'
                ? ' tile-tag-raised'
                : ''
            }${resting || sleeping ? ' tile-tag-rest' : ''}`}
            data-testid="tile-tag"
            aria-hidden={resting ? true : undefined}
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
      {/*
        掴み手も**器の直下**（復旧ボタンと同じ層）。器は揺れないので、承認待ちで
        カタカタしていても掴む的は動かない（設計§3-1）
      */}
      {handle !== undefined && (
        <div
          className="absolute top-1 left-1 z-20"
          // 小窓のクリック（＝専用画面を開く）と取り違えない
          onClick={(event) => event.stopPropagation()}
        >
          {handle}
        </div>
      )}

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
          className={`tile-revive border-border ${CHIP_GROUND} text-foreground hover:border-primary/60 hover:bg-accent absolute top-2 right-2 rounded-[3px] border px-1.5 py-0.5 text-[0.7rem] tracking-[0.04em] shadow-[inset_0_2px_0_rgb(255_255_255/28%),inset_0_-1px_0_rgb(0_0_0/30%),0_1.5px_3px_rgb(0_0_0/40%)] transition-colors active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none`}
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
