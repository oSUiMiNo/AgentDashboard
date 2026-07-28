//! ゴールデンフィクスチャ（実トランスクリプト）を通しで変換できることの検証。
//!
//! テスト計画フェーズ3の「ゴールデンフィクスチャ」項目にあたる。ここは同時に
//! **自己修復のテストゲート**（設計§9 安全条件2）を兼ねる：フォーマット変更に対応した
//! 新しいパーサが、過去バージョンのフィクスチャを壊していないことをここで担保する。
//!
//! 合成データではなく実物を通すのが要点。実データにしか無い形（`attachment` が親子の鎖に
//! 挟まる・ツール結果が文字列になる拒否ケース・サブエージェントのフラットな配置）は、
//! 手で書いたデータでは再現できない。

use protocol::Node;
use protocol::ipc::ParserEvent;
use std::collections::BTreeMap;
use std::path::PathBuf;
use transcript_parser::session::SessionState;

fn fixture(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures")
        .join(relative)
}

/// 木が落ち着くまで巡回し、ノードを id で畳んだ結果を返す。
///
/// 同じ id のノードは上書き（upsert）する。ツールコールは結果が届いた時点で
/// 送り直されるため、単純に積むと同じものが二重に数えられる。
struct Parsed {
    nodes: BTreeMap<String, protocol::TreeNode>,
    /// 発行の記録（由来のバイト位置つき）。同じ id が複数回出るのは正常
    emissions: Vec<(u64, protocol::TreeNode)>,
    stats: Option<ParserEvent>,
    resets: usize,
}

impl Parsed {
    fn of(path: PathBuf) -> Self {
        Self::resumed(path, &BTreeMap::new())
    }

    /// 途中から再開したときの発行内容を得る。
    fn resumed(path: PathBuf, from_offsets: &BTreeMap<String, u64>) -> Self {
        let mut session = SessionState::new(protocol::CardId::new(), path, from_offsets);
        let mut parsed = Parsed {
            nodes: BTreeMap::new(),
            emissions: Vec::new(),
            stats: None,
            resets: 0,
        };
        // meta とレコードの読み込み順に依存しないよう、変化が止まるまで回す
        for _ in 0..8 {
            let events = session.poll();
            if events.is_empty() {
                break;
            }
            for event in events {
                match event {
                    ParserEvent::Nodes { nodes, .. } => {
                        for parsed_node in nodes {
                            parsed
                                .emissions
                                .push((parsed_node.offset, parsed_node.node.clone()));
                            parsed
                                .nodes
                                .insert(parsed_node.node.id.0.clone(), parsed_node.node);
                        }
                    }
                    ParserEvent::Reset { .. } => parsed.resets += 1,
                    stats @ ParserEvent::Stats { .. } => parsed.stats = Some(stats),
                    _ => {}
                }
            }
        }
        parsed
    }

    fn count(&self, kind: &str) -> usize {
        self.nodes
            .values()
            .filter(|node| kind_of(&node.node) == kind)
            .count()
    }

    fn tool_calls(&self) -> Vec<&protocol::TreeNode> {
        self.nodes
            .values()
            .filter(|node| matches!(node.node, Node::ToolCall { .. }))
            .collect()
    }

    fn orphans(&self) -> u64 {
        match &self.stats {
            Some(ParserEvent::Stats { orphans, .. }) => *orphans,
            _ => 0,
        }
    }

    fn unknown_types(&self) -> BTreeMap<String, u64> {
        match &self.stats {
            Some(ParserEvent::Stats { unknown_types, .. }) => unknown_types.clone(),
            _ => BTreeMap::new(),
        }
    }
}

fn kind_of(node: &Node) -> &'static str {
    match node {
        Node::UserMessage { .. } => "user",
        Node::AssistantText { .. } => "assistant",
        Node::Thinking { .. } => "thinking",
        Node::ToolCall { .. } => "tool",
        Node::Subagent { .. } => "subagent",
        Node::Unknown { .. } => "unknown",
    }
}

#[test]
fn basic_toolsのフィクスチャが期待どおりのツリーになる() {
    let parsed = Parsed::of(fixture("v2.1.220/basic-tools/session.jsonl"));

    assert_eq!(parsed.count("user"), 1, "最初のプロンプト1件");
    assert_eq!(parsed.count("thinking"), 5);
    assert_eq!(parsed.count("assistant"), 5);
    assert_eq!(
        parsed.count("tool"),
        5,
        "Skill / Read / Edit / Bash / Write"
    );
    assert_eq!(parsed.resets, 0);

    // 実データに存在する type はすべて既知として扱えている
    assert!(
        parsed.unknown_types().is_empty(),
        "未知の種別が出た: {:?}",
        parsed.unknown_types()
    );
    assert_eq!(parsed.orphans(), 0, "親を見失ったレコードは無い");
}

#[test]
fn ツールコールには結果が対応付く() {
    let parsed = Parsed::of(fixture("v2.1.220/basic-tools/session.jsonl"));

    for node in parsed.tool_calls() {
        let Node::ToolCall {
            name,
            result,
            status,
            ..
        } = &node.node
        else {
            unreachable!()
        };
        assert!(
            result.is_some(),
            "{name} の結果が対応付いていない（tool_use_id の突き合わせが壊れている）"
        );
        assert_ne!(
            *status,
            protocol::ToolStatus::Pending,
            "{name} が保留のまま"
        );
    }
}

#[test]
fn 拒否されたツールはエラーとして残る() {
    // このフィクスチャの Skill は利用者に拒否されており、toolUseResult が文字列になる。
    // オブジェクト前提で書いているとここで落ちる
    let parsed = Parsed::of(fixture("v2.1.220/basic-tools/session.jsonl"));
    let errors: Vec<&str> = parsed
        .tool_calls()
        .into_iter()
        .filter_map(|node| match &node.node {
            Node::ToolCall {
                name,
                status: protocol::ToolStatus::Error,
                ..
            } => Some(name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(errors, vec!["Skill"]);
}

#[test]
fn ツールコールは直前のアシスタント本文の子になる() {
    // 会話の鎖をそのまま親子にすると階段になるので、意味で親を決めている。
    // 実データで「根がユーザとアシスタントだけ」になることを確認する
    let parsed = Parsed::of(fixture("v2.1.220/basic-tools/session.jsonl"));

    for node in parsed.tool_calls() {
        let parent = node.parent.as_ref().expect("ツールコールには親がある");
        let parent_node = parsed.nodes.get(&parent.0).expect("親が発行済みである");
        assert_eq!(
            kind_of(&parent_node.node),
            "assistant",
            "ツールコールの親はアシスタント本文であること"
        );
    }

    let root_kinds: Vec<&str> = parsed
        .nodes
        .values()
        .filter(|node| node.parent.is_none())
        .map(|node| kind_of(&node.node))
        .collect();
    assert!(
        root_kinds
            .iter()
            .all(|kind| matches!(*kind, "user" | "assistant" | "thinking")),
        "根に来てよいのは会話の本文だけ: {root_kinds:?}"
    );
}

#[test]
fn サブエージェントが親のツールコールにマウントされる() {
    let parsed = Parsed::of(fixture("v2.1.220/subagent/session.jsonl"));

    // 子ツリーの根
    let subagent = parsed
        .nodes
        .values()
        .find(|node| matches!(node.node, Node::Subagent { .. }))
        .expect("サブエージェントのルートが発行される");
    match &subagent.node {
        Node::Subagent {
            agent_type,
            spawn_depth,
        } => {
            assert_eq!(agent_type, "general-purpose");
            assert_eq!(*spawn_depth, 1);
        }
        other => panic!("Subagent ではない: {other:?}"),
    }

    // マウント先は Agent ツールコール（実データのツール名は Task ではなく Agent）
    let parent = subagent.parent.as_ref().expect("マウント先がある");
    let parent_node = parsed.nodes.get(&parent.0).expect("親が発行済み");
    match &parent_node.node {
        Node::ToolCall { name, subagent, .. } => {
            assert_eq!(name, "Agent");
            assert!(
                subagent.is_some(),
                "親のツールコールに子の在処が書き戻される"
            );
        }
        other => panic!("ToolCall ではない: {other:?}"),
    }
}

#[test]
fn サブエージェントの中身も同じツリーに載る() {
    let parsed = Parsed::of(fixture("v2.1.220/subagent/session.jsonl"));

    let subagent_id = parsed
        .nodes
        .values()
        .find(|node| matches!(node.node, Node::Subagent { .. }))
        .expect("サブエージェントのルート")
        .id
        .clone();

    // 子ファイルのノードは、サブエージェントのルート配下に生える
    let children: Vec<&protocol::TreeNode> = parsed
        .nodes
        .values()
        .filter(|node| node.parent.as_ref() == Some(&subagent_id))
        .collect();
    assert!(
        !children.is_empty(),
        "サブエージェントの会話が1件も載っていない"
    );

    // 子の中のツールコール（Glob / Read）まで掘れること
    let has_tool = parsed.nodes.values().any(|node| match &node.node {
        Node::ToolCall { name, .. } => name == "Glob" || name == "Read",
        _ => false,
    });
    assert!(has_tool, "サブエージェント内のツールコールが見えない");
}

#[test]
fn 途中から再開しても欠落も重複もしない() {
    // テスト計画フェーズ3「オフセット再開」。自己修復でパーサを差し替えたときの
    // 無欠落保証そのものにあたる
    let path = fixture("v2.1.220/basic-tools/session.jsonl");
    let full = Parsed::of(path.clone());
    let offsets: Vec<u64> = {
        let mut offsets: Vec<u64> = full.emissions.iter().map(|(offset, _)| *offset).collect();
        offsets.dedup();
        offsets
    };
    assert!(offsets.len() > 5, "検証に足るだけの行数があること");

    // 行の境目と、レコードの途中のバイトの両方で切ってみる
    let cuts: Vec<u64> = offsets
        .iter()
        .skip(1)
        .flat_map(|offset| [*offset, offset + 1])
        .collect();

    for cut in cuts {
        let resumed = Parsed::resumed(
            path.clone(),
            &BTreeMap::from([(path.to_string_lossy().to_string(), cut)]),
        );

        // 再開位置より前は送り直さない（core が既に持っているものを二重に届けない）
        for (offset, node) in &resumed.emissions {
            assert!(
                *offset >= cut,
                "cut={cut} で再開位置より前のノードが出た: {} @ {offset}",
                node.id.0
            );
        }

        // 再開位置以降に発行されたノードは、通しで読んだときと同じ最終状態になる。
        // 比べるのは**畳んだあとの状態**どうし。ツールコールは結果が届くまで何度か
        // 送り直されるので、途中の姿と突き合わせても意味がない（upsert 契約）
        for (offset, emitted) in &full.emissions {
            if *offset < cut {
                continue;
            }
            let expected = full.nodes.get(&emitted.id.0).expect("通しの最終状態");
            let actual = resumed
                .nodes
                .get(&emitted.id.0)
                .unwrap_or_else(|| panic!("cut={cut} で {} が欠落した", emitted.id.0));
            assert_eq!(
                actual.node, expected.node,
                "cut={cut} で {} の内容が変わった（索引の作り直しが効いていない）",
                emitted.id.0
            );
            assert_eq!(actual.parent, expected.parent, "cut={cut} で親が変わった");
        }
    }
}

#[test]
fn 再開後もツールコールの結果が対応付く() {
    // 結果だけが再開位置より後にあるツールコールは、索引を作り直さないと
    // 永久に「実行中」のまま取り残される
    let path = fixture("v2.1.220/basic-tools/session.jsonl");
    let full = Parsed::of(path.clone());

    // 最後のツール結果が出た位置の直前で切る
    let last_result_offset = full
        .emissions
        .iter()
        .filter(|(_, node)| {
            matches!(
                node.node,
                Node::ToolCall {
                    status: protocol::ToolStatus::Ok | protocol::ToolStatus::Error,
                    ..
                }
            )
        })
        .map(|(offset, _)| *offset)
        .next_back()
        .expect("結果つきのツールコールがある");

    let resumed = Parsed::resumed(
        path.clone(),
        &BTreeMap::from([(path.to_string_lossy().to_string(), last_result_offset)]),
    );
    let updated: Vec<&protocol::TreeNode> = resumed
        .nodes
        .values()
        .filter(|node| matches!(node.node, Node::ToolCall { .. }))
        .collect();
    assert!(!updated.is_empty(), "再開後にツールコールが更新されない");
    for node in updated {
        let Node::ToolCall { name, status, .. } = &node.node else {
            unreachable!()
        };
        assert_ne!(
            *status,
            protocol::ToolStatus::Pending,
            "{name} が保留のまま取り残された"
        );
    }
}

#[test]
fn read_rangeは範囲内のノードだけを正しい親付きで返す() {
    // REST のページングの裏側。先頭から読み直してから範囲を切り出すので、
    // 古いページでもツリーの親子が崩れない
    let path = fixture("v2.1.220/basic-tools/session.jsonl");
    let full = Parsed::of(path.clone());
    let cut = full
        .emissions
        .iter()
        .map(|(offset, _)| *offset)
        .nth(4)
        .expect("十分な行数");

    let range = transcript_parser::session::read_range(&path, 0, cut);
    assert!(!range.is_empty());
    for parsed_node in &range {
        assert!(parsed_node.offset < cut, "範囲外のノードが混ざっている");
        let expected = full
            .nodes
            .get(&parsed_node.node.id.0)
            .expect("通しで読んだときにも存在する");
        assert_eq!(
            parsed_node.node.parent, expected.parent,
            "範囲読みで親が変わった"
        );
    }
}

#[test]
fn 表示対象外のレコードが混ざっていても孤児を作らない() {
    // attachment / queue-operation / ai-title / last-prompt が実際に混ざっているセット
    for name in [
        "v2.1.220/basic-tools/session.jsonl",
        "v2.1.220/subagent/session.jsonl",
    ] {
        let parsed = Parsed::of(fixture(name));
        assert_eq!(parsed.orphans(), 0, "{name} で孤児が出た");
        assert_eq!(parsed.count("unknown"), 0, "{name} で未知ノードが出た");
    }
}
