//! トランスクリプトのパーサの実行ファイル。
//!
//! 中身は `transcript_parser::cli` にある。ここに書き足さないこと——自己修復が
//! 書き換えてよいのはあちらの crate だけ（設計§9）。

fn main() -> anyhow::Result<()> {
    transcript_parser::cli::run()
}
