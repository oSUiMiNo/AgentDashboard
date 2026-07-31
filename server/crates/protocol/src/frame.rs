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
/// A→S：全画面（セルフホスト化設計§4-3）。payload の先頭 8B が seq。
///
/// エージェント内の端末エミュレータ（vt100）が作ったエスケープ列で、**独自のセル配列
/// フォーマットは発明しない**。サーバはこれを [`KIND_PTY_SNAPSHOT`] へ移し替えるだけで
/// ブラウザへ流せる（「画面をリセットしてから書け」という意味論がちょうど一致する）。
pub const KIND_SCREEN_FULL: u8 = 0x04;
/// A→S：前の画面からの差分。payload の先頭 8B が seq。[`KIND_PTY_OUTPUT`] へ移し替える。
pub const KIND_SCREEN_DIFF: u8 = 0x05;

/// kind バイト + card_id の固定長ヘッダの長さ。
pub const HEADER_LEN: usize = 1 + 16;

/// 画面フレームの payload 先頭に付く通し番号の長さ（バイト・ビッグエンディアン）。
///
/// 中継（Valkey pub/sub。設計§9-3）は取りこぼしうるので、受け手が連番を検査して
/// 飛びに気づけるようにする。**ブラウザへ渡す前に剥がす**ので、この番号は
/// エージェントとサーバの間だけに存在する。
pub const SEQ_LEN: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    PtyOutput,
    PtyInput,
    PtySnapshot,
    ScreenFull,
    ScreenDiff,
}

impl FrameKind {
    pub fn as_byte(self) -> u8 {
        match self {
            Self::PtyOutput => KIND_PTY_OUTPUT,
            Self::PtyInput => KIND_PTY_INPUT,
            Self::PtySnapshot => KIND_PTY_SNAPSHOT,
            Self::ScreenFull => KIND_SCREEN_FULL,
            Self::ScreenDiff => KIND_SCREEN_DIFF,
        }
    }

    pub fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            KIND_PTY_OUTPUT => Some(Self::PtyOutput),
            KIND_PTY_INPUT => Some(Self::PtyInput),
            KIND_PTY_SNAPSHOT => Some(Self::PtySnapshot),
            KIND_SCREEN_FULL => Some(Self::ScreenFull),
            KIND_SCREEN_DIFF => Some(Self::ScreenDiff),
            _ => None,
        }
    }

    /// ブラウザへ渡すときの種別（セルフホスト化設計§4-3）。
    ///
    /// 画面のフレームだけが移し替えの対象で、それ以外は**そのまま**通る。
    /// この対応が成り立つおかげで、ブラウザ側（`TerminalPane` / `frame.ts`）は
    /// セルフホスト化で1行も変わらない。
    pub fn to_browser(self) -> Self {
        match self {
            Self::ScreenFull => Self::PtySnapshot,
            Self::ScreenDiff => Self::PtyOutput,
            other => other,
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
    #[error("画面フレームに通し番号がありません（payload {len} バイト。{SEQ_LEN} バイト必要）")]
    MissingSeq { len: usize },
}

/// フレームを組み立てる。ヘッダ + payload の1回のアロケーションで済ませる。
pub fn encode(kind: FrameKind, card_id: CardId, payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(HEADER_LEN + payload.len());
    bytes.push(kind.as_byte());
    bytes.extend_from_slice(card_id.0.as_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

/// 画面フレームを組み立てる（セルフホスト化設計§4-3）。
///
/// `[kind][card_id][seq 8B][エスケープ列]`。番号を payload の先頭に置いてヘッダを
/// 太らせないのは、**既存の3実装（Rust×2・TS×1）に散る固定長ヘッダの前提**を
/// 壊さないため。番号が要るのはエージェントとサーバの間だけで、ブラウザは知らない。
pub fn encode_screen(kind: FrameKind, card_id: CardId, seq: u64, payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(HEADER_LEN + SEQ_LEN + payload.len());
    bytes.push(kind.as_byte());
    bytes.extend_from_slice(card_id.0.as_bytes());
    bytes.extend_from_slice(&seq.to_be_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

/// 画面フレームの payload から通し番号を剥がす。
///
/// 剥がした残りがそのままブラウザへ渡すバイト列になる（[`FrameKind::to_browser`] と対）。
pub fn split_seq(payload: &[u8]) -> Result<(u64, &[u8]), FrameError> {
    if payload.len() < SEQ_LEN {
        return Err(FrameError::MissingSeq { len: payload.len() });
    }
    let (head, rest) = payload.split_at(SEQ_LEN);
    let mut raw = [0u8; SEQ_LEN];
    raw.copy_from_slice(head);
    Ok((u64::from_be_bytes(raw), rest))
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
            FrameKind::ScreenFull,
            FrameKind::ScreenDiff,
        ] {
            let bytes = encode(kind, card_id, b"x");
            assert_eq!(decode(&bytes).unwrap().kind, kind);
        }
    }

    #[test]
    fn 画面フレームは番号を付けて剥がせる() {
        let card_id = CardId::new();
        let screen = b"\x1b[2J\x1b[H hello";

        let bytes = encode_screen(FrameKind::ScreenDiff, card_id, 42, screen);
        let frame = decode(&bytes).expect("分解できること");
        assert_eq!(frame.kind, FrameKind::ScreenDiff);
        assert_eq!(frame.card_id, card_id);

        let (seq, rest) = split_seq(frame.payload).expect("番号を剥がせること");
        assert_eq!(seq, 42);
        assert_eq!(rest, screen, "剥がした残りがそのままブラウザへ渡る形");
    }

    #[test]
    fn 番号の無い画面フレームは受け取らない() {
        // 番号が無いと中継の取りこぼし（設計§9-3）に気づけない。短いものを
        // 「番号 0」と解釈して通すと、飛びの検査が静かに嘘になる
        let card_id = CardId::new();
        let bytes = encode(FrameKind::ScreenFull, card_id, b"1234");
        let frame = decode(&bytes).unwrap();
        assert_eq!(
            split_seq(frame.payload),
            Err(FrameError::MissingSeq { len: 4 })
        );
    }

    #[test]
    fn 画面の種別だけがブラウザ向けに移し替えられる() {
        // ここが崩れるとフロント無改修の約束（設計§4-3）が破れる
        assert_eq!(FrameKind::ScreenFull.to_browser(), FrameKind::PtySnapshot);
        assert_eq!(FrameKind::ScreenDiff.to_browser(), FrameKind::PtyOutput);
        for kind in [
            FrameKind::PtyOutput,
            FrameKind::PtyInput,
            FrameKind::PtySnapshot,
        ] {
            assert_eq!(kind.to_browser(), kind, "画面以外は素通しであること");
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
