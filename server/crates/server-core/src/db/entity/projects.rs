//! 追加した PJT 枠の記録（イシューグループ_2026_0805_0514 設計§2）。
//!
//! # なぜ表が要るのか
//!
//! これまでプロジェクトは**実体を持っていなかった**。一覧の箱はカードの作業ディレクトリ
//! から逆算して組み立てているだけなので、**カードが0枚の箱は存在できない**。
//! 「セッションを追加するしないに関係なく PJT を追加できる」は、表示の工夫では叶わない。
//!
//! # `agent_id` に NULL を置かない
//!
//! `sessions` のほうは `Option<Uuid>`（ローカルモードは `None`）だが、こちらは
//! **`not null` にして番兵で表す**。枠の同一性は `(account_id, agent_id, path)` の
//! ユニーク索引で担保しており、**PostgreSQL では NULL 同士が互いに別物と扱われる**ので、
//! NULL を許すと同じ枠が二重に入る。読み替えは [`super::super::projects`] の関数1本に閉じる。
//!
//! # 表示のための値を持たない
//!
//! 「セッションが居るか」「何本居るか」はカードから毎回数える。二重に持つと、
//! カードが増減したときに必ずずれる——そしてずれた側は誰にも直せない。

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "projects")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub account_id: Uuid,
    /// どの PC のパスか。**ローカルモードは番兵**（`projects::LOCAL_AGENT`）。
    pub agent_id: Uuid,
    pub path: String,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
