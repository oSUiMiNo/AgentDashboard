//! `agentdashboard` の中身（コマンドラインの解釈と、そこから先の入口）。
//!
//! 引数なしで起動するとサーバが立ち上がり、ブラウザからセッションを操作できるようになる。
//!
//! # なぜ実行ファイルの側に置かないのか
//!
//! 実行ファイルは**配布用のパッケージ**（`crates/dist`）が持っている。3本の実行ファイルを
//! 1つのアーカイブへ入れるには同じパッケージに置くしかなく（セルフホスト化設計§25 読み替え1）、
//! そちら側には呼び出しの1行しか置かない約束にしてある。中身がこちらにあるのは、その約束の側。

use clap::{Parser, Subcommand, ValueEnum};
use server_core::embed;
use session_host_core::{hook_post, logging, model_post};
use std::path::PathBuf;

use crate::{boot, config::Config, serve, serve_server};

/// `migrations` の出力の先頭に置く目印（CICD設計§9）。
///
/// **答えられたことを、目印の形が読めるかどうかで判定する。** 終了コードで見分けようと
/// すると、「知らないサブコマンド」と「起動できない」と「将来の版が正当な理由で失敗した」
/// を取り違える。末尾の数字は形が変わったときに上げる。
pub const SCHEMA_NAMES_MARKER: &str = "schema-names 1";

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
    /// 記録と状態の置き場所を表示する（`--purge` の対象になる場所）
    ///
    /// **消す側（`scripts/uninstall.sh` / `.ps1`）がここへ聞く。** あちらが自分で
    /// 組み立てると、実装の既定を変えたときに黙って食い違い、**消したつもりで記録だけが
    /// 残る**（Windows で実際に起きていた）。設定や環境変数で変えた場所もここに出る。
    ///
    /// 出力は**1行だけ**。`config` は TOML を出すが、未指定のキーは行ごと消えるので
    /// 解決後の場所を知る用途には使えない。
    StateDir,
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
    /// この実行ファイルが知っている記録の形の名前を並べる（CICD設計§9）
    ///
    /// **版を戻してよいかを決める門がここへ聞く。** 適用済みの形の中に、行き先の
    /// バイナリが知らないものが混じっていると、その版は**起動できない**（記録の道具が
    /// 拒む）。画面が出ないとポインタも直せないので、押す前に止めるしかない。
    ///
    /// 出力は先頭1行が [`SCHEMA_NAMES_MARKER`]、以降が1行1つ。**終了コードは当てにしない**
    /// ——この版より前のバイナリは「知らないサブコマンド」で断るが、起動できない場合や
    /// 将来の版が正当な理由で失敗する場合と区別が付かない。目印の形で読めたときだけ
    /// 「聞けた」と判定する。
    Migrations,
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
    /// ログを読む（ログ設計§11）
    ///
    /// **読めるのは、この機械の `<state_dir>/logs/` にあるファイルだけ。** 実配置は
    /// 3台に分かれているので、別の PC のログとサーバのログはここからは見えない。
    /// `--host` はまだ効かない——引きたい PC の上で `agentdashboard-agent logs` を叩く。
    ///
    /// **設定ファイルは読まない。** ログを見たいのはたいてい設定を触った直後なので、
    /// 設定が壊れていても読める側に倒してある。置き場所を移している場合は
    /// `--state-dir` で直接指すこと。
    Logs(session_host_core::logs::LogsArgs),
}

/// `agentdashboard` の入口。
///
/// # なぜ同期と非同期に割ってあるのか
///
/// 版の乗り換え（CICD設計§4）は同期の処理しか含まない——引数を読み、ポインタを読み、
/// 実行ファイルを差し替えるだけ。**非同期ランタイムを立てる理由が1つも無い**うえに、
/// 乗り換えた先が改めて自分のランタイムを立てるので、こちらで立てたものは使われずに捨てられる。
///
/// `#[tokio::main]` は展開後に同期の `fn` になるので、`crates/dist` の入口（各1行）から
/// 見た形は変わらない。
pub fn run() -> anyhow::Result<()> {
    // **いちばん早いところで一度触る。** ここで「プロセスの起動時刻」として確定する
    // （設定画面が「いつ起きたか」を出すのに使う）。触らないまま画面から呼ばれると、
    // 初めて呼ばれた時刻が起動時刻ということになってしまう
    let _ = session_host_core::version::started_at();

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
    // 形の名前も設定より前。**壊れた設定を渡されても答えられる必要がある**——門は
    // 「その設定を読めるか」も別に聞くので、ここで設定の失敗に巻き込まれると
    // 2つの問いの答えが混ざる（CICD設計§9）
    if matches!(cli.command, Some(Command::Migrations)) {
        println!("{SCHEMA_NAMES_MARKER}");
        for name in server_core::db::migration_names() {
            println!("{name}");
        }
        return Ok(());
    }
    // ログを読む口も設定より前（ログ設計§11-2）。**設定が壊れているときこそ読みたい**
    // ので、設定の失敗に巻き込まれてはいけない。引き換えに設定で置き場所を移している
    // 利用者のログは既定では読めないので、`--state-dir` を持たせてある
    if let Some(Command::Logs(args)) = &cli.command {
        if cli.config.is_some() {
            // `--config` は global なのでここまで通ってしまうが、この口は設定を読まない。
            // **黙って無視すると「指したのに効かない」になる**
            eprintln!(
                "注意：`logs` は設定ファイルを読まないので `--config` は効きません。置き場所を指すなら `--state-dir` を使ってください。"
            );
        }
        // **`logging::install` を呼ばない。** 呼ぶと起動時の掃除が走り、これから読む
        // ファイルを自分で掃くことになる
        return session_host_core::logs::run(args);
    }

    // **設定の失敗をここでは出さない。** 素直に `?` を付けると、設定が壊れている利用者は
    // 乗り換え判定へ辿り着けない——新しい版が増やしたキーを書いた状態で古い版を選ぶと、
    // 古い版は知らないキーで起動を拒み、**新しい版へ戻ることもできなくなる**
    // （画面が出ないのでポインタも直せない）。判定を通してから失敗させる（CICD設計§4）
    let config = Config::load(cli.config.as_deref());

    // **サブコマンドが無いときだけ乗り換える。** 門（CICD設計§9）が叩く `config` /
    // `state-dir` / `pair-token` が乗り換えると、聞いた相手と答えた相手が変わる。
    // とくに `state-dir` は消す道が叩くので、消す場所が版に振り回される
    if cli.command.is_none() {
        boot::hand_over_if_selected(config.as_ref().ok());
    }

    let config = config?;
    run_async(cli, config)
}

/// ここから先は今までどおり。
#[tokio::main]
async fn run_async(cli: Cli, config: Config) -> anyhow::Result<()> {
    match cli.command {
        Some(Command::Config) => {
            println!("{}", toml::to_string_pretty(&config)?);
        }
        Some(Command::StateDir) => {
            // **余計なものを書かない。** スクリプトが読むので、1行そのものが値になる
            println!("{}", config.agent().resolved_state_dir().display());
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
        Some(Command::HookPost { .. })
        | Some(Command::ModelPost { .. })
        | Some(Command::Migrations)
        | Some(Command::Logs(_)) => unreachable!(),
        None => {
            // **返り値を捨ててはいけない。** 非ブロッキング書き込みの見張り役なので、
            // 落とすと書き終わる前にプロセスが終わりうる（実測：200行のうち0行）。
            // `serve` の間ずっと持つ形になっている
            let _log = logging::install(logging::Proc::Dashboard, &config.agent());
            // **どの実行ファイルで動いているかを最初に出す。** 版を切り替えられるように
            // なると「更新したのに変わらない」が起こりうるが、画面へ版が出るのは先の
            // フェーズなので、実機で異常が出たときの切り分けはここだけが頼りになる
            tracing::info!(
                "実行ファイル: {} （版 {}）",
                std::env::current_exe()
                    .unwrap_or_else(|_| PathBuf::from("不明"))
                    .display(),
                env!("CARGO_PKG_VERSION")
            );
            // 渡すのは**門が行き先へ渡す `--config`**（CICD設計§9）。受け取ったときだけ渡す。
            // 設定画面からの書き戻し先はもう無い——保存先は記録（持ち出し設計§6）
            match cli.mode {
                Mode::Local => serve(config, cli.config).await?,
                Mode::Server => serve_server(config, cli.config).await?,
            }
        }
    }
    Ok(())
}
