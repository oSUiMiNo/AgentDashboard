//! 利用者の PC のフォルダとファイルを読む決まり（テスト計画 フェーズ2「列挙の決まり」「中身の読み取り」）。
//!
//! **実物のファイルシステムを相手にする。** 作った文字列だけで固めると、実装とテストが
//! 同じ勘違いを共有する（PJTガイドライン「数えて取り出す実装は、作った文字列だけで
//! 固めない」）。一時ディレクトリに実際のフォルダ・ファイル・シンボリックリンクを作る。

#![allow(non_snake_case)]

use protocol::a2s::HostFailure;
use protocol::fs::{EntryKind, MAX_ENTRIES, MAX_FILE_BYTES};
use session_host_core::hostfs;
use std::path::{Path, PathBuf};

/// 使い捨ての作業場所。**落ちても消える**ように Drop で片付ける。
struct Sandbox(PathBuf);

impl Sandbox {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "agentdashboard-hostfs-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("作業場所を作れること");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn dir(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        std::fs::create_dir_all(&path).expect("フォルダを作れること");
        path
    }

    fn file(&self, name: &str, body: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        std::fs::write(&path, body).expect("ファイルを作れること");
        path
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        // 権限を落としたフォルダが残っていると消せないので、戻してから消す
        for found in std::fs::read_dir(&self.0).into_iter().flatten().flatten() {
            let _ = std::fs::set_permissions(
                found.path(),
                std::os::unix::fs::PermissionsExt::from_mode(0o755),
            );
        }
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn names(listing: &protocol::fs::DirListing) -> Vec<String> {
    listing.entries.iter().map(|e| e.name.clone()).collect()
}

// --- 列挙の決まり（設計§8）-------------------------------------------------

#[test]
fn 並びはディレクトリが先で名前は大文字小文字を区別しない() {
    let sandbox = Sandbox::new("order");
    // わざと「大文字が混ざる」「ファイルのほうが名前は先」という順に作る
    sandbox.file("Apple.txt", b"a");
    sandbox.file("banana.txt", b"b");
    sandbox.dir("Zebra");
    sandbox.dir("ant");

    let listing = hostfs::list_dir(sandbox.path()).expect("読めること");

    // フォルダが先に固まり、その中は大文字小文字を無視した昇順
    assert_eq!(
        names(&listing),
        vec!["ant", "Zebra", "Apple.txt", "banana.txt"],
        "ディレクトリが先・各群は大文字小文字を区別しない昇順であること"
    );
}

#[test]
fn 件数が上限を超えると打ち切られたことが応答に載る() {
    let sandbox = Sandbox::new("truncate");
    for index in 0..(MAX_ENTRIES + 5) {
        sandbox.file(&format!("f{index:05}.txt"), b"x");
    }

    let listing = hostfs::list_dir(sandbox.path()).expect("読めること");

    assert!(listing.truncated, "打ち切ったことが応答に載ること");
    assert!(
        listing.entries.len() <= MAX_ENTRIES,
        "上限を超えて返さないこと（{} 件）",
        listing.entries.len()
    );
}

#[test]
fn 上限を超えるフォルダでも並びの約束は保たれる() {
    // **打ち切ってから並べると、返るのは「先に読めた任意の切れ端」になる。**
    // 件数の多いフォルダは辿るのがいちばん難しい場面なので、そこでだけ
    // 「ディレクトリが先」が効かないのでは、並びを決めた意味が無い（設計§8）。
    //
    // ファイルを上限の何倍も作るのは、**読み出しの順がファイルシステム任せ**
    // だから。全件を並べてから切っていなければ、フォルダは高い確率で溢れる
    let sandbox = Sandbox::new("orderlimit");
    for index in 0..(MAX_ENTRIES * 3) {
        sandbox.file(&format!("f{index:05}.txt"), b"x");
    }
    // 名前でも最後に来る形にして、「たまたま先頭に居た」を排除する
    let names_of_dirs = ["zz-a", "zz-b", "zz-c", "zz-d", "zz-e"];
    for name in names_of_dirs {
        sandbox.dir(name);
    }
    std::fs::create_dir_all(sandbox.path().join("zz-a").join(".git")).expect(".git を作れること");

    let listing = hostfs::list_dir(sandbox.path()).expect("読めること");

    assert!(listing.truncated, "打ち切ったことが応答に載ること");
    let got = names(&listing);
    for name in names_of_dirs {
        assert!(
            got.contains(&name.to_string()),
            "{name} が溢れている（打ち切ってから並べていないか）"
        );
    }
    assert_eq!(
        &got[..names_of_dirs.len()],
        &names_of_dirs,
        "ディレクトリが先頭に固まること"
    );
    // 印は**残した1件ぶんだけ**見る作りにしたので、打ち切った先でも正しいこと
    assert!(
        listing.entries[0].is_project,
        "打ち切った一覧でも .git の印が立つこと"
    );
}

#[test]
fn ルートがフォルダへのリンクでも一覧できる() {
    // 「リンクは辿らない」は**一覧の中の1件**についての決まりで、問われたパス
    // そのものには当てはまらない。ここを取り違えると、`~/Dev` をリンクにしている
    // 人は左パネルが丸ごと使えない
    let sandbox = Sandbox::new("rootlink");
    let real = sandbox.dir("real");
    std::fs::write(real.join("中身.md"), b"# hi\n").expect("中身を作れること");
    let link = sandbox.path().join("link");
    std::os::unix::fs::symlink(&real, &link).expect("リンクを作れること");

    let listing = hostfs::list_dir(&link).expect("リンク越しでも読めること");

    assert_eq!(names(&listing), vec!["中身.md"]);
}

#[test]
fn ドット始まりも一覧に出る() {
    let sandbox = Sandbox::new("dotfiles");
    sandbox.dir(".claude");
    sandbox.file(".gitignore", b"target\n");
    sandbox.file("README.md", b"# hi\n");

    let listing = hostfs::list_dir(sandbox.path()).expect("読めること");

    // `.claude/` を見たい場面が実際にある（利用者判断）。切替は作らない
    assert!(names(&listing).contains(&".claude".to_string()));
    assert!(names(&listing).contains(&".gitignore".to_string()));
}

#[test]
fn リンクはsymlinkとして出て辿られない() {
    let sandbox = Sandbox::new("symlink");
    let target = sandbox.dir("real");
    std::os::unix::fs::symlink(&target, sandbox.path().join("link")).expect("リンクを作れること");

    let listing = hostfs::list_dir(sandbox.path()).expect("読めること");
    let link = listing
        .entries
        .iter()
        .find(|e| e.name == "link")
        .expect("リンクが一覧に出ること");

    // 辿ると「フォルダ」になってしまう。**辿っていないことがここで分かる**
    assert_eq!(link.kind, EntryKind::Symlink);
    assert!(!link.is_project, "辿らないので中身の印は付かないこと");
}

#[test]
fn リンクで輪を作っても列挙は止まる() {
    let sandbox = Sandbox::new("loop");
    let a = sandbox.path().join("a");
    let b = sandbox.path().join("b");
    std::os::unix::fs::symlink(&b, &a).expect("a→b を作れること");
    std::os::unix::fs::symlink(&a, &b).expect("b→a を作れること");
    // 自分の親を指すリンクも足す（いちばん輪になりやすい形）
    std::os::unix::fs::symlink(sandbox.path(), sandbox.path().join("self"))
        .expect("self を作れること");

    // 辿らない実装なので、ここが返ってくること自体が答えになる
    let listing = hostfs::list_dir(sandbox.path()).expect("読めること");

    assert_eq!(listing.entries.len(), 3);
    assert!(
        listing.entries.iter().all(|e| e.kind == EntryKind::Symlink),
        "3件ともリンクとして出ること"
    );
}

#[test]
fn gitを持つフォルダにだけ印が立つ() {
    let sandbox = Sandbox::new("isproject");
    let project = sandbox.dir("proj");
    std::fs::create_dir_all(project.join(".git")).expect(".git を作れること");
    sandbox.dir("plain");

    let listing = hostfs::list_dir(sandbox.path()).expect("読めること");
    let find = |name: &str| {
        listing
            .entries
            .iter()
            .find(|e| e.name == name)
            .unwrap_or_else(|| panic!("{name} が一覧に出ること"))
            .is_project
    };

    assert!(find("proj"), ".git を持つフォルダに印が立つこと");
    assert!(!find("plain"), "持たないフォルダには立たないこと");
}

#[test]
fn 読めない理由は3つに分かれる() {
    use std::os::unix::fs::PermissionsExt;

    let sandbox = Sandbox::new("reasons");

    // ① 存在しない
    let missing = hostfs::list_dir(&sandbox.path().join("居ない")).expect_err("断ること");
    assert_eq!(missing.reason, HostFailure::NotFound);

    // ② フォルダではない
    let file = sandbox.file("ただのファイル.txt", b"x");
    let not_dir = hostfs::list_dir(&file).expect_err("断ること");
    assert_eq!(not_dir.reason, HostFailure::NotDirectory);

    // ③ 権限が無い
    let locked = sandbox.dir("鍵つき");
    std::fs::set_permissions(&locked, PermissionsExt::from_mode(0o000))
        .expect("権限を落とせること");
    let denied = hostfs::list_dir(&locked);
    // root で走らせると落とした権限が効かない。**効いているときだけ判定する**
    if std::fs::read_dir(&locked).is_err() {
        assert_eq!(
            denied.expect_err("断ること").reason,
            HostFailure::Denied,
            "権限が無いことが、存在しないことと別の理由になること"
        );
    }

    // 3つが互いに別物であること（まとめると利用者が直しようを失う）
    assert_ne!(missing.reason, not_dir.reason);
}

// --- 中身の読み取り（設計§9）-----------------------------------------------

#[test]
fn 上限の内側のテキストはそのまま読める() {
    let sandbox = Sandbox::new("text");
    let body = "# 計画\n- [x] 済み\n- [ ] まだ\n";
    let path = sandbox.file("計画.md", body.as_bytes());

    let content = hostfs::read_file(&path).expect("読めること");

    assert_eq!(content.text, body);
    assert_eq!(content.bytes, body.len() as u64);
    assert!(!content.truncated);
}

#[test]
fn nulを含むファイルは中身を返さない() {
    let sandbox = Sandbox::new("nul");
    let path = sandbox.file("bin.dat", b"MZ\x00\x00\x90pretend-binary");

    let err = hostfs::read_file(&path).expect_err("断ること");

    assert_eq!(err.reason, HostFailure::Unsupported);
    // **中身が漏れていないこと。** 断る文にファイルの中身を混ぜない
    assert!(!err.detail.contains("pretend-binary"));
}

#[test]
fn utf8として読めないファイルは断る() {
    let sandbox = Sandbox::new("sjis");
    // Shift_JIS の「日本語」。NUL は含まないので、UTF-8 の判定でだけ弾かれる
    let path = sandbox.file("sjis.txt", &[0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA]);

    let err = hostfs::read_file(&path).expect_err("断ること");

    // 文字コードを推定しない。外すと文字化けした嘘を表示することになる
    assert_eq!(err.reason, HostFailure::Unsupported);
}

#[test]
fn 上限を超えるファイルは大きさを添えて断る() {
    let sandbox = Sandbox::new("toolarge");
    let size = (MAX_FILE_BYTES + 1) as usize;
    let path = sandbox.file("大きい.txt", &vec![b'a'; size]);

    let err = hostfs::read_file(&path).expect_err("断ること");

    assert_eq!(err.reason, HostFailure::TooLarge);
    assert!(
        err.detail.contains(&size.to_string()),
        "実際の大きさが添えられること（{}）",
        err.detail
    );
}

#[test]
fn リンク越しでも大きさの上限は効く() {
    // **判定と読み取りが同じものを見ていないと、リンク1本で上限をすり抜ける。**
    // 辿らない側で測るとリンク自身の長さ（数十バイト）になるのに、読むほうは
    // 辿るので、上限を無視した中身がそのまま画面まで流れる
    let sandbox = Sandbox::new("linklarge");
    let size = (MAX_FILE_BYTES + 1) as usize;
    let real = sandbox.file("大きい.txt", &vec![b'a'; size]);
    let link = sandbox.path().join("近道.txt");
    std::os::unix::fs::symlink(&real, &link).expect("リンクを作れること");

    let err = hostfs::read_file(&link).expect_err("リンク越しでも断ること");

    assert_eq!(err.reason, HostFailure::TooLarge);
    assert!(
        err.detail.contains(&size.to_string()),
        "リンク先の大きさが添えられること（{}）",
        err.detail
    );
}

#[test]
fn フォルダへのリンクはフォルダとして断る() {
    // 辿らない側で見ていると「フォルダである」ことに気づけず、読みに行って
    // 失敗する。理由が「開けません」になるので、利用者は何をすればよいか分からない
    let sandbox = Sandbox::new("linkdir");
    let real = sandbox.dir("real");
    let link = sandbox.path().join("link");
    std::os::unix::fs::symlink(&real, &link).expect("リンクを作れること");

    let err = hostfs::read_file(&link).expect_err("断ること");

    assert_eq!(err.reason, HostFailure::Unsupported);
    assert!(
        err.detail.contains("フォルダなので"),
        "フォルダだと分かる説明であること（{}）",
        err.detail
    );
}

#[test]
fn 書き込みの口が存在しない() {
    // **構造で守る。** 読むだけと決めた以上、書く道具がソースに現れてはいけない。
    // 呼び出しを増やしたときに、ここが落ちて気づける
    let source = include_str!("../src/hostfs.rs");
    for forbidden in [
        "fs::write",
        "fs::create_dir",
        "fs::remove",
        "fs::rename",
        "fs::copy",
        "OpenOptions",
        "set_permissions",
    ] {
        assert!(
            !source.contains(forbidden),
            "書き込みの道具（{forbidden}）が入り込んでいる"
        );
    }
}
