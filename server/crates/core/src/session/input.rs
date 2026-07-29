//! Composer から届いた指示を、PTY へ書くバイト列に変換する（設計§4/§6）。
//!
//! # なぜ長さに関わらず包むのか
//!
//! ターミナル上の CLI は、改行が届いた時点で「確定した」とみなして処理を始める。
//! 複数行の指示をそのまま流すと、1行目だけが送信され、残りが次の指示として順に
//! 実行されてしまう。**bracketed paste**（`ESC[200~ … ESC[201~`）で包むと、
//! CLI は「これは貼り付けであって確定ではない」と解釈し、中の改行を本文として扱う。
//!
//! # なぜ本文と確定を別々に書くのか
//!
//! かつては複数行だけを包み、単一行は `本文 + CR` を**1回の書き込み**で送っていた。
//! これが破綻する。本物の TUI は一定量を超える入力を貼り付けと判定し、**同じ書き込みに
//! 入っている末尾の CR まで飲み込んで確定しない**。文字は入力欄に残り、エラーも出ない
//! まま何も起きない。フェーズ6の受け入れテストで実測した境目は 57〜64 バイトの間で、
//! 日本語なら20文字ほどで超える（詳細は設計§18）。
//!
//! 包むだけでは足りない。`ESC[200~ … ESC[201~ CR` を1回で書いても同じく確定しない
//! （これも実測）。**確定の CR を別の書き込みにする**と通る。つまり要点は2つある。
//!
//! 1. 行数によらず bracketed paste で包む（改行を本文として渡すため）
//! 2. 確定の CR は**本文とは別の書き込み**で送る（貼り付けの処理に飲まれないため）
//!
//! # なぜ純粋関数なのか
//!
//! 変換だけを切り出しておくと、PTY を起動せずに表駆動テストで全パターンを固定できる。
//! ただし**ここだけでは足りない**ことが上の破綻で分かった。包まないと壊れることも、
//! 1回で書くと壊れることも、本物の TUI を動かすまで見えない。実CLIテスト側に「長い
//! 単一行が1つの指示として届くこと」を置いてある。

/// bracketed paste の開始と終了。
const PASTE_BEGIN: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

/// 送信の確定。ターミナルの Enter は LF ではなく CR。
const SUBMIT: &str = "\r";

/// Composer の1回の送信を、**貼り付け本体**と**確定**の2つに分けて返す。
///
/// - 本文あり … (`ESC[200~ 本文 ESC[201~`, `CR`)
/// - 空文字 … (空, `CR`)（TUI のメニューを確定させる用途に使える）
///
/// 分けて返すのは、**呼び出し側に別々の書き込みをさせる**ため（理由はモジュールの説明）。
/// 1つに繋げて返すと、それを1回で書いてしまう経路がまた生まれる。
///
/// 本文からは **ESC（`0x1b`）をすべて取り除く**。Composer に流れてくるのは自然文か
/// スラッシュコマンドで、制御シーケンスが混じる理由が無い。素通しすると、貼り付けの
/// 終了記号を本文側から打ち込んで CLI の入力状態を壊すことができてしまう。
pub fn encode_parts(text: &str) -> (Vec<u8>, Vec<u8>) {
    let body = sanitize(text);
    let submit = SUBMIT.as_bytes().to_vec();

    if body.is_empty() {
        return (Vec::new(), submit);
    }
    (
        format!("{PASTE_BEGIN}{body}{PASTE_END}").into_bytes(),
        submit,
    )
}

/// 改行コードを LF に揃え、ESC を落とし、末尾の空行を落とす。
///
/// 末尾の改行を落とすのは、送信そのものが最後に CR を付けるため。残したままだと
/// 「本文の終わりの空行」と「送信の確定」が二重になり、CLI 側で余分な改行が入る。
fn sanitize(text: &str) -> String {
    let mut body = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\u{1b}' => {}
            '\r' => {
                // CRLF は1つの改行として扱う
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                body.push('\n');
            }
            _ => body.push(ch),
        }
    }
    body.trim_end_matches('\n').to_string()
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    /// 本文と確定を繋げた見た目。**実際の送信は2回に分かれている**（[`encode_parts`]）
    /// が、テストでは中身の組み立てだけを見たいので繋げて比べる。
    fn encoded(text: &str) -> String {
        let (body, submit) = encode_parts(text);
        String::from_utf8([body, submit].concat()).expect("UTF-8 のまま")
    }

    #[test]
    fn 本文と確定は別々に返る() {
        // 繋げて1回で書くと、TUI が貼り付けの処理で CR まで飲み込んで確定しない。
        // 「分かれていること」自体がこの関数の存在理由なので、ここで固定する
        let (body, submit) = encode_parts("こんにちは");
        assert_eq!(body, "\u{1b}[200~こんにちは\u{1b}[201~".as_bytes());
        assert_eq!(submit, b"\r");
    }

    #[test]
    fn 単一行もbracketed_pasteで包む() {
        assert_eq!(encoded("こんにちは"), "\u{1b}[200~こんにちは\u{1b}[201~\r");
    }

    #[test]
    fn 長さで送り方を変えない() {
        // 包まずに送ると、本物の TUI が一定量を超える入力を貼り付けと判定し、
        // **末尾の CR まで飲み込んで確定しない**（実測した境目は 57〜64 バイトの間）。
        // 短い側だけ試していると気づけないので、境目をまたぐ2つを並べて固定する
        let short = "0".repeat(48);
        let long = "0".repeat(200);
        assert_eq!(encoded(&short), format!("\u{1b}[200~{short}\u{1b}[201~\r"));
        assert_eq!(encoded(&long), format!("\u{1b}[200~{long}\u{1b}[201~\r"));
    }

    #[test]
    fn スラッシュコマンドも特別扱いしない() {
        // 実体が本物の CLI なので、そのまま流せば解釈される（要件「あらゆるスラッシュコマンド」）
        assert_eq!(encoded("/rewind"), "\u{1b}[200~/rewind\u{1b}[201~\r");
    }

    #[test]
    fn 複数行もbracketed_pasteで包む() {
        assert_eq!(
            encoded("1行目\n2行目"),
            "\u{1b}[200~1行目\n2行目\u{1b}[201~\r"
        );
    }

    #[test]
    fn CRLFはLFに揃える() {
        // ブラウザの textarea は環境によって CRLF を送ってくる。素通しすると
        // 貼り付けの中に CR が混ざり、CLI 側で確定と解釈されうる
        assert_eq!(
            encoded("1行目\r\n2行目"),
            "\u{1b}[200~1行目\n2行目\u{1b}[201~\r"
        );
    }

    #[test]
    fn 末尾の改行は落とす() {
        assert_eq!(encoded("ひとこと\n"), "\u{1b}[200~ひとこと\u{1b}[201~\r");
        assert_eq!(
            encoded("ひとこと\n\n\n"),
            "\u{1b}[200~ひとこと\u{1b}[201~\r"
        );
    }

    #[test]
    fn 空文字はCRだけを送る() {
        assert_eq!(encoded(""), "\r");
        assert_eq!(encoded("\n\n"), "\r");
    }

    #[test]
    fn 本文のESCは取り除く() {
        // 貼り付けの終了記号を本文から打ち込めないことの確認
        assert_eq!(
            encoded("わるいこ\u{1b}[201~ここは本文"),
            "\u{1b}[200~わるいこ[201~ここは本文\u{1b}[201~\r"
        );
    }
}
