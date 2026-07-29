//! 利用者のグローバル設定 `~/.claude/settings.json` の `model` キーを守る（設計§6）。
//!
//! # なぜダッシュボードがこのファイルを気にするのか
//!
//! `/model <値>` は、CLI にとって「ピッカーで Enter を押した」のと同じ扱いで、
//! **選択を利用者のグローバル設定へ保存する**（v2.1.153 以降）。実測でも
//! `opus[1m]` が `sonnet` へ書き換わるのを確認している（設計§11 前提3）。
//!
//! そしてダッシュボードが起こすセッションは全員がこのファイルを共有する
//! （子プロセスへ渡す環境変数の許可リストに `HOME` が入っているため）。放っておくと
//! 「1つのセッションで切り替えたら、次に起こしたセッションもそのモデルで始まる」に
//! なる。要件が名指しで心配している連動の、いちばん見つけにくい顔である。
//!
//! # 既存の [`crate::settings`] とは別物にしてある
//!
//! | | `settings.rs` | ここ |
//! |---|---|---|
//! | 対象 | PJT の `config.toml` | 利用者の `~/.claude/settings.json` |
//! | 形式 | TOML | JSON |
//! | 書いてよいキー | `always_bypass_permissions` | **`model` だけ** |
//! | 所有者 | このダッシュボード | **利用者と、他の claude プロセス** |
//!
//! 対象の所有者が違うので、同じ関数に相乗りさせない。書いてよいキーを型のレベルで
//! 1つに限定し、他のキーを渡せない形にしてある。
//!
//! # 書き方は「解析して書き直す」ではなく「その場を差し替える」
//!
//! `serde_json` で読んで書き直すと、**キーの並びが辞書順に変わり、インデントも
//! こちらの都合になる**。利用者のファイルを預かっている以上それは実害なので、
//! 生のテキストから `"model"` の値の範囲だけを見つけて差し替える。触らなかった
//! バイトは1つも動かない。`settings.rs` が `toml_edit` でやっていることの JSON 版。

use protocol::ModelId;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 書き換えてよい唯一のキー。**ここを増やしてはいけない。**
const MODEL_KEY: &str = "model";

/// 回復の結果。呼び出し側はログに出すだけだが、テストからは判定に使う。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recovery {
    /// こちらが汚したので、覚えている値へ戻した
    Restored { to: Option<ModelId> },
    /// 利用者が自分で変えたものだったので、戻さず新しい既定として覚え直した
    Adopted { model: Option<ModelId> },
    /// 汚れていなかった（切替が保存されなかった等）
    Clean,
    /// ファイルが無い・壊れている・権限が無い。**何もしない**
    Skipped { reason: String },
    /// 書き込みに失敗した。以後グローバル既定を読みに行かなくなる
    Failed { reason: String },
}

/// 覚えている状態。
#[derive(Debug, Default, Clone)]
struct Remembered {
    /// 利用者の既定モデル。**注入する値であり、回復で戻す先でもある**。
    /// `None` は「利用者が指定していない」で、そのときは何も注入しない
    default_model: Option<ModelId>,
    /// 一度でも読めたか。読めていないうちは注入の判断ができない
    loaded: bool,
    /// 回復に失敗している。`true` の間は**グローバル既定を読みに行かない**
    /// （汚れた値を利用者の既定として取り込まないため）
    broken: bool,
}

/// 利用者のグローバル設定の見張り役。
pub struct ClaudeSettings {
    path: PathBuf,
    /// **切替と回復の一連をプロセス全体で直列化する**（設計§6）。
    ///
    /// セッションごとではなくプロセス全体で1本にするのは、対象がプロセスに1つしか
    /// 無いファイルだから。直列化しないと、2本が同時に切り替えたときに
    /// 「B が A の切替先を元の値だと思い込む」→「元の値が二度と戻らない」が起きる。
    /// 「読んだ時点と違ったら書かない」という自衛だけでは、汚染を防ぐのではなく
    /// **汚染を固定する**ことになる。
    ///
    /// 切替は人が押す操作なので、直列化しても実害は無い。
    switch_lock: tokio::sync::Mutex<()>,
    state: Mutex<Remembered>,
}

impl ClaudeSettings {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            switch_lock: tokio::sync::Mutex::new(()),
            state: Mutex::new(Remembered::default()),
        }
    }

    /// 既定の置き場所（`$HOME/.claude/settings.json`）を見に行く。
    pub fn discover() -> Self {
        let home = std::env::var("HOME").unwrap_or_default();
        Self::new(PathBuf::from(home).join(".claude").join("settings.json"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 切替の一連を包むロックを取る。
    ///
    /// 呼び出し側はこのガードを持ったまま「送る → 確定を待つ → 回復する」を行う。
    /// ガードを落とすまで、他のセッションの切替は待たされる。
    pub async fn lock_switch(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.switch_lock.lock().await
    }

    /// いまのグローバル既定を読み直して覚える。セッションを起こすたびに呼ぶ。
    ///
    /// **回復に失敗している間は読みに行かない。** 汚れた値をそのまま「利用者の既定」
    /// として取り込むと、以後ずっと汚れた値を注入し続けることになる。
    pub fn refresh_default(&self) -> Option<ModelId> {
        {
            let state = self.state.lock().expect("ロックが壊れていない");
            if state.broken {
                return state.default_model.clone();
            }
        }

        match self.read_model() {
            Ok(model) => {
                let mut state = self.state.lock().expect("ロックが壊れていない");
                state.default_model = model.clone();
                state.loaded = true;
                model
            }
            // 読めないときは覚えている値を使う。作りに行かない
            Err(reason) => {
                tracing::debug!(
                    path = %self.path.display(),
                    "利用者のグローバル設定を読めませんでした（何もしません）: {reason}"
                );
                self.state
                    .lock()
                    .expect("ロックが壊れていない")
                    .default_model
                    .clone()
            }
        }
    }

    /// 覚えている既定。読みに行かない。
    pub fn remembered_default(&self) -> Option<ModelId> {
        self.state
            .lock()
            .expect("ロックが壊れていない")
            .default_model
            .clone()
    }

    /// 回復に失敗した状態か。
    pub fn is_broken(&self) -> bool {
        self.state.lock().expect("ロックが壊れていない").broken
    }

    /// 切替のあと、汚れたグローバル既定を元へ戻す（設計§6 の副の仕掛け）。
    ///
    /// # 判断
    ///
    /// > グローバル既定が、**ダッシュボードが直近に切り替えた値**と一致していたら、
    /// > こちらが起こした汚染とみなして覚えている値へ戻す。
    /// > 一致しなければ**利用者が自分で変えたもの**とみなし、戻さずに覚え直す。
    ///
    /// この区別が要るのは、**利用者が意図して変えた既定をダッシュボードが勝手に
    /// 取り消してはいけない**から。稀に「利用者の変更先」と「こちらの切替先」が偶然
    /// 一致して誤って戻すことがあるが、そのときは覚え直しの経路に乗るので次で追いつく。
    ///
    /// # 戻した値がそのまま残るとは限らない
    ///
    /// 起動に伴って CLI が綴りを正規化することがある（`opus` → `opus[1m]` を実測。
    /// 設計§11）。意味は同じなので追いかけない。「戻したのに一致しない」を異常として
    /// 扱わないこと。
    pub fn recover(&self, switched_to: &ModelId) -> Recovery {
        let current = match self.read_model() {
            Ok(current) => current,
            Err(reason) => return Recovery::Skipped { reason },
        };

        if current.as_ref() != Some(switched_to) {
            // 利用者が自分で変えた（あるいはそもそも保存されなかった）
            let mut state = self.state.lock().expect("ロックが壊れていない");
            if current == state.default_model {
                return Recovery::Clean;
            }
            tracing::info!(
                path = %self.path.display(),
                "グローバル既定が利用者によって変わっていたので、新しい既定として覚えます: {:?} -> {:?}",
                state.default_model.as_ref().map(ModelId::as_str),
                current.as_ref().map(ModelId::as_str),
            );
            state.default_model = current.clone();
            state.loaded = true;
            return Recovery::Adopted { model: current };
        }

        let restore_to = self
            .state
            .lock()
            .expect("ロックが壊れていない")
            .default_model
            .clone();

        // **書く前の値をログに残す。** 事故が起きたときに手で戻せるようにする（設計§9）
        tracing::info!(
            path = %self.path.display(),
            "モデル切替でグローバル既定が汚れたので戻します: {:?} -> {:?}",
            current.as_ref().map(ModelId::as_str),
            restore_to.as_ref().map(ModelId::as_str),
        );

        match self.write_model(restore_to.as_ref()) {
            Ok(()) => {
                self.state.lock().expect("ロックが壊れていない").broken = false;
                Recovery::Restored { to: restore_to }
            }
            Err(reason) => {
                // 回復に失敗しても切替そのものは成功として扱う。ただし失敗した状態を
                // 覚えておき、以後グローバル既定を読みに行かない（設計§9）
                self.state.lock().expect("ロックが壊れていない").broken = true;
                tracing::warn!(
                    path = %self.path.display(),
                    "グローバル既定を戻せませんでした。以後は覚えている値を使います: {reason}"
                );
                Recovery::Failed { reason }
            }
        }
    }

    /// `model` キーを読む。**ファイルが無い・壊れているときは `Err`。**
    fn read_model(&self) -> Result<Option<ModelId>, String> {
        let text = std::fs::read_to_string(&self.path).map_err(|err| err.to_string())?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|err| format!("JSON として読めません: {err}"))?;
        Ok(value
            .get(MODEL_KEY)
            .and_then(serde_json::Value::as_str)
            .map(ModelId::new))
    }

    /// `model` キーだけを書き換える。`None` ならキーごと消す。
    fn write_model(&self, model: Option<&ModelId>) -> Result<(), String> {
        let text = std::fs::read_to_string(&self.path).map_err(|err| err.to_string())?;
        // 書く前に必ず読めることを確かめる。壊れたファイルに追い打ちをかけない
        serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|err| format!("JSON として読めません（書き換えを中止します）: {err}"))?;

        let updated = set_top_level_string(&text, MODEL_KEY, model.map(ModelId::as_str))?;
        // 書いた結果が JSON として読めることも確かめてから置き換える
        serde_json::from_str::<serde_json::Value>(&updated)
            .map_err(|err| format!("書き換えた結果が JSON になりませんでした: {err}"))?;

        std::fs::write(&self.path, updated).map_err(|err| err.to_string())
    }
}

/// トップレベルの文字列キーを差し替える。`value` が `None` ならキーごと消す。
///
/// 触らなかったバイトは1つも動かさない。並び順・インデント・改行はそのまま残る。
fn set_top_level_string(text: &str, key: &str, value: Option<&str>) -> Result<String, String> {
    match find_top_level_key(text, key) {
        Some(span) => Ok(match value {
            Some(value) => {
                let mut out = String::with_capacity(text.len() + value.len());
                out.push_str(&text[..span.value_start]);
                out.push_str(&encode_json_string(value));
                out.push_str(&text[span.value_end..]);
                out
            }
            None => remove_span(text, &span),
        }),
        None => match value {
            // 元から無いキーを消す指示なら、何もしないのが正しい
            None => Ok(text.to_string()),
            Some(value) => insert_top_level(text, key, value),
        },
    }
}

/// トップレベルのキー1つ分の範囲。
#[derive(Debug, PartialEq, Eq)]
struct KeySpan {
    /// キーの `"` の位置
    key_start: usize,
    /// 値の開始
    value_start: usize,
    /// 値の終端（この位置は含まない）
    value_end: usize,
}

/// トップレベル（深さ1）にあるキーを探す。入れ子の中の同名キーは拾わない。
fn find_top_level_key(text: &str, key: &str) -> Option<KeySpan> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut index = 0usize;

    while index < bytes.len() {
        match bytes[index] {
            b'{' | b'[' => {
                depth += 1;
                index += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                index += 1;
            }
            b'"' => {
                let start = index;
                let end = scan_string(bytes, index)?;
                // 深さ1の文字列のうち、直後が `:` のものだけがキー
                if depth == 1 {
                    let after = skip_whitespace(bytes, end);
                    if after < bytes.len() && bytes[after] == b':' {
                        let name = &text[start + 1..end - 1];
                        let value_start = skip_whitespace(bytes, after + 1);
                        let value_end = scan_value(bytes, value_start)?;
                        if name == key {
                            return Some(KeySpan {
                                key_start: start,
                                value_start,
                                value_end,
                            });
                        }
                        index = value_end;
                        continue;
                    }
                }
                index = end;
            }
            _ => index += 1,
        }
    }
    None
}

/// `"` から始まる文字列の終端（閉じ `"` の次）を返す。
fn scan_string(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return Some(index + 1),
            _ => index += 1,
        }
    }
    None
}

/// 値1つ分の終端を返す。
fn scan_value(bytes: &[u8], start: usize) -> Option<usize> {
    if start >= bytes.len() {
        return None;
    }
    match bytes[start] {
        b'"' => scan_string(bytes, start),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut index = start;
            while index < bytes.len() {
                match bytes[index] {
                    b'"' => index = scan_string(bytes, index)?,
                    b'{' | b'[' => {
                        depth += 1;
                        index += 1;
                    }
                    b'}' | b']' => {
                        depth -= 1;
                        index += 1;
                        if depth == 0 {
                            return Some(index);
                        }
                    }
                    _ => index += 1,
                }
            }
            None
        }
        // 数値・true・false・null。区切りに当たるまで
        _ => {
            let mut index = start;
            while index < bytes.len() && !matches!(bytes[index], b',' | b'}' | b']') {
                index += 1;
            }
            // 末尾の空白は値に含めない
            while index > start && bytes[index - 1].is_ascii_whitespace() {
                index -= 1;
            }
            Some(index)
        }
    }
}

fn skip_whitespace(bytes: &[u8], from: usize) -> usize {
    let mut index = from;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    index
}

/// キー1つ分を、前後どちらかのカンマごと取り除く。
fn remove_span(text: &str, span: &KeySpan) -> String {
    let bytes = text.as_bytes();

    // 後ろにカンマがあればそれごと消す（残ると `,}` になって壊れる）
    let after = skip_whitespace(bytes, span.value_end);
    if after < bytes.len() && bytes[after] == b',' {
        let mut out = String::with_capacity(text.len());
        out.push_str(&text[..span.key_start]);
        out.push_str(text[after + 1..].trim_start_matches([' ', '\t']));
        return out;
    }

    // 最後の要素だった。前のカンマを消す
    let mut before = span.key_start;
    while before > 0 && bytes[before - 1].is_ascii_whitespace() {
        before -= 1;
    }
    if before > 0 && bytes[before - 1] == b',' {
        before -= 1;
    }
    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..before]);
    out.push_str(&text[span.value_end..]);
    out
}

/// トップレベルの先頭へキーを1つ挿す。
fn insert_top_level(text: &str, key: &str, value: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let open = text
        .find('{')
        .ok_or_else(|| "JSON オブジェクトではありません".to_string())?;
    let after = skip_whitespace(bytes, open + 1);

    // 空のオブジェクトならカンマは要らない
    let empty = after < bytes.len() && bytes[after] == b'}';
    // 既存の行のインデントを真似る。読めなければ2スペース
    let indent = text[open + 1..]
        .lines()
        .nth(1)
        .map(|line| {
            line.chars()
                .take_while(|ch| *ch == ' ' || *ch == '\t')
                .collect::<String>()
        })
        .filter(|indent| !indent.is_empty())
        .unwrap_or_else(|| "  ".to_string());

    let entry = format!(
        "\n{indent}{}: {}{}",
        encode_json_string(key),
        encode_json_string(value),
        if empty { "\n" } else { "," }
    );
    let mut out = String::with_capacity(text.len() + entry.len());
    out.push_str(&text[..open + 1]);
    out.push_str(&entry);
    out.push_str(&text[open + 1..]);
    Ok(out)
}

fn encode_json_string(value: &str) -> String {
    serde_json::Value::String(value.to_string()).to_string()
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    /// 実物に近い形。キーの並びは辞書順ではない
    const SAMPLE: &str = r#"{
  "permissions": {
    "defaultMode": "auto",
    "model": "この入れ子は触ってはいけない"
  },
  "model": "claude-fable-5[1m]",
  "effortLevel": "xhigh",
  "enabledPlugins": {
    "context7@claude-plugins-official": true
  }
}
"#;

    fn model_of(text: &str) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(text)
            .unwrap()
            .get("model")
            .and_then(|value| value.as_str())
            .map(str::to_string)
    }

    #[test]
    fn 値だけが差し替わり他のキーも並びも変わらない() {
        let updated = set_top_level_string(SAMPLE, "model", Some("opus")).unwrap();
        assert_eq!(model_of(&updated).as_deref(), Some("opus"));

        // 触っていない部分がバイト単位で残っていること
        assert_eq!(
            updated,
            SAMPLE.replace(r#""claude-fable-5[1m]""#, r#""opus""#)
        );
    }

    #[test]
    fn 入れ子の同名キーは巻き込まない() {
        // `permissions.model` を書き換えてしまうと、利用者の設定が壊れる
        let updated = set_top_level_string(SAMPLE, "model", Some("opus")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(
            parsed["permissions"]["model"],
            "この入れ子は触ってはいけない"
        );
        assert_eq!(parsed["permissions"]["defaultMode"], "auto");
        assert_eq!(parsed["effortLevel"], "xhigh");
        assert_eq!(
            parsed["enabledPlugins"]["context7@claude-plugins-official"],
            true
        );
    }

    #[test]
    fn キー無しへ戻すとキーごと消える() {
        // 元が「指定なし」だった利用者には、指定なしの状態を返す
        let updated = set_top_level_string(SAMPLE, "model", None).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&updated).unwrap();
        assert!(parsed.get("model").is_none(), "実際: {updated}");
        assert_eq!(parsed["effortLevel"], "xhigh");
        assert_eq!(parsed["permissions"]["defaultMode"], "auto");
    }

    #[test]
    fn 末尾のキーを消してもカンマが残らない() {
        let text = "{\n  \"a\": 1,\n  \"model\": \"opus\"\n}\n";
        let updated = set_top_level_string(text, "model", None).unwrap();
        serde_json::from_str::<serde_json::Value>(&updated)
            .unwrap_or_else(|err| panic!("JSON として読めること: {err}\n{updated}"));
        assert!(!updated.contains("model"));
    }

    #[test]
    fn 元から無いキーは挿し込まれる() {
        let text = "{\n  \"effortLevel\": \"xhigh\"\n}\n";
        let updated = set_top_level_string(text, "model", Some("sonnet")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(parsed["model"], "sonnet");
        assert_eq!(parsed["effortLevel"], "xhigh");
    }

    #[test]
    fn 空のオブジェクトにも挿せる() {
        let updated = set_top_level_string("{}", "model", Some("haiku")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(parsed["model"], "haiku");
    }

    #[test]
    fn 元から無いキーを消す指示では何も変わらない() {
        let text = "{\n  \"effortLevel\": \"xhigh\"\n}\n";
        assert_eq!(set_top_level_string(text, "model", None).unwrap(), text);
    }

    #[test]
    fn 記号を含む値も壊れない() {
        let updated = set_top_level_string(SAMPLE, "model", Some(r#"変な"値\"#)).unwrap();
        assert_eq!(model_of(&updated).as_deref(), Some(r#"変な"値\"#));
    }

    // ---- ファイルを相手にする側 ------------------------------------------------

    /// 既存の `settings.rs` のテストと同じ作法。依存を増やさない。
    ///
    /// **本物の `~/.claude/settings.json` は絶対に対象にしない。** テストが壊れたときに
    /// 利用者の設定が巻き添えになる経路を、そもそも作らない。
    fn temp_settings(label: &str, body: &str) -> (PathBuf, ClaudeSettings) {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-claude-settings-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, body).expect("書けること");
        let store = ClaudeSettings::new(path);
        (dir, store)
    }

    #[test]
    fn こちらが切り替えた値なら覚えている値へ戻す() {
        let (_dir, store) = temp_settings("restore", SAMPLE);
        // 起動時に読んで覚える
        assert_eq!(
            store.refresh_default(),
            Some(ModelId::new("claude-fable-5[1m]"))
        );

        // CLI が /model sonnet で汚した状態を作る
        store.write_model(Some(&ModelId::new("sonnet"))).unwrap();

        let outcome = store.recover(&ModelId::new("sonnet"));
        assert_eq!(
            outcome,
            Recovery::Restored {
                to: Some(ModelId::new("claude-fable-5[1m]"))
            }
        );
        assert_eq!(
            store.read_model().unwrap(),
            Some(ModelId::new("claude-fable-5[1m]"))
        );
    }

    #[test]
    fn 利用者が自分で変えた値は戻さず覚え直す() {
        // ダッシュボードが勝手に取り消してはいけない（設計§6）
        let (_dir, store) = temp_settings("adopt", SAMPLE);
        store.refresh_default();

        // 利用者が自分のターミナルで opus にした
        store.write_model(Some(&ModelId::new("opus"))).unwrap();

        let outcome = store.recover(&ModelId::new("sonnet"));
        assert_eq!(
            outcome,
            Recovery::Adopted {
                model: Some(ModelId::new("opus"))
            }
        );
        assert_eq!(store.read_model().unwrap(), Some(ModelId::new("opus")));
        assert_eq!(store.remembered_default(), Some(ModelId::new("opus")));
    }

    #[test]
    fn 元がキー無しなら戻したときもキー無しになる() {
        let (_dir, store) = temp_settings("nokey", "{\n  \"effortLevel\": \"xhigh\"\n}\n");
        assert_eq!(store.refresh_default(), None);

        store.write_model(Some(&ModelId::new("sonnet"))).unwrap();
        assert_eq!(
            store.recover(&ModelId::new("sonnet")),
            Recovery::Restored { to: None }
        );
        assert_eq!(store.read_model().unwrap(), None);
    }

    #[test]
    fn ファイルが無ければ何もせず作りにも行かない() {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-claude-settings-missing-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let store = ClaudeSettings::new(path.clone());

        assert_eq!(store.refresh_default(), None);
        assert!(matches!(
            store.recover(&ModelId::new("sonnet")),
            Recovery::Skipped { .. }
        ));
        assert!(!path.exists(), "利用者の設定ファイルを生やしてはいけない");
    }

    #[test]
    fn 壊れたJSONには何も書かない() {
        let (_dir, store) = temp_settings("broken", "{ これは JSON ではない");
        assert_eq!(store.refresh_default(), None);
        assert!(matches!(
            store.recover(&ModelId::new("sonnet")),
            Recovery::Skipped { .. }
        ));
        assert_eq!(
            std::fs::read_to_string(store.path()).unwrap(),
            "{ これは JSON ではない",
            "壊れたファイルに追い打ちをかけない"
        );
    }

    #[test]
    fn 汚れていなければ何もしない() {
        let (_dir, store) = temp_settings("clean", SAMPLE);
        store.refresh_default();
        assert_eq!(store.recover(&ModelId::new("sonnet")), Recovery::Clean);
    }

    #[test]
    #[cfg(unix)]
    fn 回復に失敗したら以後グローバル既定を読みに行かない() {
        use std::os::unix::fs::PermissionsExt as _;

        // 汚れた値を利用者の既定として取り込まないための歯止め（設計§9）
        let (_dir, store) = temp_settings("broken-write", SAMPLE);
        store.refresh_default();
        store.write_model(Some(&ModelId::new("sonnet"))).unwrap();

        // **読めるが書けない**状態を作る。ディレクトリを r-x にしても既存ファイルの
        // 書き換えは止まらない（作成と削除しか制限されない）ので、ファイル自身を読み取り専用にする
        let path = store.path().to_path_buf();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o400);
        std::fs::set_permissions(&path, perms).unwrap();

        let outcome = store.recover(&ModelId::new("sonnet"));

        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms).unwrap();

        assert!(
            matches!(outcome, Recovery::Failed { .. }),
            "実際: {outcome:?}"
        );
        assert!(store.is_broken());
        // 汚れた値（sonnet）を読み込まず、覚えている値を返し続ける
        assert_eq!(
            store.refresh_default(),
            Some(ModelId::new("claude-fable-5[1m]"))
        );
    }

    // ---- 直列化（本イシューでいちばん重要なテスト）--------------------------------

    /// CLI が `/model <値>` を保存する動きを真似る。
    ///
    /// 実物では claude 側がこれをやる（設計§11 前提3 で実測）。擬似 claude は利用者の
    /// HOME を安全に差し替えられないので汚さない。**汚れたあとどうなるかを見るには、
    /// ここで汚す役を自分でやるしかない。**
    fn cli_saves(store: &ClaudeSettings, model: &str) {
        store.write_model(Some(&ModelId::new(model))).unwrap();
    }

    #[tokio::test]
    async fn 二本が同時に切り替えても元の既定が失われない() {
        // 設計§6 に書いた4手の並びを再現する。**このテストが本イシューでいちばん重要**。
        //
        //   A：opus を控える → A：/model sonnet   → CLI が sonnet を書く
        //   B：控える（★sonnet を「元の値」だと思い込む）→ B：/model haiku
        //   A：値が違うので諦める → B：sonnet へ戻す → opus が二度と戻らない
        //
        // ロックが1本あればこの並びは起きない。
        let (_dir, store) = temp_settings("serialize", SAMPLE);
        let store = std::sync::Arc::new(store);
        store.refresh_default();
        let original = store.remembered_default();
        assert_eq!(original, Some(ModelId::new("claude-fable-5[1m]")));

        let a = {
            let store = std::sync::Arc::clone(&store);
            tokio::spawn(async move {
                let _guard = store.lock_switch().await;
                cli_saves(&store, "sonnet");
                // 相手に割り込む隙を与える。ロックが効いていればここでは入れない
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                store.recover(&ModelId::new("sonnet"))
            })
        };
        let b = {
            let store = std::sync::Arc::clone(&store);
            tokio::spawn(async move {
                let _guard = store.lock_switch().await;
                cli_saves(&store, "haiku");
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                store.recover(&ModelId::new("haiku"))
            })
        };
        let (first, second) = tokio::join!(a, b);
        first.unwrap();
        second.unwrap();

        assert_eq!(
            store.read_model().unwrap(),
            original,
            "並行して切り替えても、利用者の既定が失われないこと"
        );
        assert_eq!(store.remembered_default(), original);
    }

    #[tokio::test]
    async fn ロックはプロセス全体で1本になっている() {
        // セッションごとに持つと、対象がプロセスに1つしかないファイルを守れない
        let (_dir, store) = temp_settings("one-lock", SAMPLE);
        let guard = store.lock_switch().await;

        let blocked =
            tokio::time::timeout(std::time::Duration::from_millis(100), store.lock_switch()).await;
        assert!(blocked.is_err(), "先客がいる間は待たされること");

        drop(guard);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), store.lock_switch())
                .await
                .is_ok(),
            "解放されたら取れること"
        );
    }

    #[tokio::test]
    async fn 直列化されていれば汚染が固定されない() {
        // 「読んだ時点と違ったら書かない」という自衛だけでは、汚染を防ぐのではなく
        // **汚染を固定する**ことになる（設計§6）。順番に行えば必ず元へ戻る
        let (_dir, store) = temp_settings("sequential", SAMPLE);
        store.refresh_default();

        for model in ["sonnet", "haiku", "opus"] {
            let _guard = store.lock_switch().await;
            cli_saves(&store, model);
            assert_eq!(
                store.recover(&ModelId::new(model)),
                Recovery::Restored {
                    to: Some(ModelId::new("claude-fable-5[1m]"))
                }
            );
        }
        assert_eq!(
            store.read_model().unwrap(),
            Some(ModelId::new("claude-fable-5[1m]"))
        );
    }
}
