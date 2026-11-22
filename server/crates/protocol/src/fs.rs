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

/// 全文を1通で返す線（`ファイル閲覧の上限を設定から変え、大きいものは流し読みする` 設計§2-1）。
///
/// **いまは読める上限ではない。** これを超えて設定の上限以下なら、先頭の窓
/// （[`WINDOW_BYTES`]）だけを返して `truncated: true` にし、続きは窓読み（[`FileChunk`]）で
/// 取る。読める上限は設定の値で、PC 自身の天井は [`FILE_VIEW_LIMIT_MAX`] である。
///
/// 値の由来は、かつての「中身を返してよいファイルの大きさの上限」（設計§23-2。
/// `表示できるテキストの上限を3MBへ上げる` で 256 KiB から引き上げた）。下の実測は、
/// 3 MiB までなら全文を1通で返しても動くことの根拠としていまも正しい。
///
/// # なぜ上げたのか
///
/// 元の 256 KiB は「読みたいものは通り、読む意味の無いものは断る」線として実測で決めた。
/// **その実測の前提が、書き足していくうちに崩れた。**
///
/// | 実物 | 元（256 KiB）で | いま |
/// |---|---|---|
/// | `.claude/docs/guideline.md` 204 KiB | 通る（**残り 50 KiB**） | 通る |
/// | 理解doc の HTML 1.9 MiB | **断る** | 通る |
/// | `web/package-lock.json` 335 KiB | 断る | **通る**（引き換えに失ったもの） |
///
/// 決め手は `guideline.md` である。**上限の8割まで来ていて、なお増える置き場所**なので、
/// 据え置くと**いちばん読みたい文書がある日から開けなくなる**。
///
/// 引き換えに、ロックファイルのような読む意味の無いものも通るようになった。**それでよい**
/// ——間違って開いて失うのは一度の待ち時間だけだが、開けないほうは回復手段が無い。
///
/// # HTML と SVG もここを通る
///
/// [`MAX_BLOB_BYTES`] を通るのは**画像だけ**である（`server-core` の生の口を見よ）。
/// 一括で読む線を超えた HTML／SVG は、サーバが窓を繰り返し読んで流す
/// （`server_core::file_view::PREVIEW_MAX_BYTES` まで）。
pub const WHOLE_TEXT_BYTES: u64 = 3 * 1024 * 1024;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

/// 窓の大きさ。最初の窓と、続きを頼むときの既定の長さ（設計§2-1。エージェントの仮置き）。
///
/// 生テキストの描画は 3 MiB でも 36ms（`FileView.tsx` の実測の表）なので、画面が4枚持っても
/// 1 MiB で軽い。1回の往復で数千行が来るので、スクロールのたびに待たせない。16 MiB の
/// 壁（`session-host-core/src/link.rs` のコメント）の 1/64 に収まる。
pub const WINDOW_BYTES: u64 = 256 * 1024;

/// 1回の窓読みで読める最大（設計§2-1）。頼まれた長さはここで切り詰める——ブラウザの言い値を
/// そのまま使わない。
pub const RANGE_MAX_BYTES: u64 = MIB;

/// 設定の上限の選択肢（設計§1・§2-1）。要件の16個の並びそのまま。
///
/// 2進で数え、表示は Windows と同じ「MB」「GB」にする（方針§8。エージェントの仮置き）。
/// この PJT の画面は既に「2進の値を MB／GB と表示する」作法で揃っている（`web/src/lib/format.ts`）。
pub const FILE_VIEW_LIMIT_CHOICES: [u64; 16] = [
    MIB,
    3 * MIB,
    5 * MIB,
    10 * MIB,
    15 * MIB,
    20 * MIB,
    30 * MIB,
    50 * MIB,
    100 * MIB,
    300 * MIB,
    500 * MIB,
    GIB,
    3 * GIB,
    5 * GIB,
    10 * GIB,
    20 * GIB,
];

/// PC 自身の天井（設計§2-1・§3-1）。渡された上限がこれを超えても、ここで断る——壊れた
/// サーバや CLI の手打ちで天井を越えさせない。選択肢の最後と同じ値。
pub const FILE_VIEW_LIMIT_MAX: u64 = 20 * GIB;

const _: () = assert!(FILE_VIEW_LIMIT_CHOICES[15] == FILE_VIEW_LIMIT_MAX);

/// 大きさを人の読める形にする（設計§2-2）。`web/src/lib/format.ts` の `formatBytes` の写し。
///
/// 1024 ごとに繰り上げ、`B/KB/MB/GB/TB`、MB 以上で 100 未満なら小数1桁。**両側に同じ見本の
/// 表を置いて固定する**（TS 側の表はフェーズ6で置く）。
///
/// 丸めは「半分は上へ」を明示で書く。JS の `toFixed` は同点で大きい方を選ぶが、Rust の
/// `format!("{:.1}")` は同点を偶数へ寄せるので、そのまま書くと 2560 バイトで TS は "3 KB"、
/// Rust は "2 KB" と割れる。
pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes == 0 {
        return "0 B".to_string();
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit >= 2 && value < 100.0 {
        format!("{:.1} {}", (value * 10.0).round() / 10.0, UNITS[unit])
    } else {
        format!("{} {}", value.round() as u64, UNITS[unit])
    }
}

/// 選択肢の名前（"1 MB"・"20 GB"。整数）を作る（設計§2-2）。名前は Rust 側で1つだけ作り、
/// 画面は設定の口で受け取る。MiB・GiB の倍数でなければ [`human_bytes`] に任せる。
pub fn limit_label(bytes: u64) -> String {
    if bytes != 0 && bytes % GIB == 0 {
        format!("{} GB", bytes / GIB)
    } else if bytes != 0 && bytes % MIB == 0 {
        format!("{} MB", bytes / MIB)
    } else {
        human_bytes(bytes)
    }
}

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
    /// 一括で読む線（[`WHOLE_TEXT_BYTES`]）を超え、設定の上限以下のときに true
    /// （`ファイル閲覧の上限を設定から変え、大きいものは流し読みする` 設計§2-2）。
    ///
    /// そのとき `text` は先頭の窓（[`WINDOW_BYTES`] まで、文字の境目で切る）で、続きは
    /// 窓読み（[`FileChunk`]）で取る。**設定の上限を超えた場合はここを使わず断る**——
    /// 切れていることが伝わらない形（先頭だけ返して黙る）を避けるため、上限超えと意味を
    /// 混ぜない。
    pub truncated: bool,
    /// 元のファイルの大きさ。断るときにも添えるので、返せた場合も入れておく
    pub bytes: u64,
    /// 読んだ時点の印（`ファイルビュアにエディタ機能を追加` 設計§8-3）。
    ///
    /// **中身を解釈しない不透明な文字列である。** 作るのも比べるのも PC 側
    /// （`session-host-core` の `hostfs`）だけで、サーバもブラウザも受け取って
    /// そのまま返すだけ。**だからここに印を組み立てる関数を置かない**——置くと
    /// 「解釈してよい」と読まれ、形式を知る場所が増える。
    ///
    /// `#[serde(default)]` が要るのは、**印を付けない古い PC が送ってきても解ける
    /// ようにする**ためである（`A2S_VERSION` を上げないのと同じ理由）。空のときは
    /// 「印が無い」であって「一致した」ではない——**保存は断る側で扱う。**
    #[serde(default)]
    pub stamp: String,
    /// このファイルを**書き戻せるか**（`ファイルビュアにエディタ機能を追加` 設計§8）。
    ///
    /// **決めるのはサーバだけである。** 効いている根は「設定の `writable_roots` ＋
    /// その口座と PC で引けるプロジェクト全部」で、**後者を知っているのはサーバ**
    /// （記録を引く）。PC は自分がどの口座に見えているかを知らないので、
    /// **ここを PC に決めさせない**——決める場所が2つあると食い違う（設計§3-1）。
    ///
    /// `#[serde(default)]` で **`false`（書けない）に倒れる**。付け忘れると
    /// 「読むだけ」の面が出るので**気づけるが壊れない**——逆に倒すと、
    /// 書けない相手に打てる姿を見せることになる。
    #[serde(default)]
    pub writable: bool,
}

/// 窓1つ。位置を指定して読んだテキストの一部（設計§2-2）。
///
/// `end` から次を頼めば、継ぎ目に欠けも重なりも無い（開始と終わりを UTF-8 の文字の境目へ
/// 寄せてあるため）。`stamp` は [`FileContent::stamp`] と同じ作りで、不透明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChunk {
    pub path: String,
    /// 実際に読んだ先頭（UTF-8 の文字の境目。行頭へ寄せたならその位置）
    pub start: u64,
    /// 実際に読んだ終わり（排他。文字の境目）
    pub end: u64,
    /// ファイル全体の大きさ（読んだ時点）
    pub bytes: u64,
    pub text: String,
    /// 読んだ時点の印（[`FileContent::stamp`] と同じ作り。不透明）
    pub stamp: String,
    /// 行頭へ寄せられたか。寄せを頼まなかった・窓の中に改行が無かったときは false
    /// （先頭から読んだ窓は常に true）
    pub at_line_start: bool,
}

/// 窓の頼み方（設計§2-2）。
///
/// 線の上には載らない（`ServerToAgent::ReadFileRange` の欄として載る）。trait と `hostfs` の
/// 引数として使う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileRange {
    /// 読み始める位置（バイト）。文字の途中なら次の字の頭へ寄せる
    pub offset: u64,
    /// 読む長さ（バイト）。読む側が [`RANGE_MAX_BYTES`] で切り詰める
    pub length: u64,
    /// 最初の改行の直後へ寄せるか（位置へ飛ぶとき、行頭から見せるため）
    pub align_line: bool,
}

/// バイト列で返してよいファイルの大きさの上限（`ファイル閲覧で画像とHTMLも表示する` 設計§4）。
///
/// **テキストの [`WHOLE_TEXT_BYTES`] とは別の値にしてある。** 読みたいものの大きさが桁で違う——
/// 手元のスクショの最大は 545 KB で、テキストの上限が 256 KiB だったころは開けなかった。
///
/// **その差は縮んだが、分けたままにする**（テキストは 3 MiB へ上がった）。**通す側の理由が
/// 別のままだから**である——こちらは「絵として1枚を出す」ための線で、あちらは「文書を
/// 読む」ための線なので、片方を動かす理由がもう片方に当てはまらない。1つにまとめると、
/// 次に動かすときにどちらの理由で動かしているのか読めなくなる。
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

/// 表に無い拡張子と、整形して出す種別に与える型（`ファイルの中身に掛けた隔離を、script の
/// 1段だけ解く` 設計§5-1）。
///
/// **`text/javascript` を返さないことが要点である。** `.js` もここへ落ちるので、
/// `nosniff` と組んで**`<script src>` から実行できない**（設計§5-3。2026-09-04 に実測）。
const TEXT_PLAIN: &str = "text/plain; charset=utf-8";

/// 拡張子 → 種別と媒体型の対応（設計§2-1）。
///
/// **表に無いものも生で返す**（`ファイルの中身に掛けた隔離を、script の1段だけ解く`
/// 設計§5-1）。かつては媒体型を持たない種別を 415 で断っていたが、**押しても意味の無い
/// 相手にエラー画面を見せることになる**ので、[`TEXT_PLAIN`] を与えて字で出す。
///
/// **危なさは型のほうで抑えている。** `.js` を `text/javascript` で返さない限り、
/// ダッシュボードと同じ出自でスクリプトを読ませる道はできない（設計§5-3）。
const TABLE: &[(&str, FileKind, &str)] = &[
    ("md", FileKind::Markdown, TEXT_PLAIN),
    ("markdown", FileKind::Markdown, TEXT_PLAIN),
    ("html", FileKind::Html, "text/html; charset=utf-8"),
    ("htm", FileKind::Html, "text/html; charset=utf-8"),
    ("svg", FileKind::Svg, "image/svg+xml"),
    ("png", FileKind::Image, "image/png"),
    ("jpg", FileKind::Image, "image/jpeg"),
    ("jpeg", FileKind::Image, "image/jpeg"),
    ("gif", FileKind::Image, "image/gif"),
    ("webp", FileKind::Image, "image/webp"),
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

/// 生で返すときの `Content-Type`（設計§5-2、および `ファイルの中身に掛けた隔離を、
/// script の1段だけ解く` 設計§5-1）。
///
/// **すべての拡張子に型がある。** 表に無いものは [`TEXT_PLAIN`] になるので、**ここは
/// 門にならない**。生で返してよいかを決めるのは呼ぶ側で、[`kind_of`] を見て道を選ぶ
/// （設計§5-2）。かつてこの `None` を門にしていた3箇所は、**種別を見る形へ移してある**。
pub fn media_type_of(path: &str) -> &'static str {
    let ext = extension_of(path);
    TABLE
        .iter()
        .find(|(known, _, _)| *known == ext)
        .map_or(TEXT_PLAIN, |(_, _, media)| *media)
}

/// 添付として受け取る媒体型 → 置くときの拡張子。
///
/// **`svg` は返さない。** claude の貼り付け処理が拾うのは `png` / `jpg` / `jpeg` /
/// `gif` / `webp` だけで、`svg` は当たらない（2026-09-01 に実 claude の実行ファイルで
/// 確認）。置いても絶対に添付にならないので、**受け取る前に断るほうが正しい**。
/// script を書ける形式を書き込みの口から遠ざけられる、という都合も重なる。
///
/// **`None` は「添付として受け取らない」**という意味である。呼ぶ側はここで断る。
pub fn attachment_extension_for(media_type: &str) -> Option<&'static str> {
    let wanted = media_type
        .split(';')
        .next()
        .unwrap_or(media_type)
        .trim()
        .to_ascii_lowercase();
    TABLE
        .iter()
        .find(|(_, kind, media)| *kind == FileKind::Image && **media == wanted)
        .map(|(ext, _, _)| *ext)
}

/// その拡張子を添付として受け取るか。[`attachment_extension_for`] の裏返し。
///
/// 置いた名前を読み戻す側（掃除）が、**見覚えのある名前だけを触る**ために使う。
pub fn is_attachment_extension(extension: &str) -> bool {
    let wanted = extension.to_ascii_lowercase();
    TABLE
        .iter()
        .any(|(known, kind, _)| *known == wanted && *kind == FileKind::Image)
}

/// 置いた添付1枚（`メッセージに画像を添付できるようにする` 設計§4）。
///
/// # なぜ [`FileBlob`] を使い回さないのか
///
/// あちらは「**読んだ中身**」で、`data` を必ず持つ。書いた側の答えに中身は要らない
/// ——**要るのは置いた場所だけ**である（画像を取り返すのは生ファイルの口の仕事）。
/// 使い回すと、返すたびに中身を線へ載せ直すことになり、**運んだばかりのバイト列が
/// そのまま往復する**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrittenBlob {
    /// 置いた絶対パス。**本文へ混ぜるのはこれ**（設計§6）
    pub path: String,
    /// `image/png` など。**受け取った媒体型をそのまま返す**（呼ぶ側が突き合わせられるように）
    pub media_type: String,
    /// 置いたバイト数
    pub bytes: u64,
}

/// 書き戻したファイル1つ（`ファイルビュアにエディタ機能を追加` 設計§2）。
///
/// # なぜ [`WrittenBlob`] を流用しないのか
///
/// あちらは**添付を置いた**答えで、`media_type` を必ず持つ。こちらはテキストの
/// 上書きなので媒体型に意味が無く、流用すると**意味の無い欄を毎回埋める**ことになる。
/// [`FileContent`] と [`FileBlob`] を分けたのと同じ理由で、別の型にしておく。
///
/// # なぜ書いた側にも印を返すのか
///
/// **返さないと、2回目の保存が必ず断られる。** 呼ぶ側が持っている印は読んだ時点の
/// ものなので、書いた瞬間に古くなる。ここで新しい印を返して差し替えさせる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrittenFile {
    /// 書いた絶対パス
    pub path: String,
    /// 書いたバイト数
    pub bytes: u64,
    /// **書いたあとの**印（設計§8-3）。呼ぶ側はこれを次の保存へ持っていく
    pub stamp: String,
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
    /// `image/png` など。**拡張子から決める**（[`media_type_of`]）。
    /// **ここへ来るのは画像だけ**——バイト列で運ぶ道は [`FileKind::Image`] に限ってある
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
pub(crate) mod base64_bytes {
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
        assert_eq!(WHOLE_TEXT_BYTES, 3_145_728);
        assert_eq!(WINDOW_BYTES, 262_144);
        assert_eq!(RANGE_MAX_BYTES, 1_048_576);
        assert_eq!(FILE_VIEW_LIMIT_MAX, 21_474_836_480);
    }

    /// 窓・選択肢・大きさの表記（`ファイル閲覧の上限を設定から変え、大きいものは流し読みする`
    /// 設計§2。テスト計画フェーズ1）。
    mod 窓と選択肢 {
        use super::*;

        #[test]
        fn 選択肢は16個で昇順に並び最後が天井() {
            assert_eq!(FILE_VIEW_LIMIT_CHOICES.len(), 16);
            for pair in FILE_VIEW_LIMIT_CHOICES.windows(2) {
                assert!(pair[0] < pair[1], "狭義の昇順であること：{pair:?}");
            }
            for value in FILE_VIEW_LIMIT_CHOICES {
                // 2進で数える（1 MB ＝ 1,048,576 バイト）
                assert_eq!(value % 1_048_576, 0, "{value} が MiB の倍数であること");
            }
            assert_eq!(FILE_VIEW_LIMIT_CHOICES[15], 21_474_836_480);
        }

        #[test]
        fn 選択肢の名前は要件の並びのまま() {
            // **字で書く。** 要件の16個（1MB〜20GB）と食い違ったら、どちらかが嘘になっている
            let labels: Vec<String> = FILE_VIEW_LIMIT_CHOICES
                .iter()
                .map(|&value| limit_label(value))
                .collect();
            assert_eq!(
                labels,
                [
                    "1 MB", "3 MB", "5 MB", "10 MB", "15 MB", "20 MB", "30 MB", "50 MB", "100 MB",
                    "300 MB", "500 MB", "1 GB", "3 GB", "5 GB", "10 GB", "20 GB"
                ]
            );
        }

        #[test]
        fn 選択肢に無い大きさの名前は表記の関数に任せる() {
            assert_eq!(limit_label(0), "0 B");
            assert_eq!(limit_label(1_536), "2 KB");
            assert_eq!(limit_label(5_062_904), "4.8 MB");
        }

        #[test]
        fn 大きさの表記は画面と同じ見本の表に合う() {
            // **画面（`web/src/lib/format.ts` の `formatBytes`）に当てて求めた値。** 同じ表を
            // TS 側にも置く（テスト計画フェーズ6）。同点（1.5・2.5・2.25）は「半分は上へ」で、
            // 偶数へ寄せる丸めだと 2560 が "2 KB" になって落ちる
            let table: [(u64, &str); 16] = [
                (0, "0 B"),
                (1, "1 B"),
                (1_023, "1023 B"),
                (1_024, "1 KB"),
                (1_536, "2 KB"),
                (2_560, "3 KB"),
                (1_048_575, "1024 KB"),
                (1_048_576, "1.0 MB"),
                (2_359_296, "2.3 MB"),
                (3_145_728, "3.0 MB"),
                (5_062_904, "4.8 MB"),
                (8_388_608, "8.0 MB"),
                (104_857_600, "100 MB"),
                (1_073_741_824, "1.0 GB"),
                (21_474_836_480, "20.0 GB"),
                (5_497_558_138_880, "5.0 TB"),
            ];
            for (bytes, want) in table {
                assert_eq!(human_bytes(bytes), want, "{bytes} バイト");
            }
        }

        fn 窓の見本() -> FileChunk {
            FileChunk {
                path: "/home/me/記録.log".to_string(),
                start: 262_144,
                end: 524_290,
                bytes: 6_442_450_944,
                text: "あé🙂\n\"引用\" と \\ 逆斜線\n".to_string(),
                stamp: "12345:678".to_string(),
                at_line_start: true,
            }
        }

        #[test]
        fn 窓の欄名は画面が読む綴りのまま() {
            // 画面（フェーズ7）が同じ綴りで読む。線の上の形をここで固定する
            let value = serde_json::to_value(窓の見本()).unwrap();
            let mut keys: Vec<&str> = value
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort_unstable();
            assert_eq!(
                keys,
                [
                    "at_line_start",
                    "bytes",
                    "end",
                    "path",
                    "stamp",
                    "start",
                    "text"
                ]
            );
        }

        #[test]
        fn 窓は多バイト字と引用符を混ぜても往復して同じに戻る() {
            let chunk = 窓の見本();
            let json = serde_json::to_string(&chunk).unwrap();
            let back: FileChunk = serde_json::from_str(&json).unwrap();
            assert_eq!(back, chunk);
        }
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
            assert_eq!(media_type_of("A.JPEG"), "image/jpeg");
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
        fn 表に載る種別は決まった型で返る() {
            assert_eq!(media_type_of("撮った.png"), "image/png");
            assert_eq!(media_type_of("理解.html"), "text/html; charset=utf-8");
            assert_eq!(media_type_of("図.svg"), "image/svg+xml");
            assert_eq!(media_type_of("動く.gif"), "image/gif");
            assert_eq!(media_type_of("軽い.webp"), "image/webp");
        }

        #[test]
        fn 表の外も素のテキストとして返る() {
            // **415 を見せない**（`ファイルの中身に掛けた隔離を、script の1段だけ解く`
            // 設計§5-1）。押しても意味の無い相手でも、字か理由のどちらかは必ず出る
            assert_eq!(media_type_of("計画.md"), "text/plain; charset=utf-8");
            assert_eq!(media_type_of("メモ.txt"), "text/plain; charset=utf-8");
            assert_eq!(media_type_of("組み込み.js"), "text/plain; charset=utf-8");
            assert_eq!(media_type_of("README"), "text/plain; charset=utf-8");
        }

        #[test]
        fn jsを実行できる型で返さない() {
            // **綴りを1つ字で固定する。** ここが崩れると、`nosniff` と組んで
            // 「`<script src>` から実行できない」と言えた根拠が消える（設計§5-3）。
            // 守っているのは nosniff の1枚だけなので、型のほうも見ておく
            for name in ["組み込み.js", "型.ts", "束.mjs"] {
                let media = media_type_of(name);
                assert!(
                    !media.contains("javascript"),
                    "{name} を実行できる型で返さないこと（{media}）"
                );
                assert!(!media.contains("ecmascript"), "{name}（{media}）");
            }
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
            assert_ne!(MAX_BLOB_BYTES, WHOLE_TEXT_BYTES);
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
