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
};
use uuid::Uuid;

use super::entity::memo_blobs;

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
