//! 枠とカードに並び順（`position`）の列を足す（並べ替え設計§2-1・§2-2）。
//!
//! # なぜ列が要るのか
//!
//! これまで並びは `created_at` から導いていた。**導いている限り、利用者は並べ替えられない**——
//! 掴んで動かした結果を書き戻す先が無いためである。並びを「記録」として持つことで、
//! ホームと PJT 専用画面の**両方が同じ1本を見る**形になる（設計§2）。
//!
//! # 入れた瞬間に並びが変わってはいけない
//!
//! 利用者は「いま見えている順」を出発点にして並べ替える。入れ替えた途端に順が変わると、
//! **何が起きたのか分からなくなる**。そこで既存の行には**いまの見え方をそのまま焼き付ける**
//! （下の [`backfill`]）。**気づかれないことが、この migration が正しく入った証拠である。**
//!
//! # 採番は Rust 側で行う
//!
//! `m20260805_000003_projects.rs` と同じ流儀。**読み出しは SQL、採番と書き込みは Rust。**
//! 窓関数（`ROW_NUMBER()`）の綴りと既定の照合順序は SQLite と PostgreSQL で揃わないので、
//! そこを SQL に書かない（`make test-compose` で両方に流す）。
//!
//! # `archived` のカードにも振る
//!
//! 振らないと既定値の 0 が重なり、**外したカードを起こし直したときに並びが崩れる**。
//! 順序は生きているカードの続きから、同じ規則で振る。

use crate::db::projects::LOCAL_AGENT;
use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, TryGetable as _};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 既定の 0 は「まだ振っていない」ではなく**先頭**を意味する。既存の行はこのあと
        // backfill で必ず上書きされ、新しく作られる行は `position = 最大値 + 1` を明示して
        // 入る（設計§2-4）ので、0 のまま残るのは「枠の中で最初の1枚」だけになる。
        //
        // **2つの表を1本で触るので、片方だけ先に戻されることがある。** `projects` は
        // 作り直しの対象で（`m20260805_000003_projects.rs` が表ごと起こし直す）、
        // そのときこの1本も適用済みの記録から外れて効き直す——が、`sessions` の列は
        // 残ったままである。**在るものを足そうとすると落ちる**ので、1つずつ見て飛ばす
        if !manager.has_column("projects", "position").await? {
            manager
                .alter_table(
                    Table::alter()
                        .table(Projects::Table)
                        .add_column(
                            ColumnDef::new(Projects::Position)
                                .integer()
                                .not_null()
                                .default(0),
                        )
                        .to_owned(),
                )
                .await?;
        }
        if !manager.has_column("sessions", "position").await? {
            manager
                .alter_table(
                    Table::alter()
                        .table(Sessions::Table)
                        .add_column(
                            ColumnDef::new(Sessions::Position)
                                .integer()
                                .not_null()
                                .default(0),
                        )
                        .to_owned(),
                )
                .await?;
        }
        backfill(manager).await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Projects::Table)
                    .drop_column(Projects::Position)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Sessions::Table)
                    .drop_column(Sessions::Position)
                    .to_owned(),
            )
            .await
    }
}

/// いまの見え方を、そのまま `position` へ焼き付ける（設計§2-2）。
///
/// ```text
/// アカウントごとに：
///   枠：  ① 非 archived のカードを1枚以上持つ枠 を created_at 昇順
///         ② 1枚も持たない枠                     を created_at 昇順
///         ①→② の順に 0,1,2,… を振る          ← 群分けをそのまま写したもの
///   カード：枠ごとに、非 archived を created_at 昇順で 0,1,2,…、続けて archived
/// ```
///
/// **①→② の2群は、この migration の中にしか残らない。** ブラウザ側の群分け
/// （`stores/sessions.ts` の `rebuildGroups`）はこの工事で外すので、**群分けが最後に
/// 効くのがここ**である。以後は利用者が並べた順がそのまま正になる。
async fn backfill(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    let db = manager.get_connection();

    // ---- カード：枠ごとに 0 から振る --------------------------------------
    // **生きているカードを先に、外したカードを後に**。2回に分けて読むのは、`archived` の
    // 値を Rust 側へ取り出さずに済ませるため（真偽値の入り方が SQLite と PostgreSQL で
    // 揃わない。SQL の `eq(false)` なら両方で同じに効く）
    let mut next: HashMap<(Uuid, Uuid, String), i32> = HashMap::new();
    // 非 archived のカードを持つ枠。枠の採番でそのまま①群になる
    let mut busy_frames: HashSet<(Uuid, Uuid, String)> = HashSet::new();

    for archived in [false, true] {
        let select = Query::select()
            .column(Sessions::CardId)
            .column(Sessions::AccountId)
            .column(Sessions::AgentId)
            .column(Sessions::Project)
            .from(Sessions::Table)
            .and_where(Expr::col(Sessions::Archived).eq(archived))
            // 同着は card_id で崩す。崩さないと SQLite と PostgreSQL で順が変わりうる
            .order_by(Sessions::CreatedAt, Order::Asc)
            .order_by(Sessions::CardId, Order::Asc)
            .to_owned();

        for row in db.query_all(&select).await? {
            let card_id = Uuid::try_get(&row, "", "card_id")?;
            let account_id = Uuid::try_get(&row, "", "account_id")?;
            // ローカルモードのカードは `agent_id` が NULL。枠と突き合わせるため番兵へ読み替える
            let agent_id = Option::<Uuid>::try_get(&row, "", "agent_id")?.unwrap_or(LOCAL_AGENT);
            let path = String::try_get(&row, "", "project")?;

            let frame = (account_id, agent_id, path);
            if !archived {
                busy_frames.insert(frame.clone());
            }
            let slot = next.entry(frame).or_insert(0);
            let position = *slot;
            *slot += 1;

            let update = Query::update()
                .table(Sessions::Table)
                .value(Sessions::Position, position)
                .and_where(Expr::col(Sessions::CardId).eq(card_id))
                .to_owned();
            db.execute(&update).await?;
        }
    }

    // ---- 枠：アカウントごとに ①→② の順で 0 から振る ----------------------
    let select = Query::select()
        .column(Projects::Id)
        .column(Projects::AccountId)
        .column(Projects::AgentId)
        .column(Projects::Path)
        .from(Projects::Table)
        .order_by(Projects::CreatedAt, Order::Asc)
        .order_by(Projects::Id, Order::Asc)
        .to_owned();

    // 読んだ順（created_at 昇順）を保ったまま、アカウントごとに2つの籠へ分ける
    let mut busy: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    let mut idle: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for row in db.query_all(&select).await? {
        let id = Uuid::try_get(&row, "", "id")?;
        let account_id = Uuid::try_get(&row, "", "account_id")?;
        let agent_id = Uuid::try_get(&row, "", "agent_id")?;
        let path = String::try_get(&row, "", "path")?;

        let basket = if busy_frames.contains(&(account_id, agent_id, path)) {
            &mut busy
        } else {
            &mut idle
        };
        basket.entry(account_id).or_default().push(id);
    }

    for (account_id, ids) in &busy {
        assign(db, ids, 0).await?;
        // 同じアカウントの②群は、①群の続きから振る
        let start: i32 = ids.len().try_into().unwrap_or(i32::MAX);
        if let Some(rest) = idle.get(account_id) {
            assign(db, rest, start).await?;
        }
    }
    // ①群が1つも無いアカウント（カードを持つ枠が無い）は上の輪を通らない
    for (account_id, ids) in &idle {
        if !busy.contains_key(account_id) {
            assign(db, ids, 0).await?;
        }
    }

    Ok(())
}

/// 枠の並び順を、渡された順に `start` から振る。
async fn assign<C: ConnectionTrait>(db: &C, ids: &[Uuid], start: i32) -> Result<(), DbErr> {
    for (offset, id) in ids.iter().enumerate() {
        let step: i32 = offset.try_into().unwrap_or(i32::MAX);
        let position = start.saturating_add(step);
        let update = Query::update()
            .table(Projects::Table)
            .value(Projects::Position, position)
            .and_where(Expr::col(Projects::Id).eq(*id))
            .to_owned();
        db.execute(&update).await?;
    }
    Ok(())
}

/// 表と列の名前。**エンティティとは別に書く**（設計§3-2 の流儀）。
///
/// 当時の形をここで凍らせるためで、エンティティを後から直してもこのファイルは動かない。
#[derive(DeriveIden)]
enum Projects {
    Table,
    Id,
    AccountId,
    AgentId,
    Path,
    CreatedAt,
    Position,
}

#[derive(DeriveIden)]
enum Sessions {
    Table,
    CardId,
    AccountId,
    AgentId,
    Project,
    CreatedAt,
    Archived,
    Position,
}
