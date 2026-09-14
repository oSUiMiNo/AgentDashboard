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

/**
 * 貼った直後の幅を、**入る場所の何割にするか**（利用者の要望・2026-09-14
 * 「画像を張ると一旦横幅いっぱいのサイズで貼られるが、初期は横幅の4割サイズで
 * 貼ってほしい。大きくしたい場合はユーザーがサイズ調整するので」）。
 */
export const 貼るときの割合 = 0.4

/**
 * 掴み手が許す下限（`@blocknote/core` の実測。`Math.max(r, 64)`）。
 *
 * **貼った幅は、人が掴んで作れる幅の中に収める。** 狭い窓で4割を素直に取ると
 * ここを下回るので、**掴んでも二度と作れない幅**が最初から入ることになる。
 */
const 下限 = 64

/**
 * 貼った直後に入れる幅（px）。決められなければ `undefined`。
 *
 * # なぜ入れるのか——**入れないと必ず横幅いっぱいになる**
 *
 * ブロックエディタの `previewWidth` は**既定が `undefined`** で、そのとき絵の器は
 * `width: fit-content` になる（`@blocknote/core` の実測）。器には `max-width: 100%`、
 * 中の `<img>` には `width: 100%` が当たっているので、**原寸が入る幅より広い絵は
 * 必ず 100% まで伸びる**——スクリーンショットは例外なくこれに当たる。
 *
 * つまり「横幅いっぱい」は既定の幅が広いのではなく、**幅が決まっていないこと**の
 * 結果である。だから**貼る時点で数字を入れる**のが直し方になる。
 *
 * # 原寸より大きくしない
 *
 * **小さい絵を引き伸ばさない。** 4割をそのまま入れると、入る幅が 800px のときに
 * 100px のアイコンが 320px へ膨らむ——器の幅がそのまま `<img>` の幅になるためで、
 * **いま正しく出ているものが、この変更で初めて壊れる**。
 *
 * 「横幅いっぱいで貼られる」と言われているのは**原寸が入る幅より広い絵**の話なので、
 * 原寸で頭打ちにしても要望は満たせる。**直す対象だけが動き、それ以外は動かない。**
 *
 * # 測れなければ何も入れない
 *
 * 幅か原寸のどちらかが測れなければ、**いままでどおり**（`previewWidth` を入れない）に
 * 倒す。ここで4割だけを入れると、**原寸を測れなかった小さい絵が引き伸ばされる**——
 * 要望が通らないだけの状態より、**無かった壊れ方が増えるほうが悪い。**
 */
export function 貼るときの幅(
  入る幅: number | undefined,
  原寸: number | undefined,
): number | undefined {
  if (入る幅 === undefined || !Number.isFinite(入る幅) || 入る幅 <= 0) {
    return undefined
  }
  if (原寸 === undefined || !Number.isFinite(原寸) || 原寸 <= 0) {
    return undefined
  }
  return Math.min(Math.max(Math.round(入る幅 * 貼るときの割合), 下限), Math.round(原寸))
}

/**
 * 絵の原寸（横）を測る。測れなければ `undefined`。
 *
 * **運び終えてから測る。** 先に測ると、運ぶ前に中身をもう一度読むことになる——
 * `attachments.ts` が書いているとおり、`File` は**その場で読める保証が無い**ので、
 * 読む回数は増やさないほうがよい。ここで測れなくても運びは済んでいる。
 *
 * **投げない。** 原寸が測れないことは「幅を決められない」だけで、貼れないことでは
 * ない。ここで投げると、**運び終えた絵が貼れずに消える。**
 */
export async function 原寸を測る(blob: Blob): Promise<number | undefined> {
  // **無い環境がある**（jsdom・古い WebView）。呼ぶ前に確かめる
  if (typeof createImageBitmap !== 'function') {
    return undefined
  }
  let 絵: ImageBitmap
  try {
    絵 = await createImageBitmap(blob)
  } catch {
    return undefined
  }
  try {
    return 絵.width > 0 ? 絵.width : undefined
  } finally {
    // **作ったら捨てる**（この模組の `画像を運ぶ` と同じ約束）
    絵.close?.()
  }
}

/**
 * 貼った直後に、画像のブロックへ渡すもの。
 *
 * # なぜ文字列と物体の2つを返すのか
 *
 * エディタの `uploadFile` は**返り値が文字列なら URL として、物体ならブロックの
 * 差分として**扱う（`@blocknote/core` の型どおり：`Promise<string | Record<string, any>>`）。
 * 落とす・貼り付ける・選ぶの3経路がどれもこの1箇所を通るので、**ここへ幅を載せれば
 * 3経路とも直る。**
 *
 * **`name` を自分で載せるのは、物体を返すと経路によって落ちるからである。**
 * 文字列を返したときだけ、選ぶ経路（ファイルの面）はエディタ側で
 * `{ props: { name, url } }` を組み立てている——物体を返すとその組み立てを通らないので、
 * **載せ忘れると絵の名前（`alt`）だけが経路によって消える。**
 *
 * 幅が決まらなければ**文字列のまま返す**。いままでと1バイトも変わらない道になる。
 */
export async function 貼るときのブロック(
  file: File,
  url: string,
  入る幅: number | undefined,
): Promise<string | { props: { name: string; url: string; previewWidth: number } }> {
  const 幅 = 貼るときの幅(入る幅, await 原寸を測る(file))
  if (幅 === undefined) {
    return url
  }
  return { props: { name: file.name, url, previewWidth: 幅 } }
}
