//! 構造化履歴の**読みキャッシュ**（セルフホスト化設計§3-3）。
//!
//! # 真実は DB。ここは書き抜けの写し
//!
//! 初期実装では、この窓が履歴の持ち主だった——メモリに直近ぶんを持ち、そこから落ちた
//! 範囲はパーサに JSONL を読み直してもらう（`read_range`）という作り。フェーズ2 で
//! **DB が真実**になったので、窓は「いま書いたばかりのぶんを、DB へ問い合わせずに
//! 返すための写し」へ格下げになった（設計§3-3）。
//!
//! そのため、初期実装で持っていた**まばらな索引と `Anchor` は消えている**。
//! 遡りはバイト位置ではなく `seq` の順で DB に聞く（[`crate::db::transcript::page`]）ので、
//! 「ウィンドウから落ちたノードの位置を覚えておく」必要が無くなった。
//!
//! # 窓が空でも困らない
//!
//! サーバを再起動すると窓は空になるが、履歴は DB に残っている。復元のときに DB から
//! 直近ぶんを詰め直すので（[`crate::registry::SessionRegistry`]）、購読を始めた
//! クライアントには同じものが届く。

use protocol::TreeNode;
use std::collections::VecDeque;

/// 直近ぶんだけを持つ窓。
#[derive(Debug)]
pub struct TranscriptWindow {
    limit: usize,
    nodes: VecDeque<TreeNode>,
}

impl TranscriptWindow {
    pub fn new(limit: usize) -> Self {
        Self {
            limit: limit.max(1),
            nodes: VecDeque::new(),
        }
    }

    /// 直近ぶんで満たす（DB から復元するときに使う）。
    pub fn fill(&mut self, nodes: Vec<TreeNode>) {
        self.nodes = nodes.into();
        self.trim();
    }

    /// ノードを取り込む。**同じIDは上書き**する（設計§4 の upsert 契約）。
    pub fn append(&mut self, incoming: &[TreeNode]) {
        for node in incoming {
            // 更新の対象になるのはほぼ直近のノード（ツールコールの結果）なので、
            // 後ろから探すと実質1回で当たる
            match self.nodes.iter_mut().rev().find(|held| held.id == node.id) {
                Some(slot) => *slot = node.clone(),
                None => self.nodes.push_back(node.clone()),
            }
        }
        self.trim();
    }

    /// 購読を始めたクライアントへ最初に送る内容。
    pub fn snapshot(&self) -> Vec<TreeNode> {
        self.nodes.iter().cloned().collect()
    }

    /// 巻き戻り（`/rewind`）を受けて全部捨てる。
    pub fn clear(&mut self) {
        self.nodes.clear();
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    fn trim(&mut self) {
        while self.nodes.len() > self.limit {
            self.nodes.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use protocol::{Node, NodeId, ToolStatus};

    fn text_node(id: &str) -> TreeNode {
        TreeNode {
            id: NodeId(id.to_string()),
            parent: None,
            node: Node::AssistantText {
                text: id.to_string(),
            },
            ts: 0,
            branch: 0,
        }
    }

    fn tool_node(id: &str, status: ToolStatus) -> TreeNode {
        TreeNode {
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
        }
    }

    #[test]
    fn 同じIDのノードは上書きされる() {
        // ツールコールは結果が届いた時点で同じIDで送り直される（upsert 契約）
        let mut window = TranscriptWindow::new(100);
        window.append(&[tool_node("t1", ToolStatus::Pending)]);
        window.append(&[tool_node("t1", ToolStatus::Ok)]);

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
            window.append(&[text_node(&format!("n{index}"))]);
        }
        let ids: Vec<String> = window
            .snapshot()
            .into_iter()
            .map(|node| node.id.0)
            .collect();
        assert_eq!(ids, ["n2", "n3", "n4"], "末尾が残る");
    }

    #[test]
    fn 復元しても上限は守られる() {
        // DB から詰め直すとき、窓より多い件数を渡されても膨らませない
        let mut window = TranscriptWindow::new(2);
        window.fill(vec![text_node("a"), text_node("b"), text_node("c")]);
        let ids: Vec<String> = window
            .snapshot()
            .into_iter()
            .map(|node| node.id.0)
            .collect();
        assert_eq!(ids, ["b", "c"]);
    }

    #[test]
    fn 巻き戻りで全部捨てられる() {
        let mut window = TranscriptWindow::new(100);
        window.append(&[text_node("n1")]);
        window.clear();
        assert!(window.is_empty());
    }
}
