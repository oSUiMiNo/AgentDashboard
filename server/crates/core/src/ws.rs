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
    session::{Session, SessionManager},
};
use axum::{
    Json,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use bytes::Bytes;
use futures_util::{SinkExt as _, StreamExt as _};
use protocol::{
    CardId, SessionMeta,
    frame::{self, FrameKind},
    ws::{ClientMessage, FlowState, ServerMessage},
};
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
    next_client_id: Arc<AtomicU64>,
}

impl AppState {
    pub fn new(manager: Arc<SessionManager>, config: Arc<Config>) -> Self {
        Self {
            manager,
            config,
            next_client_id: Arc::new(AtomicU64::new(1)),
        }
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
                handle_request(&state, client_id, request, &outbound, &mut terminals).await;
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
) {
    match request {
        ClientMessage::Spawn { cwd } => match state.manager.spawn(&cwd) {
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

        ClientMessage::Kill { card_id } => {
            if let Err(err) = state.manager.kill(card_id) {
                send_error(outbound, Some(card_id), err.to_string()).await;
            }
        }

        ClientMessage::Archive { card_id } => {
            if let Some(task) = terminals.remove(&card_id) {
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

        // 以降はフェーズ3〜4で実装する。受け取ったこと自体は伝えて、無反応にはしない
        ClientMessage::SubTranscript { card_id }
        | ClientMessage::UnsubTranscript { card_id }
        | ClientMessage::SendInput { card_id, .. } => {
            send_error(
                outbound,
                Some(card_id),
                "この操作はまだ実装されていません（構造化ビューはフェーズ3、指示送信はフェーズ4）"
                    .into(),
            )
            .await;
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
