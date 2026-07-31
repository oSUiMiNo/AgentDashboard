//! ダッシュボードサーバが使う設定（セルフホスト化設計§13-2）。
//!
//! ブラウザへの配信に関わるキーだけを持つ。PTY・自己修復・利用者のファイルに関わるキーは
//! `agent_core::config::AgentConfig` の担当で、こちらからは見えない。
//!
//! [`AgentConfig`] と同じく**ファイルは読まない**。`config.toml` を読むのは両側を束ねる
//! ローカルモードの実行ファイル（`agentdashboard_core::config::Config`）で、ここはその
//! 射影を受け取る。フェーズ3 以降はサーバ自身の設定（環境変数・compose）から作られる。
//!
//! [`AgentConfig`]: https://docs.rs/agent-core

const DEFAULT_PORT: u16 = 8787;
/// 待ち受けるアドレスの既定。**外から触れる経路をそもそも作らない**（設計§7）。
const DEFAULT_BIND_ADDR: &str = "127.0.0.1";
const DEFAULT_FLOW_HIGH: usize = 256 * 1024;
const DEFAULT_FLOW_LOW: usize = 32 * 1024;
const DEFAULT_TRANSCRIPT_PAGE_LIMIT: usize = 200;
const DEFAULT_TRANSCRIPT_WINDOW_NODES: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    /// ダッシュボードの待ち受けポート
    pub port: u16,
    /// 待ち受けるアドレス（セルフホスト化設計§13-2）。
    ///
    /// 既定は `127.0.0.1`——個人用のローカルツールとして、外から触れる経路をそもそも
    /// 作らない（設計§7）。セルフホストのコンテナでは `0.0.0.0` を渡す（§14-1）。
    ///
    /// **ここを広げるとブラウザが誰からでも開ける。** 鍵（ログインと LAN パスワード）は
    /// これから実装するので、それまでは信頼できるネットワークの中だけで広げること。
    /// 起動時に警告を出す。
    pub bind_addr: String,
    /// フロー制御の上側しきい値。未書き込みバイトがこれを超えたら pause（バイト）
    pub flow_high: usize,
    /// フロー制御の下側しきい値。ここまで減ったら resume（バイト）
    pub flow_low: usize,
    /// 履歴ページングの1回あたりの上限（ノード数）
    pub transcript_page_limit: usize,
    /// メモリに置く履歴の読みキャッシュの大きさ（ノード数。設計§3-3）。
    ///
    /// フェーズ1 まではエージェント側の設定だった（窓が履歴の持ち主だったため）。
    /// **DB が真実になったので、窓ごとサーバ側へ移った**。
    pub transcript_window_nodes: usize,
    /// 記録の置き場所（設計§13-2）。
    ///
    /// 既定は `sqlite://<state_dir>/dashboard.db`。`state_dir` はエージェント側の
    /// キーなので、既定値の解決は両側を束ねる層が行う（[`ServerConfig::default`] は
    /// それを知らないため `None` のまま）。
    pub database_url: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            bind_addr: DEFAULT_BIND_ADDR.to_string(),
            flow_high: DEFAULT_FLOW_HIGH,
            flow_low: DEFAULT_FLOW_LOW,
            transcript_page_limit: DEFAULT_TRANSCRIPT_PAGE_LIMIT,
            transcript_window_nodes: DEFAULT_TRANSCRIPT_WINDOW_NODES,
            database_url: None,
        }
    }
}
