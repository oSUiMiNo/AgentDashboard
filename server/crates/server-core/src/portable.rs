//! アカウントの設定をファイルへ持ち出す（持ち出し設計§7〜§10）。
//!
//! # ここは解析と検査だけ
//!
//! **記録には触らない。** 書くのは既存の道（[`crate::db::settings::put_intervals`] と
//! [`crate::gateway::SessionHostHub::set_intervals`]）を通す（同§12）。読み込みのためだけの
//! 書き込み経路を作ると、**接続中の PC へ配り直す処理がそちらにだけ無い**という食い違いが
//! 生まれる。
//!
//! # 何を持ち出すかは、選び方で決める
//!
//! 対象は [`crate::db::settings::ACCOUNT_KEYS`]——**アカウントスコープの表そのもの**。
//! 1つずつ「これは秘密か」を判定して除くのではなく、秘密が置かれない場所から取る。
//! LAN パスワードも更新確認もサーバ全体スコープにあるので、構造的に入りようが無い。
//!
//! # 形を変えて、設定ファイルと区別する
//!
//! JSON にしてあるのは `config.toml` と見分けが付かなくなるのを避けるため（同§8）。
//! 拡張子も書式も同じものが2種類あると、取り違えて設定ファイルの場所へ置く人が出る。

use crate::db::settings::{self, Intervals};
use serde::Serialize;
use std::collections::BTreeMap;

/// 何のファイルかを名乗る印。**中身を解釈する前にこれで断れる。**
pub const KIND: &str = "agentdashboard-settings";

/// この形の版。将来キーの意味を変えるときに要る。
///
/// **古い番号は受け続ける**（キーが減っているだけなので「知らないキーは無視」で
/// 吸収できる）。自分より新しい番号だけを断る。
pub const FORMAT: u32 = 1;

/// 書き出す中身（持ち出し設計§8）。
#[derive(Debug, Serialize)]
pub struct Exported {
    pub kind: &'static str,
    pub format: u32,
    /// 書き出したサーバの版。**参考情報で、読み込みでは見ない**
    pub exported_by: String,
    pub settings: BTreeMap<String, serde_json::Value>,
}

/// いまの値から書き出す形を組み立てる。
///
/// **行が無い設定も、埋めた値で書き出す**（同§7）。行があるものだけを書き出すと、
/// 別のアカウントで読み込んだときに向こうの既存の値が残り、画面が一致しない。
pub fn exported(
    intervals: Intervals,
    always_bypass: bool,
    project_autostart: bool,
    exported_by: &str,
) -> Exported {
    Exported {
        kind: KIND,
        format: FORMAT,
        exported_by: exported_by.to_string(),
        settings: BTreeMap::from([
            (
                settings::ALWAYS_BYPASS_PERMISSIONS.to_string(),
                serde_json::json!(always_bypass),
            ),
            (
                settings::PROJECT_AUTOSTART_SESSION.to_string(),
                serde_json::json!(project_autostart),
            ),
            (
                settings::SYNC_INTERVAL_SECS.to_string(),
                serde_json::json!(intervals.sync_interval_secs),
            ),
            (
                settings::SCREEN_INTERVAL_MS.to_string(),
                serde_json::json!(intervals.screen_interval_ms),
            ),
            (
                settings::SCROLLBACK_LINES.to_string(),
                serde_json::json!(intervals.scrollback_lines),
            ),
        ]),
    }
}

/// 読み込んだ結果。**まだ何も書いていない。**
#[derive(Debug, Default)]
pub struct Parsed {
    /// 検査を通った値。キーは [`crate::db::settings::ACCOUNT_KEYS`] のいずれか
    values: BTreeMap<String, serde_json::Value>,
    /// 知らないキー。**黙って捨てず、呼ぶ側から利用者へ伝える**
    ignored: Vec<String>,
}

impl Parsed {
    /// 反映されるキー（並びは安定させる——応答が呼ぶたびに変わると差分が読めない）。
    pub fn applied(&self) -> Vec<String> {
        self.values.keys().cloned().collect()
    }

    /// 無視したキー。
    pub fn ignored(&self) -> &[String] {
        &self.ignored
    }

    /// 権限確認スキップの既定。入っていなければ `None`（＝いまの値を残す）。
    pub fn always_bypass_permissions(&self) -> Option<bool> {
        self.values
            .get(settings::ALWAYS_BYPASS_PERMISSIONS)
            .and_then(serde_json::Value::as_bool)
    }

    /// 枠を足したら1本起こすか。入っていなければ `None`（＝いまの値を残す）。
    pub fn project_autostart_session(&self) -> Option<bool> {
        self.values
            .get(settings::PROJECT_AUTOSTART_SESSION)
            .and_then(serde_json::Value::as_bool)
    }

    /// 間隔の指定が1つでも入っているか。
    pub fn touches_intervals(&self) -> bool {
        [
            settings::SYNC_INTERVAL_SECS,
            settings::SCREEN_INTERVAL_MS,
            settings::SCROLLBACK_LINES,
        ]
        .iter()
        .any(|key| self.values.contains_key(*key))
    }

    /// いまの値へ、読み込んだぶんだけを被せる。
    ///
    /// **足りないキーを既定で埋めない**（同§9）。入っていないものは触らない——
    /// そうしないと、古い版のファイルを読んだときに**利用者が設定した覚えの無い値へ
    /// 勝手に戻る**。
    pub fn merged_intervals(&self, current: Intervals) -> Intervals {
        let pick = |key: &str, fallback: u64| {
            self.values
                .get(key)
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(fallback)
        };
        Intervals {
            sync_interval_secs: pick(settings::SYNC_INTERVAL_SECS, current.sync_interval_secs),
            screen_interval_ms: pick(settings::SCREEN_INTERVAL_MS, current.screen_interval_ms),
            scrollback_lines: pick(settings::SCROLLBACK_LINES, current.scrollback_lines),
        }
    }
}

/// 読み込んで検査する。**1つでも通らなければ、何も返さない**（持ち出し設計§9）。
///
/// 半分だけ入ると、利用者から見て「入ったのか入っていないのか」が分からない状態になる。
/// 設定は数個しかなく、部分適用に価値が無い。
///
/// 断る理由は**どのキーがどう駄目か**を並べて返す。1つ直しては断られる、を繰り返させない。
pub fn parse(text: &str) -> Result<Parsed, String> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|err| format!("ファイルを読めません（JSON として壊れています）: {err}"))?;

    let Some(object) = value.as_object() else {
        return Err("ファイルの形が違います（設定の入った JSON ではありません）".to_string());
    };

    // **中身を解釈する前に名乗りを見る。** 関係ないファイルを選んだときに、
    // 意味の分からないキーの断りを並べても伝わらない
    match object.get("kind").and_then(serde_json::Value::as_str) {
        Some(KIND) => {}
        _ => {
            return Err(
                "これは AgentDashboard の設定ファイルではありません（kind が違います）".to_string(),
            );
        }
    }

    match object.get("format").and_then(serde_json::Value::as_u64) {
        Some(format) if format <= u64::from(FORMAT) => {}
        Some(format) => {
            return Err(format!(
                "新しい版で書き出されたファイルです（format {format}）。\
                 このサーバが読めるのは {FORMAT} までです"
            ));
        }
        None => return Err("ファイルに format がありません".to_string()),
    }

    let Some(entries) = object
        .get("settings")
        .and_then(serde_json::Value::as_object)
    else {
        return Err("ファイルに settings がありません".to_string());
    };

    let mut parsed = Parsed::default();
    let mut reasons = Vec::new();
    for (key, value) in entries {
        if !settings::ACCOUNT_KEYS.contains(&key.as_str()) {
            // **知らないキーは読めなくしない。** 古い版・新しい版のどちらのファイルも
            // 受け取れるようにしておく（無視したことは呼ぶ側が利用者へ伝える）
            parsed.ignored.push(key.clone());
            continue;
        }
        match settings::check(key, value) {
            Ok(()) => {
                parsed.values.insert(key.clone(), value.clone());
            }
            Err(reason) => reasons.push(reason),
        }
    }

    if !reasons.is_empty() {
        return Err(reasons.join("／"));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn 書き出し() -> String {
        let exported = exported(Intervals::default(), true, true, "0.0.0-test");
        serde_json::to_string_pretty(&exported).expect("書き出せること")
    }

    #[test]
    fn 書き出したものはそのまま読み戻せる() {
        let parsed = parse(&書き出し()).expect("読めること");
        assert_eq!(
            parsed.applied().len(),
            settings::ACCOUNT_KEYS.len(),
            "アカウントの設定が全部揃って出ること"
        );
        assert!(parsed.ignored().is_empty());
        assert_eq!(parsed.always_bypass_permissions(), Some(true));
        assert_eq!(parsed.project_autostart_session(), Some(true));
        assert_eq!(
            parsed.merged_intervals(Intervals::default()),
            Intervals::default()
        );
    }

    #[test]
    fn 行が無い設定も埋めて書き出す() {
        // 行があるものだけを書き出すと、別のアカウントで読み込んだときに
        // **向こうの既存の値が残って画面が一致しない**
        let text = 書き出し();
        for key in settings::ACCOUNT_KEYS {
            assert!(text.contains(key), "{key} が書き出されていない:\n{text}");
        }
    }

    #[test]
    fn 秘密とサーバ全体のものは書き出されない() {
        let text = 書き出し();
        assert!(!text.contains(settings::LAN_PASSWORD_HASH), "{text}");
        assert!(!text.contains(settings::UPDATE_CHECK_ENABLED), "{text}");
    }

    #[test]
    fn 名乗りが違うファイルは断る() {
        let text = r#"{"kind":"something-else","format":1,"settings":{}}"#;
        let reason = parse(text).unwrap_err();
        assert!(reason.contains("AgentDashboard"), "{reason}");

        // 素の JSON（設定ファイルではない何か）も同じ道で断る
        assert!(parse(r#"{"port":8787}"#).is_err());
        assert!(parse("これは JSON ではない").is_err());
        assert!(parse("[]").is_err());
    }

    #[test]
    fn 新しい版のファイルは断り_古い版は受ける() {
        let newer = format!(
            r#"{{"kind":"{KIND}","format":{},"settings":{{}}}}"#,
            FORMAT + 1
        );
        let reason = parse(&newer).unwrap_err();
        assert!(reason.contains("新しい版"), "{reason}");

        // 古い番号は受ける（キーが減っているだけ）
        let older = format!(r#"{{"kind":"{KIND}","format":0,"settings":{{}}}}"#);
        assert!(parse(&older).is_ok());
    }

    #[test]
    fn 知らないキーは無視して伝える() {
        let text = format!(
            r#"{{"kind":"{KIND}","format":{FORMAT},"settings":{{
                "sync_interval_secs": 10,
                "未来のキー": 1
            }}}}"#
        );
        let parsed = parse(&text).expect("読めること");
        assert_eq!(parsed.applied(), [settings::SYNC_INTERVAL_SECS]);
        assert_eq!(parsed.ignored(), ["未来のキー"]);
    }

    #[test]
    fn 足りないキーは既定で埋めない() {
        // **利用者が設定した覚えの無い値へ勝手に戻さない**
        let text = format!(
            r#"{{"kind":"{KIND}","format":{FORMAT},"settings":{{"sync_interval_secs":10}}}}"#
        );
        let parsed = parse(&text).expect("読めること");

        let current = Intervals {
            sync_interval_secs: 60,
            screen_interval_ms: 5_000,
            scrollback_lines: 4_000,
        };
        let merged = parsed.merged_intervals(current);
        assert_eq!(merged.sync_interval_secs, 10, "入っているものは反映する");
        assert_eq!(merged.screen_interval_ms, 5_000, "入っていないものは残す");
        assert_eq!(merged.scrollback_lines, 4_000, "入っていないものは残す");
        assert_eq!(parsed.always_bypass_permissions(), None);
    }

    #[test]
    fn ひとつでも駄目なら何も返さない() {
        let text = format!(
            r#"{{"kind":"{KIND}","format":{FORMAT},"settings":{{
                "sync_interval_secs": 10,
                "screen_interval_ms": 1000,
                "scrollback_lines": 0
            }}}}"#
        );
        let reason = parse(&text).unwrap_err();
        assert!(reason.contains(settings::SCROLLBACK_LINES), "{reason}");
    }

    #[test]
    fn 駄目なところは全部並べて返す() {
        // 1つ直しては断られる、を繰り返させない
        let text = format!(
            r#"{{"kind":"{KIND}","format":{FORMAT},"settings":{{
                "sync_interval_secs": 0,
                "scrollback_lines": 0
            }}}}"#
        );
        let reason = parse(&text).unwrap_err();
        assert!(reason.contains(settings::SYNC_INTERVAL_SECS), "{reason}");
        assert!(reason.contains(settings::SCROLLBACK_LINES), "{reason}");
    }
}
