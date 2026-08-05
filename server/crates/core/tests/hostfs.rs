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
        path: Some(path),
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

    // **ローカルが作るのは `Failed` だけ。** 線を跨がないので、届かなかったことを表す
    // 残りの理由（宛先不明・時間切れ・連絡係の断）は起こりえない（設計§19）
    assert!(
        matches!(
            err,
            server_core::session_host::HostFsError::Failed {
                reason: protocol::a2s::HostFailure::NotFound,
                ..
            }
        ),
        "読めない理由がそのまま写ること（{err:?}）"
    );
    assert!(
        err.message().contains("居ないフォルダ"),
        "何を開けなかったのかが説明に残ること（{}）",
        err.message()
    );
}

#[tokio::test]
async fn ローカルモードで宛先を指名されたら断る() {
    // ローカルには PC という単位が無い（設計§19）。黙って無視すると
    // `/api/hosts/<でたらめ>/dir` が手元のファイルを返し、**口の意味が構成で変わる**
    let sandbox = Sandbox::new();
    let host = host();

    let err = host
        .list_dir(HostFsRequest {
            account_id: uuid::Uuid::new_v4(),
            target: Some(protocol::AgentId(uuid::Uuid::new_v4())),
            path: Some(&sandbox.path().display().to_string()),
        })
        .await
        .expect_err("断ること");

    // 知らない PC と同じ言葉。綴りを変えて探る余地を残さない
    assert_eq!(err, server_core::session_host::HostFsError::UnknownHost);
}

/// `path` を省略すると、その PC の**ホームへ着く**（設計§26-2）。
///
/// 設計§13 は始まりの場所の1つをホームと決めているが、当初の「能力の名乗りで運ぶ」道は
/// **ローカルモードでは成立しない**（あちらは PC の一覧そのものを持たない）。省略できる
/// 形にしてあるので、ここが通ることがローカル側の担保になる。
///
/// 着いた先は応答の `path` に載る——**画面はここを見てパンくずを組み立てる**ので、
/// 空だと現在地を出せない。
#[tokio::test]
async fn 一覧はパスを省略するとホームから始まる() {
    let listing = host()
        .list_dir(HostFsRequest {
            account_id: uuid::Uuid::new_v4(),
            target: None,
            path: None,
        })
        .await
        .expect("ホームを引けること");

    assert_eq!(
        listing.path,
        session_host_core::hostfs::home().display().to_string(),
        "省略したのにホーム以外へ着いた"
    );
    assert!(!listing.path.is_empty(), "着いた先が応答に載っていない");
}

/// 中身の読み取りに「始まり」は無い（設計§26-2）。
///
/// 口が `path` を必須にしているので通常は起きないが、**型がその状態を許す**以上、
/// 落ちずに断ることを固定しておく。
#[tokio::test]
async fn 中身の読み取りはパスの省略を断る() {
    let err = host()
        .read_file(HostFsRequest {
            account_id: uuid::Uuid::new_v4(),
            target: None,
            path: None,
        })
        .await
        .expect_err("断ること");

    assert!(
        err.message().contains("指定されていません"),
        "理由が伝わらない: {}",
        err.message()
    );
}
