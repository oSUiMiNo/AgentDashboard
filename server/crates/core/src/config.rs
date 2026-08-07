//! `config.toml` の読み込み（設計§12）。
//!
//! キー名は設計§12 の表記をそのまま採用している。サイズ系（`pty_ring_buffer` /
//! `flow_high` / `flow_low`）はバイト数の整数で受ける。
//!
//! # 1つのファイルから2つの設定を作る
//!
//! 中身はセッションホスト側（[`SessionHostConfig`]）とサーバ側（[`ServerConfig`]）に分かれるが、
//! **ローカルモードでは利用者が書くファイルは1つのまま**（セルフホスト化設計§13-2）。
//! そこで、読み込みと検証はこの1つの構造体が受け持ち、[`Config::agent`] /
//! [`Config::server`] が各側へ射影する。
//!
//! 構造体を2つに分けて `#[serde(flatten)]` で束ねる形にはしない。**flatten を使うと
//! `deny_unknown_fields` が効かなくなり**、「知らないキーを書いたらエラー」という
//! 約束が静かに壊れる（打ち間違いを黙って無視すると「設定したのに効かない」事故になる）。

use serde::{Deserialize, Serialize};
use server_core::config::ServerConfig;
use session_host_core::config::{SessionHostConfig, env};
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
/// 個々のキーの意味は、射影先である [`SessionHostConfig`] と [`ServerConfig`] のドキュメントを
/// 参照する。ここに二重に書くと、片方だけ直された説明が残ることになる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Config {
    pub port: u16,
    pub bind_addr: String,
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
    pub database_url: Option<String>,
    pub valkey_url: Option<String>,
    pub cookie_secure: bool,
    pub lan_session_ttl_hours: u64,
    pub inject_status_line: bool,
    pub claude_settings_path: Option<PathBuf>,
    pub status_line_refresh_secs: u64,
    pub log_retention_days: u64,
    pub log_max_bytes: u64,
    pub log_file_level: String,
}

impl Default for Config {
    /// 既定値は**射影先が持つ**。ここで値を書き直すと、片方だけ変えたときに
    /// 「ファイルを書かなかった場合」と「書いた場合」で挙動が分かれる。
    fn default() -> Self {
        let agent = SessionHostConfig::default();
        let server = ServerConfig::default();
        Self {
            port: server.port,
            bind_addr: server.bind_addr,
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
            transcript_window_nodes: server.transcript_window_nodes,
            transcript_page_limit: server.transcript_page_limit,
            state_dir: agent.state_dir,
            database_url: server.database_url,
            valkey_url: server.valkey_url,
            cookie_secure: server.cookie_secure,
            lan_session_ttl_hours: server.lan_session_ttl_hours,
            inject_status_line: agent.inject_status_line,
            claude_settings_path: agent.claude_settings_path,
            status_line_refresh_secs: agent.status_line_refresh_secs,
            log_retention_days: agent.log_retention_days,
            log_max_bytes: agent.log_max_bytes,
            log_file_level: agent.log_file_level,
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
                    Self::from_toml_str("")
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
    ///
    /// **読んだあと、環境変数で上書きする**（[`Self::apply_env`]）。ファイルより
    /// 環境変数が強いのは、compose では設定ファイルを配らずに環境変数で渡すのが
    /// 自然だから（設計§14-1）。
    pub fn from_toml_str(text: &str) -> Result<Self, ConfigError> {
        let mut table: toml::Table = toml::from_str(text).map_err(|source| ConfigError::Parse {
            path: PathBuf::from("<inline>"),
            source,
        })?;
        Self::apply_env(&mut table)?;

        // 表へ起こしてから読み直しても `deny_unknown_fields` は効く（知らないキーは
        // ここで弾かれる）。打ち間違いを黙って無視しないという約束は保たれている
        let config: Config =
            toml::Value::Table(table)
                .try_into()
                .map_err(|source| ConfigError::Parse {
                    path: PathBuf::from("<inline>"),
                    source,
                })?;
        config.validate()?;
        Ok(config)
    }

    /// 環境変数での上書きを当てる（設計§14-1）。
    ///
    /// # なぜキーを書き並べないのか
    ///
    /// 対応表を手で持つと、**キーを増やしたときに足し忘れる**。足し忘れは
    /// 「compose では設定できないキーが1つだけある」という形でしか表に出ず、
    /// 気づくのは配ったあとになる。そこで [`Config`] 自身を TOML の表へ起こし、
    /// **そこにあるキーを全部見る**。以後の新キーは何もしなくても対応する。
    ///
    /// 仕組みそのものは [`session_host_core::config::env`] にある。`agent.toml`（セッションホスト
    /// 単体の設定）でも同じ形が要るので、**両方から見える場所へ置いてある**。
    fn apply_env(table: &mut toml::Table) -> Result<(), ConfigError> {
        env::apply(table, &Self::key_shapes(), BARE_ENV_ALIASES).map_err(ConfigError::Invalid)
    }

    /// 全キーと、その値の形。
    ///
    /// 未指定が既定のキー（`Option`）は既定値の表から消えてしまうので、**全部を
    /// 埋めた見本**から取り出す。ここが漏れるとそのキーだけ環境変数で設定できなくなる
    /// ——それを見つけるのが `全キーが環境変数で上書きできる` のテスト。
    fn key_shapes() -> Vec<(String, toml::Value)> {
        let probe = Config {
            selfheal_repo_dir: Some(PathBuf::from("/probe")),
            state_dir: Some(PathBuf::from("/probe")),
            claude_settings_path: Some(PathBuf::from("/probe")),
            database_url: Some("sqlite://probe".to_string()),
            valkey_url: Some("redis://probe".to_string()),
            ..Config::default()
        };
        env::shapes_of(&probe).expect("既定値を TOML へ変換できること")
    }

    /// セッションホスト（PC 側）が使う分だけを取り出す。
    ///
    /// `hook_port` に待ち受けポートを入れているのは、ローカルモードではフックの宛先が
    /// ブラウザと同じポートに同居しているため。フェーズ3 で別プロセスになると、ここは
    /// セッションホスト自身の設定から来る（セルフホスト化設計§5-3）。
    pub fn agent(&self) -> SessionHostConfig {
        SessionHostConfig {
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
            state_dir: self.state_dir.clone(),
            claude_settings_path: self.claude_settings_path.clone(),
            inject_status_line: self.inject_status_line,
            status_line_refresh_secs: self.status_line_refresh_secs,
            hook_port: self.port,
            log_retention_days: self.log_retention_days,
            log_max_bytes: self.log_max_bytes,
            log_file_level: self.log_file_level.clone(),
            // 接続の3つは `agent.toml` にだけ意味がある（セルフホスト化設計§21 読み替え8）。
            // ローカルモードは同じプロセスに同居していて、繋ぐ相手が自分自身になる
            server_url: None,
            pairing_token: None,
            agent_name: None,
        }
    }

    /// ダッシュボードサーバが使う分だけを取り出す。
    pub fn server(&self) -> ServerConfig {
        ServerConfig {
            port: self.port,
            bind_addr: self.bind_addr.clone(),
            flow_high: self.flow_high,
            flow_low: self.flow_low,
            transcript_page_limit: self.transcript_page_limit,
            transcript_window_nodes: self.transcript_window_nodes,
            // 既定は状態の置き場所の隣。**セッションホスト側のキーから決まる**ので、
            // 両側を知っているこの層でしか解決できない（`ServerConfig::default` は
            // `state_dir` を知らないため `None` のまま）
            database_url: Some(self.resolved_database_url()),
            // **既定を作らない。** 繋ぐ先を勝手に決めると、書き間違いが「別の
            // Valkey に繋がっている」ではなく「繋がらない」として出る
            valkey_url: self.valkey_url.clone(),
            cookie_secure: self.cookie_secure,
            lan_session_ttl_hours: self.lan_session_ttl_hours,
        }
    }

    /// 記録の置き場所を決める（設計§13-2）。
    ///
    /// 明示が無ければ状態の置き場所（`state_dir`）の隣に SQLite ファイルを作る。
    /// ビルド成果物の中や一時ディレクトリに置かないのは再開位置と同じ理由——
    /// 消えると**一覧と履歴が丸ごと消える**。
    pub fn resolved_database_url(&self) -> String {
        if let Some(url) = &self.database_url {
            return url.clone();
        }
        let path = self.agent().resolved_state_dir().join("dashboard.db");
        format!("sqlite://{}", path.display())
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
        // 0 だと「発行した瞬間に切れる入館証」になり、LAN からは永久に入れない。
        // 期限を無くしたい要望はここではなく §16 の持ち越し（共有パスワードのまま
        // 無期限にするのは、置き忘れた端末がそのまま鍵になることを意味する）
        if self.lan_session_ttl_hours == 0 {
            return Err(ConfigError::Invalid(
                "lan_session_ttl_hours は 1 以上である必要があります".to_string(),
            ));
        }
        // 0 だと今日書いたぶんまで「古い」扱いになり、起動のたびに直前のログを消す
        if self.log_retention_days == 0 {
            return Err(ConfigError::Invalid(
                "log_retention_days は 1 以上である必要があります".to_string(),
            ));
        }
        // 0 だと掃除が毎回すべてを消しにいく
        if self.log_max_bytes == 0 {
            return Err(ConfigError::Invalid(
                "log_max_bytes は 1 以上である必要があります".to_string(),
            ));
        }
        // `log_file_level` はここで断らない。読めない綴りは logging 側が `debug` へ
        // 落として**そのことをログに残す**（黙って落ちるのがこのイシューの敵）
        Ok(())
    }
}

/// 接頭辞なしでも受ける環境変数（設計§14-1 の compose 例）。
///
/// **例外だけをここに並べる。** 既定は `AGENTDASHBOARD_<キー>` で、そちらは
/// [`Config::key_shapes`] が自動で拾う。
const BARE_ENV_ALIASES: &[(&str, &str)] = &[
    ("database_url", "DATABASE_URL"),
    ("valkey_url", "VALKEY_URL"),
];

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
        for key in [
            "selfheal_repo_dir",
            "state_dir",
            "claude_settings_path",
            "database_url",
        ] {
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
            bind_addr = "0.0.0.0"
            cookie_secure = true
            lan_session_ttl_hours = 3
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
            database_url = "sqlite:///tmp/db/dashboard.db"
            valkey_url = "redis://127.0.0.1:6379"
            inject_status_line = false
            claude_settings_path = "/tmp/settings.json"
            status_line_refresh_secs = 5
            log_retention_days = 3
            log_max_bytes = 4096
            log_file_level = "trace"
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
        assert_eq!(agent.state_dir, Some(PathBuf::from("/tmp/state")));
        assert_eq!(
            agent.claude_settings_path,
            Some(PathBuf::from("/tmp/settings.json"))
        );
        assert!(!agent.inject_status_line);
        assert_eq!(agent.status_line_refresh_secs, 5);
        assert_eq!(agent.log_retention_days, 3);
        assert_eq!(agent.log_max_bytes, 4096);
        assert_eq!(agent.log_file_level, "trace");

        let server = config.server();
        assert_eq!(server.port, 9001);
        assert_eq!(server.flow_high, 4096);
        assert_eq!(server.flow_low, 1024);
        assert_eq!(server.transcript_page_limit, 44);
        assert_eq!(server.transcript_window_nodes, 33);
        assert_eq!(
            server.database_url.as_deref(),
            Some("sqlite:///tmp/db/dashboard.db")
        );
        assert_eq!(server.bind_addr, "0.0.0.0");
        assert!(server.cookie_secure);
        assert_eq!(server.lan_session_ttl_hours, 3);
        assert_eq!(server.valkey_url.as_deref(), Some("redis://127.0.0.1:6379"));
    }

    /// そのキーへ入れて意味のある値（既定と必ず違うもの）。
    fn probe_value(key: &str, shape: &toml::Value) -> String {
        match (key, shape) {
            // フロー制御は2つで1組。片方だけ極端な値にすると `flow_low < flow_high` を
            // 破って値エラーになり、**上書きが効いたのか値が弾かれたのか**が分からなくなる
            ("flow_high", _) => "999999".to_string(),
            ("flow_low", _) => "42".to_string(),
            (_, toml::Value::Integer(_)) => "4242".to_string(),
            // 既定の逆を入れる。同じ値だと「上書きが効いた」ことにならない
            (_, toml::Value::Boolean(value)) => (!value).to_string(),
            _ => "/tmp/env-probe".to_string(),
        }
    }

    #[test]
    fn 全キーが環境変数で上書きできる() {
        // compose は設定ファイルを配らず環境変数で渡す（設計§14-1）。1つでも
        // 対応していないキーがあると「そのキーだけコンテナで設定できない」という、
        // 配ってからでないと気づけない穴になる。
        //
        // **キーの一覧を手で持たない**のが要点。実装（`Config`）から取り出しているので、
        // 今後キーを増やしてもこのテストは自動でそれを見る
        for (key, shape) in Config::key_shapes() {
            let name = format!("AGENTDASHBOARD_{}", key.to_uppercase());
            let raw = probe_value(&key, &shape);
            unsafe { std::env::set_var(&name, &raw) };

            let config = Config::from_toml_str("")
                .unwrap_or_else(|err| panic!("{key} を環境変数で指定したら読めなくなった: {err}"));
            let toml::Value::Table(written) =
                toml::Value::try_from(config).expect("TOML へ変換できること")
            else {
                unreachable!("Config は構造体なのでテーブルになる");
            };
            let expected = env::parse_value(&key, &raw, &shape).expect("読めること");
            assert_eq!(
                written.get(&key),
                Some(&expected),
                "{key} が環境変数で上書きされていない"
            );

            unsafe { std::env::remove_var(&name) };
        }
    }

    #[test]
    fn 環境変数はファイルより強い() {
        // 設定ファイルを同梱したイメージへ、環境変数だけで別の値を渡せること
        unsafe { std::env::set_var("AGENTDASHBOARD_PORT", "9100") };
        let config = Config::from_toml_str("port = 8787").unwrap();
        assert_eq!(config.port, 9100);
        unsafe { std::env::remove_var("AGENTDASHBOARD_PORT") };
    }

    #[test]
    fn 裸の名前の環境変数も受けるが接頭辞つきが勝つ() {
        // compose の慣行（設計§14-1 の例）に合わせる。ただし裸の名前は他のソフトウェアと
        // 衝突しうるので、こちらの名前を先に見る
        unsafe { std::env::set_var("DATABASE_URL", "postgres://bare/db") };
        assert_eq!(
            Config::from_toml_str("").unwrap().database_url.as_deref(),
            Some("postgres://bare/db")
        );

        unsafe { std::env::set_var("AGENTDASHBOARD_DATABASE_URL", "postgres://prefixed/db") };
        assert_eq!(
            Config::from_toml_str("").unwrap().database_url.as_deref(),
            Some("postgres://prefixed/db")
        );

        unsafe { std::env::remove_var("DATABASE_URL") };
        unsafe { std::env::remove_var("AGENTDASHBOARD_DATABASE_URL") };
    }

    #[test]
    fn 環境変数の型が合わなければ理由を出して断る() {
        // 素通しして「設定したのに効かない」になるより、その場で断るほうがよい
        unsafe { std::env::set_var("AGENTDASHBOARD_PORT", "はちななはちなな") };
        let err = Config::from_toml_str("").unwrap_err();
        let ConfigError::Invalid(message) = &err else {
            panic!("値エラーにならなかった: {err:?}");
        };
        assert!(message.contains("port"), "どのキーか分かること: {message}");
        assert!(
            message.contains("整数"),
            "何を期待したか分かること: {message}"
        );
        unsafe { std::env::remove_var("AGENTDASHBOARD_PORT") };
    }

    #[test]
    fn 記録の置き場所は状態の置き場所の隣になる() {
        // 消えると**一覧と履歴が丸ごと消える**ので、再開位置と同じ扱いにする
        let config = Config::from_toml_str(r#"state_dir = "/tmp/adash-state""#).unwrap();
        assert_eq!(
            config.resolved_database_url(),
            "sqlite:///tmp/adash-state/dashboard.db"
        );
        // 明示があればそちらが勝つ
        let config = Config::from_toml_str(
            r#"
            state_dir = "/tmp/adash-state"
            database_url = "postgres://db/agentdashboard"
            "#,
        )
        .unwrap();
        assert_eq!(
            config.resolved_database_url(),
            "postgres://db/agentdashboard"
        );
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
