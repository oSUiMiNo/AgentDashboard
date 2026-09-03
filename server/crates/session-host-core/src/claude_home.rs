//! CLI が履歴を置く場所と、そこを1回だけ走査する道（名前付け設計§8-4・§13-1）。
//!
//! # なぜ1つのモジュールに集めるのか
//!
//! `~/.claude/projects` を読む場所が**2つある**——過去のセッションが実在するかの確認と、
//! 自己修復がカナリアの履歴を探すところ。**別々に `$HOME` を読むと、片方だけ偽装できる
//! 状態になってテストが嘘をつく。**
//!
//! # フォルダ名の規則を実装しない
//!
//! 履歴は `~/.claude/projects/<フォルダ>/<セッションID>.jsonl` に置かれるが、
//! **作業ディレクトリのパスからフォルダ名を作る規則は、このリポジトリのどこにも
//! 実装されていない**（CLI 側の内部規則で、公開もされていない）。
//!
//! ここで規則を書き起こすと、**CLI がフォルダ名の作り方を変えた瞬間に黙って壊れる**。
//! しかも壊れ方がいちばん悪い——「実在するのに消えたと判定する」ので、**選択肢から
//! 勝手に消える**。だから規則を持たず、**総なめして実在を見る**。
//!
//! 総なめで足りることは実測済み（設計§13）。開発機は 1,119フォルダ・27,499本の
//! `.jsonl` を持つが、1回の走査は **241ms（初回）／24.5ms（2回目）**で終わる。

use protocol::ClaudeSessionId;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// 走査の回数。**「1回で判定する」という約束を、外から数えられるようにするためだけに在る。**
///
/// 結果だけを見ても、IDごとに走査する実装と1回で済ます実装は**同じ答えを返す**ので
/// 見分けが付かない。違うのは重さだけで、それは時間で測ると機械と負荷に左右される。
/// だから回数そのものを数える。
static SCANS: AtomicU64 = AtomicU64::new(0);

/// これまでに走査した回数（[`SCANS`]）。テストが「1回で判定する」を確かめるのに使う。
pub fn scan_count() -> u64 {
    SCANS.load(Ordering::Relaxed)
}

/// 走査元を差し替える環境変数（設計§13-1）。
///
/// **設定ファイルの欄にしない。** 利用者が触る値ではなく、テストで偽装するためだけの口
/// である。E2E は別プロセスのサーバを起こすので、テストの中で `HOME` を差し替えても
/// 届かない——だから環境変数にしてある。
pub const CLAUDE_HOME_ENV: &str = "AGENTDASHBOARD_CLAUDE_HOME";

/// CLI が履歴を置くフォルダ（`<ホーム>/.claude/projects`）。
///
/// ホームは [`CLAUDE_HOME_ENV`] があればそれ、無ければ `$HOME`。どちらも無ければ `None`。
pub fn projects_dir() -> Option<PathBuf> {
    let home = std::env::var(CLAUDE_HOME_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("HOME").ok())?;
    Some(PathBuf::from(home).join(".claude").join("projects"))
}

/// 渡したIDのうち、**履歴が実在するものだけ**を返す（設計§8-3・§8-4）。
///
/// # 1回の走査で全部を判定する
///
/// IDごとに走査すると、一覧を開くたびに件数ぶんの走査が出る。フォルダを1周して
/// 見つけた `.jsonl` の名前を集め、**集合の交わり**を取る形にしてある。
///
/// # 落ちない
///
/// フォルダが無い機械（claude を一度も起こしていない）でも、読めないフォルダが
/// 混ざっていても、**そこで止まらずに残りを見る**。「読めなかった」を「無い」と
/// 混同しないためで、判定できなかったぶんは呼び出し側が「確かめていない」として扱う。
pub fn existing_sessions(ids: &[ClaudeSessionId]) -> Vec<ClaudeSessionId> {
    if ids.is_empty() {
        return Vec::new();
    }
    let Some(root) = projects_dir() else {
        return Vec::new();
    };
    SCANS.fetch_add(1, Ordering::Relaxed);
    let Ok(projects) = std::fs::read_dir(&root) else {
        // フォルダごと無い＝履歴が1つも無い。落とさずに空を返す
        return Vec::new();
    };

    let mut 実在するファイル名 = HashSet::new();
    for project in projects.flatten() {
        // 読めないフォルダは飛ばして残りを見る
        let Ok(entries) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str()
                && let Some(stem) = name.strip_suffix(".jsonl")
            {
                実在するファイル名.insert(stem.to_string());
            }
        }
    }

    ids.iter()
        .filter(|id| 実在するファイル名.contains(&id.to_string()))
        .copied()
        .collect()
}

/// 1本の履歴を探す。自己修復がカナリアの採取物を拾うのに使う。
///
/// **走査元は [`projects_dir`] に揃えてある。** ここが別に `$HOME` を読むと、
/// 片方だけ偽装できる状態になる。
pub fn find_transcript(session_id: &str) -> Option<PathBuf> {
    let root = projects_dir()?;
    let wanted = format!("{session_id}.jsonl");
    for project in std::fs::read_dir(root).ok()?.flatten() {
        let candidate = project.path().join(&wanted);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
