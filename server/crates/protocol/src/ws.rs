//! ブラウザ ⇄ core サーバの WebSocket メッセージ（設計§4）。
//!
//! 1本の WebSocket に2種類の通信を多重化している。
//!
//! - **テキストフレーム**（このモジュール）… 操作と状態。JSON で `{"t": "<種別>", ...}`
//! - **バイナリフレーム**（[`crate::frame`]）… PTY のバイト列
//!
//! 分けているのは性能のため。PTY バイトを JSON に入れると base64 化で膨らみ、
//! 高頻度の出力でエンコード・デコードのCPUを食う（設計の性能要件の前提）。
//!
//! ここではフェーズ1で扱わない種別も**型としては全て定義している**。プロトコルの全体像を
//! 1ファイルで見渡せるようにするためと、フロントエンドとの型のズレをテストで
//! 検出できるようにするため。ハンドラの実装は該当フェーズで足していく。

use crate::{CardId, SessionMeta, SessionStatus, Timestamp, TreeNode};
use serde::{Deserialize, Serialize};

/// ターミナルのフロー制御の指示（設計§10 のウォーターマーク方式）。
///
/// ブラウザ側で xterm.js の未書き込みバイトが増えすぎたら `Pause` を送る。サーバは
/// その間 PTY からの読み取りを止め、OS の PTY バッファに滞留させる。滞留しきると
/// CLI 側の書き込みがブロックされるので、**ブラウザの遅さが CLI まで伝わって減速する**。
/// バイトを捨てないのが要点。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowState {
    Pause,
    Resume,
}

/// 構造化ビューの健全性（設計§11 の縮退表示）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParserState {
    Ok,
    Degraded,
}

/// ブラウザ → サーバ。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMessage {
    /// セッションの履歴（構造化ビュー）を購読する。実装はフェーズ3
    SubTranscript {
        card_id: CardId,
    },
    UnsubTranscript {
        card_id: CardId,
    },
    /// ターミナルを購読する。購読直後にサーバから scrollback のスナップショットが届く
    SubPty {
        card_id: CardId,
        cols: u16,
        rows: u16,
    },
    UnsubPty {
        card_id: CardId,
    },
    /// 指定した作業ディレクトリで新しいセッションを起動する
    Spawn {
        cwd: String,
    },
    /// Composer からの指示送信。実装はフェーズ4
    SendInput {
        card_id: CardId,
        text: String,
    },
    Resize {
        card_id: CardId,
        cols: u16,
        rows: u16,
    },
    PtyFlow {
        card_id: CardId,
        state: FlowState,
    },
    /// セッションを終了させる（PTY プロセスを落とす）
    Kill {
        card_id: CardId,
    },
    /// 終了済みのカードを一覧から消す
    Archive {
        card_id: CardId,
    },
}

/// サーバ → ブラウザ。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMessage {
    /// 接続直後の1通目。クライアント側の実装が必要とするサーバ設定を渡す。
    ///
    /// フロー制御のしきい値は `config.toml`（設計§12）にあるがウォーターマークの判定は
    /// ブラウザ側で行うため、値を渡さないと設定が効かない。
    Hello { flow_high: usize, flow_low: usize },
    /// セッション1枚分の情報。新規・更新の区別なく全体を送る
    SessionUpsert { session: SessionMeta },
    /// カードが一覧から消えたことを伝える（`archive` の結果）。
    ///
    /// 消えたことを伝える手段が無いと、`archive` したブラウザ以外の画面にカードが
    /// 残り続けてしまう。
    SessionRemoved { card_id: CardId },
    /// 状態だけの差分更新。実装はフェーズ2
    Status {
        card_id: CardId,
        status: SessionStatus,
        subagent_active: u32,
        last_activity_at: Timestamp,
    },
    /// 履歴の追記。
    ///
    /// **同じ [`NodeId`] のノードは上書き（upsert）として扱うこと。**「追記」という名だが
    /// 純粋な追加ではない。ツールコールのノードは結果が届く前に発行され、結果が来てから
    /// 同じIDで送り直されるため。
    ///
    /// 「結果が揃うまで出さない」方式にしなかったのは、長いコマンドを実行している間
    /// そのツールコールが画面に一切出ないことになり、「いま何をしているか一目で分かる」
    /// という本ツールの目的を正面から損なうため。
    ///
    /// [`NodeId`]: crate::NodeId
    TranscriptAppend {
        card_id: CardId,
        nodes: Vec<TreeNode>,
    },
    /// トランスクリプトの巻き戻り検知。
    ///
    /// 受け取ったら、そのカードの履歴を捨てて作り直す。`/rewind` でファイルが
    /// 巻き戻ったときのほか、購読を始めるときにも先頭で1回送る（再購読を冪等にするため）。
    TranscriptReset { card_id: CardId },
    /// 構造化ビューの縮退通知。実装はフェーズ3
    ParserStatus {
        state: ParserState,
        detail: Option<String>,
    },
    /// 自己修復の進行通知。実装はフェーズ5
    Selfheal {
        phase: String,
        detail: Option<String>,
    },
    /// 操作が失敗したことをユーザへ伝える。
    ///
    /// 起動失敗のようにカードが作られないケースがあり、黙って何も起きないと
    /// 「押したのに反応しない」状態になるため、明示的に返す種別を用意している。
    Error {
        card_id: Option<CardId>,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use crate::{ClaudeSessionId, Node, NodeId, ProjectId};

    fn roundtrip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let text = serde_json::to_string(value).expect("シリアライズできること");
        serde_json::from_str(&text).expect("デシリアライズできること")
    }

    fn sample_meta() -> SessionMeta {
        SessionMeta {
            card_id: CardId::new(),
            project: ProjectId("/home/example/dev/app".to_string()),
            claude_session_id: Some(ClaudeSessionId::new()),
            status: SessionStatus::Working,
            subagent_active: 1,
            last_activity_at: 1_700_000_000_000,
            last_assistant_message: None,
            created_at: 1_699_999_000_000,
        }
    }

    #[test]
    fn client_messageは全種が往復する() {
        let card_id = CardId::new();
        let all = vec![
            ClientMessage::SubTranscript { card_id },
            ClientMessage::UnsubTranscript { card_id },
            ClientMessage::SubPty {
                card_id,
                cols: 120,
                rows: 40,
            },
            ClientMessage::UnsubPty { card_id },
            ClientMessage::Spawn {
                cwd: "/home/example/dev/app".to_string(),
            },
            ClientMessage::SendInput {
                card_id,
                text: "/rewind".to_string(),
            },
            ClientMessage::Resize {
                card_id,
                cols: 80,
                rows: 24,
            },
            ClientMessage::PtyFlow {
                card_id,
                state: FlowState::Pause,
            },
            ClientMessage::PtyFlow {
                card_id,
                state: FlowState::Resume,
            },
            ClientMessage::Kill { card_id },
            ClientMessage::Archive { card_id },
        ];
        for message in &all {
            assert_eq!(&roundtrip(message), message);
        }
    }

    #[test]
    fn server_messageは全種が往復する() {
        let card_id = CardId::new();
        let all = vec![
            ServerMessage::Hello {
                flow_high: 262_144,
                flow_low: 32_768,
            },
            ServerMessage::SessionUpsert {
                session: sample_meta(),
            },
            ServerMessage::SessionRemoved { card_id },
            ServerMessage::Status {
                card_id,
                status: SessionStatus::Ended { ok: true },
                subagent_active: 0,
                last_activity_at: 1_700_000_000_000,
            },
            ServerMessage::TranscriptAppend {
                card_id,
                nodes: vec![TreeNode {
                    id: NodeId("node-1".to_string()),
                    parent: None,
                    node: Node::AssistantText {
                        text: "了解しました".to_string(),
                    },
                    ts: 1_700_000_000_000,
                }],
            },
            ServerMessage::TranscriptReset { card_id },
            ServerMessage::ParserStatus {
                state: ParserState::Degraded,
                detail: Some("パーサプロセスが応答しません".to_string()),
            },
            ServerMessage::Selfheal {
                phase: "canary".to_string(),
                detail: None,
            },
            ServerMessage::Error {
                card_id: Some(card_id),
                message: "作業ディレクトリが存在しません".to_string(),
            },
            ServerMessage::Error {
                card_id: None,
                message: "claude を起動できませんでした".to_string(),
            },
        ];
        for message in &all {
            assert_eq!(&roundtrip(message), message);
        }
    }

    /// フロントエンド（TypeScript）は手書きの型で同じ JSON を組み立てる。
    /// 種別名が変わればここが落ちるので、両者のズレに気づける。
    #[test]
    fn 種別名はスネークケースのtフィールドで表現される() {
        let card_id = CardId::new();
        let text = serde_json::to_string(&ClientMessage::SubPty {
            card_id,
            cols: 80,
            rows: 24,
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"sub_pty","card_id":"{card_id}","cols":80,"rows":24}}"#)
        );

        let text = serde_json::to_string(&ClientMessage::PtyFlow {
            card_id,
            state: FlowState::Pause,
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"pty_flow","card_id":"{card_id}","state":"pause"}}"#)
        );

        let text = serde_json::to_string(&ServerMessage::Hello {
            flow_high: 262_144,
            flow_low: 32_768,
        })
        .unwrap();
        assert_eq!(text, r#"{"t":"hello","flow_high":262144,"flow_low":32768}"#);
    }

    #[test]
    fn 知らない種別は受け取りを拒否する() {
        // 対応していないメッセージを黙って無視すると、動かない原因が追えなくなる
        let err = serde_json::from_str::<ClientMessage>(r#"{"t":"未来の種別"}"#);
        assert!(err.is_err());
    }
}
