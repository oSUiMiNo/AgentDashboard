//! 利用者の PC のフォルダとファイルを読む（イシューグループ_2026_0805_0514 設計§8・§9）。
//!
//! # ここが唯一の読み手
//!
//! **ファイルシステムを読むのはこの crate だけ**（設計§1）。サーバ側（`server-core`）は
//! ローカルモードであっても自分では読まず、`SessionHost` 越しにここへ頼む。片側だけ
//! 近道を作ると「ローカルでは動くのにセルフホストで欠ける」という、経路の違いが原因で
//! テストを増やしても見つからない壊れ方が残る（設計§19）。
//!
//! # 読むだけ
//!
//! 書く口はこの工事では作らない（設計§9）。書ける口を1つ開けると、ブラウザから
//! 利用者の機械へ任意の書き込みができることになり、鍵のかけ方の議論が丸ごと別物になる。
//!
//! # 同期のまま置いてある
//!
//! ファイルの仕事は呼ぶ側が `spawn_blocking` へ逃がす（`link.rs`）。ここを `async` に
//! しても中で待つのは同じで、**呼ぶ側がどのランタイムに居るかを決めつける**ことになる。

use protocol::a2s::HostFailure;
use protocol::fs::{
    DirEntry, DirListing, EntryKind, FileContent, MAX_ENTRIES, MAX_FILE_BYTES, MAX_LISTING_BYTES,
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
    fn new(reason: HostFailure, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: detail.into(),
        }
    }

    /// `std::io::Error` を、利用者が直せる理由へ翻訳する。
    ///
    /// **まとめて「読めません」にしない**（設計§8）。権限が無いのか消えているのかは
    /// どちらも利用者が直せるものなので、混ぜると直しようが無くなる。
    fn from_io(err: &std::io::Error, path: &Path) -> Self {
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
/// 2つのことを1か所でやる。
///
/// 1. **省略されたらホーム**（§26-2）
/// 2. **Windows 側から貼ったパスを読み替える**（`\` 区切り・`\\wsl.localhost\...`・
///    `C:\...`・引用符付き）
///
/// 2 が要るのは、**追加の入口が2つある**ためである（§13）。打ち込む道と辿る道が
/// 別の値を指すと、同じフォルダなのに打ち方の違いで枠とカードが別の箱に割れる。
/// 読み替えそのものは `session::cwd` が持っているので、ここでは**呼ぶだけ**——
/// 解釈の並べ方を2箇所に書くと、片方だけ直したときに食い違う。
///
/// 当たらなければ**入力をそのまま返す**。存在しないパスでも枠は足せる必要があり
/// （§17。寝ている PC のぶん）、断るかどうかは呼んだ先の仕事になる。
pub fn resolve_start(path: Option<&str>) -> PathBuf {
    let Some(path) = path else {
        return home();
    };
    match crate::session::cwd::resolve(path) {
        crate::session::cwd::Resolution::Found(found) => found,
        _ => PathBuf::from(path),
    }
}

/// フォルダ1つの中身を返す（設計§8）。
///
/// **リンクは辿らない。** 追いかけると輪を作られたときに止まらなくなるので、
/// 在ることだけを示す。
pub fn list_dir(path: &Path) -> Result<DirListing, HostFsError> {
    // 「無い」と「ファイルだった」を先に分ける。`read_dir` はどちらも同じ顔で失敗する
    let meta = std::fs::symlink_metadata(path).map_err(|err| HostFsError::from_io(&err, path))?;
    if !meta.is_dir() {
        return Err(HostFsError::new(
            HostFailure::NotDirectory,
            format!("{} はフォルダではありません", path.display()),
        ));
    }

    let reader = std::fs::read_dir(path).map_err(|err| HostFsError::from_io(&err, path))?;

    let mut entries: Vec<DirEntry> = Vec::new();
    let mut truncated = false;
    let mut bytes = 0usize;

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

        // `.git` を持つのはフォルダだけ。リンクには付けない（辿らないと分からないため）
        let is_project = matches!(kind, EntryKind::Dir) && found.path().join(".git").exists();

        // **二重の上限**（設計§23-2）。件数だけでは、名前が極端に長いフォルダを縛れない
        bytes += name.len() + ENTRY_OVERHEAD_BYTES;
        if entries.len() >= MAX_ENTRIES || bytes > MAX_LISTING_BYTES {
            truncated = true;
            break;
        }

        entries.push(DirEntry {
            name,
            kind,
            is_project,
        });
    }

    // **ディレクトリが先、その他が後。** 各群の中は名前の昇順で、大文字小文字を区別しない。
    // 辿るのが目的なので、開けるものが上に集まっているほうが速い（設計§8）
    entries.sort_by(|a, b| {
        let group = |kind: EntryKind| u8::from(!matches!(kind, EntryKind::Dir));
        group(a.kind)
            .cmp(&group(b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            // 大文字小文字だけが違う2件で並びが揺れないよう、最後に元の名前で決める
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(DirListing {
        path: path.display().to_string(),
        entries,
        truncated,
    })
}

/// ファイル1つの中身を返す（設計§9）。
///
/// **テキストだけ。** 文字コードの推定はしない——外したときに文字化けした嘘を
/// 表示することになる。
pub fn read_file(path: &Path) -> Result<FileContent, HostFsError> {
    let meta = std::fs::symlink_metadata(path).map_err(|err| HostFsError::from_io(&err, path))?;
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
    })
}
