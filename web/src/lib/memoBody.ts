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
  const blocks = Array.isArray(record.blocks) ? record.blocks : []
  const markdown = typeof record.markdown === 'string' ? record.markdown : ''
  return { blocks, markdown }
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
