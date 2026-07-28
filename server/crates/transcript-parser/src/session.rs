//! 1セッション（本体＋サブエージェント群）の読み取りを取りまとめる層。
//!
//! # 1セッションは1ファイルではない
//!
//! ```text
//! ~/.claude/projects/<プロジェクト>/<sid>.jsonl          本体
//! ~/.claude/projects/<プロジェクト>/<sid>/subagents/
//!     agent-<agentId>.jsonl                              サブエージェントの会話
//!     agent-<agentId>.meta.json                          親との繋がり（1回書かれるだけ）
//! ```
//!
//! どのサブエージェントが現れるかは読んでみるまで分からないので、core には列挙させず
//! ここで見つける。再開位置は**ファイルごと**に持つ（1つのオフセットで代表させると、
//! 再起動のたびにサブエージェント側を先頭から読み直して二重に届く）。

use crate::parse::parse_line;
use crate::tail::{FileTail, Outcome};
use crate::thread::{AgentMeta, SessionThreader};
use protocol::CardId;
use protocol::ipc::{ParsedNode, ParserEvent};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

/// 1回の巡回で1ファイルから出す `nodes` イベントの最大ノード数。
///
/// 20MB のファイルに追いつくときに1発で送ると、WebSocket の送信キューを一撃で詰まらせる。
const MAX_NODES_PER_EVENT: usize = 500;

/// 監視中の1セッション。
pub struct SessionState {
    card_id: CardId,
    /// 本体トランスクリプトのパス
    path: PathBuf,
    threader: SessionThreader,
    tails: BTreeMap<PathBuf, FileTail>,
    /// 読み込み済みの meta.json（1回書かれるだけなので繰り返し読まない）
    metas_seen: HashSet<PathBuf>,
    /// 前回 stats を報告した時点のレコード数
    reported_records: u64,
    /// 再開時に「読むが発行しない」範囲。ファイル → そこまで
    catch_up_to: BTreeMap<PathBuf, u64>,
}

impl SessionState {
    pub fn new(card_id: CardId, path: PathBuf, from_offsets: &BTreeMap<String, u64>) -> Self {
        let mut tails = BTreeMap::new();
        let offset = from_offsets
            .get(&path.to_string_lossy().to_string())
            .copied()
            .unwrap_or(0);
        tails.insert(path.clone(), FileTail::new(path.clone(), offset));
        for (file, offset) in from_offsets {
            let file = PathBuf::from(file);
            tails
                .entry(file.clone())
                .or_insert_with(|| FileTail::new(file, *offset));
        }
        // 途中から再開する分は、先に「読むが発行しない」で索引だけ作り直す（§catch_up）
        let catch_up_to = tails
            .values()
            .filter(|tail| tail.offset() > 0)
            .map(|tail| (tail.path().to_path_buf(), tail.offset()))
            .collect();

        Self {
            card_id,
            path,
            threader: SessionThreader::new(),
            tails,
            metas_seen: HashSet::new(),
            reported_records: 0,
            catch_up_to,
        }
    }

    pub fn card_id(&self) -> CardId {
        self.card_id
    }

    /// 見張るべきディレクトリ。ファイルが未作成でも親を見ておけば作成を捕まえられる。
    pub fn dirs(&self) -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        if let Some(parent) = self.path.parent() {
            dirs.push(parent.to_path_buf());
        }
        if let Some(session_dir) = session_dir(&self.path) {
            dirs.push(session_dir);
        }
        dirs
    }

    /// 追記を読み、イベントを組み立てる。
    pub fn poll(&mut self) -> Vec<ParserEvent> {
        let mut events = Vec::new();
        self.catch_up();
        self.discover();

        // meta.json を先に取り込む。マウント先が未読でも threader が待ってくれる
        for meta in self.take_new_metas() {
            let nodes = self.threader.feed_meta(meta);
            push_nodes(&mut events, self.card_id, &self.path, nodes, None);
        }

        for path in self.read_order() {
            match self.read_one(&path) {
                Some(ParserEvent::Reset { card_id }) => {
                    // どれか1つでも巻き戻ったら、そのセッションの木は作り直す。
                    // 部分的に繋ぎ直すより、捨てて読み直すほうが確実に正しい
                    self.rebuild();
                    return vec![ParserEvent::Reset { card_id }];
                }
                Some(event) => events.push(event),
                None => {}
            }
        }

        if self.threader.stats().records_total != self.reported_records {
            self.reported_records = self.threader.stats().records_total;
            events.push(self.stats_event());
        }
        events
    }

    fn stats_event(&self) -> ParserEvent {
        let stats = self.threader.stats();
        ParserEvent::Stats {
            card_id: self.card_id,
            records_total: stats.records_total,
            parse_errors: stats.parse_errors,
            unknown_types: stats.unknown_types.clone(),
            orphans: stats.orphans,
            versions: stats.versions.clone(),
        }
    }

    /// 読む順番。**本体を必ず先に**読む。
    ///
    /// パスの並び順に任せると、`<sid>/subagents/...` が `<sid>.jsonl` より先に来る
    /// （パスの比較は要素単位で、`session` は `session.jsonl` より前になる）。
    /// 子を先に読むと、まだ親のツールコールを知らないまま中身が根へ散らばる。
    fn read_order(&self) -> Vec<PathBuf> {
        let mut paths = vec![self.path.clone()];
        paths.extend(
            self.tails
                .keys()
                .filter(|path| **path != self.path)
                .cloned(),
        );
        paths
    }

    fn read_one(&mut self, path: &Path) -> Option<ParserEvent> {
        // マウント先が決まっていないサブエージェントは、決まるまで読まない。
        // 先に読むと中身の親が根に固定されてしまい、後から繋ぎ直せない
        if let Some(agent_id) = agent_id_of(path) {
            if !self.threader.has_agent_root(&agent_id) {
                return None;
            }
        }
        let tail = self.tails.get_mut(path)?;
        let outcome = match tail.read() {
            Ok(outcome) => outcome,
            // 読めない事情（権限など）は致命傷にしない。次の巡回でまた試す
            Err(_) => return None,
        };
        match outcome {
            Outcome::Missing => None,
            Outcome::Reset => Some(ParserEvent::Reset {
                card_id: self.card_id,
            }),
            Outcome::Lines { lines, next_offset } => {
                if lines.is_empty() {
                    return None;
                }
                let agent_id = agent_id_of(path);
                let source = path.to_string_lossy().to_string();
                let mut nodes = Vec::new();
                for (offset, line) in lines {
                    let record = parse_line(&line);
                    for node in self
                        .threader
                        .feed_record(&source, agent_id.as_deref(), &record)
                    {
                        nodes.push(ParsedNode { node, offset });
                    }
                }
                Some(ParserEvent::Nodes {
                    card_id: self.card_id,
                    source,
                    nodes,
                    next_offset,
                })
            }
        }
    }

    /// 再開位置より前を「読むが発行しない」で通し、索引だけ作り直す。
    ///
    /// これが無いと、再開位置より前に始まったツールコールの索引が失われ、あとから届いた
    /// 結果が誰にも対応付かない。画面ではそのツールコールが**永久に「実行中」のまま**残る。
    /// 発行はしないので、既に core が持っているノードが二重に届くこともない。
    fn catch_up(&mut self) {
        if self.catch_up_to.is_empty() {
            return;
        }
        let plan = std::mem::take(&mut self.catch_up_to);
        // ここでも本体を先に通す。子を先に通すと、親のツールコールを知らないまま
        // 索引を作ることになり、マウントの手掛かりを取り逃がす
        let mut plan: Vec<(PathBuf, u64)> = plan.into_iter().collect();
        plan.sort_by_key(|(path, _)| *path != self.path);
        for (path, upto) in plan {
            let agent_id = agent_id_of(&path);
            let source = path.to_string_lossy().to_string();
            let mut tail = FileTail::new(&path, 0);
            while let Ok(Outcome::Lines { lines, next_offset }) = tail.read() {
                if lines.is_empty() {
                    break;
                }
                let mut done = next_offset >= upto;
                for (offset, line) in lines {
                    if offset >= upto {
                        done = true;
                        break;
                    }
                    let record = parse_line(&line);
                    // 戻り値は捨てる。索引（ツールコール・エージェント・親の解決）
                    // だけがここでの目的
                    let _ = self
                        .threader
                        .feed_record(&source, agent_id.as_deref(), &record);
                }
                if done {
                    break;
                }
            }
        }
        // 索引を作り直したぶんは報告済み扱いにする（同じ数を二度数えない）
        self.reported_records = self.threader.stats().records_total;
    }

    /// サブエージェントのファイルを見つけて監視対象に足す。
    fn discover(&mut self) {
        let Some(subagents) = subagents_dir(&self.path) else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(&subagents) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name.ends_with(".jsonl") && !self.tails.contains_key(&path) {
                self.tails.insert(path.clone(), FileTail::new(path, 0));
            }
        }
    }

    /// まだ読んでいない meta.json を読む。
    fn take_new_metas(&mut self) -> Vec<AgentMeta> {
        let Some(subagents) = subagents_dir(&self.path) else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(&subagents) else {
            return Vec::new();
        };
        let mut metas = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if !name.ends_with(".meta.json") || self.metas_seen.contains(&path) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            self.metas_seen.insert(path.clone());
            if let Some(meta) = parse_meta(&name, &text, &subagents) {
                metas.push(meta);
            }
        }
        metas
    }

    /// 木を捨てて先頭から読み直す準備をする。
    fn rebuild(&mut self) {
        self.threader = SessionThreader::new();
        self.metas_seen.clear();
        self.reported_records = 0;
        self.catch_up_to.clear();
        let paths: Vec<PathBuf> = self.tails.keys().cloned().collect();
        self.tails = paths
            .into_iter()
            .map(|path| (path.clone(), FileTail::new(path, 0)))
            .collect();
    }
}

fn push_nodes(
    events: &mut Vec<ParserEvent>,
    card_id: CardId,
    path: &Path,
    nodes: Vec<protocol::TreeNode>,
    offset: Option<u64>,
) {
    if nodes.is_empty() {
        return;
    }
    events.push(ParserEvent::Nodes {
        card_id,
        source: path.to_string_lossy().to_string(),
        nodes: nodes
            .into_iter()
            .map(|node| ParsedNode {
                node,
                offset: offset.unwrap_or(0),
            })
            .collect(),
        // meta 由来のノードはファイルの読み進みとは無関係なので、位置は動かさない
        next_offset: 0,
    });
}

/// `<sid>.jsonl` → `<sid>/`
fn session_dir(path: &Path) -> Option<PathBuf> {
    let stem = path.file_stem()?;
    Some(path.parent()?.join(stem))
}

/// `<sid>.jsonl` → `<sid>/subagents/`
fn subagents_dir(path: &Path) -> Option<PathBuf> {
    Some(session_dir(path)?.join("subagents"))
}

/// `agent-<id>.jsonl` → `<id>`
fn agent_id_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let id = name.strip_prefix("agent-")?.strip_suffix(".jsonl")?;
    Some(id.to_string())
}

/// `agent-<id>.meta.json` を [`AgentMeta`] にする。
fn parse_meta(file_name: &str, text: &str, subagents: &Path) -> Option<AgentMeta> {
    let agent_id = file_name
        .strip_prefix("agent-")?
        .strip_suffix(".meta.json")?
        .to_string();
    let value: Value = serde_json::from_str(text).ok()?;
    let text_of = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(ToString::to_string)
    };
    Some(AgentMeta {
        agent_type: text_of("agentType").unwrap_or_else(|| "unknown".to_string()),
        tool_use_id: text_of("toolUseId"),
        parent_agent_id: text_of("parentAgentId"),
        spawn_depth: value
            .get("spawnDepth")
            .and_then(Value::as_u64)
            .map(|depth| depth as u32),
        transcript_path: subagents
            .join(format!("agent-{agent_id}.jsonl"))
            .to_string_lossy()
            .to_string(),
        agent_id,
    })
}

/// 過去の範囲をその場で読み直す（REST のページングの裏側）。
///
/// **先頭から `to_offset` まで読んでから、要求された範囲だけを返す。**途中から読むと
/// ツリーの親子が分からず、ページを遡るたびに構造が崩れた履歴が出てしまう。
pub fn read_range(source: &Path, from_offset: u64, to_offset: u64) -> Vec<ParsedNode> {
    let mut threader = SessionThreader::new();
    let mut tail = FileTail::new(source, 0);
    let agent_id = agent_id_of(source);
    let key = source.to_string_lossy().to_string();
    let mut collected = Vec::new();

    while let Ok(Outcome::Lines { lines, next_offset }) = tail.read() {
        if lines.is_empty() {
            break;
        }
        let mut done = next_offset >= to_offset;
        for (offset, line) in lines {
            if offset >= to_offset {
                done = true;
                break;
            }
            let record = parse_line(&line);
            for node in threader.feed_record(&key, agent_id.as_deref(), &record) {
                if offset >= from_offset {
                    collected.push(ParsedNode { node, offset });
                }
            }
        }
        if done {
            break;
        }
    }
    collected
}

/// ノード列を、1イベントに載せすぎない大きさへ分ける。
pub fn chunk_nodes(nodes: Vec<ParsedNode>) -> Vec<Vec<ParsedNode>> {
    if nodes.len() <= MAX_NODES_PER_EVENT {
        return vec![nodes];
    }
    nodes
        .chunks(MAX_NODES_PER_EVENT)
        .map(<[ParsedNode]>::to_vec)
        .collect()
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn セッションのディレクトリ構成を導ける() {
        let path = Path::new("/p/9115e772.jsonl");
        assert_eq!(session_dir(path).unwrap(), Path::new("/p/9115e772"));
        assert_eq!(
            subagents_dir(path).unwrap(),
            Path::new("/p/9115e772/subagents")
        );
    }

    #[test]
    fn ファイル名からエージェントIDを取り出せる() {
        assert_eq!(
            agent_id_of(Path::new("/p/s/subagents/agent-a7b850ae4.jsonl")).as_deref(),
            Some("a7b850ae4")
        );
        // 本体トランスクリプトはエージェントではない
        assert_eq!(agent_id_of(Path::new("/p/s.jsonl")), None);
    }

    #[test]
    fn metaを読み取れる() {
        let meta = parse_meta(
            "agent-a1.meta.json",
            r#"{"agentType":"general-purpose","description":"調査","toolUseId":"toolu_1","spawnDepth":1}"#,
            Path::new("/p/s/subagents"),
        )
        .unwrap();
        assert_eq!(meta.agent_id, "a1");
        assert_eq!(meta.agent_type, "general-purpose");
        assert_eq!(meta.tool_use_id.as_deref(), Some("toolu_1"));
        assert_eq!(meta.spawn_depth, Some(1));
        assert_eq!(
            meta.transcript_path,
            "/p/s/subagents/agent-a1.jsonl".to_string()
        );
    }

    #[test]
    fn 深さ2のmetaはparentAgentIdを持ちtoolUseIdを持たない() {
        // 実データで確認した形。toolUseId 前提で書くとここで落ちる
        let meta = parse_meta(
            "agent-a2.meta.json",
            r#"{"agentType":"general-purpose","parentAgentId":"a1","spawnDepth":2}"#,
            Path::new("/p/s/subagents"),
        )
        .unwrap();
        assert_eq!(meta.tool_use_id, None);
        assert_eq!(meta.parent_agent_id.as_deref(), Some("a1"));
    }

    #[test]
    fn spawnDepthが無いmetaも読める() {
        let meta = parse_meta(
            "agent-a3.meta.json",
            r#"{"agentType":"Explore"}"#,
            Path::new("/p/s/subagents"),
        )
        .unwrap();
        assert_eq!(meta.spawn_depth, None);
    }

    #[test]
    fn 大きすぎるノード列は分割される() {
        let node = ParsedNode {
            node: protocol::TreeNode {
                id: protocol::NodeId("n".to_string()),
                parent: None,
                node: protocol::Node::AssistantText {
                    text: String::new(),
                },
                ts: 0,
            },
            offset: 0,
        };
        let chunks = chunk_nodes(vec![node; MAX_NODES_PER_EVENT + 1]);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), MAX_NODES_PER_EVENT);
        assert_eq!(chunks[1].len(), 1);
    }
}
