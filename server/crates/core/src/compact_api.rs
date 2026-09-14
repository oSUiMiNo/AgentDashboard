//! 仮想ディスクの空洞を Windows へ返す口（設計§9）。
//!
//! # なぜ版の口へ相乗りさせないのか
//!
//! [`crate::versions_api`] の charter は「ダッシュボード自身の版を見る口と、消す口」で、
//! **縮小は版の話ではない**。混ぜると charter が濁る。
//!
//! # なぜ `server-core` ではなく、ここに新しいファイルを作るのか
//!
//! `/api/hosts/…` の他の口は `server-core/src/lib.rs` に在り、あのファイルは既に
//! `cli_surface.rs` の `鍵の内側` に載っている。**そこへ足すと、台帳の穴が見えないまま
//! 塞がる**——このイシューが設計§13 で「隠れた本題」と呼んでいるのは、**5つ目のファイルを
//! 作ったときに台帳が黙ることを実際に見ること**である。
//!
//! # remote は作らない
//!
//! 縮小は**その機械の仮想ディスクを縮める**操作なので、別の PC に対して意味を持たない。
//! `SessionHost` trait 経由で remote も捌く形にすると `crates/protocol`（共有境界）へ
//! 指示を足すことになり、しかも**サーバが無いので確かめられない**。だから
//! **`local` 以外は 501 で断る**。断ったことは台帳の行にも書いてある。

use axum::{
    Extension, Json, Router,
    extract::{Path as AxumPath, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use server_core::auth::Identity;
use server_core::registry::SessionRegistry;
use session_host_core::compact::{
    self, CompactConfig, CompactStatus, QuietProbe, SlackProbe, TaskLauncher,
};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;

/// 口が抱えるもの。
#[derive(Clone)]
pub struct CompactApiState {
    /// 印と覚えていることの置き場所。
    pub state_dir: PathBuf,
    /// しきい値・時間帯・タスク名（設計§8）。
    pub cfg: CompactConfig,
    /// 機械の静けさを読む口。
    pub quiet: Arc<dyn QuietProbe>,
    /// 空洞を読む口。
    pub slack: Arc<dyn SlackProbe>,
    /// Windows のタスクを起こす口。
    pub launcher: Arc<dyn TaskLauncher>,
    /// カードの記録。**PTY を持たない構成（サーバモード）では `None`。**
    pub registry: Option<Arc<SessionRegistry>>,
}

pub fn routes(state: CompactApiState) -> Router {
    Router::new()
        .route("/api/hosts/{host}/compact", get(api_status).post(api_run))
        .route("/api/hosts/{host}/compact/pause", post(api_pause))
        .with_state(state)
}

/// `local` 以外を断る。
///
/// **`parse_host` を呼ばないのは、呼ぶ必要が無いからである**——縮小は `local` 専用なので、
/// 名前が `local` でなければそれだけで断れる。
fn local_only(host: &str) -> Result<(), (StatusCode, String)> {
    if host == "local" {
        return Ok(());
    }
    Err((
        StatusCode::NOT_IMPLEMENTED,
        "縮小はこの機械（local）にだけ効きます。別の PC の仮想ディスクは縮められません".to_string(),
    ))
}

/// 生きたカードの枚数。
///
/// **`version restart` の `stranded_cards` とは数え方が違う。** あちらは「繋がっている
/// カード」を数えるので、ローカルモードでは**終了済みの抜け殻まで**入る。落とすと
/// 道連れになるのは走っている claude だけなので、`client::alive_cards` と同じく
/// **終了していないもの**で数える。
fn alive_cards(state: &CompactApiState, identity: &Identity) -> usize {
    let Some(registry) = &state.registry else {
        return 0;
    };
    registry
        .list(identity.account_id)
        .iter()
        .filter(|meta| !matches!(meta.status, protocol::SessionStatus::Ended { .. }))
        .count()
}

/// いまの様子を組む。
fn 様子(state: &CompactApiState, identity: &Identity) -> CompactStatus {
    let remembered = compact::load_state(&state.state_dir);
    let claude_procs = state.quiet.claude_procs().unwrap_or(0);
    let interactive_shells = state.quiet.interactive_shells().unwrap_or(0);
    let in_window = match (
        state.quiet.local_minutes(),
        compact::窓を読む(&state.cfg.window),
    ) {
        (Some(いま), Some((開始, 終了))) => compact::窓の中か(いま, 開始, 終了),
        // **読めなければ「外」に倒す。** 時間帯が分からないのに打つ理由が無い
        _ => false,
    };
    CompactStatus {
        alive_cards: alive_cards(state, identity),
        claude_procs,
        interactive_shells,
        quiet_since: remembered.quiet_since,
        in_window,
        slack_bytes: state
            .slack
            .read(
                state.cfg.ext4_vhdx.as_deref(),
                state.cfg.docker_vhdx.as_deref(),
            )
            .map(|slack| slack.slack_bytes()),
        last_compact: remembered.last_compact,
        auto_enabled: state.cfg.auto,
        paused_until: remembered.paused_until,
    }
}

/// 画面と CLI が読む形。
#[derive(Debug, Serialize, Deserialize)]
pub struct CompactView {
    pub alive_cards: usize,
    pub claude_procs: usize,
    pub interactive_shells: usize,
    pub in_window: bool,
    pub slack_bytes: Option<u64>,
    pub auto_enabled: bool,
    /// 自動で打てない理由（`null` なら打てる）。
    pub auto_blocker: Option<String>,
    /// 手で打てない理由（`null` なら打てる）。
    pub manual_blocker: Option<String>,
}

fn view(status: &CompactStatus, cfg: &CompactConfig, now: SystemTime) -> CompactView {
    CompactView {
        alive_cards: status.alive_cards,
        claude_procs: status.claude_procs,
        interactive_shells: status.interactive_shells,
        in_window: status.in_window,
        slack_bytes: status.slack_bytes,
        auto_enabled: status.auto_enabled,
        auto_blocker: status.blocker(cfg, now).map(|b| b.言い分()),
        manual_blocker: status.manual_blocker(false).map(|b| b.言い分()),
    }
}

async fn api_status(
    AxumPath(host): AxumPath<String>,
    State(state): State<CompactApiState>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<CompactView>, (StatusCode, String)> {
    local_only(&host)?;
    let status = 様子(&state, &identity);
    Ok(Json(view(&status, &state.cfg, SystemTime::now())))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct RunBody {
    /// 道連れを承知で打つ。**飛ばすのは生きたカードだけ**（設計§3-4）。
    pub force: bool,
}

async fn api_run(
    AxumPath(host): AxumPath<String>,
    State(state): State<CompactApiState>,
    Extension(identity): Extension<Identity>,
    body: Option<Json<RunBody>>,
) -> Result<Json<CompactView>, (StatusCode, String)> {
    local_only(&host)?;
    let force = body.map(|Json(body)| body.force).unwrap_or(false);
    let status = 様子(&state, &identity);

    // **断るのは道連れになるものだけ**（時間帯としきい値は手では見ない。設計§3-4）
    if let Some(blocker) = status.manual_blocker(force) {
        return Err((StatusCode::CONFLICT, blocker.言い分()));
    }

    let slack = status.slack_bytes.unwrap_or(0);
    tracing::info!(
        kind = "compact_start",
        slack_gb = slack / (1024 * 1024 * 1024),
        trigger = "manual",
        alive = status.alive_cards,
        "縮小を撃ちます"
    );

    // **印を書いてから撃つ。** 逆にすると、撃った直後に死んだとき印が残らず、
    // 起き直った側が「縮小が走ったのか、ただ落ちただけか」を区別できない（設計§3-2）。
    match compact::印を書いてから撃つ(
        &state.state_dir,
        state.launcher.as_ref(),
        &state.cfg.script_task,
        slack,
        SystemTime::now(),
    ) {
        compact::FireResult::Fired => {
            // **この後どこかで自分が死ぬ。** 結果は起き直った側が拾う（フェーズ3）
            Ok(Json(view(&status, &state.cfg, SystemTime::now())))
        }
        compact::FireResult::Failed => {
            tracing::warn!(
                kind = "compact_failed",
                reason = "タスクを起こせなかった",
                "縮小を撃てませんでした"
            );
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!(
                    "Windows のタスク `{}` を起こせませんでした。登録されているか確かめてください",
                    state.cfg.script_task
                ),
            ))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct PauseBody {
    /// いつまで止めるか（RFC3339）。
    pub until: String,
}

async fn api_pause(
    AxumPath(host): AxumPath<String>,
    State(state): State<CompactApiState>,
    Extension(identity): Extension<Identity>,
    Json(body): Json<PauseBody>,
) -> Result<Json<CompactView>, (StatusCode, String)> {
    local_only(&host)?;
    let until = compact::時刻を読む(&body.until).ok_or((
        StatusCode::BAD_REQUEST,
        format!(
            "`{}` を時刻として読めません（RFC3339 で書いてください）",
            body.until
        ),
    ))?;
    let mut remembered = compact::load_state(&state.state_dir);
    remembered.paused_until = Some(until);
    compact::save_state(&state.state_dir, &remembered);
    tracing::info!(kind = "compact_paused", until = %body.until, "自動を止めました");

    let mut status = 様子(&state, &identity);
    status.paused_until = Some(until);
    Ok(Json(view(&status, &state.cfg, SystemTime::now())))
}
