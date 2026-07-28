//! PTY バイトを運ぶバイナリ WebSocket フレーム（設計§4）。
//!
//! レイアウトは `[1B kind][16B card_id][payload]` の固定長ヘッダ方式。JSON に包んで
//! base64 にすると 4/3 に膨らむうえエンコード・デコードのCPUを食うため、PTY のバイト列は
//! 必ずこの生フレームで運ぶ（設計の性能要件の前提）。
//!
//! ヘッダを固定長にしているのは、受信側が先頭 17 バイトを見るだけで宛先セッションを
//! 判別でき、payload を**コピーせずに**そのまま端末へ渡せるようにするため。

use crate::CardId;
use uuid::Uuid;

/// S→C：PTY の出力。受け取った端末はそのまま書き足す。
pub const KIND_PTY_OUTPUT: u8 = 0x01;
/// C→S：PTY への入力（端末のキー入力）。
pub const KIND_PTY_INPUT: u8 = 0x02;
/// S→C：PTY のスナップショット。受け取った端末は**画面をリセットしてから**書く。
///
/// 用途は2つある。
///
/// 1. ターミナルを開いた直後の scrollback 初期描画（サーバのリングバッファの中身を渡す）
/// 2. 受信が追いつかずサーバの送信キューが溢れたクライアントの再同期
///
/// 2 が必要なのは、途中のバイトを落としたまま続きを書くと端末の状態機械が壊れて
/// 表示が崩れるため。落としたら「今の全体」を渡し直すのが唯一の正しい復旧になる。
pub const KIND_PTY_SNAPSHOT: u8 = 0x03;

/// kind バイト + card_id の固定長ヘッダの長さ。
pub const HEADER_LEN: usize = 1 + 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    PtyOutput,
    PtyInput,
    PtySnapshot,
}

impl FrameKind {
    pub fn as_byte(self) -> u8 {
        match self {
            Self::PtyOutput => KIND_PTY_OUTPUT,
            Self::PtyInput => KIND_PTY_INPUT,
            Self::PtySnapshot => KIND_PTY_SNAPSHOT,
        }
    }

    pub fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            KIND_PTY_OUTPUT => Some(Self::PtyOutput),
            KIND_PTY_INPUT => Some(Self::PtyInput),
            KIND_PTY_SNAPSHOT => Some(Self::PtySnapshot),
            _ => None,
        }
    }
}

/// デコード結果。`payload` は入力バッファを借りるだけでコピーしない。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame<'a> {
    pub kind: FrameKind,
    pub card_id: CardId,
    pub payload: &'a [u8],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FrameError {
    #[error("フレームが短すぎます（{len} バイト。ヘッダに {HEADER_LEN} バイト必要）")]
    TooShort { len: usize },
    #[error("未知のフレーム種別です: 0x{0:02x}")]
    UnknownKind(u8),
}

/// フレームを組み立てる。ヘッダ + payload の1回のアロケーションで済ませる。
pub fn encode(kind: FrameKind, card_id: CardId, payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(HEADER_LEN + payload.len());
    bytes.push(kind.as_byte());
    bytes.extend_from_slice(card_id.0.as_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

/// フレームを分解する。payload は借用のままなので追加のコピーは発生しない。
pub fn decode(bytes: &[u8]) -> Result<Frame<'_>, FrameError> {
    if bytes.len() < HEADER_LEN {
        return Err(FrameError::TooShort { len: bytes.len() });
    }
    let kind = FrameKind::from_byte(bytes[0]).ok_or(FrameError::UnknownKind(bytes[0]))?;

    let mut raw_id = [0u8; 16];
    raw_id.copy_from_slice(&bytes[1..HEADER_LEN]);

    Ok(Frame {
        kind,
        card_id: CardId(Uuid::from_bytes(raw_id)),
        payload: &bytes[HEADER_LEN..],
    })
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 組み立てたフレームを分解すると元に戻る() {
        let card_id = CardId::new();
        let payload = b"\x1b[32mhello\x1b[0m";

        let bytes = encode(FrameKind::PtyOutput, card_id, payload);
        assert_eq!(bytes.len(), HEADER_LEN + payload.len());

        let frame = decode(&bytes).expect("分解できること");
        assert_eq!(frame.kind, FrameKind::PtyOutput);
        assert_eq!(frame.card_id, card_id);
        assert_eq!(frame.payload, payload);
    }

    #[test]
    fn 全種別が往復する() {
        let card_id = CardId::new();
        for kind in [
            FrameKind::PtyOutput,
            FrameKind::PtyInput,
            FrameKind::PtySnapshot,
        ] {
            let bytes = encode(kind, card_id, b"x");
            assert_eq!(decode(&bytes).unwrap().kind, kind);
        }
    }

    #[test]
    fn payloadが0バイトでも成立する() {
        // PTY からの読み取りが 0 バイトになるケースや、画面リセットだけを伝える
        // スナップショットがありうるため、空 payload は異常ではない
        let card_id = CardId::new();
        let bytes = encode(FrameKind::PtySnapshot, card_id, b"");
        assert_eq!(bytes.len(), HEADER_LEN);

        let frame = decode(&bytes).expect("分解できること");
        assert_eq!(frame.card_id, card_id);
        assert!(frame.payload.is_empty());
    }

    #[test]
    fn payloadにヘッダと紛らわしいバイトが入っていても壊れない() {
        // 固定長ヘッダなので payload の中身は一切解釈されない
        let card_id = CardId::new();
        let payload = [KIND_PTY_SNAPSHOT; 64];
        let bytes = encode(FrameKind::PtyOutput, card_id, &payload);

        let frame = decode(&bytes).unwrap();
        assert_eq!(frame.kind, FrameKind::PtyOutput);
        assert_eq!(frame.payload, payload);
    }

    #[test]
    fn ヘッダに足りない長さは短すぎるエラーになる() {
        for len in 0..HEADER_LEN {
            let bytes = vec![KIND_PTY_OUTPUT; len];
            assert_eq!(
                decode(&bytes),
                Err(FrameError::TooShort { len }),
                "len={len}"
            );
        }
        // ちょうどヘッダ長なら成立する（境界）
        let bytes = vec![KIND_PTY_OUTPUT; HEADER_LEN];
        assert!(decode(&bytes).is_ok());
    }

    #[test]
    fn 未知の種別は拒否する() {
        // 将来サーバ側が種別を増やしても、古いクライアントが黙って誤解釈しないようにする
        let mut bytes = encode(FrameKind::PtyOutput, CardId::new(), b"x");
        bytes[0] = 0x7f;
        assert_eq!(decode(&bytes), Err(FrameError::UnknownKind(0x7f)));
    }
}
