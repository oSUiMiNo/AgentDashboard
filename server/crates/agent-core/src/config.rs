//! エージェント（PC 側）が使う設定（セルフホスト化設計§13-2）。
//!
//! # 2つの入口がある
//!
//! | モード | 誰が読むか |
//! |---|---|
//! | ローカル（同居） | `config.toml` を `agentdashboard_core::config::Config` が読み、ここへ**射影**する |
//! | セルフホスト（分離） | `agent.toml` を [`AgentConfig::load`] が読む |
//!
//! フェーズ2 までは前者だけだったので「ファイルは読まない」と書いてあったが、
//! エージェントが別プロセスになると**読む主体が他に無い**（§21 読み替え8）。
//! 実行ファイル側に置くと 15 キーの構造体が2つになり、片方だけが古くなる。
//!
//! # キーの割り当て
//!
//! 「接続と機械に属するもの」のうち、**利用者の PC にあるものを触る**キーがここへ来る
//! （PTY・自己修復・`~/.claude`・状態の置き場所）。ブラウザへの配信に関わるキー
//! （`port` / `flow_*` / `transcript_page_limit`）は `server_core::config::ServerConfig`。
//!
//! 接続の3つ（`server_url` / `pairing_token` / `agent_name`）と `hook_port` は
//! **`agent.toml` にだけ置く**。ローカルモードでは繋ぐ相手が自分自身で、フックの宛先も
//! ブラウザと同じポートなので、`config.toml` に並べても意味を持たない——書けてしまうと
//! 「ローカルでも繋げるのか」と読めてしまう。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 環境変数での上書き（設計§14-1・§20-2）。
///
/// **2つの設定ファイル（`config.toml` と `agent.toml`）で同じ仕組みを使う。** 片方だけに
/// 実装があると、「compose では設定できないキーがある」という形でしか表に出ない差が
/// 生まれる。ここに置いたのは、両方から見える crate がここだけだから。
pub mod env {
    use serde::Serialize;

    /// 環境変数を当てる。**ファイルより環境変数が強い**（compose では設定ファイルを
    /// 配らずに環境変数で渡すのが自然なため）。
    pub fn apply(
        table: &mut toml::Table,
        shapes: &[(String, toml::Value)],
        aliases: &[(&str, &str)],
    ) -> Result<(), String> {
        for (key, shape) in shapes {
            let Some(raw) = lookup(key, aliases) else {
                continue;
            };
            table.insert(key.clone(), parse_value(key, &raw, shape)?);
        }
        Ok(())
    }

    /// そのキーに対応する環境変数を読む。
    ///
    /// 既定は `AGENTDASHBOARD_<大文字のキー>` の一本。加えて、**慣行として裸の名前が
    /// 定着しているものだけ**別名を受ける（`DATABASE_URL` など）。裸の名前は他の
    /// ソフトウェアと衝突しうるので、接頭辞つきを先に見る。
    pub fn lookup(key: &str, aliases: &[(&str, &str)]) -> Option<String> {
        let prefixed = format!("AGENTDASHBOARD_{}", key.to_uppercase());
        if let Ok(value) = std::env::var(&prefixed) {
            return Some(value);
        }
        let alias = aliases
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, alias)| *alias)?;
        std::env::var(alias).ok()
    }

    /// 全キーと、その値の形。
    ///
    /// 未指定が既定のキー（`Option`）は既定値の表から消えてしまうので、**全部を
    /// 埋めた見本**から取り出す。ここが漏れるとそのキーだけ環境変数で設定できなくなる。
    pub fn shapes_of<T: Serialize>(probe: &T) -> Result<Vec<(String, toml::Value)>, String> {
        let toml::Value::Table(table) = toml::Value::try_from(probe)
            .map_err(|err| format!("見本を TOML へ直せません: {err}"))?
        else {
            return Err("設定は構造体でなければなりません".to_string());
        };
        Ok(table.into_iter().collect())
    }

    /// 環境変数の文字列を、そのキーの形に合わせた TOML の値へ直す。
    ///
    /// 型は既定値から決める。`AGENTDASHBOARD_PORT=abc` のような値は、素通しして
    /// 後で分かりにくく壊れるより、その場で理由付きで断る。
    pub fn parse_value(key: &str, raw: &str, shape: &toml::Value) -> Result<toml::Value, String> {
        let invalid = |expected: &str| {
            format!("環境変数で指定した {key} が{expected}として読めません: {raw}")
        };
        match shape {
            toml::Value::Integer(_) => raw
                .trim()
                .parse::<i64>()
                .map(toml::Value::Integer)
                .map_err(|_| invalid("整数")),
            toml::Value::Boolean(_) => raw
                .trim()
                .parse::<bool>()
                .map(toml::Value::Boolean)
                .map_err(|_| invalid("真偽値（true / false）")),
            // 文字列とパスは素通し。**引用符を要求しない**——compose の環境変数に
            // TOML の書式を持ち込ませないため
            _ => Ok(toml::Value::String(raw.to_string())),
        }
    }
}

const DEFAULT_STALLED_THRESHOLD_SECS: u64 = 120;
const DEFAULT_COALESCE_MS: u64 = 8;
const DEFAULT_PTY_RING_BUFFER: usize = 1024 * 1024;
const DEFAULT_CANARY_MODEL: &str = "haiku";
const DEFAULT_CANARY_FALLBACK_MODEL: &str = "sonnet";
const DEFAULT_REPAIR_MODEL: &str = "sonnet";
const DEFAULT_SELFHEAL_RETRY: u32 = 3;
const DEFAULT_SELFHEAL_COOLDOWN_HOURS: u64 = 24;
/// `statusLine` を再実行する間隔（秒）。
///
/// 実測で `refreshInterval: 3` はきっちり3.0秒間隔で走った（設計§11 前提6）。
/// 1秒にするとセッション数だけ毎秒プロセスが起動するので、3秒を既定にしている。
const DEFAULT_STATUS_LINE_REFRESH_SECS: u64 = 3;
/// フックの受信ポートの既定。**0 は「動的に確保する」**（設計§5-3）。
///
/// 固定の番号を既定にすると、その番号が塞がっている PC でだけ「フックが届かない」
/// という分かりにくい失敗になる。ローカルモードでは束ねる層がブラウザの待ち受けと
/// 同じ値を入れる（同居しているため）。
const DEFAULT_HOOK_PORT: u16 = 0;

/// 設定の既定ファイル名（エージェント単体で動くとき）。
pub const DEFAULT_AGENT_FILE_NAME: &str = "agent.toml";

/// 記録と状態を置くフォルダの名前。
///
/// # なぜ公開しているのか
///
/// **入れる側と消す側が同じ場所を指す必要がある。** 消す側（`scripts/uninstall.sh` /
/// `.ps1`）は実行ファイルへ聞く（`agentdashboard state-dir`）が、実行ファイルが
/// 見つからないときの控えとして同じ組み立て方を持つ。ここを出しておけば、
/// **片方を直したらもう片方が落ちる**形を門にできる（`crates/dist/tests/uninstall.rs`）。
pub const STATE_DIR_NAME: &str = "agentdashboard";

/// 置き場所を明示する環境変数（OS を問わず最優先）。
pub const STATE_HOME_ENV: &str = "XDG_STATE_HOME";

/// Unix での既定。`HOME` からの相対。
pub const STATE_HOME_RELATIVE: &str = ".local/state";

/// Windows での既定の土台。
///
/// **`HOME` は Windows に無い。** これが無いと一時領域へ落ち、ディスク掃除で
/// 一覧と履歴が消えうる。
pub const STATE_HOME_ENV_WINDOWS: &str = "LOCALAPPDATA";

/// 中身のある環境変数だけを返す。**空文字は「無い」と同じ扱い**にする。
fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
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
    ///
    /// **既定は 0＝動的確保**（設計§5-3）。固定の番号を既定にすると、その番号が
    /// 塞がっている PC で「フックが届かない」という分かりにくい失敗になる。
    pub hook_port: u16,
    /// 繋ぎに行くダッシュボードサーバ（`http://host:port`）。
    ///
    /// **`agent.toml` にだけ意味がある。** ローカルモードは同じプロセスに同居しており、
    /// 繋ぐ相手が自分自身なので使わない。
    pub server_url: Option<String>,
    /// ペアリングトークン（設計§8-4）。アカウント画面で発行したものを貼る。
    pub pairing_token: Option<String>,
    /// この PC の名前。
    ///
    /// **アカウントの中でこの名前が PC の同一性**になる（§8-4）。変えると別の PC として
    /// 登録され、それまでのカードの帰属が切れる。未指定ならホスト名から決める。
    pub agent_name: Option<String>,
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
            state_dir: None,
            claude_settings_path: None,
            inject_status_line: true,
            status_line_refresh_secs: DEFAULT_STATUS_LINE_REFRESH_SECS,
            hook_port: DEFAULT_HOOK_PORT,
            server_url: None,
            pairing_token: None,
            agent_name: None,
        }
    }
}

impl AgentConfig {
    /// `agent.toml` を読む（セルフホストモードのエージェント）。
    ///
    /// 探索順は `explicit`（`--config`）→ カレントの `agent.toml` → 既定値。
    pub fn load(explicit: Option<&Path>) -> anyhow::Result<Self> {
        match explicit {
            Some(path) => Self::from_file(path),
            None => {
                let default_path = Path::new(DEFAULT_AGENT_FILE_NAME);
                if default_path.is_file() {
                    Self::from_file(default_path)
                } else {
                    Self::from_toml_str("")
                }
            }
        }
    }

    pub fn from_file(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path).map_err(|err| {
            anyhow::anyhow!("設定ファイルを読めません（{}）: {err}", path.display())
        })?;
        Self::from_toml_str(&text).map_err(|err| anyhow::anyhow!("{}: {err}", path.display()))
    }

    /// 全キーと、その値の形。
    ///
    /// 未指定が既定のキー（`Option`）は既定値の表から消えてしまうので、**全部を
    /// 埋めた見本**から取り出す。ここが漏れるとそのキーだけ環境変数で設定できなくなる
    /// ——それを見つけるのが `全キーが環境変数で上書きできる` のテスト。
    ///
    /// **配るのはこちら側**（設計§14-3）。手元では `agent.toml` を置けばよいが、
    /// 配った先では環境変数しか渡せない場面がある（サービスとして常駐させる等）。
    fn key_shapes() -> Vec<(String, toml::Value)> {
        let probe = Self {
            selfheal_repo_dir: Some(PathBuf::from("/probe")),
            state_dir: Some(PathBuf::from("/probe")),
            claude_settings_path: Some(PathBuf::from("/probe")),
            server_url: Some("http://probe".to_string()),
            pairing_token: Some("probe".to_string()),
            agent_name: Some("probe".to_string()),
            ..Self::default()
        };
        env::shapes_of(&probe).expect("既定値を TOML へ変換できること")
    }

    /// TOML 文字列から読み、**環境変数で上書きする**（§14-1・§20-2）。
    pub fn from_toml_str(text: &str) -> anyhow::Result<Self> {
        let mut table: toml::Table = toml::from_str(text)?;
        env::apply(&mut table, &Self::key_shapes(), &[]).map_err(|err| anyhow::anyhow!(err))?;

        // 表へ起こしてから読み直しても `deny_unknown_fields` は効く。打ち間違いを
        // 黙って無視しないという約束は保たれている
        let config: Self = toml::Value::Table(table).try_into()?;
        Ok(config)
    }

    /// この PC の名前を決める（設計§8-4）。
    ///
    /// 未指定ならホスト名を使う。**利用者に必ず名前を書かせない**のは、5分セットアップ
    /// （§14-4）で書く項目を1つでも減らすため。名前は後から設定で変えられる。
    pub fn resolved_agent_name(&self) -> String {
        if let Some(name) = &self.agent_name
            && !name.trim().is_empty()
        {
            return name.trim().to_string();
        }
        for key in ["HOSTNAME", "COMPUTERNAME"] {
            if let Ok(value) = std::env::var(key)
                && !value.trim().is_empty()
            {
                return value.trim().to_string();
            }
        }
        std::fs::read_to_string("/etc/hostname")
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "agent".to_string())
    }

    /// 状態ファイル（パーサの再開位置など）を置く場所を決める。
    ///
    /// 実行ファイルの隣やビルド成果物の中には置かない。開発中のバイナリは
    /// `server/target/debug/` にあり、`make clean` で消えると再開位置も一緒に消える。
    /// 消えると起動のたびに全再パースになり、ブラウザへ履歴が二重に届く。
    ///
    /// # 一時領域へは落とさない
    ///
    /// ここには記録の DB（一覧・履歴・アカウント）も同居する。**消えると戻せない**ので、
    /// OS が掃除する場所を既定にしてはいけない。Windows には `HOME` が無く、
    /// 分岐が無いと `%LOCALAPPDATA%\Temp\` へ落ちていた——ディスク掃除で一覧と履歴が
    /// 消えうる形だった。
    ///
    /// # 組み立ての部品は定数で出してある
    ///
    /// **消す側（`scripts/uninstall.sh` / `.ps1`）も同じ場所を知る必要がある。**
    /// あちらは実行ファイルへ聞く（`agentdashboard state-dir`）が、実行ファイルが
    /// 見つからないときの控えとして同じ組み立て方を持つ。食い違わないよう、
    /// 部品を [`STATE_DIR_NAME`] などで公開して門から突き合わせる。
    ///
    /// # `cfg(windows)` で分岐しない
    ///
    /// 分けると、**Linux の CI では Windows 側の分岐が消える**ので永久に確かめられない
    /// （実際、分岐で書いたら「実装から Windows の道を消す」を検知できなかった）。
    /// 環境変数の有無だけで決める形にしてあるので、`HOME` を外して `LOCALAPPDATA` を
    /// 置けば、どの OS の上でも Windows の道を通せる。
    ///
    /// 順番にも意味がある。Git Bash は `HOME` を持つので `HOME` を先に見る——
    /// そうすると Git Bash の利用者は `uninstall.sh` と、素の PowerShell の利用者は
    /// `uninstall.ps1` と、それぞれ同じ場所を指すことになる。
    pub fn resolved_state_dir(&self) -> PathBuf {
        if let Some(dir) = &self.state_dir {
            return dir.clone();
        }
        // 明示された置き場所は OS を問わず優先する（Windows でも設定できる）
        if let Some(dir) = non_empty_env(STATE_HOME_ENV) {
            return PathBuf::from(dir).join(STATE_DIR_NAME);
        }
        if let Some(home) = non_empty_env("HOME") {
            return PathBuf::from(home)
                .join(STATE_HOME_RELATIVE)
                .join(STATE_DIR_NAME);
        }
        // **`HOME` が無いのは Windows。** ここで諦めると一時領域へ落ちる
        if let Some(base) = non_empty_env(STATE_HOME_ENV_WINDOWS) {
            return PathBuf::from(base).join(STATE_DIR_NAME);
        }
        // 置き場所を決める手がかりが1つも無い環境。ここへ落ちること自体が異常なので、
        // 消えても動作は続く一時領域で妥協する
        std::env::temp_dir().join(STATE_DIR_NAME)
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
    use std::sync::{Mutex, MutexGuard, OnceLock};

    /// 環境変数を触るテストを1本ずつにする錠。
    ///
    /// **環境変数はプロセス全体のもの**なので、同じプロセスの別スレッドが同時に触ると
    /// 取り合いになる。`make test` は nextest（テストごとに別プロセス）なので緑のままだが、
    /// **`cargo test` を直に叩くと落ちる**——実際に落ちた。
    ///
    /// 「あの走らせ方でしか通らない」は、いずれ誰かが踏む。消す道の門でも同じ錠を
    /// 使っている（`crates/dist/tests/common/mod.rs`）。
    fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn 雛形は全キーを網羅し既定値と一致する() {
        // 環境変数を触る他のテストと同時に走ると、上書きが混ざって落ちる
        let _lock = env_lock();
        // `agent.toml.example` は、PC へエージェントを入れる人が最初に読む一覧。
        // ここが実装より遅れていると、増えたキーの存在に誰も気づけない
        // （`config.toml.example` 側で実際に起きた）
        let example = include_str!("../../../agent.toml.example");
        let config = AgentConfig::from_toml_str(example).expect("雛形が読めること");
        assert_eq!(
            config,
            AgentConfig::default(),
            "雛形の値が既定値と食い違っている"
        );

        let written: toml::Table = example.parse().expect("雛形が TOML として妥当なこと");
        let toml::Value::Table(with_values) =
            toml::Value::try_from(AgentConfig::default()).expect("既定値を TOML へ変換できること")
        else {
            unreachable!("AgentConfig は構造体なのでテーブルになる");
        };
        for key in with_values.keys() {
            assert!(
                written.contains_key(key),
                "{key} が agent.toml.example に書かれていない"
            );
        }

        // 既定が「未指定」のキーは TOML へ変換すると消えるので上の走査に乗らない。
        // 値を書くと利用者の環境に無いものを指すことになるため、雛形では
        // **コメントとして例示**する。名指しでしか確かめられないので列挙する
        for key in [
            "server_url",
            "pairing_token",
            "agent_name",
            "selfheal_repo_dir",
            "state_dir",
            "claude_settings_path",
        ] {
            assert!(
                !with_values.contains_key(key),
                "{key} に既定値が付いた。この列挙から外して通常の走査へ移すこと"
            );
            assert!(
                example.contains(&format!("# {key} =")),
                "{key} が agent.toml.example にコメントとして例示されていない"
            );
        }
    }

    #[test]
    fn 知らないキーは黙って無視しない() {
        // 打ち間違いを黙って無視すると「設定したのに効かない」事故になる
        assert!(AgentConfig::from_toml_str("coalesce_ms = 8").is_ok());
        assert!(AgentConfig::from_toml_str("coalesce_mss = 8").is_err());
    }

    /// そのキーへ入れて意味のある値（既定と必ず違うもの）。
    fn probe_value(shape: &toml::Value) -> String {
        match shape {
            toml::Value::Integer(_) => "4242".to_string(),
            // 既定の逆を入れる。同じ値だと「上書きが効いた」ことにならない
            toml::Value::Boolean(value) => (!value).to_string(),
            _ => "/tmp/env-probe".to_string(),
        }
    }

    #[test]
    fn 全キーが環境変数で上書きできる() {
        let _lock = env_lock();
        // **配るのはこちら側**（設計§14-3）。手元なら `agent.toml` を置けばよいが、
        // 配った先では環境変数しか渡せない場面がある（サービスとして常駐させる等）。
        // 1つでも対応していないキーがあると「そのキーだけ設定できない」という、
        // 配ってからでないと気づけない穴になる。
        //
        // **キーの一覧を手で持たない**のが要点。実装（`AgentConfig`）から取り出して
        // いるので、今後キーを増やしてもこのテストは自動でそれを見る
        let shapes = AgentConfig::key_shapes();

        // ただし「未指定が既定」のキーは、見本（`key_shapes` の probe）を埋め忘れると
        // 一覧そのものから消え、**この繰り返しの目にも入らない**。繋ぐための3キーは
        // 落ちると配った PC が一切繋がらなくなるので、名指しでも見る（§21 読み替え8）
        for required in ["server_url", "pairing_token", "hook_port"] {
            assert!(
                shapes.iter().any(|(key, _)| key == required),
                "{required} が一覧に居ません。key_shapes の見本を埋め忘れています"
            );
        }

        for (key, shape) in shapes {
            let name = format!("AGENTDASHBOARD_{}", key.to_uppercase());
            let raw = probe_value(&shape);
            unsafe { std::env::set_var(&name, &raw) };

            let config = AgentConfig::from_toml_str("")
                .unwrap_or_else(|err| panic!("{key} を環境変数で指定したら読めなくなった: {err}"));
            let toml::Value::Table(written) =
                toml::Value::try_from(config).expect("TOML へ変換できること")
            else {
                unreachable!("AgentConfig は構造体なのでテーブルになる");
            };
            let expected = env::parse_value(&key, &raw, &shape).expect("読めること");
            assert_eq!(
                written.get(&key),
                Some(&expected),
                "{key} が環境変数で上書きされていない"
            );

            unsafe { std::env::remove_var(&name) };
        }
    }

    #[test]
    fn 環境変数はファイルより強い() {
        let _lock = env_lock();
        // 設定ファイルを置いた PC へ、環境変数だけで別の値を渡せること
        unsafe { std::env::set_var("AGENTDASHBOARD_HOOK_PORT", "9100") };
        let config = AgentConfig::from_toml_str("hook_port = 8787").expect("読めること");
        assert_eq!(config.hook_port, 9100);
        unsafe { std::env::remove_var("AGENTDASHBOARD_HOOK_PORT") };
    }

    #[test]
    fn 環境変数の型が合わなければ理由を出して断る() {
        let _lock = env_lock();
        // 素通しして「設定したのに効かない」になるより、その場で断るほうがよい
        unsafe { std::env::set_var("AGENTDASHBOARD_HOOK_PORT", "きゅうせん") };
        let err = AgentConfig::from_toml_str("").expect_err("値エラーになること");
        let message = err.to_string();
        assert!(
            message.contains("hook_port"),
            "どのキーか分かること: {message}"
        );
        assert!(
            message.contains("整数"),
            "何を期待したか分かること: {message}"
        );
        unsafe { std::env::remove_var("AGENTDASHBOARD_HOOK_PORT") };
    }

    #[test]
    fn 名前は指定が無ければホスト名から決まる() {
        // 5分セットアップ（§14-4）で書く項目を1つでも減らすため。指定があれば必ず優先する
        let named = AgentConfig {
            agent_name: Some("  仕事用ノート  ".to_string()),
            ..AgentConfig::default()
        };
        assert_eq!(named.resolved_agent_name(), "仕事用ノート");

        // 空白だけの指定は「指定なし」と同じ扱い（貼り付けの事故で名前が消えないように）
        let blank = AgentConfig {
            agent_name: Some("   ".to_string()),
            ..AgentConfig::default()
        };
        assert!(!blank.resolved_agent_name().is_empty());
    }

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

    #[test]
    fn homeが無ければlocalappdataを使う() {
        let _lock = env_lock();
        // **Windows の道**。あちらに `HOME` は無いので、ここを通ることになる。
        //
        // `cfg(windows)` で分けると Linux の CI では消えてしまい、**この道を消しても
        // 誰も気づけない**（実際に検知できなかった）。環境変数の有無だけで決める形に
        // してあるので、Linux の上でも通せる。
        //
        // ここへ来られないと一時領域（`%LOCALAPPDATA%\Temp\`）へ落ちる。**ディスク掃除で
        // 一覧と履歴が消えうる**ので、記録の置き場所として選んではいけない。
        let saved_home = std::env::var_os("HOME");
        let saved_xdg = std::env::var_os(STATE_HOME_ENV);
        let saved_win = std::env::var_os(STATE_HOME_ENV_WINDOWS);

        // SAFETY: 触った3つは、この関数を出る前に必ず戻す
        unsafe {
            std::env::remove_var("HOME");
            std::env::remove_var(STATE_HOME_ENV);
            std::env::set_var(STATE_HOME_ENV_WINDOWS, "/tmp/ローカルアプリデータ");
        }
        let resolved = AgentConfig::default().resolved_state_dir();
        unsafe {
            match saved_home {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
            match saved_xdg {
                Some(value) => std::env::set_var(STATE_HOME_ENV, value),
                None => std::env::remove_var(STATE_HOME_ENV),
            }
            match saved_win {
                Some(value) => std::env::set_var(STATE_HOME_ENV_WINDOWS, value),
                None => std::env::remove_var(STATE_HOME_ENV_WINDOWS),
            }
        }

        assert_eq!(
            resolved,
            PathBuf::from("/tmp/ローカルアプリデータ").join(STATE_DIR_NAME),
            "HOME が無いときに一時領域へ落ちています（記録が消えうる場所です）"
        );
    }
}
