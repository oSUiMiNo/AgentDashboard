//! サーバ・フロントエンド・パーサが共有するドメインモデル（設計§3）。
//!
//! このクレートは「型の定義」だけを持ち、振る舞いは持たない。自己修復機構（設計§9）が
//! 変更してよいのは transcript-parser だけで、このクレートは変更禁止の共有境界にあたる。
//! 未知のフォーマットは必ず [`Node::Unknown`] へ写像することで、この制約と両立させる。

pub mod a2s;
pub mod frame;
pub mod ipc;
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

/// 登録済みの PC（エージェント）のID（セルフホスト化設計§3-1）。
///
/// ローカルモードでは**エージェントという単位が存在しない**ので、セッションの
/// [`SessionMeta::agent_id`] は `None` になる。「1台だけの PC」を表す ID を作って
/// 埋めることはしない——ローカルには結び付ける相手（`agents` の行）が無く、
/// 存在しないものを指す ID は、後から本物の PC が繋がったときに区別できなくなる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AgentId(pub Uuid);

impl AgentId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for AgentId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for AgentId {
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

/// セッションの権限モード（`--permission-mode` の値）。
///
/// **列挙型にしない。** CLI 側はモードを増やしてきた実績があり（`auto` / `dontAsk` は
/// 比較的新しい）、知らない値で古いダッシュボードが落ちるほうが困る。知らない値は
/// **知らないまま運んで、そのまま表示する**（[`Node::Unknown`] と同じ考え方）。
/// 表示名・危険度・CLI へ渡す形は、受け手側が表で引く。
///
/// # 正規値は `default`、CLI へ渡す形は `manual`
///
/// 「毎回確認する」モードは、フックの payload と設定ファイルでは **`default`**、
/// CLI の `--permission-mode` では **`manual`** という2つの名前を持つ（`--help` の
/// choices に `default` は無い）。混ざると「manual で起動したのにフックが default と
/// 言ってきて、別のモードへ変わったように見える」ので、**運ぶ値は常に正規値へ寄せる**。
/// 変換規則をここに置いているのは、サーバもブラウザも同じ規則で判断する必要があるため。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PermissionMode(pub String);

impl PermissionMode {
    /// CLI が別名として受け付ける綴り。
    pub const MANUAL_ALIAS: &'static str = "manual";
    /// フックと設定ファイルが使う正規の綴り。
    pub const DEFAULT: &'static str = "default";

    /// 受け取った文字列を正規値へ寄せて包む。知らない値はそのまま通す。
    pub fn new(raw: impl Into<String>) -> Self {
        let raw = raw.into();
        if raw == Self::MANUAL_ALIAS {
            return Self(Self::DEFAULT.to_string());
        }
        Self(raw)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PermissionMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// セッションが使っている LLM モデル（`/model` の値、または CLI が名乗るフルID）。
///
/// **列挙型にしない。** 理由は [`PermissionMode`] と同じだが、こちらのほうが強く効く。
/// モデルは権限モードよりずっと頻繁に増えるので、列挙型にすると Anthropic が新しい
/// モデルを出した瞬間に古いダッシュボードが未知の値で落ちる。
///
/// # 2つの顔があることに注意
///
/// この型が運ぶ文字列には、出どころの違う2種類がある。
///
/// | 出どころ | 例 | どこで使うか |
/// |---|---|---|
/// | 切り替え先として利用者が選ぶ**別名** | `opus` / `sonnet` / `default` | `/model <値>` として送る |
/// | CLI が名乗る**フルID** | `claude-opus-5` | いま動いているモデルとして受け取る |
///
/// 別名を送ってもフルIDが返ってくるので、**送った値と返る値は一致しない**。
/// 「いま何で動いているか」の正は常に CLI 側にある（設計§1）。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ModelId(pub String);

impl ModelId {
    /// 指定を消してアカウントの既定へ戻す特別な値。モデル名ではない。
    pub const DEFAULT: &'static str = "default";

    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ModelId {
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
    /// いまの権限モード。
    ///
    /// `None` は「まだ分からない」— 起動時に指定せず、フックも端末フッタも
    /// まだ何も教えてくれていない状態。空欄にするのではなく **分からないことを
    /// 分からないと表示できる**ようにするための `Option`（`hooks_seen` と同じ理由）。
    pub permission_mode: Option<PermissionMode>,
    /// CLI が名乗った、いま動いているモデルのフルID（設計§4）。
    ///
    /// `None` は「モデルが無い」ではなく **まだ CLI が名乗っていない**。注入した
    /// `statusLine` が最初の値を送ってくるまでは必ずここから始まるので、画面は
    /// これを「不明」と出す。
    pub model: Option<ModelId>,
    /// 画面に出すモデルの名前（`Opus 5` など）。
    ///
    /// [`SessionMeta::model`] と2つ持つのは、**版番号をこちらで管理しないため**。
    /// 別名がどの版に解決されるかはプロバイダによって違う（`opus` は Anthropic API
    /// なら Opus 5、Microsoft Foundry なら Opus 4.6）ので、こちらの表には書けない。
    /// CLI が `statusLine` 経由で `display_name` をくれるので、それをそのまま出す。
    pub model_label: Option<String>,
    /// 切替を要求したが、まだ CLI が名乗り直していない値（設計§5 の楽観更新）。
    ///
    /// `statusLine` が走る契機に**モデル変更は入っていない**ので、`/model` を送った
    /// 直後は確定値が古いままになる。その間「押した手応え」を返すために要求値を先に
    /// 出すが、これは推測でしかないので確定値とは**別のフィールドに分けて持つ**。
    /// 画面はこれがあるあいだ、確定した値とは違う見た目にする。
    ///
    /// bool の印ではなく値そのものを持つのは、「Sonnet へ切替中」と具体的に出せるため。
    pub model_requested: Option<ModelId>,
    pub status: SessionStatus,
    /// 稼働中サブエージェント数。バッジ表示用で、status とは独立に増減する
    pub subagent_active: u32,
    pub last_activity_at: Timestamp,
    /// Stop フックの `last_assistant_message`。JSONL を読まずに小窓へ要約を出せる
    pub last_assistant_message: Option<String>,
    pub created_at: Timestamp,
    /// フックを1件でも受け取ったか（設計§11 の「フック未受信」警告の判定材料）。
    ///
    /// [`SessionStatus::Unknown`] には「フックが来ない」以外の理由もありうるので、
    /// *なぜ* 判断できないのかを画面に出すにはこの印が要る。フックが届かない原因は
    /// 設定の注入漏れやポートの塞がりで、利用者が直せるものが多い。
    pub hooks_seen: bool,
    /// どの PC のセッションか（セルフホスト化設計§3-1）。**ローカルモードは `None`**。
    ///
    /// 一覧に PC 名バッジを出すための材料（要件4-4「どの PC のセッションかは一覧で
    /// 判別できる」）。名前ではなく ID を運ぶのは、PC の名前が後から変わりうるため。
    pub agent_id: Option<AgentId>,
    /// この記録を持っている PC と、いま繋がっているか（セルフホスト化設計§6-3）。
    ///
    /// # なぜ [`SessionStatus`] の一種にしないのか
    ///
    /// 切断は「最後に知っていた状態」を**上書きする情報ではなく、その鮮度に関する
    /// 情報**だから。要件2-3 の「作業中のまま固まってはならない」は、状態を偽らずに
    /// 「古いこと」を明示することで満たす——画面には「作業中（接続断）」と出る。
    ///
    /// ローカルモードでも意味を持つ。DB が真実になったので、**再起動前のカードが
    /// 記録として戻ってくる**（PTY は道連れで死んでいる）。それを `false` で示す。
    pub agent_connected: bool,
    /// 帰属アカウント名（表示用。セルフホスト化設計§3-1）。
    ///
    /// 権限そのものではない——**権限の源はペアリングトークン**（§8-5）で、これは
    /// 画面に出すための名前。ローカルモードはアカウントを表に出さないので `None`。
    pub account: Option<String>,
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
    /// アシスタントの思考（`thinking` ブロック）。
    ///
    /// 実データでは assistant の content ブロックの相当数を占めるため、受け皿が無いと
    /// 思考が丸ごと [`Node::Unknown`] に落ちる。表示は既定で折り畳む想定。
    Thinking {
        text: String,
    },
    ToolCall {
        name: String,
        input: serde_json::Value,
        result: Option<serde_json::Value>,
        status: ToolStatus,
        /// サブエージェントを起動するツールの場合、子ツリーのマウント先情報が入る
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
    /// 何本目の会話の枝に属するか（0 始まり）。
    ///
    /// `/rewind` は JSONL を物理的に巻き戻さず、**同じファイルの末尾に2つ目の根として
    /// 追記する**（設計§16 の実測）。そのため巻き戻して捨てたはずのやりとりも履歴に
    /// 残り続ける。番号を振っておくと、画面が「最新の枝以外は畳む」判断をできる。
    ///
    /// 増えるのは本体ファイルに `parentUuid` を持たないユーザ発言が現れたとき。
    /// サブエージェントのファイルは、起動元のツールコールの枝を引き継ぐ。
    #[serde(default)]
    pub branch: u32,
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
            permission_mode: Some(PermissionMode::new("acceptEdits")),
            model: Some(ModelId::new("claude-opus-5")),
            model_label: Some("Opus 5".to_string()),
            model_requested: Some(ModelId::new("sonnet")),
            status: SessionStatus::WaitingPermission,
            subagent_active: 2,
            last_activity_at: 1_700_000_000_000,
            last_assistant_message: Some("実装が完了しました".to_string()),
            created_at: 1_699_999_000_000,
            hooks_seen: true,
            agent_id: Some(AgentId::new()),
            agent_connected: false,
            account: Some("mao".to_string()),
        };
        assert_eq!(roundtrip(&meta), meta);
    }

    #[test]
    fn session_metaのPCまわりは省略できない() {
        // TypeScript 側と手で二重に定義しているので（PJTガイドライン）、片方だけ
        // 直しても Rust は通ってしまう。**JSON の形そのもの**を突き合わせて、
        // 増えた3つが確かに線を渡っていることを見る
        let meta = SessionMeta {
            card_id: CardId(uuid::uuid!("00000000-0000-0000-0000-000000000001")),
            project: ProjectId("/p".to_string()),
            claude_session_id: None,
            permission_mode: None,
            model: None,
            model_label: None,
            model_requested: None,
            status: SessionStatus::Working,
            subagent_active: 0,
            last_activity_at: 1,
            last_assistant_message: None,
            created_at: 1,
            hooks_seen: false,
            agent_id: None,
            agent_connected: true,
            account: None,
        };
        assert_eq!(
            serde_json::to_string(&meta).unwrap(),
            r#"{"card_id":"00000000-0000-0000-0000-000000000001","project":"/p","claude_session_id":null,"permission_mode":null,"model":null,"model_label":null,"model_requested":null,"status":{"kind":"working"},"subagent_active":0,"last_activity_at":1,"last_assistant_message":null,"created_at":1,"hooks_seen":false,"agent_id":null,"agent_connected":true,"account":null}"#
        );
    }

    #[test]
    fn manualは正規値のdefaultへ寄せられる() {
        // CLI では manual、フックと設定では default。混ざると「起動したモードと
        // フックが言うモードが違う」ように見えるので、運ぶ値は片方へ寄せる
        assert_eq!(PermissionMode::new("manual").as_str(), "default");
        assert_eq!(PermissionMode::new("default").as_str(), "default");
    }

    #[test]
    fn モデルは裸の文字列として運ばれ知らない値も通る() {
        // モデルは権限モードよりずっと頻繁に増える。知らない値で落ちてはいけない
        // （列挙型にしない理由そのもの）
        let known = ModelId::new("claude-opus-5");
        assert_eq!(roundtrip(&known), known);
        assert_eq!(
            serde_json::to_string(&known).unwrap(),
            r#""claude-opus-5""#,
            "裸の文字列として運ばれること"
        );

        let unknown = ModelId::new("まだ知らないモデル");
        assert_eq!(unknown.as_str(), "まだ知らないモデル");
        assert_eq!(roundtrip(&unknown), unknown);
    }

    #[test]
    fn 確定したモデルと切替を要求した値は別のフィールドで運ばれる() {
        // 楽観更新した値が確定値と同じ顔をすると、CLI に拒否されたときに
        // 画面が嘘をつき続ける（設計§5）
        let meta = SessionMeta {
            card_id: CardId::new(),
            project: ProjectId("/home/example/dev/app".to_string()),
            claude_session_id: None,
            permission_mode: None,
            model: Some(ModelId::new("claude-haiku-4-5")),
            model_label: Some("Haiku 4.5".to_string()),
            model_requested: Some(ModelId::new("opus")),
            status: SessionStatus::Working,
            subagent_active: 0,
            last_activity_at: 1,
            last_assistant_message: None,
            created_at: 1,
            hooks_seen: false,
            agent_id: None,
            agent_connected: true,
            account: None,
        };
        let back = roundtrip(&meta);
        assert_eq!(back.model, meta.model);
        assert_eq!(back.model_requested, meta.model_requested);
        assert_ne!(
            back.model, back.model_requested,
            "確定値と要求値が同じ入れ物に潰れていないこと"
        );
    }

    #[test]
    fn まだ名乗っていないモデルはnullとして運ばれる() {
        // 「モデルが無い」ではなく「まだ CLI が名乗っていない」を表す null。
        // フロントの `ModelId | null` と1対1で対応させるため、キーごと消してはいけない
        let meta = SessionMeta {
            card_id: CardId::new(),
            project: ProjectId("/tmp".to_string()),
            claude_session_id: None,
            permission_mode: None,
            model: None,
            model_label: None,
            model_requested: None,
            status: SessionStatus::Starting,
            subagent_active: 0,
            last_activity_at: 1,
            last_assistant_message: None,
            created_at: 1,
            hooks_seen: false,
            agent_id: None,
            agent_connected: true,
            account: None,
        };
        let text = serde_json::to_string(&meta).unwrap();
        assert!(text.contains(r#""model":null"#), "実際: {text}");
        assert!(text.contains(r#""model_label":null"#), "実際: {text}");
        assert!(text.contains(r#""model_requested":null"#), "実際: {text}");
    }

    #[test]
    fn 知らないモードはそのまま運ばれる() {
        // CLI がモードを増やしても古いダッシュボードが落ちないこと（列挙型にしない理由）
        let unknown = PermissionMode::new("まだ知らないモード");
        assert_eq!(unknown.as_str(), "まだ知らないモード");
        assert_eq!(roundtrip(&unknown), unknown);
        assert_eq!(
            serde_json::to_string(&unknown).unwrap(),
            r#""まだ知らないモード""#,
            "裸の文字列として運ばれること"
        );
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
            Node::Thinking {
                text: "まず失敗しているテストを確認する".to_string(),
            },
            Node::ToolCall {
                name: "Edit".to_string(),
                input: json!({ "old_string": "a", "new_string": "b" }),
                result: Some(json!({ "ok": true })),
                status: ToolStatus::Ok,
                subagent: None,
            },
            // サブエージェント起動ツールの実名は v2.1.220 の実データでは `Agent`
            Node::ToolCall {
                name: "Agent".to_string(),
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
            branch: 1,
        };
        assert_eq!(roundtrip(&node), node);
    }
}
