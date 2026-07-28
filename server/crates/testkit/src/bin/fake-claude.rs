//! PTY テスト用の擬似 claude。
//!
//! 本物の CLI を起動せずに PTY のライフサイクル（起動 → 出力読み取り → 入力書き込み →
//! 正常/異常終了 → EOF）を検証するためのハーネス。テスト計画フェーズ1 は「スクリプト」と
//! 書いているが、Rust バイナリにしているのは、cargo テストがコンテナ内で走るこの環境に
//! Python 等のインタプリタ依存を持ち込まないため。
//!
//! 使い方:
//!   fake-claude                    対話モード。1行受け取るごとに応答を返す
//!   fake-claude --exit-code <N>    何もせず終了コード N で終了する（異常終了の検証用）
//!   fake-claude --echo-only        受け取った行をそのまま返す（余計な装飾なし）

use std::io::{BufRead as _, Write as _};

/// 起動完了を示すマーカー。テスト側はこれを待ってから入力を送る。
const READY_MARKER: &str = "[fake-claude] ready";
/// 1行処理したことを示すマーカー。
const RECEIVED_PREFIX: &str = "[fake-claude] received: ";

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
            let _ = writeln!(out, "[fake-claude] bye");
            let _ = out.flush();
            break;
        }

        if echo_only {
            let _ = writeln!(out, "{line}");
        } else {
            let _ = writeln!(out, "{RECEIVED_PREFIX}{line}");
        }
        let _ = out.flush();
    }
}
