//! 利用者の PC のフォルダとファイルを読む決まり（テスト計画 フェーズ2「列挙の決まり」「中身の読み取り」）。
//!
//! **実物のファイルシステムを相手にする。** 作った文字列だけで固めると、実装とテストが
//! 同じ勘違いを共有する（PJTガイドライン「数えて取り出す実装は、作った文字列だけで
//! 固めない」）。一時ディレクトリに実際のフォルダ・ファイル・シンボリックリンクを作る。

#![allow(non_snake_case)]

use protocol::a2s::HostFailure;
use protocol::fs::{EntryKind, MAX_BLOB_BYTES, MAX_ENTRIES, MAX_FILE_BYTES};
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

// --- 起点の解決（設計§13・§26-2）-------------------------------------------

#[test]
fn 起点は末尾のスラッシュを落として返す() {
    // **フォルダのコピーは末尾に `/` を付ける仕様**（設計§28）なので、貼って
    // 足すだけでこの形になる。カード側（`spawn_with`）は `/` 無しの正規形を
    // 持つので、ここで揃えないと**同じ PJT が2つの箱に割れる**
    let sandbox = Sandbox::new("trailing");
    sandbox.dir("中身");

    let listing =
        hostfs::list_dir_from(Some(&format!("{}/", sandbox.path().display()))).expect("読めること");

    assert_eq!(
        listing.path,
        sandbox
            .path()
            .canonicalize()
            .expect("実体があること")
            .display()
            .to_string(),
        "末尾の `/` が残っている"
    );
}

#[test]
fn 起点がリンクでも実体のパスで返す() {
    // `~/Dev` をリンクにしている人は、辿る道と打ち込む道で別の文字列になる。
    // カード側は `canonicalize` を通すので、こちらも同じ規則へ寄せる
    let sandbox = Sandbox::new("startlink");
    let real = sandbox.dir("real");
    let link = sandbox.path().join("近道");
    std::os::unix::fs::symlink(&real, &link).expect("リンクを作れること");

    let listing = hostfs::list_dir_from(Some(&link.display().to_string())).expect("読めること");

    assert_eq!(
        listing.path,
        real.canonicalize()
            .expect("実体があること")
            .display()
            .to_string(),
        "リンクのままの名前で返っている"
    );
}

#[test]
fn 実体が無い起点は打ち込まれた形のまま返す() {
    // 寝ている PC の枠を足せる必要がある（設計§17）。正規化できないことを
    // **断る理由にしない**——断るかどうかは一覧を引く側の判断
    let sandbox = Sandbox::new("startmissing");
    let missing = sandbox.path().join("まだ無い");

    let err = hostfs::list_dir_from(Some(&missing.display().to_string())).expect_err("断ること");

    assert_eq!(err.reason, HostFailure::NotFound);
    assert!(
        err.detail.contains("まだ無い"),
        "打ち込まれた形がそのまま説明に出ること（{}）",
        err.detail
    );
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

// ---------------------------------------------------------------------------
// バイト列で読む（`ファイル閲覧で画像とHTMLも表示する` 設計§3-2。テスト計画フェーズ2）
// ---------------------------------------------------------------------------

/// 1x1 の GIF89a。**43バイトの実物**で、ブラウザが描けることも測ってある（設計§15 の5）。
const 小さなGIF: &[u8] = &[
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x44, 0x00, 0x3b,
];

#[test]
fn 表にある種別はバイト列で返る() {
    let sandbox = Sandbox::new("blob-ok");
    sandbox.file("撮った.gif", 小さなGIF);

    let blob = hostfs::read_blob(&sandbox.path().join("撮った.gif")).expect("読めること");

    assert_eq!(blob.data, 小さなGIF, "中身がそのまま運ばれること");
    assert_eq!(blob.media_type, "image/gif", "媒体型が添うこと");
    assert_eq!(blob.bytes, 小さなGIF.len() as u64);
    assert!(blob.path.ends_with("撮った.gif"));
}

#[test]
fn 画像でないものはバイト列の道へ入れない() {
    // **門は種別で見る**（`ファイルの中身に掛けた隔離を、script の1段だけ解く` 設計§5-2）。
    // 媒体型の有無で見ていた頃はここが門になっていたが、**表に無いものにも
    // `text/plain` を返すようになった**ので、あれに頼るとテキストが画像の道へ入り込む。
    //
    // **`html` と `svg` も入れない。** あちらはテキストの道から作る（設計§5-2）
    let sandbox = Sandbox::new("blob-unknown");
    sandbox.file("組み込み.js", b"alert(1)");
    sandbox.file("計画.md", b"# a");
    sandbox.file("理解.html", b"<p>a</p>");
    sandbox.file("図.svg", b"<svg/>");

    for name in ["組み込み.js", "計画.md", "理解.html", "図.svg"] {
        let err = hostfs::read_blob(&sandbox.path().join(name)).expect_err("断ること");
        assert_eq!(err.reason, HostFailure::Unsupported, "{name}");
        assert!(
            err.detail.contains("画像ではない"),
            "何が駄目なのか分かる説明であること（{}）",
            err.detail
        );
    }
}

#[test]
fn フォルダはバイト列でも断る() {
    let sandbox = Sandbox::new("blob-dir");
    // 拡張子だけを見れば表に載る名前のフォルダ。**種別の判定だけで通してはいけない**
    sandbox.dir("紛らわしい.png");

    let err = hostfs::read_blob(&sandbox.path().join("紛らわしい.png")).expect_err("断ること");

    assert_eq!(err.reason, HostFailure::Unsupported);
    assert!(err.detail.contains("フォルダなので"), "{}", err.detail);
}

#[test]
fn 上限を超えたら大きさを添えて断る() {
    let sandbox = Sandbox::new("blob-large");
    let size = MAX_BLOB_BYTES as usize + 1;
    sandbox.file("大きい.png", &vec![0u8; size]);

    let err = hostfs::read_blob(&sandbox.path().join("大きい.png")).expect_err("断ること");

    assert_eq!(err.reason, HostFailure::TooLarge);
    assert!(
        err.detail.contains(&size.to_string()),
        "実際の大きさが読めること（{}）",
        err.detail
    );
    assert!(
        err.detail.contains(&MAX_BLOB_BYTES.to_string()),
        "上限も読めること（{}）",
        err.detail
    );
}

#[test]
fn リンク越しでも上限をすり抜けられない() {
    // `symlink_metadata`（辿らない側）で測ると、**リンク1本で上限をすり抜けられる**
    let sandbox = Sandbox::new("blob-link");
    let real = sandbox.path().join("本体.png");
    std::fs::write(&real, vec![0u8; MAX_BLOB_BYTES as usize + 1]).expect("置けること");
    let link = sandbox.path().join("近道.png");
    std::os::unix::fs::symlink(&real, &link).expect("リンクを張れること");

    let err = hostfs::read_blob(&link).expect_err("リンク越しでも断ること");

    assert_eq!(err.reason, HostFailure::TooLarge);
}

#[test]
fn 権限が無いのと存在しないのを言い分ける() {
    let sandbox = Sandbox::new("blob-why");

    let missing = hostfs::read_blob(&sandbox.path().join("無い.png")).expect_err("断ること");
    assert_eq!(missing.reason, HostFailure::NotFound);

    let denied_path = sandbox.path().join("読めない.png");
    std::fs::write(&denied_path, 小さなGIF).expect("置けること");
    let mut perms = std::fs::metadata(&denied_path)
        .expect("見えること")
        .permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o000);
    std::fs::set_permissions(&denied_path, perms).expect("権限を落とせること");

    let denied = hostfs::read_blob(&denied_path);
    // root で走らせると権限は効かない。**そのときは判定そのものを飛ばす**——
    // 「効かない環境でだけ落ちるテスト」は、直せないものを赤くするだけになる
    if let Err(err) = denied {
        assert_eq!(err.reason, HostFailure::Denied);
        assert_ne!(err.reason, HostFailure::NotFound, "不在と混ぜないこと");
    }
}

#[test]
fn 中身は検めない() {
    // 拡張子が `.png` で中身がテキストでも、**そのまま返る**。
    // 壊れていることを言うのは描く側（設計§7-2）——ここで見に行くと、
    // 「読めない」と「壊れている」が同じ断りに潰れる
    let sandbox = Sandbox::new("blob-lying");
    sandbox.file("嘘.png", "これは画像ではありません".as_bytes());

    let blob = hostfs::read_blob(&sandbox.path().join("嘘.png")).expect("断らないこと");

    assert_eq!(
        blob.media_type, "image/png",
        "拡張子どおりの媒体型が付くこと"
    );
    assert_eq!(blob.data, "これは画像ではありません".as_bytes());
}

#[test]
fn テキストの上限は動かしていない() {
    // **画像の上限を足しても、テキストの側は1バイトも動かさない**（設計§13）
    let sandbox = Sandbox::new("blob-text-untouched");
    let size = MAX_FILE_BYTES as usize + 1;
    sandbox.file("長い.md", &vec![b'a'; size]);

    let err = hostfs::read_file(&sandbox.path().join("長い.md")).expect_err("今までどおり断ること");

    assert_eq!(err.reason, HostFailure::TooLarge);
    // 画像の上限（8 MiB）で判定していたら、この大きさは通ってしまう。
    // **定数どうしの比較は const block へ**（clippy）——ここは実行時ではなく
    // 「2つの上限が別物である」という約束そのものを固定している
    const { assert!(MAX_FILE_BYTES < MAX_BLOB_BYTES) };
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
