//! AgentDashboard の実行ファイル。
//!
//! 引数なしで起動するとサーバが立ち上がり、ブラウザからセッションを操作できるようになる。
//! 中身は [`agentdashboard_core`] 側にあり、ここは CLI の解釈だけを担う。

use agent_core::{hook_post, model_post};
use agentdashboard_core::{config, config::Config, serve, serve_server};
use clap::{Parser, Subcommand, ValueEnum};
use server_core::embed;
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

    /// 動かし方（セルフホスト化設計§1-1）
    #[arg(long, value_enum, default_value = "local")]
    mode: Mode,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Mode {
    /// 1台で完結する使い方。PC 側とサーバ側が同じプロセスに同居する
    Local,
    /// ダッシュボードサーバだけ。セッションの実体は繋いできた PC の中にある
    Server,
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
    /// 注入した statusLine から起動され、いまのモデルをダッシュボードへ転送する（設計§4）
    ///
    /// `hook-post` と違い、**標準出力にモデルの表示名を書く**。statusLine の標準出力は
    /// 会話ではなく端末の表示になるので、書かないとその行が空になる。
    /// こちらも失敗しても終了コード 0 で終わる。
    ModelPost {
        /// 転送先。`http://127.0.0.1:<port>/model/<token>`
        #[arg(long, value_name = "URL")]
        url: String,
    },
    /// PC を繋ぐためのペアリングトークンを発行する（セルフホスト化設計§8-4）
    ///
    /// **平文はここでしか手に入らない**（DB にはハッシュしか置かない）。発行の画面は
    /// これから作るので、それまでの入口がこのコマンドになる。
    PairToken {
        /// 誰のものにするか。無ければ作る（パスワードは持たないので画面には入れない）
        #[arg(long, value_name = "NAME", default_value = "local")]
        account: String,
        /// どの PC 用かを後から見分けるための札
        #[arg(long, value_name = "LABEL", default_value = "")]
        label: String,
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
    // statusLine も同じ理由で設定より前に処理する（利用者のプロジェクトが cwd になる）
    if let Some(Command::ModelPost { url }) = &cli.command {
        model_post::run(url);
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
        Some(Command::PairToken { account, label }) => {
            let db = server_core::db::connect(&config.resolved_database_url()).await?;
            let account_id = server_core::db::pairing::ensure_account(&db, &account).await?;
            let token = server_core::db::pairing::issue_token(&db, account_id, &label).await?;
            // **1回だけ表示する。** 控えを取り損ねたら、作り直してもらうほうが安全
            println!("{token}");
            eprintln!(
                "アカウント「{account}」のトークンを発行しました。\n\
                 PC 側の agent.toml へ pairing_token として貼ってください（この表示は一度きりです）。"
            );
        }
        // 上で先に処理して戻っている
        Some(Command::HookPost { .. }) | Some(Command::ModelPost { .. }) => unreachable!(),
        None => {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| "info".into()),
                )
                .init();
            match cli.mode {
                Mode::Local => serve(config, config_path).await?,
                Mode::Server => serve_server(config).await?,
            }
        }
    }
    Ok(())
}
