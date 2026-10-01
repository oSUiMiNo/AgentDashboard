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
  /**
   * **WSL の外側（Windows）の空き**（MB）。**最後に聞けた値があれば、古くても入る。**
   *
   * **WSL でないなら `null`**（外側という概念が無い）。**WSL でも一度も聞けていない
   * なら `null`**。古いかどうかは [`host_free_state`] と [`host_free_age_sec`] で読む
   * （寝ているカードばかりなのに、メモリ不足でセッションを起こせない 設計§5）。
   */
  host_free_mb: number | null
  /**
   * **数えるのに実際に使った空き**（MB）。**`available_mb` をそのまま使ったなら `null`。**
   *
   * 読み分けは Rust 側 `protocol::HostResources::counted_mb` の表が正（状態の欄と組で読む）。
   * **`fresh` 以外の状態の数で「何枚戻すか」を決めない**——`checking`・`failed` は
   * `MemFree` の床で数えた参考値で、確かめられていない。
   */
  counted_mb: number | null
  /**
   * 外側の値が何秒前のものか。値が無ければ `null`（寝ているカードばかりなのに、
   * メモリ不足でセッションを起こせない 設計§5）。**古い PC は送ってこない**
   */
  host_free_age_sec: number | null
  /** 外側の値の様子。**WSL でない・期限 0 なら `null`** */
  host_free_state: HostFreeState | null
  /** 最後に外側を聞けなかった理由（`failed` のとき） */
  host_free_error: string | null
  /** 予約を引いた後の、判定に使う空き（MB） */
  effective_mb: number | null
}

/**
 * 外側（Windows）の空きの様子。Rust 側の `protocol::HostFreeState` と同じ綴り。
 *
 * **`fresh` 以外の数で「何枚戻すか」を決めない**（設計§6-3）。
 */
export type HostFreeState = 'fresh' | 'stale' | 'checking' | 'failed'

/** 起こし直す相手1枚ぶん。 */
export interface ReviveTarget {
  cardId: string
  /** どの PC のカードか。ローカルモードは [`LOCAL_HOST`] */
  host: string
  /** 最終活動。**入るぶんだけ戻すとき、新しい順に選ぶ**ための鍵 */
  lastActivityAt: number
}

/**
 * その PC の Windows 側の空きを、確かめられなかったわけ（設計§6-3）。
 *
 * - `gave_up`：聞き直しの上限（[`RECHECK_LIMIT_MS`]）に達しても新しい値が来なかった
 * - `failed`：PC が「聞けなかった」と答えた（理由は `host_free_error`）
 */
export type Unconfirmed = 'gave_up' | 'failed'

/** PC 1台ぶんの内訳。 */
export interface HostBudget {
  host: string
  /** その PC に居る対象の枚数 */
  targets: number
  /**
   * その PC がいま受け入れられる枚数。**聞けなかったら `null`**。
   *
   * **確かめられていない PC は `0`**——床で数えた参考値で戻す枚数を決めない（設計§6-3）
   */
  fits: number | null
  /** 確かめられていないなら、そのわけ。確かめられた（または確かめる必要が無い）なら `null` */
  unconfirmed: Unconfirmed | null
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
 * 聞き直してから計画するべき答えか（設計§6-3）。
 *
 * **見積もり0（`fits_now === null`）は待たない**——数えないのだから、確かめる値が要らない
 * （§12-6 の順1）。`failed` も聞き直さない（PC が次の取得まで空けている）。
 */
export function needsRecheck(resources: HostResources | null): boolean {
  if (resources === null || resources.fits_now == null) {
    return false
  }
  const state = resources.host_free_state
  return state === 'checking' || state === 'stale'
}

/**
 * その PC の答えを、どの規則で読むか（設計§12-6）。
 *
 * **`== null` で比べる。** 古い PC は状態の欄そのものを送ってこないので、実行時には
 * `null` ではなく `undefined` が来る。
 *
 * **数えてよいのは `fresh` だけ**（許可の側を名指しする）。`stale`・`checking`・
 * `failed`、それに**知らない綴り**は、どれも確かめられていない側へ倒す——綴りが
 * 1字ずれても、黙って全部送る側には落ちない。
 */
function 確かめ(found: HostResources | null): Unconfirmed | null {
  if (found === null || found.fits_now == null) {
    // 聞けなかった・見積もり0（歯止めを外している）：制限なし（いまどおり）
    return null
  }
  const state = found.host_free_state
  if (state == null) {
    // WSL でない・期限0・古い PC：いまの規則のまま
    return null
  }
  if (state === 'fresh') {
    return null
  }
  if (state === 'failed') {
    return 'failed'
  }
  if (state === 'stale' || state === 'checking') {
    // **門が聞き直したうえで、まだこの答え**＝聞き直しの上限に達した
    return 'gave_up'
  }
  // 知らない綴り。確かめられていない側へ倒す
  return 'failed'
}

/**
 * 押したときの計画を立てる。
 *
 * **聞けなかった PC は数えない**（`fits` が `null`）。読めない機械（Linux 以外）や
 * 版の古い PC がここに当たる——**分からないことを理由に止めない**ので、その PC の
 * 対象は「入る」側として扱う。
 *
 * **Windows 側の空きを確かめられていない PC は 0 枚**として `over` を立てる
 * （設計§6-3）。PC が「聞けなかった」と言っているのに床で「全部入る」と数えて
 * 黙って全部送る道を塞ぐ。**「入るぶんだけ戻す」は PC ごと**——確かめられた PC の
 * ぶんまで巻き添えにしない。
 *
 * **`stale`・`checking` は、門が聞き直した後の答えとして読む**（[`fetchSettledHostResources`]）。
 * ここへ残っているなら、聞き直しの上限に達したということである。
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
    const unconfirmed = 確かめ(found)
    // **「聞けなかった」と「数えない」を同じ `null` に畳むのは正しい。** どちらも
    // 歯止め無しで進む側で、画面のふるまいは同じでよい（**CLI は言い分ける**——
    // あちらは人が読む答えなので、外しているのか聞けなかったのかは別の話）
    const fits = unconfirmed !== null ? 0 : (found?.fits_now ?? null)
    hosts.push({ host, targets: list.length, fits, unconfirmed, resources: found })

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

/** 聞き直す間隔（設計§6-3） */
export const RECHECK_INTERVAL_MS = 1_000

/**
 * 聞き直しの上限。**PC 側の判定の確認段階と同じ 65 秒**（`2 × HOST_FREE_TIMEOUT + 5 秒`。
 * 設計§3・§6-3）——正常な取得を、画面のほうが先に諦めないため
 */
export const RECHECK_LIMIT_MS = 65_000

/**
 * 聞き直しを済ませた答え。`'cancelled'` は途中で閉じられた・画面を離れた。
 */
export type SettledAnswer = HostResourcesAnswer | 'cancelled'

/**
 * その PC の資源を、**新しい値（または `failed`）が返るまで聞き直す**（設計§6-3）。
 *
 * **確かめられていない数で「何枚戻すか」を決めない。** `checking`・`stale` の答えは
 * `MemFree` の床や前回の値で数えた参考で、そのまま計画へ渡すと、床が「全部入る」と
 * 言った PC へ黙って全部送ることになる。
 *
 * - 締切（`deadline`。`Date.now()` の値）は**押した時点で1回だけ作り**、PC 全台で共有する
 * - 上限に達したら、最後の答え（`checking`・`stale` のまま）を返す。[`planRevive`] が
 *   それを「確かめられていない」として 0 枚に数える
 * - **聞き直しの途中で `null`（聞けなかった）が返っても、歯止め無しへ格下げしない。**
 *   格下げすると、塞ぎたい道（黙って全部送る）が開く。直前の答えを持ったまま締切まで回す
 * - `SIGNED_OUT` は、その場で打ち切って返す（1枚も送らない側）
 * - `isCancelled()` が真になったら `'cancelled'` を返す。**遅れた答えで送らないため**
 */
export async function fetchSettledHostResources(
  host: string,
  deadline: number,
  isCancelled: () => boolean,
): Promise<SettledAnswer> {
  let last = await fetchHostResources(host)
  for (;;) {
    if (isCancelled()) {
      return 'cancelled'
    }
    if (last === SIGNED_OUT || !needsRecheck(last)) {
      return last
    }
    if (Date.now() >= deadline) {
      return last
    }
    await new Promise((resolve) => setTimeout(resolve, RECHECK_INTERVAL_MS))
    if (isCancelled()) {
      return 'cancelled'
    }
    const next = await fetchHostResources(host)
    if (next !== null) {
      last = next
    }
  }
}

/** 何秒前かを、人が読む形にする（「12 秒前」「4 分前」「2 時間前」） */
export function ago(sec: number): string {
  if (sec < 60) {
    return `${sec} 秒前`
  }
  if (sec < 3_600) {
    return `${Math.floor(sec / 60)} 分前`
  }
  return `${Math.floor(sec / 3_600)} 時間前`
}
