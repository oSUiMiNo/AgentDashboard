//! 人が自分のために書き残すメモ（メモ設計§3）。
//!
//! # エージェントへの指示とは別物
//!
//! 画面の見た目はチャットに似ているが、**ここへ書いたものは claude へ渡らない**。
//! 指示は `ClientMessage::Input` で PTY へ流れ、メモはこの表に積まれるだけである。
//! 要件が「エージェントにメモを読ませること」を**やらないこと**に挙げている。
//!
//! # 宛先を2列で持ち、1列へ詰めない
//!
//! `target_kind` が `"global"` ならアカウントに1つのメモ、`"session"` なら
//! `target_session_id` が指す CLI セッションのメモ。**`"session:<uuid>"` のような
//! 合成文字列にしない**——索引が前方一致でしか効かなくなり、宛先で絞る問い合わせが
//! 表の全走査になる。`notices` が `source` と `kind` を分けているのと同じ理由。
//!
//! # 宛先はカードのIDではなく CLI のセッションID
//!
//! **乗り換えたらメモは付いてきてはいけない。** 中身は「その会話でやっていること」に
//! 属するので、カードへ紐づけると別のセッションに前のメモが残る。名前を付ける機能
//! （同じグループ・クローズ済み）が同じ判断をしており、`AnnotationTarget` はそのために
//! `protocol` へ用意されている。
//!
//! # チェックを真偽値で持たない
//!
//! `checked_at` が空ならチェックなし。**入っていれば上段へ移り、その中の並びを決める**
//! （要件6 が「チェックを入れた**時刻**の順」を求めている）。真偽値では並べられない。
//! `notices.read_at`（空なら未読）と同じ形に揃えてある。
//!
//! # `sessions` へ外部キーを張らない
//!
//! `sessions.claude_session_id` は**一意ではない**。乗り換えの履歴で複数のカードが
//! 同じ CLI セッションを指しうるので、参照先が1行に定まらない。`session_nicknames` が
//! 同じ理由で張っていない。
//!
//! **結果として、カードを消してもメモは残る。これは意図である**——要件の目的1が
//! 「復旧するとき、どのカードが何のやつか分からない」で、要件15が「終了したカード・
//! 抜け殻のカードでこそ読みたい」と書いている。**カードが消えたあとに読み返したい**の
//! だから、カードと運命を共にさせると要件が成立しない。孤児にはならず、同じセッションを
//! 起こし直せば戻る。消えるのは `accounts` が消えたときだけ（Cascade）。

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "memos")]
pub struct Model {
    /// **1つの宛先に複数行が積まれる**ので、複合キーにしない。
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    /// 誰のメモか。**絞り込みの鍵**。
    pub account_id: Uuid,
    /// `"global"` か `"session"`。**閉じた列挙にしない**——`notices.source` と同じ流儀。
    pub target_kind: String,
    /// `target_kind = "session"` のときだけ入る CLI のセッションID。
    pub target_session_id: Option<Uuid>,
    /// ブロックエディタの構造を丸ごと。**列に分解しない**（入れ子を持つため）。
    pub body: Json,
    /// メモの時刻。**内容が変わったときだけ更新する**（要件4）。並びを決める。
    pub noted_at: i64,
    /// **空ならチェックなし。** 入っていれば上段へ行き、その中の並びを決める。
    pub checked_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
