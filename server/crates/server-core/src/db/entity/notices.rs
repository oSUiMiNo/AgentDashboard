//! アプリ全体の知らせ（トーストとベル設計§4-1）。
//!
//! # カード単位の断りとは別物
//!
//! `web/src/stores/sessions.ts` の断り（`Notice`）は**カード1枚に効く**もので、
//! メモリだけに積み、リロードで消える。こちらは**アプリ全体に効く**もので、記録に
//! 残して**端末をまたぐ**。名前は似ているが、寿命も宛先も違う。
//!
//! 統合しないのは、あちらの設計（`細かい修正_2026-0903` §7-5）が「当面は別々」と
//! 決めているため。将来1つにするなら、**「宛先」と「本体」が分かれている**この形が要る。
//!
//! # `source` と `kind` を2列に分ける
//!
//! `source` が `"error"` なら `kind` は `ErrorKind`（11種）、`"selfheal"` なら
//! 自己修復の段階（10種）。**値域が別物**なので、1列へ詰めると
//! `"selfheal_repairing"` のような合成文字列を毎回組み立てて分解することになる。
//!
//! # 既読を真偽値で持たない
//!
//! `read_at` が空なら未読。`pairing_tokens.revoked_at`（空なら有効）と同じ形に
//! 揃えてある。**いつ読んだか**が後から要ることはあるが、真偽値からは復元できない。
//!
//! # `card_id` に外部キーを張らない
//!
//! 知らせはカードの生死と関わりなく残ってよい。いまは常に `None` で、**将来カードを
//! 名指しする知らせを足すときの受け皿**である。

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "notices")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    /// 誰の知らせか。**絞り込みの鍵**（設計§4-2）。
    pub account_id: Uuid,
    /// 名指し先。**いまは常に `None`**。
    pub card_id: Option<Uuid>,
    /// `"error"` か `"selfheal"`。**閉じた列挙にしない**——今後増える。
    pub source: String,
    /// `source` に応じた種別（`ErrorKind` か自己修復の段階）の snake_case。
    pub kind: String,
    /// 画面へそのまま出す1行。**書き込む時点で日本語を確定させる**（設計§7-1）。
    pub message: String,
    pub created_at: i64,
    /// **空なら未読。** 既読にするとは、ここへ時刻を立てること。
    pub read_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
