//! セッション専用の settings を生成してフックを注入する（設計§7）。
//!
//! Claude Code の `--settings` は「**追加で**読み込む設定ファイル」を指すオプションで、
//! 利用者のグローバル設定（`~/.claude/settings.json`）を書き換えない。ダッシュボードが
//! 起動したセッションにだけフックを効かせられるので、要件の「グローバル設定を汚さない」を
//! そのまま満たせる。
//!
//! # フックが起動するのは core バイナリ自身
//!
//! 専用のシェルスクリプトは置かず、`<core実行ファイル> hook-post --url <宛先>` を
//! フックの `command` に書く（[`crate::hook_post`]）。配布物が単一バイナリのままで済み、
//! python やシェルの有無に左右されない。
//!
//! # `"async": true` を付ける理由
//!
//! フックが CLI の実行をブロックしないことを、自前の投げっぱなし実装ではなく**公式の
//! 非同期モード**で保証する。ダッシュボードが落ちていてもセッションが止まらない。
//!
//! # フック以外に2つ注入する（設計§4・§6）
//!
//! | キー | 何のため |
//! |---|---|
//! | `statusLine` | **いま動いているモデルを CLI に送らせる**唯一の経路。既定のフッタにモデル名は出ないので、端末を読んでも取れない |
//! | `model` | ダッシュボードが起こすセッションを、**利用者の既定モデルで始める**ため |
//!
//! `model` を注入するのが効くのは、`--settings` がコマンドライン引数の層にあり
//! **user 層のグローバル設定より優先される**から（設計§11 前提4 で実測）。これで
//! 「1つのセッションで切り替えたら、次に起こしたセッションもそのモデルで始まる」
//! という連動（要件が心配している経路3）を、汚染の回復より先に断てる。

use crate::state::HookEvent;
use protocol::{CardId, ModelId};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// フックが起動する実行ファイルを差し替えるための環境変数。
///
/// 既定は自分自身（`std::env::current_exe()`）。
///
/// # もとはテスト用、いまは製品の経路でも使う
///
/// 元の理由は統合テストで、core が**ライブラリとして**動くため `current_exe()` が
/// テストバイナリを指してしまう、というものだった。
///
/// 版の切替（CICD設計§5）が入ってからは、**製品の経路でも常用する**。乗り換えると
/// `current_exe()` が保管庫の版フォルダを指すので、そのまま焼き込むと**版を消した瞬間に
/// 生きているセッションのフックが全滅する**。しかもフックは `"async": true` で呼ばれる
/// ため claude は止まらず、状態だけが更新されなくなって「作業中のまま固まる」になる。
///
/// そこで乗り換えるとき、**乗り換える前の自分**（＝入れる側が置いた入口。版が変わっても
/// 消えない）をここへ入れて渡す。既に立っていれば上書きしない。
pub const HOOK_BIN_ENV: &str = "AGENTDASHBOARD_HOOK_BIN";

/// 生成したセッション専用 settings の置き場所と認証トークン。
#[derive(Debug, Clone)]
pub struct HookSettings {
    /// セッションごとの一時ディレクトリ。カードを消すときにまるごと削除する
    pub dir: PathBuf,
    /// `--settings` へ渡すファイル
    pub path: PathBuf,
    /// 受信URLに埋め込む、このセッション限りの合言葉
    pub token: String,
}

/// フックが起動する実行ファイルを決める。
pub fn hook_program() -> PathBuf {
    hook_program_from(
        std::env::var(HOOK_BIN_ENV).ok(),
        std::env::current_exe().ok(),
    )
}

/// 決め方（材料を受け取る純粋関数）。
///
/// 分けてあるのは、テストが環境変数を書き換えずに両方の道を通せるようにするため。
/// **どちらの道も製品で通る**（乗り換えると指定側、乗り換えなければ自分自身）。
pub fn hook_program_from(configured: Option<String>, current_exe: Option<PathBuf>) -> PathBuf {
    if let Some(path) = configured.filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }
    current_exe.unwrap_or_else(|| PathBuf::from("agentdashboard"))
}

/// セッション限りのランダムなトークンを作る。
pub fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// フックの `command` に書く1行を組み立てる。
///
/// フックはシェル経由で実行されるため、空白を含むパスでも壊れないように引用符で包む。
fn command_line(program: &Path, port: u16, token: &str, event: HookEvent) -> String {
    format!(
        "{} hook-post --url http://127.0.0.1:{port}/hook/{token}/{}",
        shell_quote(&program.to_string_lossy()),
        event.as_str(),
    )
}

/// ログへ出す用の宛先の形。**合言葉は載せない**（設計§9-3）。
///
/// [`command_line`] の隣に置くのは、宛先の形を変えたときに**両方が同時に目に入る**
/// ようにするため。片方だけ動くと、ログの1行が実際とは違う場所を指す。
///
/// 切り分けに要るのは**ポート番号**（焼き込んだ先と受けている場所が一致するか）なので、
/// 合言葉が伏せてあっても材料としての価値は落ちない。
pub fn hook_url_shape(port: u16) -> String {
    format!("http://127.0.0.1:{port}/hook/<token>/<event>")
}

/// `statusLine` の `command` に書く1行を組み立てる。
///
/// 宛先の合言葉は**フックと同じものを使い回す**。セッション限りのランダム値であること
/// が要件なので、経路ごとに別々に持つ意味が無い。
fn status_line_command(program: &Path, port: u16, token: &str) -> String {
    format!(
        "{} model-post --url http://127.0.0.1:{port}/model/{token}",
        shell_quote(&program.to_string_lossy()),
    )
}

/// シングルクォートで包む（POSIX シェルの作法）。
fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// 注入する settings に足す、フック以外の設定（設計§4・§6）。
#[derive(Debug, Clone, Default)]
pub struct ModelInjection {
    /// `statusLine` を入れるか。`false` ならモデルは「不明」のままになる
    pub status_line: bool,
    /// `statusLine` の `refreshInterval`（秒）。CLI 側の最小は1
    pub refresh_secs: u64,
    /// 起動時のモデル。`None` なら**キーごと入れない**
    ///
    /// 利用者がグローバル設定でモデルを指定していない状態を、そのまま再現するため。
    /// ここで勝手に既定値を補うと、指定していない人にこちらの都合を押し付けることになる。
    pub model: Option<ModelId>,
}

/// 注入する settings の中身を組み立てる。
///
/// ファイル操作から切り離してあるので、生成される JSON の形をテストで直接確かめられる。
pub fn build_settings(program: &Path, port: u16, token: &str, injection: &ModelInjection) -> Value {
    let mut hooks = serde_json::Map::new();
    for event in HookEvent::ALL {
        let command = json!({
            "type": "command",
            "command": command_line(program, port, token, event),
            // 公式の非同期モード。CLI はフックの完了を待たない
            "async": true,
        });
        let mut entry = serde_json::Map::new();
        if event.takes_matcher() {
            // ツールに紐づくイベントだけが matcher を取る。全ツールを対象にする
            entry.insert("matcher".to_string(), json!("*"));
        }
        entry.insert("hooks".to_string(), json!([command]));
        hooks.insert(event.as_str().to_string(), json!([Value::Object(entry)]));
    }
    let mut settings = serde_json::Map::new();
    settings.insert("hooks".to_string(), Value::Object(hooks));

    if injection.status_line {
        settings.insert(
            "statusLine".to_string(),
            json!({
                "type": "command",
                "command": status_line_command(program, port, token),
                // モデル変更は statusLine の契機に入っていない（設計§11 前提6）。
                // 切り替えた結果がここに反映されるまでの時間は、事実上この値で決まる
                "refreshInterval": injection.refresh_secs.max(1),
            }),
        );
    }
    if let Some(model) = &injection.model {
        settings.insert("model".to_string(), json!(model.as_str()));
    }

    Value::Object(settings)
}

/// セッション専用の settings をディスクへ書き出す。
pub fn write(
    card_id: CardId,
    port: u16,
    program: &Path,
    injection: &ModelInjection,
) -> anyhow::Result<HookSettings> {
    let dir = std::env::temp_dir()
        .join("agentdashboard")
        .join(card_id.to_string());
    std::fs::create_dir_all(&dir)?;

    let token = new_token();
    let path = dir.join("settings.json");
    let settings = build_settings(program, port, &token, injection);
    std::fs::write(&path, serde_json::to_vec_pretty(&settings)?)?;

    Ok(HookSettings { dir, path, token })
}

/// セッションが消えるときに一時ディレクトリを片付ける。
pub fn cleanup(settings: &HookSettings) {
    // 消せなくても実害は無い（一時ディレクトリなので）。起動の失敗と混同させないため握り潰す
    let _ = std::fs::remove_dir_all(&settings.dir);
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn injection() -> ModelInjection {
        ModelInjection {
            status_line: true,
            refresh_secs: 3,
            model: Some(ModelId::new("claude-fable-5[1m]")),
        }
    }

    #[test]
    fn 指定があればそちらを焼き込む() {
        // 版を切り替えると `current_exe()` は保管庫の版フォルダを指す。そのまま
        // 焼き込むと、**版を消した瞬間に生きているセッションのフックが全滅する**
        // （CICD設計§5）。乗り換える側が「消えない入口」をここへ渡す
        assert_eq!(
            hook_program_from(
                Some("/home/x/.local/bin/agentdashboard".to_string()),
                Some(PathBuf::from("/state/versions/0.2.0/agentdashboard")),
            ),
            PathBuf::from("/home/x/.local/bin/agentdashboard")
        );
    }

    #[test]
    fn 指定が無ければ自分自身を焼き込む() {
        assert_eq!(
            hook_program_from(None, Some(PathBuf::from("/opt/agentdashboard"))),
            PathBuf::from("/opt/agentdashboard")
        );
        // 自分の場所すら分からないときは PATH 頼み。**フックが黙って落ちるよりはよい**
        assert_eq!(
            hook_program_from(Some(String::new()), None),
            PathBuf::from("agentdashboard")
        );
    }

    fn settings() -> Value {
        build_settings(
            Path::new("/opt/agent dashboard/bin"),
            8787,
            "とーくん",
            &injection(),
        )
    }

    #[test]
    fn 注入するイベントがすべてsettingsへ現れる() {
        let value = settings();
        let hooks = value["hooks"].as_object().expect("hooks があること");
        assert_eq!(hooks.len(), HookEvent::ALL.len());
        for event in HookEvent::ALL {
            assert!(
                hooks.contains_key(event.as_str()),
                "{} が抜けている",
                event.as_str()
            );
        }
    }

    #[test]
    fn 全フックが非同期モードで観測専用の入口を叩く() {
        let value = settings();
        for event in HookEvent::ALL {
            let command = &value["hooks"][event.as_str()][0]["hooks"][0];
            assert_eq!(command["type"], "command");
            assert_eq!(
                command["async"],
                true,
                "{} が同期実行になっている",
                event.as_str()
            );

            let line = command["command"].as_str().expect("コマンド行があること");
            assert!(line.contains("hook-post --url "), "実際: {line}");
            assert!(
                line.ends_with(&format!("/hook/とーくん/{}", event.as_str())),
                "実際: {line}"
            );
            assert!(
                line.contains("http://127.0.0.1:8787/"),
                "ループバック以外へ送ってはいけない: {line}"
            );
        }
    }

    #[test]
    fn 空白を含むパスでも壊れない() {
        let value = settings();
        let line = value["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(
            line.starts_with("'/opt/agent dashboard/bin' "),
            "実際: {line}"
        );
    }

    #[test]
    fn matcherはツール系イベントにだけ付く() {
        let value = settings();
        for event in HookEvent::ALL {
            let entry = &value["hooks"][event.as_str()][0];
            if event.takes_matcher() {
                assert_eq!(entry["matcher"], "*", "{}", event.as_str());
            } else {
                assert!(
                    entry.get("matcher").is_none(),
                    "{} に matcher を書いてはいけない",
                    event.as_str()
                );
            }
        }
    }

    #[test]
    fn トークンは毎回異なる() {
        let first = new_token();
        let second = new_token();
        assert_ne!(first, second);
        assert!(first.len() >= 32, "推測しにくい長さであること: {first}");
    }

    #[test]
    fn 書き出したsettingsは読み直せる() {
        let card_id = CardId::new();
        let written = write(
            card_id,
            9999,
            Path::new("/usr/local/bin/agentdashboard"),
            &injection(),
        )
        .expect("書き出せること");
        assert!(written.path.is_file());

        let text = std::fs::read_to_string(&written.path).unwrap();
        let parsed: Value = serde_json::from_str(&text).expect("JSON として読めること");
        assert_eq!(
            parsed["hooks"].as_object().unwrap().len(),
            HookEvent::ALL.len()
        );
        assert!(
            parsed["hooks"]["Stop"][0]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains(&written.token)
        );

        cleanup(&written);
        assert!(!written.dir.exists(), "片付けで消えること");
    }

    #[test]
    fn statusLineはフックと同じ合言葉でモデルの受信口を叩く() {
        let value = settings();
        let line = value["statusLine"]["command"]
            .as_str()
            .expect("コマンド行があること");
        assert_eq!(value["statusLine"]["type"], "command");
        assert!(line.contains("model-post --url "), "実際: {line}");
        assert!(line.ends_with("/model/とーくん"), "実際: {line}");
        assert!(
            line.contains("http://127.0.0.1:8787/"),
            "ループバック以外へ送ってはいけない: {line}"
        );
        // フックと同じ作法。空白を含むパスで壊れない
        assert!(
            line.starts_with("'/opt/agent dashboard/bin' "),
            "実際: {line}"
        );
    }

    #[test]
    fn statusLineの再実行間隔が入る() {
        assert_eq!(settings()["statusLine"]["refreshInterval"], 3);
    }

    #[test]
    fn 再実行間隔は1秒を下回らない() {
        // CLI 側の最小が1。0 を渡して黙って無効化されると、モデルが更新されなくなる
        let value = build_settings(
            Path::new("/bin/x"),
            1,
            "t",
            &ModelInjection {
                status_line: true,
                refresh_secs: 0,
                model: None,
            },
        );
        assert_eq!(value["statusLine"]["refreshInterval"], 1);
    }

    #[test]
    fn 覚えている利用者の既定がmodelとして入る() {
        assert_eq!(settings()["model"], "claude-fable-5[1m]");
    }

    #[test]
    fn 既定が無ければmodelキーごと入れない() {
        // 利用者が指定していない状態を、そのまま再現する（設計§6）
        let value = build_settings(
            Path::new("/bin/x"),
            1,
            "t",
            &ModelInjection {
                status_line: true,
                refresh_secs: 3,
                model: None,
            },
        );
        assert!(
            value.get("model").is_none(),
            "指定していない人にこちらの都合を押し付けない: {value}"
        );
    }

    #[test]
    fn statusLineを切ってもフックの注入は影響を受けない() {
        // 自分の statusLine を優先したい人のための逃げ道（設計§4）。
        // ここでフックまで消えると、状態表示が丸ごと死ぬ
        let value = build_settings(
            Path::new("/bin/x"),
            1,
            "t",
            &ModelInjection {
                status_line: false,
                refresh_secs: 3,
                model: Some(ModelId::new("opus")),
            },
        );
        assert!(value.get("statusLine").is_none());
        assert_eq!(
            value["hooks"].as_object().unwrap().len(),
            HookEvent::ALL.len()
        );
        assert_eq!(value["model"], "opus", "model の注入は statusLine とは独立");
    }
}
