/**
 * ブラウザの端末（[`TerminalPane`]）で、xterm の既定では足りないキーを読み替える。
 *
 * # なぜ要るのか
 *
 * xterm は Enter に対して Shift を見ておらず、**Shift+Enter でも素の Enter と同じ
 * CR（`\r`）を送る**。受け取る CLI から見れば両者は完全に同じバイト列なので、
 * 区別のしようがない。その結果、改行したいのに送信されてしまう。
 *
 * # 送る並びは推測ではなく実測
 *
 * 起動している claude のバイナリ自身が、`/terminal-setup` で VS Code へ書き込む
 * keybinding を持っている。その中身がこれだった（v2.1.220 で確認）。
 *
 * ```js
 * { key: "shift+enter", command: "workbench.action.terminal.sendSequence",
 *   args: { text: "\x1B\r" } }
 * ```
 *
 * つまり **ESC + CR** を送れば本物は改行として扱う。公式ドキュメントが言う
 * 「Option+Enter で改行」も、Option を Meta として送る＝ESC 前置なので同じ並びになる。
 *
 * なお `Ctrl+J`（0x0A）は読み替え無しでいまも効く。xterm がそのまま送るため。
 */

/** Shift+Enter で送る並び（ESC + CR）。 */
export const SHIFT_ENTER = '\x1b\r'

/**
 * 端末へ送る前にキーを読み替える。読み替えが要らなければ `null`。
 *
 * 対象は **keydown の Shift+Enter だけ**に絞る。絞らないと次の事故が起きる。
 *
 * | 除く対象 | 理由 |
 * |---|---|
 * | `keydown` 以外 | 横取りの口は keypress でも呼ばれるので、二重に送ってしまう |
 * | 他の修飾キーが一緒 | Ctrl+Shift+Enter などは別の意味を持ちうる。奪わない |
 * | IME の変換中 | 変換確定の Enter を改行と取り違える（Composer が見ているのと同じ理由） |
 */
export function terminalKeyOverride(event: KeyboardEvent): string | null {
  if (event.type !== 'keydown' || event.isComposing) {
    return null
  }
  if (event.key !== 'Enter' || !event.shiftKey) {
    return null
  }
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return null
  }
  return SHIFT_ENTER
}
