//! モデル切替の判断材料（設計§5）。
//!
//! ファイルシステムにも端末にも触らない純粋な関数だけを置く。実際に送るのは
//! [`super::Session::request_model`] で、こちらはその判断を単体で試せるようにしたもの。
//!
//! # 送る値と返る値は一致しない
//!
//! 送るのは切り替え先の**別名**（`opus`）だが、CLI が名乗り返すのは**フルID**
//! （`claude-opus-5`）である。文字列を直接比べても永久に一致しないので、
//! 「もう目的のモデルか」の判定には**別名の解決先を実測から覚えたもの**が要る。

use protocol::ModelId;

use super::permission::{squeeze, strip_ansi};

/// 会話が進んだ状態でモデルを変えようとしたときに出る確認画面の目印（設計§11）。
///
/// 実測した画面はこう出る。
///
/// ```text
/// Switch model?
/// Your next response will be slower and use more tokens
///
/// This conversation is cached for the current model. Switching to Sonnet 5 means
/// the full history gets re-read on your next message.
///
/// ❯ 1. Yes, switch to Sonnet 5
///   2. No, go back
/// ```
///
/// 目印を複数持つのは、**文言が変わっても1つ当たれば気づける**ようにするため。
/// 全部外れても害は無い（確認に答えないだけで、利用者がターミナルビューから答えられる）。
///
/// 照合は [`squeeze`] を通してから行う。生のバイト列では語間の空白が消えるため。
pub const SWITCH_CONFIRM_MARKERS: &[&str] = &[
    "switch model?",
    "gets re-read",
    "cached for the current model",
];

/// 端末の内容が、モデル切替の確認画面かどうか。
pub fn looks_like_confirmation(screen: &str) -> bool {
    let plain = squeeze(&strip_ansi(screen)).to_lowercase();
    SWITCH_CONFIRM_MARKERS
        .iter()
        .any(|marker| plain.contains(&squeeze(marker).to_lowercase()))
}

/// TUI へ送る1行を組み立てる。
///
/// 送るのはこれだけ。実際の書き込みは [`super::Session::send_instruction`] が担う
/// （入力行を空にする・bracketed paste で包む・確定を別に送る、の3点が要る。
/// PJTガイドライン「送る経路は `Session::send_instruction` に集約する」）。
pub fn switch_command(target: &ModelId) -> String {
    format!("/model {target}")
}

/// 切替先として送ってよい長さの上限。
///
/// 実在する中でいちばん長いのは `claude-haiku-4-5-20251001` の24文字なので、
/// 倍以上の余裕がある。将来モデル名が伸びても当分は当たらない。
pub const TARGET_MAX_LEN: usize = 64;

/// 切替先として受け取ってよい値か。駄目なら**理由**を返す。
///
/// # なぜ許可リストにできないのか
///
/// [`ModelId`] を列挙型にしなかったのと同じ理由で、**知らない値も運べないといけない**
/// （利用者が端末でフルIDを打つ、新しいモデルが出る、など）。そこで「これは駄目」と
/// 言えるものだけを拒否する。
///
/// # なぜ検査が要るのか
///
/// 切替先はそのまま `/model <値>` になり、bracketed paste で入力欄へ貼られたあと
/// CR で確定される。[`super::input`] が本文から落とすのは ESC だけで**改行は残る**ので、
/// `sonnet\n（任意の指示）` を渡すと**全体が1つのプロンプトとして送信される**。
/// 選択肢から選ぶ画面ではまず起きないが、値を運ぶ口（`SetModel`）は誰でも叩ける。
pub fn target_problem(target: &ModelId) -> Option<String> {
    let value = target.as_str();
    if value.is_empty() {
        return Some("空です".to_string());
    }
    // 改行・タブ・ESC をまとめて落とす。空白も混ぜないのは、`/model` の引数が
    // そこで切れて別の意味になるため（実在のモデル名に空白は入らない）
    if value.chars().any(|ch| ch.is_control() || ch == ' ') {
        return Some("空白や制御文字が入っています".to_string());
    }
    let length = value.chars().count();
    if length > TARGET_MAX_LEN {
        return Some(format!(
            "長すぎます（{length} 文字。上限は {TARGET_MAX_LEN} 文字）"
        ));
    }
    None
}

/// 選んだ別名が、いま動いているモデルと同じものを指しているか。
///
/// 同じなら送らない。無駄に `/model` を送ると、会話が進んでいる場合に確認画面が
/// 出てきて、利用者が何も変えていないのに操作を求められる。
///
/// | `current`（CLI が名乗った値） | `resolved`（別名の解決先として覚えている値） | 判定 |
/// |---|---|---|
/// | 不明 | — | **送る**（分からないので確かめようがない） |
/// | `target` と同じ文字列 | — | 送らない（フルIDを直に指定した場合） |
/// | あり | `current` と同じ | 送らない |
/// | あり | 覚えていない／違う | **送る** |
///
/// 迷ったら送る側に倒している。送って同じだった場合の害は小さい（切り替わらないだけ）
/// が、送らずに切り替わらないと「押したのに反応しない」になる。
pub fn is_already_current(
    target: &ModelId,
    resolved: Option<&ModelId>,
    current: Option<&ModelId>,
) -> bool {
    let Some(current) = current else {
        return false;
    };
    if target == current {
        return true;
    }
    resolved == Some(current)
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn id(value: &str) -> ModelId {
        ModelId::new(value)
    }

    #[test]
    fn 送るのはmodelコマンドの1行() {
        assert_eq!(switch_command(&id("opus")), "/model opus");
        assert_eq!(switch_command(&id("opus[1m]")), "/model opus[1m]");
    }

    #[test]
    fn 普通の切替先はそのまま通す() {
        // 知らない値も運べることが前提（列挙型にしなかった理由そのもの）
        for value in [
            "opus",
            "sonnet",
            "default",
            "opus[1m]",
            "claude-haiku-4-5-20251001",
            "まだ存在しないモデル",
            &"a".repeat(TARGET_MAX_LEN),
        ] {
            assert_eq!(target_problem(&id(value)), None, "{value} は通ること");
        }
    }

    #[test]
    fn 改行を含む切替先は弾く() {
        // **本イシューでいちばん重要な1本。** 改行が残ると `/model` の行がそこで切れ、
        // 続きが本物の Claude への指示として確定される
        assert!(target_problem(&id("sonnet\n悪意ある指示")).is_some());
        assert!(target_problem(&id("sonnet\r\n悪意ある指示")).is_some());
    }

    #[test]
    fn 制御文字や空白を含む切替先は弾く() {
        assert!(target_problem(&id("sonnet\u{1b}[201~")).is_some());
        assert!(target_problem(&id("sonnet\tx")).is_some());
        assert!(target_problem(&id("sonnet --dangerously-skip-permissions")).is_some());
    }

    #[test]
    fn 空や長すぎる切替先は弾く() {
        assert!(target_problem(&id("")).is_some());
        assert!(target_problem(&id(&"a".repeat(TARGET_MAX_LEN + 1))).is_some());
    }

    #[test]
    fn いまのモデルが分からないときは送る() {
        // 確かめようがないので送る。送らずに切り替わらないほうが困る
        assert!(!is_already_current(&id("opus"), None, None));
        assert!(!is_already_current(
            &id("opus"),
            Some(&id("claude-opus-5")),
            None
        ));
    }

    #[test]
    fn 別名の解決先が一致していれば送らない() {
        // 送る値は別名、CLI が名乗る値はフルID。文字列は一致しないので、
        // 覚えている解決先どうしで比べる
        assert!(is_already_current(
            &id("opus"),
            Some(&id("claude-opus-5")),
            Some(&id("claude-opus-5")),
        ));
    }

    #[test]
    fn 別名を覚えていなければ送る() {
        assert!(!is_already_current(
            &id("opus"),
            None,
            Some(&id("claude-opus-5"))
        ));
    }

    #[test]
    fn 解決先が違えば送る() {
        assert!(!is_already_current(
            &id("sonnet"),
            Some(&id("claude-sonnet-5")),
            Some(&id("claude-opus-5")),
        ));
    }

    #[test]
    fn フルIDを直に指定した場合は文字列で一致する() {
        // 利用者が端末で `/model claude-opus-5` と打った後など
        assert!(is_already_current(
            &id("claude-opus-5"),
            None,
            Some(&id("claude-opus-5")),
        ));
    }

    #[test]
    fn 確認画面を目印で見分ける() {
        let screen = "\
  Switch model?
  Your next response will be slower and use more tokens

  This conversation is cached for the current model. Switching to Sonnet 5 means
  the full history gets re-read on your next message.

  ❯ 1. Yes, switch to Sonnet 5
    2. No, go back
";
        assert!(looks_like_confirmation(screen));
    }

    #[test]
    fn 語間の空白が消えていても見分けられる() {
        // 生のバイト列では TUI が語ごとに書くので空白が落ちる（設計§11）。
        // 画面で見えている形のまま照合すると、単体テストは通るのに実物で一致しない
        assert!(looks_like_confirmation("Switchmodel?"));
        assert!(looks_like_confirmation("\u{1b}[32mSwitch\u{1b}[0m model?"));
    }

    #[test]
    fn 普通の画面は確認画面と間違えない() {
        assert!(!looks_like_confirmation(
            "⏵⏵ accept edits on\n> どうしますか"
        ));
        assert!(!looks_like_confirmation(""));
    }
}
