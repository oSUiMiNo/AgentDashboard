//! エージェント（PC 側）が使う設定（セルフホスト化設計§13-2）。
//!
//! # ファイルは読まない
//!
//! `config.toml` を読むのは、両側を束ねるローカルモードの実行ファイル
//! （`agentdashboard_core::config::Config`）の仕事で、ここはその**射影**を受け取るだけ。
//! こう分けたのは、フェーズ3 でエージェントが別プロセスになると設定ファイル自体が
//! 別（`agent.toml`）になるため。読む場所を持たないでおけば、その差し替えが
//! ここまで波及しない。
//!
//! # キーの割り当て
//!
//! 「接続と機械に属するもの」のうち、**利用者の PC にあるものを触る**キーがここへ来る
//! （PTY・自己修復・`~/.claude`・状態の置き場所）。ブラウザへの配信に関わるキー
//! （`port` / `flow_*` / `transcript_page_limit`）は `server_core::config::ServerConfig`。

use std::path::{Path, PathBuf};

const DEFAULT_STALLED_THRESHOLD_SECS: u64 = 120;
const DEFAULT_COALESCE_MS: u64 = 8;
const DEFAULT_PTY_RING_BUFFER: usize = 1024 * 1024;
const DEFAULT_CANARY_MODEL: &str = "haiku";
const DEFAULT_CANARY_FALLBACK_MODEL: &str = "sonnet";
const DEFAULT_REPAIR_MODEL: &str = "sonnet";
const DEFAULT_SELFHEAL_RETRY: u32 = 3;
const DEFAULT_SELFHEAL_COOLDOWN_HOURS: u64 = 24;
const DEFAULT_TRANSCRIPT_WINDOW_NODES: usize = 2000;
/// `statusLine` を再実行する間隔（秒）。
///
/// 実測で `refreshInterval: 3` はきっちり3.0秒間隔で走った（設計§11 前提6）。
/// 1秒にするとセッション数だけ毎秒プロセスが起動するので、3秒を既定にしている。
const DEFAULT_STATUS_LINE_REFRESH_SECS: u64 = 3;
/// フックの受信ポートの既定。
///
/// いまはブラウザの待ち受けと同じポートに同居しているので
/// [`server_core::config::ServerConfig`] の既定と同じ値にしてある（一致していることは
/// `agentdashboard_core` 側のテストが見ている）。フェーズ3 でエージェントが別プロセスに
/// なると、ここは独立に決まる（設計§5-3）。
const DEFAULT_HOOK_PORT: u16 = 8787;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentConfig {
    /// Working のままこの秒数イベントが途絶したら Stalled とみなす
    pub stalled_threshold_secs: u64,
    /// PTY 出力をまとめてから送るまでの窓（ミリ秒）
    pub coalesce_ms: u64,
    /// セッションごとの scrollback リングバッファ（バイト）
    pub pty_ring_buffer: usize,
    /// 一覧の起動ボタンを「全承認をスキップ」の1つだけにするか。
    ///
    /// 既定は `false`（3つ出す：全承認をスキップ／編集の承認のみスキップ／指定なし）。
    /// **権限確認を飛ばす機能なので、既定はスキップしない側**に置く。選ぶのは利用者。
    ///
    /// このキーだけは画面（`/settings`）から書き戻される（設計§7）。他のキーは
    /// 起動時に読むだけ。
    pub always_bypass_permissions: bool,
    /// 自己修復（設計§9）を動かすか。
    ///
    /// 切れる口を用意しているのは、この機能が**本物の claude を無人で起動して
    /// 自分のソースを書き換える**ためで、事情があるときに機能ごと止められないと困るため。
    /// 止めても検知の通知だけは出る（黙って何もしないのが一番困る）。
    pub selfheal_enabled: bool,
    /// カナリアセッションで使うモデル
    pub canary_model: String,
    /// カナリアのサンプルが要素不足だったときに、1回だけ採り直すモデル。
    ///
    /// カナリアは「ツールコールとサブエージェントを含む JSONL」を採るのが目的なので、
    /// 小さいモデルだと指示を素通りしてサブエージェントを起動しないことがある。
    /// 採れた中身を見て足りなければ、こちらで採り直す。
    pub canary_fallback_model: String,
    /// 修復セッションで使うモデル。
    ///
    /// 既定を**エイリアス**（`sonnet`）にしてあるのは、CLI 側が「その時点の最新の
    /// Sonnet」へ解決してくれるため。具体的な版を書くと、モデルが新しくなるたびに
    /// 設定を直して回ることになる。パーサを直す作業は読み書きと推論の両方を要求する
    /// ので、いちばん小さいモデルでは力不足になりやすい。
    pub repair_model: String,
    /// 修復の再試行上限
    pub selfheal_retry: u32,
    /// 同一バージョンへの再挑戦を抑制する時間
    pub selfheal_cooldown_hours: u64,
    /// ダッシュボード自身のソースリポジトリ。
    ///
    /// 自己修復はここに git worktree を作り、`scripts/cargo` でテストとビルドを行う
    /// （設計§9 の実行環境の前提）。None なら起動時のカレントディレクトリから
    /// 上へ辿って探す。見つからなければ自己修復は検知の通知だけに留まる。
    pub selfheal_repo_dir: Option<PathBuf>,
    /// メモリに保持する履歴の直近ウィンドウ（ノード数、設計§4）。
    ///
    /// セルフホスト化設計§13-2 はこのキーを `ServerConfig` に置いているが、それは
    /// `TranscriptWindow` がサーバ側へ移ったあとの姿。窓の持ち主が
    /// [`crate::session::Session`] であるうちはエージェント側で読む（フェーズ2 で窓ごと移す）。
    pub transcript_window_nodes: usize,
    /// 再開位置などの状態を置く場所。
    ///
    /// 既定は `$XDG_STATE_HOME/agentdashboard`（無ければ `~/.local/state/agentdashboard`）。
    /// 一時ディレクトリやビルド成果物の隣に置いてはいけない — 消えると再開位置を失い、
    /// 起動のたびに全再パースになってブラウザへ履歴が二重に届く。
    pub state_dir: Option<PathBuf>,
    /// 利用者のグローバル設定 `~/.claude/settings.json` の場所。
    ///
    /// 既定は `$HOME/.claude/settings.json`。**E2E とテストはここを差し替える。**
    /// モデルを切り替えるとこのファイルが汚れるので（設計§11 前提3）、指定しないと
    /// テストが利用者の本物の設定を読み書きすることになる。`state_dir` を
    /// 差し替えられるようにしてあるのと同じ理由。
    pub claude_settings_path: Option<PathBuf>,
    /// セッションへ `statusLine` を注入するか（設計§4）。
    ///
    /// これがモデル名の唯一の取得経路なので、切ると**モデルは「不明」のまま**になる。
    /// 切れるようにしてあるのは、`--settings` がコマンドライン引数の層にあるせいで
    /// **利用者自身の `statusLine` を上書きしてしまう**ため（設計§11 前提5 で実測）。
    /// 自分の statusLine を優先したい人のための逃げ道。
    pub inject_status_line: bool,
    /// 注入する `statusLine` の `refreshInterval`（秒、最小1）。
    ///
    /// `statusLine` が走る契機に**モデル変更は入っていない**（設計§11 前提6）。
    /// 切り替えた結果が画面に反映されるまでの時間は、事実上この値で決まる。
    pub status_line_refresh_secs: u64,
    /// フックと `statusLine` の宛先ポート（セルフホスト化設計§5-3）。
    ///
    /// セッション起動時に settings へ**焼き込まれる**ので、後から変えても走っている
    /// セッションには効かない。ローカルモードではブラウザの待ち受けと同じ値が入る。
    pub hook_port: u16,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            stalled_threshold_secs: DEFAULT_STALLED_THRESHOLD_SECS,
            coalesce_ms: DEFAULT_COALESCE_MS,
            pty_ring_buffer: DEFAULT_PTY_RING_BUFFER,
            always_bypass_permissions: false,
            selfheal_enabled: true,
            canary_model: DEFAULT_CANARY_MODEL.to_string(),
            canary_fallback_model: DEFAULT_CANARY_FALLBACK_MODEL.to_string(),
            repair_model: DEFAULT_REPAIR_MODEL.to_string(),
            selfheal_retry: DEFAULT_SELFHEAL_RETRY,
            selfheal_cooldown_hours: DEFAULT_SELFHEAL_COOLDOWN_HOURS,
            selfheal_repo_dir: None,
            transcript_window_nodes: DEFAULT_TRANSCRIPT_WINDOW_NODES,
            state_dir: None,
            claude_settings_path: None,
            inject_status_line: true,
            status_line_refresh_secs: DEFAULT_STATUS_LINE_REFRESH_SECS,
            hook_port: DEFAULT_HOOK_PORT,
        }
    }
}

impl AgentConfig {
    /// 状態ファイル（パーサの再開位置など）を置く場所を決める。
    ///
    /// 実行ファイルの隣やビルド成果物の中には置かない。開発中のバイナリは
    /// `server/target/debug/` にあり、`make clean` で消えると再開位置も一緒に消える。
    /// 消えると起動のたびに全再パースになり、ブラウザへ履歴が二重に届く。
    pub fn resolved_state_dir(&self) -> PathBuf {
        if let Some(dir) = &self.state_dir {
            return dir.clone();
        }
        match std::env::var("XDG_STATE_HOME") {
            Ok(dir) if !dir.is_empty() => PathBuf::from(dir).join("agentdashboard"),
            _ => match std::env::var("HOME") {
                Ok(home) if !home.is_empty() => PathBuf::from(home)
                    .join(".local")
                    .join("state")
                    .join("agentdashboard"),
                // HOME すら無い環境。消えても動作は続くので一時領域で妥協する
                _ => std::env::temp_dir().join("agentdashboard"),
            },
        }
    }

    /// 自己修復が作業するリポジトリを決める（設計§9）。
    ///
    /// 明示が無ければカレントディレクトリから上へ辿り、`scripts/cargo` を持つ場所を探す。
    /// この1本を目印にするのは、**cargo を呼べること**が自己修復の成立条件そのものだから。
    /// リポジトリの形（`.git` の有無）ではなく能力で判定する。
    ///
    /// 見つからない場合は `None`。呼び出し側は「検知はするが修復には進まない」に落とす。
    pub fn resolved_repo_dir(&self) -> Option<PathBuf> {
        if let Some(dir) = &self.selfheal_repo_dir {
            return dir.is_dir().then(|| dir.clone());
        }
        let start = std::env::current_dir().ok()?;
        start
            .ancestors()
            .find(|dir| dir.join("scripts").join("cargo").is_file())
            .map(Path::to_path_buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 権限確認スキップの既定はオフ() {
        // 権限確認を飛ばす機能なので、既定は必ずスキップしない側に置く（設計§9）
        assert!(!AgentConfig::default().always_bypass_permissions);
    }

    #[test]
    fn 明示したリポジトリが存在しなければ使わない() {
        // 設定の打ち間違いに気づかず「修復したつもり」で別の場所を触るほうが危ない。
        // 実在しないなら None にして、検知の通知だけに落とす
        let config = AgentConfig {
            selfheal_repo_dir: Some(PathBuf::from("/nonexistent/repo")),
            ..AgentConfig::default()
        };
        assert_eq!(config.resolved_repo_dir(), None);
    }

    #[test]
    fn 状態の置き場所は明示があればそれを使う() {
        let config = AgentConfig {
            state_dir: Some(PathBuf::from("/tmp/agentdashboard-test")),
            ..AgentConfig::default()
        };
        assert_eq!(
            config.resolved_state_dir(),
            PathBuf::from("/tmp/agentdashboard-test")
        );
    }
}
