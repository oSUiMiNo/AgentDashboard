//! ローカルモードでフォルダとファイルが取れること（テスト計画 フェーズ3「往復の成立」）。
//!
//! # なぜ `session-host-core` の単体テストだけでは足りないのか
//!
//! あちらが確かめているのは**読み方の決まり**（並び・上限・断り方）で、ここが確かめるのは
//! **境界を通ること**である。`SessionHost` は「サーバ側から見た PC 側」の口で、
//! ローカルモードではその実装が同じプロセスの中を向く（設計§5・§19）。
//!
//! ここが通らないと、サーバ側で「ローカルなら自分で読む」という近道を書きたくなる——
//! それをやると「ローカルでは動くのにセルフホストで欠ける」という、経路の違いが原因で
//! テストを増やしても見つからない壊れ方が残る。

#![allow(non_snake_case)]

use agentdashboard_core::local::LocalSessionHost;
use server_core::session_host::{HostFsRequest, SessionHost};
use session_host_core::{config::SessionHostConfig, session::SessionManager};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 使い捨ての作業場所。
struct Sandbox(PathBuf);

impl Sandbox {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("agentdashboard-local-fs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("作業場所を作れること");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// PTY を1つも起こさずに口だけ作る。**このテストはセッションを必要としない。**
fn host() -> LocalSessionHost {
    let config = SessionHostConfig::default();
    LocalSessionHost::new(SessionManager::new(Arc::new(config)))
}

fn ask<'a>(path: &'a str) -> HostFsRequest<'a> {
    HostFsRequest {
        account_id: uuid::Uuid::new_v4(),
        // ローカルモードには PC という単位が無い（設計§19）
        target: None,
        path,
    }
}

#[tokio::test]
async fn ローカルモードでも境界を通って一覧と中身が取れる() {
    let sandbox = Sandbox::new();
    std::fs::create_dir_all(sandbox.path().join("src")).expect("フォルダを作れること");
    let body = "# 計画\n- [x] 済み\n";
    std::fs::write(sandbox.path().join("計画.md"), body).expect("ファイルを作れること");

    let host = host();

    // ① 一覧
    let listing = host
        .list_dir(ask(&sandbox.path().display().to_string()))
        .await
        .expect("一覧が取れること");
    let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["src", "計画.md"],
        "ディレクトリが先で返ること（読み方の決まりが境界の向こうから届いている）"
    );

    // ② 中身
    let content = host
        .read_file(ask(&sandbox.path().join("計画.md").display().to_string()))
        .await
        .expect("中身が取れること");
    assert_eq!(content.text, body);
    assert_eq!(content.bytes, body.len() as u64);
}

#[tokio::test]
async fn 読めないときは理由が説明として返る() {
    let host = host();

    let err = host
        .list_dir(ask("/居ないフォルダ/居ない"))
        .await
        .expect_err("断ること");

    // 境界の戻り値は `String`（設計§5）。**人が読む説明だけを運ぶ**と決めてあるので、
    // 理由の列挙はここまで来ない。代わりに、何を開けなかったのかが文に残っていること
    assert!(
        err.contains("居ないフォルダ"),
        "何を開けなかったのかが説明に残ること（{err}）"
    );
}
