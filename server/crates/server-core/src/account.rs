//! アカウント画面が読み書きするもの（セルフホスト化設計§8-4・§11-1）。
//!
//! 扱うのは2つだけ——**PC を繋ぐための鍵**（ペアリングトークン）と、**繋がった PC の
//! 一覧**。どちらもログイン中のアカウントのぶんに閉じている（§8-6 の REST の行）。
//!
//! # 平文は発行の1回だけ
//!
//! DB にはハッシュしか置かないので、後から見せ直す手段がそもそも無い。控え損ねたら
//! 作り直してもらうほうが安全なので、**「もう一度見る」口は作らない**。
//!
//! # 失効は接続中にも効かせる
//!
//! `revoked_at` を立てるだけだと、既に繋がっている PC は次に切れるまで繋がり続ける。
//! それでは「外した」と言えないので、立てた直後にその接続を畳む（§8-4）。

use crate::{
    auth::Identity,
    db::{self, entity, pairing},
    gateway::AgentHub,
};
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::get,
};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

pub fn routes(hub: Arc<AgentHub>) -> Router {
    Router::new()
        .route("/api/account/tokens", get(list_tokens).post(issue_token))
        .route(
            "/api/account/tokens/{token_id}",
            axum::routing::delete(revoke_token),
        )
        .route("/api/account/agents", get(list_agents))
        .with_state(hub)
}

/// 発行済みトークンの1件（**平文は含まない**）。
#[derive(Debug, Serialize)]
pub struct TokenView {
    pub id: Uuid,
    /// どの PC 用かを見分けるための札
    pub label: String,
    pub created_at: i64,
    /// 一度でも繋がったか。**繋がっていないトークンは貼り忘れの可能性がある**
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

/// 登録済みの PC の1件（設計§11-1）。
#[derive(Debug, Serialize)]
pub struct AgentView {
    pub id: Uuid,
    pub name: String,
    pub last_seen_at: Option<i64>,
    /// **いま繋がっているか。** DB には持たない（落ちた瞬間の値が残るため。§3-2）ので、
    /// 接続の集まりから都度かぶせる
    pub connected: bool,
}

async fn list_tokens(
    State(hub): State<Arc<AgentHub>>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<Vec<TokenView>>, (StatusCode, String)> {
    let rows = entity::pairing_tokens::Entity::find()
        .filter(entity::pairing_tokens::Column::AccountId.eq(identity.account_id))
        .order_by_asc(entity::pairing_tokens::Column::CreatedAt)
        .all(hub.db())
        .await
        .map_err(unavailable)?;

    Ok(Json(
        rows.into_iter()
            .map(|row| TokenView {
                id: row.id,
                label: row.label,
                created_at: row.created_at,
                last_used_at: row.last_used_at,
                revoked_at: row.revoked_at,
            })
            .collect(),
    ))
}

/// `POST /api/account/tokens` の本文。
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct IssueRequest {
    pub label: String,
}

/// 発行の応答。**`token` がここにしか出てこない。**
#[derive(Debug, Serialize)]
pub struct IssuedToken {
    #[serde(flatten)]
    pub view: TokenView,
    /// 平文。画面はこれを1回だけ見せる
    pub token: String,
}

async fn issue_token(
    State(hub): State<Arc<AgentHub>>,
    Extension(identity): Extension<Identity>,
    Json(request): Json<IssueRequest>,
) -> Result<Json<IssuedToken>, (StatusCode, String)> {
    let label = request.label.trim();
    let token = pairing::issue_token(hub.db(), identity.account_id, label)
        .await
        .map_err(unavailable)?;

    // 発行したばかりの行を引き直す。**時刻や ID をこちらで組み立て直さない**——
    // 画面に出る値と DB の値が食い違うと、消したい行を名指しできなくなる
    let row = entity::pairing_tokens::Entity::find()
        .filter(entity::pairing_tokens::Column::TokenHash.eq(pairing::token_hash(&token)))
        .one(hub.db())
        .await
        .map_err(unavailable)?
        .ok_or_else(|| unavailable("発行した行が見つかりません"))?;

    Ok(Json(IssuedToken {
        view: TokenView {
            id: row.id,
            label: row.label,
            created_at: row.created_at,
            last_used_at: row.last_used_at,
            revoked_at: row.revoked_at,
        },
        token,
    }))
}

async fn revoke_token(
    State(hub): State<Arc<AgentHub>>,
    Extension(identity): Extension<Identity>,
    Path(token_id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    // **持ち主を確かめてから失効させる**（§8-6）。他人のトークンのIDを名指しして
    // 消せると、繋がっている PC を外部から落とせることになる
    let owned = entity::pairing_tokens::Entity::find_by_id(token_id)
        .filter(entity::pairing_tokens::Column::AccountId.eq(identity.account_id))
        .one(hub.db())
        .await
        .map_err(unavailable)?;
    if owned.is_none() {
        // 他人のトークンと知らないトークンを呼び分けない
        return Err((
            StatusCode::NOT_FOUND,
            "トークンが見つかりません".to_string(),
        ));
    }

    pairing::revoke_token(hub.db(), token_id)
        .await
        .map_err(unavailable)?;
    // **立ててから畳む。** 逆にすると、畳んだ直後に繋ぎ直された接続がまだ通ってしまう
    hub.disconnect_token(token_id);
    Ok(StatusCode::NO_CONTENT)
}

async fn list_agents(
    State(hub): State<Arc<AgentHub>>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<Vec<AgentView>>, (StatusCode, String)> {
    Ok(Json(agents_of(&hub, identity.account_id).await?))
}

/// そのアカウントの PC を、接続状態つきで集める。
///
/// `/api/settings` も同じものを返す（PC 名バッジの引き先。§11-2）ので、組み立てを
/// 1箇所に置いてある——2つの口が別々に作ると、名前の出どころが2つになる。
pub async fn agents_of(
    hub: &Arc<AgentHub>,
    account_id: Uuid,
) -> Result<Vec<AgentView>, (StatusCode, String)> {
    let rows = entity::agents::Entity::find()
        .filter(entity::agents::Column::AccountId.eq(account_id))
        .order_by_asc(entity::agents::Column::CreatedAt)
        .all(hub.db())
        .await
        .map_err(unavailable)?;

    // **どこかのインスタンスに繋がっていれば「繋がっている」**（設計§9-4）。
    // 自分の接続表だけを見ると、別のインスタンスに繋いだ PC が一覧で
    // 「切断」に見え、しかも操作は通るという食い違いが出る
    let connected: Vec<Uuid> = hub
        .online_of(account_id)
        .await
        .into_iter()
        .map(|id| id.0)
        .collect();

    Ok(rows
        .into_iter()
        .map(|row| AgentView {
            connected: connected.contains(&row.id),
            id: row.id,
            name: row.name,
            last_seen_at: row.last_seen_at,
        })
        .collect())
}

/// ローカルモードの PC 一覧（＝空）。
///
/// **`agents` の行そのものが無い**（A2S の受け口を持たないので、繋いでくる PC が
/// 存在しない）。空を返すのが正しく、`"local"` を1台として並べたりはしない——
/// 一覧に「この PC」というバッジが出ると、他に PC があるように見える。
pub fn no_agents() -> Vec<AgentView> {
    Vec::new()
}

fn unavailable(err: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!("アカウントの記録を読めません: {err}");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "記録を読めません".to_string(),
    )
}

/// ローカルアカウントかどうか（画面の出し分け用）。
pub fn is_local(account_id: Uuid) -> bool {
    account_id == db::LOCAL_ACCOUNT_ID
}
