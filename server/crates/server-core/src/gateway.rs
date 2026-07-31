//! エージェントの受け口（セルフホスト化設計§4-1・§6）。
//!
//! `GET /agent/ws` に PC 側から張られる WebSocket を受け、報告を記録層（[`crate::registry`]）
//! へ流し、ブラウザからの指示をそちらへ中継する。**接続の向きは常に PC → サーバ**なので、
//! サーバ側にクライアントは要らない（利用者の PC はたいてい NAT の内側にある）。
//!
//! # 入口で3つ確かめる
//!
//! 1. **版**（`Sec-WebSocket-Protocol` が [`A2S_PROTOCOL`] を含むか）。エージェントは
//!    利用者の PC にあり更新が遅れがちなので、**噛み合わない版は upgrade の前に断る**。
//!    繋がってから解釈できずに黙る、が一番たちが悪い
//! 2. **トークン**（`Authorization: Bearer`）。ハッシュ一致で `pairing_tokens` を引く
//! 3. **名乗り**（最初の [`AgentMessage::Hello`]）。ここで初めて PC の名前が分かるので、
//!    `agents` の行を引く（無ければ作る）のはこの後になる
//!
//! # 帰属は接続が決める
//!
//! 報告に何が書いてあっても、記録に残るアカウントと PC はこの接続のものになる
//! （[`ReportOrigin`]）。`.agent-dashboard.toml` に他人の名前を書いても通らないのは、
//! **見ているのが申告ではなく接続だから**（§8-5）。

use crate::{
    db::{self, pairing},
    registry::{ReportOrigin, SessionRegistry},
};
use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt as _, StreamExt as _};
use protocol::{
    AgentId, CardId, PermissionMode,
    a2s::{A2S_PROTOCOL, A2S_VERSION, AgentMessage, Intervals, ServerToAgent},
    ws::ServerMessage,
};
use sea_orm::EntityTrait as _;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;
use uuid::Uuid;

/// エージェント1接続あたりの送信待ち行列（メッセージ数）。
///
/// 溢れたら**捨てる**。ここを流れるのは指示（`SendInput` 等）で、届かなかったことは
/// 利用者にすぐ分かる（画面が動かない）。待って詰まらせると、他のエージェントへの
/// 中継まで巻き添えになる。履歴の欠落は逆側（A→S）の ack が守るので、ここには影響しない。
const OUTBOUND_QUEUE_MESSAGES: usize = 256;

/// 生存確認を送る間隔（設計§4-1）。
const PING_INTERVAL: Duration = Duration::from_secs(10);

/// 応答が途絶えてから切断とみなすまで（設計§4-1）。
///
/// TCP は**静かに死ぬ**（スリープ・電波断）。能動的に突いて確かめないと、
/// 「作業中」の表示のまま何時間も固まる（要件2-3 が正面から禁じている状態）。
const PING_TIMEOUT: Duration = Duration::from_secs(30);

/// 名乗り（Hello）を待つ上限。黙り込む接続を溜めないための門。
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// 繋がっている PC 1台ぶん。
pub struct AgentConn {
    pub agent_id: AgentId,
    pub account_id: Uuid,
    pub name: String,
    /// この PC の CLI が受け付ける権限モード（§21 読み替え1）。
    ///
    /// サーバモードにはローカルの CLI が居ないので、`GET /api/settings` の材料は
    /// ここから取る。持っていないと起動ボタンと権限モードの選択肢が空になる。
    pub available_modes: Vec<PermissionMode>,
    pub always_bypass_permissions: bool,
    outbound: mpsc::Sender<Message>,
}

impl AgentConn {
    /// 指示を1つ送る。**待たない**（届かなければ捨てる）。
    pub fn send(&self, message: &ServerToAgent) -> bool {
        match serde_json::to_string(message) {
            Ok(text) => self.outbound.try_send(Message::text(text)).is_ok(),
            Err(err) => {
                tracing::error!("指示をシリアライズできません: {err}");
                false
            }
        }
    }

    /// 生の入力（PTY のキー入力）を送る。
    pub fn send_binary(&self, bytes: Vec<u8>) -> bool {
        self.outbound
            .try_send(Message::Binary(bytes.into()))
            .is_ok()
    }
}

/// 繋がっている PC の集まり。
///
/// **接続は DB に持たない**（§3-2）。ここに居るかどうかがそのまま「いま繋がっているか」で、
/// プロセスが落ちれば全部消える——落ちた瞬間の値が残らないのが、この置き方の狙い。
pub struct AgentHub {
    db: sea_orm::DatabaseConnection,
    registry: Arc<SessionRegistry>,
    conns: Mutex<HashMap<AgentId, Arc<AgentConn>>>,
}

impl AgentHub {
    pub fn new(db: sea_orm::DatabaseConnection, registry: Arc<SessionRegistry>) -> Arc<Self> {
        Arc::new(Self {
            db,
            registry,
            conns: Mutex::new(HashMap::new()),
        })
    }

    pub fn registry(&self) -> &Arc<SessionRegistry> {
        &self.registry
    }

    pub fn db(&self) -> &sea_orm::DatabaseConnection {
        &self.db
    }

    /// 繋がっている PC を全部。
    pub fn connected(&self) -> Vec<Arc<AgentConn>> {
        self.conns
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .cloned()
            .collect()
    }

    pub fn conn(&self, agent_id: AgentId) -> Option<Arc<AgentConn>> {
        self.conns
            .lock()
            .expect("ロックが壊れていない")
            .get(&agent_id)
            .cloned()
    }

    /// そのカードを持っている PC。記録の `agent_id` から引く。
    pub fn conn_for_card(&self, card_id: CardId) -> Option<Arc<AgentConn>> {
        let agent_id = self.registry.get(card_id)?.meta().agent_id?;
        self.conn(agent_id)
    }

    /// 接続中の全 PC へ同じ指示を配る。
    pub fn broadcast(&self, message: &ServerToAgent) {
        for conn in self.connected() {
            conn.send(message);
        }
    }

    /// 間隔の設定を変え、**そのアカウントの PC へ即時に配る**（設計§13-3）。
    ///
    /// # 書いてから配る
    ///
    /// 保存が先なのは、**そのとき繋がっていなかった PC** のため。次に繋いだときの
    /// 名乗りの応答（Hello）で同じ値を受け取るので、配れなかったぶんもそこで揃う。
    /// 順序が逆だと、保存に失敗したのに配ってしまい、繋ぎ直した瞬間に古い値へ戻る。
    pub async fn set_intervals(
        &self,
        account_id: Uuid,
        intervals: db::settings::Intervals,
    ) -> Result<(), sea_orm::DbErr> {
        for (key, value) in [
            (
                db::settings::SYNC_INTERVAL_SECS,
                intervals.sync_interval_secs,
            ),
            (
                db::settings::SCREEN_INTERVAL_MS,
                intervals.screen_interval_ms,
            ),
            (db::settings::SCROLLBACK_LINES, intervals.scrollback_lines),
        ] {
            db::settings::put(&self.db, account_id, key, serde_json::json!(value)).await?;
        }

        let message = ServerToAgent::SetIntervals {
            intervals: to_protocol(intervals),
        };
        for conn in self.connected() {
            if conn.account_id == account_id {
                conn.send(&message);
            }
        }
        Ok(())
    }

    fn register(&self, conn: Arc<AgentConn>) -> Option<Arc<AgentConn>> {
        self.conns
            .lock()
            .expect("ロックが壊れていない")
            .insert(conn.agent_id, conn)
    }

    /// 自分の接続だけを外す。**入れ替わった後の掃除で新しい接続を消さない**ため、
    /// 誰が消すのかを送信口の同一性で確かめる。
    fn unregister(&self, conn: &Arc<AgentConn>) -> bool {
        let mut conns = self.conns.lock().expect("ロックが壊れていない");
        match conns.get(&conn.agent_id) {
            Some(current) if Arc::ptr_eq(current, conn) => {
                conns.remove(&conn.agent_id);
                true
            }
            _ => false,
        }
    }
}

/// ブラウザから見た「PC 側」を、A2S 越しのエージェントへ繋ぐ実装（設計§2-3）。
///
/// ローカルモードの `LocalAgent` と同じ口（[`AgentHost`]）を満たすので、**ブラウザ配信
/// （[`crate::ws`]）はどちらが向こうに居るかを知らない**。
///
/// # 届いたかどうかは返さない
///
/// 指示は fire-and-forget（§5-6）。切断中は届かず失われ、結果は `SessionUpsert` の
/// 再配信で返る。ack を足さないのは、**既存の操作と保証を揃える**ため——ローカルでも
/// 「押した結果は状態が変わることで分かる」という形になっている。
pub struct RemoteAgent {
    hub: Arc<AgentHub>,
}

impl RemoteAgent {
    pub fn new(hub: Arc<AgentHub>) -> Self {
        Self { hub }
    }

    /// そのカードを持つ PC へ1つ送る。居なければ理由を返す。
    fn relay(&self, card_id: CardId, message: ServerToAgent) -> Result<(), String> {
        let Some(conn) = self.hub.conn_for_card(card_id) else {
            return Err(NOT_CONNECTED.to_string());
        };
        conn.send(&message);
        Ok(())
    }
}

/// そのカードを持つ PC が居ないときの説明。
const NOT_CONNECTED: &str = "セッションが見つかりません（PC が繋がっていません）";

#[async_trait::async_trait]
impl crate::agent::AgentHost for RemoteAgent {
    fn exists(&self, card_id: CardId) -> bool {
        self.hub.conn_for_card(card_id).is_some()
    }

    fn spawn(&self, cwd: &str, permission_mode: Option<PermissionMode>) -> Result<(), String> {
        // **どの PC で起こすかを選ぶ口がまだ無い。** `ClientMessage::Spawn` に宛先が
        // 無く、選ぶ UI はフェーズ5（§11-2 の PC 名バッジと同時）。黙って1台目へ送ると
        // 意図しない PC でセッションが起きるので、迷う状況では断って理由を出す
        let connected = self.hub.connected();
        match connected.len() {
            1 => {
                connected[0].send(&ServerToAgent::Spawn {
                    cwd: cwd.to_string(),
                    permission_mode,
                });
                Ok(())
            }
            0 => Err("繋がっている PC がありません".to_string()),
            many => Err(format!(
                "どの PC で起動するか選べません（{many} 台が繋がっています）。PC の選択はこれから実装します"
            )),
        }
    }

    fn kill(&self, card_id: CardId) -> Result<(), String> {
        self.relay(card_id, ServerToAgent::Kill { card_id })
    }

    fn archive(&self, card_id: CardId) -> Result<(), String> {
        self.relay(card_id, ServerToAgent::Archive { card_id })
    }

    /// **リモートの端末はまだ開けない。**
    ///
    /// セルフホストモードの画面はエージェント内の端末エミュレータが作る（§7）ので、
    /// 生バイトの購読口は存在しない。ローカル用の経路をここで流用しないのは、
    /// §7-2 がそれを明確に否定しており、要件5-2（表示中のものだけ配る）とも衝突するため。
    fn subscribe_pty(
        &self,
        _card_id: CardId,
    ) -> Option<(bytes::Bytes, tokio::sync::broadcast::Receiver<bytes::Bytes>)> {
        None
    }

    fn pty_snapshot(&self, _card_id: CardId) -> Option<bytes::Bytes> {
        None
    }

    fn write_input(&self, card_id: CardId, bytes: &[u8]) -> Result<(), String> {
        let Some(conn) = self.hub.conn_for_card(card_id) else {
            return Err(NOT_CONNECTED.to_string());
        };
        // 生入力は JSON に包まずバイナリのまま運ぶ（設計§4-3）
        conn.send_binary(protocol::frame::encode(
            protocol::frame::FrameKind::PtyInput,
            card_id,
            bytes,
        ));
        Ok(())
    }

    fn resize(&self, card_id: CardId, cols: u16, rows: u16) {
        let _ = self.relay(
            card_id,
            ServerToAgent::Resize {
                card_id,
                cols,
                rows,
            },
        );
    }

    /// フロー制御はローカルの生バイト配信の仕組み（初期実装§10）。
    ///
    /// リモートでは画面を間隔で送る（§7-5）ので、詰まりを止める必要そのものが無い。
    fn set_flow(&self, _card_id: CardId, _client_id: u64, _paused: bool) {}

    fn release_client(&self, _card_id: CardId, _client_id: u64) {}

    /// パーサの健康状態は**エージェントから届く**（`ParserStatus`）ので、サーバは
    /// 持っていない。購読を始めた瞬間に縮退を知らせることはできないが、次の変化で届く。
    fn parser_state(&self) -> Option<protocol::ws::ParserState> {
        None
    }

    async fn send_input(&self, card_id: CardId, text: String) -> Result<(), String> {
        self.relay(card_id, ServerToAgent::SendInput { card_id, text })
    }

    async fn set_permission_mode(
        &self,
        card_id: CardId,
        mode: PermissionMode,
    ) -> Result<(), String> {
        self.relay(card_id, ServerToAgent::SetPermissionMode { card_id, mode })
    }

    async fn set_model(&self, card_id: CardId, model: protocol::ModelId) -> Result<(), String> {
        self.relay(card_id, ServerToAgent::SetModel { card_id, model })
    }
}

/// エージェント向けのルート。**ブラウザ向け（[`crate::routes`]）とは別に合成する。**
///
/// 分けてあるのは、セルフホストモードでこの2つが別の経路（リバースプロキシの
/// 別ロケーション）に置かれうるため（設計§14-2 の「WS が2パス」）。
pub fn agent_routes(hub: Arc<AgentHub>) -> axum::Router {
    axum::Router::new()
        .route("/agent/ws", axum::routing::get(agent_ws_handler))
        .with_state(hub)
}

pub async fn agent_ws_handler(
    State(hub): State<Arc<AgentHub>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    // 1. 版。**upgrade の前に断る**ので、古いエージェントは接続の時点で理由を受け取れる
    if !requests_protocol(&headers, A2S_PROTOCOL) {
        tracing::warn!("知らない版のエージェントを断りました");
        return (
            StatusCode::BAD_REQUEST,
            format!("対応していないプロトコルです（このサーバは {A2S_PROTOCOL}）"),
        )
            .into_response();
    }

    // 2. トークン。**理由は区別して返さない**（総当たりに手掛かりを与えない）
    let Some(token) = bearer_token(&headers) else {
        return (StatusCode::UNAUTHORIZED, "ペアリングトークンが要ります").into_response();
    };
    let owner = match pairing::resolve_token(&hub.db, &token).await {
        Ok(Some(owner)) => owner,
        Ok(None) => {
            tracing::warn!("認められないペアリングトークンで接続を試みられました");
            return (StatusCode::UNAUTHORIZED, "ペアリングトークンが不正です").into_response();
        }
        Err(err) => {
            tracing::error!("トークンを照合できません: {err}");
            return (StatusCode::SERVICE_UNAVAILABLE, "記録を読めません").into_response();
        }
    };

    let account = match db::entity::accounts::Entity::find_by_id(owner.account_id)
        .one(&hub.db)
        .await
    {
        Ok(Some(row)) => row.name,
        _ => String::new(),
    };

    upgrade
        .protocols([A2S_PROTOCOL])
        .on_upgrade(move |socket| agent_loop(hub, owner.account_id, account, socket))
}

/// `Sec-WebSocket-Protocol` に目的の版が含まれるか。
///
/// ヘッダを自分で読むのは、**「知らない版なら断る」を upgrade の前に置くため**。
/// axum の `protocols()` は合うものを選ぶだけで、合わなくても接続は成立してしまう。
fn requests_protocol(headers: &HeaderMap, wanted: &str) -> bool {
    headers
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim() == wanted)
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))?;
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_string())
}

async fn agent_loop(hub: Arc<AgentHub>, account_id: Uuid, account_name: String, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (outbound, mut outbound_rx) = mpsc::channel::<Message>(OUTBOUND_QUEUE_MESSAGES);

    // WebSocket への書き込み口はこのタスクだけ（ブラウザ側の client_loop と同じ作り）
    let writer = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    // 3. 名乗りを待つ。ここで PC の名前が分かって初めて `agents` の行が引ける
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, next_hello(&mut stream)).await {
        Ok(Some(hello)) => hello,
        Ok(None) => {
            tracing::warn!("名乗りの前に切れました");
            writer.abort();
            return;
        }
        Err(_) => {
            tracing::warn!("{HELLO_TIMEOUT:?} 以内に名乗りがありませんでした");
            writer.abort();
            return;
        }
    };

    let AgentMessage::Hello {
        protocol_version,
        agent_version,
        agent_name,
        available_modes,
        always_bypass_permissions,
    } = hello
    else {
        // next_hello が Hello 以外を返すことはない
        writer.abort();
        return;
    };

    if protocol_version != A2S_VERSION {
        // 版はサブプロトコルで交渉済みなので、ここへ来るのは実装の食い違い
        tracing::warn!("版が噛み合いません（server={A2S_VERSION} / agent={protocol_version}）");
        writer.abort();
        return;
    }

    let agent_id = match pairing::ensure_agent(&hub.db, account_id, &agent_name).await {
        Ok(agent_id) => agent_id,
        Err(err) => {
            tracing::error!("PC を登録できません: {err}");
            writer.abort();
            return;
        }
    };

    let conn = Arc::new(AgentConn {
        agent_id,
        account_id,
        name: agent_name.clone(),
        available_modes,
        always_bypass_permissions,
        outbound: outbound.clone(),
    });
    // 同じ PC が繋ぎ直してきた場合、古い接続は**静かに置き換える**。半分死んだ TCP を
    // 掴んだまま新しい接続を断ると、その PC は二度と繋がらなくなる
    if hub.register(Arc::clone(&conn)).is_some() {
        tracing::info!(%agent_id, %agent_name, "同じ PC の接続を置き換えました");
    }
    tracing::info!(%agent_id, %agent_name, %agent_version, "PC が接続しました");

    let intervals = intervals_for(&hub, account_id).await;
    conn.send(&ServerToAgent::Hello {
        protocol_version: A2S_VERSION,
        server_version: env!("CARGO_PKG_VERSION").to_string(),
        agent_id,
        intervals,
    });

    let origin = ReportOrigin {
        account_id,
        agent_id: Some(agent_id),
        account: (!account_name.is_empty()).then_some(account_name),
    };
    // 前回の記録が残っているカードは、報告が来るまで「接続していない」ままにしておく。
    // 全セッションの SessionUpsert が復帰手順（§6-4）で必ず来るので、生きているものは
    // そこで印が戻る
    hub.registry.set_agent_live(agent_id, false);

    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_seen = tokio::time::Instant::now();

    loop {
        tokio::select! {
            incoming = stream.next() => match incoming {
                Some(Ok(message)) => {
                    last_seen = tokio::time::Instant::now();
                    if !handle_message(&hub, &conn, &origin, message).await {
                        break;
                    }
                }
                // 相手が畳んだ、または壊れたフレーム
                _ => break,
            },

            _ = ping.tick() => {
                if last_seen.elapsed() > PING_TIMEOUT {
                    // TCP の静かな死。**能動的に切る**ことで、カードに接続断の印が付く
                    tracing::warn!(%agent_id, "{PING_TIMEOUT:?} 応答がないので切断します");
                    break;
                }
                if outbound.try_send(Message::Ping(bytes::Bytes::new())).is_err() {
                    break;
                }
            }
        }
    }

    if hub.unregister(&conn) {
        // 置き換えられた古い接続は掃除しない（新しい接続が生きているため）
        hub.registry.set_agent_live(agent_id, false);
        tracing::info!(%agent_id, %agent_name, "PC が切断しました");
    }
    drop(outbound);
    writer.abort();
}

/// 最初の [`AgentMessage::Hello`] だけを待つ。それ以外は読み飛ばす。
async fn next_hello(
    stream: &mut futures_util::stream::SplitStream<WebSocket>,
) -> Option<AgentMessage> {
    while let Some(Ok(message)) = stream.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        match serde_json::from_str::<AgentMessage>(&text) {
            Ok(hello @ AgentMessage::Hello { .. }) => return Some(hello),
            Ok(other) => {
                tracing::warn!("名乗りより先に別の報告が来ました: {other:?}");
            }
            Err(err) => tracing::warn!("エージェントの報告を解釈できません: {err}"),
        }
    }
    None
}

/// 1通処理する。`false` を返したら接続を畳む。
async fn handle_message(
    hub: &Arc<AgentHub>,
    conn: &Arc<AgentConn>,
    origin: &ReportOrigin,
    message: Message,
) -> bool {
    match message {
        Message::Text(text) => {
            let report = match serde_json::from_str::<AgentMessage>(&text) {
                Ok(report) => report,
                // 知らない報告で接続ごと落とさない。版交渉を通っているので、
                // これは「新しいエージェントが増やした知らせ」でありうる
                Err(err) => {
                    tracing::warn!("エージェントの報告を解釈できません: {err}");
                    return true;
                }
            };
            handle_report(hub, conn, origin, report).await;
            true
        }
        // 画面のフレーム（0x04 / 0x05）。**中身の扱いはフェーズ4**
        Message::Binary(bytes) => {
            tracing::debug!("画面のフレームを受け取りました（{} バイト）", bytes.len());
            true
        }
        Message::Close(_) => false,
        // Ping への応答は axum が自動で返す。Pong は生存の証拠として時刻の更新だけに使う
        _ => true,
    }
}

async fn handle_report(
    hub: &Arc<AgentHub>,
    conn: &Arc<AgentConn>,
    origin: &ReportOrigin,
    report: AgentMessage,
) {
    match report {
        // 2度目の名乗りは、再接続ではなく実装の食い違い。無視して続ける
        AgentMessage::Hello { .. } => {}

        AgentMessage::SessionUpsert { session } => {
            hub.registry
                .apply(origin, ServerMessage::SessionUpsert { session })
                .await;
        }
        AgentMessage::SessionRemoved { card_id } => {
            hub.registry
                .apply(origin, ServerMessage::SessionRemoved { card_id })
                .await;
        }
        AgentMessage::Status {
            card_id,
            status,
            subagent_active,
            last_activity_at,
        } => {
            hub.registry
                .apply(
                    origin,
                    ServerMessage::Status {
                        card_id,
                        status,
                        subagent_active,
                        last_activity_at,
                    },
                )
                .await;
        }

        // **書けたときだけ ack を返す**（設計§6-1）。返さないことが「まだ書けていない」
        // の合図になり、エージェントは持っているぶんを再送する
        AgentMessage::TranscriptBatch {
            batch_id,
            card_id,
            nodes,
        } => {
            if hub
                .registry
                .apply(origin, ServerMessage::TranscriptAppend { card_id, nodes })
                .await
            {
                conn.send(&ServerToAgent::BatchAck { batch_id });
            }
        }
        AgentMessage::TranscriptReset { batch_id, card_id } => {
            if hub
                .registry
                .apply(origin, ServerMessage::TranscriptReset { card_id })
                .await
            {
                conn.send(&ServerToAgent::BatchAck { batch_id });
            }
        }

        AgentMessage::ParserStatus { state, detail } => {
            hub.registry
                .apply(origin, ServerMessage::ParserStatus { state, detail })
                .await;
        }
        AgentMessage::Selfheal { phase, detail } => {
            hub.registry
                .apply(origin, ServerMessage::Selfheal { phase, detail })
                .await;
        }
        AgentMessage::Error { card_id, message } => {
            hub.registry
                .apply(origin, ServerMessage::Error { card_id, message })
                .await;
        }

        AgentMessage::ModelTable {
            cli_version,
            catalog,
            aliases,
        } => {
            let table = serde_json::json!({
                "cli_version": cli_version,
                "catalog": catalog,
                "aliases": aliases,
            });
            if let Err(err) = pairing::save_model_table(&hub.db, conn.agent_id, table).await {
                tracing::error!("モデルの表を保存できません: {err}");
            }
        }
    }
}

/// この接続へ渡す間隔（設計§13-3）。読めなければ既定で進む。
///
/// ここで諦めて接続ごと断らないのは、**間隔は動作の本質ではない**ため。読めなかった
/// ときに繋がらないより、既定で動いて設定変更を待つほうが害が小さい。
pub async fn intervals_for(hub: &Arc<AgentHub>, account_id: Uuid) -> Intervals {
    let stored = db::settings::intervals(&hub.db, account_id)
        .await
        .unwrap_or_else(|err| {
            tracing::warn!("設定を読めないので既定で進めます: {err}");
            db::settings::Intervals::default()
        });
    to_protocol(stored)
}

/// DB の設定を A2S の形へ移す。
pub fn to_protocol(stored: db::settings::Intervals) -> Intervals {
    Intervals {
        sync_secs: stored.sync_interval_secs,
        screen_ms: stored.screen_interval_ms,
        scrollback_lines: stored.scrollback_lines as usize,
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn 版はカンマ区切りの中からでも見つける() {
        // ブラウザや中継が複数の候補を並べて送ってくることがある
        let mut headers = HeaderMap::new();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("adash-a2s-v0, adash-a2s-v1"),
        );
        assert!(requests_protocol(&headers, A2S_PROTOCOL));

        let mut headers = HeaderMap::new();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("adash-a2s-v0"),
        );
        assert!(
            !requests_protocol(&headers, A2S_PROTOCOL),
            "知らない版だけなら断ること"
        );

        assert!(
            !requests_protocol(&HeaderMap::new(), A2S_PROTOCOL),
            "名乗りが無いものも断ること"
        );
    }

    #[test]
    fn トークンはBearerの後ろだけを取る() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer adp_xyz"),
        );
        assert_eq!(bearer_token(&headers), Some("adp_xyz".to_string()));

        // 種別が違うものは受け取らない（Basic 認証のヘッダを流用させない）
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer_token(&headers), None);

        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer  "));
        assert_eq!(bearer_token(&headers), None, "空のトークンは無いのと同じ");
    }
}
