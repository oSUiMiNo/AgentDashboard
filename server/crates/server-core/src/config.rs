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
/// LAN 開放で入館証が切れるまで（時間。設計§8-3）。
const DEFAULT_LAN_SESSION_TTL_HOURS: u64 = 5;

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
    /// フェーズ1 まではセッションホスト側の設定だった（窓が履歴の持ち主だったため）。
    /// **DB が真実になったので、窓ごとサーバ側へ移った**。
    pub transcript_window_nodes: usize,
    /// 記録の置き場所（設計§13-2）。
    ///
    /// 既定は `sqlite://<state_dir>/dashboard.db`。`state_dir` はセッションホスト側の
    /// キーなので、既定値の解決は両側を束ねる層が行う（[`ServerConfig::default`] は
    /// それを知らないため `None` のまま）。
    pub database_url: Option<String>,
    /// インスタンスの間の連絡係の居場所（設計§13-2・§9-1）。
    ///
    /// **無ければ連絡係を持たない。** ローカルモードと、インスタンスが1台だけの
    /// セルフホストはこれで足りる（配信はプロセスの中で完結する）。2台以上を並べる
    /// なら必須で、**設定し忘れると「どこへ繋いでも同じ結果」が静かに破れる**——
    /// 起動も接続も成功し、片方のブラウザにだけ更新が届かない形で現れる。
    pub valkey_url: Option<String>,
    /// ログインの Cookie に `Secure` を付けるか（設計§8-2・§13-2）。
    ///
    /// **既定は `false`。** `Secure` を付けた Cookie は HTTPS でしか送られないので、
    /// 平文で動かす手元やLAN では**付けた瞬間にログインできなくなる**。TLS を終端する
    /// リバースプロキシの裏に置いたときだけ `true` にする（§14-2）。
    ///
    /// 逆向きの既定（常に付ける）にしないのは、この設定を知らない利用者が最初に踏むのが
    /// 手元の平文だから。安全側の既定が「動かない」になると、外して使われることになる。
    pub cookie_secure: bool,
    /// LAN 開放で入館証が切れるまでの時間（設計§8-3）。
    ///
    /// パスワードは共有の1本なので、入りっぱなしにできると**その端末を持っている限り
    /// 誰でも入れる**状態が続く。作業のひと区切りより長く、置き忘れた端末が翌日まで
    /// 生き残らない長さとして既定5時間。
    pub lan_session_ttl_hours: u64,
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
            valkey_url: None,
            cookie_secure: false,
            lan_session_ttl_hours: DEFAULT_LAN_SESSION_TTL_HOURS,
        }
    }
}

impl ServerConfig {
    /// 待ち受けが**この機械の外から届きうるか**（設計§8-3）。
    ///
    /// ローカルモードでは、これが `true` のときだけ LAN パスワードを要求する。
    /// 判定を1箇所に置いているのは、`bind_addr` の書き方が何通りもあるため——
    /// `localhost` も `::1` も外へ出ていないので、綴りごとに条件を書くと必ず抜ける。
    pub fn reachable_from_lan(&self) -> bool {
        !matches!(
            self.bind_addr.as_str(),
            "127.0.0.1" | "localhost" | "::1" | "[::1]"
        )
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn bound_to(addr: &str) -> ServerConfig {
        ServerConfig {
            bind_addr: addr.to_string(),
            ..ServerConfig::default()
        }
    }

    #[test]
    fn 手元だけの綴りは_LAN_から届かないと判定する() {
        // 綴りごとに条件を書くと必ず抜ける。**判定を1箇所に置く**こと自体が、
        // 「鍵なしで開ける事故を仕組みで防ぐ」（要件1-1）の担保になっている
        for addr in ["127.0.0.1", "localhost", "::1", "[::1]"] {
            assert!(
                !bound_to(addr).reachable_from_lan(),
                "{addr} を外向きと判定している"
            );
        }
    }

    #[test]
    fn 広げた待ち受けは_LAN_から届くと判定する() {
        for addr in ["0.0.0.0", "192.168.1.10", "::"] {
            assert!(
                bound_to(addr).reachable_from_lan(),
                "{addr} を手元だけと判定している（鍵なしで開けてしまう）"
            );
        }
    }
}
