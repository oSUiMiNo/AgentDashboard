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
use bytes::Bytes;
use futures_util::{SinkExt as _, StreamExt as _};
use protocol::{
    AgentId, CardId, PermissionMode,
    a2s::{A2S_PROTOCOL, A2S_VERSION, AgentMessage, Intervals, ServerToAgent},
    ws::ServerMessage,
};
use sea_orm::EntityTrait as _;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{broadcast, mpsc};
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

/// カード1枚ぶんの画面の中継（設計§7-4）。
///
/// # 誰が見ているかを数えるのはサーバの仕事
///
/// エージェントは「送れ」と言われたぶんだけ送る。**誰も見ていないときに止める**判断は、
/// 視聴者を知っている側——つまりここ——にしか下せない（要件5-2）。
///
/// 数えるのを個数ではなく **client_id の集合**にしてあるのは、同じ端末を開き直したとき
/// （`SubPty` が2回来る）に二重に数えないため。1つ多く数えたまま閉じると、
/// 誰も見ていないのに画面が流れ続ける。
struct ScreenRelay {
    viewers: Mutex<HashSet<u64>>,
    /// 最後に伝えた端末の大きさ。購読を出し直すときに要る
    size: Mutex<(u16, u16)>,
    /// ブラウザ向けに移し替えたフレーム
    frames: broadcast::Sender<Bytes>,
}

impl ScreenRelay {
    fn size(&self) -> (u16, u16) {
        *self.size.lock().expect("ロックが壊れていない")
    }
}

/// 画面1枚ぶんの配信待ち行列（フレーム数）。
///
/// 画面は最短でも 50ms 間隔（ホットウィンドウ。§7-5）なので、これで数秒ぶんにあたる。
/// 溢れた購読者は作り直しへ回す（[`RemoteAgent::pty_snapshot`]）。
const SCREEN_QUEUE_FRAMES: usize = 64;

/// 繋がっている PC の集まり。
///
/// **接続は DB に持たない**（§3-2）。ここに居るかどうかがそのまま「いま繋がっているか」で、
/// プロセスが落ちれば全部消える——落ちた瞬間の値が残らないのが、この置き方の狙い。
pub struct AgentHub {
    db: sea_orm::DatabaseConnection,
    registry: Arc<SessionRegistry>,
    conns: Mutex<HashMap<AgentId, Arc<AgentConn>>>,
    /// カードごとの画面の中継。**接続と同じくメモリだけに持つ**（誰が見ているかは
    /// このインスタンスの事実で、落ちれば消えるのが正しい。跨ぐ場合の合算は§9-4＝フェーズ6）
    screens: Mutex<HashMap<CardId, Arc<ScreenRelay>>>,
}

impl AgentHub {
    pub fn new(db: sea_orm::DatabaseConnection, registry: Arc<SessionRegistry>) -> Arc<Self> {
        Arc::new(Self {
            db,
            registry,
            conns: Mutex::new(HashMap::new()),
            screens: Mutex::new(HashMap::new()),
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

    /// カードの画面の中継を引く（無ければ作る）。
    fn screen(&self, card_id: CardId) -> Arc<ScreenRelay> {
        Arc::clone(
            self.screens
                .lock()
                .expect("ロックが壊れていない")
                .entry(card_id)
                .or_insert_with(|| {
                    let (frames, _) = broadcast::channel(SCREEN_QUEUE_FRAMES);
                    Arc::new(ScreenRelay {
                        viewers: Mutex::new(HashSet::new()),
                        size: Mutex::new((80, 24)),
                        frames,
                    })
                }),
        )
    }

    /// 見る人が増えた（§7-4）。
    fn add_viewer(
        &self,
        card_id: CardId,
        client_id: u64,
        cols: u16,
        rows: u16,
    ) -> broadcast::Receiver<Bytes> {
        let relay = self.screen(card_id);
        *relay.size.lock().expect("ロックが壊れていない") = (cols, rows);
        relay
            .viewers
            .lock()
            .expect("ロックが壊れていない")
            .insert(client_id);

        // **2人目以降でも頼み直す。** 配信は1本の流れを分けて配る形なので、後から
        // 入った端末は差分だけを受け取っても何も描けない。頼み直すと全画面から始まる。
        // 大きさも最後に開いた端末に合わせる（last-writer-wins。§7-4）
        self.request_screen(card_id, cols, rows);
        relay.frames.subscribe()
    }

    /// 見る人が減った。**誰も居なくなったときだけ**止める（§7-4）。
    fn remove_viewer(&self, card_id: CardId, client_id: u64) {
        let Some(relay) = self
            .screens
            .lock()
            .expect("ロックが壊れていない")
            .get(&card_id)
            .cloned()
        else {
            return;
        };
        let empty = {
            let mut viewers = relay.viewers.lock().expect("ロックが壊れていない");
            viewers.remove(&client_id);
            viewers.is_empty()
        };
        if empty && let Some(conn) = self.conn_for_card(card_id) {
            conn.send(&ServerToAgent::UnsubScreen { card_id });
        }
    }

    /// 画面を出して（出し直して）もらう。
    fn request_screen(&self, card_id: CardId, cols: u16, rows: u16) {
        if let Some(conn) = self.conn_for_card(card_id) {
            conn.send(&ServerToAgent::SubScreen {
                card_id,
                cols,
                rows,
            });
        }
    }

    /// 繋ぎ直した PC へ、いま見られているカードの購読を出し直す（§6-4）。
    ///
    /// エージェント側は切れた時点で全部止めている——**誰が見ているかを知っているのは
    /// こちら**なので、こちらから頼み直さないと画面が戻らない。
    fn resubscribe_screens(&self, agent_id: AgentId) {
        let watched: Vec<(CardId, (u16, u16))> = self
            .screens
            .lock()
            .expect("ロックが壊れていない")
            .iter()
            .filter(|(_, relay)| {
                !relay
                    .viewers
                    .lock()
                    .expect("ロックが壊れていない")
                    .is_empty()
            })
            .map(|(card_id, relay)| (*card_id, *relay.size.lock().expect("ロックが壊れていない")))
            .collect();

        for (card_id, (cols, rows)) in watched {
            // その PC のカードだけ。他人の PC のカードを頼んでも届かない
            if self.registry.get(card_id).and_then(|r| r.meta().agent_id) == Some(agent_id) {
                self.request_screen(card_id, cols, rows);
            }
        }
    }

    /// エージェントから届いた画面のフレームを、ブラウザ向けへ移し替えて配る（設計§4-3）。
    ///
    /// やることは**種別の移し替えと通し番号を剥がすこと**だけ。中身（エスケープ列）は
    /// 一切解釈しない——だからこそブラウザ側は1行も変わらない（§7-3）。
    fn deliver_screen(&self, bytes: &[u8]) {
        let frame = match protocol::frame::decode(bytes) {
            Ok(frame) => frame,
            Err(err) => {
                tracing::warn!("壊れた画面のフレームを受け取りました: {err}");
                return;
            }
        };
        if !matches!(
            frame.kind,
            protocol::frame::FrameKind::ScreenFull | protocol::frame::FrameKind::ScreenDiff
        ) {
            tracing::warn!(
                "エージェントから送られてよい種別ではありません: {:?}",
                frame.kind
            );
            return;
        }
        // 番号は**ここで剥がす**。ブラウザは知らないし、知る必要も無い（§4-3）
        let Ok((_seq, payload)) = protocol::frame::split_seq(frame.payload) else {
            tracing::warn!("番号の無い画面のフレームを受け取りました");
            return;
        };

        let Some(relay) = self
            .screens
            .lock()
            .expect("ロックが壊れていない")
            .get(&frame.card_id)
            .cloned()
        else {
            // 誰も見ていないカードの画面。止める指示と行き違ったぶんなので捨ててよい
            return;
        };
        let browser = protocol::frame::encode(frame.kind.to_browser(), frame.card_id, payload);
        let _ = relay.frames.send(Bytes::from(browser));
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

    /// 画面の配信を始める（設計§7-4）。
    ///
    /// 返すスナップショットは**空**である。リモートに「いまの生バイト」は存在せず、
    /// 画面はエージェントが作って送ってくるものだから——ここで空の 0x03（画面を消せ）を
    /// 返しておくと、直後に届く全画面がその上に描かれて辻褄が合う。
    fn subscribe_pty(
        &self,
        card_id: CardId,
        client_id: u64,
        cols: u16,
        rows: u16,
    ) -> Option<(bytes::Bytes, broadcast::Receiver<bytes::Bytes>)> {
        // 繋がっていない PC のカードは端末を開けない（開いても永久に空のまま）
        self.hub.conn_for_card(card_id)?;
        let frames = self.hub.add_viewer(card_id, client_id, cols, rows);
        let blank = bytes::Bytes::from(protocol::frame::encode(
            protocol::frame::FrameKind::PtySnapshot,
            card_id,
            b"",
        ));
        Some((blank, frames))
    }

    /// 取りこぼした端末を作り直す。
    ///
    /// **古い全画面を渡してはいけない。** その上に新しい差分が乗ると、画面は
    /// 「途中まで古い・途中から新しい」という壊れ方をする。一度消して、
    /// エージェントに全画面を出し直してもらうのが唯一正しい復帰になる（§7-4 のデシンク）。
    fn pty_snapshot(&self, card_id: CardId) -> Option<bytes::Bytes> {
        let (cols, rows) = self.hub.screen(card_id).size();
        self.hub.request_screen(card_id, cols, rows);
        Some(bytes::Bytes::from(protocol::frame::encode(
            protocol::frame::FrameKind::PtySnapshot,
            card_id,
            b"",
        )))
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

    /// 端末を閉じた・ブラウザが切れた。**忘れると誰も見ていない画面が流れ続ける。**
    fn release_client(&self, card_id: CardId, client_id: u64) {
        self.hub.remove_viewer(card_id, client_id);
    }

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
    // まだ見られている端末があれば、画面を出し直してもらう（§6-4）。エージェントは
    // 切れた時点で全部止めているので、**こちらから頼まないと画面が戻らない**
    hub.resubscribe_screens(agent_id);

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
        // 画面のフレーム（0x04 / 0x05）。種別を移し替えてブラウザへ流す（§4-3）
        Message::Binary(bytes) => {
            hub.deliver_screen(&bytes);
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
