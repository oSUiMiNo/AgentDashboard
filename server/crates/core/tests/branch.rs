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
//!      → 元の会話が別の席へ呼び戻る → 元がその場に残り、枝がその1つ右隣へ入る
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

/// その枠へ1枚起こし、**増えたカード**のIDを返す。
///
/// **枚数を決め打ちしない。** 並びを確かめるテストは同じ枠へ複数枚起こすので、
/// 「1枚載るまで待って `[0]` を取る」形にすると2枚目以降で前の札を掴む。
async fn 席を1枚起こす(
    server: &TestServer,
    target: &client::Target,
    cwd: &std::path::Path,
) -> String {
    let 起こす前: std::collections::HashSet<String> = server
        .registry
        .list(server_core::db::LOCAL_ACCOUNT_ID)
        .into_iter()
        .map(|meta| meta.card_id.to_string())
        .collect();

    client::spawn(target, &cwd.to_string_lossy(), None, None)
        .await
        .expect("起こせること");

    // 記録に載るまで待つ（載る前に前方一致で引くと「見つかりません」になる）
    let 載った = server
        .wait_for_listed("カードが1枚増える", |list| {
            list.len() == 起こす前.len() + 1
        })
        .await;
    載った
        .iter()
        .map(|meta| meta.card_id.to_string())
        .find(|id| !起こす前.contains(id))
        .expect("増えた1枚が見つかること")
}

/// 枝分かれを頼める状態のカードを1枚作り、`(カードID, 元の会話)` を返す。
///
/// **`hook Stop` まで撃つ**。起こしただけでは `Starting` のままで、§3-4 の門に弾かれる。
async fn 入力待ちのカード(
    server: &TestServer,
    target: &client::Target,
    cwd: &std::path::Path,
) -> (String, ClaudeSessionId) {
    let card = 席を1枚起こす(server, target, cwd).await;

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

    // **見るのは「そのカード」**。同じ枠に他の席が居ると、`any` では隣の席の準備が
    // 整っただけで通ってしまう
    let 目当て = card.clone();
    let 揃った = server
        .wait_for_listed(
            "入力待ちになり、CLI 側のIDと直前の応答が載る",
            move |list| {
                list.iter().any(|meta| {
                    meta.card_id.to_string() == 目当て
                        && meta.claude_session_id.is_some()
                        && meta.status == SessionStatus::WaitingInput
                        && meta.last_assistant_message.is_some()
                })
            },
        )
        .await;
    let 元の会話 = 揃った
        .iter()
        .find(|meta| meta.card_id.to_string() == card)
        .expect("そのカードが記録に居ること")
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
async fn 押すと元はその場に残り枝が右隣へ入る() {
    let server = TestServer::start().await;
    let target = target_of(&server);
    let cwd = work_dir("seed");

    // **枠に2枚居る状態で確かめる。**
    //
    // 1枚しか無いと、**どこへ置いても2枚が隣り合う**ので位置のずれが露出しない。
    // 実際、この形で緑のまま出したものが実機で外れた（2026-09-06）——呼び戻した席は
    // 新しいカードなので枠の端に付き、そこを基準に並べていたため**2枚とも端へ
    // 移動し、しかも左右が逆**になっていた。
    //
    // **枝分かれする席を先頭以外へ置く。** 先頭に置くと「いつも先頭へ寄せる」実装でも
    // 通ってしまい、席を基準にしていることを確かめられない。
    //
    // **起こす順が「先客のほうが後」なのは、新しいカードが先頭へ入るから**（項目13）。
    // 枝分かれする席を先に起こしておくと、あとから起こした先客がその左へ入る
    let (card, 元の会話) = 入力待ちのカード(&server, &target, &cwd).await;
    let 先客 = 席を1枚起こす(&server, &target, &cwd).await;

    client::branch(&target, &card[..8])
        .await
        .expect("枝分かれできること");

    // **枚数だけで待たない。**
    //
    // `client::branch` は「新しいカードが立った」時点で返る（`Goal::NewCard`）ので、
    // **⑧の並べ替えはまだ走っていない**。枚数だけを見て並びを読むと、いつも
    // 「並べ替える前の並び」を掴む——**それでも1枚構成では期待した並びと一致してしまう**
    // ので、この土台では並びを1度も確かめていないのと同じだった（2026-09-06 に判明）。
    let 先客文字 = 先客.clone();
    let 押した文字 = card.clone();
    let list = server
        .wait_for_listed(
            "並べ替えまで済み、先客 → 元 → 枝 になる",
            move |list| {
                if list.len() != 3 {
                    return false;
                }
                let 並 = 並び(list);
                並[0].to_string() == 先客文字 && 並[2].to_string() == 押した文字
            },
        )
        .await;

    let 押した席 = list
        .iter()
        .find(|meta| meta.card_id.to_string() == card)
        .expect("押した席が残っていること");
    let 戻った席 = list
        .iter()
        .find(|meta| meta.card_id.to_string() != card && meta.card_id.to_string() != 先客)
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

    // **元がその場に残り、枝がその1つ右隣**（§3-3）。
    //
    // 先客は動かない——**枝を1枚差し込んだぶんだけ右へずれる**が、順番は変わらない
    let 先客のID = list
        .iter()
        .find(|meta| meta.card_id.to_string() == 先客)
        .expect("先客が残っていること")
        .card_id;
    assert_eq!(
        並び(&list),
        vec![先客のID, 戻った席.card_id, 押した席.card_id],
        "元がその場に残って枝が右隣、という並びになっていない"
    );
}

#[tokio::test]
async fn 枝の印は乗り換えても消えない() {
    // 印が付くのは**カードではなく会話**（§5-1）。記録を読み直しても残る
    let server = TestServer::start().await;
    let target = target_of(&server);
    let (card, 元の会話) = 入力待ちのカード(&server, &target, &work_dir("seed")).await;

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
async fn 起動直後は会話が無いので断る() {
    // §3-4-2。**断る理由が 2026-09-08 に変わった。**
    //
    // かつては `Starting`（まだ指示を受け付けられない）で断っていたが、**起動中は
    // 待てば入力待ちになる**ので、状態そのものは断る理由でなくなった。**それでも
    // 起動直後は断られる**——1ターンも会話しておらず、`branchable` が弾くためである。
    //
    // **順序が効いている。** 会話の有無は**起こす段より前**に見る（§3-6）。後ろに置くと、
    // 起こして寝かせ直すだけの往復が起きる
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
    let (card, _) = 入力待ちのカード(&server, &target, &work_dir("seed")).await;

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

// ---------------------------------------------------------------------------
// 席を失ったときの戻り道（§4-3）
// ---------------------------------------------------------------------------

#[tokio::test]
async fn 席を失った元の会話も枝の印から呼び戻せる() {
    // **枝がカードを乗っ取ると、元の会話は `sessions` から消える**（枝のIDで上書き
    // されるため）。呼び戻しが済んでいれば新しい席の行が残るが、**そこが失敗すると
    // 元のIDを持つ行が1つも無くなる**——2026-09-07 に実機で踏んだ形である。
    //
    // そのとき断りの「もう一度呼び戻す」も `session recall` も「見つかりません」で
    // 終わっていた。**印は「どの会話から分かれたか」を覚えている**ので、そこから
    // 枝を辿って枠を借りれば、元の会話は呼び戻せる。
    let server = TestServer::start().await;
    let target = target_of(&server);
    let cwd = work_dir("recover");
    let (card, 枝の会話) = 入力待ちのカード(&server, &target, &cwd).await;
    let 枠 = 引く(&server, &card).project;

    // **呼び戻しに失敗した状態を作る。** 席が持っているのは枝の会話だけで、
    // 元の会話（この場では架空）を持つ行はどこにも無い
    let 元の会話 = ClaudeSessionId::new();
    server
        .registry
        .mark_branch(server_core::db::LOCAL_ACCOUNT_ID, 枝の会話, 元の会話)
        .await
        .expect("枝の印を残せること");

    let past = server
        .registry
        .past_session_of(server_core::db::LOCAL_ACCOUNT_ID, 元の会話)
        .await
        .expect("記録を引けること")
        .expect("印から辿れること（辿れないと席を失った利用者に戻る道が無い）");

    assert_eq!(
        past.claude_session_id, 元の会話,
        "呼び戻す先が元の会話になっていない"
    );
    assert_eq!(
        past.project, 枠,
        "枠を借りられていない（枝は必ず元と同じ枠に居る）"
    );
}

#[tokio::test]
async fn 作業中に押すとターンが終わってから枝になる() {
    // §3-4（2026-09-07 に覆した）。**割り込んで走っている作業を中止させない。**
    //
    // かつては作業中を「押せない」で避けていたが、それでは**「いまの作業が終わったら
    // 枝を作る」ができない**。いまは押せて、撃つのをターンの終わりまで遅らせる。
    //
    // **ここが本体は「撃っていないこと」の確認である。** 枝になったかだけを見ると、
    // 割り込んで撃っていても最後には枝になるので通ってしまう
    let server = TestServer::start().await;
    let target = target_of(&server);
    let (card, 元の会話) = 入力待ちのカード(&server, &target, &work_dir("turn")).await;

    // 作業中へ倒す（人が指示を打った、という合図）
    client::send_input(&target, &card[..8], "hook UserPromptSubmit", false, 5)
        .await
        .expect("指示を送れること");
    let 目当て = card.clone();
    server
        .wait_for_listed("作業中になる", move |list| {
            list.iter().any(|meta| {
                meta.card_id.to_string() == 目当て && meta.status == SessionStatus::Working
            })
        })
        .await;

    枝分かれを頼む(&target, 引く(&server, &card).card_id).await;

    // **撃たれていないことを確かめる。** 撃たれていれば擬似 claude が名乗るIDを
    // 張り替えるので、ここで元の会話のままなら「待っている」と言える
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let 待機中 = server.registry.list(server_core::db::LOCAL_ACCOUNT_ID);
    let 押した席 = 待機中
        .iter()
        .find(|meta| meta.card_id.to_string() == card)
        .expect("押した席が残っていること");
    assert_eq!(
        押した席.claude_session_id,
        Some(元の会話),
        "作業中なのに `/branch` が撃たれている（走っている作業を中止させる）"
    );
    assert_eq!(待機中.len(), 1, "作業中なのに呼び戻しまで進んでいる");

    // ターンを終える。ここから段取りが動き出す
    client::send_input(
        &target,
        &card[..8],
        r#"hook Stop {"last_assistant_message":"終わりました"}"#,
        false,
        5,
    )
    .await
    .expect("指示を送れること");

    let 揃った = server
        .wait_for_listed("枝と元の2枚になる", |list| list.len() == 2)
        .await;
    let 押した席 = 揃った
        .iter()
        .find(|meta| meta.card_id.to_string() == card)
        .expect("押した席が残っていること");
    assert!(
        押した席.claude_session_id.is_some_and(|id| id != 元の会話),
        "ターンが終わっても枝になっていない"
    );
    assert!(
        揃った
            .iter()
            .any(|meta| meta.claude_session_id == Some(元の会話)),
        "元の会話が席を持って戻っていない"
    );
}

// ---------------------------------------------------------------------------
// 寝ている元から枝を作る（§3-4-2）
// ---------------------------------------------------------------------------

/// 記録に載っている `CardId` を、前方一致ではなく完全一致で引く。
fn 載っているカードID(server: &TestServer, card: &str) -> CardId {
    server
        .registry
        .list(server_core::db::LOCAL_ACCOUNT_ID)
        .into_iter()
        .find(|meta| meta.card_id.to_string() == card)
        .expect("そのカードが記録に居ること")
        .card_id
}

/// そのカードが寝るまで待つ。
async fn 寝るまで待つ(server: &TestServer, card: &str) {
    let 目当て = card.to_string();
    server
        .wait_for_listed("そのカードが寝る", move |list| {
            list.iter().any(|meta| {
                meta.card_id.to_string() == 目当て
                    && matches!(meta.status, SessionStatus::Ended { .. })
            })
        })
        .await;
}

#[tokio::test]
async fn 寝ている元から枝を作ると元は寝たまま枝だけ起きる() {
    // §3-4-2。**利用者が求めた最終形はこれ**——「元セッションは寝たままの状態で、
    // ブランチ側のみ起きている」（2026-09-08 の指定）。
    //
    // **枝になるのは押した席**なので、寝かせ直す相手は**呼び戻した新しい席**である。
    // ここを取り違えると、枝を寝かせて元を起こしたままにしてしまう
    let server = TestServer::start().await;
    let target = target_of(&server);
    let cwd = work_dir("asleep-branch");
    let (card, 元の会話) = 入力待ちのカード(&server, &target, &cwd).await;

    client::kill(&target, &card[..8])
        .await
        .expect("寝かせられること");
    寝るまで待つ(&server, &card).await;

    // **寝ていても押せる。** かつてはここで「止まっているセッションからは枝分かれ
    // できません」と断っていた。
    //
    // **待たずに撃つ。** 段取り役が「起こして、整うのを待つ」段に入るので、その間に
    // 擬似 claude を入力待ちへ倒してやる必要がある——`client::branch` で待つと、
    // 倒す前に上限へ達する
    枝分かれを頼む(&target, 載っているカードID(&server, &card)).await;

    // **擬似 claude は起こしても自分では入力待ちにならない。**
    // 本物は起動が済むと `SessionStart` フックを撃ち、それが入力待ちへ倒す
    // （`state.rs`）。擬似はフックを自分から撃たないので、ここで代わりに撃つ。
    // **これは土台の都合であって、製品の段取りに手を入れているわけではない**
    let 目当て = card.clone();
    server
        .wait_for_listed("寝ていた席が起きてくる", move |list| {
            list.iter().any(|meta| {
                meta.card_id.to_string() == 目当て
                    && !matches!(meta.status, SessionStatus::Ended { .. })
            })
        })
        .await;
    client::send_input(
        &target,
        &card[..8],
        r#"hook Stop {"last_assistant_message":"はい"}"#,
        false,
        5,
    )
    .await
    .expect("起きた席へ指示を送れること");

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

    // 押した席は**枝**になり、**起きている**
    assert_eq!(
        押した席.branched_from,
        Some(元の会話),
        "押した席が枝になっていない"
    );
    assert!(
        !matches!(押した席.status, SessionStatus::Ended { .. }),
        "枝まで寝かせてしまっている（利用者が見たいのは枝である）"
    );

    // 呼び戻した席は**元の会話**を持ち、**寝ている**
    assert_eq!(
        戻った席.claude_session_id,
        Some(元の会話),
        "呼び戻した席が元の会話を名乗っていない"
    );
    寝るまで待つ(&server, &戻った席.card_id.to_string()).await;

    // 並びは変わらない——**元がその場、枝が1つ右隣**（§3-3）
    assert_eq!(
        並び(&server.registry.list(server_core::db::LOCAL_ACCOUNT_ID)),
        vec![戻った席.card_id, 押した席.card_id],
        "元がその場に戻り、枝がその右隣に来ていない"
    );
}

#[tokio::test]
async fn 起きていた元は枝を作っても寝かされない() {
    // §3-4-2。**寝かせ直すのは、押した時点で寝ていたときだけ。** 判断を段取りの途中の
    // 状態で行うと、**自分で起こした結果を「起きていた」と読む**——その裏返しとして、
    // ここを間違えると**起きていた親を勝手に寝かせる**
    let server = TestServer::start().await;
    let target = target_of(&server);
    let cwd = work_dir("awake-branch");
    let (card, 元の会話) = 入力待ちのカード(&server, &target, &cwd).await;

    client::branch(&target, &card[..8])
        .await
        .expect("枝を作れること");

    let list = server
        .wait_for_listed("カードが2枚になる", |list| list.len() == 2)
        .await;
    let 戻った席 = list
        .iter()
        .find(|meta| meta.card_id.to_string() != card)
        .expect("呼び戻した席が増えていること");
    assert_eq!(戻った席.claude_session_id, Some(元の会話));

    // **寝かせ直しは走らないので、しばらく置いても起きたまま**である
    tokio::time::sleep(Duration::from_millis(800)).await;
    let 引き直し = server.registry.list(server_core::db::LOCAL_ACCOUNT_ID);
    let 元 = 引き直し
        .iter()
        .find(|meta| meta.card_id == 戻った席.card_id)
        .expect("呼び戻した席が残っていること");
    assert!(
        !matches!(元.status, SessionStatus::Ended { .. }),
        "起きていた元を勝手に寝かせている"
    );
}
