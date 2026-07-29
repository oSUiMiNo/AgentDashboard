//! AgentDashboard の実行ファイル。
//!
//! 引数なしで起動するとサーバが立ち上がり、ブラウザからセッションを操作できるようになる。
//! 中身は [`agentdashboard_core`] 側にあり、ここは CLI の解釈だけを担う。

use agentdashboard_core::{config, config::Config, embed, hook_post, serve};
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
    /// フックから起動され、stdin のJSONをダッシュボードへ転送する（設計§7）
    ///
    /// 標準出力には何も書かず、失敗しても終了コード 0 で終わる。
    HookPost {
        /// 転送先。`http://127.0.0.1:<port>/hook/<token>/<イベント名>`
        #[arg(long, value_name = "URL")]
        url: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // フック転送だけは設定の読み込みより前に処理する。フックは利用者のプロジェクトを
    // 作業ディレクトリとして起動されるため、そこに無関係な config.toml があると
    // 設定の読み込みで失敗し、フックが非ゼロ終了してしまう
    if let Some(Command::HookPost { url }) = &cli.command {
        hook_post::run(url);
        return Ok(());
    }

    let config = Config::load(cli.config.as_deref())?;
    // 設定画面からの書き戻し先（設計§7）。`--config` が無ければカレントの config.toml を
    // 指す。まだ存在しなくてよい — 書き換えたときに作る
    let config_path = cli
        .config
        .clone()
        .unwrap_or_else(|| PathBuf::from(config::DEFAULT_FILE_NAME));

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
        // 上で先に処理して戻っている
        Some(Command::HookPost { .. }) => unreachable!(),
        None => {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| "info".into()),
                )
                .init();
            serve(config, config_path).await?;
        }
    }
    Ok(())
}
