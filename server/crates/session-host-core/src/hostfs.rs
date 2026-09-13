//! 利用者の PC のフォルダとファイルを読む（イシューグループ_2026_0805_0514 設計§8・§9）。
//!
//! # ここが唯一の読み手
//!
//! **ファイルシステムを読むのはこの crate だけ**（設計§1）。サーバ側（`server-core`）は
//! ローカルモードであっても自分では読まず、`SessionHost` 越しにここへ頼む。片側だけ
//! 近道を作ると「ローカルでは動くのにセルフホストで欠ける」という、経路の違いが原因で
//! テストを増やしても見つからない壊れ方が残る（設計§19）。
//!
//! # 読む口と、書く口は別である
//!
//! かつてここには「**書く口はこの工事では作らない**」と書いてあった。理由は
//! 「書ける口を1つ開けると、ブラウザから利用者の機械へ任意の書き込みができることになり、
//! 鍵のかけ方の議論が丸ごと別物になる」であり、**その懸念はいまも正しい。**
//!
//! `ファイルビュアにエディタ機能を追加` で、その議論をしたうえで口を開けた（設計§3）。
//! **無制限には開けていない**——[`write_file`] は**許可された根の配下だけ**を書く。
//! 読み取りに範囲の制限が無いのに書き込みにはあるのは、**欠陥ではなく意図である**
//! （設計§3-4）。壊せる範囲を、見られる範囲より狭く取っている。
//!
//! **そして上書きだけである。** 作る・消す・移すはしない（設計§11）。それを守って
//! いるのは `tests/hostfs.rs` の構造の検査で、**書く道具の綴りがソースに現れていないか**
//! を見ている。[`write_file`] が使ってよいのは `fs::write` 1つだけである。
//!
//! # 同期のまま置いてある
//!
//! ファイルの仕事は呼ぶ側が `spawn_blocking` へ逃がす（`link.rs`）。ここを `async` に
//! しても中で待つのは同じで、**呼ぶ側がどのランタイムに居るかを決めつける**ことになる。

use protocol::a2s::HostFailure;
use protocol::fs::{
    DirEntry, DirListing, EntryKind, FileBlob, FileContent, FileKind, MAX_BLOB_BYTES, MAX_ENTRIES,
    MAX_FILE_BYTES, MAX_LISTING_BYTES, WrittenFile, kind_of, media_type_of,
};
use std::path::{Path, PathBuf};

/// 応えられなかったときの中身。そのまま `HostReply::Failed` になる。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostFsError {
    pub reason: HostFailure,
    /// 人が読む説明。**画面へそのまま出る**ので、利用者が次に何をすればよいか分かる文にする
    pub detail: String,
}

impl HostFsError {
    pub(crate) fn new(reason: HostFailure, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: detail.into(),
        }
    }

    /// `std::io::Error` を、利用者が直せる理由へ翻訳する。
    ///
    /// **まとめて「読めません」にしない**（設計§8）。権限が無いのか消えているのかは
    /// どちらも利用者が直せるものなので、混ぜると直しようが無くなる。
    pub(crate) fn from_io(err: &std::io::Error, path: &Path) -> Self {
        let reason = match err.kind() {
            std::io::ErrorKind::NotFound => HostFailure::NotFound,
            std::io::ErrorKind::PermissionDenied => HostFailure::Denied,
            _ => HostFailure::Unsupported,
        };
        Self::new(reason, format!("{} を開けません（{err}）", path.display()))
    }
}

/// 1件あたりの、名前を除いた見積もり（設計§23-2 の実測が1件60バイト前後）。
///
/// 大きさの上限を掛けるのに使う。**正確な JSON の長さを作ってから測らない**——
/// 作ってから捨てるのは、上限を置いた意味（大きいものを作らない）を失う。
const ENTRY_OVERHEAD_BYTES: usize = 60;

/// 「始まりの場所」＝この PC のホーム（設計§26-2）。
///
/// **ホームを知っているのは PC 側だけ**なので、サーバから `~` を送ってもらう道は無い。
/// 環境変数が無い環境（サービスとして起こした場合など）ではルートに落とす——
/// 辿る起点が消えるより、辿れるがそっけない起点があるほうがよい。
pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// 一覧の起点を決める（設計§26-2・§13）。
///
/// 3つのことを1か所でやる。
///
/// 1. **省略されたらホーム**（§26-2）
/// 2. **Windows 側から貼ったパスを読み替える**（`\` 区切り・`\\wsl.localhost\...`・
///    `C:\...`・引用符付き）
/// 3. **カードと同じ規則で正規化する**（末尾の `/`・途中のリンクを落とす）
///
/// 2 と 3 が要るのは、**追加の入口が2つある**ためである（§13）。打ち込む道と辿る道が
/// 別の値を指すと、同じフォルダなのに打ち方の違いで枠とカードが別の箱に割れる。
/// 読み替えそのものは `session::cwd` が持っているので、ここでは**呼ぶだけ**——
/// 解釈の並べ方を2箇所に書くと、片方だけ直したときに食い違う。
///
/// 3 の相手は `session::spawn_with`（カードの `project` を作る側）で、あちらも
/// `canonicalize` を通している。**片方だけ通すと、末尾に `/` を付けて足した枠が
/// カードと別の箱になる**——フォルダのコピーは `/` を付ける仕様なので、貼って
/// 足すだけで踏める。
///
/// 当たらなければ**入力をそのまま返す**。存在しないパスでも枠は足せる必要があり
/// （§17。寝ている PC のぶん）、断るかどうかは呼んだ先の仕事になる。
pub fn resolve_start(path: Option<&str>) -> PathBuf {
    let found = match path {
        None => home(),
        Some(path) => match crate::session::cwd::resolve(path) {
            crate::session::cwd::Resolution::Found(found) => found,
            _ => PathBuf::from(path),
        },
    };
    found.canonicalize().unwrap_or(found)
}

/// 起点を決めてから一覧する（設計§26-2・§8）。
///
/// **この2つを離さない。** 解決はファイルシステムに触る（候補ごとに `is_dir()` を
/// 叩き、正規化もする）ので、呼ぶ側が逃がした先の外で解決すると、逃がした意味が
/// その手前で薄まる。1本にしておけば、次に呼ぶ実装が解決を忘れる余地も無い。
pub fn list_dir_from(start: Option<&str>) -> Result<DirListing, HostFsError> {
    list_dir(&resolve_start(start))
}

/// 並べ替えるまでの1件。
///
/// `is_project` をまだ持たないのは、**その判定に1件ずつ stat が要る**ため。
/// 打ち切りで捨てる分にまで打つと、遅いマウントでは時間切れに近づく（設計§8）。
struct Found {
    name: String,
    kind: EntryKind,
}

/// フォルダ1つの中身を返す（設計§8）。
///
/// **リンクは辿らない。** 追いかけると輪を作られたときに止まらなくなるので、
/// 在ることだけを示す。ただしこれは**一覧の中の1件**についての決まりで、
/// 問われたパスそのものには当てはまらない（下記）。
pub fn list_dir(path: &Path) -> Result<DirListing, HostFsError> {
    // 「無い」と「ファイルだった」を先に分ける。`read_dir` はどちらも同じ顔で失敗する。
    //
    // **辿る側（`metadata`）で見る。** ここで `symlink_metadata` を使うと、
    // PJT のルートがリンクの人は一覧そのものを開けない——`read_dir` はリンクを
    // 辿るので、詰まるのはこの手前の判定だけになる
    let meta = std::fs::metadata(path).map_err(|err| HostFsError::from_io(&err, path))?;
    if !meta.is_dir() {
        return Err(HostFsError::new(
            HostFailure::NotDirectory,
            format!("{} はフォルダではありません", path.display()),
        ));
    }

    let reader = std::fs::read_dir(path).map_err(|err| HostFsError::from_io(&err, path))?;

    // **先に全件を集める。** 打ち切ってから並べると、返るのは
    // 「`read_dir` が先に返した任意の切れ端」になり、下の並びの約束が
    // いちばん必要な場面（件数が多くて辿りにくいフォルダ）でだけ効かない
    let mut all: Vec<Found> = Vec::new();

    for found in reader {
        let found = match found {
            Ok(found) => found,
            // 1件読めなくても一覧そのものは返す。**そこで諦めると、読めるものまで見えなくなる**
            Err(err) => {
                tracing::debug!("フォルダの1件を読めません（{err}）");
                continue;
            }
        };

        let name = found.file_name().to_string_lossy().into_owned();

        // **リンクかどうかを先に見る。** `metadata()` は辿ってしまうので、
        // リンク先がフォルダだと「フォルダ」として出てしまう
        let kind = match found.file_type() {
            Ok(file_type) if file_type.is_symlink() => EntryKind::Symlink,
            Ok(file_type) if file_type.is_dir() => EntryKind::Dir,
            Ok(_) => EntryKind::File,
            Err(err) => {
                tracing::debug!("{name} の種別を読めません（{err}）");
                continue;
            }
        };

        all.push(Found { name, kind });
    }

    // **ディレクトリが先、その他が後。** 各群の中は名前の昇順で、大文字小文字を区別しない。
    // 辿るのが目的なので、開けるものが上に集まっているほうが速い（設計§8）
    all.sort_by(|a, b| {
        let group = |kind: EntryKind| u8::from(!matches!(kind, EntryKind::Dir));
        group(a.kind)
            .cmp(&group(b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            // 大文字小文字だけが違う2件で並びが揺れないよう、最後に元の名前で決める
            .then_with(|| a.name.cmp(&b.name))
    });

    let mut entries: Vec<DirEntry> = Vec::new();
    let mut truncated = false;
    let mut bytes = 0usize;

    for Found { name, kind } in all {
        // **二重の上限**（設計§23-2）。件数だけでは、名前が極端に長いフォルダを縛れない
        bytes += name.len() + ENTRY_OVERHEAD_BYTES;
        if entries.len() >= MAX_ENTRIES || bytes > MAX_LISTING_BYTES {
            truncated = true;
            break;
        }

        // `.git` を持つのはフォルダだけ。リンクには付けない（辿らないと分からないため）
        let is_project = matches!(kind, EntryKind::Dir) && path.join(&name).join(".git").exists();

        entries.push(DirEntry {
            name,
            kind,
            is_project,
        });
    }

    Ok(DirListing {
        path: path.display().to_string(),
        entries,
        truncated,
    })
}

/// ファイル1つを**バイト列で**返す（`ファイル閲覧で画像とHTMLも表示する` 設計§3-2）。
///
/// # `read_file` とどう違うのか
///
/// あちらは「テキストだけ」を契約にしていて、UTF-8 として読めないものを断る。
/// ここは**断らずに運ぶ**代わりに、**生で返してよいと決めた種別だけ**を相手にする
/// （表は `protocol::fs` に1つ。設計§2-2）。
///
/// # 中身は検めない
///
/// 拡張子が `.png` で中身が違っていても、そのまま返す。**壊れていることに気づけるのは
/// 描く側**なので、そこで言う（設計§7-2）。ここで中身を見に行くと、
/// 「読めない」と「壊れている」が同じ断りに潰れる。
pub fn read_blob(path: &Path) -> Result<FileBlob, HostFsError> {
    let shown = path.display().to_string();

    // **種別を先に見る。** ここは画像専用の道なので、大きさを測るまでもなく相手ではない。
    //
    // **媒体型の有無で見ない**（`ファイルの中身に掛けた隔離を、script の1段だけ解く`
    // 設計§5-2）。あちらは表に無いものにも `text/plain` を返すようになったので、
    // 門として使うと**テキストが画像の道へ入り込む**
    if kind_of(&shown) != FileKind::Image {
        return Err(HostFsError::new(
            HostFailure::Unsupported,
            format!("{shown} は画像ではないので、バイト列では返せません"),
        ));
    }
    let media_type = media_type_of(&shown);

    // **判定と読み取りが同じものを見る。** 下の `fs::read` はリンクを辿るので、
    // ここで `symlink_metadata`（辿らない側）を使うと、リンク1本で上限をすり抜けられる
    let meta = std::fs::metadata(path).map_err(|err| HostFsError::from_io(&err, path))?;
    if meta.is_dir() {
        return Err(HostFsError::new(
            HostFailure::Unsupported,
            format!("{shown} はフォルダなので中身を読めません"),
        ));
    }

    // **開く前に大きさで断る。** 読んでから捨てるのでは、上限を置いた意味が無い
    let bytes = meta.len();
    if bytes > MAX_BLOB_BYTES {
        return Err(HostFsError::new(
            HostFailure::TooLarge,
            format!("{shown} は {bytes} バイトで、上限の {MAX_BLOB_BYTES} バイトを超えています"),
        ));
    }

    let data = std::fs::read(path).map_err(|err| {
        let failure = HostFsError::from_io(&err, path);
        tracing::warn!(path = %shown, bytes, reason = ?failure.reason, "ファイルをバイト列で読めません");
        failure
    })?;

    Ok(FileBlob {
        path: shown,
        media_type: media_type.to_string(),
        bytes,
        data,
    })
}

/// **ホームからの相対を、起点から組み立てる。** 当たらなければそのまま返す。
///
/// **これは記号の特別扱いではない。** 足しているのは「**ホームを起点にする道**」であって、
/// `~` という綴りに意味を持たせているのではない——[`resolve_start`] が引数を省いたときに
/// 既にやっていることを、読む口からも使えるようにしただけである。
///
/// **規則を2箇所に書かない。** ホームの決め方は [`resolve_start`] が既に持っているので
/// **呼ぶだけ**にする（[`list_dir_from`] が `cwd::resolve` を呼ぶだけにしてあるのと同じ）。
fn resolve_read_path(path: &str) -> PathBuf {
    if path == "~" {
        return resolve_start(None);
    }
    match path.strip_prefix("~/") {
        Some(rel) => resolve_start(None).join(rel),
        None => PathBuf::from(path),
    }
}

/// **`~/` で始まるならホームから**ファイル1つを読む（`statusコマンド相当の情報を画面から
/// 見えるようにする` 設計「引きの経路（Stats）」）。
///
/// **ホームを知っているのは PC 側だけ**（[`home`] の doc）なので、ブラウザが絶対パスを
/// 組んで渡す道は無い。**展開はここでやる。**
///
/// # 書く側には効かせない
///
/// [`write_file`] からは呼ばない。書く口はサーバの入口が**字句**で照合し、PC 側が
/// `canonicalize` した**実体**でもう一度確かめる形になっている（`server-core` の
/// `hosts::api_write_file` の doc。規則は `protocol::path::is_writable` の1つで、
/// 確かめる場所が2つ）。**ここで展開すると「照合した文字列」と「開いた対象」がずれる**
/// ——サーバが `~/notes/x.md` を見て許し、PC が `/home/u/notes/x.md` を書く形になる。
///
/// **読む口（`hosts::api_file`）には照合が無い**ので、読む側だけなら前提を壊さない。
/// 【実測 2026-09-13】`api_file` は `read_file` を呼ぶだけで、`writable_roots` を見ない。
pub fn read_file_from(path: &str) -> Result<FileContent, HostFsError> {
    read_file(&resolve_read_path(path))
}

/// ファイル1つの中身を返す（設計§9）。
///
/// **テキストだけ。** 文字コードの推定はしない——外したときに文字化けした嘘を
/// 表示することになる。
pub fn read_file(path: &Path) -> Result<FileContent, HostFsError> {
    // **判定と読み取りが同じものを見る。** 下の `fs::read` はリンクを辿るので、
    // ここで `symlink_metadata`（辿らない側）を使うと、リンクの大きさ＝数十バイトで
    // 上限を判定してしまい、**リンク1本で上限をすり抜けられる**
    let meta = std::fs::metadata(path).map_err(|err| HostFsError::from_io(&err, path))?;
    if meta.is_dir() {
        return Err(HostFsError::new(
            HostFailure::Unsupported,
            format!("{} はフォルダなので中身を読めません", path.display()),
        ));
    }

    // **開く前に大きさで断る。** 読んでから捨てるのでは、上限を置いた意味が無い
    let bytes = meta.len();
    if bytes > MAX_FILE_BYTES {
        return Err(HostFsError::new(
            HostFailure::TooLarge,
            format!(
                "{} は {bytes} バイトで、上限の {MAX_FILE_BYTES} バイトを超えています",
                path.display()
            ),
        ));
    }

    let raw = std::fs::read(path).map_err(|err| HostFsError::from_io(&err, path))?;

    // NUL を含むならバイナリ。テキストとして出すと画面が壊れる
    if raw.contains(&0) {
        return Err(HostFsError::new(
            HostFailure::Unsupported,
            format!("{} はテキストではありません", path.display()),
        ));
    }

    let text = String::from_utf8(raw).map_err(|_| {
        HostFsError::new(
            HostFailure::Unsupported,
            format!("{} は UTF-8 として読めません", path.display()),
        )
    })?;

    Ok(FileContent {
        path: path.display().to_string(),
        text,
        // 上限の内側で切ることは、いまはしない。**上限超えと意味を混ぜない**（設計§9）
        truncated: false,
        bytes,
        // 読んだ時点の印。**保存のときにこれを持ってきてもらう**（設計§8-3）
        stamp: stamp_of(&meta),
        // **ここでは決めない**（設計§8）。書いてよい根は「設定の根＋その口座で引ける
        // プロジェクト全部」で、**後者を知っているのはサーバだけ**である。PC は自分が
        // どの口座に見えているかを知らないので、**決める場所を2つにしない**ために
        // 倒したまま返し、サーバが上書きする。
        writable: false,
    })
}

/// 読んだ時点と書く直前を突き合わせるための印（設計§8-3）。
///
/// # 形式を知るのはここだけである
///
/// `<バイト数>-<更新時刻のナノ秒>`。**サーバも画面も解釈しない**——受け取ってそのまま
/// 返すだけなので、形式を変えてもこの関数の外は1行も直らない。だから `protocol` 側へ
/// 組み立てを置いていない（置くと「解釈してよい」と読まれ、形式を知る場所が増える）。
///
/// # 中身の要約を混ぜていない
///
/// 混ぜれば取りこぼしは減るが、**保存のたびに古い中身を丸ごと読み直す**ことになる——
/// 書くときは本来読まない。上限は 3 MiB あるので安くない。
///
/// **したがってこの印は完全ではない。** 同じ大きさで、かつ更新時刻の粒度の内側に収まる
/// 書き換えは原理的に抜ける。塞ぎたくなったら要約を混ぜる道がある。
///
/// # 時刻は丸めない
///
/// OS が返す精度をそのまま使う。丸めると盲点が広がるだけで、得るものが無い。更新時刻を
/// 持たない環境では大きさだけの印になり、**守りは弱くなるが壊れはしない。**
fn stamp_of(meta: &std::fs::Metadata) -> String {
    let nanos = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", meta.len())
}

/// ファイル1つを書き戻す（`ファイルビュアにエディタ機能を追加` 設計§2）。
///
/// # 上書きだけである
///
/// **作らない・消さない・移さない**（設計§11）。存在しないパスは断る——作る口は
/// `フォルダとファイルを追加できるようにしてほしい` の担当で、そちらが乗るときに
/// **同じ照合を通す**。
///
/// # 確かめる順序に意味がある
///
/// 実体 → 許可された根 → 印、の順に見る。**根を先に確かめる**のは、許可されていない
/// 場所のファイルについて「印が違います」と教えると、**そこに何があるかを漏らす**ため。
///
/// # 規則は1つ、確かめる場所が2つ
///
/// サーバは**字句**で、ここは **`canonicalize` した実体**で確かめる（設計§3-1）。
/// どちらも [`protocol::path::is_writable`] を呼ぶ。**二重実装ではない**——同じ規則へ
/// 渡す材料が違うだけである。リンクを辿った先が根の外に在る形は、ここでしか塞げない。
pub fn write_file(
    path: &Path,
    text: &str,
    stamp: &str,
    roots: &[String],
) -> Result<WrittenFile, HostFsError> {
    // **印の無い要求は断る**（設計§8-3）。省けば上書きできる道を残すと、競合の検知は
    // 「印を付けた人だけが守られる」ものになる
    if stamp.is_empty() {
        return Err(HostFsError::new(
            HostFailure::Conflict,
            format!("{} を書くには、読んだ時点の印が要ります", path.display()),
        ));
    }

    // **実体で確かめる。** `..` もリンクもここで畳まれる。`fs::write` はリンクを辿るので、
    // **辿った先が根の内側か**を見ないとリンク1本で外へ抜けられる
    let actual = std::fs::canonicalize(path).map_err(|err| HostFsError::from_io(&err, path))?;
    let shown = actual.display().to_string();

    if !protocol::path::is_writable(roots, &shown) {
        return Err(HostFsError::new(
            HostFailure::Denied,
            format!("{shown} は、書き込みを許可された場所の外です"),
        ));
    }

    let meta = std::fs::metadata(&actual).map_err(|err| HostFsError::from_io(&err, &actual))?;
    if meta.is_dir() {
        return Err(HostFsError::new(
            HostFailure::Unsupported,
            format!("{shown} はフォルダなので書き戻せません"),
        ));
    }

    // **切り詰めて上書きする事故を塞ぐ**（設計§9）。いまは上限超えを丸ごと断っているので
    // 発火しないが、部分読みが入ったときにここが効く
    let bytes = meta.len();
    if bytes > MAX_FILE_BYTES {
        return Err(HostFsError::new(
            HostFailure::TooLarge,
            format!("{shown} は {bytes} バイトで、上限の {MAX_FILE_BYTES} バイトを超えています"),
        ));
    }

    // **書く直前にもう一度取って照合する**（設計§8-3）。読んでから保存するまでに別の
    // セッションの claude が同じファイルを書き換えているのは、この道具では日常である
    let now = stamp_of(&meta);
    if now != stamp {
        return Err(HostFsError::new(
            HostFailure::Conflict,
            format!("{shown} は、読んだあとに他所で書き換えられています"),
        ));
    }

    // 読む側が NUL を断っているので、書く側でも断る。**画面からは入らないが CLI からは入る**
    if text.as_bytes().contains(&0) {
        return Err(HostFsError::new(
            HostFailure::Unsupported,
            format!("{shown} へ NUL を含む中身は書けません"),
        ));
    }

    // **文字コードは推定も変換もしない**（設計§9）。読めたものをそのまま書き戻す
    std::fs::write(&actual, text).map_err(|err| HostFsError::from_io(&err, &actual))?;

    // **書いたあとの印を返す。** 返さないと、2回目の保存が必ず断られる
    let after = std::fs::metadata(&actual).map_err(|err| HostFsError::from_io(&err, &actual))?;
    Ok(WrittenFile {
        path: shown,
        bytes: after.len(),
        stamp: stamp_of(&after),
    })
}
