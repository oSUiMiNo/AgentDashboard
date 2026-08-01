//! 配布物の形の機械検査（セルフホスト化設計§14-3・テスト計画F7）。
//!
//! # なぜタグを打つ前に見るのか
//!
//! 配布物の中身が違っていたことは、**配ってからしか気づけない**。パーサが同梱漏れなら
//! 利用者の画面では構造化ビューだけが黙って死ぬし、OS が1つ欠けていればその OS の人が
//! 落とすものが無い。どちらもこちらの手元では何も起きない。
//!
//! `dist plan` は実際にビルドせずに「何ができる予定か」を出す。予定の一覧なら
//! 数秒で読めるので、`make ci` の中で毎回見る。
//!
//! # dist はコンテナの中に居る
//!
//! `scripts/cargo` が動かすイメージへ入れてある（`docker/Dockerfile.rust`）。
//! テストは自分を走らせている環境の `dist` をそのまま呼ぶ。

use serde_json::Value;
use std::collections::BTreeSet;

/// 配るアーカイブに必ず入っていなければならない実行ファイル。
const BINARIES: &[&str] = &[
    "agentdashboard",
    "agentdashboard-agent",
    "transcript-parser",
];

/// 作ると決めた OS（設計§14-3 の「3 OS」。macOS だけ2種類ある）。
const TARGETS: &[&str] = &[
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
];

#[test]
fn どのアーカイブにも実行ファイルが3本とも入っている() {
    // パーサは `agentdashboard` と `agentdashboard-agent` の**どちらの隣にも**居る
    // 必要がある（設計§10-3 の「実行ファイルの隣」探索）。3本を1つのパッケージへ
    // 集めたのはこのためで、崩れると配布先で構造化ビューが全滅する
    let plan = plan();
    let archives = archives(&plan);
    assert_eq!(
        archives.len(),
        TARGETS.len(),
        "アーカイブの数が OS の数と合いません"
    );

    for (name, artifact) in archives {
        let assets: BTreeSet<&str> = artifact["assets"]
            .as_array()
            .expect("assets があること")
            .iter()
            .filter_map(|asset| asset["name"].as_str())
            .collect();
        for binary in BINARIES {
            // Windows は .exe が付く
            let found = assets.contains(binary) || assets.contains(&*format!("{binary}.exe"));
            assert!(found, "{name} に {binary} が入っていません: {assets:?}");
        }
    }
}

#[test]
fn 決めた顔ぶれのアーカイブとワンライナーが並ぶ() {
    let plan = plan();

    let mut targets: Vec<String> = archives(&plan)
        .iter()
        .flat_map(|(_, artifact)| {
            artifact["target_triples"]
                .as_array()
                .expect("target_triples があること")
                .iter()
                .filter_map(|triple| Some(triple.as_str()?.to_string()))
        })
        .collect();
    targets.sort();
    assert_eq!(targets, TARGETS, "作る OS の顔ぶれが変わっています");

    // ワンライナーが無いと、利用者に「アーカイブを展開して PATH を通す」ことを
    // 要求することになる。5分セットアップ（§14-4）の前提が崩れる
    let installers: BTreeSet<&str> = plan["artifacts"]
        .as_object()
        .expect("artifacts があること")
        .iter()
        .filter(|(_, artifact)| artifact["kind"] == "installer")
        .map(|(name, _)| name.as_str())
        .collect();
    assert!(
        installers.contains("agentdashboard-installer.sh")
            && installers.contains("agentdashboard-installer.ps1"),
        "ワンライナーが揃っていません: {installers:?}"
    );
}

#[test]
fn 生成済みのワークフローが設定と食い違っていない() {
    // `.github/workflows/release.yml` は `dist generate` が作る。手で書き換えても
    // 次の生成で黙って戻るので、**書き換えたことに気づける形**にしておく。
    // 設定（`dist-workspace.toml`）を触って生成し忘れたときも、ここで落ちる
    let output = dist(&["generate", "--check"]);
    assert!(
        output.status.success(),
        "設定とワークフローが食い違っています。scripts/dist generate を実行してください:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// 予定の一覧を JSON で取る。
fn plan() -> Value {
    let output = dist(&["plan", "--output-format=json"]);
    assert!(
        output.status.success(),
        "dist plan が失敗しました:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("dist plan の出力を読めること")
}

/// 実行ファイルが入るアーカイブだけを取り出す（チェックサムや source は除く）。
fn archives(plan: &Value) -> Vec<(&str, &Value)> {
    let mut found: Vec<(&str, &Value)> = plan["artifacts"]
        .as_object()
        .expect("artifacts があること")
        .iter()
        .filter(|(_, artifact)| artifact["kind"] == "executable-zip")
        .map(|(name, artifact)| (name.as_str(), artifact))
        .collect();
    found.sort_by_key(|(name, _)| *name);
    found
}

/// リポジトリのルートで `dist` を動かす。設定はそこに置いてある（§25 読み替え5）。
fn dist(args: &[&str]) -> std::process::Output {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crates/dist から3つ上がリポジトリのルート");
    std::process::Command::new("dist")
        .args(args)
        .current_dir(repo_root)
        .output()
        .unwrap_or_else(|err| {
            panic!("dist を実行できません（cargo は scripts/cargo 経由で呼んでいますか）: {err}")
        })
}
