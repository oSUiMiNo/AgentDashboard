//! 「どこまで読んだか」を進める条件（セルフホスト化設計§6-1、テスト計画フェーズ3）。
//!
//! フェーズ2 まで、位置を進めるのは**ノードを配った直後**だった。記録が DB になった
//! いま、「配った」と「残った」の間には時間がある。**その間に落ちるとノードが静かに
//! 消える**ので、進める条件を「記録に入ったことを確かめてから」へ揃えた。
//!
//! ここで見るのはローカルモードの経路。同じ約束をネットワーク越しに運ぶのが
//! ack（§6-1）で、そちらは A2S の統合テストが受け持つ。

#![allow(non_snake_case)]

use agent_core::{
    events::{EventSink, TranscriptReport},
    offsets::OffsetStore,
};
use agentdashboard_core::local;
use protocol::{
    CardId, Node, NodeId, ProjectId, SessionMeta, SessionStatus, TreeNode, ws::ServerMessage,
};
use sea_orm::DatabaseConnection;
use server_core::registry::SessionRegistry;
use std::{path::PathBuf, sync::Arc, time::Duration};

const WINDOW: usize = 100;
const TIMEOUT: Duration = Duration::from_secs(5);
const TRANSCRIPT: &str = "/tmp/project/session.jsonl";

struct Harness {
    dir: PathBuf,
    db: DatabaseConnection,
    registry: Arc<SessionRegistry>,
    offsets: Arc<OffsetStore>,
    sink: Arc<dyn EventSink>,
}

async fn harness(label: &str) -> Harness {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-offset-test-{label}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");

    let db = server_core::db::connect(&format!("sqlite://{}", dir.join("dashboard.db").display()))
        .await
        .expect("使い捨ての DB へ繋げること");
    let registry = SessionRegistry::load(db.clone(), WINDOW)
        .await
        .expect("記録層を立てられること");
    let offsets = OffsetStore::open(dir.clone());
    let sink = local::reporting(Arc::clone(&registry), Arc::clone(&offsets));

    Harness {
        dir,
        db,
        registry,
        offsets,
        sink,
    }
}

fn meta(card_id: CardId) -> SessionMeta {
    SessionMeta {
        card_id,
        project: ProjectId("/tmp/project".to_string()),
        claude_session_id: None,
        permission_mode: None,
        model: None,
        model_label: None,
        model_requested: None,
        status: SessionStatus::Working,
        subagent_active: 0,
        last_activity_at: 1,
        last_assistant_message: None,
        created_at: 1,
        hooks_seen: false,
        agent_id: None,
        agent_connected: true,
        account: None,
    }
}

fn report(card_id: CardId, id: &str, next_offset: u64) -> TranscriptReport {
    TranscriptReport {
        card_id,
        transcript_path: TRANSCRIPT.to_string(),
        source: TRANSCRIPT.to_string(),
        next_offset,
        nodes: vec![TreeNode {
            id: NodeId(id.to_string()),
            parent: None,
            node: Node::AssistantText {
                text: id.to_string(),
            },
            ts: 1,
            branch: 0,
        }],
    }
}

/// 位置が期待どおりになるまで待つ（報告は待ち行列と DB を通るので即座ではない）。
async fn wait_for_offset(offsets: &OffsetStore, card_id: CardId, expected: u64) {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        if offsets.resume(card_id, TRANSCRIPT).get(TRANSCRIPT) == Some(&expected) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{TIMEOUT:?} 以内に位置が {expected} になりませんでした。実際: {:?}",
            offsets.resume(card_id, TRANSCRIPT)
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn 記録に入ってから位置が進む() {
    let harness = harness("commit").await;
    let card_id = CardId::new();
    harness.sink.emit(ServerMessage::SessionUpsert {
        session: Box::new(meta(card_id)),
    });

    harness.sink.report_transcript(report(card_id, "n1", 120));

    wait_for_offset(&harness.offsets, card_id, 120).await;
    // 位置が進んだ時点で、記録の側にも入っている（順序が逆なら欠落しうる）
    let page = harness
        .registry
        .transcript_page(card_id, None, 10)
        .await
        .expect("読めること");
    assert_eq!(page.nodes.len(), 1);

    let _ = std::fs::remove_dir_all(harness.dir);
}

#[tokio::test]
async fn 記録に書けなければ位置は進まない() {
    // **回帰テスト。** DB 断のときに位置が進むと、そのぶんは二度と読み直されず
    // 履歴が確定的に欠ける（設計§12 の DB 断の行が「ack を返さない」で守っているもの）
    let harness = harness("db-down").await;
    let card_id = CardId::new();
    harness.sink.emit(ServerMessage::SessionUpsert {
        session: Box::new(meta(card_id)),
    });
    harness.sink.report_transcript(report(card_id, "n1", 120));
    wait_for_offset(&harness.offsets, card_id, 120).await;

    // ここで DB を落とす
    harness.db.close().await.expect("閉じられること");

    harness.sink.report_transcript(report(card_id, "n2", 240));
    // 進まないことの確認なので、待つのではなく**進む余地を与えてから**見る
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(
        harness.offsets.resume(card_id, TRANSCRIPT).get(TRANSCRIPT),
        Some(&120),
        "書けていないのに位置が進んだ（次の起動でこのぶんが欠ける）"
    );

    let _ = std::fs::remove_dir_all(harness.dir);
}

#[tokio::test]
async fn 取り込む先が無くても位置は進む() {
    // 外した直後のカード宛ての報告。**二度と書ける見込みが無い**ものを待ち続けると、
    // そのカードの位置が永久に止まり、次の起動で全部読み直すことになる
    let harness = harness("orphan").await;
    let card_id = CardId::new();

    harness.sink.report_transcript(report(card_id, "n1", 120));

    wait_for_offset(&harness.offsets, card_id, 120).await;
    assert!(
        harness.registry.list().is_empty(),
        "知らないカードが記録に増えている"
    );

    let _ = std::fs::remove_dir_all(harness.dir);
}

#[tokio::test]
async fn 巻き戻したら位置を忘れる() {
    // `/rewind` は同じファイルを読み直す必要がある。位置を残したまま先へ進むと、
    // 巻き戻した先のやりとりが二度と読まれない
    let harness = harness("rewind").await;
    let card_id = CardId::new();
    harness.sink.emit(ServerMessage::SessionUpsert {
        session: Box::new(meta(card_id)),
    });
    harness.sink.report_transcript(report(card_id, "n1", 120));
    wait_for_offset(&harness.offsets, card_id, 120).await;

    harness.sink.reset_transcript(card_id);

    let deadline = tokio::time::Instant::now() + TIMEOUT;
    while !harness.offsets.resume(card_id, TRANSCRIPT).is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{TIMEOUT:?} 以内に位置を忘れませんでした"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let _ = std::fs::remove_dir_all(harness.dir);
}
