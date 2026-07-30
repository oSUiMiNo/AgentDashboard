//! 注入した `statusLine` から起動される `model-post` サブコマンド（設計§4）。
//!
//! セッションに注入する settings（[`crate::session::hooks_settings`]）は、`statusLine` の
//! `command` として **core バイナリ自身**のこのサブコマンドを指定する。`hook-post` と
//! 同じ形なので、配布物は単一バイナリのままで済み、python やシェルの有無に左右されない。
//!
//! # なぜ `statusLine` なのか
//!
//! 「いまどのモデルか」を知る経路が他に無い。既定のフッタにモデル名は出ないので端末を
//! 読んでも取れず、公式のフック仕様で `model` を受け取りうるのは `SessionStart` だけで
//! しかも入っている保証が無い。`statusLine` だけが、**セッションの JSON を標準入力へ
//! 渡してくれる**（設計§11 前提1 で実測。12キーが届き `model.id` と
//! `model.display_name` が入っている）。
//!
//! これで**端末の解析が一切要らなくなる**。生バイト列の空白が消える問題も、折り返しで
//! 語が割れる問題も、制御シーケンスの混入も、まとめて無関係になる。
//!
//! # `hook-post` との違いは1点だけ
//!
//! **標準出力にモデルの表示名を書く。**
//!
//! `hook-post` は「観測専用のフックは標準出力に何も書かない」という約束を守る
//! （終了コード 0 のときの stdout が Claude へのコンテキストとして注入される仕様のため）。
//! しかし `statusLine` の標準出力は**そのまま端末に表示されるだけ**で、会話には混ざらない。
//! むしろ書かないと、その行が空になる。
//!
//! ここに `model.display_name` を出すと2つ得がある。
//!
//! - 端末ペインを見ている人にも、いまのモデルが分かる
//! - **ダッシュボードが落ちていて POST が届かなくても、人が読める形では残る**
//!
//! # 失敗しても終了コードは 0
//!
//! `hook-post` と同じ。ダッシュボードが落ちていることが、CLI 側の動作を妨げてはならない。

use std::io::Read as _;

/// stdin の JSON を POST し、モデルの表示名を標準出力へ書く。
///
/// どこで失敗しても黙って戻る（呼び出し元の `main` が終了コード 0 で終える）。
pub fn run(url: &str) {
    let mut body = String::new();
    if std::io::stdin().read_to_string(&mut body).is_err() {
        return;
    }

    // 先に画面へ出す。POST が失敗しても、人が読める形は残したい
    if let Some(label) = display_name(&body) {
        println!("{label}");
    }

    // 送れなくても CLI の邪魔をしないのが最優先。理由は握り潰す
    let _ = crate::hook_post::post(url, &body);
}

/// `statusLine` の payload から `model.display_name` を取り出す。
///
/// **想定外の形でも落ちない。** 届く JSON は CLI 側の都合で増減するので、
/// 欲しいキーが無ければ何も出さずに済ませる（空行が1行増えるだけ）。
fn display_name(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let label = value.get("model")?.get("display_name")?.as_str()?.trim();
    if label.is_empty() {
        return None;
    }
    // 端末の1行として出るので、改行や制御文字を持ち込ませない
    Some(label.replace(['\r', '\n'], " "))
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    const REAL: &str = r#"{
      "cwd": "/home/example/dev/app",
      "session_id": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      "transcript_path": "/home/example/.claude/projects/app/session.jsonl",
      "model": { "id": "claude-opus-5", "display_name": "Opus 5" },
      "version": "2.1.220"
    }"#;

    #[test]
    fn 実物の形から表示名を取り出せる() {
        // 設計§11 前提1 で実測した形
        assert_eq!(display_name(REAL).as_deref(), Some("Opus 5"));
    }

    #[test]
    fn 表示名には版番号が入る() {
        // 版番号をこちらの表で管理しないための要（設計§12）。
        // ここが id 側になっていると `claude-opus-5` と出てしまう
        let body = r#"{"model":{"id":"claude-haiku-4-5-20251001","display_name":"Haiku 4.5"}}"#;
        assert_eq!(display_name(body).as_deref(), Some("Haiku 4.5"));
    }

    #[test]
    fn 想定外のJSONでも落ちない() {
        // 届く JSON は CLI 側の都合で増減する。欲しいキーが無ければ黙る
        assert_eq!(display_name("{}"), None);
        assert_eq!(display_name(r#"{"model":null}"#), None);
        assert_eq!(display_name(r#"{"model":{"id":"x"}}"#), None);
        assert_eq!(display_name(r#"{"model":{"display_name":123}}"#), None);
        assert_eq!(display_name("これは JSON ではない"), None);
        assert_eq!(display_name(""), None);
    }

    #[test]
    fn 空の表示名は出さない() {
        assert_eq!(display_name(r#"{"model":{"display_name":"  "}}"#), None);
    }

    #[test]
    fn 改行を含む表示名でも1行に収める() {
        // 端末の1行として出るので、勝手に行を増やさせない
        let body = r#"{"model":{"display_name":"Opus\n5"}}"#;
        assert_eq!(display_name(body).as_deref(), Some("Opus 5"));
    }
}
