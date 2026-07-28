//! PTY テストハーネスの動作確認。
//!
//! ここが通らないとフェーズ1以降の PTY 関連テストが一切成立しないため、土台の中でも
//! 最優先の検証にあたる。あわせて設計§6 の portable-pty 実装規約（PTY毎の専用読み取り
//! スレッド／`wait()` は別スレッド／ドロップ順は slave 先行／`take_writer` は一度きり）が
//! 実際に成立することも、この場で確かめている。

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::{
    io::{Read, Write as _},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

const FAKE_CLAUDE: &str = env!("CARGO_BIN_EXE_fake-claude");
const TIMEOUT: Duration = Duration::from_secs(15);

fn default_size() -> PtySize {
    PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// PTY からの出力を専用スレッドで読み続け、蓄積先を返す。
fn spawn_reader(reader: Box<dyn Read + Send>) -> (Arc<Mutex<String>>, thread::JoinHandle<()>) {
    let output = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&output);
    let handle = thread::spawn(move || {
        let mut reader = reader;
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    let text = String::from_utf8_lossy(&chunk[..size]).into_owned();
                    sink.lock().expect("ロックが壊れていない").push_str(&text);
                }
            }
        }
    });
    (output, handle)
}

fn wait_for(output: &Arc<Mutex<String>>, marker: &str) {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        if output
            .lock()
            .expect("ロックが壊れていない")
            .contains(marker)
        {
            return;
        }
        if Instant::now() >= deadline {
            let seen = output.lock().expect("ロックが壊れていない").clone();
            panic!("{TIMEOUT:?} 以内に {marker:?} が現れませんでした。実際の出力:\n{seen}");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// `wait()` を読み書きスレッドとは別のスレッドで待つ（設計§6 の実装規約）。
fn wait_in_dedicated_thread(
    child: Box<dyn portable_pty::Child + Send + Sync>,
) -> portable_pty::ExitStatus {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut child = child;
        let _ = tx.send(child.wait());
    });
    rx.recv_timeout(TIMEOUT)
        .expect("時間内に子プロセスが終了すること")
        .expect("終了ステータスを取得できること")
}

#[test]
fn ptyで擬似claudeを起動し入出力とリサイズと正常終了ができる() {
    let pair = native_pty_system()
        .openpty(default_size())
        .expect("PTY を開けること（コンテナ内で /dev/ptmx が使えること）");

    let child = pair
        .slave
        .spawn_command(CommandBuilder::new(FAKE_CLAUDE))
        .expect("擬似claudeを起動できること");

    // 読み取りはブロッキングなので専用スレッドへ逃がす
    let reader = pair
        .master
        .try_clone_reader()
        .expect("reader を複製できること");
    let (output, reader_thread) = spawn_reader(reader);

    // take_writer は一度しか呼べないので、取得したら保持して使い回す
    let mut writer = pair.master.take_writer().expect("writer を取得できること");

    // EOF を確実に得るため slave はここで落とす
    drop(pair.slave);

    wait_for(&output, "[fake-claude] ready");

    writer.write_all(b"hello\n").expect("PTY へ書き込めること");
    writer.flush().expect("フラッシュできること");
    wait_for(&output, "[fake-claude] received: hello");

    pair.master
        .resize(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("リサイズできること");

    writer.write_all(b"exit\n").expect("PTY へ書き込めること");
    writer.flush().expect("フラッシュできること");

    let status = wait_in_dedicated_thread(child);
    assert!(status.success(), "正常終了すること。実際: {status:?}");

    drop(writer);
    drop(pair.master);
    reader_thread
        .join()
        .expect("リーダースレッドが EOF で終了すること");
}

#[test]
fn 異常終了の終了コードを取得できる() {
    let pair = native_pty_system()
        .openpty(default_size())
        .expect("PTY を開けること");

    let mut cmd = CommandBuilder::new(FAKE_CLAUDE);
    cmd.arg("--exit-code");
    cmd.arg("42");
    let child = pair
        .slave
        .spawn_command(cmd)
        .expect("擬似claudeを起動できること");

    let reader = pair
        .master
        .try_clone_reader()
        .expect("reader を複製できること");
    let (_output, reader_thread) = spawn_reader(reader);
    drop(pair.slave);

    let status = wait_in_dedicated_thread(child);
    assert!(!status.success(), "異常終了として扱われること");
    assert_eq!(status.exit_code(), 42, "終了コードが伝わること");

    drop(pair.master);
    reader_thread
        .join()
        .expect("リーダースレッドが EOF で終了すること");
}
