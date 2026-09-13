/**
 * 全体メモの画像を、サーバの記録へ置く（メモ設計§10-1 の【決着】）。
 *
 * # なぜ PC を通らないのか
 *
 * **全体メモはアカウントに属する。** 本文が既にサーバの記録に在るのに画像だけ
 * PC のディスクに在ると、**別の端末から開いたときに画像だけ欠ける**——要件10 の
 * 「別の端末から開いても、同じ吹き出しが同じ順で出る」に反する。
 *
 * **セッションメモの画像はこちらへ来ない。** あちらは**その PC の作業に属する**ので、
 * 既存の添付（`hostfs.uploadAttachment`）へ相乗りしたままである。
 */

import { HostFsError } from '@/lib/hostfs'

/** 置いた1枚の在り処。**サーバの `memo_blobs::Written` と同じ形。** */
export interface WrittenMemoBlob {
  /** **本文の Markdown へそのまま入る URL。** */
  url: string
  media_type: string
  bytes: number
}

/**
 * 1枚置いて、**本文へ入れる URL** を返す。
 *
 * # 断り方は既存の添付と同じ
 *
 * 415（種別が違う）と 413（大きすぎ）をサーバが言い分けているので、**本文をそのまま
 * 持ち上げる**。ここでまとめて「置けません」にすると、利用者が直せるもの（別の形式で
 * 撮り直す）まで直せなくなる。
 */
export async function uploadMemoBlob(bytes: Blob): Promise<string> {
  let response: Response
  try {
    response = await fetch('/api/memo-blobs', {
      method: 'POST',
      // **媒体型はヘッダで言う。** サーバは中身から推測しない
      headers: { 'Content-Type': bytes.type },
      body: bytes,
    })
  } catch (err) {
    // **応答が1つも返らなかった。** `fetch` は理由を持たない `TypeError` しか投げない
    throw new HostFsError(
      0,
      `画像をサーバへ送れませんでした（${err instanceof Error ? err.message : '理由は返りませんでした'}）`,
    )
  }
  if (!response.ok) {
    throw new HostFsError(
      response.status,
      await response.text().catch(() => '画像を置けませんでした'),
    )
  }
  const written = (await response.json()) as WrittenMemoBlob
  return written.url
}
