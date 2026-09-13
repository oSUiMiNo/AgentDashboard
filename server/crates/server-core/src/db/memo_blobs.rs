//! 全体メモの画像の出し入れと掃除（メモ設計§10-1 の【決着】・§10-2）。
//!
//! # ここは PC を1バイトも通らない
//!
//! 全体メモは**アカウントに属する**ので、画像もサーバの記録に置く。したがって
//! **A2S もセッションホストも通らない**——セッションメモの画像（PC のディスク）
//! とは経路そのものが別である。
//!
//! # 掃除の作法は既存と揃える
//!
//! 段は2つ（期間 → 容量）で、**容量のほうは「上限を下回るまで」ではなく「決めた量
//! だけ」**（利用者の指定・2026-09-01）。`attachments::sweep` と同じ形にしてある
//! ——**同じ機能の掃除が2つの規則で動くと、利用者にはどちらが効いたのか分からない。**
//!
//! **同意が要るのは容量のぶんだけ**（要件10）。期間で消えるのは黙って消す既存の
//! 振る舞いに合わせる。

use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use std::time::Duration;
use uuid::Uuid;

use super::entity::memo_blobs;

/// 掃除の間隔。**既存の掃除と同じ1時間**（`memos` ／ `notices` ／ `web_session_store`）。
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// 1枚の上限。**既存の添付と同じ値**（`protocol::fs::MAX_BLOB_BYTES`）。
///
/// 揃えるのは、**貼る側が同じ `pickImages` を通る**ため。片方だけ緩めると
/// 「入力欄には貼れるのにメモには貼れない」が生まれる。
pub const MAX_BLOB_BYTES: u64 = protocol::fs::MAX_BLOB_BYTES;

/// 置く。**大きさは呼ぶ側が確かめてから渡す**（断り文を分けるため）。
pub async fn put(
    db: &DatabaseConnection,
    account: Uuid,
    media_type: &str,
    data: Vec<u8>,
    now_ms: i64,
) -> Result<Uuid, DbErr> {
    use sea_orm::ActiveValue::Set;
    let id = Uuid::new_v4();
    let bytes = i64::try_from(data.len()).unwrap_or(i64::MAX);
    memo_blobs::ActiveModel {
        id: Set(id),
        account_id: Set(account),
        media_type: Set(media_type.to_string()),
        data: Set(data),
        bytes: Set(bytes),
        created_at: Set(now_ms),
    }
    .insert(db)
    .await?;
    Ok(id)
}

/// 読む。**他人のものは引けない**——`account` で必ず絞る。
pub async fn get(
    db: &DatabaseConnection,
    account: Uuid,
    id: Uuid,
) -> Result<Option<memo_blobs::Model>, DbErr> {
    memo_blobs::Entity::find_by_id(id)
        .filter(memo_blobs::Column::AccountId.eq(account))
        .one(db)
        .await
}

/// 掃除の下見／結果（メモ設計§10-2）。**PC 側の [`protocol::AttachmentSweep`] と同じ形。**
///
/// **同じ型を使う。** 画面から見ると「メモの画像が溢れた」は1つの出来事なので、
/// 置き場所が2つあることを画面に見せない。
pub async fn survey_or_sweep(
    db: &DatabaseConnection,
    account: Uuid,
    now_ms: i64,
    retention_days: u64,
    max_bytes: u64,
    sweep_bytes: u64,
    apply: bool,
) -> Result<protocol::AttachmentSweep, DbErr> {
    // **古い順に引く。** 掃除も同意の画面も、この並びを根拠にしている
    let rows = memo_blobs::Entity::find()
        .filter(memo_blobs::Column::AccountId.eq(account))
        .order_by_asc(memo_blobs::Column::CreatedAt)
        .order_by_asc(memo_blobs::Column::Id)
        .all(db)
        .await?;

    let cutoff = now_ms - (retention_days as i64) * 24 * 60 * 60 * 1000;
    let mut answer = protocol::AttachmentSweep {
        applied: apply,
        ..Default::default()
    };

    let mut 残り: Vec<&memo_blobs::Model> = Vec::new();
    let mut 期限切れ: Vec<Uuid> = Vec::new();
    for row in &rows {
        let size = u64::try_from(row.bytes).unwrap_or(0);
        answer.total = answer.total.saturating_add(size);
        if row.created_at < cutoff {
            // **期間で消えるぶんには同意を求めない**（既存の振る舞い）
            answer.expiring += 1;
            answer.expiring_bytes = answer.expiring_bytes.saturating_add(size);
            期限切れ.push(row.id);
            continue;
        }
        残り.push(row);
    }

    // 期間で消したあとの合計が上限を超えているか
    let のこる = answer.total.saturating_sub(answer.expiring_bytes);
    answer.over_budget = のこる > max_bytes;

    let mut 消す: Vec<Uuid> = Vec::new();
    if answer.over_budget {
        let mut freed: u64 = 0;
        for row in 残り {
            if freed >= sweep_bytes {
                break;
            }
            let size = u64::try_from(row.bytes).unwrap_or(0);
            answer.removed += 1;
            answer.freed = answer.freed.saturating_add(size);
            freed = freed.saturating_add(size);
            消す.push(row.id);
        }
    }

    if !apply {
        // **1バイトも触らない。** 同意を取る前に消えていたら、同意は事後報告になる
        return Ok(answer);
    }

    // **期限切れは同意によらず消す**（既存の振る舞い）
    let mut 全部 = 期限切れ;
    全部.extend(消す);
    if !全部.is_empty() {
        memo_blobs::Entity::delete_many()
            .filter(memo_blobs::Column::AccountId.eq(account))
            .filter(memo_blobs::Column::Id.is_in(全部))
            .exec(db)
            .await?;
    }
    answer.over_budget = のこる.saturating_sub(answer.freed) > max_bytes;
    Ok(answer)
}

/// 期限切れの画像を落とす（レビュー対応2・設計§11）。**戻り値は消した件数。**
///
/// # 容量のぶんは掃かない
///
/// [`survey_or_sweep`] は期間と容量の2段を持つが、**ここで渡す `sweep_bytes` は 0**
/// である。**容量で消すには同意が要る**（要件10）ので、**常駐の掃除が勝手に消しては
/// いけない**——同意を求める画面が在るのに、その裏で消えていたら同意の意味が無い。
///
/// **期間で消えるぶんは黙って消す。** これは既存の振る舞いに合わせている
/// （`attachments::sweep` と同じ）。
///
/// # 保持日数はアカウントごと
///
/// 行が無ければ `fallback_days` を使う（設計§11-2——toml のキーは消さず、初期値と
/// して読み続ける）。`memos::sweep` と同じ形である。
async fn sweep_expired(
    db: &DatabaseConnection,
    now_ms: i64,
    fallback_days: u64,
) -> Result<u64, DbErr> {
    let mut removed = 0;
    for account_id in accounts_with_blobs(db).await? {
        let days = super::settings::memo_retention_days_or(db, account_id, fallback_days).await;
        let limits = super::settings::memo_limits(db, account_id).await?;
        // **`sweep_bytes` は 0。** 容量のぶんは同意を取ってからでないと消せない
        let answer =
            survey_or_sweep(db, account_id, now_ms, days, limits.max_bytes, 0, true).await?;
        removed += answer.expiring;
    }
    Ok(removed)
}

/// 画像を1枚でも持っているアカウントを引く。
///
/// **保持日数がアカウントごとに違いうる**ので、全体を1つの期限で消せない。
/// `memos::accounts_with_memos` と同じ形である。
async fn accounts_with_blobs(db: &DatabaseConnection) -> Result<Vec<Uuid>, DbErr> {
    let mut ids: Vec<Uuid> = memo_blobs::Entity::find()
        .select_only()
        .column(memo_blobs::Column::AccountId)
        .group_by(memo_blobs::Column::AccountId)
        .into_tuple::<Uuid>()
        .all(db)
        .await?;
    ids.sort_unstable();
    Ok(ids)
}

/// 掃除を常駐させる（レビュー対応2）。
///
/// **`SessionRegistry::load()` から呼ぶ**——`memos::start_sweeper` ／
/// `notices::start_sweeper` と同じ場所である。**呼び出し側に任せると忘れる。**
///
/// 実際、この関数が無かったせいで**消したメモや期限切れの画像が永久に残っていた**
/// ——HTTP の口から `survey_or_sweep` を呼ぶ道しかなく、**画像を貼るのをやめた
/// 利用者の blob は、保持期間を過ぎても掃かれなかった。**
pub fn start_sweeper(db: DatabaseConnection, fallback_days: u64) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            let now = super::now_ms();
            if let Err(err) = sweep_expired(&db, now, fallback_days).await {
                // 掃除に失敗しても画像は読める。黙って止まらないよう記録だけ残す
                tracing::warn!("メモの画像の掃除に失敗しました: {err}");
            }
        }
    })
}
