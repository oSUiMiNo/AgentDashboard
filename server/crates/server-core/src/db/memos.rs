//! メモの読み書き（メモ設計§3・§7・§11）。
//!
//! # 全部の関数が `account_id` を取る
//!
//! `notices` と同じ「フラットな DB リソース」で、カードのような所有権チェックが
//! 要らない代わりに、**絞りを忘れた瞬間に他人のメモが出る**。引数の1本目に置いて
//! あるのは、忘れたらコンパイルが通らないようにするため。
//!
//! # 宛先の絞り込みを1か所へ閉じる
//!
//! 宛先は `target_kind` ＋ `target_session_id` の2列なので、条件は必ず組で書く。
//! 関数ごとに書くと**片方を落とした関数が1本混ざる**——全体メモの一覧に他人の
//! セッションメモが出る、という形で表に出る。[`target_filter`] を全関数が通る。
//!
//! **フェーズ3 で `AnnotationTarget` を受けるようになったら、差し替えるのはここだけ。**
//!
//! # 時刻はサーバが打つ
//!
//! メモは PC とスマホの両方から書かれ、セッションは別の機械の上に居ることもある。
//! **書いた端末の時計を使うと、並び順が端末ごとに変わる**（設計§7-2）。だから
//! `noted_at` も `checked_at` も引数で受け取らず、この層で [`super::now_ms`] を打つ。
//!
//! # 掃除は常駐タスクで回す
//!
//! `notices` と同じ形。**動いている間ずっと増える**ので、起動時に1回では足りない。
//! ただし保持日数は**アカウントごとの設定**なので、アカウントを1つずつ見る。

use super::entity::memos;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use std::time::Duration;
use uuid::Uuid;

/// 掃除の間隔。`notices` と揃えてある。
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// 宛先の綴り。**閉じた列挙にしない**（`notices.source` と同じ流儀）。
pub const TARGET_GLOBAL: &str = "global";
pub const TARGET_SESSION: &str = "session";

/// 宛先で絞る条件。**2列を必ず組で見る。**
///
/// 全体メモは `target_session_id` が空であることまで見る——見ないと、
/// **`target_kind` だけ一致する行が全部混ざる**。
fn target_filter(target_kind: &str, target_session_id: Option<Uuid>) -> Condition {
    let mut condition = Condition::all().add(memos::Column::TargetKind.eq(target_kind.to_owned()));
    condition = match target_session_id {
        Some(id) => condition.add(memos::Column::TargetSessionId.eq(id)),
        None => condition.add(memos::Column::TargetSessionId.is_null()),
    };
    condition
}

/// 1行積む。**時刻はここで打つ**（端末から受け取らない）。
pub async fn add(
    db: &DatabaseConnection,
    account_id: Uuid,
    target_kind: &str,
    target_session_id: Option<Uuid>,
    body: serde_json::Value,
) -> Result<memos::Model, DbErr> {
    let id = Uuid::new_v4();
    let noted_at = super::now_ms();
    let row = memos::ActiveModel {
        id: Set(id),
        account_id: Set(account_id),
        target_kind: Set(target_kind.to_owned()),
        target_session_id: Set(target_session_id),
        body: Set(body.clone()),
        noted_at: Set(noted_at),
        checked_at: Set(None),
    };
    memos::Entity::insert(row).exec(db).await?;
    Ok(memos::Model {
        id,
        account_id,
        target_kind: target_kind.to_owned(),
        target_session_id,
        body,
        noted_at,
        checked_at: None,
    })
}

/// 宛先ぶんを、画面に出る順で返す（設計§7-1）。
///
/// **2段になっている。** 上段はチェック済みを**チェックした時刻**の順、下段は未チェックを
/// **メモの時刻**の順。どちらも**新しいものが下**（チャットと同じ向き）。
///
/// **問い合わせを2本に分けているのは、索引が2本あるからである**——1本で取って
/// あとから並べ替えると、どちらかが全走査になる。
///
/// 時刻が同じ行は `id` で崩す。崩さないと SQLite と PostgreSQL で並びが変わりうる。
pub async fn list(
    db: &DatabaseConnection,
    account_id: Uuid,
    target_kind: &str,
    target_session_id: Option<Uuid>,
) -> Result<Vec<memos::Model>, DbErr> {
    let filter = target_filter(target_kind, target_session_id);

    // 上段：片付いたもの
    let mut rows = memos::Entity::find()
        .filter(memos::Column::AccountId.eq(account_id))
        .filter(filter.clone())
        .filter(memos::Column::CheckedAt.is_not_null())
        .order_by_asc(memos::Column::CheckedAt)
        .order_by_asc(memos::Column::Id)
        .all(db)
        .await?;

    // 下段：いま関係のあるもの
    let live = memos::Entity::find()
        .filter(memos::Column::AccountId.eq(account_id))
        .filter(filter)
        .filter(memos::Column::CheckedAt.is_null())
        .order_by_asc(memos::Column::NotedAt)
        .order_by_asc(memos::Column::Id)
        .all(db)
        .await?;

    rows.extend(live);
    Ok(rows)
}

/// 本文を差し替える。**中身が変わったときだけ時刻を進める**（設計§7-3）。
///
/// 変わっていなければ `noted_at` を据え置くので、**並びも動かない**。要件4 が
/// 「内容が変わっていなければ時刻はそのまま」と定めている。
///
/// **比べるのはサーバ側である。** ブラウザで比べると、**別の端末が先に書き換えていた
/// 場合に誤判定する**（画面が持っているのは自分が最後に見た版でしかない）。
///
/// 宛先の無い `id` 指定なので、`account_id` の絞りがここでの防壁になる。
/// 見つからなければ `Ok(None)`——**他人の行を指したときも同じ答えになる**。
pub async fn edit(
    db: &DatabaseConnection,
    account_id: Uuid,
    id: Uuid,
    body: serde_json::Value,
) -> Result<Option<memos::Model>, DbErr> {
    let Some(current) = memos::Entity::find()
        .filter(memos::Column::Id.eq(id))
        .filter(memos::Column::AccountId.eq(account_id))
        .one(db)
        .await?
    else {
        return Ok(None);
    };

    let unchanged = current.body == body;
    let noted_at = if unchanged {
        current.noted_at
    } else {
        super::now_ms()
    };

    let mut row: memos::ActiveModel = current.into();
    row.body = Set(body);
    row.noted_at = Set(noted_at);
    let updated = memos::Entity::update(row).exec(db).await?;
    Ok(Some(updated))
}

/// チェックを入れる／外す。**時刻はここで打つ。**
///
/// `checked` が `false` なら `checked_at` を空に戻す——**下段のメモの時刻の位置へ
/// 帰る**（設計§7-5）。`noted_at` は触らないので、元の位置に戻る。
pub async fn check(
    db: &DatabaseConnection,
    account_id: Uuid,
    id: Uuid,
    checked: bool,
) -> Result<Option<memos::Model>, DbErr> {
    let Some(current) = memos::Entity::find()
        .filter(memos::Column::Id.eq(id))
        .filter(memos::Column::AccountId.eq(account_id))
        .one(db)
        .await?
    else {
        return Ok(None);
    };

    let mut row: memos::ActiveModel = current.into();
    row.checked_at = Set(checked.then(super::now_ms));
    let updated = memos::Entity::update(row).exec(db).await?;
    Ok(Some(updated))
}

/// 1件消す（設計§7-8 の「消す道」）。**他人のものは消せない。**
pub async fn remove(db: &DatabaseConnection, account_id: Uuid, id: Uuid) -> Result<u64, DbErr> {
    let result = memos::Entity::delete_many()
        .filter(memos::Column::Id.eq(id))
        .filter(memos::Column::AccountId.eq(account_id))
        .exec(db)
        .await?;
    Ok(result.rows_affected)
}

/// 期限切れを落とす（設計§11）。**戻り値は消した件数。**
///
/// **保持日数はアカウントごとの設定**なので、アカウントを1つずつ見る。行が無ければ
/// `fallback_days` を使う（設計§11-2——toml のキーは消さず、初期値として読み続ける）。
///
/// 数えるのは `noted_at`。**編集すると延命する**が、それでよい——「最終更新から
/// 3か月」が要件10 の言い方である。
pub async fn sweep(db: &DatabaseConnection, now_ms: i64, fallback_days: u64) -> Result<u64, DbErr> {
    let mut removed = 0;
    for account_id in accounts_with_memos(db).await? {
        let days = super::settings::memo_retention_days_or(db, account_id, fallback_days).await;
        let cutoff = now_ms - (days as i64) * 24 * 60 * 60 * 1000;
        removed += memos::Entity::delete_many()
            .filter(memos::Column::AccountId.eq(account_id))
            .filter(memos::Column::NotedAt.lt(cutoff))
            .exec(db)
            .await?
            .rows_affected;
    }
    Ok(removed)
}

/// メモを1件でも持っているアカウントを引く。
///
/// **保持日数がアカウントごとに違いうる**ので、全体を1つの期限で消せない。
/// 個人用の道具なのでアカウントの数はたかが知れており、1つずつ削っても安い
/// （`notices::sweep` が同じ理由で同じ形を採っている）。
async fn accounts_with_memos(db: &DatabaseConnection) -> Result<Vec<Uuid>, DbErr> {
    let mut ids: Vec<Uuid> = memos::Entity::find()
        .select_only()
        .column(memos::Column::AccountId)
        .group_by(memos::Column::AccountId)
        .into_tuple::<Uuid>()
        .all(db)
        .await?;
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// 1時間ごとに掃く常駐タスクを立てる。
///
/// **`SessionRegistry::load()` から呼ぶ**（`notices::start_sweeper` と同じ形）。
/// 呼び出し側に任せると忘れる。
pub fn start_sweeper(db: DatabaseConnection, fallback_days: u64) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            let now = super::now_ms();
            if let Err(err) = sweep(&db, now, fallback_days).await {
                // 掃除に失敗してもメモは読める。黙って止まらないよう記録だけ残す
                tracing::warn!("メモの掃除に失敗しました: {err}");
            }
        }
    })
}
