/**
 * 一覧画面（司令塔ビュー）の本体（要件「一覧画面」／設計§10）。
 *
 * セッションをプロジェクト単位にまとめて並べる。同じフォルダで並列に走らせることが
 * 多いので、プロジェクトごとの箱にしておかないと、どれがどれの兄弟なのか分からなくなる。
 *
 * 購読するのは**構造だけ**（どの箱にどのカードが入るか）。状態の変化はここまで
 * 伝わってこないので、ツールコールのたびに一覧全体が作り直されることはない。
 * まとまりの組み立てと並びの安定は [`@/stores/sessions`] が持つ。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useReorder, type Scroller } from '@/lib/useReorder'

import { ProjectGroup } from '@/components/ProjectGroup/ProjectGroup'
import { ReviveBudgetDialog } from '@/components/TileGrid/ReviveBudgetDialog'
import { Button } from '@/components/ui/button'
import { ChevronGlyph, PowerGlyph, TrashGlyph } from '@/components/ui/glyphs'
import { moveItem } from '@/lib/reorder'
import { nicknameOf } from '@/lib/protocol'
import { reviveState } from '@/lib/protocol'
import {
  fetchHostResources,
  hostOf,
  planRevive,
  SIGNED_OUT,
  type HostResources,
  type HostResourcesAnswer,
  type RevivePlan,
  type ReviveTarget,
} from '@/lib/reviveBudget'
import {
  getSession,
  saveCardOrder,
  setAccountFilter,
  useAccountFilter,
  useProjectGroups,
  useReviveTargets,
  useTomlAccounts,
} from '@/stores/sessions'
import { saveProjectOrder } from '@/stores/projects'
import { clearSelection, useSelection } from '@/stores/selection'
import { agentOf, useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

/** 読み上げの文言を差し替えるまでの待ち（ms）。連打を1回にまとめる（設計§15-6） */
export const ANNOUNCE_DEBOUNCE_MS = 100

/**
 * 「前へ／後ろへ」で動かした結果の文言（並べ替え設計§15-6）。**純関数。**
 *
 * `並び` は新しい並びの**名前**、`添字` は動かしたものの新しい位置。Atlassian の作法
 * どおり「A と B のあいだへ」と言い、端では「先頭へ」「末尾へ」と言う。
 */
export function 移動の文言(名前: string, 並び: readonly string[], 添字: number): string {
  const 前 = 添字 > 0 ? 並び[添字 - 1] : null
  const 後 = 添字 < 並び.length - 1 ? 並び[添字 + 1] : null
  if (前 !== null && 後 !== null) {
    return `「${名前}」を「${前}」と「${後}」のあいだへ移動しました`
  }
  if (後 !== null) {
    return `「${名前}」を先頭へ移動しました（「${後}」の前）`
  }
  if (前 !== null) {
    return `「${名前}」を末尾へ移動しました（「${前}」の後ろ）`
  }
  return `「${名前}」を移動しました`
}

export function TileGrid() {
  const groups = useProjectGroups()
  const accounts = useTomlAccounts()
  const filter = useAccountFilter()
  const candidates = useReviveTargets()
  const agents = useSettingsStore((state) => state.settings.agents)
  const revive = useWsStore((state) => state.revive)
  const archive = useWsStore((state) => state.archive)
  const [orderError, setOrderError] = useState<string | null>(null)

  /*
    **入れる道を作ったら、出る道も作る**（設計§4-2）。出られないと、触る画面で
    開けなくなる——選択モードのあいだ、シングルタップは「選ぶ」になっているため
  */
  useEffect(() => {
    const 押した = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearSelection()
      }
    }
    globalThis.addEventListener('keydown', 押した)
    return () => globalThis.removeEventListener('keydown', 押した)
  }, [])

  /*
    枠の並べ替え（並べ替え設計§3）。

    **並べ替えられるのは記録を持つ枠だけ。** カードから逆算した箱は DB に行が無いので、
    書き戻す先が無い。あちらは必ず記録のある枠の**後ろ**に並ぶ（`rebuildGroups` が
    `getProjects()` を先に置く）ので、前半だけを並べ替えれば足りる。
  */
  const 鍵 = (group: { host: string; project: string }) =>
    `${group.host}\u0000${group.project}`
  const frames = groups.filter((group) => group.projectId !== undefined)
  const others = groups.filter((group) => group.projectId === undefined)
  // 送るのは枠の ID。**鍵から引くための対応表を、最新の描画のぶんで持ち回る**
  const idByKey = useRef(new Map<string, string>())
  idByKey.current = new Map(
    frames.map((group) => [鍵(group), group.projectId as string]),
  )

  const 並びを送る = useCallback(async (next: readonly string[]) => {
    const ids = next
      .map((key) => idByKey.current.get(key))
      .filter((id): id is string => id !== undefined)
    const reason = await saveProjectOrder(ids)
    setOrderError(reason)
    // **理由を返すと、掴んだ側が手元の並びを元へ滑らせて戻す**（並べ替え設計§15-4）
    return reason
  }, [])

  // **端で送るのは本体の縦の箱**（`App.tsx`）。並べ替え設計§15-12。`RoamLayer` が場を
  // `querySelector` で引くのと同じ形で、目印で引く
  const 縦の箱 = useMemo<Scroller>(
    () => ({
      get: () => document.querySelector<HTMLElement>('[data-scroll-box="home"]'),
      axis: 'y',
    }),
    [],
  )
  const { order, dragging, bind, itemRef, reordering } = useReorder({
    ids: frames.map(鍵),
    scroller: 縦の箱,
    onCommit: (next) => 並びを送る(next),
  })

  const byKey = new Map(frames.map((group) => [鍵(group), group]))
  const 並び = [
    ...order
      .map((key) => byKey.get(key))
      .filter((group): group is (typeof frames)[number] => group !== undefined),
    ...others,
  ]

  /*
    起こし直せるカードを数える（復旧設計§9-3）。**ストアが持っているのは候補まで**
    （実体が無いカード）で、PC の在否と名乗りはここで見る——その材料は設定ストアに
    あるため。数はブラウザが手元のカードから数える。版の切替と違い、**全カードを
    既に持っている**ので、サーバに数えさせる理由が無い。
  */
  let disconnected = 0
  let ended = 0
  const targets: ReviveTarget[] = []
  for (const cardId of candidates) {
    const meta = getSession(cardId)
    if (!meta) {
      continue
    }
    if (reviveState(meta, agentOf(agents, meta.agent_id)).kind !== 'ready') {
      // 押しても断られるカードは数に入れない。**押した人が数を予測できる**こと（要件）
      continue
    }
    targets.push({
      cardId,
      // メモリは**PC ごとに別**なので、宛先ごとに束ねて数える（設計§18-5）
      host: hostOf(meta.agent_id),
      lastActivityAt: meta.last_activity_at,
    })
    if (meta.status.kind === 'ended') {
      ended += 1
    } else {
      disconnected += 1
    }
  }

  /*
    押したときの計画（設計§18-5）。**聞くのは押した瞬間だけ**——常時持っていると
    古い値で判断することになる。全部入るなら黙って進み、入りきらないときだけ出す。
  */
  const [plan, setPlan] = useState<RevivePlan | null>(null)
  const [asking, setAsking] = useState(false)

  const 送る = (ids: string[]) => {
    /*
      **送る直前に、いま戻せる相手だけへ絞る**（コードレビュー対応3）。

      ダイアログは押した瞬間の対象を持ったまま、いつまでも開けておける。その間に
      別の画面から数枚を復旧したり、カードを外したりできるので、凍結したまま送ると
      **既に live なカードへも送る**ことになる——PC が「このカードは復旧中です」や
      `NotFound` を返し、**押していない断りがカードに並ぶ**。

      `targets` は記録から毎回作り直しているので、ここで突き合わせれば足りる。
      **閉じるのではなく絞る**のは、閉じると数え直しからやり直しになるため。
      絞る側は**常に安全側**（減る方向にしか動かない）で、押した人が見た数より
      増えることはない。
    */
    const いま戻せる = new Set(targets.map((target) => target.cardId))
    // 口は増やさない。**対象ぶん1枚ずつ送る**——並べるのは PC 側なので、
    // 押し手は数を気にしなくてよい（PC が複数あれば自然に台数ぶん並列になる）
    for (const cardId of ids) {
      if (!いま戻せる.has(cardId)) {
        continue
      }
      revive(cardId)
    }
  }

  /*
    **選んだものに、いま何ができるか**（設計§5-3・§5-5）。

    **電源マークは止まっているカードだけを起こす。** 走っているカードには触らない
    ——押し間違いで作業中の claude を止めないため。復旧は取り返しがつくが、
    止めるのはつかない。**何枚が対象で何枚を飛ばすかは、押す前に数で出す。**

    **新しい口は作らない**（§5-5）。既存の復旧・外すを、選んだぶんだけ繰り返す。
  */
  const 選択 = useSelection()
  /*
    **ドラッグ以外の道**（並べ替え設計§15-6・WCAG 2.2 SC 2.5.7）。1つだけ選んでいるときに
    「前へ／後ろへ」（枠なら「上へ／下へ」）を帯に出す。2つ以上では宛先が定まらないので
    出さない——十字ボタンを横並びで出さないのと同じ理由。送り先は**ドラッグと同じ口**。
  */
  const 一つだけ = 選択.ids.length === 1 ? 選択.ids[0] : null
  const カードの名前 = (id: string): string => {
    const session = getSession(id)
    const 名 = session === undefined ? null : nicknameOf(session).text
    return 名 !== null && 名 !== '' ? 名 : id.slice(0, 8)
  }
  /** 選んでいる1つの、いまの位置と並び（名前）。無ければ null */
  const 一つの居場所 = ((): {
    at: number
    並び: readonly string[]
    名前: (id: string) => string
    送る: (next: readonly string[]) => Promise<string | null>
  } | null => {
    if (一つだけ === null) {
      return null
    }
    if (選択.kind === 'project') {
      const keys = frames.map(鍵)
      const at = keys.findIndex((key) => idByKey.current.get(key) === 一つだけ)
      if (at < 0) {
        return null
      }
      const 名前 = (key: string) => key.slice(key.indexOf('\u0000') + 1)
      return { at, 並び: keys, 名前, 送る: 並びを送る }
    }
    const group = groups.find((each) => each.cards.includes(一つだけ))
    if (group === undefined) {
      return null
    }
    return {
      at: group.cards.indexOf(一つだけ),
      並び: group.cards,
      名前: カードの名前,
      送る: (next) => saveCardOrder(group.host, group.project, next),
    }
  })()
  const [通知, set通知] = useState('')
  const 通知の予定 = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (通知の予定.current !== null) {
        clearTimeout(通知の予定.current)
      }
    }
  }, [])
  /** 読み上げの文言を、少し待ってから差し替える（連打を1回にまとめる） */
  const 告げる = (文: string) => {
    if (通知の予定.current !== null) {
      clearTimeout(通知の予定.current)
    }
    通知の予定.current = setTimeout(() => {
      通知の予定.current = null
      set通知(文)
    }, ANNOUNCE_DEBOUNCE_MS)
  }
  const 前への札 = useRef<HTMLButtonElement>(null)
  const 後ろへの札 = useRef<HTMLButtonElement>(null)
  const 隣へ = async (向き: -1 | 1) => {
    if (一つだけ === null || 一つの居場所 === null) {
      return
    }
    const { at, 並び, 名前, 送る } = 一つの居場所
    const next = moveItem(並び, at, at + 向き)
    if (next === 並び) {
      return
    }
    const 断られた = await 送る(next)
    if (断られた !== null) {
      告げる(断られた)
      return
    }
    const 新しい添字 = at + 向き
    告げる(移動の文言(名前(並び[at]), next.map(名前), 新しい添字))
    // 端へ着いて押したボタンが押せなくなるなら、反対側へフォーカスを移す（落とさない）
    if (新しい添字 === 0) {
      後ろへの札.current?.focus()
    } else if (新しい添字 === next.length - 1) {
      前への札.current?.focus()
    }
  }
  const 起こせる =
    選択.kind === 'card'
      ? targets.filter((target) => 選択.ids.includes(target.cardId))
      : []
  const 消せる =
    選択.kind === 'card'
      ? 選択.ids
      : // **走っているセッションを持つ枠は外せない**（設計§10）。まとめて押しても同じ
        選択.ids.filter((id) => {
          const group = frames.find((each) => each.projectId === id)
          return group !== undefined && group.cards.length === 0
        })

  const まとめて外す = async () => {
    if (選択.kind === 'card') {
      for (const cardId of 消せる) {
        archive(cardId)
      }
    } else {
      for (const id of 消せる) {
        // 口は増やさない。既存の削除を、選んだぶんだけ呼ぶ
        try {
          await fetch(`/api/projects/${id}`, { method: 'DELETE' })
        } catch {
          // 消えたことは `project_removed` で届く。届かなければ画面は変わらない
        }
      }
    }
    clearSelection()
  }

  /**
   * 起こし直しの門を通す（設計§5-4）。
   *
   * **「全て復旧」もまとめて復旧も、同じ門を通る。** 通さないと、「全て復旧」では
   * 止められる枚数が、選んで押すと止められないことになる——**同じ結果になる操作に、
   * 片方だけ保護が付いている状態を作らない**。
   */
  const 押した = async (対象: ReviveTarget[] = targets) => {
    if (対象.length === 0) {
      return
    }
    setAsking(true)
    try {
      const hosts = [...new Set(対象.map((target) => target.host))]
      const answers = await Promise.all(
        hosts.map(
          async (host) =>
            [host, await fetchHostResources(host)] as [
              string,
              HostResourcesAnswer,
            ],
        ),
      )
      // **入館証が切れていたら1枚も送らない**（コードレビュー対応13）。
      // `null`（聞けなかった）は歯止め無しで進む側だが、こちらは進んではいけない
      // ——ログイン画面へ落ちずに26枚流すことになる。`markSignedOut()` は
      // `fetchHostResources` が呼んでいるので、ここは送らずに返るだけでよい
      if (answers.some(([, answer]) => answer === SIGNED_OUT)) {
        return
      }
      // `planRevive` の契約は変えない。`SIGNED_OUT` は上で弾いてある
      const 数えた = new Map(
        answers.map(([host, answer]) => [host, answer as HostResources | null]),
      )
      const 立てた = planRevive(対象, 数えた)
      if (!立てた.over) {
        // 全部入る。**いままでどおり黙って進む**
        送る(立てた.all)
        return
      }
      setPlan(立てた)
    } finally {
      setAsking(false)
    }
  }

  return (
    <div
      className="flex flex-col gap-3"
      /*
        **一覧の地（枠でもカードでもないところ）を押すと全部外れる**（設計§4-2）。
        子は自分の `onClick` で `stopPropagation` しているので、ここへ届くのは
        本当に地を押したときだけ
      */
      onClick={() => clearSelection()}
    >
      {/*
        絞り込みの `<select>` に相乗りさせず、**独立した行**にする（設計§9-3）。
        あちらは名乗りを持つカードが1枚も無ければ消えるので、載せると一緒に消える。

        内訳は**押すボタンより上**に出す（版の切替の雛形）。**0枚なら0枚と言う**——
        「全て」の中身が分からないと押せない、という要件はここで満たす
      */}
      <div
        data-testid="revive-all-row"
        className="flex flex-wrap items-center gap-2 text-xs"
      >
        <span data-testid="revive-breakdown" className="text-muted-foreground">
          {targets.length === 0
            ? '起こし直せるカードはありません（0枚）'
            : `起こし直せるカード：接続断 ${disconnected}枚／終了 ${ended}枚`}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="revive-all"
          disabled={targets.length === 0 || asking}
          title="接続断・終了しているカードを、元の CLI セッションでまとめて起こし直します"
          onClick={() => {
            void 押した()
          }}
        >
          {asking ? '数えています…' : '全て復旧'}
        </Button>
      </div>

      {plan !== null && (
        <ReviveBudgetDialog
          plan={plan}
          onFitting={() => {
            送る(plan.fitting)
            setPlan(null)
          }}
          onAll={() => {
            送る(plan.all)
            setPlan(null)
          }}
          onCancel={() => setPlan(null)}
        />
      )}

      {/*
        `.agent-dashboard.toml` が名乗った名前で絞り込む（セルフホスト化設計§8-5）。
        **これは権限ではない**——ローカルモードには認証が無く、ここは「いまはこの
        プロジェクト群だけ見たい」を叶えるための自己整理にすぎない。
        名乗ったカードが1枚も無ければ、選択肢そのものを出さない
      */}
      {accounts.length > 0 && (
        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">絞り込み</span>
          <select
            data-testid="account-filter"
            className="border-border rounded border px-1.5 py-0.5 text-xs"
            value={filter ?? ''}
            aria-label="名乗りで絞り込む"
            onChange={(event) =>
              setAccountFilter(event.target.value === '' ? null : event.target.value)
            }
          >
            <option value="">すべて</option>
            {accounts.map((account) => (
              <option key={account} value={account}>
                {account}
              </option>
            ))}
          </select>
        </label>
      )}

      {/*
          **まとめて操作の帯**（設計§5-2）。「全て復旧」の行の**すぐ下**に置く
          ——選択は一覧全体に効くので、画面の帯に属する（`DESIGN.md` §39.2）。

          **1枚選んだ時点から出す。**「複数選んだときだけ」にすると、2枚目を選んだ
          瞬間にボタンが生えて画面が跳ねる。

          **同じ形の器の等間隔の列にしない**（`DESIGN.md` §33）。2つしか無いこと・
          既存の「全て復旧」と役割が違うことを、**間隔と地の色**で見せる——数を
          先に置き、ボタンはその右へ寄せて、2つのあいだだけを詰める。

          # 何も選んでいなくても、場所は空けておく

          **消すと、1枚目を選んだ瞬間に下の一覧がずれる。** ずれると、ダブルクリックの
          1打目と2打目が別の場所へ当たり、**開く操作が成立しなくなる**——1打目で
          帯が生まれ、2打目が届く頃には枠が下へ動いている。E2E がこれで落ちた。

          「全て復旧」の行そのものへ混ぜないのは、あちらの内訳の文字数で行の高さが
          変わるため。**別の器にしたうえで、高さだけを常に確保する。**
        */}
        {/*
          **読み上げは帯の外に置く**（並べ替え設計§15-6）。帯は何も選んでいないとき
          `aria-hidden` なので、中に置くと `role="status"` ごと支援技術から消え、次に現れても
          「動的な変化」として読まれない。空のまま先に DOM へ置く（`InputDock` と同じ作法）。
          `sr-only` は絶対配置なので高さを取らず、帯の高さ固定を崩さない。
        */}
        <div role="status" aria-live="polite" data-testid="bulk-live" className="sr-only">
          {通知}
        </div>
        <div
          data-testid="bulk-row"
          aria-hidden={選択.ids.length === 0}
          /*
            **高さを固定する。** 場所を空けるだけでは足りなかった——中身が変わると
            行の高さが変わり（文字が折り返す・ボタンの分だけ背が伸びる）、**選んだ
            瞬間にやはり下の一覧がずれる**。ずれるとダブルクリックの2打目が別の場所へ
            当たり、開く操作が成立しない。

            折り返さない（`flex-nowrap`）ことと、文字を切る（`truncate`）ことも
            同じ理由。**数が増えて2行になった瞬間に、また同じ壊れ方をする。**
          */
          className={`border-primary/30 bg-primary/5 flex h-10 flex-nowrap items-center gap-3 overflow-hidden rounded-md border px-2 text-xs ${
            選択.ids.length === 0 ? 'invisible' : ''
          }`}
          onClick={(event) => event.stopPropagation()}
        >
          <span data-testid="bulk-count" className="text-muted-foreground truncate">
            {選択.kind === 'card'
              ? `${選択.ids.length}枚を選んでいます（起こせるのは ${起こせる.length}枚／走っている ${選択.ids.length - 起こせる.length}枚は触りません）`
              : `${選択.ids.length}枠を選んでいます`}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {一つの居場所 !== null && (
              <>
                <Button
                  ref={前への札}
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  data-testid="bulk-move-back"
                  disabled={一つの居場所.at === 0}
                  aria-label={選択.kind === 'card' ? '選んだカードを1つ前へ' : '選んだ枠を1つ上へ'}
                  title={
                    選択.kind === 'card'
                      ? '選んだカードを1つ前へ動かします（掴んで運ぶのと同じ結果になります）'
                      : '選んだ PJT 枠を1つ上へ動かします（掴んで運ぶのと同じ結果になります）'
                  }
                  onClick={() => {
                    void 隣へ(-1)
                  }}
                >
                  <ChevronGlyph direction={選択.kind === 'card' ? 'left' : 'up'} className="size-3.5" />
                </Button>
                <Button
                  ref={後ろへの札}
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  data-testid="bulk-move-forward"
                  disabled={一つの居場所.at === 一つの居場所.並び.length - 1}
                  aria-label={選択.kind === 'card' ? '選んだカードを1つ後ろへ' : '選んだ枠を1つ下へ'}
                  title={
                    選択.kind === 'card'
                      ? '選んだカードを1つ後ろへ動かします（掴んで運ぶのと同じ結果になります）'
                      : '選んだ PJT 枠を1つ下へ動かします（掴んで運ぶのと同じ結果になります）'
                  }
                  onClick={() => {
                    void 隣へ(1)
                  }}
                >
                  <ChevronGlyph direction={選択.kind === 'card' ? 'right' : 'down'} className="size-3.5" />
                </Button>
              </>
            )}
            {選択.kind === 'card' && (
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                data-testid="bulk-revive"
                disabled={起こせる.length === 0 || asking}
                aria-label={`選んだうち、止まっている ${起こせる.length}枚を起こす`}
                title={`選んだうち、止まっている ${起こせる.length}枚を起こします（走っているセッションには触りません）`}
                onClick={() => {
                  void 押した(起こせる)
                }}
              >
                <PowerGlyph className="size-3.5" />
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              data-testid="bulk-remove"
              disabled={消せる.length === 0}
              aria-label={
                選択.kind === 'card'
                  ? `選んだ ${消せる.length}枚を一覧から外す`
                  : `選んだ ${消せる.length}枠を一覧から外す`
              }
              title={
                選択.kind === 'card'
                  ? '選んだカードを一覧から外します（履歴は残ります）'
                  : '選んだ PJT 枠を外します（セッションが動いている枠は外せません）'
              }
              onClick={() => {
                void まとめて外す()
              }}
            >
              <TrashGlyph className="size-3.5" />
            </Button>
          </div>
        </div>

      {orderError !== null && (
        <p data-testid="project-order-error" className="text-destructive text-xs">
          {orderError}
        </p>
      )}

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {filter === null
            ? 'セッションはまだありません'
            : `「${filter}」のセッションはありません`}
        </p>
      ) : (
        <div data-testid="tile-grid" className="flex flex-col gap-4">
          {並び.map((group) => (
            <ProjectGroup
              // 鍵は（PC, パス）の組（設計§13）。パスだけだと別の PC の同名 PJT と衝突する
              key={鍵(group)}
              host={group.host}
              project={group.project}
              projectId={group.projectId}
              cards={group.cards}
              /*
                **掴めるのは、記録を持つ枠だけ。** カードから逆算した箱は DB に
                行が無いので、並べ替えた結果を書き戻す先が無い——動かせても何も
                残らないものは、壊れているのと見分けが付かない
              */
              grab={group.projectId === undefined ? undefined : bind(鍵(group))}
              scroller={縦の箱}
              rootRef={itemRef(鍵(group))}
              dragging={dragging === 鍵(group)}
              reordering={reordering}
            />
          ))}
        </div>
      )}
    </div>
  )
}
