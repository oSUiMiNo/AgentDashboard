//! 追加した PJT 枠の読み書き（イシューグループ_2026_0805_0514 設計§2）。
//!
//! # 番兵はここにしか無い
//!
//! ローカルモードには PC という単位が無い。それを表す nil UUID の綴りは
//! **このファイルの [`LOCAL_AGENT`] 1つだけ**にする。他所で `Uuid::nil()` と書くと、
//! 意味の違う nil（[`super::SERVER_SCOPE_ID`] など）と見分けが付かなくなり、
//! 片方だけ直したときに黙って壊れる。
//!
//! `hosts::LOCAL_HOST`（`"local"`）とも**別物**である。あちらは画面と REST の綴りで、
//! こちらは DB の値。同じ「ローカル」でも、変えたときに影響する範囲が違う。
//!
//! # 読み替えは1本に閉じる
//!
//! `sessions.agent_id` は `Option<Uuid>` のままにしてある（既に配ったスキーマを
//! 変える理由が無い）。したがって「`None` ⇄ 番兵」の読み替えが要るが、これを各所で
//! 書くと必ずどこかで忘れる。[`to_column`] と [`from_column`] だけを使うこと。

use super::entity::projects;
use protocol::AgentId;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder,
};
use uuid::Uuid;

/// 「PC という単位が無い」を表す番兵（設計§2）。
///
/// **主キー相当の列に NULL を置けない**ため。ユニーク索引へ逃がしても、PostgreSQL では
/// NULL 同士が互いに別物と扱われ、同じ枠が二重に入る（PJTガイドライン「DB を相手に
/// するとき」で実際に踏んでいる）。
pub const LOCAL_AGENT: Uuid = Uuid::nil();

/// 宛先を列の値へ。`None`（ローカル）は番兵になる。
pub fn to_column(agent: Option<AgentId>) -> Uuid {
    agent.map(|id| id.0).unwrap_or(LOCAL_AGENT)
}

/// 列の値を宛先へ。番兵は `None` に戻る。
pub fn from_column(value: Uuid) -> Option<AgentId> {
    if value == LOCAL_AGENT {
        None
    } else {
        Some(AgentId(value))
    }
}

/// そのアカウントの枠を、**利用者が並べた順**に並べて返す。
///
/// 並びの正は `position`（並べ替え設計§2-3）。以前は `created_at` で固定していたが、
/// **利用者が自分で並べ替えられるようになった**ので、時刻はもう順序を決めない。
/// `created_at` は値としては守り続ける（起こし直しで動かさない）。
///
/// **セッションが居るかどうかで2群に分けることは、もうしない。** 群分けは画面の
/// 仕事だったが、利用者の並びと正面から衝突する（起動しただけで枠が飛ぶ）ので
/// 外した。ここは順序だけを保証する。
pub async fn list(
    db: &DatabaseConnection,
    account_id: Uuid,
) -> Result<Vec<projects::Model>, DbErr> {
    projects::Entity::find()
        .filter(projects::Column::AccountId.eq(account_id))
        .order_by_asc(projects::Column::Position)
        // 同着は `id` で崩す。崩さないと SQLite と PostgreSQL で並びが変わりうる
        .order_by_asc(projects::Column::Id)
        .all(db)
        .await
}

/// 1つ引く。**必ずアカウントで絞る**（設計§18）。
///
/// 他人の枠は「無い」と同じ扱いになる——絞りをここに入れておけば、呼び出し側が
/// 帰属の確認を書き忘れても他人のものは出てこない。
pub async fn get(
    db: &DatabaseConnection,
    account_id: Uuid,
    id: Uuid,
) -> Result<Option<projects::Model>, DbErr> {
    projects::Entity::find_by_id(id)
        .filter(projects::Column::AccountId.eq(account_id))
        .one(db)
        .await
}

/// 枠を足す。**同じ（アカウント・PC・パス）が既にあれば、その行をそのまま返す。**
///
/// 二重に押したときに増えないことを、判定ではなくユニーク索引で担保している。
/// 先に引いてから入れる形にしているのは、**既にある行の `id` を返す**必要があるため
/// （画面はその `id` で消しにくる）。競合で入れ損ねた場合も、もう一度引いて既存を返す。
pub async fn add(
    db: &DatabaseConnection,
    account_id: Uuid,
    agent: Option<AgentId>,
    path: &str,
    now: i64,
) -> Result<projects::Model, DbErr> {
    let agent_column = to_column(agent);

    if let Some(found) = find_same(db, account_id, agent_column, path).await? {
        return Ok(found);
    }

    let row = projects::ActiveModel {
        id: Set(Uuid::new_v4()),
        account_id: Set(account_id),
        agent_id: Set(agent_column),
        path: Set(path.to_string()),
        created_at: Set(now),
        position: Set(next_position(db, account_id).await?),
    };
    projects::Entity::insert(row)
        .on_conflict_do_nothing()
        .exec(db)
        .await?;

    // `on_conflict_do_nothing` は「入らなかった」ことを成功として返すので、
    // 入れた行そのものは取り直す。競合していた場合はここで相手の行が取れる
    find_same(db, account_id, agent_column, path)
        .await?
        .ok_or_else(|| DbErr::Custom("枠を足したのに読み戻せません".to_string()))
}

/// そのアカウントの枠に振る、次の並び順（並べ替え設計§2-4）。**末尾へ足す。**
///
/// 末尾にする理由は2つある。1つは「増えたものが目の前に割り込まない」こと。もう1つは
/// **既存の E2E の土台がこれに乗っている**ことで、`web/e2e/helpers.ts` の `spawnSession` は
/// 「起こす前の枚数を数え、`nth(その数)` で新しいカードを掴む」作りになっている。
/// ここを変えると、並べ替えと関係のない spec まで一斉に落ちる。
///
/// 枠が1つも無ければ 0。**空きがあっても詰め直さない**——並べ替えの口
/// （`PUT /api/projects/order`）が丸ごと受け取って 0 から振り直すので、
/// 穴はそこで消える。
async fn next_position(db: &DatabaseConnection, account_id: Uuid) -> Result<i32, DbErr> {
    let last = projects::Entity::find()
        .filter(projects::Column::AccountId.eq(account_id))
        .order_by_desc(projects::Column::Position)
        .one(db)
        .await?;
    Ok(last.map_or(0, |row| row.position.saturating_add(1)))
}

/// 枠を消す。消えたら `true`、もともと無い（または他人のもの）なら `false`。
pub async fn remove(db: &DatabaseConnection, account_id: Uuid, id: Uuid) -> Result<bool, DbErr> {
    let outcome = projects::Entity::delete_many()
        .filter(projects::Column::Id.eq(id))
        .filter(projects::Column::AccountId.eq(account_id))
        .exec(db)
        .await?;
    Ok(outcome.rows_affected > 0)
}

async fn find_same(
    db: &DatabaseConnection,
    account_id: Uuid,
    agent_column: Uuid,
    path: &str,
) -> Result<Option<projects::Model>, DbErr> {
    projects::Entity::find()
        .filter(projects::Column::AccountId.eq(account_id))
        .filter(projects::Column::AgentId.eq(agent_column))
        .filter(projects::Column::Path.eq(path))
        .one(db)
        .await
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 宛先と番兵は往復する() {
        // 読み替えを1本に閉じている以上、ここが唯一の検査点になる
        assert_eq!(to_column(None), LOCAL_AGENT);
        assert_eq!(from_column(LOCAL_AGENT), None);

        let agent = AgentId(Uuid::new_v4());
        assert_eq!(to_column(Some(agent)), agent.0);
        assert_eq!(from_column(agent.0), Some(agent));
    }

    #[test]
    fn 番兵は実在の宛先とぶつからない() {
        // v4 は nil を作らないので、番兵が本物の PC と衝突することはない。
        // ここが破れると「ローカルの枠」と「ある PC の枠」が同じ行になる
        assert_eq!(LOCAL_AGENT, Uuid::nil());
        for _ in 0..64 {
            assert_ne!(Uuid::new_v4(), LOCAL_AGENT);
        }
    }
}
