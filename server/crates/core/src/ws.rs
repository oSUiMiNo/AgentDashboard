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

use crate::{
    config::Config,
    parser::ParserSupervisor,
    session::{Session, SessionManager},
    settings::{SettingsStore, SettingsView},
};
use axum::{
    Json,
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
    CardId, NodeId, SessionMeta, TreeNode,
    frame::{self, FrameKind},
    ws::{ClientMessage, FlowState, ServerMessage},
};
use serde::{Deserialize, Serialize};
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
    pub manager: Arc<SessionManager>,
    pub config: Arc<Config>,
    /// パーサの世話役。**居なくても core は動く**（構造化ビューだけが縮退する）。
    ///
    /// 設計§11 の「パーサが停止しても、ターミナルと指示送信は通常動作」を型で表している。
    pub parser: Option<Arc<ParserSupervisor>>,
    /// 画面から書き換えられる設定（設計§7）。**居なくても core は動く**ので、
    /// 統合テストは設定画面を立てずにセッションの検証だけができる。
    pub settings: Option<Arc<SettingsStore>>,
    next_client_id: Arc<AtomicU64>,
}

impl AppState {
    pub fn new(manager: Arc<SessionManager>, config: Arc<Config>) -> Self {
        Self {
            manager,
            config,
            parser: None,
            settings: None,
            next_client_id: Arc::new(AtomicU64::new(1)),
        }
    }

    /// パーサを繋いだ状態にする。
    pub fn with_parser(mut self, parser: Arc<ParserSupervisor>) -> Self {
        self.parser = Some(parser);
        self
    }

    /// 設定の持ち主を繋いだ状態にする。
    pub fn with_settings(mut self, settings: Arc<SettingsStore>) -> Self {
        self.settings = Some(settings);
        self
    }
}

/// `GET /api/settings` — 画面が読む設定（設計§7・§8）。
///
/// 起動ボタンの数と切替UIの選択肢がこれで決まる。**保存先がサーバなので、別のタブで
/// 開いても同じ値になる。**
pub async fn api_settings(State(state): State<AppState>) -> Result<Json<SettingsView>, StatusCode> {
    let settings = state.settings.as_ref().ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(settings.view()))
}

/// `PUT /api/settings` の本文。
#[derive(Debug, Deserialize)]
pub struct SettingsUpdate {
    pub always_bypass_permissions: bool,
}

/// `PUT /api/settings` — トグルを書き換えて `config.toml` へ書き戻す（設計§7）。
pub async fn api_update_settings(
    State(state): State<AppState>,
    Json(update): Json<SettingsUpdate>,
) -> Result<Json<SettingsView>, (StatusCode, String)> {
    let settings = state
        .settings
        .as_ref()
        .ok_or((StatusCode::NOT_FOUND, "設定を扱えません".to_string()))?;

    // 書き込みはブロッキング。テストのスレッドで待つと自分の応答を自分で待つ形になるので、
    // 専用スレッドへ逃がす（初期実装フェーズ2でテスト一式が固まった件と同じ理由）
    let settings = Arc::clone(settings);
    let value = update.always_bypass_permissions;
    let result = tokio::task::spawn_blocking(move || settings.set_always_bypass_permissions(value))
        .await
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;

    match result {
        Ok(view) => Ok(Json(view)),
        // 黙って失敗すると「変えたのに戻る」という追いにくい形になる
        Err(err) => Err((StatusCode::INTERNAL_SERVER_ERROR, format!("{err:#}"))),
    }
}

pub async fn ws_handler(State(state): State<AppState>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| client_loop(state, socket))
}

/// `GET /api/sessions` — 現在のカード一覧（設計§4 の初期スナップショット）。
///
/// ブラウザは接続時にこれで「いまの全体」を取り、以後は WebSocket の差分だけを見る。
/// 真実は常にサーバ側にあるので、リロードしても同じ画面へ戻れる（フェーズ4で使う土台）。
pub async fn api_sessions(State(state): State<AppState>) -> Json<Vec<SessionMeta>> {
    Json(state.manager.list())
}

/// `GET /api/sessions/{card_id}/transcript` の絞り込み。
#[derive(Debug, Default, Deserialize)]
pub struct TranscriptQuery {
    /// このノードより前を遡る。省略なら手元の最新から
    pub before: Option<String>,
    pub limit: Option<usize>,
}

/// 履歴1ページ分。
#[derive(Debug, Serialize)]
pub struct TranscriptPage {
    pub nodes: Vec<TreeNode>,
    /// さらに前があるかもしれない
    pub has_more: bool,
}

/// `GET /api/sessions/{card_id}/transcript` — 履歴の遡り（設計§4）。
///
/// core がメモリに持つのは直近ウィンドウだけなので、それより前を求められたら
/// パーサに読み直してもらう。**パーサが縮退しているときは 503 を返す**。
/// 待ち続けて画面を固めるより、「これ以上遡れない」と伝えるほうがよい。
pub async fn api_transcript(
    State(state): State<AppState>,
    Path(card_id): Path<String>,
    Query(query): Query<TranscriptQuery>,
) -> Result<Json<TranscriptPage>, StatusCode> {
    let card_id = card_id
        .parse::<uuid::Uuid>()
        .map(CardId)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let session = state.manager.get(card_id).ok_or(StatusCode::NOT_FOUND)?;

    // 上限を切らないと、1回の要求で全履歴を求められてしまう
    let limit = query
        .limit
        .unwrap_or(state.config.transcript_page_limit)
        .clamp(1, state.config.transcript_page_limit);

    let Some(before) = query.before.map(NodeId) else {
        // 起点の指定なし＝手元の最新ぶん
        let mut nodes = session.transcript_snapshot();
        let has_more = nodes.len() > limit;
        if has_more {
            nodes = nodes.split_off(nodes.len() - limit);
        }
        return Ok(Json(TranscriptPage { nodes, has_more }));
    };

    // 手元のウィンドウで答えられるならパーサへ行かない
    if let Some(nodes) = session.transcript_before(&before, limit) {
        let has_more = nodes.len() == limit;
        return Ok(Json(TranscriptPage { nodes, has_more }));
    }

    let Some(anchor) = session.transcript_anchor(&before) else {
        // どこにも位置の記録が無い＝これ以上は遡れない
        return Ok(Json(TranscriptPage {
            nodes: Vec::new(),
            has_more: false,
        }));
    };
    let parser = state
        .parser
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let mut parsed = parser
        .read_range(card_id, anchor.source, anchor.offset)
        .await
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    let has_more = parsed.len() > limit;
    if has_more {
        parsed = parsed.split_off(parsed.len() - limit);
    }
    Ok(Json(TranscriptPage {
        nodes: parsed.into_iter().map(|parsed| parsed.node).collect(),
        has_more,
    }))
}

async fn client_loop(state: AppState, socket: WebSocket) {
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
    let events = state.manager.subscribe_events();

    send_json(
        &outbound,
        ServerMessage::Hello {
            flow_high: state.config.flow_high,
            flow_low: state.config.flow_low,
        },
    )
    .await;
    for meta in state.manager.list() {
        send_json(&outbound, ServerMessage::SessionUpsert { session: meta }).await;
    }

    let event_task = tokio::spawn(pump_events(events, outbound.clone()));

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
                    client_id,
                    request,
                    &outbound,
                    &mut terminals,
                    &mut transcripts,
                )
                .await;
            }
            Message::Binary(bytes) => handle_pty_input(&state, &bytes, &outbound).await,
            Message::Close(_) => break,
            // Ping / Pong は axum が自動で処理する
            _ => {}
        }
    }

    // 後始末。特にフロー制御の解除を忘れると、停止を要求したまま切れたクライアントの
    // せいで端末が二度と動かなくなる
    for (card_id, task) in terminals {
        task.abort();
        if let Some(session) = state.manager.get(card_id) {
            session.release_client(client_id);
        }
    }
    for (_, task) in transcripts {
        task.abort();
    }
    event_task.abort();
    drop(outbound);
    let _ = writer.await;
}

async fn handle_request(
    state: &AppState,
    client_id: u64,
    request: ClientMessage,
    outbound: &mpsc::Sender<Message>,
    terminals: &mut HashMap<CardId, JoinHandle<()>>,
    transcripts: &mut HashMap<CardId, JoinHandle<()>>,
) {
    match request {
        ClientMessage::Spawn {
            cwd,
            permission_mode,
        } => match state.manager.spawn_with_mode(&cwd, permission_mode) {
            // 起動できた場合の通知は一覧の購読経由で届くので、ここでは何もしない
            Ok(_) => {}
            Err(err) => {
                send_json(
                    outbound,
                    ServerMessage::Error {
                        card_id: None,
                        message: err.to_string(),
                    },
                )
                .await;
            }
        },

        // 走っているセッションのモードを切り替える（設計§6）。
        // 実体は TUI へのキー送出なので時間がかかる。**待たずに別のタスクへ逃がす**。
        // ここで待つと、切替のあいだ同じブラウザからの他の操作が全部止まる
        ClientMessage::SetPermissionMode { card_id, mode } => {
            let Some(session) = state.manager.get(card_id) else {
                send_error(outbound, Some(card_id), "セッションが見つかりません".into()).await;
                return;
            };
            let manager = Arc::clone(&state.manager);
            let outbound = outbound.clone();
            tokio::spawn(async move {
                match session.switch_permission_mode(&mode).await {
                    // 着いたことは SessionMeta 経由で全クライアントへ届く
                    Ok(_) => manager.broadcast_session(&session),
                    Err(err) => {
                        // 途中まで動いた結果も配る（いまどこに居るかは伝わったほうがよい）
                        manager.broadcast_session(&session);
                        send_error(&outbound, Some(card_id), err.to_string()).await;
                    }
                }
            });
        }

        ClientMessage::Kill { card_id } => {
            if let Err(err) = state.manager.kill(card_id) {
                send_error(outbound, Some(card_id), err.to_string()).await;
            }
        }

        ClientMessage::Archive { card_id } => {
            if let Some(task) = terminals.remove(&card_id) {
                task.abort();
            }
            if let Some(task) = transcripts.remove(&card_id) {
                task.abort();
            }
            if let Err(err) = state.manager.archive(card_id) {
                send_error(outbound, Some(card_id), err.to_string()).await;
            }
        }

        ClientMessage::SubPty {
            card_id,
            cols,
            rows,
        } => {
            let Some(session) = state.manager.get(card_id) else {
                send_error(outbound, Some(card_id), "セッションが見つかりません".into()).await;
                return;
            };
            // 二重購読を防ぐ。同じカードを開き直したときは古い方を畳む
            if let Some(previous) = terminals.remove(&card_id) {
                previous.abort();
            }
            // 端末の大きさは最後に届いた指示が勝つ（設計§10 の last-writer-wins）
            let _ = session.resize(cols, rows);

            let (snapshot, receiver) = session.subscribe_with_snapshot();
            let task = tokio::spawn(pump_terminal(
                Arc::clone(&session),
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
            if let Some(session) = state.manager.get(card_id) {
                session.release_client(client_id);
            }
        }

        ClientMessage::Resize {
            card_id,
            cols,
            rows,
        } => {
            if let Some(session) = state.manager.get(card_id) {
                let _ = session.resize(cols, rows);
            }
        }

        ClientMessage::PtyFlow {
            card_id,
            state: flow,
        } => {
            if let Some(session) = state.manager.get(card_id) {
                session.set_client_pause(client_id, matches!(flow, FlowState::Pause));
            }
        }

        ClientMessage::SubTranscript { card_id } => {
            let Some(session) = state.manager.get(card_id) else {
                send_error(outbound, Some(card_id), "セッションが見つかりません".into()).await;
                return;
            };
            // 二重購読を防ぐ。同じカードを開き直したときは古い方を畳む
            if let Some(previous) = transcripts.remove(&card_id) {
                previous.abort();
            }

            let (snapshot, receiver) = session.subscribe_transcript();
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
            if let Some(parser) = state.parser.as_ref() {
                send_json(
                    outbound,
                    ServerMessage::ParserStatus {
                        state: parser.state(),
                        detail: None,
                    },
                )
                .await;
            }

            let task = tokio::spawn(pump_transcript(
                Arc::clone(&session),
                receiver,
                outbound.clone(),
            ));
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
            let Some(session) = state.manager.get(card_id) else {
                send_error(outbound, Some(card_id), "セッションが見つかりません".into()).await;
                return;
            };
            if let Err(err) = session.send_instruction(&text).await {
                send_error(
                    outbound,
                    Some(card_id),
                    format!("指示を送れませんでした: {err:#}"),
                )
                .await;
            }
        }
    }
}

/// ブラウザからのキー入力を PTY へ書き込む。
async fn handle_pty_input(state: &AppState, bytes: &[u8], outbound: &mpsc::Sender<Message>) {
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
    let Some(session) = state.manager.get(frame.card_id) else {
        return;
    };
    if let Err(err) = session.write_input(frame.payload) {
        send_error(
            outbound,
            Some(frame.card_id),
            format!("端末へ書き込めませんでした: {err:#}"),
        )
        .await;
    }
}

/// 一覧の更新をそのままクライアントへ流す。
async fn pump_events(
    mut events: broadcast::Receiver<ServerMessage>,
    outbound: mpsc::Sender<Message>,
) {
    loop {
        match events.recv().await {
            Ok(message) => {
                if !send_json(&outbound, message).await {
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
    session: Arc<Session>,
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
                if outbound
                    .send(Message::Binary(session.snapshot_frame()))
                    .await
                    .is_err()
                {
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
    session: Arc<Session>,
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
                let snapshot = session.transcript_snapshot();
                if snapshot.is_empty() {
                    continue;
                }
                if !send_json(
                    &outbound,
                    ServerMessage::TranscriptAppend {
                        card_id: session.card_id,
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
