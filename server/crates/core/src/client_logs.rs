//! ブラウザのログの受け口と、書き出し口を繋ぐ（設計§12）。
//!
//! **ここにしか置けない。** 受け口は `server-core`（鍵の外側の REST）、書き出しの土台は
//! `session-host-core`（7欄の整形と appender）にあり、**前者は後者に依存できない**
//! （`tests/dependencies.rs` が `server-core` から `portable-pty` / `vt100` へ辿れない
//! ことを推移的に検査している）。両方を知っているのはこのクレートだけなので、
//! 境界 trait の実体をここへ置く。
//!
//! `local::LocalSessionHost` が `server_core::session_host::SessionHost` の実体を
//! 持っているのとまったく同じ形である。

use std::sync::Arc;

use protocol::client_log::{ClientLogDrops, ClientLogEntry};
use server_core::client_logs::ClientLogSink;
use session_host_core::{config::SessionHostConfig, logging};

/// 受け取った行を `<state_dir>/logs/browser*.jsonl` へ落とす。
pub struct LoggingSink {
    log: logging::ClientLog,
}

impl LoggingSink {
    /// 書き出し口を開く。**開けなくてもサーバは動く**（ブラウザのぶんが残らないだけ）。
    pub fn open(config: &SessionHostConfig) -> Arc<dyn ClientLogSink> {
        Arc::new(LoggingSink {
            log: logging::ClientLog::open(config),
        })
    }
}

impl ClientLogSink for LoggingSink {
    fn write(&self, anon: bool, entries: &[ClientLogEntry], drops: ClientLogDrops) {
        self.log.write(anon, entries, drops);
    }
}
