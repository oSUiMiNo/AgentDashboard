//! `GET /api/lan-address` の口（LANアドレス テスト計画フェーズ2）。
//!
//! 数え上げそのものは `src/lan_address.rs` の単体テストが厚く見ている。ここで見るのは
//! **口としての約束**——鍵の内側にあること・設計どおりの形で返すこと・合言葉が
//! 混ざらないことの3つである。
//!
//! **鍵の検査をここへ置く理由。** 越境の総当たり（`tenancy.rs`）はアカウントごとに
//! 中身が変わる口を見るためのもので、この口はアカウントで中身が変わらない。
//! 変わらないからこそ「素通しでよい」と読まれかねないので、**断ることを1本の
//! テストで名指ししておく**。

mod common;

use server_core::config::ServerConfig;
use server_core::registry::{NoticeLimits, SessionRegistry};
use std::net::SocketAddr;
use std::sync::Arc;

/// メモリに持つ履歴の窓（この試験では使わないが、記録層が要求する）。
const WINDOW: usize = 200;

/// ルータを1つ立てて、待ち受け先を返す。
///
/// `account` が真ならアカウント方式（鍵が要る）、偽ならローカルの素通し。
/// **素通しになるのは `127.0.0.1` のときだけ**なので、`bind_addr` もそれに合わせる。
async fn serve(db: sea_orm::DatabaseConnection, bind_addr: &str, account: bool) -> SocketAddr {
    let config = Arc::new(ServerConfig {
        bind_addr: bind_addr.to_string(),
        ..ServerConfig::default()
    });
    let registry = SessionRegistry::load(db.clone(), WINDOW, None, NoticeLimits::default())
        .await
        .expect("記録層を立てられること");
    let auth = if account {
        server_core::auth::AuthContext::server(db.clone(), &config)
    } else {
        server_core::auth::AuthContext::local(db.clone(), &config)
    };
    let hub = server_core::gateway::SessionHostHub::new(db.clone(), Arc::clone(&registry));
    let agent: Arc<dyn server_core::session_host::SessionHost> = Arc::new(
        server_core::gateway::RemoteSessionHost::new(Arc::clone(&hub)),
    );
    let state = server_core::ws::AppState::new(agent, registry, Arc::clone(&config));
    let router =
        server_core::auth::with_sessions(server_core::routes(state, Arc::clone(&auth)), &auth);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("空きポートで待ち受けられること");
    let addr = listener.local_addr().expect("待ち受け先を取れること");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    addr
}

/// 札も入館証も持たずに1往復する。
///
/// **`testkit::request` は同期**なので、非同期の試験から呼ぶには外へ出す。
async fn get(addr: SocketAddr) -> (u16, String) {
    let response = tokio::task::spawn_blocking(move || {
        testkit::request(addr, "GET", "/api/lan-address", None, None)
    })
    .await
    .expect("HTTPスレッドが落ちないこと")
    .expect("応答を読めること");
    (response.status, response.body)
}

#[tokio::test]
async fn 設計どおりの形で返る() {
    for backend in common::backends("lan-address-shape").await {
        // 素通しで叩けるように `127.0.0.1` で立てる
        let addr = serve(backend.db.clone(), "127.0.0.1", false).await;
        let (status, body) = get(addr).await;
        assert_eq!(status, 200, "[{}] 口が開いていない：{body}", backend.name);

        let view: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|err| panic!("JSON で返らない：{err}：{body}"));
        for key in ["port", "bind_addr", "reachable", "candidates"] {
            assert!(
                view.get(key).is_some(),
                "[{}] {key} が無い：{body}",
                backend.name
            );
        }
        assert!(
            view["candidates"].is_array(),
            "[{}] candidates が並びでない：{body}",
            backend.name
        );
        // `127.0.0.1` で立てたので、広がっていない側に倒れる（設計§5）
        assert_eq!(
            view["reachable"],
            serde_json::Value::Bool(false),
            "[{}] 待ち受けの広さを読み違えている：{body}",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 鍵の外から叩くと断られる() {
    for backend in common::backends("lan-address-guard").await {
        // アカウント方式で立てる。**札を持たずに叩く**
        let addr = serve(backend.db.clone(), "0.0.0.0", true).await;
        let (status, body) = get(addr).await;
        assert_eq!(
            status, 401,
            "[{}] 鍵の外から機械のアドレスが読めている：{body}",
            backend.name
        );
        // **番号が1つも漏れていないこと。** 断り文に混ぜてしまう事故を見張る
        assert!(
            !body.contains("192.168.") && !body.contains("10."),
            "[{}] 断り文に番号が混ざっている：{body}",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 応答に合言葉が混ざらない() {
    for backend in common::backends("lan-address-secret").await {
        let addr = serve(backend.db.clone(), "127.0.0.1", false).await;
        let (_, body) = get(addr).await;
        // 設計§5「合言葉は一切返さない」。**欄そのものが無いことを字面で見張る**
        for word in ["password", "secret", "token", "hash"] {
            assert!(
                !body.contains(word),
                "[{}] {word} が応答に混ざっている：{body}",
                backend.name
            );
        }

        backend.finish().await;
    }
}
