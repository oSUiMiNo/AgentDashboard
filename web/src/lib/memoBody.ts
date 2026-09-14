/**
 * メモ1件の中身（メモ設計§6-1）。
 *
 * # なぜ2つ持つのか
 *
 * ブロックエディタが編集するのは**ブロックの配列**だが、**読むだけの吹き出しに
 * エディタを1つずつ載せると重い**——溜まったメモの数だけ ProseMirror が立つ。
 *
 * そこで**確定した瞬間に Markdown も作って一緒に置く**。
 *
 * | 何を | 何に使うか |
 * |---|---|
 * | `blocks` | **編集**（鉛筆を押したときにエディタへ戻す） |
 * | `markdown` | **表示**（この PJT が既に持っている `react-markdown` の道を通す） |
 *
 * **derive したものを持つので、食い違う余地がある。** ただし**両方を書くのは確定の
 * 1箇所だけ**で、片方だけ書き換える道を作っていない——だから食い違わない。
 * 逆に言えば、**書き込む場所を増やしたらこの前提が崩れる。**
 *
 * # 記録から見ると中身は不透明である
 *
 * サーバは `body` を JSON のまま持ち、中身を読まない（メモ設計§3-2）。したがって
 * **形が違うものが返ってくる余地が型の上では常にある**——古い版が書いたもの、
 * 手で書き換えられたもの。**`unknown` から読むところが「誰も捕まえない」場所**なので、
 * [`readMemoBody`] は**何が来ても倒れない**形にしてある。
 */

/** 確定したメモの中身。 */
export interface MemoBody {
  /** ブロックエディタの中身そのまま。**編集のときだけ使う。** */
  blocks: unknown[]
  /** 表示用。**確定のたびに作り直す。** */
  markdown: string
}

/**
 * 記録から来た `unknown` を読む。**壊れていても倒れない。**
 *
 * 読めなければ**空として扱う**——ここで例外を投げると、1件壊れているだけで
 * 面ごと出なくなる。**1件が読めないことより、全部が消えることのほうが悪い。**
 */
export function readMemoBody(body: unknown): MemoBody {
  if (typeof body !== 'object' || body === null) {
    return { blocks: [], markdown: '' }
  }
  const record = body as Record<string, unknown>
  const blocks = Array.isArray(record.blocks) ? record.blocks.filter(ブロックらしいか) : []
  const markdown = typeof record.markdown === 'string' ? record.markdown : ''
  return { blocks, markdown }
}

/**
 * 1件がブロックの形をしているか（レビュー対応8）。
 *
 * # 最上位だけ見ても足りなかった
 *
 * 以前は `Array.isArray` しか見ておらず、**要素が不正でも配列でありさえすれば通した**。
 * その配列はエディタへ**そのまま渡る**ので、**描画の最中に投げる**——この web には
 * エラー境界が1つも無いので、**面が丸ごと消える**。
 *
 * **`readMemoBody` が防ごうとした壊れ方が、鉛筆を押した経路から戻ってくる形**だった。
 *
 * # 倒れない形は保つ
 *
 * **1件を捨てて残りを出す。** 投げない——「1件が読めないことより、全部が消えること
 * のほうが悪い」という、この関数の約束は変えない。
 *
 * # なぜ `type` だけ見るのか
 *
 * ブロックの中身は版によって変わりうるが、**`type` を持つことはエディタが前提に
 * している**。ここを厳しくしすぎると、**新しい版が書いたブロックを古い版が捨てる**
 * ——直せるはずのものが直せなくなる。
 */
function ブロックらしいか(one: unknown): boolean {
  return typeof one === 'object' && one !== null && typeof (one as { type?: unknown }).type === 'string'
}

/**
 * 中身が同じかどうか。
 *
 * **時刻を動かすかどうかの判定はサーバがする**（メモ設計§7-3）——ブラウザで比べると、
 * 別の端末が先に書き換えていた場合に「変わっていない」と誤判定する。
 *
 * こちらが使うのは**送るかどうか**の判定だけである。中身が同じなら送らなくてよい
 * （送っても結果は同じだが、線を1往復無駄にする）。
 */
export function sameMemoBody(a: MemoBody, b: MemoBody): boolean {
  return a.markdown === b.markdown && JSON.stringify(a.blocks) === JSON.stringify(b.blocks)
}

/**
 * 確定した本文の中から、**画像の幅**を引く（利用者の報告・2026-09-14
 * 「編集画面で画像幅を変えても、確定済みのビューを見ると常に横幅いっぱいに
 * 表示されている」）。
 *
 * # なぜ表示側で引くのか
 *
 * **幅は落ちていない。落としているのは Markdown への変換である。**
 * ブロックエディタは `props.previewWidth` に幅を持っている（実測した記録に
 * `197` `246` `185` `163` が入っていた）が、確定のときに通す
 * `blocksToMarkdownLossy` は——**名前のとおり**——`![alt](url)` しか書けない。
 * Markdown の画像記法に幅の置き場が無いからである。
 *
 * そして描く側は幅を知らないまま `<img>` を出すので、**元の大きさのまま**
 * 面に載る。スクリーンショットは面より大きいので、`max-width: 100%` に当たって
 * **必ず横幅いっぱいになる**——「常に」と見えていたのはこれである。
 *
 * # 記録を書き換える道は採らなかった
 *
 * Markdown の側へ幅を埋め込む手もあるが、**それでは既に書かれたメモが直らない**
 * ——書き直すまで幅が戻らない。[`MemoBody`] は `blocks` も一緒に持っている
 * （この模組の冒頭に理由がある）ので、**表示のたびにそちらから引けば、
 * 昔のメモもその場で直る。**
 *
 * # 鍵は URL
 *
 * 画像1枚ごとに別の置き場所（`/api/memo-blobs/<UUID>`）が振られるので、
 * **同じ URL が2枚を指すことはない。** 同じ絵を2回貼っても、運ばれた先は別になる。
 *
 * **読めないものは黙って飛ばす。** ここも「1件が読めないことより、全部が消える
 * ことのほうが悪い」——幅が引けなければ、幅が無かったときと同じに描けばよい。
 */
export function 画像の幅(blocks: unknown[]): Map<string, number> {
  const 表 = new Map<string, number>()
  集める(blocks, 表)
  return 表
}

/**
 * **入れ子も見る。** 画像は箇条書きの項目の下など、`children` の側にも置ける。
 * 最上位だけ見ると、そこに置いた1枚だけ幅が戻らない——**直った絵と直らない絵が
 * 混ざるほうが、全部直らないより分かりにくい。**
 */
function 集める(blocks: unknown[], 表: Map<string, number>): void {
  for (const one of blocks) {
    if (typeof one !== 'object' || one === null) {
      continue
    }
    const ブロック = one as { type?: unknown; props?: unknown; children?: unknown }
    if (Array.isArray(ブロック.children)) {
      集める(ブロック.children, 表)
    }
    if (ブロック.type !== 'image') {
      continue
    }
    const props = ブロック.props
    if (typeof props !== 'object' || props === null) {
      continue
    }
    const { url, previewWidth } = props as { url?: unknown; previewWidth?: unknown }
    // **幅を変えていない画像には `previewWidth` が入っていない**（実測）。
    // そのときは元のまま描く＝いままでどおりで正しい
    if (typeof url !== 'string' || url === '') {
      continue
    }
    if (typeof previewWidth !== 'number' || !Number.isFinite(previewWidth) || previewWidth <= 0) {
      continue
    }
    表.set(url, previewWidth)
  }
}
