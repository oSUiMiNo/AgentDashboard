//! 画面が読み書きする設定の REST（設計§7）。
//!
//! # なぜ server-core ではなくここにあるのか
//!
//! 応答（[`SettingsView`]）の中身は、**PC 側にしか無いもの**でできている——`config.toml` の
//! トグル、起動している CLI が受け付ける権限モード、その CLI 由来のモデル対応表
//! （セルフホスト化設計§13-4）。サーバ側の crate へ持っていくには、これらの型を
//! 共有境界（`protocol`）へ移すことになる。
//!
//! ところが §13-4 は、この応答を**エージェントごとの表を束ねた形**（`model_tables`）へ
//! 作り替えると決めている。いま形を変える前提の型を共有境界へ移すのは、**2回移すこと**に
//! なるので、フェーズ1 では両者を束ねるこの層に置いておく。
//!
//! 口（`GET`/`PUT /api/settings`）も応答の JSON も、移設の前後で変わっていない。

use agent_core::{
    session::SessionManager,
    settings::{SettingsStore, SettingsView},
};
use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Clone)]
pub struct SettingsState {
    /// 画面から書き換えられる設定の持ち主。**居なくても動く**ので、統合テストは
    /// 設定画面を立てずにセッションの検証だけができる。
    pub store: Option<Arc<SettingsStore>>,
    /// 別名の実測は [`SessionManager`] が持っているので、応答を作るときに引く。
    pub manager: Arc<SessionManager>,
}

pub fn routes(state: SettingsState) -> Router {
    Router::new()
        // 設定は接続のたびに流すほど変わらないので、WebSocket ではなく REST に置く
        .route("/api/settings", get(api_settings).put(api_update_settings))
        .with_state(state)
}

/// サーバモードの設定（セルフホスト化設計§13-4・§21 読み替え1）。
///
/// # 材料が PC 側にしか無い
///
/// 応答の中身——受け付ける権限モード・トグル・モデルの表——は、**起動している CLI が
/// ある場所**にしか無い。サーバモードにはローカルの CLI が居ないので、繋がっている PC が
/// 名乗ったもの（Hello）と、保存してある表（`agents.model_table`）から組み立てる。
///
/// 書き換え（`PUT`）はここでは受けない。トグルの持ち主はエージェントの `agent.toml` で、
/// **サーバから書き戻す口はまだ無い**（アカウント単位化は §16-2 の持ち越し）。
pub fn server_routes(hub: Arc<server_core::gateway::AgentHub>) -> Router {
    Router::new()
        .route("/api/settings", get(api_server_settings))
        .with_state(hub)
}

async fn api_server_settings(
    State(hub): State<Arc<server_core::gateway::AgentHub>>,
) -> Json<SettingsView> {
    let connected = hub.connected();

    // **受け付けるモードは合併する。** PC ごとに CLI の版が違えば選択肢も違うので、
    // どれか1台に揃えると他の PC で選べないモードが消える。選んだモードが通るかは
    // 送った先の PC が決める（通らなければ `Error` が返る）
    let mut available_modes: Vec<protocol::PermissionMode> = Vec::new();
    for conn in &connected {
        for mode in &conn.available_modes {
            if !available_modes.contains(mode) {
                available_modes.push(mode.clone());
            }
        }
    }

    let mut model_tables = std::collections::BTreeMap::new();
    for conn in &connected {
        let tables = server_core::db::pairing::model_tables(hub.db(), conn.account_id)
            .await
            .unwrap_or_default();
        for (agent_id, table) in tables {
            model_tables.insert(agent_id.to_string(), table);
        }
    }

    // いま効いている画面の更新間隔（§11-3）。**繋がっている PC のアカウントから引く**——
    // 誰も繋がっていなければ出しようがないので既定を返す
    let account_id = connected.first().map(|conn| conn.account_id);
    let screen_interval_ms = match account_id {
        Some(account_id) => {
            server_core::db::settings::intervals(hub.db(), account_id)
                .await
                .unwrap_or_default()
                .screen_interval_ms
        }
        None => server_core::db::settings::Intervals::default().screen_interval_ms,
    };

    Json(SettingsView {
        // 起動ボタンの数を決めるトグル。**PC ごとの設定**なので、1台でも
        // 「スキップだけ出す」なら画面もそれに従う（迷う組み合わせは PC 選択が
        // 入るフェーズ5 で整理する）
        always_bypass_permissions: connected.iter().any(|conn| conn.always_bypass_permissions),
        available_modes,
        // フラットな2つは**ローカルモードのための互換**。リモートの表は下の map にある
        model_aliases: Vec::new(),
        model_catalog: Vec::new(),
        model_tables,
        screen_interval_ms: Some(screen_interval_ms),
    })
}

/// `PUT /api/settings` の本文。
#[derive(Debug, Deserialize)]
pub struct SettingsUpdate {
    pub always_bypass_permissions: bool,
}

/// `GET /api/settings` — 画面が読む設定（設計§7・§8）。
///
/// 起動ボタンの数と切替UIの選択肢がこれで決まる。**保存先がサーバなので、別のタブで
/// 開いても同じ値になる。**
pub async fn api_settings(
    State(state): State<SettingsState>,
) -> Result<Json<SettingsView>, StatusCode> {
    let settings = state.store.as_ref().ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(settings.view_with(state.manager.aliases().all())))
}

/// `PUT /api/settings` — トグルを書き換えて `config.toml` へ書き戻す（設計§7）。
pub async fn api_update_settings(
    State(state): State<SettingsState>,
    Json(update): Json<SettingsUpdate>,
) -> Result<Json<SettingsView>, (StatusCode, String)> {
    let settings = state
        .store
        .as_ref()
        .ok_or((StatusCode::NOT_FOUND, "設定を扱えません".to_string()))?;

    // 書き込みはブロッキング。テストのスレッドで待つと自分の応答を自分で待つ形になるので、
    // 専用スレッドへ逃がす（初期実装フェーズ2でテスト一式が固まった件と同じ理由）
    let settings = Arc::clone(settings);
    let value = update.always_bypass_permissions;
    let result = tokio::task::spawn_blocking(move || settings.set_always_bypass_permissions(value))
        .await
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;

    match result {
        Ok(_) => Ok(Json(
            state
                .store
                .as_ref()
                .expect("直前に取り出せている")
                .view_with(state.manager.aliases().all()),
        )),
        // 黙って失敗すると「変えたのに戻る」という追いにくい形になる
        Err(err) => Err((StatusCode::INTERNAL_SERVER_ERROR, format!("{err:#}"))),
    }
}
