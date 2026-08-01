//! 同じプロセスの中だけで配る連絡係（セルフホスト化設計§9・§15-3）。
//!
//! # これはテストの飾りではない
//!
//! 複数インスタンスの検証には本物の Valkey が要り、それには docker が要る。docker を
//! 使う検証は `make ci` に入れない約束なので（設計§15-3）、本物だけを相手にすると
//! **フェーズ6 で足した判断が1つも日常のテストで守られない**ことになる。
//!
//! ここが受け持つのは「跨いだときにどう振る舞うか」——番号が飛んだら画面を作り直すのか、
//! 誰も見ていないと分かったら止めるのか、連絡係が切れている間に何を諦めるのか。どれも
//! 相手が Valkey である必要が無い。本物でしか出ない食い違い（RESP3・自動再購読・
//! healthcheck の順序）は compose 側（`make e2e-compose`）が受け持つ。
//!
//! # 壊し方を持っている
//!
//! [`MemoryBroker::drop_next`]（1通落とす）と [`MemoryBroker::cut`]（丸ごと切る）がある。
//! **壊れたときにどうなるかは、壊してみないと分からない**——番号の飛びも縮退バナーも、
//! 正常に動く相手からは一度も引き出せない。

use super::{Bus, BusError, BusMessage, BusState};
use bytes::Bytes;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, watch};

/// 繋がっているインスタンスたちを束ねる中央。
///
/// 本物では Valkey のサーバにあたる。テストは1つ作って [`MemoryBroker::connect`] を
/// 人数分呼び、それぞれを別インスタンスの連絡係として渡す。
#[derive(Default)]
pub struct MemoryBroker {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    members: HashMap<usize, Member>,
    next_id: usize,
    /// 視聴リース（鍵 → 誰が → いつ）
    leases: HashMap<String, HashMap<String, i64>>,
    /// 次の1通を落とすチャネル
    drop_next: HashSet<String>,
    /// 切れている間は配らない
    cut: bool,
}

struct Member {
    incoming: mpsc::UnboundedSender<BusMessage>,
    channels: HashSet<String>,
    state: watch::Sender<BusState>,
}

impl MemoryBroker {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// インスタンスを1つ繋ぐ。届いたものは `incoming` へ流れる。
    pub fn connect(
        self: &Arc<Self>,
        incoming: mpsc::UnboundedSender<BusMessage>,
    ) -> Arc<MemoryBus> {
        let mut inner = self.inner.lock().expect("ロックが壊れていない");
        let id = inner.next_id;
        inner.next_id += 1;
        let state = watch::Sender::new(if inner.cut {
            BusState::Degraded
        } else {
            BusState::Ok
        });
        inner.members.insert(
            id,
            Member {
                incoming,
                channels: HashSet::new(),
                state,
            },
        );
        drop(inner);

        Arc::new(MemoryBus {
            broker: Arc::clone(self),
            id,
        })
    }

    /// 次にこのチャネルへ流れる1通を落とす（番号の飛びを作る）。
    pub fn drop_next(&self, channel: &str) {
        self.inner
            .lock()
            .expect("ロックが壊れていない")
            .drop_next
            .insert(channel.to_string());
    }

    /// 連絡係が落ちた状態にする。
    ///
    /// **購読は忘れない。** 本物（`set_automatic_resubscription`）が復帰時に張り直すのと
    /// 揃えてある——切れている間に購読を捨てると、戻ったときに静かに何も届かなくなる。
    pub fn cut(&self) {
        let mut inner = self.inner.lock().expect("ロックが壊れていない");
        inner.cut = true;
        for member in inner.members.values() {
            // `send` は受け手が居ないと**値を書かずに**失敗する。見張っていない
            // インスタンスの状態が古いまま残るので、必ず書く方を使う
            member.state.send_replace(BusState::Degraded);
        }
    }

    /// 繋がった状態に戻す。
    pub fn restore(&self) {
        let mut inner = self.inner.lock().expect("ロックが壊れていない");
        inner.cut = false;
        for member in inner.members.values() {
            member.state.send_replace(BusState::Ok);
        }
    }

    fn publish(&self, channel: &str, payload: Bytes) {
        let mut inner = self.inner.lock().expect("ロックが壊れていない");
        if inner.cut {
            return;
        }
        if inner.drop_next.remove(channel) {
            return;
        }
        // 購読している全員へ配る。**自分が出したものも自分へ返る**（本物と同じ）ので、
        // 発信元の判別は受け取る側の責任になる（`bus::decode_json` の封筒）
        for member in inner.members.values() {
            if member.channels.contains(channel) {
                let _ = member.incoming.send(BusMessage {
                    channel: channel.to_string(),
                    payload: payload.clone(),
                });
            }
        }
    }

    fn set_subscription(&self, id: usize, channel: &str, on: bool) {
        let mut inner = self.inner.lock().expect("ロックが壊れていない");
        let Some(member) = inner.members.get_mut(&id) else {
            return;
        };
        if on {
            member.channels.insert(channel.to_string());
        } else {
            member.channels.remove(channel);
        }
    }

    fn state_of(&self, id: usize) -> watch::Receiver<BusState> {
        let inner = self.inner.lock().expect("ロックが壊れていない");
        inner
            .members
            .get(&id)
            .map(|member| member.state.subscribe())
            .unwrap_or_else(|| watch::Sender::new(BusState::Degraded).subscribe())
    }

    fn lease(&self) -> Result<std::sync::MutexGuard<'_, Inner>, BusError> {
        let inner = self.inner.lock().expect("ロックが壊れていない");
        if inner.cut {
            return Err(BusError::Disconnected);
        }
        Ok(inner)
    }
}

/// [`MemoryBroker`] に繋がったインスタンス1つぶん。
pub struct MemoryBus {
    broker: Arc<MemoryBroker>,
    id: usize,
}

#[async_trait::async_trait]
impl Bus for MemoryBus {
    fn publish(&self, channel: &str, payload: Bytes) {
        self.broker.publish(channel, payload);
    }

    fn subscribe(&self, channel: &str) {
        self.broker.set_subscription(self.id, channel, true);
    }

    fn unsubscribe(&self, channel: &str) {
        self.broker.set_subscription(self.id, channel, false);
    }

    async fn lease_touch(&self, key: &str, member: &str, at_ms: i64) -> Result<(), BusError> {
        self.broker
            .lease()?
            .leases
            .entry(key.to_string())
            .or_default()
            .insert(member.to_string(), at_ms);
        Ok(())
    }

    async fn lease_release(&self, key: &str, member: &str) -> Result<(), BusError> {
        if let Some(entries) = self.broker.lease()?.leases.get_mut(key) {
            entries.remove(member);
        }
        Ok(())
    }

    async fn lease_sweep(&self, key: &str, older_than_ms: i64) -> Result<u64, BusError> {
        let mut inner = self.broker.lease()?;
        let entries = inner.leases.entry(key.to_string()).or_default();
        entries.retain(|_, at| *at > older_than_ms);
        Ok(entries.len() as u64)
    }

    fn state(&self) -> watch::Receiver<BusState> {
        self.broker.state_of(self.id)
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn member(broker: &Arc<MemoryBroker>) -> (Arc<MemoryBus>, mpsc::UnboundedReceiver<BusMessage>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (broker.connect(tx), rx)
    }

    #[tokio::test]
    async fn 購読しているインスタンスにだけ届く() {
        let broker = MemoryBroker::new();
        let (a, mut a_rx) = member(&broker);
        let (b, mut b_rx) = member(&broker);

        b.subscribe("acct:x:events");
        a.publish("acct:x:events", Bytes::from_static(b"hi"));

        let got = b_rx.recv().await.expect("届くこと");
        assert_eq!(got.channel, "acct:x:events");
        assert_eq!(&got.payload[..], b"hi");
        // 購読していない側には届かない（名前で分かれていることの土台）
        assert!(a_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn 自分が出したものも購読していれば返ってくる() {
        // 本物の pub/sub と同じ振る舞い。**発信元の判別を上の層に要求する**根拠になる
        let broker = MemoryBroker::new();
        let (a, mut a_rx) = member(&broker);
        a.subscribe("acct:x:events");
        a.publish("acct:x:events", Bytes::from_static(b"hi"));
        assert!(a_rx.recv().await.is_some());
    }

    #[tokio::test]
    async fn 落とすと届かないが次は届く() {
        let broker = MemoryBroker::new();
        let (a, _a_rx) = member(&broker);
        let (b, mut b_rx) = member(&broker);
        b.subscribe("card:1:screen");

        broker.drop_next("card:1:screen");
        a.publish("card:1:screen", Bytes::from_static(b"1"));
        a.publish("card:1:screen", Bytes::from_static(b"2"));

        let got = b_rx.recv().await.expect("2通目は届くこと");
        assert_eq!(&got.payload[..], b"2", "落とすのは1通だけ");
    }

    #[tokio::test]
    async fn 切れている間は配らないが購読は覚えている() {
        let broker = MemoryBroker::new();
        let (a, _a_rx) = member(&broker);
        let (b, mut b_rx) = member(&broker);
        b.subscribe("acct:x:events");

        broker.cut();
        assert_eq!(*b.state().borrow(), BusState::Degraded);
        a.publish("acct:x:events", Bytes::from_static(b"lost"));
        assert!(b_rx.try_recv().is_err());

        broker.restore();
        assert_eq!(*b.state().borrow(), BusState::Ok);
        // 購読し直さなくても届く。**切れている間に購読を捨てない**ことの確認
        a.publish("acct:x:events", Bytes::from_static(b"back"));
        assert!(b_rx.recv().await.is_some());
    }

    #[tokio::test]
    async fn 視聴の印は古くなると掃除される() {
        let broker = MemoryBroker::new();
        let (a, _rx) = member(&broker);

        a.lease_touch("screen_viewers:1", "A", 1_000).await.unwrap();
        a.lease_touch("screen_viewers:1", "B", 5_000).await.unwrap();
        // 3000 より古い印を捨てる → A だけ消える
        assert_eq!(a.lease_sweep("screen_viewers:1", 3_000).await.unwrap(), 1);

        a.lease_release("screen_viewers:1", "B").await.unwrap();
        assert_eq!(
            a.lease_sweep("screen_viewers:1", 0).await.unwrap(),
            0,
            "誰も見ていない状態になること"
        );
    }

    #[tokio::test]
    async fn 切れている間は視聴の印を触れない() {
        // 触れたことにすると、**繋がっていないのに「誰も見ていない」と読める**
        let broker = MemoryBroker::new();
        let (a, _rx) = member(&broker);
        broker.cut();
        assert!(matches!(
            a.lease_touch("screen_viewers:1", "A", 1).await,
            Err(BusError::Disconnected)
        ));
        assert!(matches!(
            a.lease_sweep("screen_viewers:1", 0).await,
            Err(BusError::Disconnected)
        ));
    }
}
