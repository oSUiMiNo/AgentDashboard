//! `agentdashboard` の中身（コマンドラインの解釈と、そこから先の入口）。
//!
//! 引数なしで起動するとサーバが立ち上がり、ブラウザからセッションを操作できるようになる。
//!
//! # なぜ実行ファイルの側に置かないのか
//!
//! 実行ファイルは**配布用のパッケージ**（`crates/dist`）が持っている。3本の実行ファイルを
//! 1つのアーカイブへ入れるには同じパッケージに置くしかなく（セルフホスト化設計§25 読み替え1）、
//! そちら側には呼び出しの1行しか置かない約束にしてある。中身がこちらにあるのは、その約束の側。

use clap::{Args, Parser, Subcommand, ValueEnum};
use server_core::embed;
use session_host_core::{hook_post, logging, model_post};
use std::path::PathBuf;

use crate::client::{self, output};
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

    /// 話しかけるダッシュボード（CLI設計§4-1）。省略時は手元の 127.0.0.1:<config の port>。
    /// 環境変数 ADASH_SERVER でも指定でき、両方あれば引数が勝つ
    #[arg(long, global = true, value_name = "URL")]
    server: Option<String>,

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
    /// **既定で読めるのは、この機械の `<state_dir>/logs/` にあるファイルだけ。**
    ///
    /// `--host <ID>` は、**同じ機械で動いているダッシュボード**（127.0.0.1）を通して
    /// 繋がっている PC のログを引く。外のサーバは見えない。
    ///
    /// **いまの構成では、この道は使えない。** ローカルモードは PC の受け口を持たず、
    /// サーバモードはアカウントでログインする形式なので CLI からは 401 になる。
    /// 別の PC のログは、ブラウザから `GET /api/hosts/<ID>/logs` を叩くか、
    /// その PC の上で `agentdashboard-agent logs` を叩くこと。
    ///
    /// **設定ファイルは読まない。** ログを見たいのはたいてい設定を触った直後なので、
    /// 設定が壊れていても読める側に倒してある。置き場所を移している場合は
    /// `--state-dir` で直接指すこと。**`--host` のときだけは設定を読む**（待ち受け
    /// ポートを知るため）。
    Logs(session_host_core::logs::LogsArgs),
    /// セッションを見る・操作する（動いているダッシュボードに話しかける。CLI設計§3）
    #[command(subcommand)]
    Session(SessionCmd),
    /// PJT 枠を見る・操作する
    #[command(subcommand)]
    Project(ProjectCmd),
    /// 繋がっている PC のフォルダやファイルを覗く
    ///
    /// **ログを引く口はここには無い。** 別 PC のログは既存の `logs --host <ID>` を使う
    /// （同じ道を2つ作らない。CLI設計§3-2）
    #[command(subcommand)]
    Host(HostCmd),
    /// ダッシュボードの設定を見る
    #[command(subcommand)]
    Settings(SettingsCmd),
    /// ダッシュボードの版を見る
    #[command(subcommand)]
    Version(VersionCmd),
}

/// `--json` の置き場所。読む系の全コマンドが同じ旗を持つ（CLI設計§10-2）。
#[derive(Args)]
struct OutputArgs {
    /// サーバの応答をそのまま JSON で出す（機械向け。CLI 側で加工しない）
    #[arg(long)]
    json: bool,
}

#[derive(Subcommand)]
enum SessionCmd {
    /// セッションの一覧
    Ls {
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 1本のセッションの詳細
    Show {
        /// カードID。先頭の数文字で足りる（前方一致で一意なら通る）
        id: String,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 履歴（構造化ビューと同じもの）を読む
    Transcript {
        /// カードID。先頭の数文字で足りる
        id: String,
        /// このノードIDより前を読む（遡り）
        #[arg(long, value_name = "NODE")]
        before: Option<String>,
        /// 1回で読む最大ノード数（サーバの既定は200）
        #[arg(long, value_name = "N")]
        limit: Option<usize>,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// セッションを起こす。新しいカードのフルIDを標準出力へ返す
    Spawn {
        /// 作業ディレクトリ
        cwd: String,
        /// 権限モード（例：acceptEdits / bypassPermissions / plan）。省略すると既定
        #[arg(long, value_name = "MODE")]
        mode: Option<String>,
        /// どの PC で起こすか（繋がっている PC が2台以上のときは必須）
        #[arg(long, value_name = "AGENT_ID")]
        host: Option<String>,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 指示を送る。既定は投げて終わり（届いたかは確かめない）
    Send {
        /// カードID。先頭の数文字で足りる
        id: String,
        /// 送る本文
        text: String,
        /// ターンの終わり（入力待ちへ戻る）まで待つ。
        /// 既に作業中のセッションへ送った場合は、いま走っているターンの終わりで返りうる
        #[arg(long)]
        wait: bool,
        /// `--wait` の上限秒
        #[arg(long, value_name = "SECS", default_value_t = client::wait::SEND_DEFAULT_CAP_SECS)]
        timeout: u64,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// セッションを終了する（終了の知らせまで待つ）
    Kill {
        /// カードID。先頭の数文字で足りる
        id: String,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// カードを一覧から外す（外れたの知らせまで待つ）。履歴の記録は残る
    Rm {
        /// カードID。先頭の数文字で足りる
        id: String,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// モデルを切り替える（切り替わったの知らせまで待つ）
    Model {
        /// カードID。先頭の数文字で足りる
        id: String,
        /// 切り替え先（別名で渡す。例：opus / sonnet / haiku / default）
        model: String,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 権限モードを切り替える（反映の知らせまで待つ）
    Mode {
        /// カードID。先頭の数文字で足りる
        id: String,
        /// 切り替え先（例：default / acceptEdits / plan。行けないモードは断られる）
        mode: String,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 端末の大きさを変える（待たない）
    Resize {
        /// カードID。先頭の数文字で足りる
        id: String,
        #[arg(long, value_name = "N")]
        cols: u16,
        #[arg(long, value_name = "N")]
        rows: u16,
        #[command(flatten)]
        out: OutputArgs,
    },
}

#[derive(Subcommand)]
enum ProjectCmd {
    /// PJT 枠の一覧
    Ls {
        #[command(flatten)]
        out: OutputArgs,
    },
    /// PJT 枠を足す（設定が ON ならセッションも1本起きる）
    Add {
        /// どの PC か。この機械なら `local`、繋いだ PC はその ID
        host: String,
        /// 作業ディレクトリのパス
        path: String,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// PJT 枠を外す（セッションが動いている枠は断られる）
    Rm {
        /// 枠のID。先頭の数文字で足りる（一覧は `project ls --json`）
        id: String,
        #[command(flatten)]
        out: OutputArgs,
    },
}

#[derive(Subcommand)]
enum HostCmd {
    /// PC のフォルダを覗く（PJT 専用画面の左パネルと同じ口）
    Dir {
        /// どの PC か。この機械なら `local`、繋いだ PC はその ID
        host: String,
        /// 覗くパス。省略するとホームディレクトリ
        path: Option<String>,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// PC のファイルを読む
    File {
        /// どの PC か。この機械なら `local`
        host: String,
        /// 読むファイルのパス
        path: String,
        #[command(flatten)]
        out: OutputArgs,
    },
}

#[derive(Subcommand)]
enum SettingsCmd {
    /// いまの設定を出す（中身は解釈せず、サーバの答えをそのまま出す）
    Show {
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 設定を1項目だけ変える（触った項目だけを送る。CLI設計§12-1）
    Set {
        /// キー（always_bypass_permissions / project_autostart_session /
        /// sync_interval_secs / screen_interval_ms / scrollback_lines / lan_password）
        key: String,
        /// 値（トグルは true・false、間隔は数値）
        value: String,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 設定をファイルへ持ち出せる形で出す（標準出力へ。`> 保存先` で受ける）
    Export,
    /// 持ち出した設定を読み込む（全部通るか、1つも入れないか）
    Import {
        /// 読み込むファイル
        file: std::path::PathBuf,
        #[command(flatten)]
        out: OutputArgs,
    },
}

#[derive(Subcommand)]
enum VersionCmd {
    /// 手元に置いてある版と、いま動いている版を出す
    Ls {
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 版を予約する。**その瞬間には何も起きない**——効くのは次に起こしたとき
    Select {
        /// 予約する版（例：0.1.10）
        version: String,
        /// 「確かめられない」と断られた版を、承知のうえで予約する
        #[arg(long)]
        confirm_unverified: bool,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 予約を取り消す（次に起こすと、入れる側が置いた版で立ち上がる）
    Unselect {
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 新しい版を取ってくる（背景で走る。進みは `version ls` で見る）
    Install {
        /// 取ってくる版
        version: String,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 手元に置いてある版を消す（走っている版は消せない）
    Rm {
        /// 消す版
        version: String,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// いま入れ替える＝**プロセスを落とす**。ローカルモードでは走っている claude が
    /// 道連れになるので、生きたカードが1枚でもあれば数を言って止まる
    Restart {
        /// 生きたカードがあっても落とす
        #[arg(long)]
        force: bool,
        #[command(flatten)]
        out: OutputArgs,
    },
}

impl Command {
    /// ダッシュボードへ話しかける群か（CLI設計§1）。
    ///
    /// この群は設定の読み込みより前に分岐する——`--server` があるときは設定を
    /// **読まない**のが仕様（CLI設計§4-1）で、壊れた設定に巻き込まれてはいけない。
    fn is_client(&self) -> bool {
        matches!(
            self,
            Self::Session(_)
                | Self::Project(_)
                | Self::Host(_)
                | Self::Settings(_)
                | Self::Version(_)
        )
    }
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
        // **`--host` のときだけ設定を読む。** 待ち受けポートを知る手段が他に無い
        // （ログ設計§25-5）。読めなければ既定へ黙って落ちない——`--host` は設定が要る、
        // と `--help` にも書いてある
        if args.host.is_some() {
            let config = Config::load(cli.config.as_deref())?;
            return session_host_core::logs::run_remote(args, config.port);
        }
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
    // ダッシュボードへ話しかける群も設定より前（CLI設計§4-1）。`--server` があるときは
    // 設定を読まないので、`Config::load` の失敗に巻き込まれてはいけない。
    // 失敗の終了コードに意味を持たせる（CLI設計§10-3）ため、出口もここで分ける
    if cli.command.as_ref().is_some_and(Command::is_client) {
        return run_client(cli);
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
        | Some(Command::Logs(_))
        | Some(Command::Session(_))
        | Some(Command::Project(_))
        | Some(Command::Host(_))
        | Some(Command::Settings(_))
        | Some(Command::Version(_)) => unreachable!(),
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

/// ダッシュボードへ話しかける群の入口（CLI設計§1-2）。
///
/// `run_async` と分けてあるのは、こちらは `Config` を**持たないまま**入るため——
/// `--server` があるときは設定を読まないのが仕様（CLI設計§4-1）。
#[tokio::main]
async fn run_client(cli: Cli) -> anyhow::Result<()> {
    let env_server = std::env::var(client::SERVER_ENV).ok();
    let config_path = cli.config.clone();
    let target = client::Target::resolve(cli.server.as_deref(), env_server.as_deref(), || {
        Config::load(config_path.as_deref())
            .map(|config| config.port)
            .map_err(|err| format!("設定を読めません（{err}）。外のサーバなら --server で指せます"))
    })
    .unwrap_or_else(|err| fail(err));
    let command = cli.command.expect("is_client で絞ってから来る");
    let outcome = match command {
        Command::Session(cmd) => client_session(cmd, &target).await,
        Command::Project(cmd) => client_project(cmd, &target).await,
        Command::Host(cmd) => client_host(cmd, &target).await,
        Command::Settings(cmd) => client_settings(cmd, &target).await,
        Command::Version(cmd) => client_version(cmd, &target).await,
        _ => unreachable!("is_client で絞ってから来る"),
    };
    if let Err(err) = outcome {
        fail(err);
    }
    Ok(())
}

/// 言葉を標準エラーへ出して、意味のある終了コードで終わる（CLI設計§10-3・§10-4）。
/// 標準出力は**結果だけ**の約束なので、失敗はこちらへ出す。
fn fail(err: client::ClientError) -> ! {
    eprintln!("{err}");
    std::process::exit(err.exit_code());
}

/// いまの epoch ミリ秒（「12秒前」の基準）。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn home() -> Option<String> {
    std::env::var("HOME").ok()
}

async fn client_session(
    cmd: SessionCmd,
    target: &client::Target,
) -> Result<(), client::ClientError> {
    match cmd {
        SessionCmd::Ls { out } => {
            let (sessions, raw) = client::sessions(target).await?;
            let human = output::render_sessions(&sessions, now_ms(), home().as_deref());
            println!("{}", output::pick(out.json, &raw, &human));
        }
        SessionCmd::Show { id, out } => {
            let (meta, raw_element) = client::session_show(target, &id).await?;
            let human = output::render_session_detail(&meta, now_ms(), home().as_deref());
            println!("{}", output::pick(out.json, &raw_element, &human));
        }
        SessionCmd::Transcript {
            id,
            before,
            limit,
            out,
        } => {
            let (page, raw) = client::transcript(target, &id, before.as_deref(), limit).await?;
            let human = output::render_transcript(&page.nodes, page.has_more);
            println!("{}", output::pick(out.json, &raw, &human));
        }
        SessionCmd::Spawn {
            cwd,
            mode,
            host,
            out,
        } => {
            let outcome = client::spawn(target, &cwd, mode.as_deref(), host.as_deref()).await?;
            println!("{}", output::pick(out.json, &outcome.raw, &outcome.human));
        }
        SessionCmd::Send {
            id,
            text,
            wait,
            timeout,
            out,
        } => {
            let outcome = client::send_input(target, &id, &text, wait, timeout).await?;
            println!("{}", output::pick(out.json, &outcome.raw, &outcome.human));
        }
        SessionCmd::Kill { id, out } => {
            let outcome = client::kill(target, &id).await?;
            println!("{}", output::pick(out.json, &outcome.raw, &outcome.human));
        }
        SessionCmd::Rm { id, out } => {
            let outcome = client::archive(target, &id).await?;
            println!("{}", output::pick(out.json, &outcome.raw, &outcome.human));
        }
        SessionCmd::Model { id, model, out } => {
            let outcome = client::set_model(target, &id, &model).await?;
            println!("{}", output::pick(out.json, &outcome.raw, &outcome.human));
        }
        SessionCmd::Mode { id, mode, out } => {
            let outcome = client::set_mode(target, &id, &mode).await?;
            println!("{}", output::pick(out.json, &outcome.raw, &outcome.human));
        }
        SessionCmd::Resize {
            id,
            cols,
            rows,
            out,
        } => {
            let outcome = client::resize(target, &id, cols, rows).await?;
            println!("{}", output::pick(out.json, &outcome.raw, &outcome.human));
        }
    }
    Ok(())
}

async fn client_project(
    cmd: ProjectCmd,
    target: &client::Target,
) -> Result<(), client::ClientError> {
    match cmd {
        ProjectCmd::Ls { out } => {
            let (projects, raw) = client::projects(target).await?;
            let human = output::render_projects(&projects, home().as_deref());
            println!("{}", output::pick(out.json, &raw, &human));
        }
        ProjectCmd::Add { host, path, out } => {
            let (response, raw) = client::project_add(target, &host, &path).await?;
            let mut human = format!(
                "PJT 枠を足しました：{}（{}）",
                output::fold_home(&response.project.path, home().as_deref()),
                output::short_id(&response.project.id.to_string())
            );
            if response.spawned {
                human.push_str("。セッションも1本起こしました");
            }
            if let Some(reason) = &response.spawn_error {
                // 枠は足せたがセッションは起きなかった。混ぜると結果が読めなくなるので
                // 理由は標準エラーへ（CLI設計§10-4）
                eprintln!("セッションは起きませんでした：{reason}");
            }
            println!("{}", output::pick(out.json, &raw, &human));
        }
        ProjectCmd::Rm { id, out } => {
            let removed = client::project_remove(target, &id).await?;
            // DELETE の応答は本文なし（204）なので、`--json` には消したIDの受け取り証を出す
            let raw = serde_json::json!({ "removed": removed }).to_string();
            let human = format!("PJT 枠を外しました：{}", output::short_id(&removed));
            println!("{}", output::pick(out.json, &raw, &human));
        }
    }
    Ok(())
}

async fn client_host(cmd: HostCmd, target: &client::Target) -> Result<(), client::ClientError> {
    match cmd {
        HostCmd::Dir { host, path, out } => {
            let (listing, raw) = client::host_dir(target, &host, path.as_deref()).await?;
            let human = output::render_dir(&listing);
            println!("{}", output::pick(out.json, &raw, &human));
        }
        HostCmd::File { host, path, out } => {
            let (content, raw) = client::host_file(target, &host, &path).await?;
            if out.json {
                println!("{raw}");
            } else {
                // 中身をそのまま出す（`--json` でないときの結果はファイルの本文そのもの）。
                // 切り詰めの注記は本文と混ざらないよう標準エラーへ（CLI設計§10-4）
                print!("{}", content.text);
                if !content.text.ends_with('\n') {
                    println!();
                }
                if content.truncated {
                    eprintln!(
                        "（大きいので途中まで。全体は {} バイトあります）",
                        content.bytes
                    );
                }
            }
        }
    }
    Ok(())
}

async fn client_settings(
    cmd: SettingsCmd,
    target: &client::Target,
) -> Result<(), client::ClientError> {
    match cmd {
        SettingsCmd::Show { out } => {
            let raw = client::settings_raw(target).await?;
            // **中身は解釈しない**（CLI設計§12-1）。モードで顔ぶれが変わる応答なので、
            // human でも整形（改行と字下げ）だけをして値には触らない
            if out.json {
                println!("{raw}");
            } else {
                println!("{}", prettify(&raw));
            }
        }
        SettingsCmd::Set { key, value, out } => {
            // 知らないキー・読めない値は引数の誤り（exit 2）。BadUrl は「引数が読めない」
            // 全般の受け皿で、終了コードの写像（§10-3）がそのままここにも当てはまる
            let body =
                client::settings_update_body(&key, &value).map_err(client::ClientError::BadUrl)?;
            let raw = client::settings_set(target, body).await?;
            if out.json {
                println!("{raw}");
            } else {
                println!("{key} を変えました。いまの設定：");
                println!("{}", prettify(&raw));
            }
        }
        SettingsCmd::Export => {
            // 出力そのものが持ち出しファイルの中身。`> 保存先` で受ける前提なので
            // 案内は混ぜない（標準出力は結果だけ。CLI設計§10-4）
            let raw = client::settings_export(target).await?;
            println!("{raw}");
        }
        SettingsCmd::Import { file, out } => {
            let body = std::fs::read_to_string(&file).map_err(|err| {
                client::ClientError::BadUrl(format!("`{}` を読めません（{err}）", file.display()))
            })?;
            let raw = client::settings_import(target, body).await?;
            let human = render_import_outcome(&raw);
            println!("{}", output::pick(out.json, &raw, &human));
        }
    }
    Ok(())
}

/// JSON の応答を、値に触らず読みやすい形（改行と字下げ）にする。
fn prettify(raw: &str) -> String {
    serde_json::from_str::<serde_json::Value>(raw)
        .and_then(|value| serde_json::to_string_pretty(&value))
        .unwrap_or_else(|_| raw.to_string())
}

/// 読み込みの結果（applied / ignored）を人が読む形へ。
fn render_import_outcome(raw: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    let names = |key: &str| -> Vec<String> {
        value[key]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let applied = names("applied");
    let ignored = names("ignored");
    let mut lines = if applied.is_empty() {
        "入れた項目はありません".to_string()
    } else {
        format!("入れました：{}", applied.join("、"))
    };
    if !ignored.is_empty() {
        lines.push_str(&format!(
            "\n知らないキーは無視しました：{}",
            ignored.join("、")
        ));
    }
    lines
}

async fn client_version(
    cmd: VersionCmd,
    target: &client::Target,
) -> Result<(), client::ClientError> {
    match cmd {
        VersionCmd::Ls { out } => {
            let (view, raw) = client::versions(target).await?;
            let human = output::render_versions(&view);
            println!("{}", output::pick(out.json, &raw, &human));
        }
        VersionCmd::Select {
            version,
            confirm_unverified,
            out,
        } => {
            let raw = client::version_select(target, &version, confirm_unverified).await?;
            // 「選ぶ」と「効かせる」は別（CICD設計）。この意味論を出力にも書く
            let human = format!(
                "{version} を予約しました。次に起こしたときから効きます（この瞬間には何も起きません）。\nいま入れ替えるなら `agentdashboard version restart`"
            );
            println!("{}", output::pick(out.json, &raw, &human));
        }
        VersionCmd::Unselect { out } => {
            let raw = client::version_unselect(target).await?;
            let human = "予約を取り消しました。次に起こすと、入れる側が置いた版で立ち上がります";
            println!("{}", output::pick(out.json, &raw, human));
        }
        VersionCmd::Install { version, out } => {
            let raw = client::version_install(target, &version).await?;
            let human = format!(
                "{version} を取りに行っています（背景で走ります）。進みは `agentdashboard version ls`"
            );
            println!("{}", output::pick(out.json, &raw, &human));
        }
        VersionCmd::Rm { version, out } => {
            let raw = client::version_remove(target, &version).await?;
            let human = format!("{version} を消しました");
            println!("{}", output::pick(out.json, &raw, &human));
        }
        VersionCmd::Restart { force, out } => {
            // 生きたカードを数えて止まる門は client::version_restart の中（判定の実装を
            // 1箇所に集める。`積み残し_運用` 項目11）
            let raw = client::version_restart(target, force).await?;
            let human = "落とす指示を受け付けました。常駐（systemd 等）が無ければ、手で起こし直してください";
            println!("{}", output::pick(out.json, &raw, human));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ログを引く口はホスト群に作っていない() {
        // 別 PC のログは既存の `logs --host` の1本道（CLI設計§3-2）。同じ操作への口を
        // 2つ作ると片方だけが古くなるので、`host logs` は**存在しないこと**が仕様
        assert!(
            Cli::try_parse_from(["agentdashboard", "host", "logs"]).is_err(),
            "host logs は解釈されてはいけない"
        );
        // 群そのものは生きている（比較対象。これも落ちたら試験の作りが壊れている）
        assert!(Cli::try_parse_from(["agentdashboard", "host", "dir", "local"]).is_ok());
    }
}
