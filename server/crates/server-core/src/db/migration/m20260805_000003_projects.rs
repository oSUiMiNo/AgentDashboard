//! 追加した PJT 枠の表を足す（イシューグループ_2026_0805_0514 設計§2・§3）。
//!
//! # 列名をここで別に書いている理由
//!
//! 既存2本と同じ流儀。entity を直接指せば短く書けるが、**列名を変えた瞬間に過去の
//! マイグレーションの意味が変わる**。ここは「作った時の形を凍らせた記録」なので、
//! entity とは独立に綴りを持つ。
//!
//! # 番兵だけは定数を借りる
//!
//! 列名と違い、`LOCAL_AGENT`（nil UUID）は**綴りが1箇所しか無いこと自体が約束**
//! （設計§2）。ここで値を直に書き直すと2箇所目になり、「1箇所」を機械で見ている
//! 検査が意味を失う。値は固定なので、借りても過去が動くことはない。
//!
//! # 表を作るだけでは足りない
//!
//! これが走った瞬間、**既存の利用者の枠は1つも無い状態になる**。いま画面に出ている箱は
//! カードから逆算しているだけで、記録には何も無いためである。放っておくと、版を上げた
//! 利用者の画面から枠が消え、しかも「セッションが終わったら消える枠」に戻るので
//! **原因が版上げにあると気づけない**。だから同じマイグレーションで作り直す（§3）。

use crate::db::projects::LOCAL_AGENT;
use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::TryGetable as _;
use uuid::Uuid;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Projects::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Projects::Id).uuid().not_null().primary_key())
                    .col(ColumnDef::new(Projects::AccountId).uuid().not_null())
                    // **NULL を許さない。** ローカルモードは番兵で表す——NULL にすると
                    // PostgreSQL では NULL 同士が別物と扱われ、下のユニーク索引をすり抜けて
                    // 同じ枠が二重に入る
                    .col(ColumnDef::new(Projects::AgentId).uuid().not_null())
                    .col(ColumnDef::new(Projects::Path).string().not_null())
                    .col(ColumnDef::new(Projects::CreatedAt).big_integer().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_projects_account")
                            .from(Projects::Table, Projects::AccountId)
                            .to(Accounts::Table, Accounts::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    // **`agents` への外部キーは張らない。** 番兵は `agents` に存在しない
                    // 行を指すため。帰属は読むときに `account_id` で絞って守る（§18）
                    .to_owned(),
            )
            .await?;

        // 枠の同一性そのもの（設計§2「PC ＋ パス」）。判定ではなく索引で担保する
        manager
            .create_index(
                Index::create()
                    .name("idx_projects_account_agent_path")
                    .table(Projects::Table)
                    .col(Projects::AccountId)
                    .col(Projects::AgentId)
                    .col(Projects::Path)
                    .unique()
                    .to_owned(),
            )
            .await?;

        backfill(manager).await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Projects::Table).to_owned())
            .await
    }
}

/// 外していないカードから枠を起こす（設計§3）。
///
/// # 採番は Rust 側で行う
///
/// UUID を作る関数の綴りは SQLite と PostgreSQL で揃わない。**読み出しは SQL、
/// 採番と挿入は Rust**にすれば、両方で同じ結果になる（`make test-compose` で通す）。
///
/// # 外したカードからは起こさない
///
/// 外したものが枠として蘇るのは、消した意図に反する。
async fn backfill(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    let db = manager.get_connection();

    let select = Query::select()
        .column(Sessions::AccountId)
        .column(Sessions::AgentId)
        .column(Sessions::Project)
        // 並びが「最初に現れた順」で従来と揃うよう、その組のいちばん古いカードに合わせる
        .expr_as(
            Func::min(Expr::col(Sessions::CreatedAt)),
            Alias::new("created_at"),
        )
        .from(Sessions::Table)
        .and_where(Expr::col(Sessions::Archived).eq(false))
        .add_group_by([
            Expr::col(Sessions::AccountId),
            Expr::col(Sessions::AgentId),
            Expr::col(Sessions::Project),
        ])
        .to_owned();

    let rows = db.query_all(&select).await?;

    for row in rows {
        let account_id = Uuid::try_get(&row, "", "account_id")?;
        // ローカルモードのカードは `agent_id` が NULL。ここで番兵へ読み替える
        let agent_id = Option::<Uuid>::try_get(&row, "", "agent_id")?.unwrap_or(LOCAL_AGENT);
        let path = String::try_get(&row, "", "project")?;
        let created_at = i64::try_get(&row, "", "created_at")?;

        let insert = Query::insert()
            .into_table(Projects::Table)
            .columns([
                Projects::Id,
                Projects::AccountId,
                Projects::AgentId,
                Projects::Path,
                Projects::CreatedAt,
            ])
            .values_panic([
                Uuid::new_v4().into(),
                account_id.into(),
                agent_id.into(),
                path.into(),
                created_at.into(),
            ])
            .to_owned();
        db.execute(&insert).await?;
    }

    Ok(())
}

/// 表と列の名前。**エンティティとは別に書く**（設計§3-2 の流儀）。
#[derive(DeriveIden)]
enum Projects {
    Table,
    Id,
    AccountId,
    AgentId,
    Path,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Accounts {
    Table,
    Id,
}

/// 作り直しで**読むだけ**の表。ここでは一切書き換えない。
#[derive(DeriveIden)]
enum Sessions {
    Table,
    AccountId,
    AgentId,
    Project,
    CreatedAt,
    Archived,
}
