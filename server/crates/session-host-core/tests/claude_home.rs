//! 履歴の走査（名前付け設計§8-4）。
//!
//! **擬似 claude を使わない。** 走査が見るのはファイルの実在だけなので、置くだけで足りる。
//!
//! # `HOME` ではなく専用の環境変数を差し替える
//!
//! 走査元は `AGENTDASHBOARD_CLAUDE_HOME`（設計§13-1）。`HOME` を差し替える形にすると、
//! **E2E で別プロセスのサーバを起こしたときに届かない**。ここで同じ口を使っておくのは、
//! 単体と通しで違う道を通らせないため。
//!
//! 環境変数はプロセスに効くが、**nextest はテストごとにプロセスを分ける**ので混ざらない
//! （`version_fetch.rs` と同じ前提）。

#![allow(non_snake_case)]

use protocol::ClaudeSessionId;
use session_host_core::claude_home;
use std::path::PathBuf;

/// テスト専用の一時フォルダ。**依存は増やさない**——既存のテストと同じく
/// `std::env::temp_dir()` から作る（`version_fetch.rs` の流儀）。
///
/// 落ちても残るが、プロセスIDと呼び名で分けてあるので混ざらない。
fn 一時フォルダ(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-claude-home-{label}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("一時フォルダを作れること");
    dir
}

/// 偽のホームを作り、指定した「プロジェクトフォルダ／セッションID」で履歴を置く。
fn 偽のホーム(label: &str, 履歴: &[(&str, ClaudeSessionId)]) -> PathBuf {
    let home = 一時フォルダ(label);
    for (project, id) in 履歴 {
        let dir = home.join(".claude").join("projects").join(project);
        std::fs::create_dir_all(&dir).expect("フォルダを作れること");
        std::fs::write(dir.join(format!("{id}.jsonl")), "{}\n").expect("置けること");
    }
    unsafe { std::env::set_var(claude_home::CLAUDE_HOME_ENV, &home) };
    home
}

#[test]
fn 実在するidだけが返る() {
    let 在る1 = ClaudeSessionId::new();
    let 在る2 = ClaudeSessionId::new();
    let 消えた = ClaudeSessionId::new();
    // **別々のフォルダに散らばっていても見つかる。** これが「フォルダ名の規則を
    // 実装しない」ことの担保でもある——規則を書くと、片方のフォルダは引けなくなる
    let _home = 偽のホーム(
        "scatter",
        &[("-home-me-app", 在る1), ("-home-me--claude-hooks", 在る2)],
    );

    let found = claude_home::existing_sessions(&[在る1, 消えた, 在る2]);

    assert!(found.contains(&在る1), "1つ目が見つからない");
    assert!(found.contains(&在る2), "別のフォルダのものが見つからない");
    assert!(
        !found.contains(&消えた),
        "実在しないものが「在る」と返っている"
    );
    assert_eq!(found.len(), 2, "余計なものが混ざっている");
}

#[test]
fn プロジェクトのパスからフォルダ名を組み立てていない() {
    // **規則を書くと、CLI がフォルダ名の作り方を変えた瞬間に黙って壊れる**
    // （設計§8-4）。しかも壊れ方がいちばん悪い——「実在するのに消えたと判定する」。
    //
    // 規則を持っていないことを、**規則では絶対に当たらないフォルダ名**で示す。
    // パスから作った名前と一致しないのに見つかるなら、走査しているということ。
    let id = ClaudeSessionId::new();
    let _home = 偽のホーム("no-rule", &[("まったく関係のない名前-12345", id)]);

    assert_eq!(
        claude_home::existing_sessions(&[id]),
        vec![id],
        "フォルダ名の規則に頼っている（総なめしていない）"
    );
}

#[test]
fn フォルダが1つも無くても落ちない() {
    // claude を一度も起こしていない機械。**空を返すのであって、落ちるのではない**
    let home = 一時フォルダ("empty");
    unsafe { std::env::set_var(claude_home::CLAUDE_HOME_ENV, &home) };

    assert!(claude_home::existing_sessions(&[ClaudeSessionId::new()]).is_empty());
}

#[test]
fn 読めないフォルダが混ざっても残りを見る() {
    // 「読めなかった」を「無い」と混同しない。**そこで止まらずに残りを見る**
    let 在る = ClaudeSessionId::new();
    let home = 偽のホーム("unreadable", &[("-home-me-app", 在る)]);

    let 読めない = home
        .join(".claude")
        .join("projects")
        .join("-home-me-secret");
    std::fs::create_dir_all(&読めない).expect("作れること");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&読めない, std::fs::Permissions::from_mode(0o000))
            .expect("権限を落とせること");
    }

    let found = claude_home::existing_sessions(&[在る]);

    // 後片付け（落ちても一時フォルダを消せるように戻す）
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&読めない, std::fs::Permissions::from_mode(0o755));
    }

    assert_eq!(found, vec![在る], "読めないフォルダで走査が止まっている");
}

#[test]
fn 何も聞かれなければ走査しない() {
    // 一覧が空のときに 1,119 フォルダを舐めない
    let _home = 偽のホーム("nothing", &[]);
    assert!(claude_home::existing_sessions(&[]).is_empty());
}
