/**
 * 仮想ディスクの縮小を、画面から読む・押す（縮小設計§10）。
 *
 * # なぜ `reviveBudget.ts` に相乗りしないのか
 *
 * あちらは「全て復旧」を押す前にメモリが足りるかを数える口で、**主題が違う**。
 * `HostResources` は復旧の予算の型なので、そこへ縮小の欄を生やすと
 * `cli_surface.rs` の `資源の欄はブラウザ側の型にも全部ある` が縮小の綴りまで
 * 要求するようになる——**縮小と無関係な型が、縮小の都合で動く。**
 *
 * # 401 を `null` へ畳まない
 *
 * cookie が切れているときに「聞けなかった」と混ぜると、**ログイン画面へ落ちずに
 * 進む**。他の取得口（`stores/settings.ts` ／ `stores/versions.ts` ／
 * `reviveBudget.ts`）が `markSignedOut()` を呼ぶ約束なので、ここも揃える。
 *
 * # 例外を投げない
 *
 * 押した流れの他の分岐まで巻き込むので、**返り値で言い分ける。**
 */

import { useAuthStore } from '@/stores/auth'

/** Rust 側の `CompactView`（`core/src/compact_api.rs`）と同じ綴り。 */
export interface CompactView {
  alive_cards: number
  claude_procs: number
  interactive_shells: number
  in_window: boolean
  /** 空洞（`null` なら読めない＝WSL でない機械か、パスが未設定）。 */
  slack_bytes: number | null
  /** 2枚の仮想ディスクの合計（`null` なら読めない）。 */
  vhdx_bytes: number | null
  /** 最後に縮めた時刻（epoch ミリ秒。`null` なら一度も縮めていない）。 */
  last_compact: number | null
  auto_enabled: boolean
  /** 自動で打てない理由（`null` なら打てる）。 */
  auto_blocker: string | null
  /** 手で打てない理由（`null` なら打てる）。 */
  manual_blocker: string | null
}

/** ログインが切れていた。**「聞けなかった」と区別する。** */
export const SIGNED_OUT = 'signed-out' as const

export type CompactAnswer = CompactView | null | typeof SIGNED_OUT

/**
 * 撃った結果。
 *
 * **`unknown` が要る。** 縮小は自分を殺す操作なので、撃った直後にサーバが死ぬ。
 * 線が切れたことは**「撃てなかった」ではない**——むしろ撃てた証拠でありうる。
 * 区別できないものを「失敗」と断定して出すと嘘になる（縮小設計§10-2）。
 */
export type RunOutcome =
  | { kind: 'fired'; view: CompactView }
  | { kind: 'refused'; reason: string }
  | { kind: 'unknown' }

/** いまの様子を聞く。 */
export async function fetchCompactView(host: string): Promise<CompactAnswer> {
  try {
    const response = await fetch(
      `/api/hosts/${encodeURIComponent(host)}/compact`,
    )
    if (response.status === 401) {
      useAuthStore.getState().markSignedOut()
      return SIGNED_OUT
    }
    if (!response.ok) {
      return null
    }
    return (await response.json()) as CompactView
  } catch {
    return null
  }
}

/**
 * 縮小を撃つ。
 *
 * **断られた（409）ことと、線が切れたことを分ける。** 前者はサーバが生きていて
 * 理由を返した状態で、後者は**撃てて機械が落ちた可能性がある**状態である。
 */
export async function runCompact(
  host: string,
  force: boolean,
): Promise<RunOutcome> {
  try {
    const response = await fetch(
      `/api/hosts/${encodeURIComponent(host)}/compact`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force }),
      },
    )
    if (response.status === 401) {
      useAuthStore.getState().markSignedOut()
      return { kind: 'unknown' }
    }
    if (response.status === 409) {
      return { kind: 'refused', reason: await response.text() }
    }
    if (!response.ok) {
      return { kind: 'refused', reason: await response.text() }
    }
    return { kind: 'fired', view: (await response.json()) as CompactView }
  } catch {
    // **ここが「分からない」。** 撃った直後に機械が落ちると線が切れるので、
    // 例外は失敗の証拠にならない
    return { kind: 'unknown' }
  }
}

/** バイトを GiB の文字列へ。**`reviveBudget.ts` の `gb` は MB を受けるので別物。** */
export function gib(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
