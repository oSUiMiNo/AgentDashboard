//! 利用者の PC のフォルダとファイルを引く REST の口（イシューグループ_2026_0805_0514 設計§10）。
//!
//! # なぜ WebSocket ではないのか
//!
//! あちらは「起きたことを配る線」で、これは「聞いて答える線」である。性質の違うものを
//! 1本に混ぜると、片方の遅れがもう片方を引きずる（セルフホスト化フェーズ6 で実際に踏んだ）。
//! 履歴のページングが既に REST なので、並びも揃う。
//!
//! # 断り方を1か所に集める
//!
//! 状態コードの写しは [`status_of`] だけが持つ。経路ごとに書くと、**同じ失敗が口に
//! よって違うコードになる**——利用者から見ると「たまに動く」になり、原因へ辿れない。

use crate::{
    auth::Identity,
    session_host::{HostFsError, HostFsRequest},
    ws::AppState,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use protocol::{
    AgentId,
    a2s::HostFailure,
    fs::{DirListing, FileContent},
};

/// ローカルモードの `{host}`。
///
/// `SettingsView.model_tables` のキーが既にこの綴りを使っているので揃える（設計§10）。
pub const LOCAL_HOST: &str = "local";

/// `?path=…`。**フォルダの一覧では省略できる**（省略＝その PC のホーム。設計§26-2）。
#[derive(Debug, serde::Deserialize)]
pub struct DirQuery {
    pub path: Option<String>,
}

/// `?path=…`。中身の読み取りには「始まり」が無いので**必須**。
#[derive(Debug, serde::Deserialize)]
pub struct PathQuery {
    pub path: String,
}

/// `GET /api/hosts/{host}/dir?path=…`
pub async fn api_dir(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(host): Path<String>,
    Query(query): Query<DirQuery>,
) -> Result<Json<DirListing>, (StatusCode, String)> {
    let target = parse_host(&host)?;
    state
        .agent
        .list_dir(
            HostFsRequest {
                account_id: identity.account_id,
                target,
            },
            query.path.as_deref(),
        )
        .await
        .map(Json)
        .map_err(refuse)
}

/// `GET /api/hosts/{host}/file?path=…`
pub async fn api_file(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(host): Path<String>,
    Query(query): Query<PathQuery>,
) -> Result<Json<FileContent>, (StatusCode, String)> {
    let target = parse_host(&host)?;
    state
        .agent
        .read_file(
            HostFsRequest {
                account_id: identity.account_id,
                target,
            },
            &query.path,
        )
        .await
        .map(Json)
        .map_err(refuse)
}

/// `{host}` を宛先へ。**読めない綴りは「知らない PC」と同じ扱い**（設計§18）。
///
/// 言い分けると、綴りを変えながら叩いて何かを探れる余地ができる。
///
/// 枠の口（[`crate::projects`]）も同じ綴りを受けるので、**ここから借りる**。
/// 写しを持たせると、`LOCAL_HOST` の綴りを変えたときに片方だけ直る。
pub(crate) fn parse_host(host: &str) -> Result<Option<AgentId>, (StatusCode, String)> {
    if host == LOCAL_HOST {
        return Ok(None);
    }
    match host.parse::<uuid::Uuid>() {
        Ok(id) => Ok(Some(AgentId(id))),
        Err(_) => Err(refuse(HostFsError::UnknownHost)),
    }
}

pub(crate) fn refuse(err: HostFsError) -> (StatusCode, String) {
    (status_of(&err), err.message())
}

/// 断る理由を状態コードへ写す（設計§10）。
///
/// **ローカルとリモートで同じ写し方になる。** 境界が返すのは同じ型なので、
/// 構成によってコードが変わることがない（フェーズ1 の引き継ぎで心配していた点）。
pub fn status_of(err: &HostFsError) -> StatusCode {
    match err {
        // 他人の PC・知らない PC・繋がっていない PC を**言い分けない**
        HostFsError::UnknownHost => StatusCode::NOT_FOUND,
        // 「できない」ではなく「いまのこの相手ではできない」——更新すれば変わる
        HostFsError::Unsupported => StatusCode::CONFLICT,
        HostFsError::Timeout => StatusCode::GATEWAY_TIMEOUT,
        HostFsError::Unreachable(_) => StatusCode::SERVICE_UNAVAILABLE,
        HostFsError::Failed { reason, .. } => match reason {
            HostFailure::NotFound => StatusCode::NOT_FOUND,
            HostFailure::Denied => StatusCode::FORBIDDEN,
            // 「フォルダを頼んだらファイルだった」も、その名前では見つからないのと同じ
            HostFailure::NotDirectory => StatusCode::NOT_FOUND,
            HostFailure::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            // 設計§10 の表には無い5つ目。テキストとして扱えない、が最も近い
            HostFailure::Unsupported => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        },
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 断る理由はすべて別の状態コードへ写る() {
        // **まとめて500にしない。** 利用者が直せるもの（権限・パス・版）が、
        // 直せないもの（サーバの不調）と同じ顔になると、直しようが無くなる
        assert_eq!(status_of(&HostFsError::UnknownHost), StatusCode::NOT_FOUND);
        assert_eq!(status_of(&HostFsError::Unsupported), StatusCode::CONFLICT);
        assert_eq!(
            status_of(&HostFsError::Timeout),
            StatusCode::GATEWAY_TIMEOUT
        );
        assert_eq!(
            status_of(&HostFsError::Unreachable("届きません".to_string())),
            StatusCode::SERVICE_UNAVAILABLE
        );

        let failed = |reason| HostFsError::Failed {
            reason,
            detail: String::new(),
        };
        assert_eq!(
            status_of(&failed(HostFailure::Denied)),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status_of(&failed(HostFailure::TooLarge)),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            status_of(&failed(HostFailure::NotFound)),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn 読めない宛先は知らないpcと同じ言葉で断る() {
        // 綴りを変えながら叩いて存在を探れないこと（設計§18）
        let (code, message) = parse_host("これはUUIDではない").expect_err("断ること");
        assert_eq!(code, StatusCode::NOT_FOUND);
        assert_eq!(message, HostFsError::UnknownHost.message());
    }

    #[test]
    fn localは宛先なしとして読む() {
        assert_eq!(parse_host(LOCAL_HOST).expect("通ること"), None);
    }
}
