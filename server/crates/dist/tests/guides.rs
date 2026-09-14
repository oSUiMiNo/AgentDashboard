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

mod common;
use common::repo_root;
use std::path::{Path, PathBuf};

/// 在るべき手順書。
///
/// 検収条件が数えているのは前の4つ（設計§14-2）。`uninstall.md` は**入れる道と
/// 対で要る**ものとして後から足した（設計§27）——消し方が書いていないと、利用者は
/// 自分で調べることになり、**記録まで消して戻せなくする**形が一番あぶない。
const GUIDES: &[&str] = &[
    "local.md",
    "selfhost.md",
    "pairing.md",
    "reverse-proxy.md",
    "uninstall.md",
];

/// リポジトリの中を指していると判断する頭。
///
/// これに当たらない `/etc/nginx/...` や `~/.local/bin` は、**利用者の機械の話**なので
/// 実在を求めない。
const REPO_ROOTS: &[&str] = &["docs/", "server/", "docker/", "web/", "scripts/"];

/// 常駐の雛形（セルフホストの道①）。
const UNIT: &str = "docs/service/agentdashboard.service";

/// Windows へ空きを返す台本。
///
/// **人が居ないところ（タスクスケジューラ）から走る**ので、確認待ちが1つでもあると
/// 誰も答えず永久に止まる。しかも止まったことに気づく人も居ない。
const COMPACT_SCRIPT: &str = "docs/service/compact-wsl.ps1";

#[test]
fn 手順書がそろっている() {
    // 検収条件が数えているのは最初の4つ。名前を変えるならこちらも変える
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

#[test]
fn 常駐の雛形が手順書と同じ起こし方をしている() {
    // 雛形はコピーして使われる。**手元で試せないもの**（systemd は CI に無い）なので、
    // せめて「手順書が案内している起こし方と食い違っていない」ことだけは機械で見る。
    //
    // 食い違うと、コピーした人の機械でだけ起動に失敗する——書いた側には何も起きない。
    let unit = std::fs::read_to_string(repo_root().join(UNIT)).expect("常駐の雛形を読めること");
    let exec = unit
        .lines()
        .find(|line| line.starts_with("ExecStart="))
        .expect("ExecStart があること");

    // 配る実行ファイルの名前。改名したらここで気づく
    assert!(
        exec.contains("/agentdashboard "),
        "ExecStart が配る実行ファイルを指していない: {exec}"
    );
    // **ローカルモードで起こしてはいけない。** サーバの役だけを持たせる指定が要る
    assert!(
        exec.contains("--mode server"),
        "ExecStart に --mode server が無い: {exec}"
    );
    // 待ち受けを広げないと、常駐させても外から届かない（手順書の道①はこれを前提にしている）
    assert!(
        unit.contains("Environment=AGENTDASHBOARD_BIND_ADDR=0.0.0.0"),
        "待ち受けを広げる指定が無い（常駐させても外から届かない）"
    );
}

#[test]
fn 縮小の台本が確認待ちを持たない() {
    // タスクから走ったときに確認待ちがあると、**誰も答えないので永久に止まる**。
    // しかも人が見ていないので、止まったことにも気づけない。
    //
    // 注釈は落としてから探す。台本は「確認待ちを持たない」理由を自分の説明に
    // 書いており、そこに出てくる名前で落ちては意味が無い
    let script = 台本を読む();
    let code = 注釈を落とす(&script).to_lowercase();

    for 待つもの in [
        "read-host",
        "[console]::readkey",
        "cmd /c pause",
        "cmd.exe /c pause",
    ] {
        assert!(
            !code.contains(待つもの),
            "縮小の台本に確認待ちがある: {待つもの}（タスクから走ると永久に止まる）"
        );
    }
    // 単独の `Pause` も同じ。行として置かれているものだけを見る
    for line in code.lines() {
        assert!(
            line.trim() != "pause",
            "縮小の台本に確認待ち（単独の Pause）がある"
        );
    }
}

#[test]
fn 縮小の台本が仮想ディスクを読み取り専用で付けている() {
    // `attach vdisk readonly` は**安全形**である。これがファイルシステム対応の
    // 圧縮を有効にし、かつ書き込みを弾く。実際に報告されている破損事例は、
    // どれも readonly を省いた形のものである。
    //
    // **「readonly が1回在る」だけを見てはいけない。** 2枚のうち片方にだけ
    // 付けた台本が通ってしまう。**readonly を伴わない `attach vdisk` が
    // 1つも無いこと**まで見て、初めて意味がある
    let script = 台本を読む();
    let code = 注釈を落とす(&script).to_lowercase();

    assert!(
        code.contains("attach vdisk readonly"),
        "縮小の台本が仮想ディスクを読み取り専用で付けていない"
    );

    let mut at = 0;
    while let Some(found) = code[at..].find("attach vdisk") {
        let head = at + found;
        let rest = &code[head..];
        assert!(
            rest.starts_with("attach vdisk readonly"),
            "readonly を伴わない attach vdisk がある（破損事例と同じ条件）: {}",
            rest.lines().next().unwrap_or("")
        );
        at = head + "attach vdisk".len();
    }
}

#[test]
fn 縮小の台本が圧縮より先に切り離していない() {
    // **圧縮の完了前に切り離すと、そこで失敗する**（Microsoft の仕様）。
    // 順番が入れ替わっただけで、縮小は一度も成功しなくなる
    let script = 台本を読む();
    let code = 注釈を落とす(&script).to_lowercase();

    let compact = code
        .find("compact vdisk")
        .expect("台本に compact vdisk があること");
    let detach = code
        .find("detach vdisk")
        .expect("台本に detach vdisk があること");

    assert!(
        compact < detach,
        "圧縮より先に切り離している（圧縮が必ず失敗する）"
    );
}

fn 台本を読む() -> String {
    std::fs::read_to_string(repo_root().join(COMPACT_SCRIPT)).expect("縮小の台本を読めること")
}

/// PowerShell の注釈（`<# … #>` と、行中の `#` から行末まで）を落とす。
///
/// **台本は自分の作法を説明に書いている**ので、注釈ごと探すと「説明に出てくる
/// 名前」で落ちる。落とす側が雑だと検査が意味を失うが、ここで見たいのは
/// **実際に走る行だけ**なので、多めに落として困ることはない（落としすぎれば
/// 「1回以上在る」の確認が先に落ちる）。
fn 注釈を落とす(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<#") {
        out.push_str(&rest[..start]);
        match rest[start..].find("#>") {
            Some(end) => rest = &rest[start + end + 2..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);

    out.lines()
        .map(|line| match line.find('#') {
            Some(at) => &line[..at],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
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

fn setup_dir() -> PathBuf {
    repo_root().join("docs").join("setup")
}
