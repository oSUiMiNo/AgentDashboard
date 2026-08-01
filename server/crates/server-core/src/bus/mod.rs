//! インスタンスの間の連絡係（セルフホスト化設計§9）。
//!
//! # 何を運ぶ相手なのか
//!
//! **耐久データは運ばない。** カードも履歴も真実は DB にあり（設計§9-1）、ここを流れるのは
//! 「いま何が起きたか」という**揮発の知らせ**だけになる。理由は Valkey の pub/sub が
//! at-most-once だから——切れている間のメッセージは消える。消えて困るものを預けてはいけない。
//!
//! だから配線の順序は常に **DB へ書く → プロセス内へ配る → 連絡係へも流す** になる。
//! 連絡係が丸ごと死んでも、各インスタンスの中で完結する配信は動き続ける（設計§12）。
//!
//! # なぜ境界にしてあるのか
//!
//! 実装は2つある。
//!
//! | 実装 | 何者か |
//! |---|---|
//! | [`valkey::ValkeyBus`] | 本物。複数インスタンスの運用で使う |
//! | [`memory::MemoryBroker`] | 同じプロセスの中だけで配る偽物。**テスト専用ではなく検証の主戦場** |
//!
//! 本物を相手にするには docker が要り、それは `make ci` に入れない約束になっている
//! （設計§15-3）。境界を1枚置いて偽物を差せるようにしてあるので、跨ぎ配信・視聴リース・
//! 番号の飛び・断の縮退といった**判断のロジックは docker 無しで守れる**。本物でしか
//! 出ない食い違い（RESP3・再購読・healthcheck の順序）は compose 側が受け持つ。
//!
//! ローカルモードは連絡係を持たない（設計§9-1）。`valkey_url` が無ければ、配信は
//! フェーズ5 までと1バイトも変わらない。
//!
//! # 名前で分ける
//!
//! チャネル名にアカウントを含めてある（[`account_events`]）。**他人のアカウントの
//! チャネルは名前を作れないので購読できない**——テナント分離（設計§8-6）が、
//! 判定ではなく名前で効く形になっている。受け取った側が持ち主を知るのに封筒の中身を
//! 信じないのはこのためで、[`parse_account_events`] が**チャネル名の方を正**とする。

pub mod memory;
pub mod valkey;

use bytes::Bytes;
use protocol::{AgentId, CardId};
use serde::{Serialize, de::DeserializeOwned};
use tokio::sync::watch;
use uuid::Uuid;

/// 連絡係が運ぶ1通。
#[derive(Debug, Clone)]
pub struct BusMessage {
    pub channel: String,
    pub payload: Bytes,
}

/// 連絡係が生きているか（設計§12 の Valkey 断の行）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BusState {
    Ok,
    /// 繋がっていない。**インスタンスを跨ぐ更新だけが止まる**（中の配信は動く）
    Degraded,
}

#[derive(Debug, thiserror::Error)]
pub enum BusError {
    #[error("連絡係に繋がっていません")]
    Disconnected,
    #[error("連絡係が応じません: {0}")]
    Failed(String),
}

/// インスタンスの間の連絡係。
///
/// # 配るのを待たない
///
/// [`Bus::publish`] は同期で、送れたかどうかを返さない。ここで待つと、**跨ぎの配信が
/// セッションの実行を遅らせる**ことになる（フェーズ2 の報告経路と同じ判断）。
/// 順序は実装側が1本の待ち行列で守るので、`TranscriptReset` が `TranscriptAppend` に
/// 追い越されることはない（設計§6-2）。
#[async_trait::async_trait]
pub trait Bus: Send + Sync + 'static {
    /// 1通配る。**届いたかどうかは返らない**（揮発の知らせなので、消えても DB が正）。
    fn publish(&self, channel: &str, payload: Bytes);

    /// 購読を開ける。既に開いていれば何も起きない。
    fn subscribe(&self, channel: &str);

    /// 購読を閉じる。
    fn unsubscribe(&self, channel: &str);

    /// 「このインスタンスはまだ見ている」と記す（設計§9-4 の視聴リース）。
    ///
    /// 時刻を添えるので、**インスタンスが異常終了しても古くなって自然に消える**。
    /// 明示的な解放を待たない作りにしてあるのは、待つと落ちた瞬間に誰も解放できないため。
    async fn lease_touch(&self, key: &str, member: &str, at_ms: i64) -> Result<(), BusError>;

    /// 自分の印を消す（見るのをやめた）。
    async fn lease_release(&self, key: &str, member: &str) -> Result<(), BusError>;

    /// 生きている印だけを名前で取り出す（掃除はしない）。
    ///
    /// 数えるだけでは足りない相手がある——**どの PC が繋がっているか**は、
    /// 数ではなく名前で要る（設計§9-2 の `agent:{id}:cmd` の宛先探し）。
    async fn lease_members(&self, key: &str, newer_than_ms: i64) -> Result<Vec<String>, BusError>;

    /// 古い印を掃除して、残った数を返す。
    ///
    /// 0 が返ったら**誰も見ていない**ので、画面を作るのをやめてよい（設計§7-4）。
    async fn lease_sweep(&self, key: &str, older_than_ms: i64) -> Result<u64, BusError>;

    /// 繋がっているか。**変化を見張れる形で返す**（縮退バナーの出し入れに使う）。
    fn state(&self) -> watch::Receiver<BusState>;
}

// --- チャネル名（設計§9-2）---------------------------------------------------
//
// 作る側と読む側を必ず対で置く。名前の綴りを各所に散らすと、片方だけ直したときに
// **黙って誰にも届かなくなる**（購読しているチャネルに誰も publish しない、という
// 壊れ方はログにも出ない）。

const ACCOUNT_PREFIX: &str = "acct:";
const ACCOUNT_SUFFIX: &str = ":events";
const AGENT_PREFIX: &str = "agent:";
const AGENT_SUFFIX: &str = ":cmd";
const CARD_PREFIX: &str = "card:";
const CARD_SUFFIX: &str = ":screen";
const VIEWERS_PREFIX: &str = "screen_viewers:";
/// 繋がっている PC の控え（sorted set の鍵）。**アカウントでは分けない**——
/// 名前（UUID）が偶然ぶつかることは無く、読む側は必ず自分のアカウントの `agents` と
/// 突き合わせてから使う（設計§8-6 の絞り込みは DB 側で効く）。
const AGENTS_ONLINE: &str = "agents_online";

/// そのアカウントのブラウザ向けの知らせ。
pub fn account_events(account_id: Uuid) -> String {
    format!("{ACCOUNT_PREFIX}{account_id}{ACCOUNT_SUFFIX}")
}

/// その PC への指示。
pub fn agent_cmd(agent_id: AgentId) -> String {
    format!("{AGENT_PREFIX}{}{AGENT_SUFFIX}", agent_id.0)
}

/// そのカードの画面。
pub fn card_screen(card_id: CardId) -> String {
    format!("{CARD_PREFIX}{}{CARD_SUFFIX}", card_id.0)
}

/// そのカードを見ているインスタンスの控え（sorted set の鍵）。
pub fn screen_viewers(card_id: CardId) -> String {
    format!("{VIEWERS_PREFIX}{}", card_id.0)
}

/// 繋がっている PC の控え。
pub fn agents_online() -> &'static str {
    AGENTS_ONLINE
}

/// アカウントの知らせのチャネルなら、そのアカウント。
///
/// **持ち主はここで決める。** 封筒の中に書いてあるアカウントを信じると、名前で分けた
/// 意味が無くなる（届いた先で「実は別のアカウント宛て」と言えてしまう）。
pub fn parse_account_events(channel: &str) -> Option<Uuid> {
    parse_between(channel, ACCOUNT_PREFIX, ACCOUNT_SUFFIX)?
        .parse()
        .ok()
}

pub fn parse_agent_cmd(channel: &str) -> Option<AgentId> {
    Some(AgentId(
        parse_between(channel, AGENT_PREFIX, AGENT_SUFFIX)?
            .parse()
            .ok()?,
    ))
}

pub fn parse_card_screen(channel: &str) -> Option<CardId> {
    Some(CardId(
        parse_between(channel, CARD_PREFIX, CARD_SUFFIX)?
            .parse()
            .ok()?,
    ))
}

fn parse_between<'a>(value: &'a str, prefix: &str, suffix: &str) -> Option<&'a str> {
    value.strip_prefix(prefix)?.strip_suffix(suffix)
}

// --- 封筒 --------------------------------------------------------------------

/// 発信元を添えて JSON にする。
///
/// # 自分が出したものを自分で受け取る
///
/// pub/sub は購読していれば**自分の publish も返ってくる**。発信元を書いておかないと、
/// 受けた側がもう一度取り込んで配り直し、それがまた返ってきて止まらなくなる。
pub fn encode_json<T: Serialize>(from: Uuid, body: &T) -> Bytes {
    #[derive(Serialize)]
    struct Outgoing<'a, T> {
        from: Uuid,
        body: &'a T,
    }
    match serde_json::to_vec(&Outgoing { from, body }) {
        Ok(bytes) => Bytes::from(bytes),
        // 自分の型を自分でシリアライズできない場合は実装の誤りなので、握り潰さず記録する
        Err(err) => {
            tracing::error!("連絡係へ渡す中身を作れません: {err}");
            Bytes::new()
        }
    }
}

/// [`encode_json`] の対。読めなければ `None`（知らない版のインスタンスが混ざった場合）。
pub fn decode_json<T: DeserializeOwned>(payload: &[u8]) -> Option<(Uuid, T)> {
    #[derive(serde::Deserialize)]
    struct Incoming<T> {
        from: Uuid,
        body: T,
    }
    match serde_json::from_slice::<Incoming<T>>(payload) {
        Ok(incoming) => Some((incoming.from, incoming.body)),
        Err(err) => {
            tracing::warn!("連絡係から届いた中身を解釈できません: {err}");
            None
        }
    }
}

/// 発信元を頭に付けてバイト列にする（画面のフレーム用）。
///
/// JSON に包まないのは、**画面が最も量の多い相手**だから（設計§9-5）。16バイト足すだけで
/// 済ませる。
pub fn encode_binary(from: Uuid, body: &[u8]) -> Bytes {
    let mut bytes = Vec::with_capacity(16 + body.len());
    bytes.extend_from_slice(from.as_bytes());
    bytes.extend_from_slice(body);
    Bytes::from(bytes)
}

/// [`encode_binary`] の対。
pub fn decode_binary(payload: &[u8]) -> Option<(Uuid, &[u8])> {
    if payload.len() < 16 {
        return None;
    }
    let (head, rest) = payload.split_at(16);
    let mut raw = [0u8; 16];
    raw.copy_from_slice(head);
    Some((Uuid::from_bytes(raw), rest))
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    /// 名前がアカウントで分かれていること（テスト計画F6「acct スコープの機械検査」）。
    ///
    /// これが破れると、テナント分離が「判定を書き忘れていないか」の話に落ちる。
    /// 名前で分かれているうちは、**他人のチャネルは名前を作れないので購読できない**。
    #[test]
    fn 知らせのチャネルはアカウントごとに別の名前になる() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        assert_ne!(account_events(a), account_events(b));
        // 名前の中にアカウントが入っていること（入っていなければ分かれようがない）
        assert!(account_events(a).contains(&a.to_string()));
        // 作った名前から持ち主を取り出せること。**受け取る側はこちらを正とする**
        assert_eq!(parse_account_events(&account_events(a)), Some(a));
        assert_ne!(parse_account_events(&account_events(a)), Some(b));
    }

    #[test]
    fn 種類の違うチャネルを取り違えない() {
        let account = Uuid::new_v4();
        let agent = AgentId(Uuid::new_v4());
        let card = CardId(Uuid::new_v4());

        // 3種類は互いに読めない。読めてしまうと、画面のフレームを知らせとして
        // 解釈するような壊れ方をする
        assert_eq!(parse_account_events(&agent_cmd(agent)), None);
        assert_eq!(parse_account_events(&card_screen(card)), None);
        assert_eq!(parse_agent_cmd(&account_events(account)), None);
        assert_eq!(parse_card_screen(&account_events(account)), None);

        assert_eq!(parse_agent_cmd(&agent_cmd(agent)), Some(agent));
        assert_eq!(parse_card_screen(&card_screen(card)), Some(card));
    }

    #[test]
    fn 発信元を添えて往復できる() {
        let me = Uuid::new_v4();
        let payload = encode_json(me, &"こんにちは".to_string());
        let (from, body) = decode_json::<String>(&payload).expect("読めること");
        assert_eq!(from, me);
        assert_eq!(body, "こんにちは");

        let payload = encode_binary(me, b"\x01\x02\x03");
        let (from, body) = decode_binary(&payload).expect("読めること");
        assert_eq!(from, me);
        assert_eq!(body, b"\x01\x02\x03");
    }

    #[test]
    fn 短すぎるバイト列は発信元として読まない() {
        // 知らない版のインスタンスが混ざったときに、頭の16バイトを勝手に切り取らない
        assert!(decode_binary(b"\x01\x02").is_none());
    }
}
