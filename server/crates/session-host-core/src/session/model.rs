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

/// CLI が名乗ったフルIDが、送った別名で説明が付くか（設計§12）。
///
/// **別名の語幹が、名乗られたフルIDに含まれるか**を見るだけ。
///
/// | 別名 | 名乗り | 判定 | |
/// |---|---|---|---|
/// | `opus` | `claude-opus-5` | 説明が付く | |
/// | `opus[1m]` | `claude-opus-5` | 説明が付く | 角括弧より前で見る |
/// | `haiku` | `claude-haiku-4-5-20251001` | 説明が付く | 日付が付いていても通る |
/// | `claude-opus-5` | `claude-opus-5` | 説明が付く | フルIDを直に指定した場合 |
/// | `opus` | `claude-sonnet-5` | **付かない** | 要求と無関係に CLI が乗り換えた形 |
/// | `opusplan` / `default` / `best` | 何であれ | **付かない** | 特定のモデル1つを指す別名ではない |
///
/// # なぜ要るのか
///
/// 「切替を要求している間にモデルが動いたら、それは要求の結果」とみなすと、CLI が
/// 自分の都合で変えたもの（利用制限のフォールバック、`opusplan` がプランから実行へ
/// 移る等）まで要求の結果として扱ってしまう。**`opus → Sonnet 5` を覚えると、
/// 選択肢の Opus 行が「Sonnet 5」と表示される**。
///
/// # 説明が付かない別名を切り捨てても、画面は何も失わない
///
/// `default` / `best` / `opusplan` は解決先が状況で変わるので、**そもそも実測値を
/// 表示に使っていない**（`web/src/lib/models.ts` の `ModelInfo.fixed`）。学習の対象から
/// 外れても選択肢のラベルは変わらない。
///
/// 将来この語幹の作法から外れた ID が出たら、その別名が学習されなくなるだけで、
/// 選択肢は CLI の対応表からの推測へ落ちる。壊れずに退化する。
pub fn id_matches_alias(alias: &ModelId, id: &ModelId) -> bool {
    let stem = base_name(alias).to_ascii_lowercase();
    if stem.is_empty() {
        return false;
    }
    id.as_str().to_ascii_lowercase().contains(&stem)
}

/// 角括弧の修飾（`[1m]` など）を落とした部分。
fn base_name(model: &ModelId) -> &str {
    model
        .as_str()
        .split_once('[')
        .map_or(model.as_str(), |(base, _)| base)
}

/// 選んだ別名が、いま効いているものと同じか。
///
/// 同じなら送らない。無駄に `/model` を送ると、会話が進んでいる場合に確認画面が
/// 出てきて、利用者が何も変えていないのに操作を求められる。
///
/// # 比べるのは別名どうし。フルIDでは足りない
///
/// **違う別名が同じフルIDへ落ちることがある**（`opus` と `opus[1m]`、`sonnet` と
/// 実行フェーズの `opusplan`）。解決先だけで比べると、その組の間を移動しようとしても
/// 「もう目的のモデル」と判定されて**無言で無視される**。利用者から見ると
/// 「選んでも戻る」になる。
///
/// | 状況 | 判定 |
/// |---|---|
/// | `current` が不明 | **送る**（分からないので確かめようがない） |
/// | `target` と `current` が同じ文字列 | 送らない（フルIDを直に指定した場合） |
/// | 別名が分かっていて、`target` と違う | **送る** |
/// | 別名が分かっていて `target` と同じ、かつ名乗りと辻褄が合う | 送らない |
/// | 別名が分かっていて `target` と同じ、だが名乗りと辻褄が合わない | **送る** |
/// | 別名が分からない | 解決先どうしで比べる |
///
/// 最後から2番目の行が要る理由は、**要求の裏で CLI が別のモデルへ乗り換えることが
/// ある**から。「別名が同じ」だけを根拠に送らないと、乗り換えられたあと同じ別名を
/// 選び直しても二度と戻れなくなる。
///
/// 迷ったら送る側に倒している。送って同じだった場合の害は小さい（切り替わらないだけ）
/// が、送らずに切り替わらないと「押したのに反応しない」になる。
pub fn is_already_current(
    target: &ModelId,
    in_effect: Option<&ModelId>,
    resolved: Option<&ModelId>,
    current: Option<&ModelId>,
) -> bool {
    let Some(current) = current else {
        return false;
    };
    if target == current {
        return true;
    }
    match in_effect {
        Some(in_effect) => in_effect == target && report_explains(target, resolved, current),
        // どの別名で動いているか分からない。解決先で比べるしかない
        None => resolved == Some(current),
    }
}

/// CLI が名乗っている値が、その別名で説明が付くか。
///
/// 覚えている解決先と一致するか、語幹で説明が付くか（[`id_matches_alias`]）のどちらか。
/// 実測を先に見るのは、そちらが**この環境で実際に起きたこと**だから。
pub fn report_explains(alias: &ModelId, resolved: Option<&ModelId>, id: &ModelId) -> bool {
    resolved == Some(id) || id_matches_alias(alias, id)
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
    fn 名乗りが別名を説明するかを語幹で見る() {
        for (alias, reported) in [
            ("opus", "claude-opus-5"),
            ("opus[1m]", "claude-opus-5"),
            ("sonnet[1m]", "claude-sonnet-5"),
            ("haiku", "claude-haiku-4-5-20251001"),
            ("claude-opus-5", "claude-opus-5"),
            ("OPUS", "claude-opus-5"),
        ] {
            assert!(
                id_matches_alias(&id(alias), &id(reported)),
                "{alias} は {reported} で説明が付くこと"
            );
        }
    }

    #[test]
    fn 要求と食い違う名乗りは説明が付かない() {
        // **C-1 が捕まえたい形。** 要求の裏で CLI が乗り換えたものを、要求の結果として
        // 覚えると `opus → Sonnet 5` が永続化される
        assert!(!id_matches_alias(&id("opus"), &id("claude-sonnet-5")));
    }

    #[test]
    fn 特定のモデルを指さない別名は説明が付かない() {
        // 解決先が状況で変わる3つ。実測1回で決めつけると嘘になる
        assert!(!id_matches_alias(&id("default"), &id("claude-sonnet-5")));
        assert!(!id_matches_alias(&id("best"), &id("claude-fable-5")));
        assert!(!id_matches_alias(&id("opusplan"), &id("claude-opus-5")));
    }

    #[test]
    fn いまのモデルが分からないときは送る() {
        // 確かめようがないので送る。送らずに切り替わらないほうが困る
        assert!(!is_already_current(&id("opus"), None, None, None));
        assert!(!is_already_current(
            &id("opus"),
            Some(&id("opus")),
            Some(&id("claude-opus-5")),
            None
        ));
    }

    #[test]
    fn 別名が違えば解決先が同じでも送る() {
        // **B-2。** `opus` と `opus[1m]` はどちらも `claude-opus-5` へ落ちる。
        // 解決先だけで比べると、この組の間を移動できない
        assert!(!is_already_current(
            &id("opus"),
            Some(&id("opus[1m]")),
            Some(&id("claude-opus-5")),
            Some(&id("claude-opus-5")),
        ));
    }

    #[test]
    fn 同じ別名を選び直したときは送らない() {
        assert!(is_already_current(
            &id("opus"),
            Some(&id("opus")),
            Some(&id("claude-opus-5")),
            Some(&id("claude-opus-5")),
        ));
    }

    #[test]
    fn 別名は同じでも名乗りと辻褄が合わなければ送る() {
        // 要求の裏で CLI が Sonnet へ乗り換えた状態。ここで送らないと、
        // 利用者が Opus を選び直しても二度と戻れない
        assert!(!is_already_current(
            &id("opus"),
            Some(&id("opus")),
            None,
            Some(&id("claude-sonnet-5")),
        ));
    }

    #[test]
    fn 別名の解決先が一致していれば送らない() {
        // 送る値は別名、CLI が名乗る値はフルID。文字列は一致しないので、
        // 覚えている解決先どうしで比べる（いまの別名が分からないときの道筋）
        assert!(is_already_current(
            &id("opus"),
            None,
            Some(&id("claude-opus-5")),
            Some(&id("claude-opus-5")),
        ));
    }

    #[test]
    fn 別名を覚えていなければ送る() {
        assert!(!is_already_current(
            &id("opus"),
            None,
            None,
            Some(&id("claude-opus-5"))
        ));
    }

    #[test]
    fn 解決先が違えば送る() {
        assert!(!is_already_current(
            &id("sonnet"),
            None,
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
