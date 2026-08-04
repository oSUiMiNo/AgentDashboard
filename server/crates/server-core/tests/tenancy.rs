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
//! | REST 全エンドポイント | 他人のカードの一覧・履歴を要求する |
//! | WS 購読 | `SubTranscript` / `SubPty` を他人のカードへ出す |
//! | WS 操作 | `Kill` / `Archive` / `SetModel` / `SetPermissionMode` / `SendInput` / `Resize` / `PtyFlow` / 生の入力 / `Spawn`（他人の PC 宛て）を出す |
//! | A2S | 自分の接続から**他人の card_id** を報告する |
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
use server_core::{db::pairing, gateway::SessionHostHub, registry::SessionRegistry};
use std::{net::SocketAddr, sync::Arc, time::Duration};
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
    task: tokio::task::JoinHandle<()>,
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
        let agent: Arc<dyn server_core::agent::SessionHost> = Arc::new(
            server_core::gateway::RemoteSessionHost::new(Arc::clone(&hub)),
        );
        let ws_state =
            server_core::ws::AppState::new(agent, Arc::clone(&registry), Arc::clone(&config));

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
        let token = pairing::issue_token(&self.db, account_id, "テスト")
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
        let token = pairing::issue_token(&backend.db, account_id, "捨てる予定")
            .await
            .expect("発行できること");
        let token_id = pairing::resolve_token(&backend.db, &token)
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
            let token = pairing::issue_token(&backend.db, account_id, name)
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
