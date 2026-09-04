//! アプリ全体の知らせの読み書き（トーストとベル設計§4・§5）。
//!
//! # 全部の関数が `account_id` を取る
//!
//! `projects` と同じ「フラットな DB リソース」で、カードのような所有権チェックが
//! 要らない代わりに、**絞りを忘れた瞬間に他人の知らせが出る**。引数の1本目に置いて
//! あるのは、忘れたらコンパイルが通らないようにするため。
//!
//! # 掃除は常駐タスクで回す
//!
//! ログと添付は**ファイル**なので起動時に1回掃けば足りるが、こちらは DB なので
//! **動いている間ずっと増える**。`web_session_store` の掃除と同じ形にしてある。
//!
//! # 上限は2本立て
//!
//! 日数（古いものを消す）と件数（アカウントごとに溢れたぶんを消す）。片方だけだと、
//! 「1日で200件出た」か「30日かけて少しずつ溜まった」のどちらかを取りこぼす。

use super::entity::notices;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use std::time::Duration;
use uuid::Uuid;

/// 掃除の間隔。`web_session_store` と揃えてある。
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// 一覧の1ページあたりの既定。
pub const DEFAULT_PAGE_LIMIT: u64 = 50;

/// 1ページで返せる上限。**これ以上は要求されても切る**（記録が育っても応答が膨らまない）。
pub const MAX_PAGE_LIMIT: u64 = 200;

/// 積む。**呼ぶ側は失敗を握りつぶしてよい**（設計§4-3）。
pub async fn push(
    db: &DatabaseConnection,
    account_id: Uuid,
    card_id: Option<Uuid>,
    source: &str,
    kind: &str,
    message: &str,
    created_at: i64,
) -> Result<notices::Model, DbErr> {
    let row = notices::ActiveModel {
        id: Set(Uuid::new_v4()),
        account_id: Set(account_id),
        card_id: Set(card_id),
        source: Set(source.to_owned()),
        kind: Set(kind.to_owned()),
        message: Set(message.to_owned()),
        created_at: Set(created_at),
        read_at: Set(None),
    };
    notices::Entity::insert(row.clone())
        .exec(db)
        .await
        .map(|_| notices::Model {
            id: match row.id {
                Set(id) => id,
                _ => unreachable!("id は Set で作っている"),
            },
            account_id,
            card_id,
            source: source.to_owned(),
            kind: kind.to_owned(),
            message: message.to_owned(),
            created_at,
            read_at: None,
        })
}

/// 新しい順に1ページ読む。
///
/// `before` は「その時刻より古いものから」。**時刻が同じ行は `id` で崩す**——崩さないと
/// SQLite と PostgreSQL で並びが変わりうる。
///
/// 戻り値の `bool` は「まだ続きがあるか」。**`limit + 1` 件取って判定する**ので、
/// 件数を数える問い合わせを別に投げない（`transcript::page` と同じ手）。
pub async fn list_page(
    db: &DatabaseConnection,
    account_id: Uuid,
    before: Option<i64>,
    limit: u64,
) -> Result<(Vec<notices::Model>, bool), DbErr> {
    let limit = limit.clamp(1, MAX_PAGE_LIMIT);
    let mut query = notices::Entity::find().filter(notices::Column::AccountId.eq(account_id));
    if let Some(before) = before {
        query = query.filter(notices::Column::CreatedAt.lt(before));
    }
    let mut rows = query
        .order_by_desc(notices::Column::CreatedAt)
        .order_by_desc(notices::Column::Id)
        .limit(limit + 1)
        .all(db)
        .await?;
    let has_more = rows.len() as u64 > limit;
    rows.truncate(limit as usize);
    Ok((rows, has_more))
}

/// 未読の数。**バッジはこれで出す。**
pub async fn unread_count(db: &DatabaseConnection, account_id: Uuid) -> Result<u64, DbErr> {
    notices::Entity::find()
        .filter(notices::Column::AccountId.eq(account_id))
        .filter(notices::Column::ReadAt.is_null())
        .count(db)
        .await
}

/// 未読をまとめて既読にする。**戻り値は何件に印を付けたか。**
///
/// 1件ずつの既読は作らない（設計§10-3——ベルを開いた瞬間に全部を既読にする）。
pub async fn mark_all_read(
    db: &DatabaseConnection,
    account_id: Uuid,
    read_at: i64,
) -> Result<u64, DbErr> {
    let result = notices::Entity::update_many()
        .col_expr(
            notices::Column::ReadAt,
            sea_orm::sea_query::Expr::value(read_at),
        )
        .filter(notices::Column::AccountId.eq(account_id))
        .filter(notices::Column::ReadAt.is_null())
        .exec(db)
        .await?;
    Ok(result.rows_affected)
}

/// 1件消す。**他人のものは消せない**（絞りがここに入っている）。
pub async fn remove(db: &DatabaseConnection, account_id: Uuid, id: Uuid) -> Result<u64, DbErr> {
    let result = notices::Entity::delete_many()
        .filter(notices::Column::Id.eq(id))
        .filter(notices::Column::AccountId.eq(account_id))
        .exec(db)
        .await?;
    Ok(result.rows_affected)
}

/// そのアカウントの知らせを全部消す。
pub async fn clear(db: &DatabaseConnection, account_id: Uuid) -> Result<u64, DbErr> {
    let result = notices::Entity::delete_many()
        .filter(notices::Column::AccountId.eq(account_id))
        .exec(db)
        .await?;
    Ok(result.rows_affected)
}

/// 古いものと、溢れたぶんを消す（設計§5-1）。
///
/// **日数と件数の両方を見る。** 日数だけだと「1日で200件出た」を取りこぼし、件数だけだと
/// 「30日かけて少しずつ溜まった」を取りこぼす。
///
/// 件数はアカウントごとに数える。**他人の件数に巻き込まれない**ようにするため。
pub async fn sweep(
    db: &DatabaseConnection,
    now_ms: i64,
    retention_days: u64,
    max_rows: u64,
) -> Result<u64, DbErr> {
    let mut removed = 0;

    // 古いものを落とす
    let cutoff = now_ms - (retention_days as i64) * 24 * 60 * 60 * 1000;
    removed += notices::Entity::delete_many()
        .filter(notices::Column::CreatedAt.lt(cutoff))
        .exec(db)
        .await?
        .rows_affected;

    // アカウントごとに溢れたぶんを落とす。
    //
    // **生の SQL で `GROUP BY ... HAVING` を書かない。** SQLite と PostgreSQL の両方へ
    // 流すので、方言の差を持ち込みたくない（`make test-compose` が両方を通す）。
    // 個人用の道具なのでアカウントの数はたかが知れており、1つずつ削っても安い
    for account_id in accounts_with_notices(db).await? {
        removed += trim_account(db, account_id, max_rows).await?;
    }

    Ok(removed)
}

/// 知らせを1件でも持っているアカウントを引く。
///
/// **溢れているかはここで判定しない。** 判定は [`trim_account`] が行い、溢れていなければ
/// 0 を返す——「数える」と「削る」を2回に分けると、その間に増えたぶんを取りこぼす。
async fn accounts_with_notices(db: &DatabaseConnection) -> Result<Vec<Uuid>, DbErr> {
    let mut ids: Vec<Uuid> = notices::Entity::find()
        .select_only()
        .column(notices::Column::AccountId)
        .group_by(notices::Column::AccountId)
        .into_tuple::<Uuid>()
        .all(db)
        .await?;
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// 1アカウントぶんを上限まで削る。**古いものから捨てる。**
async fn trim_account(
    db: &DatabaseConnection,
    account_id: Uuid,
    max_rows: u64,
) -> Result<u64, DbErr> {
    if max_rows == 0 {
        return Ok(0);
    }

    // **境目の1行だけを引いて、そこより古いものをまとめて消す。**
    //
    // 「残すぶんを飛ばして、そこから先を全部引く」（`OFFSET` だけ）とは書けない——
    // **SQLite は `LIMIT` の無い `OFFSET` を構文エラーにする**。件数ぶんの id を
    // 持ち帰らずに済むので、溢れが大きいときも問い合わせが膨らまない。
    let Some(keep) = notices::Entity::find()
        .filter(notices::Column::AccountId.eq(account_id))
        .order_by_desc(notices::Column::CreatedAt)
        .order_by_desc(notices::Column::Id)
        .limit(1)
        .offset(max_rows - 1)
        .one(db)
        .await?
    else {
        // 上限に届いていない
        return Ok(0);
    };

    // 並びは `(created_at, id)` の降順なので、**その組より小さいものが捨てる側**になる。
    // `created_at` だけで切ると、**同じ時刻の行がまとめて落ちる**（積んだ瞬間が
    // 揃うことは実際にある）
    let older = Condition::any()
        .add(notices::Column::CreatedAt.lt(keep.created_at))
        .add(
            Condition::all()
                .add(notices::Column::CreatedAt.eq(keep.created_at))
                .add(notices::Column::Id.lt(keep.id)),
        );

    let result = notices::Entity::delete_many()
        .filter(notices::Column::AccountId.eq(account_id))
        .filter(older)
        .exec(db)
        .await?;
    Ok(result.rows_affected)
}

/// 1時間ごとに掃く常駐タスクを立てる。
///
/// **`SessionRegistry::load()` から呼ぶ**（設計§5-3）。呼び出し側に任せると忘れる。
pub fn start_sweeper(
    db: DatabaseConnection,
    retention_days: u64,
    max_rows: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            let now = super::now_ms();
            if let Err(err) = sweep(&db, now, retention_days, max_rows).await {
                // 掃除に失敗しても知らせは届く。黙って止まらないよう記録だけ残す
                tracing::warn!("知らせの掃除に失敗しました: {err}");
            }
        }
    })
}
