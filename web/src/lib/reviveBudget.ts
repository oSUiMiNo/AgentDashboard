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
  /**
   * `fresh` の値が、答えた時点から**あと何秒新しいか**。**古い PC は送ってこない**（`null`）。
   *
   * 遅い PC を待つ間に、先に答えた PC の `fresh` が期限を越えることがある。これが無いと
   * 画面はそれを見分けられない（[`settleHostResources`]）
   */
  host_free_fresh_for_sec: number | null
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
 * その PC の空きを、確かめられなかったわけ（設計§6-3）。
 *
 * - `gave_up`：聞き直しの上限（[`RECHECK_LIMIT_MS`]）に達しても新しい値が来なかった
 * - `failed`：PC が「Windows 側を聞けなかった」と答えた（理由は `host_free_error`）
 * - `no_answer`：**PC の答えそのものが来なかった**（通信の失敗・時間切れ。[`NO_ANSWER`]）。
 *   WSL でない PC でも起こるので、画面はこれを「Windows 側」と呼ばない
 */
export type Unconfirmed = 'gave_up' | 'failed' | 'no_answer'

/** PC 1台ぶんの内訳。 */
export interface HostBudget {
  host: string
  /** その PC に居る対象の枚数 */
  targets: number
  /**
   * その PC がいま受け入れられる枚数。**PC が「数えない」と答えたら `null`**。
   *
   * **確かめられていない PC は `0`**——床で数えた参考値で戻す枚数を決めない（設計§6-3）
   */
  fits: number | null
  /** 確かめられていないなら、そのわけ。確かめられた（または確かめる必要が無い）なら `null` */
  unconfirmed: Unconfirmed | null
  /**
   * 表示に使う答え。**`no_answer` のときは前に聞けた答え**（無ければ `null`）で、
   * 数えるのには使っていない
   */
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
    // この機械では数えない・見積もり0（歯止めを外している）：制限なし（いまどおり）
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
 * 答えが来なかった PC（[`NO_ANSWER`]）を、計画へ渡す形。
 *
 * `last` は前に聞けた答えで、**表示にだけ使い、数えない**。確かめ直しで1周目の通信が
 * 失敗しても、前回の答えを持ったまま「確かめられていない」に留めるために持ち回す
 */
export interface NoAnswer {
  readonly no_answer: true
  readonly last: HostResources | null
}

export function noAnswer(last: HostResources | null): NoAnswer {
  return { no_answer: true, last }
}

/**
 * 計画へ渡す PC 1台ぶんの答え。
 *
 * - `HostResources`：答えが来た
 * - `null`：**PC が「この機械では数えない」と答えた**（[`fetchHostResources`]）。歯止め無し
 * - [`NoAnswer`]：**答えが来なかった**。確かめられていない側
 */
export type HostAnswer = HostResources | null | NoAnswer

function isNoAnswer(answer: HostAnswer): answer is NoAnswer {
  return answer !== null && 'no_answer' in answer
}

/**
 * 押したときの計画を立てる。
 *
 * **「数えない」と答えた PC は数えない**（`fits` が `null`）。読めない機械（Linux 以外）や
 * 版の古い PC がここに当たる——**分からないことを理由に止めない**ので、その PC の
 * 対象は「入る」側として扱う。
 *
 * **答えが来なかった PC（[`NoAnswer`]）は、それとは別。** 通信が失敗しただけで、WSL の
 * 確認が要る PC かどうかも分からないので、確かめられていない PC として 0 枚に数える。
 *
 * **Windows 側の空きを確かめられていない PC は 0 枚**として `over` を立てる
 * （設計§6-3）。PC が「聞けなかった」と言っているのに床で「全部入る」と数えて
 * 黙って全部送る道を塞ぐ。**「入るぶんだけ戻す」は PC ごと**——確かめられた PC の
 * ぶんまで巻き添えにしない。
 *
 * **`stale`・`checking` は、門が聞き直した後の答えとして読む**（[`settleHostResources`]）。
 * ここへ残っているなら、聞き直しの上限に達したということである。
 */
export function planRevive(
  targets: ReviveTarget[],
  resources: ReadonlyMap<string, HostAnswer>,
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
    const answer = resources.get(host) ?? null
    const found = isNoAnswer(answer) ? answer.last : answer
    const unconfirmed = isNoAnswer(answer) ? 'no_answer' : 確かめ(found)
    // **「この機械では数えない」と「歯止めを外している」を同じ `null` に畳むのは正しい。**
    // どちらも歯止め無しで進む側で、画面のふるまいは同じでよい（**CLI は言い分ける**——
    // あちらは人が読む答えなので、外しているのか読めない機械なのかは別の話）
    const fits = unconfirmed !== null ? 0 : (found?.fits_now ?? null)
    hosts.push({ host, targets: list.length, fits, unconfirmed, resources: found })

    if (fits === null || list.length <= fits) {
      // 数えない、または全部入る。**間引かない**
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
 * **「数えない」（`null`）と混ぜてはいけない。** あちらは歯止め無しで進む側だが、
 * こちらで進むと**ログイン画面へ落ちずに26枚流す**ことになる。
 */
export const SIGNED_OUT = 'signed-out' as const

/**
 * 聞いたのに答えが来なかった（通信の失敗・時間切れ・本文が読めない）。
 *
 * **「数えない」（`null`）と混ぜてはいけない。** `null` は PC が「この機械では数えない」と
 * 答えた確定の答えで、歯止め無しで進む。こちらは**答えそのものが無い**——WSL の確認が
 * 要る PC でも起こるので、歯止め無しへ倒すと、確かめていない数のまま全部送ることになる。
 */
export const NO_ANSWER = 'no-answer' as const

/** [`fetchHostResources`] の答え。 */
export type HostResourcesAnswer =
  | HostResources
  | null
  | typeof SIGNED_OUT
  | typeof NO_ANSWER

/**
 * 「その PC は数えない」という確定の答えの状態コード。**歯止め無しで進む**（いまどおり）。
 *
 * - 501：メモリの空きを読めない機械（Linux 以外。`HostFailure::Unavailable`）
 * - 409：資源を聞く口を持たない古い版の PC（`HostAskError::Unsupported`）
 *
 * **これ以外の失敗はすべて「答えが来なかった」**（[`NO_ANSWER`]）。503・504・404・500・415
 * （ローカルモードで読み取りの処理が落ちたとき）は、どれも WSL の PC でも起こる。
 */
const 数えない状態コード: ReadonlySet<number> = new Set([501, 409])

/**
 * その PC の資源を聞く（`GET /api/hosts/{host}/resources`）。
 *
 * **押した瞬間にだけ聞く。** 常時持っていると古い値で判断することになる。
 *
 * # 失敗を3つに言い分ける
 *
 * - 401 → [`SIGNED_OUT`]。他の取得口（`stores/settings.ts` ／ `stores/versions.ts` ／
 *   `stores/ws.ts`）と同じく `markSignedOut()` を呼ぶ
 * - 501・409 → `null`（この機械では数えない。歯止め無し）
 * - それ以外・投げた・打ち切られた・本文が読めない → [`NO_ANSWER`]
 *
 * **例外にしない。** 複数の PC を同時に聞くので、投げると他の PC の答えまで巻き込む。
 * **返り値で言い分けるほうが読める。**
 */
export async function fetchHostResources(
  host: string,
  signal?: AbortSignal,
): Promise<HostResourcesAnswer> {
  try {
    const response = await fetch(
      `/api/hosts/${encodeURIComponent(host)}/resources`,
      { signal },
    )
    if (response.status === 401) {
      useAuthStore.getState().markSignedOut()
      return SIGNED_OUT
    }
    if (数えない状態コード.has(response.status)) {
      return null
    }
    if (!response.ok) {
      return NO_ANSWER
    }
    return (await response.json()) as HostResources
  } catch {
    return NO_ANSWER
  }
}

/**
 * 時刻の控え。**経過は単調時計（`performance.now()`）で測り、壁時計（`Date.now()`）は
 * 見張りのために併せて持つ**（実装レビュー第3回 Astra 4）。
 *
 * 壁時計だけで測ると、ブラウザの時計が巻き戻ったとき経過が負になり、期限の切れた答えを
 * 新しいと読み、65 秒の締切も伸びる。
 */
export interface Instant {
  readonly mono: number
  readonly wall: number
}

/** いまの時刻。**使うたびにグローバルから読む**——取り置くと偽の時計が効かない */
export function instantNow(): Instant {
  return { mono: performance.now(), wall: Date.now() }
}

/**
 * 答えが `from` から `to` までにどれだけ古くなったか（ミリ秒）。**新しさを測るのはこれだけ。**
 *
 * - **壁時計が巻き戻っていたら `Infinity`**——どれだけ経ったか言えないので、期限は切れた側へ倒す
 * - それ以外は**単調時計と壁時計の長いほう**。単調時計は機械が寝ている間に進まないことがあり、
 *   寝ていた間に古くなった答えを新しいと読まないため
 */
export function elapsedMs(from: Instant, to: Instant): number {
  const wall = to.wall - from.wall
  if (wall < 0) {
    return Number.POSITIVE_INFINITY
  }
  return Math.max(to.mono - from.mono, wall)
}

/**
 * 聞き直しの締切。**単調時計だけで測る**——壁時計が巻き戻っても伸びず、縮みもしない。
 *
 * 巻き戻りで締切まで切ると、聞き直せば確かめられた PC まで諦めることになる。古くなった
 * 答えは [`elapsedMs`] が期限切れとして読むので、聞き直しが続けば新しい答えに替わる。
 *
 * 数（`Date.now()` の値）で持たないのは、単調時計の数と比べ違えないため——型で見分けがつく
 */
export interface Deadline {
  /** 作った時刻（`performance.now()`） */
  readonly since: number
  readonly ms: number
}

/** いまから `ms` ミリ秒の締切 */
export function deadlineIn(ms: number): Deadline {
  return { since: performance.now(), ms }
}

function 締切までの残り(deadline: Deadline, at: Instant): number {
  return deadline.ms - (at.mono - deadline.since)
}

function 締切に達した(deadline: Deadline, at: Instant): boolean {
  return 締切までの残り(deadline, at) <= 0
}

/**
 * 数えた枚数の有効期限（[`Settled.freshUntil`]）。**経過は [`elapsedMs`] で測る**
 * ——巻き戻ったら切れたとみなす
 */
export interface FreshUntil {
  readonly since: Instant
  readonly ms: number
}

/** 有効期限まであと何ミリ秒か。切れていれば 0 以下（壁時計の巻き戻りは `-Infinity`） */
export function remainingMs(freshUntil: FreshUntil, at: Instant): number {
  return freshUntil.ms - elapsedMs(freshUntil.since, at)
}

export function isPast(freshUntil: FreshUntil, at: Instant): boolean {
  return remainingMs(freshUntil, at) <= 0
}

/** 聞き直す間隔（設計§6-3） */
export const RECHECK_INTERVAL_MS = 1_000

/**
 * 聞き直しの上限。**PC 側の判定の確認段階と同じ 65 秒**（`2 × HOST_FREE_TIMEOUT + 5 秒`。
 * 設計§3・§6-3）——正常な取得を、画面のほうが先に諦めないため
 */
export const RECHECK_LIMIT_MS = 65_000

/**
 * 1回の問い合わせの上限。**サーバが PC へ聞くときの時間切れ（5 秒）より長く**取る。
 *
 * これを超えても答えないのは、ブラウザとサーバのあいだで止まっているときである。
 * 上限が締切しか無いと、止まった1台に合わせて周が締切まで延び、**先に答えた PC の値が
 * 1分以上前のものになる**——古い値で何枚戻すかを決めることになる
 */
export const ASK_LIMIT_MS = 10_000

/**
 * 何を待って聞き直しているか（画面の言い方を分けるため）。
 *
 * - `windows`：PC が Windows 側の空きを確かめている（`checking`・`stale`）
 * - `answer`：PC の答えそのものが来ていない。**WSL でない PC でも起こる**ので「Windows 側」と言わない
 */
export type WaitingFor = 'windows' | 'answer'

/** 1周ぶんの答え（入館証切れは周の外で扱う） */
type RoundAnswer = HostResources | null | typeof NO_ANSWER

/** PC 1台ぶんの答えと、それを聞いた時刻 */
interface 受け取り {
  answer: RoundAnswer
  /**
   * その周で聞き始めた時刻。**新しさの残りはここから測る。**
   *
   * PC が残りを数えたのは、聞き始めてから受け取るまでのどこかである。受け取った時刻から
   * 測ると、運ぶのにかかったぶんだけ新しく見積もる——確かめられていない側へ倒すため、早いほうを使う
   */
  askedAt: Instant
}

/** 1周で受け取ったもの。**締切で切られたか**を添える */
interface 周の答え extends 受け取り {
  /**
   * **締切で打ち切ったから答えが無い。** PC が答えなかったのではなく、聞くのを途中でやめた。
   * 503・通信の失敗・1回の上限（[`ASK_LIMIT_MS`]）で切ったものは含めない
   */
  切られた: boolean
}

/**
 * いま読むとどうなる答えか。
 *
 * **答えた時点で `fresh` でも、新しさの残り（`host_free_fresh_for_sec`）を使い切ったら
 * `stale` として読む。** PC がいま聞かれたら返す形に直すので、聞き直すか（[`needsRecheck`]）・
 * 何枚戻すか（[`planRevive`]）・どう見せるかは、`stale` の答えと同じ道を通る。
 *
 * **残りの欄が無い（古い PC）なら、いまの扱いのまま。** 欄そのものが来ないので `== null` で比べる
 *
 * **壁時計が巻き戻ったら、何秒前の値かも言えない**（経過が `Infinity`）。古さの欄は空にする
 * ——足し算した `Infinity` を画面へ渡すと「Infinity 時間前」と出る
 */
function 今の答え(got: 受け取り, now: Instant): RoundAnswer {
  const answer = got.answer
  if (
    answer === null ||
    answer === NO_ANSWER ||
    answer.host_free_state !== 'fresh' ||
    answer.host_free_fresh_for_sec == null
  ) {
    return answer
  }
  const 経過 = elapsedMs(got.askedAt, now)
  if (経過 < answer.host_free_fresh_for_sec * 1_000) {
    return answer
  }
  return {
    ...answer,
    host_free_state: 'stale',
    host_free_age_sec:
      answer.host_free_age_sec == null || !Number.isFinite(経過)
        ? null
        : answer.host_free_age_sec + Math.floor(経過 / 1_000),
    host_free_fresh_for_sec: 0,
  }
}

/**
 * この答えで数えた枚数が、いつまで新しいか（実装レビュー第3回 Astra 3）。
 *
 * **数えるのに使う答えだけが期限を持つ**——`fresh` で、数えていて（`fits_now`）、新しさの残りを
 * 送ってきたもの。WSL でない PC・古い PC（残りの欄が無い）はいまどおり期限を持たない。
 * 確かめられていない PC は 0 枚に数えているので、古くなっても数が増える側へは動かない
 */
function 新しいうち(got: 受け取り, answer: RoundAnswer): FreshUntil | null {
  if (
    answer === null ||
    answer === NO_ANSWER ||
    answer.fits_now == null ||
    answer.host_free_state !== 'fresh' ||
    answer.host_free_fresh_for_sec == null
  ) {
    return null
  }
  return { since: got.askedAt, ms: answer.host_free_fresh_for_sec * 1_000 }
}

/** この答えなら、もう1周聞く */
function 落ち着いていない(answer: RoundAnswer): boolean {
  return answer === NO_ANSWER || needsRecheck(answer)
}

/**
 * 全台へ1回ずつ聞く。**同じ周の問い合わせは同時に始め、同じ打ち切りを共有する。**
 *
 * - 1回の上限は [`ASK_LIMIT_MS`] と締切の近いほう。超えた PC は [`NO_ANSWER`]
 * - **締切のほうで切ったときは、切られた PC に印を付ける**（[`周の答え`]）
 * - **1台が 401 を返したら、残りも打ち切る**——入館証が切れているなら、他の答えを待っても1枚も送らない
 */
async function 一周(
  hosts: readonly string[],
  deadline: Deadline,
  outer: AbortSignal,
): Promise<Map<string, 周の答え> | typeof SIGNED_OUT> {
  const 周 = new AbortController()
  const askedAt = instantNow()
  const 残り = 締切までの残り(deadline, askedAt)
  const 締切で切る = 残り < ASK_LIMIT_MS
  let 締切に達した = false
  const 打ち切る = () => {
    周.abort()
  }
  const timer = setTimeout(
    () => {
      締切に達した = 締切で切る
      周.abort()
    },
    Math.max(0, Math.min(ASK_LIMIT_MS, 残り)),
  )
  outer.addEventListener('abort', 打ち切る)
  if (outer.aborted) {
    周.abort()
  }
  try {
    const answers = await Promise.all(
      hosts.map(async (host) => {
        const answer = await fetchHostResources(host, 周.signal)
        if (answer === SIGNED_OUT) {
          周.abort()
        }
        // **返ってきた時点の印で見る。** 切る前に 503 で返った PC は、切られたのではない
        return [host, answer, answer === NO_ANSWER && 締切に達した] as const
      }),
    )
    const 揃った = new Map<string, 周の答え>()
    for (const [host, answer, 切られた] of answers) {
      if (answer === SIGNED_OUT) {
        return SIGNED_OUT
      }
      揃った.set(host, { answer, askedAt, 切られた })
    }
    return 揃った
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', 打ち切る)
  }
}

/** 次の周まで待つ。**打ち切られたらすぐ起きる** */
function 眠る(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined
    const 起きる = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', 起きる)
      resolve()
    }
    if (signal.aborted) {
      resolve()
      return
    }
    timer = setTimeout(起きる, ms)
    signal.addEventListener('abort', 起きる)
  })
}

/** [`settleHostResources`] の頼み方 */
export interface SettleOptions {
  /** 締切（[`deadlineIn`]）。**押した時点で1回だけ作り**、全周で共有する */
  deadline: Deadline
  /** 閉じた・やめた・画面を離れたら打ち切る。**進行中の問い合わせも切る** */
  signal: AbortSignal
  /** 前に聞けた答え（確かめ直しのとき）。**表示にだけ使い、数えない** */
  previous?: ReadonlyMap<string, HostResources | null>
  /** 聞き直しに入るたびに呼ぶ。何を待っているかを渡す */
  onWaiting?: (waitingFor: WaitingFor) => void
}

/**
 * 全台の資源を、**1つの周の中で全台が落ち着くまで聞き直す**（設計§6-3）。
 *
 * **確かめられていない数で「何枚戻すか」を決めない。** `checking`・`stale` の答えは
 * `MemFree` の床や前回の値で数えた参考で、そのまま計画へ渡すと、床が「全部入る」と
 * 言った PC へ黙って全部送ることになる。
 *
 * # 毎周、全台へ聞き直す
 *
 * 遅い PC を待つ間に、**先に答えた PC の `fresh` が古くなる**。落ち着いていない PC だけを
 * 聞き直すと、揃ったときには先に答えた PC の値が数十秒前のものになっている。PC 側は
 * 期限内なら即答するので、全台へ聞き直しても負荷はほぼ無い。
 *
 * **同じ周の中でも古くなる。** 先に答えた PC の `fresh` が、遅い PC を待つ間に期限を
 * 越えることがある。周の終わりと返す瞬間に、新しさの残りを使い切った `fresh` を `stale`
 * として読み直す（[`今の答え`]）——落ち着いていない側へ戻るので、締切まで聞き直し、
 * 間に合わなければ確かめられていない PC になる。
 *
 * - 落ち着いた＝新しい値・`failed`・状態の欄が無い・「数えない」。`checking`・`stale`・
 *   答えが来なかった PC が1台でも居れば、1秒おいて**全台**をもう1周聞く
 * - 締切に達したら、**PC ごとの最後の答え**を返す。[`planRevive`] が落ち着いていない PC を
 *   「確かめられていない」として 0 枚に数える
 * - **締切で切った周では、切られた PC だけ前の周の答えを使う。** 締切の直前に始めた周は
 *   途中で切られるが、それは PC が答えなかったのではない——「答えが来なかった」と読むと、
 *   直前まで確かめられていた PC まで 0 枚に化け、見出しも原因を取り違える。前の周の答えは
 *   聞いた時刻を持ったまま運ぶので、`fresh` でも期限を越えていれば `stale` として読む。
 *   **残り時間が短い周を始めないことでは避けない**——残りより遅い PC はそれでも切られる
 * - **答えが来なかった PC は、それより前の周や前回の答えを持ち回しても数えない**（[`NoAnswer`]）。
 *   1回の上限で切った PC・503・通信の失敗はここに入る。前回の答えは表示にだけ使う
 * - 1台でも 401 なら [`SIGNED_OUT`]（1枚も送らない側）
 * - 打ち切られたら `'cancelled'`。**遅れた答えで送らないため**
 * - **数えた枚数の有効期限を添えて返す**（[`Settled`]）
 */
export async function settleHostResources(
  hosts: readonly string[],
  { deadline, signal, previous, onWaiting }: SettleOptions,
): Promise<Settled | typeof SIGNED_OUT | 'cancelled'> {
  const 前に聞けた = new Map<string, HostResources>()
  for (const [host, found] of previous ?? []) {
    if (found !== null) {
      前に聞けた.set(host, found)
    }
  }
  let 最後の周 = new Map<string, 受け取り>()
  for (;;) {
    const 周 = await 一周(hosts, deadline, signal)
    if (signal.aborted) {
      return 'cancelled'
    }
    if (周 === SIGNED_OUT) {
      return SIGNED_OUT
    }
    const 前の周 = 最後の周
    最後の周 = new Map()
    for (const [host, got] of 周) {
      const 前 = 前の周.get(host)
      最後の周.set(host, got.切られた && 前 !== undefined ? 前 : got)
      if (got.answer !== null && got.answer !== NO_ANSWER) {
        前に聞けた.set(host, got.answer)
      }
    }
    const いま = instantNow()
    const 待つ = [...最後の周.values()]
      .map((got) => 今の答え(got, いま))
      .filter(落ち着いていない)
    if (待つ.length === 0 || 締切に達した(deadline, いま)) {
      break
    }
    onWaiting?.(待つ.every((answer) => answer === NO_ANSWER) ? 'answer' : 'windows')
    await 眠る(RECHECK_INTERVAL_MS, signal)
    if (signal.aborted) {
      return 'cancelled'
    }
    // **眠った後にも締切を見る。** 残り0ミリ秒で次の周を始めても、何も聞けずに切られるだけ
    if (締切に達した(deadline, instantNow())) {
      break
    }
  }
  // **返す瞬間の時刻で読み直す。** 眠った後に締切で抜けたときは、最後の周から1秒以上経っている
  const 返す時刻 = instantNow()
  const answers = new Map<string, HostAnswer>()
  let freshUntil: FreshUntil | null = null
  for (const host of hosts) {
    const got = 最後の周.get(host)
    // **`??` で既定を当てない。** `null`（数えない）まで答え無しに化ける
    const answer = got === undefined ? NO_ANSWER : 今の答え(got, 返す時刻)
    answers.set(
      host,
      answer === NO_ANSWER ? noAnswer(前に聞けた.get(host) ?? null) : answer,
    )
    // **有効期限も同じ時刻で決める。** 読み直しで `stale` へ移った答えは期限を持たない
    const 期限 = got === undefined ? null : 新しいうち(got, answer)
    if (
      期限 !== null &&
      (freshUntil === null ||
        remainingMs(期限, 返す時刻) < remainingMs(freshUntil, 返す時刻))
    ) {
      freshUntil = 期限
    }
  }
  return { answers, freshUntil }
}

/** [`settleHostResources`] の答え */
export interface Settled {
  answers: Map<string, HostAnswer>
  /**
   * この答えで数えた枚数が、**いつまで新しいか**（実装レビュー第3回 Astra 3）。PC ごとの
   * 「最後の周で聞き始めた時刻＋新しさの残り」のうち、最も早く切れるもの。
   *
   * ダイアログを開けたまま考えている間に過ぎることがある。**過ぎてから枚数に基づく操作を
   * 押したら、送る前に確かめ直す**——古い数で何枚戻すかを決めない。
   *
   * **`null` は期限を持つ答えが無い**（WSL でない・古い PC・確かめられていない PC だけ）
   */
  freshUntil: FreshUntil | null
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
