//! 手順書が名指ししているものが実在することの検査（設計§14-2・§14-4／テスト計画F7）。
//!
//! # なぜ機械で見るのか
//!
//! 手順書の中の切れたリンクや、消えたファイルへの参照は、**書いた本人には見えない**。
//! 読むのは初めての人で、そこで詰まっても手元には何も起きない。検収条件に
//! 「セットアップガイド4種」がある以上、腐っていないことは自動で守る。
//!
//! 中身が正しいかまでは見ない（それは `make e2e-compose` が実際に動かして見る）。
//! ここで捕まえるのは**指している先が無い**という、一番安い失敗だけ。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// 在るべき手順書（設計§14-2 の4種）。
const GUIDES: &[&str] = &["local.md", "selfhost.md", "pairing.md", "reverse-proxy.md"];

/// リポジトリの中を指していると判断する頭。
///
/// これに当たらない `/etc/nginx/...` や `~/.local/bin` は、**利用者の機械の話**なので
/// 実在を求めない。
const REPO_ROOTS: &[&str] = &["docs/", "server/", "docker/", "web/", "scripts/"];

#[test]
fn 手順書は4種とも在る() {
    // 検収条件が数えているのはこの4つ。名前を変えるならこちらも変える
    let dir = setup_dir();
    for guide in GUIDES {
        assert!(
            dir.join(guide).is_file(),
            "手順書がありません: {}",
            dir.join(guide).display()
        );
    }
}

#[test]
fn 手順書のリンク先が実在する() {
    let dir = setup_dir();
    for guide in GUIDES {
        let path = dir.join(guide);
        let text = std::fs::read_to_string(&path).expect("手順書を読めること");
        for target in link_targets(&text) {
            // 見出しへの飛び先は文字列の一致で確かめられないので見ない
            if target.starts_with('#') || target.starts_with("http") {
                continue;
            }
            let (file, _anchor) = target.split_once('#').unwrap_or((target.as_str(), ""));
            let resolved = normalize(&dir.join(file));
            assert!(
                resolved.exists(),
                "{guide} のリンク先がありません: {target}（{}）",
                resolved.display()
            );
        }
    }
}

#[test]
fn 入口の案内が実在する() {
    // 入口は README で、そこから手順書へ渡す。**一番見られるところの切れたリンク**は
    // 一番早く信用を落とすので、同じ検査をこちらにも掛ける
    let root = repo_root();
    let text = std::fs::read_to_string(root.join("README.md")).expect("README を読めること");

    for target in link_targets(&text) {
        if target.starts_with('#') || target.starts_with("http") {
            continue;
        }
        let (file, _anchor) = target.split_once('#').unwrap_or((target.as_str(), ""));
        let resolved = normalize(&root.join(file));
        assert!(
            resolved.exists(),
            "README のリンク先がありません: {target}（{}）",
            resolved.display()
        );
    }
    for named in repo_paths(&text) {
        assert!(
            root.join(&named).exists(),
            "README が名指ししているものがありません: {named}"
        );
    }
}

#[test]
fn 手順書が名指ししているファイルが実在する() {
    // リンクではなく、地の文で `docker/compose.yml` のように名指ししているもの。
    // **名前を変えたときに気づけない**のはこちらのほう（リンクと違って見た目が壊れない）
    let root = repo_root();
    let dir = setup_dir();
    for guide in GUIDES {
        let text = std::fs::read_to_string(dir.join(guide)).expect("手順書を読めること");
        for named in repo_paths(&text) {
            assert!(
                root.join(&named).exists(),
                "{guide} が名指ししているものがありません: {named}"
            );
        }
    }
}

/// `[表示](行き先)` の行き先を集める。
fn link_targets(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == ']' && bytes.get(index + 1) == Some(&'(') {
            let start = index + 2;
            if let Some(length) = bytes[start..].iter().position(|c| *c == ')') {
                found.push(bytes[start..start + length].iter().collect());
                index = start + length;
            }
        }
        index += 1;
    }
    found
}

/// `` `docs/proxy/nginx.conf` `` のような、リポジトリの中を指す名指しを集める。
fn repo_paths(text: &str) -> BTreeSet<String> {
    text.split('`')
        // 奇数番目が引用符の中身
        .skip(1)
        .step_by(2)
        .filter(|token| {
            REPO_ROOTS.iter().any(|root| token.starts_with(root))
                // コマンド行や URL を拾わない
                && !token.contains(char::is_whitespace)
                && !token.contains(':')
        })
        .map(|token| token.trim_end_matches('/').to_string())
        .collect()
}

/// `..` を含む道筋を畳む。`Path::canonicalize` は実在しないと失敗するので使わない
/// （**失敗の理由が「無い」ことだと分かる形**で assert したい）。
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crates/dist から3つ上がリポジトリのルート")
        .to_path_buf()
}

fn setup_dir() -> PathBuf {
    repo_root().join("docs").join("setup")
}
