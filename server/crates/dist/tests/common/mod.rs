//! 配布まわりのテストが共有するもの。
//!
//! # なぜ1箇所へ寄せるのか
//!
//! `repo_root()` と「配る実行ファイルの顔ぶれ」は、3つのテストファイルへ
//! コピーで散らばっていた。**顔ぶれのほうが厄介**で、片方だけ増減しても
//! コンパイルは通り、どの門も見ていない——「同じ顔ぶれ」というコメントだけが
//! 根拠という状態だった。
//!
//! ここへ寄せると、食い違いようが無くなる。
//!
//! # 偽の HOME はガード型で持つ
//!
//! 消す道の検査は、**偽のインストール一式を作って実際に走らせる**。作った側が
//! 片付ける形にしていると、assert が落ちたときに panic で飛ばされて残る。
//! [`FakeHome`] は Drop で畳むので、**失敗しても散らからない**。
//! 落ちたときだけは、調べられるように場所を印字してから消す。

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

/// 配る実行ファイル。**増減させたらここだけ直す。**
///
/// `dist plan` の中身（アーカイブに入っているか）と、消す道（消す対象）の
/// 両方がこれを見る。
pub const BINARIES: &[&str] = &[
    "agentdashboard",
    "agentdashboard-agent",
    "transcript-parser",
];

/// リポジトリのルート。
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crates/dist から3つ上がリポジトリのルート")
        .to_path_buf()
}

/// 偽の HOME。**Drop で畳む。**
pub struct FakeHome {
    path: PathBuf,
}

impl FakeHome {
    /// `label` ごとに別の場所を使う。同じプロセスで2つ作っても取り合わない。
    pub fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "agentdashboard-uninstall-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn join(&self, part: &str) -> PathBuf {
        self.path.join(part)
    }

    /// この HOME 専用の一時領域（消す道へ `TMPDIR` として渡す）。
    ///
    /// 古い置き場所は `${TMPDIR:-/tmp}/agentdashboard` で、**機械に1つしかない実在の
    /// 場所**である。素通しにすると、`--purge` を実際に走らせる検査が開発機のそこを
    /// 消してしまい、同じ場所を前提にしている別の検査と並行したときに片方が落ちる。
    pub fn legacy_tmp(&self) -> PathBuf {
        let path = self.path.join("tmp");
        let _ = std::fs::create_dir_all(&path);
        path
    }

    /// 実装の既定を、この HOME のもとで求める。
    ///
    /// **写しを作らない。** 「実装がどこを既定にしているか」を確かめるのが検査の
    /// 中身なので、値をこちらで組み立てると門が門でなくなる。
    ///
    /// 環境変数はプロセス全体のものなので、**1本の錠で直列化し、必ず元へ戻す**。
    /// nextest はテストごとに別プロセスなので普段は競合しないが、`cargo test` を
    /// 直に叩くと同じプロセスで並ぶ（`std::env::temp_dir()` を読む側と衝突する）。
    pub fn resolved_state_dir(&self) -> PathBuf {
        let _lock = env_lock();
        let saved_home = std::env::var_os("HOME");
        let saved_xdg = std::env::var_os("XDG_STATE_HOME");

        // SAFETY: 錠の中で書き、この関数を出る前に必ず戻す
        unsafe {
            std::env::remove_var("XDG_STATE_HOME");
            std::env::set_var("HOME", &self.path);
        }
        let resolved = agentdashboard_core::config::Config::default()
            .agent()
            .resolved_state_dir();
        unsafe {
            match saved_home {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
            if let Some(value) = saved_xdg {
                std::env::set_var("XDG_STATE_HOME", value);
            }
        }
        resolved
    }
}

impl Drop for FakeHome {
    fn drop(&mut self) {
        // 落ちたときは**消す前に場所を出す**。現場が黙って消えると、次の調査が困る
        if std::thread::panicking() {
            eprintln!(
                "偽の HOME を片付けます（調べるならこの場所）: {}",
                self.path.display()
            );
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 環境変数の書き換えを直列化する錠。
fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
