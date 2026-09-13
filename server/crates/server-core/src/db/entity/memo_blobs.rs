//! 全体メモの画像（メモ設計§10-1 の【決着】）。
//!
//! # セッションメモの画像はここに来ない
//!
//! **帰属が違うので保管も違う。** セッションメモの画像は**その PC の作業に属する**
//! ので、既存の添付（`<state_dir>/attachments/<カードID>/`）へ相乗りしたままである。
//! 全体メモは**アカウントに属する**ので、本文と同じ記録へ置く——**本文だけサーバに
//! 在って画像が PC に在ると、別の端末から開いたときに画像だけ欠ける**（要件10）。
//!
//! **要件9（同じ部品・同じ口）は保たれている。** 割れるのは保管先だけで、口は宛先を
//! 引数で受ける形のままである。
//!
//! # 中身を列で持つ
//!
//! **サーバにはファイルの置き場が無い**（`ServerConfig` は `database_url` と
//! `valkey_url` しか持たない）ので、どの構成でも在る durable な置き場は記録だけ。
//!
//! # `bytes` を別の列に持つ理由
//!
//! **掃除が合計を出すたびに中身を読まないため。** `data` の長さで数えると、
//! 1 GiB を数えるのに 1 GiB 運ぶことになる。
//!
//! # メモの本文へ外部キーを張らない
//!
//! **貼っている途中の画像は、どのメモにも属していない。** 確定するまで本文は記録へ
//! 入らないので、張ると「置いたが確定しなかった画像」が置けなくなる。**宙に浮いた
//! ぶんは掃除が期限で回収する**——`memos` が `sessions` へ張っていないのと同じ形で、
//! 孤児を許して掃除で始末する。

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "memo_blobs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    /// 誰の画像か。**絞り込みの鍵**であり、掃除の単位でもある。
    pub account_id: Uuid,
    /// 媒体型。**中身から推測しない**（既存の添付と同じ作法）。
    pub media_type: String,
    /// 画像そのもの。SQLite は BLOB、PostgreSQL は BYTEA。
    pub data: Vec<u8>,
    /// 大きさ。**掃除が中身を読まずに合計を出すために持つ。**
    pub bytes: i64,
    /// 置いた時刻。**古い順に消す**（要件10）ので並びを決める。
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
