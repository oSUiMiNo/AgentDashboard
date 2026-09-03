//! セッションホストの中身（セルフホスト化設計§1-1）。
//!
//! 実行ファイル（`agentdashboard-agent`）そのものは**配布用のパッケージ**
//! （`crates/dist`）が持っている。3本の実行ファイルを1つのアーカイブへ入れるには
//! 同じパッケージに置くしかなく（§25 読み替え1）、あちらには呼び出しの1行しか置かない。
//! **禁じ手の検査はこの crate に掛かったまま**なので、境界そのものは動いていない。
//!
//! セルフホストモードでは、**PTY・フック受信・パース・自己修復はこのプロセスが持つ**。
//! ダッシュボードサーバへは A2S（WebSocket）で繋ぎ、状態と履歴を報告し、指示を受ける。
//! サーバがいくら再起動しても、ここが生きている限りセッションは無傷（§1-3）。
//!
//! ローカルモード（1台で完結する使い方）は `agentdashboard` の方を使う。こちらには
//! ブラウザ配信も DB も無い——`crates/core/tests/dependencies.rs` が、その荷物が
//! 紛れ込んでいないことを機械で見ている。
//!
//! # 起動の順序には理由がある
//!
//! 1. **フックの受信口を先に開く**。注入する settings に宛先の URL が焼き込まれるので、
//!    セッションを起こす前に番号が確定していないと届かない（§5-3）
//! 2. 報告の運び手（[`SessionHostLink`]）を作る。セッションの持ち主はこれを受け取ってから作る
//! 3. マネージャ → パーサ → 自己修復 → 接続開始

use clap::{Parser, Subcommand};
use session_host_core::{
    config::SessionHostConfig,
    hook_post, hooks,
    link::{LinkConfig, SessionHostLink},
    logging,
    model_catalog::ModelCatalog,
    model_post,
    offsets::OffsetStore,
    parser::ParserSupervisor,
    selfheal,
    session::{SessionManager, lifecycle, permission},
};
use std::{path::PathBuf, sync::Arc};

#[derive(Parser)]
#[command(
    name = "agentdashboard-agent",
    version,
    about = "AgentDashboard のセッションホスト"
)]
struct Cli {
    /// 設定ファイルのパス。省略時はカレントの agent.toml、それも無ければ既定値
    #[arg(long, value_name = "PATH")]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Command>,
}

/// フックと `statusLine` から呼ばれる転送の口。
///
/// # なぜセッションホストが持つのか
///
/// 注入する settings には**この実行ファイル自身**が書き込まれる（`current_exe()`）。
/// PC に置かれているのは配布されたセッションホストだけなので、転送の口をここに持たないと
/// 「注入したコマンドが存在しない」ことになり、フックが1つも届かない。
///
/// 中身はローカルモードの `agentdashboard` と同じもの（`session_host_core` の関数）。
#[derive(Subcommand)]
enum Command {
    /// フックから起動され、stdin の JSON をセッションホストへ転送する（設計§7）
    ///
    /// 標準出力には何も書かず、失敗しても終了コード 0 で終わる。
    HookPost {
        /// 転送先。`http://127.0.0.1:<port>/hook/<token>/<イベント名>`
        #[arg(long, value_name = "URL")]
        url: String,
    },
    /// 注入した statusLine から起動され、いまのモデルをセッションホストへ転送する（設計§4）
    ///
    /// `hook-post` と違い、**標準出力にモデルの表示名を書く**（statusLine の標準出力は
    /// 端末の表示になるため）。こちらも失敗しても終了コード 0 で終わる。
    ModelPost {
        /// 転送先。`http://127.0.0.1:<port>/model/<token>`
        #[arg(long, value_name = "URL")]
        url: String,
    },
    /// ログを読む（ログ設計§11）
    ///
    /// **読めるのは、この PC の `<state_dir>/logs/` にあるファイルだけ。** サーバ側の
    /// ログはサーバの上で `agentdashboard logs` を叩く。
    ///
    /// **設定ファイルは読まない。** 置き場所を移している場合は `--state-dir` で直接指す。
    /// 中身はローカルモードの `agentdashboard logs` と**同じもの**（`session_host_core`
    /// の関数）。
    Logs(session_host_core::logs::LogsArgs),
}

/// セッションホストの入口。
///
/// # なぜ同期と非同期に割ってあるのか
///
/// 早期に処理する口（転送とログ）は**同期の処理しか含まない**ので、非同期ランタイムを
/// 立てる理由が1つも無い。とくに転送はフックのイベントごとに起こされる熱い経路で、
/// 1回ごとにランタイムを立てて捨てるのは無駄でしかない。`agentdashboard` 側（`cli.rs`）が
/// 同じ形になっているので、両方の CLI の骨格も揃う。
///
/// `#[tokio::main]` は展開後に同期の `fn` になるので、`crates/dist` の入口（1行）から
/// 見た形は変わらない。
pub fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // 転送は設定より先に処理する。フックは**利用者のプロジェクトを作業ディレクトリとして**
    // 起動されるので、そこに無関係な agent.toml があると設定の読み込みで失敗し、
    // フックが非ゼロ終了してしまう（ローカルモードと同じ理由）
    match &cli.command {
        Some(Command::HookPost { url }) => {
            hook_post::run(url);
            return Ok(());
        }
        Some(Command::ModelPost { url }) => {
            model_post::run(url);
            return Ok(());
        }
        // ログを読む口も設定より前（ログ設計§11-2）。**設定が壊れているときこそ読みたい**。
        // **`logging::install` は呼ばない**——呼ぶと起動時の掃除が走り、これから読む
        // ファイルを自分で掃くことになる
        Some(Command::Logs(args)) => return session_host_core::logs::run(args),
        None => {}
    }

    run_async(cli)
}

/// ここから先は今までどおり。
#[tokio::main]
async fn run_async(cli: Cli) -> anyhow::Result<()> {
    // **設定の読み込みをログ層より前に置く。** ログの置き場所とレベルが設定で決まる
    // ため。読めなかった場合は `?` で抜け、`main` の Termination が理由を stderr へ
    // 書く——ここでログ層が組めている必要はない（入れ替える前も、この2つの間に
    // ログを出す処理は1行も無かった）
    let config = SessionHostConfig::load(cli.config.as_deref())?;

    // **返り値を捨ててはいけない。** 落とすと書き終わる前に消える（実測：200行のうち0行）
    let _log = logging::install(logging::Proc::SessionHost, &config);
    // **添付の掃除も、ここで1回**（ダッシュボード側と同じ理由・同じ位置）
    {
        let config = config.clone();
        tokio::task::spawn_blocking(move || {
            session_host_core::attachments::sweep_on_start(&config);
        });
    }
    let Some(link_config) = link_config(&config) else {
        // **繋ぎ先が無ければ起動しない。** 繋がらないまま黙って動くと、PTY だけが
        // 増えていって誰も見ていない状態になる
        anyhow::bail!(
            "server_url と pairing_token が要ります（agent.toml か AGENTDASHBOARD_SERVER_URL / \
             AGENTDASHBOARD_PAIRING_TOKEN で指定してください）"
        );
    };

    // 1. フックの受信口を先に開いて、番号を確定させる（§5-3）
    let (hook_listener, hook_port) = hooks::bind(config.hook_port).await?;
    let config = Arc::new(SessionHostConfig {
        hook_port,
        ..config
    });
    tracing::info!("フックの受信口: http://127.0.0.1:{hook_port}");

    // 2. 起動している CLI へ問い合わせる2つ。子プロセスの起動と大きなファイル読みなので、
    // まとめてブロッキング用のスレッドへ逃がす（ローカルモードと同じ理由）。
    //
    // **名乗りより先に要る。** 受け付ける権限モードは Hello でサーバへ渡すので
    // （§21 読み替え1）、繋ぐ前に分かっていなければならない
    let (available_modes, catalog) = {
        let program = lifecycle::claude_program();
        let state_dir = config.resolved_state_dir();
        tokio::task::spawn_blocking(move || {
            let modes = permission::supported_modes(&program);
            let catalog = ModelCatalog::resolve(&program, Some(state_dir));
            (modes, catalog)
        })
        .await?
    };
    tracing::info!(
        "権限モード: {}",
        available_modes
            .iter()
            .map(protocol::PermissionMode::as_str)
            .collect::<Vec<_>>()
            .join(", ")
    );

    // 3. 報告の運び手。**繋ぎ始めるのはマネージャを作ってから**
    let offsets = OffsetStore::open(config.resolved_state_dir());
    let link = SessionHostLink::new(
        link_config.with_capabilities(available_modes, config.always_bypass_permissions),
    );

    // 4. セッションの持ち主
    let manager = SessionManager::with_sink(Arc::clone(&config), Arc::clone(&link) as _);
    tracing::info!("起動する CLI: {}", manager.program());
    hooks::serve(hook_listener, Arc::clone(&manager));

    // 「作業中」の表示のまま実はハングしている、という見落としを防ぐ見張り（設計§5）。
    // **判定はこちら側のクロックで回す**（§5-4）——サーバとの時計ずれで Stalled を
    // 誤判定しないため
    manager.start_sweeper();

    let parser = ParserSupervisor::start(
        Arc::clone(&manager),
        Arc::clone(&config),
        Arc::clone(&offsets),
    );
    manager.attach_parser(parser.handle());

    // 自己修復も PC の中で完結する（§10-1）。修復には Docker とダッシュボード自身の
    // ソースが要る。無い環境では検知の通知だけ行う
    let ops = match config.resolved_repo_dir() {
        Some(repo) => Some(Arc::new(selfheal::ops::HostOps::new(
            repo,
            manager.program().to_string(),
        )) as Arc<dyn selfheal::ops::SelfhealOps>),
        None => {
            // 配って入れた PC はたいていこちら（設計§10-2）。**ここでは画面へ出さない**
            // （§25 読み替え3）——パースは正常なのに、起動しただけで縮退バナーが
            // 出っぱなしになる。伝えるのは実際に検知が発火したとき
            tracing::warn!(
                "ダッシュボード自身のソースが見つかりません。自己修復は検知の通知だけになります\
                 （パーサの更新が要るときは画面に出ます）"
            );
            None
        }
    };
    selfheal::Selfheal::start(
        Arc::clone(&manager),
        Arc::clone(&parser),
        Arc::clone(&config),
        ops,
        catalog.cli_version().to_string(),
    );

    // モデルの表は接続直後に送る（§13-4）。**サーバは中身を解釈しない**ので、
    // 形をこちらで決めて丸ごと渡す
    link.set_model_table(
        catalog.cli_version().to_string(),
        serde_json::to_value(catalog.models())?,
        serde_json::to_value(manager.aliases().all())?,
    );

    // 5. 繋ぎ始める。ここから先は切れても繋ぎ直し続ける（§6-3）
    link.attach(Arc::clone(&manager), offsets);
    tracing::info!("セッションホストを起動しました");

    // 常駐する。畳むのは Ctrl+C か、外からの停止
    tokio::signal::ctrl_c().await?;
    tracing::info!("セッションホストを終了します");
    Ok(())
}

/// 接続の設定を組み立てる。繋ぎ先か身分証が無ければ `None`。
///
/// PC の能力（受け付ける権限モード）は、CLI へ問い合わせてから
/// [`LinkConfig::with_capabilities`] で添える。
fn link_config(config: &SessionHostConfig) -> Option<LinkConfig> {
    Some(LinkConfig {
        server_url: config.server_url.clone()?,
        pairing_token: config.pairing_token.clone()?,
        agent_name: config.resolved_agent_name(),
        available_modes: Vec::new(),
        always_bypass_permissions: config.always_bypass_permissions,
    })
}
