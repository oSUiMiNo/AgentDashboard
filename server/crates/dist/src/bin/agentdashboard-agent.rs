//! セッションホストの実行ファイル。
//!
//! 中身は `agentdashboard_agent` にある。ここに書き足さないこと——**配るセッションホストが
//! サーバ側の荷物を引き込まない**という約束は、あちらの依存グラフで証明されている。

fn main() -> anyhow::Result<()> {
    agentdashboard_agent::run()
}
