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

/// バイト列で返してよいファイルの大きさの上限（`ファイル閲覧で画像とHTMLも表示する` 設計§4）。
///
/// **テキストの [`MAX_FILE_BYTES`] とは別の値にしてある。** 読みたいものの大きさが桁で違う——
/// 手元のスクショの最大は 545 KB で、テキストの上限（256 KiB）では開けない。逆にテキストの
/// 上限を上げると、ロックファイルのような読む意味の無いものまで通ってしまう。
///
/// 線に載るときは base64 で 4/3 に膨らみ、約 10.7 MiB になる。実測で
/// WebSocket の1フレーム（16 MiB）にも Valkey の pub/sub にも収まっている（設計§15）。
pub const MAX_BLOB_BYTES: u64 = 8 * 1024 * 1024;

/// ファイルの見せ方の種別（設計§2）。
///
/// **拡張子だけで決める。中身は推測しない。** 推定を始めると、外したときに嘘を表示する
/// ことになる（文字コードを推定しないと決めてあるのと同じ理由。設計§9）。
///
/// PC 側・サーバ・画面の3者が同じ判断をするので、**表はここに1つだけ置く**。画面側
/// （TypeScript）は写しになるので、両側で同じ振り分けになることをテストで固定する。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    /// 整形して出す
    Markdown,
    /// 隔離した箱で描く
    Html,
    /// **`Image` ではない。** 中に script を書けるので、危なさは HTML と同じ側にある。
    /// script を書ける形式を1つの箱にまとめておけば、隔離の理屈が1本で済む（設計§6-4）
    Svg,
    /// `<img>` で描く
    Image,
    /// 等幅でそのまま出す（表に無いものはすべてここへ落ちる）
    Text,
}

/// 拡張子 → 種別と媒体型の対応（設計§2-1）。
///
/// **媒体型を持たない種別（`markdown` / `text`）は生で返さない**（設計§5-2）。
/// なんでも生で返せる口にすると、`.js` をダッシュボードと同じ出自で読ませる道ができる。
const TABLE: &[(&str, FileKind, Option<&str>)] = &[
    ("md", FileKind::Markdown, None),
    ("markdown", FileKind::Markdown, None),
    ("html", FileKind::Html, Some("text/html; charset=utf-8")),
    ("htm", FileKind::Html, Some("text/html; charset=utf-8")),
    ("svg", FileKind::Svg, Some("image/svg+xml")),
    ("png", FileKind::Image, Some("image/png")),
    ("jpg", FileKind::Image, Some("image/jpeg")),
    ("jpeg", FileKind::Image, Some("image/jpeg")),
    ("gif", FileKind::Image, Some("image/gif")),
    ("webp", FileKind::Image, Some("image/webp")),
];

/// 拡張子を小文字で取り出す。**大文字小文字は区別しない**（設計§2-3）——
/// Windows 側から持ち込まれたファイルで普通に起こる。
fn extension_of(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((head, ext)) if !head.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// このファイルをどう見せるか（設計§2）。表に無いものは [`FileKind::Text`]。
pub fn kind_of(path: &str) -> FileKind {
    let ext = extension_of(path);
    TABLE
        .iter()
        .find(|(known, _, _)| *known == ext)
        .map_or(FileKind::Text, |(_, kind, _)| *kind)
}

/// 生で返すときの `Content-Type`（設計§5-2）。
///
/// **`None` は「生では返さない」**という意味である。呼ぶ側はここで断る。
pub fn media_type_of(path: &str) -> Option<&'static str> {
    let ext = extension_of(path);
    TABLE
        .iter()
        .find(|(known, _, _)| *known == ext)
        .and_then(|(_, _, media)| *media)
}

/// バイト列で返すファイル1つ（設計§3-1）。
///
/// # なぜ [`FileContent`] に欄を足さないのか
///
/// あちらは「**テキストだけ**」を契約にしていて、実装もテストもそれに依存している。
/// 欄を1つ足して両義にすると、「`text` が空なのは中身が空なのか画像なのか」が読めなくなる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileBlob {
    pub path: String,
    /// `image/png` など。**拡張子から決める**（[`media_type_of`]）
    pub media_type: String,
    /// 元のファイルの大きさ
    pub bytes: u64,
    /// 中身。**線に載るときだけ base64 の文字列になる**。
    ///
    /// `Vec<u8>` のまま持つのは、**ローカルモードが直列化そのものを通らない**ためである。
    /// 同じプロセスの中では base64 の代金を1バイトも払わない。素の `Vec<u8>` を JSON へ
    /// 出すと数値の配列になり、1バイトが3〜4文字へ膨らむ。
    #[serde(with = "base64_bytes")]
    pub data: Vec<u8>,
}

/// `Vec<u8>` を base64 の文字列として運ぶ（[`FileBlob::data`]）。
mod base64_bytes {
    use base64::Engine as _;
    use serde::{Deserialize as _, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(serde::de::Error::custom)
    }
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

    /// 種別の表（`ファイル閲覧で画像とHTMLも表示する` 設計§2。テスト計画フェーズ2）。
    mod 種別 {
        use super::*;

        #[test]
        fn 五種が拡張子から引ける() {
            assert_eq!(kind_of("計画.md"), FileKind::Markdown);
            assert_eq!(kind_of("a/b/理解.html"), FileKind::Html);
            assert_eq!(kind_of("図.svg"), FileKind::Svg);
            assert_eq!(kind_of("撮った.png"), FileKind::Image);
            assert_eq!(kind_of("メモ.txt"), FileKind::Text);
        }

        #[test]
        fn 大文字小文字は区別しない() {
            // Windows 側から持ち込まれたファイルで普通に起こる（設計§2-3）
            assert_eq!(kind_of("A.PNG"), FileKind::Image);
            assert_eq!(kind_of("B.Html"), FileKind::Html);
            assert_eq!(media_type_of("A.JPEG"), Some("image/jpeg"));
        }

        #[test]
        fn 表に無い拡張子は素のテキストへ落ちる() {
            // **`image` へ落とさない。** 落とすと、知らない形式を画像として描こうとする
            assert_eq!(kind_of("動く.mp4"), FileKind::Text);
            assert_eq!(kind_of("組み込み.js"), FileKind::Text);
            assert_eq!(kind_of("書類.pdf"), FileKind::Text);
        }

        #[test]
        fn svgは画像ではなく独立した種別になる() {
            // ここが崩れると、script を書ける形式が `<img>` の側へ流れて隔離をすり抜ける
            assert_ne!(kind_of("図.svg"), FileKind::Image);
            assert_eq!(kind_of("図.svg"), FileKind::Svg);
        }

        #[test]
        fn 拡張子を持たない名前はテキスト() {
            assert_eq!(kind_of("README"), FileKind::Text);
            assert_eq!(kind_of("/home/me/.bashrc"), FileKind::Text);
            assert_eq!(kind_of("/home/me/"), FileKind::Text);
        }

        #[test]
        fn 生で返してよいのは表に載る種別だけ() {
            // **`None` は「生では返さない」という意味**（設計§5-2）
            assert_eq!(media_type_of("撮った.png"), Some("image/png"));
            assert_eq!(media_type_of("理解.html"), Some("text/html; charset=utf-8"));
            assert_eq!(media_type_of("図.svg"), Some("image/svg+xml"));
            assert_eq!(media_type_of("動く.gif"), Some("image/gif"));
            assert_eq!(media_type_of("軽い.webp"), Some("image/webp"));
            // 整形して出すものと素のテキストは、生で返す相手ではない
            assert_eq!(media_type_of("計画.md"), None);
            assert_eq!(media_type_of("メモ.txt"), None);
            assert_eq!(media_type_of("組み込み.js"), None);
        }
    }

    /// バイト列の型と上限（設計§3-1・§4。テスト計画フェーズ2）。
    mod バイト列 {
        use super::*;

        fn 見本() -> FileBlob {
            FileBlob {
                path: "/home/me/撮った.png".to_string(),
                media_type: "image/png".to_string(),
                bytes: 3,
                // 0x00 と 0xFF を入れておく。テキストとして運べない値であることが、
                // 「base64 で包む必要がある」の実体そのもの
                data: vec![0x00, 0x7f, 0xff],
            }
        }

        #[test]
        fn 画像の上限は八メビバイトのまま() {
            // **数を字で書く。** 定数から期待値を組み立てると、壊し方を当てたときに
            // テストも一緒に動いて通ってしまう
            assert_eq!(MAX_BLOB_BYTES, 8_388_608);
            // テキストの上限とは別の値であること（設計§4-1）
            assert_ne!(MAX_BLOB_BYTES, MAX_FILE_BYTES);
        }

        #[test]
        fn 中身はbase64の文字列として運ばれる() {
            // **綴りを1つ字で固定する。** 数値の配列（`[0,127,255]`）になっていたら、
            // 1バイトが3〜4文字へ膨らんでいる
            let json = serde_json::to_string(&見本()).unwrap();
            assert!(
                json.contains(r#""data":"AH//""#),
                "base64 の文字列で運ばれること: {json}"
            );
            assert!(
                !json.contains("[0,"),
                "数値の配列になっていないこと: {json}"
            );
        }

        #[test]
        fn 往復して同じものに戻る() {
            let blob = 見本();
            let json = serde_json::to_string(&blob).unwrap();
            let back: FileBlob = serde_json::from_str(&json).unwrap();
            assert_eq!(back, blob);
        }

        #[test]
        fn 読めないbase64は断る() {
            // 黙って空のバイト列にすると、壊れた画像を「中身が空の画像」として描く
            let json = r#"{"path":"a","media_type":"image/png","bytes":1,"data":"これは違う"}"#;
            assert!(serde_json::from_str::<FileBlob>(json).is_err());
        }
    }
}
