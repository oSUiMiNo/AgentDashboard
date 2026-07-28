//! Composer から届いた指示を、PTY へ書くバイト列に変換する（設計§4/§6）。
//!
//! # なぜ複数行だけ包むのか
//!
//! ターミナル上の CLI は、改行が届いた時点で「確定した」とみなして処理を始める。
//! 複数行の指示をそのまま流すと、1行目だけが送信され、残りが次の指示として順に
//! 実行されてしまう。**bracketed paste**（`ESC[200~ … ESC[201~`）で包むと、
//! CLI は「これは貼り付けであって確定ではない」と解釈し、中の改行を本文として扱う。
//!
//! # なぜ純粋関数なのか
//!
//! 変換だけを切り出しておくと、PTY を起動せずに表駆動テストで全パターンを固定できる。
//! 「複数行が1行目だけ送られる」たぐいの不具合は、実際に CLI を動かして目で見るまで
//! 気づけないので、ここで機械的に押さえておく価値が高い。

/// bracketed paste の開始と終了。
const PASTE_BEGIN: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

/// 送信の確定。ターミナルの Enter は LF ではなく CR。
const SUBMIT: &str = "\r";

/// Composer の1回の送信を、PTY へ書くバイト列にする。
///
/// - 単一行 … `本文 + CR`
/// - 複数行 … `ESC[200~ 本文 ESC[201~ + CR`
/// - 空文字 … `CR` だけ（TUI のメニューを確定させる用途に使える）
///
/// 本文からは **ESC（`0x1b`）をすべて取り除く**。Composer に流れてくるのは自然文か
/// スラッシュコマンドで、制御シーケンスが混じる理由が無い。素通しすると、貼り付けの
/// 終了記号を本文側から打ち込んで CLI の入力状態を壊すことができてしまう。
pub fn encode_input(text: &str) -> Vec<u8> {
    let body = sanitize(text);

    if body.is_empty() {
        return SUBMIT.as_bytes().to_vec();
    }
    if body.contains('\n') {
        return format!("{PASTE_BEGIN}{body}{PASTE_END}{SUBMIT}").into_bytes();
    }
    format!("{body}{SUBMIT}").into_bytes()
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

    fn encoded(text: &str) -> String {
        String::from_utf8(encode_input(text)).expect("UTF-8 のまま")
    }

    #[test]
    fn 単一行は末尾にCRを付けて送る() {
        assert_eq!(encoded("こんにちは"), "こんにちは\r");
    }

    #[test]
    fn スラッシュコマンドも特別扱いしない() {
        // 実体が本物の CLI なので、そのまま流せば解釈される（要件「あらゆるスラッシュコマンド」）
        assert_eq!(encoded("/rewind"), "/rewind\r");
    }

    #[test]
    fn 複数行はbracketed_pasteで包む() {
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
        assert_eq!(encoded("ひとこと\n"), "ひとこと\r");
        assert_eq!(encoded("ひとこと\n\n\n"), "ひとこと\r");
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
            "わるいこ[201~ここは本文\r"
        );
    }
}
