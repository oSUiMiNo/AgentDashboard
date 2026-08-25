//! カードの記録（セルフホスト化設計§3-2・§3-3）。
//!
//! # ここが「サーバから見たセッション」
//!
//! PTY も claude のプロセスも持たない。持っているのは**記録**——DB に書いた内容と、
//! それをブラウザへ配るための口だけ。実体（[`crate::session_host::SessionHost`] の向こう）とは
//! 完全に分かれていて、フェーズ1 で切った境界（設計§2-3）の、記録側の中身にあたる。
//!
//! フェーズ1 でここを作らなかったのは、写しを持つと**実体と二重化して起動直後の
//! カードを取りこぼす窓**が生まれるためだった（設計§18 読み替え1）。DB が真実になった
//! いまはその窓を塞げる——**書いてから配る**（§9-1）ので、ブラウザが知った時点で
//! DB には必ず入っている。
//!
//! # 何が来ても、まず書く
//!
//! セッションホストからの報告は [`SessionRegistry::apply`] を通る。ここでの順序は
//! 「DB へ書く → ブラウザへ配る」で固定する。**書けなかったものは配らない**——
//! 配ってしまうと、画面には出るのに再読み込みで消える（嘘になる）。代わりに
//! エラーを配ってバナーに出す（設計§12 の DB 断の行）。
//!
//! 揮発の知らせ（パーサの健康状態・自己修復の進行・操作の失敗）は DB へ書かずに
//! 素通しする。真実として残す性質のものではない。

use crate::{
    bus::{self, Bus},
    db::{self, entity, transcript as db_transcript},
    transcript::TranscriptWindow,
};
use protocol::{
    AgentId, CardId, ClaudeSessionId, ModelId, NodeId, PermissionMode, ProjectId, SessionMeta,
    SessionStatus, TreeNode, ws::ServerMessage,
};
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::broadcast;
use uuid::Uuid;

/// 一覧の更新通知の待ち行列（メッセージ数）。
///
/// 取りこぼした購読者は `GET /api/sessions` で取り直せる（[`crate::ws`]）ので、
/// ここで待たない。一覧の更新がセッションの実行を遅らせてはいけない。
const EVENT_QUEUE_MESSAGES: usize = 256;

/// 在席の印がこれだけ古くなったら死んだものとみなす（ミリ秒。設計§9-4）。
///
/// 記す側（[`crate::gateway`]）と同じ値でなければならない。ずれると、記し直す前に
/// 消えたり、落ちた PC がいつまでも生きて見えたりする。
pub const PRESENCE_TTL_MS: i64 = 30_000;

/// 履歴購読1本あたりの配信待ち行列（メッセージ数）。
pub const TRANSCRIPT_QUEUE_MESSAGES: usize = 64;

/// 履歴1ページ分（`GET /api/sessions/{card_id}/transcript` の応答）。
///
/// `Deserialize` も持つのは、CLI（`agentdashboard session transcript`）が同じ型で
/// 応答を読み戻すため（CLI設計§6-3）。CLI 側に写しの型を定義しない。
#[derive(Debug, Serialize, Deserialize)]
pub struct TranscriptPage {
    pub nodes: Vec<TreeNode>,
    /// さらに前があるかもしれない
    pub has_more: bool,
}

/// 報告の出どころ（セルフホスト化設計§5-1 の手順4）。
///
/// **帰属を決めるのはサーバの仕事**なので、セッションホストが `SessionMeta` に何を書いて
/// 寄越しても、記録に残る `agent_id` と `account_id` はここの値で上書きする。ローカル
/// モードは「1つのアカウントの、PC という単位が無い報告」として同じ形に流し込む。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportOrigin {
    pub account_id: Uuid,
    /// どの PC からか。**ローカルモードは `None`**（結び付ける `agents` の行が無い）
    pub agent_id: Option<AgentId>,
    /// 画面に出すアカウント名。ローカルはアカウントを表に出さないので `None`
    pub account: Option<String>,
}

impl ReportOrigin {
    /// ローカルモードの出どころ。
    pub fn local() -> Self {
        Self {
            account_id: db::LOCAL_ACCOUNT_ID,
            agent_id: None,
            account: None,
        }
    }
}

/// 履歴のページを作れなかった理由。
#[derive(Debug, PartialEq, Eq)]
pub enum PageError {
    /// そのカードを知らない
    NotFound,
    /// DB に聞けなかった。
    ///
    /// **パーサの縮退ではここへ来ない**のが初期実装との違い。読み先が JSONL から DB へ
    /// 変わったので、パーサが止まっていても DB にある範囲は返せる（設計§3-3 の改善）。
    Unavailable,
}

/// 一覧の更新通知。**誰のカードの話か**を添えて配る。
///
/// 配信の口を1本にしたまま、購読側が自分のアカウントのぶんだけを拾えるようにするための形
/// （設計§8-6）。アカウントごとにチャネルを分けるのはインスタンスを跨ぐとき（§9-2）の話で、
/// 1インスタンスのうちは**配るときに絞る**ほうが、購読の作りが1つで済む。
#[derive(Debug, Clone)]
pub struct AccountEvent {
    pub account_id: Uuid,
    pub message: ServerMessage,
}

/// カード1枚の記録。
pub struct SessionRecord {
    pub card_id: CardId,
    /// 誰のカードか（設計§8-6）。**帰属は接続が決める**ので、ここは書き換わらない
    pub account_id: Uuid,
    meta: Mutex<SessionMeta>,
    /// 直近ぶんの写し（設計§3-3）。真実は DB
    window: Mutex<TranscriptWindow>,
    /// 履歴の配信。**購読しているクライアントにだけ**流す（一覧の配信とは別口）
    transcript_tx: broadcast::Sender<Arc<String>>,
    /// 次に振る `seq`。書き込みは1本の経路を通るので、ここで直列化すれば足りる
    next_seq: tokio::sync::Mutex<i64>,
    /// この記録を持っている相手が、いま報告してきているか（設計§6-3）。
    ///
    /// ローカルモードでは「前回の起動が残した記録」が `false` になる。PTY は
    /// 再起動で道連れなので、戻ってきたカードは履歴だけが読める抜け殻になる。
    live: AtomicBool,
}

impl SessionRecord {
    fn new(
        meta: SessionMeta,
        account_id: Uuid,
        window_nodes: usize,
        next_seq: i64,
        live: bool,
    ) -> Self {
        Self {
            card_id: meta.card_id,
            account_id,
            meta: Mutex::new(meta),
            window: Mutex::new(TranscriptWindow::new(window_nodes)),
            transcript_tx: broadcast::channel(TRANSCRIPT_QUEUE_MESSAGES).0,
            next_seq: tokio::sync::Mutex::new(next_seq),
            live: AtomicBool::new(live),
        }
    }

    /// いまのカード情報。**接続の鮮度はここで被せる**（DB には持たない）。
    pub fn meta(&self) -> SessionMeta {
        let mut meta = self.meta.lock().expect("ロックが壊れていない").clone();
        meta.agent_connected = self.live.load(Ordering::Relaxed);
        meta
    }

    /// カード情報を入れ替える。**鮮度の印は渡された値に従う。**
    ///
    /// 自分の受け口から来た報告は「いま届いた」ので必ず繋がっている（セッションホスト側が
    /// `true` を立てて寄越す）。他インスタンスから回ってきたものは向こうの見立てが正で、
    /// ここで `true` に塗り替えると**切断の知らせが跨いだ瞬間に消える**。
    fn store_meta(&self, meta: SessionMeta) {
        self.live.store(meta.agent_connected, Ordering::Relaxed);
        *self.meta.lock().expect("ロックが壊れていない") = meta;
    }

    /// 履歴の購読を、いま持っているぶんの取得と**同じロックの中で**始める。
    ///
    /// 取得と購読開始がずれると、その隙間に届いたノードを取りこぼす。逆側にずれた
    /// 場合は同じノードが二度届くが、履歴は「同じIDは上書き」なので害が無い。
    /// **迷ったら重ねる側に倒す。**
    pub fn subscribe_transcript(&self) -> (Vec<TreeNode>, broadcast::Receiver<Arc<String>>) {
        let window = self.window.lock().expect("ロックが壊れていない");
        let receiver = self.transcript_tx.subscribe();
        (window.snapshot(), receiver)
    }

    pub fn transcript_snapshot(&self) -> Vec<TreeNode> {
        self.window.lock().expect("ロックが壊れていない").snapshot()
    }

    /// 購読者が居るときだけ直列化して配る。
    ///
    /// 巨大な Edit の結果を JSON にする処理がコストの本体なので、誰も見ていないカードで
    /// それをやらない。窓の更新は購読の有無に関わらず続ける（開いた瞬間に履歴が出るのは
    /// このため）。
    fn fanout(&self, message: &ServerMessage) {
        if self.transcript_tx.receiver_count() == 0 {
            return;
        }
        if let Ok(text) = serde_json::to_string(message) {
            let _ = self.transcript_tx.send(Arc::new(text));
        }
    }
}

/// 全カードの記録と、その配信。
pub struct SessionRegistry {
    db: DatabaseConnection,
    records: Mutex<HashMap<CardId, Arc<SessionRecord>>>,
    events: broadcast::Sender<AccountEvent>,
    /// 失効した札（cli）の知らせ。**このインスタンスの `/ws` 接続を畳むためだけ**の道
    /// （コードレビュー対応3）。PC 側の失効（gateway の `disconnect_token`）と同じく
    /// インスタンス跨ぎは扱わない——よそのインスタンスの接続は、新しい要求が
    /// `resolve_token` で断られる形に任せる
    revocations: broadcast::Sender<Uuid>,
    window_nodes: usize,
    /// インスタンスを跨ぐ連絡係（設計§9）。**無ければプロセスの中で完結する**——
    /// ローカルモードと、インスタンスが1台だけのセルフホストがこれにあたる
    bus: Option<Arc<dyn Bus>>,
    /// このインスタンスの通し番号。**自分が出した知らせを自分で取り込まない**ための印
    instance_id: Uuid,
    /// アカウントごとの、いま繋がっているブラウザの数。
    ///
    /// 0→1 で知らせの購読を開け、1→0 で閉じる（設計§9-2）。**全アカウントを
    /// まとめて購読しない**のは、そうするとチャネル名でアカウントを分けた意味が
    /// 無くなるため（§8-6）——他人のチャネルは名前を作れないから購読できない、
    /// という形が分離の実体になっている
    browsers: Mutex<HashMap<Uuid, usize>>,
}

impl SessionRegistry {
    /// DB から復元して立ち上げる。
    ///
    /// 外していない（`archived=false`）カードを読み戻し、**すべて「接続していない」印**で
    /// 一覧に出す。ローカルモードでは、これが前回の起動が残した記録にあたる——
    /// 履歴は読めるが PTY は道連れで死んでいる（設計§1-3）。セルフホストモードでは、
    /// セッションホストが繋ぎ直してくるまでの間がこの状態になる（§6-3 と同じ見え方）。
    ///
    /// **全アカウントぶんを読む。** このインスタンスは誰のブラウザも受けるので、
    /// 読む時点で絞る相手が決まっていない。絞るのは配るとき・返すときで、
    /// その判定は [`SessionRecord::account_id`] が持つ（§8-6）。
    pub async fn load(
        db: DatabaseConnection,
        window_nodes: usize,
        bus: Option<Arc<dyn Bus>>,
    ) -> Result<Arc<Self>, anyhow::Error> {
        let rows = entity::sessions::Entity::find()
            .filter(entity::sessions::Column::Archived.eq(false))
            .order_by_asc(entity::sessions::Column::CreatedAt)
            .all(&db)
            .await?;

        // 画面に出すアカウント名（`SessionMeta::account`）は行に持っていないので、
        // まとめて引いておく。カードごとに引くと、復元するだけで枚数ぶんの問い合わせになる
        let names: HashMap<Uuid, String> = entity::accounts::Entity::find()
            .all(&db)
            .await?
            .into_iter()
            .map(|row| (row.id, row.name))
            .collect();

        let mut records = HashMap::new();
        for row in rows {
            let account_id = row.account_id;
            let mut meta = meta_from_row(row);
            // ローカルのアカウントは画面に出さない（アカウントという単位が無い）
            if account_id != db::LOCAL_ACCOUNT_ID {
                meta.account = names.get(&account_id).cloned();
            }
            let card_id = meta.card_id;
            let next_seq = db_transcript::next_seq(&db, card_id).await?;
            // 窓を DB の直近ぶんで満たす。空のままだと、購読を始めたクライアントに
            // 「履歴が無い」と見えてしまう（DB には残っているのに）。
            // **読み終えてからロックを取る**（ロックを持ったまま待たない）
            let latest = db_transcript::latest(&db, card_id, window_nodes).await?;
            // 前回の起動が残したカードなので live=false
            let record = SessionRecord::new(meta, account_id, window_nodes, next_seq, false);
            record
                .window
                .lock()
                .expect("ロックが壊れていない")
                .fill(latest);
            records.insert(card_id, Arc::new(record));
        }
        if !records.is_empty() {
            tracing::info!("前回の記録から {} 枚のカードを復元しました", records.len());
        }

        Ok(Arc::new(Self {
            db,
            records: Mutex::new(records),
            events: broadcast::channel(EVENT_QUEUE_MESSAGES).0,
            revocations: broadcast::channel(EVENT_QUEUE_MESSAGES).0,
            window_nodes,
            bus,
            instance_id: Uuid::new_v4(),
            browsers: Mutex::new(HashMap::new()),
        }))
    }

    /// このインスタンスの通し番号（視聴リースの名乗りにも使う。設計§9-4）。
    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }

    pub fn bus(&self) -> Option<&Arc<dyn Bus>> {
        self.bus.as_ref()
    }

    /// 記録そのもの。**カード以外の表**（PJT 枠など）を読み書きする口が使う。
    ///
    /// カードの読み書きはこの型のメソッド越しに行うこと——**外から直に触ると
    /// 「手元の写しと DB」の順序を守る場所が増える**（設計§9-1 の配線）。
    pub fn db(&self) -> &DatabaseConnection {
        &self.db
    }

    /// カード以外の知らせを、そのアカウントのブラウザへ配る（設計§11）。
    ///
    /// 配り方は [`Self::publish`] と同じ——**連絡係にも流す**ので、別のインスタンスに
    /// 繋いでいるブラウザにも届く。呼ぶ側は**記録へ書けてから**呼ぶこと。
    pub fn announce_account(&self, account_id: Uuid, message: ServerMessage) {
        self.publish(account_id, message);
    }

    /// 一覧の更新通知を購読する。**どのアカウントのぶんかは受け取る側が捨てる。**
    ///
    /// **購読を始めてから [`Self::list`] を呼ぶ**こと。逆順にすると、その隙間に起動した
    /// セッションを取りこぼす（順序を守れば重複するだけで、upsert は重複しても害がない）。
    pub fn subscribe_events(&self) -> broadcast::Receiver<AccountEvent> {
        self.events.subscribe()
    }

    /// 札の失効を購読する（札で入った `/ws` 接続が自分を畳むため。コードレビュー対応3）。
    pub fn subscribe_revocations(&self) -> broadcast::Receiver<Uuid> {
        self.revocations.subscribe()
    }

    /// 札の失効を知らせる。呼ぶのは revoke の口だけ。
    pub fn broadcast_revocation(&self, token_id: Uuid) {
        // 受け手（札で入った接続）が1つも居ないのは正常な状態
        let _ = self.revocations.send(token_id);
    }

    /// そのアカウントのカード一覧を作成順に返す（設計§8-6）。
    pub fn list(&self, account_id: Uuid) -> Vec<SessionMeta> {
        let mut metas: Vec<SessionMeta> = self
            .records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .filter(|record| record.account_id == account_id)
            .map(|record| record.meta())
            .collect();
        metas.sort_by_key(|meta| meta.created_at);
        metas
    }

    /// そのカードの持ち主。知らないカードなら `None`。
    ///
    /// 操作の可否（§8-6 の WS 操作の行）はこれ1つで判断する。**「実体が居るか」とは
    /// 別物**で、前回の起動が残した記録にも持ち主は居る。
    pub fn owner_of(&self, card_id: CardId) -> Option<Uuid> {
        self.get(card_id).map(|record| record.account_id)
    }

    /// 自分のカードとして扱ってよいときだけ記録を返す。
    ///
    /// **他人のカードと知らないカードを呼び分けない。** 分けると、IDを総当たりして
    /// 「そのカードは存在する」ことだけを調べられる。
    pub fn owned(&self, account_id: Uuid, card_id: CardId) -> Option<Arc<SessionRecord>> {
        self.get(card_id)
            .filter(|record| record.account_id == account_id)
    }

    /// その PC のカードの**鮮度の印**を切り替えて配り直す（設計§6-3）。
    ///
    /// **`status` は書き換えない。** 切断は「最後に知っていた状態」を上書きする情報では
    /// なく、その鮮度に関する情報だから（§3-1）。画面には「作業中（接続断）」と出る。
    ///
    /// DB にも書かない（§20 読み替え4）。接続はインスタンスローカルの事実で、保存すると
    /// **落ちた瞬間の値が残る**——次に起動したサーバが「繋がっている」と信じてしまう。
    pub fn set_agent_live(&self, agent_id: AgentId, live: bool) {
        let all: Vec<Arc<SessionRecord>> = self
            .records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .cloned()
            .collect();
        for record in all {
            let meta = record.meta();
            if meta.agent_id != Some(agent_id) || meta.agent_connected == live {
                continue;
            }
            record.live.store(live, Ordering::Relaxed);
            self.publish(
                record.account_id,
                ServerMessage::SessionUpsert {
                    session: Box::new(record.meta()),
                },
            );
        }
    }

    /// 一覧の更新を配る。**誰のカードの話かを必ず添える**（設計§8-6）。
    ///
    /// 自分のブラウザへ配ってから、連絡係にも流す（設計§9-2）。順序がこうなのは、
    /// **手元の配信を跨ぎの都合で遅らせない**ため。連絡係が居なければ後半は何もしない。
    fn publish(&self, account_id: Uuid, message: ServerMessage) {
        self.publish_bus(account_id, &message);
        self.publish_local(account_id, message);
    }

    /// このインスタンスの中だけへ配る。
    ///
    /// **他インスタンスから回ってきたものはこちらを使う。** `publish` を使うと、
    /// 受け取ったものをそのまま配り直し、それがまた返ってきて止まらなくなる。
    fn publish_local(&self, account_id: Uuid, message: ServerMessage) {
        let _ = self.events.send(AccountEvent {
            account_id,
            message,
        });
    }

    /// いま繋がっている全ブラウザへ知らせる（連絡係の縮退など、カードに紐づかない話）。
    ///
    /// **連絡係へは流さない。** 縮退はインスタンスごとの事実で、しかも流す相手が
    /// 切れているときに出す知らせなので、跨いで配ること自体が成り立たない。
    pub fn announce(&self, message: ServerMessage) {
        let accounts: Vec<Uuid> = self
            .browsers
            .lock()
            .expect("ロックが壊れていない")
            .keys()
            .copied()
            .collect();
        for account_id in accounts {
            self.publish_local(account_id, message.clone());
        }
    }

    /// 連絡係がいま繋がっているか。**持っていなければ `None`**（縮退という概念が無い）。
    pub fn bus_state(&self) -> Option<crate::bus::BusState> {
        self.bus.as_ref().map(|bus| *bus.state().borrow())
    }

    /// 連絡係へ流す（他インスタンスのブラウザ向け）。
    fn publish_bus(&self, account_id: Uuid, message: &ServerMessage) {
        let Some(bus) = &self.bus else {
            return;
        };
        bus.publish(
            &bus::account_events(account_id),
            bus::encode_json(
                self.instance_id,
                &bus::AccountMessage::Event(Box::new(message.clone())),
            ),
        );
    }

    /// 「いま持っているカードを名乗り直してほしい」と頼む（設計§6-4 のサーバ版）。
    ///
    /// 立ち上げ直した直後は、**どのカードが生きているかを知らない**。動きの無い
    /// セッションは報告を出さないので、待っていても来ない。
    pub fn request_resync(&self, account_id: Uuid) {
        let Some(bus) = &self.bus else {
            return;
        };
        bus.publish(
            &bus::account_events(account_id),
            bus::encode_json(self.instance_id, &bus::AccountMessage::Resync),
        );
    }

    /// そのカードの記録へ、外から「いまの姿」を入れ直す（名乗り直しの受け口）。
    pub fn announce_card(&self, account_id: Uuid, meta: SessionMeta) {
        let Some(record) = self.owned(account_id, meta.card_id) else {
            return;
        };
        record.store_meta(meta);
        self.publish(
            account_id,
            ServerMessage::SessionUpsert {
                session: Box::new(record.meta()),
            },
        );
    }

    /// 他インスタンスから回ってきた知らせを取り込む（設計§9-2）。
    ///
    /// # ここでは DB へ書かない
    ///
    /// 書いたのは発信元のインスタンスで、真実はもう DB にある。二重に書くと、
    /// 履歴の通し番号（`seq`）が両方で進んで**並びが飛ぶ**。ここでやるのは、
    /// このインスタンスのブラウザへ見せるための手元の写しを合わせることだけ。
    ///
    /// **持ち主はチャネル名で決まる**（`account_id` は呼び出し側が名前から取る）。
    /// 封筒の中身を信じると、名前でアカウントを分けた意味が無くなる。
    pub async fn adopt(&self, account_id: Uuid, message: ServerMessage) {
        match message {
            ServerMessage::SessionUpsert { session } => {
                let card_id = session.card_id;
                // **外したカードは戻さない。** 跨ぎの経路にも同じ門が要る
                // （`upsert` と対）——外した直後に他インスタンスから流れてきたぶんや、
                // 名乗り直しと行き違ったぶんを素直に取り込むと、記録が作り直されて
                // 一覧へ戻ってくる。しかも `list` はメモリの記録を見るので、
                // **DB では外れているのに画面には出続ける**という食い違いになる
                if self.get(card_id).is_none()
                    && matches!(self.stored(card_id).await, Ok(Some((_, true))))
                {
                    return;
                }
                let record = match self.record_for(account_id, card_id).await {
                    Ok(record) => record,
                    Err(err) => {
                        tracing::warn!(%card_id, "跨ぎで届いたカードを用意できません: {err}");
                        return;
                    }
                };
                // 他人のカードとして届いたものは取り込まない。チャネルは持ち主ごとに
                // 分かれているので通常は起こらないが、**名前と中身が食い違ったときに
                // 名前を正とする**ことをここでも守る
                if record.account_id != account_id {
                    return;
                }
                record.store_meta(*session);
                self.publish_local(
                    account_id,
                    ServerMessage::SessionUpsert {
                        session: Box::new(record.meta()),
                    },
                );
            }

            ServerMessage::SessionRemoved { card_id } => {
                if self.owned(account_id, card_id).is_none() {
                    return;
                }
                self.records
                    .lock()
                    .expect("ロックが壊れていない")
                    .remove(&card_id);
                self.publish_local(account_id, ServerMessage::SessionRemoved { card_id });
            }

            ServerMessage::Status {
                card_id,
                status,
                subagent_active,
                last_activity_at,
            } => {
                let Some(record) = self.owned(account_id, card_id) else {
                    return;
                };
                {
                    let mut meta = record.meta.lock().expect("ロックが壊れていない");
                    meta.status = status;
                    meta.subagent_active = subagent_active;
                    meta.last_activity_at = last_activity_at;
                }
                // 状態が届くということは、向こうで報告が続いている
                record.live.store(true, Ordering::Relaxed);
                self.publish_local(
                    account_id,
                    ServerMessage::Status {
                        card_id,
                        status,
                        subagent_active,
                        last_activity_at,
                    },
                );
            }

            ServerMessage::TranscriptAppend { card_id, nodes } => {
                let Some(record) = self.owned(account_id, card_id) else {
                    return;
                };
                record
                    .window
                    .lock()
                    .expect("ロックが壊れていない")
                    .append(&nodes);
                record.fanout(&ServerMessage::TranscriptAppend { card_id, nodes });
            }

            ServerMessage::TranscriptReset { card_id } => {
                let Some(record) = self.owned(account_id, card_id) else {
                    return;
                };
                record.window.lock().expect("ロックが壊れていない").clear();
                record.fanout(&ServerMessage::TranscriptReset { card_id });
            }

            // 揮発の知らせはそのまま流す
            other => self.publish_local(account_id, other),
        }
    }

    /// ブラウザが1つ繋がった。**最初の1人でそのアカウントの知らせを購読する**（設計§9-2）。
    ///
    /// 購読を開けた瞬間より前に流れたものは届かない（pub/sub は at-most-once）。
    /// だから開けた直後に DB を読み直して埋める——**真実は DB にある**ので、
    /// 取りこぼしはこれで必ず追いつく（§9-1）。
    pub async fn attach_browser(&self, account_id: Uuid) {
        let first = {
            let mut browsers = self.browsers.lock().expect("ロックが壊れていない");
            let count = browsers.entry(account_id).or_insert(0);
            *count += 1;
            *count == 1
        };
        if !first {
            return;
        }
        let Some(bus) = &self.bus else {
            return;
        };
        bus.subscribe(&bus::account_events(account_id));
        if let Err(err) = self.reload_account(account_id).await {
            tracing::warn!(%account_id, "記録を読み直せません: {err}");
        }
        // DB からは「どのカードが生きているか」が分からない。PC を持っている
        // インスタンスに名乗り直してもらう（設計§6-4 のサーバ版）
        self.request_resync(account_id);
    }

    /// ブラウザが1つ去った。**最後の1人で購読を閉じる。**
    pub fn detach_browser(&self, account_id: Uuid) {
        let last = {
            let mut browsers = self.browsers.lock().expect("ロックが壊れていない");
            match browsers.get_mut(&account_id) {
                Some(count) => {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        browsers.remove(&account_id);
                        true
                    } else {
                        false
                    }
                }
                None => false,
            }
        };
        if last && let Some(bus) = &self.bus {
            bus.unsubscribe(&bus::account_events(account_id));
        }
    }

    /// 連絡係が戻ってきたので、見ているアカウントを全部読み直す（設計§9-1 の規約）。
    ///
    /// 読み直しに続けて名乗り直しも頼む。切れている間に生き死にが変わっていても、
    /// DB にはその区別が書いていない。
    ///
    /// 自動再購読は**取りこぼしを埋めない**——切れている間に流れたものは消えている。
    /// 購読が戻ったことと、中身が揃っていることは別の話になる。
    pub async fn resnapshot(&self) {
        let accounts: Vec<Uuid> = self
            .browsers
            .lock()
            .expect("ロックが壊れていない")
            .keys()
            .copied()
            .collect();
        for account_id in accounts {
            if let Err(err) = self.reload_account(account_id).await {
                tracing::warn!(%account_id, "記録を読み直せません: {err}");
            }
            self.request_resync(account_id);
        }
    }

    /// そのアカウントの記録を DB と突き合わせ直す。
    ///
    /// 消えたものは外し、知らないものは足し、あるものは DB の中身で上書きする。
    /// **鮮度の印（`agent_connected`）だけは手元の値を残す**——接続はこのインスタンスと
    /// 他インスタンスの見立てであって、DB には書いていない（設計§20 読み替え4）。
    pub async fn reload_account(&self, account_id: Uuid) -> Result<(), DbErr> {
        let rows = entity::sessions::Entity::find()
            .filter(entity::sessions::Column::AccountId.eq(account_id))
            .filter(entity::sessions::Column::Archived.eq(false))
            .order_by_asc(entity::sessions::Column::CreatedAt)
            .all(&self.db)
            .await?;
        let account_name = entity::accounts::Entity::find_by_id(account_id)
            .one(&self.db)
            .await?
            .map(|row| row.name);

        let alive: std::collections::HashSet<CardId> =
            rows.iter().map(|row| CardId(row.card_id)).collect();

        // DB に無いものは外れている。**手元にだけ残っていると、外したカードが
        // このインスタンスのブラウザにだけ出続ける**
        let stale: Vec<CardId> = self
            .records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .filter(|record| record.account_id == account_id && !alive.contains(&record.card_id))
            .map(|record| record.card_id)
            .collect();
        for card_id in stale {
            self.records
                .lock()
                .expect("ロックが壊れていない")
                .remove(&card_id);
            self.publish_local(account_id, ServerMessage::SessionRemoved { card_id });
        }

        for row in rows {
            let card_id = CardId(row.card_id);
            let mut meta = meta_from_row(row);
            if account_id != db::LOCAL_ACCOUNT_ID {
                meta.account = account_name.clone();
            }
            // DB は接続を知らない（`meta_from_row` は必ず false を返す）ので、
            // 手元の見立てを残す。**知らないカードは繋がっていない扱い**で始め、
            // 生きているものは名乗り直し（[`Self::request_resync`]）で印が戻る——
            // **PC が繋がっていることと、そのカードが生きていることは別**。PC ごと
            // 落ちたあとのカードは、PC が戻っても死んだままになる（設計§1-3）
            let known = self.get(card_id);
            meta.agent_connected = known
                .as_ref()
                .is_some_and(|record| record.meta().agent_connected);
            let record = match known {
                Some(record) => record,
                None => self.record_for(account_id, card_id).await?,
            };
            record.store_meta(meta);
            self.publish_local(
                account_id,
                ServerMessage::SessionUpsert {
                    session: Box::new(record.meta()),
                },
            );
        }
        Ok(())
    }

    /// その PC が持っているカードの一覧（切断時の掃除と、指示の宛先探しに使う）。
    pub fn cards_of(&self, agent_id: AgentId) -> Vec<CardId> {
        self.records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .filter(|record| record.meta().agent_id == Some(agent_id))
            .map(|record| record.card_id)
            .collect()
    }

    pub fn get(&self, card_id: CardId) -> Option<Arc<SessionRecord>> {
        self.records
            .lock()
            .expect("ロックが壊れていない")
            .get(&card_id)
            .cloned()
    }

    /// 履歴を1ページ分作る（設計§3-3）。読み先は DB。
    ///
    /// **自分のカードでなければ「無い」と答える**（§8-6）。他人のカードだと分かる
    /// 返し方をすると、IDの総当たりで存在を調べられる。
    pub async fn transcript_page(
        &self,
        account_id: Uuid,
        card_id: CardId,
        before: Option<NodeId>,
        limit: usize,
    ) -> Result<TranscriptPage, PageError> {
        if self.owned(account_id, card_id).is_none() {
            return Err(PageError::NotFound);
        }
        match db_transcript::page(&self.db, card_id, before.as_ref(), limit).await {
            Ok((nodes, has_more)) => Ok(TranscriptPage { nodes, has_more }),
            Err(err) => {
                tracing::error!(%card_id, "履歴を読めません: {err}");
                Err(PageError::Unavailable)
            }
        }
    }

    /// セッションホストからの報告を1件取り込む。**書いてから配る。**
    ///
    /// 戻り値は「**取り込みが終わったか**」で、そのまま ack を返してよいかの判断になる
    /// （設計§6-1）。`false` のときは黙って返さない——ack を返さないこと自体が
    /// 「まだ書けていない」の合図で、セッションホストは持っているぶんを再送する（§12 の DB 断）。
    ///
    /// 取り込む先が無かった場合（外した直後のカード宛て）も `true` を返す。ここで
    /// `false` にすると、**二度と書ける見込みが無いものを永久に再送させる**ことになり、
    /// そのカードのオフセットが止まったままになる。
    pub async fn apply(&self, origin: &ReportOrigin, message: ServerMessage) -> bool {
        let outcome = match message {
            ServerMessage::SessionUpsert { session } => self.upsert(origin, *session).await,
            ServerMessage::SessionRemoved { card_id } => self.archive(origin, card_id).await,
            ServerMessage::Status {
                card_id,
                status,
                subagent_active,
                last_activity_at,
            } => {
                self.status(origin, card_id, status, subagent_active, last_activity_at)
                    .await
            }
            ServerMessage::TranscriptAppend { card_id, nodes } => {
                self.append(origin, card_id, nodes).await
            }
            ServerMessage::TranscriptReset { card_id } => self.reset(origin, card_id).await,
            // 揮発の知らせ。真実として残す性質のものではないので素通しする。
            // **配る先は報告してきたアカウントの中だけ**（§8-6 の A2S の行）
            other => {
                self.publish(origin.account_id, other);
                Ok(())
            }
        };

        match outcome {
            Ok(()) => true,
            Err(err) => {
                // 書けなかったものは配らない（画面に出るのに再読み込みで消えるのを防ぐ）。
                // 代わりに理由を出す——黙って落とすと「一覧が更新されない」としか見えない
                tracing::error!("記録を書けませんでした: {err}");
                self.publish(
                    origin.account_id,
                    ServerMessage::Error {
                        card_id: None,
                        message: format!("記録を保存できませんでした: {err}"),
                    },
                );
                false
            }
        }
    }

    async fn upsert(&self, origin: &ReportOrigin, mut meta: SessionMeta) -> Result<(), DbErr> {
        // **外したカードは戻さない。**
        //
        // 外す（`archive`）と記録は落ちるが、**報告の待ち行列にはまだそのカードのぶんが
        // 残っている**（切替の結果配信・見張りの1周・処理中のフック）。それを素直に
        // 取り込むと記録が作り直され、消したはずのカードが一覧へ戻ってくる。
        //
        // 記録が手元に無いときだけ DB を見るので、通常の更新に問い合わせは増えない。
        // CardId は UUIDv4 なので、外したIDが後から別のセッションに割り当たることもない
        // 既に知っているカードなら、生まれた時刻と名前は**記録の側が正**（下記）
        let mut 記録の生まれた時刻 = None;
        let mut 記録の名前 = None;
        match self.get(meta.card_id) {
            Some(record) => {
                if self.refuse_crossing(&origin.account_id, record.account_id, meta.card_id) {
                    return Ok(());
                }
                記録の生まれた時刻 = Some(record.meta().created_at);
                記録の名前 = record.meta().session_title;
            }
            None => match self.stored(meta.card_id).await? {
                Some((owner, _))
                    if self.refuse_crossing(&origin.account_id, owner, meta.card_id) =>
                {
                    return Ok(());
                }
                Some((_, true)) => return Ok(()),
                _ => {}
            },
        }

        // **帰属を決めるのはサーバの仕事**（設計§5-1 の手順4）。セッションホストが申告した
        // 値は捨て、接続そのものが含意する出どころで上書きする。他アカウントの名前を
        // 名乗られても通らないのは、ここで見ているのが**申告ではなく接続**だから（§8-5）
        meta.agent_id = origin.agent_id;
        meta.account = origin.account.clone();
        // **生まれた時刻もサーバが決める。** これは擬似ターミナルではなく**カードの性質**で、
        // カードは起こし直しをまたいで同じものであり続ける（初期実装§3）。
        //
        // 起こし直し（`revive`）は同じ CardId に別の実体を載せ直すので、セッションホストは
        // **そのとき採った時刻**を申告してくる。素直に取り込むと、**一覧の並びが動く**——
        // 並びは `created_at` の昇順で、しかも「群の中の並びは追加した順で固定してあり、
        // 状態が変わっても動かない」と約束してある（README。押そうとした瞬間に的が逃げないため）。
        //
        // 実機で踏んだ（2026-08-23）。復旧した2枚が枠の末尾へ動いた。「全て復旧」を押すと
        // **群ごと並び替わる**ことになるので、約束のほうが先に壊れる。
        if let Some(生まれた時刻) = 記録の生まれた時刻 {
            meta.created_at = 生まれた時刻;
        }
        // **空の報告で名前を消さない**（設計§6-1）。生まれた時刻と同じ性質——名前は
        // 擬似ターミナルではなく**カードに属する**もので、起こし直しをまたいで残る。
        //
        // 名前の行は履歴の途中に1回書かれるだけなので、**カードの報告のほうが先に着く**。
        // 素直に取り込むと、記録に入っていた名前がその1回で消える（パーサが読み直して
        // 報告し直すまでの隙間で消え、題の行がまだ無いセッションでは永久に戻らない）。
        //
        // 逆向き（空でない報告）は素通しでよい。名前が変わるときは**新しい名前が書かれる**
        // ので、空を無視しても更新は届く。
        if meta.session_title.is_none()
            && let Some(名前) = 記録の名前
        {
            meta.session_title = Some(名前);
        }
        // 申告が持ち主と食い違ったら**記録には残すが帰属は動かさない**。警告を出すのは、
        // 利用者から見ると「toml に書いたのに効かない」だけに見えるため
        if let (Some(claimed), Some(actual)) = (&meta.toml_account, &origin.account)
            && claimed != actual
        {
            tracing::warn!(
                card_id = %meta.card_id,
                "`.agent-dashboard.toml` は「{claimed}」と名乗りましたが、この接続は「{actual}」のものです。申告は無視します"
            );
        }

        self.write_session(origin, &meta).await?;

        let record = self.record_for(origin.account_id, meta.card_id).await?;
        record.store_meta(meta);
        self.publish(
            record.account_id,
            ServerMessage::SessionUpsert {
                session: Box::new(record.meta()),
            },
        );
        Ok(())
    }

    /// 他人のカードへの報告を断るか（設計§8-6 の A2S の行）。
    ///
    /// **`false`（＝取り込まない）でも ack は返す**（呼び出し側が `Ok` にする）。
    /// 返さないと、二度と書ける見込みの無いものをセッションホストが永久に再送する。
    fn refuse_crossing(&self, reporting: &Uuid, owner: Uuid, card_id: CardId) -> bool {
        if *reporting == owner {
            return false;
        }
        tracing::warn!(%card_id, "他のアカウントのカードへの報告を無視しました");
        true
    }

    /// ブラウザからの指示でカードを外す（実体がもう居ない場合）。
    ///
    /// # 実体が死んでいるカードも外せないといけない
    ///
    /// 通常はセッションホストへ頼み、向こうが片付けてから `SessionRemoved` を報告してくる。
    /// だが**前回の起動が残したカード**や、PC ごと落ちたあとのカードには頼む相手が
    /// 居ない。そのままだと一覧から二度と消せず、履歴を残すために行を消さない設計
    /// （下の [`Self::archive`]）と噛み合って**永久に残る**。
    ///
    /// 持ち主は必ず確かめる。他人のカードのIDを名指しして消せてはいけない（§8-6）。
    pub async fn archive_owned(&self, account_id: Uuid, card_id: CardId) -> Result<(), DbErr> {
        self.archive(
            &ReportOrigin {
                account_id,
                agent_id: None,
                account: None,
            },
            card_id,
        )
        .await
    }

    async fn archive(&self, origin: &ReportOrigin, card_id: CardId) -> Result<(), DbErr> {
        if let Some(record) = self.get(card_id)
            && self.refuse_crossing(&origin.account_id, record.account_id, card_id)
        {
            return Ok(());
        }
        // 行は消さない。**履歴を残すため**——カードを一覧から外しても、
        // 何をしたセッションだったかは辿れる。**持ち主も条件に入れる**ので、
        // 他人のカードのIDを名指しして消すことはできない
        entity::sessions::Entity::update_many()
            .col_expr(
                entity::sessions::Column::Archived,
                sea_orm::sea_query::Expr::value(true),
            )
            .filter(entity::sessions::Column::CardId.eq(card_id.0))
            .filter(entity::sessions::Column::AccountId.eq(origin.account_id))
            .exec(&self.db)
            .await?;
        self.records
            .lock()
            .expect("ロックが壊れていない")
            .remove(&card_id);
        self.publish(origin.account_id, ServerMessage::SessionRemoved { card_id });
        Ok(())
    }

    async fn status(
        &self,
        origin: &ReportOrigin,
        card_id: CardId,
        status: SessionStatus,
        subagent_active: u32,
        last_activity_at: i64,
    ) -> Result<(), DbErr> {
        let Some(record) = self.owned(origin.account_id, card_id) else {
            return Ok(());
        };
        entity::sessions::Entity::update_many()
            .col_expr(
                entity::sessions::Column::Status,
                sea_orm::sea_query::Expr::value(
                    serde_json::to_value(status).unwrap_or(serde_json::Value::Null),
                ),
            )
            .col_expr(
                entity::sessions::Column::SubagentActive,
                sea_orm::sea_query::Expr::value(subagent_active as i32),
            )
            .col_expr(
                entity::sessions::Column::LastActivityAt,
                sea_orm::sea_query::Expr::value(last_activity_at),
            )
            .filter(entity::sessions::Column::CardId.eq(card_id.0))
            .exec(&self.db)
            .await?;

        {
            let mut meta = record.meta.lock().expect("ロックが壊れていない");
            meta.status = status;
            meta.subagent_active = subagent_active;
            meta.last_activity_at = last_activity_at;
        }
        record.live.store(true, Ordering::Relaxed);
        self.publish(
            record.account_id,
            ServerMessage::Status {
                card_id,
                status,
                subagent_active,
                last_activity_at,
            },
        );
        Ok(())
    }

    async fn append(
        &self,
        origin: &ReportOrigin,
        card_id: CardId,
        nodes: Vec<TreeNode>,
    ) -> Result<(), DbErr> {
        let Some(record) = self.owned(origin.account_id, card_id) else {
            // 知らないカードの履歴は捨てる。外した直後に届いたぶんで一覧を汚さない
            return Ok(());
        };
        {
            let mut next = record.next_seq.lock().await;
            db_transcript::append(&self.db, card_id, &nodes, &mut next).await?;
        }
        record
            .window
            .lock()
            .expect("ロックが壊れていない")
            .append(&nodes);
        // 履歴は一覧の口（`events`）ではなく、そのカードを見ている人だけへ流す。
        // **跨ぎのぶんは連絡係へ別に流す**——向こうのインスタンスで見ている人が
        // 居るかどうかは、こちらからは分からない
        let message = ServerMessage::TranscriptAppend { card_id, nodes };
        self.publish_bus(record.account_id, &message);
        record.fanout(&message);
        Ok(())
    }

    async fn reset(&self, origin: &ReportOrigin, card_id: CardId) -> Result<(), DbErr> {
        let Some(record) = self.owned(origin.account_id, card_id) else {
            return Ok(());
        };
        {
            let mut next = record.next_seq.lock().await;
            db_transcript::reset(&self.db, card_id).await?;
            // 全部消したので番号も最初から。残すと、次のノードが遠い番号から始まる
            *next = 0;
        }
        record.window.lock().expect("ロックが壊れていない").clear();
        // 作り直しと追記は**同じ列**を通る（連絡係が順序を守る）。逆になると、
        // 消したはずの履歴が残ったまま続きが積まれる（設計§6-2）
        let message = ServerMessage::TranscriptReset { card_id };
        self.publish_bus(record.account_id, &message);
        record.fanout(&message);
        Ok(())
    }

    /// 記録を DB へ書く（無ければ作る）。
    async fn write_session(&self, origin: &ReportOrigin, meta: &SessionMeta) -> Result<(), DbErr> {
        let row = entity::sessions::ActiveModel {
            card_id: Set(meta.card_id.0),
            agent_id: Set(meta.agent_id.map(|id| id.0)),
            account_id: Set(origin.account_id),
            project: Set(meta.project.0.clone()),
            claude_session_id: Set(meta.claude_session_id.map(|id| id.0)),
            permission_mode: Set(meta
                .permission_mode
                .as_ref()
                .map(|mode| mode.as_str().to_string())),
            model: Set(meta.model.as_ref().map(|id| id.as_str().to_string())),
            model_label: Set(meta.model_label.clone()),
            model_requested: Set(meta
                .model_requested
                .as_ref()
                .map(|id| id.as_str().to_string())),
            status: Set(serde_json::to_value(meta.status).unwrap_or(serde_json::Value::Null)),
            subagent_active: Set(meta.subagent_active as i32),
            last_activity_at: Set(meta.last_activity_at),
            last_assistant_message: Set(meta.last_assistant_message.clone()),
            created_at: Set(meta.created_at),
            hooks_seen: Set(meta.hooks_seen),
            archived: Set(false),
            toml_account: Set(meta.toml_account.clone()),
            session_title: Set(meta.session_title.clone()),
        };
        entity::sessions::Entity::insert(row)
            .on_conflict(
                OnConflict::column(entity::sessions::Column::CardId)
                    .update_columns([
                        entity::sessions::Column::AgentId,
                        entity::sessions::Column::Project,
                        entity::sessions::Column::ClaudeSessionId,
                        entity::sessions::Column::PermissionMode,
                        entity::sessions::Column::Model,
                        entity::sessions::Column::ModelLabel,
                        entity::sessions::Column::ModelRequested,
                        entity::sessions::Column::Status,
                        entity::sessions::Column::SubagentActive,
                        entity::sessions::Column::LastActivityAt,
                        entity::sessions::Column::LastAssistantMessage,
                        entity::sessions::Column::HooksSeen,
                        entity::sessions::Column::TomlAccount,
                        // `SessionTitle` は更新する。**渡す値のほうを正しくしてある**ので
                        // （空の報告は `upsert` が記録の名前で埋め直す。§6-1）、
                        // ここで例外を作らない
                        entity::sessions::Column::SessionTitle,
                        // `Archived` は**更新しない**。外したことは後から届く報告で
                        // 取り消されてはいけない（上の `upsert` の門と対になっている）。
                        // `AccountId` も**更新しない**。帰属は最初の報告で決まり、
                        // 後から別のアカウントの PC が同じIDを名乗っても動かない（§8-6）
                    ])
                    .to_owned(),
            )
            .exec(&self.db)
            .await?;
        Ok(())
    }

    /// DB に残っているそのカードの `(持ち主, 外したか)`。行が無ければ `None`。
    ///
    /// 記録が手元に無いときだけ引く。**持ち主と外した印を一度に取る**のは、
    /// 別々に引くと2回問い合わせることになり、しかも間に状態が変わりうるため。
    async fn stored(&self, card_id: CardId) -> Result<Option<(Uuid, bool)>, DbErr> {
        Ok(entity::sessions::Entity::find_by_id(card_id.0)
            .one(&self.db)
            .await?
            .map(|row| (row.account_id, row.archived)))
    }

    /// そのカードの記録を取り出す。無ければ作る。
    async fn record_for(
        &self,
        account_id: Uuid,
        card_id: CardId,
    ) -> Result<Arc<SessionRecord>, DbErr> {
        if let Some(record) = self.get(card_id) {
            return Ok(record);
        }
        // 作るには DB を読むので、ロックの外で用意してから入れ直す
        let next_seq = db_transcript::next_seq(&self.db, card_id).await?;
        let latest = db_transcript::latest(&self.db, card_id, self.window_nodes).await?;

        let mut records = self.records.lock().expect("ロックが壊れていない");
        // 待っている間に別の報告が作っていることがある
        if let Some(record) = records.get(&card_id) {
            return Ok(Arc::clone(record));
        }
        let record = Arc::new(SessionRecord::new(
            placeholder_meta(card_id),
            account_id,
            self.window_nodes,
            next_seq,
            true,
        ));
        record
            .window
            .lock()
            .expect("ロックが壊れていない")
            .fill(latest);
        records.insert(card_id, Arc::clone(&record));
        Ok(record)
    }
}

/// [`SessionRecord`] を作る瞬間だけ使う仮の中身。
///
/// 直後に本物の [`SessionMeta`] で上書きされる。空の入れ物を作らないのは、
/// 「まだ埋まっていない meta」を型で表すと、読む側が毎回 `Option` を剥がすことになるため。
fn placeholder_meta(card_id: CardId) -> SessionMeta {
    SessionMeta {
        card_id,
        project: ProjectId(String::new()),
        claude_session_id: None,
        permission_mode: None,
        model: None,
        model_label: None,
        model_requested: None,
        status: SessionStatus::Unknown,
        subagent_active: 0,
        last_activity_at: 0,
        last_assistant_message: None,
        created_at: 0,
        hooks_seen: false,
        agent_id: None,
        agent_connected: true,
        account: None,
        toml_account: None,
        session_title: None,
    }
}

fn meta_from_row(row: entity::sessions::Model) -> SessionMeta {
    SessionMeta {
        card_id: CardId(row.card_id),
        project: ProjectId(row.project),
        claude_session_id: row.claude_session_id.map(ClaudeSessionId),
        permission_mode: row.permission_mode.map(PermissionMode::new),
        model: row.model.map(ModelId::new),
        model_label: row.model_label,
        model_requested: row.model_requested.map(ModelId::new),
        // 読めない状態は「不明」に落とす。**捨てずに、分からないと言う**
        status: serde_json::from_value(row.status).unwrap_or(SessionStatus::Unknown),
        subagent_active: row.subagent_active as u32,
        last_activity_at: row.last_activity_at,
        last_assistant_message: row.last_assistant_message,
        created_at: row.created_at,
        hooks_seen: row.hooks_seen,
        agent_id: row.agent_id.map(protocol::AgentId),
        // 読み出した時点では「繋がっていない」。報告が来たら立つ
        agent_connected: false,
        account: None,
        toml_account: row.toml_account,
        session_title: row.session_title,
    }
}
