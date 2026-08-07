//! パーサの stdout が IPC 専用のままであることと、stderr の行に pid が付くこと
//! （ログ設計§8-3・テスト計画フェーズ3）。
//!
//! # なぜ実バイナリを起こすのか
//!
//! `eprintln!` そのものは単体テストからは捕まえられない。前置を組む純関数
//! （`format_note`）は `transcript-parser` 側の単体テストで固定してあるが、
//! **それが実際に stderr へ流れ、stdout を汚していない**ことは、起こしてみないと
//! 言えない。
//!
//! stdout が汚れると「繋がっているのに何も届かない」という追いにくい沈黙になる。
//! しかも `transcript-parser` は**丸ごと自己修復の書き換え範囲**にあるので、
//! ここは機械で押さえておく価値がある。

use std::io::Write as _;
use std::process::{Command, Stdio};

#[test]
fn 解釈できない指示はstderrへpid付きで出てstdoutは汚れない() {
    let mut child = Command::new(testkit::binary_path("transcript-parser"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("パーサを起こせること");

    {
        let stdin = child.stdin.as_mut().expect("stdin を掴めること");
        // 知らない指示。**落ちずに受け流し、stderr へ1行残す**のが約束
        writeln!(stdin, "これは JSON ではない").expect("書けること");
    }
    // stdin を閉じるとパーサは自分で終わる
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("終わること");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // **stdout に IPC 以外の行が1行も混ざらない。** 混ざると core の行パースが壊れる
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        serde_json::from_str::<serde_json::Value>(line).unwrap_or_else(|err| {
            panic!("stdout に IPC でない行が混ざっています（{err}）: {line}\n---\n{stdout}")
        });
    }

    // stderr の行は `[<pid>] ` で始まる。親（parser.rs）がここを剥がして
    // `parser_pid` の欄へ移す
    let noted: Vec<&str> = stderr
        .lines()
        .filter(|line| line.contains("解釈できない指示"))
        .collect();
    assert_eq!(noted.len(), 1, "受け流した記録が1行だけ出ること:\n{stderr}");
    let line = noted[0];
    let pid = line
        .strip_prefix('[')
        .and_then(|rest| rest.split_once("] "))
        .map(|(pid, _)| pid);
    let pid = pid.unwrap_or_else(|| panic!("先頭に [<pid>] が付いていません: {line}"));
    assert!(
        pid.parse::<u32>().is_ok(),
        "pid が数字ではありません: {line}"
    );
}
