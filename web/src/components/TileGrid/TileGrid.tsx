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

import { useCallback, useEffect, useRef, useState } from 'react'

import { useReorder } from '@/lib/useReorder'

import { ProjectGroup } from '@/components/ProjectGroup/ProjectGroup'
import { ReorderHandle } from '@/components/ReorderHandle/ReorderHandle'
import { ReviveBudgetDialog } from '@/components/TileGrid/ReviveBudgetDialog'
import { Button } from '@/components/ui/button'
import { PowerGlyph, TrashGlyph } from '@/components/ui/glyphs'
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
  setAccountFilter,
  useAccountFilter,
  useProjectGroups,
  useReviveTargets,
  useTomlAccounts,
} from '@/stores/sessions'
import { saveProjectOrder } from '@/stores/projects'
import { clearSelection, toggleSelect, useSelection } from '@/stores/selection'
import { agentOf, useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

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
    setOrderError(await saveProjectOrder(ids))
  }, [])

  const { order, dragging, bind, itemRef } = useReorder({
    ids: frames.map(鍵),
    onCommit: (next) => {
      void 並びを送る(next)
    },
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
        <div
          data-testid="bulk-row"
          aria-hidden={選択.ids.length === 0}
          className={`border-primary/30 bg-primary/5 flex flex-wrap items-center gap-3 rounded-md border px-2 py-1.5 text-xs ${
            選択.ids.length === 0 ? 'invisible' : ''
          }`}
          onClick={(event) => event.stopPropagation()}
        >
          <span data-testid="bulk-count" className="text-muted-foreground">
            {選択.kind === 'card'
              ? `${選択.ids.length}枚を選んでいます（起こせるのは ${起こせる.length}枚／走っている ${選択.ids.length - 起こせる.length}枚は触りません）`
              : `${選択.ids.length}枠を選んでいます`}
          </span>
          <div className="ml-auto flex items-center gap-1">
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
                **掴み手は、記録を持つ枠にだけ出す。** カードから逆算した箱は DB に
                行が無いので、並べ替えた結果を書き戻す先が無い——押しても何も起きない
                ものを置くと、壊れているのと見分けが付かない
              */
              handle={
                group.projectId === undefined ? undefined : (
                  <ReorderHandle
                    kind="project"
                    label={`${group.project} を掴んで並べ替える`}
                    {...bind(鍵(group))}
                    // 掴まずに離したら選ぶ（設計§4-4 の保険）
                    onTap={() => toggleSelect('project', group.projectId as string)}
                  />
                )
              }
              rootRef={itemRef(鍵(group))}
              dragging={dragging === 鍵(group)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
