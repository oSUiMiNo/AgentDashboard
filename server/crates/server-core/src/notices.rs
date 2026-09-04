//! アプリ全体の知らせの REST の口（トーストとベル設計§6-1）。
//!
//! # まず全体を取り、以後は差分だけを見る
//!
//! `/api/sessions` と同じ原則。ブラウザは開いたときにここで一覧と未読数を取り、
//! あとは WebSocket の [`ServerMessage::NoticeCreated`] を見る。**1件届くたびに
//! 数え直させない**ために、プッシュ側も未読数を同梱している。
//!
//! # 絞りは `Identity` から取る
//!
//! `projects` と同じ「フラットな DB リソース」。カードのような所有権チェックは要らず、
//! **`db::notices` の全関数が `account_id` を第1引数に取る**ことで守っている。

use crate::{auth::Identity, db, registry::notice_view, ws::AppState};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use protocol::ws::{NoticeView, ServerMessage};
use uuid::Uuid;

/// `GET /api/notices` の絞り込み。
#[derive(Debug, Default, serde::Deserialize)]
pub struct ListQuery {
    /// この時刻より古いものから返す（続きを読むときに前のページの最後を渡す）。
    pub before: Option<i64>,
    /// 1ページの件数。**上限を超えたら切る**（`db::notices::MAX_PAGE_LIMIT`）。
    pub limit: Option<u64>,
}

/// `GET /api/notices` の応答。
///
/// `Deserialize` も持つのは、CLI（`agentdashboard notice ls`）が同じ型で読み戻すため
/// （CLI設計§6-3——CLI 側に写しの型を作らない）。
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct NoticePage {
    pub notices: Vec<NoticeView>,
    /// さらに古いものがあるか。
    pub has_more: bool,
    /// **いまの未読数。** バッジはこれで出す。
    pub unread_count: u32,
}

/// `POST /api/notices/read` の応答。
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ReadResponse {
    /// 印を付けた件数。
    pub marked: u64,
    /// 既読にした時刻。
    pub read_at: i64,
    /// **必ず 0 になる**（全件を既読にするため）。画面が数え直さずに済むよう返す。
    pub unread_count: u32,
}

/// `GET /api/notices` — このアカウントの知らせを新しい順に。
pub async fn api_list(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Query(query): Query<ListQuery>,
) -> Result<Json<NoticePage>, (StatusCode, String)> {
    let db = state.registry.db();
    let limit = query.limit.unwrap_or(db::notices::DEFAULT_PAGE_LIMIT);
    let (rows, has_more) = db::notices::list_page(db, identity.account_id, query.before, limit)
        .await
        .map_err(unavailable)?;
    let unread = db::notices::unread_count(db, identity.account_id)
        .await
        .map_err(unavailable)?;
    Ok(Json(NoticePage {
        notices: rows.into_iter().map(notice_view).collect(),
        has_more,
        unread_count: unread as u32,
    }))
}

/// `POST /api/notices/read` — 未読をまとめて既読にする。
///
/// **1件ずつの既読は作らない**（設計§10-3——ベルを開いた瞬間に全部を既読にする）。
/// 結果は他のタブや端末のバッジを揃えるために配る。
pub async fn api_read(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
) -> Result<Json<ReadResponse>, (StatusCode, String)> {
    let db = state.registry.db();
    let read_at = db::now_ms();
    let marked = db::notices::mark_all_read(db, identity.account_id, read_at)
        .await
        .map_err(unavailable)?;

    state.registry.announce_account(
        identity.account_id,
        ServerMessage::NoticeRead {
            read_at,
            unread_count: 0,
        },
    );

    Ok(Json(ReadResponse {
        marked,
        read_at,
        unread_count: 0,
    }))
}

/// `DELETE /api/notices/{id}` — 1件消す。
///
/// **他人のものは消せない**（絞りは `db::notices::remove` が持っている）。無いものを
/// 消そうとしたときと他人のものを消そうとしたときを**言い分けない**——言い分けると、
/// IDを総当たりして他人の知らせの存在を調べられる（`projects` と同じ判断）。
pub async fn api_remove(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let removed = db::notices::remove(state.registry.db(), identity.account_id, id)
        .await
        .map_err(unavailable)?;
    if removed == 0 {
        return Err((StatusCode::NOT_FOUND, "その知らせはありません".to_string()));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/notices` — 全部消す。
pub async fn api_clear(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
) -> Result<StatusCode, (StatusCode, String)> {
    db::notices::clear(state.registry.db(), identity.account_id)
        .await
        .map_err(unavailable)?;
    Ok(StatusCode::NO_CONTENT)
}

/// 記録が読めないときの断り。**`projects` と同じ状態コードに揃える。**
fn unavailable(err: sea_orm::DbErr) -> (StatusCode, String) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        format!("記録を読めませんでした: {err}"),
    )
}
