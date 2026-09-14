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
use std::time::{Duration, SystemTime};
use uuid::Uuid;

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
///
/// **[`Identity`] ではなく `account_id` を受ける。** 自動の見回り（[`一回り`]）には
/// HTTP の身元が無いが、ローカルモードのアカウントは
/// [`server_core::db::LOCAL_ACCOUNT_ID`] の1つしか無いので、それを渡せば足りる。
fn alive_cards(state: &CompactApiState, account_id: Uuid) -> usize {
    let Some(registry) = &state.registry else {
        return 0;
    };
    registry
        .list(account_id)
        .iter()
        .filter(|meta| !matches!(meta.status, protocol::SessionStatus::Ended { .. }))
        .count()
}

/// いまの様子を組む。
fn 様子(state: &CompactApiState, account_id: Uuid) -> CompactStatus {
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
    // **1回だけ読んで、2つとも写す。** 空洞と合計は同じ測定から出る値なので、
    // 別々に読むと**同じ瞬間の話ではなくなる**（画面には並べて出る）。
    let slack = state.slack.read(
        state.cfg.ext4_vhdx.as_deref(),
        state.cfg.docker_vhdx.as_deref(),
    );
    CompactStatus {
        alive_cards: alive_cards(state, account_id),
        claude_procs,
        interactive_shells,
        quiet_since: remembered.quiet_since,
        in_window,
        slack_bytes: slack.map(|slack| slack.slack_bytes()),
        vhdx_bytes: slack.map(|slack| slack.vhdx_bytes()),
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
    /// 2枚の仮想ディスクが C: の上で占めている合計（`null` なら読めない）。
    pub vhdx_bytes: Option<u64>,
    /// 最後に縮めた時刻（epoch ミリ秒。`null` なら一度も縮めていない）。
    ///
    /// **`protocol::Timestamp` と同じ形で載せる。** このリポジトリは時刻を i64 の
    /// エポックで運んでおり、`SystemTime` をそのまま `Serialize` すると
    /// `{ secs_since_epoch, nanos_since_epoch }` という別の形で出てしまう。
    pub last_compact: Option<protocol::Timestamp>,
    pub auto_enabled: bool,
    /// 自動で打てない理由（`null` なら打てる）。
    pub auto_blocker: Option<String>,
    /// 手で打てない理由（`null` なら打てる）。
    pub manual_blocker: Option<String>,
}

/// `SystemTime` を epoch ミリ秒へ。**読めない時刻は載せない**（`None` にする）。
fn epoch_ms(time: SystemTime) -> Option<protocol::Timestamp> {
    time.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_millis() as protocol::Timestamp)
}

fn view(status: &CompactStatus, cfg: &CompactConfig, now: SystemTime) -> CompactView {
    CompactView {
        alive_cards: status.alive_cards,
        claude_procs: status.claude_procs,
        interactive_shells: status.interactive_shells,
        in_window: status.in_window,
        slack_bytes: status.slack_bytes,
        vhdx_bytes: status.vhdx_bytes,
        last_compact: status.last_compact.and_then(epoch_ms),
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
    let status = 様子(&state, identity.account_id);
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
    let status = 様子(&state, identity.account_id);

    // **断るのは道連れになるものだけ**（時間帯としきい値は手では見ない。設計§3-4）
    if let Some(blocker) = status.manual_blocker(force) {
        return Err((StatusCode::CONFLICT, blocker.言い分()));
    }

    match 記録して撃つ(&state, &status, "manual", SystemTime::now()) {
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

    let mut status = 様子(&state, identity.account_id);
    status.paused_until = Some(until);
    Ok(Json(view(&status, &state.cfg, SystemTime::now())))
}

// ---------------------------------------------------------------------------
// 撃つ手順（手で押したときも、自動のときも、ここを通る）

/// 記録を残してから撃ち、撃てたら「最後に打った時刻」を控える。
///
/// **門はここでは見ない。** 手（[`api_run`]）は [`CompactStatus::manual_blocker`]、
/// 自動（[`一回り`]）は [`CompactStatus::blocker`] と、**通す門が違う**ので、
/// 呼ぶ側が通しておく決まりにしてある。ここへ門を書くと、どちらかが必ず間違う。
fn 記録して撃つ(
    state: &CompactApiState,
    status: &CompactStatus,
    trigger: &'static str,
    now: SystemTime,
) -> compact::FireResult {
    let slack = status.slack_bytes.unwrap_or(0);
    tracing::info!(
        kind = "compact_start",
        slack_gb = slack / (1024 * 1024 * 1024),
        trigger = trigger,
        alive = status.alive_cards,
        "縮小を撃ちます"
    );

    // **印を書いてから撃つ。** 逆にすると、撃った直後に死んだとき印が残らず、
    // 起き直った側が「縮小が走ったのか、ただ落ちただけか」を区別できない（設計§3-2）。
    let result = compact::印を書いてから撃つ(
        &state.state_dir,
        state.launcher.as_ref(),
        &state.cfg.script_task,
        slack,
        now,
    );

    if matches!(result, compact::FireResult::Fired) {
        // **撃てたときだけ控える。** 撃てなかった回まで「打った」ことにすると、
        // 何も起きていないのに24時間打てなくなる。
        //
        // **撃った後に書く**ので、書き終える前に機械が落ちることがある。そのときは
        // 起き直った側（`settle_compact`）が印から埋め直す——印は撃つ前に必ず
        // 書かれていて、撃った時刻を持っている。
        let mut remembered = compact::load_state(&state.state_dir);
        remembered.last_compact = Some(now);
        compact::save_state(&state.state_dir, &remembered);
    }
    result
}

// ---------------------------------------------------------------------------
// 静かなときの自動（設計§7）

/// 見回り1回分の結末。**返り値はテストのために在る**——ループは使わない。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum 見回りの結果 {
    /// 撃った。
    撃った,
    /// 撃とうとしたが、Windows のタスクを起こせなかった。
    撃てなかった,
    /// 見送った。**記録に残したかどうかも返す**（間引きが効いているかを見るため）。
    見送った {
        理由: compact::Blocker,
        記録した: bool,
    },
}

/// 見回り1回分。
///
/// # ループから切り離してある理由
///
/// [`tokio::spawn`] の中へ直に書くと、**時計も間隔も偽装できず1行も確かめられない**。
/// `now` を引数で受けるのは、このリポジトリの既存の流儀（`logging.rs::admit`・
/// [`CompactStatus::blocker`]）に合わせたもので、新しい仕組みではない。
///
/// # 順序に意味がある
///
/// [`様子`] は `compact-state.json` から `quiet_since` を読むが、それは**この見回りより
/// 前の値**である。進めた結果を写し直さないと、**静かになった最初の1回だけ判定が
/// 1周分（5分）遅れる。**
///
/// # 通す門は [`CompactStatus::blocker`]（手とは違う）
///
/// 手で押すとき（[`api_run`]）は道連れだけを見るが、**自動は全部見る**——切ってあるか・
/// 一時停止・道連れ・静かさ・時間帯・空洞・間隔。混ぜると「夜でもないのに撃つ」か
/// 「手で押しても夜まで待たされる」のどちらかになる。
pub fn 一回り(state: &CompactApiState, now: SystemTime) -> 見回りの結果 {
    let mut status = 様子(state, server_core::db::LOCAL_ACCOUNT_ID);
    let 元の記憶 = compact::load_state(&state.state_dir);
    let mut remembered = 元の記憶.clone();

    // **静かさを進めるのはここだけ。** これを落とすと `quiet_since` が永久に `None` の
    // ままになり、`blocker()` が必ず `NotQuietLongEnough` を返して**自動は一度も
    // 走らない**。しかも落ちも警告も出ないので、「設定を on にしたのに何も起きない」
    // という形でしか気づけない
    compact::静かさを進める(&mut remembered, status.静かか(), now);
    status.quiet_since = remembered.quiet_since;

    let 結果 = match status.blocker(&state.cfg, now) {
        Some(理由) => {
            let 札 = 理由.理由の名前();
            let 記録した = compact::見送りを残すか(remembered.last_skip.as_ref(), 札, now);
            if 記録した {
                tracing::info!(
                    kind = "compact_skipped",
                    reason = %理由.言い分(),
                    "縮小を見送りました"
                );
                remembered.last_skip = Some(compact::LastSkip {
                    reason: 札.to_string(),
                    at: now,
                });
            }
            見回りの結果::見送った {
                理由, 記録した
            }
        }
        None => 見回りの結果::撃った, // 実際に撃つのは下（**覚えていることを先に残す**）
    };

    // **撃つ前に書く。** 撃つと機械が落ちるので、後回しにすると静かさも見送りの記録も
    // 失われる。**変わっていなければ書かない**——5分ごとに無条件で書くと1日 288 回に
    // なる（`CompactState` は `PartialEq` を導出しているので比べられる）
    if remembered != 元の記憶 {
        compact::save_state(&state.state_dir, &remembered);
    }

    if 結果 == 見回りの結果::撃った {
        return match 記録して撃つ(state, &status, "auto", now) {
            compact::FireResult::Fired => 見回りの結果::撃った,
            compact::FireResult::Failed => {
                tracing::warn!(
                    kind = "compact_failed",
                    reason = "タスクを起こせなかった",
                    "自動の縮小を撃てませんでした"
                );
                見回りの結果::撃てなかった
            }
        };
    }
    結果
}

/// 静かなときに縮小を打つ見回り（設計§7）。**ローカルモードだけで生やす。**
///
/// # 口とは違って、両モードには置かない
///
/// 口（[`routes`]）はサーバモードにも生やしてある（断る道そのものを台帳へ載せるため）。
/// **見回りはそうしない**——縮小は機械に効く操作で、サーバは機械を持たない。
/// 「口が両方に在るから見回りも両方」と読まないこと。
///
/// # `interval` ではなく `sleep` を使う
///
/// [`tokio::time::interval`] は遅れを取り戻そうとして**溜まった分を続けて撃つ**。
/// 見回りが重なると同じ時刻で判定が何度も走る。`sleep` なら必ず間隔が空く。
/// `watch_updates` も同じ形である。
pub async fn watch_compact(state: CompactApiState) {
    /// 見回りの間隔。**静かさの判定がこの刻みになる**ので、`quiet_minutes` に対して
    /// 最大でこの長さの誤差が出る。**誤差は「遅れる」側**なので安全側に倒れる。
    const POLL: Duration = Duration::from_secs(300);

    if state.cfg.ext4_vhdx.is_none() {
        // **打てる手が無いことを出し続けない**（`watch_updates` と同じ作法）。空洞が
        // 測れない機械では永久に打てないので、理由を1行だけ残して降りる
        tracing::info!("縮小の自動は動きません: 仮想ディスクの場所が設定されていません");
        return;
    }
    // **`auto` が `false` でも降りない。** 設定は動かしうるので、見回りは続ける
    loop {
        一回り(&state, SystemTime::now());
        tokio::time::sleep(POLL).await;
    }
}
