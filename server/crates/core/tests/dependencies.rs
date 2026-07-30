//! crate 境界に引いた線が実際に効いていることの機械検査（セルフホスト化設計§2-1）。
//!
//! ローカルモードとセルフホストモードを feature flag ではなく **crate 境界**で分けたのは、
//! 「サーバ側が PTY に触る」ような依存の逆流を**コンパイラに止めさせる**ため。ただし
//! コンパイラが止めてくれるのは「使ったら」であって、`Cargo.toml` に1行足した時点では
//! 何も起きない。**足せてしまう**うちは境界は約束でしかないので、ここで機械にする。
//!
//! # なぜ通常の依存だけを見るのか
//!
//! `Cargo.lock` の依存一覧は dev-dependencies と混ざっている。testkit は擬似 claude を
//! PTY で起こす試験のために `portable-pty` を dev-dependencies に持つので、混ぜて数えると
//! **テスト用の依存を製品の依存と読み違えて**誤検知する。`cargo metadata` は依存の種別を
//! 返すので、そこから通常（`kind: null`）だけを辿る。

use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// 「この crate から、通常の依存だけを辿って、これらに到達してはいけない」。
///
/// 後続フェーズで増える荷物（SeaORM・redis 等）も、入れた時点でここへ足すこと。
/// 検査を1箇所に集めておかないと、配布物が重くなったことに誰も気づけない。
const FORBIDDEN: &[(&str, &[&str])] = &[
    // サーバ側は PTY を持たない。持った瞬間、セルフホストの「サーバはどのインスタンスでも
    // よい」（設計§9-6）が崩れる
    ("server-core", &["portable-pty"]),
    // PC 側は DB を持たない。記録の持ち主はサーバで、エージェントは**報告するだけ**
    // （設計§6-1 の batch+ack）。ここが破れると、同じ記録を2箇所が書くことになり
    // 「どちらが正か」が決められなくなる
    ("agent-core", &["sea-orm"]),
    // 配布するエージェントは、サーバ側の荷物を1つも引き込まない。
    // 利用者の PC へ配る単一バイナリを軽く保ち、musl 静的リンク（設計§14-3）を
    // 成立させるため
    (
        "agentdashboard-agent",
        &["rust-embed", "sea-orm", "tower-sessions"],
    ),
];

#[test]
fn 依存の逆流が起きていない() {
    let metadata = metadata();
    let names = package_names(&metadata);
    let graph = normal_dependency_graph(&metadata);

    for (from, forbidden) in FORBIDDEN {
        let root = names
            .iter()
            .find(|(_, name)| name == from)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| panic!("crate が見つかりません: {from}"));

        let reachable = reachable_from(&graph, &root);
        for banned in *forbidden {
            let hit = reachable
                .iter()
                .any(|id| names.get(id).map(String::as_str) == Some(*banned));
            assert!(
                !hit,
                "{from} が {banned} へ依存しています。crate 境界に引いた線が破れています\
                 （通常の依存だけを辿った結果。dev-dependencies は数えていません）"
            );
        }
    }
}

/// `cargo metadata` を実行して JSON を得る。
fn metadata() -> Value {
    // 実行するのはコンテナの中（`scripts/cargo`）。テストを走らせている cargo 自身を使う
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let output = std::process::Command::new(&cargo)
        .args(["metadata", "--format-version", "1"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap_or_else(|err| panic!("cargo metadata を実行できません（{cargo}）: {err}"));
    assert!(
        output.status.success(),
        "cargo metadata が失敗しました:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("cargo metadata の出力を読めること")
}

/// パッケージID → パッケージ名。
fn package_names(metadata: &Value) -> HashMap<String, String> {
    metadata["packages"]
        .as_array()
        .expect("packages があること")
        .iter()
        .map(|package| {
            (
                package["id"].as_str().expect("id があること").to_string(),
                package["name"]
                    .as_str()
                    .expect("name があること")
                    .to_string(),
            )
        })
        .collect()
}

/// 通常の依存（dev でもビルドスクリプト用でもないもの）だけの隣接表。
fn normal_dependency_graph(metadata: &Value) -> HashMap<String, Vec<String>> {
    metadata["resolve"]["nodes"]
        .as_array()
        .expect("resolve.nodes があること")
        .iter()
        .map(|node| {
            let id = node["id"].as_str().expect("id があること").to_string();
            let deps = node["deps"]
                .as_array()
                .expect("deps があること")
                .iter()
                .filter(|dep| is_normal(dep))
                .map(|dep| dep["pkg"].as_str().expect("pkg があること").to_string())
                .collect();
            (id, deps)
        })
        .collect()
}

/// 通常の依存か。`dep_kinds` の `kind` が無い（＝null）ものが通常の依存にあたる。
fn is_normal(dep: &Value) -> bool {
    dep["dep_kinds"]
        .as_array()
        .expect("dep_kinds があること")
        .iter()
        .any(|kind| kind["kind"].is_null())
}

/// 起点から通常の依存だけを辿って到達できるパッケージID。
fn reachable_from(graph: &HashMap<String, Vec<String>>, root: &str) -> HashSet<String> {
    let mut seen = HashSet::new();
    let mut stack = vec![root.to_string()];
    while let Some(id) = stack.pop() {
        for next in graph.get(&id).map(Vec::as_slice).unwrap_or_default() {
            if seen.insert(next.clone()) {
                stack.push(next.clone());
            }
        }
    }
    seen
}
