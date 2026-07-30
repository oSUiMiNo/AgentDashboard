/**
 * Enter まわりのキーの割り当て。**端末（[`TerminalPane`]）と入力欄（`Composer`）の
 * 両方がここを見る。**
 *
 * # 何をどう変えているか
 *
 * | キー | 意味 |
 * |---|---|
 * | Enter | **改行** |
 * | Shift+Enter | 改行 |
 * | Ctrl+Enter | **送信** |
 *
 * 長い指示を打つことが多いので、**改行を押しやすいキーへ、送信を意図の要るキーへ**という
 * 割り当てにしている（利用者の指定）。
 *
 * # 2つの入力口で同じ割り当てにする
 *
 * セッション専用画面には入力口が2つある。タブの中の端末と、タブの外に常設された入力欄で、
 * **どちらも同じ画面に見えている**。ここが食い違うと、押した結果が「いまどちらに焦点が
 * あるか」で変わることになり、打っている本人には原因が分からない。
 *
 * 判定を1ファイルへ集約しているのは、片方だけ直して片方が取り残される形を作らないため。
 * ただし**送るものは別**で、端末は下の表のバイト列を送り、入力欄は素のテキストに改行が
 * 入るだけである（改行を含む指示を包むのはサーバの仕事。`session/input.rs`）。
 *
 * | 端末が送る並び | 意味 |
 * |---|---|
 * | `ESC CR` | 改行（既定では送信になってしまう） |
 * | `CR` | 送信 |
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

/**
 * 押し分けの判断に使う分だけを取り出した形。
 *
 * React の合成イベントには `isComposing` が無い（`nativeEvent` 側にある）ので、
 * 具体的なイベント型ではなくこの形を受け取る。呼ぶ側が必要な値を並べる。
 *
 * **`shiftKey` は入れない。** 押し分けているのは Ctrl だけなので、判断材料に持たなければ
 * 「Shift の扱いを間違える」余地そのものが無くなる。
 */
export interface EnterKeyState {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  isComposing: boolean
}

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
  // Shift の有無は改行かどうかに影響しない（xterm は Enter に修飾キーを見ておらず、
  // Shift+Enter でも素の Enter と同じ CR を送る）。押し分けるのは Ctrl だけ
  return event.ctrlKey ? SUBMIT : NEWLINE
}

/**
 * 入力欄（`Composer`）で、そのキーを「送信」と解釈するか。
 *
 * **Ctrl+Enter だけが送信**で、それ以外の Enter は何もしない（textarea の既定がそのまま
 * 改行として働く）。除く対象は端末側（[`terminalKeyOverride`]）と揃えてある。
 *
 * | 除く対象 | 理由 |
 * |---|---|
 * | Alt / Meta が一緒 | 端末側が読み替えを避ける組み合わせ。片方だけ送信になると、同じキーが画面によって違う意味になる |
 * | IME の変換中 | 変換確定の Enter を送信と取り違える |
 */
export function isComposerSubmit(event: EnterKeyState): boolean {
  if (event.key !== 'Enter' || event.isComposing) {
    return false
  }
  if (event.altKey || event.metaKey) {
    return false
  }
  // Shift は見ない。押し分けるのは Ctrl だけ
  return event.ctrlKey
}
