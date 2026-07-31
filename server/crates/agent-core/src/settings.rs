//! 画面から書き換えられる設定（設計§7）。
//!
//! `config.toml` は本来**起動時に読むだけ**で、書く経路は無かった。設定画面のトグル
//! （「常に権限確認スキップモードで開くか」）を次の起動へ持ち越すために、ここで
//! 1キーだけの書き戻しを足す。
//!
//! # なぜ `toml_edit` なのか
//!
//! `toml::to_string` で構造体から書き直すと、**ファイル中のコメントが全部消える**。
//! `config.toml.example` は説明コメントが本体と言っていいほど厚く、利用者がそれを
//! コピーして使う前提なので、これは実害になる。`toml_edit` は書式とコメントを保った
//! まま特定のキーだけを差し替えられる。**触るのはそのキーだけ**にして、他のキーや
//! 並び順には手を出さない。
//!
//! # 共有の `AgentConfig` は不変のまま
//!
//! このキーを読むのは画面だけで、サーバの動作には影響しない。`Arc<AgentConfig>` を
//! `RwLock` へ広げると、全く関係の無い経路にまでロックを持ち込むことになる。
//! **1つの値だけをここで持つ**のが釣り合う。

use crate::config::AgentConfig;
use crate::model_aliases::AliasSeen;
use crate::model_catalog::CatalogEntry;
use protocol::PermissionMode;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// 書き戻す対象のキー。
const ALWAYS_BYPASS_KEY: &str = "always_bypass_permissions";

/// ローカルモードのモデル表のキー（設計§13-4）。
pub const LOCAL_TABLE_KEY: &str = "local";

/// 画面から変えられる設定の持ち主。
#[derive(Debug)]
pub struct SettingsStore {
    /// 書き戻す先。`--config` が指定されていればそのファイル、無ければカレントの `config.toml`
    path: PathBuf,
    always_bypass_permissions: AtomicBool,
    available_modes: Vec<PermissionMode>,
    model_catalog: Vec<CatalogEntry>,
    /// 起動している CLI の版（モデルの表に添えて配る。設計§13-4）
    cli_version: String,
}

impl SettingsStore {
    pub fn new(
        path: PathBuf,
        config: &AgentConfig,
        available_modes: Vec<PermissionMode>,
        model_catalog: Vec<CatalogEntry>,
    ) -> Self {
        Self::with_version(path, config, available_modes, model_catalog, String::new())
    }

    /// CLI の版まで明示して作る（モデルの表に添える。設計§13-4）。
    pub fn with_version(
        path: PathBuf,
        config: &AgentConfig,
        available_modes: Vec<PermissionMode>,
        model_catalog: Vec<CatalogEntry>,
        cli_version: String,
    ) -> Self {
        Self {
            path,
            always_bypass_permissions: AtomicBool::new(config.always_bypass_permissions),
            available_modes,
            model_catalog,
            cli_version,
        }
    }

    /// この PC のモデルの表（`agents.model_table` へ入るのと同じ形）。
    pub fn model_table(&self, model_aliases: &[AliasSeen]) -> serde_json::Value {
        serde_json::json!({
            "cli_version": self.cli_version,
            "catalog": self.model_catalog,
            "aliases": model_aliases,
        })
    }

    /// この PC のモデル表を、`agent_id` をキーにした形で1本だけ返す（設計§13-4）。
    ///
    /// ローカルモードには PC という単位が無いので、キーは常に [`LOCAL_TABLE_KEY`]。
    /// **応答の組み立て（`/api/settings`）は両者を束ねる層の仕事**なので、ここは
    /// 材料を渡すところまでにしてある。
    pub fn local_model_tables(
        &self,
        model_aliases: &[AliasSeen],
    ) -> std::collections::BTreeMap<String, serde_json::Value> {
        std::collections::BTreeMap::from([(
            LOCAL_TABLE_KEY.to_string(),
            self.model_table(model_aliases),
        )])
    }

    pub fn always_bypass_permissions(&self) -> bool {
        self.always_bypass_permissions.load(Ordering::Relaxed)
    }

    pub fn available_modes(&self) -> &[PermissionMode] {
        &self.available_modes
    }

    /// トグルを書き換える。**ファイルとメモリの両方**を更新する。
    ///
    /// ファイルだけ書いても動いているサーバは古い値を持ったままなので、次の起動を
    /// 待たせることになる。逆にメモリだけでは、開き直したときに戻ってしまう。
    pub fn set_always_bypass_permissions(&self, value: bool) -> anyhow::Result<()> {
        write_bool(&self.path, ALWAYS_BYPASS_KEY, value)?;
        self.always_bypass_permissions
            .store(value, Ordering::Relaxed);
        Ok(())
    }
}

/// TOML ファイルの1キーだけを差し替える。
///
/// ファイルが無ければ作る（設定を書いたことが無い利用者もいるため）。読めた内容が
/// TOML として壊れている場合は**書かない** — 直せると思って上書きすると、利用者が
/// 手で書いた他のキーを消すことになる。
fn write_bool(path: &Path, key: &str, value: bool) -> anyhow::Result<()> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(err.into()),
    };

    let mut document: toml_edit::DocumentMut = text.parse().map_err(|err| {
        anyhow::anyhow!("設定ファイルを読めません（書き換えを中止します）: {err}")
    })?;
    document[key] = toml_edit::value(value);

    if let Some(dir) = path.parent()
        && !dir.as_os_str().is_empty()
    {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, document.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn temp_file(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-settings-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("config.toml")
    }

    #[test]
    fn 書き戻してもコメントと他のキーが残る() {
        // `toml_edit` を使う理由そのもの。ここが落ちるなら実装が toml::to_string になっている
        let path = temp_file("comments");
        std::fs::write(
            &path,
            "\
# ダッシュボードの待ち受けポート
port = 8787

# 停滞とみなすまでの秒数
stalled_threshold_secs = 120
",
        )
        .unwrap();

        write_bool(&path, ALWAYS_BYPASS_KEY, true).unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(
            after.contains("# ダッシュボードの待ち受けポート"),
            "コメントが消えた:\n{after}"
        );
        assert!(after.contains("# 停滞とみなすまでの秒数"), "{after}");
        assert!(after.contains("port = 8787"), "{after}");
        assert!(after.contains("stalled_threshold_secs = 120"), "{after}");
        assert!(
            after.contains("always_bypass_permissions = true"),
            "{after}"
        );

        // 書き戻した結果が、そのまま TOML として読み直せること。
        // ここで `Config`（全キーの読み込み）を使わないのは、それがローカルモードの
        // 実行ファイル側の型になったため。見たいのは**書いたファイルの中身**なので、
        // 素の TOML として読むほうが検証としても直接的になる
        let table: toml::Table = after
            .parse()
            .expect("書き戻した結果が TOML として妥当なこと");
        assert_eq!(table[ALWAYS_BYPASS_KEY].as_bool(), Some(true));
        assert_eq!(table["port"].as_integer(), Some(8787));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn 並び順は変わらない() {
        let path = temp_file("order");
        std::fs::write(&path, "port = 1234\ncoalesce_ms = 8\nflow_low = 32768\n").unwrap();

        write_bool(&path, ALWAYS_BYPASS_KEY, true).unwrap();
        write_bool(&path, ALWAYS_BYPASS_KEY, false).unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        let keys: Vec<&str> = after
            .lines()
            .filter_map(|line| line.split('=').next())
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .collect();
        assert_eq!(
            keys,
            ["port", "coalesce_ms", "flow_low", ALWAYS_BYPASS_KEY],
            "既存のキーの順が入れ替わってはいけない:\n{after}"
        );
        assert!(after.contains("always_bypass_permissions = false"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn ファイルが無ければ作る() {
        // 設定を書いたことが無い利用者でも、画面から変えた値が次の起動へ残ること
        let path = temp_file("missing");
        assert!(!path.exists());

        write_bool(&path, ALWAYS_BYPASS_KEY, true).unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        let table: toml::Table = after
            .parse()
            .expect("書き出した結果が TOML として妥当なこと");
        assert_eq!(table[ALWAYS_BYPASS_KEY].as_bool(), Some(true));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn 壊れたファイルは書き換えない() {
        // 直せると思って上書きすると、利用者が手で書いた他のキーを消すことになる
        let path = temp_file("broken");
        std::fs::write(&path, "port = = 8787\n").unwrap();

        assert!(write_bool(&path, ALWAYS_BYPASS_KEY, true).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "port = = 8787\n");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn メモリ上の値も同時に変わる() {
        // ファイルだけ書いても、動いているサーバは古い値を持ったままになる
        let path = temp_file("memory");
        let store = SettingsStore::new(
            path.clone(),
            &AgentConfig::default(),
            vec![PermissionMode::new("default")],
            // 対応表はここでは関係ない（画面へ配るだけの値）
            Vec::new(),
        );
        assert!(!store.always_bypass_permissions());

        store.set_always_bypass_permissions(true).unwrap();
        assert!(store.always_bypass_permissions());
        assert_eq!(store.available_modes(), [PermissionMode::new("default")]);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
