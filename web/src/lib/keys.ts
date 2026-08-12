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
 * # 選択ダイアログのときだけ、Enter は確定になる
 *
 * CLI の TUI は「Yes / No」のような選択も Enter で確定する。Enter を一律に改行へ読み替えて
 * いた頃は、**その確定まで Ctrl+Enter で行うことになっていた**——画面に `Enter to confirm` と
 * 出ているのに素の Enter が効かない、という食い違いがここにあった。しかも **`Ctrl` を持たない
 * スマホでは確定そのものができなかった**。
 *
 * いまは [`isSelectionPrompt`] が画面を見て、選択待ちのときだけ Enter を確定として送る。
 * 押し分けを覚える必要は無くなったが、**`Ctrl+Enter` は画面によらず確定のまま**にしてある
 * ——判定が外れたときの逃げ道を、利用者から取り上げないため。
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
 * 選択カーソルとして扱う文字。
 *
 * 実物は `❯` だが、版で変わりうるので近い形を数個持っておく。サーバ側の
 * `session/permission.rs` の `accept_option_key` が落としている顔ぶれに揃えてある。
 */
const SELECTION_CURSORS = '❯>*›▶│'

/**
 * TUI が「Esc で取り消せる」と言っている案内。**これが選択待ちの唯一の共通点**だった。
 *
 * 実測（v2.1.228）では、Enter の案内は画面ごとに違った——信頼確認は `Enter to confirm`、
 * `/rewind` は `Enter to continue`、権限確認は**Enter の案内をそもそも出さない**。
 * 3種すべてに出たのはこちらだけである。
 *
 * 作業中に出る `esc to interrupt` とは綴りが違うので当たらない。
 */
const CANCEL_HINT = 'esc to cancel'

/**
 * いま画面が「選択して決めるのを待っている」か。
 *
 * # 目印を2つ持ち、どちらかが当たれば選択待ちとみなす
 *
 * 1つの文字列に賭けない。TUI の文言は版ごとに変わるうえ、こちらから出させることが
 * できない画面もある。実測（v2.1.228。`fixtures/v2.1.228/screens/`）の結果が次のとおりで、
 * **2つ持って初めて3種すべてに当たり、そうでない画面には1つも当たらない**。
 *
 * | 画面 | 形 | 案内文 |
 * |---|---|---|
 * | フォルダ信頼の確認 | 当たり | 当たり |
 * | 権限確認 | 当たり | 当たり |
 * | `/rewind` のメニュー | — | 当たり |
 * | 起動直後（welcome） | — | — |
 * | 普通に会話しているだけ | — | — |
 *
 * **`/rewind` は選択肢に番号を持たない**（`❯ (current)`）ので、形の目印だけでは取りこぼす。
 *
 * # 迷ったら「選択待ちではない」と答える
 *
 * 誤判定の重さが逆方向で違う。選択待ちでないのに確定と答えると**打ちかけの文が送信されて
 * しまう**（取り消せない）。逆は「Enter が効かない」だけで、`Ctrl+Enter` を押せば済む。
 * だから**目印が1つも当たらなければ false** にする。
 */
export function isSelectionPrompt(screen: string): boolean {
  if (!screen) {
    return false
  }
  if (screen.toLowerCase().includes(CANCEL_HINT)) {
    return true
  }
  return screen.split('\n').some(hasNumberedChoice)
}

/**
 * その行が「選択カーソル ＋ 番号つきの選択肢」か。
 *
 * **空白の種類を当てにしない。** `❯` の直後は、入力欄では NBSP（U+00A0）、選択肢では
 * 通常の半角空白だった（実測）。`trimStart()` はどちらも落とすので、種類を問わずに読める。
 */
function hasNumberedChoice(line: string): boolean {
  const trimmed = line.trimStart()
  const cursor = trimmed.charAt(0)
  if (!cursor || !SELECTION_CURSORS.includes(cursor)) {
    return false
  }
  return /^\d+\./.test(trimmed.slice(1).trimStart())
}

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
 *
 * **除外は画面を見る前に効かせる。** 変換確定の Enter を確定と取り違えないことのほうが先で、
 * しかもそうすれば既存の振る舞いを1バイトも変えずに済む。
 *
 * # 画面は「読む関数」で受け取る
 *
 * 横取りの口は**すべてのキー**で呼ばれるので、画面テキスト（40行×120桁）を毎打鍵で
 * 組み立てると、打つたびに無駄が乗る。関数で受け取れば、**素の Enter のときにしか
 * 呼ばれない**——除外に当たった場合も、`Ctrl+Enter` の場合も、読まずに答えが決まる。
 *
 * @param readScreen いま見えている画面（可視領域だけ）を返す。**呼ばれないことがある**
 */
export function terminalKeyOverride(
  event: KeyboardEvent,
  readScreen: () => string,
): string | null {
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
  if (event.ctrlKey) {
    return SUBMIT
  }
  // 選択待ちの画面でだけ、素の Enter も確定として送る
  return isSelectionPrompt(readScreen()) ? SUBMIT : NEWLINE
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
