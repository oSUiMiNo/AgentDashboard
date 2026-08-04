//! 画面が起動時に読む、PC 側にしか無い材料（設計§7・持ち出し設計§3・§6）。
//!
//! # ここは読むだけ
//!
//! かつては設定画面のトグル（「常に権限確認スキップモードで開くか」）を `config.toml`
//! へ書き戻していたが、**同じ画面に並ぶ1項目だけ保存先が違うと、セルフホスト構成では
//! 画面から触れない**（書き戻す相手が利用者の PC のファイルで、サーバから手が届かない）。
//! 保存先は記録（DB）へ寄せた（持ち出し設計§1〜§3）ので、ここに書く道は無くなった。
//!
//! 残っているトグルの値は**行が無いときの初期値**として読まれる（同§3）。既に
//! `config.toml` で `true` にして使っている利用者の設定を、引っ越しで黙って戻さない
//! ためにある。
//!
//! # 共有の `SessionHostConfig` は不変のまま
//!
//! 読むだけなので、`Arc<SessionHostConfig>` を `RwLock` へ広げる理由が最初から無い。

use crate::config::SessionHostConfig;
use crate::model_aliases::AliasSeen;
use crate::model_catalog::CatalogEntry;
use protocol::PermissionMode;

/// ローカルモードのモデル表のキー（設計§13-4）。
pub const LOCAL_TABLE_KEY: &str = "local";

/// 画面が起動時に読む、PC 側の材料。
#[derive(Debug)]
pub struct SettingsStore {
    /// 権限確認スキップの既定の**初期値**（持ち出し設計§3）。正は記録のほう
    always_bypass_permissions: bool,
    available_modes: Vec<PermissionMode>,
    model_catalog: Vec<CatalogEntry>,
    /// 起動している CLI の版（モデルの表に添えて配る。設計§13-4）
    cli_version: String,
}

impl SettingsStore {
    pub fn new(
        config: &SessionHostConfig,
        available_modes: Vec<PermissionMode>,
        model_catalog: Vec<CatalogEntry>,
    ) -> Self {
        Self::with_version(config, available_modes, model_catalog, String::new())
    }

    /// CLI の版まで明示して作る（モデルの表に添える。設計§13-4）。
    pub fn with_version(
        config: &SessionHostConfig,
        available_modes: Vec<PermissionMode>,
        model_catalog: Vec<CatalogEntry>,
        cli_version: String,
    ) -> Self {
        Self {
            always_bypass_permissions: config.always_bypass_permissions,
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

    /// 権限確認スキップの既定の初期値。**記録に行が無いときだけ使われる**（同§3）。
    pub fn always_bypass_permissions(&self) -> bool {
        self.always_bypass_permissions
    }

    pub fn available_modes(&self) -> &[PermissionMode] {
        &self.available_modes
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 設定ファイルの値が初期値として読める() {
        // 記録に行が無いときの落とし先。**ここが `false` 固定になると、既に
        // `config.toml` で有効にしている利用者の設定が引っ越しで消える**
        let mut config = SessionHostConfig::default();
        assert!(!SettingsStore::new(&config, Vec::new(), Vec::new()).always_bypass_permissions());

        config.always_bypass_permissions = true;
        let store = SettingsStore::new(
            &config,
            vec![PermissionMode::new("default")],
            // 対応表はここでは関係ない（画面へ配るだけの値）
            Vec::new(),
        );
        assert!(store.always_bypass_permissions());
        assert_eq!(store.available_modes(), [PermissionMode::new("default")]);
    }
}
