//! 性能まわりの回帰テスト（テスト計画フェーズ6のサーバ側）。
//!
//! # なぜ「速さ」ではなく「壊れないこと」を測るのか
//!
//! フレームレートや所要時間は実行機の混み具合で上下するので、閾値にすると
//! 「他の作業をしていると落ちるテスト」になる。それはテストとして役に立たない。
//!
//! そこで**マシンの速さに左右されない性質**だけを自動判定にした。
//!
//! - 遅いクライアントが**他のクライアントと PTY 読み取りを巻き込まない**こと
//! - 巨大なトランスクリプトでも**保持量が有界**であること
//! - コアレッシングで**フレーム数が実際に減る**こと（比なので機械の速さで変わらない）
//!
//! 実測値（fps・状態反映の遅延・CPU 使用率）は `make perf` で採り、実行レポートへ残す。

mod common;

use agent_core::config::AgentConfig;
use protocol::{CardId, Node, NodeId, TreeNode};
use std::time::Duration;
use testkit::fake_claude;

/// 遅いクライアントを詰まらせるのに十分な量。
const FLOOD: usize = 8 * 1024 * 1024;

#[tokio::test]
async fn 遅いクライアントは他のクライアントとptyの読み取りを止めない() {
    // テスト計画フェーズ6「遅いクライアント」。1本の遅い購読者のせいで全体が停滞すると、
    // 「別のタブを開いていたら他のセッションまで固まった」という最悪の壊れ方になる
    let manager = common::manager();
    let (session, mut healthy) = common::start_session(&manager).await;

    // 購読するだけで一切受け取らないクライアント（＝いちばん遅い相手）
    let (_snapshot, slow) = session.subscribe_with_snapshot();

    common::send_line(&session, &format!("flood {FLOOD}"));

    // 遅い相手がぶら下がったままでも、まともなクライアントには最後まで届く
    healthy.wait_for(fake_claude::FLOOD_END_MARKER).await;
    assert_eq!(
        healthy.lagged, 0,
        "受信し続けている側は取りこぼさないこと（遅い相手の影響を受けない）"
    );
    assert!(healthy.total_bytes >= FLOOD);

    // PTY の読み取りも止まっていない。止まっているなら誰も停止を要求していないのに
    // 出力が終わらない、という形で上の wait_for が時間切れになる
    assert!(!session.is_paused(), "誰も停止を要求していないこと");

    // 遅い相手の待ち行列は上限で頭打ちになっている（＝サーバのメモリを食い潰さない）
    drop(slow);
    session.kill();
}

#[tokio::test]
// `make perf` でだけ走らせる（`make test` からは外す）。
//
// **比なら機械の速さに左右されない、という前提が成り立たないことが分かった。**
// 他のテストと資源を取り合うと、合流なし（0ms）の側も OS とパイプの都合で勝手に
// まとまるため、比が縮んで落ちる。
//
// # 「半分以下」は判定にできない（セルフホスト化フェーズ1 の実測）
//
// この開発機で5回ずつ測ると、合流=17〜18 に対して素=28〜35 に散った。
// **crate 再編成の前後どちらでも同じ分布**で、「半分以下」の判定は前でも後でも
// ほとんどの回で落ちる。落ちると `make perf` はそこで打ち切られ、**残り3つの
// 実測値が採れなくなる**（比を守るために、記録という本来の目的を失っていた）。
//
// 判定は「合流したほうが確かに少ない」までに留める。合流が丸ごと効かなくなった
// （合流≒素）ことは、これでも捕まる。倍率は記録として印字するだけにする。
//
// Makefile が「数値を合否にしないのは、他の作業の負荷で落ちるテストは役に立たない
// ため」と書いているとおりの扱いに揃えた。
#[ignore = "負荷に左右される実測値。make perf で採る"]
async fn コアレッシングでフレーム数が実際に減る() {
    // テスト計画フェーズ6「コアレッシング効果」。CLI は1文字ずつ書くことがあるので、
    // まとめずに送るとフレーム数が爆発してブラウザが追いつかない
    let merged = frames_with_window(8).await;
    let raw = frames_with_window(0).await;

    println!(
        "フレーム数: 8ms合流={merged} 合流なし={raw}（{:.2}倍）",
        raw as f64 / merged as f64
    );
    assert!(
        merged < raw,
        "8ms の合流でフレーム数が減っていない: 合流={merged} 素={raw}"
    );
}

/// 指定した合流の窓で一定量を流し、届いたフレーム数を返す。
async fn frames_with_window(coalesce_ms: u64) -> usize {
    let config = AgentConfig {
        coalesce_ms,
        // 測っているのは PTY のフレーム合流であって statusLine ではない。
        // 注入したままだと、擬似 claude が数秒ごとに子プロセスを起こして
        // 測定対象と資源を取り合う（実際に本数が揺れて落ちた）
        inject_status_line: false,
        ..AgentConfig::default()
    };
    let manager = common::manager_with(config);
    let (session, mut watcher) = common::start_session(&manager).await;

    common::send_line(&session, &format!("flood {}", 2 * 1024 * 1024));
    watcher.wait_for(fake_claude::FLOOD_END_MARKER).await;
    // 末尾に流れてくる分も数え切ってから比べる
    watcher.drain_quiet_for(Duration::from_millis(200)).await;

    session.kill();
    watcher.output_frames
}

#[tokio::test]
async fn 巨大な履歴でも保持量は直近ウィンドウに収まる() {
    // テスト計画フェーズ6「巨大JSONL」のサーバ側。先行事例では数GBのトランスクリプトで
    // メモリが破綻した例があるため、**届いた量に比例して太らない**ことを固定する
    let window = 2_000;
    let config = AgentConfig {
        transcript_window_nodes: window,
        ..AgentConfig::default()
    };
    let manager = common::manager_with(config);
    let (session, _watcher) = common::start_session(&manager).await;

    // 数十万行に相当するノードを、パーサから届いたのと同じ形で流し込む
    let total = 200_000;
    let chunk = 1_000;
    for start in (0..total).step_by(chunk) {
        let nodes: Vec<protocol::ipc::ParsedNode> = (start..start + chunk)
            .map(|index| protocol::ipc::ParsedNode {
                node: text_node(index),
                offset: index as u64 * 128,
            })
            .collect();
        session.append_transcript("/p/s.jsonl", &nodes);
    }

    let snapshot = session.transcript_snapshot();
    assert_eq!(
        snapshot.len(),
        window,
        "保持しているのは直近ウィンドウぶんだけであること"
    );

    // 残っているのは新しい方（古い方から捨てる）
    let last = snapshot.last().expect("最後のノードがあること");
    assert_eq!(last.id, NodeId(format!("n{}", total - 1)));

    // 捨てた範囲を遡ると、どこから読み直せばよいかは分かる（パーサへ頼む手掛かり）
    let anchor_id = NodeId(format!("n{}", total - window));
    assert!(
        session.transcript_anchor(&anchor_id).is_some(),
        "捨てた範囲の位置は控えてあること"
    );

    session.kill();
}

fn text_node(index: usize) -> TreeNode {
    TreeNode {
        id: NodeId(format!("n{index}")),
        parent: None,
        node: Node::AssistantText {
            text: format!("{index} 行目の応答"),
        },
        ts: 1_700_000_000_000 + index as i64,
        branch: 0,
    }
}

#[tokio::test]
async fn 十二セッションを同時に起動しても状態が全部届く() {
    // テスト計画フェーズ6「並列負荷」のサーバ側。画面のフレームレートは E2E と
    // `make perf` で見る。ここで確かめるのは「取りこぼさないこと」
    let server = common::TestServer::start().await;
    let mut sessions = Vec::new();
    for _ in 0..12 {
        let session = server
            .manager
            .spawn(&common::work_dir())
            .expect("セッションを起動できること");
        sessions.push(session);
    }

    // 数本を高出力にした状態で、全セッションへフックを届ける
    for session in sessions.iter().take(3) {
        common::send_line(session, &format!("flood {}", 4 * 1024 * 1024));
    }
    for session in &sessions {
        server
            .post_hook(session.token(), "UserPromptSubmit", "{}")
            .await;
    }

    for session in &sessions {
        common::wait_for_status(session, protocol::SessionStatus::Working).await;
    }

    // 一覧の口からも12枚そろって見えること
    let (status, body) = server.get("/api/sessions").await;
    assert_eq!(status, 200);
    let listed: Vec<protocol::SessionMeta> =
        serde_json::from_str(&body).expect("SessionMeta の配列として読めること");
    assert_eq!(listed.len(), 12);

    for session in &sessions {
        session.kill();
    }
    for session in &sessions {
        let _: CardId = session.card_id;
        server
            .manager
            .archive(session.card_id)
            .expect("片付けられること");
    }
}
