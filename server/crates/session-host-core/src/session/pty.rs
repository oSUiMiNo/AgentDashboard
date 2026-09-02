//! 擬似端末（PTY）1本の生成と入出力（設計§6）。
//!
//! portable-pty の使い方には守らないと壊れる作法がいくつかあり、設計§6/§14 で実装規約として
//! 明文化されている。フェーズ0の `testkit/tests/pty_smoke.rs` で実際に成立することを確認済み。
//!
//! - 読み取りは**ブロッキング**なので、PTY ごとに専用の OS スレッドを立てる
//!   （`spawn_blocking` の共有プールを使うと、PTY が増えたときにプールを食い潰す）
//! - `Child::wait()` も**別スレッド**で待つ（読み書きを止めないため）
//! - PTY を開いた直後に `slave` を落とす（子プロセスだけが slave を握っている状態にすると、
//!   子が終わったときに master 側の読み取りが確実に終わる）
//! - `take_writer()` は一度しか呼べないので、取得したら保持して使い回す
//!
//! # フロー制御の考え方
//!
//! ブラウザの描画が追いつかないとき、サーバは**読み取りそのものを止める**（[`FlowGate`]）。
//! 読まなければ OS の PTY バッファに溜まり、溜まりきると CLI 側の `write` がブロックされる。
//! つまりブラウザの遅さが CLI まで伝わって自然に減速する。バイトを捨てないのが要点で、
//! 途中を捨てると端末の制御シーケンスが割れて表示が崩れてしまう。

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    io::{Read as _, Write as _},
    sync::{Arc, Condvar, Mutex},
    thread,
};
use tokio::sync::{mpsc, oneshot};

/// PTY から1回で読み取る最大バイト数。
const READ_CHUNK: usize = 64 * 1024;

/// 子プロセスの終了。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtyExit {
    pub ok: bool,
    pub code: u32,
}

#[derive(Debug, Default)]
struct GateState {
    paused: bool,
    /// PTY を畳んだ。待っているスレッドを起こして終了させるための印
    closed: bool,
}

/// 読み取りスレッドを一時停止させるための門。
///
/// tokio の非同期プリミティブではなく `Condvar` を使っているのは、待つ相手が
/// 非同期タスクではなくブロッキングの OS スレッドだから。
#[derive(Debug, Default)]
pub struct FlowGate {
    state: Mutex<GateState>,
    changed: Condvar,
}

impl FlowGate {
    /// 停止中なら解除されるまで待つ。戻り値が `false` なら畳まれたので終了してよい。
    fn wait_while_paused(&self) -> bool {
        let mut state = self.state.lock().expect("ロックが壊れていない");
        while state.paused && !state.closed {
            state = self.changed.wait(state).expect("ロックが壊れていない");
        }
        !state.closed
    }

    pub fn set_paused(&self, paused: bool) {
        let mut state = self.state.lock().expect("ロックが壊れていない");
        if state.paused == paused {
            return;
        }
        state.paused = paused;
        drop(state);
        // 解除だけでなく設定時も起こす。待っているスレッドが「畳まれた」を取りこぼさないため
        self.changed.notify_all();
    }

    pub fn is_paused(&self) -> bool {
        self.state.lock().expect("ロックが壊れていない").paused
    }

    fn close(&self) {
        let mut state = self.state.lock().expect("ロックが壊れていない");
        state.closed = true;
        drop(state);
        self.changed.notify_all();
    }
}

/// master と writer をまとめて1つのロックで守る。
///
/// `Box<dyn MasterPty + Send>` は `Sync` ではないため、複数の非同期タスクから触るには
/// ロックで包む必要がある。リサイズも書き込みも短時間で終わるので競合の影響は小さい。
struct PtyInner {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn std::io::Write + Send>,
}

/// 起動中の PTY プロセス1本。
pub struct PtyProcess {
    inner: Mutex<PtyInner>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    gate: Arc<FlowGate>,
}

impl std::fmt::Debug for PtyProcess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PtyProcess")
            .field("paused", &self.gate.is_paused())
            .finish_non_exhaustive()
    }
}

impl PtyProcess {
    /// PTY を開いてコマンドを起動する。
    ///
    /// 読み取ったバイトは `output` へ流れる。`output` が詰まると読み取りスレッドが待つので、
    /// ここでも自然に背圧がかかる（フロー制御の二重の担保）。
    /// 戻り値の受信側には、子プロセスが終了したときに終了状態が1回だけ届く。
    pub fn spawn(
        command: CommandBuilder,
        size: PtySize,
        output: mpsc::Sender<Vec<u8>>,
    ) -> anyhow::Result<(Self, oneshot::Receiver<PtyExit>)> {
        let pair = native_pty_system().openpty(size)?;
        let child = pair.slave.spawn_command(command)?;
        let killer = child.clone_killer();

        // **ここで失敗したときに `?` で返ってはいけない。** 子は既に居るのに、待ちスレッドは
        // まだ立っていない。捨てるだけだと誰も終了状態を引き取らず、ゾンビになる
        // （ゾンビ設計§1-5・§6-2）
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => return Err(abandon(child, error)),
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => return Err(abandon(child, error)),
        };

        // 子プロセスだけが slave を握る状態にする。こうしておくと、子が終わった時点で
        // master 側の読み取りが必ず終わり、読み取りスレッドが残らない。
        drop(pair.slave);

        let gate = Arc::new(FlowGate::default());

        let reader_gate = Arc::clone(&gate);
        thread::spawn(move || read_loop(reader, reader_gate, output));

        let (exit_tx, exit_rx) = oneshot::channel();
        thread::spawn(move || {
            let mut child = child;
            let status = child.wait();
            let exit = match status {
                Ok(status) => PtyExit {
                    ok: status.success(),
                    code: status.exit_code(),
                },
                // 終了状態を取れなかった場合も「異常終了」として伝える。黙って消えると
                // カードが「起動中」のまま残り、ハングと見分けがつかなくなる
                Err(_) => PtyExit { ok: false, code: 1 },
            };
            let _ = exit_tx.send(exit);
        });

        Ok((
            Self {
                inner: Mutex::new(PtyInner {
                    master: pair.master,
                    writer,
                }),
                killer: Mutex::new(killer),
                gate,
            },
            exit_rx,
        ))
    }

    /// 端末へ入力を書き込む。
    pub fn write_input(&self, bytes: &[u8]) -> anyhow::Result<()> {
        let mut inner = self.inner.lock().expect("ロックが壊れていない");
        inner.writer.write_all(bytes)?;
        inner.writer.flush()?;
        Ok(())
    }

    /// 端末の大きさを変える。
    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        let inner = self.inner.lock().expect("ロックが壊れていない");
        inner.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// 読み取りを止める／再開する（設計§10 のフロー制御）。
    pub fn set_paused(&self, paused: bool) {
        self.gate.set_paused(paused);
    }

    pub fn is_paused(&self) -> bool {
        self.gate.is_paused()
    }

    /// 子プロセスを終了させる。終了の検知は `spawn` が返した受信側に届く。
    pub fn kill(&self) {
        // 止まっている読み取りスレッドを起こしてから殺す。逆順だと、停止中のセッションを
        // kill したときに読み取りスレッドが待ったまま残る
        self.gate.set_paused(false);
        let _ = self.killer.lock().expect("ロックが壊れていない").kill();
    }
}

/// 起こしたばかりの子を、待ちスレッドを立てる前に畳む。
///
/// **落とすだけでは引き取られない。** Rust の子プロセスは `Drop` で `wait` しないので、
/// ここを通さずに返ると、その子は終了状態を引き取られないまま残る。`proc::run` が
/// 打ち切るときに `kill` → `wait` の両方をやっているのと同じ形に揃えてある。
fn abandon(mut child: Box<dyn Child + Send + Sync>, error: anyhow::Error) -> anyhow::Error {
    let mut killer = child.clone_killer();
    // 既に終わっていれば空振りするが、それは目的が達成されている姿である
    let _ = killer.kill();
    // **殺したあとに必ず待つ。** ここを抜くと、塞いだつもりで塞げていない
    let _ = child.wait();
    error
}

impl Drop for PtyProcess {
    fn drop(&mut self) {
        // 取りこぼすと子プロセスとスレッドが残るので、畳むときは必ず両方やる
        self.gate.close();
        let _ = self.killer.lock().expect("ロックが壊れていない").kill();
    }
}

/// PTY 専用の読み取りスレッド本体。
fn read_loop(
    mut reader: Box<dyn std::io::Read + Send>,
    gate: Arc<FlowGate>,
    output: mpsc::Sender<Vec<u8>>,
) {
    let mut buffer = vec![0u8; READ_CHUNK];
    loop {
        // 停止中はそもそも読まない。読まないことが OS バッファ経由で CLI への背圧になる
        if !gate.wait_while_paused() {
            break;
        }
        match reader.read(&mut buffer) {
            // 子プロセスが終わると EOF もしくは EIO になる。どちらも「もう読むものは無い」
            Ok(0) | Err(_) => break,
            Ok(size) => {
                if output.blocking_send(buffer[..size].to_vec()).is_err() {
                    // 受け手が畳まれた＝このセッションはもう配信されない
                    break;
                }
            }
        }
    }
}
