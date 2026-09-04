//! JSONL トランスクリプトを正規化イベントモデル（[`protocol::TreeNode`]）へ変換する。
//!
//! **このクレートは自己修復機構（設計§9）が唯一書き換えてよい範囲**。core と protocol には
//! 触れさせないことで、フォーマット変更への自動対応の爆発半径を物理的に限定している。
//! 未知の構造に出会ったら必ず [`protocol::Node::Unknown`] へ写像し、共有境界である
//! protocol クレートの変更を要求しないこと。
//!
//! # 依存を増やさない
//!
//! ここは修復エージェントが書き換える場所なので、依存が少ないほど直しやすく、
//! ビルドも速い（修復中のビルド時間は利用者の待ち時間そのものになる）。
//! 非同期ランタイムは入れていない。やることは「ファイルを読む」「stdin/stdout」だけで、
//! tokio が解く問題がここには無い。

pub mod cli;
pub mod origin;
pub mod normalize;
pub mod parse;
pub mod session;
pub mod stats;
pub mod tail;
pub mod thread;
