//! ログの出力層（ログ設計§4）。
//!
//! **購読者を組むのはここ1箇所だけ。** 他のクレートは `tracing` のマクロを呼ぶだけで、
//! どこへどんな形で出るかを知らない。`core`（ローカルモードとサーバ）と `session-host`
//! （PC 側）の両方がこのクレートへ依存しているので、ここに置ける。
//!
//! # 層は2本で、フィルタは別々
//!
//! ```text
//! tracing の購読者
//!  ├─ 端末層   … 人間向けテキスト。RUST_LOG に従う（既定 info）。出力先は stderr
//!  └─ ファイル層 … JSON Lines。log_file_level に従う（既定 debug）
//!       └─ 間引き（§6-3）
//! ```
//!
//! `RUST_LOG` は1本しかないので、分けておかないと「詳しく出したくて `RUST_LOG=debug`
//! にしたら端末が読めなくなった」になる。
//!
//! # 端末層が stderr なのは、消す道のため
//!
//! `scripts/uninstall.sh` は `agentdashboard state-dir` の**標準出力の1行目をそのまま
//! 消す対象**にする。stdout のままだと、誰かが入口の先頭で [`install`] を呼んだ瞬間に
//! 1行目がログの1行になり、**何も消さずに正常終了する**（設計§5-2）。
//!
//! # 触るときの約束
//!
//! - **[`Guard`] を捨ててはいけない。** 非ブロッキング書き込みは、この見張り役が落ちる
//!   ときにまとめて書き出す。忘れると 200行のうち **0行**しか残らない（§19-2 で実測）
//! - **ファイル層へ書くのは fmt 層だけ。** 生の `writeln!` を混ぜると
//!   [`ErrorCounter::dropped_lines`] の単位（1イベント＝1回の `write`）が壊れる
//! - **この中で `tracing::` を呼んではいけない**（購読者への再入になる）。言えなかった
//!   ことは溜めておき、組み終わってから吐く

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Metadata, Subscriber};
use tracing_appender::non_blocking::{ErrorCounter, NonBlocking, WorkerGuard};
use tracing_subscriber::layer::{Context, Filter, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer, fmt};

use crate::config::{DEFAULT_LOG_FILE_LEVEL, SessionHostConfig};

/// ログの置き場所。`<state_dir>/logs/`（設計§3-1）。
///
/// **消す道（`scripts/uninstall.sh` / `.ps1`）が同じ名前を持っている。** 食い違って
/// いないことは `crates/dist/tests/uninstall.rs` が機械で見る。
pub const LOGS_DIR_NAME: &str = "logs";

/// ファイルの拡張子。1行1レコードの JSON なので `jsonl`。
const FILE_SUFFIX: &str = "jsonl";

/// 間引きの窓（設計§19-6）。
///
/// 通常運転では**どの窓を選んでもほとんど何も間引かれない**（同一鍵の連続間隔の
/// 中央値は 2,229 秒）。この値が相手にするのは画面フレーム1枚ごとの警告で、
/// 12セッション61fps なら毎秒 732 行になる。60秒まで伸ばすとセッションホストの
/// 再接続ループが削られはじめる——**あれは雑音ではなく症状**なので削ってはいけない。
const DEDUP_WINDOW: Duration = Duration::from_secs(5);

/// 間引きの鍵に使う本文の長さ（**文字数**。設計§19-6）。
///
/// 長くするほど衝突は減るが、32文字以上では ID が鍵の中へ入り込んで
/// **間引きたい相手ほど鍵が割れる**という逆向きの壊れ方をする。
const DEDUP_MSG_CHARS: usize = 24;

/// 溜め込みを防ぐ掃除の間隔（この回数の `admit` ごとに1回）。
const DEDUP_SWEEP_EVERY: u64 = 1024;

/// 捨てた件数を見に行く間隔。
///
/// **通知の仕組みは無いのでポーリングしかない**（§19-2）。短くすると見張り自体が
/// 常駐の tick になるので、「取りこぼしに気づく」に足りる長さにする。
const DROP_POLL: Duration = Duration::from_secs(60);

/// ファイル層で既定で落とす第三者クレート。
///
/// **`EnvFilter` のターゲット照合は `starts_with` で `::` の境界を見ない。** そこから
/// 2つの罠が出るので、両方をここで潰してある。
///
/// - `sea_orm=warn` は `sea_orm_migration` も飲む（移行の記録が黙って消える）。
///   **より長い指定が勝つ**ので `sea_orm_migration=info` を並べて救う
/// - `tungstenite=warn` は `tokio_tungstenite` を拾わない。両方書く
const THIRD_PARTY_QUIET: &[&str] = &[
    "hyper=warn",
    "hyper_util=warn",
    "h2=warn",
    "tungstenite=warn",
    "tokio_tungstenite=warn",
    "sea_orm=warn",
    "sea_orm_migration=info",
    "sqlx=warn",
    "rustls=warn",
    "mio=warn",
];

/// 7欄と衝突する名前。イベント側が同じ名前のフィールドを持っていたら改名して残す。
const RESERVED: &[&str] = &[
    "ts",
    "level",
    "target",
    "proc",
    "pid",
    "run_id",
    "msg",
    "suppressed",
];

/// どのプロセスが書いたか（設計§2-1 の `proc` 欄）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Proc {
    /// ダッシュボードサーバ。ローカルモードでは PC 側もここへ混ざる（設計§1-1）。
    Dashboard,
    /// セッションホスト（`agentdashboard-agent`）。
    SessionHost,
}

impl Proc {
    pub fn as_str(self) -> &'static str {
        match self {
            Proc::Dashboard => "dashboard",
            Proc::SessionHost => "session-host",
        }
    }
}

/// プロセスの起動ごとに1つ振る識別子（設計§2-2）。
///
/// **`pid` は OS が再利用する。** 同じ番号の別のプロセスと取り違えると原因追跡が
/// 丸ごと空振りするので、「あの起動のとき」を1語で引ける値を別に持つ。
pub fn run_id() -> &'static str {
    static RUN_ID: OnceLock<String> = OnceLock::new();
    RUN_ID.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

/// ログの置き場所を返す。**新しい場所の決め方を作らない**（設計§3-1）。
pub fn logs_dir(config: &SessionHostConfig) -> PathBuf {
    config.resolved_state_dir().join(LOGS_DIR_NAME)
}

/// ファイル名の日付より前の部分（設計§19-3 の読み替え）。
///
/// ローテーションの区切りは `.` に固定されていて、日付は prefix と suffix の**間**に
/// しか入らない。したがって設計§3-2 の `<proc>-<日付>-<pid>` は作れず、
/// **`<proc>-<pid>.<日付>.jsonl`** になる。
pub fn file_stem(proc: Proc, pid: u32) -> String {
    format!("{}-{pid}", proc.as_str())
}

// ---------------------------------------------------------------------------
// 1行の形（設計§2）
// ---------------------------------------------------------------------------

/// 1行の固定部分。プロセスの間ずっと変わらない。
#[derive(Debug, Clone)]
struct Origin {
    proc: &'static str,
    pid: u32,
    run_id: &'static str,
}

/// イベントから集めたもの。
#[derive(Debug, Default)]
struct EventFields {
    msg: String,
    extra: Vec<(String, serde_json::Value)>,
}

impl EventFields {
    fn put(&mut self, field: &Field, value: serde_json::Value) {
        self.put_named(field.name(), value);
    }

    /// 名前で受ける口。`Field` はテストから組み立てられないので、判断はこちらに置く。
    fn put_named(&mut self, name: &str, value: serde_json::Value) {
        if name == "message" {
            self.msg = match value {
                serde_json::Value::String(text) => text,
                other => other.to_string(),
            };
            return;
        }
        // 7欄を壊さない。落とさずに改名して残す
        let key = if RESERVED.contains(&name) {
            format!("f_{name}")
        } else {
            name.to_string()
        };
        self.extra.push((key, value));
    }

    fn card_id(&self) -> Option<&str> {
        self.extra
            .iter()
            .find(|(key, _)| key == "card_id")
            .and_then(|(_, value)| value.as_str())
    }
}

impl Visit for EventFields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, serde_json::Value::from(value));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, serde_json::Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, serde_json::Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, serde_json::Value::from(value));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.put(field, serde_json::Value::from(value));
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.put(field, serde_json::Value::from(value.to_string()));
    }

    /// **ここが本命。** `%`（Display）も `?`（Debug）も、そして `message` も
    /// この口を通る。`%` の実体は `format_args!` なので、`{:?}` で出しても
    /// **引用符の付かない素の文字列**になる。
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.put(field, serde_json::Value::from(format!("{value:?}")));
    }
}

/// 1行を組む。**7欄を書いた順に出す。**
///
/// `serde_json::Map` を使わないのは、既定が `BTreeMap` で**キーが辞書順へ並び替わる**
/// ため。`SerializeMap` を直に使えば書いた順がそのまま出る。
fn render_line(
    origin: &Origin,
    ts: &str,
    level: &str,
    target: &str,
    fields: &EventFields,
    suppressed: Option<u64>,
) -> Result<String, serde_json::Error> {
    use serde::ser::{SerializeMap, Serializer};

    let mut buf: Vec<u8> = Vec::with_capacity(256);
    {
        let mut ser = serde_json::Serializer::new(&mut buf);
        let mut map = ser.serialize_map(None)?;
        map.serialize_entry("ts", ts)?;
        map.serialize_entry("level", level)?;
        map.serialize_entry("target", target)?;
        map.serialize_entry("proc", origin.proc)?;
        map.serialize_entry("pid", &origin.pid)?;
        map.serialize_entry("run_id", origin.run_id)?;
        map.serialize_entry("msg", &fields.msg)?;
        for (name, value) in &fields.extra {
            map.serialize_entry(name, value)?;
        }
        if let Some(count) = suppressed {
            map.serialize_entry("suppressed", &count)?;
        }
        map.end()?;
    }
    buf.push(b'\n');
    // serde_json は UTF-8 しか書かない
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// RFC3339・ミリ秒まで・UTC（設計§2-1）。
///
/// 固定幅・0埋め・常に `Z` なので、**文字列のまま並べ替えて時刻順になる**。
/// 段2 の時刻順マージがこれに乗る。
fn now_rfc3339_millis() -> String {
    format_rfc3339_millis(time::OffsetDateTime::now_utc())
}

fn format_rfc3339_millis(at: time::OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond(),
    )
}

// ---------------------------------------------------------------------------
// 間引き（設計§6-3・§19-6）
// ---------------------------------------------------------------------------

/// 間引きの鍵。
///
/// `card_id` が入っているのが設計§6-3 からの読み替え（§19-6）。無いと
/// **別のセッションで起きた同じ事象が同じ鍵へ落ちる**——12本走っているときに
/// 11本ぶんが間引かれ、しかも `suppressed` からは「どのカードのぶんが消えたか」が
/// 分からない。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DedupKey {
    target: &'static str,
    level: Level,
    card_id: Option<String>,
    head: String,
}

impl DedupKey {
    fn new(target: &'static str, level: Level, card_id: Option<&str>, msg: &str) -> Self {
        Self {
            target,
            level,
            card_id: card_id.map(str::to_owned),
            head: head_of(msg),
        }
    }
}

/// 本文の先頭を**文字数**で切る。
///
/// **`&msg[..24]` と書いてはいけない。** 本文は日本語で1文字3バイトなので、
/// バイト添字は文字境界で panic する。
fn head_of(msg: &str) -> String {
    msg.chars().take(DEDUP_MSG_CHARS).collect()
}

#[derive(Debug)]
struct Entry {
    last_pass: Instant,
    pending: u64,
}

/// 間引きの帳簿。
///
/// **`pending` を 0 へ戻すのは整形器だけ**、というのが約束の要。フィルタが通した
/// のに整形器へ届かなかった場合でも件数は残り、**次に通る同じ鍵の行に載る**。
/// 件数は遅れることはあっても消えない——「黙って減らさない」を経路の性質として満たす。
#[derive(Debug, Default)]
struct Dedup {
    entries: Mutex<HashMap<DedupKey, Entry>>,
    admits: Mutex<u64>,
}

impl Dedup {
    /// ロックが毒されてもプロセスを落とさない。
    ///
    /// ログの内部状態が壊れただけでアプリが死ぬのは本末転倒。
    fn lock(&self) -> MutexGuard<'_, HashMap<DedupKey, Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 通すかどうかを決め、通さないぶんは数える。
    fn admit(&self, key: &DedupKey, now: Instant) -> bool {
        let mut entries = self.lock();
        let passed = match entries.get_mut(key) {
            Some(entry) if now.saturating_duration_since(entry.last_pass) < DEDUP_WINDOW => {
                entry.pending += 1;
                false
            }
            Some(entry) => {
                entry.last_pass = now;
                true
            }
            None => {
                entries.insert(
                    key.clone(),
                    Entry {
                        last_pass: now,
                        pending: 0,
                    },
                );
                true
            }
        };

        let mut admits = self
            .admits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *admits = admits.wrapping_add(1);
        if *admits % DEDUP_SWEEP_EVERY == 0 {
            drop(admits);
            evict_stale(&mut entries, now);
        }
        passed
    }

    /// 間引いた件数を取り出して 0 へ戻す。**整形器だけが呼ぶ。**
    fn take_suppressed(&self, key: &DedupKey) -> Option<u64> {
        let mut entries = self.lock();
        let entry = entries.get_mut(key)?;
        (entry.pending > 0).then(|| std::mem::take(&mut entry.pending))
    }
}

/// 鍵の種類が増え続けないように古いものを落とす。
///
/// **`pending > 0` のものは絶対に落とさない。** 落とした瞬間に「黙って減らす」になる。
fn evict_stale(entries: &mut HashMap<DedupKey, Entry>, now: Instant) {
    entries.retain(|_, entry| {
        entry.pending > 0 || now.saturating_duration_since(entry.last_pass) < DEDUP_WINDOW * 10
    });
}

/// 鍵だけを拾う軽い訪問者。間引かれる行はこちらで終わる。
#[derive(Debug, Default)]
struct KeyVisitor {
    msg: String,
    card_id: Option<String>,
}

impl Visit for KeyVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "card_id" {
            self.card_id = Some(value.to_owned());
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "message" if self.msg.chars().count() < DEDUP_MSG_CHARS => {
                self.msg = format!("{value:?}");
            }
            "card_id" => self.card_id = Some(format!("{value:?}")),
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// 層
// ---------------------------------------------------------------------------

/// ファイル層の整形器（設計§19-4）。
///
/// `fmt().json()` を使わないのは、あちらのキー名が `timestamp` / `fields.message` で
/// **固定されていて、変える公開 API が無い**ため（フェーズ0 で実測）。
struct JsonFormat {
    origin: Arc<Origin>,
    dedup: Arc<Dedup>,
}

impl<S, N> fmt::FormatEvent<S, N> for JsonFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> fmt::FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        _ctx: &fmt::FmtContext<'_, S, N>,
        mut writer: fmt::format::Writer<'_>,
        event: &Event<'_>,
    ) -> std::fmt::Result {
        let meta = event.metadata();
        let mut fields = EventFields::default();
        event.record(&mut fields);

        let key = DedupKey::new(meta.target(), *meta.level(), fields.card_id(), &fields.msg);
        let suppressed = self.dedup.take_suppressed(&key);

        let line = render_line(
            &self.origin,
            &now_rfc3339_millis(),
            meta.level().as_str(),
            meta.target(),
            &fields,
            suppressed,
        )
        // 返せる型が `fmt::Error` しかないので理由は消える。ここが無音になることは
        // 設計§9-2（ログ書き込み自体の失敗は出さない）と整合するので受け入れる
        .map_err(|_| std::fmt::Error)?;

        writer.write_str(&line)
    }
}

/// ファイル層のフィルタ。水位の判定と間引きを1つにまとめてある。
///
/// **`impl Layer for 自作層 { fn event_enabled }` と書いてはいけない。** あちらは
/// `Layered` が AND で短絡合成するので、`false` を返すと**端末層まで消える**。
/// `with_filter` 経由なら、飛ぶのは包んだ層の `on_event` だけになる。
struct FileFilter {
    env: EnvFilter,
    dedup: Arc<Dedup>,
}

impl<S> Filter<S> for FileFilter
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn enabled(&self, meta: &Metadata<'_>, cx: &Context<'_, S>) -> bool {
        Filter::<S>::enabled(&self.env, meta, cx)
    }

    fn callsite_enabled(&self, meta: &'static Metadata<'static>) -> tracing::subscriber::Interest {
        Filter::<S>::callsite_enabled(&self.env, meta)
    }

    fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
        Filter::<S>::max_level_hint(&self.env)
    }

    fn event_enabled(&self, event: &Event<'_>, _cx: &Context<'_, S>) -> bool {
        let mut visitor = KeyVisitor::default();
        event.record(&mut visitor);
        let meta = event.metadata();
        let key = DedupKey::new(
            meta.target(),
            *meta.level(),
            visitor.card_id.as_deref(),
            &visitor.msg,
        );
        self.dedup.admit(&key, Instant::now())
    }
}

/// 端末層のフィルタ。**既存2箇所と挙動を1文字も変えない。**
fn terminal_filter() -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
}

/// ファイル層のフィルタの指定文字列を組む。
fn file_filter_directives(level: &str) -> String {
    let mut directives = String::from(level);
    for quiet in THIRD_PARTY_QUIET {
        directives.push(',');
        directives.push_str(quiet);
    }
    directives
}

/// 設定の綴りが読めなければ既定へ落とし、**落としたことを言う**。
///
/// **`EnvFilter::try_new` は綴り間違いを弾かない。** 裸の語は「そういう名前の
/// ターゲット」として解釈されるので、`log_file_level = "debgu"` は
/// エラーにならず、**そのターゲットだけを通す指定**になる——結果としてファイル層が
/// 静かに沈黙する。黙って落ちるのはこのイシューの敵なので、**レベルとして
/// 読めることを先に確かめる**。
fn file_filter(level: &str) -> (EnvFilter, Option<String>) {
    let trimmed = level.trim();
    // **空文字は `ERROR` として読めてしまう**（`LevelFilter` の `FromStr` が
    // `target=` のような書き方のために持っている扱い）。設定が空なのは書き忘れなので、
    // 「ほぼ何も残らないレベル」へ静かに落ちるのではなく、断って既定へ戻す
    if trimmed.is_empty()
        || trimmed
            .parse::<tracing::level_filters::LevelFilter>()
            .is_err()
    {
        return (
            EnvFilter::new(file_filter_directives(DEFAULT_LOG_FILE_LEVEL)),
            Some(format!(
                "log_file_level をレベルとして読めません（{level}）。\
                 {DEFAULT_LOG_FILE_LEVEL} として扱います（off / error / warn / info / debug / trace のいずれか）"
            )),
        );
    }
    match EnvFilter::try_new(file_filter_directives(trimmed)) {
        Ok(filter) => (filter, None),
        Err(err) => (
            EnvFilter::new(file_filter_directives(DEFAULT_LOG_FILE_LEVEL)),
            Some(format!(
                "ファイル層のフィルタを組めません（{level}）: {err}。\
                 {DEFAULT_LOG_FILE_LEVEL} として扱います"
            )),
        ),
    }
}

// ---------------------------------------------------------------------------
// 保持（設計§6-2）
// ---------------------------------------------------------------------------

/// `sweep` の結果。組み終わってから吐くために持ち回る。
#[derive(Debug, Default)]
struct SweepOutcome {
    removed: usize,
    freed: u64,
    over_budget: bool,
    failures: Vec<String>,
}

/// ファイル名を `(stem, 日付)` へ分解する。合わない名前は `None`。
fn parse_log_name(name: &str) -> Option<(&str, time::Date)> {
    let rest = name.strip_suffix(&format!(".{FILE_SUFFIX}"))?;
    let (stem, date) = rest.rsplit_once('.')?;
    if stem.is_empty() {
        return None;
    }
    let mut parts = date.splitn(3, '-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u8 = parts.next()?.parse().ok()?;
    let day: u8 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let month = time::Month::try_from(month).ok()?;
    time::Date::from_calendar_date(year, month, day)
        .ok()
        .map(|date| (stem, date))
}

/// 古いものと溢れたぶんを片付ける。**起動時に1回だけ呼ぶ。**
///
/// **今日の日付のファイルは、どの経路でも消さない。** ローテーションの判定は
/// `write()` の中で行われるので（§19-3）、日付が変わったあと生きている書き手が
/// 昨日の名前のファイルへ書くことは無い。つまり**いま誰かが書きうるのは今日の
/// 名前のものだけ**で、そこを避ければ同じ機械で2つ動いていても踏まない。
fn sweep(dir: &Path, retention_days: u64, max_bytes: u64) -> SweepOutcome {
    sweep_at(dir, time::OffsetDateTime::now_utc().date(), retention_days, max_bytes)
}

fn sweep_at(dir: &Path, today: time::Date, retention_days: u64, max_bytes: u64) -> SweepOutcome {
    let mut outcome = SweepOutcome::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return outcome;
    };

    // 見覚えのある名前だけを候補にする。合わないものには何があっても触らない
    let mut candidates: Vec<(time::Date, Option<std::time::SystemTime>, String, PathBuf, u64)> =
        Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some((_, date)) = parse_log_name(name) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        candidates.push((date, meta.modified().ok(), name.to_owned(), path, meta.len()));
    }

    // 古い順。日付 → 同日は更新時刻 → それも取れなければ名前
    candidates.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });

    let today_julian = today.to_julian_day();
    let retention = i32::try_from(retention_days).unwrap_or(i32::MAX);
    let mut remaining: Vec<usize> = Vec::new();
    let mut total: u64 = 0;

    for (index, (date, _, _, path, size)) in candidates.iter().enumerate() {
        // 今日のぶんは誰かが開いているかもしれない。数には入れるが消さない
        let removable = *date < today;
        let too_old = removable && today_julian.saturating_sub(date.to_julian_day()) > retention;
        if too_old {
            remove_one(path, *size, &mut outcome);
            continue;
        }
        total = total.saturating_add(*size);
        if removable {
            remaining.push(index);
        }
    }

    // 合計が上限を超えていたら、古い順に消す
    let mut cursor = 0;
    while total > max_bytes {
        let Some(&index) = remaining.get(cursor) else {
            outcome.over_budget = true;
            break;
        };
        cursor += 1;
        let (_, _, _, path, size) = &candidates[index];
        if remove_one(path, *size, &mut outcome) {
            total = total.saturating_sub(*size);
        }
    }

    outcome
}

fn remove_one(path: &Path, size: u64, outcome: &mut SweepOutcome) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => {
            outcome.removed += 1;
            outcome.freed = outcome.freed.saturating_add(size);
            true
        }
        Err(err) => {
            // 握り潰さない。組み終わってから吐く
            outcome
                .failures
                .push(format!("{}: {err}", path.display()));
            false
        }
    }
}

// ---------------------------------------------------------------------------
// 組み立てと差し込み
// ---------------------------------------------------------------------------

/// 非ブロッキング書き込みの見張り役。**落とすと書き終わる前に消える。**
#[must_use = "落とすと書き終わる前にプロセスが終わりうる（実測：200行のうち0行）"]
pub struct Guard {
    worker: Option<WorkerGuard>,
    watch: Option<tokio::task::JoinHandle<()>>,
    counter: Option<ErrorCounter>,
    path: Option<PathBuf>,
}

impl Guard {
    /// このプロセスが書いているファイル。組めなかったときは `None`。
    pub fn log_path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(watch) = self.watch.take() {
            watch.abort();
        }
        // 見張りが最後に見た数を残す。この時点で購読者はまだ生きているが、
        // 詰まっている最中はこの1行自体が捨てられうるので stderr にも出す
        if let Some(counter) = self.counter.take() {
            let dropped = counter.dropped_lines();
            if dropped > 0 {
                eprintln!("ログの取りこぼし（合計 {dropped} 行）");
            }
        }
        drop(self.worker.take());
    }
}

/// 組み立てた層と、組む前に言えなかったこと。
struct Built {
    layer: Option<Box<dyn Layer<tracing_subscriber::Registry> + Send + Sync>>,
    guard: Guard,
    complaints: Vec<String>,
}

/// ファイル層を組む。**`.init()` は呼ばない**（テストから叩けるようにするため）。
fn build_file_layer(proc: Proc, config: &SessionHostConfig) -> Built {
    let mut complaints = Vec::new();
    let dir = logs_dir(config);
    let pid = std::process::id();

    if let Err(err) = std::fs::create_dir_all(&dir) {
        complaints.push(format!(
            "ログの置き場所を作れません（{}）: {err}。ファイルへは残りません",
            dir.display()
        ));
        return Built {
            layer: None,
            guard: Guard {
                worker: None,
                watch: None,
                counter: None,
                path: None,
            },
            complaints,
        };
    }

    // **appender を作る前に掃く。** 逆にすると自分がいま開いた口を消しうる
    let outcome = sweep(&dir, config.log_retention_days, config.log_max_bytes);
    if outcome.removed > 0 {
        complaints.push(format!(
            "古いログを {} 件消しました（{} バイト）",
            outcome.removed, outcome.freed
        ));
    }
    if outcome.over_budget {
        complaints.push(format!(
            "ログの合計が上限（{} バイト）を超えていますが、今日ぶんしか残っていないので消せません",
            config.log_max_bytes
        ));
    }
    for failure in outcome.failures {
        complaints.push(format!("古いログを消せません: {failure}"));
    }

    let stem = file_stem(proc, pid);
    let appender = match tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix(&stem)
        .filename_suffix(FILE_SUFFIX)
        .build(&dir)
    {
        Ok(appender) => appender,
        Err(err) => {
            complaints.push(format!(
                "ログのファイルを開けません（{}）: {err}。ファイルへは残りません",
                dir.display()
            ));
            return Built {
                layer: None,
                guard: Guard {
                    worker: None,
                    watch: None,
                    counter: None,
                    path: None,
                },
                complaints,
            };
        }
    };

    let (writer, worker) = NonBlocking::new(appender);
    let counter = writer.error_counter();

    let (env, complaint) = file_filter(&config.log_file_level);
    if let Some(complaint) = complaint {
        complaints.push(complaint);
    }

    let origin = Arc::new(Origin {
        proc: proc.as_str(),
        pid,
        run_id: run_id(),
    });
    let dedup = Arc::new(Dedup::default());

    let layer = fmt::layer()
        .event_format(JsonFormat {
            origin,
            dedup: Arc::clone(&dedup),
        })
        .with_ansi(false)
        // ログ書き込み自体の失敗は出さない（設計§9-2。無限再帰になる）
        .log_internal_errors(false)
        .with_writer(writer)
        .with_filter(FileFilter { env, dedup });

    Built {
        layer: Some(Box::new(layer)),
        guard: Guard {
            worker: Some(worker),
            watch: None,
            counter: Some(counter),
            path: Some(dir.join(format!("{stem}.<日付>.{FILE_SUFFIX}"))),
        },
        complaints,
    }
}

/// ログの出力層を組む。
///
/// **返り値を落としてはいけない。** `let _ = install(..)` と書くと即座にドロップされ、
/// 1行も残らない（§19-2 で実測）。`let _log = install(..)` にすること。
pub fn install(proc: Proc, config: &SessionHostConfig) -> Guard {
    let mut built = build_file_layer(proc, config);
    let layer = built.layer.take();
    let path = built.guard.log_path().map(Path::to_path_buf);

    // **ファイル層を先に重ねる。** 箱に入れた層は `Layer<Registry>` として型が
    // 決まっているので、後ろに置くと相手が `Layered<..>` になって噛み合わない。
    // 端末層は型推論で相手に合わせられるので、こちらを後ろにする
    let terminal = fmt::layer()
        .with_writer(std::io::stderr)
        .with_filter(terminal_filter());

    tracing_subscriber::registry()
        .with(layer)
        .with(terminal)
        .init();

    // ここから先は tracing が使える。組む前に言えなかったことを吐く
    for complaint in &built.complaints {
        tracing::warn!("{complaint}");
    }

    if let Some(counter) = built.guard.counter.clone() {
        built.guard.watch = spawn_drop_watch(counter);
    }

    match &path {
        Some(path) => tracing::info!(
            run_id = run_id(),
            proc = proc.as_str(),
            pid = std::process::id(),
            path = %path.display(),
            "ログを開始しました"
        ),
        None => tracing::error!(
            run_id = run_id(),
            proc = proc.as_str(),
            "ログをファイルへ残せません。端末にだけ出します"
        ),
    }

    built.guard
}

/// 捨てた件数を見に行く（設計§19-2）。
///
/// **通知の仕組みは無いのでポーリングしかない。** ランタイムの外で呼ばれても
/// 落ちないように守る——見張りが付かないだけで、起動は続ける。
fn spawn_drop_watch(counter: ErrorCounter) -> Option<tokio::task::JoinHandle<()>> {
    let handle = tokio::runtime::Handle::try_current().ok()?;
    Some(handle.spawn(async move {
        let mut last = 0usize;
        let mut tick = tokio::time::interval(DROP_POLL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let now = counter.dropped_lines();
            if now > last {
                tracing::warn!(
                    dropped = now - last,
                    dropped_total = now,
                    "ログの書き出しが追いつかず取りこぼしました"
                );
                last = now;
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> Origin {
        Origin {
            proc: "dashboard",
            pid: 4242,
            run_id: "9f2c",
        }
    }

    fn fields(msg: &str, extra: &[(&str, serde_json::Value)]) -> EventFields {
        EventFields {
            msg: msg.to_owned(),
            extra: extra
                .iter()
                .map(|(name, value)| ((*name).to_owned(), value.clone()))
                .collect(),
        }
    }

    fn parse(line: &str) -> serde_json::Value {
        assert!(line.ends_with('\n'), "行が改行で終わっていない");
        assert_eq!(line.matches('\n').count(), 1, "1行に収まっていない");
        serde_json::from_str(line.trim_end()).expect("JSON として読めること")
    }

    mod 一行の形 {
        use super::*;

        #[test]
        fn 必須の7欄がすべて載る() {
            let line = render_line(
                &origin(),
                "2026-08-07T12:34:56.789Z",
                "WARN",
                "session_host_core::parser",
                &fields("パーサへ履歴の監視を頼みました", &[]),
                None,
            )
            .unwrap();
            let value = parse(&line);
            assert_eq!(value["ts"], "2026-08-07T12:34:56.789Z");
            assert_eq!(value["level"], "WARN");
            assert_eq!(value["target"], "session_host_core::parser");
            assert_eq!(value["proc"], "dashboard");
            assert_eq!(value["pid"], 4242);
            assert_eq!(value["run_id"], "9f2c");
            assert_eq!(value["msg"], "パーサへ履歴の監視を頼みました");
        }

        #[test]
        fn 欄は書いた順に出て辞書順へ並び替わらない() {
            // serde_json::Map（BTreeMap）を使うとここが辞書順になる
            let line = render_line(&origin(), "t", "INFO", "x", &fields("本文", &[]), None).unwrap();
            let head: Vec<&str> = line
                .trim_start_matches('{')
                .split(',')
                .filter_map(|part| part.split(':').next())
                .map(|key| key.trim_matches('"'))
                .take(7)
                .collect();
            assert_eq!(
                head,
                ["ts", "level", "target", "proc", "pid", "run_id", "msg"]
            );
        }

        #[test]
        fn 本文に改行があっても行が割れない() {
            let line = render_line(
                &origin(),
                "t",
                "INFO",
                "x",
                &fields("1行目\n2行目\n3行目", &[]),
                None,
            )
            .unwrap();
            let value = parse(&line);
            assert_eq!(value["msg"], "1行目\n2行目\n3行目");
        }

        #[test]
        fn 相関キーは載る行にだけ現れる() {
            let with = render_line(
                &origin(),
                "t",
                "INFO",
                "x",
                &fields("本文", &[("card_id", serde_json::Value::from("075b83fa"))]),
                None,
            )
            .unwrap();
            assert_eq!(parse(&with)["card_id"], "075b83fa");

            let without =
                render_line(&origin(), "t", "INFO", "x", &fields("本文", &[]), None).unwrap();
            assert!(
                parse(&without).get("card_id").is_none(),
                "値の無い相関キーは欄ごと現れないこと"
            );
        }

        #[test]
        fn 間引いた件数は欄として載る() {
            let line =
                render_line(&origin(), "t", "INFO", "x", &fields("本文", &[]), Some(11)).unwrap();
            assert_eq!(parse(&line)["suppressed"], 11);
        }

        #[test]
        fn 予約語と同じ名前のフィールドは7欄を壊さない() {
            // イベント側が `pid` という名前のフィールドを持っていた場合
            let mut collected = EventFields::default();
            collected.put_named("message", serde_json::Value::from("本文"));
            collected.put_named("pid", serde_json::Value::from("横取り"));
            let line = render_line(&origin(), "t", "INFO", "x", &collected, None).unwrap();
            let value = parse(&line);
            assert_eq!(value["pid"], 4242, "7欄の pid が横取りされていない");
            assert_eq!(value["f_pid"], "横取り", "落とさずに改名して残す");
        }

        #[test]
        fn 本文はmessageという名前のフィールドから取る() {
            let mut collected = EventFields::default();
            collected.put_named("message", serde_json::Value::from("本文"));
            assert_eq!(collected.msg, "本文");
            assert!(collected.extra.is_empty(), "message を欄として残さないこと");
        }

        #[test]
        fn 時刻はミリ秒3桁のutcで出る() {
            let at = time::OffsetDateTime::from_unix_timestamp(1_775_000_000)
                .unwrap()
                .replace_millisecond(7)
                .unwrap();
            let text = format_rfc3339_millis(at);
            assert!(text.ends_with(".007Z"), "{text}");
            assert_eq!(text.len(), "2026-08-07T12:34:56.789Z".len());
        }

        #[test]
        fn 時刻は文字列のまま並べ替えても時刻順になる() {
            let base = time::OffsetDateTime::from_unix_timestamp(1_775_000_000).unwrap();
            let mut texts = vec![
                format_rfc3339_millis(base + time::Duration::seconds(60)),
                format_rfc3339_millis(base),
                format_rfc3339_millis(base + time::Duration::milliseconds(1)),
            ];
            let expected = vec![texts[1].clone(), texts[2].clone(), texts[0].clone()];
            texts.sort();
            assert_eq!(texts, expected);
        }
    }

    mod 置き場所 {
        use super::*;

        #[test]
        fn ファイル名は種別とpidと日付でできている() {
            let stem = file_stem(Proc::Dashboard, 15588);
            assert_eq!(stem, "dashboard-15588");
            let name = format!("{stem}.2026-08-07.jsonl");
            let (parsed, date) = parse_log_name(&name).expect("読めること");
            assert_eq!(parsed, "dashboard-15588");
            assert_eq!(date.to_string(), "2026-08-07");
        }

        #[test]
        fn 同じ種別を2つ起こしても別のファイルになる() {
            // 実機（ローカルモード）と trial（サーバモード）は同じ実行ファイル
            assert_ne!(
                file_stem(Proc::Dashboard, 15588),
                file_stem(Proc::Dashboard, 15646)
            );
        }

        #[test]
        fn セッションホストは別の種別として分かれる() {
            assert_eq!(file_stem(Proc::SessionHost, 1), "session-host-1");
        }

        #[test]
        fn 見覚えのない名前は読まない() {
            for name in [
                "dashboard-1.jsonl",
                "dashboard-1.2026-08-07.log",
                ".2026-08-07.jsonl",
                "dashboard-1.2026-13-07.jsonl",
                "dashboard-1.2026-08-07-01.jsonl",
                "dashboard.jsonl",
            ] {
                assert!(parse_log_name(name).is_none(), "{name} を読んでしまった");
            }
        }

        #[test]
        fn 置き場所は状態の置き場所の下になる() {
            let mut config = SessionHostConfig::default();
            config.state_dir = Some(PathBuf::from("/tmp/state"));
            assert_eq!(logs_dir(&config), PathBuf::from("/tmp/state/logs"));
        }
    }

    mod 間引き {
        use super::*;

        fn key(msg: &str, card: Option<&str>) -> DedupKey {
            DedupKey::new("t", Level::WARN, card, msg)
        }

        #[test]
        fn 同じ鍵の行は窓の中で1本だけ通る() {
            let dedup = Dedup::default();
            let now = Instant::now();
            let key = key("同じ本文", None);
            assert!(dedup.admit(&key, now));
            assert!(!dedup.admit(&key, now + Duration::from_secs(1)));
            assert!(!dedup.admit(&key, now + Duration::from_secs(4)));
            assert!(dedup.admit(&key, now + Duration::from_secs(6)));
        }

        #[test]
        fn 間引いた件数は次に通る行へ載る() {
            let dedup = Dedup::default();
            let now = Instant::now();
            let key = key("同じ本文", None);
            assert!(dedup.admit(&key, now));
            assert_eq!(dedup.take_suppressed(&key), None, "まだ間引いていない");
            for _ in 0..3 {
                assert!(!dedup.admit(&key, now + Duration::from_secs(1)));
            }
            assert!(dedup.admit(&key, now + Duration::from_secs(6)));
            assert_eq!(dedup.take_suppressed(&key), Some(3));
            assert_eq!(dedup.take_suppressed(&key), None, "二度は載せない");
        }

        #[test]
        fn 整形へ届かなくても件数は消えない() {
            // 通したのに整形されなかった場合、件数は次の行まで残る
            let dedup = Dedup::default();
            let now = Instant::now();
            let key = key("同じ本文", None);
            assert!(dedup.admit(&key, now));
            assert!(!dedup.admit(&key, now + Duration::from_secs(1)));
            assert!(dedup.admit(&key, now + Duration::from_secs(6)));
            // ここで take せずにもう1周
            assert!(!dedup.admit(&key, now + Duration::from_secs(7)));
            assert!(dedup.admit(&key, now + Duration::from_secs(12)));
            assert_eq!(dedup.take_suppressed(&key), Some(2), "遅れても消えない");
        }

        #[test]
        fn カードが違えば別の鍵になる() {
            let dedup = Dedup::default();
            let now = Instant::now();
            assert!(dedup.admit(&key("同じ本文", Some("aaa")), now));
            assert!(
                dedup.admit(&key("同じ本文", Some("bbb")), now),
                "別のセッションで起きた同じ事象を潰さないこと"
            );
        }

        #[test]
        fn 本文の先頭は文字数で切る() {
            // バイト添字で切ると日本語で panic する
            let msg = "あ".repeat(40);
            assert_eq!(head_of(&msg).chars().count(), DEDUP_MSG_CHARS);
            assert_eq!(head_of("短い"), "短い");
        }

        #[test]
        fn 件数の残っている鍵は掃除で捨てない() {
            let mut entries = HashMap::new();
            let now = Instant::now();
            let old = now - DEDUP_WINDOW * 100;
            entries.insert(
                key("捨ててよい", None),
                Entry {
                    last_pass: old,
                    pending: 0,
                },
            );
            entries.insert(
                key("件数が残っている", None),
                Entry {
                    last_pass: old,
                    pending: 5,
                },
            );
            evict_stale(&mut entries, now);
            assert!(entries.get(&key("捨ててよい", None)).is_none());
            assert!(entries.get(&key("件数が残っている", None)).is_some());
        }
    }

    mod 保持 {
        use super::*;

        fn temp_dir(label: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "agentdashboard-logging-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).expect("作れること");
            dir
        }

        fn put(dir: &Path, name: &str, size: usize) {
            std::fs::write(dir.join(name), "x".repeat(size)).expect("書けること");
        }

        fn day(text: &str) -> time::Date {
            let (_, date) = parse_log_name(&format!("x.{text}.jsonl")).expect("読めること");
            date
        }

        #[test]
        fn 保持日数より古いファイルだけ消える() {
            let dir = temp_dir("retention");
            put(&dir, "dashboard-1.2026-08-01.jsonl", 10);
            put(&dir, "dashboard-1.2026-08-05.jsonl", 10);
            put(&dir, "dashboard-1.2026-08-07.jsonl", 10);
            let outcome = sweep_at(&dir, day("2026-08-07"), 3, u64::MAX);
            assert_eq!(outcome.removed, 1);
            assert!(!dir.join("dashboard-1.2026-08-01.jsonl").exists());
            assert!(dir.join("dashboard-1.2026-08-05.jsonl").exists());
            assert!(dir.join("dashboard-1.2026-08-07.jsonl").exists());
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn 合計が上限を超えたら古い順に消える() {
            let dir = temp_dir("budget");
            put(&dir, "dashboard-1.2026-08-01.jsonl", 100);
            put(&dir, "dashboard-1.2026-08-02.jsonl", 100);
            put(&dir, "dashboard-1.2026-08-03.jsonl", 100);
            let outcome = sweep_at(&dir, day("2026-08-07"), 3650, 250);
            assert_eq!(outcome.removed, 1);
            assert!(!dir.join("dashboard-1.2026-08-01.jsonl").exists());
            assert!(dir.join("dashboard-1.2026-08-03.jsonl").exists());
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn 今日のファイルは上限を超えても消さない() {
            // いま誰かが開いているかもしれない。消しても書き手は気づかない（§19-8）
            let dir = temp_dir("today");
            put(&dir, "dashboard-1.2026-08-07.jsonl", 100);
            put(&dir, "dashboard-2.2026-08-07.jsonl", 100);
            let outcome = sweep_at(&dir, day("2026-08-07"), 3650, 10);
            assert_eq!(outcome.removed, 0);
            assert!(outcome.over_budget, "消せないことを言うこと");
            assert!(dir.join("dashboard-1.2026-08-07.jsonl").exists());
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn 見覚えのない名前のファイルには触らない() {
            let dir = temp_dir("stranger");
            put(&dir, "dashboard-1.2026-01-01.jsonl", 10);
            put(&dir, "notes.txt", 10);
            put(&dir, "dashboard-1.jsonl", 10);
            let outcome = sweep_at(&dir, day("2026-08-07"), 3, u64::MAX);
            assert_eq!(outcome.removed, 1);
            assert!(dir.join("notes.txt").exists());
            assert!(dir.join("dashboard-1.jsonl").exists());
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn 置き場所が無くても落ちない() {
            let outcome = sweep_at(
                Path::new("/nonexistent/agentdashboard/logs"),
                day("2026-08-07"),
                7,
                1,
            );
            assert_eq!(outcome.removed, 0);
        }
    }

    mod フィルタ {
        use super::*;

        #[test]
        fn 第三者クレートは既定で落ちる() {
            let directives = file_filter_directives("debug");
            assert!(directives.starts_with("debug,"));
            for quiet in ["hyper=warn", "tokio_tungstenite=warn", "sea_orm=warn"] {
                assert!(directives.contains(quiet), "{quiet} が無い");
            }
        }

        #[test]
        fn 移行の記録は落とさない() {
            // `sea_orm=warn` は starts_with なので sea_orm_migration も飲む。
            // より長い指定を並べて救っている（基線②の18行がこれ）
            assert!(file_filter_directives("debug").contains("sea_orm_migration=info"));
        }

        #[test]
        fn 綴りが読めなければ既定へ落として言う() {
            for typo in ["こんなレベルは無い", "debgu", ""] {
                let (_, complaint) = file_filter(typo);
                let complaint = complaint.unwrap_or_else(|| panic!("{typo} で黙って落ちた"));
                assert!(complaint.contains("debug として扱います"), "{complaint}");
            }
        }

        #[test]
        fn 綴り間違いはenvfilterでは弾けない() {
            // **`try_new` は綴り間違いを通す。** 裸の語は「そういう名前のターゲット」
            // として解釈されるので、`debgu` はエラーにならず**そのターゲットだけを
            // 通す指定**になり、ファイル層が静かに沈黙する。
            // だから file_filter は先にレベルとして読めることを確かめている
            assert!(
                EnvFilter::try_new(file_filter_directives("debgu")).is_ok(),
                "この前提が変わったら file_filter の二段構えを見直すこと"
            );
        }

        #[test]
        fn 読めるレベルなら文句を言わない() {
            for level in ["trace", "debug", "info", "warn", "error", "off", " info "] {
                let (_, complaint) = file_filter(level);
                assert!(complaint.is_none(), "{level}: {complaint:?}");
            }
        }
    }
}
