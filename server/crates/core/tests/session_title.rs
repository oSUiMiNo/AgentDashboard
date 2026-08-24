//! セッションの名前が、報告からカードへ届くまで（テスト計画フェーズ2「PC 側の受けと配り直し」）。
//!
//! **ここで見るのは継ぎ目だけ。** 「履歴の行から題を拾う」はパーサの単体テストが、
//! 「線に乗る形」は `protocol` の往復テストが押さえている。こちらは
//! **報告 → `meta` → カード1枚の配り直し**という3段が繋がっていることを見る。
//!
//! 相手は擬似 claude なので課金なしで走る。

mod common;

use protocol::CardId;
use protocol::ws::ServerMessage;

const 題: &str = "TODOを完了に変更し作業内容をまとめる";

/// 報告を受けると、そのカードの名前が埋まること。
#[tokio::test]
async fn 題の報告でカードに名前が載る() {
    let server = common::TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;

    // 起こした直後は必ずここから始まる。名前は最初のターンのあとに CLI が付ける
    assert_eq!(session.meta().session_title, None);

    server
        .manager
        .report_session_title(session.card_id, 題.to_string());

    assert_eq!(session.meta().session_title.as_deref(), Some(題));
}

/// 名前が付いたらカード1枚が配り直されること。
///
/// 名前は差分メッセージ（`Status`）に載らないので、**カード全体を送り直すしか道が無い**。
#[tokio::test]
async fn 題が付いたらカード1枚が配り直される() {
    let server = common::TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;
    let mut events = common::EventWatcher::attach(&server.manager);

    server
        .manager
        .report_session_title(session.card_id, 題.to_string());

    let message = events
        .wait_for("カード1枚の配り直し", |message| {
            matches!(message, ServerMessage::SessionUpsert { .. })
        })
        .await;
    let ServerMessage::SessionUpsert { session: meta } = message else {
        unreachable!("上の述語が SessionUpsert だけを通している");
    };
    assert_eq!(meta.card_id, session.card_id);
    assert_eq!(meta.session_title.as_deref(), Some(題));
}

/// 同じ題を2回受けたら、2回目は配らないこと。
///
/// **同じ題は履歴に何度も書かれる**（実測で1ファイルに2件）。毎回配ると、記録層と
/// 全ブラウザまで波及する配り直しが読み直しのたびに走る。
#[tokio::test]
async fn 同じ題を2回受けても2回目は配らない() {
    let server = common::TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;

    server
        .manager
        .report_session_title(session.card_id, 題.to_string());

    // 1回目の配り直しを見送ってから購読する
    let mut events = common::EventWatcher::attach(&server.manager);
    server
        .manager
        .report_session_title(session.card_id, 題.to_string());
    // 違う題なら配られる。**この2件目が最初に届けば、1件目は流れていない**
    server
        .manager
        .report_session_title(session.card_id, "別の題".to_string());

    let message = events
        .wait_for("カード1枚の配り直し", |message| {
            matches!(message, ServerMessage::SessionUpsert { .. })
        })
        .await;
    let ServerMessage::SessionUpsert { session: meta } = message else {
        unreachable!("上の述語が SessionUpsert だけを通している");
    };
    assert_eq!(
        meta.session_title.as_deref(),
        Some("別の題"),
        "同じ題でも配り直している（変わったときだけのはず）"
    );
}

/// 監視していないカードの報告は捨てること。
///
/// 外した直後に届いたぶんで一覧を汚さないための門（設計§4）。
///
/// # なぜセッションを2本立てるのか
///
/// 1本だけだと**門を外しても落ちない**（実測。壊し方を当てて分かった）。門が無い実装は
/// 迷子の報告をどれか1枚へ着けることになるが、生きているカードが1枚しか無ければ
/// その1枚は正解と同じカードなので、`card_id` を見るだけでは見分けが付かない。
///
/// 2本にして**題を別のものにする**と、どちらへ着いても必ず食い違いが出る。
#[tokio::test]
async fn 知らないカードの題は捨てる() {
    const 捨てられるはずの題: &str = "宛先の無い題";

    let server = common::TestServer::start().await;
    let (first, _first_watcher) = common::start_session(&server.manager).await;
    let (second, _second_watcher) = common::start_session(&server.manager).await;
    let mut events = common::EventWatcher::attach(&server.manager);

    // 誰のものでもないカードID
    server
        .manager
        .report_session_title(CardId::new(), 捨てられるはずの題.to_string());
    // 生きているカードへの報告は通る。**これが先に届けば、上は流れていない**
    server
        .manager
        .report_session_title(second.card_id, 題.to_string());

    let message = events
        .wait_for("カード1枚の配り直し", |message| {
            matches!(message, ServerMessage::SessionUpsert { .. })
        })
        .await;
    let ServerMessage::SessionUpsert { session: meta } = message else {
        unreachable!("上の述語が SessionUpsert だけを通している");
    };
    assert_eq!(
        meta.card_id, second.card_id,
        "知らないカードの報告が一覧へ漏れている"
    );
    assert_eq!(
        meta.session_title.as_deref(),
        Some(題),
        "宛先の無い題が、生きているカードへ着いている"
    );

    // 配信の順序に頼らない裏取り。**どちらのカードにも迷子の題は着いていない**
    assert_eq!(first.meta().session_title, None);
    assert_eq!(second.meta().session_title.as_deref(), Some(題));
}

/// **要件が名指しで心配している形**：片方に名前が付いても、隣のカードは変わらない。
#[tokio::test]
async fn 片方に名前が付いても隣は変わらない() {
    let server = common::TestServer::start().await;
    let (first, _first_watcher) = common::start_session(&server.manager).await;
    let (second, _second_watcher) = common::start_session(&server.manager).await;

    server
        .manager
        .report_session_title(first.card_id, 題.to_string());

    assert_eq!(first.meta().session_title.as_deref(), Some(題));
    assert_eq!(
        second.meta().session_title,
        None,
        "隣のセッションの名前が連動してはいけない"
    );
    assert_ne!(first.card_id, second.card_id);
}
