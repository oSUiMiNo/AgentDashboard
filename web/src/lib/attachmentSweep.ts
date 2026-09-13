/**
 * 添付の掃除を、同意を取ってから走らせる（メモ設計§10-2）。
 *
 * # なぜ下見と本番が同じ口なのか
 *
 * 要件10 は「1GB を超えたら**利用者に同意のダイアログを出してから**消す」と定めて
 * いる。**同意の画面に出した数のとおりに消えること**が同意の意味そのものなので、
 * 口を分けると片方だけ直せてしまう。`apply` の真偽1つで分ける。
 *
 * # 既存の掃除は1バイトも変わっていない
 *
 * PC が起きたときの掃除（`sweep_on_start`）は **toml の値のまま**で、この口を通らない。
 * ここが読むのは**アカウントの設定**（`memo_max_bytes`）である——設計§11-2 が
 * 「1項目だけ toml だと、セルフホスト構成で画面から触れない」を理由に記録へ寄せた。
 */

import { HostFsError } from '@/lib/hostfs'

/** 掃除の下見／結果。**サーバの `protocol::AttachmentSweep` と同じ形。** */
export interface AttachmentSweep {
  /** いま置いてある合計（バイト） */
  total: number
  /** **期間で消える／消えたぶん。** ここに同意は要らない（既存の振る舞い） */
  expiring: number
  expiring_bytes: number
  /** 期間のぶんを除いても上限を超えているか。**偽なら同意を求めない。** */
  over_budget: boolean
  /** **同意が要る件数**（下見）／**実際に消した件数**（本番） */
  removed: number
  freed: number
  /** 本番だったか。**偽なら1バイトも消えていない。** */
  applied: boolean
}

/**
 * 掃除の下見／本番。
 *
 * **既定は下見。** 消すほうを既定にすると、確かめるつもりで呼んだ関数が消してしまう。
 */
export async function sweepAttachments(
  host: string,
  apply = false,
): Promise<AttachmentSweep> {
  const response = await fetch(
    `/api/hosts/${encodeURIComponent(host)}/attachments/sweep?apply=${apply}`,
    { method: 'POST' },
  )
  if (!response.ok) {
    throw new HostFsError(
      response.status,
      await response.text().catch(() => '添付を掃けませんでした'),
    )
  }
  return (await response.json()) as AttachmentSweep
}

/** 人が読める大きさ。**同意の画面に出す。** */
export function 大きさの字(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  }
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / 1024 / 1024)} MB`
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
