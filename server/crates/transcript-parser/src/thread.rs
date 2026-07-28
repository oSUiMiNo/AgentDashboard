//! スレッディング層 — レコードの列を、画面で掘れるツリーに組み立てる（設計§8 のパーサ中核）。
//!
//! # 表示のツリーは `parentUuid` の鎖そのものではない
//!
//! 設計§8-1 は「`uuid`/`parentUuid` でツリー連結」と書いているが、実データの `parentUuid` は
//! **会話の直線的な鎖**である（各レコードの親が直前のレコード）。これをそのまま表示の親子に
//! すると、レコード数ぶんの深さを持つ階段になり、数百レコードで完全に読めなくなる。
//! 要件が求めているのは「サブエージェント → ツールコール → 編集差分 と掘れる」表示であって、
//! 会話順の入れ子ではない。
//!
//! そこで表示の親子は**意味で決める**：
//!
//! ```text
//! 👤 ユーザのメッセージ            ← 根
//! 🤖 アシスタントの本文            ← 根（ここが「そのターンの見出し」になる）
//!   🔧 ツールコール                ← 直前のアシスタント本文の子
//!     🧩 サブエージェント          ← 起動したツールコールの子
//!       🔧 サブエージェント内のツールコール
//! ```
//!
//! `parentUuid` を捨てるわけではない。**未知種別のレコードを「どのあたりで起きたか」に
//! 置く**ために使う（[`SessionThreader::resolve`]）。ここで「表示しないが鎖には参加する」
//! 種別（`attachment` / `system`）を透過させないと、未知レコードの置き場所がずれる。
//!
//! # サブエージェントのマウントは2系統
//!
//! `subagents/` はフラットに並ぶだけで、木構造はファイル配置からは分からない。
//! `meta.json` のリンクだけが頼りで、しかも**深さによって鍵が違う**（実データで確認）。
//!
//! | 深さ | 鍵 |
//! |---|---|
//! | 1 | `toolUseId` → 親セッションの当該ツールコール |
//! | 2以上 | `parentAgentId` → 親エージェントのルートノード |
//!
//! どちらも解けないもの（`spawnDepth` すら無い meta も実在する）は**捨てずに根へ吊るす**。
//! 消すと「サブエージェントが走ったのに画面に何も出ない」という、いちばん困る形になる。

use crate::normalize::{self, Block};
use crate::parse::{Kind, Record};
use crate::stats::Stats;
use protocol::{Node, NodeId, SubagentRef, ToolStatus, TreeNode};
use serde_json::Value;
use std::collections::HashMap;

/// `agent-*.meta.json` から読んだ、サブエージェントの素性。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMeta {
    pub agent_id: String,
    pub agent_type: String,
    /// 深さ1のときの鍵。親セッションのツールコールIDを指す
    pub tool_use_id: Option<String>,
    /// 深さ2以上のときの鍵。親エージェントの識別子を指す
    pub parent_agent_id: Option<String>,
    /// 欠けている meta が実在するので `Option`
    pub spawn_depth: Option<u32>,
    pub transcript_path: String,
}

/// ツールコール1件の、結果が届くまでの状態。
#[derive(Debug, Clone)]
struct ToolCallState {
    node_id: NodeId,
    parent: Option<NodeId>,
    name: String,
    input: Value,
    result: Option<Value>,
    status: ToolStatus,
    subagent: Option<SubagentRef>,
    ts: i64,
}

impl ToolCallState {
    fn to_tree_node(&self) -> TreeNode {
        TreeNode {
            id: self.node_id.clone(),
            parent: self.parent.clone(),
            node: Node::ToolCall {
                name: self.name.clone(),
                input: self.input.clone(),
                result: self.result.clone(),
                status: self.status,
                subagent: self.subagent.clone(),
            },
            ts: self.ts,
        }
    }
}

/// 1ファイル分の読み進み状態。
#[derive(Debug, Default)]
struct FileState {
    /// このファイルのノードがぶら下がる根。サブエージェントのファイルなら
    /// そのエージェントのルートノード、本体なら `None`（＝画面の最上位）
    root: Option<NodeId>,
    /// 直近のアシスタント本文。ツールコールはここにぶら下がる
    turn_anchor: Option<NodeId>,
    /// レコードの `uuid` → 実際に発行したノード。未知レコードの置き場所の解決に使う
    resolved: HashMap<String, Option<NodeId>>,
}

/// 1セッション（本体＋サブエージェント群）ぶんのスレッディング。
///
/// ツールコールとエージェントの索引は**ファイルをまたぐ**ので、ここが持つ。
/// ファイルごとに分けると、深さ1のマウント（子ファイルの meta が親ファイルの
/// ツールコールを指す）が成立しない。
#[derive(Debug, Default)]
pub struct SessionThreader {
    files: HashMap<String, FileState>,
    /// tool_use_id → ツールコールの状態
    tool_calls: HashMap<String, ToolCallState>,
    /// agentId → そのエージェントを起動したツールコールの tool_use_id
    ///
    /// 親の `toolUseResult.agentId` から作る。meta に `toolUseId` が無い場合の代替経路
    agent_to_tool_use: HashMap<String, String>,
    /// agentId → そのエージェントのルートノード
    agent_roots: HashMap<String, NodeId>,
    /// マウント先がまだ決まらない meta。新しい索引が増えるたびに再挑戦する
    pending_metas: Vec<AgentMeta>,
    /// `uuid` を持たない未知レコードに振る通し番号
    synthetic_seq: u64,
    /// タイムスタンプが読めなかったときの代わり（0 にすると全部がエポックへ飛ぶ）
    last_ts: i64,
    stats: Stats,
}

impl SessionThreader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn stats(&self) -> &Stats {
        &self.stats
    }

    /// そのサブエージェントのマウント先が確定しているか。
    ///
    /// 確定する前に子ファイルを読むと、中身が根へ散らばったまま固定されてしまう
    /// （親が後から決まっても、発行済みノードの親は変えられない）。読み手はこれを見て
    /// 「まだ読まない」と判断する。
    pub fn has_agent_root(&self, agent_id: &str) -> bool {
        self.agent_roots.contains_key(agent_id)
    }

    /// レコード1件を取り込み、発行・更新されたノードを返す。
    ///
    /// 同じ [`NodeId`] のノードが再び返ることがある（ツールコールに結果が付いたとき）。
    /// 受け手は**上書き（upsert）**として扱うこと。
    pub fn feed_record(
        &mut self,
        source: &str,
        agent_id: Option<&str>,
        record: &Record,
    ) -> Vec<TreeNode> {
        self.stats.record();
        if record.broken {
            self.stats.parse_error();
        }
        if let Some(version) = &record.version {
            self.stats.version(version);
        }
        let ts = record.ts.unwrap_or(self.last_ts);
        self.last_ts = ts;

        // サブエージェントのファイルは、そのエージェントのルートの下に生える。
        // 一度 None で覚えてしまわないよう、根が判明した時点で必ず書き直す
        let agent_id = agent_id.or(record.agent_id.as_deref());
        if let Some(agent_id) = agent_id {
            if let Some(root) = self.agent_roots.get(agent_id).cloned() {
                self.files.entry(source.to_string()).or_default().root = Some(root);
            }
        }

        match record.kind() {
            Kind::Message => self.feed_message(source, record, ts),
            Kind::Transparent => {
                // 表示はしないが、鎖は繋いでおく。ここで切ると、後続の未知レコードが
                // 「どのあたりで起きたか」を見失って根に散らばる
                let parent = self.resolve(source, record.parent_uuid.as_deref());
                if let Some(uuid) = &record.uuid {
                    self.file(source).resolved.insert(uuid.clone(), parent);
                }
                Vec::new()
            }
            Kind::Noise => Vec::new(),
            Kind::Unknown => self.feed_unknown(source, record, ts),
        }
    }

    /// `agent-*.meta.json` を1件取り込む。
    pub fn feed_meta(&mut self, meta: AgentMeta) -> Vec<TreeNode> {
        let mut emitted = Vec::new();
        self.mount_agent(&meta, &mut emitted);
        emitted
    }

    // --- 内部 ---------------------------------------------------------------

    fn file(&mut self, source: &str) -> &mut FileState {
        self.files.entry(source.to_string()).or_default()
    }

    /// レコードの `parentUuid` から、実際に発行済みのノードを引く。
    ///
    /// 透過種別を挟んでいても [`Self::feed_record`] が解決済みの値を入れているので、
    /// ここで鎖を辿る必要はない。辿らないので循環で固まる余地も無い。
    fn resolve(&mut self, source: &str, parent_uuid: Option<&str>) -> Option<NodeId> {
        let root = self.files.get(source).and_then(|file| file.root.clone());
        let Some(parent_uuid) = parent_uuid else {
            return root;
        };
        match self
            .files
            .get(source)
            .and_then(|f| f.resolved.get(parent_uuid))
        {
            Some(resolved) => resolved.clone(),
            None => {
                // 親を指しているのに親を知らない。捨てずに根へ置き、数えておく
                self.stats.orphan();
                root
            }
        }
    }

    fn feed_message(&mut self, source: &str, record: &Record, ts: i64) -> Vec<TreeNode> {
        let root = self.files.get(source).and_then(|file| file.root.clone());
        let blocks = normalize::blocks(record);
        let uuid = record.uuid.clone().unwrap_or_else(|| self.synthetic_id());
        let mut emitted = Vec::new();
        let mut last_emitted: Option<NodeId> = None;

        for (index, block) in blocks.into_iter().enumerate() {
            let node_id = NodeId(format!("{uuid}#{index}"));
            match block {
                Block::UserText(text) => {
                    // 新しい指示が来たらターンが変わる。以後のツールコールは
                    // 次のアシスタント本文にぶら下がる
                    self.file(source).turn_anchor = None;
                    emitted.push(TreeNode {
                        id: node_id.clone(),
                        parent: root.clone(),
                        node: Node::UserMessage { text },
                        ts,
                    });
                    last_emitted = Some(node_id);
                }
                Block::AssistantText(text) => {
                    self.file(source).turn_anchor = Some(node_id.clone());
                    emitted.push(TreeNode {
                        id: node_id.clone(),
                        parent: root.clone(),
                        node: Node::AssistantText { text },
                        ts,
                    });
                    last_emitted = Some(node_id);
                }
                Block::Thinking(text) => {
                    emitted.push(TreeNode {
                        id: node_id.clone(),
                        parent: root.clone(),
                        node: Node::Thinking { text },
                        ts,
                    });
                    last_emitted = Some(node_id);
                }
                Block::ToolUse { id, name, input } => {
                    let parent = self
                        .files
                        .get(source)
                        .and_then(|file| file.turn_anchor.clone())
                        .or_else(|| root.clone());
                    let state = ToolCallState {
                        node_id: node_id.clone(),
                        parent,
                        name,
                        input,
                        result: None,
                        status: ToolStatus::Pending,
                        subagent: None,
                        ts,
                    };
                    emitted.push(state.to_tree_node());
                    if !id.is_empty() {
                        self.tool_calls.insert(id, state);
                        // 新しいツールコールが増えたので、待たせている meta を再挑戦
                        self.retry_pending(&mut emitted);
                    }
                    last_emitted = Some(node_id);
                }
                Block::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => {
                    // 結果は自分ではノードにならず、対応するツールコールへ合流する。
                    // 同じIDのノードを結果入りで送り直す（upsert 契約）
                    if let Some(state) = self.tool_calls.get_mut(&tool_use_id) {
                        // top-level の toolUseResult があればそちらを使う。Edit の
                        // structuredPatch のような差分表示に必要な情報はこちらにしかない
                        state.result = Some(match record.tool_use_result() {
                            Some(value) => normalize::truncate_value(value),
                            None => content,
                        });
                        state.status = if is_error {
                            ToolStatus::Error
                        } else {
                            ToolStatus::Ok
                        };
                        emitted.push(state.to_tree_node());
                    }
                    self.index_agent_from_result(record, &tool_use_id, &mut emitted);
                }
            }
        }

        if let Some(uuid) = &record.uuid {
            let resolved = last_emitted.or(root);
            self.file(source).resolved.insert(uuid.clone(), resolved);
        }
        emitted
    }

    fn feed_unknown(&mut self, source: &str, record: &Record, ts: i64) -> Vec<TreeNode> {
        let record_type = if record.record_type.is_empty() {
            "<壊れた行>"
        } else {
            &record.record_type
        };
        self.stats.unknown_type(record_type);

        let parent = self.resolve(source, record.parent_uuid.as_deref());
        let node_id = match &record.uuid {
            Some(uuid) => NodeId(uuid.clone()),
            None => NodeId(self.synthetic_id()),
        };
        if let Some(uuid) = &record.uuid {
            self.file(source)
                .resolved
                .insert(uuid.clone(), Some(node_id.clone()));
        }
        vec![TreeNode {
            id: node_id,
            parent,
            node: Node::Unknown {
                record_type: record_type.to_string(),
                raw: record.raw.clone(),
            },
            ts,
        }]
    }

    fn synthetic_id(&mut self) -> String {
        self.synthetic_seq += 1;
        format!("synthetic:{}", self.synthetic_seq)
    }

    /// 親のツール結果に載っている `agentId` から、エージェント→ツールコールの索引を作る。
    ///
    /// meta.json に `toolUseId` が無い場合の代替経路になる。
    fn index_agent_from_result(
        &mut self,
        record: &Record,
        tool_use_id: &str,
        emitted: &mut Vec<TreeNode>,
    ) {
        let Some(agent_id) = record
            .tool_use_result()
            .and_then(|value| value.get("agentId"))
            .and_then(Value::as_str)
        else {
            return;
        };
        self.agent_to_tool_use
            .insert(agent_id.to_string(), tool_use_id.to_string());
        self.retry_pending(emitted);
    }

    /// マウント待ちの meta を、増えた索引で再挑戦する。
    ///
    /// meta.json と本体 JSONL の書き込み順は保証されないので、片方向だけの解決だと
    /// 「meta が先に来た」ケースで永久に根へ取り残される。
    fn retry_pending(&mut self, emitted: &mut Vec<TreeNode>) {
        if self.pending_metas.is_empty() {
            return;
        }
        let pending = std::mem::take(&mut self.pending_metas);
        for meta in pending {
            self.mount_agent(&meta, emitted);
        }
    }

    fn mount_agent(&mut self, meta: &AgentMeta, emitted: &mut Vec<TreeNode>) {
        let node_id = NodeId(format!("agent:{}", meta.agent_id));

        // 経路1: meta の toolUseId（深さ1）／経路2: 親の結果に載っていた agentId
        let tool_use_id = meta
            .tool_use_id
            .clone()
            .or_else(|| self.agent_to_tool_use.get(&meta.agent_id).cloned());

        let (parent, depth_hint) = if let Some(tool_use_id) = tool_use_id.as_ref() {
            match self.tool_calls.get(tool_use_id) {
                Some(state) => (Some(state.node_id.clone()), Some(1)),
                None => {
                    // ツールコールがまだ読めていない。捨てずに待たせる
                    self.pending_metas.push(meta.clone());
                    return;
                }
            }
        } else if let Some(parent_agent_id) = &meta.parent_agent_id {
            // 経路3: 深さ2以上。親エージェントのルートへぶら下げる
            match self.agent_roots.get(parent_agent_id).cloned() {
                Some(parent) => (Some(parent), None),
                None => {
                    self.pending_metas.push(meta.clone());
                    return;
                }
            }
        } else {
            // 手掛かりが何も無い。根へ吊るす（消さないことが大事）
            (None, None)
        };

        let spawn_depth = meta.spawn_depth.or(depth_hint).unwrap_or(1);
        self.agent_roots
            .insert(meta.agent_id.clone(), node_id.clone());

        emitted.push(TreeNode {
            id: node_id.clone(),
            parent: parent.clone(),
            node: Node::Subagent {
                agent_type: meta.agent_type.clone(),
                spawn_depth,
            },
            ts: self.last_ts,
        });

        // 親のツールコールに「ここに子ツリーがある」ことを書き戻す（upsert）
        if let Some(tool_use_id) = tool_use_id {
            if let Some(state) = self.tool_calls.get_mut(&tool_use_id) {
                state.subagent = Some(SubagentRef {
                    agent_type: meta.agent_type.clone(),
                    transcript_path: meta.transcript_path.clone(),
                    spawn_depth,
                });
                emitted.push(state.to_tree_node());
            }
        }

        // 既に読み込み済みのサブエージェントのファイルへ、根を教え直す
        if let Some(file) = self.files.get_mut(&meta.transcript_path) {
            file.root = Some(node_id);
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use crate::parse::parse_line;

    const MAIN: &str = "/p/s.jsonl";

    fn feed(threader: &mut SessionThreader, line: &str) -> Vec<TreeNode> {
        let record = parse_line(line);
        threader.feed_record(MAIN, None, &record)
    }

    fn kinds(nodes: &[TreeNode]) -> Vec<&'static str> {
        nodes
            .iter()
            .map(|node| match node.node {
                Node::UserMessage { .. } => "user",
                Node::AssistantText { .. } => "assistant",
                Node::Thinking { .. } => "thinking",
                Node::ToolCall { .. } => "tool",
                Node::Subagent { .. } => "subagent",
                Node::Unknown { .. } => "unknown",
            })
            .collect()
    }

    #[test]
    fn ツールコールは直前のアシスタント本文にぶら下がる() {
        // 会話の鎖をそのまま親子にすると階段になるので、意味で親を決めている
        let mut threader = SessionThreader::new();
        feed(
            &mut threader,
            r#"{"type":"user","uuid":"u1","message":{"content":"テストを直して"}}"#,
        );
        let assistant = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","message":{"content":[
                {"type":"text","text":"確認します"}]}}"#,
        );
        let tool = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u3","parentUuid":"u2","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}"#,
        );

        assert_eq!(tool[0].parent.as_ref(), Some(&assistant[0].id));
        // ユーザとアシスタントは根に並ぶ（深さが会話の長さに比例しない）
        assert!(assistant[0].parent.is_none());
    }

    #[test]
    fn ツール結果は同じIDのノードを更新して届く() {
        let mut threader = SessionThreader::new();
        let call = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}]}}"#,
        );
        assert!(matches!(
            call[0].node,
            Node::ToolCall {
                status: ToolStatus::Pending,
                ..
            }
        ));

        let result = feed(
            &mut threader,
            r#"{"type":"user","uuid":"u2","parentUuid":"u1","toolUseResult":{"stdout":"ok"},
                "message":{"content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"ok"}]}}"#,
        );
        assert_eq!(result[0].id, call[0].id, "同じノードIDで送り直される");
        match &result[0].node {
            Node::ToolCall { status, result, .. } => {
                assert_eq!(*status, ToolStatus::Ok);
                // 差分表示に要る情報は top-level の toolUseResult 側にしかない
                assert_eq!(result.as_ref().unwrap().get("stdout").unwrap(), "ok");
            }
            other => panic!("ToolCall ではない: {other:?}"),
        }
    }

    #[test]
    fn 拒否された結果は文字列でも落ちずにエラーになる() {
        let mut threader = SessionThreader::new();
        feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Skill","input":{}}]}}"#,
        );
        let result = feed(
            &mut threader,
            r#"{"type":"user","uuid":"u2","toolUseResult":"Error: rejected","message":{"content":[
                {"tool_use_id":"toolu_1","type":"tool_result","content":"Error","is_error":true}]}}"#,
        );
        match &result[0].node {
            Node::ToolCall { status, .. } => assert_eq!(*status, ToolStatus::Error),
            other => panic!("ToolCall ではない: {other:?}"),
        }
    }

    #[test]
    fn 並列ツールコールは1レコードから別々のノードになる() {
        let mut threader = SessionThreader::new();
        let nodes = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"a","name":"Read","input":{}},
                {"type":"tool_use","id":"b","name":"Read","input":{}}]}}"#,
        );
        assert_eq!(kinds(&nodes), vec!["tool", "tool"]);
        assert_ne!(nodes[0].id, nodes[1].id, "1レコードでもIDが衝突しない");
    }

    #[test]
    fn 透過種別を挟んでも未知レコードの置き場所が繋がる() {
        // attachment を素通しで捨てると、その先の未知レコードが根へ散らばる
        let mut threader = SessionThreader::new();
        let assistant = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[{"type":"text","text":"本文"}]}}"#,
        );
        feed(
            &mut threader,
            r#"{"type":"attachment","uuid":"u2","parentUuid":"u1"}"#,
        );
        let unknown = feed(
            &mut threader,
            r#"{"type":"brand-new","uuid":"u3","parentUuid":"u2"}"#,
        );
        assert_eq!(kinds(&unknown), vec!["unknown"]);
        assert_eq!(unknown[0].parent.as_ref(), Some(&assistant[0].id));
    }

    #[test]
    fn ノイズ種別はノードにならない() {
        let mut threader = SessionThreader::new();
        assert!(
            feed(
                &mut threader,
                r#"{"type":"queue-operation","operation":"enqueue"}"#
            )
            .is_empty()
        );
        assert!(feed(&mut threader, r#"{"type":"ai-title","aiTitle":"題"}"#).is_empty());
    }

    #[test]
    fn 壊れた行は未知ノードとして残り数えられる() {
        let mut threader = SessionThreader::new();
        let nodes = feed(&mut threader, "{壊れている");
        assert_eq!(kinds(&nodes), vec!["unknown"]);
        assert_eq!(threader.stats().parse_errors, 1);
    }

    #[test]
    fn 親が見つからないレコードは根に置いて数える() {
        let mut threader = SessionThreader::new();
        let nodes = feed(
            &mut threader,
            r#"{"type":"brand-new","uuid":"u9","parentUuid":"居ない"}"#,
        );
        assert!(nodes[0].parent.is_none());
        assert_eq!(threader.stats().orphans, 1);
    }

    #[test]
    fn 深さ1のサブエージェントはtool_use_idでマウントされる() {
        let mut threader = SessionThreader::new();
        let call = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Agent","input":{"prompt":"調べて"}}]}}"#,
        );
        let mounted = threader.feed_meta(AgentMeta {
            agent_id: "a1".to_string(),
            agent_type: "Explore".to_string(),
            tool_use_id: Some("toolu_1".to_string()),
            parent_agent_id: None,
            spawn_depth: Some(1),
            transcript_path: "/p/s/subagents/agent-a1.jsonl".to_string(),
        });

        assert_eq!(kinds(&mounted), vec!["subagent", "tool"]);
        assert_eq!(mounted[0].parent.as_ref(), Some(&call[0].id));
        // 親のツールコールにも子ツリーの在処が書き戻される
        match &mounted[1].node {
            Node::ToolCall { subagent, .. } => {
                assert_eq!(subagent.as_ref().unwrap().agent_type, "Explore");
            }
            other => panic!("ToolCall ではない: {other:?}"),
        }
    }

    #[test]
    fn 深さ2のサブエージェントはparentAgentIdでマウントされる() {
        // 実データでは深さ2以上の meta は toolUseId を持たない
        let mut threader = SessionThreader::new();
        feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Agent","input":{}}]}}"#,
        );
        let parent = threader.feed_meta(AgentMeta {
            agent_id: "a1".to_string(),
            agent_type: "general-purpose".to_string(),
            tool_use_id: Some("toolu_1".to_string()),
            parent_agent_id: None,
            spawn_depth: Some(1),
            transcript_path: "/p/s/subagents/agent-a1.jsonl".to_string(),
        });
        let child = threader.feed_meta(AgentMeta {
            agent_id: "a2".to_string(),
            agent_type: "general-purpose".to_string(),
            tool_use_id: None,
            parent_agent_id: Some("a1".to_string()),
            spawn_depth: Some(2),
            transcript_path: "/p/s/subagents/agent-a2.jsonl".to_string(),
        });

        assert_eq!(child[0].parent.as_ref(), Some(&parent[0].id));
        match &child[0].node {
            Node::Subagent { spawn_depth, .. } => assert_eq!(*spawn_depth, 2),
            other => panic!("Subagent ではない: {other:?}"),
        }
    }

    #[test]
    fn metaが先に来ても後からマウントされる() {
        // meta.json と本体 JSONL の書き込み順は保証されない
        let mut threader = SessionThreader::new();
        let early = threader.feed_meta(AgentMeta {
            agent_id: "a1".to_string(),
            agent_type: "Explore".to_string(),
            tool_use_id: Some("toolu_1".to_string()),
            parent_agent_id: None,
            spawn_depth: Some(1),
            transcript_path: "/p/s/subagents/agent-a1.jsonl".to_string(),
        });
        assert!(early.is_empty(), "まだマウント先が無いので発行しない");

        let late = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Agent","input":{}}]}}"#,
        );
        assert_eq!(kinds(&late), vec!["tool", "subagent", "tool"]);
    }

    #[test]
    fn 手掛かりの無いmetaも捨てずに根へ吊るす() {
        // spawnDepth も toolUseId も無い meta が実在する
        let mut threader = SessionThreader::new();
        let mounted = threader.feed_meta(AgentMeta {
            agent_id: "a1".to_string(),
            agent_type: "Explore".to_string(),
            tool_use_id: None,
            parent_agent_id: None,
            spawn_depth: None,
            transcript_path: "/p/s/subagents/agent-a1.jsonl".to_string(),
        });
        assert_eq!(kinds(&mounted), vec!["subagent"]);
        assert!(mounted[0].parent.is_none());
    }

    #[test]
    fn サブエージェントのファイルはそのルートの下に生える() {
        let mut threader = SessionThreader::new();
        feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Agent","input":{}}]}}"#,
        );
        let mounted = threader.feed_meta(AgentMeta {
            agent_id: "a1".to_string(),
            agent_type: "Explore".to_string(),
            tool_use_id: Some("toolu_1".to_string()),
            parent_agent_id: None,
            spawn_depth: Some(1),
            transcript_path: "/p/s/subagents/agent-a1.jsonl".to_string(),
        });

        let record = parse_line(
            r#"{"type":"assistant","uuid":"c1","isSidechain":true,"agentId":"a1",
                "message":{"content":[{"type":"text","text":"子の応答"}]}}"#,
        );
        let child = threader.feed_record("/p/s/subagents/agent-a1.jsonl", Some("a1"), &record);
        assert_eq!(child[0].parent.as_ref(), Some(&mounted[0].id));
    }

    #[test]
    fn バージョンは行ごとに集めて集合になる() {
        let mut threader = SessionThreader::new();
        feed(
            &mut threader,
            r#"{"type":"user","uuid":"u1","version":"2.1.196"}"#,
        );
        feed(
            &mut threader,
            r#"{"type":"user","uuid":"u2","version":"2.1.220"}"#,
        );
        assert_eq!(threader.stats().versions.len(), 2);
    }
}
