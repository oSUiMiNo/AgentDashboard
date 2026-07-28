//! transcript-parser プロセスの入口。
//!
//! core とは stdin/stdout の JSON Lines で会話する（設計§8）。別プロセスに分離しているのは、
//! 自己修復でこのバイナリだけを差し替え・再起動できるようにするため。core と生きている PTY には
//! 一切触れずにパーサだけを入れ替えられることが、設計上の要になっている。
//!
//! IPC と tail の実装はフェーズ3（M3）で行う。

fn main() -> anyhow::Result<()> {
    eprintln!(
        "transcript-parser {} — 骨格のみ（フェーズ0）。IPC とパースはフェーズ3で実装します。",
        env!("CARGO_PKG_VERSION")
    );
    Ok(())
}
