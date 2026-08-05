//! 利用者の PC のフォルダとファイルを運ぶ型（イシューグループ_2026_0805_0514 設計§8・§9）。
//!
//! # なぜ `a2s` の中に置かないのか
//!
//! ここの型は**2つの線を流れる**。セッションホスト → サーバは A2S（[`crate::a2s`]）だが、
//! サーバ → ブラウザは REST の応答になる（設計§10）。片方の線のモジュールへ置くと、
//! もう片方が「相手の線の型」を名指しすることになり、どちらが持ち主なのか読めなくなる。
//!
//! # 上限は型と同じ場所に置く
//!
//! 守るのはセッションホストだが、**断り文を出すのはサーバとブラウザ**なので、値の綴りが
//! 3箇所に散りやすい。ここに1つだけ置いて全員が引く（設計§23-2 で実測して決めた値）。

use serde::{Deserialize, Serialize};

/// 1つのフォルダから返す件数の上限（設計§23-2）。
///
/// 実測では1件あたり60バイト前後で、1000件でも 61 KB に収まる。
pub const MAX_ENTRIES: usize = 1_000;

/// 1つのフォルダから返す大きさの上限（設計§23-2）。
///
/// **件数と重ねて掛ける。** 名前は1件255バイトまで在りうるので、件数だけでは縛れない。
pub const MAX_LISTING_BYTES: usize = 512 * 1024;

/// 中身を返してよいファイルの大きさの上限（設計§23-2）。
///
/// 読みたいもの（この PJT でいちばん大きい文書が 110 KB）は通り、読む意味の無いもの
/// （ロックファイル 343 KB）は断られる線。
pub const MAX_FILE_BYTES: u64 = 256 * 1024;

/// フォルダ1つの中身（設計§8）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirListing {
    /// 読んだフォルダの絶対パス。**問いに使ったパスではなく、読めた側**を入れる
    pub path: String,
    pub entries: Vec<DirEntry>,
    /// 上限で打ち切ったか。**隠さない**（設計§8）。
    ///
    /// 黙って切ると「あるはずのフォルダが無い」という、原因まで辿れない形になる。
    pub truncated: bool,
}

/// フォルダの中の1件。
///
/// **ディレクトリとファイルの両方を返す**（設計§8）。口を2本に割ると、並び・上限・
/// リンクの決まりが2箇所へ散る。見せる側で絞る。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub kind: EntryKind,
    /// そのディレクトリが `.git` を持っているか。**[`EntryKind::Dir`] のときだけ意味を持つ。**
    ///
    /// 深い階層を掘るときに「どれが目的地なのか」を1階層ぶん先に教えるための印で、
    /// スマホでは1タップの重みが大きい（設計§8）。
    pub is_project: bool,
}

/// 中身の種別。
///
/// **リンクは辿らない**（設計§8）。追いかけると輪を作られたときに止まらなくなるので、
/// 在ることだけを示して、その場では開かない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Dir,
    File,
    Symlink,
}

/// ファイル1つの中身（設計§9）。
///
/// **テキストだけ。** バイナリと判断したものはここへ入れず、断る側（`HostFailure`）へ回す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    pub text: String,
    /// 上限の**内側で**行数などの都合により切ったか。
    ///
    /// [`MAX_FILE_BYTES`] を超えた場合はここを使わず、断る（設計§9）。切れていることが
    /// 伝わらない形（先頭だけ返して黙る）を避けるため、意味を混ぜない。
    pub truncated: bool,
    /// 元のファイルの大きさ。断るときにも添えるので、返せた場合も入れておく
    pub bytes: u64,
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 種別はスネークケースで表される() {
        // ブラウザ側（TypeScript）が同じ綴りで読む。線の上の形をここで固定する
        assert_eq!(serde_json::to_string(&EntryKind::Dir).unwrap(), r#""dir""#);
        assert_eq!(
            serde_json::to_string(&EntryKind::File).unwrap(),
            r#""file""#
        );
        assert_eq!(
            serde_json::to_string(&EntryKind::Symlink).unwrap(),
            r#""symlink""#
        );
    }

    #[test]
    fn 上限は実測で決めた値のまま() {
        // 設計§23-2 と食い違ったら、どちらかが嘘になっている
        assert_eq!(MAX_ENTRIES, 1_000);
        assert_eq!(MAX_LISTING_BYTES, 524_288);
        assert_eq!(MAX_FILE_BYTES, 262_144);
    }
}
