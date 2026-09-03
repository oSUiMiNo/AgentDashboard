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

    /// 札（ペアリングトークン。CLI設計§5-4）。サーバモードのダッシュボードを叩くときに要る。
    /// 環境変数 ADASH_TOKEN でも渡せ、両方あれば引数が勝つ。ファイルには保存しない
    #[arg(long, global = true, value_name = "TOKEN")]
    token: Option<String>,

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
        /// 札の用途（CLI設計§5-5）。`agent`＝PC を繋ぐ・`cli`＝CLI で叩く。
        /// 既定は `agent`——既存の手順（PC のペアリング）を変えない
        #[arg(long, value_name = "KIND", default_value = "agent")]
        kind: String,
    },
    /// ログを読む（ログ設計§11）
    ///
    /// **既定で読めるのは、この機械の `<state_dir>/logs/` にあるファイルだけ。**
    ///
    /// `--host <ID>` は、**同じ機械で動いているダッシュボード**（127.0.0.1）を通して
    /// 繋がっている PC のログを引く。外のサーバは見えない——外を見たいなら、
    /// そのサーバの上でこれを叩く。
    ///
    /// **ローカルモードは PC の受け口を持たない**ので、この道が通るのは同じ機械に
    /// アカウント方式のサーバモードが居るとき。その場合は札が要る（`--token` か
    /// 環境変数 ADASH_TOKEN。発行は `agentdashboard pair-token --kind cli`）。
    /// ほかの道としては、ブラウザから `GET /api/hosts/<ID>/logs` を叩くか、
    /// その PC の上で `agentdashboard-agent logs` を叩く。
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
    /// アカウントの札（ペアリングトークン）と登録済みの PC を見る・操作する
    ///
    /// **サーバモードにしか無い**（CLI設計§3-4）。ローカルモードのダッシュボードへ
    /// 叩くと「この構成にアカウントはありません」で断られる
    #[command(subcommand)]
    Account(AccountCmd),
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
        /// 届く追記をそのまま流し続ける（止めるのは Ctrl+C）。--before / --limit とは併用できない
        #[arg(long, conflicts_with_all = ["before", "limit"])]
        follow: bool,
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
    /// 画像を添付として置く（送信はしない。置いた場所を標準出力へ返す）。
    ///
    /// 画面の「＋」と同じ口を叩く。**送るのは `session send` の役目**で、
    /// 返ってきたパスを本文の末尾へ1行で足す
    Attach {
        /// カードID。先頭の数文字で足りる
        id: String,
        /// 送る画像（png / jpg / jpeg / gif / webp）
        file: String,
        /// どの PC のカードか（繋がっている PC が2台以上のときは必須）
        #[arg(long, value_name = "AGENT_ID", default_value = "local")]
        host: String,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// **過去のセッションを並べる**。名前を付けたものは全部、付けていないものは最近のぶんだけ。
    /// PC が繋がっていないものは「確かめていない」と出ます（勝手に消しません）
    Past {
        /// どの PC のぶんか。`--project` と**組で**指定します
        #[arg(long, value_name = "AGENT_ID", requires = "project")]
        host: Option<String>,
        /// どの枠（作業ディレクトリ）のぶんか。`--host` と**組で**指定します。
        /// 片方だけでは枠が定まりません——同じパスの PJT が別の PC にもありうるためです
        #[arg(long, value_name = "PATH", requires = "host")]
        project: Option<String>,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// **過去のセッションを呼び戻す**（新しいカードで起こし、起動まで待つ）。
    /// 名前を付けてあれば、起こしたカードにもその名前が付きます
    Recall {
        /// CLI のセッションID（`session past` に出るもの）
        id: String,
        /// 権限モード。省略すると記録に残っているモードで起こします
        #[arg(long, value_name = "MODE")]
        mode: Option<String>,
        /// どの PC で起こすか。**記録が PC を知っていればそちらが勝ちます**
        #[arg(long, value_name = "AGENT_ID")]
        host: Option<String>,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// カードに**自分で名前を付ける**（反映まで待つ）。
    /// 名前は CLI セッションに付くので、`--resume` で乗り換えても付いてきます
    Nickname {
        /// カードID。先頭の数文字で足りる
        id: String,
        /// 付ける名前。改行は使えません（200文字まで）
        #[arg(required_unless_present = "clear")]
        name: Option<String>,
        /// 名前を消す
        #[arg(long, conflicts_with = "name")]
        clear: bool,
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
    /// 抜け殻のカード（接続断・終了）を、元の CLI セッションで起こし直す（起動まで待つ）。
    /// **動いているカードは断られます**（走っている作業を巻き添えにしないため）
    Revive {
        /// カードID。先頭の数文字で足りる
        #[arg(required_unless_present = "all")]
        id: Option<String>,
        /// 起こし直せるカードを全部（順に1枚ずつ。戻せないものは理由を出して飛ばす）
        #[arg(long, conflicts_with = "id")]
        all: bool,
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
    /// 1つの PJT 枠の中で、カードを並べ替える（画面のドラッグと同じ口）
    ///
    /// **枠をまたいだ移動はできない。** カードの作業ディレクトリは起動時に決まる。
    /// 並びは丸ごと渡し、渡さなかったカードは今の順のまま後ろへ続く。
    Reorder {
        /// どの PC か。この機械なら `local`、繋いだ PC はその ID
        host: String,
        /// どの枠か。作業ディレクトリのパス
        path: String,
        /// 並べたい順のカードID。先頭の数文字で足りる
        ids: Vec<String>,
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
    /// いまの画面を1枚だけ受け取る（権限確認やメニューを読むためのもの）。
    /// **--cols / --rows の指定は、同じセッションをブラウザで開いている人の表示にも効きます**
    /// （購読がそのまま端末のリサイズになるため）
    Screen {
        /// カードID。先頭の数文字で足りる
        id: String,
        /// 画面の桁数。既定はブラウザの録画と同じ 120
        #[arg(long, value_name = "N", default_value_t = 120)]
        cols: u16,
        /// 画面の行数。既定は 40
        #[arg(long, value_name = "N", default_value_t = 40)]
        rows: u16,
        /// エスケープ列のまま出す（別の端末エミュレータへ流したいとき用）
        #[arg(long)]
        raw: bool,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// キーを送る（矢印・確定・取り消しなど。名前を並べた順に送る）。
    /// 確定は enter（改行を入れたいときは newline）。届いたかは確かめないので、
    /// 効いたかは `session screen` で見る
    Key {
        /// カードID。先頭の数文字で足りる
        id: String,
        /// 送るキーの名前。例：down down enter
        #[arg(required = true, value_name = "KEY")]
        keys: Vec<String>,
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
    /// PJT 枠を並べ替える（画面のドラッグと同じ口）
    ///
    /// **並びを丸ごと渡す。** 渡さなかった枠は今の順のまま後ろへ続く。
    Reorder {
        /// 並べたい順の枠ID。先頭の数文字で足りる（一覧は `project ls --json`）
        ids: Vec<String>,
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
        /// 画像や HTML を**生のバイト列で**取る（`--out` が要る）
        #[arg(long)]
        raw: bool,
        /// `--raw` の書き出し先。**標準出力へバイト列は流さない**
        #[arg(long)]
        out_file: Option<std::path::PathBuf>,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// PC の空きメモリと、**いま何枚起こし直せるか**（`session revive` の歯止めと同じ数）
    Resources {
        /// どの PC か。この機械なら `local`
        host: String,
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
        /// sync_interval_secs / screen_interval_ms / scrollback_lines /
        /// motion_quiet / lan_password）
        key: String,
        /// 値（トグルは true・false、間隔は数値、静けさは lively・calm・still）
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
enum AccountCmd {
    /// 発行済みの札の一覧（平文は出ない——もう一度見る口はそもそも無い）
    Tokens {
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 札を発行する。**平文はこの1回しか出ない**（標準出力へ。パイプでそのまま渡せる）
    Issue {
        /// 何用かを後から見分けるための名前
        #[arg(long, value_name = "LABEL", default_value = "")]
        label: String,
        /// 札の用途（CLI設計§5-5）。`agent`＝PC を繋ぐ・`cli`＝CLI で叩く。
        /// 既定は `agent`——画面の発行ボタンと同じ意味を保つ
        #[arg(long, value_name = "KIND", default_value = "agent")]
        kind: String,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 札を失効させる（その札で繋がっている接続はその場で切れる）
    Revoke {
        /// 札のID。先頭の数文字で足りる（一覧は `account tokens`）
        id: String,
        #[command(flatten)]
        out: OutputArgs,
    },
    /// 登録済みの PC の一覧
    Hosts {
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
                | Self::Account(_)
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

    // **走っている実行ファイルの素性も、ここで確定する。**
    //
    // `make build` は走っているプロセスの実体を消すので、あとから聞くと `(deleted)` 付きの
    // 存在しないパスが返る——**実パスもビルド時刻も失われる**。起動した瞬間はまだ
    // 差し替えられていないので、ここで一度だけ聞けば正しい答えが手に入る。
    //
    // **触らないと、画面から初めて呼ばれた時刻に聞くことになる**。それが差し替えの後だと
    // 「中身が入れ替わったか」を判定する材料が消え、**新しい版があっても気づけない**
    // （実測でそうなった）
    let _ = session_host_core::version::running_binary();

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
            // 札は **`logs` の引数 > 全体の `--token` > 環境変数**（CLI設計§5-4）。
            // 全体の `--token` を見るのは、それが他の全コマンドで効く位置だから
            // ——ここだけ黙って無視すると「渡したのに断られた」になる
            let mut args = args.clone();
            args.token = 札を合流(
                args.token.clone(),
                cli.token.clone(),
                std::env::var(client::TOKEN_ENV).ok(),
            );
            return session_host_core::logs::run_remote(&args, config.port);
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

/// 起動した時点で、自分の子にゾンビが何体ぶら下がっているかを1行残す（ゾンビ設計§5-2）。
///
/// # なぜ起動のときに数えるのか
///
/// 版の入れ替えは `exec` で自分を置き換えるので、**プロセスの中で数え上げた値は入れ替えの
/// たびに消える**。一方 OS の親子関係は PID が同じまま残るので、**入れ替えを跨いで効く
/// 数え方はこれ1つだけ**である。入れ替えは起動をまるごとやり直すため、この行は入れ替えの
/// たびに自動で出る——周期の見張りを足す必要が無い。
///
/// # 0体でも出す
///
/// この検査そのものが動いたことを、後から確かめられるようにするため。ただし `DEBUG` なので
/// 端末には出ず、ファイルにだけ残る。
fn report_zombie_children() {
    match crate::children::zombie_count() {
        Some(0) => tracing::debug!(zombie_children = 0, "起動時点でゾンビはありません"),
        Some(zombie_children) => tracing::warn!(
            zombie_children,
            "起動時点で、自分の子にゾンビが残っています\
             （前の版入れ替えの置き土産。実害はありません）"
        ),
        // 読めない機械（Linux 以外）。**0体と書かない**
        None => {}
    }
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
        Some(Command::PairToken {
            account,
            label,
            kind,
        }) => {
            let Some(kind) = server_core::db::pairing::TokenKind::parse(&kind) else {
                anyhow::bail!("--kind は agent か cli です（実際: {kind}）");
            };
            let db = server_core::db::connect(&config.resolved_database_url()).await?;
            let account_id = server_core::db::pairing::ensure_account(&db, &account).await?;
            let token =
                server_core::db::pairing::issue_token(&db, account_id, &label, kind).await?;
            // **1回だけ表示する。** 控えを取り損ねたら、作り直してもらうほうが安全
            println!("{token}");
            match kind {
                server_core::db::pairing::TokenKind::Agent => eprintln!(
                    "アカウント「{account}」のトークンを発行しました。\n\
                     PC 側の agent.toml へ pairing_token として貼ってください（この表示は一度きりです）。"
                ),
                server_core::db::pairing::TokenKind::Cli => eprintln!(
                    "アカウント「{account}」の CLI 用トークンを発行しました。\n\
                     `--token` か環境変数 ADASH_TOKEN で渡してください（この表示は一度きりです）。"
                ),
            }
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
        | Some(Command::Version(_))
        | Some(Command::Account(_)) => unreachable!(),
        None => {
            // **返り値を捨ててはいけない。** 非ブロッキング書き込みの見張り役なので、
            // 落とすと書き終わる前にプロセスが終わりうる（実測：200行のうち0行）。
            // `serve` の間ずっと持つ形になっている
            let _log = logging::install(logging::Proc::Dashboard, &config.agent());
            // **添付の掃除も、ここで1回。** 置くたびの掃除だけだと、付けたきり送らなかった
            // ぶんが「次に誰かが添付を置くまで」残る。ログの掃除と同じ位置に並べる
            {
                let agent = config.agent();
                tokio::task::spawn_blocking(move || {
                    session_host_core::attachments::sweep_on_start(&agent);
                });
            }
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
            report_zombie_children();
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
    .unwrap_or_else(|err| fail(err))
    // 札は接続先と独立に決まる（引数 > 環境変数。CLI設計§5-4）
    .with_token(
        cli.token
            .clone()
            .or_else(|| std::env::var(client::TOKEN_ENV).ok()),
    );
    let command = cli.command.expect("is_client で絞ってから来る");
    let outcome = match command {
        Command::Session(cmd) => client_session(cmd, &target).await,
        Command::Project(cmd) => client_project(cmd, &target).await,
        Command::Host(cmd) => client_host(cmd, &target).await,
        Command::Settings(cmd) => client_settings(cmd, &target).await,
        Command::Version(cmd) => client_version(cmd, &target).await,
        Command::Account(cmd) => client_account(cmd, &target).await,
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
/// 受け取ったバイト列を1バイトも足さずに書く。
///
/// `screen --raw` と `host file` の約束（CLI設計§10-2「そのまま出す」）はここに集める。
/// **末尾の改行を補わない**——`--raw` は端末へ流し直すためのバイト列で1行ぶんずれ、
/// `host file` は `> copy` で写したファイルが元より1バイト長くなる
/// （どちらも照合が必ず食い違う。コードレビュー対応11）。
fn 生のまま書く(out: &mut impl std::io::Write, bytes: &[u8]) -> std::io::Result<()> {
    out.write_all(bytes)?;
    out.flush()
}

/// `logs --host` が使う札を決める（CLI設計§5-4）。
///
/// 優先は **`logs` の `--token` > 全体の `--token` > 環境変数**。全体の `--token` を
/// 混ぜるのは、それが**他の全コマンドで効く位置**だから——ここだけ黙って無視すると
/// 「渡したのに断られた」になり、失効を疑って総当たりする経路ができる。
fn 札を合流(
    logs: Option<String>,
    global: Option<String>,
    env: Option<String>,
) -> Option<String> {
    logs.or(global).or(env)
}

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
            follow,
            out,
        } => {
            if follow {
                follow_transcript(target, &id, out.json).await?;
            } else {
                let (page, raw) = client::transcript(target, &id, before.as_deref(), limit).await?;
                let human = output::render_transcript(&page.nodes, page.has_more);
                println!("{}", output::pick(out.json, &raw, &human));
            }
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
        SessionCmd::Attach {
            id,
            file,
            host,
            out,
        } => {
            let outcome = client::attach(target, &host, &id, std::path::Path::new(&file)).await?;
            println!("{}", output::pick(out.json, &outcome.raw, &outcome.human));
        }
        SessionCmd::Reorder {
            host,
            path,
            ids,
            out,
        } => {
            let ordered = client::session_reorder(target, &host, &path, &ids).await?;
            let raw = serde_json::json!({ "card_ids": ordered }).to_string();
            let human = format!("カードを並べ替えました：{} 枚", ordered.len());
            println!("{}", output::pick(out.json, &raw, &human));
        }
        SessionCmd::Past {
            host,
            project,
            out,
        } => {
            let frame = host.as_deref().zip(project.as_deref());
            let (past, raw) = client::past_sessions(target, frame).await?;
            let human = output::render_past_sessions(&past, now_ms(), home().as_deref());
            println!("{}", output::pick(out.json, &raw, &human));
        }
        SessionCmd::Recall {
            id,
            mode,
            host,
            out,
        } => {
            // **IDは丸ごと要る**（カードIDのような前方一致にしない）。過去のセッションは
            // 一覧に出ていないものも指せるので、前方一致で解決する相手が居ない
            let session = protocol::ClaudeSessionId(id.parse().map_err(|_| {
                client::ClientError::Refused {
                    status: 400,
                    message: "セッションIDの形が違います".to_string(),
                }
            })?);
            let agent = match host.as_deref() {
                None | Some("local") => None,
                Some(raw) => Some(protocol::AgentId(raw.parse().map_err(|_| {
                    client::ClientError::Refused {
                        status: 400,
                        message: "PC の ID の形が違います".to_string(),
                    }
                })?)),
            };
            let outcome = client::recall(
                target,
                session,
                mode.map(protocol::PermissionMode::new),
                agent,
            )
            .await?;
            println!("{}", output::pick(out.json, &outcome.raw, &outcome.human));
        }
        // `clear` は読まない。**clap が「name か --clear のどちらか片方」を強制している**
        // （`required_unless_present` と `conflicts_with`）ので、name が無いことが
        // そのまま `--clear` を意味する。ここで両方を見ると、同じ約束を2箇所で持つことになる
        SessionCmd::Nickname { id, name, out, .. } => {
            let outcome = client::set_nickname(target, &id, name).await?;
            println!("{}", output::pick(out.json, &outcome.raw, &outcome.human));
        }
        SessionCmd::Kill { id, out } => {
            let outcome = client::kill(target, &id).await?;
            println!("{}", output::pick(out.json, &outcome.raw, &outcome.human));
        }
        // `all` は読まない。**clap が「id か --all のどちらか片方」を強制している**
        // （`required_unless_present` と `conflicts_with`）ので、id が無いことが
        // そのまま `--all` を意味する。ここで両方を見ると、同じ約束を2箇所で持つことになる
        SessionCmd::Revive { id, all: _, out } => {
            let outcome = match id {
                Some(id) => client::revive(target, &id).await?,
                None => client::revive_all(target).await?,
            };
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
        SessionCmd::Screen {
            id,
            cols,
            rows,
            raw,
            out,
        } => {
            let shot = client::screen(target, &id, cols, rows).await?;
            if raw {
                生のまま書く(&mut std::io::stdout(), &shot.payload)
                    .map_err(|err| client::ClientError::Config(format!("書き出せません: {err}")))?;
            } else {
                let text = client::render::render_screen(&shot.payload, shot.rows, shot.cols);
                if out.json {
                    // 画面のフレームはバイナリで、サーバに JSON の応答が無い唯一の口。
                    // ここだけ CLI が組む（「そのまま出す」約束の例外として設計§17 に記録）
                    let value = serde_json::json!({
                        "card_id": shot.card.to_string(),
                        "cols": shot.cols,
                        "rows": shot.rows,
                        "text": text,
                    });
                    println!("{value}");
                } else {
                    println!("{text}");
                }
            }
        }
        SessionCmd::Key { id, keys, out } => {
            let outcome = client::send_keys(target, &id, &keys).await?;
            println!("{}", output::pick(out.json, &outcome.raw, &outcome.human));
        }
    }
    Ok(())
}

/// `session transcript --follow`。届く追記を流し続け、Ctrl+C で閉じる（CLI設計§3-2）。
async fn follow_transcript(
    target: &client::Target,
    id: &str,
    json: bool,
) -> Result<(), client::ClientError> {
    let mut stream = client::follow(target, id).await?;
    loop {
        // select! の中で stream を動かせない（next の借用が生きている）ので、
        // どちらが来たかだけを持ち出して、閉じるのは外で行う
        let event = tokio::select! {
            event = stream.next() => Some(event),
            _ = tokio::signal::ctrl_c() => None,
        };
        match event {
            Some(event) => match event? {
                client::FollowEvent::Append { nodes, raw } => {
                    if json {
                        // 1追記＝1行の JSON（届いた知らせそのまま）。読む側が行単位で追える
                        println!("{raw}");
                    } else {
                        let human = output::render_transcript(&nodes, false);
                        println!("{human}");
                    }
                }
                client::FollowEvent::Reset => {
                    // 履歴が作り直された（購読開始時にも1回来る）。結果と混ぜない（§10-4）
                    eprintln!("（履歴が作り直されました。ここから先が新しい内容です）");
                }
            },
            None => break,
        }
    }
    stream.close().await;
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
        ProjectCmd::Reorder { ids, out } => {
            let ordered = client::project_reorder(target, &ids).await?;
            let raw = serde_json::json!({ "ids": ordered }).to_string();
            let human = format!("PJT 枠を並べ替えました：{} 枚", ordered.len());
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
        HostCmd::File {
            host,
            path,
            raw: true,
            out_file,
            out: _,
        } => {
            // **`--out-file` が無ければ断る。** 標準出力へバイト列を流すと、
            // 消す道が `state-dir` の出力をそのままパスとして使う約束と食い違う
            // （ログ設計「標準出力へ書いてよいのは、サーバを起こしたときだけ」）
            let Some(destination) = out_file else {
                return Err(client::ClientError::Config(
                    "`--raw` には `--out-file <パス>` が要ります（標準出力へバイト列は流しません）"
                        .to_string(),
                ));
            };
            let bytes = client::host_file_raw(target, &host, &path).await?;
            std::fs::write(&destination, &bytes)
                .map_err(|err| client::ClientError::Config(format!("書き出せません: {err}")))?;
            // **何が起きたかを人が確かめられる形で1行。** 中身は出さない
            println!(
                "{} へ {} バイト書き出しました",
                destination.display(),
                bytes.len()
            );
        }
        HostCmd::File {
            host,
            path,
            raw: false,
            out_file: _,
            out,
        } => {
            let (content, raw) = client::host_file(target, &host, &path).await?;
            if out.json {
                println!("{raw}");
            } else {
                // 中身をそのまま出す（`--json` でないときの結果はファイルの本文そのもの）。
                // 切り詰めの注記は本文と混ざらないよう標準エラーへ（CLI設計§10-4）
                生のまま書く(&mut std::io::stdout(), content.text.as_bytes())
                    .map_err(|err| client::ClientError::Config(format!("書き出せません: {err}")))?;
                if content.truncated {
                    eprintln!(
                        "（大きいので途中まで。全体は {} バイトあります）",
                        content.bytes
                    );
                }
            }
        }
        HostCmd::Resources { host, out } => {
            let (resources, raw) = client::host_resources(target, &host).await?;
            // 組み立ては `output` へ寄せる（テストから当てられる形にするため）
            let human = output::render_resources(&resources);
            println!("{}", output::pick(out.json, &raw, &human));
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

async fn client_account(
    cmd: AccountCmd,
    target: &client::Target,
) -> Result<(), client::ClientError> {
    match cmd {
        AccountCmd::Tokens { out } => {
            let (tokens, raw) = client::account_tokens(target).await?;
            let human = output::render_tokens(&tokens, now_ms());
            println!("{}", output::pick(out.json, &raw, &human));
        }
        AccountCmd::Issue { label, kind, out } => {
            // 綴りは手元で先に確かめる（打ち間違いをサーバまで運ばない。exit 2）
            if server_core::db::pairing::TokenKind::parse(&kind).is_none() {
                return Err(client::ClientError::BadUrl(format!(
                    "--kind は agent か cli です（実際: {kind}）"
                )));
            }
            let (token, raw) = client::account_issue(target, &label, &kind).await?;
            if out.json {
                println!("{raw}");
            } else {
                // 平文は標準出力へ**1回だけ**。案内を混ぜないので、パイプでそのまま
                // 次へ渡せる（CLI設計§12-3。標準出力は結果だけの約束＝§10-4）
                println!("{token}");
                eprintln!("札を発行しました（この表示は一度きりです）。");
            }
        }
        AccountCmd::Revoke { id, out } => {
            let raw = client::account_revoke(target, &id).await?;
            // 204 は本文が空。`--json` でも空行を出さず、空の連想配列で「済んだ」を表す
            let human = "失効させました。この札で繋がっていた接続は切れます";
            if out.json {
                println!("{}", if raw.trim().is_empty() { "{}" } else { &raw });
            } else {
                println!("{human}");
            }
        }
        AccountCmd::Hosts { out } => {
            let (hosts, raw) = client::account_hosts(target).await?;
            let human = output::render_hosts(&hosts, now_ms());
            println!("{}", output::pick(out.json, &raw, &human));
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

    #[test]
    fn 検証を切る旗はどの群にも生えていない() {
        // TLS の証明書検証を切る指定（`--insecure` の類）は**作らない**（テスト計画F4。
        // PJTガイドライン「渡す環境と引数は純粋関数で組み立て、門を置く」）。一度でも
        // 生えると「とりあえず付ける」が習慣になり、検証が実質オフの運用に落ちる。
        // 旗の名前は将来も増えるので、引数の**全群を再帰で走査**して禁止語で見張る
        use clap::CommandFactory as _;
        fn walk(command: &clap::Command, hits: &mut Vec<String>) {
            for arg in command.get_arguments() {
                if let Some(long) = arg.get_long() {
                    let long = long.to_ascii_lowercase();
                    if ["insecure", "no-verify", "danger", "skip-tls", "no-check"]
                        .iter()
                        .any(|bad| long.contains(bad))
                    {
                        hits.push(format!("{} --{long}", command.get_name()));
                    }
                }
            }
            for sub in command.get_subcommands() {
                walk(sub, hits);
            }
        }
        let command = Cli::command();
        let mut hits = Vec::new();
        walk(&command, &mut hits);
        assert!(hits.is_empty(), "検証を切る旗が生えています: {hits:?}");
        // 解釈もされない（走査の対象漏れがあっても、こちらで捕まる）
        assert!(
            Cli::try_parse_from(["agentdashboard", "session", "ls", "--insecure"]).is_err(),
            "--insecure は解釈されてはいけない"
        );
    }

    #[test]
    fn そのまま出す口は末尾の改行を足さない() {
        // `--raw` は端末へ流し直すバイト列、`host file` はファイルの本文そのもの。
        // 1バイト足すと再生が1行ずれ、写したファイルは照合が食い違う（コードレビュー対応11）
        let payload = b"\x1b[2J\x1b[Hhello";
        let mut out = Vec::new();
        生のまま書く(&mut out, payload).expect("書けること");
        assert_eq!(out, payload, "エスケープ列に改行を足さないこと");

        // 末尾に改行の無い本文も、そのままの長さで出る
        let text = "ok";
        let mut out = Vec::new();
        生のまま書く(&mut out, text.as_bytes()).expect("書けること");
        assert_eq!(out, text.as_bytes(), "本文へ改行を補わないこと");
    }

    #[test]
    fn logsの札は引数から環境変数へ順に落ちる() {
        let 札 = |s: &str| Some(s.to_string());
        // logs 自身の --token が最優先
        assert_eq!(札を合流(札("logs"), 札("global"), 札("env")), 札("logs"));
        // 全体の --token は他の全コマンドで効く位置。ここでも効く（コードレビュー対応9）
        assert_eq!(札を合流(None, 札("global"), 札("env")), 札("global"));
        assert_eq!(札を合流(None, None, 札("env")), 札("env"));
        assert_eq!(札を合流(None, None, None), None);
    }

    #[test]
    fn セッション群の口は名指しの集合で固定する() {
        // **生バイトを直に送る口は作らない**（CLI設計§9-4）。任意のバイト列を許すと
        // 入力の作法（初期実装§18）を迂回できてしまう。指示文は send・キーは key の
        // 2つに絞ってあり、口を1つ足すときはこの集合を**意識して**更新することになる
        use clap::CommandFactory as _;
        let command = Cli::command();
        let session = command
            .get_subcommands()
            .find(|sub| sub.get_name() == "session")
            .expect("session 群があること");
        let mut names: Vec<&str> = session
            .get_subcommands()
            .map(clap::Command::get_name)
            .collect();
        names.sort_unstable();
        assert_eq!(
            names,
            vec![
                "attach",
                "key",
                "kill",
                "ls",
                "mode",
                "model",
                // カードに自分で名前を付ける（名前付け設計§11-1）。
                // **生バイトは1つも運ばない**——運ぶのはカードIDと文字列だけで、
                // 宛先の CLI セッションはサーバが記録から引く
                "nickname",
                // 過去のセッションを並べる（名前付け設計§11-1）。**読むだけ**
                "past",
                // 過去のセッションを呼び戻す（名前付け設計§11-1）。
                // **生バイトは1つも運ばない**——運ぶのはセッションIDと選択肢だけ
                "recall",
                // 1つの枠の中でカードを並べ替える（並べ替え設計§9-1）。
                // **運ぶのはカードIDの並びだけ**で、生バイトは1つも通らない
                "reorder",
                "resize",
                // 抜け殻のカードを起こし直す（接続断のカードを復旧ボタンで戻す 設計§10-1）。
                // **生バイトは1つも運ばない**——運ぶのはカードIDだけで、材料は
                // サーバ側の記録が持っている
                "revive",
                "rm",
                "screen",
                "send",
                "show",
                "spawn",
                "transcript",
            ],
            "session 群の口が増減している。生バイトの直送を作っていないか、台帳（フェーズ5）と照合すること"
        );
    }
}
