//! カードの記録（セルフホスト化設計§3-2・§3-3）。
//!
//! # ここが「サーバから見たセッション」
//!
//! PTY も claude のプロセスも持たない。持っているのは**記録**——DB に書いた内容と、
//! それをブラウザへ配るための口だけ。実体（[`crate::agent::AgentHost`] の向こう）とは
//! 完全に分かれていて、フェーズ1 で切った境界（設計§2-3）の、記録側の中身にあたる。
//!
//! フェーズ1 でここを作らなかったのは、写しを持つと**実体と二重化して起動直後の
//! カードを取りこぼす窓**が生まれるためだった（設計§18 読み替え1）。DB が真実になった
//! いまはその窓を塞げる——**書いてから配る**（§9-1）ので、ブラウザが知った時点で
//! DB には必ず入っている。
//!
//! # 何が来ても、まず書く
//!
//! エージェントからの報告は [`SessionRegistry::apply`] を通る。ここでの順序は
//! 「DB へ書く → ブラウザへ配る」で固定する。**書けなかったものは配らない**——
//! 配ってしまうと、画面には出るのに再読み込みで消える（嘘になる）。代わりに
//! エラーを配ってバナーに出す（設計§12 の DB 断の行）。
//!
//! 揮発の知らせ（パーサの健康状態・自己修復の進行・操作の失敗）は DB へ書かずに
//! 素通しする。真実として残す性質のものではない。

use crate::{
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
use serde::Serialize;
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

/// 履歴購読1本あたりの配信待ち行列（メッセージ数）。
pub const TRANSCRIPT_QUEUE_MESSAGES: usize = 64;

/// 履歴1ページ分（`GET /api/sessions/{card_id}/transcript` の応答）。
#[derive(Debug, Serialize)]
pub struct TranscriptPage {
    pub nodes: Vec<TreeNode>,
    /// さらに前があるかもしれない
    pub has_more: bool,
}

/// 報告の出どころ（セルフホスト化設計§5-1 の手順4）。
///
/// **帰属を決めるのはサーバの仕事**なので、エージェントが `SessionMeta` に何を書いて
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

/// カード1枚の記録。
pub struct SessionRecord {
    pub card_id: CardId,
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
    fn new(meta: SessionMeta, window_nodes: usize, next_seq: i64, live: bool) -> Self {
        Self {
            card_id: meta.card_id,
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

    fn store_meta(&self, meta: SessionMeta) {
        *self.meta.lock().expect("ロックが壊れていない") = meta;
        self.live.store(true, Ordering::Relaxed);
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
    events: broadcast::Sender<ServerMessage>,
    window_nodes: usize,
}

impl SessionRegistry {
    /// DB から復元して立ち上げる。
    ///
    /// 外していない（`archived=false`）カードを読み戻し、**すべて「接続していない」印**で
    /// 一覧に出す。ローカルモードでは、これが前回の起動が残した記録にあたる——
    /// 履歴は読めるが PTY は道連れで死んでいる（設計§1-3）。セルフホストモードでは、
    /// エージェントが繋ぎ直してくるまでの間がこの状態になる（§6-3 と同じ見え方）。
    ///
    /// アカウントで絞らずに全部読むのは、**見ている人が誰かをまだ知らない**ため。
    /// ログイン（§8-2）が入るフェーズ5 で、配るときに絞る形になる（§8-6）。
    pub async fn load(
        db: DatabaseConnection,
        window_nodes: usize,
    ) -> Result<Arc<Self>, anyhow::Error> {
        let rows = entity::sessions::Entity::find()
            .filter(entity::sessions::Column::Archived.eq(false))
            .order_by_asc(entity::sessions::Column::CreatedAt)
            .all(&db)
            .await?;

        let mut records = HashMap::new();
        for row in rows {
            let meta = meta_from_row(row);
            let card_id = meta.card_id;
            let next_seq = db_transcript::next_seq(&db, card_id).await?;
            // 窓を DB の直近ぶんで満たす。空のままだと、購読を始めたクライアントに
            // 「履歴が無い」と見えてしまう（DB には残っているのに）。
            // **読み終えてからロックを取る**（ロックを持ったまま待たない）
            let latest = db_transcript::latest(&db, card_id, window_nodes).await?;
            // 前回の起動が残したカードなので live=false
            let record = SessionRecord::new(meta, window_nodes, next_seq, false);
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
            window_nodes,
        }))
    }

    /// 一覧の更新通知を購読する。
    ///
    /// **購読を始めてから [`Self::list`] を呼ぶ**こと。逆順にすると、その隙間に起動した
    /// セッションを取りこぼす（順序を守れば重複するだけで、upsert は重複しても害がない）。
    pub fn subscribe_events(&self) -> broadcast::Receiver<ServerMessage> {
        self.events.subscribe()
    }

    /// 現在のカード一覧を作成順に返す。
    pub fn list(&self) -> Vec<SessionMeta> {
        let mut metas: Vec<SessionMeta> = self
            .records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .map(|record| record.meta())
            .collect();
        metas.sort_by_key(|meta| meta.created_at);
        metas
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
            let _ = self.events.send(ServerMessage::SessionUpsert {
                session: Box::new(record.meta()),
            });
        }
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
    pub async fn transcript_page(
        &self,
        card_id: CardId,
        before: Option<NodeId>,
        limit: usize,
    ) -> Result<TranscriptPage, PageError> {
        if self.get(card_id).is_none() {
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

    /// エージェントからの報告を1件取り込む。**書いてから配る。**
    ///
    /// 戻り値は「**取り込みが終わったか**」で、そのまま ack を返してよいかの判断になる
    /// （設計§6-1）。`false` のときは黙って返さない——ack を返さないこと自体が
    /// 「まだ書けていない」の合図で、エージェントは持っているぶんを再送する（§12 の DB 断）。
    ///
    /// 取り込む先が無かった場合（外した直後のカード宛て）も `true` を返す。ここで
    /// `false` にすると、**二度と書ける見込みが無いものを永久に再送させる**ことになり、
    /// そのカードのオフセットが止まったままになる。
    pub async fn apply(&self, origin: &ReportOrigin, message: ServerMessage) -> bool {
        let outcome = match message {
            ServerMessage::SessionUpsert { session } => self.upsert(origin, *session).await,
            ServerMessage::SessionRemoved { card_id } => self.archive(card_id).await,
            ServerMessage::Status {
                card_id,
                status,
                subagent_active,
                last_activity_at,
            } => {
                self.status(card_id, status, subagent_active, last_activity_at)
                    .await
            }
            ServerMessage::TranscriptAppend { card_id, nodes } => self.append(card_id, nodes).await,
            ServerMessage::TranscriptReset { card_id } => self.reset(card_id).await,
            // 揮発の知らせ。真実として残す性質のものではないので素通しする
            other => {
                let _ = self.events.send(other);
                Ok(())
            }
        };

        match outcome {
            Ok(()) => true,
            Err(err) => {
                // 書けなかったものは配らない（画面に出るのに再読み込みで消えるのを防ぐ）。
                // 代わりに理由を出す——黙って落とすと「一覧が更新されない」としか見えない
                tracing::error!("記録を書けませんでした: {err}");
                let _ = self.events.send(ServerMessage::Error {
                    card_id: None,
                    message: format!("記録を保存できませんでした: {err}"),
                });
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
        if self.get(meta.card_id).is_none() && self.is_archived(meta.card_id).await? {
            return Ok(());
        }

        // **帰属を決めるのはサーバの仕事**（設計§5-1 の手順4）。エージェントが申告した
        // 値は捨て、接続そのものが含意する出どころで上書きする。他アカウントの名前を
        // 名乗られても通らないのは、ここで見ているのが**申告ではなく接続**だから（§8-5）
        meta.agent_id = origin.agent_id;
        meta.account = origin.account.clone();

        self.write_session(origin, &meta).await?;

        let record = self.record_for(meta.card_id).await?;
        record.store_meta(meta);
        let _ = self.events.send(ServerMessage::SessionUpsert {
            session: Box::new(record.meta()),
        });
        Ok(())
    }

    async fn archive(&self, card_id: CardId) -> Result<(), DbErr> {
        // 行は消さない。**履歴を残すため**——カードを一覧から外しても、
        // 何をしたセッションだったかは辿れる
        entity::sessions::Entity::update_many()
            .col_expr(
                entity::sessions::Column::Archived,
                sea_orm::sea_query::Expr::value(true),
            )
            .filter(entity::sessions::Column::CardId.eq(card_id.0))
            .exec(&self.db)
            .await?;
        self.records
            .lock()
            .expect("ロックが壊れていない")
            .remove(&card_id);
        let _ = self.events.send(ServerMessage::SessionRemoved { card_id });
        Ok(())
    }

    async fn status(
        &self,
        card_id: CardId,
        status: SessionStatus,
        subagent_active: u32,
        last_activity_at: i64,
    ) -> Result<(), DbErr> {
        let Some(record) = self.get(card_id) else {
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
        let _ = self.events.send(ServerMessage::Status {
            card_id,
            status,
            subagent_active,
            last_activity_at,
        });
        Ok(())
    }

    async fn append(&self, card_id: CardId, nodes: Vec<TreeNode>) -> Result<(), DbErr> {
        let Some(record) = self.get(card_id) else {
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
        record.fanout(&ServerMessage::TranscriptAppend { card_id, nodes });
        Ok(())
    }

    async fn reset(&self, card_id: CardId) -> Result<(), DbErr> {
        let Some(record) = self.get(card_id) else {
            return Ok(());
        };
        {
            let mut next = record.next_seq.lock().await;
            db_transcript::reset(&self.db, card_id).await?;
            // 全部消したので番号も最初から。残すと、次のノードが遠い番号から始まる
            *next = 0;
        }
        record.window.lock().expect("ロックが壊れていない").clear();
        record.fanout(&ServerMessage::TranscriptReset { card_id });
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
            toml_account: Set(None),
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
                        // `Archived` は**更新しない**。外したことは後から届く報告で
                        // 取り消されてはいけない（上の `upsert` の門と対になっている）
                    ])
                    .to_owned(),
            )
            .exec(&self.db)
            .await?;
        Ok(())
    }

    /// そのカードが既に外されているか。行が無ければ「外していない」。
    async fn is_archived(&self, card_id: CardId) -> Result<bool, DbErr> {
        Ok(entity::sessions::Entity::find_by_id(card_id.0)
            .one(&self.db)
            .await?
            .is_some_and(|row| row.archived))
    }

    /// そのカードの記録を取り出す。無ければ作る。
    async fn record_for(&self, card_id: CardId) -> Result<Arc<SessionRecord>, DbErr> {
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
    }
}
