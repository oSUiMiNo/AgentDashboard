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

import { useState } from 'react'

import { ProjectGroup } from '@/components/ProjectGroup/ProjectGroup'
import { ReviveBudgetDialog } from '@/components/TileGrid/ReviveBudgetDialog'
import { Button } from '@/components/ui/button'
import { reviveState } from '@/lib/protocol'
import {
  fetchHostResources,
  hostOf,
  planRevive,
  type HostResources,
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
import { agentOf, useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

export function TileGrid() {
  const groups = useProjectGroups()
  const accounts = useTomlAccounts()
  const filter = useAccountFilter()
  const candidates = useReviveTargets()
  const agents = useSettingsStore((state) => state.settings.agents)
  const revive = useWsStore((state) => state.revive)

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
    // 口は増やさない。**対象ぶん1枚ずつ送る**——並べるのは PC 側なので、
    // 押し手は数を気にしなくてよい（PC が複数あれば自然に台数ぶん並列になる）
    for (const cardId of ids) {
      revive(cardId)
    }
  }

  const 押した = async () => {
    setAsking(true)
    try {
      const hosts = [...new Set(targets.map((target) => target.host))]
      const answers = await Promise.all(
        hosts.map(
          async (host) =>
            [host, await fetchHostResources(host)] as [
              string,
              HostResources | null,
            ],
        ),
      )
      const 立てた = planRevive(targets, new Map(answers))
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
    <div className="flex flex-col gap-3">
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

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {filter === null
            ? 'セッションはまだありません'
            : `「${filter}」のセッションはありません`}
        </p>
      ) : (
        <div data-testid="tile-grid" className="flex flex-col gap-4">
          {groups.map((group) => (
            <ProjectGroup
              // 鍵は（PC, パス）の組（設計§13）。パスだけだと別の PC の同名 PJT と衝突する
              key={`${group.host}\u0000${group.project}`}
              host={group.host}
              project={group.project}
              projectId={group.projectId}
              cards={group.cards}
            />
          ))}
        </div>
      )}
    </div>
  )
}
