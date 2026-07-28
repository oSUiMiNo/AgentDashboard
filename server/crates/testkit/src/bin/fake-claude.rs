//! PTY テスト用の擬似 claude。
//!
//! 本物の CLI を起動せずに PTY のライフサイクル（起動 → 出力読み取り → 入力書き込み →
//! 正常/異常終了 → EOF）と、フック経由の状態通知（設計§5/§7）を検証するためのハーネス。
//! テスト計画フェーズ1 は「スクリプト」と書いているが、Rust バイナリにしているのは、
//! cargo テストがコンテナ内で走るこの環境に Python 等のインタプリタ依存を持ち込まないため。
//!
//! 起動オプション:
//!   fake-claude                    対話モード。1行受け取るごとに応答を返す
//!   fake-claude --exit-code <N>    何もせず終了コード N で終了する（異常終了の検証用）
//!   fake-claude --echo-only        受け取った行をそのまま返す（余計な装飾なし）
//!   （本物と同じく `--session-id <UUID>` と `--settings <PATH>` を付けて起動される。
//!     知らないオプションは黙って無視する）
//!
//! 対話モードで受け付ける命令:
//!   dump          自分の起動引数と環境変数を1行ずつ書き出す
//!   flood <N>     N バイトをまとめて吐き出す（フロー制御と大量出力の検証用）
//!   hook <名前> [JSON]  注入された settings のフックを実際に起動する
//!   jsonl <元ファイル> [行数]  フックが運ぶトランスクリプトへ JSONL を追記する
//!   crash <N>     終了コード N で自ら異常終了する
//!   exit          終了する
//!   その他        受け取った行を返す

use std::io::{BufRead as _, Write};
use std::process::{Command, Stdio};
use testkit::fake_claude::{
    ARGV_PREFIX, BYE_MARKER, CRASH_MARKER, DUMP_END_MARKER, ENV_PREFIX, FLOOD_END_MARKER,
    FLOOD_PATTERN, HOOK_FAILED_PREFIX, HOOK_SENT_PREFIX, JSONL_APPENDED_PREFIX,
    JSONL_FAILED_PREFIX, READY_MARKER, RECEIVED_PREFIX,
};

/// 起動時に受け取った、フック実行に必要な情報。
struct Injected {
    session_id: String,
    /// `--transcript` で渡された書き出し先。フックが運ぶ値もこれになる
    transcript: Option<String>,
    settings: Option<serde_json::Value>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let mut echo_only = false;
    let mut session_id = String::new();
    let mut settings_path: Option<String> = None;
    let mut transcript_path: Option<String> = None;
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
            // 本物と同じく、ダッシュボードが採番したIDを受け取る
            "--session-id" => {
                session_id = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            // 本物と同じく、追加で読み込む設定ファイルを受け取る（設計§7）
            "--settings" => {
                settings_path = args.get(index + 1).cloned();
                index += 2;
            }
            // 本物には無い。フックが運ぶ transcript_path を実在するパスにして、
            // `jsonl` 命令で中身を書けるようにするためのテスト用の入口
            "--transcript" => {
                transcript_path = args.get(index + 1).cloned();
                index += 2;
            }
            _ => index += 1,
        }
    }

    let injected = Injected {
        session_id,
        transcript: transcript_path,
        settings: settings_path
            .as_deref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str(&text).ok()),
    };

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

        if let Some(rest) = line.strip_prefix("hook ") {
            hook(&mut out, &injected, rest.trim());
            continue;
        }

        if let Some(rest) = line.strip_prefix("jsonl ") {
            append_jsonl(&mut out, &injected, rest.trim());
            continue;
        }

        if let Some(code) = line.strip_prefix("crash ") {
            let _ = writeln!(out, "{CRASH_MARKER}");
            let _ = out.flush();
            std::process::exit(code.trim().parse::<i32>().unwrap_or(1));
        }

        if echo_only {
            let _ = writeln!(out, "{line}");
        } else {
            let _ = writeln!(out, "{RECEIVED_PREFIX}{line}");
        }
        let _ = out.flush();
    }
}

/// トランスクリプトへ JSONL を追記する（`jsonl <元ファイル> [行数]`）。
///
/// 本物の claude が書くものをテストから再現するための入口。行数を指定できるのは、
/// **書きかけの状態**を作れるようにするため。増分読み取りと末尾追従は「途中まで
/// 書かれている」状況でこそ検証の値がある。
///
/// 書き出し先はフックが運ぶ `transcript_path` と同じ場所（[`transcript_path`]）。
fn append_jsonl(out: &mut impl Write, injected: &Injected, argument: &str) {
    let mut parts = argument.splitn(2, char::is_whitespace);
    let source = parts.next().unwrap_or_default();
    let take = parts
        .next()
        .and_then(|value| value.trim().parse::<usize>().ok());

    // 書き出し先は、フックが運ぶ値と必ず同じにする。ずれると「フックは届くのに
    // 履歴が出ない」という追いにくい状態になる
    let target = transcript_path(injected);
    let target = target.as_str();
    let Ok(text) = std::fs::read_to_string(source) else {
        let _ = writeln!(out, "{JSONL_FAILED_PREFIX}元ファイルを読めません: {source}");
        let _ = out.flush();
        return;
    };

    // 既に書いた行数を数え、その続きから追記する。同じ行を二度書かない
    let written = std::fs::read_to_string(target)
        .map(|current| current.lines().count())
        .unwrap_or(0);
    let lines: Vec<&str> = text.lines().skip(written).collect();
    let lines = match take {
        Some(count) => &lines[..count.min(lines.len())],
        None => &lines[..],
    };

    if let Some(parent) = std::path::Path::new(target).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(target);
    let Ok(mut file) = file else {
        let _ = writeln!(out, "{JSONL_FAILED_PREFIX}書き込めません: {target}");
        let _ = out.flush();
        return;
    };
    for line in lines {
        let _ = writeln!(file, "{line}");
    }
    let _ = file.flush();

    // サブエージェントのファイル群も一緒に置く。本物は `<セッションID>/subagents/` に
    // 別ファイルで書くので、本体だけ写しても子ツリーがマウントされない
    copy_session_dir(source, target);

    let _ = writeln!(out, "{JSONL_APPENDED_PREFIX}{}", lines.len());
    let _ = out.flush();
}

/// `<元>.jsonl` の隣にある `<元>/` を、`<先>.jsonl` の隣へ写す。
fn copy_session_dir(source: &str, target: &str) {
    let source = std::path::Path::new(source);
    let target = std::path::Path::new(target);
    let (Some(from), Some(to)) = (sibling_dir(source), sibling_dir(target)) else {
        return;
    };
    if !from.is_dir() || to.exists() {
        return;
    }
    copy_tree(&from, &to);
}

fn sibling_dir(path: &std::path::Path) -> Option<std::path::PathBuf> {
    Some(path.parent()?.join(path.file_stem()?))
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
    if std::fs::create_dir_all(to).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(from) else {
        return;
    };
    for entry in entries.flatten() {
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_tree(&source, &target);
        } else {
            let _ = std::fs::copy(&source, &target);
        }
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

/// 注入された settings に書かれたフックコマンドを、本物と同じ形で起動する。
///
/// 本物の Claude Code は `"async": true` を見て非同期に走らせるが、こちらは**同期実行**に
/// してある。テストは「フックが届き終わってから状態を確かめたい」ので、待てる方がよい。
///
/// 引数は `hook <イベント名> [payload に混ぜる JSON]`。
fn hook(out: &mut impl Write, injected: &Injected, rest: &str) {
    let (event, extra) = match rest.split_once(' ') {
        Some((event, extra)) => (event, extra.trim()),
        None => (rest, ""),
    };

    let Some(settings) = injected.settings.as_ref() else {
        let _ = writeln!(out, "{HOOK_FAILED_PREFIX}{event} (settings が読めていない)");
        let _ = out.flush();
        return;
    };
    let Some(command) = settings["hooks"][event][0]["hooks"][0]["command"].as_str() else {
        let _ = writeln!(out, "{HOOK_FAILED_PREFIX}{event} (コマンドが見つからない)");
        let _ = out.flush();
        return;
    };

    let payload = build_payload(injected, event, extra);
    match run_hook(command, &payload) {
        Ok(stdout) => {
            // 観測専用のフックは stdout に何も出さないのが正しい（設計§7）。
            // 何か出ていたら、それは Claude へ注入されてしまう内容なので必ず表に出す
            if stdout.is_empty() {
                let _ = writeln!(out, "{HOOK_SENT_PREFIX}{event}");
            } else {
                let _ = writeln!(
                    out,
                    "{HOOK_FAILED_PREFIX}{event} (stdout に出力があった: {stdout:?})"
                );
            }
        }
        Err(err) => {
            let _ = writeln!(out, "{HOOK_FAILED_PREFIX}{event} ({err})");
        }
    }
    let _ = out.flush();
}

/// フックへ渡す JSON を組み立てる。
///
/// 本物が必ず載せてくる `session_id` / `transcript_path` / `hook_event_name` を入れ、
/// テストが指定した追加フィールド（`notification_type` など）を混ぜる。
fn build_payload(injected: &Injected, event: &str, extra: &str) -> String {
    let mut payload = serde_json::json!({
        "session_id": injected.session_id,
        "transcript_path": transcript_path(injected),
        "hook_event_name": event,
    });

    if !extra.is_empty()
        && let Ok(serde_json::Value::Object(fields)) = serde_json::from_str(extra)
        && let Some(target) = payload.as_object_mut()
    {
        for (key, value) in fields {
            target.insert(key, value);
        }
    }
    payload.to_string()
}

/// フックが運ぶトランスクリプトの場所。
///
/// `--transcript` を渡されていればそれを使う（`jsonl` 命令で中身を書ける）。
/// 渡されていなければ本物に似せた、存在しなくてよいパスを返す。**存在しないことは
/// 異常ではない**（JSONL は結果整合のチャネルで、フックより遅れて現れる）。
fn transcript_path(injected: &Injected) -> String {
    if let Some(path) = &injected.transcript {
        return path.clone();
    }
    std::env::temp_dir()
        .join("fake-claude")
        .join(format!("{}.jsonl", injected.session_id))
        .to_string_lossy()
        .into_owned()
}

fn run_hook(command: &str, payload: &str) -> Result<String, String> {
    // フックはシェル経由で起動される。引用符付きのコマンド行をそのまま渡せる形にする
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("起動できない: {err}"))?;

    child
        .stdin
        .take()
        .ok_or_else(|| "stdin を掴めない".to_string())?
        .write_all(payload.as_bytes())
        .map_err(|err| format!("payload を渡せない: {err}"))?;

    let output = child
        .wait_with_output()
        .map_err(|err| format!("終了を待てない: {err}"))?;
    if !output.status.success() {
        // 失敗しても終了コード 0 で終わるのが hook-post の約束（設計§7）
        return Err(format!("終了コードが 0 でない: {}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
