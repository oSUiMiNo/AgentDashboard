/**
 * ブラウザの端末（[`TerminalPane`]）で、Enter まわりのキーを読み替える。
 *
 * # 何をどう変えているか
 *
 * | キー | 送る並び | 意味 |
 * |---|---|---|
 * | Enter | `ESC CR` | **改行**（既定では送信になってしまう） |
 * | Shift+Enter | `ESC CR` | 改行（xterm は Shift を見ておらず、素の Enter と同じ CR を送る） |
 * | Ctrl+Enter | `CR` | **送信** |
 *
 * 長い指示を端末へ直に打つことが多いので、**改行を押しやすいキーへ、送信を意図の要る
 * キーへ**という割り当てにしている（利用者の指定）。
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
 * # 選択ダイアログの確定も Ctrl+Enter になる
 *
 * CLI の TUI は「Yes / No」のような選択も Enter で確定する。Enter を改行にした以上、
 * **その確定も Ctrl+Enter で行うことになる**。押し分けが要るのはこの割り当ての代償で、
 * 隠さずここに書いておく。
 *
 * なお `Ctrl+J`（0x0A）は読み替え無しでいまも改行として効く。xterm がそのまま送るため。
 */

/** 改行として送る並び（ESC + CR）。 */
export const NEWLINE = '\x1b\r'

/** 送信として送る並び（CR）。端末の作法どおり確定は CR。 */
export const SUBMIT = '\r'

/**
 * 端末へ送る前にキーを読み替える。読み替えが要らなければ `null`。
 *
 * 対象は **keydown の Enter だけ**に絞る。絞らないと次の事故が起きる。
 *
 * | 除く対象 | 理由 |
 * |---|---|
 * | `keydown` 以外 | 横取りの口は keypress でも呼ばれるので、二重に送ってしまう |
 * | Alt / Meta が一緒 | Alt+Enter は端末の作法で既に ESC 前置になる。奪うと二重に前置する |
 * | IME の変換中 | 変換確定の Enter を改行と取り違える（Composer が見ているのと同じ理由） |
 */
export function terminalKeyOverride(event: KeyboardEvent): string | null {
  if (event.type !== 'keydown' || event.isComposing) {
    return null
  }
  if (event.key !== 'Enter') {
    return null
  }
  if (event.altKey || event.metaKey) {
    return null
  }
  // Shift の有無は改行かどうかに影響しない。押し分けるのは Ctrl だけ
  return event.ctrlKey ? SUBMIT : NEWLINE
}
