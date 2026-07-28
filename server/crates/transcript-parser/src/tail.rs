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

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::io::{self, Read as _, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;

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

/// ディレクトリの変更を知らせる見張り。
///
/// **ファイル単体ではなくディレクトリを見る。**監視を始める時点でファイルが存在しない
/// ことが普通にあり、存在しないパスは watch できないため。
pub struct DirWatcher {
    watcher: RecommendedWatcher,
    watching: Vec<PathBuf>,
}

impl DirWatcher {
    /// 変更があったら `notify` へ空メッセージを送る見張りを作る。
    ///
    /// 何が変わったかは伝えない。受け手は「とにかく見に行く」だけでよく、
    /// イベントの種別に依存しないぶん取りこぼしに強い。
    pub fn new(notify: Sender<()>) -> notify::Result<Self> {
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if event.is_ok() {
                let _ = notify.send(());
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
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use std::io::Write;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("transcript-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
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
}
