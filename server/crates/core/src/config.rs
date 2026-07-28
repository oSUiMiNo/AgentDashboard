//! `config.toml` の読み込み（設計§12）。
//!
//! キー名は設計§12 の表記をそのまま採用している。サイズ系（`pty_ring_buffer` /
//! `flow_high` / `flow_low`）はバイト数の整数で受ける。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 設定の既定ファイル名。カレントディレクトリから探す。
pub const DEFAULT_FILE_NAME: &str = "config.toml";

const DEFAULT_PORT: u16 = 8787;
const DEFAULT_STALLED_THRESHOLD_SECS: u64 = 120;
const DEFAULT_COALESCE_MS: u64 = 8;
const DEFAULT_PTY_RING_BUFFER: usize = 1024 * 1024;
const DEFAULT_FLOW_HIGH: usize = 256 * 1024;
const DEFAULT_FLOW_LOW: usize = 32 * 1024;
const DEFAULT_CANARY_MODEL: &str = "haiku";
const DEFAULT_SELFHEAL_RETRY: u32 = 3;
const DEFAULT_SELFHEAL_COOLDOWN_HOURS: u64 = 24;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Config {
    /// ダッシュボードの待ち受けポート。127.0.0.1 のみにバインドする（設計§7）
    pub port: u16,
    /// Working のままこの秒数イベントが途絶したら Stalled とみなす
    pub stalled_threshold_secs: u64,
    /// PTY 出力をまとめてから送るまでの窓（ミリ秒）
    pub coalesce_ms: u64,
    /// セッションごとの scrollback リングバッファ（バイト）
    pub pty_ring_buffer: usize,
    /// フロー制御の上側しきい値。未書き込みバイトがこれを超えたら pause（バイト）
    pub flow_high: usize,
    /// フロー制御の下側しきい値。ここまで減ったら resume（バイト）
    pub flow_low: usize,
    /// カナリアセッションで使うモデル
    pub canary_model: String,
    /// 修復セッションで使うモデル。None なら通常モデル
    pub repair_model: Option<String>,
    /// 修復の再試行上限
    pub selfheal_retry: u32,
    /// 同一バージョンへの再挑戦を抑制する時間
    pub selfheal_cooldown_hours: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            stalled_threshold_secs: DEFAULT_STALLED_THRESHOLD_SECS,
            coalesce_ms: DEFAULT_COALESCE_MS,
            pty_ring_buffer: DEFAULT_PTY_RING_BUFFER,
            flow_high: DEFAULT_FLOW_HIGH,
            flow_low: DEFAULT_FLOW_LOW,
            canary_model: DEFAULT_CANARY_MODEL.to_string(),
            repair_model: None,
            selfheal_retry: DEFAULT_SELFHEAL_RETRY,
            selfheal_cooldown_hours: DEFAULT_SELFHEAL_COOLDOWN_HOURS,
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
        assert_eq!(config.repair_model, None);
        assert_eq!(config.selfheal_retry, 3);
        assert_eq!(config.selfheal_cooldown_hours, 24);
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
        assert_eq!(config.repair_model.as_deref(), Some("opus"));
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
        // 打ち間違いを黙って無視すると「設定したのに効かない」事故になるため弾く
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
}
