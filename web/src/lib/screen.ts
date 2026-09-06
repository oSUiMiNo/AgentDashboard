/**
 * 端末の画面を読む（設計§5・§7）。
 *
 * Enter を「改行」と「確定」で振り分ける判定（`lib/keys.ts` の `isSelectionPrompt`）は、
 * ここが渡す文字列だけを見る。**`TerminalPane` から切り出してあるのは、xterm の
 * `Terminal` さえあれば動く純関数で、React の描画と無関係だから**——コンポーネントの
 * ファイルへ置くと fast-refresh の警告が出るうえ、テストに render が要る。
 */

import type { Terminal } from '@xterm/xterm'

/**
 * いま**見えている**ぶんの画面をテキストにする。
 *
 * # スクロールバックを混ぜない
 *
 * `buffer.active` は遡れる行も持っているが、渡すのは `viewportY` から `rows` 行だけに
 * する。過去のダイアログの残骸に反応してキーを送る事故は、サーバ側で実測済み
 * （モデル切替の確認画面。`Session::scrollback_since` はそれを防ぐために生まれた）。
 * ここで可視領域に限っておけば、同じ壊れ方が構造的に起きない。
 *
 * 末尾の空白は落とす（`translateToString(true)`）。判定は行頭を見るので、右側の余白は要らない。
 */
export function visibleScreen(term: Terminal): string {
  return visibleLines(term).join('\n')
}

/** 画面の1行ぶん。`wrapped` は「前の行の続きとして折り返されたもの」。 */
export interface ScreenRow {
  text: string
  wrapped: boolean
}

/**
 * 折り返された物理行を、1つの**論理行**へ繋ぐ。
 *
 * # なぜ繋ぐのか
 *
 * xterm の型定義が明言している——`translateToString` は **`isWrapped` を考慮しない**。
 * 幅の狭いスマホでは案内文（`Esc to cancel · Tab to amend`）が物理行の途中で割れるので、
 * 繋がないと**目印が2行に分かれて当たらない**。tmux の `capture-pane -J` と同じ扱いになる。
 *
 * # 末尾の空行は落とさない
 *
 * 判定は「最終行から N 行以内」で窓を切るので、空行で埋まっていると目印を見失う。だが
 * **落とすのはここではない**——この関数（と [`visibleScreen`]）は「空行も含めて画面の行数
 * ぶん返る」という契約を先に持っており、行の位置が動かないことを当てにしている呼び手が
 * いる。**落とすのは判定の側**（`lib/keys.ts` の窓を切る手前）に置く。
 *
 * `Terminal` を受け取らないのは、テストから駆動できるようにするため。
 */
export function joinWrapped(rows: ScreenRow[]): string[] {
  return joinWrappedAt(rows, -1).lines
}

/**
 * [`joinWrapped`] と同じ繋ぎ方をしつつ、**注目している物理行が何本目の論理行に
 * なったか**も返す。
 *
 * # なぜ位置まで返すのか
 *
 * 折り返しを繋ぐと**繋いだぶんだけ行が上へ詰まる**ので、繋ぐ前の番号は繋いだあとでは
 * 別の行を指す。触った行を後から探し直す形にすると、**同じ文字列がもう一度出てくる
 * 画面（同じコマンドを2回打ったとき等）で別の行に当たる**——繋ぐのと数えるのは
 * 同じ1回でなければならない。
 *
 * `focus` が範囲の外なら `at` は 0 を返す。**「見つからない」を例外にしない**——
 * 呼ぶ側がやることは「先頭を見せる」で、それは失敗ではない。
 */
export function joinWrappedAt(
  rows: ScreenRow[],
  focus: number,
): { lines: string[]; at: number } {
  const lines: string[] = []
  let at = 0
  rows.forEach((row, i) => {
    if (row.wrapped && lines.length > 0) {
      lines[lines.length - 1] += row.text
    } else {
      lines.push(row.text)
    }
    if (i === focus) {
      at = lines.length - 1
    }
  })
  return { lines, at }
}

/**
 * 末尾の空行を落とす。**`at` は残った範囲へ寄せる。**
 *
 * 端末の格子は 40 行あるが、書かれているのは数行のことが多い。落とさずに出すと
 * **文字の面が空白で埋まり、指で繰る距離だけが伸びる**。
 *
 * **落とすのは末尾だけ。** 途中の空行は段落の切れ目なので、消すと文が繋がって読める
 * ものが読めなくなる。
 */
export function dropTrailingBlank(
  lines: string[],
  at: number,
): { lines: string[]; at: number } {
  let last = lines.length
  while (last > 0 && lines[last - 1].trim() === '') {
    last -= 1
  }
  const 残り = lines.slice(0, last)
  return { lines: 残り, at: Math.min(Math.max(at, 0), Math.max(0, 残り.length - 1)) }
}

/** いま見えているぶんの画面を、折り返しを繋いだ論理行として返す。 */
export function visibleLines(term: Terminal): string[] {
  return joinWrapped(rowsFrom(term, term.buffer.active.viewportY))
}

/**
 * いま見えているぶんの画面を、**折り返しを繋がない物理行**として返す。
 *
 * 返る本数は必ず `term.rows` で、**添字がそのまま画面の上から何行目か**になる。
 *
 * # 触った場所を行に直す側は、こちらしか使えない
 *
 * [`visibleLines`] は折り返しを1本に繋ぐので、**繋いだぶんだけ添字が上へ詰まる**。
 * 指が触れた高さから出した行番号と突き合わせると、**画面の上のほうで1度でも折り返しが
 * あった日から、静かに1行ずれる**（設計§13-3）。ずれても例外は出ず、押した場所と
 * 反応した場所が食い違うだけなので、気づくのは実機で触ったときになる。
 *
 * 逆に、目印を語で探す判定（`lib/keys.ts`）は繋いだほうを使う——狭い画面では案内文が
 * 物理行の途中で割れるので、繋がないと目印が2行に分かれて当たらない。
 * **用途が逆なので、口を2つに分けてある。**
 */
export function visibleRows(term: Terminal): string[] {
  return rowsFrom(term, term.buffer.active.viewportY).map((row) => row.text)
}

/** `top` 行目から `rows` 行ぶんを、折り返しの印を付けたまま返す。 */
function rowsFrom(term: Terminal, top: number): ScreenRow[] {
  const buffer = term.buffer.active
  const rows: ScreenRow[] = []
  for (let y = 0; y < term.rows; y += 1) {
    const line = buffer.getLine(top + y)
    rows.push({
      text: line?.translateToString(true) ?? '',
      wrapped: line?.isWrapped ?? false,
    })
  }
  return rows
}

/**
 * **遡ったぶんも含めた全部**を、折り返しを繋いだ論理行として返す。
 *
 * # ここだけがスクロールバックを混ぜてよい
 *
 * [`visibleScreen`] の注釈が「遡った先の古いダイアログに反応してキーを送る事故」を
 * 理由に可視領域へ限っているが、**あれは端末へキーを撃つ判定の話**である。こちらは
 * **人が読んで選ぶために文字を並べるだけ**で、読んだ結果が端末へ送られる経路が無い。
 * 混ぜてよい理由がこれで、**判定の側へこの口を渡してはいけない。**
 *
 * `row` はバッファの通し番号（`viewportY + 画面の行`）。その行が論理行の何本目に
 * なったかを `at` で返すので、呼ぶ側はそこを見せればよい。
 */
export function transcriptAt(term: Terminal, row: number): { lines: string[]; at: number } {
  const { lines, at } = joinWrappedAt(allRows(term), row)
  return dropTrailingBlank(lines, at)
}

/** バッファ全体を、折り返しの印を付けたまま返す。 */
function allRows(term: Terminal): ScreenRow[] {
  const buffer = term.buffer.active
  const rows: ScreenRow[] = []
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y)
    rows.push({
      text: line?.translateToString(true) ?? '',
      wrapped: line?.isWrapped ?? false,
    })
  }
  return rows
}
