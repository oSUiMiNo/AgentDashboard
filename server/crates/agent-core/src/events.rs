//! エージェントが「上へ報告する」口（セルフホスト化設計§2-3）。
//!
//! セッションの状態が変わった・履歴が伸びた・自己修復が動いた——こうした知らせは、
//! ローカルモードでは同じプロセスのブラウザ配信へ、セルフホストモードでは A2S 越しの
//! ダッシュボードサーバへ流れる。**流し先を [`SessionManager`] に焼き付けない**ための
//! 口がこのトレイトになる。
//!
//! [`SessionManager`]: crate::session::SessionManager
//!
//! # 購読も口に含める
//!
//! 報告（[`EventSink::emit`]）だけでなく購読（[`EventSink::subscribe`]）も持たせている。
//! セルフホストモードでも、**同じプロセスの中に購読者が残る**ためである——自己修復は
//! 自分が起こしたセッションの様子を見ながら進む（`selfheal`）。上へ運ぶ実装は、
//! 手元の配信を購読して A2S へ転送する形になる（フェーズ3）。
//!
//! # 取りこぼしは購読者の責任
//!
//! 配信は固定長の待ち行列で、受信が遅れた購読者には `Lagged` が返る。ここで待たない
//! のは、**一覧の更新がセッションの実行を遅らせてはいけない**ため。取りこぼした側は
//! 状態を取り直せばよく、そのための入口（`GET /api/sessions`）は別にある。

use protocol::ws::ServerMessage;
use tokio::sync::broadcast;

/// 一覧の更新通知の待ち行列（メッセージ数）。
const EVENT_QUEUE_MESSAGES: usize = 256;

pub trait EventSink: Send + Sync + 'static {
    /// 1件報告する。**送れなくても失敗として扱わない**（購読者が居ないのは異常ではない）。
    fn emit(&self, event: ServerMessage);

    /// 同じプロセスの中で購読する。
    fn subscribe(&self) -> broadcast::Receiver<ServerMessage>;
}

/// ローカルモードの報告先：プロセス内の配信そのもの。
#[derive(Debug)]
pub struct LocalEventBus {
    events: broadcast::Sender<ServerMessage>,
}

impl LocalEventBus {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(EVENT_QUEUE_MESSAGES);
        Self { events }
    }
}

impl Default for LocalEventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventSink for LocalEventBus {
    fn emit(&self, event: ServerMessage) {
        let _ = self.events.send(event);
    }

    fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
        self.events.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::CardId;
    use std::sync::{Arc, Mutex};

    fn removed(card_id: CardId) -> ServerMessage {
        ServerMessage::SessionRemoved { card_id }
    }

    #[tokio::test]
    async fn 報告は購読者へ届く() {
        let bus = LocalEventBus::new();
        let mut receiver = bus.subscribe();
        let card_id = CardId::new();

        bus.emit(removed(card_id));

        assert_eq!(receiver.recv().await.unwrap(), removed(card_id));
    }

    #[test]
    fn 購読者が居なくても報告は失敗しない() {
        // 誰も見ていない状態は異常ではない（ブラウザを1枚も開いていないだけ）。
        // ここで失敗を返すと、呼び出し側が「配れなかった」を毎回握り潰すことになる
        let bus = LocalEventBus::new();
        bus.emit(removed(CardId::new()));
    }

    /// 差し替えが効くことを確かめるための、記録するだけの報告先。
    #[derive(Default)]
    struct RecordingSink {
        seen: Mutex<Vec<ServerMessage>>,
        bus: LocalEventBus,
    }

    impl EventSink for RecordingSink {
        fn emit(&self, event: ServerMessage) {
            self.seen.lock().expect("ロックが壊れていない").push(event);
        }

        fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
            self.bus.subscribe()
        }
    }

    #[test]
    fn 報告先は差し替えられる() {
        // フェーズ3 でここが A2S 越しの実装に変わる。差し替えられない口を作っても
        // 意味が無いので、**別の実装を実際に通しておく**
        let sink = Arc::new(RecordingSink::default());
        let card_id = CardId::new();

        let as_trait: Arc<dyn EventSink> = Arc::clone(&sink) as Arc<dyn EventSink>;
        as_trait.emit(removed(card_id));

        assert_eq!(
            *sink.seen.lock().expect("ロックが壊れていない"),
            vec![removed(card_id)]
        );
    }
}
