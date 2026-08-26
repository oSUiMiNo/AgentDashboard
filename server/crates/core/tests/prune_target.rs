//! ビルドの置き場所を自動で片付ける仕組みの機械検査（設計§11／テスト計画フェーズ2・3）。
//!
//! # なぜここまでやるのか
//!
//! この仕組みは**壊れても表に出ない向き**を2つ持っている。
//!
//! - **消しすぎる** — 次のビルドが遅くなるだけで、画面にも検査にも何も出ない。
//!   「cargo が遅い日がある」としか感じられない
//! - **走っているビルドの足元を抜く** — 並行している別セッションが落ちるが、
//!   落ちた側から見ると原因が自分の外にあるので追えない
//!
//! どちらも読むだけの検査では捕まらない。だから `dist/tests/uninstall.rs` と同じ形で、
//! **偽の置き場所を作って実物のスクリプトを走らせ、残ったものを数える。**
//!
//! # 本物の置き場所を渡す道を作らない
//!
//! 検査が壊れたときに開発機の `server/target` が巻き添えになる経路を、そもそも作らない
//! （`uninstall.rs` が偽の `HOME` を渡して本物の `HOME` を絶対に渡さないのと同じ考え方）。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, SystemTime};

/// cargo workspace の根（`server/`）。`crates/core` から2つ上（`cli_surface.rs` と同じ）。
fn server_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("server の下")
        .to_path_buf()
}

/// リポジトリの根。`scripts/` はワークスペースの外に居る。
fn repo_root() -> PathBuf {
    server_root()
        .parent()
        .expect("リポジトリの根")
        .to_path_buf()
}

fn script() -> PathBuf {
    repo_root().join("scripts").join("prune-target")
}

/// 偽の置き場所。**Drop で畳む。**
struct 偽の置き場所 {
    path: PathBuf,
}

impl 偽の置き場所 {
    /// `label` ごとに別の場所を使う。同じプロセスで2つ作っても取り合わない。
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "agentdashboard-prune-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(path.join("debug/deps")).expect("作れること");
        std::fs::create_dir_all(path.join("debug/incremental")).expect("作れること");
        std::fs::create_dir_all(path.join("release")).expect("作れること");
        // 巻き添えを見るための番人。**これが消える実装は、配る実行ファイルを作る場所を壊している**
        std::fs::write(path.join("release/bystander"), "x").expect("書けること");
        // 置き場所そのものの目印。cargo が置く実物と同じ層に居る
        std::fs::write(path.join("CACHEDIR.TAG"), "Signature: 8a477f597d28d172")
            .expect("書けること");
        Self { path }
    }

    fn join(&self, part: &str) -> PathBuf {
        self.path.join(part)
    }

    /// `deps` に、基準名 `base` の世代を1つ置く。`age_days` が大きいほど古い。
    ///
    /// **mtime は書いたあとに明示して設定する。** コピー系の API で作ると mtime が
    /// 暗黙に引き継がれ、狙った新旧関係にならない（控えを `copy2` で戻したら
    /// mtime ごと戻り、cargo が「変更なし」と誤判定した既存の教訓の裏返し）。
    fn 実行ファイル(&self, base: &str, hash: &str, age_days: u64, kib: usize) {
        let path = self.join(&format!("debug/deps/{base}-{hash}"));
        std::fs::write(&path, vec![b'x'; kib * 1024]).expect("書けること");
        古くする(&path, age_days);
    }

    /// `deps` に、段1が触ってはいけない中間成果物を置く。
    fn 中間成果物(&self, name: &str, age_days: u64) {
        let path = self.join(&format!("debug/deps/{name}"));
        std::fs::write(&path, "x").expect("書けること");
        古くする(&path, age_days);
    }

    /// `incremental` に、基準名 `base` のクレートディレクトリを1つ置く。
    fn クレート(&self, base: &str, hash: &str, age_days: u64, kib: usize) {
        let dir = self.join(&format!("debug/incremental/{base}-{hash}"));
        std::fs::create_dir_all(dir.join("s-session")).expect("作れること");
        std::fs::write(dir.join("s-session/dep-graph.bin"), vec![b'x'; kib * 1024])
            .expect("書けること");
        古くする(&dir, age_days);
    }

    fn depsの顔ぶれ(&self) -> Vec<String> {
        顔ぶれ(&self.join("debug/deps"))
    }

    fn incrementalの顔ぶれ(&self) -> Vec<String> {
        顔ぶれ(&self.join("debug/incremental"))
    }

    fn 記録(&self) -> String {
        std::fs::read_to_string(self.join(".prune-target.log")).unwrap_or_default()
    }
}

impl Drop for 偽の置き場所 {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn 古くする(path: &Path, age_days: u64) {
    let when = SystemTime::now() - Duration::from_secs(age_days * 24 * 60 * 60);
    let file = std::fs::File::options()
        .write(true)
        .open(path)
        .or_else(|_| std::fs::File::open(path))
        .expect("開けること");
    file.set_modified(when).expect("mtime を設定できること");
}

fn 顔ぶれ(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .map(|e| {
            e.expect("読めること")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

/// 実物のスクリプトを走らせる。**標準出力と標準エラーは分けて受ける**——
/// 混ぜると「標準出力が空であること」を確かめられない。
fn 走らせる(place: &偽の置き場所, args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut cmd = Command::new("bash");
    cmd.arg(script());
    for arg in args {
        cmd.arg(arg);
    }
    cmd.arg(&place.path);
    // 上書きしなかったぶんは既定が効く。**呼び出し側の環境が漏れ込まないよう明示的に外す**
    for key in [
        "AGENTDASHBOARD_CARGO_PRUNE",
        "AGENTDASHBOARD_CARGO_PRUNE_CAP_GB",
        "AGENTDASHBOARD_CARGO_PRUNE_KEEP",
        "AGENTDASHBOARD_CARGO_PRUNE_INTERVAL_SEC",
    ] {
        cmd.env_remove(key);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.output().expect("bash を実行できること")
}

fn 成功を確かめる(out: &Output) {
    assert!(
        out.status.success(),
        "スクリプトが失敗しました:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    // **標準出力は完全に空。** cargo の出力へ混ざると、出力を読んでいる別の仕組みを壊す
    assert!(
        out.stdout.is_empty(),
        "標準出力へ書いています: {}",
        String::from_utf8_lossy(&out.stdout)
    );
}

/// 段1だけで収まる上限（下の仕掛けと対で決めてある）。
///
/// **境目に寄せて置かないこと。** 仕掛けの嵩と上限を近づけると、置き場所の
/// ファイルシステムが変わっただけ（手元と箱の中で違う）で判定が裏返り、
/// 「実装は正しいのに検査だけが落ちる」状態になる——実際に一度そうなった。
///
/// 仕掛けは古いものだけを大きく作ってあるので、前が約 24MiB、段1のあとが 1MiB 未満。
/// 上限を約 10MiB に置けば、どちらの側にも十分な余裕がある。
const 段1で収まる上限: &str = "0.01";
/// 段1では収まらない上限。段2への昇格を見るために使う（ほぼ 0）。
const 段1では収まらない上限: &str = "0.0000001";

/// 古い世代だけを大きく作った仕掛け。
///
/// **落ちるものを大きく、残るものを小さくしてある。** こうすると「段1で収まったか」の
/// 判定が嵩の細かい違いに左右されない。
fn 世代の仕掛け(label: &str) -> 偽の置き場所 {
    const 大: usize = 8 * 1024; // KiB 単位なので 8MiB
    const 小: usize = 64;
    let place = 偽の置き場所::new(label);
    // 基準名 alpha に4世代。古い2つが落ちて、新しい2つが残るはず
    place.実行ファイル("alpha", "aaaaaaaaaaaaaaa1", 40, 大);
    place.実行ファイル("alpha", "aaaaaaaaaaaaaaa2", 30, 大);
    place.実行ファイル("alpha", "aaaaaaaaaaaaaaa3", 20, 小);
    place.実行ファイル("alpha", "aaaaaaaaaaaaaaa4", 1, 小);
    // 基準名 beta は1世代しかない。**残す数に満たないものは落とさない**
    place.実行ファイル("beta", "bbbbbbbbbbbbbbb1", 50, 1);
    // 段1が触ってはいけないもの。**どれも古くしてある**——日数で落とす実装へ壊すと落ちる。
    //
    // `.rlib` は**同じ前置きで3世代**置いてある。1つだけだと基準名が必ず唯一になり、
    // 「拡張子を持つものを候補に入れてしまう」壊し方をしても振る舞いが変わらない
    // ——つまり**この性質を確かめられない仕掛け**になってしまう。
    place.中間成果物("libalpha-1111111111111111.rlib", 60);
    place.中間成果物("libalpha-2222222222222222.rlib", 50);
    place.中間成果物("libalpha-3333333333333333.rlib", 40);
    place.中間成果物("alpha-dddddddddddddddd.rmeta", 60);
    place.中間成果物("alpha-eeeeeeeeeeeeeeee.d", 60);
    place.中間成果物("alpha-ffffffffffffffff.o", 60);
    place.中間成果物("libproc-1111111111111111.so", 60);
    // 基準名 alpha に3世代。古い1つが落ちて、新しい2つが残るはず
    place.クレート("alpha", "zzzzzzzzzzzz1", 40, 大);
    place.クレート("alpha", "zzzzzzzzzzzz2", 20, 小);
    place.クレート("alpha", "zzzzzzzzzzzz3", 1, 小);
    place
}

fn 段1が走る環境(cap: &str) -> Vec<(&'static str, String)> {
    vec![
        ("AGENTDASHBOARD_CARGO_PRUNE_CAP_GB", cap.to_string()),
        ("AGENTDASHBOARD_CARGO_PRUNE_KEEP", "2".to_string()),
        ("AGENTDASHBOARD_CARGO_PRUNE_INTERVAL_SEC", "0".to_string()),
    ]
}

fn 借りる<'a>(env: &'a [(&'static str, String)]) -> Vec<(&'static str, &'a str)> {
    env.iter().map(|(k, v)| (*k, v.as_str())).collect()
}

// --- 段1：落ちるものが落ち、触らないものが残る -------------------------------

#[test]
fn 基準名ごとに新しい世代だけが残る() {
    let place = 世代の仕掛け("keep");
    let env = 段1が走る環境(段1で収まる上限);
    let out = 走らせる(&place, &[], &借りる(&env));
    成功を確かめる(&out);

    let deps = place.depsの顔ぶれ();
    assert!(
        deps.contains(&"alpha-aaaaaaaaaaaaaaa3".to_string())
            && deps.contains(&"alpha-aaaaaaaaaaaaaaa4".to_string()),
        "新しい2世代が残っていない: {deps:?}"
    );
    assert!(
        !deps.contains(&"alpha-aaaaaaaaaaaaaaa1".to_string())
            && !deps.contains(&"alpha-aaaaaaaaaaaaaaa2".to_string()),
        "古い世代が残っている: {deps:?}"
    );
    // **残す数に満たない基準名は、いくら古くても落とさない**
    assert!(
        deps.contains(&"beta-bbbbbbbbbbbbbbb1".to_string()),
        "1世代しかない基準名を落としている: {deps:?}"
    );
}

#[test]
fn クレートのディレクトリも世代で落ちる() {
    let place = 世代の仕掛け("inc");
    let env = 段1が走る環境(段1で収まる上限);
    成功を確かめる(&走らせる(&place, &[], &借りる(&env)));

    let inc = place.incrementalの顔ぶれ();
    assert_eq!(
        inc,
        vec![
            "alpha-zzzzzzzzzzzz2".to_string(),
            "alpha-zzzzzzzzzzzz3".to_string()
        ],
        "クレートのディレクトリが世代で落ちていない"
    );
}

#[test]
fn 段1は中間成果物に触らない() {
    let place = 世代の仕掛け("keep-intermediate");
    let env = 段1が走る環境(段1で収まる上限);
    成功を確かめる(&走らせる(&place, &[], &借りる(&env)));

    let deps = place.depsの顔ぶれ();
    // **どれも仕掛けの中でいちばん古い。** 日数で落とす実装へ壊すと、ここが真っ先に落ちる。
    // `.rlib` の3世代は、拡張子を持つものを候補に入れてしまう壊し方を捕まえるために居る。
    for name in [
        "libalpha-1111111111111111.rlib",
        "libalpha-2222222222222222.rlib",
        "libalpha-3333333333333333.rlib",
        "alpha-dddddddddddddddd.rmeta",
        "alpha-eeeeeeeeeeeeeeee.d",
        "alpha-ffffffffffffffff.o",
        "libproc-1111111111111111.so",
    ] {
        assert!(
            deps.contains(&name.to_string()),
            "{name} を消しています: {deps:?}"
        );
    }
}

#[test]
fn 巻き添えにしないこと() {
    let place = 世代の仕掛け("bystander");
    let env = 段1が走る環境(段1で収まる上限);
    成功を確かめる(&走らせる(&place, &[], &借りる(&env)));

    assert!(
        place.join("release/bystander").exists(),
        "配る実行ファイルを作る場所を巻き添えにしています"
    );
    assert!(
        place.join("CACHEDIR.TAG").exists(),
        "置き場所そのものの目印を消しています"
    );
}

// --- 走る条件・走らない条件 ---------------------------------------------------

#[test]
fn 上限以下では何もしない() {
    let place = 世代の仕掛け("under-cap");
    let before = place.depsの顔ぶれ();
    // 上限を十分大きく取る（既定の 40GB）
    let env = vec![
        ("AGENTDASHBOARD_CARGO_PRUNE_KEEP", "2".to_string()),
        ("AGENTDASHBOARD_CARGO_PRUNE_INTERVAL_SEC", "0".to_string()),
    ];
    成功を確かめる(&走らせる(&place, &[], &借りる(&env)));

    assert_eq!(before, place.depsの顔ぶれ(), "上限以下なのに消しています");
    assert!(
        place.記録().is_empty(),
        "何もしていないのに記録を書いています"
    );
}

#[test]
fn 間隔が空いていなければ測りもしない() {
    let place = 世代の仕掛け("interval");
    let before = place.depsの顔ぶれ();
    // 直前に測ったことにする
    std::fs::write(
        place.join(".prune-state"),
        format!(
            "{}\n",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("時計が壊れていないこと")
                .as_secs()
        ),
    )
    .expect("書けること");

    let env = vec![
        (
            "AGENTDASHBOARD_CARGO_PRUNE_CAP_GB",
            段1で収まる上限.to_string(),
        ),
        ("AGENTDASHBOARD_CARGO_PRUNE_KEEP", "2".to_string()),
        (
            "AGENTDASHBOARD_CARGO_PRUNE_INTERVAL_SEC",
            "3600".to_string(),
        ),
    ];
    成功を確かめる(&走らせる(&place, &[], &借りる(&env)));

    assert_eq!(
        before,
        place.depsの顔ぶれ(),
        "間隔が空いていないのに消しています"
    );
}

#[test]
fn 止める指定で何もしない() {
    let place = 世代の仕掛け("disabled");
    let before = place.depsの顔ぶれ();
    let env = vec![
        ("AGENTDASHBOARD_CARGO_PRUNE", "0".to_string()),
        (
            "AGENTDASHBOARD_CARGO_PRUNE_CAP_GB",
            段1で収まる上限.to_string(),
        ),
        ("AGENTDASHBOARD_CARGO_PRUNE_INTERVAL_SEC", "0".to_string()),
    ];
    成功を確かめる(&走らせる(&place, &[], &借りる(&env)));

    assert_eq!(before, place.depsの顔ぶれ(), "止める指定を無視しています");
}

#[test]
fn 置き場所を渡さなければ何もせずに落ちる() {
    // **既定値へ落ちる道が無いこと。** あると、呼び出し側の渡し忘れが
    // 「本物の置き場所を消す」という最悪の結果になる
    let out = Command::new("bash")
        .arg(script())
        .output()
        .expect("bash を実行できること");
    assert!(!out.status.success(), "引数が無いのに成功しています");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("置き場所"),
        "何が足りないのかを言っていません: {stderr}"
    );
}

#[test]
fn 段1で足りなければ段2へ上がる() {
    let place = 世代の仕掛け("stage2");
    let env = 段1が走る環境(段1では収まらない上限);
    成功を確かめる(&走らせる(&place, &[], &借りる(&env)));

    assert!(
        place.depsの顔ぶれ().is_empty() && place.incrementalの顔ぶれ().is_empty(),
        "段2まで上がっていません"
    );
    assert!(
        place.記録().contains("段2"),
        "段2まで来たことが記録に残っていません: {}",
        place.記録()
    );
    // **段2は起こらないはずの事態なので、警告として残る**
    assert!(place.記録().contains("警告"), "警告として残っていません");
    // 巻き添えは段2でも起きない
    assert!(
        place.join("release/bystander").exists(),
        "段2で巻き添えにしています"
    );
}

// --- 記録 ---------------------------------------------------------------------

#[test]
fn 消したことが記録に残る() {
    let place = 世代の仕掛け("log");
    let env = 段1が走る環境(段1で収まる上限);
    let out = 走らせる(&place, &[], &借りる(&env));
    成功を確かめる(&out);

    let log = place.記録();
    assert_eq!(log.lines().count(), 1, "記録が1行になっていません: {log}");
    assert!(log.contains("段1"), "どの段かが残っていません: {log}");
    assert!(
        log.contains("実行ファイル 2 件"),
        "件数が残っていません: {log}"
    );
    assert!(log.contains("クレート 1 件"), "件数が残っていません: {log}");
    assert!(log.contains('→'), "前後の嵩が残っていません: {log}");
    // 通知は標準エラーへ出る（黙って消さない）
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("prune-target"),
        "標準エラーへ何も出していません"
    );
}

// --- 手で叩く道（make prune）--------------------------------------------------

#[test]
fn allは上限も間隔も止める指定も見ずに丸ごと落とす() {
    let place = 世代の仕掛け("all");
    // **止める指定も、間隔も、上限も置いてある。手で叩いた以上、どれも効いてはいけない**
    std::fs::write(place.join(".prune-state"), "9999999999\n").expect("書けること");
    let env = vec![
        ("AGENTDASHBOARD_CARGO_PRUNE", "0".to_string()),
        ("AGENTDASHBOARD_CARGO_PRUNE_CAP_GB", "999".to_string()),
        (
            "AGENTDASHBOARD_CARGO_PRUNE_INTERVAL_SEC",
            "999999".to_string(),
        ),
    ];
    成功を確かめる(&走らせる(&place, &["--all"], &借りる(&env)));

    assert!(
        place.depsの顔ぶれ().is_empty() && place.incrementalの顔ぶれ().is_empty(),
        "--all なのに残っています"
    );
    assert!(
        place.join("release/bystander").exists(),
        "--all で巻き添えにしています"
    );
    assert!(
        place.記録().contains("--all"),
        "記録に残っていません: {}",
        place.記録()
    );
}

// --- ロック -------------------------------------------------------------------

/// 共有ロックを持つ子を立てる。**走っているビルドの代わり。**
fn 共有ロックを持つ子(place: &偽の置き場所, seconds: u32) -> std::process::Child {
    Command::new("bash")
        .arg("-c")
        .arg(format!("exec 9>\"$1\"; flock --shared 9; sleep {seconds}",))
        .arg("bash")
        .arg(place.join(".prune-lock"))
        .spawn()
        .expect("子を起こせること")
}

#[test]
fn ビルドが走っている間は消さない() {
    let place = 世代の仕掛け("lock");
    let before = place.depsの顔ぶれ();
    let mut child = 共有ロックを持つ子(&place, 30);
    // 子がロックを取るまで待つ（取る前に走らせると、確かめたいことを確かめられない）
    std::thread::sleep(Duration::from_millis(500));

    let env = 段1が走る環境(段1で収まる上限);
    let 始め = SystemTime::now();
    let out = 走らせる(&place, &[], &借りる(&env));
    let かかった = 始め.elapsed().expect("時計が壊れていないこと");

    let _ = child.kill();
    let _ = child.wait();

    成功を確かめる(&out);
    assert_eq!(
        before,
        place.depsの顔ぶれ(),
        "走っているビルドの足元を抜いています"
    );
    // **待たずに諦める。** 待つ実装だと、次の cargo 呼び出しが数十分止まる
    assert!(
        かかった < Duration::from_secs(10),
        "ロックが空くのを待っています（{かかった:?}）"
    );
    assert!(
        place.記録().contains("見送り"),
        "諦めたことが記録に残っていません: {}",
        place.記録()
    );
}

#[test]
fn ロックが空いていれば消える() {
    let place = 世代の仕掛け("lock-free");
    let mut child = 共有ロックを持つ子(&place, 1);
    std::thread::sleep(Duration::from_millis(500));
    let _ = child.wait();

    let env = 段1が走る環境(段1で収まる上限);
    成功を確かめる(&走らせる(&place, &[], &借りる(&env)));
    assert!(
        !place
            .depsの顔ぶれ()
            .contains(&"alpha-aaaaaaaaaaaaaaa1".to_string()),
        "ロックが空いているのに消えていません"
    );
}

#[test]
fn 置き場所が違えばロックも別になる() {
    let 本体 = 世代の仕掛け("lock-a");
    let 修復 = 世代の仕掛け("lock-b");
    let mut child = 共有ロックを持つ子(&本体, 30);
    std::thread::sleep(Duration::from_millis(500));

    let env = 段1が走る環境(段1で収まる上限);
    成功を確かめる(&走らせる(&修復, &[], &借りる(&env)));

    let _ = child.kill();
    let _ = child.wait();

    // **別の置き場所は止められない。** 自己修復の置き場所と本体が競合すると、
    // どちらかが永久に掃除されなくなる
    assert!(
        !修復
            .depsの顔ぶれ()
            .contains(&"alpha-aaaaaaaaaaaaaaa1".to_string()),
        "別の置き場所のロックに巻き込まれています"
    );
}
