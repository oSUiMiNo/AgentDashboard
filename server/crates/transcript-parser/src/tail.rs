//! ファイルの増分読み取りと巻き戻り検知（設計§8）。
//!
//! # 守っている不変条件：オフセットは必ず行境界を指す
//!
//! JSONL は追記中に読まれるので、**途中まで書かれた最終行**が普通に見える。改行で
//! 終わっていない末尾は読まずに残し、オフセットも進めない。これを守らないと、
//! 1つのレコードが「壊れた前半」と「壊れた後半」の2件になって二重に届く。
//! テスト計画の「オフセット再開で欠落・重複が無いこと」は、この不変条件の上に立っている。
//!
//! # ファイルが無いのは異常ではない
//!
//! `transcript_path` はフックが運んでくるが、その時点でファイルはまだ存在しない
//! （フェーズ2の実機検証で確認済み）。JSONL は結果整合のチャネルであり、
//! 「無い＝異常」と扱うと構造化ビューが起動直後に必ず壊れる。

use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::io::{self, Read as _, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 1回の読み取りで扱う上限。
///
/// 20MB のファイルに追いつくとき、1発で読んで1つの巨大なイベントにすると、
/// WebSocket の送信キュー（クライアントあたり64本）を一撃で詰まらせる。分けて流す。
const MAX_CHUNK: usize = 4 * 1024 * 1024;

/// 1行の上限。これを超えたら中身を諦めて先へ進む。
///
/// 実測の最長行は約220KBだが、1行でメモリを飛ばせる経路を残さない。
const MAX_LINE: usize = 8 * 1024 * 1024;

/// 先頭の同一性を見るために読むバイト数の上限。
///
/// 実際に見るのは「既に読み終えた範囲」の先頭部分だけにする（[`FileTail::head_len`]）。
/// 単純に先頭4KiBを見ると、4KiB に満たないファイルへの**追記でも指紋が変わってしまい**、
/// 正常な追記を巻き戻りと誤判定する。
const HEAD_BYTES: u64 = 4096;

/// 読み取りの結果。
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// まだファイルが無い。異常ではない
    Missing,
    /// 巻き戻りを検知した。読み手は履歴を捨てて先頭から読み直す
    Reset,
    /// 完全な行が取れた（0件のこともある）
    Lines {
        /// (ファイル内の開始位置, 行の中身)
        lines: Vec<(u64, String)>,
        next_offset: u64,
    },
}

/// 1ファイルの読み進み状態。
#[derive(Debug)]
pub struct FileTail {
    path: PathBuf,
    offset: u64,
    /// 先頭 [`HEAD_BYTES`] の指紋。同じ長さのまま中身が入れ替わる巻き戻りを捕まえる
    head: Option<u64>,
}

impl FileTail {
    pub fn new(path: impl Into<PathBuf>, offset: u64) -> Self {
        Self {
            path: path.into(),
            offset,
            head: None,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// 追記分を読む。
    pub fn read(&mut self) -> io::Result<Outcome> {
        let metadata = match std::fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Outcome::Missing),
            Err(error) => return Err(error),
        };

        // 縮んだ＝巻き戻った。`/rewind` のほか、削除して作り直された場合もここに来る
        if metadata.len() < self.offset {
            self.rewind();
            return Ok(Outcome::Reset);
        }

        let mut file = std::fs::File::open(&self.path)?;

        // 長さが同じでも中身が入れ替わることがあるので、先頭の指紋も見る。
        // 見るのは「既に読み終えた範囲」の先頭だけ。追記では変わらない部分なので、
        // 正常な追記を巻き戻りと取り違えない
        if let Some(previous) = self.head {
            if read_head(&mut file, self.head_len())? != previous {
                self.rewind();
                return Ok(Outcome::Reset);
            }
        }

        file.seek(SeekFrom::Start(self.offset))?;
        let mut buffer = vec![0u8; MAX_CHUNK.min((metadata.len() - self.offset) as usize)];
        let read = file.read(&mut buffer)?;
        buffer.truncate(read);

        let mut lines = Vec::new();
        let mut consumed = 0usize;
        for chunk in buffer.split_inclusive(|byte| *byte == b'\n') {
            if !chunk.ends_with(b"\n") {
                // 改行で終わっていない末尾は「まだ書き終わっていない行」。
                // 読まずに残し、オフセットも進めない
                break;
            }
            let start = self.offset + consumed as u64;
            consumed += chunk.len();
            let text = String::from_utf8_lossy(&chunk[..chunk.len() - 1])
                .trim_end_matches('\r')
                .to_string();
            if !text.is_empty() {
                lines.push((start, text));
            }
        }

        // 1行が上限を超えている（改行が来ない）。諦めて読み飛ばさないと、
        // 同じ場所を永久に読み直し続ける
        if consumed == 0 && buffer.len() >= MAX_LINE {
            consumed = buffer.len();
            lines.push((self.offset, String::from("{\"__oversized_line\":true}")));
        }

        self.offset += consumed as u64;
        if self.offset > 0 {
            self.head = Some(read_head(&mut file, self.head_len())?);
        }
        Ok(Outcome::Lines {
            lines,
            next_offset: self.offset,
        })
    }

    /// 指紋を取る範囲。読み終えた範囲を超えない
    fn head_len(&self) -> u64 {
        self.offset.min(HEAD_BYTES)
    }

    fn rewind(&mut self) {
        self.offset = 0;
        self.head = None;
    }
}

fn read_head(file: &mut std::fs::File, len: u64) -> io::Result<u64> {
    file.seek(SeekFrom::Start(0))?;
    let mut head = vec![0u8; len as usize];
    let read = file.read(&mut head)?;
    Ok(fingerprint(&head[..read]))
}

/// FNV-1a。暗号用途ではなく「変わったか」を見るだけなので、これで足りる。
fn fingerprint(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// その通知が「見に行く理由」になるかを判定する。
///
/// # 落とすのは2種だけ
///
/// | 通知 | 通すか | なぜ |
/// |---|---|---|
/// | `need_rescan()` が立っている | **通す** | 取りこぼしたかもしれないという合図。**種別より先に見る** |
/// | `Access(_)` | 通さない | `IN_OPEN`。**パーサ自身の読み取りで上がる**。輪の発生源 |
/// | `Modify(Metadata(_))` | 通さない | `IN_ATTRIB`。`strictatime` の環境では読むたびに上がる |
/// | それ以外 | 通す | 中身が増えた・現れた・消えた・名前が変わった |
///
/// 知らない種別（`Any` / `Other`）は**通す側へ倒す**。判断が付かないものを落とすと、
/// 見立てが外れたときに静かに届かなくなる。
///
/// # これは効率の改善であって、安全性の担保ではない
///
/// 選別が失敗しても、合図は1枚の旗に畳まれるので嵩は増えない（`cli.rs` の `Signal`）。
/// そして正しさを担保しているのは 500ms の巡回であって、見張りは反応を速くするためだけに
/// 在る（初期実装§8）。したがって通知を減らしても、**遅くなることはあっても届かなくなることはない**。
fn worth_polling(event: &notify::Event) -> bool {
    // 取りこぼしの合図は、種別によらず通す（保険を二重に効かなくしない）
    if event.need_rescan() {
        return true;
    }
    !matches!(
        event.kind,
        EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_))
    )
}

/// ディレクトリの変更を知らせる見張り。
///
/// **ファイル単体ではなくディレクトリを見る。**監視を始める時点でファイルが存在しない
/// ことが普通にあり、存在しないパスは watch できないため。
pub struct DirWatcher {
    watcher: RecommendedWatcher,
    watching: Vec<PathBuf>,
}

impl DirWatcher {
    /// 見に行く価値のある変更があったときだけ `on_change` を呼ぶ見張りを作る。
    ///
    /// 何が変わったかは伝えない。受け手は「とにかく見に行く」だけでよく、
    /// イベントの種別に依存しないぶん取りこぼしに強い。**種別を見るのはここまで**で、
    /// 判断（`worth_polling`）を内側に置いてあるぶん、呼び出し側が選別を書き忘れる余地が無い。
    ///
    /// # 中継しない
    ///
    /// 以前はここから `Sender<()>` へ流し、別のスレッドが受けて合図へ載せ替えていた。
    /// 2段になっているぶん、1件の通知が必ず1件の合図になる。クロージャを直に呼べば
    /// **スレッドが1本、チャネルが1本消える**。呼ぶのは旗の操作と `send` だけで、
    /// どちらも待たない操作なので notify のイベント処理を詰まらせない（設計§12-3 で実測）。
    pub fn new(on_change: impl Fn() + Send + 'static) -> notify::Result<Self> {
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if event.is_ok_and(|event| worth_polling(&event)) {
                on_change();
            }
        })?;
        Ok(Self {
            watcher,
            watching: Vec::new(),
        })
    }

    /// ディレクトリを監視対象に加える（既に見ているなら何もしない）。
    pub fn watch(&mut self, dir: &Path) -> notify::Result<()> {
        if self.watching.iter().any(|known| known == dir) {
            return Ok(());
        }
        if !dir.is_dir() {
            // 親ディレクトリすら無い段階。次の巡回でまた試す
            return Ok(());
        }
        self.watcher.watch(dir, RecursiveMode::Recursive)?;
        self.watching.push(dir.to_path_buf());
        Ok(())
    }

    /// いま要る場所だけを見張り続ける。`keep` に無いものを解除する。
    ///
    /// # 引き算で外さない
    ///
    /// 呼び出し側は「外したカードが使っていたディレクトリ」ではなく、**残っている
    /// セッション全部が要求する集合**を渡す。同じフォルダは複数のセッションが共有する
    /// （`~/.claude/projects/<プロジェクト>/` は同じプロジェクトの全セッションで同じ）ので、
    /// 引き算で外すと**別のセッションの見張りまで消える**。
    ///
    /// # 解除できなくても一覧からは必ず落とす
    ///
    /// 落とし忘れると [`watch`](Self::watch) の冪等な早期 return に引っかかり、
    /// **同じディレクトリを二度と張り直せなくなる**。エラーも出ないので、
    /// 「そのセッションだけ構造化ビューが更新されない」という形でしか表に出ない。
    pub fn retain(&mut self, keep: &HashSet<PathBuf>) {
        let mut kept = Vec::with_capacity(self.watching.len());
        for dir in std::mem::take(&mut self.watching) {
            if keep.contains(&dir) {
                kept.push(dir);
            } else {
                // 既に消えたディレクトリなどで失敗する。次の登録は冪等なので
                // 取りこぼしても実害が無い（設計§4）
                let _ = self.watcher.unwatch(&dir);
            }
        }
        self.watching = kept;
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use std::io::Write;
    use std::time::Duration;

    /// 見張りが落ち着くまでの猶予。**判定の待ちより短くする**（短いほうで待って
    /// 静まったものが、長いほうで蘇ることはない）。
    const QUIET: Duration = Duration::from_millis(300);
    /// 合図を待つ上限。
    const WAIT: Duration = Duration::from_millis(1500);

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("transcript-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    /// 見張りを張る使い捨てのディレクトリ。走るたびに作り直す。
    fn watch_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("transcript-watch-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 監視を張った直後に来るぶんを捨て、静まるまで待つ。
    fn 静まるまで待つ(rx: &std::sync::mpsc::Receiver<()>) {
        while rx.recv_timeout(QUIET).is_ok() {}
    }

    fn append(path: &Path, text: &str) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    fn lines(outcome: Outcome) -> Vec<String> {
        match outcome {
            Outcome::Lines { lines, .. } => lines.into_iter().map(|(_, text)| text).collect(),
            other => panic!("Lines ではない: {other:?}"),
        }
    }

    #[test]
    fn ファイルが無くてもエラーにならない() {
        // フックが運んでくる transcript_path は、その時点ではまだ存在しない
        let mut tail = FileTail::new(temp_path("居ない.jsonl"), 0);
        assert_eq!(tail.read().unwrap(), Outcome::Missing);
        assert_eq!(tail.offset(), 0);
    }

    #[test]
    fn 追記した分だけを読む() {
        let path = temp_path("追記.jsonl");
        let _ = std::fs::remove_file(&path);
        append(&path, "{\"a\":1}\n");

        let mut tail = FileTail::new(&path, 0);
        assert_eq!(lines(tail.read().unwrap()), vec!["{\"a\":1}"]);
        // 2回目は何も増えていない
        assert_eq!(lines(tail.read().unwrap()), Vec::<String>::new());

        append(&path, "{\"b\":2}\n");
        assert_eq!(lines(tail.read().unwrap()), vec!["{\"b\":2}"]);
    }

    #[test]
    fn 書きかけの行は完成するまで読まない() {
        // ここが崩れると、1レコードが壊れた2件になって二重に届く
        let path = temp_path("書きかけ.jsonl");
        let _ = std::fs::remove_file(&path);
        append(&path, "{\"完\":1}\n{\"未\"");

        let mut tail = FileTail::new(&path, 0);
        assert_eq!(lines(tail.read().unwrap()), vec!["{\"完\":1}"]);
        let after_first = tail.offset();

        append(&path, ":2}\n");
        assert_eq!(lines(tail.read().unwrap()), vec!["{\"未\":2}"]);
        assert!(tail.offset() > after_first);
    }

    #[test]
    fn 縮んだら巻き戻りとして知らせる() {
        let path = temp_path("縮む.jsonl");
        let _ = std::fs::remove_file(&path);
        append(&path, "{\"a\":1}\n{\"b\":2}\n");

        let mut tail = FileTail::new(&path, 0);
        assert_eq!(lines(tail.read().unwrap()).len(), 2);

        std::fs::write(&path, "{\"a\":1}\n").unwrap();
        assert_eq!(tail.read().unwrap(), Outcome::Reset);
        assert_eq!(tail.offset(), 0, "先頭から読み直せる状態になる");
        assert_eq!(lines(tail.read().unwrap()), vec!["{\"a\":1}"]);
    }

    #[test]
    fn 長さが同じでも中身が入れ替わったら巻き戻りとする() {
        let path = temp_path("入替.jsonl");
        std::fs::write(&path, "{\"a\":1}\n").unwrap();

        let mut tail = FileTail::new(&path, 0);
        assert_eq!(lines(tail.read().unwrap()), vec!["{\"a\":1}"]);

        std::fs::write(&path, "{\"z\":9}\n").unwrap();
        assert_eq!(tail.read().unwrap(), Outcome::Reset);
    }

    #[test]
    fn 途中のオフセットから再開できる() {
        let path = temp_path("再開.jsonl");
        std::fs::write(&path, "{\"a\":1}\n{\"b\":2}\n").unwrap();

        let mut first = FileTail::new(&path, 0);
        let Outcome::Lines { lines: read, .. } = first.read().unwrap() else {
            panic!("Lines ではない");
        };
        let second_start = read[1].0;

        // 2行目の開始位置から始めれば、2行目だけが読める（欠落も重複もしない）
        let mut resumed = FileTail::new(&path, second_start);
        assert_eq!(lines(resumed.read().unwrap()), vec!["{\"b\":2}"]);
    }

    #[test]
    fn 空行は読み飛ばす() {
        let path = temp_path("空行.jsonl");
        std::fs::write(&path, "{\"a\":1}\n\n{\"b\":2}\n").unwrap();
        let mut tail = FileTail::new(&path, 0);
        assert_eq!(lines(tail.read().unwrap()), vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    /// 通知の選別（設計§3）。純関数なので、実際の見張りを作らずに当てられる。
    ///
    /// 種別の写り方はフェーズ0 で `notify` 8.2.0 の実物のソースから採ってある（設計§12-1）。
    mod 通知の選別 {
        use super::*;
        use notify::event::{
            AccessKind, AccessMode, CreateKind, DataChange, Flag, MetadataKind, RemoveKind,
            RenameMode,
        };

        fn 判定(kind: EventKind) -> bool {
            worth_polling(&notify::Event::new(kind))
        }

        #[test]
        fn 自分の読み取りで上がる開くは通さない() {
            // ここが輪の発生源。パーサが poll で開くたびに IN_OPEN が上がり、
            // その通知でまた poll が呼ばれていた
            assert!(!判定(
                EventKind::Access(AccessKind::Open(AccessMode::Any))
            ));
        }

        #[test]
        fn 閉じるも通さない() {
            // IN_CLOSE_WRITE も Access へ写るので落ちる側。書き込みの合図を
            // これに頼ってはいけない——fd を開いたままの書き手では上がらない。
            // 実際の書き込みには必ず IN_MODIFY が伴う（設計§12-1）
            assert!(!判定(EventKind::Access(AccessKind::Close(
                AccessMode::Write
            ))));
            assert!(!判定(EventKind::Access(AccessKind::Close(
                AccessMode::Read
            ))));
        }

        #[test]
        fn メタデータだけの変更は通さない() {
            // strictatime の環境では、読むたびに IN_ATTRIB が上がる。
            // パーサが見ているのは中身の増加だけなので、時刻や権限は関係が無い
            assert!(!判定(EventKind::Modify(ModifyKind::Metadata(
                MetadataKind::Any
            ))));
            assert!(!判定(EventKind::Modify(ModifyKind::Metadata(
                MetadataKind::AccessTime
            ))));
        }

        #[test]
        fn 中身が増えたら通す() {
            assert!(判定(EventKind::Modify(ModifyKind::Data(DataChange::Any))));
            assert!(判定(EventKind::Modify(ModifyKind::Data(
                DataChange::Content
            ))));
        }

        #[test]
        fn 作成と削除は通す() {
            assert!(判定(EventKind::Create(CreateKind::File)));
            assert!(判定(EventKind::Remove(RemoveKind::File)));
            // 名前が変わるのも、見に行くべき変化
            assert!(判定(EventKind::Modify(ModifyKind::Name(RenameMode::Any))));
        }

        #[test]
        fn 取りこぼしの合図は種別によらず通す() {
            // **落とす種別に付いていても通ること**を見る。ここが効かないと、
            // 溢れて取りこぼしたことを知らせる唯一の合図を捨てることになる
            let 溢れた = notify::Event::new(EventKind::Access(AccessKind::Open(AccessMode::Any)))
                .set_flag(Flag::Rescan);
            assert!(溢れた.need_rescan(), "前提：印が立っていること");
            assert!(worth_polling(&溢れた));
        }

        #[test]
        fn 知らない種別は通す() {
            // 判断が付かないものは通す側へ倒す。落とすと、見立てが外れたときに
            // 静かに届かなくなる
            assert!(判定(EventKind::Any));
            assert!(判定(EventKind::Other));
            assert!(判定(EventKind::Modify(ModifyKind::Any)));
            assert!(判定(EventKind::Modify(ModifyKind::Other)));
        }
    }

    /// 読む行為が次の読む理由を作る輪が、閉じていること。
    ///
    /// この2本は**対で意味を持つ**。「合図が来ない」だけでは、輪が閉じたのか
    /// 見張りがそもそも動いていないのかを区別できない。
    mod 輪が閉じていること {
        use super::*;
        use std::sync::mpsc;

        #[test]
        fn 監視下のファイルを繰り返し読んでも合図は来ない() {
            // 巡回が毎回やっていること（開いて読む）を、そのまま繰り返す。
            // ここで合図が返ってくると、その合図でまた読むことになり輪が回る
            let dir = watch_dir("read");
            let path = dir.join("session.jsonl");
            std::fs::write(&path, "{\"a\":1}\n").unwrap();

            let (tx, rx) = mpsc::channel();
            let mut watcher = DirWatcher::new(move || {
                let _ = tx.send(());
            })
            .expect("見張りを作れること");
            watcher.watch(&dir).expect("監視を張れること");
            静まるまで待つ(&rx);

            let mut tail = FileTail::new(&path, 0);
            for _ in 0..20 {
                tail.read().expect("読めること");
            }

            assert!(
                rx.recv_timeout(WAIT).is_err(),
                "読むだけでは合図が来ないこと。来るなら、その合図でまた読む輪になっている"
            );
        }

        #[test]
        fn 追記すれば合図が来る() {
            // 上の否定側だけでは「見張りが動いていない」と区別が付かない。
            // 肯定側をここで裏取りする
            let dir = watch_dir("append");
            let path = dir.join("session.jsonl");
            std::fs::write(&path, "{\"a\":1}\n").unwrap();

            let (tx, rx) = mpsc::channel();
            let mut watcher = DirWatcher::new(move || {
                let _ = tx.send(());
            })
            .expect("見張りを作れること");
            watcher.watch(&dir).expect("監視を張れること");
            静まるまで待つ(&rx);

            append(&path, "{\"b\":2}\n");

            assert!(
                rx.recv_timeout(WAIT).is_ok(),
                "中身が増えたら合図が来ること"
            );
        }
    }

    /// 要らなくなった見張りを外せること（設計§4）。
    ///
    /// 待ち方の道具（`WAIT` / `静まるまで待つ`）は輪の検査と共有する。**新しい待ち方を
    /// 作らない**——2通りあると、落ちたときにどちらの都合かを切り分けることになる。
    mod 監視の解除 {
        use super::*;
        use std::sync::mpsc;

        /// 2つのディレクトリを張り、合図が1本の口へ集まる見張りを作る。
        fn 二箇所を張る(label: &str) -> (DirWatcher, mpsc::Receiver<()>, PathBuf, PathBuf) {
            let 残す = watch_dir(&format!("{label}-keep"));
            let 外す = watch_dir(&format!("{label}-drop"));
            std::fs::write(残す.join("session.jsonl"), "{\"a\":1}\n").unwrap();
            std::fs::write(外す.join("session.jsonl"), "{\"a\":1}\n").unwrap();

            let (tx, rx) = mpsc::channel();
            let mut watcher = DirWatcher::new(move || {
                let _ = tx.send(());
            })
            .expect("見張りを作れること");
            watcher.watch(&残す).expect("監視を張れること");
            watcher.watch(&外す).expect("監視を張れること");
            静まるまで待つ(&rx);
            (watcher, rx, 残す, 外す)
        }

        #[test]
        fn 集合に無いものだけが外れる() {
            // **2つの主張を1本に入れてある。** どちらも同じ `retain` 呼び出しに
            // ついての事実で、「外したほうが黙る」だけでは見張りごと壊れた場合と
            // 区別が付かない。残したほうが同じ呼び出しの後に鳴って初めて、
            // 「外したほうだけが外れた」と言える
            let (mut watcher, rx, 残す, 外す) = 二箇所を張る("retain");

            watcher.retain(&HashSet::from([残す.clone()]));

            append(&外す.join("session.jsonl"), "{\"b\":2}\n");
            assert!(
                rx.recv_timeout(WAIT).is_err(),
                "どのセッションも使っていないディレクトリは、追記しても合図が来ないこと"
            );

            append(&残す.join("session.jsonl"), "{\"b\":2}\n");
            assert!(
                rx.recv_timeout(WAIT).is_ok(),
                "使っているディレクトリの見張りは残っていること"
            );
        }

        #[test]
        fn 外したディレクトリは張り直せる() {
            // 解除したのに内部の一覧へ残していると、`watch` の冪等な早期 return に
            // 引っかかって**二度と張り直せない**。エラーが出ないので、
            // 「そのセッションだけ更新されない」という形でしか表に出ない
            let (mut watcher, rx, 残す, 外す) = 二箇所を張る("rewatch");
            watcher.retain(&HashSet::from([残す]));

            watcher.watch(&外す).expect("張り直せること");
            静まるまで待つ(&rx);

            append(&外す.join("session.jsonl"), "{\"c\":3}\n");
            assert!(
                rx.recv_timeout(WAIT).is_ok(),
                "一度外したディレクトリでも、張り直せば合図が来ること"
            );
        }
    }
}
