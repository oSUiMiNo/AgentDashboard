/**
 * 「全て復旧」が入りきらないときのダイアログ（起こし直し設計§18-5）。
 *
 * **「もう一度確かめる」の後だけは、全部入るときも出したまま押させる**（`plan.over` が偽）。
 * 押したのは「確かめる」で「戻す」ではないので、黙って送らない。
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
  /**
   * 数えた枚数が古くなっていたので、押された操作の代わりに確かめ直した後か
   * （実装レビュー第3回 Astra 3）。**押したのに送られなかったわけを言う**
   */
  recheckedBecauseStale: boolean
  /** 入るぶんだけ戻す */
  onFitting: () => void
  /** それでも全部戻す */
  onAll: () => void
  /** もう一度確かめる（確かめられていない PC があるときと、確かめ直している間だけ出す） */
  onRecheck: () => void
  onCancel: () => void
}

/**
 * 見出し（`aria-label` と同じ文字列）。**何で抑えられているのか**を先頭で言う（設計§6-3）。
 *
 * 確かめられないわけが混ざったら、**待てば済む見込みが小さい順**に先を言う——
 * PC が「聞けなかった」と答えた（`failed`）→ 答えそのものが来なかった（`no_answer`）→
 * 待っても答えが来なかった（`gave_up`）。**`no_answer` は「Windows 側」と言わない**
 * （WSL でない PC でも起こる）
 */
function 見出し(plan: RevivePlan): string {
  if (!plan.over) {
    return '全部起こし直せます'
  }
  if (plan.hosts.some((host) => host.unconfirmed === 'failed')) {
    return 'Windows 側の空きを確かめられませんでした'
  }
  if (plan.hosts.some((host) => host.unconfirmed === 'no_answer')) {
    return 'PC の空きメモリを聞けませんでした'
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
function 外側の行(resources: HostResources, 打ち切った: boolean) {
  const state = resources.host_free_state
  const age =
    resources.host_free_age_sec == null
      ? ''
      : `${ago(resources.host_free_age_sec)}`
  const counted = resources.counted_mb
  if (state === 'fresh' && resources.host_free_mb != null) {
    /*
      **「使える空き」は判定に使う空き（`effective_mb`）。** CLI と断りの文面がこの語で
      `effective_mb` を指しているので、ここだけ予約を引く前の数を指すと、画面で 2.8 GB と
      読んだ人が断りの 2.0 GB を見て「数が合わない」と読む
    */
    const 使える = resources.effective_mb ?? counted
    return (
      <>
        Windows 側の空き <strong>{gb(resources.host_free_mb)}</strong>
        {age !== '' && `（${age}に確認）`}
        {使える != null && (
          <>
            ／使える空き <strong>{gb(使える)}</strong>
          </>
        )}
      </>
    )
  }
  if (state === 'stale' && resources.host_free_mb != null) {
    return (
      <>
        Windows 側の空き <strong>{gb(resources.host_free_mb)}</strong>
        （{age !== '' ? `${age}の値・` : ''}
        {打ち切った ? '確かめ直しましたが答えが来ませんでした' : '確かめ直しています'}）
      </>
    )
  }
  if (state === 'checking' || state === 'stale') {
    return 打ち切った ? (
      <>Windows 側の空きを確かめられていません（待っても答えが来ませんでした）</>
    ) : (
      <>Windows 側の空きを確かめています</>
    )
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

/**
 * 起こしている途中のぶんの行（予約が制約のときだけ）。**差し引いたぶんを言う。**
 *
 * **「うち X」とだけ書かない。** 「使える空き Y」の直後に置くと Y の内訳に読めるが、
 * X は Y より大きいことがある。何から差し引いた値なのかを文の中で言う。
 *
 * - `fresh`：使える空きは外側の行に出ているので、その説明だけを添える
 * - 状態の欄が無い（WSL でない・古い PC）：使える空きはここでしか出ないので、値ごと出す
 * - 確かめられていない PC：出さない（数えていないので、引いた値も判断材料にならない）
 */
function 予約の行(host: HostBudget, resources: HostResources) {
  const effective = resources.effective_mb
  if (effective == null || host.unconfirmed !== null) {
    return null
  }
  const base = resources.counted_mb ?? resources.available_mb
  if (effective >= base) {
    return null
  }
  const 差分 = gb(base - effective)
  if (resources.host_free_state === 'fresh') {
    return <>使える空きは、起こしている途中のぶん {差分} を差し引いた値です</>
  }
  return (
    <>
      使える空き <strong>{gb(effective)}</strong>（起こしている途中のぶん {差分} を差し引いた値）
    </>
  )
}

/**
 * 枚数を数えない PC か。答えがあれば `fits_now === null`＝`revive_estimate_mb = 0`（設定で
 * 外している）、答えが無ければ「この機械では数えない」と答えた PC（501・409）。
 *
 * **1枚あたりの見積もりも 0 なので、「必要」の数も出さない**——「必要 0.0 GB」と出すと、
 * 見積もっていないものが「何も要らない」に読める
 */
function 数えない設定(host: HostBudget): boolean {
  return host.unconfirmed === null && host.fits === null
}

function 入る行(host: HostBudget) {
  if (数えない設定(host)) {
    /*
      **数が空いたまま出さない**（実装レビュー第3回 Astra 5）。以前は `null` をそのまま描き
      「いま入るのは 枚」と出ていた。言い方は CLI（`render_resources`）に揃える
    */
    return (
      <span className="text-muted-foreground">
        この PC は枚数を数えない設定です（revive_estimate_mb = 0 で歯止めを外しています）
      </span>
    )
  }
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
  recheckedBecauseStale,
  onFitting,
  onAll,
  onRecheck,
  onCancel,
}: Props) {
  /*
    数えられた PC と、確かめられていない PC を並べる。「数えない」と答えた PC は
    歯止めの外＝出しても判断材料にならない。**答えが来なかった PC は、前に聞けた答えが
    無くても出す**——0 枚に数えているのに画面から消えると、なぜ減ったのか読めない
  */
  const 並べる = plan.hosts.filter(
    (host) => host.resources !== null || host.unconfirmed !== null,
  )
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
  /*
    **数えない PC のぶんは「入る」と言わない。** 空きを確かめずに送るだけなので、
    「全部入ります」と書くと確かめていない数を確かめたように言うことになる。

    **足元の文では「設定」と言わない。** 「この機械では数えない」と答えた PC（501・409。
    `resources` が無い）もここに入る——読めない機械・古い版で、設定で外したのではない
  */
  const 数えないPCがある = plan.hosts.some(数えない設定)
  const 数えるPCがある = plan.hosts.some((host) => !数えない設定(host))
  /*
    **確かめている間は、どこから押しても忙しさを出す。** 枚数が古くなっていて押した操作の
    代わりに確かめ直すとき、全台が確かめられていれば「もう一度確かめる」は出ていない——
    出さないと、押せないボタンが並ぶだけで何が起きているのか見えない
  */
  const 確かめるボタン = 確かめられていない || rechecking

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

        {並べる.map((host) => {
          const resources = host.resources
          const 答え無し = host.unconfirmed === 'no_answer'
          const 予約 = resources === null ? null : 予約の行(host, resources)
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
                {resources !== null && resources.fits_now != null && (
                  <>
                    {' ／ '}
                    必要{' '}
                    <strong>
                      {gb(host.targets * resources.estimate_mb)}
                    </strong>
                    <span className="text-muted-foreground">
                      （1枚 約{resources.estimate_mb}MB）
                    </span>
                  </>
                )}
              </p>
              {/*
                **答えが来なかった PC には、前に聞けた空きを出さない。** いつの値か言えない
                数を並べると、いまの空きに読める
              */}
              {resources !== null && !答え無し && (
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
              )}
              {/*
                **数字だけ直すと、説明のつかない画面になる。** 空きが潤沢に見えるのに
                0枚では、壊れているのと見分けが付かない。**何で抑えたのか**を書く。
                WSL でなければ状態も `counted_mb` も null なので、**行そのものが出ない**
              */}
              {答え無し ? (
                <p
                  data-testid="revive-budget-outside"
                  className="text-muted-foreground"
                >
                  この PC から空きメモリの答えが来ませんでした
                </p>
              ) : (
                resources !== null &&
                (resources.host_free_state != null ||
                  resources.counted_mb != null) && (
                  <p
                    data-testid="revive-budget-outside"
                    className="text-muted-foreground"
                  >
                    {外側の行(resources, host.unconfirmed === 'gave_up')}
                  </p>
                )
              )}
              {予約 !== null && (
                <p
                  data-testid="revive-budget-reserved"
                  className="text-muted-foreground"
                >
                  {予約}
                </p>
              )}
              <p data-testid="revive-budget-fits">{入る行(host)}</p>
            </div>
          )
        })}

        <p className="text-muted-foreground text-xs">
          {recheckedBecauseStale && (
            <>
              数えてから時間が経ち、枚数が古くなっていたので、送らずに確かめ直しました。
              <br />
            </>
          )}
          {!plan.over && 数えるPCがある && (
            <>
              確かめ直した結果、
              {数えないPCがある ? '数える PC のぶん' : '選んだぶん'}は全部入ります。
              <br />
            </>
          )}
          {数えないPCがある && (
            <>
              枚数を数えない PC のぶんは、空きを確かめずに送ります。
              <br />
            </>
          )}
          {足りない && (
            <>
              全部戻すと空きを超え、機械が固まることがあります。
              <br />
            </>
          )}
          {確かめられていない && (
            <>
              {
                '確かめられていない PC のぶんは「入るぶんだけ戻す」に含めません。「それでも全部戻す」を押しても、起こすときに PC 側が確かめ直し、足りなければ断ります。'
              }
              <br />
            </>
          )}
          {/* **なぜその N 枚なのかを書く。** 黙って選ぶと理由が誰にも分からない */}
          {plan.over && (
            <>
              「入るぶんだけ戻す」は<strong>最終活動が新しい順</strong>に選びます。
            </>
          )}
        </p>

        <div className="flex flex-wrap gap-2">
          {確かめるボタン && (
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
          {/*
            **全部入るなら、押す場所は1つ。** 「入るぶんだけ」と「それでも全部」は同じ相手を
            指すので、2つ並べると違いを探させることになる
          */}
          {plan.over && (
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
          )}
          <Button
            type="button"
            variant={plan.over ? 'outline' : 'default'}
            size="sm"
            data-testid="revive-budget-all"
            disabled={rechecking}
            onClick={onAll}
          >
            {plan.over
              ? `それでも全部戻す（${plan.all.length}枚）`
              : `全部戻す（${plan.all.length}枚）`}
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
