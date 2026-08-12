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
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < term.rows; y += 1) {
    lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '')
  }
  return lines.join('\n')
}
