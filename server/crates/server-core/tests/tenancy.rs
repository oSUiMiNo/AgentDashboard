//! アカウント分離の総当たり（セルフホスト化設計§8-6、テスト計画フェーズ5 の1項目目）。
//!
//! # 何を確かめるのか
//!
//! 設計§8-6 は enforcement を効かせる場所を表で列挙している。**1経路でも漏れると
//! テナント分離が絵に描いた餅になる**ので、ここでは表の全行を**越境する側から**叩き、
//! 全部が失敗することを見る。
//!
//! | 表の行 | ここでの叩き方 |
//! |---|---|
//! | REST 全エンドポイント | 他人のカードの一覧・履歴を要求する／**他人の枠を一覧・削除し、他人の PC へ枠を作る** |
//! | WS 購読 | `SubTranscript` / `SubPty` を他人のカードへ出す |
//! | WS 操作 | `Kill` / `Archive` / `SetModel` / `SetPermissionMode` / `SendInput` / `Resize` / `PtyFlow` / 生の入力 / `Spawn`（他人の PC 宛て）を出す |
//! | A2S | 自分の接続から**他人の card_id** を報告する |
//! | 別の PC のログを引く口 | 他人の PC を宛先に `GET /api/hosts/{id}/logs` する（ログ設計§13-1） |
//! | ブラウザのログの受け口 | 他人の card_id を名乗って `POST /api/client-logs` する（ログ設計§12-5） |
//! | CLI の札（CLI設計§5-2・§5-3） | `cli` の札で REST と `/ws` を通し、見えるのは自分のカードだけ／他人のカードは名指しでも知らないカードと同じ言葉／`agent` の札・失効した札・用途違いの札は通らない／**札が通らないとき Cookie へ落ちない** |
//!
//! Valkey の行（チャネル名の acct スコープ）はフェーズ6 側で消化する。
//!
//! # 「断られた」だけでは足りない
//!
//! 断られても**中身が変わっていたら**意味が無いので、越境を試した後に必ず
//! 「相手のカードが無傷か」を確かめる。逆に、正当な側（自分のカード）では同じ操作が
//! 通ることも見る——全部断っているだけの実装でも通ってしまうため。

#![allow(non_snake_case)]

mod common;

use futures_util::{SinkExt as _, StreamExt as _};
use protocol::{
    CardId, SessionMeta, SessionStatus,
    a2s::AgentMessage,
    ws::{ClientMessage, ServerMessage},
};
use sea_orm::DatabaseConnection;
use server_core::{
    client_logs::ClientLogSink, db::pairing, gateway::SessionHostHub, registry::SessionRegistry,
};
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_tungstenite::tungstenite;
use uuid::Uuid;

const WINDOW: usize = 200;
const TIMEOUT: Duration = Duration::from_secs(10);
const PASSWORD: &str = "つよいあいことば";

/// 1アカウントぶんの持ち物。
struct Tenant {
    name: &'static str,
    account_id: Uuid,
    card_id: CardId,
}

/// アカウント分離を試すための一式（サーバ1つ・アカウント2つ）。
struct Arena {
    addr: SocketAddr,
    db: DatabaseConnection,
    registry: Arc<SessionRegistry>,
    /// 繋がっている PC の集まり。失効を接続中へ効かせる確認に要る
    hub: Arc<SessionHostHub>,
    /// ブラウザのログの行き先。**ファイルではなく手元へ溜める**——
    /// 見たいのは「何が書かれたか」であって、書き出しの経路ではない
    logs: Arc<記録>,
    task: tokio::task::JoinHandle<()>,
}

/// 受け取った行を溜めるだけの行き先。
#[derive(Default)]
struct 記録 {
    lines: Mutex<Vec<protocol::client_log::ClientLogEntry>>,
}

impl ClientLogSink for 記録 {
    fn write(
        &self,
        _anon: bool,
        entries: &[protocol::client_log::ClientLogEntry],
        _drops: protocol::client_log::ClientLogDrops,
    ) {
        self.lines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .extend_from_slice(entries);
    }
}

impl Drop for Arena {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Arena {
    async fn start(db: DatabaseConnection) -> Self {
        let config = Arc::new(server_core::config::ServerConfig::default());
        let registry = SessionRegistry::load(db.clone(), WINDOW, None)
            .await
            .expect("記録層を立てられること");
        let auth = server_core::auth::AuthContext::server(db.clone(), &config);
        let hub = SessionHostHub::new(db.clone(), Arc::clone(&registry));
        let agent: Arc<dyn server_core::session_host::SessionHost> = Arc::new(
            server_core::gateway::RemoteSessionHost::new(Arc::clone(&hub)),
        );
        let logs = Arc::new(記録::default());
        let ws_state =
            server_core::ws::AppState::new(agent, Arc::clone(&registry), Arc::clone(&config))
                .with_client_logs(Arc::clone(&logs) as Arc<dyn ClientLogSink>);

        let router = server_core::auth::with_sessions(
            server_core::routes(ws_state, Arc::clone(&auth))
                .merge(server_core::gateway::agent_routes(Arc::clone(&hub))),
            &auth,
        );

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("空きポートで待ち受けられること");
        let addr = listener.local_addr().expect("待ち受け先を取れること");
        let task = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        Self {
            addr,
            db,
            registry,
            hub,
            logs,
            task,
        }
    }

    /// アカウントを1つ用意し、その PC を繋いでカードを1枚作る。
    async fn tenant(&self, name: &'static str) -> (Tenant, common::SessionHostSocket) {
        let account_id = pairing::ensure_account(&self.db, name)
            .await
            .expect("アカウントを用意できること");
        // 画面から入れるようにパスワードも付ける（`/setup` は1人目しか通らない）
        set_password(&self.db, account_id).await;
        let token = pairing::issue_token(&self.db, account_id, "テスト", pairing::TokenKind::Agent)
            .await
            .expect("トークンを発行できること");

        let mut socket = common::connect_agent_as(self.addr, &token, name).await;
        // 名乗りの応答（`Hello`）を先に受け取っておく。**残しておくと、後で
        // 「最初に届く指示」を見るときにこれが出てきて、検査が空振りする**
        socket
            .wait_for("名乗りの応答", |message| {
                matches!(message, protocol::a2s::ServerToAgent::Hello { .. })
            })
            .await;

        let card_id = CardId::new();
        socket
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(common::meta(card_id)),
            })
            .await;
        self.wait_for_listed(account_id, 1).await;

        (
            Tenant {
                name,
                account_id,
                card_id,
            },
            socket,
        )
    }

    /// そのアカウントの一覧が指定の枚数になるまで待つ。
    async fn wait_for_listed(&self, account_id: Uuid, count: usize) -> Vec<SessionMeta> {
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        loop {
            let listed = self.registry.list(account_id);
            if listed.len() == count {
                return listed;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{TIMEOUT:?} 以内に一覧が {count} 枚になりませんでした（実際 {} 枚）",
                listed.len()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// ログイン済みのブラウザを1つ作る。
    async fn browser(&self, tenant: &Tenant) -> Browser {
        let addr = self.addr;
        let body = serde_json::json!({ "name": tenant.name, "password": PASSWORD }).to_string();
        let response = tokio::task::spawn_blocking(move || {
            testkit::request(addr, "POST", "/api/login", Some(&body), None)
        })
        .await
        .expect("HTTPスレッドが落ちないこと")
        .expect("応答を読めること");
        assert_eq!(response.status, 200, "ログインできない: {}", response.body);
        let cookie = response.cookie.expect("入館証が出ること");

        // `/ws` も REST と同じ Cookie で認証する（設計§8-2）
        let request = tungstenite::http::Request::builder()
            .uri(format!("ws://{addr}/ws"))
            .header("Host", addr.to_string())
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header(
                "Sec-WebSocket-Key",
                tungstenite::handshake::client::generate_key(),
            )
            .header("Cookie", cookie.clone())
            .body(())
            .expect("要求を組み立てられること");
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .expect("ブラウザとして繋げること");

        Browser {
            addr,
            cookie,
            socket,
        }
    }
}

/// パスワードを持たせる（`pair-token` が作った行はログインできない。§20 読み替え3）。
async fn set_password(db: &DatabaseConnection, account_id: Uuid) {
    use sea_orm::{ColumnTrait as _, EntityTrait as _, QueryFilter as _};
    let hash = tokio::task::spawn_blocking(password_hash)
        .await
        .expect("スレッドが落ちないこと");
    server_core::db::entity::accounts::Entity::update_many()
        .col_expr(
            server_core::db::entity::accounts::Column::PasswordHash,
            sea_orm::sea_query::Expr::value(hash),
        )
        .filter(server_core::db::entity::accounts::Column::Id.eq(account_id))
        .exec(db)
        .await
        .expect("パスワードを付けられること");
}

/// `/api/setup` を通さずにハッシュを作る。**同じ道具（argon2id）を通す**ことが要点で、
/// 別の作り方をすると照合が通らない。
fn password_hash() -> String {
    // `server_core::auth` は生成関数を公開していない（外から作らせるものではない）。
    // ここでは `/setup` の代わりに DB を直接埋めるので、同じ crate を使って作る
    password_auth::generate_hash(PASSWORD)
}

/// ブラウザの役。REST と WS の両方を1つの入館証で使う。
struct Browser {
    addr: SocketAddr,
    cookie: String,
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl Browser {
    async fn get(&self, path: &str) -> (u16, String) {
        let (addr, path, cookie) = (self.addr, path.to_string(), self.cookie.clone());
        let response = tokio::task::spawn_blocking(move || {
            testkit::request(addr, "GET", &path, None, Some(&cookie))
        })
        .await
        .expect("HTTPスレッドが落ちないこと")
        .expect("応答を読めること");
        (response.status, response.body)
    }

    /// `GET` 以外も叩く（枠の追加・削除）。入館証の載せ方は同じ。
    async fn request(&self, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
        let (addr, method, path) = (self.addr, method.to_string(), path.to_string());
        let (body, cookie) = (body.map(str::to_string), self.cookie.clone());
        let response = tokio::task::spawn_blocking(move || {
            testkit::request(addr, &method, &path, body.as_deref(), Some(&cookie))
        })
        .await
        .expect("HTTPスレッドが落ちないこと")
        .expect("応答を読めること");
        (response.status, response.body)
    }

    async fn send(&mut self, message: &ClientMessage) {
        let text = serde_json::to_string(message).expect("組み立てられること");
        self.socket
            .send(tungstenite::Message::text(text))
            .await
            .expect("送れること");
    }

    async fn send_bytes(&mut self, bytes: Vec<u8>) {
        self.socket
            .send(tungstenite::Message::Binary(bytes.into()))
            .await
            .expect("送れること");
    }

    /// 条件に合う知らせが来るまで受け取り続ける。
    async fn wait_for(
        &mut self,
        what: &str,
        matches: impl Fn(&ServerMessage) -> bool,
    ) -> ServerMessage {
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let next = tokio::time::timeout(remaining, self.socket.next())
                .await
                .unwrap_or_else(|_| panic!("{TIMEOUT:?} 以内に {what} が届きませんでした"));
            match next {
                Some(Ok(tungstenite::Message::Text(text))) => {
                    if let Ok(message) = serde_json::from_str::<ServerMessage>(&text)
                        && matches(&message)
                    {
                        return message;
                    }
                }
                Some(Ok(_)) => continue,
                other => panic!("{what} を待っている間に切れました: {other:?}"),
            }
        }
    }

    /// 断られたことを確かめる。
    async fn expect_refused(&mut self, message: ClientMessage, what: &str) {
        self.send(&message).await;
        let refused = self
            .wait_for(what, |message| {
                matches!(message, ServerMessage::Error { .. })
            })
            .await;
        let ServerMessage::Error { message, .. } = refused else {
            unreachable!()
        };
        // **他人のカードと知らないカードを呼び分けない**（IDの総当たりで存在を
        // 調べられないように）
        assert_eq!(
            message, "セッションが見つかりません",
            "断り方が他人のカードだと分かる形になっている: {what}"
        );
    }
}

#[tokio::test]
async fn 他人のカードは一覧にも履歴にも出ない() {
    for backend in common::backends("tenancy-read").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let (theirs, _their_agent) = arena.tenant("よそのひと").await;
        let browser = arena.browser(&mine).await;

        // REST の一覧：自分のカードだけ
        let (status, body) = browser.get("/api/sessions").await;
        assert_eq!(status, 200);
        let listed: Vec<SessionMeta> = serde_json::from_str(&body).expect("読めること");
        assert_eq!(listed.len(), 1, "[{}] 実際: {body}", backend.name);
        assert_eq!(listed[0].card_id, mine.card_id);

        // REST の履歴：自分のは読めて、他人のは「無い」
        let (status, _) = browser
            .get(&format!("/api/sessions/{}/transcript", mine.card_id))
            .await;
        assert_eq!(status, 200, "[{}] 自分の履歴が読めない", backend.name);

        let (status, _) = browser
            .get(&format!("/api/sessions/{}/transcript", theirs.card_id))
            .await;
        assert_eq!(status, 404, "[{}] 他人の履歴が読めてしまった", backend.name);

        backend.finish().await;
    }
}

#[tokio::test]
async fn 他人のカードへの購読と操作は全部断られる() {
    for backend in common::backends("tenancy-ws").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let (theirs, mut their_agent) = arena.tenant("よそのひと").await;
        let mut browser = arena.browser(&mine).await;

        let card_id = theirs.card_id;
        // **§8-6 の表を総当たりする。** 1つでも漏れると分離が成立しない
        let crossings = [
            ("履歴の購読", ClientMessage::SubTranscript { card_id }),
            (
                "端末の購読",
                ClientMessage::SubPty {
                    card_id,
                    cols: 80,
                    rows: 24,
                },
            ),
            (
                "権限モードの切替",
                ClientMessage::SetPermissionMode {
                    card_id,
                    mode: protocol::PermissionMode::new("bypassPermissions"),
                },
            ),
            (
                "モデルの切替",
                ClientMessage::SetModel {
                    card_id,
                    model: protocol::ModelId::new("opus"),
                },
            ),
            (
                "指示の送信",
                ClientMessage::SendInput {
                    card_id,
                    text: "こっそり".to_string(),
                },
            ),
            ("終了", ClientMessage::Kill { card_id }),
            ("一覧から外す", ClientMessage::Archive { card_id }),
            (
                "大きさの変更",
                ClientMessage::Resize {
                    card_id,
                    cols: 1,
                    rows: 1,
                },
            ),
            (
                "フロー制御",
                ClientMessage::PtyFlow {
                    card_id,
                    state: protocol::ws::FlowState::Pause,
                },
            ),
            ("購読の取り下げ", ClientMessage::UnsubTranscript { card_id }),
            ("端末の取り下げ", ClientMessage::UnsubPty { card_id }),
            // 起こし直しは**他人の PC で本物の claude を起動させる**操作なので、
            // 越えられると被害がいちばん大きい
            ("起こし直し", ClientMessage::ReviveSession { card_id }),
        ];
        for (what, message) in crossings {
            browser.expect_refused(message, what).await;
        }

        // 生のキー入力は**黙って捨てる**（打鍵ごとに来るので断り続けると画面が埋まる）。
        // 捨てていることは「相手の PC へ何も届かない」で確かめる
        browser
            .send_bytes(protocol::frame::encode(
                protocol::frame::FrameKind::PtyInput,
                card_id,
                b"rm -rf /\r",
            ))
            .await;

        // 断られたあとも相手のカードは無傷
        let listed = arena.wait_for_listed(theirs.account_id, 1).await;
        assert_eq!(listed[0].card_id, card_id, "[{}]", backend.name);
        assert_eq!(
            listed[0].status,
            SessionStatus::Working,
            "[{}]",
            backend.name
        );

        // **相手の PC には指示が1つも届いていない。** 「何も来ないこと」は待ち時間の
        // 長さでしか言えないので、相手が自分で1つ報告し、その**応答（ack）が
        // 次に届く**ことで確かめる——間に横取りした指示があれば、そちらが先に来る
        their_agent
            .send(&AgentMessage::TranscriptReset {
                batch_id: protocol::a2s::BatchId(1),
                card_id,
            })
            .await;
        let next = their_agent.wait_for("最初に届く指示", |_| true).await;
        assert!(
            matches!(
                next,
                protocol::a2s::ServerToAgent::BatchAck { batch_id } if batch_id == protocol::a2s::BatchId(1)
            ),
            "[{}] 横取りした指示が相手の PC へ届いている: {next:?}",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 他人の戻せるカードも同じ言葉で断られる() {
    // **門の順序を固定する。** 持ち主の確認より先に「戻せるか」を見ると、他人のカードへ
    // 「このセッションは動いています」「呼び戻す先が記録されていません」を返すことになり、
    // **IDの総当たりで他人のカードの様子が読める**（設計§3-5・セルフホスト化設計§18）。
    //
    // 上の総当たりが使うのは**動いているカード**なので、順序を入れ替えても
    // あちらは「動いています」ではなく素通りしてしまい、この壊れ方を捕まえられない。
    for backend in common::backends("tenancy-revive").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let (theirs, mut their_agent) = arena.tenant("よそのひと").await;
        let mut browser = arena.browser(&mine).await;

        // 相手のカードを**起こし直せる状態**にする（終了済み＋呼び戻し先あり）
        let mut ended = common::meta(theirs.card_id);
        ended.status = SessionStatus::Ended { ok: true };
        ended.claude_session_id = Some(protocol::ClaudeSessionId::new());
        their_agent
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(ended),
            })
            .await;
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        loop {
            if arena
                .registry
                .list(theirs.account_id)
                .first()
                .is_some_and(SessionMeta::revivable)
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "[{}] 相手のカードが戻せる状態になりませんでした",
                backend.name
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        browser
            .expect_refused(
                ClientMessage::ReviveSession {
                    card_id: theirs.card_id,
                },
                "他人の戻せるカードの起こし直し",
            )
            .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 正当な相手には同じ操作が通る() {
    // **全部断っているだけの実装でも上のテストは通る。** こちらが対になっている
    for backend in common::backends("tenancy-allow").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let mut browser = arena.browser(&mine).await;

        browser
            .send(&ClientMessage::SubTranscript {
                card_id: mine.card_id,
            })
            .await;
        // 購読は「作り直しの指示」から始まる（設計§4）
        browser
            .wait_for("履歴の購読が始まる", |message| {
                matches!(
                    message,
                    ServerMessage::TranscriptReset { card_id } if *card_id == mine.card_id
                )
            })
            .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 他人のカードIDを報告しても登録されない() {
    // 設計§8-6 の A2S の行。**帰属は接続が決める**ので、自分の接続から他人の
    // card_id を名乗っても、その行の持ち主は動かない
    for backend in common::backends("tenancy-a2s").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, mut mine_agent) = arena.tenant("わたし").await;
        let (theirs, _their_agent) = arena.tenant("よそのひと").await;

        // 他人のカードを乗っ取ろうとする
        let mut stolen = common::meta(theirs.card_id);
        stolen.project = protocol::ProjectId("/乗っ取り".to_string());
        mine_agent
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(stolen),
            })
            .await;
        mine_agent
            .send(&AgentMessage::Status {
                card_id: theirs.card_id,
                status: SessionStatus::Ended { ok: false },
                subagent_active: 0,
                last_activity_at: 99,
            })
            .await;
        mine_agent
            .send(&AgentMessage::SessionRemoved {
                card_id: theirs.card_id,
            })
            .await;

        // 自分の側で1つ報告して、上の3つが処理し終わったことを確かめる
        // （**先に届いたものが先に処理される**ので、これが見えれば前は済んでいる）
        mine_agent
            .send(&AgentMessage::Status {
                card_id: mine.card_id,
                status: SessionStatus::WaitingInput,
                subagent_active: 0,
                last_activity_at: 5,
            })
            .await;
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        loop {
            let listed = arena.registry.list(mine.account_id);
            if listed.first().map(|meta| meta.status) == Some(SessionStatus::WaitingInput) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "[{}] 自分の報告が届かない",
                backend.name
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        // 他人のカードは1枚のまま・中身も無傷
        let listed = arena.registry.list(theirs.account_id);
        assert_eq!(listed.len(), 1, "[{}] 外されている", backend.name);
        assert_eq!(listed[0].card_id, theirs.card_id);
        assert_eq!(
            listed[0].status,
            SessionStatus::Working,
            "[{}] 状態を書き換えられた",
            backend.name
        );
        assert_eq!(
            listed[0].project.0, "/tmp/project",
            "[{}] 中身を書き換えられた",
            backend.name
        );
        // 自分の一覧に他人のカードが混ざってもいない
        assert_eq!(
            arena.registry.list(mine.account_id).len(),
            1,
            "[{}]",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 他人の_PC_を宛先にした起動は断られる() {
    // 設計§21 読み替え3 の宛先指定に、§8-6 の絞り込みを効かせた形
    for backend in common::backends("tenancy-spawn").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let (theirs, _their_agent) = arena.tenant("よそのひと").await;

        let their_agent_id = arena
            .registry
            .list(theirs.account_id)
            .first()
            .and_then(|meta| meta.agent_id)
            .expect("相手の PC が分かること");

        let mut browser = arena.browser(&mine).await;
        browser
            .send(&ClientMessage::Spawn {
                cwd: "/tmp".to_string(),
                permission_mode: None,
                agent_id: Some(their_agent_id),
            })
            .await;
        let refused = browser
            .wait_for("断られる", |message| {
                matches!(message, ServerMessage::Error { .. })
            })
            .await;
        let ServerMessage::Error { message, .. } = refused else {
            unreachable!()
        };
        // **他人の PC は「繋がっていない」と同じ扱い**（存在を言い当てさせない）
        assert_eq!(
            message, "指定された PC が繋がっていません",
            "[{}] 他人の PC の存在が分かる断り方になっている",
            backend.name
        );
        let _ = mine;

        backend.finish().await;
    }
}

#[tokio::test]
async fn tomlに他人の名前を書いても帰属は動かない() {
    // 検収「権限」——**持っていない権限は名乗れない**（設計§8-5）。申告そのものは
    // 記録に残す（利用者が「書いたのに効かない」を確かめられるように）が、
    // 帰属は接続のもののまま
    for backend in common::backends("tenancy-toml").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (theirs, _their_agent) = arena.tenant("よそのひと").await;
        let (mine, mut mine_agent) = arena.tenant("わたし").await;

        let card_id = CardId::new();
        let mut claim = common::meta(card_id);
        claim.toml_account = Some("よそのひと".to_string());
        mine_agent
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(claim),
            })
            .await;

        let listed = arena.wait_for_listed(mine.account_id, 2).await;
        let card = listed
            .iter()
            .find(|meta| meta.card_id == card_id)
            .expect("自分の一覧に出ること");
        // 申告はそのまま残る（画面に出して、書いた本人が気づけるように）
        assert_eq!(card.toml_account.as_deref(), Some("よそのひと"));
        // **帰属は動かない。** 見ているのは申告ではなく接続
        assert_eq!(
            card.account.as_deref(),
            Some("わたし"),
            "[{}]",
            backend.name
        );
        // 名指しされた側の一覧にも現れない
        assert_eq!(
            arena.registry.list(theirs.account_id).len(),
            1,
            "[{}] 名乗っただけで相手の一覧へ入り込んだ",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 失効させると繋がっている_PC_も切れる() {
    // 設計§8-4。**立てるだけでは足りない**——外したはずの PC が次に切れるまで
    // 繋がり続けるなら、失効はほとんど意味を持たない
    for backend in common::backends("tenancy-revoke").await {
        let arena = Arena::start(backend.db.clone()).await;
        let account_id = pairing::ensure_account(&backend.db, "わたし")
            .await
            .expect("アカウントを用意できること");
        let token = pairing::issue_token(
            &backend.db,
            account_id,
            "捨てる予定",
            pairing::TokenKind::Agent,
        )
        .await
        .expect("発行できること");
        let token_id = pairing::resolve_token(&backend.db, &token, pairing::TokenKind::Agent)
            .await
            .expect("引けること")
            .expect("有効であること")
            .token_id;

        let mut socket = common::connect_agent_as(arena.addr, &token, "外す予定のPC").await;
        socket
            .wait_for("名乗りの応答", |message| {
                matches!(message, protocol::a2s::ServerToAgent::Hello { .. })
            })
            .await;

        pairing::revoke_token(&backend.db, token_id)
            .await
            .expect("失効させられること");
        let cut = arena.hub.disconnect_token(token_id);
        assert_eq!(
            cut, 1,
            "[{}] 繋がっている接続を見つけられていない",
            backend.name
        );

        // 相手からは**畳まれた**ように見える
        socket.expect_closed().await;

        // 失効後は繋ぎ直せない（upgrade の段階で断られる）
        let denied =
            common::connect_agent(arena.addr, Some(&token), Some(protocol::a2s::A2S_PROTOCOL))
                .await;
        assert!(
            denied.is_err(),
            "[{}] 失効したトークンで繋がった",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 同じアカウントへ3台以上を同時に繋げる() {
    // 検収「複数 PC を同一アカウントに登録」＋非機能「3台以上」（設計§8-4）。
    // トークンは1台1本にしておくと、1台ぶんを外すときに他を巻き添えにしない
    for backend in common::backends("tenancy-many").await {
        let arena = Arena::start(backend.db.clone()).await;
        let account_id = pairing::ensure_account(&backend.db, "わたし")
            .await
            .expect("アカウントを用意できること");

        let mut sockets = Vec::new();
        for name in ["仕事用ノート", "自宅デスクトップ", "手元のミニPC"] {
            let token =
                pairing::issue_token(&backend.db, account_id, name, pairing::TokenKind::Agent)
                    .await
                    .expect("発行できること");
            let mut socket = common::connect_agent_as(arena.addr, &token, name).await;
            socket
                .wait_for("名乗りの応答", |message| {
                    matches!(message, protocol::a2s::ServerToAgent::Hello { .. })
                })
                .await;
            socket
                .send(&AgentMessage::SessionUpsert {
                    session: Box::new(common::meta(CardId::new())),
                })
                .await;
            sockets.push(socket);
        }

        // 3台ぶんのカードが同じアカウントの一覧に並ぶ
        let listed = arena.wait_for_listed(account_id, 3).await;
        let mut agent_ids: Vec<_> = listed.iter().filter_map(|meta| meta.agent_id).collect();
        agent_ids.sort();
        agent_ids.dedup();
        assert_eq!(
            agent_ids.len(),
            3,
            "[{}] 別々の PC として登録されていない",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 他人の枠は見えないし消せない() {
    // 口が3つ増えたので、表の行も同じ数だけ増やす（イシューグループ_2026_0805_0514 設計§18）。
    // **他人の PC と知らない PC を言い分けない**——言い分けると、IDを総当たりして
    // 他人の持ち物の存在だけを調べられる
    use sea_orm::{ColumnTrait as _, EntityTrait as _, QueryFilter as _};

    for backend in common::backends("tenancy-projects").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let (theirs, _their_agent) = arena.tenant("よそのひと").await;
        let browser = arena.browser(&mine).await;

        let ours = server_core::db::projects::add(
            &backend.db,
            mine.account_id,
            None,
            "/home/example/mine",
            1,
        )
        .await
        .expect("自分の枠を作れること");
        let theirs_project = server_core::db::projects::add(
            &backend.db,
            theirs.account_id,
            None,
            "/home/example/theirs",
            2,
        )
        .await
        .expect("よその枠を作れること");

        // ① 一覧に他人の枠は出ない
        let (status, body) = browser.get("/api/projects").await;
        assert_eq!(status, 200);
        let listed: Vec<serde_json::Value> = serde_json::from_str(&body).expect("読めること");
        assert_eq!(listed.len(), 1, "[{}] 実際: {body}", backend.name);
        assert_eq!(listed[0]["path"], "/home/example/mine");

        // ② 他人の枠は消せない。**知らない枠と同じ 404**
        let (status, _) = browser
            .request(
                "DELETE",
                &format!("/api/projects/{}", theirs_project.id),
                None,
            )
            .await;
        assert_eq!(status, 404, "[{}] 他人の枠を消せてしまった", backend.name);
        let (unknown, _) = browser
            .request("DELETE", &format!("/api/projects/{}", Uuid::new_v4()), None)
            .await;
        assert_eq!(
            unknown, status,
            "[{}] 他人の枠と知らない枠を言い分けている",
            backend.name
        );

        // ③ 断られただけでなく、相手の枠が無傷であること
        let still =
            server_core::db::projects::get(&backend.db, theirs.account_id, theirs_project.id)
                .await
                .expect("読めること");
        assert!(still.is_some(), "[{}] 他人の枠が消えている", backend.name);

        // ④ 他人の PC を宛先にした追加も、知らない PC と同じ言葉で断る
        let their_agent = server_core::db::entity::agents::Entity::find()
            .filter(server_core::db::entity::agents::Column::AccountId.eq(theirs.account_id))
            .one(&backend.db)
            .await
            .expect("読めること")
            .expect("よその PC が登録されていること");
        let (status, _) = browser
            .request(
                "POST",
                "/api/projects",
                Some(&serde_json::json!({ "host": their_agent.id, "path": "/x" }).to_string()),
            )
            .await;
        assert_eq!(
            status, 404,
            "[{}] 他人の PC へ枠を作れてしまった",
            backend.name
        );

        // ⑤ 正当な側では同じ操作が通ること（全部断っているだけの実装でも通らないように）
        let (status, _) = browser
            .request("DELETE", &format!("/api/projects/{}", ours.id), None)
            .await;
        assert_eq!(status, 204, "[{}] 自分の枠が消せない", backend.name);

        backend.finish().await;
    }
}

/// ブラウザのログに他人の PC を引かせない（ログ設計§12-5・§8-6）。
///
/// この口は**鍵の外側**なので、他の行と違って「断られること」では確かめられない
/// ——誰でも書けるのが仕様である。見るのは**書けた行の中身**で、他人の `card_id` を
/// 名乗っても `agent_id` が引けないこと。引けてしまうと、IDを総当たりして
/// **他人のセッションがどの PC に居るかを外から測れる**。
#[tokio::test]
async fn 他人の_card_id_を名乗っても_PC_は引けない() {
    for backend in common::backends("tenancy-client-logs").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let (theirs, _their_agent) = arena.tenant("よそのひと").await;
        let browser = arena.browser(&mine).await;

        // ① 他人のカードを名乗る
        let (status, _) = browser
            .request(
                "POST",
                "/api/client-logs",
                Some(&client_log_body(theirs.card_id)),
            )
            .await;
        assert_eq!(status, 204, "[{}] 受けること（鍵の外側）", backend.name);

        // ② 自分のカードを名乗る。**正当な側では引けること**まで見ないと、
        // 「いつも引けない実装」でも①が通ってしまう
        let (status, _) = browser
            .request(
                "POST",
                "/api/client-logs",
                Some(&client_log_body(mine.card_id)),
            )
            .await;
        assert_eq!(status, 204, "[{}] 受けること", backend.name);

        let lines = arena
            .logs
            .lines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert_eq!(lines.len(), 2, "[{}] 2件とも書かれること", backend.name);
        assert_eq!(
            lines[0].agent_id, None,
            "[{}] 他人の card_id から PC を引けてしまった",
            backend.name
        );
        assert!(
            lines[1].agent_id.is_some(),
            "[{}] 自分の card_id からも引けていない（①が空振りしている）",
            backend.name
        );

        backend.finish().await;
    }
}

/// ブラウザが名乗った `agent_id` は信じない（ログ設計§12-5）。
///
/// **封筒の中身ではなく、こちらが引いた値を正とする。** 信じると、他人の PC を
/// 名乗った行がそのまま残り、後から読む人が誤った PC を追いかけることになる。
#[tokio::test]
async fn ブラウザが名乗った_agent_id_は捨てる() {
    for backend in common::backends("tenancy-client-logs-agent").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let browser = arena.browser(&mine).await;

        let 嘘 = format!(
            r#"{{"entries":[{{"ts":"2026-08-08T00:00:00.000Z","level":"ERROR","kind":"unhandled","msg":"名乗り","agent_id":"{}"}}]}}"#,
            Uuid::from_u128(0xdead)
        );
        let (status, _) = browser.request("POST", "/api/client-logs", Some(&嘘)).await;
        assert_eq!(status, 204);

        let lines = arena
            .logs
            .lines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert_eq!(
            lines[0].agent_id, None,
            "[{}] ブラウザの名乗りがそのまま残っている",
            backend.name
        );

        backend.finish().await;
    }
}

fn client_log_body(card_id: CardId) -> String {
    format!(
        r#"{{"entries":[{{"ts":"2026-08-08T00:00:00.000Z","level":"ERROR","kind":"unhandled","msg":"落ちました","card_id":"{card_id}"}}]}}"#
    )
}

#[tokio::test]
async fn 他人の_PC_のログは引けない() {
    // 振る舞いは `ask` の宛先解決（`conn.account_id == request.account_id`）が既に
    // 守っている。**それでもここへ足すのは、守られている証拠が無いから**——
    // 1経路でも漏れると分離が絵に描いた餅になる、というのがこの表の存在理由
    for backend in common::backends("tenancy-logs").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, mut mine_agent) = arena.tenant("わたし").await;
        let (theirs, _their_agent) = arena.tenant("よそのひと").await;

        let their_agent_id = arena
            .registry
            .list(theirs.account_id)
            .first()
            .and_then(|meta| meta.agent_id)
            .expect("相手の PC が分かること");

        let browser = arena.browser(&mine).await;
        let (status, body) = browser
            .get(&format!(
                "/api/hosts/{}/logs?since=2026-08-08T00:00:00.000Z",
                their_agent_id.0
            ))
            .await;

        // **他人の PC と知らない PC を言い分けない。** 言い分けると、IDを総当たりして
        // 他人の持ち物の存在だけを調べられる
        assert_eq!(status, 404, "[{}] {body}", backend.name);
        assert!(
            body.contains("繋がっていません"),
            "[{}] 存在が分かる断り方になっている: {body}",
            backend.name
        );

        // **でたらめな綴りも同じ言葉。** ここが違うと、断り方の差だけで実在を探れる
        let (unknown_status, unknown_body) = browser
            .get(&format!(
                "/api/hosts/{}/logs?since=2026-08-08T00:00:00.000Z",
                uuid::Uuid::new_v4()
            ))
            .await;
        assert_eq!(unknown_status, status, "[{}]", backend.name);
        assert_eq!(unknown_body, body, "[{}]", backend.name);

        // **肯定側の裏取り。** 全部断っているだけの実装でも上は通ってしまうので、
        // 自分の PC へは同じ口が通ることまで見る。
        //
        // なお `local` は**サーバモードでは引けない**（`RemoteSessionHost` は自分の
        // ログを読む口を持たない）。ここで `local` を当てにすると、正しい 404 を
        // 「塞がれている」と読み違える（実際に一度そう書いた）
        let my_agent_id = arena
            .registry
            .list(mine.account_id)
            .first()
            .and_then(|meta| meta.agent_id)
            .expect("自分の PC が分かること");
        let (addr, cookie) = (browser.addr, browser.cookie.clone());
        let path = format!(
            "/api/hosts/{}/logs?since=2026-08-08T00:00:00.000Z",
            my_agent_id.0
        );
        // 問いは答えを待つので、別のタスクへ逃がして**その間に PC 役が答える**
        let asking = tokio::task::spawn_blocking(move || {
            testkit::request(addr, "GET", &path, None, Some(&cookie))
        });

        let message = mine_agent
            .wait_for("自分の PC へ届くログの問い", |message| {
                matches!(message, protocol::a2s::ServerToAgent::ReadLog { .. })
            })
            .await;
        let protocol::a2s::ServerToAgent::ReadLog { request_id, .. } = message else {
            panic!("[{}] ログの問いであること", backend.name);
        };
        mine_agent
            .send(&protocol::a2s::AgentMessage::HostReply {
                request_id,
                reply: protocol::a2s::HostReply::Log(protocol::logs::LogChunk {
                    host: String::new(),
                    host_now: "2026-08-08T01:00:00.000Z".to_string(),
                    lines: Vec::new(),
                    truncated: false,
                    broken: 0,
                    leaks: 0,
                }),
            })
            .await;
        let own = asking
            .await
            .expect("HTTPスレッドが落ちないこと")
            .expect("応答を読めること");
        assert_eq!(own.status, 200, "[{}] {}", backend.name, own.body);
        // **どの PC のものかはサーバが埋める**（PC は空で返す）
        assert!(
            own.body.contains(&my_agent_id.0.to_string()),
            "[{}] {}",
            backend.name,
            own.body
        );

        backend.finish().await;
    }
}

/// 他人の PC の資源（空きメモリ）は引けないこと（コードレビュー対応7）。
///
/// **いまは `route()` を `/dir`・`/file`・`/logs` と共有しているので実際には塞がっている。**
/// それでもここへ足すのは、`.claude/CLAUDE.md` が「enforcement を足したらここへ足す」と
/// 定めているため——**将来 `api_resources` が近道を持ったときに、総当たりが空振りする。**
#[tokio::test]
async fn 他人の_PC_の資源は引けない() {
    for backend in common::backends("tenancy-resources").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, mut mine_agent) = arena.tenant("わたし").await;
        let (theirs, _their_agent) = arena.tenant("よそのひと").await;

        let their_agent_id = arena
            .registry
            .list(theirs.account_id)
            .first()
            .and_then(|meta| meta.agent_id)
            .expect("相手の PC が分かること");

        let browser = arena.browser(&mine).await;
        let (status, body) = browser
            .get(&format!("/api/hosts/{}/resources", their_agent_id.0))
            .await;

        // **他人の PC と知らない PC を言い分けない。** 言い分けると、IDを総当たりして
        // 他人の持ち物の存在だけを調べられる
        assert_eq!(status, 404, "[{}] {body}", backend.name);
        assert!(
            body.contains("繋がっていません"),
            "[{}] 存在が分かる断り方になっている: {body}",
            backend.name
        );

        // **でたらめな綴りも同じ言葉。** ここが違うと、断り方の差だけで実在を探れる
        let (unknown_status, unknown_body) = browser
            .get(&format!("/api/hosts/{}/resources", uuid::Uuid::new_v4()))
            .await;
        assert_eq!(unknown_status, status, "[{}]", backend.name);
        assert_eq!(unknown_body, body, "[{}]", backend.name);

        // **肯定側の裏取り。** 全部断っているだけの実装でも上は通ってしまう
        let my_agent_id = arena
            .registry
            .list(mine.account_id)
            .first()
            .and_then(|meta| meta.agent_id)
            .expect("自分の PC が分かること");
        let (addr, cookie) = (browser.addr, browser.cookie.clone());
        let path = format!("/api/hosts/{}/resources", my_agent_id.0);
        // 問いは答えを待つので、別のタスクへ逃がして**その間に PC 役が答える**
        let asking = tokio::task::spawn_blocking(move || {
            testkit::request(addr, "GET", &path, None, Some(&cookie))
        });

        let message = mine_agent
            .wait_for("自分の PC へ届く資源の問い", |message| {
                matches!(message, protocol::a2s::ServerToAgent::HostResources { .. })
            })
            .await;
        let protocol::a2s::ServerToAgent::HostResources { request_id } = message else {
            panic!("[{}] 資源の問いであること", backend.name);
        };
        mine_agent
            .send(&protocol::a2s::AgentMessage::HostReply {
                request_id,
                reply: protocol::a2s::HostReply::Resources(protocol::HostResources {
                    total_mb: 15_700,
                    available_mb: 8_192,
                    swap_free_mb: 4_096,
                    estimate_mb: 780,
                    headroom_mb: 2_048,
                    fits_now: Some(7),
                }),
            })
            .await;
        let own = asking
            .await
            .expect("HTTPスレッドが落ちないこと")
            .expect("応答を読めること");
        assert_eq!(own.status, 200, "[{}] {}", backend.name, own.body);
        assert!(
            own.body.contains("8192"),
            "[{}] 自分の PC の答えが返ること: {}",
            backend.name,
            own.body
        );

        backend.finish().await;
    }
}

/// 生で返す口も、他人の PC には届かない
/// （`ファイル閲覧で画像とHTMLも表示する` 設計§12-1。テスト計画フェーズ3「アカウント分離」）。
///
/// **同じルートのクエリ違いでも、総当たりへ足す。** 判定は `guard` と `parse_host` の
/// 1箇所を通るので通って当然に見えるが、`.claude/CLAUDE.md` が「enforcement を足したら
/// ここへ足す」と定めている——**将来この分岐が近道を持ったときに、総当たりが空振りする。**
#[tokio::test]
async fn 他人の_PC_のファイルは生でも引けない() {
    for backend in common::backends("tenancy-raw").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, mut mine_agent) = arena.tenant("わたし").await;
        let (theirs, _their_agent) = arena.tenant("よそのひと").await;

        let their_agent_id = arena
            .registry
            .list(theirs.account_id)
            .first()
            .and_then(|meta| meta.agent_id)
            .expect("相手の PC が分かること");

        let browser = arena.browser(&mine).await;
        let (status, body) = browser
            .get(&format!(
                "/api/hosts/{}/file?path=%2Ftmp%2F%E6%92%AE%E3%81%A3%E3%81%9F.png&as=raw",
                their_agent_id.0
            ))
            .await;

        // **他人の PC と知らない PC を言い分けない**（他の口と同じ言葉）
        assert_eq!(status, 404, "[{}] {body}", backend.name);
        assert!(
            body.contains("繋がっていません"),
            "[{}] 存在が分かる断り方になっている: {body}",
            backend.name
        );

        // **でたらめな綴りも同じ言葉。** 断り方の差だけで実在を探れないこと
        let (unknown_status, unknown_body) = browser
            .get(&format!(
                "/api/hosts/{}/file?path=%2Ftmp%2Fa.png&as=raw",
                uuid::Uuid::new_v4()
            ))
            .await;
        assert_eq!(unknown_status, status, "[{}]", backend.name);
        assert_eq!(unknown_body, body, "[{}]", backend.name);

        // **肯定側の裏取り。** 全部断っているだけの実装でも上は通ってしまう
        let my_agent_id = arena
            .registry
            .list(mine.account_id)
            .first()
            .and_then(|meta| meta.agent_id)
            .expect("自分の PC が分かること");
        let (addr, cookie) = (browser.addr, browser.cookie.clone());
        let path = format!(
            "/api/hosts/{}/file?path=%2Ftmp%2F%E6%92%AE%E3%81%A3%E3%81%9F.png&as=raw",
            my_agent_id.0
        );
        let asking = tokio::task::spawn_blocking(move || {
            testkit::request(addr, "GET", &path, None, Some(&cookie))
        });

        let message = mine_agent
            .wait_for("自分の PC へ届くバイト列の問い", |message| {
                matches!(message, protocol::a2s::ServerToAgent::ReadBlob { .. })
            })
            .await;
        let protocol::a2s::ServerToAgent::ReadBlob { request_id, .. } = message else {
            panic!("[{}] バイト列の問いであること", backend.name);
        };
        mine_agent
            .send(&protocol::a2s::AgentMessage::HostReply {
                request_id,
                reply: protocol::a2s::HostReply::Blob(protocol::fs::FileBlob {
                    path: "/tmp/撮った.png".to_string(),
                    media_type: "image/png".to_string(),
                    bytes: 3,
                    data: vec![0x00, 0x7f, 0xff],
                }),
            })
            .await;
        let own = asking
            .await
            .expect("HTTPスレッドが落ちないこと")
            .expect("応答を読めること");
        assert_eq!(own.status, 200, "[{}] {}", backend.name, own.body);

        backend.finish().await;
    }
}

// ---------------------------------------------------------------------------
// CLI の札（CLI設計§5。テスト計画F3「札」）
//
// CLI は Cookie を持たず、`Authorization: Bearer` の札だけで名乗る。判定は
// `AuthContext::identify` の1箇所（§5-1）なので、REST と `/ws` の両方に同じ形で効く。
// ---------------------------------------------------------------------------

/// 札で REST を叩く（CLI の役）。`cookie` も渡せるのは「札が通らないとき Cookie へ
/// 落ちない」（§5-2）を試すため——正当な CLI は Cookie を持たない。
async fn bearer_request(
    addr: SocketAddr,
    method: &'static str,
    path: String,
    token: String,
    cookie: Option<String>,
) -> (u16, String) {
    let response = tokio::task::spawn_blocking(move || {
        let auth = format!("Bearer {token}");
        let mut headers: Vec<(&str, &str)> = vec![("Authorization", auth.as_str())];
        if let Some(cookie) = cookie.as_deref() {
            headers.push(("Cookie", cookie));
        }
        testkit::request_with(addr, method, &path, None, &headers)
    })
    .await
    .expect("HTTPスレッドが落ちないこと")
    .expect("応答を読めること");
    (response.status, response.body)
}

/// 札で `/ws` へ upgrade する（CLI の役。Cookie は載せない）。
async fn cli_ws(
    addr: SocketAddr,
    token: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tungstenite::Error,
> {
    let request = tungstenite::http::Request::builder()
        .uri(format!("ws://{addr}/ws"))
        .header("Host", addr.to_string())
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tungstenite::handshake::client::generate_key(),
        )
        .header("Authorization", format!("Bearer {token}"))
        .body(())
        .expect("要求を組み立てられること");
    tokio_tungstenite::connect_async(request)
        .await
        .map(|(socket, _)| socket)
}

/// upgrade の断りが 401 であることを見る。
fn assert_ws_unauthorized(result: Result<impl Sized, tungstenite::Error>, what: &str) {
    match result {
        Err(tungstenite::Error::Http(response)) => {
            assert_eq!(response.status().as_u16(), 401, "{what}");
        }
        Err(other) => panic!("{what}：401 ではない断られ方でした: {other:?}"),
        Ok(_) => panic!("{what}：通ってしまいました"),
    }
}

#[tokio::test]
async fn cliの札でrestが通り自分のカードだけが見える() {
    for backend in common::backends("tenancy-cli-rest").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let (theirs, _their_agent) = arena.tenant("よそのひと").await;
        let token =
            pairing::issue_token(&arena.db, mine.account_id, "CLI", pairing::TokenKind::Cli)
                .await
                .expect("札を発行できること");

        // 通る。そして絞り込み（§8-6）は Cookie の経路とまったく同じに効く
        let (status, body) = bearer_request(
            arena.addr,
            "GET",
            "/api/sessions".into(),
            token.clone(),
            None,
        )
        .await;
        assert_eq!(status, 200, "[{}] {body}", backend.name);
        let listed: Vec<SessionMeta> = serde_json::from_str(&body).expect("読めること");
        assert_eq!(listed.len(), 1, "[{}] 実際: {body}", backend.name);
        assert_eq!(listed[0].card_id, mine.card_id, "[{}]", backend.name);

        // 他人のカードは名指しでも、でたらめな綴りと**同じ言葉**で断られる
        let (their_status, their_body) = bearer_request(
            arena.addr,
            "GET",
            format!("/api/sessions/{}/transcript", theirs.card_id),
            token.clone(),
            None,
        )
        .await;
        let (unknown_status, unknown_body) = bearer_request(
            arena.addr,
            "GET",
            format!("/api/sessions/{}/transcript", CardId::new()),
            token.clone(),
            None,
        )
        .await;
        assert_eq!(their_status, 404, "[{}] {their_body}", backend.name);
        assert_eq!(their_status, unknown_status, "[{}]", backend.name);
        assert_eq!(
            their_body, unknown_body,
            "[{}] 断り方の差で実在を探れる",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn cliの札でwsも通る() {
    for backend in common::backends("tenancy-cli-ws").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let token =
            pairing::issue_token(&arena.db, mine.account_id, "CLI", pairing::TokenKind::Cli)
                .await
                .expect("札を発行できること");

        // upgrade も同じ middleware を通る（§5-1）。名乗り（Hello）まで届けば通っている
        let mut socket = cli_ws(arena.addr, &token)
            .await
            .expect("札で /ws へ繋げること");
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let next = tokio::time::timeout(remaining, socket.next())
                .await
                .unwrap_or_else(|_| panic!("[{}] Hello が届きませんでした", backend.name));
            match next {
                Some(Ok(tungstenite::Message::Text(text))) => {
                    if matches!(
                        serde_json::from_str::<ServerMessage>(&text),
                        Ok(ServerMessage::Hello { .. })
                    ) {
                        break;
                    }
                }
                Some(Ok(_)) => continue,
                other => panic!("[{}] Hello の前に切れました: {other:?}", backend.name),
            }
        }

        backend.finish().await;
    }
}

#[tokio::test]
async fn agentの札ではブラウザ側の口を通れない() {
    // 用途を分けた意味（§5-3）：PC の札が漏れても、鍵の内側の REST と `/ws` は開かない
    for backend in common::backends("tenancy-agent-kind").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let token =
            pairing::issue_token(&arena.db, mine.account_id, "PC", pairing::TokenKind::Agent)
                .await
                .expect("札を発行できること");

        let (status, body) = bearer_request(
            arena.addr,
            "GET",
            "/api/sessions".into(),
            token.clone(),
            None,
        )
        .await;
        assert_eq!(status, 401, "[{}] {body}", backend.name);
        assert_ws_unauthorized(
            cli_ws(arena.addr, &token).await,
            &format!("[{}] agent の札で /ws", backend.name),
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 他人のpcへ添付を置けない() {
    // `メッセージに画像を添付できるようにする` 設計§3-2。**書く口は帰属を必ず通る。**
    // 読む口（`GET /api/hosts/{host}/…`）と違い、こちらは相手のディスクへ痕跡を残すので、
    // すり抜けると「他人の機械にファイルを置ける」ことになる
    for backend in common::backends("tenancy-attach").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let (theirs, _their_agent) = arena.tenant("よそのひと").await;
        let browser = arena.browser(&mine).await;

        let their_agent_id = arena
            .registry
            .list(theirs.account_id)
            .first()
            .and_then(|meta| meta.agent_id)
            .expect("相手の PC が分かること");
        let my_agent_id = arena
            .registry
            .list(mine.account_id)
            .first()
            .and_then(|meta| meta.agent_id)
            .expect("自分の PC が分かること");

        let (status, body) = browser
            .request(
                "POST",
                &format!(
                    "/api/hosts/{their_agent_id}/attachments?card={}",
                    theirs.card_id
                ),
                Some("dummy"),
            )
            .await;
        assert!(
            status == 403 || status == 404,
            "[{}] 他人の PC へ添付を置けてしまった: {status} {body}",
            backend.name
        );

        // **自分の PC は帰属で断られない。** ここを見ないと、口が丸ごと壊れていても
        // 上の主張だけは通ってしまう
        let (status, body) = browser
            .request(
                "POST",
                &format!("/api/hosts/{my_agent_id}/attachments?card={}", mine.card_id),
                Some("dummy"),
            )
            .await;
        assert!(
            status != 403 && status != 404,
            "[{}] 自分の PC が帰属で断られた: {status} {body}",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn cliの札ではpcの受け口を通れない() {
    // 逆向きも同じ（§5-3）：CLI の札が漏れても `/agent/ws` は開かない
    for backend in common::backends("tenancy-cli-kind").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let token =
            pairing::issue_token(&arena.db, mine.account_id, "CLI", pairing::TokenKind::Cli)
                .await
                .expect("札を発行できること");

        let result =
            common::connect_agent(arena.addr, Some(&token), Some(protocol::a2s::A2S_PROTOCOL))
                .await
                .map(|_| ());
        assert_ws_unauthorized(result, &format!("[{}] cli の札で /agent/ws", backend.name));

        backend.finish().await;
    }
}

#[tokio::test]
async fn 失効した札では通らない() {
    for backend in common::backends("tenancy-cli-revoked").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let token =
            pairing::issue_token(&arena.db, mine.account_id, "CLI", pairing::TokenKind::Cli)
                .await
                .expect("札を発行できること");
        let owner = pairing::resolve_token(&arena.db, &token, pairing::TokenKind::Cli)
            .await
            .expect("引けること")
            .expect("有効であること");
        pairing::revoke_token(&arena.db, owner.token_id)
            .await
            .expect("失効させられること");

        let (status, body) = bearer_request(
            arena.addr,
            "GET",
            "/api/sessions".into(),
            token.clone(),
            None,
        )
        .await;
        assert_eq!(status, 401, "[{}] {body}", backend.name);

        backend.finish().await;
    }
}

#[tokio::test]
async fn 札が通らなくてもcookieへ落ちない() {
    // §5-2 の核心。ここが破れると、失効させた札の持ち主が**たまたま持っている
    // Cookie で通り続け**、「外した」が嘘になる
    for backend in common::backends("tenancy-cli-fallback").await {
        let arena = Arena::start(backend.db.clone()).await;
        let (mine, _mine_agent) = arena.tenant("わたし").await;
        let browser = arena.browser(&mine).await;

        // 前提の裏取り：この Cookie 単体なら通る
        let (status, _) = browser.get("/api/sessions").await;
        assert_eq!(status, 200, "[{}] 入館証が生きていること", backend.name);

        // でたらめな札＋生きた Cookie → 401（Cookie で拾い直さない）
        let (status, body) = bearer_request(
            arena.addr,
            "GET",
            "/api/sessions".into(),
            "adp_detarame".to_string(),
            Some(browser.cookie.clone()),
        )
        .await;
        assert_eq!(
            status, 401,
            "[{}] 札が通らないのに Cookie で通っている: {body}",
            backend.name
        );

        // 失効した札＋生きた Cookie も同じ
        let token =
            pairing::issue_token(&arena.db, mine.account_id, "CLI", pairing::TokenKind::Cli)
                .await
                .expect("札を発行できること");
        let owner = pairing::resolve_token(&arena.db, &token, pairing::TokenKind::Cli)
            .await
            .expect("引けること")
            .expect("有効であること");
        pairing::revoke_token(&arena.db, owner.token_id)
            .await
            .expect("失効させられること");
        let (status, body) = bearer_request(
            arena.addr,
            "GET",
            "/api/sessions".into(),
            token,
            Some(browser.cookie.clone()),
        )
        .await;
        assert_eq!(
            status, 401,
            "[{}] 失効した札が Cookie で生き返っている: {body}",
            backend.name
        );

        backend.finish().await;
    }
}
