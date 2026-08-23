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
import { gb, type RevivePlan } from '@/lib/reviveBudget'
import { LOCAL_HOST } from '@/lib/routes'
import { agentName, useSettingsStore } from '@/stores/settings'

interface Props {
  plan: RevivePlan
  /** 入るぶんだけ戻す */
  onFitting: () => void
  /** それでも全部戻す */
  onAll: () => void
  onCancel: () => void
}

export function ReviveBudgetDialog({ plan, onFitting, onAll, onCancel }: Props) {
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

  return (
    <>
      {/* 暗い幕。**押しても閉じない**——取り違えて全部戻すほうが痛い */}
      <div aria-hidden className="fixed inset-0 z-40 bg-black/60" />
      <div
        data-testid="revive-budget-dialog"
        role="dialog"
        aria-label="起こし直せますが、メモリが足りません"
        className="bg-background fixed inset-0 z-50 flex flex-col gap-3 overflow-y-auto p-4 sm:inset-x-auto sm:inset-y-16 sm:left-1/2 sm:w-[min(34rem,90vw)] sm:-translate-x-1/2 sm:rounded-xl sm:border sm:shadow-xl"
      >
        <header className="flex shrink-0 items-center gap-2">
          <h2 className="text-sm font-semibold">
            起こし直せますが、メモリが足りません
          </h2>
        </header>

        {数えた.map((host) => {
          const resources = host.resources
          if (resources === null) {
            return null
          }
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
              <p>
                空き <strong>{gb(resources.available_mb)}</strong>
                <span className="text-muted-foreground">
                  （積んでいる {gb(resources.total_mb)}／残す余白{' '}
                  {gb(resources.headroom_mb)}）
                </span>
              </p>
              <p data-testid="revive-budget-fits">
                いま入るのは <strong>{host.fits}枚</strong>
              </p>
            </div>
          )
        })}

        <p className="text-muted-foreground text-xs">
          全部戻すと空きを超え、機械が固まることがあります。
          <br />
          {/* **なぜその N 枚なのかを書く。** 黙って選ぶと理由が誰にも分からない */}
          「入るぶんだけ戻す」は<strong>最終活動が新しい順</strong>に選びます。
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            data-testid="revive-budget-fitting"
            disabled={入る枚数 === 0}
            onClick={onFitting}
          >
            入るぶんだけ戻す（{入る枚数}枚）
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="revive-budget-all"
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
