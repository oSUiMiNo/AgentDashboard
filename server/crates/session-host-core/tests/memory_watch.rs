//! メモリが返ったかを、出来事の前後で記録する（寝ているカードばかりなのに、メモリ不足で
//! セッションを起こせない 設計§25）。
//!
//! **Windows を実際には聞かない。** 聞く口（[`OutsideProbe`]）を差し替え、答えを止められる
//! 偽物で「測りが寝かせる・止める・入れ替えるを待たせない」を固定する。30 秒・2 分・10 分後の
//! 測りは偽の時計（`tokio::time::pause`）で進める。

#![allow(non_snake_case)]

mod common;

use protocol::{CardId, SessionStatus};
use session_host_core::memory_watch::{
    Event, Inside, InsideProbe, MEMORY_WATCH_ATTEMPT, MemoryWatch, Outside, OutsideProbe, Sample,
    Step, parse_inside, parse_outside,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

// ---------------------------------------------------------------------------
// 偽物

/// いつも同じ量を答える WSL の中。読まれた回数を数える。
#[derive(Debug, Default)]
struct 固定の中 {
    読まれた: AtomicUsize,
}

impl 固定の中 {
    fn 回数(&self) -> usize {
        self.読まれた.load(Ordering::SeqCst)
    }
}

impl InsideProbe for 固定の中 {
    fn read(&self) -> Option<Inside> {
        self.読まれた.fetch_add(1, Ordering::SeqCst);
        Some(Inside {
            available_mb: 19_500,
            free_mb: 8_800,
            cached_mb: 6_900,
        })
    }
}

/// 開けるまで答えない Windows 側。**聞かれた回数を数える。** 開いていれば 4,100MB と
/// 4,300MB を答える。
#[derive(Debug, Default)]
struct 止める外 {
    開いた: Mutex<bool>,
    合図: Condvar,
    聞かれた: AtomicUsize,
}

impl 止める外 {
    fn 開いたまま() -> Arc<Self> {
        let 外 = Arc::new(Self::default());
        外.開ける();
        外
    }

    fn 閉じたまま() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn 開ける(&self) {
        *self.開いた.lock().expect("ロックが壊れていない") = true;
        self.合図.notify_all();
    }

    fn 回数(&self) -> usize {
        self.聞かれた.load(Ordering::SeqCst)
    }
}

impl OutsideProbe for 止める外 {
    fn read(&self) -> Outside {
        self.聞かれた.fetch_add(1, Ordering::SeqCst);
        let mut 開いた = self.開いた.lock().expect("ロックが壊れていない");
        while !*開いた {
            開いた = self.合図.wait(開いた).expect("ロックが壊れていない");
        }
        Outside {
            host_free_mb: Some(4_100),
            vmmem_mb: Some(4_300),
            error: None,
        }
    }
}

/// 試験が途中で落ちても門を開ける。閉じたままだと測りの糸が待ち続け、落ちた試験の
/// プロセスが終われずに固まる。
struct 門を開けて去る(Arc<止める外>);

impl Drop for 門を開けて去る {
    fn drop(&mut self) {
        self.0.開ける();
    }
}

fn 測り(外: Option<&Arc<止める外>>) -> (Arc<MemoryWatch>, Arc<固定の中>) {
    let 中 = Arc::new(固定の中::default());
    let watch = MemoryWatch::new(
        Arc::clone(&中) as Arc<dyn InsideProbe>,
        外.map(|外| Arc::clone(外) as Arc<dyn OutsideProbe>),
    );
    (watch, 中)
}

fn 置き場所(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-memory-watch-{label}-{}",
        std::process::id()
    ));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).expect("前回の残りを消せること");
    }
    std::fs::create_dir_all(&dir).expect("置き場所を作れること");
    dir
}

fn 印(dir: &Path) -> PathBuf {
    dir.join(MEMORY_WATCH_ATTEMPT)
}

/// 偽の時計で、測りが来るまで待つ。**来なければ時計が1時間進んで落ちる**（固まらない）。
async fn 来るのを待つ(rx: &mut broadcast::Receiver<Sample>, what: &str) -> Sample {
    match tokio::time::timeout(Duration::from_secs(3600), rx.recv()).await {
        Ok(Ok(sample)) => sample,
        Ok(Err(err)) => panic!("{what}：測りの知らせを受けられない（{err}）"),
        Err(_) => panic!("★{what}：測りが来ない（出来事の前後を測っていない）"),
    }
}

/// 偽の時計を進め、起きたタスクに回らせる。
async fn 進める(by: Duration) {
    tokio::time::advance(by).await;
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

// ---------------------------------------------------------------------------
// 読み取り

#[test]
fn 中の量はキャッシュとバッファを足して読む() {
    let text = "MemTotal:       24607912 kB\n\
                MemFree:         9096740 kB\n\
                MemAvailable:   18625496 kB\n\
                Buffers:          102400 kB\n\
                Cached:          7000284 kB\n\
                SwapCached:            0 kB\n";
    assert_eq!(
        parse_inside(text),
        Some(Inside {
            available_mb: 18_625_496 / 1024,
            free_mb: 9_096_740 / 1024,
            cached_mb: (7_000_284 + 102_400) / 1024,
        }),
        "★/proc/meminfo の kB を MB へ直し、Cached と Buffers を足して読んでいない"
    );
    // **`SwapCached:` を `Cached` と取り違えない**（行の頭で名前を見る）
    assert_eq!(
        parse_inside("MemFree: 1024 kB\nMemAvailable: 2048 kB\nSwapCached: 4096 kB\n")
            .map(|inside| inside.cached_mb),
        None,
        "★Cached の行が無いのに、SwapCached を Cached として読んだ"
    );
    assert_eq!(
        parse_inside("MemFree: 1024 kB\nCached: 1024 kB\n"),
        None,
        "★MemAvailable が無いのに読めたことにした"
    );
}

#[test]
fn 外の量は空きをkBで常駐量をバイトで読む() {
    // 実機（2026-10-02）で `powershell.exe` が返した答えの形
    let outside = parse_outside("free_kb=4243244\r\nvmmem_bytes=4484079616\r\n");
    assert_eq!(
        outside,
        Outside {
            host_free_mb: Some(4_243_244 / 1024),
            vmmem_mb: Some(4_484_079_616 / 1024 / 1024),
            error: None,
        },
        "★空き（kB）と常駐量（バイト）の単位を取り違えている"
    );
}

#[test]
fn VmmemWSLが無ければ常駐量だけ空欄で理由が残る() {
    let outside = parse_outside("free_kb=4243244\nvmmem_bytes=\n");
    assert_eq!(outside.host_free_mb, Some(4_243_244 / 1024));
    assert_eq!(outside.vmmem_mb, None, "★無い常駐量を数にした");
    assert!(
        outside
            .error
            .as_deref()
            .is_some_and(|error| error.contains("VmmemWSL のプロセスが見つかりませんでした")),
        "★常駐量が空欄なのに、プロセスが無いという理由が無い: {outside:?}"
    );
}

#[test]
fn 答えが読めなければ両方空欄で理由が残る() {
    let outside = parse_outside("Get-CimInstance : アクセスが拒否されました。\n");
    assert_eq!(outside.host_free_mb, None);
    assert_eq!(outside.vmmem_mb, None);
    assert!(
        outside.error.is_some(),
        "★読めなかったのに理由が無い: {outside:?}"
    );
}

// ---------------------------------------------------------------------------
// いつ測るか・束ねる

#[tokio::test(start_paused = true)]
async fn 出来事の直前と三つの時点を測る() {
    let 外 = 止める外::開いたまま();
    let (watch, 中) = 測り(Some(&外));
    let mut rx = watch.subscribe();
    let card = CardId::new();

    watch.note(Event::SessionSleep, Some(card));
    let before = 来るのを待つ(&mut rx, "直前の測り").await;
    assert_eq!(
        (before.step, before.event, before.card_id, before.elapsed_ms),
        (Step::Before, Event::SessionSleep, Some(card), 0),
        "★出来事の直前の測りになっていない: {before:?}"
    );
    assert_eq!(
        before.inside.map(|inside| inside.available_mb),
        Some(19_500)
    );
    assert_eq!(
        before.outside.as_ref().and_then(|outside| outside.vmmem_mb),
        Some(4_300),
        "★WSL の機械なのに Windows 側を測っていない"
    );
    assert!(before.probe_ms.is_some(), "★Windows を聞いた時間が無い");

    進める(Duration::from_secs(29)).await;
    assert_eq!(中.回数(), 1, "★30 秒経つ前に、次の時点を測った");
    進める(Duration::from_secs(1)).await;
    let after = 来るのを待つ(&mut rx, "30 秒後").await;
    assert_eq!(
        after.step,
        Step::After30s,
        "★30 秒後の測りが来ない: {after:?}"
    );
    assert_eq!(
        after.series, before.series,
        "★同じ出来事の測りが別の系列になった"
    );
    assert!(after.elapsed_ms >= 30_000, "{after:?}");

    進める(Duration::from_secs(90)).await;
    let after = 来るのを待つ(&mut rx, "2 分後").await;
    assert_eq!(
        after.step,
        Step::After2m,
        "★2 分後の測りが来ない: {after:?}"
    );

    進める(Duration::from_secs(8 * 60)).await;
    let after = 来るのを待つ(&mut rx, "10 分後").await;
    assert_eq!(
        after.step,
        Step::After10m,
        "★10 分後の測りが来ない: {after:?}"
    );
    assert_eq!(外.回数(), 4, "★1回の測りで Windows を2回以上聞いた");

    // 10 分後で系列は終わる。次の出来事は新しい系列になる
    assert_eq!(watch.走っている系列(), None, "★測り終えた系列が残っている");
    watch.note(Event::SessionKill, None);
    let next = 来るのを待つ(&mut rx, "次の系列の直前").await;
    assert_eq!(next.step, Step::Before);
    assert_ne!(
        next.series, before.series,
        "★終わった系列に次の出来事を足した"
    );
}

#[tokio::test(start_paused = true)]
async fn 続けて寝かせても系列は一本で数だけ増える() {
    let 外 = 止める外::開いたまま();
    let (watch, 中) = 測り(Some(&外));
    let mut rx = watch.subscribe();

    watch.note(Event::SessionSleep, Some(CardId::new()));
    watch.note(Event::SessionSleep, Some(CardId::new()));
    watch.note(Event::SessionKill, Some(CardId::new()));
    let before = 来るのを待つ(&mut rx, "直前の測り").await;
    assert_eq!(before.step, Step::Before);
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert!(
        rx.try_recv().is_err(),
        "★系列が走っているのに、新しい系列を始めた"
    );
    assert_eq!(中.回数(), 1, "★束ねた出来事のたびに WSL の中を読んだ");
    assert_eq!(
        外.回数(),
        1,
        "★束ねた出来事のたびに powershell.exe を立てた"
    );

    進める(Duration::from_secs(30)).await;
    let after = 来るのを待つ(&mut rx, "30 秒後").await;
    assert_eq!(after.series, before.series);
    assert_eq!(
        after.events, "session_sleep:2,session_kill:1",
        "★束ねた出来事の数が残っていない"
    );
    assert_eq!(
        after.event,
        Event::SessionSleep,
        "系列を始めた出来事は変わらない"
    );
}

#[tokio::test(start_paused = true)]
async fn WSLでなければWindowsの欄を測らない() {
    let (watch, _中) = 測り(None);
    let mut rx = watch.subscribe();
    watch.note(Event::SessionSleep, None);
    let before = 来るのを待つ(&mut rx, "直前の測り").await;
    assert_eq!(before.outside, None, "★WSL でないのに Windows の欄がある");
    assert_eq!(before.probe_ms, None);
    assert!(
        before.inside.is_some(),
        "WSL の中（Linux の中）は測り続ける"
    );
}

#[tokio::test(start_paused = true)]
async fn 測った行は種類と系列で引ける() {
    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();
    let 外 = 止める外::開いたまま();
    let (watch, _中) = 測り(Some(&外));
    let mut rx = watch.subscribe();
    watch.note(Event::SessionSleep, None);
    let before = 来るのを待つ(&mut rx, "直前の測り").await;

    let lines = sink.matching(mark, "series", &before.series);
    assert_eq!(lines.len(), 1, "★測りが1行になっていない: {lines:#?}");
    let line = &lines[0];
    let 期待 = [
        ("kind", serde_json::json!("memory_watch")),
        ("step", serde_json::json!("before")),
        ("event", serde_json::json!("session_sleep")),
        ("events", serde_json::json!("session_sleep:1")),
        ("available_mb", serde_json::json!(19_500)),
        ("free_mb", serde_json::json!(8_800)),
        ("cached_mb", serde_json::json!(6_900)),
        ("host_free_mb", serde_json::json!(4_100)),
        ("vmmem_mb", serde_json::json!(4_300)),
    ];
    for (欄, 値) in 期待 {
        assert_eq!(line[欄], 値, "★測りの行の {欄} が設計§25-2 と違う: {line}");
    }
    assert!(
        line.get("probe_ms").is_some(),
        "★Windows を聞いた時間が無い: {line}"
    );
    assert!(
        line.get("host_error").is_none(),
        "聞けたのに理由の欄がある: {line}"
    );
}

// ---------------------------------------------------------------------------
// 版の入れ替えをまたぐ

/// 入れ替えの前の測りを別の糸で走らせ、戻るのを待つ。**戻らなければ★で落ちる**
/// （固まらない）。
fn 入れ替えの前を測る(watch: &Arc<MemoryWatch>, dir: &Path, wait: Duration) {
    let (tx, rx) = std::sync::mpsc::channel();
    let watch = Arc::clone(watch);
    let dir = dir.to_path_buf();
    std::thread::spawn(move || {
        watch.before_swap(&dir, wait);
        tx.send(()).expect("試験が待っている");
    });
    rx.recv_timeout(Duration::from_secs(10)).expect(
        "★入れ替えの前の測りが、Windows の答えを上限を過ぎても待ち続けた（入れ替えを待たせた）",
    );
}

#[tokio::test(start_paused = true)]
async fn 入れ替えの後のプロセスが同じ系列で残りを測る() {
    let dir = 置き場所("carry");
    let 外 = 止める外::開いたまま();
    // 入れ替える前のプロセス。寝かせた系列が走っている
    let (前, _) = 測り(Some(&外));
    let mut 前の知らせ = 前.subscribe();
    前.note(Event::SessionSleep, None);
    let 寝かせた = 来るのを待つ(&mut 前の知らせ, "寝かせた直前").await;

    入れ替えの前を測る(&前, &dir, Duration::from_secs(3));
    assert!(印(&dir).is_file(), "★入れ替える前に印を書いていない");

    // 入れ替えた後のプロセス
    let (後, _) = 測り(Some(&外));
    let mut rx = 後.subscribe();
    assert!(後.resume_after_swap(&dir), "★入れ替えの印を拾っていない");
    assert!(!印(&dir).is_file(), "★拾った印を消していない");
    let before = 来るのを待つ(&mut rx, "入れ替えの直前（運ばれた）").await;
    assert_eq!(
        (before.step, before.event),
        (Step::Before, Event::VersionSwap),
        "★入れ替えの直前の測りを、入れ替えた後に書き残していない: {before:?}"
    );
    assert!(
        before.measured_at_ms.is_some(),
        "★運んだ測りに測った時刻が無い"
    );
    assert_eq!(
        before.cut_series.as_deref(),
        Some(寝かせた.series.as_str()),
        "★入れ替えで打ち切った系列が書かれていない"
    );
    assert_eq!(
        before
            .outside
            .as_ref()
            .and_then(|outside| outside.host_free_mb),
        Some(4_100)
    );

    進める(Duration::from_secs(30)).await;
    let after = 来るのを待つ(&mut rx, "入れ替えの 30 秒後").await;
    assert_eq!(after.step, Step::After30s);
    assert_eq!(
        after.series, before.series,
        "★入れ替えの前と後が別の系列になった"
    );
    assert!(
        前の知らせ.try_recv().is_err(),
        "★入れ替えで打ち切った系列を、前のプロセスが測り続けた"
    );
}

#[tokio::test(start_paused = true)]
async fn 入れ替えの前の測りは上限で打ち切って先へ進む() {
    let dir = 置き場所("cap");
    let 外 = 止める外::閉じたまま();
    let _札 = 門を開けて去る(Arc::clone(&外));
    let (前, _) = 測り(Some(&外));

    入れ替えの前を測る(&前, &dir, Duration::from_millis(50));
    assert!(印(&dir).is_file(), "★打ち切ったときに印を書いていない");

    let (後, _) = 測り(Some(&止める外::開いたまま()));
    let mut rx = 後.subscribe();
    assert!(後.resume_after_swap(&dir));
    let before = 来るのを待つ(&mut rx, "入れ替えの直前（運ばれた）").await;
    let outside = before.outside.expect("WSL の機械なので Windows の欄はある");
    assert_eq!(
        (outside.host_free_mb, outside.vmmem_mb),
        (None, None),
        "★答えが来ていない Windows の欄を埋めた"
    );
    assert!(
        outside
            .error
            .as_deref()
            .is_some_and(|error| error.contains("打ち切")),
        "★打ち切った理由が無い: {outside:?}"
    );
    assert_eq!(
        before.inside.map(|inside| inside.available_mb),
        Some(19_500),
        "WSL の中は待たずに測れている"
    );
}

#[tokio::test(start_paused = true)]
async fn 入れ替えられなかったら同じプロセスで続ける() {
    let dir = 置き場所("failed-swap");
    let (watch, _) = 測り(Some(&止める外::開いたまま()));
    let mut rx = watch.subscribe();
    let mut 入れ替えた = false;
    // **入れ替えが返ってきた**＝失敗した。成功なら返らない（exec）
    watch.around_swap(&dir, Duration::from_secs(3), || 入れ替えた = true);
    assert!(入れ替えた, "入れ替えそのものは呼ぶ");
    assert!(!印(&dir).is_file(), "★入れ替えられなかったのに印を残した");
    let before = 来るのを待つ(&mut rx, "入れ替えの直前").await;
    assert_eq!(
        (before.step, before.event),
        (Step::Before, Event::VersionSwap)
    );
    進める(Duration::from_secs(30)).await;
    let after = 来るのを待つ(&mut rx, "30 秒後").await;
    assert_eq!(
        (after.step, after.series.as_str()),
        (Step::After30s, before.series.as_str()),
        "★入れ替えられなかった後、同じプロセスで測りを続けていない"
    );
}

#[tokio::test(start_paused = true)]
async fn 古い入れ替えの印は捨てて行を残す() {
    let dir = 置き場所("stale");
    let 古い = session_host_core::session::now_ms() - 12 * 60 * 1000;
    std::fs::write(
        印(&dir),
        format!(r#"{{"series":"stale-series","at":{古い}}}"#),
    )
    .expect("印を置けること");
    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();

    let (watch, _) = 測り(Some(&止める外::開いたまま()));
    assert!(
        !watch.resume_after_swap(&dir),
        "★12 分前の入れ替えの続きを測り始めた"
    );
    assert!(
        !印(&dir).is_file(),
        "★古い印を消していない（次の起動でまた拾う）"
    );
    assert_eq!(watch.走っている系列(), None);
    assert_eq!(
        sink.matching(mark, "series", "stale-series").len(),
        1,
        "★古い印を捨てたことが残っていない"
    );
}

#[tokio::test(start_paused = true)]
async fn 入れ替えていない起動は印を拾わない() {
    // 統合テストは core をライブラリとして動かす。入れ替えた側でない起動が印を拾うと、
    // 開発者の実環境の印を消しにいく（`version::confirm_started` と同じ理由）
    let dir = 置き場所("not-handed-over");
    let (前, _) = 測り(Some(&止める外::開いたまま()));
    入れ替えの前を測る(&前, &dir, Duration::from_secs(3));
    assert!(
        印(&dir).is_file(),
        "入れ替える前に印を書いていない（形を作れていない）"
    );
    let (後, _) = 測り(Some(&止める外::開いたまま()));
    assert!(
        !後.resume_after_swap_if_handed_over(&dir),
        "★入れ替えていない起動が、入れ替えの続きを測り始めた"
    );
    assert!(
        印(&dir).is_file(),
        "★入れ替えていない起動が、入れ替えの印を拾った"
    );
}

// ---------------------------------------------------------------------------
// カードを寝かせる・止める（本物の擬似ターミナル）

/// 生きたカードと、閉じた門の Windows 側を差し込んだ測り。
async fn 門の閉じた測りで1枚起こす() -> (
    Arc<session_host_core::session::SessionManager>,
    Arc<session_host_core::session::Session>,
    Arc<止める外>,
    門を開けて去る,
    broadcast::Receiver<Sample>,
) {
    let manager = common::manager();
    let 外 = 止める外::閉じたまま();
    let 札 = 門を開けて去る(Arc::clone(&外));
    let (watch, _) = 測り(Some(&外));
    let rx = watch.subscribe();
    manager.set_memory_watch(watch);
    let (session, _watcher) = common::start_session(&manager).await;
    (manager, session, 外, 札, rx)
}

/// `op` を別の糸で走らせ、戻るのを待つ。**戻らなければ★で落ちる**。
async fn 待たずに戻る(what: &str, op: impl FnOnce() + Send + 'static) {
    tokio::time::timeout(common::TIMEOUT, tokio::task::spawn_blocking(op))
        .await
        .unwrap_or_else(|_| panic!("★{what}が、Windows 側の測りの答えを待った"))
        .expect("落ちていない");
}

async fn 測りを待つ(rx: &mut broadcast::Receiver<Sample>, what: &str) -> Sample {
    match tokio::time::timeout(common::TIMEOUT, rx.recv()).await {
        Ok(Ok(sample)) => sample,
        Ok(Err(err)) => panic!("{what}：測りの知らせを受けられない（{err}）"),
        Err(_) => panic!("★{what}：測りが来ない（出来事の前後を測っていない）"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn 寝かせても測りを待たない() {
    let (manager, session, 外, _札, mut rx) = 門の閉じた測りで1枚起こす().await;
    let card_id = session.card_id;

    let 止める = Arc::clone(&manager);
    待たずに戻る("寝かせる頼み", move || {
        止める.kill(card_id).expect("止められること");
    })
    .await;
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;
    assert!(
        rx.try_recv().is_err(),
        "Windows の答えが来る前に直前の測りを書いた"
    );

    外.開ける();
    let before = 測りを待つ(&mut rx, "寝かせた直前").await;
    assert_eq!(
        (before.step, before.event, before.card_id),
        (Step::Before, Event::SessionSleep, Some(card_id)),
        "★寝かせた出来事として測っていない: {before:?}"
    );
    assert_eq!(
        before.live_sessions,
        Some(1),
        "★止める直前の生きている claude の数になっていない"
    );
}

/// 一覧から外す頼みを流し、止めた出来事として測ったことを見る。
///
/// **製品が通る口で外す**（実装レビュー Fable 2）。生きた claude を抱えたカードを外すと、
/// 画面・`session rm` は `archive`、記録の側だけで外したカードは `forget` を通る。
/// `stop_for_removal` は記録だけ外す道で、生きたカードには届かない。
async fn 外すと止めた出来事として測る(
    what: &'static str,
    外す: impl FnOnce(&session_host_core::session::SessionManager, CardId) + Send + 'static,
) {
    let (manager, session, 外, _札, mut rx) = 門の閉じた測りで1枚起こす().await;
    let card_id = session.card_id;

    let 止める = Arc::clone(&manager);
    待たずに戻る(what, move || 外す(&止める, card_id)).await;
    外.開ける();
    let before = 測りを待つ(&mut rx, what).await;
    assert_eq!(
        (before.step, before.event, before.card_id),
        (Step::Before, Event::SessionKill, Some(card_id)),
        "★{what}を、一覧から外す出来事として測っていない: {before:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn 一覧から外すときは止めた出来事として測る() {
    外すと止めた出来事として測る(
        "一覧から外す頼み（archive）",
        |manager, card_id| {
            manager.archive(card_id).expect("生きたカードを外せること");
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn 記録の側で外した知らせでも止めた出来事として測る() {
    外すと止めた出来事として測る(
        "記録の側で外した知らせ（forget）",
        |manager, card_id| {
            assert!(manager.forget(card_id), "実体を畳めること");
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn 同じカードを止めている間の頼みは一回と数える() {
    // 実装レビュー Fable 3。同じ番号の送り直し（CLI の再送）・別の番号の頼み・番号の無い頼みが、
    // 止め終わる前に重なって届く。どれも同じ1枚を寝かせる1つの出来事で、束ねた数
    // （`events`）を寝かせた枚数として読めるように、1回だけ数える
    let (manager, session, 外, _札, mut rx) = 門の閉じた測りで1枚起こす().await;
    let card_id = session.card_id;
    let op = protocol::ws::OpId::new();

    let 止める = Arc::clone(&manager);
    待たずに戻る("重なった終了の頼み", move || {
        止める.kill_answering(card_id, op);
        止める.kill_answering(card_id, op);
        止める.kill_answering(card_id, protocol::ws::OpId::new());
        止める
            .kill(card_id)
            .expect("止めている最中のカードへの終了は断らない");
    })
    .await;
    外.開ける();
    let before = 測りを待つ(&mut rx, "寝かせた直前").await;
    assert_eq!(
        before.events, "session_sleep:1",
        "★同じ1枚を止めている間の頼みを、別の寝かせとして数えた: {before:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn 終わっているカードへの終了では測らない() {
    let (manager, session, 外, _札, _rx) = 門の閉じた測りで1枚起こす().await;
    外.開ける();
    // **claude が自分で終わった形にする**（止める合図を出さない）。合図で止めると止め始めた印が
    // 立ち、「終わっているか」を見なくても測らずに済んでしまう
    common::send_line(&session, "exit");
    let 期限 = tokio::time::Instant::now() + common::TIMEOUT;
    while !matches!(session.status(), SessionStatus::Ended { .. }) {
        assert!(
            tokio::time::Instant::now() < 期限,
            "claude が自分で終わらない"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    manager
        .kill(session.card_id)
        .expect("寝ているカードへの終了は断らない");
    assert_eq!(
        manager.memory_watch().走っている系列(),
        None,
        "★もう終わっている claude の前後を測り始めた（返るメモリが無い）"
    );
}
