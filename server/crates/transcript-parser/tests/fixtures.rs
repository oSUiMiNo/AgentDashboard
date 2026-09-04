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
    /// 拾った題と、それが**何回報告されたか**。
    ///
    /// ここを見ることで、**自己修復のゲートにも名前が入る**——修復されたパーサが
    /// 題を落としたら、フィクスチャを回るテストが止める。
    titles: Vec<String>,
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
            titles: Vec::new(),
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
                    ParserEvent::SessionTitle { title, .. } => parsed.titles.push(title),
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

    fn parse_errors(&self) -> u64 {
        match &self.stats {
            Some(ParserEvent::Stats { parse_errors, .. }) => *parse_errors,
            _ => 0,
        }
    }

    fn title(&self) -> Option<&str> {
        self.titles.last().map(String::as_str)
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
        // **人と機械を別に数える**（`人が打っていないものを、人の発言として出さない` 設計§8）。
        // **人の側は `"user"` のまま**にしてある——既存のゴールデンの数値を動かさないため
        Node::UserMessage { origin, .. } if !origin.is_human() => "user-machine",
        Node::UserMessage { .. } => "user",
        Node::AssistantText { .. } => "assistant",
        Node::Thinking { .. } => "thinking",
        Node::ToolCall { .. } => "tool",
        Node::Subagent { .. } => "subagent",
        Node::Image { .. } => "image",
        // 畳んだかどうかで別に数える。**ゴールデンで「消える側」を守る**ため
        Node::QueuedMessage { taken: false, .. } => "queued",
        Node::QueuedMessage { taken: true, .. } => "queued-taken",
        Node::Unknown { .. } => "unknown",
    }
}

#[test]
fn basic_toolsのフィクスチャが期待どおりのツリーになる() {
    let parsed = Parsed::of(fixture("v2.1.220/basic-tools/session.jsonl"));

    // **実採取のフィクスチャは `claude -p` で採るので、1通目が `promptSource: "sdk"`
    // になる**（`人が打っていないものを、人の発言として出さない` 設計§1-1 の #6）。
    // つまり「人が打った」とは名乗っていない。**判定はこれで正しい**——採り方の性質で
    // あって、製品の動きではない（ダッシュボードは PTY 上の対話 CLI を起こすので
    // 利用者の入力は `typed` になる）
    assert_eq!(parsed.count("user"), 0, "人が打ったと名乗る発言は無い");
    assert_eq!(parsed.count("user-machine"), 1, "最初のプロンプト1件（SDK 由来）");
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
fn ツール自身が失敗した場合もエラーとして残る() {
    // 上の「拒否された」ケースとは別物。拒否は `toolUseResult` が文字列になるが、
    // ツール自身の失敗は結果ブロックの `is_error` で表される。取り違えると
    // 「失敗したのに成功の印が付く」形で表に出る（画面では気づけない）。
    let parsed = Parsed::of(fixture("v2.1.220/failing-tools/session.jsonl"));

    let failed: Vec<&protocol::TreeNode> = parsed
        .tool_calls()
        .into_iter()
        .filter(|node| {
            matches!(
                node.node,
                Node::ToolCall {
                    status: protocol::ToolStatus::Error,
                    ..
                }
            )
        })
        .collect();
    assert_eq!(
        failed.len(),
        1,
        "存在しないファイルの Read が1件だけ失敗する"
    );

    // 残りは成功として残る。ひとまとめに失敗扱いされていないこと
    let ok = parsed
        .tool_calls()
        .into_iter()
        .filter(|node| {
            matches!(
                node.node,
                Node::ToolCall {
                    status: protocol::ToolStatus::Ok,
                    ..
                }
            )
        })
        .count();
    assert_eq!(ok, 4, "Read 2件と Edit 2件は成功");
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
        root_kinds.iter().all(|kind| matches!(
            *kind,
            // 待ち行列の指示は、まだどのターンにも属していない。**読まれたときに本物は
            // 根へ出るので、待ちも根に置く**——置き場所が無いからではなく、そこが
            // 正しい位置だから広げた（作業中に送った追加メッセージ 設計§5-1）
            "user" | "user-machine" | "assistant" | "thinking" | "queued" | "queued-taken"
        )),
        "根に来てよいのは会話の本文と、まだ読まれていない指示だけ: {root_kinds:?}"
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
    // attachment / ai-title / last-prompt が実際に混ざっているセット。
    // **`queue-operation` はもう表示対象外ではない**（設計§2-1 で行を作る側へ移した）
    // が、`parentUuid` を持たないので孤児には数えられないままである
    for name in [
        "v2.1.220/basic-tools/session.jsonl",
        "v2.1.220/subagent/session.jsonl",
    ] {
        let parsed = Parsed::of(fixture(name));
        assert_eq!(parsed.orphans(), 0, "{name} で孤児が出た");
        assert_eq!(parsed.count("unknown"), 0, "{name} で未知ノードが出た");
    }
}

#[test]
fn 多段ネストのサブエージェントが親子で繋がる() {
    // テスト計画フェーズ3「spawnDepth 多段ネストの再現」。
    //
    // 実データで確認できたこと: 深さ2の meta は `toolUseId` と `parentAgentId` の
    // **両方**を持つ。`toolUseId` は親エージェントのファイルの中のツールコールを指すので、
    // ツールコールの索引をファイルをまたいで持っていないと解けない。
    let parsed = Parsed::of(fixture("v2.1.220/nested-subagent/session.jsonl"));

    let mut subagents: Vec<&protocol::TreeNode> = parsed
        .nodes
        .values()
        .filter(|node| matches!(node.node, Node::Subagent { .. }))
        .collect();
    subagents.sort_by_key(|node| match node.node {
        Node::Subagent { spawn_depth, .. } => spawn_depth,
        _ => 0,
    });
    assert_eq!(subagents.len(), 2, "深さ1と深さ2のサブエージェントが揃う");

    let depths: Vec<u32> = subagents
        .iter()
        .map(|node| match node.node {
            Node::Subagent { spawn_depth, .. } => spawn_depth,
            _ => 0,
        })
        .collect();
    assert_eq!(depths, vec![1, 2]);

    // 深さ2は、深さ1のエージェントの中のツールコールにぶら下がる
    let inner_parent = subagents[1].parent.as_ref().expect("マウント先がある");
    let parent_node = parsed.nodes.get(&inner_parent.0).expect("親が発行済み");
    assert!(
        matches!(parent_node.node, Node::ToolCall { .. }),
        "深さ2の親がツールコールではありません: {:?}",
        parent_node.node
    );

    // 孤児を作らずに繋がっていること
    assert_eq!(parsed.orphans(), 0);
}

/// `fixtures/` にあるトランスクリプトを全部見つける。
///
/// パスを直書きしないのが要点。自己修復（設計§9）はカナリアで採った**新しい版の
/// サンプルをここへ足す**ので、名前を知らないファイルが増えていく。列挙を手で書くと、
/// 足したサンプルが誰にも検証されないまま「対応済み」と記録されてしまう。
fn discover() -> Vec<PathBuf> {
    let root = fixture("");
    let mut found = Vec::new();
    for version in read_dir(&root) {
        for label in read_dir(&version) {
            let session = label.join("session.jsonl");
            if session.is_file() {
                found.push(session);
            }
        }
    }
    found.sort();
    found
}

fn read_dir(dir: &std::path::Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect()
}

#[test]
fn すべてのフィクスチャが不明なイベントを出さずに読める() {
    // ここが**自己修復のテストゲートの実体**（設計§9 安全条件2）。
    //
    // 修復セッションが直したパーサは、このテストを通ったときだけ採用される。
    // 「新しい形式が読める」だけでなく「過去バージョンを壊していない」ことを
    // 同時に見るために、個別のフィクスチャではなく**全部**を対象にしている。
    let all = discover();
    assert!(
        all.len() >= 4,
        "フィクスチャを見つけられていません（探した場所: {}）",
        fixture("").display()
    );

    for session in all {
        let name = session
            .strip_prefix(fixture(""))
            .unwrap_or(&session)
            .display()
            .to_string();
        let parsed = Parsed::of(session.clone());

        assert_eq!(
            parsed.unknown_types(),
            BTreeMap::new(),
            "{name}: 知らないレコード種別があります"
        );
        assert_eq!(parsed.count("unknown"), 0, "{name}: 不明なノードが出ました");
        assert_eq!(
            parsed.parse_errors(),
            0,
            "{name}: パースに失敗した行があります"
        );
        assert_eq!(
            parsed.orphans(),
            0,
            "{name}: 親に繋がらないレコードがあります"
        );
    }
}

#[test]
fn 実物のフィクスチャから題を1回だけ拾える() {
    // **これを置くことで、名前を運ぶ経路が自己修復のゲートに入る。** 修復されたパーサが
    // `ai-title` を捨てる側へ戻したら、ここが止める。
    //
    // 実物は**同じ題が2件**書かれている（`basic-tools` は8行目と20行目）ので、
    // 「変わったときだけ出す」が効いていれば報告は1回で済む。
    let 題のあるもの = [
        (
            "v2.1.220/basic-tools",
            "TODOを完了に変更し作業内容をまとめる",
        ),
        ("v2.1.220/subagent", "Pythonファイルの関数一覧を調査"),
    ];

    for (label, 期待) in 題のあるもの {
        let parsed = Parsed::of(fixture(&format!("{label}/session.jsonl")));
        assert_eq!(parsed.title(), Some(期待), "{label}: 題が拾えていません");
        assert_eq!(
            parsed.titles.len(),
            1,
            "{label}: 同じ題を{}回報告しています（変わったときだけのはず）",
            parsed.titles.len()
        );
    }
}

/// 5通りが正しく分かれること
/// （`人が打っていないものを、人の発言として出さない` 設計§8・テスト計画フェーズ5）。
///
/// **この崩れが今まで門に掛からなかったのは、`origin` を持つフィクスチャが1つしか
/// 無かったからである。** ここが最後の砦になる。
#[test]
fn message_originのフィクスチャで人と機械が分かれる() {
    let parsed = Parsed::of(fixture("synthetic/message-origin/session.jsonl"));

    assert_eq!(
        parsed.count("user"),
        3,
        "人＝素の指示・スラッシュコマンド・印が1つも無い記録（/clear）"
    );
    assert_eq!(
        parsed.count("user-machine"),
        2,
        "機械＝フックの注入・他セッションからの連絡。**展開は行にならない**"
    );
    assert_eq!(parsed.orphans(), 0, "親を見失ったレコードは無い");
    assert!(
        parsed.unknown_types().is_empty(),
        "未知の種別が出た: {:?}",
        parsed.unknown_types()
    );

    let 発言: Vec<_> = parsed
        .nodes
        .values()
        .filter_map(|node| match &node.node {
            Node::UserMessage {
                text,
                origin,
                command,
            } => Some((text.as_str(), origin.clone(), command.clone())),
            _ => None,
        })
        .collect();

    // 生のタグが1文字も出ないこと
    for (text, _, _) in &発言 {
        assert!(!text.contains("command-name"), "生のタグが出ている: {text}");
        assert!(!text.contains("command-message"), "生のタグが出ている: {text}");
    }

    let コマンド = 発言
        .iter()
        .find(|(_, _, command)| command.is_some())
        .expect("スラッシュコマンドが1つあること");
    assert_eq!(コマンド.0, "/sample-skill-1 calc.py", "打った形＝名前＋引数");
    assert!(コマンド.1.is_human(), "打った本人は人のまま");
    assert_eq!(
        コマンド.2.as_ref().unwrap().expansion.as_deref(),
        Some("指定されたファイルを読み、要点をまとめよ。"),
        "展開が同じ吹き出しの中に入る"
    );

    // 他セッションからの連絡は、送り主の名前を持って出る
    let 連絡 = 発言
        .iter()
        .find(|(_, origin, _)| matches!(origin, protocol::MessageOrigin::Peer { .. }))
        .expect("連絡が1つあること");
    assert!(
        matches!(
            &連絡.1,
            protocol::MessageOrigin::Peer { name: Some(name) } if name == "sample-peer-session"
        ),
        "送り主の名前が出る: {:?}",
        連絡.1
    );

    // **印が1つも無い記録は人**（安全側の門。ここに `/clear` が来る）
    let 印無し = 発言
        .iter()
        .find(|(text, _, _)| *text == "/clear")
        .expect("印の無い記録が1つあること");
    assert_eq!(印無し.1, protocol::MessageOrigin::Unmarked);
    assert!(印無し.1.is_human(), "印が無いものは人として出す");
}
