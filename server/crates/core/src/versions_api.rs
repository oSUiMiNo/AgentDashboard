//! ダッシュボード自身の版を見る口と、消す口（CICD設計§14）。
//!
//! # なぜ設定の口へ相乗りさせないのか
//!
//! 設定は**画面を開いた瞬間に必ず読む**もので、版の一覧は保管庫の走査と3本への
//! 問い合わせ（1版あたり十数ミリ秒）を伴う。性質の違うものを1本に混ぜると、
//! 片方の遅れがもう片方を引きずる——セルフホスト化で一度踏んでいる。
//!
//! # なぜ両モードで同じ口なのか
//!
//! [`crate::settings_api`] はローカルとサーバで材料の出どころが違う（片方は PC 側の
//! `config.toml`、片方は DB）ので口を2本に割っているが、**版はどちらも「自分が
//! 走っている機械の保管庫」**なので材料が同じ。違うのは押せる相手の決め方だけなので、
//! そこだけ [`may_operate`] で分ける。
//!
//! # 押せる相手を絞る
//!
//! 版の入れ替えは、突き詰めれば**外から実行ファイルを取ってきて走らせる**ことである。
//! ログインを通っただけの相手に開ける操作ではない（設計§13）。一方で**一覧を見るのは
//! 誰でもよい**——見えないと、押せないことすら分からない。

use crate::gate;
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post, put},
};
use protocol::{VersionEntry, VersionId};
use serde::{Deserialize, Serialize};
use server_core::auth::{AuthContext, AuthMode, Identity};
use server_core::registry::SessionRegistry;
use session_host_core::{version, version_ops::VersionOps};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// その DB に適用済みの記録の形を読む口（設計§9）。
///
/// **関数で受け取るのは、`crates/core` が記録の道具を通常の依存に持っていないため**
/// （設計§23-9。更新確認の設定と同じ理由）。型を書かずに呼べる形にしておく。
pub type AppliedSchemas = Arc<
    dyn Fn() -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Vec<String>, String>> + Send>,
        > + Send
        + Sync,
>;

/// 自分を終える口（設計§10・§24）。
///
/// **差し替えられる形にしてある。** 素直に `std::process::exit` を呼ぶと、統合テストは
/// サーバをプロセス内に立てているので**テストバイナリごと死ぬ**——押した結果を
/// 確かめる手段が無くなる。「新しく外の状態を持ったら、同時に差し替え口も作る」
/// （PJTガイドライン）に沿って口にした。
pub type Stopper = Arc<dyn Fn() + Send + Sync>;

/// 本番の終わり方。**後片付けは走らない。**
///
/// graceful shutdown を採らないのは、あれが**開いている接続の完了を待つ**ため。
/// ブラウザは `/ws` を開きっぱなしなので、押した本人の接続が閉じず待ちが終わらない。
/// 失うのは `Drop`（PTY の後始末）だが、**穏やかに終えても強引に殺しても claude は
/// 道連れで死ぬ**ことを実測済み（設計§20-1）なので、失うものが無い。
pub fn exit_process() -> Stopper {
    Arc::new(|| std::process::exit(0))
}

/// **落とすのではなく、次に起きる版へ入れ替える**（`手元の新しい版をGUIだけで効かせる`
/// 設計§7）。
///
/// # なぜ落とすだけでは足りなかったか
///
/// 起こし直しは常駐の設定（systemd の `Restart=always`）に任せる作りだったが、
/// **ソースビルドの機械は常駐に載っていない**ので誰も起こさない。押すと画面ごと消えて
/// 戻ってこないため、**押せるようにしても使えなかった。**
///
/// # 行き先が無ければ、今までどおり落ちる
///
/// 常駐に載っている構成（箱・systemd）では、落ちれば戻ってくる。**振る舞いを
/// 変えない**ほうが安全なので、行き先を決められないときは `exit(0)` へ落とす。
///
/// # 入れ替えられなかったときは、**落ちずに生き残る**
///
/// 素直に書くと、`exec` に失敗したあと今までどおり `exit(0)` する。**そうしてはいけない。**
///
/// この道を作った理由が「**落ちても誰も起こさない機械がある**」ことなので、失敗して
/// なお落ちると**最悪の結末**になる——版は変わらないまま、画面ごと消えて戻ってこない。
/// 押す前より悪い。
///
/// 生き残れば、利用者は**古い版のまま操作を続けられる**し、理由が画面に残る。
pub fn hand_over_process(state_dir: PathBuf) -> Stopper {
    Arc::new(move || {
        let Some(target) = version::next_binary(&state_dir) else {
            // 行き先が分からない。今までどおり落ちて、常駐に任せる
            std::process::exit(0)
        };

        // 成功すれば返らない（プロセスの中身が入れ替わる）
        crate::boot::hand_over_now(&state_dir, &target);

        // 返ってきた＝入れ替えられなかった。**落ちない。**
        let reason = format!("入れ替えられませんでした: {}", target.display());
        tracing::error!(target = %target.display(), "{reason}");
        version::write_outcome(
            &state_dir,
            &version::Outcome {
                attempted: None,
                attempted_path: target.display().to_string(),
                running: version::running_version(),
                failed_reason: Some(reason),
                at: session_host_core::session::now_ms(),
            },
        );
    })
}

/// 記録へ聞けない構成のときの答え（設計§9）。
///
/// **「聞けなかった」を「知らない形は無かった」に読み替えない。** 空の一覧を返すと
/// 門は必ず `Ready` を出すので、**記録が読めないという理由だけで切替が通る**ことになる。
pub fn no_schemas() -> AppliedSchemas {
    Arc::new(|| {
        Box::pin(async {
            Err("この構成では記録の形を確かめられません".to_string()) as Result<Vec<String>, String>
        })
    })
}

/// 終わり方を持たない構成のときの答え。**落とさない**（既存の統合テスト用）。
pub fn no_stop() -> Stopper {
    Arc::new(|| tracing::warn!("この構成では自分を終えられません"))
}

/// 応答を流し切ってから落とすまでの間（設計§24）。
///
/// **ハンドラの中で落とすと応答が届かない。** ブラウザからは「押したのに失敗した」と
/// 見分けが付かなくなるので、返してから落とす。
const STOP_AFTER: std::time::Duration = std::time::Duration::from_millis(250);

/// 版の一覧と、いまの状態（設計§14）。
///
/// `supported` / `editable` を分けてあるのは [`crate::settings_api::LanPasswordView`] と
/// 同じ形。**使えない構成なのに中身がある**という組み合わせを作らないため、
/// `supported` が偽なら他も空にする。
///
/// `Deserialize` も持つのは、CLI（`client`）が同じ型で応答を読み戻すため（CLI設計§6-3）。
/// CLI 側に写しの型を定義すると、片方だけが古くなる場所が1つ増える。
#[derive(Debug, Serialize, Deserialize)]
pub struct VersionsView {
    /// 保管庫を持てる構成か。**箱の中なら偽**（書いても次に起こし直すと消える）。
    pub supported: bool,
    /// いま操作してよいか（設計§13）。
    pub editable: bool,
    pub entries: Vec<VersionEntry>,
    /// 次に起こすときの版。ポインタが無ければ `None`（＝入れる側が置いた版）。
    pub selected: Option<VersionId>,
    /// 前回の乗り換えの結末。**知らせではなく状態**として持つ（設計§11）。
    pub outcome: Option<version::Outcome>,
    /// 最後に読めた最新版。一度も見に行けていなければ `None`（設計§8）。
    pub latest: Option<LatestView>,
    /// **いま入れ替えると抜け殻になるカードの枚数**（設計§10）。
    ///
    /// 押す前に数で見せるための値。ローカルモードでは PTY が道連れで死ぬが**カードは
    /// 記録に残る**ので、戻ってきた画面は空ではなく「履歴だけが読める抜け殻が N 枚
    /// 並んだ画面」になる。サーバモードは PTY を持たないので常に 0。
    ///
    /// 既に繋がっていないカードは**既に抜け殻**なので数えない。ここが数えるのは
    /// **これから失うぶん**だけ。
    pub stranded_cards: usize,
    /// 取ってくる仕事の様子（設計§15）。押していなければ `None`。
    pub install: Option<InstallView>,
    /// 取ってくる道具が無いときの理由（設計§23-6）。
    ///
    /// **`supported` と混ぜない。** あちらは「保管庫を持てる構成か」で、こちらは
    /// 「取ってこられるか」。混ぜると画面が2つを区別できなくなる——版を選ぶことは
    /// できるが取ってくることはできない、という組み合わせが普通にある。
    pub install_unavailable: Option<String>,
    /// ポインタの実際の置き場所。
    ///
    /// **画面が「手で消す2行」を出すために要る**（設計§9 の最終節）。この機能より
    /// 前の版へ戻ると版を選ぶ画面ごと無くなるので、**ここが袋小路からの唯一の
    /// 出口**になる。決め打ちの既定を書くと `state_dir` を移している利用者に
    /// 存在しないパスを案内することになり、出口が塞がる。
    pub pointer_path: String,

    // --- ここから下は「このダッシュボードについて」の材料（バージョン表示イシュー）。
    //     **`supported` が偽でも埋める。** 版の切替が使えない構成（箱）でこそ、
    //     「いま何が動いていて、いつからここに在るか」を知りたい
    /// いま走っている版。
    pub running: VersionId,
    /// 走っている実行ファイルができた時刻。読めなければ `None`。
    ///
    /// 配布物なら**その版が作られた時刻**、ソースビルドなら**自分がビルドした時刻**。
    pub binary_at: Option<protocol::Timestamp>,
    /// 走っている実行ファイルの場所。
    ///
    /// **一覧の行から引かせない**（設計§3）。実機では走ってきた実体が消えているので、
    /// どの行とも一致しない——行を探させると「不明」としか出せなくなる。
    #[serde(default)]
    pub running_path: Option<String>,
    /// このプロセスが起きた時刻。
    ///
    /// [`Self::binary_at`] と対で見る。**更新したのか、再起動しただけなのか**が
    /// この2つの差で分かる。
    pub started_at: protocol::Timestamp,

    // --- ここから下は「手元の新しい版を GUI だけで効かせる」イシューで足したもの。
    /// **いま起こし直したら、どれで立ち上がるか**（設計§4）。
    ///
    /// [`Self::selected`] は「予約があるか」しか答えない。**予約が無い機械
    /// （ソースビルド）でも次に起きる版は在る**ので、画面が見るのはこちらである。
    ///
    /// **起動時の乗り換えと同じ関数**（`version::next_binary`）から作る。別々に
    /// 組み立てると、画面が言った版と実際に立ち上がる版が食い違う。
    #[serde(default)]
    pub next_version: Option<VersionId>,
    /// 次に起きる版の実行ファイルの場所。同じ版名の行を見分ける材料になる。
    #[serde(default)]
    pub next_path: Option<String>,
    /// **走っているものと、次に起きるものが違うか**（設計§5）。
    ///
    /// **外を見に行かない。** 「新しい版が出ています」（[`Self::latest`]）とは別物で、
    /// あちらは取ってくる相手が居ることの知らせ、こちらは**自分の足元**の話である。
    /// ソースビルドの機械に要るのはこちらだけ（取ってくる相手が居ない）。
    #[serde(default)]
    pub next_differs: bool,
}

/// 取ってくる仕事の段階（設計§15）。
///
/// **3つしか無い。** 細かく刻むには [`session_host_core::version::install_version`] の中へ
/// 通知の口を通すことになるが、窓は数十秒なので割に合わない（設計§24）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallPhase {
    Installing,
    Done,
    Failed,
}

/// 取ってくる仕事の様子。
///
/// **プロセスの中にだけ持つ。** [`version::Outcome`] がファイルなのは乗り換えが
/// プロセスをまたぐからで、取ってくる仕事はまたがない（設計§24）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallView {
    pub version: VersionId,
    pub phase: InstallPhase,
    /// 失敗した理由。うまくいったときは `None`。
    pub reason: Option<String>,
}

/// 版を選ぶときの本文。
#[derive(Debug, Deserialize)]
pub struct SelectRequest {
    pub version: VersionId,
    /// **確かめられなかったことを承知のうえで進めるか**（設計§9）。
    ///
    /// この機能より前の版は記録の形を答えられないので、必ず「確かめられません」を通る。
    /// 断ってしまうといちばん戻りたい先へ永久に戻れなくなるので、**同意を取って通す**。
    #[serde(default)]
    pub confirm_unverified: bool,
}

/// 最後に読めた最新版（設計§8）。
///
/// **素の値だけを載せる。** 「新着かどうか」は画面が**走っている版より新しいか**で
/// 決める（`VersionId` は版として比べられる）。サーバが「新着です」と決めてしまうと、
/// 押しつけの知らせ（同じ版で二度出さない）と状態（繋いだ瞬間に読める）が
/// **同じ値を取り合う**——別々の問題への答えなので、値も分ける。
///
/// この口は**見に行かない。** 最後に読めた値を返すだけで、外へ出るのは背景の周期だけ。
/// さもないと画面を開くたびにネットワークが要る。
#[derive(Debug, Serialize, Deserialize)]
pub struct LatestView {
    pub version: VersionId,
    /// 試作版か。**いまはほぼ常に偽**（`releases/latest` は非試作版を指すため）。
    pub prerelease: bool,
    /// 自分の機械向けの箱があるか。**無い版は勧めない。**
    pub has_artifact: bool,
    /// 最後に見に行った時刻。
    pub checked_at: protocol::Timestamp,
}

/// 走っている実行ファイルの場所（覚えた値から）。
fn running_path() -> Option<String> {
    version::running_binary()
        .path
        .as_ref()
        .map(|path| path.display().to_string())
}

/// 記録から最新版を組み立てる。一度も読めていなければ `None`。
fn latest_of(state_dir: &std::path::Path) -> Option<LatestView> {
    let notice = session_host_core::version_ops::read_notice(state_dir);
    (!notice.latest.is_empty()).then(|| LatestView {
        version: VersionId::new(notice.latest),
        prerelease: notice.prerelease,
        has_artifact: notice.has_artifact,
        checked_at: notice.checked_at,
    })
}

#[derive(Clone)]
pub struct VersionsState {
    /// 保管庫・ポインタ・結末の置き場所。
    pub state_dir: PathBuf,
    /// 入口の鍵。**押せる相手の決め方がモードで変わる**ので要る。
    pub auth: Arc<AuthContext>,
    /// カードの記録。**この機械が PTY を持っているときだけ `Some`**（設計§10）。
    ///
    /// 鍵のモードで見分ける道もあるが、あれは**鍵のかけ方**であって PTY の持ち主では
    /// ない。`None` が「この機械は誰も道連れにしない」を型で言うほうが読み違えにくい。
    pub registry: Option<Arc<SessionRegistry>>,
    /// 親が受け取った `--config`（設計§9）。
    ///
    /// **書き戻し先の `config_path` とは別物。** 常に渡すと、設定ファイルを置いて
    /// いない利用者を「設定が壊れている」と誤判定する——`--config` 無しの起動は、
    /// カレントに設定が無くても空の設定として成功するため。
    pub config_arg: Option<PathBuf>,
    /// 適用済みの記録の形を読む口（設計§9）。
    pub applied: AppliedSchemas,
    /// 取ってくる窓口（設計§7）。**道具が無い環境でも形は変えない**（必ず失敗を返す実装）。
    pub ops: Arc<dyn VersionOps>,
    /// 取ってくる仕事の様子（設計§15）。
    pub install: Arc<Mutex<Option<InstallView>>>,
    /// 自分を終える口（設計§10）。
    pub stop: Stopper,
}

pub fn routes(state: VersionsState) -> Router {
    Router::new()
        .route("/api/versions", get(api_versions))
        .route(
            "/api/versions/selected",
            put(api_select).delete(api_unselect),
        )
        .route("/api/versions/{version}", delete(api_remove))
        .route("/api/versions/{version}/install", post(api_install))
        .route("/api/versions/restart", post(api_restart))
        .with_state(state)
}

/// 版を操作してよいか（設計§13）。
///
/// ローカルモードの `is_admin` は**常に偽**なので、管理者で絞ると誰も押せなくなる。
/// モードで分ける。
fn may_operate(auth: &AuthContext, identity: &Identity) -> bool {
    match auth.mode {
        AuthMode::Account => identity.is_admin,
        AuthMode::Open | AuthMode::LanPassword => identity.from_loopback,
    }
}

/// 断り方。**どこから叩けば通るか／誰なら押せるか**を書く。
fn refusal(auth: &AuthContext) -> (StatusCode, String) {
    let reason = match auth.mode {
        AuthMode::Account => "版の切り替えは管理者のアカウントだけができます",
        _ => "版の切り替えは、この PC のブラウザ（127.0.0.1）からだけできます",
    };
    (StatusCode::FORBIDDEN, reason.to_string())
}

/// いまの一覧を組み立てる。
///
/// **プロセスを起こすので、非同期の担ぎ手を塞がないよう逃がす。**
async fn build_view(state: &VersionsState, identity: &Identity) -> VersionsView {
    let editable = may_operate(&state.auth, identity);
    let supported = version::Capability::detect().supported();
    // 出口の案内は走査の前に決まる。**出せない構成でも嘘は書かない**
    let pointer_path = version::pointer_path(&state.state_dir)
        .display()
        .to_string();
    if !supported {
        // できないことをボタンにしない。走査そのものを省く。
        //
        // **ただし「何が動いているか」は出す。** 版の切替が使えない構成でも、
        // 最新版の確認そのものは走っており（記録は箱の中にもある）、捨てると
        // 「更新されているか知りたいのに、いちばん知りたい画面に何も出ない」になる
        return VersionsView {
            supported,
            editable,
            entries: Vec::new(),
            selected: None,
            outcome: None,
            latest: latest_of(&state.state_dir),
            stranded_cards: 0,
            install: None,
            install_unavailable: None,
            pointer_path,
            running: version::running_version(),
            binary_at: version::binary_at(),
            running_path: running_path(),
            started_at: version::started_at(),
            // 乗り換えられない構成なので、次に起きる版という概念が無い
            next_version: None,
            next_path: None,
            next_differs: false,
        };
    }

    let state_dir = state.state_dir.clone();
    let entries = tokio::task::spawn_blocking(move || {
        version::list_versions(&state_dir, version::source_dir().as_deref())
    })
    .await
    .unwrap_or_default();

    let selected = entries
        .iter()
        .find(|entry| entry.selected)
        .map(|entry| entry.version.clone());

    // **次に起きる版**（設計§4）。起動時の乗り換えと同じ関数から作る。
    // 版名は一覧の行から引く——同じ実行ファイルを二度聞きに行かないため
    let next_binary = version::next_binary(&state.state_dir);
    let next_entry = next_binary.as_deref().and_then(|target| {
        entries
            .iter()
            .find(|entry| version::same_path(std::path::Path::new(&entry.path), target))
    });
    let next_version = next_entry.map(|entry| entry.version.clone());
    let next_differs = version::differs(
        &version::running_version(),
        version::running_binary(),
        next_version.as_ref(),
        next_binary.as_deref().and_then(version::built_at_of),
    );

    VersionsView {
        supported,
        editable,
        entries,
        selected,
        outcome: version::read_outcome(&state.state_dir),
        latest: latest_of(&state.state_dir),
        stranded_cards: stranded_cards(state, identity),
        install: state.install.lock().expect("ロックが壊れていない").clone(),
        install_unavailable: state.ops.unavailable_reason(),
        pointer_path,
        running: version::running_version(),
        binary_at: version::binary_at(),
        running_path: running_path(),
        started_at: version::started_at(),
        next_version,
        next_path: next_binary.map(|path| path.display().to_string()),
        next_differs,
    }
}

/// いま入れ替えると抜け殻になるカードの枚数（設計§10）。
///
/// PTY を持たない構成（サーバモード）では**数える相手が居ない**ので 0。
fn stranded_cards(state: &VersionsState, identity: &Identity) -> usize {
    let Some(registry) = &state.registry else {
        return 0;
    };
    registry
        .list(identity.account_id)
        .iter()
        .filter(|meta| meta.agent_connected)
        .count()
}

async fn api_versions(
    State(state): State<VersionsState>,
    Extension(identity): Extension<Identity>,
) -> Json<VersionsView> {
    Json(build_view(&state, &identity).await)
}

async fn api_remove(
    State(state): State<VersionsState>,
    Extension(identity): Extension<Identity>,
    Path(version): Path<String>,
) -> Result<Json<VersionsView>, (StatusCode, String)> {
    if !may_operate(&state.auth, &identity) {
        return Err(refusal(&state.auth));
    }

    let version = VersionId::new(version);
    if version::stored_version_dir(&state.state_dir, &version).is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("保管庫にありません: {version}"),
        ));
    }

    // **錠はプロセスをまたぐ**（設計§13）。順番待ちはせず、動いていることをその場で伝える
    version::acquire_lock(&state.state_dir).map_err(|reason| (StatusCode::CONFLICT, reason))?;
    let removed = version::remove_version(&state.state_dir, &version);
    version::release_lock(&state.state_dir);
    removed.map_err(|reason| (StatusCode::CONFLICT, reason))?;

    Ok(Json(build_view(&state, &identity).await))
}

/// 次に起こす版を選ぶ（設計§9・§10）。
///
/// **プロセスは落ちない。** ここでやるのは門を通してポインタを書くところまでで、
/// 効くのは次に起こしたとき——要件が名指しで恐れている「選んだ瞬間に全部入れ替わる」を
/// 構造で外している。
async fn api_select(
    State(state): State<VersionsState>,
    Extension(identity): Extension<Identity>,
    Json(request): Json<SelectRequest>,
) -> Result<Json<VersionsView>, (StatusCode, String)> {
    if !may_operate(&state.auth, &identity) {
        return Err(refusal(&state.auth));
    }

    let Some(dir) = version::stored_version_dir(&state.state_dir, &request.version) else {
        return Err((
            StatusCode::NOT_FOUND,
            format!("保管庫にありません: {}", request.version),
        ));
    };
    // **3本揃って、3本とも同じ版を名乗るときだけ選ばせる**（設計§6）。揃っていない版を
    // 選ばせると、パーサだけ食い違った状態で動き出す
    version::versions_agree(&dir)
        .map_err(|reason| (StatusCode::CONFLICT, format!("選べません: {reason}")))?;
    let target = dir.join("agentdashboard");

    version::acquire_lock(&state.state_dir).map_err(|reason| (StatusCode::CONFLICT, reason))?;
    let verdict = decide(&state, &target).await;
    let selected = match &verdict {
        Ok(gate::Verdict::Ready) => Ok(()),
        // **断らない。** 断るといちばん戻りたい先（この機能を入れる直前の版）へ
        // 永久に戻れなくなるので、承知のうえなら通す（設計§9）
        Ok(gate::Verdict::Unverified { reason }) if request.confirm_unverified => {
            tracing::warn!(version = %request.version, %reason, "確かめられないまま版を選びました");
            Ok(())
        }
        Ok(gate::Verdict::Unverified { reason }) => Err((
            // **「断った」とは別の返し方をする。** 同意すれば進める道が残っていることを、
            // 画面が状態コードだけで見分けられるようにする
            StatusCode::PRECONDITION_REQUIRED,
            reason.clone(),
        )),
        Ok(gate::Verdict::Refused { reason }) => Err((StatusCode::CONFLICT, reason.clone())),
        Err(reason) => Err((StatusCode::CONFLICT, reason.clone())),
    };
    if selected.is_ok() {
        version::write_pointer(&state.state_dir, Some(&target));
    }
    version::release_lock(&state.state_dir);
    selected?;

    Ok(Json(build_view(&state, &identity).await))
}

/// 行き先に聞いて結論を出す（設計§9）。
async fn decide(state: &VersionsState, target: &std::path::Path) -> Result<gate::Verdict, String> {
    let applied = (state.applied)().await?;
    let target = target.to_path_buf();
    let config_arg = state.config_arg.clone();
    // **3回プロセスを起こす**ので、非同期の担ぎ手を塞がないよう逃がす
    let answers = tokio::task::spawn_blocking(move || gate::ask(&target, config_arg.as_deref()))
        .await
        .map_err(|err| format!("行き先に聞けませんでした: {err}"))??;
    Ok(gate::judge(&answers, &applied))
}

/// 予約を取り消す（設計§10）。**入れる側が置いた版へ戻る。**
async fn api_unselect(
    State(state): State<VersionsState>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<VersionsView>, (StatusCode, String)> {
    if !may_operate(&state.auth, &identity) {
        return Err(refusal(&state.auth));
    }

    version::acquire_lock(&state.state_dir).map_err(|reason| (StatusCode::CONFLICT, reason))?;
    version::write_pointer(&state.state_dir, None);
    version::release_lock(&state.state_dir);

    Ok(Json(build_view(&state, &identity).await))
}

/// 版を取ってくる（設計§7・§15）。
///
/// **すぐ返して背景で走らせる。** 取得は数十秒かかるので、応答を待たせると前段の
/// 打ち切りに当たる。様子は [`VersionsView::install`] に出る。
///
/// **取ってきても選ばない。** 「勝手に更新されない」の最後の砦なので、ポインタは
/// [`api_select`] でしか書かない。
async fn api_install(
    State(state): State<VersionsState>,
    Extension(identity): Extension<Identity>,
    Path(version): Path<String>,
) -> Result<(StatusCode, Json<VersionsView>), (StatusCode, String)> {
    if !may_operate(&state.auth, &identity) {
        return Err(refusal(&state.auth));
    }
    if let Some(reason) = state.ops.unavailable_reason() {
        return Err((StatusCode::CONFLICT, reason));
    }

    let version = VersionId::new(version);
    version::acquire_lock(&state.state_dir).map_err(|reason| (StatusCode::CONFLICT, reason))?;
    *state.install.lock().expect("ロックが壊れていない") = Some(InstallView {
        version: version.clone(),
        phase: InstallPhase::Installing,
        reason: None,
    });

    let background = state.clone();
    tokio::spawn(async move {
        let state_dir = background.state_dir.clone();
        let ops = Arc::clone(&background.ops);
        let target = version.clone();
        let done = tokio::task::spawn_blocking(move || {
            version::install_version(&state_dir, ops.as_ref(), &target)
        })
        .await;
        let (phase, reason) = match done {
            Ok(Ok(_)) => (InstallPhase::Done, None),
            Ok(Err(reason)) => (InstallPhase::Failed, Some(reason)),
            Err(err) => (
                InstallPhase::Failed,
                Some(format!("取ってこられません: {err}")),
            ),
        };
        *background.install.lock().expect("ロックが壊れていない") = Some(InstallView {
            version,
            phase,
            reason,
        });
        version::release_lock(&background.state_dir);
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(build_view(&state, &identity).await),
    ))
}

/// いま入れ替える（設計§10）。
///
/// **自分を終えるところまで。** 起こし直しは常駐の設定（systemd の `Restart=always` ／
/// compose の `restart: unless-stopped`）に任せる。見届け役のプロセスを離す形は採らない
/// ——このプロジェクトは離したプロセスが孤児として生き残った事故を実測している。
async fn api_restart(
    State(state): State<VersionsState>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<VersionsView>, (StatusCode, String)> {
    if !may_operate(&state.auth, &identity) {
        return Err(refusal(&state.auth));
    }

    // **押す直前に、行き先へ問う**（`手元の新しい版をGUIだけで効かせる` 設計§8）。
    //
    // 門は予約を入れるときにも走るが、**予約を通らない道がある**——ソースビルドの機械は
    // 予約を使わないので、押す道だけが門の外側にできてしまう。
    //
    // **予約時の1回では代わりにならない。** 予約してから押すまでの間にファイルが
    // 置き換わりうるからで、実機ではそれが常態である。
    //
    // 実測：ゴミを置いた行き先へ `exec` すると、**失敗せずにシェルへ落ちてそのまま死ぬ**。
    // 「失敗したら生き残る」では防げないので、**起こす前に断る**しかない。
    // **2つを分けて扱う。** `decide` は「行き先が起動できない」と「記録の形を読めない」を
    // 同じ `Err` にまとめるが、**塞いでよいのは前者だけ**——後者で断ると、記録へ聞けない
    // 構成（`no_schemas`）で押す道が丸ごと無くなる。
    if let Some(target) = version::next_binary(&state.state_dir) {
        let asked = {
            let target = target.clone();
            let config_arg = state.config_arg.clone();
            tokio::task::spawn_blocking(move || gate::ask(&target, config_arg.as_deref()))
                .await
                .map_err(|err| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("行き先に聞けませんでした: {err}"),
                    )
                })?
        };
        // ①起きるか・設定を読めるか。**ここが駄目なら絶対に起こさない**
        let answers = asked.map_err(|reason| {
            (
                StatusCode::CONFLICT,
                format!("この版では起動できないので入れ替えません: {reason}"),
            )
        })?;
        // ②記録の形。聞けないときは**通す**（今までどおり）
        if let Ok(applied) = (state.applied)().await
            && let gate::Verdict::Refused { reason } = gate::judge(&answers, &applied)
        {
            return Err((StatusCode::CONFLICT, reason));
        }
    }

    let view = build_view(&state, &identity).await;
    tracing::info!(
        stranded = view.stranded_cards,
        "版を入れ替えるために終了します"
    );
    let stop = Arc::clone(&state.stop);
    tokio::spawn(async move {
        // **返してから落とす。** 応答が届かないと「押したのに失敗した」と見分けが付かない
        tokio::time::sleep(STOP_AFTER).await;
        stop();
    });

    Ok(Json(view))
}
