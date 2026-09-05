//! 枝分かれの段取り（ブランチ設計§3・§4。テスト計画フェーズ3）。
//!
//! **実際に待ち受けるサーバを起こし、ブラウザと同じ口を叩く。** 段取り役だけを
//! 単体で呼んでも、「受け口 → 段取り → 記録 → 配信」という継ぎ目は確かめられない。
//! 相手は擬似 claude なので課金しない。
//!
//! # ここで確かめる形
//!
//! ```text
//! 押す → /branch が飛ぶ → 席の CLI 側IDが張り替わる（＝枝）
//!      → 元の会話が別の席へ呼び戻る → 枝が元の左隣へ並ぶ
//! ```
//!
//! **通しの1本では競合が出ない**ので、断る側（§3-4・§4-1）は行ごとに1本ずつ当てる。

// テスト名は日本語で書く。ID などの英大文字が snake_case 判定に引っかかるだけで
// 実害はないため、このファイルに限って許可する（`cli_ops.rs` と同じ扱い）
#![allow(non_snake_case)]

mod common;

use std::path::PathBuf;
use std::time::Duration;

use agentdashboard_core::client::{self, ws::Ws};
use common::TestServer;
use protocol::{CardId, ClaudeSessionId, SessionMeta, SessionStatus, ws::ClientMessage};

/// 記録からそのカードを引く。
fn 引く(server: &TestServer, card: &str) -> SessionMeta {
    server
        .registry
        .list(server_core::db::LOCAL_ACCOUNT_ID)
        .into_iter()
        .find(|meta| meta.card_id.to_string() == card)
        .expect("カードが記録に居ること")
}

/// 一時の作業ディレクトリ（セッションの cwd に使う）。
fn work_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-branch-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("作業ディレクトリを作れること");
    dir
}

fn target_of(server: &TestServer) -> client::Target {
    client::Target::from_url(&format!("http://{}", server.addr)).expect("接続先を読めること")
}

/// 枝分かれを頼める状態のカードを1枚作り、`(カードID, 元の会話)` を返す。
///
/// **`hook Stop` まで撃つ**。起こしただけでは `Starting` のままで、§3-4 の門に弾かれる。
async fn 入力待ちのカード(
    server: &TestServer,
    target: &client::Target,
) -> (String, ClaudeSessionId) {
    let cwd = work_dir("seed");
    client::spawn(target, &cwd.to_string_lossy(), None, None)
        .await
        .expect("起こせること");

    // 記録に載るまで待つ（載る前に前方一致で引くと「見つかりません」になる）
    let 載った = server
        .wait_for_listed("カードが1枚載る", |list| list.len() == 1)
        .await;
    let card = 載った[0].card_id.to_string();

    // 擬似 claude にフックを撃たせて入力待ちへ倒す。
    //
    // **ターンの終わりを待たない。** `hook Stop` は1件のフックを撃つだけで、
    // 「作業中 → 終わり」の移り変わりを作らない——待つと必ず時間切れになる。
    // 代わりに、記録の側が入力待ちになるのを見る
    //
    // **`last_assistant_message` を載せる。** 本物の CLI は**まだ1ターンも会話していない
    // 席の `/branch` を断る**（`No conversation to branch`。2026-09-05 実測）ので、
    // 段取り役も送る前に断る（§3-4）。ここを省くと、土台が「会話の無い席」になる
    client::send_input(
        target,
        &card[..8],
        r#"hook Stop {"last_assistant_message":"はい"}"#,
        false,
        5,
    )
    .await
    .expect("指示を送れること");

    let 揃った = server
        .wait_for_listed(
            "入力待ちになり、CLI 側のIDと直前の応答が載る",
            |list| {
                list.iter().any(|meta| {
                    meta.claude_session_id.is_some()
                        && meta.status == SessionStatus::WaitingInput
                        && meta.last_assistant_message.is_some()
                })
            },
        )
        .await;
    let 元の会話 = 揃った[0]
        .claude_session_id
        .expect("CLI 側のIDが載っていること");
    (card, 元の会話)
}

/// **待たずに1通だけ撃つ。**
///
/// 断られる場面で `client::branch` を使うと、来ないカードを上限まで待つことになる
/// （断りは配信で届くので、口そのものは成功して返る）。
async fn 枝分かれを頼む(target: &client::Target, card_id: CardId) {
    let mut ws = Ws::connect(target).await.expect("繋がること");
    ws.send(&ClientMessage::BranchSession { card_id })
        .await
        .expect("送れること");
    ws.close().await;
}

/// その枠の並び（`position` 順のカードID）。
fn 並び(list: &[SessionMeta]) -> Vec<protocol::CardId> {
    let mut 枠: Vec<&SessionMeta> = list.iter().collect();
    枠.sort_by_key(|meta| meta.position);
    枠.iter().map(|meta| meta.card_id).collect()
}

// ---------------------------------------------------------------------------
// 通し（§3-2）
// ---------------------------------------------------------------------------

#[tokio::test]
async fn 押すと枝ができ元が左隣へ戻る() {
    let server = TestServer::start().await;
    let target = target_of(&server);
    let (card, 元の会話) = 入力待ちのカード(&server, &target).await;

    client::branch(&target, &card[..8])
        .await
        .expect("枝分かれできること");

    let list = server
        .wait_for_listed("カードが2枚になる", |list| list.len() == 2)
        .await;

    let 押した席 = list
        .iter()
        .find(|meta| meta.card_id.to_string() == card)
        .expect("押した席が残っていること");
    let 戻った席 = list
        .iter()
        .find(|meta| meta.card_id.to_string() != card)
        .expect("呼び戻した席が増えていること");

    // 押した席は**枝になった**（IDが張り替わった）
    assert!(
        押した席.claude_session_id.is_some_and(|id| id != 元の会話),
        "押した席が枝になっていない（{:?}）",
        押した席.claude_session_id
    );
    // **元の会話は席を持って戻っている**
    assert_eq!(
        戻った席.claude_session_id,
        Some(元の会話),
        "呼び戻した席が元の会話を名乗っていない"
    );
    // **どちらが枝かが印で分かる**（§5-1）
    assert_eq!(
        押した席.branched_from,
        Some(元の会話),
        "枝の側に印が付いていない"
    );
    assert_eq!(
        戻った席.branched_from, None,
        "元の側に印が付いてしまっている"
    );

    // **枝が元のすぐ左**（§3-3）
    assert_eq!(
        並び(&list),
        vec![押した席.card_id, 戻った席.card_id],
        "枝が元の左隣に並んでいない"
    );
}

#[tokio::test]
async fn 枝の印は乗り換えても消えない() {
    // 印が付くのは**カードではなく会話**（§5-1）。記録を読み直しても残る
    let server = TestServer::start().await;
    let target = target_of(&server);
    let (card, 元の会話) = 入力待ちのカード(&server, &target).await;

    client::branch(&target, &card[..8])
        .await
        .expect("枝分かれできること");
    let list = server
        .wait_for_listed("カードが2枚になる", |list| list.len() == 2)
        .await;
    let 枝の会話 = list
        .iter()
        .find(|meta| meta.card_id.to_string() == card)
        .and_then(|meta| meta.claude_session_id)
        .expect("枝の会話が決まっていること");
    assert_ne!(枝の会話, 元の会話);

    // 記録層を丸ごと読み直す（連絡係が戻ったときに通る道）
    server
        .registry
        .reload_account(server_core::db::LOCAL_ACCOUNT_ID)
        .await
        .expect("読み直せること");

    let 読み直した = server.registry.list(server_core::db::LOCAL_ACCOUNT_ID);
    let 枝 = 読み直した
        .iter()
        .find(|meta| meta.claude_session_id == Some(枝の会話))
        .expect("枝の席があること");
    assert_eq!(
        枝.branched_from,
        Some(元の会話),
        "読み直しで札が消えた（`reload_account` で引き直していない）"
    );
}

// ---------------------------------------------------------------------------
// 断る側（§3-4・§4-1）
// ---------------------------------------------------------------------------

#[tokio::test]
async fn 起動直後は断る() {
    // §3-4。`Starting` は「まだ指示を受け付けられない」
    let server = TestServer::start().await;
    let target = target_of(&server);
    let cwd = work_dir("starting");
    client::spawn(&target, &cwd.to_string_lossy(), None, None)
        .await
        .expect("起こせること");
    let 載った = server
        .wait_for_listed("カードが1枚載る", |list| list.len() == 1)
        .await;
    let _card = 載った[0].card_id.to_string();

    // **断りは配信で届く**ので、口そのものは成功して返る。カードが増えないことで見る
    枝分かれを頼む(&target, 載った[0].card_id).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let list = server.registry.list(server_core::db::LOCAL_ACCOUNT_ID);
    assert_eq!(list.len(), 1, "断ったのにカードが増えている");
}

#[tokio::test]
async fn 会話が無い席は断る() {
    // §3-4。**状態では見分けられない**——起こした直後の席も「入力待ち」になりうる。
    // ここを通すと、CLI 側が `No conversation to branch` と断って待ちが空振りする
    let server = TestServer::start().await;
    let target = target_of(&server);
    let cwd = work_dir("no-conversation");
    client::spawn(&target, &cwd.to_string_lossy(), None, None)
        .await
        .expect("起こせること");
    let 載った = server
        .wait_for_listed("カードが1枚載る", |list| list.len() == 1)
        .await;
    let card = 載った[0].card_id.to_string();

    // **応答を載せずに**入力待ちへ倒す（＝1ターンも会話していない席）
    client::send_input(&target, &card[..8], "hook Stop", false, 5)
        .await
        .expect("指示を送れること");
    server
        .wait_for_listed("入力待ちになる", |list| {
            list.iter()
                .any(|meta| meta.status == SessionStatus::WaitingInput)
        })
        .await;

    枝分かれを頼む(&target, 載った[0].card_id).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let list = server.registry.list(server_core::db::LOCAL_ACCOUNT_ID);
    assert_eq!(list.len(), 1, "会話が無い席で枝分かれが走ってしまった");
}

#[tokio::test]
async fn 二度押しは断る() {
    // §4-1。1本目が走っている間に2本目を通すと、枝が2つできる
    let server = TestServer::start().await;
    let target = target_of(&server);
    let (card, _) = 入力待ちのカード(&server, &target).await;

    let 押した = 引く(&server, &card).card_id;
    枝分かれを頼む(&target, 押した).await;
    // 走り出してから重ねる（1本目が終わる前に2本目を通す）
    tokio::time::sleep(Duration::from_millis(30)).await;
    枝分かれを頼む(&target, 押した).await;

    let list = server
        .wait_for_listed("呼び戻しが1枚だけ増える", |list| list.len() == 2)
        .await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let _ = list;

    let list = server.registry.list(server_core::db::LOCAL_ACCOUNT_ID);
    assert_eq!(
        list.len(),
        2,
        "二度押しで席が増えすぎている（1枚押して増えるのは1枚だけ）"
    );
}
