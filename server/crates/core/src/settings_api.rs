//! 画面が起動時に読む設定（設計§7・セルフホスト化設計§13-4・§11-2）。
//!
//! # なぜここが応答の形を持つのか
//!
//! 中身は**両側から集まる**——受け付ける権限モードとモデルの表は PC 側、画面から
//! 変える設定は DB（サーバ側）、PC の一覧は接続（サーバ側）。どちらか片方の
//! crate へ置くと、もう片方を参照させることになる。両者を束ねるこの層に置くのが、
//! 依存の向きを増やさない唯一の場所になる（§18 読み替え2 の続き）。
//!
//! # 権限確認スキップの既定は「記録が正、無ければ PC 側」
//!
//! 保存先は他の3項目と同じ DB（持ち出し設計§2）。ただし**行が無い間だけ PC 側が
//! 持っている値を初期値として使う**（同§3）——ローカルは `config.toml`、サーバモードは
//! 名乗り。こうしないと、既に `true` にして使っている利用者の設定が引っ越しで黙って
//! 戻る。**両側を見られるのはこの層だけ**なので、この判断もここに置く。
//!
//! # 画面が起動時に読む口はここ1つ
//!
//! PC 名バッジ（`agent_id` → 名前）の引き先を別の口にすると、一覧の描画が**2つの
//! 応答の到着順に依存する**（名前が後から来ると、一度バッジ無しで描いてから差し替わる）。
//! 起動時に要るものは1つの応答へまとめてある。
//!
//! # フラットなモデル表は落とした
//!
//! §13-4 のとおり `model_tables`（`agent_id` キー、ローカルは `"local"`）へ一本化した。
//! CLI の版は PC ごとに違うので、ModelPicker は**セッションが属する PC の表**を見る。

use agent_core::{session::SessionManager, settings::SettingsStore};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use server_core::{
    account::AgentView,
    auth::{AuthContext, AuthMode, Identity},
    db,
};
use std::{collections::BTreeMap, sync::Arc};

/// `GET /api/settings` の応答。
#[derive(Debug, Serialize)]
pub struct SettingsView {
    /// 起動時の権限モードの既定の選択を「全承認をスキップ」にするか（選択肢は減らない）。
    ///
    /// **どの構成でも画面から変えられる**（持ち出し設計§6）。「変えられるか」を運ぶ欄は
    /// 置かない——区別が無くなったので、真偽を運ぶ意味も無い。
    pub always_bypass_permissions: bool,
    /// その CLI が受け付ける権限モード（正規値）。繋がっている PC ぶんを合併したもの
    pub available_modes: Vec<protocol::PermissionMode>,
    /// PC ごとのモデル表（設計§13-4）。キーは `agent_id`、ローカルは `"local"`
    pub model_tables: BTreeMap<String, serde_json::Value>,
    /// 登録済みの PC（設計§11-1・§11-2）。**PC 名バッジの引き先**
    pub agents: Vec<AgentView>,
    /// 画面から変えられる間隔一式（設計§13-3）
    pub intervals: IntervalsView,
    /// LAN 開放のパスワード（設計§8-3）。**ローカルモードでしか意味を持たない**
    pub lan_password: LanPasswordView,
}

/// 画面から変えられる間隔（設計§13-3）。
#[derive(Debug, Serialize)]
pub struct IntervalsView {
    pub sync_interval_secs: u64,
    pub screen_interval_ms: u64,
    pub scrollback_lines: u64,
}

impl From<db::settings::Intervals> for IntervalsView {
    fn from(intervals: db::settings::Intervals) -> Self {
        Self {
            sync_interval_secs: intervals.sync_interval_secs,
            screen_interval_ms: intervals.screen_interval_ms,
            scrollback_lines: intervals.scrollback_lines,
        }
    }
}

/// LAN 開放のパスワードの状態（設計§8-3）。
#[derive(Debug, Serialize)]
pub struct LanPasswordView {
    /// そもそもこの構成に LAN パスワードがあるか（ローカルモードだけ）
    pub supported: bool,
    /// 登録済みか。**値そのものは返さない**（ハッシュしか持っていない）
    pub configured: bool,
    /// いま変えられるか。**127.0.0.1 からだけ**（§8-3）
    pub editable: bool,
}

#[derive(Clone)]
pub struct SettingsState {
    /// 画面から書き換えられる設定の持ち主。**居なくても動く**ので、統合テストは
    /// 設定画面を立てずにセッションの検証だけができる。
    pub store: Option<Arc<SettingsStore>>,
    /// 別名の実測は [`SessionManager`] が持っているので、応答を作るときに引く。
    pub manager: Arc<SessionManager>,
    /// 入口の鍵（設計§8-1）。LAN パスワードの読み書きと、モードの出し分けに要る
    pub auth: Arc<AuthContext>,
}

pub fn routes(state: SettingsState) -> Router {
    Router::new()
        // 設定は接続のたびに流すほど変わらないので、WebSocket ではなく REST に置く
        .route("/api/settings", get(api_settings).put(api_update_settings))
        // 持ち出し（持ち出し設計§11）。**両モードで同じ形の口を生やす**
        .route("/api/settings/export", get(api_export))
        .route("/api/settings/import", post(api_import))
        .with_state(state)
}

/// サーバモードの設定（設計§13-4・§21 読み替え1）。
///
/// # 材料が PC 側にしか無い
///
/// 権限モードとトグルは、**起動している CLI がある場所**にしか無い。サーバモードには
/// ローカルの CLI が居ないので、繋がっている PC が名乗ったもの（Hello）と、保存して
/// ある表（`agents.model_table`）から組み立てる。
pub fn server_routes(hub: Arc<server_core::gateway::AgentHub>) -> Router {
    Router::new()
        .route(
            "/api/settings",
            get(api_server_settings).put(api_server_update_settings),
        )
        .route("/api/settings/export", get(api_server_export))
        .route("/api/settings/import", post(api_server_import))
        .with_state(hub)
}

async fn api_server_settings(
    State(hub): State<Arc<server_core::gateway::AgentHub>>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<SettingsView>, (StatusCode, String)> {
    // 名乗った中身は DB にある（`agents.capabilities`）。**接続表ではなく保存を見る**
    // のは、ブラウザが繋がったインスタンスにその PC が居ないことがあるため（設計§9-2）。
    // 出すのは**いまどこかに繋がっている PC のぶんだけ**——落ちている PC のモードを
    // 出すと、選んでから「繋がっていません」と断られる
    let online = hub.online_of(identity.account_id).await;
    let capabilities: Vec<server_core::gateway::Capabilities> =
        db::pairing::capabilities_of(hub.db(), identity.account_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|(agent_id, _)| online.contains(agent_id))
            .filter_map(|(_, value)| serde_json::from_value(value).ok())
            .collect();

    // **受け付けるモードは合併する。** PC ごとに CLI の版が違えば選択肢も違うので、
    // どれか1台に揃えると他の PC で選べないモードが消える。選んだモードが通るかは
    // 送った先の PC が決める（通らなければ `Error` が返る）
    let mut available_modes: Vec<protocol::PermissionMode> = Vec::new();
    for capability in &capabilities {
        for mode in &capability.available_modes {
            if !available_modes.contains(mode) {
                available_modes.push(mode.clone());
            }
        }
    }

    // **他のアカウントの PC の表は含めない**（§8-6 の REST の行）
    let mut model_tables = BTreeMap::new();
    for (agent_id, table) in db::pairing::model_tables(hub.db(), identity.account_id)
        .await
        .unwrap_or_default()
    {
        model_tables.insert(agent_id.to_string(), table);
    }

    let intervals = db::settings::intervals(hub.db(), identity.account_id)
        .await
        .unwrap_or_default();

    Ok(Json(SettingsView {
        // 記録が正。**まだ画面から触っていなければ、名乗った値を初期値にする**
        // （持ち出し設計§3）。1台でも「既定はスキップ」なら画面もそれに従う
        always_bypass_permissions: db::settings::always_bypass_or(
            hub.db(),
            identity.account_id,
            capabilities
                .iter()
                .any(|capability| capability.always_bypass_permissions),
        )
        .await,
        available_modes,
        model_tables,
        agents: server_core::account::agents_of(&hub, identity.account_id).await?,
        intervals: intervals.into(),
        // セルフホストの鍵はアカウントのほう（§8-3 が LAN の検査から除外している）
        lan_password: LanPasswordView {
            supported: false,
            configured: false,
            editable: false,
        },
    }))
}

/// `PUT /api/settings` の本文。
///
/// **全部が省略できる。** 画面は触った項目だけを送る——1項目のために全部を送り直すと、
/// 別のタブが同時に開いていたときに、そちらの変更を巻き戻すことになる。
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SettingsUpdate {
    pub always_bypass_permissions: Option<bool>,
    /// LAN 開放の共有パスワード（設計§8-3）。**平文で受けてここでハッシュにする。**
    ///
    /// 受け付けるのは**ローカルモードの 127.0.0.1 から**だけ。LAN の向こうから
    /// 変えられると、いま入っている誰かが鍵を掛け替えられることになる。
    pub lan_password: Option<String>,
    pub sync_interval_secs: Option<u64>,
    pub screen_interval_ms: Option<u64>,
    pub scrollback_lines: Option<u64>,
}

impl SettingsUpdate {
    /// 入れてよい値かを確かめる。**ファイルからの読み込みと同じ検査を通す**（持ち出し
    /// 設計§9）。
    ///
    /// 画面は選択肢と入力欄で値を絞っているが、REST は直に叩ける。ここを通さないと
    /// `sync_interval_secs = 0` のような値がそのまま入る。
    fn check(&self) -> Result<(), (StatusCode, String)> {
        for (key, value) in [
            (db::settings::SYNC_INTERVAL_SECS, self.sync_interval_secs),
            (db::settings::SCREEN_INTERVAL_MS, self.screen_interval_ms),
            (db::settings::SCROLLBACK_LINES, self.scrollback_lines),
        ] {
            if let Some(value) = value {
                db::settings::check(key, &serde_json::json!(value))
                    .map_err(|reason| (StatusCode::BAD_REQUEST, reason))?;
            }
        }
        Ok(())
    }

    /// 間隔の指定が1つでもあるか。
    fn touches_intervals(&self) -> bool {
        self.sync_interval_secs.is_some()
            || self.screen_interval_ms.is_some()
            || self.scrollback_lines.is_some()
    }

    /// いまの値へ、指定されたぶんだけ被せる。
    fn merged(&self, current: db::settings::Intervals) -> db::settings::Intervals {
        db::settings::Intervals {
            sync_interval_secs: self
                .sync_interval_secs
                .unwrap_or(current.sync_interval_secs),
            screen_interval_ms: self
                .screen_interval_ms
                .unwrap_or(current.screen_interval_ms),
            scrollback_lines: self.scrollback_lines.unwrap_or(current.scrollback_lines),
        }
    }
}

/// `GET /api/settings` — 画面が読む設定（設計§7・§8）。
///
/// 起動時の既定のモードと切替UIの選択肢がこれで決まる。**保存先がサーバなので、別のタブで
/// 開いても同じ値になる。**
pub async fn api_settings(
    State(state): State<SettingsState>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<SettingsView>, (StatusCode, String)> {
    let store = state
        .store
        .as_ref()
        .ok_or((StatusCode::NOT_FOUND, "設定を扱えません".to_string()))?;
    let intervals = db::settings::intervals(state.auth.db(), identity.account_id)
        .await
        .unwrap_or_default();

    Ok(Json(SettingsView {
        // 記録が正。**まだ画面から触っていなければ `config.toml` の値**（同§3）
        always_bypass_permissions: db::settings::always_bypass_or(
            state.auth.db(),
            identity.account_id,
            store.always_bypass_permissions(),
        )
        .await,
        available_modes: store.available_modes().to_vec(),
        model_tables: store.local_model_tables(&state.manager.aliases().all()),
        // ローカルモードに PC という単位は無い（`"local"` を1台として並べない）
        agents: server_core::account::no_agents(),
        intervals: intervals.into(),
        lan_password: lan_password_view(&state.auth, &identity).await,
    }))
}

/// `PUT /api/settings` — 触った項目だけを書き換える（設計§7・§8-3・§13-3）。
pub async fn api_update_settings(
    State(state): State<SettingsState>,
    Extension(identity): Extension<Identity>,
    Json(update): Json<SettingsUpdate>,
) -> Result<Json<SettingsView>, (StatusCode, String)> {
    update.check()?;

    if let Some(password) = &update.lan_password {
        // **登録できるのは 127.0.0.1 からだけ**（設計§8-3）。LAN の向こうから
        // 変えられると、いま入っている誰かが鍵を掛け替えられる
        if !identity.from_loopback {
            return Err((
                StatusCode::FORBIDDEN,
                "LAN のパスワードは、この PC のブラウザ（127.0.0.1）からのみ変更できます"
                    .to_string(),
            ));
        }
        server_core::auth::set_lan_password(state.auth.db(), password).await?;
    }

    if update.touches_intervals() {
        let current = db::settings::intervals(state.auth.db(), identity.account_id)
            .await
            .unwrap_or_default();
        // ローカルモードには配る相手（PC）が居ないので、保存だけで足りる。
        // 履歴の同期間隔はエージェント側が起動時に読む（§13-3）
        db::settings::put_intervals(state.auth.db(), identity.account_id, update.merged(current))
            .await
            .map_err(|err| {
                tracing::error!("間隔を保存できません: {err}");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "設定を保存できません".to_string(),
                )
            })?;
    }

    if let Some(value) = update.always_bypass_permissions {
        db::settings::set_always_bypass_permissions(state.auth.db(), identity.account_id, value)
            .await
            .map_err(save_failed)?;
    }

    // **設定の持ち主が居なくても、DB のぶんは保存できている。** 居ないことを理由に
    // 404 を返すと、保存されたのに失敗したように見える（統合テストは画面を立てずに
    // セッションだけを確かめることがある）
    if state.store.is_none() {
        let intervals = db::settings::intervals(state.auth.db(), identity.account_id)
            .await
            .unwrap_or_default();
        return Ok(Json(SettingsView {
            always_bypass_permissions: db::settings::always_bypass_or(
                state.auth.db(),
                identity.account_id,
                false,
            )
            .await,
            available_modes: Vec::new(),
            model_tables: BTreeMap::new(),
            agents: server_core::account::no_agents(),
            intervals: intervals.into(),
            lan_password: lan_password_view(&state.auth, &identity).await,
        }));
    }
    api_settings(State(state), Extension(identity)).await
}

/// サーバモードの `PUT /api/settings`（LAN パスワード以外を受ける）。
///
/// LAN パスワードはローカル専用（§8-3）。**受けられないものは受けたふりをしない**
/// ——保存されないのに 200 を返すと、画面には反映されたのに次の再読み込みで戻る。
///
/// **トグルはこちらでも受ける**（持ち出し設計§6）。保存先が記録になったので、
/// ローカルと同じ道で書ける。
async fn api_server_update_settings(
    State(hub): State<Arc<server_core::gateway::AgentHub>>,
    Extension(identity): Extension<Identity>,
    Json(update): Json<SettingsUpdate>,
) -> Result<Json<SettingsView>, (StatusCode, String)> {
    update.check()?;

    if update.lan_password.is_some() {
        return Err((
            StatusCode::FORBIDDEN,
            "LAN のパスワードはローカルモードだけの設定です".to_string(),
        ));
    }

    if update.touches_intervals() {
        let current = db::settings::intervals(hub.db(), identity.account_id)
            .await
            .unwrap_or_default();
        // **保存して、そのアカウントの PC へ即時に配る**（設計§13-3）。次回接続まで
        // 古い間隔で送り続けさせない
        hub.set_intervals(identity.account_id, update.merged(current))
            .await
            .map_err(|err| {
                tracing::error!("間隔を保存できません: {err}");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "設定を保存できません".to_string(),
                )
            })?;
    }

    if let Some(value) = update.always_bypass_permissions {
        db::settings::set_always_bypass_permissions(hub.db(), identity.account_id, value)
            .await
            .map_err(save_failed)?;
    }

    api_server_settings(State(hub), Extension(identity)).await
}

/// `POST /api/settings/import` の応答（持ち出し設計§9）。
///
/// **無視したものを黙って捨てない。** 反映されない項目があることが伝わらないと、
/// 「読み込んだのに効いていない」が説明の付かない現象になる。
#[derive(Debug, Serialize)]
pub struct ImportOutcome {
    pub applied: Vec<String>,
    pub ignored: Vec<String>,
}

/// 書き出しをダウンロードとして返す（持ち出し設計§13）。
///
/// **サーバ側にファイルを作らない。** 置き場所を決める必要が無く、消す責任も生まれない。
fn download(exported: server_core::portable::Exported) -> Result<Response, (StatusCode, String)> {
    let body = serde_json::to_string_pretty(&exported)
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/json"),
            (
                axum::http::header::CONTENT_DISPOSITION,
                "attachment; filename=\"agentdashboard-settings.json\"",
            ),
        ],
        body,
    )
        .into_response())
}

/// `GET /api/settings/export` — ローカルモード。
async fn api_export(
    State(state): State<SettingsState>,
    Extension(identity): Extension<Identity>,
) -> Result<Response, (StatusCode, String)> {
    let intervals = db::settings::intervals(state.auth.db(), identity.account_id)
        .await
        .unwrap_or_default();
    // **画面に出ている値を書き出す**（同§7）。行が無いものは初期値で埋まる
    let always_bypass = db::settings::always_bypass_or(
        state.auth.db(),
        identity.account_id,
        state
            .store
            .as_ref()
            .is_some_and(|store| store.always_bypass_permissions()),
    )
    .await;
    download(server_core::portable::exported(
        intervals,
        always_bypass,
        env!("CARGO_PKG_VERSION"),
    ))
}

/// `POST /api/settings/import` — ローカルモード。
async fn api_import(
    State(state): State<SettingsState>,
    Extension(identity): Extension<Identity>,
    body: String,
) -> Result<Json<ImportOutcome>, (StatusCode, String)> {
    let parsed =
        server_core::portable::parse(&body).map_err(|reason| (StatusCode::BAD_REQUEST, reason))?;

    if parsed.touches_intervals() {
        let current = db::settings::intervals(state.auth.db(), identity.account_id)
            .await
            .unwrap_or_default();
        // **書くのは既存の道**（同§12）。ローカルには配る相手が居ないので保存だけ
        db::settings::put_intervals(
            state.auth.db(),
            identity.account_id,
            parsed.merged_intervals(current),
        )
        .await
        .map_err(save_failed)?;
    }
    if let Some(value) = parsed.always_bypass_permissions() {
        db::settings::set_always_bypass_permissions(state.auth.db(), identity.account_id, value)
            .await
            .map_err(save_failed)?;
    }

    Ok(Json(ImportOutcome {
        applied: parsed.applied(),
        ignored: parsed.ignored().to_vec(),
    }))
}

/// `GET /api/settings/export` — サーバモード。
async fn api_server_export(
    State(hub): State<Arc<server_core::gateway::AgentHub>>,
    Extension(identity): Extension<Identity>,
) -> Result<Response, (StatusCode, String)> {
    let intervals = db::settings::intervals(hub.db(), identity.account_id)
        .await
        .unwrap_or_default();
    let always_bypass = db::settings::always_bypass_or(hub.db(), identity.account_id, false).await;
    download(server_core::portable::exported(
        intervals,
        always_bypass,
        env!("CARGO_PKG_VERSION"),
    ))
}

/// `POST /api/settings/import` — サーバモード。
async fn api_server_import(
    State(hub): State<Arc<server_core::gateway::AgentHub>>,
    Extension(identity): Extension<Identity>,
    body: String,
) -> Result<Json<ImportOutcome>, (StatusCode, String)> {
    let parsed =
        server_core::portable::parse(&body).map_err(|reason| (StatusCode::BAD_REQUEST, reason))?;

    if parsed.touches_intervals() {
        let current = db::settings::intervals(hub.db(), identity.account_id)
            .await
            .unwrap_or_default();
        // **保存して、そのアカウントの PC へ即時に配る**（同§12）。読み込みだけ
        // 別の道を作ると、配り直しがそちらにだけ無いという食い違いが生まれる
        hub.set_intervals(identity.account_id, parsed.merged_intervals(current))
            .await
            .map_err(save_failed)?;
    }
    if let Some(value) = parsed.always_bypass_permissions() {
        db::settings::set_always_bypass_permissions(hub.db(), identity.account_id, value)
            .await
            .map_err(save_failed)?;
    }

    Ok(Json(ImportOutcome {
        applied: parsed.applied(),
        ignored: parsed.ignored().to_vec(),
    }))
}

/// 保存に失敗したときの返し方。
///
/// **黙って失敗すると「変えたのに戻る」**という追いにくい形になるので、必ず断りを返す。
/// 記録の道具の型を書かずに済ませるため、表示できるものなら何でも受ける
/// （`crates/core` は sea-orm を通常依存に持っていない）。
fn save_failed<E: std::fmt::Display>(err: E) -> (StatusCode, String) {
    tracing::error!("設定を保存できません: {err}");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "設定を保存できません".to_string(),
    )
}

async fn lan_password_view(auth: &Arc<AuthContext>, identity: &Identity) -> LanPasswordView {
    // **鍵をかけていない構成にも欄を出す。** ローカルで `bind_addr` を広げるには
    // 先にパスワードが要る（起動時検査。§8-3）ので、広げる前に登録できないと
    // 「広げると起動しない」だけになる
    let supported = matches!(auth.mode, AuthMode::Open | AuthMode::LanPassword);
    LanPasswordView {
        supported,
        configured: supported && server_core::auth::lan_password_set(auth.db()).await,
        editable: supported && identity.from_loopback,
    }
}
