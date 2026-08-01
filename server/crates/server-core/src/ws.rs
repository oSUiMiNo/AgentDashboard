//! WebSocket ゲートウェイ（設計§4）。
//!
//! ブラウザ1接続につき [`client_loop`] が1つ動く。1本の WebSocket に
//! **テキスト（JSON の操作・状態）** と **バイナリ（PTY のバイト列）** を多重化する。
//!
//! # 送信の作り
//!
//! クライアントごとに「送信用の待ち行列 + 送信タスク」を1組持つ。複数の場所（一覧の更新、
//! ターミナル出力、操作の返答）から同じ WebSocket へ書きたいので、書き込み口を1つの
//! タスクに集約している。待ち行列は**上限つき**で、受信が遅いクライアントの分だけが
//! 詰まり、他のクライアントや PTY の読み取りは止まらない。
//!
//! # 遅いクライアントの復帰
//!
//! ターミナル出力は [`tokio::sync::broadcast`] で配る。受信が遅れて待ち行列から溢れると
//! `Lagged` が返るので、そのときは**リングバッファのスナップショット**（フレーム種別
//! `0x03`）を送り直して画面を作り直す。途中を落としたまま続きを書くと端末の制御シーケンスが
//! 割れて表示が崩れるため、落としたら全体を渡し直すのが唯一の正しい復帰になる。
//!
//! # セッションの実体は知らない
//!
//! PTY も claude のプロセスも、このモジュールからは見えない。頼めるのは [`AgentHost`] に
//! 書いてあることだけで、その向こうがローカル直結か A2S 越しかをここでは区別しない
//! （セルフホスト化設計§2-3）。

use crate::{
    agent::AgentHost,
    auth::Identity,
    config::ServerConfig,
    registry::{AccountEvent, PageError, SessionRecord, SessionRegistry, TranscriptPage},
};
use axum::{
    Extension, Json,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::Response,
};
use bytes::Bytes;
use futures_util::{SinkExt as _, StreamExt as _};
use protocol::{
    CardId, NodeId, SessionMeta,
    frame::{self, FrameKind},
    ws::{ClientMessage, FlowState, ServerMessage},
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    sync::{broadcast, mpsc},
    task::JoinHandle,
};

/// クライアント1接続あたりの送信待ち行列（メッセージ数）。
const OUTBOUND_QUEUE_MESSAGES: usize = 64;

#[derive(Clone)]
pub struct AppState {
    /// PC 側への口（セルフホスト化設計§2-3）。**実体（PTY）に頼むことだけ**を持つ
    pub agent: Arc<dyn AgentHost>,
    /// カードの記録（セルフホスト化設計§3）。一覧と履歴はこちらから読む。
    ///
    /// 実体と記録が別なのがフェーズ2 の要点。**記録は DB にあるので、実体が
    /// 死んでいても一覧と履歴は出る**（再起動後の復元がまさにその状態）。
    pub registry: Arc<SessionRegistry>,
    pub config: Arc<ServerConfig>,
    next_client_id: Arc<AtomicU64>,
}

impl AppState {
    pub fn new(
        agent: Arc<dyn AgentHost>,
        registry: Arc<SessionRegistry>,
        config: Arc<ServerConfig>,
    ) -> Self {
        Self {
            agent,
            registry,
            config,
            next_client_id: Arc::new(AtomicU64::new(1)),
        }
    }
}

pub async fn ws_handler(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| client_loop(state, identity, socket))
}

/// `GET /api/sessions` — 現在のカード一覧（設計§4 の初期スナップショット）。
///
/// ブラウザは接続時にこれで「いまの全体」を取り、以後は WebSocket の差分だけを見る。
/// 真実は常にサーバ側にあるので、リロードしても同じ画面へ戻れる。
///
/// **返すのはログイン中のアカウントのぶんだけ**（設計§8-6 の REST の行）。
pub async fn api_sessions(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
) -> Json<Vec<SessionMeta>> {
    Json(state.registry.list(identity.account_id))
}

/// `GET /api/sessions/{card_id}/transcript` の絞り込み。
#[derive(Debug, Default, Deserialize)]
pub struct TranscriptQuery {
    /// このノードより前を遡る。省略なら手元の最新から
    pub before: Option<String>,
    pub limit: Option<usize>,
}

/// `GET /api/sessions/{card_id}/transcript` — 履歴の遡り（設計§4・§3-3）。
///
/// 読み先は DB。**パーサが縮退していても遡れる**のがフェーズ2 での変化で、
/// 503 になるのは DB に聞けなかったときだけになった（初期実装では、窓から落ちた範囲を
/// パーサに JSONL を読み直してもらっていたので、パーサが止まると遡れなかった）。
pub async fn api_transcript(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(card_id): Path<String>,
    Query(query): Query<TranscriptQuery>,
) -> Result<Json<TranscriptPage>, StatusCode> {
    let card_id = card_id
        .parse::<uuid::Uuid>()
        .map(CardId)
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    // 上限を切らないと、1回の要求で全履歴を求められてしまう
    let limit = query
        .limit
        .unwrap_or(state.config.transcript_page_limit)
        .clamp(1, state.config.transcript_page_limit);

    state
        .registry
        .transcript_page(
            identity.account_id,
            card_id,
            query.before.map(NodeId),
            limit,
        )
        .await
        .map(Json)
        .map_err(|err| match err {
            PageError::NotFound => StatusCode::NOT_FOUND,
            PageError::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        })
}

async fn client_loop(state: AppState, identity: Identity, socket: WebSocket) {
    let client_id = state.next_client_id.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let (outbound, mut outbound_rx) = mpsc::channel::<Message>(OUTBOUND_QUEUE_MESSAGES);

    // WebSocket への書き込み口はこのタスクだけ。複数箇所から同時に書かないための集約
    let writer = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    // 一覧の購読を先に始めてから現在の一覧を送る。逆順にすると、その隙間に起動した
    // セッションを取りこぼす。順序を守れば重複するだけで、upsert は重複しても害がない
    let events = state.registry.subscribe_events();
    // 他インスタンスの知らせも、この時点から受け取れるようにする（設計§9-2）。
    // **中で DB を読み直す**ので、購読を開ける前に流れたぶんもここで揃う
    state.registry.attach_browser(identity.account_id).await;

    send_json(
        &outbound,
        ServerMessage::Hello {
            flow_high: state.config.flow_high,
            flow_low: state.config.flow_low,
        },
    )
    .await;
    for meta in state.registry.list(identity.account_id) {
        send_json(
            &outbound,
            ServerMessage::SessionUpsert {
                session: Box::new(meta),
            },
        )
        .await;
    }

    let event_task = tokio::spawn(pump_events(identity.account_id, events, outbound.clone()));

    // 購読中のターミナル。切断時にまとめて畳む
    let mut terminals: HashMap<CardId, JoinHandle<()>> = HashMap::new();
    // 購読中の履歴。ターミナルと対称に、クライアントごとに持つ。
    // 一覧の配信（events）に混ぜると、履歴を見ていないクライアントにまで流れてしまう
    let mut transcripts: HashMap<CardId, JoinHandle<()>> = HashMap::new();

    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Text(text) => {
                let Ok(request) = serde_json::from_str::<ClientMessage>(&text) else {
                    // 知らないメッセージを黙って捨てると、繋がっているのに動かない状態の
                    // 原因が追えなくなる
                    send_json(
                        &outbound,
                        ServerMessage::Error {
                            card_id: None,
                            message: format!("解釈できないメッセージです: {text}"),
                        },
                    )
                    .await;
                    continue;
                };
                handle_request(
                    &state,
                    &identity,
                    client_id,
                    request,
                    &outbound,
                    &mut terminals,
                    &mut transcripts,
                )
                .await;
            }
            Message::Binary(bytes) => handle_pty_input(&state, &identity, &bytes, &outbound).await,
            Message::Close(_) => break,
            // Ping / Pong は axum が自動で処理する
            _ => {}
        }
    }

    // 後始末。特にフロー制御の解除を忘れると、停止を要求したまま切れたクライアントの
    // せいで端末が二度と動かなくなる
    for (card_id, task) in terminals {
        task.abort();
        state.agent.release_client(card_id, client_id);
    }
    for (_, task) in transcripts {
        task.abort();
    }
    event_task.abort();
    // 最後の1人なら跨ぎの購読も閉じる。**忘れると、誰も見ていないアカウントの
    // 知らせを受け取り続ける**
    state.registry.detach_browser(identity.account_id);
    drop(outbound);
    let _ = writer.await;
}

#[allow(clippy::too_many_arguments)]
async fn handle_request(
    state: &AppState,
    identity: &Identity,
    client_id: u64,
    request: ClientMessage,
    outbound: &mpsc::Sender<Message>,
    terminals: &mut HashMap<CardId, JoinHandle<()>>,
    transcripts: &mut HashMap<CardId, JoinHandle<()>>,
) {
    // **どのカードへの操作かが分かるものは、まずここで持ち主を確かめる**（設計§8-6）。
    // 個々の分岐で書くと、口を1つ足したときに付け忘れる——そして付け忘れは、
    // 他人のカードを操作できるという形でしか表に出ない
    if let Some(card_id) = target_card(&request)
        && state.registry.owned(identity.account_id, card_id).is_none()
    {
        // **他人のカードと知らないカードを呼び分けない**（IDの総当たりで存在を
        // 調べられないように）
        send_error(outbound, Some(card_id), NOT_FOUND.to_string()).await;
        return;
    }

    match request {
        ClientMessage::Spawn {
            cwd,
            permission_mode,
            agent_id,
        } => match state
            .agent
            .spawn(crate::agent::SpawnRequest {
                account_id: identity.account_id,
                target: agent_id,
                cwd: &cwd,
                permission_mode,
            })
            .await
        {
            // 起動できた場合の通知は一覧の購読経由で届くので、ここでは何もしない
            Ok(_) => {}
            Err(message) => {
                send_json(
                    outbound,
                    ServerMessage::Error {
                        card_id: None,
                        message,
                    },
                )
                .await;
            }
        },

        // 走っているセッションのモードを切り替える（設計§6）。
        // 実体は TUI へのキー送出なので時間がかかる。**待たずに別のタスクへ逃がす**。
        // ここで待つと、切替のあいだ同じブラウザからの他の操作が全部止まる
        ClientMessage::SetPermissionMode { card_id, mode } => {
            if !state.agent.exists(card_id) {
                send_error(outbound, Some(card_id), NOT_FOUND.to_string()).await;
                return;
            }
            let agent = Arc::clone(&state.agent);
            let outbound = outbound.clone();
            tokio::spawn(async move {
                // 着いたことも、途中まで動いたことも SessionMeta 経由で全クライアントへ届く
                if let Err(message) = agent.set_permission_mode(card_id, mode).await {
                    send_error(&outbound, Some(card_id), message).await;
                }
            });
        }

        // 走っているセッションのモデルを切り替える（設計§5）。
        // 権限モードと同じく時間がかかるので別タスクへ逃がすが、**逃がした先で
        // プロセス全体のロックを取る**のが違い。切替は利用者のグローバル既定
        // `~/.claude/settings.json` を汚すので、並走すると元の値が失われる（設計§6）。
        ClientMessage::SetModel { card_id, model } => {
            if !state.agent.exists(card_id) {
                send_error(outbound, Some(card_id), NOT_FOUND.to_string()).await;
                return;
            }
            let agent = Arc::clone(&state.agent);
            let outbound = outbound.clone();
            tokio::spawn(async move {
                if let Err(message) = agent.set_model(card_id, model).await {
                    send_error(&outbound, Some(card_id), message).await;
                }
            });
        }

        ClientMessage::Kill { card_id } => {
            if let Err(message) = state.agent.kill(card_id) {
                send_error(outbound, Some(card_id), message).await;
            }
        }

        ClientMessage::Archive { card_id } => {
            if let Some(task) = terminals.remove(&card_id) {
                task.abort();
                // 見ていたことも取り下げる。**忘れると、外したカードを見ている人が
                // 1人居ることになり**、リモートでは画面が作られ続ける
                state.agent.release_client(card_id, client_id);
            }
            if let Some(task) = transcripts.remove(&card_id) {
                task.abort();
            }
            if let Err(message) = state.agent.archive(card_id) {
                send_error(outbound, Some(card_id), message).await;
            }
        }

        ClientMessage::SubPty {
            card_id,
            cols,
            rows,
        } => {
            if !state.agent.exists(card_id) {
                send_error(outbound, Some(card_id), NOT_FOUND.to_string()).await;
                return;
            }
            // 二重購読を防ぐ。同じカードを開き直したときは古い方を畳む
            if let Some(previous) = terminals.remove(&card_id) {
                previous.abort();
            }
            // 端末の大きさは最後に届いた指示が勝つ（設計§10 の last-writer-wins）
            state.agent.resize(card_id, cols, rows);

            let Some((snapshot, receiver)) =
                state.agent.subscribe_pty(card_id, client_id, cols, rows)
            else {
                // **生きているのに端末が開けない**＝別の PC のカード。セルフホストの画面は
                // エージェント内の端末エミュレータが作るので、生バイトの購読口が無い
                // （セルフホスト化設計§7）。ローカルでは、直前の生存確認との隙間に
                // セッションが終わった場合だけここへ来る
                send_error(
                    outbound,
                    Some(card_id),
                    "この PC の端末はまだ開けません".into(),
                )
                .await;
                return;
            };
            let task = tokio::spawn(pump_terminal(
                Arc::clone(&state.agent),
                card_id,
                snapshot,
                receiver,
                outbound.clone(),
            ));
            terminals.insert(card_id, task);
        }

        ClientMessage::UnsubPty { card_id } => {
            if let Some(task) = terminals.remove(&card_id) {
                task.abort();
            }
            state.agent.release_client(card_id, client_id);
        }

        ClientMessage::Resize {
            card_id,
            cols,
            rows,
        } => state.agent.resize(card_id, cols, rows),

        ClientMessage::PtyFlow {
            card_id,
            state: flow,
        } => state
            .agent
            .set_flow(card_id, client_id, matches!(flow, FlowState::Pause)),

        ClientMessage::SubTranscript { card_id } => {
            // **生きているかではなく、記録があるかで判断する。** 前回の起動が残した
            // カードは PTY を持たないが、履歴は DB に残っていて読める（設計§3-2）
            // 二重購読を防ぐ。同じカードを開き直したときは古い方を畳む
            if let Some(previous) = transcripts.remove(&card_id) {
                previous.abort();
            }
            let Some(record) = state.registry.owned(identity.account_id, card_id) else {
                send_error(outbound, Some(card_id), NOT_FOUND.to_string()).await;
                return;
            };
            let (snapshot, receiver) = record.subscribe_transcript();
            // まず作り直しを指示してから中身を送る。こうすると再購読が冪等になり、
            // 開き直しても順序や展開状態が混ざらない
            send_json(outbound, ServerMessage::TranscriptReset { card_id }).await;
            if !snapshot.is_empty() {
                send_json(
                    outbound,
                    ServerMessage::TranscriptAppend {
                        card_id,
                        nodes: snapshot,
                    },
                )
                .await;
            }
            // パーサが縮退しているならその旨も伝える（開いた直後に分かるように）
            if let Some(parser_state) = state.agent.parser_state() {
                send_json(
                    outbound,
                    ServerMessage::ParserStatus {
                        state: parser_state,
                        detail: None,
                    },
                )
                .await;
            }

            let task = tokio::spawn(pump_transcript(record, receiver, outbound.clone()));
            transcripts.insert(card_id, task);
        }

        ClientMessage::UnsubTranscript { card_id } => {
            if let Some(task) = transcripts.remove(&card_id) {
                task.abort();
            }
        }

        // Composer からの指示送信（設計§6）。実体は PTY への書き込みなので、
        // スラッシュコマンドも自然文も同じ経路を通る
        ClientMessage::SendInput { card_id, text } => {
            if let Err(message) = state.agent.send_input(card_id, text).await {
                send_error(outbound, Some(card_id), message).await;
            }
        }
    }
}

/// そのメッセージが名指ししているカード（無ければ `None`）。
///
/// **持ち主の確認を1箇所で済ませるための一覧**（設計§8-6）。ここに載せ忘れた種別は
/// 検査を通らずに素通りするので、`ClientMessage` を増やしたら必ず足すこと——
/// 網羅の match にしてあるのは、足し忘れをコンパイラに数えさせるため。
fn target_card(request: &ClientMessage) -> Option<CardId> {
    match request {
        ClientMessage::SubTranscript { card_id }
        | ClientMessage::UnsubTranscript { card_id }
        | ClientMessage::SubPty { card_id, .. }
        | ClientMessage::UnsubPty { card_id }
        | ClientMessage::SetPermissionMode { card_id, .. }
        | ClientMessage::SetModel { card_id, .. }
        | ClientMessage::SendInput { card_id, .. }
        | ClientMessage::Resize { card_id, .. }
        | ClientMessage::PtyFlow { card_id, .. }
        | ClientMessage::Kill { card_id }
        | ClientMessage::Archive { card_id } => Some(*card_id),
        // まだカードが無い（作る側）
        ClientMessage::Spawn { .. } => None,
    }
}

/// 見つからないときの言い分。
///
/// **他人のカードにも同じ言葉を返す。** 「あなたのものではありません」と言い分けると、
/// IDを総当たりして「そのカードは存在する」ことだけを調べられる。
const NOT_FOUND: &str = "セッションが見つかりません";

/// ブラウザからのキー入力を PTY へ書き込む。
async fn handle_pty_input(
    state: &AppState,
    identity: &Identity,
    bytes: &[u8],
    outbound: &mpsc::Sender<Message>,
) {
    let frame = match frame::decode(bytes) {
        Ok(frame) => frame,
        Err(err) => {
            send_error(
                outbound,
                None,
                format!("壊れたフレームを受け取りました: {err}"),
            )
            .await;
            return;
        }
    };
    if frame.kind != FrameKind::PtyInput {
        send_error(
            outbound,
            Some(frame.card_id),
            format!(
                "クライアントから送ってよい種別ではありません: {:?}",
                frame.kind
            ),
        )
        .await;
        return;
    }
    // **他人のカードへの入力は黙って捨てる**（設計§8-6 の WS 操作の行）。
    // キー入力は1打鍵ごとに来るので、断る返事を出すと画面がエラーで埋まる
    if state
        .registry
        .owned(identity.account_id, frame.card_id)
        .is_none()
    {
        return;
    }
    // 居ないカードへの入力も黙って捨てる（閉じた直後に届いたぶんで画面を汚さない）
    if !state.agent.exists(frame.card_id) {
        return;
    }
    if let Err(message) = state.agent.write_input(frame.card_id, frame.payload) {
        send_error(outbound, Some(frame.card_id), message).await;
    }
}

/// 一覧の更新を、**自分のアカウントのぶんだけ**クライアントへ流す（設計§8-6）。
///
/// 配信の口は1本のままで、受け取る側が捨てる。アカウントごとにチャネルを分けるのは
/// インスタンスを跨ぐとき（§9-2）の話で、1インスタンスのうちはここで足りる。
async fn pump_events(
    account_id: uuid::Uuid,
    mut events: broadcast::Receiver<AccountEvent>,
    outbound: mpsc::Sender<Message>,
) {
    loop {
        match events.recv().await {
            Ok(event) => {
                if event.account_id != account_id {
                    continue;
                }
                if !send_json(&outbound, event.message).await {
                    break;
                }
            }
            // 一覧の更新を取りこぼした場合は、状態が古いままになるより作り直す方が安全
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

/// 1つのターミナルの出力をクライアントへ流す。
async fn pump_terminal(
    agent: Arc<dyn AgentHost>,
    card_id: CardId,
    snapshot: Bytes,
    mut output: broadcast::Receiver<Bytes>,
    outbound: mpsc::Sender<Message>,
) {
    // 開いた直後は、それまでの画面（スクロールバック）を1発で描く
    if outbound.send(Message::Binary(snapshot)).await.is_err() {
        return;
    }

    loop {
        match output.recv().await {
            Ok(framed) => {
                if outbound.send(Message::Binary(framed)).await.is_err() {
                    break;
                }
            }
            // 受信が追いつかず取りこぼした。続きを書くと表示が割れるので画面ごと作り直す
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let Some(snapshot) = agent.pty_snapshot(card_id) else {
                    break;
                };
                if outbound.send(Message::Binary(snapshot)).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

/// 1つのセッションの履歴をクライアントへ流す。
///
/// [`pump_terminal`] と対称。違いは復帰の仕方で、履歴は**同じIDのノードは上書き**という
/// 約束（設計§4）があるため、取りこぼしたらウィンドウ全体を送り直せば収束する。
/// 端末のように「途中を落とすと表示が割れる」性質が無いので、作り直しの指示は要らない。
async fn pump_transcript(
    record: Arc<SessionRecord>,
    mut nodes: broadcast::Receiver<Arc<String>>,
    outbound: mpsc::Sender<Message>,
) {
    loop {
        match nodes.recv().await {
            Ok(text) => {
                if outbound
                    .send(Message::text(text.as_str().to_string()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let snapshot = record.transcript_snapshot();
                if snapshot.is_empty() {
                    continue;
                }
                if !send_json(
                    &outbound,
                    ServerMessage::TranscriptAppend {
                        card_id: record.card_id,
                        nodes: snapshot,
                    },
                )
                .await
                {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

/// JSON を1通送る。送れなければ `false`（相手が畳まれている）。
async fn send_json(outbound: &mpsc::Sender<Message>, message: ServerMessage) -> bool {
    match serde_json::to_string(&message) {
        Ok(text) => outbound.send(Message::text(text)).await.is_ok(),
        // 自分の型を自分でシリアライズできない場合は実装の誤りなので、握り潰さず記録する
        Err(err) => {
            tracing::error!("メッセージをシリアライズできません: {err}");
            true
        }
    }
}

async fn send_error(outbound: &mpsc::Sender<Message>, card_id: Option<CardId>, message: String) {
    send_json(outbound, ServerMessage::Error { card_id, message }).await;
}
