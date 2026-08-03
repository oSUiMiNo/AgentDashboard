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

use agent_core::version;
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::get,
};
use protocol::{VersionEntry, VersionId};
use serde::Serialize;
use server_core::auth::{AuthContext, AuthMode, Identity};
use std::path::PathBuf;
use std::sync::Arc;

/// 版の一覧と、いまの状態（設計§14）。
///
/// `supported` / `editable` を分けてあるのは [`crate::settings_api::LanPasswordView`] と
/// 同じ形。**使えない構成なのに中身がある**という組み合わせを作らないため、
/// `supported` が偽なら他も空にする。
#[derive(Debug, Serialize)]
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
}

#[derive(Clone)]
pub struct VersionsState {
    /// 保管庫・ポインタ・結末の置き場所。
    pub state_dir: PathBuf,
    /// 入口の鍵。**押せる相手の決め方がモードで変わる**ので要る。
    pub auth: Arc<AuthContext>,
}

pub fn routes(state: VersionsState) -> Router {
    Router::new()
        .route("/api/versions", get(api_versions))
        .route("/api/versions/{version}", axum::routing::delete(api_remove))
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
    if !supported {
        // できないことをボタンにしない。走査そのものを省く
        return VersionsView {
            supported,
            editable,
            entries: Vec::new(),
            selected: None,
            outcome: None,
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

    VersionsView {
        supported,
        editable,
        entries,
        selected,
        outcome: version::read_outcome(&state.state_dir),
    }
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
