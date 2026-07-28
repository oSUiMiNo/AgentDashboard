//! PTY テスト用の擬似 claude。
//!
//! 本物の CLI を起動せずに PTY のライフサイクル（起動 → 出力読み取り → 入力書き込み →
//! 正常/異常終了 → EOF）を検証するためのハーネス。テスト計画フェーズ1 は「スクリプト」と
//! 書いているが、Rust バイナリにしているのは、cargo テストがコンテナ内で走るこの環境に
//! Python 等のインタプリタ依存を持ち込まないため。
//!
//! 起動オプション:
//!   fake-claude                    対話モード。1行受け取るごとに応答を返す
//!   fake-claude --exit-code <N>    何もせず終了コード N で終了する（異常終了の検証用）
//!   fake-claude --echo-only        受け取った行をそのまま返す（余計な装飾なし）
//!   （知らないオプションは黙って無視する。本物と同じく `--session-id <UUID>` が付いた
//!     状態で起動されるため）
//!
//! 対話モードで受け付ける命令:
//!   dump          自分の起動引数と環境変数を1行ずつ書き出す
//!   flood <N>     N バイトをまとめて吐き出す（フロー制御と大量出力の検証用）
//!   exit          終了する
//!   その他        受け取った行を返す

use std::io::{BufRead as _, Write};
use testkit::fake_claude::{
    ARGV_PREFIX, BYE_MARKER, DUMP_END_MARKER, ENV_PREFIX, FLOOD_END_MARKER, FLOOD_PATTERN,
    READY_MARKER, RECEIVED_PREFIX,
};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let mut echo_only = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--exit-code" => {
                let code = args
                    .get(index + 1)
                    .and_then(|value| value.parse::<i32>().ok())
                    .unwrap_or(1);
                std::process::exit(code);
            }
            "--echo-only" => {
                echo_only = true;
                index += 1;
            }
            _ => index += 1,
        }
    }

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{READY_MARKER}");
    let _ = out.flush();

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim_end_matches('\r');

        if line == "exit" {
            let _ = writeln!(out, "{BYE_MARKER}");
            let _ = out.flush();
            break;
        }

        if line == "dump" {
            dump(&mut out);
            continue;
        }

        if let Some(size) = line.strip_prefix("flood ") {
            flood(&mut out, size.trim().parse::<usize>().unwrap_or(0));
            continue;
        }

        if echo_only {
            let _ = writeln!(out, "{line}");
        } else {
            let _ = writeln!(out, "{RECEIVED_PREFIX}{line}");
        }
        let _ = out.flush();
    }
}

/// 自分がどんな引数と環境で起動されたかを報告する。
///
/// 環境変数のサニタイズ（設計§6）と `--session-id` の受け渡しを、**実際に起動された
/// 子プロセスの側から**確認するために使う。親側で組み立てた値を見るだけだと、
/// 途中で環境が混ざる経路を見落とす。
fn dump(out: &mut impl Write) {
    for arg in std::env::args() {
        let _ = writeln!(out, "{ARGV_PREFIX}{arg}");
    }
    for (name, value) in std::env::vars() {
        let _ = writeln!(out, "{ENV_PREFIX}{name}={value}");
    }
    let _ = writeln!(out, "{DUMP_END_MARKER}");
    let _ = out.flush();
}

/// 指定バイト数をまとめて吐く。フロー制御と大量出力の検証用。
fn flood(out: &mut impl Write, size: usize) {
    let mut written = 0;
    while written < size {
        let remaining = size - written;
        let chunk = &FLOOD_PATTERN[..FLOOD_PATTERN.len().min(remaining)];
        if out.write_all(chunk).is_err() {
            return;
        }
        written += chunk.len();
    }
    let _ = writeln!(out, "\n{FLOOD_END_MARKER}");
    let _ = out.flush();
}
