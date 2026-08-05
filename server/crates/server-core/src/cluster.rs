//! 連絡係と、このインスタンスの中身を繋ぐ配線（セルフホスト化設計§9）。
//!
//! [`crate::bus`] は運ぶだけで、何を運んでいるかを知らない。届いたものをチャネル名で
//! 見分けて、記録層（[`crate::registry`]）や受け口（[`crate::gateway`]）へ渡すのがここ。
//!
//! # 列を分ける
//!
//! 知らせ（`acct:`）と画面（`card:`）を同じ列で捌くと、**知らせの処理で DB を1回引く
//! あいだ画面が止まる**。知らせは稀で重く、画面は頻繁で軽いので、性質が逆になる。
//! 分けておけば互いの都合を引きずらない。
//!
//! 列の中は**順番どおりに1つずつ**捌く。追い越しを許すと、履歴の作り直しの前に
//! 続きが積まれる（設計§6-2）。

use crate::{
    bus::{self, BusMessage, BusState},
    gateway::{SessionHostCommand, SessionHostHub},
    registry::SessionRegistry,
};
use std::sync::Arc;
use tokio::sync::{mpsc, watch};

/// 連絡係からの受け取りを始める。
///
/// 呼ぶのは組み立てる側（`agentdashboard_core`）で、**連絡係が居るときだけ**。
pub fn start(
    registry: Arc<SessionRegistry>,
    hub: Arc<SessionHostHub>,
    incoming: mpsc::UnboundedReceiver<BusMessage>,
    state: watch::Receiver<BusState>,
) {
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    let (cmds_tx, cmds_rx) = mpsc::unbounded_channel();
    let (frames_tx, frames_rx) = mpsc::unbounded_channel();
    tokio::spawn(events_loop(
        Arc::clone(&registry),
        Arc::clone(&hub),
        events_rx,
    ));
    tokio::spawn(cmds_loop(Arc::clone(&hub), Arc::clone(&registry), cmds_rx));
    tokio::spawn(frames_loop(Arc::clone(&hub), frames_rx));
    tokio::spawn(route(incoming, events_tx, cmds_tx, frames_tx));
    tokio::spawn(watch_state(registry, state));
    // 「この PC はうちに繋がっている」「このカードをうちで見ている」と記し続ける（§9-4）
    hub.start_presence();
    hub.start_viewing_lease();
}

/// 届いたものを、チャネル名で行き先へ振り分ける。
async fn route(
    mut incoming: mpsc::UnboundedReceiver<BusMessage>,
    events: mpsc::UnboundedSender<BusMessage>,
    cmds: mpsc::UnboundedSender<BusMessage>,
    frames: mpsc::UnboundedSender<BusMessage>,
) {
    while let Some(message) = incoming.recv().await {
        // 名前を読めないものは捨てる。知らない版のインスタンスが増やしたチャネルで
        // ありうるので、**接続ごと落とさない**
        let sent = if bus::parse_account_events(&message.channel).is_some() {
            events.send(message)
        } else if bus::parse_agent_cmd(&message.channel).is_some() {
            cmds.send(message)
        } else if bus::parse_card_screen(&message.channel).is_some() {
            frames.send(message)
        } else {
            continue;
        };
        if sent.is_err() {
            break;
        }
    }
}

/// 画面を自分のブラウザへ流す。
///
/// **知らせとは別の列**にしてある。知らせは稀で重く（DB を引くことがある）、画面は
/// 頻繁で軽い——同じ列に並べると、知らせ1件の処理で画面が止まる。
async fn frames_loop(hub: Arc<SessionHostHub>, mut frames: mpsc::UnboundedReceiver<BusMessage>) {
    while let Some(message) = frames.recv().await {
        hub.deliver_bus_screen(&message.payload);
    }
}

/// PC への指示を、自分が持っている接続へ渡す。
async fn cmds_loop(
    hub: Arc<SessionHostHub>,
    registry: Arc<SessionRegistry>,
    mut cmds: mpsc::UnboundedReceiver<BusMessage>,
) {
    while let Some(message) = cmds.recv().await {
        let Some(agent_id) = bus::parse_agent_cmd(&message.channel) else {
            continue;
        };
        let Some((from, command)) = bus::decode_json::<SessionHostCommand>(&message.payload) else {
            continue;
        };
        // 自分が出したものは、出す前に自分の接続表を見て直に送っている。
        // ここへ来るのは行き違いなので、二度送らない
        if from == registry.instance_id() {
            continue;
        }
        hub.deliver_command(agent_id, command);
    }
}

/// アカウントの知らせを取り込む。
async fn events_loop(
    registry: Arc<SessionRegistry>,
    hub: Arc<SessionHostHub>,
    mut events: mpsc::UnboundedReceiver<BusMessage>,
) {
    while let Some(message) = events.recv().await {
        // **持ち主はチャネル名で決める**（封筒の中身ではなく）。分離を判定ではなく
        // 名前で成立させているのがこの設計の要点（設計§8-6・§9-2）
        let Some(account_id) = bus::parse_account_events(&message.channel) else {
            continue;
        };
        let Some((from, body)) = bus::decode_json::<bus::AccountMessage>(&message.payload) else {
            continue;
        };
        // 自分が出したものは既に手元へ配ってある。取り込むと二重になり、しかも
        // 配り直したものがまた返ってきて止まらなくなる
        if from == registry.instance_id() {
            continue;
        }
        match body {
            bus::AccountMessage::Event(event) => registry.adopt(account_id, *event).await,
            // 立ち上げ直したインスタンスからの頼み。**自分に繋がっている PC の
            // カードだけ**を名乗り直す
            bus::AccountMessage::Resync => hub.reannounce(account_id),
            // 別のインスタンスに繋がっている PC からの答え（設計§7）。
            //
            // **自分が問うたものでなければ捨てる。** このチャネルはアカウント単位なので、
            // 問うていないインスタンスにも届く——`request_id` が合わないものは、
            // 捨てるだけで正しい
            bus::AccountMessage::HostReply { request_id, reply } => {
                hub.resolve_reply(request_id, *reply);
            }
        }
    }
}

/// 連絡係の生き死にを見張る。
///
/// **戻ってきたら DB を読み直す**（設計§9-1 の規約）。自動再購読は購読を張り直すだけで、
/// 切れている間に流れたものは埋めてくれない——購読が戻ったことと、中身が揃っていることは
/// 別の話になる。
async fn watch_state(registry: Arc<SessionRegistry>, mut state: watch::Receiver<BusState>) {
    let mut previous = *state.borrow();
    while state.changed().await.is_ok() {
        let current = *state.borrow_and_update();
        if previous == current {
            continue;
        }
        // 画面へ出す。**症状が「一部だけ古い」という分かりにくい形**になるので、
        // 何が止まっているのかを利用者が読み解けるようにする（設計§12）
        registry.announce(banner(current));
        if previous == BusState::Degraded && current == BusState::Ok {
            tracing::info!("連絡係が戻りました。記録を読み直します");
            registry.resnapshot().await;
        }
        previous = current;
    }
}

/// 連絡係の状態を、画面へ出す形にする。
pub fn banner(state: BusState) -> protocol::ws::ServerMessage {
    protocol::ws::ServerMessage::BusStatus {
        state: match state {
            BusState::Ok => protocol::ws::BusState::Ok,
            BusState::Degraded => protocol::ws::BusState::Degraded,
        },
        detail: match state {
            BusState::Ok => None,
            BusState::Degraded => Some("連絡係（Valkey）に繋がりません".to_string()),
        },
    }
}
