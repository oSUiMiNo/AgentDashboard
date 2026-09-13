//! 全体メモの画像の口（メモ設計§10-1 の【決着】・§10-2）。
//!
//! # なぜ `hosts.rs` に置かないのか
//!
//! **あちらは PC 単位の口**（`/api/hosts/{host}/…`）だが、**全体メモの画像は
//! アカウントに属する**ので PC を指名しない。混ぜると「どの PC か」を渡す意味の
//! 無い引数が増える。
//!
//! # セッションメモの画像はここを通らない
//!
//! あちらは**その PC の作業に属する**ので、既存の添付（`hosts::api_attachment`）へ
//! 相乗りしたままである。**扱いが違うのは帰属が違うから**であって、要件9（同じ
//! 部品・同じ口）は宛先を引数で受ける形のまま保たれている——**割れるのは保管先だけ。**
//!
//! # 段4（PC 側の掃除）より層が少ない
//!
//! PC を通らないので、**共有境界（`SessionHost`）も A2S も名乗りも通らない**。
//! 記録を読み書きするだけである。

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};

use crate::{auth::Identity, ws::AppState};

/// 一度に掃く量（要件10 の 200MB）。
///
/// **`hosts.rs` の同名の値と揃える。** 揃えるのは、**利用者から見ると「メモの画像が
/// 溢れた」は1つの出来事**だからで、置き場所によって消える量が変わると説明できない。
const SWEEP_BYTES: u64 = 200 * 1024 * 1024;

/// `POST /api/memo-blobs` — 全体メモの画像を1枚置く。
///
/// **媒体型はヘッダから取る。** 中身から推測すると、外したときに嘘の拡張子で置くことに
/// なる（既存の添付と同じ作法）。
///
/// **表に無い種別と大きすぎるものは、書く前に断る。** 断りを言い分けるのは、
/// 利用者が直せるもの（別の形式で撮り直す）まで直せなくならないようにするため。
pub async fn api_put(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Written>, (StatusCode, String)> {
    let media_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if !受ける種別か(&media_type) {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            format!("{media_type} は置けない種別です（png / jpeg / gif / webp）"),
        ));
    }
    let bytes = body.len() as u64;
    if bytes > crate::db::memo_blobs::MAX_BLOB_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "画像が大きすぎます（{bytes} バイト。上限は {} バイト）",
                crate::db::memo_blobs::MAX_BLOB_BYTES
            ),
        ));
    }

    let id = crate::db::memo_blobs::put(
        state.registry.db(),
        identity.account_id,
        &media_type,
        body.to_vec(),
        crate::db::now_ms(),
    )
    .await
    .map_err(|err| {
        tracing::error!("メモの画像を置けません: {err}");
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "画像を置けませんでした".to_string(),
        )
    })?;

    Ok(Json(Written {
        // **本文へ入るのは読める URL である。** 記録の中の ID を直に入れると、
        // 貼った側が組み立て方を知っていなければならなくなる
        url: format!("/api/memo-blobs/{id}"),
        media_type,
        bytes,
    }))
}

/// その媒体型を受けるか。
///
/// # なぜ切り出したのか
///
/// **口を立てないと確かめられない形にしない。** ここが素通しになっても
/// 型は通り画面も動くので、**機械は何も言わない**——`svg` が片方だけ通る形は、
/// このリポジトリが繰り返し警告しているものである。
///
/// **既存の添付とまったく同じ表を見る**（`protocol::fs` の対応表）。ここで別の判定を
/// 書くと、**入力欄では断られるのにメモには置ける**という食い違いが生まれる。
fn 受ける種別か(media_type: &str) -> bool {
    protocol::fs::attachment_extension_for(media_type).is_some()
}

/// 置いた1枚の在り処。
#[derive(Debug, serde::Serialize)]
pub struct Written {
    /// **本文の Markdown へそのまま入る URL。**
    pub url: String,
    pub media_type: String,
    pub bytes: u64,
}

/// `GET /api/memo-blobs/{id}` — 全体メモの画像を1枚読む。
///
/// **他人のものは引けない**——記録の側でも `account` で絞っている（§8-6 の二重の鍵）。
/// 口だけで守ると、口を1つ足したときに素通しの経路が生まれる。
pub async fn api_get(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    let id = id
        .parse::<uuid::Uuid>()
        .map_err(|_| (StatusCode::BAD_REQUEST, "画像のIDが読めません".to_string()))?;

    let row = crate::db::memo_blobs::get(state.registry.db(), identity.account_id, id)
        .await
        .map_err(|err| {
            tracing::error!("メモの画像を引けません: {err}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "画像を読めませんでした".to_string(),
            )
        })?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "画像が見つかりません".to_string()))?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, row.media_type)],
        row.data,
    )
        .into_response())
}

/// `POST /api/memo-blobs/sweep` — 掃く／下見する（メモ設計§10-2）。
///
/// **`hosts.rs::api_attachment_sweep` の鏡。** 下見と本番を同じ口にしてあるのも、
/// 既定が下見なのも同じ理由である——**同意の画面に出した数のとおりに消えること**が
/// 同意の意味そのものなので、口を分けると片方だけ直せてしまう。
pub async fn api_sweep(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Query(query): Query<SweepQuery>,
) -> Result<Json<protocol::AttachmentSweep>, (StatusCode, String)> {
    let limits = crate::db::settings::memo_limits(state.registry.db(), identity.account_id)
        .await
        .unwrap_or_default();
    crate::db::memo_blobs::survey_or_sweep(
        state.registry.db(),
        identity.account_id,
        crate::db::now_ms(),
        limits.retention_days,
        limits.max_bytes,
        SWEEP_BYTES,
        query.apply,
    )
    .await
    .map(Json)
    .map_err(|err| {
        tracing::error!("メモの画像を掃けません: {err}");
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "画像を掃けませんでした".to_string(),
        )
    })
}

/// 掃除の下見か本番か。**既定は下見**（`hosts.rs` と同じ理由）。
#[derive(serde::Deserialize)]
pub struct SweepQuery {
    #[serde(default)]
    pub apply: bool,
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 受ける種別は既存の添付と同じ顔ぶれである() {
        // **要件9（同じ部品・同じ口）。** 割れるのは保管先だけで、ふるいは同じ
        for ok in ["image/png", "image/jpeg", "image/gif", "image/webp"] {
            assert!(受ける種別か(ok), "{ok} を断った");
        }
    }

    #[test]
    fn svgは断る() {
        // **意図的に除外されている**（claude 側の貼り付け処理が拾わないため）。
        // ここが通ると、**入力欄では断られるのにメモには置ける**形になる
        assert!(!受ける種別か("image/svg+xml"));
    }

    #[test]
    fn 画像でないものは断る() {
        for ng in ["text/plain", "text/markdown", "application/pdf", ""] {
            assert!(!受ける種別か(ng), "{ng} を通した");
        }
    }
}
