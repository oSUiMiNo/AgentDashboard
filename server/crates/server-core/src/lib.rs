//! ダッシュボードサーバ側のロジック（セルフホスト化設計§2-1）。
//!
//! ブラウザとの WebSocket・REST・web アセットの配信を持つ。**PTY には触らない**のが
//! このクレートの存在理由で、PC 側へは境界 trait（[`session_host::SessionHost`]）越しにしか
//! 触れない。境界が守られていることは `crates/core/tests/dependencies.rs` が機械で検査する。
//!
//! ローカルモードでは [`session_host_core`] と同じプロセスに同居し、境界はプロセス内の直結に
//! なる。セルフホストモードでは同じ境界の向こうが A2S 越しのセッションホストに変わる
//! （設計§2-3）。**どちらのモードでもブラウザから見た口は変わらない。**
//!
//! [`session_host_core`]: https://docs.rs/session-host-core

pub mod account;
pub mod auth;
pub mod branch;
pub mod bus;
pub mod client_logs;
pub mod cluster;
pub mod config;
pub mod db;
pub mod embed;
pub mod gateway;
pub mod hosts;
pub mod lan_address;
pub mod notices;
pub mod portable;
pub mod projects;
pub mod registry;
pub mod session_host;
pub mod transcript;
pub mod ws;

use axum::{
    Router,
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use std::sync::Arc;

/// ブラウザ向けのルート一式。
///
/// 口は2種類だけ。`/ws` が WebSocket、`/api/*` がスナップショットと履歴の遡り。
/// 残りはすべて同梱した web アセットの配信にまわる。
///
/// フックの受信（`/hook/*`・`/model/*`）は**ここには入らない**。宛先はどちらのモードでも
/// セッションホストの 127.0.0.1 で、セルフホストモードでは別プロセスの別ポートになる
/// （セルフホスト化設計§5-3）。合成するのは両者を束ねる側の仕事。
///
/// # 鍵がかかるのは中身のある口だけ
///
/// web アセット（[`static_handler`]）と認証の口（[`auth::routes`]）は素通しにしてある。
/// 画面そのものを 401 にすると「ログイン画面を出す」手段が無くなるし、認証の要否を
/// 知るのに認証が要るという循環もできる。**中身は返さないが、扉は開ける。**
pub fn routes(state: ws::AppState, auth: Arc<auth::AuthContext>) -> Router {
    // ブラウザで起きたことの受け口（設計§12-3）。**鍵の外側**——内側だと
    // ログイン画面とセットアップ画面のエラーが1件も届かない。材料は先に取り出す
    // （下の `with_state` が `state` を食べるため）
    let client_logs = client_logs::routes(
        Arc::clone(&auth),
        Arc::clone(&state.registry),
        state.client_logs.clone(),
    );

    let protected = Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/api/sessions", get(ws::api_sessions))
        .route("/api/sessions/past", get(ws::api_sessions_past))
        // 並べ替えの保存（並べ替え設計§9-1）。**丸ごと受け取って 0 から詰め直す**
        .route("/api/sessions/order", put(ws::api_sessions_reorder))
        .route(
            "/api/sessions/{card_id}/transcript",
            get(ws::api_transcript),
        )
        // 利用者の PC のフォルダとファイル（イシューグループ_2026_0805_0514 設計§10）。
        // **鍵の内側**に置く——中身のある口なので、素通しにしてよい理由が無い
        .route("/api/hosts/{host}/attachments", post(hosts::api_attachment))
        .route("/api/hosts/{host}/dir", get(hosts::api_dir))
        .route("/api/hosts/{host}/file", get(hosts::api_file))
        .route("/api/hosts/{host}/logs", get(hosts::api_logs))
        .route("/api/hosts/{host}/resources", get(hosts::api_resources))
        // 追加した PJT 枠（イシューグループ_2026_0805_0514 設計§10）。
        // フォルダの口と同じく**鍵の内側**
        .route(
            "/api/projects",
            get(projects::api_list).post(projects::api_add),
        )
        .route("/api/projects/order", put(projects::api_reorder))
        .route("/api/projects/{id}", delete(projects::api_remove))
        // LAN の別端末から開ける番号（LANアドレス設計§5）。**鍵の内側**——
        // 機械のアドレスは、外から誰でも読めてよいものではない
        .route("/api/lan-address", get(lan_address::api_lan_address))
        // アプリ全体の知らせ（トーストとベル設計§6-1）。**鍵の内側**——
        // 誰の知らせかで中身が変わるので、素通しにしてよい理由が無い
        .route(
            "/api/notices",
            get(notices::api_list).delete(notices::api_clear),
        )
        .route("/api/notices/read", post(notices::api_read))
        .route("/api/notices/{id}", delete(notices::api_remove))
        .with_state(state);

    guard(protected, Arc::clone(&auth))
        .merge(auth::routes(auth))
        .merge(client_logs)
        .fallback(get(static_handler))
}

/// 鍵をかける（設計§8-6）。
///
/// enforcement の要求は「漏れなく総当たり」なので、**通す口を1つの関数の向こうへ集める**。
/// ルータごとに middleware を書き並べると、新しい口を足したときに付け忘れる。
pub fn guard(router: Router, auth: Arc<auth::AuthContext>) -> Router {
    router.layer(axum::middleware::from_fn_with_state(
        auth,
        auth::require_identity,
    ))
}

/// 同梱した web アセットを配信する。
///
/// 見つからないパスのうち、拡張子を持たないものは SPA のルーティング（`/s/<id>` など）と
/// みなして `index.html` を返す。拡張子があるのに見つからない場合は本当に無いので 404 に
/// する（欠けた JS の代わりに HTML を返すと、原因の分からない実行時エラーになる）。
pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(data) = embed::get(path) {
        return ([(header::CONTENT_TYPE, embed::content_type(path))], data).into_response();
    }

    let looks_like_file = path
        .rsplit('/')
        .next()
        .is_some_and(|name| name.contains('.'));
    if !looks_like_file && let Some(data) = embed::get("index.html") {
        return (
            [(header::CONTENT_TYPE, embed::content_type("index.html"))],
            data,
        )
            .into_response();
    }

    (StatusCode::NOT_FOUND, format!("見つかりません: /{path}")).into_response()
}
