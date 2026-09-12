/**
 * メモへ貼る画像を、PC のディスクへ運ぶ（メモ設計§10-1）。
 *
 * # なぜ面から切り出すのか
 *
 * **決める側（どこへ置くか・何を断るか）と、測る側（DOM）を分ける。** 面の中に
 * 置くと、**エディタを立てないと確かめられない**——jsdom で ProseMirror を立てても
 * 画像を貼る操作は再現できないので、**貼る道が1本も守られないまま緑になる**。
 *
 * # ふるいは入力欄と同じ1つを通す
 *
 * `pickImages` を通す（設計§10-1）。ここで別に判定すると、**片方だけ svg が通る**
 * ような食い違いが生まれる——受ける種別は png・jpeg・gif・webp で、
 * **svg は意図的に除外**されている（claude 側の貼り付け処理が拾わないため）。
 *
 * # 断りはそのまま持ち上げる
 *
 * `pickImages` が「何が駄目だったか」の文を作っているので、ここで「置けません」に
 * 潰さない。**撮り直せば済むものまで直せなくなる。**
 */

import { pickImages } from '@/lib/attachments'
import { rawUrl, uploadAttachment } from '@/lib/hostfs'

/**
 * 画像の置き場所。
 *
 * **宛先（`AnnotationTarget`）からは引けない。** 添付は PC のディスクへ置くので
 * **どの PC か**が要るが、宛先が持っているのは `claude_session_id` だけである。
 * カードIDも同じ理由で呼ぶ側から渡す。
 */
export interface 画像の置き場所 {
  host: string
  cardId: string
}

/**
 * 1枚運んで、**本文へ入れる URL** を返す。
 *
 * **返すのはディスクのパスではない。** パスを本文へ入れると、別の機械から開いた
 * ときに読めない絵になる。`rawUrl` は `/api/hosts/…/file?path=…` の形なので、
 * **どの端末から開いても同じ絵が出る**。
 */
export async function 画像を運ぶ(
  置き場所: 画像の置き場所,
  file: File,
): Promise<string> {
  const { accepted, rejected } = await pickImages([file])
  const one = accepted[0]
  if (one === undefined) {
    // **理由をそのまま投げる。** エディタが画面へ出す
    throw new Error(rejected[0] ?? '画像を添付できません')
  }
  const written = await uploadAttachment(置き場所.host, 置き場所.cardId, one.bytes)
  return rawUrl(置き場所.host, written.path)
}
