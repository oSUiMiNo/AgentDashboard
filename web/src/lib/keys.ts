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
 *
 * # 判定は「位置」で決まる。語だけでは決まらない
 *
 * **かつてここには「`Esc to cancel` が選択待ちの唯一の共通点だった」と書いてあったが、
 * それは誤りだった。** 母集団を実行ファイルの解析まで広げると、
 *
 * - `esc to cancel` を**出さない**選択画面が実在する（`Esc to reject all` など）
 * - 選択待ちでない画面に**当たる**（作業中・ログイン待ち・そして**利用者が打った文そのもの**）
 *
 * の両方が起きる。実際、入力欄に `1. 手順を書く` と打っただけで以後 Enter が送信になる、
 * という不具合が出荷されていた。
 *
 * 直し方は語を増やすことではなく、**画面のどこを見るかを絞ること**だった。実物では
 * **案内は最終行に出て、メニューの選択肢は字下げされており、利用者が打つ行は字下げ0**
 * である。この3つで本物と偽物が完全に分かれる。
 *
 * # 口は3つある。答えるものが違う
 *
 * | 口 | 誰が使うか | 何を答えるか |
 * |---|---|---|
 * | [`isSelectionPrompt`] | Enter の読み替え | 選択待ちか（**迷ったら偽**。誤爆すると打ちかけが送信される） |
 * | [`looksSelecting`] | 十字ボタンの出し入れ | 選択待ちらしいか（**迷ったら真**。出しすぎても場所を取るだけ） |
 * | [`inputBoxRows`] | スマホで触った場所の判定 | 入力欄が**画面のどの行にあるか** |
 *
 * **3つ目だけ、答えるものが真偽ではない。** ここは「打てる状態か」を真偽で答えて
 * いた時期があったが、**通常状態では常に真になる**ので、ログの部分を押しても
 * キーボードが出た。要る答えは状態ではなく**場所**だった（設計§13）。
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

/** 案内文を探す窓（最終行から何行ぶんか）。実物はすべて**最終行**に出る。 */
const HINT_WINDOW = 3

/** 選択カーソルを探す窓。実物はすべて**下から5行以内**に出る。 */
const CURSOR_WINDOW = 6

/**
 * キーの案内の形。`Esc to cancel` / `Esc cancel` / `Enter/↓ to select` のどれも拾う。
 *
 * **`to` は任意。** 自動生成のフッタは `Esc cancel · ↑/↓ navigate` の形になり、
 * 「to」が入らない（実行ファイルの解析で確認）。綴りは `Esc` / `esc` / `⎋` に変わる。
 */
const HINT = /(?:^|[\s·([])(esc|⎋|enter|⏎|↵)(?:\/\S+)?\s+(?:to\s+)?([a-z]+)/gi

/**
 * 案内の形をしているが、**選択待ちではない**場面に固有の語。
 *
 * 許す側（`cancel` `close` `skip` …）を並べないのは、**列挙は版が上がるたびに漏れる**から。
 * 禁じる側は2語しかなく、しかも「作業中」という出てはいけない場面に固有なので、
 * こちらのほうが寿命が長い。
 *
 * **位置で絞っても救えない。** どちらも末尾のフッタに出るので、ここを書かないと
 * 作業中ずっと Enter が確定になる。
 */
const NOT_A_PROMPT = new Set(['interrupt', 'stop'])

/** 末尾の空行を落とした行の並び。窓を切る前に必ず通す。 */
function screenLines(screen: string): string[] {
  const lines = screen.split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop()
  }
  return lines
}

/**
 * **利用者が打った行**か（入力欄そのものと、履歴に残る過去の発言）。
 *
 * 実物では、入力欄も過去の発言も**字下げ0**の選択カーソルで始まる。一方メニューの
 * 選択肢は必ず**字下げ1以上**である（`fixtures/` の実測）。**この字下げが、本物と偽物を
 * 分ける唯一の構造情報**なので、案内を探すときもカーソルを数えるときも先に除く。
 *
 * これを除かないと、利用者が `esc to cancel` の意味を尋ねただけで選択待ちと判定される
 * （調査レポート §10-3 で実物の関数を動かして再現した誤爆）。
 */
function isTypedLine(line: string): boolean {
  return (
    line.length > 0 &&
    line.trimStart() === line &&
    SELECTION_CURSORS.includes(line.charAt(0))
  )
}

/** その行に、選択待ちの案内があるか。 */
function hasHint(line: string): boolean {
  if (isTypedLine(line)) {
    return false
  }
  for (const found of line.matchAll(HINT)) {
    if (!NOT_A_PROMPT.has(found[2].toLowerCase())) {
      return true
    }
  }
  return false
}

/** 末尾の窓の中に案内があるか。 */
function hintNearEnd(lines: string[]): boolean {
  return lines.slice(Math.max(0, lines.length - HINT_WINDOW)).some(hasHint)
}

/**
 * 末尾の窓の中にある**メニューの選択肢**（字下げ1以上の選択カーソルで始まる行）の、
 * カーソルより後ろの部分。
 *
 * **空白の種類を当てにしない。** `❯` の直後は、入力欄では NBSP（U+00A0）、選択肢では
 * 通常の半角空白だった（実測）。`trimStart()` はどちらも落とすので、種類を問わずに読める。
 * ただし**落とすのは字下げを見たあと**である。
 */
function menuChoices(lines: string[]): string[] {
  const choices: string[] = []
  for (const line of lines.slice(Math.max(0, lines.length - CURSOR_WINDOW))) {
    const trimmed = line.trimStart()
    if (trimmed === line) {
      // 字下げ0。入力欄か過去の発言であって、選択肢ではない
      continue
    }
    const cursor = trimmed.charAt(0)
    if (cursor && SELECTION_CURSORS.includes(cursor)) {
      choices.push(trimmed.slice(1))
    }
  }
  return choices
}

/**
 * いま画面が「選択して決めるのを待っている」か。**厳しいほう**（Enter の読み替え用）。
 *
 * # 見るのは3つ。どれも位置で窓を絞る
 *
 * | 材料 | 定義 |
 * |---|---|
 * | 末尾の案内 | 最終行から3行以内に、`Esc` / `Enter` に続く語がある（`interrupt` と `stop` は除く） |
 * | 選択カーソル | 下から6行以内に、**字下げ1以上**の `❯` で始まる行がある |
 * | 番号 | その行のカーソルの後ろが `数字.` の形 |
 *
 * ```
 * 厳しい ＝ 末尾の案内 ‖ （選択カーソル ＆ 番号）
 * ```
 *
 * **位置を見ないと誤爆する。** 実物の画面で確かめてある——作業中の画面にも過去の発言の
 * エコー（`❯ 1. …`）が残っているので、語を除外するだけでは止まらない。
 *
 * # 迷ったら「選択待ちではない」と答える
 *
 * 誤判定の重さが逆方向で違う。選択待ちでないのに確定と答えると**打ちかけの文が送信されて
 * しまう**（取り消せない）。逆は「Enter が効かない」だけで、`Ctrl+Enter` を押せば済む。
 * **十字ボタンの出し入れは倒し方が逆**なので、そちらは [`looksSelecting`] を使う。
 */
export function isSelectionPrompt(screen: string): boolean {
  const lines = screenLines(screen)
  if (lines.length === 0) {
    return false
  }
  return (
    hintNearEnd(lines) ||
    menuChoices(lines).some((rest) => /^\s*\d+\./.test(rest))
  )
}

/**
 * いま画面が選択待ち**らしい**か。**緩いほう**（十字ボタンの出し入れ用）。
 *
 * ```
 * 緩い ＝ 厳しい ‖ 選択カーソル
 * ```
 *
 * **番号を要求しない。** 案内が横幅の都合で `+N more` に切られて消えた画面でも、
 * 字下げされたカーソルさえ見えていれば出せる。
 *
 * # なぜ倒し方を変えるのか
 *
 * 外したときの損が逆向きだから。十字ボタンが余計に出ても**場所を取るだけ**で、
 * 入力欄は畳むだけで消さないので何も失わない。逆に出ないと、**`Ctrl` を持たない
 * スマホでは選択肢を選べない**。
 *
 * **厳しいほうを必ず内包する。** 逆転すると「Enter は確定になるのに十字ボタンが
 * 出ない」という、いちばん説明のつかない状態ができる。
 */
export function looksSelecting(screen: string): boolean {
  const lines = screenLines(screen)
  if (lines.length === 0) {
    return false
  }
  return (
    hintNearEnd(lines) || menuChoices(lines).length > 0 || hasScrollHint(lines)
  )
}

/**
 * 「まだ上（下）に N 件ある」という**送りの案内**があるか。
 *
 * # なぜ要るのか（実機・`/rewind`）
 *
 * `/rewind` は**選択肢に番号を持たない**（`❯ (current)`）ので、番号の目印では取れない。
 * 残るのは案内文と字下げカーソルの2つだが、**一覧が長くなるとどちらも視界から外れる**
 * ——実機では `↑ 33 more above` だけが見えている状態になった。
 *
 * **送りの案内は、それ自体が「送って選ぶ一覧」の証拠**である。普通の会話には出ない。
 *
 * # 緩いほうにだけ足す
 *
 * 厳しいほう（Enter の読み替え）には足さない。**あちらの偽陽性は打ちかけの文が
 * 送信されること**で取り消せないが、こちらは十字が余計に出るだけで済む（設計§3）。
 */
function hasScrollHint(lines: string[]): boolean {
  return lines
    .slice(Math.max(0, lines.length - CURSOR_WINDOW))
    .some((line) => /[↑↓]\s*\d+\s+more\b/i.test(line))
}

/**
 * 入力欄の枠に使う罫線（`─`・U+2500）だけでできた行。
 *
 * **選択待ちの区切りは `╌`（U+254C）で、別のグリフである**（`fixtures/` の `permission`
 * で実測）。ここへ `╌` を入れると、選択待ちの区切りが入力欄の枠に化ける。
 *
 * **8 は幅ではなく床である。** 実物は 120桁で 120文字、狭い相手で 45文字（実測）なので
 * 桁数は決め打てない。飾りの短い横線を拾わないためだけに床を置いている。
 */
const RULE_LINE = /^─{8,}$/

/** 入力欄の枠を探す窓。実物は末尾5行以内に収まる（フッタ2行ぶんの余裕を足してある）。 */
const INPUT_BOX_WINDOW = 8

/** 画面の行の範囲。**両端を含む**（0 起点・可視領域の中での番号）。 */
export interface RowRange {
  top: number
  bottom: number
}

/**
 * 入力欄が**画面のどの行にあるか**を返す。**触った場所で入力可能を決めるための口**（設計§13）。
 *
 * ```
 * ────────────   ← top（上の罫線）
 * ❯ 打った文
 *   折り返した続き
 * ────────────   ← bottom（下の罫線）
 * ```
 *
 * # 状態ではなく範囲を返す
 *
 * かつて同じ判定が `acceptsTyping`（打てる状態か）という**真偽**を答えていたが、
 * それでは要件を満たせなかった——**プロンプトが出ている通常状態では常に真**なので、
 * ログの部分を押してもキーボードが出る。利用者が求めていたのは「状態」ではなく
 * **「場所」**だった（実機の観測・2026-09-05）。判定の中身は同じで、**答え方だけを
 * 変えて戻してある。**
 *
 * # 罫線に挟まれているかまで見る
 *
 * **過去の発言のエコーも字下げ0で写る。** `permission` の実物には、利用者が打った
 * `❯ report.txt というファイルを作って…` が残ったまま選択待ちになっている——
 * 字下げ（[`isTypedLine`]）だけを見ると、この行が入力欄に化ける。**罫線に挟まれて
 * いるかまで見ると、生きている入力欄とエコーが分かれる**（実物15枚で確認）。
 *
 * # 枠の線も範囲に入れる
 *
 * 返すのは**描かれた枠そのもの**で、上下の罫線を含む。中身だけにすると、実機では
 * 1行（10px 前後）しか的が無く、指では狙えない。**枠の外へは広げない**——余白まで
 * 含めると「関係ない所を押したのに入力可能になる」という、直そうとしている症状に戻る。
 *
 * # 見つからなければカーソルの行へ落とす
 *
 * 枠を出さない画面（起動直後・全画面の TUI）でも、打つ道を失わせない。**遡って
 * カーソルが画面の外に居るときは、どの行とも一致しない**——ログを読んでいる最中に
 * 打ち始めることにはならない。
 *
 * @param rows 可視領域の**物理行**。折り返しを繋いだ論理行を渡してはいけない
 *   （繋ぐと行番号がずれ、触った場所と対応しなくなる）
 * @param cursorRow カーソルの居る行（可視領域の 0 起点）。画面の外なら範囲外の値でよい
 */
export function inputBoxRows(rows: string[], cursorRow: number): RowRange | null {
  let last = rows.length - 1
  while (last >= 0 && rows[last].trim() === '') {
    last -= 1
  }
  if (last < 0) {
    return null
  }
  for (let i = Math.max(0, last + 1 - INPUT_BOX_WINDOW); i + 2 <= last; i += 1) {
    if (!RULE_LINE.test(rows[i].trimEnd()) || !isTypedLine(rows[i + 1])) {
      continue
    }
    // **打った文が長いと、枠は縦に伸びる。** 折り返したぶんの続きを跨いで、
    // 閉じの罫線を探す——ここを `rows[i + 2]` に決め打つと、**長い文を打っている
    // 最中だけ枠が見つからなくなる**。長文こそ、取りこぼしたときの損が大きい。
    //
    // **跨いでよいのは罫線でない行だけ。** 罫線に当たったらそこで閉じる（当たらずに
    // 窓を出たら、枠ではなかったということ）。
    for (let j = i + 2; j <= last; j += 1) {
      if (RULE_LINE.test(rows[j].trimEnd())) {
        return { top: i, bottom: j }
      }
      if (isTypedLine(rows[j])) {
        // 次の入力欄の始まり。ここまでで閉じていないなら枠ではない
        break
      }
    }
  }
  if (cursorRow < 0 || cursorRow >= rows.length) {
    return null
  }
  return { top: cursorRow, bottom: cursorRow }
}

/**
 * その行が範囲の中か。**範囲が無ければ、どの行も外**（＝入力可能にはしない）。
 *
 * 触った場所を測るのは呼ぶ側（`TerminalPane`）の仕事で、**ここは数の比べ方だけ**を
 * 持つ。混ぜると jsdom が寸法を持たないぶん、単体テストが何も確かめないまま緑になる
 * （`lib/reorder.ts` と `lib/useReorder.ts` の分け方と同じ理由）。
 */
export function rowInRange(range: RowRange | null, row: number): boolean {
  return range !== null && row >= range.top && row <= range.bottom
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

/**
 * 端末へ頼めるキー。**意味であって、バイト列ではない**（設計§5）。
 *
 * 十字ボタンは `'up'` と頼むだけで、何バイト送られるかを知らない。押す側が独自に
 * 組み立てる余地が構造的に無いので、「Enter の扱いを直したのに十字ボタンだけ
 * 取り残される」という、このファイルがまさに防ごうとしている失敗を型で消せる。
 */
export type TerminalKey = 'up' | 'down' | 'left' | 'right' | 'enter' | 'esc'

/** 矢印の終端バイト。前置きが `ESC [` か `ESC O` かはモードで決まる。 */
const CURSOR_FINAL: Record<'up' | 'down' | 'right' | 'left', string> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
}

/**
 * キーを端末へ送るバイト列に直す。**バイト列を知るのはここだけ**（設計§5）。
 *
 * # 矢印の符号は読んで選ぶ
 *
 * `ESC [ A`（ノーマル）と `ESC O A`（アプリケーション）を分けているのは DECCKM で、
 * 実測では claude はこれを立てず、しかも**両方を受ける**（調査レポート §2-1）。つまり
 * 今日は決め打ちでも動く。それでも読んで選ぶのは、`term.modes` がすぐそこにあり
 * **読むコストがゼロ**だからで、tmux の `send-keys` も同じことをしている。
 *
 * 立っているかを**知らない**とき（`undefined`）は CSI 側へ落とす。知らないことを
 * 「立っていない」と同じ扱いにするのは、そちらが既定だからである。
 *
 * @param applicationCursorKeys `term.modes.applicationCursorKeysMode`。読めなければ `undefined`
 */
export function sequenceFor(
  key: TerminalKey,
  applicationCursorKeys: boolean | undefined,
): string {
  if (key === 'enter') {
    // 確定は CR。端末の作法どおりで、Ctrl+Enter が送るものと同じ
    return SUBMIT
  }
  if (key === 'esc') {
    return '\x1b'
  }
  const prefix = applicationCursorKeys === true ? '\x1bO' : '\x1b['
  return prefix + CURSOR_FINAL[key]
}
