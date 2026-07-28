//! AgentDashboard の core サーバ（設計§1）。
//!
//! フェーズ0時点では土台のみ。Session Manager / Hook Ingest / WS Gateway 等の実装は
//! フェーズ1以降で本ファイルへ足していく。

mod config;
mod embed;

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "agentdashboard",
    version,
    about = "Claude Code セッションの司令塔ダッシュボード"
)]
struct Cli {
    /// 設定ファイルのパス。省略時はカレントの config.toml、それも無ければ既定値
    #[arg(long, global = true, value_name = "PATH")]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// 解決後の設定を表示する
    Config,
    /// 単一バイナリへ同梱された web アセットを一覧・取り出しする
    Embedded {
        /// 指定したパスのファイル内容を標準出力へ書き出す
        #[arg(long, value_name = "PATH")]
        get: Option<String>,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let config = config::Config::load(cli.config.as_deref())?;

    match cli.command {
        Some(Command::Config) => {
            println!("{}", toml::to_string_pretty(&config)?);
        }
        Some(Command::Embedded { get: None }) => {
            let paths = embed::list();
            println!("同梱アセット {} 件", paths.len());
            for path in paths {
                println!("{path}");
            }
        }
        Some(Command::Embedded { get: Some(path) }) => {
            let Some(data) = embed::get(&path) else {
                anyhow::bail!("同梱アセットが見つかりません: {path}");
            };
            use std::io::Write as _;
            std::io::stdout().write_all(&data)?;
        }
        None => {
            // サーバ起動はフェーズ1（M1: 動くターミナル）で実装する。
            // ここで黙って何もしないと「起動したつもり」の誤解を生むため明示的に伝える。
            println!(
                "AgentDashboard {} — 土台のみ（フェーズ0）。サーバ起動はフェーズ1で実装します。",
                env!("CARGO_PKG_VERSION")
            );
            println!("待ち受け予定ポート: {}", config.port);
            println!("同梱アセット: {} 件", embed::list().len());
        }
    }
    Ok(())
}
