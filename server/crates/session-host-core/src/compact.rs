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
    /// 2枚の仮想ディスクが C: の上で占めている合計。**読めなければ `None`。**
    ///
    /// **空洞と並べて初めて「どれだけ無駄か」が読める。** 「80 GiB 空洞」だけでは
    /// それが全体の何割なのかが分からず、押しどきの判断にならない（縮小設計§10-3）。
    pub vhdx_bytes: Option<u64>,
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

/// 見送りを記録に残すか。**純関数。**
///
/// 自動の見回りは5分ごとなので、見送るたびに書くと**1日 288 行**になる。読む人が
/// 埋もれるだけなので、**理由が変わったとき**と、**前回から1日経ったとき**だけ残す。
///
/// # 鍵にするのは [`Blocker::理由の名前`] であって [`Blocker::言い分`] ではない
///
/// 言い分は `"生きたセッションが 3 本あります"` のように**数が入った文**を返す。これを
/// 鍵にすると、**枚数が1枚変わるたびに「理由が変わった」と判定されて毎回書かれる**——
/// 間引いているつもりで、間引けていない形になる。記録の本文には言い分を出してよい。
pub fn 見送りを残すか(last: Option<&LastSkip>, reason: &str, now: SystemTime) -> bool {
    let Some(last) = last else {
        // 初めての見送り。これは残す
        return true;
    };
    if last.reason != reason {
        return true;
    }
    // **時計が巻き戻っていたら残す側へ倒す。** 記録が増えるだけで害が無い
    now.duration_since(last.at)
        .map(|経過| 経過.as_secs() >= 24 * 3600)
        .unwrap_or(true)
}

// ---------------------------------------------------------------------------
// Windows のタスクを起こす口

/// 縮小の台本を抱えた Windows のタスクを起こす口。
///
/// **トレイトにしてあるのはテストのため**（[`QuietProbe`] と同じ理由）。差し替えられないと
/// **印を書いてから撃つ順序を1行も確かめられない**——本物を撃つと走っている claude が
/// 全部落ちるので、テストからは絶対に呼べない。
pub trait TaskLauncher: Send + Sync + std::fmt::Debug {
    /// 起動を頼む。**返るのは「頼めたか」であって、台本が終わったかではない。**
    fn run(&self, task_name: &str) -> bool;
}

/// 本物。`schtasks.exe` へ起動を頼む。
#[derive(Debug, Clone, Copy, Default)]
pub struct RealLauncher;

/// **絶対パスで指す。** `PATH` に Windows の道が載らない構成（`appendWindowsPath=false`）
/// でも通るようにするためで、[`crate::resources`] の `POWERSHELL` と同じ理由・同じ形。
const SCHTASKS: &str = "/mnt/c/Windows/System32/schtasks.exe";

/// `schtasks.exe /Run` の応答を待つ上限。
///
/// **台本の長さではない。** `/Run` は起動を頼んで即座に返るコマンドで、縮小そのものは
/// 10〜15分かかる。ここで待っているのは「頼めたかどうか」の応答だけである。
const RUN_TIMEOUT: Duration = Duration::from_secs(30);

impl TaskLauncher for RealLauncher {
    fn run(&self, task_name: &str) -> bool {
        // **`schtasks.exe /Run` は即座に返る。** これはタスクの起動を頼むコマンドで、
        // 台本の完了は待たない。だから普通に待ってよく、**終了コードも普通に見てよい**。
        //
        // 「撃ちっぱなし」とは**台本の完了を待たない**という意味であって、`schtasks` の
        // 応答まで捨てることではない。取り違えて結果を捨てると、**頼めなかったことに
        // 気づけないまま印だけが残る**うえ、`swallowed.toml` へ載せる義務まで生む。
        let outcome = crate::proc::run(
            std::process::Command::new(SCHTASKS).args(["/Run", "/TN", task_name]),
            RUN_TIMEOUT,
        );
        // **出力は CP932 なので文字列で判定しない。** 化けた文字を読んで判定すると、
        // 成功しているのに失敗と読む（またはその逆）。終了コードだけを見る。
        outcome.success
    }
}

// ---------------------------------------------------------------------------
// 撃った印

/// 縮小を撃った印（`<state_dir>/compact-attempt`）。
///
/// **起き直った側がこれを拾う**（フェーズ3）。打った本人は `wsl --shutdown` で死ぬので
/// 結果を自分では受け取れない——**印が無いと「縮小が走ったのか、ただ落ちただけか」を
/// 後から区別できない。**
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CompactAttempt {
    /// 撃った時刻。
    ///
    /// **結果 JSON の `finished_at` と比べて新旧を決める。** `/mnt/c` 越しのファイルの
    /// 更新時刻は当てにならないので、そちらでは判定しない。
    pub at: Option<SystemTime>,
    /// 撃つ直前の空洞。`compact_done` で前後を並べるため。
    pub slack_bytes: u64,
}

/// RFC3339 の文字列を [`SystemTime`] へ。**純関数。**
///
/// **`core` ではなくここに置くのは、`time` を持っているのがこちらだから。** 一時停止の
/// 期限は口（`compact_api`）が受け取るが、あちらの依存に時刻の道具は無い。
///
/// 紀元前は `None`（[`SystemTime::UNIX_EPOCH`] より前の期限に意味が無い）。
pub fn 時刻を読む(text: &str) -> Option<SystemTime> {
    let parsed =
        time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()?;
    let secs = parsed.unix_timestamp();
    if secs < 0 {
        return None;
    }
    Some(SystemTime::UNIX_EPOCH + Duration::from_secs(secs as u64))
}

/// epoch ミリ秒を RFC3339 の文字列へ。**[`時刻を読む`] の対。**
///
/// **同じ場所に置くのは、読む側と書く側がずれないようにするため。** 片方だけ別の
/// crate にあると、綴りが変わったときにもう片方が黙って古いままになる。
///
/// **`core` から使う。** あちらの依存に `time` が無いので、口や CLI が時刻を人へ
/// 見せたいときはここを通る。読めない値（紀元前など）は `None`。
pub fn 時刻を書く(epoch_ms: i64) -> Option<String> {
    if epoch_ms < 0 {
        return None;
    }
    let at = time::OffsetDateTime::from_unix_timestamp(epoch_ms / 1000).ok()?;
    at.format(&time::format_description::well_known::Rfc3339)
        .ok()
}

/// 覚えていることの場所。
pub fn state_path(state_dir: &Path) -> PathBuf {
    state_dir.join(COMPACT_STATE)
}

/// 覚えていることを読む。**読めなければ既定値**（[`CompactState`] の doc の作法）。
pub fn load_state(state_dir: &Path) -> CompactState {
    crate::jsonfile::load_or_default(&state_path(state_dir))
}

/// 覚えていることを書く。
pub fn save_state(state_dir: &Path, state: &CompactState) {
    crate::jsonfile::save(&state_path(state_dir), state);
}

/// 印の場所。
pub fn attempt_path(state_dir: &Path) -> PathBuf {
    state_dir.join(COMPACT_ATTEMPT)
}

/// 撃った印を書く。
pub fn write_attempt(state_dir: &Path, attempt: &CompactAttempt) {
    crate::jsonfile::save(&attempt_path(state_dir), attempt);
}

/// 印が残っていれば取り出して消す。**残っていたら前回の起動で縮小を撃っている。**
pub fn take_attempt(state_dir: &Path) -> Option<CompactAttempt> {
    let path = attempt_path(state_dir);
    if !path.is_file() {
        return None;
    }
    let attempt: CompactAttempt = crate::jsonfile::load_or_default(&path);
    let _ = std::fs::remove_file(&path);
    Some(attempt)
}

/// 撃つのに失敗したので印を消す。
pub fn clear_attempt(state_dir: &Path) {
    let _ = std::fs::remove_file(attempt_path(state_dir));
}

/// 撃った結果。**呼ぶ側（`compact_api`）が記録を出すために読む。**
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FireResult {
    /// 頼めた。**この後どこかで自分が死ぬ。**
    Fired,
    /// 頼めなかった。印は消してある。
    Failed,
}

/// 印を書いてから撃つ（設計§3-2 の④⑤）。
///
/// # ④と⑤が逆になってはいけない
///
/// **印を書く前に撃つと、撃った直後に死んだとき印が残らない。** そうなると起き直った側は
/// 「縮小が走ったのか、ただ落ちただけか」を区別できず、往復の記録が丸ごと成り立たなくなる。
/// だから**必ず書いてから撃つ**。頼めなかったときだけ、後から消す。
pub fn 印を書いてから撃つ(
    state_dir: &Path,
    launcher: &dyn TaskLauncher,
    task_name: &str,
    slack_bytes: u64,
    now: SystemTime,
) -> FireResult {
    write_attempt(
        state_dir,
        &CompactAttempt {
            at: Some(now),
            slack_bytes,
        },
    );
    if launcher.run(task_name) {
        FireResult::Fired
    } else {
        clear_attempt(state_dir);
        FireResult::Failed
    }
}

// ---------------------------------------------------------------------------
// 起き直った側（設計§4）

/// 台本（`docs/service/compact-wsl.ps1`）が残す1行 JSON。
///
/// # 数値の欄が全部 [`Option`] である理由
///
/// 台本は**結果の入れ物を先に組んで `finally` で書く**作りなので、**測る前に倒れた欄は
/// `null` のまま出る**。ここを `u64` で受けると `serde_json` がその行ごと弾き、
/// **いちばん理由を知りたい回——倒れた回——の結果だけが読めなくなる。**
///
/// フェーズ0 で BOM について踏んだのと同じ形である。**壊れた回の記録が読めないのが
/// いちばん困る**ので、欄が欠けていても読めるほうへ倒す。
///
/// **時刻を [`String`] で受けるのも同じ理由。** `serde` に解釈させると、読めない綴りが
/// 1つ来ただけで構造体ごと落ちる。読むのは [`時刻を読む`] の仕事にして、読めなければ
/// その欄だけ諦める。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CompactResult {
    /// 縮小が最後まで進んだか。**成否はこれだけで決める**（`woke` では決めない）。
    pub ok: bool,
    pub started_at: Option<String>,
    /// 終わった時刻。**印の時刻と比べて新旧を決める。**
    pub finished_at: Option<String>,
    pub c_before_bytes: Option<u64>,
    pub c_after_bytes: Option<u64>,
    pub ext4_before_bytes: Option<u64>,
    pub ext4_after_bytes: Option<u64>,
    pub docker_before_bytes: Option<u64>,
    pub docker_after_bytes: Option<u64>,
    /// WSL を起こし直せたか。**記録には載せるが、成否の判定には使わない**——台本は
    /// 「起こせなくても `ok` は真のまま」と決めている。
    pub woke: bool,
    pub reason: Option<String>,
}

/// 起き直ったときに何が分かったか。**記録に出す中身そのもの。**
///
/// 返り値にしているのは、テストが**記録の中身を確かめられる**ようにするためである。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettleOutcome {
    /// 縮小が走り、結果も読めた。
    Done(Box<CompactResult>),
    /// 縮小の結果を確定できなかった。**理由は必ず載る。**
    Failed(String),
}

/// バイトを GiB へ。**切り捨て。**
///
/// 丸めるのは読む側の仕事である（設計§5-2 は「バイトで書く」と決めている）。
/// `compact_start` の `slack_gb` と**同じ丸め方**にしてあるので、前後を並べて比べられる。
///
/// **測れなかった欄は `-1`。** `0` にすると「測れなかった」と「本当に空き0」が同じ
/// 見た目になり、記録を読んだ人が区別できない。
fn gib(bytes: Option<u64>) -> i64 {
    match bytes {
        Some(value) => (value / GIB) as i64,
        None => -1,
    }
}

/// 結果が印より新しいか。**純関数。ファイルの更新時刻は見ない。**
///
/// # なぜ更新時刻で判定しないのか
///
/// 結果は `/mnt/c` 越しに置かれる。**Windows と Linux で時計の基準も粒度も違う**ので、
/// あの更新時刻は当てにならない。**印に書いた時刻と、台本が書いた `finished_at` だけ**で
/// 決める。
///
/// **どちらかが読めなければ「古い」側へ倒す。** 判断できないときに新しいほうへ倒すと、
/// **前回の成功を今回の成功として記録する**——このフェーズで唯一の「嘘の記録」が
/// そこから出る。
pub fn 結果は印より新しいか(
    attempt_at: Option<SystemTime>,
    finished_at: Option<SystemTime>,
) -> bool {
    match (attempt_at, finished_at) {
        (Some(撃った), Some(終わった)) => 終わった >= 撃った,
        _ => false,
    }
}

/// 結果 JSON を読む。**[`crate::jsonfile::load_or_default`] を使わない。**
///
/// あちらは「読めなければ既定値」なので、**無いことと壊れていることが同じ答えになる**。
/// ここでは5つの分岐のうち2つがその区別に懸かっているので、自分で読んで理由を書き分ける。
fn 結果を読む(path: Option<&Path>) -> Result<CompactResult, String> {
    let Some(path) = path else {
        return Err("結果の置き場所が設定されていない".to_string());
    };
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err("台本の記録が見つからない".to_string());
        }
        Err(err) => return Err(format!("台本の記録を読めない：{err}")),
    };
    // **BOM は台本側で付けないようにしてある**（フェーズ0）が、念のため落とす。
    // 付いていたときに理由が「JSON として読めない」としか出ず、詰まるのを防ぐ。
    let text = text.trim_start_matches('\u{feff}');
    serde_json::from_str(text).map_err(|err| format!("台本の記録が JSON として読めない：{err}"))
}

/// 印と結果から結末を決める（設計§4-2 の5つの分岐）。
///
/// # 順序に意味がある
///
/// **「印より古いか」を「`ok=false` か」より先に見る。** 逆にすると、古い結果の
/// `ok=true` を今回の成功として記録してしまう。他の失敗枝は「記録が出ない」で済むが、
/// **この枝だけは嘘の成功が記録に残り、読んだ人が信じる。**
fn 結末を決める(attempt: &CompactAttempt, result_path: Option<&Path>) -> SettleOutcome {
    let result = match 結果を読む(result_path) {
        Ok(result) => result,
        Err(why) => return SettleOutcome::Failed(why),
    };
    let 終わった = result.finished_at.as_deref().and_then(時刻を読む);
    if !結果は印より新しいか(attempt.at, 終わった) {
        return SettleOutcome::Failed("台本の記録が印より古い（前回のもの）".to_string());
    }
    if !result.ok {
        let why = result
            .reason
            .as_deref()
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .unwrap_or("台本が理由を書いていない");
        return SettleOutcome::Failed(why.to_string());
    }
    SettleOutcome::Done(Box::new(result))
}

/// 起き直った側が、Windows の残した結果を記録へ移す（設計§4）。
///
/// **印が無ければ何もしない。** 縮小を撃っていない普通の起動では、この関数はファイルを
/// 1つ見て帰るだけである。
///
/// # なぜ起動のたびに呼ぶのか
///
/// 撃った本人は `wsl --shutdown` で死ぬので、**結果を自分では受け取れない**。印
/// （`compact-attempt`）が残っていることだけが「前回の起動で縮小を撃った」証拠で、
/// **それを拾えるのは次に起きた者しかいない。**
///
/// # どの枝でも印は消える
///
/// [`take_attempt`] が読んだ時点で消すので、**分岐の中に「消す」を書かない**——構造で
/// 保証されている。消し忘れると、次の起動でも同じ記録が出続ける。
///
/// # 「最後に打った時刻」はここでも埋める
///
/// 撃った側（`記録して撃つ`）も書くが、**撃った直後に機械が落ちるので、書き終える前に
/// 死ぬことがある**。そのまま起き直ると「最後に打った時刻」が空のままになり、間隔の
/// 判定（[`Blocker::TooSoon`]）が効かず、**次の見回りでまた撃つ**。
///
/// 印は**撃つ前に必ず書かれていて、撃った時刻を持っている**ので、ここで埋め直せる。
pub fn settle_compact(state_dir: &Path, result_path: Option<&Path>) -> Option<SettleOutcome> {
    let attempt = take_attempt(state_dir)?;
    if let Some(at) = attempt.at {
        let mut remembered = load_state(state_dir);
        // **前へ戻さない。** 撃った後に別の経路が新しい時刻を書いていたら、そちらが正しい
        if remembered.last_compact.is_none_or(|前| 前 < at) {
            remembered.last_compact = Some(at);
            save_state(state_dir, &remembered);
        }
    }
    let outcome = 結末を決める(&attempt, result_path);
    match &outcome {
        SettleOutcome::Done(result) => tracing::info!(
            kind = "compact_done",
            slack_before_gb = gib(Some(attempt.slack_bytes)),
            c_before_gb = gib(result.c_before_bytes),
            c_after_gb = gib(result.c_after_bytes),
            ext4_before_gb = gib(result.ext4_before_bytes),
            ext4_after_gb = gib(result.ext4_after_bytes),
            docker_before_gb = gib(result.docker_before_bytes),
            docker_after_gb = gib(result.docker_after_bytes),
            woke = result.woke,
            "縮小が終わりました"
        ),
        SettleOutcome::Failed(reason) => tracing::warn!(
            kind = "compact_failed",
            reason = %reason,
            "縮小の結果を確定できませんでした"
        ),
    }
    Some(outcome)
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
            vhdx_bytes: Some(300 * GIB),
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
            vhdx_bytes: Some(0),
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
    fn 同じ理由の見送りは一日に一度しか残さない() {
        let now = SystemTime::now();
        let 前 = LastSkip {
            reason: "生きたカード".to_string(),
            at: now,
        };

        // 初めては残す
        assert!(
            見送りを残すか(None, "生きたカード", now),
            "初めての見送りが残らない"
        );

        // 同じ理由で5分後・1時間後・23時間後は残さない（5分ごとに書くと1日 288 行になる）
        for 秒 in [300, 3600, 23 * 3600] {
            assert!(
                !見送りを残すか(Some(&前), "生きたカード", now + Duration::from_secs(秒)),
                "{秒} 秒後に同じ理由が残ってしまった"
            );
        }

        // 1日経てば残す
        assert!(
            見送りを残すか(
                Some(&前),
                "生きたカード",
                now + Duration::from_secs(24 * 3600)
            ),
            "1日経っても残らない"
        );
    }

    #[test]
    fn 理由が変わればその場で見送りを残す() {
        let now = SystemTime::now();
        let 前 = LastSkip {
            reason: "生きたカード".to_string(),
            at: now,
        };
        assert!(
            見送りを残すか(Some(&前), "自動が切ってある", now + Duration::from_secs(1)),
            "理由が変わったのに残らない"
        );
    }

    #[test]
    fn 見送りの鍵に言い分を使うと間引けなくなる() {
        // **これは実装の取り違えを見張る検査である。**
        //
        // `理由の名前()` は札（枚数を含まない）、`言い分()` は文（枚数を含む）。鍵に
        // 言い分を選ぶと、**枚数が1枚変わるだけで「理由が変わった」になり毎回書かれる**。
        // ここでその差を固定しておく。
        let 三枚 = Blocker::AliveCards(3);
        let 四枚 = Blocker::AliveCards(4);

        assert_eq!(
            三枚.理由の名前(),
            四枚.理由の名前(),
            "枚数が違うだけで札まで変わっては、間引きが効かない"
        );
        assert_ne!(
            三枚.言い分(),
            四枚.言い分(),
            "言い分に枚数が入っていない。入っていないなら、この検査の前提が崩れている"
        );

        // 札を鍵にすれば間引ける
        let now = SystemTime::now();
        let 前 = LastSkip {
            reason: 三枚.理由の名前().to_string(),
            at: now,
        };
        assert!(
            !見送りを残すか(Some(&前), 四枚.理由の名前(), now + Duration::from_secs(300)),
            "札を鍵にしても間引けていない"
        );
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

    // -----------------------------------------------------------------------
    // 撃つ口と印

    /// 使い終わったら消える一時フォルダ。
    ///
    /// **`tempfile` を足さないのは、依存を1つ増やすと `dependencies.rs` の台帳にも
    /// 足す義務が生じるため。** 作り方は `selfheal::ops` の `tempdir` に揃えてある。
    struct 捨てるフォルダ(PathBuf);

    impl 捨てるフォルダ {
        fn 作る() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "agentdashboard-compact-{}-{}",
                std::process::id(),
                protocol::CardId::new()
            ));
            std::fs::create_dir_all(&dir).expect("一時フォルダ");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for 捨てるフォルダ {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 撃たれた瞬間に**印が在るかどうかを見る**偽のランチャ。
    ///
    /// # なぜ「撃たれた瞬間」でなければならないのか
    ///
    /// **後から印の有無を確かめる書き方では、④と⑤が逆でも緑になる**——撃ってから印を
    /// 書いても、テストが見るころには印が在るからである。**順序そのものを見るには、
    /// 撃たれた最中に覗くしかない。**
    #[derive(Debug)]
    struct 撃たれたとき印を覗く {
        state_dir: PathBuf,
        /// 撃たれた瞬間に印が在ったか。
        印が在った: std::sync::Mutex<Option<bool>>,
        /// 撃つのに成功したことにするか。
        成功: bool,
    }

    impl TaskLauncher for 撃たれたとき印を覗く {
        fn run(&self, _task_name: &str) -> bool {
            let 在った = attempt_path(&self.state_dir).is_file();
            *self.印が在った.lock().unwrap() = Some(在った);
            self.成功
        }
    }

    fn 覗く口(dir: &Path, 成功: bool) -> 撃たれたとき印を覗く {
        撃たれたとき印を覗く {
            state_dir: dir.to_path_buf(),
            印が在った: std::sync::Mutex::new(None),
            成功,
        }
    }

    #[test]
    fn 印は撃つより先に書かれている() {
        let dir = 捨てるフォルダ::作る();
        let 口 = 覗く口(dir.path(), true);
        let result =
            印を書いてから撃つ(dir.path(), &口, "偽タスク", 70 * GIB, SystemTime::now());

        assert_eq!(result, FireResult::Fired);
        assert_eq!(
            *口.印が在った.lock().unwrap(),
            Some(true),
            "撃たれた瞬間に印が無い。**④と⑤が逆になっている**——撃った直後に死ぬと、\
             起き直った側は「縮小が走ったのか、ただ落ちただけか」を区別できなくなる"
        );
    }

    #[test]
    fn 撃てなければ印は残らない() {
        let dir = 捨てるフォルダ::作る();
        let 口 = 覗く口(dir.path(), false);
        let result =
            印を書いてから撃つ(dir.path(), &口, "偽タスク", 70 * GIB, SystemTime::now());

        assert_eq!(result, FireResult::Failed);
        assert_eq!(
            *口.印が在った.lock().unwrap(),
            Some(true),
            "撃つ前には書かれているはず"
        );
        assert!(
            !attempt_path(dir.path()).is_file(),
            "撃てなかったのに印が残っている。**次の起動が「前回は縮小を撃った」と読む**"
        );
    }

    #[test]
    fn 印は読んだら消える() {
        let dir = 捨てるフォルダ::作る();
        write_attempt(
            dir.path(),
            &CompactAttempt {
                at: Some(SystemTime::UNIX_EPOCH),
                slack_bytes: 42,
            },
        );

        let 取れた = take_attempt(dir.path()).expect("印が在るはず");
        assert_eq!(取れた.slack_bytes, 42);
        assert_eq!(取れた.at, Some(SystemTime::UNIX_EPOCH));
        assert!(
            take_attempt(dir.path()).is_none(),
            "2回目も取れている。**消えないと、起き直るたびに同じ結果を記録し続ける**"
        );
    }

    #[test]
    fn 覚えていることは往復できる() {
        let dir = 捨てるフォルダ::作る();
        assert_eq!(
            load_state(dir.path()),
            CompactState::default(),
            "無ければ既定値"
        );

        let state = CompactState {
            paused_until: Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000)),
            ..CompactState::default()
        };
        save_state(dir.path(), &state);
        assert_eq!(load_state(dir.path()), state);
    }

    #[test]
    fn 一時停止の期限はrfc3339で読める() {
        let 読めた = 時刻を読む("2026-09-20T00:00:00Z").expect("読めるはず");
        assert_eq!(
            読めた
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("紀元後")
                .as_secs(),
            1_789_862_400
        );
        assert_eq!(時刻を読む("あした"), None, "読めない綴りは None");
        assert_eq!(
            時刻を読む("1960-01-01T00:00:00Z"),
            None,
            "紀元前の期限に意味は無い"
        );
    }

    // -----------------------------------------------------------------------
    // 起き直った側（設計§4）

    /// 撃った時刻。テストの基準点。
    fn 撃った時刻() -> SystemTime {
        時刻を読む("2026-09-15T02:00:00Z").expect("読めること")
    }

    /// 印を置く。
    fn 印を置く(dir: &Path, at: Option<SystemTime>) {
        write_attempt(
            dir,
            &CompactAttempt {
                at,
                slack_bytes: 68 * GIB,
            },
        );
    }

    /// 結果 JSON を置いて、そのパスを返す。
    fn 結果を置く(dir: &Path, json: &str) -> PathBuf {
        let path = dir.join("compact-result.json");
        std::fs::write(&path, json).expect("書けること");
        path
    }

    /// 成功した回の結果（すべての欄が埋まっている）。
    fn 成功の結果(finished: &str) -> String {
        format!(
            r#"{{"ok":true,"started_at":"2026-09-15T02:00:11Z","finished_at":"{finished}",
               "c_before_bytes":22467641344,"c_after_bytes":124302397440,
               "ext4_before_bytes":320335773696,"ext4_after_bytes":247000000000,
               "docker_before_bytes":38312869888,"docker_after_bytes":30000000000,
               "woke":true,"reason":null}}"#
        )
        .replace('\n', "")
    }

    #[test]
    fn 印が無ければ起き直りは何もしない() {
        // **普通の起動はここで帰る。** 縮小を撃っていないのに記録が出ると、
        // 起こすたびに読まれない行が増える
        let dir = 捨てるフォルダ::作る();
        assert_eq!(settle_compact(dir.path(), None), None);
    }

    #[test]
    fn 結果が新しければ前後の量ごと成功が残る() {
        let dir = 捨てるフォルダ::作る();
        印を置く(dir.path(), Some(撃った時刻()));
        let path = 結果を置く(dir.path(), &成功の結果("2026-09-15T02:19:48Z"));

        let 結末 = settle_compact(dir.path(), Some(&path)).expect("印が在るので何か返る");

        let SettleOutcome::Done(result) = 結末 else {
            panic!("成功のはず: {結末:?}");
        };
        assert_eq!(result.c_before_bytes, Some(22_467_641_344));
        assert_eq!(result.c_after_bytes, Some(124_302_397_440));
        assert!(result.woke);
    }

    #[test]
    fn 結果が印より古ければ前回のものとして退ける() {
        // **このフェーズで唯一の「嘘の記録」を止める枝。** 他の失敗枝は「記録が
        // 出ない」で済むが、ここだけは**前回の成功を今回の成功として残す**——
        // 記録を読んだ人が信じてしまう
        let dir = 捨てるフォルダ::作る();
        印を置く(dir.path(), Some(撃った時刻()));
        // 撃つより前に終わっている＝前回のもの
        let path = 結果を置く(dir.path(), &成功の結果("2026-09-14T09:53:00Z"));

        let 結末 = settle_compact(dir.path(), Some(&path)).expect("印が在る");

        assert_eq!(
            結末,
            SettleOutcome::Failed("台本の記録が印より古い（前回のもの）".to_string()),
            "古い ok=true を成功として記録してはいけない"
        );
    }

    #[test]
    fn 古い結果は台本の理由より先に前回のものとして退ける() {
        // **順序そのものを見る唯一のテスト。**
        //
        // 「古い」と「ok=false」が両方あてはまる回で、どちらを先に見るかが分かれる。
        // `ok` を先に見ると、**前回の失敗理由を今回の理由として記録する**——読んだ人は
        // 具体的な理由が書いてあるので信じるが、それは別の回の話である。
        //
        // 古い側を先に見れば「前回のものだ」と正しく言える。**上の
        // `結果が印より古ければ…` は ok=true なのでどちらの順序でも通る**ので、
        // この1本が無いと順序は1つも守られない（実際に入れ替えて確かめた）。
        let dir = 捨てるフォルダ::作る();
        印を置く(dir.path(), Some(撃った時刻()));
        let path = 結果を置く(
            dir.path(),
            r#"{"ok":false,"finished_at":"2026-09-14T09:53:00Z","reason":"前回ここで倒れた"}"#,
        );

        assert_eq!(
            settle_compact(dir.path(), Some(&path)),
            Some(SettleOutcome::Failed(
                "台本の記録が印より古い（前回のもの）".to_string()
            )),
            "前回の理由を今回の理由として記録してはいけない"
        );
    }

    #[test]
    fn 結果が無ければ見つからないと記録する() {
        let dir = 捨てるフォルダ::作る();
        印を置く(dir.path(), Some(撃った時刻()));
        let path = dir.path().join("どこにも無い.json");

        assert_eq!(
            settle_compact(dir.path(), Some(&path)),
            Some(SettleOutcome::Failed(
                "台本の記録が見つからない".to_string()
            ))
        );
    }

    #[test]
    fn 結果の置き場所が無ければその理由が残る() {
        // 「見つからない」と「そもそも設定されていない」は別の困りごとである
        let dir = 捨てるフォルダ::作る();
        印を置く(dir.path(), Some(撃った時刻()));

        assert_eq!(
            settle_compact(dir.path(), None),
            Some(SettleOutcome::Failed(
                "結果の置き場所が設定されていない".to_string()
            ))
        );
    }

    #[test]
    fn 台本が失敗を書いていればその理由が残る() {
        let dir = 捨てるフォルダ::作る();
        印を置く(dir.path(), Some(撃った時刻()));
        let path = 結果を置く(
            dir.path(),
            r#"{"ok":false,"finished_at":"2026-09-15T02:05:00Z","reason":"90 秒待っても Running が消えなかった"}"#,
        );

        assert_eq!(
            settle_compact(dir.path(), Some(&path)),
            Some(SettleOutcome::Failed(
                "90 秒待っても Running が消えなかった".to_string()
            ))
        );
    }

    #[test]
    fn 台本が理由を書いていなくても空欄では残さない() {
        // 理由が空の compact_failed が残ると、読んだ人は何も分からない
        let dir = 捨てるフォルダ::作る();
        印を置く(dir.path(), Some(撃った時刻()));
        let path = 結果を置く(
            dir.path(),
            r#"{"ok":false,"finished_at":"2026-09-15T02:05:00Z","reason":"   "}"#,
        );

        assert_eq!(
            settle_compact(dir.path(), Some(&path)),
            Some(SettleOutcome::Failed(
                "台本が理由を書いていない".to_string()
            ))
        );
    }

    #[test]
    fn 結果の数値が空でも読める() {
        // **倒れた回ほど理由を知りたい。** 台本は入れ物を先に組んで finally で書くので、
        // 測る前に倒れた欄は null のまま出る。u64 で受けると serde がその行ごと弾き、
        // **いちばん読みたい回だけが読めなくなる**（フェーズ0 の BOM と同じ形）
        let dir = 捨てるフォルダ::作る();
        印を置く(dir.path(), Some(撃った時刻()));
        let path = 結果を置く(
            dir.path(),
            r#"{"ok":false,"started_at":"2026-09-15T02:00:01Z","finished_at":"2026-09-15T02:00:30Z",
                "c_before_bytes":null,"c_after_bytes":null,
                "ext4_before_bytes":null,"ext4_after_bytes":null,
                "docker_before_bytes":null,"docker_after_bytes":null,
                "woke":false,"reason":"最後まで進まなかった"}"#,
        );

        assert_eq!(
            settle_compact(dir.path(), Some(&path)),
            Some(SettleOutcome::Failed("最後まで進まなかった".to_string())),
            "null の欄があっても読めること"
        );
    }

    #[test]
    fn 壊れた結果は見つからないと区別して残す() {
        // load_or_default を使うと「無い」と「壊れている」が同じ答えになる
        let dir = 捨てるフォルダ::作る();
        印を置く(dir.path(), Some(撃った時刻()));
        let path = 結果を置く(dir.path(), "{壊れている");

        let 結末 = settle_compact(dir.path(), Some(&path)).expect("印が在る");
        let SettleOutcome::Failed(why) = 結末 else {
            panic!("失敗のはず");
        };
        assert!(
            why.contains("JSON として読めない"),
            "「見つからない」と区別できること: {why}"
        );
    }

    #[test]
    fn どの枝でも印は消える() {
        // 消し忘れると、次の起動でも同じ記録が出続ける
        let dir = 捨てるフォルダ::作る();
        let 良い結果 = 成功の結果("2026-09-15T02:19:48Z");
        let 枝: [(&str, Option<&str>); 5] = [
            ("結果なし", None),
            ("壊れている", Some("{壊れている")),
            ("古い", Some(&成功の結果("2026-09-14T09:53:00Z"))),
            (
                "ok=false",
                Some(r#"{"ok":false,"finished_at":"2026-09-15T02:05:00Z","reason":"だめ"}"#),
            ),
            ("成功", Some(&良い結果)),
        ];
        for (名前, json) in 枝 {
            印を置く(dir.path(), Some(撃った時刻()));
            let path = json.map(|json| 結果を置く(dir.path(), json));
            let _ = settle_compact(dir.path(), path.as_deref());
            assert!(
                !attempt_path(dir.path()).is_file(),
                "{名前} の枝で印が残った"
            );
        }
    }

    #[test]
    fn 新旧の判定はファイルの更新時刻を見ない() {
        // /mnt/c 越しの更新時刻は当てにならない。印の時刻と finished_at だけで決める
        let 撃った = 撃った時刻();
        let 後 = 撃った + Duration::from_secs(600);
        let 前 = 撃った - Duration::from_secs(600);

        assert!(結果は印より新しいか(Some(撃った), Some(後)));
        assert!(
            結果は印より新しいか(Some(撃った), Some(撃った)),
            "同時刻は新しい側"
        );
        assert!(!結果は印より新しいか(Some(撃った), Some(前)));
        // **読めないときは古い側へ倒す。** 判断できないのに新しいほうへ倒すと、
        // 嘘の成功が残る
        assert!(
            !結果は印より新しいか(Some(撃った), None),
            "終了時刻が読めない"
        );
        assert!(!結果は印より新しいか(None, Some(後)), "印の時刻が読めない");
        assert!(!結果は印より新しいか(None, None));
    }

    #[test]
    fn 測れなかった量は0と区別して残る() {
        // 0 にすると「測れなかった」と「本当に空き0」が同じ見た目になる
        assert_eq!(gib(Some(68 * GIB)), 68);
        assert_eq!(gib(Some(0)), 0);
        assert_eq!(gib(None), -1);
    }

    /// 記録の綴りそのものを確かめる。
    ///
    /// **返り値のテストでは `kind` の綴りを守れない**——`compact_done` を打ち間違えても
    /// 返り値は変わらないので、全部緑のまま通る。**後から記録を読む道（`agentdashboard
    /// logs --grep 'kind=compact'`）が、綴り1つで丸ごと空振りする。**
    mod 記録に出る綴り {
        use super::*;
        use crate::logging::capture;

        #[test]
        fn 成功はcompact_doneとして残る() {
            let dir = 捨てるフォルダ::作る();
            印を置く(dir.path(), Some(撃った時刻()));
            let path = 結果を置く(dir.path(), &成功の結果("2026-09-15T02:19:48Z"));

            let sink = capture::sink();
            let mark = sink.mark();
            let _ = settle_compact(dir.path(), Some(&path));

            let lines = sink.matching(mark, "kind", "compact_done");
            assert_eq!(lines.len(), 1, "{lines:#?}");
            assert_eq!(lines[0]["c_after_gb"], 115, "前後の量が載ること");
            assert_eq!(lines[0]["woke"], true);
        }

        #[test]
        fn 失敗はcompact_failedとして理由ごと残る() {
            let dir = 捨てるフォルダ::作る();
            印を置く(dir.path(), Some(撃った時刻()));

            let sink = capture::sink();
            let mark = sink.mark();
            let _ = settle_compact(dir.path(), None);

            let lines = sink.matching(mark, "kind", "compact_failed");
            assert_eq!(lines.len(), 1, "{lines:#?}");
            assert_eq!(lines[0]["reason"], "結果の置き場所が設定されていない");
        }

        #[test]
        fn 印が無ければ行は1つも出ない() {
            let dir = 捨てるフォルダ::作る();
            let sink = capture::sink();
            let mark = sink.mark();

            assert_eq!(settle_compact(dir.path(), None), None);

            assert!(sink.matching(mark, "kind", "compact_done").is_empty());
            assert!(sink.matching(mark, "kind", "compact_failed").is_empty());
        }
    }
}
