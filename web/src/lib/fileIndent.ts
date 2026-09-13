/**
 * エディタの字下げ（`ファイルビュアにエディタ機能を追加` 設計§6-6）。
 *
 * # ここは決める側。DOM を1行も読まない
 *
 * 字下げは「どの範囲の行頭をどう変え、選択をどこへ置き直すか」という**文字列の話**で
 * ある。`textarea` から読むのは呼ぶ側の仕事で、ここは受け取った文字列と位置だけを見る。
 * 混ぜると jsdom で確かめられなくなり、**何も確かめないまま緑になる**（この PJT が
 * 並べ替え・効果線・タブで繰り返し採っている形）。
 *
 * # 中身から推定しない
 *
 * 字下げ1つぶんは**呼ぶ側が決めて渡す**（既定は空白2つ）。ファイルの中身を見て
 * 「たぶんタブだろう」と推定すると、**外したときに1つのファイルへタブと空白が混ざる**
 * ——そちらのほうが害が大きく、しかも気づきにくい。
 */

/** 字下げの結果。**選択の位置も返す**——返さないと、押すたびに選択が飛ぶ。 */
export interface 字下げの結果 {
  text: string
  start: number
  end: number
}

/** `位置` が乗っている行の、行頭の位置。 */
function 行頭(text: string, 位置: number): number {
  return text.lastIndexOf('\n', Math.max(0, 位置 - 1)) + 1
}

/**
 * 選択に掛かっている行の、行頭の位置を並べる。
 *
 * **終端がちょうど行頭にあるとき、その行は含めない。** 含めると、行を選んだつもりが
 * 次の行まで動く——**選択の見た目と、変わる範囲がずれる。**
 */
function 掛かっている行頭(text: string, start: number, end: number): number[] {
  const 最後 = end > start ? Math.max(start, end - 1) : start
  const 頭たち: number[] = []
  let 位置 = 行頭(text, start)
  for (;;) {
    頭たち.push(位置)
    const 次の改行 = text.indexOf('\n', 位置)
    if (次の改行 === -1 || 次の改行 >= 最後) {
      break
    }
    位置 = 次の改行 + 1
  }
  return 頭たち
}

/**
 * 字下げを足す。
 *
 * - **選択が無ければ**、カーソル位置へ1つぶん差し込み、カーソルをその後ろへ置く
 * - **選択があれば**、掛かっている全行の行頭へ足し、**選択範囲を保つ**
 */
export function 字下げする(
  text: string,
  start: number,
  end: number,
  インデント: string,
): 字下げの結果 {
  if (start === end) {
    return {
      text: text.slice(0, start) + インデント + text.slice(start),
      start: start + インデント.length,
      end: start + インデント.length,
    }
  }
  const 頭たち = 掛かっている行頭(text, start, end)
  let 次 = text
  // **後ろから足す。** 前から足すと、足したぶんだけ後ろの行頭がずれる
  for (const 頭 of [...頭たち].reverse()) {
    次 = 次.slice(0, 頭) + インデント + 次.slice(頭)
  }
  return {
    text: 次,
    start: start + インデント.length,
    end: end + インデント.length * 頭たち.length,
  }
}

/**
 * 字下げを1つぶん落とす（`Shift+Tab`）。
 *
 * **在れば落とす。無い行は変えない**——揃っていない塊を選んだときに、
 * 一部の行だけ左へ寄って**かえって崩れる**のを避ける。
 */
export function 字下げを戻す(
  text: string,
  start: number,
  end: number,
  インデント: string,
): 字下げの結果 {
  const 頭たち = 掛かっている行頭(text, start, end)
  let 次 = text
  let 先頭から減った = 0
  let 全部で減った = 0
  for (const 頭 of [...頭たち].reverse()) {
    const 行 = 次.slice(頭, 頭 + インデント.length)
    if (行 !== インデント) {
      continue
    }
    次 = 次.slice(0, 頭) + 次.slice(頭 + インデント.length)
    全部で減った += インデント.length
    if (頭 <= start) {
      先頭から減った = インデント.length
    }
  }
  const 新しい始め = Math.max(頭たち[0], start - 先頭から減った)
  return {
    text: 次,
    start: 新しい始め,
    end: Math.max(新しい始め, end - 全部で減った),
  }
}
