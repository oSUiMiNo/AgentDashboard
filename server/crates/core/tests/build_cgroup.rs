//! docker の外で走るビルドと検査を、返せる箱の中で走らせる仕組みの機械検査
//! （設計§6／テスト計画フェーズ1〜4）。
//!
//! # なぜここまでやるのか
//!
//! この仕組みも `prune_target.rs` と同じで、**壊れても表に出ない向き**を持っている。
//!
//! - **箱へ入れていない** — ビルドは通り、検査も緑のまま。**機械が痩せていくことでしか
//!   分からない**ので、気づくのは数時間後の実測になる
//! - **命令の終了コードを食う** — `make ci` が失敗を見逃す。**赤が緑に化ける**ので、
//!   気づいたときには壊れたものが配られている
//!
//! どちらも読むだけの検査では捕まらない。だから `prune_target.rs` と同じ形で、
//! **偽の cgroup の木を作って実物のスクリプトを走らせ、残ったものを数える。**
//!
//! # root も本物の cgroup も要らない
//!
//! `/sys/fs/cgroup` の場所と WSL の目印を環境変数で差し替え、一時領域に作った
//! ただのファイルを相手にする。**本物の `/sys/fs/cgroup` を叩く経路は、そもそも通らない**
//! ——根が差し替えられているときスクリプトは docker を起こさないと決めてある（設計§6-2）。
//! これが無いと、`docker run` が `/sys/fs/cgroup` を持ち込むので**検査が本物の機械を返す**。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// 1 GiB。しきい値の検査で使う。
const GIB: u64 = 1_073_741_824;

fn server_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("server の下")
        .to_path_buf()
}

fn repo_root() -> PathBuf {
    server_root()
        .parent()
        .expect("リポジトリの根")
        .to_path_buf()
}

fn 包み() -> PathBuf {
    repo_root().join("scripts").join("in-build-cgroup")
}

fn 返す口() -> PathBuf {
    repo_root().join("scripts").join("reclaim-cache")
}

/// 偽の cgroup の木と、記録の置き場所。**Drop で畳む。**
struct 偽の一式 {
    根: PathBuf,
    置き場所: PathBuf,
}

impl 偽の一式 {
    fn new(label: &str) -> Self {
        let base =
            std::env::temp_dir().join(format!("agentdashboard-box-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let 根 = base.join("cgroup");
        let 置き場所 = base.join("target");
        std::fs::create_dir_all(&根).expect("作れること");
        std::fs::create_dir_all(&置き場所).expect("作れること");
        // 本物の `/sys/fs/cgroup` にも在るもの。**在ることを条件にしている箇所がある**
        std::fs::write(根.join("cgroup.procs"), "").expect("書けること");
        Self { 根, 置き場所 }
    }

    /// WSL の目印。**存在するファイルなら何でもよい**（中身は見ない）。
    fn 目印(&self) -> PathBuf {
        self.根.parent().expect("親").join("wsl-marker")
    }

    fn 目印を置く(&self) -> PathBuf {
        let p = self.目印();
        std::fs::write(&p, "").expect("書けること");
        p
    }

    /// `memory.stat` と `memory.reclaim` を持つ cgroup を1つ置く。
    fn cgroupを置く(&self, name: &str, file_bytes: u64) {
        let dir = self.根.join(name);
        std::fs::create_dir_all(&dir).expect("作れること");
        // **`file_mapped` を混ぜてある。** 完全一致で拾っていない実装だと、こちらに
        // 釣られて数が変わる
        std::fs::write(
            dir.join("memory.stat"),
            format!("anon 4096\nfile {file_bytes}\nfile_mapped 999999999\n"),
        )
        .expect("書けること");
        std::fs::write(dir.join("memory.reclaim"), "").expect("書けること");
        std::fs::write(dir.join("cgroup.procs"), "").expect("書けること");
    }

    fn 箱の場所(&self) -> PathBuf {
        self.根.join("agentdashboard-build")
    }

    fn 箱がある(&self) -> bool {
        self.箱の場所().is_dir()
    }

    fn 箱のprocs(&self) -> String {
        std::fs::read_to_string(self.箱の場所().join("cgroup.procs")).unwrap_or_default()
    }

    fn reclaimの中身(&self, name: &str) -> String {
        std::fs::read_to_string(self.根.join(name).join("memory.reclaim")).unwrap_or_default()
    }

    fn 包みの記録(&self) -> String {
        std::fs::read_to_string(self.置き場所.join(".build-cgroup.log")).unwrap_or_default()
    }
}

impl Drop for 偽の一式 {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.根.parent().expect("親"));
    }
}

/// 実物のスクリプトを走らせる。**呼び出し側の環境が漏れ込まないよう明示的に外す。**
fn 走らせる(script: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut cmd = Command::new("bash");
    cmd.arg(script);
    for arg in args {
        cmd.arg(arg);
    }
    for key in [
        "AGENTDASHBOARD_CARGO_CGROUP",
        "AGENTDASHBOARD_CARGO_CGROUP_ROOT",
        "AGENTDASHBOARD_CARGO_WSL_MARKER",
        "AGENTDASHBOARD_CARGO_RECLAIM",
        "AGENTDASHBOARD_CARGO_RECLAIM_TARGET",
        "AGENTDASHBOARD_CARGO_RECLAIM_MIN_GB",
        "AGENTDASHBOARD_CARGO_RECLAIM_INTERVAL_SEC",
    ] {
        cmd.env_remove(key);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.output().expect("bash を実行できること")
}

/// 包みを走らせる。**箱の道が通っている形**（目印あり・偽の木）を既定にする。
fn 包みを走らせる(
    一式: &偽の一式, 追加: &[(&str, &str)], 命令: &[&str]
) -> Output {
    let 目印 = 一式.目印を置く();
    let mut env: Vec<(String, String)> = vec![
        (
            "AGENTDASHBOARD_CARGO_CGROUP_ROOT".into(),
            一式.根.display().to_string(),
        ),
        (
            "AGENTDASHBOARD_CARGO_WSL_MARKER".into(),
            目印.display().to_string(),
        ),
        (
            "AGENTDASHBOARD_CARGO_RECLAIM_TARGET".into(),
            一式.置き場所.display().to_string(),
        ),
    ];
    for (k, v) in 追加 {
        env.retain(|(ek, _)| ek != k);
        env.push(((*k).into(), (*v).into()));
    }
    let 借りた: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    走らせる(&包み(), 命令, &借りた)
}

fn 終了コード(out: &Output) -> i32 {
    out.status.code().expect("終了コードが取れること")
}

/// **標準出力は完全に空。** 命令の出力へ混ざると、出力を読んでいる別の仕組みを壊す。
fn 標準出力が空(out: &Output) {
    assert!(
        out.stdout.is_empty(),
        "標準出力へ書いています: {}",
        String::from_utf8_lossy(&out.stdout)
    );
}

// --- フェーズ1：包みが命令を素通しする -----------------------------------------

#[test]
fn 箱が無くても命令は走り終了コードがそのまま返る() {
    let 一式 = 偽の一式::new("passthrough");
    let 追加 = [("AGENTDASHBOARD_CARGO_CGROUP_ROOT", "/nonexistent/cgroup")];

    let out = 包みを走らせる(&一式, &追加, &["bash", "-c", "echo ran; exit 0"]);
    assert_eq!(終了コード(&out), 0, "成功が素通りしていない");
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "ran",
        "命令が走っていない"
    );

    // **失敗のほうが大事。** 後ろに返す口を足したせいで 0 に化けると `make ci` が見逃す
    let out = 包みを走らせる(&一式, &追加, &["bash", "-c", "exit 42"]);
    assert_eq!(終了コード(&out), 42, "失敗の終了コードが食われている");
}

#[test]
fn 箱へ移せなくても命令は走る() {
    let 一式 = 偽の一式::new("unwritable");
    // 箱は在るが `cgroup.procs` が読み取り専用。**持ち主が戻った機械の形**である
    let 箱 = 一式.箱の場所();
    std::fs::create_dir_all(&箱).expect("作れること");
    let procs = 箱.join("cgroup.procs");
    std::fs::write(&procs, "").expect("書けること");
    let mut perm = std::fs::metadata(&procs).expect("読めること").permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perm.set_mode(0o444);
    }
    std::fs::set_permissions(&procs, perm).expect("設定できること");

    let out = 包みを走らせる(&一式, &[], &["bash", "-c", "exit 7"]);
    assert_eq!(
        終了コード(&out),
        7,
        "移れなかったせいで終了コードが変わった"
    );
    assert!(
        一式.包みの記録().contains("移れなかった"),
        "移れなかったことが記録に残っていない: {}",
        一式.包みの記録()
    );
    assert_eq!(
        一式.箱のprocs(),
        "",
        "書けないはずの cgroup.procs に書けている"
    );
}

#[test]
fn 包みは標準出力へ一文字も書かない() {
    let 一式 = 偽の一式::new("stdout");
    let out = 包みを走らせる(&一式, &[], &["true"]);
    標準出力が空(&out);
}

// --- フェーズ2：箱を作る条件 ---------------------------------------------------

#[test]
fn wslでなければ箱を作りに行かない() {
    let 一式 = 偽の一式::new("not-wsl");
    // **これが効かないと、GitHub Actions の CI が毎回 docker で箱を作りに行って失敗する**
    let out = 包みを走らせる(
        &一式,
        &[("AGENTDASHBOARD_CARGO_WSL_MARKER", "/nonexistent/wsl")],
        &["bash", "-c", "exit 5"],
    );
    assert_eq!(終了コード(&out), 5, "命令が走っていない");
    assert!(!一式.箱がある(), "WSL でないのに箱を作っている");
}

#[test]
fn wslなら箱を作って自分を入れる() {
    let 一式 = 偽の一式::new("make-box");
    let out = 包みを走らせる(&一式, &[], &["true"]);
    assert_eq!(終了コード(&out), 0);
    assert!(一式.箱がある(), "箱が作られていない");

    // **数字が1つ書かれていること。** 「何か書いてある」では、空文字でも通ってしまう
    let procs = 一式.箱のprocs();
    let 行: Vec<&str> = procs.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(行.len(), 1, "cgroup.procs の中身が1行でない: {procs:?}");
    assert!(
        行[0].parse::<u32>().is_ok(),
        "cgroup.procs に PID でないものが書かれている: {procs:?}"
    );
    assert!(
        一式.包みの記録().contains("箱へ移った"),
        "箱へ移ったことが記録に残っていない: {}",
        一式.包みの記録()
    );
}

#[test]
fn 二回目は箱を作り直さない() {
    let 一式 = 偽の一式::new("idempotent");
    包みを走らせる(&一式, &[], &["true"]);
    包みを走らせる(&一式, &[], &["true"]);

    // **「箱を作った」が2回出ていたら、2回目も docker を起こしている。** 本物の機械では
    // 1回あたり1〜2秒かかるので、対象の数だけ待ち時間が増えることになる
    let 作った = 一式.包みの記録().matches("箱を作った").count();
    assert_eq!(作った, 1, "2回目も箱を作っている: {}", 一式.包みの記録());
    let 移った = 一式.包みの記録().matches("箱へ移った").count();
    assert_eq!(移った, 2, "2回とも箱へ移れていない: {}", 一式.包みの記録());
}

#[test]
fn 止める口が効く() {
    let 一式 = 偽の一式::new("disabled");
    let out = 包みを走らせる(
        &一式,
        &[("AGENTDASHBOARD_CARGO_CGROUP", "0")],
        &["bash", "-c", "exit 9"],
    );
    assert_eq!(終了コード(&out), 9, "命令が走っていない");
    assert!(!一式.箱がある(), "止めてあるのに箱を作っている");
}

// --- フェーズ3：返す口が両方を見る ---------------------------------------------

/// 返す口を、偽の木に対して走らせる。
fn 返す口を走らせる(一式: &偽の一式, 追加: &[(&str, &str)]) -> Output {
    let mut env: Vec<(String, String)> = vec![
        (
            "AGENTDASHBOARD_CARGO_CGROUP_ROOT".into(),
            一式.根.display().to_string(),
        ),
        // **間隔は毎回 0 にする。** 前の検査が刻んだ印で見送られると、
        // 何も確かめないまま緑になる
        (
            "AGENTDASHBOARD_CARGO_RECLAIM_INTERVAL_SEC".into(),
            "0".into(),
        ),
    ];
    for (k, v) in 追加 {
        env.retain(|(ek, _)| ek != k);
        env.push(((*k).into(), (*v).into()));
    }
    let 借りた: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let 置き場所 = 一式.置き場所.display().to_string();
    走らせる(&返す口(), &[置き場所.as_str()], &借りた)
}

#[test]
fn しきい値は合計で判定される() {
    // **片方ずつでは、どちらも 1 GiB に届かない。** 合計で見ていない実装はここで落ちる
    let 一式 = 偽の一式::new("sum-over");
    let 半分 = GIB * 6 / 10;
    一式.cgroupを置く("docker", 半分);
    一式.cgroupを置く("agentdashboard-build", 半分);

    let out = 返す口を走らせる(&一式, &[("AGENTDASHBOARD_CARGO_RECLAIM_MIN_GB", "1.0")]);
    assert_eq!(終了コード(&out), 0);
    assert_eq!(
        一式.reclaimの中身("docker").trim(),
        半分.to_string(),
        "合計で超えているのに /docker を返していない"
    );
    assert_eq!(
        一式.reclaimの中身("agentdashboard-build").trim(),
        半分.to_string(),
        "合計で超えているのに箱を返していない"
    );
}

#[test]
fn 合計でも届かなければ返さない() {
    let 一式 = 偽の一式::new("sum-under");
    let 少し = GIB * 2 / 10;
    一式.cgroupを置く("docker", 少し);
    一式.cgroupを置く("agentdashboard-build", 少し);

    let out = 返す口を走らせる(&一式, &[("AGENTDASHBOARD_CARGO_RECLAIM_MIN_GB", "1.0")]);
    assert_eq!(終了コード(&out), 0);
    assert_eq!(
        一式.reclaimの中身("docker"),
        "",
        "届いていないのに返している"
    );
    assert_eq!(
        一式.reclaimの中身("agentdashboard-build"),
        "",
        "届いていないのに返している"
    );
}

#[test]
fn 片方だけ大きくても返す() {
    let 一式 = 偽の一式::new("one-big");
    一式.cgroupを置く("docker", GIB * 3);
    一式.cgroupを置く("agentdashboard-build", 0);

    let out = 返す口を走らせる(&一式, &[("AGENTDASHBOARD_CARGO_RECLAIM_MIN_GB", "1.0")]);
    assert_eq!(終了コード(&out), 0);
    assert_eq!(
        一式.reclaimの中身("docker").trim(),
        (GIB * 3).to_string(),
        "大きいほうを返していない"
    );
}

#[test]
fn 箱しか無い機械でも返す() {
    // docker を使っていない機械・箱をまだ作っていない機械のどちらでも動くこと
    let 一式 = 偽の一式::new("box-only");
    一式.cgroupを置く("agentdashboard-build", GIB * 3);

    let out = 返す口を走らせる(&一式, &[("AGENTDASHBOARD_CARGO_RECLAIM_MIN_GB", "1.0")]);
    assert_eq!(終了コード(&out), 0);
    assert_eq!(
        一式.reclaimの中身("agentdashboard-build").trim(),
        (GIB * 3).to_string(),
        "箱しか無い機械で返していない"
    );
}

#[test]
fn 返す口は標準出力へ一文字も書かない() {
    let 一式 = 偽の一式::new("reclaim-stdout");
    一式.cgroupを置く("docker", GIB * 3);
    let out = 返す口を走らせる(&一式, &[("AGENTDASHBOARD_CARGO_RECLAIM_MIN_GB", "1.0")]);
    標準出力が空(&out);
}

// --- フェーズ4：返す口の失敗が呼び元に漏れない ---------------------------------

/// 返す口が**必ず失敗する**形。しきい値に数でないものを渡すと、検査に落ちて 1 で返る。
const 返す口が落ちる形: (&str, &str) = ("AGENTDASHBOARD_CARGO_RECLAIM_MIN_GB", "こわす");

#[test]
fn 返す口が落ちても呼び元の終了コードは変わらない() {
    let 一式 = 偽の一式::new("reclaim-fails");
    // 返す口が**検査まで進む**ように、相手の cgroup を1つ置いておく
    一式.cgroupを置く("docker", GIB * 3);

    // まず、この形で本当に返す口が落ちることを確かめる。
    // **落ちない形で「終了コードが変わらない」を見ても、何も確かめていない**
    let 単体 = 返す口を走らせる(&一式, &[返す口が落ちる形]);
    assert_eq!(
        終了コード(&単体),
        1,
        "返す口が落ちていない。検査が空振りする"
    );

    let out = 包みを走らせる(&一式, &[返す口が落ちる形], &["bash", "-c", "exit 0"]);
    assert_eq!(終了コード(&out), 0, "返す口の失敗が呼び元へ漏れている");

    let out = 包みを走らせる(&一式, &[返す口が落ちる形], &["bash", "-c", "exit 42"]);
    assert_eq!(終了コード(&out), 42, "命令の失敗が返す口に食われている");
}
