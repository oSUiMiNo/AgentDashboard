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

mod common;
use common::{BINARIES, repo_root};

/// 作ると決めた OS（設計§14-3 の「3 OS」。macOS だけ2種類ある）。
const TARGETS: &[&str] = &[
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
];

/// 利用者が取ってくる献立表（設計§26 読み替え2）。
const COMPOSE: &str = "docker/compose.yml";

/// 棚に置く箱の名前。
///
/// **リポジトリの持ち主から機械的に決まる**（`.github/workflows/docker-image.yml` が
/// 持ち主の名前を小文字にして組み立てる）。引っ越したら両方を一緒に直すことになるので、
/// 片方だけ直したことに気づけるよう、ここに全部書いておく。
const IMAGE: &str = "ghcr.io/osuimino/agentdashboard";

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
fn 消す道もリリースに並ぶ() {
    // 入れる道と対で配る（設計§27）。ここから静かに落ちると、**利用者は消し方を
    // 自分で調べることになる**——そして調べた結果が正しいとは限らない
    // （記録まで消して、一覧と履歴を戻せなくする形が一番あぶない）
    let plan = plan();
    let extras: BTreeSet<&str> = plan["artifacts"]
        .as_object()
        .expect("artifacts があること")
        .iter()
        .filter(|(_, artifact)| artifact["kind"] == "extra-artifact")
        .map(|(name, _)| name.as_str())
        .collect();

    for expected in [
        "agentdashboard-uninstaller.sh",
        "agentdashboard-uninstaller.ps1",
    ] {
        assert!(
            extras.contains(expected),
            "{expected} がリリースに並びません: {extras:?}"
        );
    }
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

#[test]
fn 献立表は配る箱を版ごと名指ししている() {
    // 版を上げると、箱の版と献立表が食い違いうる。食い違っても**献立表は動く**
    // （古い箱がまだ棚にあるので立つ）ため、症状が出ない。出るのは
    // 「直したはずの不具合が直っていない」という形で、原因まで辿れない。
    //
    // あわせて `latest` に戻っていないことも見ている。あちらは取り直しただけで
    // 記録の表の形が上がり、**戻す道が無い**
    let text = without_comments(&compose());
    let expected = format!("image: {IMAGE}:{}", env!("CARGO_PKG_VERSION"));
    assert!(
        text.contains(&expected),
        "献立表が指す箱がワークスペースの版と食い違っています。期待: {expected}"
    );
}

#[test]
fn 献立表はソースからビルドしない() {
    // `build:` があると、箱が手元に無いとき Docker は**自分で作ろうとする**。
    // 材料（ソース）を持っているのは開発者だけなので、献立表1枚だけ取ってきた
    // 利用者はそこで詰まる。検収「`docker compose up -d` で起動」が
    // 開発者の立場でしか成立しなくなる（実際にそうなっていた）
    let text = without_comments(&compose());
    assert!(
        !text.contains("build:"),
        "本番の献立表にソースからのビルドが残っています（利用者はソースを持っていません）"
    );
}

/// 献立表の中身。
fn compose() -> String {
    std::fs::read_to_string(repo_root().join(COMPOSE)).expect("献立表を読めること")
}

/// 注釈を落とす。**説明のために書いた語**を仕様と読み違えないため。
fn without_comments(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
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
    std::process::Command::new("dist")
        .args(args)
        .current_dir(repo_root())
        .output()
        .unwrap_or_else(|err| {
            panic!("dist を実行できません（cargo は scripts/cargo 経由で呼んでいますか）: {err}")
        })
}
