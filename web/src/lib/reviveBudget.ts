/**
 * 「全て復旧」を押す前に、**入るかどうかを数える**（起こし直し設計§18-5）。
 *
 * # なぜ枚数だけでは足りないのか
 *
 * 内訳（「接続断 7枚／終了 19枚」）は要件の「押した人が数を予測できること」を満たして
 * いるが、**枚数からは資源が読めない**。実機の抜け殻26枚は約 20GB を要求し、WSL の枠は
 * 15.7GB しかない——押すと機械が固まる。
 *
 * **席（同時に起こす本数）は助けにならない。** 席が絞るのは起動の山で、**載る総量は
 * 絞らない**（設計§17-2 の実測）。26枚頼めば26本ぶんが積み上がる。
 *
 * # 数える規則はここに無い
 *
 * 「何枚入るか」（`fits_now`）を計算するのは **PC 側の1箇所**（`resources::fits`）で、
 * ここがやるのは**受け取った数と対象の枚数を比べること**だけである。同じ規則を
 * Rust と TypeScript の2箇所に書くと、**画面が「入る」と言ったものを PC が断る**
 * （あるいは逆）ことが起こる。
 *
 * 戻せるかの判定（設計§3-3）は二重に持ってよいと決めたが、あちらはずれても
 * 「押せてしまってサーバが断る」に倒れるだけだった。**こちらはずれると機械が死ぬ。**
 */

import { LOCAL_HOST } from '@/lib/routes'
import { useAuthStore } from '@/stores/auth'

/** Rust 側の `protocol::HostResources` と同じ綴り。 */
export interface HostResources {
  total_mb: number
  available_mb: number
  swap_free_mb: number
  estimate_mb: number
  headroom_mb: number
  /**
   * **いま何枚起こし直せるか。** 数えたのは PC 側。
   *
   * **`null` は「数えない」**（`revive_estimate_mb = 0`＝歯止めを外している）。
   * 以前は番兵（`u32::MAX`）が数として載っていた（コードレビュー対応2）。
   */
  fits_now: number | null
}

/** 起こし直す相手1枚ぶん。 */
export interface ReviveTarget {
  cardId: string
  /** どの PC のカードか。ローカルモードは [`LOCAL_HOST`] */
  host: string
  /** 最終活動。**入るぶんだけ戻すとき、新しい順に選ぶ**ための鍵 */
  lastActivityAt: number
}

/** PC 1台ぶんの内訳。 */
export interface HostBudget {
  host: string
  /** その PC に居る対象の枚数 */
  targets: number
  /** その PC がいま受け入れられる枚数。**聞けなかったら `null`** */
  fits: number | null
  resources: HostResources | null
}

/** 押したときにどうするか。 */
export interface RevivePlan {
  /** 1台でも入りきらないか。**偽ならダイアログを出さずに進む** */
  over: boolean
  /** 全部戻すときの相手 */
  all: string[]
  /** 入るぶんだけ戻すときの相手（**PC ごとに、最終活動が新しい順**） */
  fitting: string[]
  hosts: HostBudget[]
}

/** カードの `agent_id` を、REST とルートで使う綴りへ直す。 */
export function hostOf(agentId: string | null | undefined): string {
  return agentId ?? LOCAL_HOST
}

/**
 * 押したときの計画を立てる。
 *
 * **聞けなかった PC は数えない**（`fits` が `null`）。読めない機械（Linux 以外）や
 * 版の古い PC がここに当たる——**分からないことを理由に止めない**ので、その PC の
 * 対象は「入る」側として扱う。
 */
export function planRevive(
  targets: ReviveTarget[],
  resources: ReadonlyMap<string, HostResources | null>,
): RevivePlan {
  const byHost = new Map<string, ReviveTarget[]>()
  for (const target of targets) {
    const list = byHost.get(target.host)
    if (list) {
      list.push(target)
    } else {
      byHost.set(target.host, [target])
    }
  }

  const hosts: HostBudget[] = []
  const fitting: string[] = []
  let over = false

  for (const [host, list] of byHost) {
    const found = resources.get(host) ?? null
    // **「聞けなかった」と「数えない」を同じ `null` に畳むのは正しい。** どちらも
    // 歯止め無しで進む側で、画面のふるまいは同じでよい（**CLI は言い分ける**——
    // あちらは人が読む答えなので、外しているのか聞けなかったのかは別の話）
    const fits = found?.fits_now ?? null
    hosts.push({ host, targets: list.length, fits, resources: found })

    if (fits === null || list.length <= fits) {
      // 聞けなかった、または全部入る。**間引かない**
      for (const target of list) {
        fitting.push(target.cardId)
      }
      continue
    }
    over = true
    // **新しい順に選ぶ。** 黙って選ぶと「なぜこの N 枚なのか」が誰にも分からないので、
    // 画面には理由を1行出す（設計§18-5）
    const 新しい順 = [...list].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    for (const target of 新しい順.slice(0, fits)) {
      fitting.push(target.cardId)
    }
  }

  return {
    over,
    all: targets.map((target) => target.cardId),
    fitting,
    hosts,
  }
}

/** MB を人が読む形にする。 */
export function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`
}

/**
 * 入館証が切れていた、という答え（コードレビュー対応13）。
 *
 * **「聞けなかった」（`null`）と混ぜてはいけない。** あちらは歯止め無しで進む側だが、
 * こちらで進むと**ログイン画面へ落ちずに26枚流す**ことになる。
 */
export const SIGNED_OUT = 'signed-out' as const

/** [`fetchHostResources`] の答え。 */
export type HostResourcesAnswer =
  | HostResources
  | null
  | typeof SIGNED_OUT

/**
 * その PC の資源を聞く（`GET /api/hosts/{host}/resources`）。
 *
 * **押した瞬間にだけ聞く。** 常時持っていると古い値で判断することになる。
 * 聞けなければ `null`——**歯止め無しで進む**ので、投げるのではなく畳んで返す。
 *
 * # 401 だけは言い分ける
 *
 * cookie が切れているときに `null` へ畳むと、**歯止め無しで全部流す**ことになる。
 * 他の取得口（`stores/settings.ts` ／ `stores/versions.ts` ／ `stores/ws.ts`）は
 * 401 で `markSignedOut()` を呼ぶ約束なので、ここも揃える。
 *
 * **例外にしない。** `Promise.all` で投げると押した流れの他の分岐まで巻き込むうえ、
 * 「聞けなかったら進む」という既存の契約と混ざる。**返り値で言い分けるほうが読める。**
 */
export async function fetchHostResources(
  host: string,
): Promise<HostResourcesAnswer> {
  try {
    const response = await fetch(
      `/api/hosts/${encodeURIComponent(host)}/resources`,
    )
    if (response.status === 401) {
      useAuthStore.getState().markSignedOut()
      return SIGNED_OUT
    }
    if (!response.ok) {
      return null
    }
    return (await response.json()) as HostResources
  } catch {
    return null
  }
}
