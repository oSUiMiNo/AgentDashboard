//! セッションホストの受け口（セルフホスト化設計§4-1・§6）。
//!
//! `GET /agent/ws` に PC 側から張られる WebSocket を受け、報告を記録層（[`crate::registry`]）
//! へ流し、ブラウザからの指示をそちらへ中継する。**接続の向きは常に PC → サーバ**なので、
//! サーバ側にクライアントは要らない（利用者の PC はたいてい NAT の内側にある）。
//!
//! # 入口で3つ確かめる
//!
//! 1. **版**（`Sec-WebSocket-Protocol` が [`A2S_PROTOCOL`] を含むか）。セッションホストは
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
    bus::{self, BusState},
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
use base64::Engine as _;
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

/// セッションホスト1接続あたりの送信待ち行列（メッセージ数）。
///
/// 溢れたら**捨てる**。ここを流れるのは指示（`SendInput` 等）で、届かなかったことは
/// 利用者にすぐ分かる（画面が動かない）。待って詰まらせると、他のセッションホストへの
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

/// 「この PC はうちに繋がっている」と記し直す間隔（設計§9-4）。
pub const PRESENCE_INTERVAL: Duration = Duration::from_secs(10);
/// 記してから、これだけ経った印は死んだものとみなす（ミリ秒）。
///
/// 記す間隔の3倍にしてある。1回の取りこぼしで消えると、**繋がっているのに
/// 「居ない」と見える**時間ができる。**読む側（記録層）と同じ値を使う。**
use crate::registry::PRESENCE_TTL_MS;
/// 視聴の印も同じ寿命で扱う（設計§9-4 の「30 秒以内に自然に掃除される」）。
const VIEWING_TTL_MS: i64 = 30_000;

/// 繋がっている PC 1台ぶん。
pub struct AgentConn {
    pub agent_id: AgentId,
    pub account_id: Uuid,
    /// この接続を認めたトークン（設計§8-4）。
    ///
    /// **失効を接続中にも効かせるため**に持つ。外したはずの PC が繋がり続けるなら、
    /// 失効はほとんど意味を持たない（次に切れるまで待つことになる）。
    pub token_id: Uuid,
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

    /// この接続を畳ませる（設計§8-4 の「接続中なら切断」）。
    ///
    /// 待ち行列へ Close を積むだけ。**こちらから TCP を殴らない**のは、送信タスクが
    /// 積まれた指示を書き終えてから畳むほうが、相手にとって理由の分かる終わり方に
    /// なるため。
    pub fn disconnect(&self) {
        let _ = self.outbound.try_send(Message::Close(None));
    }
}

/// その PC の CLI ができること（設計§9-2）。
///
/// 名乗り（Hello）で届き、`agents.capabilities` へ JSON のまま入る。**インスタンスを
/// 跨いでも見えるように**保存する——メモリにだけ持つと、ブラウザが繋がったインスタンスに
/// その PC が居ないときに起動ボタンの選択肢が空になる。
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct Capabilities {
    #[serde(default)]
    pub available_modes: Vec<PermissionMode>,
    #[serde(default)]
    pub always_bypass_permissions: bool,
    /// その PC のセッションホストの版（CICD設計§16）。
    ///
    /// 名乗りには最初から載っていたが、ログへ出て消えていた。**ここへ写すだけで
    /// 画面まで運べる**——この列はサーバが解釈しない JSON なので、記録の形も
    /// A2S の形も変えずに済む。
    ///
    /// 古い行には無いので `Option`。**「まだ名乗っていない」と「持っていない」を
    /// 同じ形で表す**（どちらも画面では「不明」）。
    #[serde(default)]
    pub agent_version: Option<String>,
}

/// 他インスタンスから回ってくる、PC への指示（設計§9-2 の `agent:{id}:cmd`）。
///
/// # なぜ A2S の型をそのまま流さないのか
///
/// 生の入力（キー打鍵）は JSON に包まずバイナリで運ぶ約束（設計§4-3）なので、
/// `ServerToAgent` には入る場所が無い。**そのために A2S へ変種を足すと、
/// セッションホストが知らなくてよいものを共有境界へ持ち込む**ことになる。ここは
/// サーバ同士の内輪の取り決めなので、server-core の中で完結させる。
///
/// 生入力は数十バイトなので base64 で内包してよい（設計§9-2 の但し書き。
/// base64 を禁じているのは大容量の PTY 出力に対する規約）。
///
/// # 種別を「隣」に置く理由
///
/// 中に入る [`ServerToAgent`] も種別を `t` という名前で持っている。同じ入れ物へ
/// 混ぜる書き方（internally tagged）にすると**内側の `t` が外側の `t` を上書きし、
/// 読み直せなくなる**。しかもエラーにならず、届かないだけという形で出る。
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "body", rename_all = "snake_case")]
pub enum AgentCommand {
    /// JSON の指示そのまま
    Message(Box<ServerToAgent>),
    /// PTY への生入力（フレームごと base64）
    Input { data: String },
}

/// カード1枚ぶんの画面の中継（設計§7-4）。
///
/// # 誰が見ているかを数えるのはサーバの仕事
///
/// セッションホストは「送れ」と言われたぶんだけ送る。**誰も見ていないときに止める**判断は、
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
    /// 次に来るはずの通し番号（連絡係から受け取る側だけが使う。設計§9-3）。
    ///
    /// **同じインスタンスの PC から直に届く分には要らない**——そちらは TCP なので
    /// 途中が消えない。消えうるのは pub/sub を挟んだときだけ（at-most-once）。
    expected_seq: Mutex<Option<u64>>,
    /// 出し直しを待っている間は中継しない（設計§9-3）。
    ///
    /// 飛んだ後の差分をそのまま流すと、**画面は動いているのに中身が壊れている**という
    /// 一番気づきにくい形になる。全画面が来るまで捨てるほうが正しい。
    stalled: std::sync::atomic::AtomicBool,
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
    /// このインスタンスの事実で、落ちれば消えるのが正しい。インスタンスを跨いだ
    /// 合算は連絡係の視聴リースで行う。§9-4）
    screens: Mutex<HashMap<CardId, Arc<ScreenRelay>>>,
    /// いま PC に画面を作らせているカード（設計§9-4 の掃除の対象）。
    ///
    /// **数えるのはここに居るカードだけ。** 全カードを10秒ごとに数えると、遊んでいる
    /// カードの数だけ連絡係へ問い合わせが出る。
    streaming: Mutex<HashSet<CardId>>,
}

impl AgentHub {
    pub fn new(db: sea_orm::DatabaseConnection, registry: Arc<SessionRegistry>) -> Arc<Self> {
        Arc::new(Self {
            db,
            registry,
            conns: Mutex::new(HashMap::new()),
            screens: Mutex::new(HashMap::new()),
            streaming: Mutex::new(HashSet::new()),
        })
    }

    pub fn registry(&self) -> &Arc<SessionRegistry> {
        &self.registry
    }

    pub fn db(&self) -> &sea_orm::DatabaseConnection {
        &self.db
    }

    /// **どこかのインスタンスに**繋がっている PC を全部（設計§9-4）。
    ///
    /// 自分の接続表と、連絡係に置かれた印を合わせる。印は置いた側が10秒ごとに
    /// 記し直すので、**インスタンスが異常終了しても古くなって自然に消える**——
    /// 落ちた瞬間に誰かが片付ける必要が無いのがこの持ち方の狙い。
    pub async fn online(&self) -> Vec<AgentId> {
        let mut ids: Vec<AgentId> = self.connected().iter().map(|conn| conn.agent_id).collect();
        let Some(bus) = self.registry.bus() else {
            return ids;
        };
        let cutoff = db::now_ms() - PRESENCE_TTL_MS;
        match bus.lease_members(bus::agents_online(), cutoff).await {
            Ok(members) => {
                for member in members {
                    let Ok(id) = member.parse().map(AgentId) else {
                        continue;
                    };
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
            }
            // 読めないなら自分の分だけで答える。**繋がっている PC を隠すより、
            // 他インスタンスの分が見えないほうが害が小さい**（操作は断られるだけ）
            Err(err) => tracing::warn!("繋がっている PC を数えられません: {err}"),
        }
        ids
    }

    /// そのアカウントの、どこかに繋がっている PC。
    ///
    /// 印はアカウントで分けていないので、**DB の `agents` と突き合わせて絞る**
    /// （§8-6 の絞り込みは DB 側で効かせる）。
    pub async fn online_of(&self, account_id: Uuid) -> Vec<AgentId> {
        let online = self.online().await;
        let mine = pairing::agent_names(&self.db, account_id)
            .await
            .unwrap_or_default();
        mine.into_iter()
            .map(|(id, _)| id)
            .filter(|id| online.contains(id))
            .collect()
    }

    /// 自分の接続表にある PC を「繋がっている」と記し直す。
    async fn touch_presence(&self) {
        let Some(bus) = self.registry.bus() else {
            return;
        };
        let now = db::now_ms();
        for conn in self.connected() {
            if let Err(err) = bus
                .lease_touch(bus::agents_online(), &conn.agent_id.0.to_string(), now)
                .await
            {
                tracing::warn!(agent_id = %conn.agent_id, "在席を記せません: {err}");
            }
        }
    }

    /// 印を消す（切断したとき）。
    async fn release_presence(&self, agent_id: AgentId) {
        let Some(bus) = self.registry.bus() else {
            return;
        };
        let _ = bus
            .lease_release(bus::agents_online(), &agent_id.0.to_string())
            .await;
    }

    /// 在席を記し続ける見張りを始める（連絡係が居るときだけ）。
    pub fn start_presence(self: &Arc<Self>) {
        if self.registry.bus().is_none() {
            return;
        }
        let hub = Arc::clone(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(PRESENCE_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                hub.touch_presence().await;
            }
        });
    }

    /// 他インスタンスに繋がっている PC へ指示を回す（設計§9-2）。
    ///
    /// **黙って落とさない。** 届かない理由を返せば画面に出る——押したのに何も
    /// 起きない状態が一番たちが悪い。
    pub fn relay_across(&self, agent_id: AgentId, command: AgentCommand) -> Result<(), String> {
        let Some(bus) = self.registry.bus() else {
            return Err(NOT_CONNECTED.to_string());
        };
        if *bus.state().borrow() == BusState::Degraded {
            return Err(
                "この PC は別のインスタンスに繋がっています（連絡係が切れているため、いま指示を届けられません）"
                    .to_string(),
            );
        }
        bus.publish(
            &bus::agent_cmd(agent_id),
            bus::encode_json(self.registry.instance_id(), &command),
        );
        Ok(())
    }

    /// 「いま持っているカードを名乗り直してほしい」に応える（設計§6-4 のサーバ版）。
    ///
    /// **自分に繋がっている PC のカードだけ**を名乗る。他インスタンスから回ってきて
    /// 手元に写しがあるだけのカードまで名乗ると、同じことを全員が言い合うことになる。
    pub fn reannounce(&self, account_id: Uuid) {
        let mine: Vec<AgentId> = self
            .connected()
            .iter()
            .filter(|conn| conn.account_id == account_id)
            .map(|conn| conn.agent_id)
            .collect();
        for agent_id in mine {
            for card_id in self.registry.cards_of(agent_id) {
                if let Some(record) = self.registry.get(card_id) {
                    self.registry.announce_card(account_id, record.meta());
                }
            }
        }
    }

    /// 他インスタンスから回ってきた指示を、自分が持っている接続へ渡す。
    ///
    /// その PC を持っていなければ**何もしない**。宛先ごとにチャネルが分かれているので
    /// 通常は届かないが、置き換わった直後などに行き違うことがある。
    pub fn deliver_command(&self, agent_id: AgentId, command: AgentCommand) {
        let Some(conn) = self.conn(agent_id) else {
            return;
        };
        match command {
            AgentCommand::Message(message) => {
                // 別のインスタンスから頼まれた画面も**掃除の対象に入れる**。
                // 入れ忘れると、頼んだ側が落ちたときに誰も止められなくなる
                self.note_streaming(&message);
                conn.send(&message);
            }
            AgentCommand::Input { data } => {
                match base64::engine::general_purpose::STANDARD.decode(&data) {
                    Ok(bytes) => {
                        conn.send_binary(bytes);
                    }
                    Err(err) => tracing::warn!("跨ぎで届いた入力を読めません: {err}"),
                }
            }
        }
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
        db::settings::put_intervals(&self.db, account_id, intervals).await?;

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
                        expected_seq: Mutex::new(None),
                        // **全画面が来るまでは何も流さない。** 途中の差分から始めると、
                        // 何も描かれていない画面に部分的な書き換えが乗る
                        stalled: std::sync::atomic::AtomicBool::new(true),
                    })
                }),
        )
    }

    /// 見る人が増えた（§7-4）。
    fn add_viewer(
        self: &Arc<Self>,
        card_id: CardId,
        client_id: u64,
        cols: u16,
        rows: u16,
    ) -> broadcast::Receiver<Bytes> {
        let relay = self.screen(card_id);
        *relay.size.lock().expect("ロックが壊れていない") = (cols, rows);
        let first = {
            let mut viewers = relay.viewers.lock().expect("ロックが壊れていない");
            viewers.insert(client_id);
            viewers.len() == 1
        };

        if first && let Some(bus) = self.registry.bus() {
            // その PC が別のインスタンスに繋がっている場合、画面はここへ流れてくる
            bus.subscribe(&bus::card_screen(card_id));
            // 「うちにも見ている人が居る」と記す。**待たない**——数えるのに
            // 端末を開く手を止めさせない
            let hub = Arc::clone(self);
            tokio::spawn(async move { hub.touch_viewing(card_id).await });
        }

        // **2人目以降でも頼み直す。** 配信は1本の流れを分けて配る形なので、後から
        // 入った端末は差分だけを受け取っても何も描けない。頼み直すと全画面から始まる。
        // 大きさも最後に開いた端末に合わせる（last-writer-wins。§7-4）
        self.request_screen(card_id, cols, rows);
        relay.frames.subscribe()
    }

    /// 見る人が減った。**誰も居なくなったときだけ**止める（§7-4）。
    ///
    /// 連絡係が居るときは、止めてよいかを**他のインスタンスと合算して**決める
    /// （§9-4）。手元が空になっただけで止めると、別のインスタンスで見ている人の
    /// 画面が黙って止まる。
    fn remove_viewer(self: &Arc<Self>, card_id: CardId, client_id: u64) {
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
        if !empty {
            return;
        }
        match self.registry.bus() {
            None => self.request_unsub(card_id),
            Some(bus) => {
                bus.unsubscribe(&bus::card_screen(card_id));
                let hub = Arc::clone(self);
                tokio::spawn(async move { hub.release_viewing(card_id).await });
            }
        }
    }

    /// 「うちにも見ている人が居る」と記す（§9-4）。
    async fn touch_viewing(&self, card_id: CardId) {
        let Some(bus) = self.registry.bus() else {
            return;
        };
        let member = self.registry.instance_id().to_string();
        if let Err(err) = bus
            .lease_touch(&bus::screen_viewers(card_id), &member, db::now_ms())
            .await
        {
            tracing::warn!(%card_id, "視聴の印を置けません: {err}");
        }
    }

    /// 印を消し、**他に見ている人が居なければ**止めさせる（§9-4）。
    async fn release_viewing(self: Arc<Self>, card_id: CardId) {
        let Some(bus) = self.registry.bus() else {
            return;
        };
        let member = self.registry.instance_id().to_string();
        let key = bus::screen_viewers(card_id);
        let _ = bus.lease_release(&key, &member).await;
        match bus.lease_sweep(&key, db::now_ms() - VIEWING_TTL_MS).await {
            Ok(0) => self.request_unsub(card_id),
            // 数えられないなら止めない。**止めて画面が消えるより、余分に流れるほうが
            // 害が小さい**（利用者から見て「壊れた」に見えるのは前者）
            Ok(_) => {}
            Err(err) => tracing::warn!(%card_id, "見ている人を数えられません: {err}"),
        }
    }

    /// 見ている人が居るあいだ、印を記し直す（§9-4）。
    async fn touch_viewings(&self) {
        let watched: Vec<CardId> = self
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
            .map(|(card_id, _)| *card_id)
            .collect();
        for card_id in watched {
            self.touch_viewing(card_id).await;
        }
    }

    /// 送らせているカードのうち、誰も見ていないものを止める（§9-4）。
    ///
    /// **異常終了したインスタンスの掃除がここで効く。** 明示的な解放を待たない作りなので、
    /// 落ちた側の印はただ古くなり、30秒以内にここで落ちる。
    async fn sweep_viewings(self: &Arc<Self>) {
        let Some(bus) = self.registry.bus() else {
            return;
        };
        let streaming: Vec<CardId> = self
            .streaming
            .lock()
            .expect("ロックが壊れていない")
            .iter()
            .copied()
            .collect();
        for card_id in streaming {
            let key = bus::screen_viewers(card_id);
            match bus.lease_sweep(&key, db::now_ms() - VIEWING_TTL_MS).await {
                Ok(0) => self.request_unsub(card_id),
                Ok(_) => {}
                Err(err) => tracing::warn!(%card_id, "見ている人を数えられません: {err}"),
            }
        }
    }

    /// 画面を出して（出し直して）もらう。**別のインスタンスの PC にも届く。**
    fn request_screen(&self, card_id: CardId, cols: u16, rows: u16) {
        self.tell_agent(
            card_id,
            ServerToAgent::SubScreen {
                card_id,
                cols,
                rows,
            },
        );
    }

    /// 画面を止めてもらう。
    fn request_unsub(&self, card_id: CardId) {
        self.tell_agent(card_id, ServerToAgent::UnsubScreen { card_id });
    }

    /// 画面の開始・停止を PC へ伝え、**送らせているカードの控えを合わせる。**
    fn tell_agent(&self, card_id: CardId, message: ServerToAgent) {
        self.note_streaming(&message);
        if let Some(conn) = self.conn_for_card(card_id) {
            conn.send(&message);
            return;
        }
        // 別のインスタンスに繋がっている PC へ回す。届かなくても画面が出ないだけで、
        // 次に開き直せばまた頼まれる
        if let Some(agent_id) = self
            .registry
            .get(card_id)
            .and_then(|record| record.meta().agent_id)
        {
            let _ = self.relay_across(agent_id, AgentCommand::Message(Box::new(message)));
        }
    }

    /// 「いま送らせているカード」を覚える（掃除の対象を絞るため）。
    fn note_streaming(&self, message: &ServerToAgent) {
        let mut streaming = self.streaming.lock().expect("ロックが壊れていない");
        match message {
            ServerToAgent::SubScreen { card_id, .. } => {
                streaming.insert(*card_id);
            }
            ServerToAgent::UnsubScreen { card_id } => {
                streaming.remove(card_id);
            }
            _ => {}
        }
    }

    /// 視聴リースの見張りを始める（連絡係が居るときだけ）。
    pub fn start_viewing_lease(self: &Arc<Self>) {
        if self.registry.bus().is_none() {
            return;
        }
        let hub = Arc::clone(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(PRESENCE_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                hub.touch_viewings().await;
                hub.sweep_viewings().await;
            }
        });
    }

    /// 繋ぎ直した PC へ、いま見られているカードの購読を出し直す（§6-4）。
    ///
    /// セッションホスト側は切れた時点で全部止めている——**誰が見ているかを知っているのは
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

    /// セッションホストから届いた画面のフレームを、ブラウザ向けへ移し替えて配る（設計§4-3）。
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
                "セッションホストから送られてよい種別ではありません: {:?}",
                frame.kind
            );
            return;
        }
        // 番号は**ここで剥がす**。ブラウザは知らないし、知る必要も無い（§4-3）
        let Ok((_seq, payload)) = protocol::frame::split_seq(frame.payload) else {
            tracing::warn!("番号の無い画面のフレームを受け取りました");
            return;
        };

        // 別のインスタンスで見ている人へも回す。**通し番号を付けたまま**流すのが要点で、
        // 受け取る側はそれを見て取りこぼしに気づく（設計§9-2・§9-3）
        if let Some(bus) = self.registry.bus() {
            bus.publish(
                &bus::card_screen(frame.card_id),
                bus::encode_binary(self.registry.instance_id(), bytes),
            );
        }

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

    /// 連絡係から届いた画面を、自分のブラウザへ流す（設計§9-2・§9-3）。
    ///
    /// # 番号が飛んだら中継を止める
    ///
    /// pub/sub は at-most-once なので、途中の差分が消えることがある。**消えたまま
    /// 続きを流すと、画面は動いているのに中身が壊れている**という一番気づきにくい形に
    /// なる。飛びを見つけたら流すのをやめ、全画面を出し直してもらってから再開する。
    pub fn deliver_bus_screen(&self, payload: &[u8]) {
        let Some((from, bytes)) = bus::decode_binary(payload) else {
            return;
        };
        // 自分が出したものは、既に手元のブラウザへ配ってある
        if from == self.registry.instance_id() {
            return;
        }
        let Ok(frame) = protocol::frame::decode(bytes) else {
            return;
        };
        let is_full = frame.kind == protocol::frame::FrameKind::ScreenFull;
        if !is_full && frame.kind != protocol::frame::FrameKind::ScreenDiff {
            return;
        }
        let Ok((seq, inner)) = protocol::frame::split_seq(frame.payload) else {
            return;
        };
        let Some(relay) = self
            .screens
            .lock()
            .expect("ロックが壊れていない")
            .get(&frame.card_id)
            .cloned()
        else {
            // うちでは誰も見ていない。止める指示と行き違ったぶん
            return;
        };

        {
            let mut expected = relay.expected_seq.lock().expect("ロックが壊れていない");
            if is_full {
                // 全画面はどこから始まってもよい。**ここが唯一の再開点**
                relay
                    .stalled
                    .store(false, std::sync::atomic::Ordering::Relaxed);
                *expected = Some(seq.wrapping_add(1));
            } else {
                if relay.stalled.load(std::sync::atomic::Ordering::Relaxed) {
                    // 出し直しを待っている間の差分は捨てる
                    return;
                }
                match *expected {
                    Some(next) if next == seq => *expected = Some(seq.wrapping_add(1)),
                    _ => {
                        tracing::warn!(
                            card_id = %frame.card_id,
                            "画面の番号が飛びました。出し直してもらいます"
                        );
                        relay
                            .stalled
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                        *expected = None;
                        let (cols, rows) = relay.size();
                        // ロックを持ったまま指示を出さない
                        drop(expected);
                        self.request_screen(frame.card_id, cols, rows);
                        return;
                    }
                }
            }
        }

        let browser = protocol::frame::encode(frame.kind.to_browser(), frame.card_id, inner);
        let _ = relay.frames.send(Bytes::from(browser));
    }

    /// そのトークンで繋がっている PC を全部畳む（設計§8-4）。
    ///
    /// 失効の直後に呼ぶ。**次の接続は upgrade で断られる**（トークンが引けない）ので、
    /// ここで畳めば「外したはずの PC が繋がり続ける」状態が残らない。
    pub fn disconnect_token(&self, token_id: Uuid) -> usize {
        let doomed: Vec<Arc<AgentConn>> = self
            .conns
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .filter(|conn| conn.token_id == token_id)
            .cloned()
            .collect();
        for conn in &doomed {
            tracing::info!(agent_id = %conn.agent_id, "失効したトークンの接続を切ります");
            conn.disconnect();
        }
        doomed.len()
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

/// ブラウザから見た「PC 側」を、A2S 越しのセッションホストへ繋ぐ実装（設計§2-3）。
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
    ///
    /// **自分の接続表に無くても諦めない**（設計§9-2）。記録が「繋がっている」と
    /// 言うなら、その PC は別のインスタンスに繋がっている——連絡係へ回せば届く。
    fn relay(&self, card_id: CardId, message: ServerToAgent) -> Result<(), String> {
        if let Some(conn) = self.hub.conn_for_card(card_id) {
            conn.send(&message);
            return Ok(());
        }
        let agent_id = self.remote_agent_of(card_id)?;
        self.hub
            .relay_across(agent_id, AgentCommand::Message(Box::new(message)))
    }

    /// そのカードを持つ PC が**別のインスタンスに**繋がっているなら、その PC。
    ///
    /// 記録の鮮度の印を見る。これは報告が回ってきているかどうかで、**どのインスタンスに
    /// 繋がっているかまでは分からない**——分からなくてよく、宛先ごとのチャネルへ
    /// 流せば持っているインスタンスだけが拾う。
    fn remote_agent_of(&self, card_id: CardId) -> Result<AgentId, String> {
        let meta = self
            .hub
            .registry
            .get(card_id)
            .map(|record| record.meta())
            .ok_or_else(|| NOT_CONNECTED.to_string())?;
        match (meta.agent_id, meta.agent_connected) {
            (Some(agent_id), true) => Ok(agent_id),
            _ => Err(NOT_CONNECTED.to_string()),
        }
    }
}

/// そのカードを持つ PC が居ないときの説明。
const NOT_CONNECTED: &str = "セッションが見つかりません（PC が繋がっていません）";

#[async_trait::async_trait]
impl crate::agent::AgentHost for RemoteAgent {
    /// そのカードを**どこかのインスタンスが**持っているか。
    ///
    /// 見るのは自分の接続表ではなく記録の鮮度の印（設計§9-2）。接続表を見ると、
    /// **別のインスタンスに繋がっている PC のカードが全部「無い」ことになる**。
    fn exists(&self, card_id: CardId) -> bool {
        self.hub
            .registry
            .get(card_id)
            .is_some_and(|record| record.meta().agent_connected)
    }

    async fn spawn(&self, request: crate::agent::SpawnRequest<'_>) -> Result<(), String> {
        let message = ServerToAgent::Spawn {
            cwd: request.cwd.to_string(),
            permission_mode: request.permission_mode,
        };

        // 宛先が指名されているなら、その PC が繋がっているかだけを見る。
        // **他人の PC は「繋がっていない」と同じ扱い**（設計§8-6）——言い分けると、
        // IDの総当たりで他人の PC の存在を調べられる
        if let Some(target) = request.target {
            if let Some(conn) = self
                .hub
                .conn(target)
                .filter(|conn| conn.account_id == request.account_id)
            {
                conn.send(&message);
                return Ok(());
            }
            // 自分の接続表に無くても、別のインスタンスに繋がっていることがある
            if !self
                .hub
                .online_of(request.account_id)
                .await
                .contains(&target)
            {
                return Err("指定された PC が繋がっていません".to_string());
            }
            return self
                .hub
                .relay_across(target, AgentCommand::Message(Box::new(message)));
        }

        // 指名が無いときは、**選ぶ余地が無い場合だけ**通す。黙って1台目へ送ると、
        // 意図しない PC で本物の claude が起動する。数えるのは**自分の PC だけ**で、
        // 他人の PC が繋がっているせいで「選んでください」と言われるのはおかしい
        let online = self.hub.online_of(request.account_id).await;
        match online.len() {
            1 => match self.hub.conn(online[0]) {
                Some(conn) => {
                    conn.send(&message);
                    Ok(())
                }
                None => self
                    .hub
                    .relay_across(online[0], AgentCommand::Message(Box::new(message))),
            },
            0 => Err("繋がっている PC がありません".to_string()),
            many => Err(format!(
                "どの PC で起動するか選んでください（{many} 台が繋がっています）"
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
    /// 画面はセッションホストが作って送ってくるものだから——ここで空の 0x03（画面を消せ）を
    /// 返しておくと、直後に届く全画面がその上に描かれて辻褄が合う。
    fn subscribe_pty(
        &self,
        card_id: CardId,
        client_id: u64,
        cols: u16,
        rows: u16,
    ) -> Option<(bytes::Bytes, broadcast::Receiver<bytes::Bytes>)> {
        // 繋がっていない PC のカードは端末を開けない（開いても永久に空のまま）。
        // **どこかのインスタンスに繋がっていればよい**——うちに繋がっている必要は無い
        if !self.exists(card_id) {
            return None;
        }
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
    /// セッションホストに全画面を出し直してもらうのが唯一正しい復帰になる（§7-4 のデシンク）。
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
        // 生入力は JSON に包まずバイナリのまま運ぶ（設計§4-3）
        let framed = protocol::frame::encode(protocol::frame::FrameKind::PtyInput, card_id, bytes);
        if let Some(conn) = self.hub.conn_for_card(card_id) {
            conn.send_binary(framed);
            return Ok(());
        }
        // 跨ぐときだけ base64 で包む（設計§9-2）。1打鍵ぶんの数十バイトなので、
        // 増える3割は問題にならない——**画面（数十KB）と同じ扱いにしない**のが要点
        let agent_id = self.remote_agent_of(card_id)?;
        self.hub.relay_across(
            agent_id,
            AgentCommand::Input {
                data: base64::engine::general_purpose::STANDARD.encode(&framed),
            },
        )
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

    /// パーサの健康状態は**セッションホストから届く**（`ParserStatus`）ので、サーバは
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

/// セッションホスト向けのルート。**ブラウザ向け（[`crate::routes`]）とは別に合成する。**
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
    // 1. 版。**upgrade の前に断る**ので、古いセッションホストは接続の時点で理由を受け取れる
    if !requests_protocol(&headers, A2S_PROTOCOL) {
        tracing::warn!("知らない版のセッションホストを断りました");
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

    upgrade.protocols([A2S_PROTOCOL]).on_upgrade(move |socket| {
        agent_loop(hub, owner.account_id, owner.token_id, account, socket)
    })
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

async fn agent_loop(
    hub: Arc<AgentHub>,
    account_id: Uuid,
    token_id: Uuid,
    account_name: String,
    socket: WebSocket,
) {
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

    // 名乗った中身を残す。**接続を持っていないインスタンスからも見えるように**
    // （設計§9-2）——ここを飛ばすと、ブラウザが別のインスタンスに繋がっているとき
    // 起動ボタンの選択肢が空になる
    let capabilities = Capabilities {
        available_modes: available_modes.clone(),
        always_bypass_permissions,
        // 名乗りには最初から載っている。**ここまで来て捨てていた**（CICD設計§16）
        agent_version: Some(agent_version.clone()),
    };
    match serde_json::to_value(&capabilities) {
        Ok(value) => {
            if let Err(err) = pairing::save_capabilities(&hub.db, agent_id, value).await {
                tracing::warn!(%agent_id, "PC の名乗りを保存できません: {err}");
            }
        }
        Err(err) => tracing::error!("名乗りをシリアライズできません: {err}"),
    }

    let conn = Arc::new(AgentConn {
        agent_id,
        account_id,
        token_id,
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
    // まだ見られている端末があれば、画面を出し直してもらう（§6-4）。セッションホストは
    // 切れた時点で全部止めているので、**こちらから頼まないと画面が戻らない**
    hub.resubscribe_screens(agent_id);
    // 他のインスタンスからも「この PC は繋がっている」と見えるようにする（§9-4）。
    // 見張りの1周（10秒）を待たずに記すのは、**繋いだ直後に起動できない時間**を
    // 作らないため
    hub.touch_presence().await;
    if let Some(bus) = hub.registry.bus() {
        // この PC 宛ての指示を受け取る（§9-2）。ブラウザは別のインスタンスに
        // 繋がっていてよい
        bus.subscribe(&bus::agent_cmd(agent_id));
    }

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
        hub.release_presence(agent_id).await;
        if let Some(bus) = hub.registry.bus() {
            bus.unsubscribe(&bus::agent_cmd(agent_id));
        }
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
            Err(err) => tracing::warn!("セッションホストの報告を解釈できません: {err}"),
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
                // これは「新しいセッションホストが増やした知らせ」でありうる
                Err(err) => {
                    tracing::warn!("セッションホストの報告を解釈できません: {err}");
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
        // の合図になり、セッションホストは持っているぶんを再送する
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

#[cfg(test)]
mod envelope_tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 指示の封筒は中身ごと往復する() {
        // **回帰テスト。** 種別の名前が中の型とぶつかると、書けるのに読めないという
        // 形で壊れる——エラーは出ず、指示が届かないだけになる
        let command = AgentCommand::Message(Box::new(ServerToAgent::SendInput {
            card_id: CardId::new(),
            text: "こんにちは".to_string(),
        }));
        let bytes = bus::encode_json(Uuid::new_v4(), &command);
        let (_, back) = bus::decode_json::<AgentCommand>(&bytes).expect("読めること");
        match (command, back) {
            (AgentCommand::Message(before), AgentCommand::Message(after)) => {
                assert_eq!(before, after)
            }
            (before, after) => panic!("種別が変わっています: {before:?} → {after:?}"),
        }
    }

    #[test]
    fn 生入力の封筒も往復する() {
        let command = AgentCommand::Input {
            data: "AAEC".to_string(),
        };
        let bytes = bus::encode_json(Uuid::new_v4(), &command);
        let (_, back) = bus::decode_json::<AgentCommand>(&bytes).expect("読めること");
        match back {
            AgentCommand::Input { data } => assert_eq!(data, "AAEC"),
            other => panic!("種別が変わっています: {other:?}"),
        }
    }
}
