//! 本物の連絡係（Valkey）。セルフホスト化設計§9-1。
//!
//! # 落とし穴が3つある
//!
//! 1. **RESP3 でないと pub/sub が使えない。** `redis://valkey:6379` のまま繋ぐと、
//!    購読の呼び出しが実行時に断られる。設計§14-1 の例は素の URL なので、
//!    [`normalize_url`] で `protocol=resp3` を必ず足す（`sqlite://` に `mode=rwc` を
//!    足しているのと同じ扱い）
//! 2. **自動再購読は既定で切れている。** 入れ忘れると、**繋ぎ直した後で購読だけが
//!    静かに失われる**。エラーは出ず、ただ何も届かなくなる。[`manager_config`] で必ず
//!    有効にし、有効であることを機械で検査する
//! 3. **自動再購読は取りこぼしを埋めない。** 切れている間に流れたものは消えているので、
//!    繋がり直したら DB からスナップショットを取り直す（設計§9-1 の規約）。その合図は
//!    [`Bus::state`] の変化で配る
//!
//! # 待たせない・順序は守る
//!
//! 配る要求は1本の待ち行列に積み、**1つのタスクが順に捌く**。呼ぶ側は待たないので
//! セッションの実行が跨ぎの配信に引きずられず、それでいて同じチャネルへの順序は保たれる
//! （`TranscriptReset` が `TranscriptAppend` に追い越されない。設計§6-2）。

use super::{Bus, BusError, BusMessage, BusState};
use bytes::Bytes;
use redis::{
    AsyncTypedCommands as _, FromRedisValue as _, PushInfo, PushKind,
    aio::{ConnectionManager, ConnectionManagerConfig},
};
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, watch};

/// 繋ぐまでの上限。**待ち続けない**——起動が黙って止まるより、繋がらないと言うほうがよい。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// 1つの要求への応答を待つ上限。
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);
/// 視聴の印を置いておく寿命（秒）。
///
/// 掃除（[`Bus::lease_sweep`]）は見ているカードにしか走らないので、**見なくなった
/// カードの鍵が残り続ける**。寿命を付けておけば、誰も触らなくなった鍵は勝手に消える。
const LEASE_TTL_SECS: u64 = 60;

/// 連絡係へ出す要求。**publish と購読の開け閉めを同じ列に並べる**ので、
/// 「購読する前に流れた」という取りこぼしが自分の実装では起きない。
enum Op {
    Publish { channel: String, payload: Bytes },
    Subscribe(String),
    Unsubscribe(String),
}

pub struct ValkeyBus {
    ops: mpsc::UnboundedSender<Op>,
    /// 視聴リース用。`ConnectionManager` は clone しても実体は1つ（参照カウント）
    commands: ConnectionManager,
    state: Arc<watch::Sender<BusState>>,
}

impl ValkeyBus {
    /// 繋いで、届いたものを `incoming` へ流し始める。
    pub async fn connect(
        url: &str,
        incoming: mpsc::UnboundedSender<BusMessage>,
    ) -> anyhow::Result<Arc<Self>> {
        let url = normalize_url(url);
        let client = redis::Client::open(url.as_str())?;

        // 届いたものを受け取る口。**購読用の接続にだけ**付ける
        let (push_tx, push_rx) = mpsc::unbounded_channel::<PushInfo>();
        let subscriber =
            ConnectionManager::new_with_config(client.clone(), subscriber_config(push_tx)).await?;
        // 配る側と視聴リースは別の接続にする。購読中の接続へ大きな publish を混ぜると、
        // 出力バッファの上限（設計§9-5）に押し出されて**サーバ側から切られる**
        let commands = ConnectionManager::new_with_config(client, command_config()).await?;

        let state = Arc::new(watch::Sender::new(BusState::Ok));
        let (ops, op_rx) = mpsc::unbounded_channel();

        tokio::spawn(drain(
            op_rx,
            subscriber,
            commands.clone(),
            Arc::clone(&state),
        ));
        tokio::spawn(pump(push_rx, incoming, Arc::clone(&state)));

        tracing::info!("連絡係（Valkey）に繋ぎました: {}", masked(&url));
        Ok(Arc::new(Self {
            ops,
            commands,
            state,
        }))
    }

    fn mark(&self, ok: bool) {
        mark(&self.state, ok);
    }
}

#[async_trait::async_trait]
impl Bus for ValkeyBus {
    fn publish(&self, channel: &str, payload: Bytes) {
        let _ = self.ops.send(Op::Publish {
            channel: channel.to_string(),
            payload,
        });
    }

    fn subscribe(&self, channel: &str) {
        let _ = self.ops.send(Op::Subscribe(channel.to_string()));
    }

    fn unsubscribe(&self, channel: &str) {
        let _ = self.ops.send(Op::Unsubscribe(channel.to_string()));
    }

    async fn lease_touch(&self, key: &str, member: &str, at_ms: i64) -> Result<(), BusError> {
        let mut conn = self.commands.clone();
        let result = async {
            conn.zadd(key, member, at_ms).await?;
            conn.expire(key, LEASE_TTL_SECS as i64).await?;
            Ok::<(), redis::RedisError>(())
        }
        .await;
        self.finish(result.map(|_| ()))
    }

    async fn lease_release(&self, key: &str, member: &str) -> Result<(), BusError> {
        let mut conn = self.commands.clone();
        let result = conn.zrem(key, member).await.map(|_| ());
        self.finish(result)
    }

    async fn lease_members(&self, key: &str, newer_than_ms: i64) -> Result<Vec<String>, BusError> {
        let mut conn = self.commands.clone();
        // 古いものを消さずに読み飛ばす。**掃除は持ち主の仕事**で、読む側が消すと
        // 一瞬遅れているだけの相手を消してしまう
        let result = conn
            .zrangebyscore(key, format!("({newer_than_ms}"), "+inf")
            .await;
        self.finish(result)
    }

    async fn lease_sweep(&self, key: &str, older_than_ms: i64) -> Result<u64, BusError> {
        let mut conn = self.commands.clone();
        let result = async {
            // 印が古いものを落としてから数える。**落とす前に数えると、落ちた
            // インスタンスのぶんを見ている人として数えてしまう**
            conn.zrembyscore(key, "-inf", older_than_ms).await?;
            conn.zcard(key).await
        }
        .await;
        self.finish(result.map(|count| count as u64))
    }

    fn state(&self) -> watch::Receiver<BusState> {
        self.state.subscribe()
    }
}

impl ValkeyBus {
    /// 結果を記録しつつ、こちらのエラー型へ移す。
    fn finish<T>(&self, result: Result<T, redis::RedisError>) -> Result<T, BusError> {
        match result {
            Ok(value) => {
                self.mark(true);
                Ok(value)
            }
            Err(err) => {
                self.mark(false);
                Err(BusError::Failed(err.to_string()))
            }
        }
    }
}

/// 待ち行列を順に捌く。
async fn drain(
    mut ops: mpsc::UnboundedReceiver<Op>,
    mut subscriber: ConnectionManager,
    mut commands: ConnectionManager,
    state: Arc<watch::Sender<BusState>>,
) {
    while let Some(op) = ops.recv().await {
        let outcome = match op {
            // **1つずつ待つ。** まとめて投げると、同じチャネルへの並びが崩れうる
            Op::Publish { channel, payload } => commands
                .publish(&channel, payload.as_ref())
                .await
                .map(|_| ()),
            Op::Subscribe(channel) => subscriber.subscribe(&channel).await,
            Op::Unsubscribe(channel) => subscriber.unsubscribe(&channel).await,
        };
        match outcome {
            Ok(()) => mark(&state, true),
            Err(err) => {
                // 落とすだけにする。**揮発の知らせなので、消えても DB が正**
                tracing::warn!("連絡係へ渡せませんでした: {err}");
                mark(&state, false);
            }
        }
    }
}

/// 届いたものを流す。
async fn pump(
    mut push: mpsc::UnboundedReceiver<PushInfo>,
    incoming: mpsc::UnboundedSender<BusMessage>,
    state: Arc<watch::Sender<BusState>>,
) {
    while let Some(info) = push.recv().await {
        match info.kind {
            PushKind::Message => {
                let Some(message) = as_message(info) else {
                    continue;
                };
                if incoming.send(message).is_err() {
                    break;
                }
            }
            // 切れた。**中の配信は生きている**ので、止めるのは跨ぎのぶんだけ（設計§12）
            PushKind::Disconnection => {
                tracing::warn!("連絡係との接続が切れました。跨ぎの更新だけが止まります");
                mark(&state, false);
            }
            // 繋がり直して購読が張り直された合図。ここから先は届く
            PushKind::Subscribe => mark(&state, true),
            _ => {}
        }
    }
}

/// pub/sub の1通を取り出す。
fn as_message(info: PushInfo) -> Option<BusMessage> {
    let mut data = info.data.into_iter();
    let channel = String::from_redis_value(data.next()?).ok()?;
    let payload = Vec::<u8>::from_redis_value(data.next()?).ok()?;
    Some(BusMessage {
        channel,
        payload: Bytes::from(payload),
    })
}

/// 状態を書き換える。**受け手が居なくても書く**（`send` は受け手が居ないと値を残さない）。
fn mark(state: &watch::Sender<BusState>, ok: bool) {
    let next = if ok { BusState::Ok } else { BusState::Degraded };
    if *state.borrow() != next {
        state.send_replace(next);
    }
}

/// 配る側・視聴リース側の接続の設定。
///
/// **自動再購読を付けてはいけない。** 受け取り口（push sender）を持たない接続に
/// 付けると、redis は接続そのものを断る（`Cannot set resubscribe_automatically
/// without setting a push sender`）——compose で2台立てて実際に踏んだ。
pub fn command_config() -> ConnectionManagerConfig {
    ConnectionManagerConfig::new()
        .set_connection_timeout(Some(CONNECT_TIMEOUT))
        .set_response_timeout(Some(RESPONSE_TIMEOUT))
}

/// 購読側の接続の設定。**自動再購読をここで必ず有効にする。**
///
/// 既定は無効で、忘れると繋ぎ直した後に購読だけが静かに失われる（エラーは出ない）。
/// 有効であることは下のテストが機械で確かめる。
pub fn subscriber_config(push: mpsc::UnboundedSender<PushInfo>) -> ConnectionManagerConfig {
    command_config()
        .set_push_sender(push)
        .set_automatic_resubscription()
}

/// 接続先に RESP3 を指定する（無ければ足す）。
///
/// redis の pub/sub は RESP3 でしか使えないので、素の URL のままだと購読が実行時に
/// 断られる。設計§14-1 の例（`redis://valkey:6379`）をそのまま書いた利用者が
/// **起動はできるのに跨ぎだけ動かない**状態に落ちるのを防ぐ。
pub fn normalize_url(url: &str) -> String {
    if url.contains("protocol=") {
        return url.to_string();
    }
    if url.contains('?') {
        format!("{url}&protocol=resp3")
    } else {
        format!("{url}?protocol=resp3")
    }
}

/// ログへ出す用に、あれば認証情報を伏せる。
fn masked(url: &str) -> String {
    match (url.find("://"), url.find('@')) {
        (Some(scheme), Some(at)) if at > scheme => {
            format!("{}//***@{}", &url[..scheme + 1], &url[at + 1..])
        }
        _ => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 購読側は自動再購読を必ず有効にしている() {
        // **既定は無効**。ここが false のまま出荷すると、繋ぎ直した後で購読だけが
        // 静かに失われる——エラーは出ず、ただ何も届かなくなる（テスト計画F6）
        let (push, _rx) = mpsc::unbounded_channel();
        assert!(
            subscriber_config(push).automatic_resubscription(),
            "自動再購読が無効のままです"
        );
    }

    #[test]
    fn 配る側には自動再購読を付けない() {
        // 受け取り口を持たない接続に付けると、redis は**接続そのものを断る**。
        // 「両方に同じ設定を渡す」書き方にすると、起動した瞬間に全部止まる
        assert!(
            !command_config().automatic_resubscription(),
            "受け取り口の無い接続に自動再購読が付いています"
        );
    }

    #[test]
    fn 接続先に_RESP3_を必ず指定する() {
        assert_eq!(
            normalize_url("redis://valkey:6379"),
            "redis://valkey:6379?protocol=resp3"
        );
        // 既に何か付いているなら足す側に回る
        assert_eq!(
            normalize_url("redis://valkey:6379?db=1"),
            "redis://valkey:6379?db=1&protocol=resp3"
        );
        // 明示されているものは尊重する（RESP2 を選ぶ判断は利用者のもの）
        assert_eq!(
            normalize_url("redis://valkey:6379?protocol=resp2"),
            "redis://valkey:6379?protocol=resp2"
        );
    }

    #[test]
    fn ログには認証情報を出さない() {
        assert_eq!(
            masked("redis://user:secret@valkey:6379"),
            "redis://***@valkey:6379"
        );
        assert_eq!(masked("redis://valkey:6379"), "redis://valkey:6379");
    }
}
