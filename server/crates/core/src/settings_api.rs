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
