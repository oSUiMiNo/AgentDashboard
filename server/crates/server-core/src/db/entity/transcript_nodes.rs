//! 構造化履歴のノード（セルフホスト化設計§3-2）。
//!
//! # `payload` を列に分解しない
//!
//! `Node` は寛容パース（初期実装§3）の成果物で、**知らない構造は `Node::Unknown` として
//! そのまま残る**。列へ分解すると未知ノードの置き場が無くなり、「JSONL の書式が変わっても
//! パーサだけ直せば済む」という自己修復の前提を DB スキーマが壊す。
//!
//! # `seq` は挿入時に採番する
//!
//! ページング（`?before=&limit=`）の並びを安定させるための単調列。**主キーが複合なので
//! DB の自動採番は使えない**（SQLite の自動採番は単一の INTEGER 主キーに限られる）ので、
//! カードごとの最大値の続きを書き込み側で振る。
//!
//! **同じノードを入れ直しても `seq` は書き換えない。** ツールコールは結果が届いた時点で
//! 同じIDで送り直されるので、そのたびに採番し直すと**並びが動いて画面が飛ぶ**。

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "transcript_nodes")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub card_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub node_id: String,
    pub parent: Option<String>,
    pub ts: i64,
    pub branch: i32,
    pub seq: i64,
    /// `TreeNode` の `node` 部を丸ごと JSON にしたもの。
    pub payload: Json,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
