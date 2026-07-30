//! `config.toml` の読み込み（設計§12）。
//!
//! キー名は設計§12 の表記をそのまま採用している。サイズ系（`pty_ring_buffer` /
//! `flow_high` / `flow_low`）はバイト数の整数で受ける。
//!
//! # 1つのファイルから2つの設定を作る
//!
//! 中身はエージェント側（[`AgentConfig`]）とサーバ側（[`ServerConfig`]）に分かれるが、
//! **ローカルモードでは利用者が書くファイルは1つのまま**（セルフホスト化設計§13-2）。
//! そこで、読み込みと検証はこの1つの構造体が受け持ち、[`Config::agent`] /
//! [`Config::server`] が各側へ射影する。
//!
//! 構造体を2つに分けて `#[serde(flatten)]` で束ねる形にはしない。**flatten を使うと
//! `deny_unknown_fields` が効かなくなり**、「知らないキーを書いたらエラー」という
//! 約束が静かに壊れる（打ち間違いを黙って無視すると「設定したのに効かない」事故になる）。

use agent_core::config::AgentConfig;
use serde::{Deserialize, Serialize};
use server_core::config::ServerConfig;
use std::path::{Path, PathBuf};

/// 設定の既定ファイル名。カレントディレクトリから探す。
pub const DEFAULT_FILE_NAME: &str = "config.toml";

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("設定ファイルを読めません: {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("設定ファイルの書式が不正です: {path}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
    #[error("設定値が不正です: {0}")]
    Invalid(String),
}

/// `config.toml` の全キー。
///
/// 個々のキーの意味は、射影先である [`AgentConfig`] と [`ServerConfig`] のドキュメントを
/// 参照する。ここに二重に書くと、片方だけ直された説明が残ることになる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Config {
    pub port: u16,
    pub stalled_threshold_secs: u64,
    pub coalesce_ms: u64,
    pub pty_ring_buffer: usize,
    pub flow_high: usize,
    pub flow_low: usize,
    pub always_bypass_permissions: bool,
    pub selfheal_enabled: bool,
    pub canary_model: String,
    pub canary_fallback_model: String,
    pub repair_model: String,
    pub selfheal_retry: u32,
    pub selfheal_cooldown_hours: u64,
    pub selfheal_repo_dir: Option<PathBuf>,
    pub transcript_window_nodes: usize,
    pub transcript_page_limit: usize,
    pub state_dir: Option<PathBuf>,
    pub inject_status_line: bool,
    pub claude_settings_path: Option<PathBuf>,
    pub status_line_refresh_secs: u64,
}

impl Default for Config {
    /// 既定値は**射影先が持つ**。ここで値を書き直すと、片方だけ変えたときに
    /// 「ファイルを書かなかった場合」と「書いた場合」で挙動が分かれる。
    fn default() -> Self {
        let agent = AgentConfig::default();
        let server = ServerConfig::default();
        Self {
            port: server.port,
            stalled_threshold_secs: agent.stalled_threshold_secs,
            coalesce_ms: agent.coalesce_ms,
            pty_ring_buffer: agent.pty_ring_buffer,
            flow_high: server.flow_high,
            flow_low: server.flow_low,
            always_bypass_permissions: agent.always_bypass_permissions,
            selfheal_enabled: agent.selfheal_enabled,
            canary_model: agent.canary_model,
            canary_fallback_model: agent.canary_fallback_model,
            repair_model: agent.repair_model,
            selfheal_retry: agent.selfheal_retry,
            selfheal_cooldown_hours: agent.selfheal_cooldown_hours,
            selfheal_repo_dir: agent.selfheal_repo_dir,
            transcript_window_nodes: agent.transcript_window_nodes,
            transcript_page_limit: server.transcript_page_limit,
            state_dir: agent.state_dir,
            inject_status_line: agent.inject_status_line,
            claude_settings_path: agent.claude_settings_path,
            status_line_refresh_secs: agent.status_line_refresh_secs,
        }
    }
}

impl Config {
    /// 設定を解決する。
    ///
    /// 探索順は次のとおり。
    /// 1. `explicit`（`--config` で明示された場合）— 存在しなければエラー
    /// 2. カレントディレクトリの `config.toml` — 無ければ既定値
    pub fn load(explicit: Option<&Path>) -> Result<Self, ConfigError> {
        match explicit {
            Some(path) => Self::from_file(path),
            None => {
                let default_path = Path::new(DEFAULT_FILE_NAME);
                if default_path.is_file() {
                    Self::from_file(default_path)
                } else {
                    Ok(Self::default())
                }
            }
        }
    }

    pub fn from_file(path: &Path) -> Result<Self, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.to_path_buf(),
            source,
        })?;
        Self::from_toml_str(&text).map_err(|err| match err {
            ConfigError::Parse { source, .. } => ConfigError::Parse {
                path: path.to_path_buf(),
                source,
            },
            other => other,
        })
    }

    /// TOML 文字列から読む。書式エラーと値エラーを別々に返す。
    pub fn from_toml_str(text: &str) -> Result<Self, ConfigError> {
        let config: Config = toml::from_str(text).map_err(|source| ConfigError::Parse {
            path: PathBuf::from("<inline>"),
            source,
        })?;
        config.validate()?;
        Ok(config)
    }

    /// エージェント（PC 側）が使う分だけを取り出す。
    ///
    /// `hook_port` に待ち受けポートを入れているのは、ローカルモードではフックの宛先が
    /// ブラウザと同じポートに同居しているため。フェーズ3 で別プロセスになると、ここは
    /// エージェント自身の設定から来る（セルフホスト化設計§5-3）。
    pub fn agent(&self) -> AgentConfig {
        AgentConfig {
            stalled_threshold_secs: self.stalled_threshold_secs,
            coalesce_ms: self.coalesce_ms,
            pty_ring_buffer: self.pty_ring_buffer,
            always_bypass_permissions: self.always_bypass_permissions,
            selfheal_enabled: self.selfheal_enabled,
            canary_model: self.canary_model.clone(),
            canary_fallback_model: self.canary_fallback_model.clone(),
            repair_model: self.repair_model.clone(),
            selfheal_retry: self.selfheal_retry,
            selfheal_cooldown_hours: self.selfheal_cooldown_hours,
            selfheal_repo_dir: self.selfheal_repo_dir.clone(),
            transcript_window_nodes: self.transcript_window_nodes,
            state_dir: self.state_dir.clone(),
            claude_settings_path: self.claude_settings_path.clone(),
            inject_status_line: self.inject_status_line,
            status_line_refresh_secs: self.status_line_refresh_secs,
            hook_port: self.port,
        }
    }

    /// ダッシュボードサーバが使う分だけを取り出す。
    pub fn server(&self) -> ServerConfig {
        ServerConfig {
            port: self.port,
            flow_high: self.flow_high,
            flow_low: self.flow_low,
            transcript_page_limit: self.transcript_page_limit,
        }
    }

    /// 型が合っていても意味的に成立しない組み合わせを弾く。
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.port == 0 {
            return Err(ConfigError::Invalid(
                "port は 1 以上である必要があります".to_string(),
            ));
        }
        if self.coalesce_ms == 0 {
            return Err(ConfigError::Invalid(
                "coalesce_ms は 1 以上である必要があります".to_string(),
            ));
        }
        if self.stalled_threshold_secs == 0 {
            return Err(ConfigError::Invalid(
                "stalled_threshold_secs は 1 以上である必要があります".to_string(),
            ));
        }
        if self.pty_ring_buffer == 0 {
            return Err(ConfigError::Invalid(
                "pty_ring_buffer は 1 以上である必要があります".to_string(),
            ));
        }
        // 下側しきい値が上側以上だと pause と resume が同時に成立してしまい、
        // フロー制御が振動する（設計§10）。
        if self.flow_low >= self.flow_high {
            return Err(ConfigError::Invalid(format!(
                "flow_low({}) は flow_high({}) より小さい必要があります",
                self.flow_low, self.flow_high
            )));
        }
        if self.selfheal_retry == 0 {
            return Err(ConfigError::Invalid(
                "selfheal_retry は 1 以上である必要があります".to_string(),
            ));
        }
        if self.transcript_window_nodes == 0 {
            return Err(ConfigError::Invalid(
                "transcript_window_nodes は 1 以上である必要があります".to_string(),
            ));
        }
        if self.transcript_page_limit == 0 {
            return Err(ConfigError::Invalid(
                "transcript_page_limit は 1 以上である必要があります".to_string(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空のtomlは設計12の既定値になる() {
        let config = Config::from_toml_str("").unwrap();
        assert_eq!(config, Config::default());
        assert_eq!(config.stalled_threshold_secs, 120);
        assert_eq!(config.coalesce_ms, 8);
        assert_eq!(config.pty_ring_buffer, 1024 * 1024);
        assert_eq!(config.flow_high, 256 * 1024);
        assert_eq!(config.flow_low, 32 * 1024);
        assert_eq!(config.canary_model, "haiku");
        assert_eq!(config.repair_model, "sonnet");
        assert_eq!(config.selfheal_retry, 3);
        assert_eq!(config.selfheal_cooldown_hours, 24);
        assert!(config.selfheal_enabled);
        assert_eq!(config.canary_fallback_model, "sonnet");
        assert_eq!(config.selfheal_repo_dir, None);
    }

    #[test]
    fn 雛形は全キーを網羅し既定値と一致する() {
        // `config.toml.example` は利用者が最初に読む設定の一覧であり、README の設定表の
        // 元ネタでもある。ここが実装より遅れていると、増えたキーの存在に誰も気づけない
        // （実際にフェーズ5で増えた3キーが雛形に載らないまま残っていた）。
        //
        // 「読める」だけでなく「全キーが書かれている」ことまで見るのが要点。
        // 既定値が入るだけの `from_toml_str` は、キーが抜けていても通ってしまう。
        let example = include_str!("../../../config.toml.example");
        let config = Config::from_toml_str(example).expect("雛形が読めること");
        assert_eq!(
            config,
            Config::default(),
            "雛形の値が既定値と食い違っている"
        );

        let written: toml::Table = example.parse().expect("雛形が TOML として妥当なこと");
        let toml::Value::Table(with_values) =
            toml::Value::try_from(Config::default()).expect("既定値を TOML へ変換できること")
        else {
            unreachable!("Config は構造体なのでテーブルになる");
        };
        for key in with_values.keys() {
            assert!(
                written.contains_key(key),
                "{key} が config.toml.example に書かれていない"
            );
        }

        // Option 型のキーは既定が「未指定」で、TOML へ変換すると消えるため上の走査に乗らない。
        // 値を書くと利用者の環境に存在しないパスを指すことになるので、雛形では
        // **コメントとして例示**する。名指しでしか確かめられないので、ここに列挙する
        for key in ["selfheal_repo_dir", "state_dir", "claude_settings_path"] {
            assert!(
                !with_values.contains_key(key),
                "{key} に既定値が付いた。この列挙から外して通常の走査へ移すこと"
            );
            assert!(
                example.contains(&format!("# {key} =")),
                "{key} が config.toml.example にコメントとして例示されていない"
            );
        }
    }

    #[test]
    fn 権限確認スキップの既定はオフ() {
        // 権限確認を飛ばす機能なので、既定は必ずスキップしない側に置く（設計§9）
        assert!(!Config::default().always_bypass_permissions);
        let config = Config::from_toml_str("always_bypass_permissions = true").unwrap();
        assert!(config.always_bypass_permissions);
    }

    #[test]
    fn 明示したリポジトリが存在しなければ使わない() {
        // 設定の打ち間違いに気づかず「修復したつもり」で別の場所を触るほうが危ない。
        // 実在しないなら None にして、検知の通知だけに落とす
        let config = Config::from_toml_str(r#"selfheal_repo_dir = "/nonexistent/repo""#).unwrap();
        assert_eq!(config.agent().resolved_repo_dir(), None);
    }

    #[test]
    fn 指定したキーだけが上書きされる() {
        let config = Config::from_toml_str(
            r#"
            port = 9999
            coalesce_ms = 16
            repair_model = "opus"
            "#,
        )
        .unwrap();
        assert_eq!(config.port, 9999);
        assert_eq!(config.coalesce_ms, 16);
        assert_eq!(config.repair_model, "opus");
        // 触っていないキーは既定値のまま
        assert_eq!(config.stalled_threshold_secs, 120);
    }

    #[test]
    fn 型不一致は書式エラーになる() {
        let err = Config::from_toml_str(r#"port = "8787""#).unwrap_err();
        assert!(matches!(err, ConfigError::Parse { .. }), "実際: {err:?}");
    }

    #[test]
    fn 知らないキーは書式エラーになる() {
        // 打ち間違いを黙って無視すると「設定したのに効かない」事故になるため弾く。
        //
        // **2構造体を `#[serde(flatten)]` で束ねると、この検査は静かに効かなくなる。**
        // 分割しても1つの構造体で読んでいるのはそのため（本モジュールの冒頭を参照）。
        let err = Config::from_toml_str("porrt = 8787").unwrap_err();
        assert!(matches!(err, ConfigError::Parse { .. }), "実際: {err:?}");
    }

    #[test]
    fn 範囲外の値は値エラーになる() {
        for text in [
            "port = 0",
            "coalesce_ms = 0",
            "stalled_threshold_secs = 0",
            "pty_ring_buffer = 0",
            "selfheal_retry = 0",
        ] {
            let err = Config::from_toml_str(text).unwrap_err();
            assert!(
                matches!(err, ConfigError::Invalid(_)),
                "{text} で Invalid にならなかった: {err:?}"
            );
        }
    }

    #[test]
    fn flow_lowがflow_high以上なら値エラーになる() {
        let err = Config::from_toml_str(
            r#"
            flow_high = 1024
            flow_low = 1024
            "#,
        )
        .unwrap_err();
        assert!(matches!(err, ConfigError::Invalid(_)), "実際: {err:?}");
    }

    #[test]
    fn 存在しないファイルを明示指定したら読み取りエラーになる() {
        let err = Config::load(Some(Path::new("/nonexistent/config.toml"))).unwrap_err();
        assert!(matches!(err, ConfigError::Read { .. }), "実際: {err:?}");
    }

    #[test]
    fn 射影が全キーを漏らさず運ぶ() {
        // 既定値と違う値を全キーへ入れて、両側の射影がそれを運ぶことを見る。
        // 片方の射影でフィールドを写し忘れると、そのキーだけ**黙って既定値に戻る**という
        // 追いにくい壊れ方になる（設定したのに効かない、という利用者から見て同じ症状）。
        let config = Config::from_toml_str(
            r#"
            port = 9001
            stalled_threshold_secs = 61
            coalesce_ms = 9
            pty_ring_buffer = 2048
            flow_high = 4096
            flow_low = 1024
            always_bypass_permissions = true
            selfheal_enabled = false
            canary_model = "a"
            canary_fallback_model = "b"
            repair_model = "c"
            selfheal_retry = 7
            selfheal_cooldown_hours = 11
            selfheal_repo_dir = "/tmp/repo"
            transcript_window_nodes = 33
            transcript_page_limit = 44
            state_dir = "/tmp/state"
            inject_status_line = false
            claude_settings_path = "/tmp/settings.json"
            status_line_refresh_secs = 5
            "#,
        )
        .unwrap();

        let agent = config.agent();
        assert_eq!(agent.stalled_threshold_secs, 61);
        assert_eq!(agent.coalesce_ms, 9);
        assert_eq!(agent.pty_ring_buffer, 2048);
        assert!(agent.always_bypass_permissions);
        assert!(!agent.selfheal_enabled);
        assert_eq!(agent.canary_model, "a");
        assert_eq!(agent.canary_fallback_model, "b");
        assert_eq!(agent.repair_model, "c");
        assert_eq!(agent.selfheal_retry, 7);
        assert_eq!(agent.selfheal_cooldown_hours, 11);
        assert_eq!(agent.selfheal_repo_dir, Some(PathBuf::from("/tmp/repo")));
        assert_eq!(agent.transcript_window_nodes, 33);
        assert_eq!(agent.state_dir, Some(PathBuf::from("/tmp/state")));
        assert_eq!(
            agent.claude_settings_path,
            Some(PathBuf::from("/tmp/settings.json"))
        );
        assert!(!agent.inject_status_line);
        assert_eq!(agent.status_line_refresh_secs, 5);

        let server = config.server();
        assert_eq!(server.port, 9001);
        assert_eq!(server.flow_high, 4096);
        assert_eq!(server.flow_low, 1024);
        assert_eq!(server.transcript_page_limit, 44);
    }

    #[test]
    fn フックの宛先は待ち受けと同じポートになる() {
        // ローカルモードではフックの受信口がブラウザと同じポートに同居している。
        // 既定値が食い違うと、settings に焼き込まれた宛先が誰も待っていない場所を指し、
        // 「フックが1件も来ない」という形でしか表に出ない（設計§11 の縮退表示）
        assert_eq!(
            Config::default().agent().hook_port,
            Config::default().server().port
        );
        assert_eq!(
            Config::from_toml_str("port = 9002")
                .unwrap()
                .agent()
                .hook_port,
            9002
        );
    }
}
