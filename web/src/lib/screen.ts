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
  const lines: string[] = []
  for (const row of rows) {
    if (row.wrapped && lines.length > 0) {
      lines[lines.length - 1] += row.text
    } else {
      lines.push(row.text)
    }
  }
  return lines
}

/** いま見えているぶんの画面を、折り返しを繋いだ論理行として返す。 */
export function visibleLines(term: Terminal): string[] {
  return linesFrom(term, term.buffer.active.viewportY)
}

/** `top` 行目から `rows` 行ぶんを、折り返しを繋いだ論理行として返す。 */
function linesFrom(term: Terminal, top: number): string[] {
  const buffer = term.buffer.active
  const rows: ScreenRow[] = []
  for (let y = 0; y < term.rows; y += 1) {
    const line = buffer.getLine(top + y)
    rows.push({
      text: line?.translateToString(true) ?? '',
      wrapped: line?.isWrapped ?? false,
    })
  }
  return joinWrapped(rows)
}
