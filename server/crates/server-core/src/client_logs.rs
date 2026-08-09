//! ブラウザで起きたことを受け取る口（設計§12）。
//!
//! # なぜ鍵の外側なのか
//!
//! 鍵の内側に置くと、**ログイン画面とセットアップ画面で起きたエラーが1件も届かない**
//! （設計§12-3）。そこがいちばん報告しづらく、いちばん欲しい。「扉は開けるが中身は
//! 返さない」という既存の考え方（セルフホスト化設計§8-1）をそのまま延長する——
//! **この口は何も返さない。**
//!
//! 外側に置くぶん、待ち受けを広げている構成では**無認証で書き込める口**になる。だから
//! 上限を厳しくし（§23-5）、未認証ぶんは別のファイルへ隔離する。
//!
//! # 書き手はここに居ない
//!
//! ログを書く土台（7欄の整形・appender・掃除）は `session-host-core` にあるが、
//! **このクレートはあちらに依存できない**——`crates/core/tests/dependencies.rs` が
//! 「`server-core` から `portable-pty` / `vt100` へ辿れないこと」を推移的に検査しており、
//! `session-host-core` は両方を通常依存に持つ。
//!
//! そこで [`crate::session_host::SessionHost`] とまったく同じ形にする。**ここは境界
//! trait（[`ClientLogSink`]）だけを持ち、実体は両方に依存できる `crates/core` が
//! 差し込む。**

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    Json, Router,
    extract::{ConnectInfo, FromRequestParts, State},
    http::{StatusCode, request::Parts},
    routing::post,
};
use protocol::{
    CardId,
    client_log::{
        ClientLogBatch, ClientLogDrops, ClientLogEntry, MAX_ANON_DAILY_BYTES, MAX_BATCH_BYTES,
        MAX_BATCH_ENTRIES, MAX_PER_MINUTE,
    },
};
use tower_sessions::Session;
use uuid::Uuid;

use crate::{auth::AuthContext, registry::SessionRegistry};

/// 頻度を数える窓の長さ。**設定キーにはしない**（設計§7-3）。
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// `drops` だけの行1本を、未認証の1日の合計へ計上するときの見積り。
///
/// **0 で通してはいけない。** 中身が無くても行はディスクへ書かれるので、0 を計上すると
/// 「中身の無い要求」だけが容量の門を素通りする道になる。実際の1行は 100 バイト前後
/// （7欄＋2つの数）なので、少し多めに採って上限側へ倒してある。
const DROPS_LINE_BYTES: u64 = 128;

/// 受け取った行の書き出し先（境界）。
///
/// 実体は `agentdashboard_core::client_logs::LoggingSink`。**ここに実装を置かない**のが
/// このトレイトの存在理由で、理由はモジュール冒頭のとおり。
pub trait ClientLogSink: Send + Sync + 'static {
    /// `anon` が真なら未認証ぶん（`browser-anon-*`）へ。
    fn write(&self, anon: bool, entries: &[ClientLogEntry], drops: ClientLogDrops);
}

/// この口が使う材料。
#[derive(Clone)]
pub struct ClientLogState {
    auth: Arc<AuthContext>,
    /// `card_id` から `agent_id` を引くため（設計§12-5）。**アカウントで絞って引く**
    registry: Arc<SessionRegistry>,
    /// 書き出し先。**差し込まれていなければ、受け取って捨てる**——口が 404 に
    /// 変わると「繋がらない」と「残さない」がブラウザから区別できなくなる
    sink: Option<Arc<dyn ClientLogSink>>,
    gate: Arc<Gate>,
}

/// ブラウザ向けのルート。**`guard()` の外側へ merge する**（設計§12-3）。
pub fn routes(
    auth: Arc<AuthContext>,
    registry: Arc<SessionRegistry>,
    sink: Option<Arc<dyn ClientLogSink>>,
) -> Router {
    Router::new()
        .route("/api/client-logs", post(api_client_logs))
        .with_state(ClientLogState {
            auth,
            registry,
            sink,
            gate: Arc::new(Gate::default()),
        })
}

/// `POST /api/client-logs` — ブラウザで起きたことを受け取る。
///
/// **何も返さない。** 断ったかどうかも返さない——返すと、口の向こうの状態を外から
/// 数えられる。断った件数はログの行に `refused` として残る。
async fn api_client_logs(
    State(state): State<ClientLogState>,
    session: Session,
    Peer(peer): Peer,
    Json(batch): Json<ClientLogBatch>,
) -> StatusCode {
    // **接続そのものを見る。** `X-Forwarded-For` の類は読まない（§8-3 と同じ理由で、
    // ヘッダ1行で相手を名乗り分けられては数える意味が無い）
    let from_loopback = peer.is_some_and(|addr| addr.ip().is_loopback());
    let identity = state.auth.identify(&session, from_loopback).await;
    let anon = identity.is_none();

    let mut drops = ClientLogDrops {
        browser: batch.dropped,
        refused: 0,
    };

    // ① 件数と大きさを**重ねて掛ける**（`fs::MAX_ENTRIES` ＋ `MAX_LISTING_BYTES` の型紙）
    let mut entries: Vec<ClientLogEntry> = Vec::new();
    let mut bytes = 0usize;
    for mut entry in batch.entries {
        if entries.len() >= MAX_BATCH_ENTRIES {
            drops.refused += 1;
            continue;
        }
        entry.clamp();
        // **通ったぶんだけ数える。** 先に足してから断ると、上限を跨いだ1件の大きさが
        // 残り続け、`bytes > MAX_BATCH_BYTES` が真のまま以降を全部巻き添えにする——
        // 入るはずだった小さい行が、前に居た大きい行のせいで消える
        let next = bytes + entry.size_bytes();
        if next > MAX_BATCH_BYTES {
            drops.refused += 1;
            continue;
        }
        bytes = next;
        entries.push(entry);
    }

    // ② 頻度。**認証済みはアカウント、未認証は接続元アドレス**（§23-5）
    let who = match &identity {
        Some(identity) => Who::Account(identity.account_id),
        // 接続元が分からないときは**まとめて1つの相手として数える**（安全側）。
        // 分からないものを別扱いにすると、そこだけ上限が効かない道ができる
        None => Who::Peer(peer.map_or(IpAddr::from([0, 0, 0, 0]), |addr| addr.ip())),
    };
    // **数えるのは「行」ではなく「書き込み」。** `drops` だけの行も1本はディスクへ
    // 落ちるので、中身が空でも最低1枠を要求する。ここを `entries.len()` のままにすると、
    // 空のバッチ（`{"entries":[],"dropped":1}`）が**どちらの門にも当たらないまま**
    // 1リクエストにつき1行を書ける道になる——掃除は起動時に1回だけなので（設計§6-2）、
    // 動かしている間は回収されない
    let want = entries.len().max(1);
    let allowed = state.gate.take(who, want, Instant::now());
    if allowed < entries.len() {
        drops.refused += (entries.len() - allowed) as u32;
        entries.truncate(allowed);
    }
    // 枠が1つも取れなかったなら**何も書かない。** `entries` が全部断られた要求でも
    // `drops` の行は書けてしまう、というのが穴の本体だった
    let mut may_write = allowed > 0;

    // ③ 未認証ぶんは1日の合計にも上限を置く
    if anon && may_write {
        let want: u64 = entries
            .iter()
            .map(|entry| entry.size_bytes() as u64)
            .sum::<u64>()
            .max(DROPS_LINE_BYTES);
        if !state.gate.take_anon_bytes(want) {
            drops.refused += entries.len() as u32;
            entries.clear();
            may_write = false;
        }
    }

    // ④ `card_id` から `agent_id` を引く。**引くのは受ける側の仕事**（§12-5）で、
    // ブラウザが名乗ってきた値は必ず捨てる
    for entry in &mut entries {
        entry.agent_id = identity
            .as_ref()
            .zip(entry.card_id.as_deref())
            .and_then(|(identity, card_id)| {
                let card_id = CardId(Uuid::parse_str(card_id).ok()?);
                state.registry.owned(identity.account_id, card_id)
            })
            .and_then(|record| record.meta().agent_id)
            .map(|agent_id| agent_id.to_string());
    }

    if let Some(sink) = &state.sink
        && may_write
        && (!entries.is_empty() || !drops.is_empty())
    {
        sink.write(anon, &entries, drops);
    }

    StatusCode::NO_CONTENT
}

/// 接続元のアドレス。**無ければ無いまま渡す。**
///
/// `Option<ConnectInfo<..>>` は抽出子にならない（axum 0.8）ので、自分で1つ書く。
/// 素の `ConnectInfo<SocketAddr>` にすると、接続元を渡さない形で待ち受けている
/// テストの土台で**500 になる**——鍵の外側の口が落ちるのは、いちばん困る形である。
struct Peer(Option<SocketAddr>);

impl<S: Send + Sync> FromRequestParts<S> for Peer {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Peer(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|ConnectInfo(addr)| *addr),
        ))
    }
}

/// 誰として数えるか。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Who {
    Account(Uuid),
    Peer(IpAddr),
}

/// 頻度と、未認証ぶんの1日の合計を数える門。
#[derive(Default)]
struct Gate {
    per_minute: Mutex<HashMap<Who, Window>>,
    anon_day: Mutex<Option<AnonDay>>,
}

struct Window {
    started: Instant,
    used: u32,
}

struct AnonDay {
    day: time::Date,
    bytes: u64,
}

impl Gate {
    /// `want` 件のうち、通してよい件数を返す。
    fn take(&self, who: Who, want: usize, now: Instant) -> usize {
        let mut windows = self
            .per_minute
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        // 古い窓は捨てる。**放っておくと、繋いだ相手のぶんだけ増え続ける**
        windows.retain(|_, window| now.saturating_duration_since(window.started) < RATE_WINDOW);

        let window = windows.entry(who).or_insert(Window {
            started: now,
            used: 0,
        });
        if now.saturating_duration_since(window.started) >= RATE_WINDOW {
            window.started = now;
            window.used = 0;
        }
        let room = MAX_PER_MINUTE.saturating_sub(window.used) as usize;
        let take = want.min(room);
        window.used += take as u32;
        take
    }

    /// 未認証ぶんの1日の合計に `want` バイト足せるか。
    fn take_anon_bytes(&self, want: u64) -> bool {
        let today = time::OffsetDateTime::now_utc().date();
        let mut day = self
            .anon_day
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = day.get_or_insert(AnonDay {
            day: today,
            bytes: 0,
        });
        if entry.day != today {
            entry.day = today;
            entry.bytes = 0;
        }
        if entry.bytes + want > MAX_ANON_DAILY_BYTES {
            return false;
        }
        entry.bytes += want;
        true
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 頻度の上限を超えたぶんだけ断る() {
        let gate = Gate::default();
        let who = Who::Account(Uuid::from_u128(7));
        let now = Instant::now();

        assert_eq!(gate.take(who, 100, now), 100);
        // 残りは20件
        assert_eq!(gate.take(who, 50, now), 20);
        assert_eq!(gate.take(who, 1, now), 0);
    }

    #[test]
    fn 窓が明けたら数え直す() {
        let gate = Gate::default();
        let who = Who::Peer(IpAddr::from([127, 0, 0, 1]));
        let now = Instant::now();

        assert_eq!(gate.take(who, MAX_PER_MINUTE as usize, now), 120);
        let later = now + RATE_WINDOW + Duration::from_secs(1);
        assert_eq!(gate.take(who, 10, later), 10, "窓が明けたら通ること");
    }

    #[test]
    fn 相手が違えば別々に数える() {
        let gate = Gate::default();
        let now = Instant::now();
        let 甲 = Who::Account(Uuid::from_u128(1));
        let 乙 = Who::Account(Uuid::from_u128(2));

        assert_eq!(gate.take(甲, MAX_PER_MINUTE as usize, now), 120);
        assert_eq!(gate.take(乙, 5, now), 5, "別の相手が巻き添えにならないこと");
    }

    #[test]
    fn 未認証ぶんは1日の合計でも止まる() {
        let gate = Gate::default();
        assert!(gate.take_anon_bytes(MAX_ANON_DAILY_BYTES));
        assert!(!gate.take_anon_bytes(1), "超えたら断ること");
    }
}
