//! ローカルモード／ダッシュボードサーバの実行ファイル。
//!
//! 中身は `agentdashboard_core::cli` にある。ここに書き足さないこと——crate 境界
//! （設計§2-1）はコンパイラが lib の依存グラフで守っており、この入口はその外側に立つ。

fn main() -> anyhow::Result<()> {
    agentdashboard_core::cli::run()
}
