//! ダッシュボードサーバへの常時接続（セルフホスト化設計§4・§6）。
//!
//! ローカルモードで「同じプロセスの記録層へ渡す」だったところが、セルフホストモードでは
//! ここになる。**報告する口（[`EventSink`]）としては同じ顔**をしているので、
//! [`crate::session::SessionManager`] から見た使い方は変わらない。
//!
//! # 切断はデータを失わせない。遅らせるだけ
//!
//! 繋がっていない間も PTY・フック受信・パースは通常どおり動く（全部 PC の中で完結して
//! いる）。履歴は手元に溜め、繋がったら送り直す。**位置を進めるのは ack が返ってから**
//! なので、途中で落ちても同じところから読み直せる（§6-1）。
//!
//! 状態の知らせ（`Status` など）は切断中に捨てる。復帰したときに全セッションの
//! `SessionUpsert` を送り直すので、**中間の遷移を再生する意味が無い**（§6-4）。
//! ダッシュボードが必要とするのは「最新の状態」と「完全な履歴」で、その2つは
//! 別の方法で守られている。
//!
//! # 溜めるほうに上限を置かない
//!
//! 長い切断で手元のバッチは増え続ける。上限を置いて捨てると「欠落なし」（要件の非機能）が
//! 壊れるので、**遅れは許容し、欠落は許容しない**（ローカルの待ち行列と同じ判断。§20-1）。

use crate::{
    events::{EventSink, LocalEventBus, TranscriptReport},
    offsets::OffsetStore,
    session::SessionManager,
};
use futures_util::{SinkExt as _, StreamExt as _};
use protocol::{
    CardId, TreeNode,
    a2s::{
        A2S_PROTOCOL, A2S_VERSION, AgentMessage, BatchId, HostReply, Intervals, RequestId,
        ServerToAgent,
    },
    frame::{self, FrameKind},
    ws::ServerMessage,
};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite;

/// 再接続の待ち時間（設計§6-3）。上限まで伸ばして、落ちているサーバを叩き続けない。
const BACKOFF_MS: [u64; 7] = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/// 生存確認を送る間隔（設計§4-1）。
const PING_INTERVAL: Duration = Duration::from_secs(10);

/// 何も届かないまま切断とみなすまで（設計§4-1）。
const SILENCE_TIMEOUT: Duration = Duration::from_secs(30);

/// 名乗りの応答を待つ上限。
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// 接続先と身分証。
#[derive(Debug, Clone)]
pub struct LinkConfig {
    /// ダッシュボードサーバ（`http://host:port` でも `ws://host:port` でもよい）
    pub server_url: String,
    pub pairing_token: String,
    /// この PC の名前。**アカウントの中でこの名前が PC の同一性**になる（§8-4）
    pub agent_name: String,
    /// 起動している CLI が受け付ける権限モード（名乗りで渡す）
    pub available_modes: Vec<protocol::PermissionMode>,
    /// セッションホスト側の toml のトグル（名乗りで渡す）
    pub always_bypass_permissions: bool,
}

impl LinkConfig {
    /// この PC の CLI が受け付ける権限モードを添える（§21 読み替え1）。
    ///
    /// サーバモードにはローカルの CLI が居ないので、名乗りで渡さないと**起動ボタンと
    /// 権限モードの選択肢が空になる**。起動時に `claude --help` から読んだものをそのまま運ぶ。
    pub fn with_capabilities(
        mut self,
        available_modes: Vec<protocol::PermissionMode>,
        always_bypass_permissions: bool,
    ) -> Self {
        self.available_modes = available_modes;
        self.always_bypass_permissions = always_bypass_permissions;
        self
    }
}

/// 報告の運び手（サーバへ繋ぐ側）。
pub struct SessionHostLink {
    config: LinkConfig,
    /// 同じプロセス内の購読者（自己修復）向け
    bus: LocalEventBus,
    outgoing: mpsc::UnboundedSender<Outgoing>,
    /// モデルの表（§13-4）。接続直後と変化時に送る。
    ///
    /// **部品のまま持つ。** 変わるのは別名の側だけ（実測の学習）なので、
    /// 差し替えてから組み立て直す
    model_table: Mutex<Option<ModelTable>>,
    /// 常駐タスクへ渡す受け口。[`SessionHostLink::attach`] で取り出す
    inbox: Mutex<Option<mpsc::UnboundedReceiver<Outgoing>>>,
}

/// セッションホストが名乗るモデルの表（§13-4）。
#[derive(Clone)]
struct ModelTable {
    cli_version: String,
    catalog: serde_json::Value,
    aliases: serde_json::Value,
}

impl ModelTable {
    fn message(&self) -> AgentMessage {
        AgentMessage::ModelTable {
            cli_version: self.cli_version.clone(),
            catalog: self.catalog.clone(),
            aliases: self.aliases.clone(),
        }
    }
}

/// 上へ運ぶもの1件。
enum Outgoing {
    /// 状態の知らせ。**切断中は捨ててよい**（復帰時に送り直す）
    Volatile(AgentMessage),
    /// 履歴。ack が返るまで持ち続ける
    Transcript(TranscriptReport),
    Reset(CardId),
    /// モデルの表（接続していなければ、次に繋がったときに送る）
    ModelTable(AgentMessage),
    /// 画面のフレーム（0x04 / 0x05）。**切断中は捨てる**。
    ///
    /// 履歴と違って画面は「いま」しか意味を持たない。溜めて後から送ると、繋がった
    /// 瞬間に古い差分が順に流れて画面が踊る。繋ぎ直したら全画面から送り直す（§6-4）
    Screen(Vec<u8>),
}

impl SessionHostLink {
    /// 口だけ作る。**繋ぎ始めるのは [`SessionHostLink::attach`] を呼んでから。**
    ///
    /// 2段に分かれているのは、**セッションの持ち主（マネージャ）がこの口を受け取って
    /// から作られる**ため（パーサの世話役と同じ形）。順序は
    /// 「口を作る → マネージャを作る → 繋ぎ始める」。
    ///
    /// 繋ぎ始める前に報告されたものは溜まったままになる（捨てない）。
    pub fn new(config: LinkConfig) -> Arc<Self> {
        let (outgoing, inbox) = mpsc::unbounded_channel();
        Arc::new(Self {
            config,
            bus: LocalEventBus::new(),
            outgoing,
            model_table: Mutex::new(None),
            inbox: Mutex::new(Some(inbox)),
        })
    }

    /// 常駐タスクを立てて繋ぎ始める。2度目以降は何もしない。
    pub fn attach(self: &Arc<Self>, manager: Arc<SessionManager>, offsets: Arc<OffsetStore>) {
        let Some(inbox) = self.inbox.lock().expect("ロックが壊れていない").take() else {
            return;
        };
        tokio::spawn(run(
            self.config.clone(),
            manager,
            offsets,
            Arc::clone(self),
            inbox,
        ));
    }

    /// モデルの表を差し込む（§13-4）。接続していれば即送り、していなければ次の接続で送る。
    pub fn set_model_table(
        &self,
        cli_version: String,
        catalog: serde_json::Value,
        aliases: serde_json::Value,
    ) {
        let table = ModelTable {
            cli_version,
            catalog,
            aliases,
        };
        let message = table.message();
        *self.model_table.lock().expect("ロックが壊れていない") = Some(table);
        let _ = self.outgoing.send(Outgoing::ModelTable(message));
    }
}

impl EventSink for SessionHostLink {
    fn emit(&self, event: ServerMessage) {
        if let Some(message) = to_agent_message(&event) {
            let _ = self.outgoing.send(Outgoing::Volatile(message));
        }
        // 手元の購読者（自己修復）にも配る。セルフホストでも修復は PC の中で完結する
        self.bus.emit(event);
    }

    fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
        self.bus.subscribe()
    }

    fn report_transcript(&self, report: TranscriptReport) {
        let _ = self.outgoing.send(Outgoing::Transcript(report));
    }

    fn reset_transcript(&self, card_id: CardId) {
        let _ = self.outgoing.send(Outgoing::Reset(card_id));
    }

    fn model_aliases_changed(&self, aliases: serde_json::Value) {
        let message = {
            let mut table = self.model_table.lock().expect("ロックが壊れていない");
            // まだ表を持っていないなら、送る形にできない（起動直後の一瞬だけ）。
            // 次の接続で改めて全部送るので、ここで作りかけを送る必要は無い
            let Some(table) = table.as_mut() else {
                return;
            };
            table.aliases = aliases;
            table.message()
        };
        let _ = self.outgoing.send(Outgoing::ModelTable(message));
    }

    /// **この報告先が居ることが、セルフホストモードであることの定義**（設計§7-2・§22 読み替え2）。
    fn screens_enabled(&self) -> bool {
        true
    }

    fn screen_frame(&self, frame: Vec<u8>) {
        let _ = self.outgoing.send(Outgoing::Screen(frame));
    }
}

/// ブラウザ向けの知らせを、サーバへの報告へ移す。
///
/// 履歴（`TranscriptAppend` / `TranscriptReset`）はここを通らない——**ack の要る経路**は
/// [`EventSink::report_transcript`] で受けるため。`Hello` はブラウザ専用なので運ばない。
fn to_agent_message(event: &ServerMessage) -> Option<AgentMessage> {
    Some(match event {
        ServerMessage::SessionUpsert { session } => AgentMessage::SessionUpsert {
            session: session.clone(),
        },
        ServerMessage::SessionRemoved { card_id } => {
            AgentMessage::SessionRemoved { card_id: *card_id }
        }
        ServerMessage::Status {
            card_id,
            status,
            subagent_active,
            last_activity_at,
        } => AgentMessage::Status {
            card_id: *card_id,
            status: *status,
            subagent_active: *subagent_active,
            last_activity_at: *last_activity_at,
        },
        ServerMessage::ParserStatus { state, detail } => AgentMessage::ParserStatus {
            state: *state,
            detail: detail.clone(),
        },
        ServerMessage::Selfheal { phase, detail } => AgentMessage::Selfheal {
            phase: *phase,
            detail: detail.clone(),
        },
        ServerMessage::Error { card_id, message } => AgentMessage::Error {
            card_id: *card_id,
            message: message.clone(),
        },
        // `BusStatus` はサーバ同士の話（インスタンスの間の連絡係。設計§12）。
        // **PC は自分が繋いだ1台としか話さない**ので、運ぶ意味も運ぶ手段も無い。
        //
        // PJT 枠（`ProjectUpsert` / `ProjectRemoved`）は**サーバの記録**で、PC は
        // 持っていない（イシューグループ_2026_0805_0514 設計§2）。足すのも消すのも
        // ブラウザ → サーバの REST で完結するので、こちらへ運ぶ経路は要らない
        ServerMessage::Hello { .. }
        | ServerMessage::TranscriptAppend { .. }
        | ServerMessage::TranscriptReset { .. }
        | ServerMessage::BusStatus { .. }
        | ServerMessage::ProjectUpsert { .. }
        | ServerMessage::ProjectRemoved { .. } => return None,
    })
}

/// ack を待っている、または待たせている履歴1件。
struct Pending {
    batch_id: BatchId,
    card_id: CardId,
    kind: PendingKind,
}

enum PendingKind {
    /// 送るノードと、**入ったら進めてよい位置**
    Nodes {
        nodes: Vec<TreeNode>,
        commits: Vec<Commit>,
    },
    /// 巻き戻し。入ったら位置を忘れる
    Reset,
}

struct Commit {
    transcript_path: String,
    source: String,
    next_offset: u64,
}

impl Pending {
    fn message(&self) -> AgentMessage {
        match &self.kind {
            PendingKind::Nodes { nodes, .. } => AgentMessage::TranscriptBatch {
                batch_id: self.batch_id,
                card_id: self.card_id,
                nodes: nodes.clone(),
            },
            PendingKind::Reset => AgentMessage::TranscriptReset {
                batch_id: self.batch_id,
                card_id: self.card_id,
            },
        }
    }
}

/// 履歴の送り出し（設計§6-1・§6-2）。
struct Outbox {
    offsets: Arc<OffsetStore>,
    next_id: u64,
    /// まだ束ねている途中のぶん。**到着順を保つ**（巻き戻しが追い越さないため）
    buffered: Vec<Pending>,
    /// 送ったが ack が返っていないぶん
    inflight: Vec<Pending>,
}

impl Outbox {
    fn new(offsets: Arc<OffsetStore>) -> Self {
        Self {
            offsets,
            next_id: 1,
            buffered: Vec::new(),
            inflight: Vec::new(),
        }
    }

    fn take_id(&mut self) -> BatchId {
        let id = BatchId(self.next_id);
        self.next_id += 1;
        id
    }

    /// 読んだぶんを積む。**同じカードの続きなら1つのバッチにまとめる**。
    ///
    /// まとめてよいのは、間に巻き戻しが挟まっていないときだけ（§6-2）。挟まっていたら
    /// 別のバッチになり、順序どおりに送られる。
    fn push(&mut self, report: TranscriptReport) {
        let TranscriptReport {
            card_id,
            transcript_path,
            source,
            next_offset,
            nodes,
        } = report;
        let commit = Commit {
            transcript_path,
            source,
            next_offset,
        };

        // 同じカードの、**巻き戻しを挟まない**最後のバッチを探す
        let mergeable = self
            .buffered
            .iter_mut()
            .rev()
            .take_while(|pending| {
                pending.card_id != card_id || matches!(pending.kind, PendingKind::Nodes { .. })
            })
            .find(|pending| pending.card_id == card_id);

        if let Some(Pending {
            kind:
                PendingKind::Nodes {
                    nodes: acc,
                    commits,
                },
            ..
        }) = mergeable
        {
            acc.extend(nodes);
            commits.push(commit);
            return;
        }

        let batch_id = self.take_id();
        self.buffered.push(Pending {
            batch_id,
            card_id,
            kind: PendingKind::Nodes {
                nodes,
                commits: vec![commit],
            },
        });
    }

    fn push_reset(&mut self, card_id: CardId) {
        let batch_id = self.take_id();
        self.buffered.push(Pending {
            batch_id,
            card_id,
            kind: PendingKind::Reset,
        });
    }

    /// 束ねていたぶんを送りに出す。返るのは送るべきメッセージの列（順序どおり）。
    fn flush(&mut self) -> Vec<AgentMessage> {
        let messages: Vec<AgentMessage> = self.buffered.iter().map(Pending::message).collect();
        self.inflight.append(&mut self.buffered);
        messages
    }

    /// 未 ack のぶんを送り直す（復帰手順。§6-4）。
    fn resend(&self) -> Vec<AgentMessage> {
        self.inflight.iter().map(Pending::message).collect()
    }

    /// **記録に入った**ので位置を進める。
    fn ack(&mut self, batch_id: BatchId) {
        let Some(at) = self
            .inflight
            .iter()
            .position(|pending| pending.batch_id == batch_id)
        else {
            // 二重の ack（再送が両方届いた等）。位置は既に進んでいるので何もしない
            return;
        };
        let pending = self.inflight.remove(at);
        match pending.kind {
            PendingKind::Nodes { commits, .. } => {
                for commit in commits {
                    self.offsets.commit(
                        pending.card_id,
                        &commit.transcript_path,
                        &commit.source,
                        commit.next_offset,
                    );
                }
            }
            PendingKind::Reset => self.offsets.forget(pending.card_id),
        }
    }

    fn pending_count(&self) -> usize {
        self.buffered.len() + self.inflight.len()
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 常駐タスク。繋がるまで待ち、繋がっている間は運び、切れたらまた待つ。
async fn run(
    config: LinkConfig,
    manager: Arc<SessionManager>,
    offsets: Arc<OffsetStore>,
    link: Arc<SessionHostLink>,
    mut inbox: mpsc::UnboundedReceiver<Outgoing>,
) {
    let mut outbox = Outbox::new(offsets);
    let mut attempt = 0usize;

    loop {
        // **繋がるのを待っている間も報告は受け取る。** 待ち行列を止めると、報告を出す側
        // （フックの処理・パーサの読み取り）が詰まる
        let socket = match connect_waiting(&config, &mut inbox, &mut outbox, attempt).await {
            Some(socket) => socket,
            // 送り口が全部落ちた＝プロセスが畳まれている
            None => return,
        };

        match handshake(socket, &config).await {
            Ok((socket, mut intervals)) => {
                attempt = 0;
                tracing::info!("ダッシュボードサーバへ接続しました: {}", config.server_url);
                connected(
                    socket,
                    &manager,
                    &link,
                    &mut inbox,
                    &mut outbox,
                    &mut intervals,
                )
                .await;
                // 見ている相手が居るかどうかを知っているのはサーバ側なので、切れたら
                // 一旦全部止める。作り続けても行き先が無い（§7-4）
                manager.unsubscribe_all_screens();
                tracing::warn!(
                    "ダッシュボードサーバとの接続が切れました（未送信 {} 件）",
                    outbox.pending_count()
                );
            }
            Err(err) => {
                attempt += 1;
                tracing::warn!("名乗りに失敗しました: {err}");
            }
        }
    }
}

/// 待ち時間を置いてから繋ぐ。待っている間に届いた報告は溜める。
async fn connect_waiting(
    config: &LinkConfig,
    inbox: &mut mpsc::UnboundedReceiver<Outgoing>,
    outbox: &mut Outbox,
    attempt: usize,
) -> Option<Socket> {
    let mut attempt = attempt;
    loop {
        if attempt > 0 {
            let wait = Duration::from_millis(BACKOFF_MS[(attempt - 1).min(BACKOFF_MS.len() - 1)]);
            let deadline = tokio::time::Instant::now() + wait;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline) => break,
                    received = inbox.recv() => match received {
                        Some(outgoing) => absorb(outbox, outgoing),
                        None => return None,
                    },
                }
            }
        }

        match dial(config).await {
            Ok(socket) => return Some(socket),
            Err(err) => {
                attempt += 1;
                tracing::warn!("ダッシュボードサーバへ繋げません（{err}）。待って試し直します");
            }
        }
    }
}

/// 溜める側（送らない）。
fn absorb(outbox: &mut Outbox, outgoing: Outgoing) {
    match outgoing {
        // 切断中の状態の知らせは捨てる。復帰したら全部送り直す（§6-4）
        Outgoing::Volatile(_) | Outgoing::ModelTable(_) | Outgoing::Screen(_) => {}
        Outgoing::Transcript(report) => outbox.push(report),
        Outgoing::Reset(card_id) => outbox.push_reset(card_id),
    }
}

async fn dial(config: &LinkConfig) -> anyhow::Result<Socket> {
    use tungstenite::client::IntoClientRequest as _;

    let mut request = agent_ws_url(&config.server_url).into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", config.pairing_token).parse()?,
    );
    // **版はここで名乗る。** 噛み合わなければサーバは upgrade を断る（§4-1）
    request
        .headers_mut()
        .insert("sec-websocket-protocol", A2S_PROTOCOL.parse()?);

    let (socket, _response) = tokio_tungstenite::connect_async(request).await?;
    Ok(socket)
}

/// `http://host:port` の形も受けて、A2S の口を指す URL にする。
fn agent_ws_url(server_url: &str) -> String {
    let trimmed = server_url.trim_end_matches('/');
    let base = match trimmed.split_once("://") {
        Some(("http", rest)) => format!("ws://{rest}"),
        Some(("https", rest)) => format!("wss://{rest}"),
        // ws:// / wss:// はそのまま。それ以外は書かれたとおりに使う（打ち間違いを
        // こちらで直すと、繋がらない理由が見えなくなる）
        _ => trimmed.to_string(),
    };
    format!("{base}/agent/ws")
}

/// 名乗りを交わす（§4-2）。
async fn handshake(mut socket: Socket, config: &LinkConfig) -> anyhow::Result<(Socket, Intervals)> {
    let hello = AgentMessage::Hello {
        protocol_version: A2S_VERSION,
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        agent_name: config.agent_name.clone(),
        // この PC の CLI が受け付けるモードは、名乗りと一緒に渡す（§21 読み替え1）。
        // サーバにはローカルの CLI が居ないので、ここで渡さないと選択肢が空になる
        available_modes: config.available_modes.clone(),
        always_bypass_permissions: config.always_bypass_permissions,
        // フォルダを覗ける版であることを名乗る（イシューグループ_2026_0805_0514 設計§4）。
        // **この実行ファイルは実装を持っている**ので、常に真。名乗らない古いホストと
        // 区別が付くことが、画面に正しい理由を出せる唯一の材料になる
        supports_host_fs: true,
    };
    socket
        .send(tungstenite::Message::text(serde_json::to_string(&hello)?))
        .await?;

    let reply = tokio::time::timeout(HELLO_TIMEOUT, socket.next())
        .await
        .map_err(|_| anyhow::anyhow!("名乗りの応答がありません"))?
        .ok_or_else(|| anyhow::anyhow!("名乗りの途中で切れました"))??;

    let tungstenite::Message::Text(text) = reply else {
        anyhow::bail!("名乗りの応答が文字ではありません");
    };
    match serde_json::from_str::<ServerToAgent>(&text)? {
        ServerToAgent::Hello {
            protocol_version,
            agent_id,
            intervals,
            ..
        } => {
            if protocol_version != A2S_VERSION {
                anyhow::bail!(
                    "版が噛み合いません（agent={A2S_VERSION} / server={protocol_version}）"
                );
            }
            tracing::info!(%agent_id, "この PC として登録されました");
            Ok((socket, intervals))
        }
        other => anyhow::bail!("名乗りの応答ではありません: {other:?}"),
    }
}

/// 繋がっている間の本体。切れたら戻る。
async fn connected(
    socket: Socket,
    manager: &Arc<SessionManager>,
    link: &Arc<SessionHostLink>,
    inbox: &mut mpsc::UnboundedReceiver<Outgoing>,
    outbox: &mut Outbox,
    intervals: &mut Intervals,
) {
    let (mut sink, mut stream) = socket.split();

    // 名乗りの応答が持ってきた設定を先に効かせる（§6-4）。切れていた間に変わっていても、
    // ここで揃う——**繋がっていなかった PC のぶんは、この経路でしか届かない**
    manager.set_screen_settings((*intervals).into());

    // 復帰手順（§6-4）：全セッションを送り直す → 未 ack を送り直す
    let mut initial: Vec<AgentMessage> = manager
        .list()
        .into_iter()
        .map(|meta| AgentMessage::SessionUpsert {
            session: Box::new(meta),
        })
        .collect();
    if let Some(table) = link
        .model_table
        .lock()
        .expect("ロックが壊れていない")
        .as_ref()
    {
        initial.push(table.message());
    }
    initial.extend(outbox.resend());
    for message in initial {
        if send(&mut sink, &message).await.is_err() {
            return;
        }
    }

    let mut flush = tokio::time::interval(Duration::from_secs(intervals.sync_secs.max(1)));
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_seen = tokio::time::Instant::now();

    loop {
        tokio::select! {
            received = inbox.recv() => match received {
                Some(Outgoing::Volatile(message)) | Some(Outgoing::ModelTable(message)) => {
                    if send(&mut sink, &message).await.is_err() {
                        return;
                    }
                }
                Some(Outgoing::Transcript(report)) => outbox.push(report),
                Some(Outgoing::Reset(card_id)) => outbox.push_reset(card_id),
                // 画面はバイナリのまま運ぶ（設計§4-3）。JSON に包むと base64 で 4/3 に膨らむ
                Some(Outgoing::Screen(bytes)) => {
                    if sink.send(tungstenite::Message::Binary(bytes.into())).await.is_err() {
                        return;
                    }
                }
                // 送り口が全部落ちた＝プロセスが畳まれている
                None => return,
            },

            _ = flush.tick() => {
                for message in outbox.flush() {
                    if send(&mut sink, &message).await.is_err() {
                        return;
                    }
                }
            }

            incoming = stream.next() => match incoming {
                Some(Ok(message)) => {
                    last_seen = tokio::time::Instant::now();
                    if !handle_incoming(message, manager, &link.outgoing, outbox, intervals, &mut flush) {
                        return;
                    }
                }
                _ => return,
            },

            _ = ping.tick() => {
                if last_seen.elapsed() > SILENCE_TIMEOUT {
                    // TCP の静かな死（スリープ・電波断）。**能動的に切って繋ぎ直す**
                    tracing::warn!("{SILENCE_TIMEOUT:?} 何も届かないので繋ぎ直します");
                    return;
                }
                if sink.send(tungstenite::Message::Ping(Default::default())).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// サーバからの1通を処理する。`false` を返したら繋ぎ直す。
fn handle_incoming(
    message: tungstenite::Message,
    manager: &Arc<SessionManager>,
    outgoing: &mpsc::UnboundedSender<Outgoing>,
    outbox: &mut Outbox,
    intervals: &mut Intervals,
    flush: &mut tokio::time::Interval,
) -> bool {
    match message {
        tungstenite::Message::Text(text) => {
            match serde_json::from_str::<ServerToAgent>(&text) {
                Ok(command) => apply_command(command, manager, outgoing, outbox, intervals, flush),
                // 知らない指示で接続ごと落とさない。新しいサーバが増やしたものでありうる
                Err(err) => tracing::warn!("サーバの指示を解釈できません: {err}"),
            }
            true
        }
        // ブラウザからの生入力（0x02）。**PTY へ届くまでの作法は変えない**（§5-5）
        tungstenite::Message::Binary(bytes) => {
            write_pty_input(manager, &bytes);
            true
        }
        tungstenite::Message::Close(_) => false,
        // Ping への応答は tungstenite が返す。Pong は生存の証拠として時刻の更新だけに使う
        _ => true,
    }
}

/// どちらを聞かれたか。
#[derive(Debug, Clone, Copy)]
enum HostFsAsk {
    Dir,
    File,
}

/// フォルダ／ファイルの問いに、**別のスレッドで**答える（設計§4・§8・§9）。
///
/// # 必ず答える
///
/// 読めなかった場合も `HostReply::Failed` を返す。黙ると、聞いた側は時間切れを待つ
/// しかなくなり、**フォルダが無いことと区別が付かない**（設計§7）。
///
/// # 送り口が閉じているときは捨ててよい
///
/// 切断中の答えは行き先が無い。聞いた側は時間切れで畳むので、溜めても意味が無い
/// （`Outgoing::Volatile` の扱いと同じ）。
fn answer_host_fs(
    outgoing: mpsc::UnboundedSender<Outgoing>,
    request_id: RequestId,
    path: String,
    ask: HostFsAsk,
) {
    tokio::task::spawn_blocking(move || {
        let failed = |err: crate::hostfs::HostFsError| HostReply::Failed {
            reason: err.reason,
            detail: err.detail,
        };
        let reply = match ask {
            HostFsAsk::Dir => match crate::hostfs::list_dir(Path::new(&path)) {
                Ok(listing) => HostReply::Dir(listing),
                Err(err) => failed(err),
            },
            HostFsAsk::File => match crate::hostfs::read_file(Path::new(&path)) {
                Ok(content) => HostReply::File(content),
                Err(err) => failed(err),
            },
        };
        let _ = outgoing.send(Outgoing::Volatile(AgentMessage::HostReply {
            request_id,
            reply,
        }));
    });
}

fn apply_command(
    command: ServerToAgent,
    manager: &Arc<SessionManager>,
    outgoing: &mpsc::UnboundedSender<Outgoing>,
    outbox: &mut Outbox,
    intervals: &mut Intervals,
    flush: &mut tokio::time::Interval,
) {
    match command {
        // 2度目の名乗りは実装の食い違い。無視して続ける
        ServerToAgent::Hello { .. } => {}

        ServerToAgent::BatchAck { batch_id } => outbox.ack(batch_id),

        ServerToAgent::SetIntervals {
            intervals: updated, ..
        } => {
            *intervals = updated;
            *flush = tokio::time::interval(Duration::from_secs(updated.sync_secs.max(1)));
            flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // 画面のほうは動いているセッションへその場で配る（§13-3）
            manager.set_screen_settings(updated.into());
            tracing::info!(
                "同期間隔が変わりました（履歴 {} 秒 / 画面 {} ミリ秒 / 遡り {} 行）",
                updated.sync_secs,
                updated.screen_ms,
                updated.scrollback_lines
            );
        }

        ServerToAgent::Spawn {
            cwd,
            permission_mode,
        } => {
            // 採番はこちら（§5-2）。結果は SessionUpsert で返る
            if let Err(err) = manager.spawn_with_mode(&cwd, permission_mode) {
                manager.broadcast(ServerMessage::Error {
                    card_id: None,
                    message: err.to_string(),
                });
            }
        }
        ServerToAgent::Kill { card_id } => {
            if let Err(err) = manager.kill(card_id) {
                report_error(manager, card_id, err.to_string());
            }
        }
        ServerToAgent::Archive { card_id } => {
            if let Err(err) = manager.archive(card_id) {
                report_error(manager, card_id, err.to_string());
            }
        }
        ServerToAgent::Resize {
            card_id,
            cols,
            rows,
        } => {
            if let Some(session) = manager.get(card_id) {
                let _ = session.resize(cols, rows);
            }
        }

        // 時間のかかるものは別のタスクへ逃がす。**ここで待つと、その間ほかの指示も
        // 履歴の送り出しも全部止まる**（ブラウザ側の client_loop と同じ判断）
        ServerToAgent::SendInput { card_id, text } => {
            let manager = Arc::clone(manager);
            tokio::spawn(async move {
                let Some(session) = manager.get(card_id) else {
                    report_error(&manager, card_id, NOT_FOUND.to_string());
                    return;
                };
                if let Err(err) = session.send_instruction(&text).await {
                    report_error(
                        &manager,
                        card_id,
                        format!("指示を送れませんでした: {err:#}"),
                    );
                }
            });
        }
        ServerToAgent::SetPermissionMode { card_id, mode } => {
            let manager = Arc::clone(manager);
            tokio::spawn(async move {
                let Some(session) = manager.get(card_id) else {
                    report_error(&manager, card_id, NOT_FOUND.to_string());
                    return;
                };
                let outcome = session.switch_permission_mode(&mode).await;
                // 着いても着かなくても、いまどこに居るのかは配る
                manager.broadcast_session(&session);
                if let Err(err) = outcome {
                    report_error(&manager, card_id, err.to_string());
                }
            });
        }
        ServerToAgent::SetModel { card_id, model } => {
            let manager = Arc::clone(manager);
            tokio::spawn(async move {
                let Some(session) = manager.get(card_id) else {
                    report_error(&manager, card_id, NOT_FOUND.to_string());
                    return;
                };
                if let Err(err) = manager.switch_model(&session, &model).await {
                    // 途中まで動いた結果も配る（楽観更新が立っていれば、それも伝わる）
                    manager.broadcast_session(&session);
                    report_error(&manager, card_id, err.to_string());
                }
            });
        }

        // 画面の配信（§7-4）。視聴者が現れた・居なくなった、の2つしか来ない
        ServerToAgent::SubScreen {
            card_id,
            cols,
            rows,
        } => manager.subscribe_screen(card_id, cols, rows),
        ServerToAgent::UnsubScreen { card_id } => manager.unsubscribe_screen(card_id),

        // フォルダとファイルの問い（イシューグループ_2026_0805_0514 設計§4）。
        //
        // **ここで直接読まない。** この関数は接続の `select!` ループの中から同期で
        // 呼ばれているので、大きなフォルダを読むと ping まで止まり、サーバから見ると
        // 「静かな死」に見えて切られる
        ServerToAgent::ListDir { request_id, path } => {
            answer_host_fs(outgoing.clone(), request_id, path, HostFsAsk::Dir);
        }
        ServerToAgent::ReadFile { request_id, path } => {
            answer_host_fs(outgoing.clone(), request_id, path, HostFsAsk::File);
        }
    }
}

/// 見つからないカードを指されたときの説明。
const NOT_FOUND: &str = "セッションが見つかりません";

/// 操作の失敗を上へ返す（§5-6）。サーバが `ServerMessage::Error` として配る。
fn report_error(manager: &Arc<SessionManager>, card_id: CardId, message: String) {
    manager.broadcast(ServerMessage::Error {
        card_id: Some(card_id),
        message,
    });
}

fn write_pty_input(manager: &Arc<SessionManager>, bytes: &[u8]) {
    let frame = match frame::decode(bytes) {
        Ok(frame) => frame,
        Err(err) => {
            tracing::warn!("壊れたフレームを受け取りました: {err}");
            return;
        }
    };
    if frame.kind != FrameKind::PtyInput {
        tracing::warn!("サーバから送られてよい種別ではありません: {:?}", frame.kind);
        return;
    }
    // 居ないカードへの入力は黙って捨てる（閉じた直後に届いたぶんで画面を汚さない）
    let Some(session) = manager.get(frame.card_id) else {
        return;
    };
    if let Err(err) = session.write_input(frame.payload) {
        tracing::warn!("端末へ書き込めませんでした: {err:#}");
    }
}

async fn send(
    sink: &mut futures_util::stream::SplitSink<Socket, tungstenite::Message>,
    message: &AgentMessage,
) -> anyhow::Result<()> {
    let text = serde_json::to_string(message)?;
    sink.send(tungstenite::Message::text(text)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use protocol::{Node, NodeId};

    fn node(id: &str) -> TreeNode {
        TreeNode {
            id: NodeId(id.to_string()),
            parent: None,
            node: Node::AssistantText {
                text: id.to_string(),
            },
            ts: 0,
            branch: 0,
        }
    }

    fn report(card_id: CardId, id: &str, next_offset: u64) -> TranscriptReport {
        TranscriptReport {
            card_id,
            transcript_path: "/p/s.jsonl".to_string(),
            source: "/p/s.jsonl".to_string(),
            next_offset,
            nodes: vec![node(id)],
        }
    }

    fn outbox(label: &str) -> (Outbox, Arc<OffsetStore>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-outbox-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");
        let offsets = OffsetStore::open(dir.clone());
        (Outbox::new(Arc::clone(&offsets)), offsets, dir)
    }

    #[test]
    fn 同じカードの続きは1つのバッチにまとまる() {
        // 同期間隔（既定20秒）のあいだに読んだぶんを1通にする。1イベント1通だと、
        // 回線の細い環境で往復ばかりが増える
        let (mut outbox, _offsets, dir) = outbox("merge");
        let card_id = CardId::new();
        outbox.push(report(card_id, "n1", 10));
        outbox.push(report(card_id, "n2", 20));

        let messages = outbox.flush();
        assert_eq!(messages.len(), 1, "実際: {messages:?}");
        match &messages[0] {
            AgentMessage::TranscriptBatch { nodes, .. } => assert_eq!(nodes.len(), 2),
            other => panic!("バッチではない: {other:?}"),
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 巻き戻しは履歴を追い越さない() {
        // 追い越すと、消えたはずの枝がブラウザに残る（設計§6-2）
        let (mut outbox, _offsets, dir) = outbox("order");
        let card_id = CardId::new();
        outbox.push(report(card_id, "n1", 10));
        outbox.push_reset(card_id);
        outbox.push(report(card_id, "n2", 20));

        let messages = outbox.flush();
        assert!(
            matches!(messages[0], AgentMessage::TranscriptBatch { .. }),
            "実際: {:?}",
            messages[0]
        );
        assert!(
            matches!(messages[1], AgentMessage::TranscriptReset { .. }),
            "実際: {:?}",
            messages[1]
        );
        assert!(
            matches!(messages[2], AgentMessage::TranscriptBatch { .. }),
            "巻き戻しの後のぶんが前へ回っている: {:?}",
            messages[2]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ackが返るまで位置は進まず_未ackは送り直される() {
        let (mut outbox, offsets, dir) = outbox("ack");
        let card_id = CardId::new();
        outbox.push(report(card_id, "n1", 10));
        let messages = outbox.flush();
        let AgentMessage::TranscriptBatch { batch_id, .. } = messages[0] else {
            panic!("バッチではない")
        };

        assert!(
            offsets.resume(card_id, "/p/s.jsonl").is_empty(),
            "送っただけで位置が進んでいる"
        );
        assert_eq!(outbox.resend().len(), 1, "未 ack が送り直しの対象に無い");

        outbox.ack(batch_id);

        assert_eq!(offsets.resume(card_id, "/p/s.jsonl")["/p/s.jsonl"], 10);
        assert!(outbox.resend().is_empty(), "ack 済みが残っている");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 巻き戻しのackで位置を忘れる() {
        let (mut outbox, offsets, dir) = outbox("reset-ack");
        let card_id = CardId::new();
        outbox.push(report(card_id, "n1", 10));
        let first = outbox.flush();
        let AgentMessage::TranscriptBatch { batch_id, .. } = first[0] else {
            panic!("バッチではない")
        };
        outbox.ack(batch_id);
        assert!(!offsets.resume(card_id, "/p/s.jsonl").is_empty());

        outbox.push_reset(card_id);
        let second = outbox.flush();
        let AgentMessage::TranscriptReset { batch_id, .. } = second[0] else {
            panic!("巻き戻しではない")
        };
        outbox.ack(batch_id);

        assert!(
            offsets.resume(card_id, "/p/s.jsonl").is_empty(),
            "巻き戻したのに位置が残っている（先のやりとりが二度と読まれない）"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 二重のackは何も壊さない() {
        // 再送が両方届くことがある。2回目は既に位置が進んでいるので何もしない
        let (mut outbox, _offsets, dir) = outbox("double");
        let card_id = CardId::new();
        outbox.push(report(card_id, "n1", 10));
        let messages = outbox.flush();
        let AgentMessage::TranscriptBatch { batch_id, .. } = messages[0] else {
            panic!("バッチではない")
        };
        outbox.ack(batch_id);
        outbox.ack(batch_id);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 接続先はhttpの書き方でも受ける() {
        assert_eq!(
            agent_ws_url("http://dash.example:8787"),
            "ws://dash.example:8787/agent/ws"
        );
        assert_eq!(
            agent_ws_url("https://dash.example/"),
            "wss://dash.example/agent/ws"
        );
        assert_eq!(
            agent_ws_url("ws://127.0.0.1:8787"),
            "ws://127.0.0.1:8787/agent/ws"
        );
    }
}
