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
const DEFAULT_FLOW_HIGH: usize = 256 * 1024;
const DEFAULT_FLOW_LOW: usize = 32 * 1024;
const DEFAULT_TRANSCRIPT_PAGE_LIMIT: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    /// ダッシュボードの待ち受けポート。127.0.0.1 のみにバインドする（設計§7）
    pub port: u16,
    /// フロー制御の上側しきい値。未書き込みバイトがこれを超えたら pause（バイト）
    pub flow_high: usize,
    /// フロー制御の下側しきい値。ここまで減ったら resume（バイト）
    pub flow_low: usize,
    /// 履歴ページングの1回あたりの上限（ノード数）
    pub transcript_page_limit: usize,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            flow_high: DEFAULT_FLOW_HIGH,
            flow_low: DEFAULT_FLOW_LOW,
            transcript_page_limit: DEFAULT_TRANSCRIPT_PAGE_LIMIT,
        }
    }
}
