//! セッション1枚ぶんの履歴の保持（設計§4）。
//!
//! # メモリに全部は置かない
//!
//! 実運用のトランスクリプトは1ファイル20MB規模になる（実測）。全部をメモリに置くと
//! セッションが増えるほど破綻するので、core が持つのは**直近ウィンドウだけ**にする。
//! それより古い範囲を要求されたら、パーサに `read_range` を頼んで読み直す。
//!
//! # 「どこから読み直すか」を決めるための索引
//!
//! ブラウザは「このノードより前を200件」と要求してくるが、パーサが受け取れるのは
//! バイト位置である。ウィンドウから落ちたノードの位置を覚えていないと、この変換ができない。
//! そのため**まばらな索引**（一定間隔でノードIDと位置を控える）を別に持つ。
//! 1件あたり数十バイトなので、20万ノードでも数百KBに収まる。

use protocol::{NodeId, TreeNode, ipc::ParsedNode};
use std::collections::VecDeque;

/// まばらな索引を刻む間隔（ノード数）。
const SPARSE_EVERY: u64 = 50;

/// ページングの起点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    /// 読み直す対象のファイル
    pub source: String,
    /// このバイト位置より前を読む
    pub offset: u64,
}

/// 直近ウィンドウと、過去へ遡るための索引。
#[derive(Debug)]
pub struct TranscriptWindow {
    limit: usize,
    /// (ノード, ファイル番号, バイト位置)
    nodes: VecDeque<(TreeNode, usize, u64)>,
    /// ファイル名の重複を持たないための対応表
    sources: Vec<String>,
    /// ウィンドウから落ちたあとも遡れるようにする、まばらな索引
    sparse: Vec<(NodeId, usize, u64)>,
    /// 通算で受け取ったノード数（まばらな索引の間引きに使う）
    seen: u64,
}

impl TranscriptWindow {
    pub fn new(limit: usize) -> Self {
        Self {
            limit: limit.max(1),
            nodes: VecDeque::new(),
            sources: Vec::new(),
            sparse: Vec::new(),
            seen: 0,
        }
    }

    /// ノードを取り込む。**同じIDは上書き**する（設計§4 の upsert 契約）。
    ///
    /// 返り値は、実際に表示へ反映すべきノード（＝渡された全部）。
    pub fn append(&mut self, source: &str, incoming: &[ParsedNode]) {
        if incoming.is_empty() {
            return;
        }
        let source_index = self.intern(source);

        for parsed in incoming {
            // 更新の対象になるのはほぼ直近のノード（ツールコールの結果）なので、
            // 後ろから探すと実質1回で当たる
            if let Some(slot) = self
                .nodes
                .iter_mut()
                .rev()
                .find(|(node, _, _)| node.id == parsed.node.id)
            {
                slot.0 = parsed.node.clone();
                continue;
            }

            self.seen += 1;
            if self.seen % SPARSE_EVERY == 0 {
                self.sparse
                    .push((parsed.node.id.clone(), source_index, parsed.offset));
            }
            self.nodes
                .push_back((parsed.node.clone(), source_index, parsed.offset));
        }

        while self.nodes.len() > self.limit {
            self.nodes.pop_front();
        }
    }

    /// 購読を始めたクライアントへ最初に送る内容。
    pub fn snapshot(&self) -> Vec<TreeNode> {
        self.nodes.iter().map(|(node, _, _)| node.clone()).collect()
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// 巻き戻り（`/rewind`）を受けて全部捨てる。
    pub fn clear(&mut self) {
        self.nodes.clear();
        self.sparse.clear();
        self.sources.clear();
        self.seen = 0;
    }

    /// ウィンドウの中に持っている「このノードより前」を返す。
    ///
    /// 手元にある範囲で答えられるならパーサへ行く必要がない。
    pub fn before_in_window(&self, before: &NodeId, limit: usize) -> Option<Vec<TreeNode>> {
        let position = self
            .nodes
            .iter()
            .position(|(node, _, _)| node.id == *before)?;
        if position == 0 {
            // 手元の先頭。これより前はウィンドウの外にある
            return None;
        }
        let start = position.saturating_sub(limit);
        Some(
            self.nodes
                .iter()
                .skip(start)
                .take(position - start)
                .map(|(node, _, _)| node.clone())
                .collect(),
        )
    }

    /// ウィンドウの外を読み直すための起点を求める。
    pub fn anchor_for(&self, before: &NodeId) -> Option<Anchor> {
        let found = self
            .nodes
            .iter()
            .find(|(node, _, _)| node.id == *before)
            .map(|(_, source, offset)| (*source, *offset))
            .or_else(|| {
                self.sparse
                    .iter()
                    .find(|(id, _, _)| id == before)
                    .map(|(_, source, offset)| (*source, *offset))
            })?;
        Some(Anchor {
            source: self.sources.get(found.0)?.clone(),
            offset: found.1,
        })
    }

    fn intern(&mut self, source: &str) -> usize {
        if let Some(index) = self.sources.iter().position(|known| known == source) {
            return index;
        }
        self.sources.push(source.to_string());
        self.sources.len() - 1
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use protocol::{Node, ToolStatus};

    const SOURCE: &str = "/p/s.jsonl";

    fn text_node(id: &str, offset: u64) -> ParsedNode {
        ParsedNode {
            node: TreeNode {
                id: NodeId(id.to_string()),
                parent: None,
                node: Node::AssistantText {
                    text: id.to_string(),
                },
                ts: 0,
                branch: 0,
            },
            offset,
        }
    }

    fn tool_node(id: &str, offset: u64, status: ToolStatus) -> ParsedNode {
        ParsedNode {
            node: TreeNode {
                id: NodeId(id.to_string()),
                parent: None,
                node: Node::ToolCall {
                    name: "Bash".to_string(),
                    input: serde_json::Value::Null,
                    result: None,
                    status,
                    subagent: None,
                },
                ts: 0,
                branch: 0,
            },
            offset,
        }
    }

    #[test]
    fn 同じIDのノードは上書きされる() {
        // ツールコールは結果が届いた時点で同じIDで送り直される（upsert 契約）
        let mut window = TranscriptWindow::new(100);
        window.append(SOURCE, &[tool_node("t1", 0, ToolStatus::Pending)]);
        window.append(SOURCE, &[tool_node("t1", 0, ToolStatus::Ok)]);

        assert_eq!(window.len(), 1, "二重に積まれていない");
        match &window.snapshot()[0].node {
            Node::ToolCall { status, .. } => assert_eq!(*status, ToolStatus::Ok),
            other => panic!("ToolCall ではない: {other:?}"),
        }
    }

    #[test]
    fn 上限を超えたら古い方から捨てる() {
        let mut window = TranscriptWindow::new(3);
        for index in 0..5 {
            window.append(SOURCE, &[text_node(&format!("n{index}"), index * 10)]);
        }
        assert_eq!(window.len(), 3);
        let ids: Vec<String> = window
            .snapshot()
            .into_iter()
            .map(|node| node.id.0)
            .collect();
        assert_eq!(ids, vec!["n2", "n3", "n4"], "末尾が残る");
    }

    #[test]
    fn ウィンドウ内なら遡りをその場で返せる() {
        let mut window = TranscriptWindow::new(100);
        for index in 0..10 {
            window.append(SOURCE, &[text_node(&format!("n{index}"), index * 10)]);
        }
        let before = window
            .before_in_window(&NodeId("n5".to_string()), 2)
            .unwrap();
        let ids: Vec<String> = before.into_iter().map(|node| node.id.0).collect();
        assert_eq!(ids, vec!["n3", "n4"]);
    }

    #[test]
    fn ウィンドウの先頭より前は手元では答えられない() {
        let mut window = TranscriptWindow::new(3);
        for index in 0..5 {
            window.append(SOURCE, &[text_node(&format!("n{index}"), index * 10)]);
        }
        // n2 が手元の先頭。これより前はパーサに読み直してもらうしかない
        assert!(
            window
                .before_in_window(&NodeId("n2".to_string()), 2)
                .is_none()
        );
    }

    #[test]
    fn ウィンドウから落ちたノードもまばらな索引で位置を引ける() {
        // これが無いと「このノードより前」をバイト位置に変換できず、遡れなくなる
        let mut window = TranscriptWindow::new(5);
        for index in 0..(SPARSE_EVERY * 2) {
            window.append(SOURCE, &[text_node(&format!("n{index}"), index * 10)]);
        }
        let anchor = window
            .anchor_for(&NodeId(format!("n{}", SPARSE_EVERY - 1)))
            .expect("まばらな索引に載っている");
        assert_eq!(anchor.source, SOURCE);
        assert_eq!(anchor.offset, (SPARSE_EVERY - 1) * 10);
    }

    #[test]
    fn 巻き戻りで全部捨てられる() {
        let mut window = TranscriptWindow::new(100);
        window.append(SOURCE, &[text_node("n1", 0)]);
        window.clear();
        assert!(window.is_empty());
        assert!(window.anchor_for(&NodeId("n1".to_string())).is_none());
    }

    #[test]
    fn 複数のファイルから来ても位置を取り違えない() {
        // 本体とサブエージェントのファイルが混ざる
        let mut window = TranscriptWindow::new(100);
        window.append(SOURCE, &[text_node("main", 100)]);
        window.append("/p/s/subagents/agent-a1.jsonl", &[text_node("sub", 200)]);

        assert_eq!(
            window
                .anchor_for(&NodeId("main".to_string()))
                .unwrap()
                .source,
            SOURCE
        );
        assert_eq!(
            window
                .anchor_for(&NodeId("sub".to_string()))
                .unwrap()
                .source,
            "/p/s/subagents/agent-a1.jsonl"
        );
    }
}
