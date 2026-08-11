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

use crate::gateway::Capabilities;
use crate::{
    auth::Identity,
    db::{self, entity, pairing},
    gateway::SessionHostHub,
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

pub fn routes(hub: Arc<SessionHostHub>) -> Router {
    Router::new()
        .route("/api/account/tokens", get(list_tokens).post(issue_token))
        .route(
            "/api/account/tokens/{token_id}",
            axum::routing::delete(revoke_token),
        )
        .route("/api/account/agents", get(list_agents))
        .with_state(hub)
}

/// `kind` が欠けている応答（0.1.12 以前のサーバ）の読み方。
fn kind_agent() -> String {
    pairing::TokenKind::Agent.as_str().to_string()
}

/// 発行済みトークンの1件（**平文は含まない**）。
///
/// `Deserialize` は CLI のため（CLI設計§6-3）——`account tokens` が同じ型で読み戻す。
/// CLI 側に写しの型を作らない。
#[derive(Debug, Serialize, Deserialize)]
pub struct TokenView {
    pub id: Uuid,
    /// どの PC 用かを見分けるための札
    pub label: String,
    /// 札の用途（CLI設計§5-3）。`"agent"` か `"cli"`。画面はこれで
    /// 「これは PC ではない」を出し分ける——分けないと、CLI の札が
    /// 「繋いでこない PC」としてアカウント画面に並び続ける。
    ///
    /// **既定を持たせているのは CLI のため。** この型は CLI が応答を読むのにも使う
    /// ので、`kind` を知らない版のサーバ（0.1.12 以前）を相手にすると
    /// 「応答の形を読めません」で落ちる。用途が生まれる前の札は全部 PC 用なので、
    /// 欠けていたら `agent` と読むのが実態に合う。
    #[serde(default = "kind_agent")]
    pub kind: String,
    pub created_at: i64,
    /// 一度でも繋がったか。**繋がっていないトークンは貼り忘れの可能性がある**
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

/// 登録済みの PC の1件（設計§11-1）。`Deserialize` は CLI のため（CLI設計§6-3）。
#[derive(Debug, Serialize, Deserialize)]
pub struct SessionHostView {
    pub id: Uuid,
    pub name: String,
    pub last_seen_at: Option<i64>,
    /// **いま繋がっているか。** DB には持たない（落ちた瞬間の値が残るため。§3-2）ので、
    /// 接続の集まりから都度かぶせる
    pub connected: bool,
    /// その PC のセッションホストの版（CICD設計§16）。名乗っていなければ `None`。
    ///
    /// 見せるのは、**危ない組み合わせに気づけるようにする**ため。サーバのほうが古いと、
    /// 必須の項目が1つ増えるだけで報告全体が解けなくなり、カードが1枚も出なくなる。
    pub version: Option<String>,
}

async fn list_tokens(
    State(hub): State<Arc<SessionHostHub>>,
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
                kind: row.kind,
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
    /// 札の用途（CLI設計§5-5）。省略は `agent`——画面の発行ボタンは PC を繋ぐ
    /// ためのもので、既存の動きを変えない。CLI の札は `"cli"` を明示して頼む
    pub kind: Option<String>,
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
    State(hub): State<Arc<SessionHostHub>>,
    Extension(identity): Extension<Identity>,
    Json(request): Json<IssueRequest>,
) -> Result<Json<IssuedToken>, (StatusCode, String)> {
    let label = request.label.trim();
    let kind = match request.kind.as_deref() {
        None => pairing::TokenKind::Agent,
        Some(value) => pairing::TokenKind::parse(value).ok_or((
            StatusCode::BAD_REQUEST,
            "kind は agent か cli です".to_string(),
        ))?,
    };
    let token = pairing::issue_token(hub.db(), identity.account_id, label, kind)
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
            kind: row.kind,
            created_at: row.created_at,
            last_used_at: row.last_used_at,
            revoked_at: row.revoked_at,
        },
        token,
    }))
}

async fn revoke_token(
    State(hub): State<Arc<SessionHostHub>>,
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
    // **立ててから畳む。** 逆にすると、畳んだ直後に繋ぎ直された接続がまだ通ってしまう。
    // PC の接続（/agent/ws）とブラウザ側の口（/ws。cli 札の follow 等）の両方を畳む
    hub.disconnect_token(token_id);
    hub.registry().broadcast_revocation(token_id);
    Ok(StatusCode::NO_CONTENT)
}

async fn list_agents(
    State(hub): State<Arc<SessionHostHub>>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<Vec<SessionHostView>>, (StatusCode, String)> {
    Ok(Json(agents_of(&hub, identity.account_id).await?))
}

/// そのアカウントの PC を、接続状態つきで集める。
///
/// `/api/settings` も同じものを返す（PC 名バッジの引き先。§11-2）ので、組み立てを
/// 1箇所に置いてある——2つの口が別々に作ると、名前の出どころが2つになる。
pub async fn agents_of(
    hub: &Arc<SessionHostHub>,
    account_id: Uuid,
) -> Result<Vec<SessionHostView>, (StatusCode, String)> {
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
        .map(|row| SessionHostView {
            connected: connected.contains(&row.id),
            // 名乗りは**この行と一緒に引けている**ので、聞き直さない（CICD設計§16）
            version: row
                .capabilities
                .clone()
                .and_then(|value| serde_json::from_value::<Capabilities>(value).ok())
                .and_then(|capabilities| capabilities.agent_version),
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
pub fn no_agents() -> Vec<SessionHostView> {
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

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 用途の無い応答は_PC_用の札として読める() {
        // この型は CLI が応答を読むのにも使う（CLI設計§6-3）。用途（kind）が生まれる
        // 前のサーバ（0.1.12 以前）を相手にしたとき、欠けているだけで
        // 「応答の形を読めません」で落ちてはいけない（コードレビュー対応5）。
        // 用途が無かった頃の札は全部 PC 用なので、agent と読むのが実態に合う
        let 昔の応答 = r#"{"id":"11111111-1111-4111-8111-111111111111","label":"ふるいPC","created_at":1,"last_used_at":null,"revoked_at":null}"#;
        let view: TokenView = serde_json::from_str(昔の応答).expect("読めること");
        assert_eq!(view.kind, "agent");

        // いまの応答はそのまま読む
        let いまの応答 = r#"{"id":"11111111-1111-4111-8111-111111111111","label":"CLI","kind":"cli","created_at":1,"last_used_at":null,"revoked_at":null}"#;
        let view: TokenView = serde_json::from_str(いまの応答).expect("読めること");
        assert_eq!(view.kind, "cli");
    }
}
