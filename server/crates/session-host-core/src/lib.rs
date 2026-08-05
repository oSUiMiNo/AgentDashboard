//! PC 側（セッションホスト）のロジック一式（セルフホスト化設計§2-1）。
//!
//! セッションの起動と管理（[`session`]）、フックの受信（[`hooks`]）、状態の導出
//! （[`state`]）、トランスクリプトのパース（[`parser`]）、自己修復（[`selfheal`]）
//! ——つまり**利用者の PC にあるもの**（本物の CLI・PTY・`~/.claude`・プロジェクトの
//! ファイル）に触る仕事は、すべてこちら側にある。
//!
//! # なぜ crate を分けるのか
//!
//! セルフホストモードでは、この一式が利用者の PC で動き、ダッシュボードサーバは別の
//! マシンで動く（設計§1-1）。分け方を feature flag ではなく **crate 境界**にしたのは、
//! 「サーバ側が PTY に触る」ような依存の逆流を**コンパイラに止めさせる**ため。
//! 境界が守られていることは `crates/core/tests/dependencies.rs` が機械で検査する。
//!
//! # サーバ側との繋ぎ方
//!
//! ブラウザへ配信するのはサーバ側（`server-core`）の仕事で、こちらはそこを知らない。
//! ローカルモードでは両者を [`agentdashboard_core`] が同じプロセスで束ね、
//! セルフホストモードでは同じ境界の向こうが A2S 越しのサーバに変わる（フェーズ3）。

pub mod claude_settings;
pub mod config;
pub mod events;
pub mod hook_post;
pub mod hooks;
pub mod hostfs;
pub mod jsonfile;
pub mod link;
pub mod model_aliases;
pub mod model_catalog;
pub mod model_post;
pub mod offsets;
pub mod parser;
pub mod proc;
pub mod selfheal;
pub mod session;
pub mod settings;
pub mod state;
pub mod version;
pub mod version_ops;
