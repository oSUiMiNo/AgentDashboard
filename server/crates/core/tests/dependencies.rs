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
    // 端末エミュレータは PC 側だけが持つ（設計§7-2）。サーバへ置くと、生バイトを
    // サーバまで運ばないと画面が作れないことになり、要件5-2（表示中のものだけ配る）が
    // 成り立たなくなる
    ("server-core", &["vt100"]),
    // PC 側は DB を持たない。記録の持ち主はサーバで、セッションホストは**報告するだけ**
    // （設計§6-1 の batch+ack）。ここが破れると、同じ記録を2箇所が書くことになり
    // 「どちらが正か」が決められなくなる
    ("session-host-core", &["sea-orm"]),
    // ブラウザの鍵（設計§8-2）もサーバ側だけ。PC 側は**ペアリングトークン**で
    // 名乗るので、利用者のパスワードを扱う道具（argon2id）を持つ理由が無い
    ("session-host-core", &["password-auth", "tower-sessions"]),
    // インスタンスの間の連絡係（設計§9-1）もサーバ側だけ。PC 側は**1つのサーバとしか
    // 話さない**ので、インスタンスが何台あるかを知る必要そのものが無い
    ("session-host-core", &["redis"]),
    // 配布するセッションホストは、サーバ側の荷物を1つも引き込まない。
    // 利用者の PC へ配る単一バイナリを軽く保ち、musl 静的リンク（設計§14-3）を
    // 成立させるため
    (
        "session-host",
        &[
            "rust-embed",
            "sea-orm",
            "tower-sessions",
            "password-auth",
            "redis",
        ],
    ),
    // 配布するセッションホストは、**CLI の荷物も引き込まない**（CLI設計§2-2）。
    // CLI（ダッシュボードを外から叩く層）の置き場所は agentdashboard-core なので、
    // そこへ到達しないことがそのまま「CLI を持たない」の機械表現になる。
    // hyper / vt100 / tokio-tungstenite への**到達**は禁じられない——フック受信の
    // axum・画面の端末エミュレータ・A2S クライアントとして session-host-core が
    // 元から正当に持っている。だから直の宣言のほうは FORBIDDEN_DIRECT で見る
    ("session-host", &["agentdashboard-core"]),
    // **パーサには `tracing` を持たせない**（ログ設計§8-3）。理由は2つあり、どちらも
    // 「入れた瞬間に静かに壊れる」性質を持つ。
    //
    // 1. `tracing_subscriber::fmt()` の既定の書き出し先は **stdout**。パーサの stdout は
    //    IPC 専用で、1行でも混ざると「繋がっているのに何も届かない」沈黙になる。
    //    そして**この crate は丸ごと、無人の claude が書き換えてよい範囲**にあり
    //    （`selfheal/repair.rs` の許可リスト）、修復のテストゲートは stdout 汚染を見ない
    // 2. 修復中のビルド時間は利用者の待ち時間そのもの。現在の依存は6つで、
    //    `tracing` 一式を足すと倍以上になる
    //
    // ログは今までどおり `eprintln!` で stderr へ出し、親が拾って合流させる。
    (
        "transcript-parser",
        &["tracing", "tracing-subscriber", "tracing-appender"],
    ),
];

/// 「この crate の `Cargo.toml` に、通常の依存として**直に**書いてはいけない」。
///
/// 到達可能性（[`FORBIDDEN`]）では捕まえられない相手がここに入る。**禁じたいのが
/// 「使うこと」であって「同じ木に居ること」ではない**場合がそれにあたる。
///
/// 例：`axum` の WebSocket 機能は、実装（`tokio-tungstenite`）を通常の依存として
/// 引き込む。だからサーバ側からはどうやっても到達できてしまうが、禁じたいのは
/// **サーバが自分でクライアントとして繋ぎに行くこと**（設計§4-1「接続は常に PC 側から」）
/// なので、宣言そのものを見るほうが意図に合う。
const FORBIDDEN_DIRECT: &[(&str, &[&str])] = &[
    // A2S を張るのは PC 側だけ。利用者の PC はたいてい NAT の内側にあり、サーバから
    // 繋ぎに行く経路は存在しない。**テストは本物の WS で叩くので dev-dependencies には
    // 入る**が、それは「使う」に当たらない
    ("server-core", &["tokio-tungstenite"]),
    // CLI の HTTP クライアント（CLI設計§6-1）はセッションホストの仕事ではない。
    // hyper 系は axum 経由で同じ木に居るので到達可能性では捕まえられず、
    // **自分で使い始めたこと**を宣言で捕まえる。配布物が太らないことは
    // フェーズ0 の実測（CLI設計§15-4：−136 B）で確認済みで、これはその見張り
    (
        "session-host",
        &[
            "hyper",
            "hyper-util",
            "http-body-util",
            "tokio-rustls",
            "webpki-roots",
        ],
    ),
];

/// 「この crate は、これらを**通常の依存として直に**持っていること」
/// （CLI設計§2-2・テスト計画F2「依存と置き場所」）。
///
/// CLI の道具が dev-dependencies へ滑り落ちても、テストは dev の側で繋がるので
/// **テストだけが通る形**で壊れる余地がある。禁じる側（上の2つ）と対で、持つ側も
/// 機械で固定する。
const REQUIRED_DIRECT: &[(&str, &[&str])] = &[(
    "agentdashboard-core",
    &["hyper", "tokio-tungstenite", "vt100"],
)];

/// 配布用パッケージの入口が置いてある場所（このテストから見た相対パス）。
const DIST_BINS: &str = "../dist/src/bin";

/// そこに在るべき入口と、それぞれが呼ぶ先。
const ENTRY_POINTS: &[(&str, &str)] = &[
    ("agentdashboard.rs", "agentdashboard_core::cli::run()"),
    ("agentdashboard-agent.rs", "session_host::run()"),
    ("transcript-parser.rs", "transcript_parser::cli::run()"),
];

#[test]
fn 配布用の入口は呼ぶだけになっている() {
    // 実行ファイル3本は1つのパッケージに集めてある（セルフホスト化設計§25 読み替え1）。
    // そのパッケージは**両側の lib へ依存する**ので、上の [`FORBIDDEN`] のような
    // 「到達できないこと」の証明が効かない唯一の場所になる。
    //
    // 効かないなら狭める。入口が**呼び出しの1行だけ**であるうちは、そこへ書ける
    // ロジックが存在しない——境界の外に立っているのは1行であって、コードではない。
    // ここが緩むと、たとえば配るセッションホストの入口からサーバ側の関数を呼べてしまい、
    // 「配布バイナリを軽く保つ」（`crates/agent/Cargo.toml`）が黙って破れる。
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(DIST_BINS);

    let mut found: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|err| panic!("配布用の入口を読めません（{}）: {err}", dir.display()))
        .filter_map(|entry| Some(entry.ok()?.file_name().to_string_lossy().into_owned()))
        .collect();
    found.sort();
    let mut expected: Vec<String> = ENTRY_POINTS
        .iter()
        .map(|(name, _)| (*name).to_string())
        .collect();
    expected.sort();
    assert_eq!(
        found, expected,
        "配布用の入口が増減しています。増やすなら ENTRY_POINTS へも足すこと"
    );

    for (name, call) in ENTRY_POINTS {
        let source = std::fs::read_to_string(dir.join(name))
            .unwrap_or_else(|err| panic!("{name} を読めません: {err}"));
        // 注釈は何行あってもよい。数えるのは**実際に走る行**だけ
        let code: Vec<&str> = source
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("//"))
            .collect();
        assert_eq!(
            code,
            vec!["fn main() -> anyhow::Result<()> {", call, "}"],
            "{name} が呼び出しの1行だけではありません。中身は lib 側へ置くこと"
        );
    }
}

#[test]
fn 直に持ってはいけない依存を宣言していない() {
    let metadata = metadata();
    for (from, forbidden) in FORBIDDEN_DIRECT {
        let declared = direct_normal_dependencies(&metadata, from);
        for banned in *forbidden {
            assert!(
                !declared.contains(*banned),
                "{from} が {banned} を通常の依存として宣言しています。\
                 使ってよい場所ではありません（dev-dependencies なら数えません）"
            );
        }
    }
}

#[test]
fn 持つべき依存を通常の依存として持っている() {
    let metadata = metadata();
    for (from, required) in REQUIRED_DIRECT {
        let declared = direct_normal_dependencies(&metadata, from);
        for needed in *required {
            assert!(
                declared.contains(*needed),
                "{from} が {needed} を通常の依存として持っていません。\
                 dev-dependencies へ落ちると、製品の CLI が壊れてもテストだけは通ります"
            );
        }
    }
}

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

/// その crate が**自分の `Cargo.toml` に書いている**通常の依存の名前。
fn direct_normal_dependencies(metadata: &Value, package: &str) -> HashSet<String> {
    metadata["packages"]
        .as_array()
        .expect("packages があること")
        .iter()
        .find(|entry| entry["name"].as_str() == Some(package))
        .unwrap_or_else(|| panic!("crate が見つかりません: {package}"))["dependencies"]
        .as_array()
        .expect("dependencies があること")
        .iter()
        // `kind` は通常の依存だけ null。dev / build は名前が入る
        .filter(|dep| dep["kind"].is_null())
        .filter_map(|dep| dep["name"].as_str().map(str::to_string))
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
