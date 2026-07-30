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

use crate::{CardId, ModelId, PermissionMode, SessionMeta, SessionStatus, Timestamp, TreeNode};
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

/// 自己修復の進み具合（設計§9）。
///
/// 文字列ではなく型にしてあるのは、送り手と受け手が別々の言語で手書きされているため。
/// 綴り違いはコンパイルを通ってしまい、「進行が画面に出ない」という追いにくい形でしか
/// 表に出ない。段階の増減は [`ServerMessage::Selfheal`] と同じく4箇所同期の対象。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelfhealPhase {
    /// パースの異常、または知らない版を見つけた
    Detected,
    /// カナリアで新しい版のサンプルを採っている
    Canary,
    /// 採ったサンプルでゴールデンテストを実行している
    Testing,
    /// 修復セッションが作業している
    Repairing,
    /// 修復の結果を core 側で検証している（エージェントの自己申告は使わない）
    Verifying,
    /// 直す必要が無かった。対応表に登録して終わり
    Passed,
    /// 新しいパーサへ差し替えた
    Swapped,
    /// 差し替えたあとに悪化したので、前のパーサへ戻した
    RolledBack,
    /// 直せなかった。構造化ビューは縮退のまま
    Failed,
    /// 同じ版への再挑戦を抑えている
    Cooldown,
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
    /// 指定した作業ディレクトリで新しいセッションを起動する。
    ///
    /// `permission_mode` が `None` のときは **CLI に何も渡さない**。空文字や `manual` を
    /// 明示的に渡すのとは意味が違い、利用者の `permissions.defaultMode` を尊重するという
    /// 意思表示になる。
    Spawn {
        cwd: String,
        permission_mode: Option<PermissionMode>,
    },
    /// 走っているセッションの権限モードを切り替える。
    ///
    /// 実体は PTY 上の TUI なので、サーバが Shift+Tab を送って**目的のモードへ着くまで
    /// 繰り返す**（設計§6）。着けない組み合わせがある（`dontAsk` は巡回に入らない、
    /// `bypassPermissions` は起動時に有効化した場合だけ）ので、結果は
    /// [`ServerMessage::Error`] で返りうる。
    SetPermissionMode {
        card_id: CardId,
        mode: PermissionMode,
    },
    /// 走っているセッションのモデルを切り替える（設計§5）。
    ///
    /// 実体は TUI へ `/model <値>` を送ることなので、権限モードと同じく時間がかかり、
    /// 失敗しうる。運ぶのは**切り替え先の別名**（`opus` など）で、CLI が名乗り返す
    /// フルID（`claude-opus-5`）とは別物である点に注意（[`ModelId`] のドキュメント）。
    ///
    /// 会話が進んだ状態では CLI が確認を求めてくるので、着地までに数手かかる。
    /// 結果は [`ServerMessage::Error`] で返りうる。
    SetModel {
        card_id: CardId,
        model: ModelId,
    },
    /// Composer からの指示送信。
    ///
    /// 改行の扱いはサーバ側が決める（`crates/core/src/session/input.rs`）。単一行は
    /// CR を付けて確定し、複数行は bracketed paste で包む。加工をブラウザ側と両方で
    /// やると、どちらが正なのか分からなくなるので、ここでは生の文字列だけを運ぶ。
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
    /// セッション1枚分の情報。新規・更新の区別なく全体を送る。
    ///
    /// # なぜ `Box` なのか
    ///
    /// この列挙は**購読者ごとに複製されて配信の待ち行列へ積まれる**（1接続あたり
    /// 64件×クライアント数）。[`SessionMeta`] は他のバリアントより桁違いに大きいので、
    /// 直に持つと `Status` のような小さな知らせまで同じ大きさで積まれることになる。
    /// JSON の形は変わらない（`Box` は透過的に直列化される）ので、線の上は同じ。
    SessionUpsert { session: Box<SessionMeta> },
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
    /// 自己修復の進行通知（設計§9）。
    ///
    /// `detail` には、人が読んで次の一手を決められる手掛かりを入れる（失敗したテストの
    /// 抜粋・見つけた新しい版など）。段階だけでは「何が起きたのか」が分からない。
    Selfheal {
        phase: SelfhealPhase,
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
    use crate::{ClaudeSessionId, Node, NodeId, PermissionMode, ProjectId};

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
            permission_mode: Some(PermissionMode::new("acceptEdits")),
            model: Some(ModelId::new("claude-opus-5")),
            model_label: Some("Opus 5".to_string()),
            model_requested: None,
            status: SessionStatus::Working,
            subagent_active: 1,
            last_activity_at: 1_700_000_000_000,
            last_assistant_message: None,
            created_at: 1_699_999_000_000,
            hooks_seen: true,
            agent_id: None,
            agent_connected: true,
            account: None,
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
                permission_mode: None,
            },
            ClientMessage::Spawn {
                cwd: "/home/example/dev/app".to_string(),
                permission_mode: Some(PermissionMode::new("bypassPermissions")),
            },
            ClientMessage::SetPermissionMode {
                card_id,
                mode: PermissionMode::new("acceptEdits"),
            },
            ClientMessage::SetModel {
                card_id,
                model: ModelId::new("opus"),
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
                session: Box::new(sample_meta()),
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
                    branch: 0,
                }],
            },
            ServerMessage::TranscriptReset { card_id },
            ServerMessage::ParserStatus {
                state: ParserState::Degraded,
                detail: Some("パーサプロセスが応答しません".to_string()),
            },
            ServerMessage::Selfheal {
                phase: SelfhealPhase::Canary,
                detail: None,
            },
            ServerMessage::Selfheal {
                phase: SelfhealPhase::Swapped,
                detail: Some("transcript-parser を差し替えました".to_string()),
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

        // 起動の指定なしは `null` として運ぶ。ブラウザ側も同じ形で組み立てる
        let text = serde_json::to_string(&ClientMessage::Spawn {
            cwd: "/home/example/dev/app".to_string(),
            permission_mode: None,
        })
        .unwrap();
        assert_eq!(
            text,
            r#"{"t":"spawn","cwd":"/home/example/dev/app","permission_mode":null}"#
        );

        let text = serde_json::to_string(&ClientMessage::SetPermissionMode {
            card_id,
            mode: PermissionMode::new("manual"),
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"set_permission_mode","card_id":"{card_id}","mode":"default"}}"#),
            "CLI の別名 manual は正規値 default に寄せてから運ぶ"
        );

        // モデルは権限モードと違って寄せる別名が無い。受け取った値をそのまま運ぶ
        let text = serde_json::to_string(&ClientMessage::SetModel {
            card_id,
            model: ModelId::new("opus"),
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"set_model","card_id":"{card_id}","model":"opus"}}"#)
        );

        let text = serde_json::to_string(&ServerMessage::Hello {
            flow_high: 262_144,
            flow_low: 32_768,
        })
        .unwrap();
        assert_eq!(text, r#"{"t":"hello","flow_high":262144,"flow_low":32768}"#);

        // 自己修復の段階も、TypeScript 側と同じ綴りになることを固定する
        let text = serde_json::to_string(&ServerMessage::Selfheal {
            phase: SelfhealPhase::RolledBack,
            detail: None,
        })
        .unwrap();
        assert_eq!(
            text,
            r#"{"t":"selfheal","phase":"rolled_back","detail":null}"#
        );
    }

    #[test]
    fn 自己修復の段階は全部スネークケースで往復する() {
        let all = [
            (SelfhealPhase::Detected, "detected"),
            (SelfhealPhase::Canary, "canary"),
            (SelfhealPhase::Testing, "testing"),
            (SelfhealPhase::Repairing, "repairing"),
            (SelfhealPhase::Verifying, "verifying"),
            (SelfhealPhase::Passed, "passed"),
            (SelfhealPhase::Swapped, "swapped"),
            (SelfhealPhase::RolledBack, "rolled_back"),
            (SelfhealPhase::Failed, "failed"),
            (SelfhealPhase::Cooldown, "cooldown"),
        ];
        for (phase, name) in all {
            assert_eq!(
                serde_json::to_string(&phase).unwrap(),
                format!(r#""{name}""#)
            );
            assert_eq!(roundtrip(&phase), phase);
        }
    }

    #[test]
    fn 知らない種別は受け取りを拒否する() {
        // 対応していないメッセージを黙って無視すると、動かない原因が追えなくなる
        let err = serde_json::from_str::<ClientMessage>(r#"{"t":"未来の種別"}"#);
        assert!(err.is_err());
    }
}
