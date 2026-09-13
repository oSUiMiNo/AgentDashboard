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

import { pickImages, releasePreview } from '@/lib/attachments'
import { rawUrl, uploadAttachment } from '@/lib/hostfs'
import { uploadMemoBlob } from '@/lib/memoBlobs'

/**
 * 画像の置き場所。**宛先によって2つある**（メモ設計§10-1 の【決着】）。
 *
 * # なぜ2つなのか——**帰属と保管を揃える**
 *
 * | 宛先 | 帰属 | 置き場所 |
 * |---|---|---|
 * | セッションメモ | **その PC の作業** | PC のディスク（既存の添付へ相乗り） |
 * | 全体メモ | **アカウント** | サーバの記録 |
 *
 * **本文が既にサーバの記録に在るのに画像だけ PC に在ると、別の端末から開いたときに
 * 画像だけ欠ける**——要件10 の「別の端末から開いても、同じ吹き出しが同じ順で出る」
 * に反する。
 *
 * **要件9（同じ部品・同じ口）は保たれている。** 割れるのは保管先だけで、
 * 貼る道（`pickImages` → 運ぶ → URL を返す）は1本のままである。
 */
export type 画像の置き場所 =
  /** セッションメモ。**どの PC のどのカードか**が要る */
  | { where: 'card'; host: string; cardId: string }
  /** 全体メモ。**PC を指名しない**（アカウントに属するので） */
  | { where: 'account' }

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
  // **ふるいは宛先によらず1つ。** ここで分けると、片方だけ svg が通る
  const { accepted, rejected } = await pickImages([file])
  const one = accepted[0]
  if (one === undefined) {
    // **理由をそのまま投げる。** エディタが画面へ出す
    throw new Error(rejected[0] ?? '画像を添付できません')
  }
  /*
    **作ったら捨てる**（レビュー対応4）。

    `pickImages` は**通した1枚ごとに `URL.createObjectURL` を1本作る**（`attachments.ts`）。
    ここは `bytes` しか使わないので、**捨てなければ貼るたびに1本ずつ溜まり、タブの
    寿命いっぱい残る**——最大 8 MiB の写しである。

    **`Composer` は5箇所で解放しているが、こちらは1箇所でよい。** あちらは小窓に絵を
    出すので、付け外し・送信のたびに要る。**倣うのは約束（作ったら捨てる）であって、
    箇所数ではない。**

    **成功しても失敗しても捨てる**ので `finally` に置く——運ぶ道は2つあり、どちらも
    投げうる。
  */
  try {
    if (置き場所.where === 'account') {
      // 全体メモ。**PC を通らない**——記録へ直に置く
      return await uploadMemoBlob(one.bytes)
    }
    const written = await uploadAttachment(置き場所.host, 置き場所.cardId, one.bytes)
    return rawUrl(置き場所.host, written.path)
  } finally {
    releasePreview(one)
  }
}
