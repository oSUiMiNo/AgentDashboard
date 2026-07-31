//! ペアリング（アカウント・トークン・登録済みの PC）の読み書き（セルフホスト化設計§8-4）。
//!
//! # 平文は一度きり
//!
//! 発行のときに1回だけ返し、DB には SHA-256 のハッシュしか置かない。**低速ハッシュ
//! （argon2）にはしない**——トークンは 256bit の乱数なので辞書攻撃が成立せず、接続の
//! たびにハッシュ一致で引ける必要があるため（§3-2）。利用者が自分で決めるパスワードとは
//! 要求が違うので、同じ道具を使い回さない。
//!
//! # PC の同一性は「アカウント × 名前」
//!
//! `agents` の行は接続のたびに作らず、(アカウント, 名前) で引いて無ければ作る。こうすると
//! **エージェントを再起動しても同じ `agent_id` に戻る**ので、そのPCのカードの帰属
//! （`sessions.agent_id`）が切れない。トークンを引数にしないのは、1台のPCのトークンを
//! 入れ替えても同じ PC であり続けてほしいため。

use super::{entity, now_ms};
use base64::Engine as _;
use protocol::AgentId;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

/// 発行するトークンの接頭辞。ログや設定ファイルの中で「これは鍵だ」と分かるように付ける。
pub const TOKEN_PREFIX: &str = "adp_";

/// トークンを認められた結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenOwner {
    pub token_id: Uuid,
    pub account_id: Uuid,
}

/// 照合に使う値へ潰す。**保存も照合も必ずここを通す**（片方だけ別の作り方をすると、
/// 発行したトークンが永久に一致しなくなる）。
pub fn token_hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 新しいトークンを1本作る。**平文はここでしか手に入らない。**
pub fn generate_token() -> String {
    // UUIDv4 を2つ並べて 32 バイト（乱数として 244 ビット）。専用の乱数クレートを
    // 足さずに済ませているが、出どころは同じ OS の乱数（uuid の v4）である
    let mut raw = [0u8; 32];
    raw[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    raw[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    format!(
        "{TOKEN_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
    )
}

/// アカウントを名前で引く。無ければ作る（**パスワードは持たせない**）。
///
/// ハッシュを空のまま作るのは、フェーズ3 のトークン発行がログインより先に来るため。
/// `password_hash` が `None` ＝ログインできない、という約束（§20 読み替え3）はここでも
/// 守られるので、パスワードを設定するまでこのアカウントでは画面に入れない。
pub async fn ensure_account(db: &DatabaseConnection, name: &str) -> Result<Uuid, DbErr> {
    if let Some(row) = entity::accounts::Entity::find()
        .filter(entity::accounts::Column::Name.eq(name))
        .one(db)
        .await?
    {
        return Ok(row.id);
    }

    let id = Uuid::new_v4();
    entity::accounts::Entity::insert(entity::accounts::ActiveModel {
        id: Set(id),
        name: Set(name.to_string()),
        password_hash: Set(None),
        is_admin: Set(false),
        created_at: Set(now_ms()),
    })
    .on_conflict_do_nothing()
    .exec(db)
    .await?;

    // 競合して入らなかった場合は、入っている方を引き直す（先に作った側が正）
    let row = entity::accounts::Entity::find()
        .filter(entity::accounts::Column::Name.eq(name))
        .one(db)
        .await?
        .ok_or_else(|| DbErr::Custom(format!("アカウントを作れませんでした: {name}")))?;
    Ok(row.id)
}

/// トークンを1本発行し、**平文を返す**。呼び出し側は一度だけ利用者に見せる。
pub async fn issue_token(
    db: &DatabaseConnection,
    account_id: Uuid,
    label: &str,
) -> Result<String, DbErr> {
    let token = generate_token();
    entity::pairing_tokens::Entity::insert(entity::pairing_tokens::ActiveModel {
        id: Set(Uuid::new_v4()),
        account_id: Set(account_id),
        token_hash: Set(token_hash(&token)),
        label: Set(label.to_string()),
        created_at: Set(now_ms()),
        last_used_at: Set(None),
        revoked_at: Set(None),
    })
    .exec(db)
    .await?;
    Ok(token)
}

/// 提示されたトークンを認める。失効済み・未知なら `None`。
///
/// **`None` の理由を区別して返さない。** 「そのトークンは存在するが失効している」と
/// 「そんなトークンは無い」を呼び分けられると、総当たりに手掛かりを与えることになる。
pub async fn resolve_token(
    db: &DatabaseConnection,
    token: &str,
) -> Result<Option<TokenOwner>, DbErr> {
    let Some(row) = entity::pairing_tokens::Entity::find()
        .filter(entity::pairing_tokens::Column::TokenHash.eq(token_hash(token)))
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    if row.revoked_at.is_some() {
        return Ok(None);
    }

    entity::pairing_tokens::Entity::update_many()
        .col_expr(
            entity::pairing_tokens::Column::LastUsedAt,
            sea_orm::sea_query::Expr::value(now_ms()),
        )
        .filter(entity::pairing_tokens::Column::Id.eq(row.id))
        .exec(db)
        .await?;

    Ok(Some(TokenOwner {
        token_id: row.id,
        account_id: row.account_id,
    }))
}

/// 登録済みの PC を引く。無ければ作る。
pub async fn ensure_agent(
    db: &DatabaseConnection,
    account_id: Uuid,
    name: &str,
) -> Result<AgentId, DbErr> {
    if let Some(row) = entity::agents::Entity::find()
        .filter(entity::agents::Column::AccountId.eq(account_id))
        .filter(entity::agents::Column::Name.eq(name))
        .one(db)
        .await?
    {
        touch_agent(db, AgentId(row.id)).await?;
        return Ok(AgentId(row.id));
    }

    let id = Uuid::new_v4();
    entity::agents::Entity::insert(entity::agents::ActiveModel {
        id: Set(id),
        account_id: Set(account_id),
        name: Set(name.to_string()),
        created_at: Set(now_ms()),
        last_seen_at: Set(Some(now_ms())),
        model_table: Set(None),
    })
    .exec(db)
    .await?;
    tracing::info!(agent_id = %id, %name, "新しい PC を登録しました");
    Ok(AgentId(id))
}

/// 「最後に見かけた時刻」を更新する。
pub async fn touch_agent(db: &DatabaseConnection, agent_id: AgentId) -> Result<(), DbErr> {
    entity::agents::Entity::update_many()
        .col_expr(
            entity::agents::Column::LastSeenAt,
            sea_orm::sea_query::Expr::value(now_ms()),
        )
        .filter(entity::agents::Column::Id.eq(agent_id.0))
        .exec(db)
        .await?;
    Ok(())
}

/// PC が名乗ったモデルの表を保存する（§13-4）。**中身は解釈しない。**
pub async fn save_model_table(
    db: &DatabaseConnection,
    agent_id: AgentId,
    table: serde_json::Value,
) -> Result<(), DbErr> {
    entity::agents::Entity::update_many()
        .col_expr(
            entity::agents::Column::ModelTable,
            sea_orm::sea_query::Expr::value(table),
        )
        .filter(entity::agents::Column::Id.eq(agent_id.0))
        .exec(db)
        .await?;
    Ok(())
}

/// そのアカウントの PC の表を全部集める（`GET /api/settings` の `model_tables`）。
///
/// **他のアカウントの PC は含めない**——絞り込み（§8-6）は REST でも同じ形で効かせる。
pub async fn model_tables(
    db: &DatabaseConnection,
    account_id: Uuid,
) -> Result<Vec<(AgentId, serde_json::Value)>, DbErr> {
    let rows = entity::agents::Entity::find()
        .filter(entity::agents::Column::AccountId.eq(account_id))
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| row.model_table.map(|table| (AgentId(row.id), table)))
        .collect())
}

/// 登録済みの PC の名前（一覧表示とログ用）。
pub async fn agent_names(
    db: &DatabaseConnection,
    account_id: Uuid,
) -> Result<Vec<(AgentId, String)>, DbErr> {
    let rows = entity::agents::Entity::find()
        .filter(entity::agents::Column::AccountId.eq(account_id))
        .select_only()
        .column(entity::agents::Column::Id)
        .column(entity::agents::Column::Name)
        .into_tuple::<(Uuid, String)>()
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name)| (AgentId(id), name))
        .collect())
}

/// 失効させる（アカウント画面からの操作。UI はフェーズ5）。
pub async fn revoke_token(db: &DatabaseConnection, token_id: Uuid) -> Result<(), DbErr> {
    entity::pairing_tokens::Entity::update_many()
        .col_expr(
            entity::pairing_tokens::Column::RevokedAt,
            sea_orm::sea_query::Expr::value(now_ms()),
        )
        .filter(entity::pairing_tokens::Column::Id.eq(token_id))
        .filter(entity::pairing_tokens::Column::RevokedAt.is_null())
        .exec(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 発行したトークンは接頭辞つきで毎回違う() {
        let first = generate_token();
        let second = generate_token();
        assert!(first.starts_with(TOKEN_PREFIX), "実際: {first}");
        assert_ne!(first, second);
        // base64url なので、URL やヘッダに載せても壊れる文字が出ない
        assert!(
            first
                .trim_start_matches(TOKEN_PREFIX)
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "実際: {first}"
        );
    }

    #[test]
    fn 同じトークンは同じ値へ潰れ_違うトークンは別の値になる() {
        // 保存と照合が同じ関数を通ることの確認。ここがずれると発行したトークンで
        // 二度と繋がらなくなる
        let token = generate_token();
        assert_eq!(token_hash(&token), token_hash(&token));
        assert_ne!(token_hash(&token), token_hash(&generate_token()));
        assert_eq!(token_hash(&token).len(), 64, "SHA-256 の16進表現");
    }
}
