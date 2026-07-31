//! ブラウザのログインセッションの置き場所（セルフホスト化設計§8-2）。
//!
//! # なぜ自前で書くのか
//!
//! 既製の `tower-sessions-sqlx-store` を使わない理由は設計§8-2 のとおり——2025-01 から
//! 更新が止まって `tower-sessions` 0.15 と噛み合わず、さらに sqlx 0.8 依存が SeaORM の
//! sqlx 0.9 と**二重ビルド**になる。トレイトは4メソッドしかないので、SeaORM で書いた
//! ほうが依存も見通しも軽い。
//!
//! # フェーズ2 では誰も使わない
//!
//! ログインへの結線はフェーズ5。ここで先に作るのは、**DB 層を統合前に単体で固める**
//! というフェーズ2 の趣旨（テスト計画F2）に沿っている。認証を入れる回に、置き場所の
//! バグまで一緒に踏まないようにするための順序。

use super::entity::web_sessions;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter};
use std::time::Duration;
use time::OffsetDateTime;
use tower_sessions::session::{Id, Record};
use tower_sessions::session_store::{Error, ExpiredDeletion, Result, SessionStore};

/// 期限切れを掃除する間隔（設計§3-2）。
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone)]
pub struct DbSessionStore {
    db: DatabaseConnection,
}

impl DbSessionStore {
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db }
    }

    /// 期限切れを1時間ごとに掃除する常駐タスクを立てる。
    ///
    /// 掃除しないと**溜まり続ける**。ログインのたびに行が増え、消えるのは明示的な
    /// ログアウトのときだけになる。
    pub fn start_sweeper(&self) -> tokio::task::JoinHandle<()> {
        let store = self.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
            loop {
                ticker.tick().await;
                if let Err(err) = store.delete_expired().await {
                    // 掃除に失敗しても認証は動く。黙って止まらないよう記録だけ残す
                    tracing::warn!("ログインセッションの掃除に失敗しました: {err}");
                }
            }
        })
    }

    /// 入館証を**全部**捨てる（設計§8-3・利用者判断）。
    ///
    /// LAN のパスワードを変えたときに呼ぶ。変える動機はたいてい「漏れたかもしれない」
    /// なので、変えたのに既に入っている端末が居座れては意味が無い。
    ///
    /// 対象を LAN のぶんに絞らないのは、**中身を読まずに済ませるため**。絞るには全行の
    /// JSON を開いて種別を見ることになり、そのために「どう保存されているか」を
    /// ここが知る必要が出る。捨てすぎても、もう一度ログインすれば済む。
    pub async fn delete_all(db: &DatabaseConnection) -> std::result::Result<(), DbErr> {
        web_sessions::Entity::delete_many().exec(db).await?;
        Ok(())
    }

    fn encode(record: &Record) -> Result<Vec<u8>> {
        serde_json::to_vec(record).map_err(|err| Error::Encode(err.to_string()))
    }

    fn decode(row: &web_sessions::Model) -> Result<Record> {
        serde_json::from_slice(&row.data).map_err(|err| Error::Decode(err.to_string()))
    }

    fn row(record: &Record) -> Result<web_sessions::ActiveModel> {
        Ok(web_sessions::ActiveModel {
            id: Set(record.id.to_string()),
            data: Set(Self::encode(record)?),
            expiry_date: Set(record.expiry_date.unix_timestamp()),
        })
    }
}

#[async_trait::async_trait]
impl SessionStore for DbSessionStore {
    /// 新しいセッションを作る。
    ///
    /// **既にあるIDを踏んだら採番し直す。** 上書きにすると、たまたま同じIDが出たときに
    /// 他人のセッションを乗っ取ることになる（トレイトが `save` と分けている理由そのもの）。
    async fn create(&self, record: &mut Record) -> Result<()> {
        loop {
            let inserted = web_sessions::Entity::insert(Self::row(record)?)
                .on_conflict(
                    OnConflict::column(web_sessions::Column::Id)
                        .do_nothing()
                        .to_owned(),
                )
                .exec(&self.db)
                .await;

            match inserted {
                Ok(_) => return Ok(()),
                // 何も入らなかった＝そのIDは既に埋まっている
                Err(DbErr::RecordNotInserted) => {
                    // 128bit の乱数なので、ここへ来ること自体がまず無い
                    record.id = Id(uuid::Uuid::new_v4().as_u128() as i128);
                }
                Err(err) => return Err(Error::Backend(err.to_string())),
            }
        }
    }

    async fn save(&self, record: &Record) -> Result<()> {
        web_sessions::Entity::insert(Self::row(record)?)
            .on_conflict(
                OnConflict::column(web_sessions::Column::Id)
                    .update_columns([web_sessions::Column::Data, web_sessions::Column::ExpiryDate])
                    .to_owned(),
            )
            .exec(&self.db)
            .await
            .map_err(|err| Error::Backend(err.to_string()))?;
        Ok(())
    }

    async fn load(&self, session_id: &Id) -> Result<Option<Record>> {
        let found = web_sessions::Entity::find_by_id(session_id.to_string())
            .filter(web_sessions::Column::ExpiryDate.gt(OffsetDateTime::now_utc().unix_timestamp()))
            .one(&self.db)
            .await
            .map_err(|err| Error::Backend(err.to_string()))?;

        // 期限切れは**無かったことにする**（掃除を待たずに効かせる）。掃除は1時間ごとで、
        // その間に失効したセッションが通ってしまうと TTL の意味が無くなる
        found.as_ref().map(Self::decode).transpose()
    }

    async fn delete(&self, session_id: &Id) -> Result<()> {
        web_sessions::Entity::delete_by_id(session_id.to_string())
            .exec(&self.db)
            .await
            .map_err(|err| Error::Backend(err.to_string()))?;
        Ok(())
    }
}

#[async_trait::async_trait]
impl ExpiredDeletion for DbSessionStore {
    async fn delete_expired(&self) -> Result<()> {
        web_sessions::Entity::delete_many()
            .filter(web_sessions::Column::ExpiryDate.lt(OffsetDateTime::now_utc().unix_timestamp()))
            .exec(&self.db)
            .await
            .map_err(|err| Error::Backend(err.to_string()))?;
        Ok(())
    }
}
