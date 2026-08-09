//! ログを読む口（設計§11）。
//!
//! `<state_dir>/logs/` に落ちた JSON Lines を、**複数のファイルにまたがって時刻順に
//! 混ぜて**出す。生ファイルは今までどおり `jq` でも読める。
//!
//! # 射程
//!
//! **この口が読めるのは、その機械にあるファイルだけである。** 実配置は3台に分かれて
//! いるので、別の PC のログとサーバのログはここからは見えない（設計§11-4）。
//! `--host` は §13 が入って初めて効く。
//!
//! # 設定を読まない
//!
//! **ログを見たいのは、たいてい設定を触った直後**である。設定が壊れていると読めない口
//! では意味がないので、`Config::load` より前の群に置く（設計§11-2）。引き換えに、設定で
//! 置き場所を移している利用者のログは既定では読めないので `--state-dir` を持たせる。
//!
//! # 実装は1つ
//!
//! `agentdashboard logs` と `agentdashboard-agent logs` は**同じここを呼ぶ**（設計§11-3）。
//! 引数の定義（[`LogsArgs`]）もここに置いてあるので、フラグが2箇所へ写ることがない。

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::config::SessionHostConfig;
use crate::logging;
use crate::redact;

/// `--follow` の見直しの間隔。
const FOLLOW_POLL: Duration = Duration::from_millis(500);

/// 水位の並び。小さいほど詳しい。
const LEVELS: &[&str] = &["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];

/// ログを読む口の引数（設計§11-1）。
///
/// **両方の CLI がこの定義を使う。** 素の struct にして各 CLI へ clap の定義を書くと、
/// 10個のフラグが2箇所へ写り、片方だけが古くなる。
#[derive(clap::Args, Debug, Clone)]
pub struct LogsArgs {
    /// いつから。`90s` `30m` `1h` `2d` か、RFC3339 の絶対時刻。
    #[arg(long, value_name = "期間", default_value = "1h")]
    pub since: String,

    /// この水位以上だけを出す（trace / debug / info / warn / error）。
    #[arg(long, value_name = "水位", default_value = "info")]
    pub level: String,

    /// このセッション（`card_id`）の行だけを出す。
    #[arg(long, value_name = "ID")]
    pub card: Option<String>,

    /// このプロセスの行だけを出す（dashboard / session-host / browser / browser-anon）。
    #[arg(long, value_name = "名前")]
    pub proc: Option<String>,

    /// 出す行を正規表現で絞る。当てる先は整形した1行ぜんぶ。
    #[arg(long, value_name = "正規表現")]
    pub grep: Option<String>,

    /// 元の JSON Lines をそのまま流す。
    #[arg(long)]
    pub json: bool,

    /// 出し切ったあとも追いかける。
    #[arg(long)]
    pub follow: bool,

    /// 置き場所を直接指す。**設定は読まない**ので、移している場合はここで指す。
    #[arg(long, value_name = "PATH")]
    pub state_dir: Option<PathBuf>,

    /// 外へ貼るために伏せる（ホームのパス・利用者名・メール・トークン・ホスト名）。
    #[arg(long)]
    pub sanitize: bool,

    /// 別の PC のログを引く（ダッシュボード側の口だけ・ループバック限定）。
    #[arg(long, value_name = "ID")]
    pub host: Option<String>,
}

impl Default for LogsArgs {
    fn default() -> Self {
        Self {
            since: "1h".to_string(),
            level: "info".to_string(),
            card: None,
            proc: None,
            grep: None,
            json: false,
            follow: false,
            state_dir: None,
            sanitize: false,
            host: None,
        }
    }
}

/// ログを読んで出す。**同期のまま処理する**（非同期ランタイムを立てる理由が無い）。
pub fn run(args: &LogsArgs) -> anyhow::Result<()> {
    if let Some(host) = &args.host {
        // **できないことを、できるように見せない。** 黙って手元のログを出すと、
        // 別の PC を見ているつもりの読み手が、まったく別の機械の行で結論を出す。
        //
        // ここへ来るのはセッションホストの `logs` だけ（ダッシュボード側は `--host` を
        // 見て [`run_remote`] へ分岐する）。**あちらにダッシュボードの REST 口は無い**
        // ——`agent.toml` の `server_url` は外のサーバを指していて、ループバックではない
        anyhow::bail!(
            "別の PC（{host}）のログは、この口からは引けません。\n\
             ダッシュボードを動かしている機械で `agentdashboard logs --host {host}` を叩くか、\n\
             その PC の上で `agentdashboard-agent logs` を叩いてください。"
        );
    }

    let query = Query::build(args)?;
    let dir = logs_dir_for(args);
    let mut out = std::io::stdout().lock();
    let mut stats = Stats::default();

    let mut offsets = drain(&dir, &query, &mut out, &mut stats)?;
    let _ = out.flush();
    stats.report(&dir);

    if args.follow {
        follow(&dir, &query, &mut out, &mut stats, &mut offsets)?;
    }
    Ok(())
}

/// 置き場所を決める。**`Config::load` を通らない**（設計§11-2）。
fn logs_dir_for(args: &LogsArgs) -> PathBuf {
    let config = SessionHostConfig {
        state_dir: args.state_dir.clone(),
        ..Default::default()
    };
    logging::logs_dir(&config)
}

// ---------------------------------------------------------------------------
// 絞り込み
// ---------------------------------------------------------------------------

struct Query {
    /// この文字列より前の `ts` は捨てる。**`ts` は固定幅なので文字列比較で足りる**（§19-9）。
    since: String,
    level: usize,
    card: Option<String>,
    proc: Option<String>,
    grep: Option<regex::Regex>,
    json: bool,
    rules: Option<redact::Rules>,
}

/// CLI の引数を、線に載せる形へ（設計§25-2）。
///
/// **`--since` を解くのはここだけ。** 相対の綴り（`1h`）を線に載せて相手に解かせると、
/// 時計のずれが完全に見えなくなる。こちらの時計で絶対時刻にしてから渡せば、ずれは
/// 「思ったより多い・少ない」という観測できる形で現れる。
///
/// 水位と正規表現は**送る前にこちらでも組んでみる**。相手に断らせると往復1回ぶんの
/// 無駄になるうえ、手元で読むときと同じ言葉で断れない。
fn to_wire(args: &LogsArgs) -> anyhow::Result<protocol::logs::LogQuery> {
    let since = parse_since(&args.since, time::OffsetDateTime::now_utc())?;
    parse_level(&args.level)?;
    if let Some(pattern) = &args.grep {
        regex::Regex::new(pattern)
            .map_err(|err| anyhow::anyhow!("`--grep` の正規表現が読めません：{err}"))?;
    }
    Ok(protocol::logs::LogQuery {
        since,
        level: args.level.clone(),
        card: args.card.clone(),
        proc: args.proc.clone(),
        grep: args.grep.clone(),
        // **`--json` は「読み手が生で見る」ということ。** grep を当てる先はそちらに
        // 合わせないと、`--grep` の意味が構成によって変わる
        grep_on_raw: args.json,
        sanitize: args.sanitize,
    })
}

impl Query {
    fn build(args: &LogsArgs) -> anyhow::Result<Self> {
        let query = Self::from_wire(&to_wire(args)?)?;
        if let Some(rules) = &query.rules
            && rules.is_empty()
        {
            eprintln!(
                "警告：伏せる規則を1つも組み立てられませんでした（ホーム・利用者名・ホスト名のいずれも読めません）。"
            );
        }
        Ok(query)
    }

    /// 線の向こうから来た頼みを、解決済みの条件へ。
    ///
    /// [`to_wire`] と対になっていて、**`--since` はここでは解かない**（もう絶対時刻）。
    fn from_wire(wire: &protocol::logs::LogQuery) -> anyhow::Result<Self> {
        let level = parse_level(&wire.level)?;
        let grep = match &wire.grep {
            Some(pattern) => Some(
                regex::Regex::new(pattern)
                    .map_err(|err| anyhow::anyhow!("`--grep` の正規表現が読めません：{err}"))?,
            ),
            None => None,
        };
        Ok(Self {
            since: wire.since.clone(),
            level,
            card: wire.card.clone(),
            proc: wire.proc.clone(),
            grep,
            json: wire.grep_on_raw,
            // **伏せる規則は「この機械」の環境から組む。** 頼んだ側で組んで
            // こちらの行に当てても、こちらの利用者名もホーム名も規則に入っていない
            rules: wire.sanitize.then(redact::Rules::from_env),
        })
    }

    /// 出す行かどうか。**`--grep` は整形した1行に当てる**ので、ここでは見ない。
    fn keep(&self, line: &Line) -> bool {
        if line.ts.as_str() < self.since.as_str() {
            return false;
        }
        if level_rank(&line.level) < self.level {
            return false;
        }
        if let Some(card) = &self.card
            && line.card_id() != Some(card.as_str())
        {
            return false;
        }
        true
    }
}

/// `90s` / `30m` / `1h` / `2d`、または RFC3339 の絶対時刻を、下限の `ts` 文字列へ直す。
fn parse_since(text: &str, now: time::OffsetDateTime) -> anyhow::Result<String> {
    let text = text.trim();
    if text.is_empty() {
        anyhow::bail!("`--since` が空です");
    }
    if let Some(duration) = parse_duration(text) {
        let at = now
            .checked_sub(duration)
            .ok_or_else(|| anyhow::anyhow!("`--since` が遡りすぎています：{text}"))?;
        return Ok(logging::format_rfc3339_millis(at));
    }
    if let Ok(at) =
        time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
    {
        return Ok(logging::format_rfc3339_millis(
            at.to_offset(time::UtcOffset::UTC),
        ));
    }
    anyhow::bail!(
        "`--since` を読めません：{text}\n\
         `90s` `30m` `1h` `2d` のような長さか、`2026-08-07T12:00:00Z` のような時刻を渡してください。"
    )
}

fn parse_duration(text: &str) -> Option<time::Duration> {
    // **末尾1バイトで割らない。** 日本語は1文字が複数バイトなので、`text.len() - 1` は
    // 文字の途中を指して panic する（`きのう` で実際に落ちた）
    let (boundary, unit) = text.char_indices().next_back()?;
    let value: i64 = text[..boundary].parse().ok()?;
    let seconds: i64 = match unit {
        's' => 1,
        'm' => 60,
        'h' => 60 * 60,
        'd' => 24 * 60 * 60,
        _ => return None,
    };
    value.checked_mul(seconds).map(time::Duration::seconds)
}

fn parse_level(text: &str) -> anyhow::Result<usize> {
    let upper = text.trim().to_ascii_uppercase();
    LEVELS
        .iter()
        .position(|level| *level == upper)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "`--level` を読めません：{text}\n合うのは trace / debug / info / warn / error です。"
            )
        })
}

/// 知らない水位は**いちばん詳しい扱い**にする。捨てるより出すほうが安全側。
fn level_rank(level: &str) -> usize {
    LEVELS.iter().position(|known| *known == level).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 1行
// ---------------------------------------------------------------------------

/// 読み取った1行。**任意欄の型は決め打ちできない**（`%` は文字列、`count = 3` は数）ので
/// [`serde_json::Value`] で受ける。
#[derive(Clone)]
struct Line {
    raw: String,
    ts: String,
    level: String,
    target: String,
    proc: String,
    pid: Option<u64>,
    msg: String,
    extra: Vec<(String, serde_json::Value)>,
    suppressed: Option<u64>,
}

impl Line {
    fn card_id(&self) -> Option<&str> {
        self.extra
            .iter()
            .find(|(name, _)| name == "card_id")
            .and_then(|(_, value)| value.as_str())
    }
}

/// 1行を読む。`ts` を持たないものは読めなかった扱い（マージの鍵が無いため）。
fn parse_line(raw: &str) -> Option<Line> {
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(raw).ok()?;
    let text = |key: &str| -> String {
        map.get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let ts = text("ts");
    if ts.is_empty() {
        return None;
    }
    let extra = map
        .iter()
        .filter(|(name, _)| {
            !matches!(
                name.as_str(),
                "ts" | "level" | "target" | "proc" | "pid" | "run_id" | "msg" | "suppressed"
            )
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    Some(Line {
        raw: raw.to_string(),
        ts,
        level: text("level"),
        target: text("target"),
        proc: text("proc"),
        pid: map.get("pid").and_then(serde_json::Value::as_u64),
        msg: text("msg"),
        extra,
        suppressed: map.get("suppressed").and_then(serde_json::Value::as_u64),
    })
}

/// 人が読む形。機械が読むなら `--json` を使う。
fn render_human(line: &Line) -> String {
    let mut out = String::with_capacity(line.raw.len() + 32);
    out.push_str(&line.ts);
    out.push(' ');
    out.push_str(&format!("{:<5}", line.level));
    out.push(' ');
    out.push_str(&line.proc);
    if let Some(pid) = line.pid {
        out.push('/');
        out.push_str(&pid.to_string());
    }
    out.push(' ');
    out.push_str(&line.target);
    out.push(':');
    out.push(' ');
    out.push_str(&line.msg);
    for (name, value) in &line.extra {
        out.push(' ');
        out.push_str(name);
        out.push('=');
        out.push_str(&render_value(value));
    }
    if let Some(count) = line.suppressed {
        out.push_str(&format!("（他 {count} 件を間引き）"));
    }
    out
}

/// 文字列は引用符を外して出す。人が読む側なので、引用符は雑音にしかならない。
fn render_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// ファイルを混ぜる
// ---------------------------------------------------------------------------

/// ファイル名を `(proc, pid)` へ割る。
///
/// **右から1回で割る。** `session-host` はハイフンを含むので、左から割ると
/// `("session", "host-1234")` になる。
fn split_stem(stem: &str) -> Option<(&str, &str)> {
    let (proc, pid) = stem.rsplit_once('-')?;
    if proc.is_empty() || pid.is_empty() || !pid.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some((proc, pid))
}

/// 読む対象のファイルを、名前順で返す。
///
/// 拾う条件は**掃く側と同じ**（[`logging::parse_log_name`]）。ここがずれると、
/// 掃かれるのに読めないファイルが生まれる。
fn list_log_files(dir: &Path, proc: Option<&str>) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .filter(|entry| {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return false;
            };
            let Some((stem, _)) = logging::parse_log_name(name) else {
                return false;
            };
            match proc {
                // 中身ではなく名前で絞る。1ファイルは1プロセスのものなので、
                // 開かずに済む相手を開かない
                Some(wanted) => split_stem(stem).is_some_and(|(found, _)| found == wanted),
                None => true,
            }
        })
        .map(|entry| entry.path())
        .collect();
    paths.sort();
    paths
}

#[derive(Default)]
struct Stats {
    broken: usize,
    unreadable: Vec<String>,
    leaks: usize,
}

impl Stats {
    /// 別の PC から引いたときの報告。**置き場所の案内は出さない**。
    ///
    /// あちらの置き場所はこちらには無いので、`--state-dir` を案内すると嘘になる
    /// （置き場所が無いことは、答えの側が `NotFound` として言う）。
    fn report_remote(&self) {
        if self.broken > 0 {
            eprintln!("読めない行を {} 行飛ばしました。", self.broken);
        }
        if self.leaks > 0 {
            eprintln!(
                "警告：伏せ切れなかったものが {} 件あります。外へ貼る前に目で確かめてください。",
                self.leaks
            );
        }
    }

    /// **黙って減らさない。** 飛ばした行がある事実は、必ず読み手へ言う。
    fn report(&self, dir: &Path) {
        if self.broken > 0 {
            eprintln!("読めない行を {} 行飛ばしました。", self.broken);
        }
        for path in &self.unreadable {
            eprintln!("開けませんでした：{path}");
        }
        if self.leaks > 0 {
            eprintln!(
                "警告：伏せ切れなかったものが {} 件あります。外へ貼る前に目で確かめてください。",
                self.leaks
            );
        }
        if !dir.exists() {
            // **この口は設定を読まない**（§11-2）ので、設定で置き場所を移していると
            // ここへ来る。実機がまさにそれだった。**答えを知っている口を名指しする**
            // ——`scripts/uninstall.sh` が「置き場所は実行ファイルに聞く」形にしてある
            // のと同じ考えで、こちらが設定を読み始めるより筋がよい
            // **`\` の行継続と全角スペースを混ぜない。** 継続が飛ばすのは ASCII の空白
            // だけなので、続く `　` は本文として残る（意図どおりだが rustc が曖昧だと
            // 警告する）。1つの文字列として書けば迷いようが無い
            eprintln!(
                "ログの置き場所がまだありません：{}\n（一度も起動していないか、設定で置き場所を移しています。\n　この口は設定を読まないので、{}を `--state-dir` へ渡してください）",
                dir.display(),
                where_to_ask()
            );
        }
    }
}

/// 「本当の置き場所をどこで知るか」の案内。**実行ファイルごとに違う。**
///
/// `agentdashboard` には置き場所を答える口（`state-dir`）があるが、
/// **`agentdashboard-agent` には無い**（`hook-post` / `model-post` / `logs` だけ）。
/// 名前を組み立てて `<名前> state-dir` と案内すると、セッションホスト側では
/// **存在しないコマンドを名指しする**ことになる——それは「できないことを、できるように
/// 見せない」に反する。
///
/// なお `agentdashboard state-dir` は `config.toml` を読むので、**セッションホストの
/// 置き場所の答えにはならない**（あちらは `agent.toml`）。名前を借りるだけでも誤り。
fn where_to_ask() -> String {
    let name = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_default();
    if name.ends_with("-agent") {
        "`agent.toml` の `state_dir` が指す場所".to_string()
    } else {
        let name = if name.is_empty() {
            "agentdashboard".to_string()
        } else {
            name
        };
        format!("`{name} state-dir` が答える場所")
    }
}

/// 1つのファイルを頭から読む。**改行で終わっている行だけ**を返す。
struct Source {
    path: PathBuf,
    reader: BufReader<File>,
    offset: u64,
}

impl Source {
    fn open(path: &Path) -> std::io::Result<Self> {
        Ok(Self {
            path: path.to_path_buf(),
            reader: BufReader::new(File::open(path)?),
            offset: 0,
        })
    }

    /// 次に出す1行。読めない行は飛ばして数える。
    fn next_kept(&mut self, query: &Query, stats: &mut Stats) -> Option<Line> {
        loop {
            let mut raw = String::new();
            let read = self.reader.read_line(&mut raw).ok()?;
            if read == 0 {
                return None;
            }
            if !raw.ends_with('\n') {
                // まだ書かれている途中。**位置を進めない**ので、次に呼ばれたときに読み直す
                return None;
            }
            self.offset += read as u64;
            let trimmed = raw.trim_end_matches('\n');
            match parse_line(trimmed) {
                Some(line) => {
                    if query.keep(&line) {
                        return Some(line);
                    }
                }
                None => stats.broken += 1,
            }
        }
    }
}

/// 溜まっているぶんを時刻順に出し切り、ファイルごとの読んだ位置を返す。
///
/// 各ファイルは追記のみなので**すでに `ts` 昇順**である。全部読んでから並べ替えると
/// 上限（`log_max_bytes` の既定は 512 MiB）いっぱいのときに落ちるので、先頭だけを
/// 持つヒープで混ぜる。
fn drain(
    dir: &Path,
    query: &Query,
    out: &mut impl Write,
    stats: &mut Stats,
) -> anyhow::Result<HashMap<PathBuf, u64>> {
    let paths = list_log_files(dir, query.proc.as_deref());
    let mut sources: Vec<Source> = Vec::with_capacity(paths.len());
    for path in &paths {
        match Source::open(path) {
            Ok(source) => sources.push(source),
            Err(err) => stats
                .unreadable
                .push(format!("{}（{err}）", path.display())),
        }
    }

    let mut heads: Vec<Option<Line>> = Vec::with_capacity(sources.len());
    let mut heap: BinaryHeap<Reverse<(String, usize)>> = BinaryHeap::new();
    for (index, source) in sources.iter_mut().enumerate() {
        let head = source.next_kept(query, stats);
        if let Some(line) = &head {
            heap.push(Reverse((line.ts.clone(), index)));
        }
        heads.push(head);
    }

    while let Some(Reverse((_, index))) = heap.pop() {
        let Some(line) = heads[index].take() else {
            continue;
        };
        if !emit(&line, query, out, stats)? {
            // 相手が読むのをやめた（`| head` など）。ここで静かに畳む
            return Ok(offsets_of(&sources));
        }
        let next = sources[index].next_kept(query, stats);
        if let Some(next) = &next {
            heap.push(Reverse((next.ts.clone(), index)));
        }
        heads[index] = next;
    }

    Ok(offsets_of(&sources))
}

fn offsets_of(sources: &[Source]) -> HashMap<PathBuf, u64> {
    sources
        .iter()
        .map(|source| (source.path.clone(), source.offset))
        .collect()
}

/// 中身をそのまま運ぶ欄。**`--sanitize` では中身を落として長さだけ残す。**
///
/// `tail`（端末の末尾400文字。§8-4 の材料）には、利用者が打った指示・開いている
/// ファイル名・パスがそのまま写る。**名指しの規則でも形でも拾えない**ので、欄ごと
/// 落とすしかない。実際、実CLI の失敗メッセージには利用者の表示名とメールアドレスが
/// 写った TUI の画面が丸ごと出ていた。
///
/// 落としたことは長さで示す。**黙って消すと、元から何も無かったのか伏せたのかを
/// 読む側が区別できない**——このイシューが敵にしている無言の欠落そのものになる。
const VERBATIM_FIELDS: &[&str] = &["tail"];

/// 本文をそのまま運ぶ欄の中身を落とす。`--sanitize` のときだけ通る。
fn drop_verbatim(line: &Line) -> Line {
    let mut line = line.clone();
    let mut dropped = false;
    for (name, value) in &mut line.extra {
        if !VERBATIM_FIELDS.contains(&name.as_str()) {
            continue;
        }
        let chars = value.as_str().map_or(0, |text| text.chars().count());
        *value = serde_json::Value::String(format!("（{chars} 文字を伏せました）"));
        dropped = true;
    }
    if dropped {
        // `--json` は `raw` をそのまま流すので、そちらも同じ形へ直す。**片方だけ直すと、
        // 人が読む形では伏せられているのに JSON では素通りする**という一番たちの悪い形になる。
        //
        // **解いて組み立て直さない**（`stamp_host` と同じ作法）。`serde_json` は
        // `preserve_order` 無しでビルドされているので `Map` は `BTreeMap` になり、
        // `to_string()` が**キーをアルファベット順へ並べ替える**。同じファイルを
        // `--json` で2回出したときに `--sanitize` の有無で並びが変わり、差分が取れなくなる
        let mut raw = line.raw.clone();
        let mut 全部置けた = true;
        for (name, replaced) in &line.extra {
            if !VERBATIM_FIELDS.contains(&name.as_str()) {
                continue;
            }
            let Some(text) = replaced.as_str() else {
                continue;
            };
            match replace_string_field(&raw, name, text) {
                Some(next) => raw = next,
                None => 全部置けた = false,
            }
        }
        if 全部置けた {
            line.raw = raw;
        } else if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&line.raw)
            && let Some(object) = value.as_object_mut()
        {
            // **並びが崩れるより、伏せ損ねるほうが困る。** 文字列として置けなかった
            // （欄が無い・値が文字列でない・書式が想定と違う）ときだけここへ落ちる。
            // 自分たちの書き手が出した行では起きないが、**古いファイルや手で書かれた行**
            // には効く
            for (name, replaced) in &line.extra {
                if VERBATIM_FIELDS.contains(&name.as_str()) {
                    object.insert(name.clone(), replaced.clone());
                }
            }
            line.raw = value.to_string();
        }
    }
    line
}

/// JSON 1行の中の `"<name>":"...."` を、文字列として差し替える。
///
/// **解かずに直すためのもの**（理由は [`drop_verbatim`] と [`stamp_host`]）。値の走査は
/// エスケープを尊重する——`\"` で終わったと読み違えると、そこから先が壊れた JSON になる。
///
/// 欄が無い・値が文字列でないときは `None`。**黙って素通しさせない**ために、
/// 呼び出し側が別の手へ落ちられる形にしてある。
fn replace_string_field(raw: &str, name: &str, value: &str) -> Option<String> {
    let key = format!("\"{name}\":");
    let at = raw.find(&key)?;
    let rest = &raw[at + key.len()..];
    let head = rest.len() - rest.trim_start().len();
    let body = &rest[head..];
    if !body.starts_with('"') {
        return None;
    }
    // 開きの `"` の次から、エスケープされていない `"` を探す
    let mut escaped = false;
    let mut end = None;
    for (index, ch) in body.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => {
                end = Some(index);
                break;
            }
            _ => {}
        }
    }
    let end = end?;
    let 置き換え = serde_json::Value::String(value.to_string()).to_string();
    let 前 = &raw[..at + key.len() + head];
    let 後 = &body[end + 1..];
    Some(format!("{前}{置き換え}{後}"))
}

/// 1行を出す。相手が読むのをやめていたら `false`。
fn emit(
    line: &Line,
    query: &Query,
    out: &mut impl Write,
    stats: &mut Stats,
) -> anyhow::Result<bool> {
    let dropped;
    let line = if query.rules.is_some() {
        dropped = drop_verbatim(line);
        &dropped
    } else {
        line
    };
    let text = if query.json {
        line.raw.clone()
    } else {
        render_human(line)
    };
    if let Some(grep) = &query.grep
        && !grep.is_match(&text)
    {
        return Ok(true);
    }
    let text = match &query.rules {
        Some(rules) => {
            let redacted = rules.apply(&text);
            stats.leaks += rules.residue(&redacted).len();
            redacted
        }
        None => text,
    };
    match writeln!(out, "{text}") {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::BrokenPipe => Ok(false),
        Err(err) => Err(err.into()),
    }
}

// ---------------------------------------------------------------------------
// 別の PC のログを引く（ログ設計§25-5）
// ---------------------------------------------------------------------------

/// 答えを待つ上限。
///
/// **`hook_post` の 1 秒を写してはいけない。** サーバ側は PC の答えを5秒待つので、
/// 1秒で切ると**必ず時間切れになる**。
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// 時計のずれを警告する境目（設計§25-4）。
const CLOCK_SKEW: time::Duration = time::Duration::seconds(2);

/// 同じ機械で動いているダッシュボードを通して、別の PC のログを引く。
///
/// # ループバック限定
///
/// 叩くのは `http://127.0.0.1:<port>` だけ。TLS を張らないので**外のサーバへは届かない**
/// ——外を見たいなら、そのサーバの上でこれを叩く。アカウントでログインする形式の
/// サーバでは 401 になるので、そのことを理由として出す。
pub fn run_remote(args: &LogsArgs, port: u16) -> anyhow::Result<()> {
    let host = args
        .host
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("`--host` が要ります"))?;
    if args.follow {
        // **1往復の問答に `--follow` は乗らない。** 黙って1回で終わると
        // 「追いかけているつもりで止まっている」になる
        anyhow::bail!(
            "`--follow` は `--host` と一緒には使えません（別の PC のログは1回ずつ引く形です）。"
        );
    }
    let wire = to_wire(args)?;
    let url = format!(
        "http://127.0.0.1:{port}/api/hosts/{}/logs?{}",
        escape(host),
        query_string(&wire)
    );

    let (status, body) = fetch(&url)?;
    if status != 200 {
        anyhow::bail!("{}", explain(status, host, &body));
    }
    let chunk: protocol::logs::LogChunk = serde_json::from_str(&body)
        .map_err(|err| anyhow::anyhow!("ダッシュボードの答えを読めません：{err}"))?;

    let query = Query::build(args)?;
    let mut out = std::io::stdout().lock();
    let mut stats = Stats::default();
    // 相手側で数えたぶんを、こちらの数え上げへ足し込む。**引いたときだけ黙らない**
    stats.broken += chunk.broken as usize;
    stats.leaks += chunk.leaks as usize;

    for raw in &chunk.lines {
        // **刻んでから解く。** 先に刻めば、人が読む形も `--json` も同じ1本で済む
        let stamped = stamp_host(raw, host);
        let Some(line) = parse_line(&stamped) else {
            stats.broken += 1;
            continue;
        };
        if !emit(&line, &query, &mut out, &mut stats)? {
            break;
        }
    }
    let _ = out.flush();

    if chunk.truncated {
        eprintln!(
            "上限で打ち切りました（{} 行）。続きは `--since` を進めて引いてください。",
            chunk.lines.len()
        );
    }
    if let Some(note) = clock_note(&chunk.host_now, time::OffsetDateTime::now_utc()) {
        eprintln!("{note}");
    }
    stats.report_remote();
    Ok(())
}

/// 時計がずれていたら、そのことを言う（設計§25-4・§18-7）。
///
/// **行の `ts` は書き換えない。** 書き換えると、その PC の上で
/// `agentdashboard-agent logs` を叩いた出力と突き合わせられなくなり、いちばん確かな
/// 相互参照を失う。代わりに**受け取った側の時刻を併記する**——設計§18-7 が
/// 「扱えないなら併記する」としていたものの答えがこれ。
fn clock_note(host_now: &str, local_now: time::OffsetDateTime) -> Option<String> {
    let at = time::OffsetDateTime::parse(host_now, &time::format_description::well_known::Rfc3339)
        .ok()?;
    let skew = at - local_now;
    if skew.abs() <= CLOCK_SKEW {
        return None;
    }
    Some(format!(
        "警告：この PC の時計は {:.0} 秒ずれています（PC={host_now} / こちら={}）。\n\
         混ぜたときの前後関係は当てになりません。",
        skew.as_seconds_f64(),
        logging::format_rfc3339_millis(local_now),
    ))
}

/// 引いた行に「どの機械のものか」を刻む（設計§25-3）。
///
/// **解いて組み立て直さない。** 直すと欄の並びが変わり、同じ行が経路によって別の順で
/// 出ることになる。末尾の `}` の直前へ差し込む。
fn stamp_host(raw: &str, host: &str) -> String {
    let trimmed = raw.trim_end();
    let Some(head) = trimmed.strip_suffix('}') else {
        return raw.to_string();
    };
    if head.trim_end().ends_with('{') {
        // 中身の無い行。刻むと壊れる
        return raw.to_string();
    }
    // 書く側は `logging::RESERVED` で塞いであるが、**古いファイルには効かない**。
    // 綴りを揃えて退避する（落とさずに残す、が RESERVED の約束）
    let head = if head.contains("\"host\":") {
        head.replacen("\"host\":", "\"f_host\":", 1)
    } else {
        head.to_string()
    };
    format!(
        "{head},\"host\":{}}}",
        serde_json::Value::String(host.to_string())
    )
}

/// 絞り込みを URL のクエリへ。
fn query_string(wire: &protocol::logs::LogQuery) -> String {
    let mut parts = vec![
        format!("since={}", escape(&wire.since)),
        format!("level={}", escape(&wire.level)),
    ];
    if let Some(card) = &wire.card {
        parts.push(format!("card={}", escape(card)));
    }
    if let Some(proc) = &wire.proc {
        parts.push(format!("proc={}", escape(proc)));
    }
    if let Some(grep) = &wire.grep {
        parts.push(format!("grep={}", escape(grep)));
    }
    if wire.grep_on_raw {
        parts.push("raw=true".to_string());
    }
    if wire.sanitize {
        parts.push("sanitize=true".to_string());
    }
    parts.join("&")
}

/// URL に載せられる形へ。**予約文字だけを逃がす**（依存を増やさない）。
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// 状態コードを、読み手にできることが分かる言葉へ。
fn explain(status: u16, host: &str, body: &str) -> String {
    let body = body.trim();
    match status {
        // **401 が出るのはアカウント方式のときだけ**（素通しと LAN の合言葉は
        // 127.0.0.1 を免除している）。事実を名指しできる
        401 => "このダッシュボードはアカウントでログインする形式なので、CLI からは引けません。\n                ブラウザで開くか、引きたい PC の上で `agentdashboard-agent logs` を叩いてください。"
            .to_string(),
        404 => format!("PC（{host}）が見つかりません：{body}"),
        409 => format!("PC（{host}）の版が古く、ログを引けません：{body}"),
        504 => format!("PC（{host}）が応じません：{body}"),
        503 => format!("いま PC（{host}）へ届けられません：{body}"),
        400 => format!("頼み方が読めません：{body}"),
        other => format!("ダッシュボードが {other} を返しました：{body}"),
    }
}

/// ループバックのダッシュボードへ1本 GET する。
///
/// [`crate::hook_post::post`] を流用しないのは、あちらの契約が「失敗しても黙る」
/// 「応答を読み捨てる」だからである。こちらは**状態コードと本文の両方が要る**。
fn fetch(url: &str) -> anyhow::Result<(u16, String)> {
    use std::io::{Read as _, Write as _};

    let target = crate::hook_post::parse_url(url)?;
    let address = std::net::ToSocketAddrs::to_socket_addrs(&target.authority)?
        .next()
        .ok_or_else(|| anyhow::anyhow!("接続先を解決できません：{}", target.authority))?;

    let mut stream = std::net::TcpStream::connect_timeout(&address, FETCH_TIMEOUT)
        .map_err(|err| anyhow::anyhow!("ダッシュボードへ繋げません（{err}）。起きていますか？"))?;
    stream.set_write_timeout(Some(FETCH_TIMEOUT))?;
    stream.set_read_timeout(Some(FETCH_TIMEOUT))?;

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        target.path, target.authority,
    );
    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    let text = String::from_utf8_lossy(&response).into_owned();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| anyhow::anyhow!("答えの形が読めません（区切りがありません）"))?;

    let status: u16 = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| anyhow::anyhow!("答えの状態コードを読めません"))?;

    // **`Content-Length` が無ければ断る。** 分割送り（chunked）は読めないので、
    // 黙って長さの行ごと本文として扱うと壊れた JSON を読むことになる。
    // ループバック直結では来ないが、来たときに黙らない
    if !head
        .lines()
        .any(|line| line.to_ascii_lowercase().starts_with("content-length:"))
    {
        anyhow::bail!(
            "答えに `Content-Length` がありません（この口はループバック直結だけを相手にします）。"
        );
    }
    Ok((status, body.to_string()))
}

// ---------------------------------------------------------------------------
// 線の向こうへ渡す形で切り出す（ログ設計§13-1・§25）
// ---------------------------------------------------------------------------

/// 引けなかった理由。[`crate::hostfs::HostFsError`] と同じ形だが、**別の型にしてある**。
///
/// あちらは名前のとおりファイルシステムの話で、ログを混ぜると名前が嘘になる。
/// 運ぶ先（`HostReply::Failed`）が同じなので、写すのは受け口の2行で済む。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogReadError {
    pub reason: protocol::a2s::HostFailure,
    pub detail: String,
}

/// この機械のログを切り出す（設計§13-1）。
///
/// **同期のまま置いてある。** 呼ぶ側（`link.rs`）が `spawn_blocking` へ逃がす——
/// [`crate::hostfs`] と同じ作法で、接続の `select!` ループを塞がないため。
///
/// 絞り込みをこちら側で当てるのは、線の予算（512 KiB）に対してファイルの上限が
/// 512 MiB あるためである。**`--grep` まで当てる**のが要点で、受け取ってから当てると
/// 「一致が少ない」のか「上限で切られた先に在った」のかが読み手から区別できない。
pub fn collect(
    config: &SessionHostConfig,
    wire: &protocol::logs::LogQuery,
) -> Result<protocol::logs::LogChunk, LogReadError> {
    let dir = logging::logs_dir(config);
    if !dir.exists() {
        // **空の答えを返さない。** 「0行だった」と「一度も起動していない・設定で
        // 移している」は別物で、潰すと引いたときだけその区別が消える
        return Err(LogReadError {
            reason: protocol::a2s::HostFailure::NotFound,
            detail: format!(
                "ログの置き場所がありません：{}（一度も起動していないか、設定で置き場所を移しています）",
                dir.display()
            ),
        });
    }
    let query = Query::from_wire(wire).map_err(|err| LogReadError {
        // 頼みが読めないのは実装の食い違い——サーバは投げる前に同じものを組んでいる
        reason: protocol::a2s::HostFailure::Unsupported,
        detail: format!("頼みを読めません：{err}"),
    })?;

    let paths = list_log_files(&dir, query.proc.as_deref());
    let mut stats = Stats::default();
    let mut sources: Vec<Source> = Vec::with_capacity(paths.len());
    for path in &paths {
        match Source::open(path) {
            Ok(source) => sources.push(source),
            // 開けなかったファイルも**黙って落とさない**。数だけは読み手まで運ぶ
            Err(_) => stats.broken += 1,
        }
    }

    // 混ぜ方は `drain` と同じ。全部読んでから並べ替えると上限いっぱいのときに落ちる
    let mut heads: Vec<Option<Line>> = Vec::with_capacity(sources.len());
    let mut heap: BinaryHeap<Reverse<(String, usize)>> = BinaryHeap::new();
    for (index, source) in sources.iter_mut().enumerate() {
        let head = source.next_kept(&query, &mut stats);
        if let Some(line) = &head {
            heap.push(Reverse((line.ts.clone(), index)));
        }
        heads.push(head);
    }

    let mut lines: Vec<String> = Vec::new();
    let mut bytes = 0usize;
    let mut truncated = false;
    while let Some(Reverse((_, index))) = heap.pop() {
        let Some(line) = heads[index].take() else {
            continue;
        };
        if let Some(text) = take_line(&line, &query, &mut stats) {
            // **古いほうから詰めて、上限で止める。** 「更新前を見たい」がいちばんの
            // 動機なので、切るなら新しい側を切る。続きは `--since` を進めて引ける
            if lines.len() >= protocol::logs::MAX_LOG_LINES
                || bytes + text.len() > protocol::logs::MAX_LOG_BYTES
            {
                truncated = true;
                break;
            }
            bytes += text.len();
            lines.push(text);
        }
        let next = sources[index].next_kept(&query, &mut stats);
        if let Some(next) = &next {
            heap.push(Reverse((next.ts.clone(), index)));
        }
        heads[index] = next;
    }

    Ok(protocol::logs::LogChunk {
        // 埋めるのはサーバ。こちらは自分がどの綴りで呼ばれたかを知らない
        host: String::new(),
        host_now: logging::format_rfc3339_millis(time::OffsetDateTime::now_utc()),
        lines,
        truncated,
        broken: stats.broken as u32,
        leaks: stats.leaks as u32,
    })
}

/// 1行を、線に載せる形へ。`--grep` に合わなければ `None`。
///
/// **[`emit`] と同じ順で通す**——伏せるより先に grep を当てる。順が違うと、手元で
/// 読むときと引いて読むときで当たる行が変わる。
fn take_line(line: &Line, query: &Query, stats: &mut Stats) -> Option<String> {
    let dropped;
    let line = if query.rules.is_some() {
        dropped = drop_verbatim(line);
        &dropped
    } else {
        line
    };
    let text = if query.json {
        line.raw.clone()
    } else {
        render_human(line)
    };
    if let Some(grep) = &query.grep
        && !grep.is_match(&text)
    {
        return None;
    }
    // **運ぶのは常に生。** どう出すかを決めるのは読み手なので、ここでは整えない
    Some(match &query.rules {
        Some(rules) => {
            let redacted = rules.apply(&line.raw);
            stats.leaks += rules.residue(&redacted).len();
            redacted
        }
        None => line.raw.clone(),
    })
}

/// 追いかける。**新しく現れたファイルも拾う**（日付が変わるとローテーションで名前が変わる）。
fn follow(
    dir: &Path,
    query: &Query,
    out: &mut impl Write,
    stats: &mut Stats,
    offsets: &mut HashMap<PathBuf, u64>,
) -> anyhow::Result<()> {
    loop {
        std::thread::sleep(FOLLOW_POLL);
        let mut batch: Vec<Line> = Vec::new();
        for path in list_log_files(dir, query.proc.as_deref()) {
            let start = offsets.get(&path).copied().unwrap_or(0);
            let Some((text, consumed)) = read_from(&path, start) else {
                continue;
            };
            if consumed == 0 {
                continue;
            }
            offsets.insert(path.clone(), start + consumed);
            for raw in text.lines() {
                match parse_line(raw) {
                    Some(line) => {
                        if query.keep(&line) {
                            batch.push(line);
                        }
                    }
                    None => stats.broken += 1,
                }
            }
        }
        // 1回ぶんの中では時刻順に揃える。**窓をまたぐ順序までは保証できない**——
        // まだ書かれていない行を待つことはできないため
        batch.sort_by(|left, right| left.ts.cmp(&right.ts));
        for line in &batch {
            if !emit(line, query, out, stats)? {
                return Ok(());
            }
        }
        let _ = out.flush();
    }
}

/// `start` から先の**改行で終わっている範囲**を読む。返すのは `(本文, 進めたバイト数)`。
fn read_from(path: &Path, start: u64) -> Option<(String, u64)> {
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    let end = buf.iter().rposition(|byte| *byte == b'\n')? + 1;
    buf.truncate(end);
    Some((String::from_utf8_lossy(&buf).into_owned(), end as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> time::OffsetDateTime {
        time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
            .expect("読めること")
    }

    fn line(ts: &str, level: &str, msg: &str) -> Line {
        parse_line(&format!(
            r#"{{"ts":"{ts}","level":"{level}","target":"t","proc":"dashboard","pid":1,"run_id":"r","msg":"{msg}"}}"#
        ))
        .expect("読めること")
    }

    mod 絞り込み {
        use super::*;

        #[test]
        fn 長さでも絶対時刻でも下限を作れる() {
            let now = at("2026-08-07T12:00:00Z");
            assert_eq!(parse_since("1h", now).unwrap(), "2026-08-07T11:00:00.000Z");
            assert_eq!(parse_since("90s", now).unwrap(), "2026-08-07T11:58:30.000Z");
            assert_eq!(parse_since("2d", now).unwrap(), "2026-08-05T12:00:00.000Z");
            assert_eq!(
                parse_since("2026-08-01T09:30:00Z", now).unwrap(),
                "2026-08-01T09:30:00.000Z"
            );
        }

        #[test]
        fn 読めない期間は理由を言って断る() {
            let now = at("2026-08-07T12:00:00Z");
            assert!(parse_since("きのう", now).is_err());
            assert!(parse_since("", now).is_err());
            assert!(parse_since("1w", now).is_err());
        }

        #[test]
        fn 水位は大小文字を問わない() {
            assert_eq!(parse_level("info").unwrap(), parse_level("INFO").unwrap());
            assert_eq!(parse_level("Warn").unwrap(), 3);
            assert!(parse_level("しずか").is_err());
        }

        #[test]
        fn 知らない水位の行は捨てない() {
            // 捨てるより出すほうが安全側。読み手が気づける
            assert_eq!(level_rank("FATAL"), 0);
        }

        #[test]
        fn 既定は直近1時間とinfo以上と全プロセス() {
            let args = LogsArgs::default();
            let query = Query::build(&args).expect("組めること");
            assert_eq!(query.level, parse_level("info").unwrap());
            assert!(query.card.is_none());
            assert!(query.proc.is_none());
            assert!(query.rules.is_none());
            // 下限が「いまより1時間前」であること（秒までは揺れるので日付と時までを見る）
            let expected = logging::format_rfc3339_millis(
                time::OffsetDateTime::now_utc() - time::Duration::hours(1),
            );
            assert_eq!(query.since[..13], expected[..13]);
        }

        #[test]
        fn 水位で切る() {
            let args = LogsArgs {
                since: "2026-01-01T00:00:00Z".to_string(),
                level: "warn".to_string(),
                ..Default::default()
            };
            let query = Query::build(&args).expect("組めること");
            assert!(!query.keep(&line("2026-08-07T12:00:00.000Z", "INFO", "a")));
            assert!(query.keep(&line("2026-08-07T12:00:00.000Z", "ERROR", "a")));
        }

        #[test]
        fn 下限より前は捨てる() {
            let args = LogsArgs {
                since: "2026-08-07T12:00:00Z".to_string(),
                level: "trace".to_string(),
                ..Default::default()
            };
            let query = Query::build(&args).expect("組めること");
            assert!(!query.keep(&line("2026-08-07T11:59:59.999Z", "INFO", "a")));
            assert!(query.keep(&line("2026-08-07T12:00:00.000Z", "INFO", "a")));
        }

        #[test]
        fn カードで絞る() {
            let args = LogsArgs {
                since: "2026-01-01T00:00:00Z".to_string(),
                card: Some("abc".to_string()),
                ..Default::default()
            };
            let query = Query::build(&args).expect("組めること");
            let with = parse_line(
                r#"{"ts":"2026-08-07T12:00:00.000Z","level":"INFO","target":"t","proc":"dashboard","pid":1,"run_id":"r","msg":"m","card_id":"abc"}"#,
            )
            .expect("読めること");
            assert!(query.keep(&with));
            assert!(!query.keep(&line("2026-08-07T12:00:00.000Z", "INFO", "m")));
        }
    }

    mod 一行 {
        use super::*;

        #[test]
        fn 七欄と任意欄に割れる() {
            let parsed = parse_line(
                r#"{"ts":"2026-08-07T12:00:00.000Z","level":"WARN","target":"a::b","proc":"session-host","pid":42,"run_id":"r","msg":"本文","card_id":"c1","count":3}"#,
            )
            .expect("読めること");
            assert_eq!(parsed.level, "WARN");
            assert_eq!(parsed.target, "a::b");
            assert_eq!(parsed.proc, "session-host");
            assert_eq!(parsed.pid, Some(42));
            assert_eq!(parsed.msg, "本文");
            assert_eq!(parsed.card_id(), Some("c1"));
            assert_eq!(parsed.extra.len(), 2);
        }

        #[test]
        fn tsを持たない行は読めない扱い() {
            assert!(parse_line(r#"{"level":"INFO"}"#).is_none());
            assert!(parse_line("これは JSON ではない").is_none());
            assert!(parse_line("").is_none());
        }

        #[test]
        fn 人が読む形は引用符を外す() {
            let parsed = parse_line(
                r#"{"ts":"2026-08-07T12:00:00.000Z","level":"INFO","target":"a","proc":"dashboard","pid":7,"run_id":"r","msg":"起こしました","path":"/tmp/x","count":3}"#,
            )
            .expect("読めること");
            let text = render_human(&parsed);
            assert!(text.starts_with("2026-08-07T12:00:00.000Z INFO  dashboard/7 a: 起こしました"));
            assert!(text.contains("path=/tmp/x"), "{text}");
            assert!(text.contains("count=3"), "{text}");
            assert!(!text.contains('"'), "{text}");
        }

        #[test]
        fn 間引いた件数を添える() {
            let parsed = parse_line(
                r#"{"ts":"2026-08-07T12:00:00.000Z","level":"WARN","target":"a","proc":"dashboard","pid":7,"run_id":"r","msg":"m","suppressed":12}"#,
            )
            .expect("読めること");
            assert!(render_human(&parsed).contains("（他 12 件を間引き）"));
        }

        fn 端末の末尾つき() -> Line {
            parse_line(
                r#"{"ts":"2026-08-07T12:00:00.000Z","level":"WARN","target":"a","proc":"dashboard","pid":7,"run_id":"r","msg":"フックが来ません","card_id":"c1","tail":"❯ 秘密の指示を書いた行"}"#,
            )
            .expect("読めること")
        }

        #[test]
        fn 本文を運ぶ欄は中身を落として長さだけ残す() {
            let dropped = drop_verbatim(&端末の末尾つき());
            let text = render_human(&dropped);
            assert!(!text.contains("秘密の指示"), "{text}");
            // **黙って消さない。** 元から無かったのか伏せたのかを読む側が区別できる
            assert!(text.contains("12 文字を伏せました"), "{text}");
            // 他の欄は落とさない——`card_id` が消えると串刺しができなくなる
            assert!(text.contains("card_id=c1"), "{text}");
        }

        #[test]
        fn 生のjsonの側も同じ形へ直す() {
            // 片方だけ直すと、人が読む形では伏せられているのに `--json` では素通りする
            let dropped = drop_verbatim(&端末の末尾つき());
            assert!(!dropped.raw.contains("秘密の指示"), "{}", dropped.raw);
            assert!(dropped.raw.contains("文字を伏せました"), "{}", dropped.raw);
        }

        #[test]
        fn 運ばない欄しか無い行は素通しする() {
            let parsed = parse_line(
                r#"{"ts":"2026-08-07T12:00:00.000Z","level":"INFO","target":"a","proc":"dashboard","pid":7,"run_id":"r","msg":"m","card_id":"c1"}"#,
            )
            .expect("読めること");
            assert_eq!(drop_verbatim(&parsed).raw, parsed.raw);
        }

        /// **伏せても欄の並びが変わらない**（レビュー指摘②）。
        ///
        /// `raw` を `serde_json::Value` へ解いて組み立て直していたころは、`Map` が
        /// `BTreeMap`（`preserve_order` 無し）なのでキーがアルファベット順へ並び替わり、
        /// 同じファイルを `--json` で2回出すと `--sanitize` の有無で順が変わっていた。
        #[test]
        fn 伏せても欄の並びが変わらない() {
            let もと = 端末の末尾つき();
            let dropped = drop_verbatim(&もと);

            let 並び = |raw: &str| -> Vec<String> {
                raw.split(",\"")
                    .skip(1)
                    .filter_map(|part| part.split("\":").next().map(str::to_string))
                    .collect()
            };
            assert_eq!(
                並び(&もと.raw),
                並び(&dropped.raw),
                "伏せる前後で欄の並びが変わっている\n前: {}\n後: {}",
                もと.raw,
                dropped.raw
            );
            // 先頭も動いていないこと（7欄の1つ目は `ts`）
            assert!(dropped.raw.starts_with(r#"{"ts":"#), "{}", dropped.raw);
            // 直したあとも JSON として読める
            serde_json::from_str::<serde_json::Value>(&dropped.raw).expect("JSON として読めること");
        }

        #[test]
        fn 欄の中身を文字列のまま差し替えられる() {
            let raw = r#"{"a":"x","tail":"ふつうの値","b":1}"#;
            let 直した = replace_string_field(raw, "tail", "伏せました").expect("置けること");
            assert_eq!(直した, r#"{"a":"x","tail":"伏せました","b":1}"#);
        }

        #[test]
        fn エスケープを含む値でも終わりを読み違えない() {
            // `\"` を値の終わりと読むと、そこから先が壊れた JSON になる
            let raw = r#"{"tail":"引用 \" と 逆斜線 \\ 入り","b":1}"#;
            let 直した = replace_string_field(raw, "tail", "伏せました").expect("置けること");
            assert_eq!(直した, r#"{"tail":"伏せました","b":1}"#);
            serde_json::from_str::<serde_json::Value>(&直した).expect("JSON として読めること");
        }

        #[test]
        fn 欄が無いか文字列でなければ置かない() {
            assert!(replace_string_field(r#"{"a":1}"#, "tail", "x").is_none());
            // 値が文字列でない行は、この口では扱わない（呼び出し側が別の手へ落ちる）
            assert!(replace_string_field(r#"{"tail":42}"#, "tail", "x").is_none());
        }
    }

    mod 置き場所 {
        use super::*;

        #[test]
        fn 名前は右から割る() {
            assert_eq!(split_stem("dashboard-15588"), Some(("dashboard", "15588")));
            // 左から割ると ("session", "host-1234") になる
            assert_eq!(
                split_stem("session-host-1234"),
                Some(("session-host", "1234"))
            );
            assert_eq!(split_stem("browser-anon-9"), Some(("browser-anon", "9")));
        }

        #[test]
        // 名前に ASCII の大文字を混ぜない（`…はNone` は `non_snake_case` で落ちる）
        fn 割れない名前は割らない() {
            assert_eq!(split_stem("dashboard"), None);
            assert_eq!(split_stem("dashboard-"), None);
            assert_eq!(split_stem("-15588"), None);
            assert_eq!(split_stem("dashboard-abc"), None);
        }

        #[test]
        fn 置き場所は状態の置き場所の下() {
            let dir = std::env::temp_dir().join("agentdashboard-logs-置き場所");
            let args = LogsArgs {
                state_dir: Some(dir.clone()),
                ..Default::default()
            };
            assert_eq!(logs_dir_for(&args), dir.join(logging::LOGS_DIR_NAME));
        }
    }

    mod 混ぜる {
        use super::*;

        fn temp_dir(label: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "agentdashboard-logs-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).expect("作れること");
            dir
        }

        fn record(ts: &str, proc: &str, pid: u32, msg: &str) -> String {
            format!(
                r#"{{"ts":"{ts}","level":"INFO","target":"t","proc":"{proc}","pid":{pid},"run_id":"r","msg":"{msg}"}}"#
            )
        }

        fn query_all() -> Query {
            Query::build(&LogsArgs {
                since: "2026-01-01T00:00:00Z".to_string(),
                level: "trace".to_string(),
                ..Default::default()
            })
            .expect("組めること")
        }

        #[test]
        fn 複数のファイルが時刻順に混ざる() {
            let dir = temp_dir("merge");
            std::fs::write(
                dir.join("dashboard-1.2026-08-07.jsonl"),
                format!(
                    "{}\n{}\n",
                    record("2026-08-07T12:00:00.000Z", "dashboard", 1, "だ1"),
                    record("2026-08-07T12:00:02.000Z", "dashboard", 1, "だ2"),
                ),
            )
            .expect("書けること");
            std::fs::write(
                dir.join("session-host-2.2026-08-07.jsonl"),
                format!(
                    "{}\n{}\n",
                    record("2026-08-07T12:00:01.000Z", "session-host", 2, "せ1"),
                    record("2026-08-07T12:00:03.000Z", "session-host", 2, "せ2"),
                ),
            )
            .expect("書けること");

            let mut out: Vec<u8> = Vec::new();
            let mut stats = Stats::default();
            drain(&dir, &query_all(), &mut out, &mut stats).expect("読めること");
            let text = String::from_utf8(out).expect("UTF-8");
            let order: Vec<&str> = text.lines().map(|line| &line[24..]).collect();
            assert_eq!(order.len(), 4, "{text}");
            assert!(
                text.find("だ1").unwrap() < text.find("せ1").unwrap(),
                "{text}"
            );
            assert!(
                text.find("せ1").unwrap() < text.find("だ2").unwrap(),
                "{text}"
            );
            assert!(
                text.find("だ2").unwrap() < text.find("せ2").unwrap(),
                "{text}"
            );
            assert_eq!(stats.broken, 0);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn 読めない行は飛ばして数える() {
            let dir = temp_dir("broken");
            std::fs::write(
                dir.join("dashboard-1.2026-08-07.jsonl"),
                format!(
                    "こわれている\n{}\n{{\"ts\":\n",
                    record("2026-08-07T12:00:00.000Z", "dashboard", 1, "生きている"),
                ),
            )
            .expect("書けること");

            let mut out: Vec<u8> = Vec::new();
            let mut stats = Stats::default();
            drain(&dir, &query_all(), &mut out, &mut stats).expect("読めること");
            let text = String::from_utf8(out).expect("UTF-8");
            assert!(text.contains("生きている"), "{text}");
            assert_eq!(text.lines().count(), 1, "{text}");
            assert_eq!(stats.broken, 2);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn 書きかけの行は出さない() {
            let dir = temp_dir("partial");
            let 完成 = record("2026-08-07T12:00:00.000Z", "dashboard", 1, "完成");
            let 途中 = record("2026-08-07T12:00:01.000Z", "dashboard", 1, "途中");
            std::fs::write(
                dir.join("dashboard-1.2026-08-07.jsonl"),
                format!("{完成}\n{途中}"),
            )
            .expect("書けること");

            let mut out: Vec<u8> = Vec::new();
            let mut stats = Stats::default();
            let offsets = drain(&dir, &query_all(), &mut out, &mut stats).expect("読めること");
            let text = String::from_utf8(out).expect("UTF-8");
            assert!(text.contains("完成"), "{text}");
            assert!(!text.contains("途中"), "{text}");
            // **位置は改行までしか進まない。** 書きかけの行を消費してしまうと、
            // 書き終わったときに二度と読まれない
            assert_eq!(
                offsets.values().copied().next(),
                Some(完成.len() as u64 + 1)
            );
            assert_eq!(stats.broken, 0, "書きかけは壊れた行ではない");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn プロセスで絞ると相手のファイルを開かない() {
            let dir = temp_dir("proc");
            std::fs::write(
                dir.join("dashboard-1.2026-08-07.jsonl"),
                format!(
                    "{}\n",
                    record("2026-08-07T12:00:00.000Z", "dashboard", 1, "だ")
                ),
            )
            .expect("書けること");
            std::fs::write(
                dir.join("session-host-2.2026-08-07.jsonl"),
                format!(
                    "{}\n",
                    record("2026-08-07T12:00:01.000Z", "session-host", 2, "せ")
                ),
            )
            .expect("書けること");

            let picked = list_log_files(&dir, Some("session-host"));
            assert_eq!(picked.len(), 1, "{picked:?}");
            assert!(picked[0].to_string_lossy().contains("session-host-2"));
            assert_eq!(list_log_files(&dir, None).len(), 2);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn 見覚えのない名前は読まない() {
            let dir = temp_dir("names");
            for name in [
                "dashboard-1.2026-08-07.jsonl",
                "dashboard-1.jsonl",
                "note.txt",
                "dashboard-1.2026-13-07.jsonl",
                "dashboard.db",
            ] {
                std::fs::write(dir.join(name), "{}\n").expect("書けること");
            }
            assert_eq!(list_log_files(&dir, None).len(), 1);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn jsonは元の行をそのまま流す() {
            let dir = temp_dir("json");
            let raw = record("2026-08-07T12:00:00.000Z", "dashboard", 1, "そのまま");
            std::fs::write(dir.join("dashboard-1.2026-08-07.jsonl"), format!("{raw}\n"))
                .expect("書けること");

            let query = Query::build(&LogsArgs {
                since: "2026-01-01T00:00:00Z".to_string(),
                level: "trace".to_string(),
                json: true,
                ..Default::default()
            })
            .expect("組めること");
            let mut out: Vec<u8> = Vec::new();
            let mut stats = Stats::default();
            drain(&dir, &query, &mut out, &mut stats).expect("読めること");
            assert_eq!(String::from_utf8(out).expect("UTF-8"), format!("{raw}\n"));
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn grepは整形した行に当たる() {
            let dir = temp_dir("grep");
            std::fs::write(
                dir.join("dashboard-1.2026-08-07.jsonl"),
                format!(
                    "{}\n{}\n",
                    record("2026-08-07T12:00:00.000Z", "dashboard", 1, "あたり"),
                    record("2026-08-07T12:00:01.000Z", "dashboard", 1, "はずれ"),
                ),
            )
            .expect("書けること");

            let query = Query::build(&LogsArgs {
                since: "2026-01-01T00:00:00Z".to_string(),
                level: "trace".to_string(),
                grep: Some("あた.".to_string()),
                ..Default::default()
            })
            .expect("組めること");
            let mut out: Vec<u8> = Vec::new();
            let mut stats = Stats::default();
            drain(&dir, &query, &mut out, &mut stats).expect("読めること");
            let text = String::from_utf8(out).expect("UTF-8");
            assert!(text.contains("あたり"), "{text}");
            assert!(!text.contains("はずれ"), "{text}");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn 置き場所が無くても落ちない() {
            let dir = temp_dir("missing").join("まだ無い");
            let mut out: Vec<u8> = Vec::new();
            let mut stats = Stats::default();
            drain(&dir, &query_all(), &mut out, &mut stats).expect("落ちないこと");
            assert!(out.is_empty());
        }
    }

    /// 線の向こうへ渡す形で切り出す（ログ設計§13-1・§25）。
    mod 切り出す {
        use super::*;

        fn temp_dir(label: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "agentdashboard-collect-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).expect("作れること");
            dir
        }

        fn config_at(dir: &Path) -> SessionHostConfig {
            // `logs_dir` は `<state_dir>/logs` を返すので、親を渡す
            SessionHostConfig {
                state_dir: Some(dir.to_path_buf()),
                ..Default::default()
            }
        }

        /// `<state_dir>/logs/` を作って、行を書く。
        fn place(state: &Path, name: &str, body: &str) {
            let dir = state.join("logs");
            std::fs::create_dir_all(&dir).expect("作れること");
            std::fs::write(dir.join(name), body).expect("書けること");
        }

        fn wire() -> protocol::logs::LogQuery {
            protocol::logs::LogQuery {
                since: "2026-01-01T00:00:00.000Z".to_string(),
                level: "TRACE".to_string(),
                card: None,
                proc: None,
                grep: None,
                grep_on_raw: false,
                sanitize: false,
            }
        }

        fn record(ts: &str, msg: &str) -> String {
            format!(
                r#"{{"ts":"{ts}","level":"INFO","target":"t","proc":"session-host","pid":9,"run_id":"r","msg":"{msg}"}}"#
            )
        }

        #[test]
        fn 置き場所が無ければ理由つきで断る() {
            // **空の答えを返さない。** 「0行だった」と「一度も起動していない」は別物で、
            // 潰すと引いたときだけその区別が消える
            let dir = temp_dir("missing");
            let err = collect(&config_at(&dir), &wire()).expect_err("断ること");
            assert_eq!(err.reason, protocol::a2s::HostFailure::NotFound);
            assert!(err.detail.contains("置き場所がありません"), "{err:?}");
        }

        #[test]
        fn 運ぶのは生の行であって整えたものではない() {
            // 解いて組み立て直すと欄の並びが変わる（設計§25-1）。**そのまま運ぶ**
            let dir = temp_dir("raw");
            let one = record("2026-08-08T00:00:00.000Z", "ひとつめ");
            place(&dir, "session-host-9.2026-08-08.jsonl", &format!("{one}\n"));

            let chunk = collect(&config_at(&dir), &wire()).expect("読めること");
            assert_eq!(chunk.lines, vec![one]);
            // 埋めるのはサーバ。PC は自分がどう呼ばれたかを知らない
            assert_eq!(chunk.host, "");
            assert!(!chunk.host_now.is_empty());
            assert!(chunk.host_now.ends_with('Z'), "{}", chunk.host_now);
            assert!(!chunk.truncated);
        }

        #[test]
        fn 上限を超えると古いほうを残して打ち切る() {
            // 「更新前を見たい」がいちばんの動機なので、切るなら新しい側を切る
            let dir = temp_dir("limit");
            let mut body = String::new();
            for index in 0..(protocol::logs::MAX_LOG_LINES + 10) {
                body.push_str(&record(
                    &format!("2026-08-08T00:00:{:02}.{:03}Z", index / 1000, index % 1000),
                    &format!("行{index}"),
                ));
                body.push('\n');
            }
            place(&dir, "session-host-9.2026-08-08.jsonl", &body);

            let chunk = collect(&config_at(&dir), &wire()).expect("読めること");
            assert!(chunk.truncated, "打ち切ったことが載ること");
            assert_eq!(chunk.lines.len(), protocol::logs::MAX_LOG_LINES);
            assert!(chunk.lines[0].contains("行0"), "古いほうが残ること");
        }

        #[test]
        fn grepの当て先は頼みで決まる() {
            // `run_id` は人が読む形には出ない欄。**生に当てるかどうかで結果が変わる**
            let dir = temp_dir("grep");
            place(
                &dir,
                "session-host-9.2026-08-08.jsonl",
                &format!("{}\n", record("2026-08-08T00:00:00.000Z", "ふつうの本文")),
            );
            let config = config_at(&dir);

            let on_raw = protocol::logs::LogQuery {
                grep: Some("run_id".to_string()),
                grep_on_raw: true,
                ..wire()
            };
            assert_eq!(
                collect(&config, &on_raw).expect("読めること").lines.len(),
                1
            );

            let on_human = protocol::logs::LogQuery {
                grep_on_raw: false,
                ..on_raw
            };
            assert!(
                collect(&config, &on_human)
                    .expect("読めること")
                    .lines
                    .is_empty(),
                "人が読む形には run_id が出ない"
            );
        }

        #[test]
        fn 伏せるときは本文をそのまま運ぶ欄が落ちる() {
            // `tail`（端末の末尾）は名指しの規則でも形でも拾えないので欄ごと落とす。
            // **`--json` で流れるのは生の行**なので、そちらも直っていないと素通しになる
            let dir = temp_dir("sanitize");
            place(
                &dir,
                "session-host-9.2026-08-08.jsonl",
                r#"{"ts":"2026-08-08T00:00:00.000Z","level":"WARN","target":"t","proc":"session-host","pid":9,"run_id":"r","msg":"m","tail":"利用者の画面がそのまま写る"}
"#,
            );
            let config = config_at(&dir);

            let asked = protocol::logs::LogQuery {
                sanitize: true,
                ..wire()
            };
            let chunk = collect(&config, &asked).expect("読めること");
            let line = &chunk.lines[0];
            assert!(!line.contains("利用者の画面がそのまま写る"), "{line}");
            assert!(line.contains("文字を伏せました"), "{line}");

            // 頼まなければ伏せない（手元の道具として、原因究明に要るものを既定で落とさない）
            let plain = collect(&config, &wire()).expect("読めること");
            assert!(plain.lines[0].contains("利用者の画面がそのまま写る"));
        }

        #[test]
        fn 読めない行は数えて運ぶ() {
            // **引いたときだけ黙らない。** 手元では「N 行飛ばしました」と必ず言う
            let dir = temp_dir("broken");
            place(
                &dir,
                "session-host-9.2026-08-08.jsonl",
                &format!(
                    "これはJSONではない\n{}\n",
                    record("2026-08-08T00:00:00.000Z", "よめる")
                ),
            );
            let chunk = collect(&config_at(&dir), &wire()).expect("読めること");
            assert_eq!(chunk.lines.len(), 1);
            assert_eq!(chunk.broken, 1);
        }
    }
}
