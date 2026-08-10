//! WebSocket の1往復（CLI設計§7）。
//!
//! 操作系のコマンドは**投げっぱなし**の `ClientMessage` を送り、結果は後から
//! `SessionUpsert`／`Error` で返る（設計§8-1）。ここが持つのは線の世話だけ——
//! 「何をもって届いたとするか」は [`super::wait`] が決める。
//!
//! # Hello を受け取ってから返す
//!
//! サーバは接続直後に必ず `Hello` を1通目として送る（`server-core/src/ws.rs`）。
//! [`Ws::connect`] はそれを**読んでから**呼び出し元へ返る——繋いだ直後に送ると、
//! 鍵の判定より前に届いて黙って捨てられる余地があるため、**時間ではなく合図で待つ**
//! （CLI設計§7-2。固定スリープで立ち上がりを待つ罠と同じ形を踏まない）。

use futures_util::{SinkExt, StreamExt};
use protocol::CardId;
use protocol::frame::FrameKind;
use protocol::ws::{ClientMessage, ServerMessage};
use std::time::Duration;
use tokio_tungstenite::tungstenite;

use super::{ClientError, Target};

/// 接続と `Hello` の待ちの上限。操作の待ち（§8-2）とは別で、これは「繋がったか」だけを見る
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 線の上を流れてくるものの2種類（CLI設計§9-1）。
///
/// 操作系の待ち（[`super::wait`]）はテキストの知らせしか見ないが、`session screen` は
/// バイナリ（PTY のフレーム）が本体になる。どちらが要るかは受け取る側の都合なので、
/// 両方を返す口（[`Ws::next_frame`]）を分けて置く。
pub enum WsEvent {
    /// テキストの知らせ（`ServerMessage`）
    Message(ServerMessage),
    /// PTY のバイナリフレーム。`payload` はヘッダ（kind + card_id）を剥がした中身
    Frame {
        kind: FrameKind,
        card_id: CardId,
        payload: Vec<u8>,
    },
}

/// ダッシュボードの `/ws` に座っている接続。1回の呼び出しで「繋ぐ→送る→観測する→切る」を
/// 閉じる（CLI設計§1-2）ので、長生きさせない。
pub struct Ws {
    socket: Socket,
    /// エラーメッセージで「相手」を名指しするための表示用 URL
    target_url: String,
    /// 未解除の購読（CLI設計§3-3）。CLI は切断がそのまま解除になるが、**内部では律儀に
    /// unsub を送ってから閉じる**——黙って切ると、サーバ側の後片付けに任せる形になる
    pending_unsubs: Vec<ClientMessage>,
}

impl Ws {
    /// 繋いで、`Hello` を受け取ってから返す。
    pub async fn connect(target: &Target) -> Result<Self, ClientError> {
        let url = target.ws_url();
        let connected = tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async(url.as_str()),
        )
        .await
        .map_err(|_| ClientError::Timeout {
            what: format!("{url} への接続"),
            secs: CONNECT_TIMEOUT.as_secs(),
        })?;
        let (socket, _) = connected.map_err(|err| match err {
            // upgrade が HTTP の答えで断られた形（401 など）は、REST と同じ言葉へ写す
            tungstenite::Error::Http(response) => {
                let status = response.status().as_u16();
                let body = response
                    .body()
                    .as_ref()
                    .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
                    .unwrap_or_default();
                ClientError::from_status(status, body)
            }
            other => ClientError::Unreachable {
                target: target.http_url(),
                detail: other.to_string(),
            },
        })?;
        let mut ws = Self {
            socket,
            target_url: target.http_url(),
            pending_unsubs: Vec::new(),
        };
        // 1通目は必ず Hello。来るまでは何も送らない（時間ではなく合図で待つ）
        tokio::time::timeout(CONNECT_TIMEOUT, async {
            loop {
                if matches!(ws.next_event().await?, ServerMessage::Hello { .. }) {
                    return Ok::<(), ClientError>(());
                }
            }
        })
        .await
        .map_err(|_| ClientError::Timeout {
            what: "サーバの名乗り（Hello）".to_string(),
            secs: CONNECT_TIMEOUT.as_secs(),
        })??;
        Ok(ws)
    }

    /// `ClientMessage` を1本送る。購読なら、切る前に送る unsub をここで控える。
    pub async fn send(&mut self, message: &ClientMessage) -> Result<(), ClientError> {
        match message {
            ClientMessage::SubPty { card_id, .. } => {
                self.pending_unsubs
                    .push(ClientMessage::UnsubPty { card_id: *card_id });
            }
            ClientMessage::SubTranscript { card_id } => {
                self.pending_unsubs
                    .push(ClientMessage::UnsubTranscript { card_id: *card_id });
            }
            ClientMessage::UnsubPty { card_id } => self
                .pending_unsubs
                .retain(|m| !matches!(m, ClientMessage::UnsubPty { card_id: c } if c == card_id)),
            ClientMessage::UnsubTranscript { card_id } => self.pending_unsubs.retain(
                |m| !matches!(m, ClientMessage::UnsubTranscript { card_id: c } if c == card_id),
            ),
            _ => {}
        }
        let text = serde_json::to_string(message).expect("ClientMessage は必ず JSON へ直せる");
        self.socket
            .send(tungstenite::Message::text(text))
            .await
            .map_err(|err| ClientError::Unreachable {
                target: self.target_url.clone(),
                detail: format!("送っている途中で切れました: {err}"),
            })
    }

    /// 次の知らせを1つ受け取る。
    ///
    /// **知らない種別は黙って読み飛ばす**（CLI設計§7-3）。ここで落ちる作りにすると、
    /// サーバに種別が1つ増えただけで CLI が全部止まる。バイナリ（PTY のフレーム）も
    /// 同じ理由で読み飛ばす——操作系の待ちに要るのはテキストの知らせだけ。
    pub async fn next_event(&mut self) -> Result<ServerMessage, ClientError> {
        loop {
            if let WsEvent::Message(message) = self.next_frame().await? {
                return Ok(message);
            }
            // バイナリは読み飛ばす（`session screen` だけが next_frame を直に使う）
        }
    }

    /// 次に流れてきたものを、テキスト・バイナリの区別ごと受け取る（CLI設計§9-1）。
    ///
    /// `session screen` は PTY のフレーム（`0x03` / `0x01`）が本体なのでこちらを使う。
    /// 読めないバイナリ（ヘッダが壊れている・知らない種別）は、知らないテキストと
    /// 同じ理由で黙って読み飛ばす。
    pub async fn next_frame(&mut self) -> Result<WsEvent, ClientError> {
        loop {
            match self.socket.next().await {
                Some(Ok(tungstenite::Message::Text(text))) => {
                    if let Ok(message) = serde_json::from_str::<ServerMessage>(&text) {
                        return Ok(WsEvent::Message(message));
                    }
                    // パース不能＝知らない種別。捨てて次を待つ
                }
                Some(Ok(tungstenite::Message::Binary(bytes))) => {
                    if let Ok(frame) = protocol::frame::decode(&bytes) {
                        return Ok(WsEvent::Frame {
                            kind: frame.kind,
                            card_id: frame.card_id,
                            payload: frame.payload.to_vec(),
                        });
                    }
                }
                Some(Ok(tungstenite::Message::Close(_))) | None => {
                    return Err(ClientError::Unreachable {
                        target: self.target_url.clone(),
                        detail: "待っている間に接続が切れました".to_string(),
                    });
                }
                Some(Ok(_)) => {}
                Some(Err(err)) => {
                    return Err(ClientError::Unreachable {
                        target: self.target_url.clone(),
                        detail: format!("受け取りに失敗しました: {err}"),
                    });
                }
            }
        }
    }

    /// バイナリフレームを1本送る（`session key` の `0x02`。CLI設計§9-3）。
    pub async fn send_binary(&mut self, bytes: Vec<u8>) -> Result<(), ClientError> {
        self.socket
            .send(tungstenite::Message::Binary(bytes.into()))
            .await
            .map_err(|err| ClientError::Unreachable {
                target: self.target_url.clone(),
                detail: format!("送っている途中で切れました: {err}"),
            })
    }

    /// 未解除の購読を送ってから閉じる。失敗しても黙って終わる——切断そのものが
    /// 解除になる（サーバは接続ごとに購読を持つ）ので、ここで利用者を止める理由が無い。
    pub async fn close(mut self) {
        for unsub in std::mem::take(&mut self.pending_unsubs) {
            let text = serde_json::to_string(&unsub).expect("ClientMessage は必ず JSON へ直せる");
            if self
                .socket
                .send(tungstenite::Message::text(text))
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = self.socket.close(None).await;
    }
}
