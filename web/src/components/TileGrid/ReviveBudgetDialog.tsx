/**
 * 「全て復旧」が入りきらないときのダイアログ（起こし直し設計§18-5）。
 *
 * **枚数だけでは資源が読めない。** 内訳（「接続断 7枚／終了 19枚」）は要件の
 * 「押した人が数を予測できること」を満たしているが、26枚が約 20GB を要求することは
 * そこからは分からない——押すと機械が固まる。
 *
 * 器は `ProjectAdd` のシートを写した（このアプリで唯一のダイアログ）。**新しい部品を
 * 作らない。**
 */

import { Button } from '@/components/ui/button'
import {
  ago,
  gb,
  type HostBudget,
  type HostResources,
  type RevivePlan,
} from '@/lib/reviveBudget'
import { LOCAL_HOST } from '@/lib/routes'
import { agentName, useSettingsStore } from '@/stores/settings'

interface Props {
  plan: RevivePlan
  /** 「もう一度確かめる」が聞き直している間 */
  rechecking: boolean
  /** 入るぶんだけ戻す */
  onFitting: () => void
  /** それでも全部戻す */
  onAll: () => void
  /** もう一度確かめる（確かめられていない PC があるときだけ出す） */
  onRecheck: () => void
  onCancel: () => void
}

/**
 * 見出し（`aria-label` と同じ文字列）。**何で抑えられているのか**を先頭で言う（設計§6-3）。
 *
 * 確かめられなかった PC（`failed`）と上限に達した PC（`gave_up`）が混ざったら、
 * **`failed` を先に言う**——PC が「聞けなかった」と答えたほうが、待てば済む見込みが小さい
 */
function 見出し(plan: RevivePlan): string {
  if (plan.hosts.some((host) => host.unconfirmed === 'failed')) {
    return 'Windows 側の空きを確かめられませんでした'
  }
  if (plan.hosts.some((host) => host.unconfirmed === 'gave_up')) {
    return 'Windows 側の空きを確かめられていません'
  }
  return '起こし直せますが、メモリが足りません'
}

/**
 * WSL の外側（Windows）の行。状態ごとに出し分ける（設計§6-3 の表）。
 *
 * **状態の欄が無い**のは古い PC の答えで、外側の値があるかだけで言い分ける
 * （「もう一度押すと反映されます」は出さない——押し直す必要は無くなった）
 */
function 外側の行(resources: HostResources) {
  const state = resources.host_free_state
  const age =
    resources.host_free_age_sec == null
      ? ''
      : `${ago(resources.host_free_age_sec)}`
  const counted = resources.counted_mb
  if (state === 'fresh' && resources.host_free_mb != null) {
    return (
      <>
        Windows 側の空き <strong>{gb(resources.host_free_mb)}</strong>
        {age !== '' && `（${age}に確認）`}
        {counted != null && (
          <>
            ／使える空き <strong>{gb(counted)}</strong>
          </>
        )}
      </>
    )
  }
  if (state === 'stale' && resources.host_free_mb != null) {
    return (
      <>
        Windows 側の空き <strong>{gb(resources.host_free_mb)}</strong>
        （{age !== '' ? `${age}の値・` : ''}確かめ直しています）
      </>
    )
  }
  if (state === 'checking' || state === 'stale') {
    return <>Windows 側の空きを確かめています</>
  }
  if (state === 'failed') {
    const 理由 = resources.host_free_error
    return (
      <>
        Windows 側の空きを確かめられませんでした
        {理由 != null && 理由 !== '' && (
          <span data-testid="revive-budget-error">（{理由}）</span>
        )}
      </>
    )
  }
  if (state == null && counted != null) {
    return resources.host_free_mb == null ? (
      <>
        Windows 側の空きをまだ聞けていません／数えたのは{' '}
        <strong>{gb(counted)}</strong>
      </>
    ) : (
      <>
        Windows 側の空き <strong>{gb(resources.host_free_mb)}</strong>
        ／数えたのは <strong>{gb(counted)}</strong>
      </>
    )
  }
  // 知らない綴り。確かめられていない側として言う
  return <>Windows 側の空きを確かめられませんでした</>
}

/** 起こしている途中のぶんを差し引いた空きが、観測より小さいか（予約が制約） */
function 予約で抑えた(resources: HostResources): number | null {
  const effective = resources.effective_mb
  if (effective == null) {
    return null
  }
  const base = resources.counted_mb ?? resources.available_mb
  return effective < base ? effective : null
}

function 入る行(host: HostBudget) {
  if (host.unconfirmed !== null) {
    return (
      <>
        いま入るのは <strong>0枚</strong>
        <span className="text-muted-foreground">
          （確かめられていないので、この PC のぶんは数えません）
        </span>
      </>
    )
  }
  return (
    <>
      いま入るのは <strong>{host.fits}枚</strong>
    </>
  )
}

export function ReviveBudgetDialog({
  plan,
  rechecking,
  onFitting,
  onAll,
  onRecheck,
  onCancel,
}: Props) {
  // 数えられた PC だけを並べる（聞けなかった PC は歯止めの外＝出しても判断材料にならない）
  const 数えた = plan.hosts.filter((host) => host.resources !== null)
  // **生の `agent_id`（UUID）を出さない**（コードレビュー対応10）。2台以上あると
  // 「PC：11111111-2222-…」が並び、**どちらを間引くかを決める**というこの
  // ダイアログの目的が果たせない。`SessionTile` と同じ道具を使う
  const agents = useSettingsStore((state) => state.settings.agents)
  /** その宛先の呼び名。**引けなければ綴りをそのまま出す**（嘘をつかない） */
  const pc名 = (host: string): string =>
    agentName(agents, host === LOCAL_HOST ? null : host) ?? host
  const 入る枚数 = plan.fitting.length
  const 題 = 見出し(plan)
  const 確かめられていない = plan.hosts.some((host) => host.unconfirmed !== null)
  // 確かめられた PC のうち、入りきらないものがあるか（足元の文を出し分ける）
  const 足りない = plan.hosts.some(
    (host) =>
      host.unconfirmed === null && host.fits !== null && host.targets > host.fits,
  )

  return (
    <>
      {/* 暗い幕。**押しても閉じない**——取り違えて全部戻すほうが痛い */}
      <div aria-hidden className="fixed inset-0 z-40 bg-black/60" />
      <div
        data-testid="revive-budget-dialog"
        role="dialog"
        aria-label={題}
        className="bg-background fixed inset-0 z-50 flex flex-col gap-3 overflow-y-auto p-4 sm:inset-x-auto sm:inset-y-16 sm:left-1/2 sm:w-[min(34rem,90vw)] sm:-translate-x-1/2 sm:rounded-xl sm:border sm:shadow-xl"
      >
        <header className="flex shrink-0 items-center gap-2">
          <h2 data-testid="revive-budget-title" className="text-sm font-semibold">
            {題}
          </h2>
        </header>

        {数えた.map((host) => {
          const resources = host.resources
          if (resources === null) {
            return null
          }
          const 抑えた = 予約で抑えた(resources)
          return (
            <div
              key={host.host}
              data-testid="revive-budget-host"
              className="border-border flex flex-col gap-1 rounded-lg border p-3 text-xs"
            >
              {plan.hosts.length > 1 && (
                <p className="text-muted-foreground">PC：{pc名(host.host)}</p>
              )}
              <p>
                対象{' '}
                <strong data-testid="revive-budget-targets">
                  {host.targets}枚
                </strong>
                {' ／ '}
                必要{' '}
                <strong>
                  {gb(host.targets * resources.estimate_mb)}
                </strong>
                <span className="text-muted-foreground">
                  （1枚 約{resources.estimate_mb}MB）
                </span>
              </p>
              <p data-testid="revive-budget-available">
                {/*
                  **WSL のときは「WSL の中の空き」と呼び分ける**（設計§6-3）。
                  外側（Windows）の空きと並ぶので、ただの「空き」ではどちらか読めない
                */}
                {resources.counted_mb != null ? 'WSL の中の空き' : '空き'}{' '}
                <strong>{gb(resources.available_mb)}</strong>
                <span className="text-muted-foreground">
                  （積んでいる {gb(resources.total_mb)}／残す余白{' '}
                  {gb(resources.headroom_mb)}）
                </span>
              </p>
              {/*
                **数字だけ直すと、説明のつかない画面になる。** 空きが潤沢に見えるのに
                0枚では、壊れているのと見分けが付かない。**何で抑えたのか**を書く。
                WSL でなければ状態も `counted_mb` も null なので、**行そのものが出ない**
              */}
              {(resources.host_free_state != null ||
                resources.counted_mb != null) && (
                <p
                  data-testid="revive-budget-outside"
                  className="text-muted-foreground"
                >
                  {外側の行(resources)}
                </p>
              )}
              {抑えた !== null && (
                <p
                  data-testid="revive-budget-reserved"
                  className="text-muted-foreground"
                >
                  うち起こしている途中のぶんを差し引いて{' '}
                  <strong>{gb(抑えた)}</strong>
                </p>
              )}
              <p data-testid="revive-budget-fits">{入る行(host)}</p>
            </div>
          )
        })}

        <p className="text-muted-foreground text-xs">
          {足りない && (
            <>
              全部戻すと空きを超え、機械が固まることがあります。
              <br />
            </>
          )}
          {確かめられていない && (
            <>
              確かめられていない PC のぶんは「入るぶんだけ戻す」に含めません。
              「それでも全部戻す」を押しても、起こすときに PC 側が確かめ直し、
              足りなければ断ります。
              <br />
            </>
          )}
          {/* **なぜその N 枚なのかを書く。** 黙って選ぶと理由が誰にも分からない */}
          「入るぶんだけ戻す」は<strong>最終活動が新しい順</strong>に選びます。
        </p>

        <div className="flex flex-wrap gap-2">
          {確かめられていない && (
            <Button
              type="button"
              size="sm"
              data-testid="revive-budget-recheck"
              disabled={rechecking}
              aria-busy={rechecking}
              onClick={onRecheck}
            >
              {rechecking ? '確かめています…' : 'もう一度確かめる'}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={確かめられていない ? 'outline' : 'default'}
            data-testid="revive-budget-fitting"
            disabled={入る枚数 === 0 || rechecking}
            onClick={onFitting}
          >
            入るぶんだけ戻す（{入る枚数}枚）
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="revive-budget-all"
            disabled={rechecking}
            onClick={onAll}
          >
            それでも全部戻す（{plan.all.length}枚）
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="revive-budget-cancel"
            className="ml-auto"
            onClick={onCancel}
          >
            やめる
          </Button>
        </div>
      </div>
    </>
  )
}
