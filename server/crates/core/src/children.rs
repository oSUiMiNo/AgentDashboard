//! 自分の子プロセスを数え、畳んで引き取る（ゾンビ設計§5-1・§6-2）。
//!
//! # なぜ持ち主に聞かないのか
//!
//! 版の入れ替えは `exec` で自分を置き換える。**プロセスの中身は全部消えるが、OS の親子
//! 関係は PID が同じなので残る**——`CLOEXEC` で PTY が閉じて死んだ子を引き取る者が、
//! 新しいプロセス画像に1人も居ない。これが実機で78体溜まった原因である。
//!
//! 直し方として「持ち主（セッションの表・パーサの世話役）に畳ませて待つ」を先に考えたが、
//! **採らなかった**。理由は2つある。
//!
//! 1. **持ち主が知らない子が居る。** 実機の計測で、カードとして把握している数を
//!    子の実数が上回る回があった（自己修復のカナリアなど、カードに紐づかない claude）。
//!    聞いて回る形では拾えない
//! 2. **待つ土台が無い。** 子の PID を出す口が無く、終了通知は内部で消費され、待ちスレッドは
//!    切り離されている。全部を作り足すことになる
//!
//! **だから、プロセス自身が自分の子を数えて引き取る。** 起動直後の経路（まだ子が居ない）
//! でも無害で、誰も把握していない子も拾える。
//!
//! # 数える口は1つ
//!
//! 画面・CLI・ログの3つが同じ数を出す必要がある。**規則が2箇所にあると、片方だけ直した
//! ときに答えが食い違う**ので、走査は [`scan`] の1本だけにしてある。

use std::path::Path;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

/// 子1本の姿。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Child {
    pub pid: i32,
    /// 終了したのに引き取られていない（`ps` の `Z`）。
    pub zombie: bool,
    pub comm: String,
}

/// 自分の子を並べる。**読めなければ `None`**（Linux 以外）。
///
/// 「読めない」と「0体」を区別する。潰すと、Linux 以外の機械で「ゾンビは居ません」と
/// 嘘をつくことになる。
pub fn children() -> Option<Vec<Child>> {
    scan(Path::new("/proc"), std::process::id())
}

/// 自分の子のうち、引き取られていないものの数。
pub fn zombie_count() -> Option<usize> {
    Some(children()?.iter().filter(|child| child.zombie).count())
}

/// `/proc` を1周して、親が `parent` のものだけを拾う。
///
/// 読んでいる最中に消える子が居るのは普通なので、**1件読めなくても止めない**。
pub fn scan(root: &Path, parent: u32) -> Option<Vec<Child>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        if let Some(child) = parse_stat(&text, parent) {
            found.push(child);
        }
    }
    Some(found)
}

/// `/proc/<pid>/stat` の1行を読む。親が違えば `None`。
///
/// **`comm` は括弧で囲まれていて、空白も括弧も含みうる**（`(fake claude)` や `(a)b)`）。
/// 先頭から空白で割ると欄がずれるので、**最後の `)` で切ってから**残りを割る。
fn parse_stat(line: &str, parent: u32) -> Option<Child> {
    let open = line.find('(')?;
    let close = line.rfind(')')?;
    if close < open {
        return None;
    }
    let pid: i32 = line[..open].trim().parse().ok()?;
    let comm = line[open + 1..close].to_string();
    let mut rest = line[close + 1..].split_whitespace();
    let state = rest.next()?;
    let ppid: u32 = rest.next()?.parse().ok()?;
    if ppid != parent {
        return None;
    }
    Some(Child {
        pid,
        zombie: state == "Z",
        comm,
    })
}

/// 引き取った結果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reaped {
    /// 終了状態を引き取れた数。
    pub reaped: usize,
    /// 期限までに引き取れなかった子。**数ではなく PID を残す**——突き合わせる側が要る。
    pub left: Vec<i32>,
}

/// 抱えている子を畳んで、終了状態まで引き取る（ゾンビ設計§6-2）。
///
/// **`exec` の直前に呼ぶ。** `exec` すると引き取る手立てが消えるので、その前に片付ける。
///
/// # 期限を切る
///
/// 入れ替えの売りは「落ちないこと」なので、**引き取れなくても先へ進む**
/// （ゾンビ設計§6-3）。返り値の `left` が残っていても、呼び手は止まってはいけない。
///
/// # 穏やかに頼んでから、強く止める
///
/// 先に `SIGTERM` を送るのは、`exec` で PTY が閉じたときと同じ「終わってくれ」に
/// 近づけるため。それで終わらなかったものだけ `SIGKILL` する。
#[cfg(unix)]
pub fn reap(grace: Duration, deadline: Duration) -> Option<Reaped> {
    let alive: Vec<i32> = children()?
        .into_iter()
        .filter(|child| !child.zombie)
        .map(|child| child.pid)
        .collect();

    let mut reaped = 0;
    // 既にゾンビになっている子は、頼むまでもなく引き取れる
    drain(&mut reaped);

    if alive.is_empty() {
        return Some(Reaped {
            reaped,
            left: Vec::new(),
        });
    }

    for pid in &alive {
        signal(*pid, libc::SIGTERM);
    }
    wait_until(Instant::now() + grace, &mut reaped);

    for pid in still_alive(&alive) {
        signal(pid, libc::SIGKILL);
    }
    wait_until(Instant::now() + deadline, &mut reaped);

    Some(Reaped {
        reaped,
        left: still_alive(&alive),
    })
}

/// この OS には引き取る手立てが無い。
#[cfg(not(unix))]
pub fn reap(_grace: Duration, _deadline: Duration) -> Option<Reaped> {
    None
}

/// まだ生きているか、ゾンビとして残っている子。
#[cfg(unix)]
fn still_alive(watched: &[i32]) -> Vec<i32> {
    let Some(now) = children() else {
        return Vec::new();
    };
    watched
        .iter()
        .copied()
        .filter(|pid| now.iter().any(|child| child.pid == *pid))
        .collect()
}

#[cfg(unix)]
fn signal(pid: i32, signal: i32) {
    // 既に終わっている子への合図は空振りするが、それは目的が達成されている姿である
    unsafe { libc::kill(pid, signal) };
}

/// いま引き取れるものを全部引き取る。**子が1本も居なくなったら `true`。**
#[cfg(unix)]
fn drain(reaped: &mut usize) -> bool {
    loop {
        let mut status = 0;
        // SAFETY: 渡すのは自分のスタック上の1つの int だけで、他は値渡しである
        let done = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        match done {
            // 引き取れた。続けて次を見る
            found if found > 0 => *reaped += 1,
            // 子は居るが、まだ終わっていない
            0 => return false,
            // 子が1本も居ない
            _ => return true,
        }
    }
}

/// 期限まで、少しずつ引き取り続ける。
#[cfg(unix)]
fn wait_until(deadline: Instant, reaped: &mut usize) {
    /// 様子を見に行く間隔。細かくしても待ち時間は縮まらない（相手の終わり方で決まる）。
    const POLL: Duration = Duration::from_millis(20);
    loop {
        if drain(reaped) {
            return;
        }
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `/proc/<pid>/stat` を模した1行を作る。
    fn stat(pid: i32, comm: &str, state: &str, ppid: u32) -> String {
        format!("{pid} ({comm}) {state} {ppid} 1 1 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 3 0 47757")
    }

    fn 偽のproc(entries: &[(&str, String)]) -> tempdir::Fake {
        tempdir::build(entries)
    }

    #[test]
    fn 自分の子だけを拾う() {
        let root = 偽のproc(&[
            ("11", stat(11, "claude", "Z", 597)),
            ("12", stat(12, "claude", "S", 42)),
            ("13", stat(13, "transcript-parser", "Z", 597)),
        ]);
        let mut found = scan(root.path(), 597).expect("読めること");
        found.sort_by_key(|child| child.pid);
        assert_eq!(
            found.iter().map(|child| child.pid).collect::<Vec<_>>(),
            vec![11, 13],
            "親が違う子を数えていない"
        );
    }

    #[test]
    fn ゾンビだけを数える() {
        // **`stat` の状態欄は1文字。** `ps` が見せる `Zs` の `s`（セッションリーダー）は
        // 別の欄から作られた飾りで、ここには現れない
        let root = 偽のproc(&[
            ("11", stat(11, "claude", "Z", 597)),
            ("12", stat(12, "claude", "S", 597)),
            ("13", stat(13, "claude", "R", 597)),
            ("14", stat(14, "transcript-parser", "Z", 597)),
        ]);
        let found = scan(root.path(), 597).expect("読めること");
        assert_eq!(found.len(), 4, "生きている子も並ぶ");
        assert_eq!(
            found.iter().filter(|child| child.zombie).count(),
            2,
            "引き取られていないものだけを数える"
        );
    }

    #[test]
    fn 名前に空白や括弧が入っていても欄がずれない() {
        let child = parse_stat(&stat(11, "fake claude", "Z", 597), 597).expect("読めること");
        assert_eq!(child.comm, "fake claude");
        assert!(child.zombie, "空白入りの名前でも状態を読める");

        let child = parse_stat(&stat(12, "a) b", "S", 597), 597).expect("読めること");
        assert_eq!(child.comm, "a) b", "**最後の** `)` で切っている");
        assert!(!child.zombie);
    }

    #[test]
    fn 数字でない入れ物は見ない() {
        let root = 偽のproc(&[
            ("self", stat(11, "claude", "Z", 597)),
            ("meminfo", stat(12, "claude", "Z", 597)),
            ("13", stat(13, "claude", "Z", 597)),
        ]);
        let found = scan(root.path(), 597).expect("読めること");
        assert_eq!(found.len(), 1, "`/proc` にはプロセス以外も並んでいる");
    }

    #[test]
    fn 読めない機械は0体ではなく分からないと言う() {
        let missing = Path::new("/この名前の入れ物は無い/proc");
        assert_eq!(
            scan(missing, 1),
            None,
            "`Some(vec![])`（0体）と取り違えると、Linux 以外で嘘をつく"
        );
    }

    #[test]
    fn 壊れた行は飛ばして残りを数える() {
        let root = 偽のproc(&[
            ("11", "括弧が無い行".to_string()),
            ("12", stat(12, "claude", "Z", 597)),
        ]);
        let found = scan(root.path(), 597).expect("読めること");
        assert_eq!(found.len(), 1, "1件読めなくても止めない");
    }

    /// **前から溜まっていたゾンビも引き取る**（ゾンビ設計§6-2）。
    ///
    /// これが成り立たないと、実機に既に溜まっている78体は永久に残る。`waitpid(-1)` は
    /// 「いま引き取れる子」を見境なく拾うので、**自分が殺した子だけを拾うのではない**
    /// ——そこが要点である。
    ///
    /// **`nextest` はテストごとにプロセスを分ける**ので、`waitpid(-1)` が他のテストの子を
    /// 拾う心配は無い。
    #[cfg(unix)]
    #[test]
    fn 前から溜まっていたゾンビも引き取る() {
        if children().is_none() {
            // Linux 以外
            return;
        }

        // 引き取られていない子を2本作る。**`wait` しないまま終わらせる**のが要点
        let mut 置き去り = Vec::new();
        for _ in 0..2 {
            let child = std::process::Command::new("true")
                .spawn()
                .expect("起こせること");
            置き去り.push(child.id());
        }
        // 終わってゾンビになるまで待つ（`wait` は呼ばない）
        let 期限 = Instant::now() + Duration::from_secs(5);
        while 置き去り.iter().any(|pid| {
            !children()
                .unwrap_or_default()
                .iter()
                .any(|c| c.pid as u32 == *pid && c.zombie)
        }) {
            assert!(Instant::now() < 期限, "ゾンビになるのを待てなかった");
            std::thread::sleep(Duration::from_millis(20));
        }

        let 引き取る前 = children().expect("読めること");
        assert_eq!(
            引き取る前.iter().filter(|c| c.zombie).count(),
            2,
            "溜まった状態を作れていること"
        );

        // **生きた子は1本も無い状態で呼ぶ。** 実機で押したときと同じ形
        let result =
            reap(Duration::from_millis(100), Duration::from_secs(2)).expect("引き取れること");

        assert_eq!(result.reaped, 2, "溜まっていた2本を引き取ったこと");
        assert!(
            result.left.is_empty(),
            "取り残しが無いこと: {:?}",
            result.left
        );
        assert_eq!(
            children()
                .expect("読めること")
                .iter()
                .filter(|c| c.zombie)
                .count(),
            0,
            "プロセス表からも消えたこと"
        );
    }

    /// 偽の `/proc` を組み立てる小道具。
    mod tempdir {
        use std::path::{Path, PathBuf};

        pub struct Fake(PathBuf);

        impl Fake {
            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Fake {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        pub fn build(entries: &[(&str, String)]) -> Fake {
            let root = std::env::temp_dir().join(format!(
                "agentdashboard-children-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            for (name, text) in entries {
                let dir = root.join(name);
                std::fs::create_dir_all(&dir).expect("偽の入れ物を作れること");
                std::fs::write(dir.join("stat"), text).expect("偽の stat を書けること");
            }
            Fake(root)
        }
    }
}
