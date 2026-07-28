//! サーバ・フロントエンド・パーサが共有するドメインモデル（設計§3）。
//!
//! このクレートは「型の定義」だけを持ち、振る舞いは持たない。自己修復機構（設計§9）が
//! 変更してよいのは transcript-parser だけで、このクレートは変更禁止の共有境界にあたる。
//! 未知のフォーマットは必ず [`Node::Unknown`] へ写像することで、この制約と両立させる。

pub mod frame;
pub mod ws;

use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

/// エポックからのミリ秒。
///
/// 日時ライブラリに依存せず、フロントエンド（TypeScript）がそのまま `number` として
/// 扱える表現を選んでいる。共有境界であるこのクレートの依存を増やさないための判断。
pub type Timestamp = i64;

/// ダッシュボード内で不変のセッションカードID。
///
/// UI とPTYプロセスはこのIDに紐づく。CLI 側のセッションID（[`ClaudeSessionId`]）は
/// resume などで変わりうるが、こちらは生涯不変。先行事例で頻発した「ID追跡切れ」を
/// 構造的に防ぐための分離（設計§3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CardId(pub Uuid);

impl CardId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for CardId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for CardId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Claude Code CLI 側のセッションID。resume や fork で変わりうる「属性」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ClaudeSessionId(pub Uuid);

impl ClaudeSessionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ClaudeSessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for ClaudeSessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// 作業ディレクトリの絶対パス。一覧画面のグループ化キーになる。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectId(pub String);

impl fmt::Display for ProjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// 小窓に表示するセッションの状態（設計§5 の導出結果）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionStatus {
    /// PTY 起動済みだが SessionStart フックをまだ受けていない
    Starting,
    Working,
    WaitingPermission,
    WaitingInput,
    /// Working のままイベントが途絶した（ハング検知）
    Stalled,
    Ended {
        ok: bool,
    },
    /// PTY 出力はあるのにフックが1件も届いていない等、判断できない状態
    Unknown,
}

/// 一覧画面の小窓1枚分の情報。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub card_id: CardId,
    pub project: ProjectId,
    pub claude_session_id: Option<ClaudeSessionId>,
    pub status: SessionStatus,
    /// 稼働中サブエージェント数。バッジ表示用で、status とは独立に増減する
    pub subagent_active: u32,
    pub last_activity_at: Timestamp,
    /// Stop フックの `last_assistant_message`。JSONL を読まずに小窓へ要約を出せる
    pub last_assistant_message: Option<String>,
    pub created_at: Timestamp,
}

/// JSONL レコードの `uuid` に対応するノードID。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(pub String);

impl fmt::Display for NodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// ツールコールの完了状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    /// tool_use は観測したが対応する toolUseResult がまだ来ていない
    Pending,
    Ok,
    Error,
}

/// 親のツールコールにぶら下がるサブエージェントの参照情報。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentRef {
    pub agent_type: String,
    /// `<セッションID>/subagents/agent-*.jsonl` へのパス
    pub transcript_path: String,
    pub spawn_depth: u32,
}

/// 正規化イベントモデル。transcript-parser の出力単位（設計§3）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Node {
    UserMessage {
        text: String,
    },
    AssistantText {
        text: String,
    },
    ToolCall {
        name: String,
        input: serde_json::Value,
        result: Option<serde_json::Value>,
        status: ToolStatus,
        /// Task 系ツールの場合、子ツリーのマウント先情報が入る
        subagent: Option<SubagentRef>,
    },
    Subagent {
        agent_type: String,
        spawn_depth: u32,
    },
    /// 寛容パースの受け皿。未知の type / 構造はすべてここへ写像する。
    ///
    /// このバリアントがあるおかげで、パーサは共有境界（このクレート）を変更せずに
    /// 新フォーマットへ対応できる。自己修復の変更範囲を transcript-parser だけに
    /// 限定するための要（設計§14 の引き継ぎ事項1）。
    Unknown {
        record_type: String,
        raw: serde_json::Value,
    },
}

/// スレッディング層が組み立てるツリーの1ノード。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TreeNode {
    pub id: NodeId,
    pub parent: Option<NodeId>,
    pub node: Node,
    pub ts: Timestamp,
}

#[cfg(test)]
mod tests {
    // テスト名は日本語で書いている。英大文字（JSON 等）が混ざると snake_case 判定に
    // 引っかかるだけで実害はないため、このモジュールに限って許可する。
    #![allow(non_snake_case)]

    use super::*;
    use serde_json::json;

    fn roundtrip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let text = serde_json::to_string(value).expect("シリアライズできること");
        serde_json::from_str(&text).expect("デシリアライズできること")
    }

    #[test]
    fn id型はJSONでは裸の値として表現される() {
        let card = CardId::new();
        let text = serde_json::to_string(&card).unwrap();
        assert_eq!(text, format!("\"{}\"", card.0));

        let project = ProjectId("/home/example/dev/app".to_string());
        assert_eq!(
            serde_json::to_string(&project).unwrap(),
            "\"/home/example/dev/app\""
        );
    }

    #[test]
    fn session_statusは全バリアントが往復する() {
        let all = [
            SessionStatus::Starting,
            SessionStatus::Working,
            SessionStatus::WaitingPermission,
            SessionStatus::WaitingInput,
            SessionStatus::Stalled,
            SessionStatus::Ended { ok: true },
            SessionStatus::Ended { ok: false },
            SessionStatus::Unknown,
        ];
        for status in all {
            assert_eq!(roundtrip(&status), status);
        }
    }

    #[test]
    fn session_metaが往復する() {
        let meta = SessionMeta {
            card_id: CardId::new(),
            project: ProjectId("/home/example/dev/app".to_string()),
            claude_session_id: Some(ClaudeSessionId::new()),
            status: SessionStatus::WaitingPermission,
            subagent_active: 2,
            last_activity_at: 1_700_000_000_000,
            last_assistant_message: Some("実装が完了しました".to_string()),
            created_at: 1_699_999_000_000,
        };
        assert_eq!(roundtrip(&meta), meta);
    }

    #[test]
    fn nodeは全バリアントが往復する() {
        let nodes = vec![
            Node::UserMessage {
                text: "テストを流して".to_string(),
            },
            Node::AssistantText {
                text: "了解しました".to_string(),
            },
            Node::ToolCall {
                name: "Edit".to_string(),
                input: json!({ "old_string": "a", "new_string": "b" }),
                result: Some(json!({ "ok": true })),
                status: ToolStatus::Ok,
                subagent: None,
            },
            Node::ToolCall {
                name: "Task".to_string(),
                input: json!({ "prompt": "調査して" }),
                result: None,
                status: ToolStatus::Pending,
                subagent: Some(SubagentRef {
                    agent_type: "Explore".to_string(),
                    transcript_path: "subagents/agent-001.jsonl".to_string(),
                    spawn_depth: 1,
                }),
            },
            Node::Subagent {
                agent_type: "Explore".to_string(),
                spawn_depth: 1,
            },
            Node::Unknown {
                record_type: "queue-operation".to_string(),
                raw: json!({ "type": "queue-operation", "未知フィールド": 1 }),
            },
        ];
        for node in &nodes {
            assert_eq!(&roundtrip(node), node);
        }
    }

    #[test]
    fn 未知レコードは生データを保持したまま往復する() {
        // 寛容パースの肝：知らない構造でも情報を落とさずに運べること
        let raw = json!({
            "type": "brand-new-type",
            "nested": { "deep": [1, 2, { "x": null }] },
        });
        let node = Node::Unknown {
            record_type: "brand-new-type".to_string(),
            raw: raw.clone(),
        };
        match roundtrip(&node) {
            Node::Unknown { raw: restored, .. } => assert_eq!(restored, raw),
            other => panic!("Unknown 以外になった: {other:?}"),
        }
    }

    #[test]
    fn tree_nodeが往復する() {
        let node = TreeNode {
            id: NodeId("11111111-2222-3333-4444-555555555555".to_string()),
            parent: Some(NodeId("00000000-0000-0000-0000-000000000000".to_string())),
            node: Node::AssistantText {
                text: "done".to_string(),
            },
            ts: 1_700_000_000_123,
        };
        assert_eq!(roundtrip(&node), node);
    }
}
