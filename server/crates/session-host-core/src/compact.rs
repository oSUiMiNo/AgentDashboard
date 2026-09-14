//! 仮想ディスクの縮小を「打ってよいか」を決める（設計§2・§8）。
//!
//! # なぜ判定だけを先に切り出すのか
//!
//! 縮小は **`wsl --shutdown` を伴う＝走っている claude を全部落とす**操作である。
//! 打った本人（ダッシュボード）も道連れになるので、**結果を自分では受け取れない**。
//! だから「打ってよいか」の判定だけは、**外の世界へ出ずに確かめられる形**にしておく
//! 必要がある——打ってから間違いに気づいても、そのときには誰も居ない。
//!
//! # 形
//!
//! ```text
//! 外の世界  →  QuietProbe / SlackProbe（トレイト）  →  CompactStatus  →  blocker()
//!             ここだけがコマンドを起こす              ただの値        純関数
//! ```
//!
//! **判定（[`CompactStatus::blocker`]）は純関数**で、`&self` と設定と `now` しか見ない。
//! 時計を偽装したテストが書けるのはこの形のときだけである（`logging::admit` と同じ作法）。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// 縮小を試みた印。**打つ直前に書き、起き直った側が拾って消す。**
///
/// 名前は [`crate::version`] の `version-attempt` に揃えてある。同じ `<state_dir>` に
/// 別の命名規則を混ぜると、次に読む人がどちらが正か考えることになる。
pub const COMPACT_ATTEMPT: &str = "compact-attempt";

/// 縮小まわりの覚えておくこと（静かになった時刻・最後に打った時刻・一時停止）。
pub const COMPACT_STATE: &str = "compact-state.json";

/// 外部コマンドを諦めるまでの時間。
///
/// 数えるだけのコマンドしか起こさないので短くてよい。**読めなければ「打たない」側へ
/// 倒れる**ので、待ち続けるより諦めるほうが安全である。
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// 設定

/// 縮小の設定（設計§8）。
///
/// **[`crate::config::SessionHostConfig`] へ入れていない。** あちらは `agent.toml` として
/// **別の PC へ配る**ファイルだが、縮小は **この機械にしか効かない**（remote は 501 で
/// 断る）。置くと「remote でも縮められるのか」と読めてしまう。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactConfig {
    /// 静かなときに自動で打つか。**既定は `false`。**
    pub auto: bool,
    /// ①〜③が全部0のまま、この分数が続いたら「静か」とみなす。
    pub quiet_minutes: u64,
    /// 空洞がこの GiB を超えていなければ打たない。
    pub threshold_gb: u64,
    /// 打ってよい時間帯（`"02:00-05:00"`）。**日をまたぐ指定も読む。**
    pub window: String,
    /// 前回からこの時間が経つまで打たない。
    pub min_interval_hours: u64,
    /// Windows のタスクスケジューラに登録した名前。
    pub script_task: String,
    /// 台本が結果を書く先（Windows 側のパスを WSL から見たもの）。
    pub result_path: Option<PathBuf>,
    /// Ubuntu の仮想ディスク。
    pub ext4_vhdx: Option<PathBuf>,
    /// Docker の仮想ディスク。
    pub docker_vhdx: Option<PathBuf>,
}

impl Default for CompactConfig {
    fn default() -> Self {
        Self {
            // **自分を殺す操作の既定を on にしない。** 利用者が初回確認を通してから
            // 自分で入れる（設計§7）
            auto: false,
            quiet_minutes: 30,
            threshold_gb: 50,
            window: "02:00-05:00".to_string(),
            min_interval_hours: 24,
            script_task: "AgentDashboard Compact WSL".to_string(),
            // 置き場所は機械ごとに違うので既定を作らない。**未指定なら空洞を出さない。**
            result_path: None,
            ext4_vhdx: None,
            docker_vhdx: None,
        }
    }
}

// ---------------------------------------------------------------------------
// 外の世界を読む口

/// 機械の静けさを読む口。
///
/// **トレイトにしてあるのはテストのため**（[`crate::resources::Probe`] と同じ理由）。
/// 差し替えられないと、**うるさいときに打たないことを1行も確かめられない。**
pub trait QuietProbe: Send + Sync + std::fmt::Debug {
    /// claude の本数。**読めなければ `None`**（読めないことは異常ではない）。
    fn claude_procs(&self) -> Option<usize>;
    /// tty を持つ対話シェルの本数。
    fn interactive_shells(&self) -> Option<usize>;
    /// 機械の地方時（0時からの分）。
    fn local_minutes(&self) -> Option<u16>;
}

/// 本物。
#[derive(Debug, Clone, Copy, Default)]
pub struct RealQuiet;

impl QuietProbe for RealQuiet {
    fn claude_procs(&self) -> Option<usize> {
        // **`-x`（プロセス名の完全一致）であって `-f` ではない。**
        //
        // `-f` はコマンドライン全体を見るので、フックが起こしている `uv` / `python3` /
        // `sh` / `bash`（どれも引数に `~/.claude/…` を持つだけ）まで数える。実測で
        // **`-f` は 27、`-x` は 12** だった。②の条件は「claude が0本」なので、`-f` を
        // 使うと**この条件は永久に満たされず、自動の縮小は一度も走らない**——落ちも
        // 警告も出ないまま、機能だけが死ぬ。
        //
        // **逆向きの危険もある。** `-x` に渡す名前が15文字を超えると `pgrep` は必ず
        // 0件を返す（プロセス名の長さ制限）。そうなると②が常に満たされ、**うるさい
        // ときでも打ってしまう。** `claude` は6文字なので足りている。
        数える(std::process::Command::new("pgrep").args(["-x", "claude"]))
    }

    fn interactive_shells(&self) -> Option<usize> {
        // `=` を付けて見出しを消しているので、1行目から数えてよい。
        let outcome = crate::proc::run(
            std::process::Command::new("ps").args(["-eo", "tty=,comm="]),
            PROBE_TIMEOUT,
        );
        if !outcome.success {
            return None;
        }
        Some(対話シェルを数える(&outcome.output))
    }

    fn local_minutes(&self) -> Option<u16> {
        // **`time` crate では取れない。** workspace の `time` は `local-offset` を持たず、
        // `current_local_offset()` は Unix の多スレッドプログラムでは既定で失敗する。
        // リポジトリ全体で地方時を読んでいる箇所は他に無い。
        //
        // `LC_ALL=C` を付けるのは、書式が数字だけとはいえ locale に触らせないため。
        let outcome = crate::proc::run(
            std::process::Command::new("date")
                .env("LC_ALL", "C")
                .arg("+%H:%M"),
            PROBE_TIMEOUT,
        );
        if !outcome.success {
            return None;
        }
        時刻を分へ(outcome.output.trim())
    }
}

/// `pgrep` の出力を本数として読む。
///
/// **終了コード1は「0本」であって失敗ではない。** `pgrep` は1件も見つからないと1を
/// 返す。ここを「読めなかった（`None`）」と扱うと、**静かなときに限って `None` が
/// 返り**、判定が永久に通らなくなる。
fn 数える(command: &mut std::process::Command) -> Option<usize> {
    let outcome = crate::proc::run(command, PROBE_TIMEOUT);
    let 行数 = outcome
        .output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    if outcome.success {
        return Some(行数);
    }
    // 出力が空のまま失敗した＝「見つからなかった」。それ以外は本当に読めていない
    if 行数 == 0 { Some(0) } else { None }
}

/// `ps -eo tty=,comm=` の出力から、tty を持つ対話シェルを数える。**純関数。**
pub fn 対話シェルを数える(text: &str) -> usize {
    text.lines()
        .filter_map(|line| {
            let mut 列 = line.split_whitespace();
            let tty = 列.next()?;
            let comm = 列.next()?;
            Some((tty, comm))
        })
        // tty が `?` のものは端末を持たない（背景で走っているだけ）
        .filter(|(tty, comm)| *tty != "?" && matches!(*comm, "bash" | "zsh" | "fish"))
        .count()
}

/// `"12:32"` を0時からの分へ。読めなければ `None`。**純関数。**
pub fn 時刻を分へ(text: &str) -> Option<u16> {
    let (時, 分) = text.trim().split_once(':')?;
    let 時: u16 = 時.trim().parse().ok()?;
    let 分: u16 = 分.trim().parse().ok()?;
    if 時 > 23 || 分 > 59 {
        return None;
    }
    Some(時 * 60 + 分)
}

/// 仮想ディスクの大きさと、中の使用量。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slack {
    /// Ubuntu の仮想ディスクの大きさ。
    pub ext4_bytes: u64,
    /// Docker の仮想ディスクの大きさ。**読めなければ0。**
    pub docker_bytes: u64,
    /// Ubuntu の中で実際に使っている量（`df` が答える量）。
    pub used_bytes: u64,
}

impl Slack {
    /// 2枚が C: の上で占めている合計。**画面に出す値。**
    pub fn vhdx_bytes(&self) -> u64 {
        self.ext4_bytes.saturating_add(self.docker_bytes)
    }

    /// 空洞（消したのに Windows へ返っていない量）。
    ///
    /// **`ext4.vhdx` のぶんだけを数える。** `df /` が答えるのは Ubuntu の
    /// ファイルシステムの使用量であって、Docker の仮想ディスクの中は見えない。
    /// 2枚の合計から引くと、**Docker のぶんが丸ごと空洞に見える。**
    ///
    /// **`saturating_sub` を使う。** 大きさと使用量は測る時点がずれるので、中のほうが
    /// 大きく見える瞬間がある。素の引き算だと `u64` が回り込んで**巨大な空洞に見え、
    /// しきい値を必ず超えてしまう。**
    pub fn slack_bytes(&self) -> u64 {
        self.ext4_bytes.saturating_sub(self.used_bytes)
    }
}

/// 空洞を読む口。**[`QuietProbe`] と分けてあるのは、偽装したい軸が別だから。**
pub trait SlackProbe: Send + Sync + std::fmt::Debug {
    /// **どちらか読めなければ `None`**（＝打たない側へ倒れる）。
    fn read(&self, ext4: Option<&Path>, docker: Option<&Path>) -> Option<Slack>;
}

/// 本物。**PowerShell を起こさない**——Windows のファイルの大きさは `/mnt/c` 越しに
/// `stat` で読める。
#[derive(Debug, Clone, Copy, Default)]
pub struct RealSlack;

impl SlackProbe for RealSlack {
    fn read(&self, ext4: Option<&Path>, docker: Option<&Path>) -> Option<Slack> {
        // 判定に要るのは `ext4.vhdx` だけ。**これが読めなければ空洞は出せない。**
        let ext4_bytes = std::fs::metadata(ext4?).ok()?.len();
        // Docker のほうは画面に出すだけなので、読めなくても進む
        let docker_bytes = docker
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|meta| meta.len())
            .unwrap_or(0);
        let outcome = crate::proc::run(
            std::process::Command::new("df").args(["-B1", "/"]),
            PROBE_TIMEOUT,
        );
        if !outcome.success {
            return None;
        }
        let used_bytes = dfの使用量を読む(&outcome.output)?;
        Some(Slack {
            ext4_bytes,
            docker_bytes,
            used_bytes,
        })
    }
}

/// `df -B1 /` の出力から使用量（3列目）を読む。**純関数。**
///
/// ```text
/// Filesystem         1B-blocks         Used    Available Use% Mounted on
/// /dev/sdd       1081101176832 261109248000 764999573504  26% /
/// ```
pub fn dfの使用量を読む(text: &str) -> Option<u64> {
    // 1行目は見出しなので捨てる
    let 行 = text.lines().nth(1)?;
    行.split_whitespace().nth(2)?.parse().ok()
}

// ---------------------------------------------------------------------------
// 時間帯

/// `"02:00-05:00"` を（開始分, 終了分）へ。読めなければ `None`。**純関数。**
pub fn 窓を読む(text: &str) -> Option<(u16, u16)> {
    let (開始, 終了) = text.trim().split_once('-')?;
    Some((時刻を分へ(開始)?, 時刻を分へ(終了)?))
}

/// いまが窓の中か。**日をまたぐ指定（`"22:00-03:00"`）も読む。純関数。**
///
/// 開始と終了が同じなら「窓が無い」（1分も入らない）。下の式では前半の枝に入り、
/// 空の範囲になるので自然にそうなる。
pub fn 窓の中か(いまの分: u16, 開始: u16, 終了: u16) -> bool {
    if 開始 <= 終了 {
        (開始..終了).contains(&いまの分)
    } else {
        いまの分 >= 開始 || いまの分 < 終了
    }
}

// ---------------------------------------------------------------------------
// 覚えておくこと

/// 最後に見送った理由と、その時刻。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastSkip {
    /// [`Blocker::理由の名前`] が返す短い札。
    pub reason: String,
    pub at: SystemTime,
}

/// `<state_dir>/compact-state.json`。
///
/// **読めなければ既定値**（[`crate::jsonfile::load_or_default`] の作法）。状態を失っても
/// **「打たない」側から数え直すだけ**なので、それで困らない。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CompactState {
    /// ①〜③が全部0になった時刻。1つでも増えたら `None` へ戻す。
    pub quiet_since: Option<SystemTime>,
    /// 最後に縮小を打った時刻。
    pub last_compact: Option<SystemTime>,
    /// 一時停止の期限。
    pub paused_until: Option<SystemTime>,
    /// 最後に見送った理由（同じ理由を何度も記録しないための判定に使う）。
    pub last_skip: Option<LastSkip>,
}

// ---------------------------------------------------------------------------
// 判定

/// いま読み取った、機械の様子。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactStatus {
    /// ① 生きたカードの枚数。
    pub alive_cards: usize,
    /// ② claude の本数。
    pub claude_procs: usize,
    /// ③ tty を持つ対話シェルの本数。
    pub interactive_shells: usize,
    /// ④ ①〜③が全部0になった時刻。
    pub quiet_since: Option<SystemTime>,
    /// ⑤ いまが打ってよい時間帯か。
    pub in_window: bool,
    /// 空洞。**読めなければ `None`。**
    pub slack_bytes: Option<u64>,
    pub last_compact: Option<SystemTime>,
    pub auto_enabled: bool,
    pub paused_until: Option<SystemTime>,
}

/// 打てない理由。
///
/// **列挙にしてあるのは、3箇所が同じ答えを使うから**——`host compact status` の表示・
/// `kind=compact_skipped` の理由・自動の見送り判定。文字列で持つと3箇所で綴りが割れる。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Blocker {
    /// 自動が切ってある。
    AutoDisabled,
    /// 一時停止の期限内。
    Paused { until: SystemTime },
    /// 生きたカードが残っている。
    AliveCards(usize),
    /// claude が走っている。
    ClaudeRunning(usize),
    /// 端末が開いている。
    ShellOpen(usize),
    /// 静かになって間もない。**残りの秒数。**
    NotQuietLongEnough { secs: u64 },
    /// 時間帯の外。
    OutsideWindow,
    /// 空洞がしきい値に届かない（読めなかった場合を含む）。
    SlackTooSmall { have: u64, need: u64 },
    /// 前回から間がない。**前回からの秒数。**
    TooSoon { since: u64 },
}

impl Blocker {
    /// 記録に載せる短い札。**表示の文言とは別物**（あちらは人が読む1行）。
    pub fn 理由の名前(&self) -> &'static str {
        match self {
            Blocker::AutoDisabled => "auto_disabled",
            Blocker::Paused { .. } => "paused",
            Blocker::AliveCards(_) => "alive_cards",
            Blocker::ClaudeRunning(_) => "claude_running",
            Blocker::ShellOpen(_) => "shell_open",
            Blocker::NotQuietLongEnough { .. } => "not_quiet_long_enough",
            Blocker::OutsideWindow => "outside_window",
            Blocker::SlackTooSmall { .. } => "slack_too_small",
            Blocker::TooSoon { .. } => "too_soon",
        }
    }

    /// 人が読む1行。
    pub fn 言い分(&self) -> String {
        match self {
            Blocker::AutoDisabled => "自動が切ってあります（compact_auto = false）".to_string(),
            Blocker::Paused { .. } => "一時停止の期限内です".to_string(),
            Blocker::AliveCards(n) => {
                format!("生きたセッションが {n} 本あります。落とすと道連れになります")
            }
            Blocker::ClaudeRunning(n) => format!("claude が {n} 本走っています"),
            Blocker::ShellOpen(n) => format!("端末が {n} 本開いています"),
            Blocker::NotQuietLongEnough { secs } => {
                format!("静かになってから間がありません（あと {secs} 秒）")
            }
            Blocker::OutsideWindow => "打ってよい時間帯の外です".to_string(),
            Blocker::SlackTooSmall { have, need } => format!(
                "空洞が足りません（{} GiB / 必要 {} GiB）",
                have / GIB,
                need / GIB
            ),
            Blocker::TooSoon { since } => {
                format!("前回の縮小から {} 時間しか経っていません", since / 3600)
            }
        }
    }
}

const GIB: u64 = 1024 * 1024 * 1024;

impl CompactStatus {
    /// **自動で**打ってよいか。打てないなら理由を返す（`None` なら打てる）。
    ///
    /// **純関数。** `&self` と設定と `now` しか見ない。
    ///
    /// 順番には意味がある（設計§2-3）。**人が切ったこと（1・2）を先に言う**——切って
    /// あるのに「空洞が足りない」と言われると、切ったこと自体を忘れる。次に**道連れに
    /// なる本数（3〜5）**、最後に**打てるが値打ちが無い（8・9）**。
    pub fn blocker(&self, cfg: &CompactConfig, now: SystemTime) -> Option<Blocker> {
        if !self.auto_enabled {
            return Some(Blocker::AutoDisabled);
        }
        if let Some(until) = self.paused_until {
            if until > now {
                return Some(Blocker::Paused { until });
            }
        }
        if let Some(blocker) = self.道連れ(false) {
            return Some(blocker);
        }
        let 必要 = cfg.quiet_minutes.saturating_mul(60);
        let 経過 = self
            .quiet_since
            .and_then(|since| now.duration_since(since).ok())
            .map(|d| d.as_secs())
            // 静かになった時刻が無い＝まだ静かではない
            .unwrap_or(0);
        if 経過 < 必要 {
            return Some(Blocker::NotQuietLongEnough {
                secs: 必要 - 経過
            });
        }
        if !self.in_window {
            return Some(Blocker::OutsideWindow);
        }
        let 必要な空洞 = cfg.threshold_gb.saturating_mul(GIB);
        // **読めなかった場合もここで断る。** 空洞が分からないのに打つ理由が無い
        let 空洞 = self.slack_bytes.unwrap_or(0);
        if 空洞 < 必要な空洞 {
            return Some(Blocker::SlackTooSmall {
                have: 空洞,
                need: 必要な空洞,
            });
        }
        if let Some(last) = self.last_compact {
            let 経過 = now.duration_since(last).map(|d| d.as_secs()).unwrap_or(0);
            if 経過 < cfg.min_interval_hours.saturating_mul(3600) {
                return Some(Blocker::TooSoon { since: 経過 });
            }
        }
        None
    }

    /// **人が手で**打ってよいか（`host compact run`）。
    ///
    /// 見るのは**道連れになるもの（①②③）だけ**である。時間帯としきい値は見ない——
    /// 人が押したなら、それは「いま縮めたい」という意思であって、夜まで待つ話ではない。
    ///
    /// `force` が飛ばすのは**①生きたカードだけ**（設計§3-4）。`version restart` から
    /// 借りた語なので、あちらと同じ「道連れを承知で落とす」の意味に揃えてある。
    /// **②③は飛ばさない**——あれはダッシュボードが知らない作業を守るためのものである。
    pub fn manual_blocker(&self, force: bool) -> Option<Blocker> {
        self.道連れ(force)
    }

    /// ①②③（落とすと道連れになるもの）を、決めた順に見る。
    fn 道連れ(&self, force: bool) -> Option<Blocker> {
        if !force && self.alive_cards > 0 {
            return Some(Blocker::AliveCards(self.alive_cards));
        }
        if self.claude_procs > 0 {
            return Some(Blocker::ClaudeRunning(self.claude_procs));
        }
        if self.interactive_shells > 0 {
            return Some(Blocker::ShellOpen(self.interactive_shells));
        }
        None
    }

    /// ①〜③が全部0か。**[`CompactState::quiet_since`] を進めるかどうかの判定。**
    pub fn 静かか(&self) -> bool {
        self.alive_cards == 0 && self.claude_procs == 0 && self.interactive_shells == 0
    }
}

/// 静かさの移り変わりを [`CompactState`] へ写す。**純関数。**
///
/// 静かになった瞬間に時刻を入れ、**1つでも増えたら消す**。消さないと「30分前に
/// 静かだった」という記録だけで打ててしまう。
pub fn 静かさを進める(state: &mut CompactState, 静か: bool, now: SystemTime) {
    if 静か {
        if state.quiet_since.is_none() {
            state.quiet_since = Some(now);
        }
    } else {
        state.quiet_since = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn 設定() -> CompactConfig {
        CompactConfig::default()
    }

    /// 全部通る状態（打てる）。ここから1つずつ崩して確かめる。
    fn 打てる状態(now: SystemTime) -> CompactStatus {
        CompactStatus {
            alive_cards: 0,
            claude_procs: 0,
            interactive_shells: 0,
            quiet_since: Some(now - Duration::from_secs(3600)),
            in_window: true,
            slack_bytes: Some(100 * GIB),
            last_compact: None,
            auto_enabled: true,
            paused_until: None,
        }
    }

    #[test]
    fn 全部そろえば打てる() {
        let now = SystemTime::now();
        assert_eq!(打てる状態(now).blocker(&設定(), now), None);
    }

    #[test]
    fn 窓は日をまたいでも読める() {
        let (開始, 終了) = 窓を読む("22:00-03:00").expect("読めること");
        assert_eq!((開始, 終了), (22 * 60, 3 * 60));
        assert!(窓の中か(23 * 60, 開始, 終了), "23:00 は中");
        assert!(窓の中か(2 * 60, 開始, 終了), "02:00 は中");
        assert!(!窓の中か(12 * 60, 開始, 終了), "12:00 は外");

        let (開始, 終了) = 窓を読む("02:00-05:00").expect("読めること");
        assert!(窓の中か(3 * 60, 開始, 終了), "03:00 は中");
        assert!(!窓の中か(23 * 60, 開始, 終了), "23:00 は外");
    }

    #[test]
    fn 開始と終了が同じ窓は1分も入らない() {
        // **「1日中」と読み違えると、夜を待たずに打ってしまう。**
        let (開始, 終了) = 窓を読む("02:00-02:00").expect("読めること");
        for 分 in [0u16, 1, 119, 120, 121, 1439] {
            assert!(!窓の中か(分, 開始, 終了), "{分} 分が中に入った");
        }
    }

    #[test]
    fn 窓の綴りが壊れていれば読めない() {
        for 綴り in [
            "",
            "02:00",
            "25:00-05:00",
            "02:60-05:00",
            "あ-い",
            "02:00_05:00",
        ] {
            assert_eq!(窓を読む(綴り), None, "{綴り} が読めてしまった");
        }
    }

    #[test]
    fn 生きたカードがあれば打てない() {
        let now = SystemTime::now();
        let mut 状態 = 打てる状態(now);
        状態.alive_cards = 3;
        assert_eq!(状態.blocker(&設定(), now), Some(Blocker::AliveCards(3)));
        assert_eq!(状態.manual_blocker(false), Some(Blocker::AliveCards(3)));
        // **--force が飛ばすのは①だけ**
        assert_eq!(状態.manual_blocker(true), None);
    }

    #[test]
    fn claudeが走っていれば打てない() {
        let now = SystemTime::now();
        let mut 状態 = 打てる状態(now);
        状態.claude_procs = 2;
        assert_eq!(状態.blocker(&設定(), now), Some(Blocker::ClaudeRunning(2)));
        // **--force でも飛ばさない。** ダッシュボードが知らない作業を守るため
        assert_eq!(状態.manual_blocker(true), Some(Blocker::ClaudeRunning(2)));
    }

    #[test]
    fn 端末が開いていれば打てない() {
        let now = SystemTime::now();
        let mut 状態 = 打てる状態(now);
        状態.interactive_shells = 1;
        assert_eq!(状態.blocker(&設定(), now), Some(Blocker::ShellOpen(1)));
        assert_eq!(状態.manual_blocker(true), Some(Blocker::ShellOpen(1)));
    }

    #[test]
    fn 静かになって間もなければ打てない() {
        let now = SystemTime::now();
        let mut 状態 = 打てる状態(now);
        状態.quiet_since = Some(now - Duration::from_secs(60));
        let Some(Blocker::NotQuietLongEnough { secs }) = 状態.blocker(&設定(), now) else {
            panic!("静かさで断られるはず");
        };
        assert_eq!(secs, 30 * 60 - 60, "残りの秒数を返す");

        // 静かになった時刻が無い＝まだ静かではない
        状態.quiet_since = None;
        assert!(matches!(
            状態.blocker(&設定(), now),
            Some(Blocker::NotQuietLongEnough { .. })
        ));
    }

    #[test]
    fn 時間帯の外なら打てない() {
        let now = SystemTime::now();
        let mut 状態 = 打てる状態(now);
        状態.in_window = false;
        assert_eq!(状態.blocker(&設定(), now), Some(Blocker::OutsideWindow));
        // **手で押すときは時間帯を見ない**
        assert_eq!(状態.manual_blocker(false), None);
    }

    #[test]
    fn 空洞がしきい値に足りなければ打てない() {
        let now = SystemTime::now();
        let mut 状態 = 打てる状態(now);
        状態.slack_bytes = Some(10 * GIB);
        assert_eq!(
            状態.blocker(&設定(), now),
            Some(Blocker::SlackTooSmall {
                have: 10 * GIB,
                need: 50 * GIB
            })
        );
    }

    #[test]
    fn 空洞が読めなければ打たない側へ倒れる() {
        // **読めないことを「たぶん大丈夫」と読まない。** 分からないのに打つ理由が無い
        let now = SystemTime::now();
        let mut 状態 = 打てる状態(now);
        状態.slack_bytes = None;
        assert_eq!(
            状態.blocker(&設定(), now),
            Some(Blocker::SlackTooSmall {
                have: 0,
                need: 50 * GIB
            })
        );
    }

    #[test]
    fn 前回から間がなければ打てない() {
        let now = SystemTime::now();
        let mut 状態 = 打てる状態(now);
        状態.last_compact = Some(now - Duration::from_secs(3600));
        assert_eq!(
            状態.blocker(&設定(), now),
            Some(Blocker::TooSoon { since: 3600 })
        );

        // 24時間経てば通る
        状態.last_compact = Some(now - Duration::from_secs(25 * 3600));
        assert_eq!(状態.blocker(&設定(), now), None);
    }

    #[test]
    fn 自動が切ってあれば打てない() {
        let now = SystemTime::now();
        let mut 状態 = 打てる状態(now);
        状態.auto_enabled = false;
        assert_eq!(状態.blocker(&設定(), now), Some(Blocker::AutoDisabled));
        // **手で押す道は塞がない。** 切ってあるのは自動だけ
        assert_eq!(状態.manual_blocker(false), None);
    }

    #[test]
    fn 一時停止の期限内は打てない() {
        let now = SystemTime::now();
        let mut 状態 = 打てる状態(now);
        let until = now + Duration::from_secs(3600);
        状態.paused_until = Some(until);
        assert_eq!(状態.blocker(&設定(), now), Some(Blocker::Paused { until }));

        // 期限を過ぎれば自然に戻る
        状態.paused_until = Some(now - Duration::from_secs(1));
        assert_eq!(状態.blocker(&設定(), now), None);
    }

    #[test]
    fn 打てない理由は決めた順に出る() {
        // **順を変えると3箇所の文言が同時に変わる**ので、ここで固定する
        // （表示・kind=compact_skipped の理由・自動の見送り判定）
        let now = SystemTime::now();
        // 全部の理由が同時に成り立つ状態を作る
        let 全部だめ = CompactStatus {
            alive_cards: 1,
            claude_procs: 1,
            interactive_shells: 1,
            quiet_since: None,
            in_window: false,
            slack_bytes: Some(0),
            last_compact: Some(now),
            auto_enabled: false,
            paused_until: Some(now + Duration::from_secs(60)),
        };
        let 順 = [
            "auto_disabled",
            "paused",
            "alive_cards",
            "claude_running",
            "shell_open",
            "not_quiet_long_enough",
            "outside_window",
            "slack_too_small",
            "too_soon",
        ];
        let mut 状態 = 全部だめ.clone();
        let mut 出た = Vec::new();
        // 先に当たったものから順に1つずつ潰していく
        for _ in 0..順.len() {
            let Some(blocker) = 状態.blocker(&設定(), now) else {
                break;
            };
            出た.push(blocker.理由の名前());
            match blocker {
                Blocker::AutoDisabled => 状態.auto_enabled = true,
                Blocker::Paused { .. } => 状態.paused_until = None,
                Blocker::AliveCards(_) => 状態.alive_cards = 0,
                Blocker::ClaudeRunning(_) => 状態.claude_procs = 0,
                Blocker::ShellOpen(_) => 状態.interactive_shells = 0,
                Blocker::NotQuietLongEnough { .. } => {
                    状態.quiet_since = Some(now - Duration::from_secs(3600))
                }
                Blocker::OutsideWindow => 状態.in_window = true,
                Blocker::SlackTooSmall { .. } => 状態.slack_bytes = Some(100 * GIB),
                Blocker::TooSoon { .. } => 状態.last_compact = None,
            }
        }
        assert_eq!(出た, 順, "打てない理由の順が変わっている");
        assert_eq!(状態.blocker(&設定(), now), None, "全部潰せば打てる");
    }

    #[test]
    fn 空洞は引き算が回り込まない() {
        // 中の使用量が仮想ディスクより大きく見える瞬間がありうる（測る時点がずれる）。
        // 素の引き算だと u64 が回り込んで**巨大な空洞に見え、しきい値を必ず超える**
        let slack = Slack {
            ext4_bytes: 100,
            docker_bytes: 50,
            used_bytes: 200,
        };
        assert_eq!(slack.slack_bytes(), 0, "回り込んでいる");
        assert_eq!(slack.vhdx_bytes(), 150);
    }

    #[test]
    fn 空洞はext4のぶんだけを数える() {
        // `df /` は Docker の仮想ディスクの中を見ていないので、2枚の合計から引くと
        // **Docker のぶんが丸ごと空洞に見える**
        let slack = Slack {
            ext4_bytes: 300 * GIB,
            docker_bytes: 35 * GIB,
            used_bytes: 230 * GIB,
        };
        assert_eq!(slack.slack_bytes(), 70 * GIB);
        assert_eq!(slack.vhdx_bytes(), 335 * GIB);
    }

    #[test]
    fn dfの使用量は3列目を読む() {
        let 出力 = "Filesystem         1B-blocks         Used    Available Use% Mounted on\n\
                    /dev/sdd       1081101176832 261109248000 764999573504  26% /\n";
        assert_eq!(dfの使用量を読む(出力), Some(261_109_248_000));
        // 見出しだけ・空なら読めない
        assert_eq!(dfの使用量を読む("Filesystem 1B-blocks Used\n"), None);
        assert_eq!(dfの使用量を読む(""), None);
    }

    #[test]
    fn 対話シェルはttyを持つものだけ数える() {
        let 出力 = "?        systemd\n\
                    pts/1    bash\n\
                    ?        bash\n\
                    pts/2    zsh\n\
                    pts/3    claude\n\
                    tty1     fish\n";
        // pts/1 の bash・pts/2 の zsh・tty1 の fish の3本。
        // tty を持たない bash と、シェルでない claude は数えない
        assert_eq!(対話シェルを数える(出力), 3);
        assert_eq!(対話シェルを数える(""), 0);
    }

    #[test]
    fn 時刻は分へ直せる() {
        assert_eq!(時刻を分へ("00:00"), Some(0));
        assert_eq!(時刻を分へ("12:32"), Some(12 * 60 + 32));
        assert_eq!(時刻を分へ("23:59"), Some(23 * 60 + 59));
        assert_eq!(時刻を分へ("24:00"), None);
        assert_eq!(時刻を分へ("12:60"), None);
        assert_eq!(時刻を分へ("あ:い"), None);
    }

    #[test]
    fn 静かさは増えた瞬間に消える() {
        let now = SystemTime::now();
        let mut state = CompactState::default();

        静かさを進める(&mut state, true, now);
        assert_eq!(state.quiet_since, Some(now), "静かになった時刻が入る");

        // 続けて静かなら**上書きしない**（数え直すと永久に30分が経たない）
        静かさを進める(&mut state, true, now + Duration::from_secs(600));
        assert_eq!(state.quiet_since, Some(now), "静かなままなら進めない");

        // 1つでも増えたら消す
        静かさを進める(&mut state, false, now + Duration::from_secs(700));
        assert_eq!(state.quiet_since, None, "うるさくなったら消す");
    }

    #[test]
    fn claudeの数え方は名前の完全一致で行う() {
        // **`-f` へ戻すと、②の条件が永久に満たされず自動が一度も走らない。**
        // 落ちないので誰も気づけない——だからここで綴りそのものを見張る
        let mut command = std::process::Command::new("pgrep");
        command.args(["-x", "claude"]);
        let 引数: Vec<String> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(引数.contains(&"-x".to_string()), "-x が要る");
        assert!(!引数.contains(&"-f".to_string()), "-f を使ってはいけない");
        // **15文字を超えると pgrep は必ず0件を返す**（うるさいときでも打ってしまう）
        assert!("claude".len() <= 15, "-x に渡す名前は15文字以内");
    }

    /// 好きな静けさを名乗るだけの口。
    #[derive(Debug)]
    struct 名乗る静けさ {
        claude: Option<usize>,
        shells: Option<usize>,
        分: Option<u16>,
    }

    impl QuietProbe for 名乗る静けさ {
        fn claude_procs(&self) -> Option<usize> {
            self.claude
        }
        fn interactive_shells(&self) -> Option<usize> {
            self.shells
        }
        fn local_minutes(&self) -> Option<u16> {
            self.分
        }
    }

    /// 好きな空洞を名乗るだけの口。**`None` は「読めなかった」。**
    #[derive(Debug)]
    struct 名乗る空洞(Option<Slack>);

    impl SlackProbe for 名乗る空洞 {
        fn read(&self, _ext4: Option<&Path>, _docker: Option<&Path>) -> Option<Slack> {
            self.0
        }
    }

    #[test]
    fn 窓口は差し替えられる() {
        // **差し替えられないと、うるさいときに打たないことを1行も確かめられない**
        let 静けさ = 名乗る静けさ {
            claude: Some(3),
            shells: Some(0),
            分: Some(3 * 60),
        };
        assert_eq!(静けさ.claude_procs(), Some(3));
        assert_eq!(静けさ.local_minutes(), Some(180));

        let 空洞 = 名乗る空洞(Some(Slack {
            ext4_bytes: 300 * GIB,
            docker_bytes: 0,
            used_bytes: 230 * GIB,
        }));
        assert_eq!(
            空洞.read(None, None).map(|s| s.slack_bytes()),
            Some(70 * GIB)
        );

        let 読めない = 名乗る空洞(None);
        assert_eq!(読めない.read(None, None), None);
    }
}
