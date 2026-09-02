//! 利用者がセッションへ付けた名前の記録（名前付け設計§4-1）。
//!
//! # なぜ `sessions` の列にしないのか
//!
//! 理由は3つあり、**どれか1つでも成り立てば別表になる**。
//!
//! 1. **名前は CLI セッションに付く。** `sessions` は**カード**の表なので、そこへ置くと
//!    `--resume` で乗り換えたときに前の名前が残る（要件4 が名指しした失敗そのもの）
//! 2. **カードが1枚も無いセッションにも名前が残る必要がある。** 外したカードの行は
//!    残るが、読み込みから除かれる（`Archived.eq(false)` で絞る）ので引く道が無い
//! 3. **`sessions.session_title` と同じ欄に載せると CLI に潰される。** あちらは
//!    パーサが運ぶ `ai-title` で、空でない報告は素通しされる
//!
//! # 主キーが2列なのはなぜか
//!
//! 名前は**アカウントに属する**（要件「誰の名前か」）。`claude_session_id` だけを
//! 主キーにすると、同じセッションを別のアカウントが見たときに名前を共有してしまう。
//!
//! # `sessions` への外部キーを張らない
//!
//! 名前が指すのは**カードではなく CLI セッション**で、`sessions.claude_session_id` は
//! 一意ではない（乗り換えの履歴で複数のカードが同じセッションを指す）。張れる相手が
//! 無いので、帰属は読むときに `account_id` で絞って守る。
//!
//! **カードが1枚も無くなっても名前は残る。** これは漏れではなく要件3 そのものである。

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "session_nicknames")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub account_id: Uuid,
    /// 宛先の CLI セッション（`protocol::ClaudeSessionId`）。
    #[sea_orm(primary_key, auto_increment = false)]
    pub claude_session_id: Uuid,
    /// 利用者が付けた名前。**空文字は入らない**（消すときは行ごと消す）。
    pub nickname: String,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
