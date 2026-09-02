//! Composer から届いた指示を、PTY へ書くバイト列に変換する（設計§4/§6）。
//!
//! **添付については、書く側と読む側の両方をここに置く。** 本文へパスを混ぜるのが
//! [`encode_parts_with`]、混ぜた結果として画面に出る印を数えるのが
//! [`count_image_marks`] で、**この2つは対になっている**（何を書いたから何が出るはず
//! なのか、という関係）。離して置くと、片方を直したときにもう片方が取り残される。
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
//! 3. 入れる前に**入力行を空にする**（残っているものへ追記させないため。[`CLEAR_LINE`]）
//!
//! # なぜ純粋関数なのか
//!
//! 変換だけを切り出しておくと、PTY を起動せずに表駆動テストで全パターンを固定できる。
//! ただし**ここだけでは足りない**ことが上の破綻で分かった。包まないと壊れることも、
//! 1回で書くと壊れることも、本物の TUI を動かすまで見えない。実CLIテスト側に「長い
//! 単一行が1つの指示として届くこと」を置いてある。

use super::permission::{squeeze, strip_ansi};

/// bracketed paste の開始と終了。
const PASTE_BEGIN: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

/// 送信の確定。ターミナルの Enter は LF ではなく CR。
const SUBMIT: &str = "\r";

/// 入力行を消す（readline の kill-line、`Ctrl+U`）。
///
/// 送る前に必ず1回打つ。TUI の入力欄に**何か残っていると、そこへ追記される**からで、
/// これは実害として観測している。`/rewind` は巻き戻した発言を入力欄へ戻す仕様なので、
/// そのまま Composer から次の指示を送ると「巻き戻した指示＋新しい指示」が1つの発言に
/// なって届き、**取り消したはずの作業がやり直される**（フェーズ6の受け入れテストで実測）。
///
/// 送信が失敗して本文が入力欄に残っている場合も同じことが起きる。Composer から送った
/// ものは「入力欄に打ったそのもの」であるべきなので、先に空にしてから入れる。
const CLEAR_LINE: &str = "\x15";

/// Composer の1回の送信を、**貼り付け本体**と**確定**の2つに分けて返す。
///
/// - 本文あり … (`Ctrl+U ESC[200~ 本文 ESC[201~`, `CR`)
/// - 空文字 … (空, `CR`)（TUI のメニューを確定させる用途に使える）
///
/// 分けて返すのは、**呼び出し側に別々の書き込みをさせる**ため（理由はモジュールの説明）。
/// 1つに繋げて返すと、それを1回で書いてしまう経路がまた生まれる。
///
/// 本文からは **ESC（`0x1b`）をすべて取り除く**。Composer に流れてくるのは自然文か
/// スラッシュコマンドで、制御シーケンスが混じる理由が無い。素通しすると、貼り付けの
/// 終了記号を本文側から打ち込んで CLI の入力状態を壊すことができてしまう。
pub fn encode_parts(text: &str) -> (Vec<u8>, Vec<u8>) {
    encode_parts_with(text, &[])
}

/// [`encode_parts`] に**添付のパス**を足した形（設計§6）。
///
/// 添付が0枚のときは [`encode_parts`] と**1バイトも変わらない**。添付を使わない送信を
/// 巻き添えにしないための約束で、テストで固定してある。
///
/// パスは**本文の後ろへ、1行に1つ・行末**に並べる。claude の貼り付け処理は貼られた
/// 文字列を改行と「スペース＋パスの始まり」で切り、**断片の末尾**が画像の拡張子のとき
/// だけそれをディスクから読んで添付にする。したがって行の途中に置くと当たらない
/// （2026-09-01 に実 claude で実測。設計§19 の前提1）。
pub fn encode_parts_with(text: &str, attachments: &[String]) -> (Vec<u8>, Vec<u8>) {
    let body = compose(sanitize(text), attachments);
    let submit = SUBMIT.as_bytes().to_vec();

    // 空送信は「メニューを確定させる」用途なので、入力行に触ってはいけない
    if body.is_empty() {
        return (Vec::new(), submit);
    }
    (
        format!("{CLEAR_LINE}{PASTE_BEGIN}{body}{PASTE_END}").into_bytes(),
        submit,
    )
}

/// 本文の後ろへ添付のパスを1行ずつ足す。
///
/// **本文は1文字も変えない。** 足すのは行の区切りとパスだけで、本文が空なら
/// パスだけの本文になる（画像だけを送る形）。
fn compose(body: String, attachments: &[String]) -> String {
    if attachments.is_empty() {
        return body;
    }
    let mut out = body;
    for path in attachments {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(path);
    }
    out
}

/// 画面に出る添付の印（設計§7-1）。
///
/// claude は貼り付けから画像を拾うと、入力欄へ `[Image #1]` のようなチップを出す。
/// **番号は当てにしない**——あれはセッションを跨いで通し番号が続く（§21 読み替え1）。
/// 数えるのは**個数だけ**で、何番が付いたかは見ない。
const IMAGE_MARK: &str = "[Image #";

/// 画面に出ている添付の印を数える（設計§7-1）。
///
/// 読む対象は**画面の見た目ではなく印の綴り**にする（PJTガイドライン「端末の表示を
/// 読んで判断するとき」）。装飾は端末の都合で変わるが、綴りは claude が書いたもの
/// なので、揺れるとしたら CLI 側の変更のときだけになる。
///
/// [`super::permission::squeeze`] を通してから照合するのは、**チップが行の折り返しで
/// 割れることがある**ため。空白を全部落とせば、割れても1つの綴りとして当たる。
pub fn count_image_marks(screen: &str) -> usize {
    let plain = squeeze(&strip_ansi(screen)).to_lowercase();
    plain.matches(&squeeze(IMAGE_MARK).to_lowercase()).count()
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
        assert_eq!(body, "\u{15}\u{1b}[200~こんにちは\u{1b}[201~".as_bytes());
        assert_eq!(submit, b"\r");
    }

    #[test]
    fn 単一行もbracketed_pasteで包む() {
        assert_eq!(
            encoded("こんにちは"),
            "\u{15}\u{1b}[200~こんにちは\u{1b}[201~\r"
        );
    }

    #[test]
    fn 長さで送り方を変えない() {
        // 包まずに送ると、本物の TUI が一定量を超える入力を貼り付けと判定し、
        // **末尾の CR まで飲み込んで確定しない**（実測した境目は 57〜64 バイトの間）。
        // 短い側だけ試していると気づけないので、境目をまたぐ2つを並べて固定する
        let short = "0".repeat(48);
        let long = "0".repeat(200);
        assert_eq!(
            encoded(&short),
            format!("\u{15}\u{1b}[200~{short}\u{1b}[201~\r")
        );
        assert_eq!(
            encoded(&long),
            format!("\u{15}\u{1b}[200~{long}\u{1b}[201~\r")
        );
    }

    #[test]
    fn スラッシュコマンドも特別扱いしない() {
        // 実体が本物の CLI なので、そのまま流せば解釈される（要件「あらゆるスラッシュコマンド」）
        assert_eq!(encoded("/rewind"), "\u{15}\u{1b}[200~/rewind\u{1b}[201~\r");
    }

    #[test]
    fn 複数行もbracketed_pasteで包む() {
        assert_eq!(
            encoded("1行目\n2行目"),
            "\u{15}\u{1b}[200~1行目\n2行目\u{1b}[201~\r"
        );
    }

    #[test]
    fn CRLFはLFに揃える() {
        // ブラウザの textarea は環境によって CRLF を送ってくる。素通しすると
        // 貼り付けの中に CR が混ざり、CLI 側で確定と解釈されうる
        assert_eq!(
            encoded("1行目\r\n2行目"),
            "\u{15}\u{1b}[200~1行目\n2行目\u{1b}[201~\r"
        );
    }

    #[test]
    fn 末尾の改行は落とす() {
        assert_eq!(
            encoded("ひとこと\n"),
            "\u{15}\u{1b}[200~ひとこと\u{1b}[201~\r"
        );
        assert_eq!(
            encoded("ひとこと\n\n\n"),
            "\u{15}\u{1b}[200~ひとこと\u{1b}[201~\r"
        );
    }

    #[test]
    fn 空文字はCRだけを送る() {
        // メニューの確定に使う経路。ここで入力行を消しにいくと、選択中の
        // メニューに余計なキーを打ち込むことになる
        assert_eq!(encoded(""), "\r");
        assert_eq!(encoded("\n\n"), "\r");
    }

    #[test]
    fn 送る前に入力行を消す() {
        // 入力欄に残っていると、そこへ追記される。`/rewind` は巻き戻した発言を
        // 入力欄へ戻すので、消さずに送ると「巻き戻した指示＋新しい指示」が1つの
        // 発言として届き、取り消したはずの作業がやり直される（実測）
        let (body, _) = encode_parts("新しい指示");
        assert!(
            body.starts_with(b"\x15"),
            "先頭が kill-line で始まっていない: {body:?}"
        );
    }

    #[test]
    fn 本文のESCは取り除く() {
        // 貼り付けの終了記号を本文から打ち込めないことの確認
        assert_eq!(
            encoded("わるいこ\u{1b}[201~ここは本文"),
            "\u{15}\u{1b}[200~わるいこ[201~ここは本文\u{1b}[201~\r"
        );
    }

    /// 添付つきの見た目。[`encoded`] と同じく、繋げて中身だけを見る。
    fn encoded_with(text: &str, attachments: &[&str]) -> String {
        let owned: Vec<String> = attachments.iter().map(|p| (*p).to_string()).collect();
        let (body, submit) = encode_parts_with(text, &owned);
        String::from_utf8([body, submit].concat()).expect("UTF-8 のまま")
    }

    #[test]
    fn 添付が無ければ従来と1バイトも変わらない() {
        // 添付を使わない送信を巻き添えにしないための約束。ここが崩れると、
        // 画像と関係のない指示の送り方まで変わってしまう
        for text in ["こんにちは", "/rewind", "1行目\n2行目", ""] {
            assert_eq!(
                encode_parts_with(text, &[]),
                encode_parts(text),
                "添付0枚で食い違った: {text:?}"
            );
        }
    }

    #[test]
    fn 添付のパスは本文の後ろへ1行ずつ並ぶ() {
        // 行の途中に置くと claude の貼り付け処理に当たらない（実測・設計§19 前提1）
        assert_eq!(
            encoded_with("この画像を見て", &["/tmp/a.png"]),
            "\u{15}\u{1b}[200~この画像を見て\n/tmp/a.png\u{1b}[201~\r"
        );
    }

    #[test]
    fn 添付が複数でも1行に1つずつ並ぶ() {
        assert_eq!(
            encoded_with("見て", &["/tmp/a.png", "/tmp/b.jpg"]),
            "\u{15}\u{1b}[200~見て\n/tmp/a.png\n/tmp/b.jpg\u{1b}[201~\r"
        );
    }

    #[test]
    fn 添付があっても本文は1文字も変わらない() {
        // 足すのは行の区切りとパスだけ。本文へ手を入れないことを、
        // 添付ありと添付なしの差分が「\n＋パス」ちょうどであることで示す
        let text = "1行目\n2行目　全角空白あり\n3行目";
        let without = encoded(text);
        let with = encoded_with(text, &["/tmp/a.png"]);
        let inserted = with.len() - without.len();
        assert_eq!(
            inserted,
            "\n/tmp/a.png".len(),
            "本文が変わっている: {with:?}"
        );
        assert!(
            with.starts_with(without.trim_end_matches("\u{1b}[201~\r")),
            "本文の前半が変わっている: {with:?}"
        );
    }

    #[test]
    fn 本文が空でも添付だけで送れる() {
        // 画像だけを投げる形。空送信（メニューの確定）とは別物なので、
        // 入力行を消す先頭の kill-line が付くこと
        assert_eq!(
            encoded_with("", &["/tmp/a.png"]),
            "\u{15}\u{1b}[200~/tmp/a.png\u{1b}[201~\r"
        );
    }

    #[test]
    fn 添付が無い空送信は入力行に触らない() {
        // TUI のメニューを確定させる用途。ここで kill-line を打つと選択が壊れる
        let (body, submit) = encode_parts_with("", &[]);
        assert!(body.is_empty(), "空送信で入力行に触っている: {body:?}");
        assert_eq!(submit, b"\r");
    }

    #[test]
    fn 印は枚数ぶん数える() {
        assert_eq!(count_image_marks(""), 0);
        assert_eq!(count_image_marks("なにも出ていない"), 0);
        assert_eq!(count_image_marks("[Image #1]"), 1);
        assert_eq!(count_image_marks("[Image #1] [Image #2] [Image #3]"), 3);
    }

    #[test]
    fn 印の番号は当てにしない() {
        // 番号はセッションを跨いで通し番号が続く（実測・設計§21 読み替え1）。
        // 1枚目が `#8` から始まっても、枚数として数えられること
        assert_eq!(count_image_marks("[Image #8] [Image #27]"), 2);
    }

    #[test]
    fn 印は装飾に埋もれても数える() {
        // 端末は色や位置の指定を挟む。**読むのは見た目ではなく綴り**なので、
        // ESC 列を落としてから数える
        assert_eq!(count_image_marks("\u{1b}[1;36m[Image #1]\u{1b}[0m"), 1);
    }

    #[test]
    fn 印は折り返しで割れても数える() {
        // 入力欄の幅で `[Image #1]` の途中に改行が挟まることがある。空白を
        // 全部落としてから照合するので、割れても1つとして当たる
        assert_eq!(count_image_marks("[Image\n #1]"), 1);
        assert_eq!(count_image_marks("[Ima\r\nge  #2]"), 1);
    }

    #[test]
    fn 利用者が打った印も数に入ってしまう() {
        // **数え方の側では弾けない。** 画面に出ている綴りは、claude が出したチップと
        // まったく同じものである。**これは既知の穴で、直していない**——差し引こうにも、
        // 端末は入力欄を何度も描き直すので**差し引くべき数が分からない**
        // （`core/tests/attachment_send.rs` の `本文が印の綴りを含むと数を多く見る` で
        // 実測してある。本文の印1つが3つに見えた）。
        //
        // ここは**穴があること自体を固定しておく場所**。直し方を思いついた人が、
        // まずここを見て前提を疑えるようにするため
        assert_eq!(count_image_marks("[Image #1] を見て"), 1);
        assert_eq!(count_image_marks("[Image #1] と [Image #2]"), 2);
    }

    #[test]
    fn 添付のパスそのものは印として数えない() {
        // 貼り付けた本文は画面へ echo される。**パスを印と取り違えると、
        // claude が画像を読み終える前に確定してしまう**——この工事が防ぎたい形そのもの
        let echoed = encoded_with("見て", &["/tmp/a.png", "/tmp/b.jpg"]);
        assert_eq!(count_image_marks(&echoed), 0);
    }
}
