//! 端末エミュレータと画面の配信（セルフホスト化設計§7）。
//!
//! # なぜ画面を作るのか
//!
//! ローカルモードでは PTY の生バイトをそのままブラウザへ流している。同じことを
//! セルフホストでやると、**誰も見ていないセッションのバイトまで線に乗る**——要件5-2
//! （表示中のものだけ配る）が正面から禁じている形になる。そこで PC の中に端末を1つ
//! 持ち、「いまの画面」だけを間隔をあけて運ぶ。
//!
//! ```text
//! PTY の生バイト（合流前）→ vt100 → contents_formatted()  … 全画面 → 0x04
//!                                 → contents_diff(&送った画面) … 差分 → 0x05
//! ```
//!
//! # 独自の形を発明しない
//!
//! 運ぶのは**エスケープ列**（設計§7-3）。サーバは種別を移し替えるだけ、ブラウザは
//! 受け取ったバイトを xterm.js へ書くだけで済む。セル配列の JSON を発明すると、
//! 3実装ぶんの変換とその取り違えを永久に抱えることになる。
//!
//! 「画面 → エスケープ列 → 画面」が同じ画面になることは、実 claude の録画に対して
//! 実測済み（設計§19-1。食い違い0セル）。
//!
//! # 送った画面を別に持つ理由
//!
//! 差分は「前に送った画面」との差でなければならない。手元の画面と比べても
//! 「何が変わったか」しか分からず、**取りこぼした相手には届かない差分**を作ってしまう。
//! [`TermEmulator::sent`] がその基準で、スクロールバックを持たせていないのは
//! 差分が可視部分だけを相手にするため（設計§19-3）。
//!
//! # 見た目だけでなく入力の作法も運ぶ
//!
//! 使うのは `state_formatted()` / `state_diff()`——設計§7-3 が挙げている `contents_*` に
//! **入力モードを足したもの**である。ローカルモードのブラウザは生バイトを見ているので、
//! CLI が立てた入力モード（カーソルキーの送り方・括弧付き貼り付け）をそこから学べる。
//! リモートでは生バイトが届かないので、画面と一緒に運ばないと**矢印キーが違う符号で
//! 送られる**——`/rewind` のメニュー操作がまさにそれで落ちる。

use crate::events::EventSink;
use protocol::{
    CardId,
    a2s::Intervals,
    frame::{self, FrameKind},
};
use std::{
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{sync::Notify, task::JoinHandle, time::Instant};

/// 1フレームの上限（設計§9-5）。
///
/// もともとは Valkey の出力バッファ切断（既定 hard 32MB）を避けるための保険だが、
/// **全画面にも効かせる**（設計§19-3）。実測でスクロールバック1000行の全画面が
/// 上限の45%に達しており、差分だけを見ていると足りない。
pub const FRAME_LIMIT: usize = 256 * 1024;

/// 入力の直後だけ画面を細かく送る長さと間隔（設計§7-5）。
///
/// TUI の描き直しは入力から**非同期に遅れて**届くので、「入力を受けたら1回だけ返す」
/// では描く前の画面を掴む。手元の PTY での実測は最大185ms（設計§19-4）だが、
/// リモートの往復を含まない数字なので縮めていない。
const HOT_WINDOW: Duration = Duration::from_millis(1_500);
const HOT_INTERVAL: Duration = Duration::from_millis(50);

/// 行と行のあいだに置くもの。**属性を戻してから**改行する。
///
/// 戻さないと、色の付いた行の次の行が同じ色を引きずる（1行ぶんの出力は
/// 「既定の属性から始まる」前提で作られているため）。
const LINE_BREAK: &[u8] = b"\x1b[m\r\n";

/// 画面に関わる設定（設計§13-3 の2つ）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenSettings {
    /// 無操作のときに差分を送る周期（ミリ秒）
    pub screen_ms: u64,
    /// 遡れる行数
    pub scrollback_lines: usize,
}

impl Default for ScreenSettings {
    fn default() -> Self {
        Self {
            screen_ms: 20_000,
            scrollback_lines: 1_000,
        }
    }
}

impl From<Intervals> for ScreenSettings {
    fn from(intervals: Intervals) -> Self {
        Self {
            screen_ms: intervals.screen_ms,
            scrollback_lines: intervals.scrollback_lines,
        }
    }
}

/// セッション1本ぶんの端末。
pub struct TermEmulator {
    card_id: CardId,
    /// 上へ運ぶ先。ローカルモードにはこれを持つ実装が無い（設計§7-2）
    events: Arc<dyn EventSink>,
    /// PTY の生バイトを**全量・順序どおり**食う側
    source: Mutex<vt100::Parser>,
    /// 送った画面。差分の基準（スクロールバックは要らない）
    sent: Mutex<vt100::Parser>,
    /// フレームの通し番号（設計§4-3）。中継の取りこぼし検出に使う
    seq: AtomicU64,
    screen_ms: AtomicU64,
    /// いま作ってある遡り行数。vt100 は後から訊けないので控えておく
    scrollback_lines: AtomicUsize,
    /// 入力があった合図（ホットウィンドウの引き金）
    input: Notify,
    /// 配信タスク。**居ないあいだは1バイトも出さない**（要件5-2）
    pump: Mutex<Option<JoinHandle<()>>>,
}

impl TermEmulator {
    pub fn new(
        card_id: CardId,
        events: Arc<dyn EventSink>,
        cols: u16,
        rows: u16,
        settings: ScreenSettings,
    ) -> Arc<Self> {
        Arc::new(Self {
            card_id,
            events,
            source: Mutex::new(vt100::Parser::new(rows, cols, settings.scrollback_lines)),
            sent: Mutex::new(vt100::Parser::new(rows, cols, 0)),
            seq: AtomicU64::new(0),
            screen_ms: AtomicU64::new(settings.screen_ms),
            scrollback_lines: AtomicUsize::new(settings.scrollback_lines),
            input: Notify::new(),
            pump: Mutex::new(None),
        })
    }

    /// PTY が吐いたぶんを食わせる。**合流前の生バイトを全量・順序どおり**（設計§7-2）。
    ///
    /// 間引くと ANSI の状態機械が壊れる（初期実装§4 の原則が、そのままここにも効く）。
    pub fn feed(&self, bytes: &[u8]) {
        self.source
            .lock()
            .expect("ロックが壊れていない")
            .process(bytes);
    }

    /// 端末へ何か書いた。ホットウィンドウを開く（設計§7-5）。
    ///
    /// 引き金を「0x02 の到着」ではなく「PTY へ書いたこと」にしてあるのは、Composer の
    /// 指示送信も同じところを通り、同じように画面を動かすため。0x02 だけを見ると、
    /// **指示を送った直後だけ追随が効かない**という一貫しない挙動になる。
    pub fn note_input(&self) {
        self.input.notify_one();
    }

    /// 端末の大きさを揃える（設計§7-4）。変わったら `true`。
    ///
    /// 送った画面も同じ大きさへ作り直す。**基準の大きさが食い違うと差分が組み立てられない。**
    pub fn resize(&self, cols: u16, rows: u16) -> bool {
        let mut source = self.source.lock().expect("ロックが壊れていない");
        if source.screen().size() == (rows, cols) {
            return false;
        }
        source.screen_mut().set_size(rows, cols);
        *self.sent.lock().expect("ロックが壊れていない") = vt100::Parser::new(rows, cols, 0);
        true
    }

    /// 遡れる行数を変える（設計§13-3）。
    ///
    /// vt100 は行数を後から変えられないので**作り直す**。作り直すと中身が消えるため、
    /// セッションが持っている生バイト（リングバッファ）を食わせ直して復元する。
    pub fn rebuild(&self, scrollback_lines: usize, seed: &[u8]) {
        let mut source = self.source.lock().expect("ロックが壊れていない");
        let (rows, cols) = source.screen().size();
        let mut rebuilt = vt100::Parser::new(rows, cols, scrollback_lines);
        rebuilt.process(seed);
        *source = rebuilt;
        *self.sent.lock().expect("ロックが壊れていない") = vt100::Parser::new(rows, cols, 0);
        self.scrollback_lines
            .store(scrollback_lines, Ordering::Relaxed);
    }

    pub fn set_screen_ms(&self, screen_ms: u64) {
        self.screen_ms.store(screen_ms, Ordering::Relaxed);
    }

    pub fn scrollback_lines(&self) -> usize {
        self.scrollback_lines.load(Ordering::Relaxed)
    }

    fn screen_ms(&self) -> u64 {
        self.screen_ms.load(Ordering::Relaxed).max(1)
    }

    pub fn is_subscribed(&self) -> bool {
        self.pump
            .lock()
            .expect("ロックが壊れていない")
            .as_ref()
            .is_some_and(|task| !task.is_finished())
    }

    /// 配信を始める（設計§7-4）。すでに始まっていれば大きさだけ揃えて全画面を出し直す。
    pub fn subscribe(self: &Arc<Self>, cols: u16, rows: u16) {
        self.resize(cols, rows);
        let mut pump = self.pump.lock().expect("ロックが壊れていない");
        if let Some(previous) = pump.take() {
            previous.abort();
        }
        *pump = Some(tokio::spawn(pump_loop(Arc::downgrade(self))));
    }

    /// 配信を止める。視聴者が居なくなったときだけ呼ばれる（設計§7-4）。
    pub fn unsubscribe(&self) {
        if let Some(task) = self.pump.lock().expect("ロックが壊れていない").take() {
            task.abort();
        }
    }

    /// 見ている相手が居るなら、いまの全画面を送り直す。
    ///
    /// 大きさが変わった直後に呼ぶ（設計§7-4）。誰も見ていなければ何も出さない。
    pub fn refresh(&self) {
        if !self.is_subscribed() {
            return;
        }
        self.send_full();
    }

    fn send_full(&self) {
        let payload = {
            let mut source = self.source.lock().expect("ロックが壊れていない");
            self.full_payload(&mut source)
        };
        self.emit(FrameKind::ScreenFull, payload);
    }

    /// 変わったぶんを送る。**変化が無ければ何も送らない**（設計§7-5）。
    fn send_update(&self) {
        let Some((kind, payload)) = self.next_update() else {
            return;
        };
        self.emit(kind, payload);
    }

    fn next_update(&self) -> Option<(FrameKind, Vec<u8>)> {
        let mut source = self.source.lock().expect("ロックが壊れていない");
        let diff = {
            let sent = self.sent.lock().expect("ロックが壊れていない");
            source.screen().state_diff(sent.screen())
        };
        if diff.is_empty() {
            return None;
        }
        // 差分のほうが大きくなるくらいなら、画面を作り直したほうが小さい（設計§9-5）
        if diff.len() > FRAME_LIMIT {
            let payload = self.full_payload(&mut source);
            return Some((FrameKind::ScreenFull, payload));
        }
        self.sent
            .lock()
            .expect("ロックが壊れていない")
            .process(&diff);
        Some((FrameKind::ScreenDiff, diff))
    }

    /// 全画面を組み立て、**送った画面をその形に合わせる**。
    ///
    /// 並びは「スクロールバック行 → 画面本体」（設計§7-6）。本体（`contents_formatted`）は
    /// 画面を消してから描くので、前置した行が画面に残っていると**消される**。
    /// そこで前置のあとに改行を足して、行を全部スクロールバックへ押し出しておく。
    fn full_payload(&self, source: &mut vt100::Parser) -> Vec<u8> {
        let (rows, cols) = source.screen().size();
        let visible = source.screen().state_formatted();

        // 送った画面は**本体だけ**から作り直す。前置はスクロールバックへ行くので、
        // 画面の中身には影響しない
        let mut sent = vt100::Parser::new(rows, cols, 0);
        sent.process(&visible);
        *self.sent.lock().expect("ロックが壊れていない") = sent;

        let lines = collect_scrollback(source, FRAME_LIMIT.saturating_sub(visible.len()));
        let mut payload =
            Vec::with_capacity(visible.len() + lines.iter().map(Vec::len).sum::<usize>() + 64);
        for line in &lines {
            payload.extend_from_slice(b"\x1b[m");
            payload.extend_from_slice(line);
            payload.extend_from_slice(b"\r\n");
        }
        if !lines.is_empty() {
            // 画面ぶんの改行で、前置した行を最後の1行まで押し上げる
            for _ in 1..rows {
                payload.extend_from_slice(b"\r\n");
            }
        }
        payload.extend_from_slice(&visible);
        payload
    }

    fn emit(&self, kind: FrameKind, payload: Vec<u8>) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        self.events
            .screen_frame(frame::encode_screen(kind, self.card_id, seq, &payload));
    }
}

/// 遡れる行を古い方から集める（設計§19-3 で確定した組み立て方）。
///
/// `contents_formatted()` は可視部分しか返さないので、`set_scrollback` で窓をずらしながら
/// 1行ずつ取り出す。予算（`budget`）に収まらないぶんは**古い方から捨てる**——新しい方を
/// 捨てると、画面のすぐ上が抜けた読めない履歴になる。
fn collect_scrollback(source: &mut vt100::Parser, budget: usize) -> Vec<Vec<u8>> {
    // 実際の量へ丸められるので、大きい値を入れて訊く
    source.screen_mut().set_scrollback(usize::MAX);
    let depth = source.screen().scrollback();
    let (rows, cols) = source.screen().size();

    let mut lines: Vec<Vec<u8>> = Vec::with_capacity(depth);
    let mut offset = depth;
    while offset > 0 {
        source.screen_mut().set_scrollback(offset);
        let take = offset.min(rows as usize);
        for line in source.screen().rows_formatted(0, cols).take(take) {
            lines.push(line);
        }
        offset = offset.saturating_sub(rows as usize);
    }
    source.screen_mut().set_scrollback(0);

    let cost = |line: &Vec<u8>| line.len() + LINE_BREAK.len();
    let mut total: usize = lines.iter().map(cost).sum();
    let mut drop_head = 0;
    while total > budget && drop_head < lines.len() {
        total -= cost(&lines[drop_head]);
        drop_head += 1;
    }
    lines.drain(..drop_head);
    lines
}

/// 配信の本体（設計§7-5）。
///
/// 弱い参照で持つのは、**セッションが畳まれたら止まる**ようにするため。強い参照だと
/// 配信タスクがセッションを生かし続け、終わったカードの画面を作り続けることになる。
async fn pump_loop(weak: Weak<TermEmulator>) {
    // 購読の始まりは必ず全画面から。差分から始めると、相手が持っていない画面を
    // 基準にした差分を送ることになる
    match weak.upgrade() {
        Some(screen) => screen.send_full(),
        None => return,
    }

    let mut hot_until: Option<Instant> = None;
    loop {
        let Some(screen) = weak.upgrade() else {
            return;
        };
        let hot = hot_until.is_some_and(|at| Instant::now() < at);
        let wait = if hot {
            HOT_INTERVAL
        } else {
            Duration::from_millis(screen.screen_ms())
        };

        let woken = tokio::select! {
            _ = tokio::time::sleep(wait) => false,
            _ = screen.input.notified() => true,
        };
        if woken {
            hot_until = Some(Instant::now() + HOT_WINDOW);
        }
        screen.send_update();
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use crate::events::LocalEventBus;
    use std::sync::Mutex as StdMutex;

    /// 送られたフレームを溜めるだけの報告先。
    #[derive(Default)]
    struct Frames {
        seen: StdMutex<Vec<Vec<u8>>>,
        bus: LocalEventBus,
    }

    impl Frames {
        fn kinds(&self) -> Vec<FrameKind> {
            self.seen
                .lock()
                .expect("ロックが壊れていない")
                .iter()
                .map(|bytes| frame::decode(bytes).expect("分解できること").kind)
                .collect()
        }

        fn payloads(&self) -> Vec<Vec<u8>> {
            self.seen
                .lock()
                .expect("ロックが壊れていない")
                .iter()
                .map(|bytes| {
                    let frame = frame::decode(bytes).expect("分解できること");
                    let (_, rest) = frame::split_seq(frame.payload).expect("番号を剥がせること");
                    rest.to_vec()
                })
                .collect()
        }
    }

    impl EventSink for Frames {
        fn emit(&self, _event: protocol::ws::ServerMessage) {}

        fn subscribe(&self) -> tokio::sync::broadcast::Receiver<protocol::ws::ServerMessage> {
            self.bus.subscribe()
        }

        fn report_transcript(&self, _report: crate::events::TranscriptReport) {}

        fn reset_transcript(&self, _card_id: CardId) {}

        fn screens_enabled(&self) -> bool {
            true
        }

        fn screen_frame(&self, frame: Vec<u8>) {
            self.seen.lock().expect("ロックが壊れていない").push(frame);
        }
    }

    fn emulator(settings: ScreenSettings) -> (Arc<TermEmulator>, Arc<Frames>) {
        let sink = Arc::new(Frames::default());
        let screen = TermEmulator::new(
            CardId::new(),
            Arc::clone(&sink) as Arc<dyn EventSink>,
            20,
            5,
            settings,
        );
        (screen, sink)
    }

    /// 送ったバイト列を別の端末に食わせて、元の画面と同じになるか見る。
    ///
    /// 設計§7-3 の主張そのものの検査（xterm.js の代わりに2つ目の vt100 を置く）。
    fn replay(payloads: &[Vec<u8>], cols: u16, rows: u16) -> vt100::Parser {
        let mut mirror = vt100::Parser::new(rows, cols, 100);
        for payload in payloads {
            mirror.process(payload);
        }
        mirror
    }

    #[test]
    fn 誰も見ていなければ1バイトも出さない() {
        // 要件5-2。エミュレータは動くが、送るのは購読が始まってから
        let (screen, sink) = emulator(ScreenSettings::default());
        screen.feed(b"hello");
        screen.note_input();

        assert!(
            sink.seen.lock().expect("ロックが壊れていない").is_empty(),
            "購読していないのにフレームが出ています"
        );
    }

    #[tokio::test]
    async fn 購読を始めると全画面から始まる() {
        let (screen, sink) = emulator(ScreenSettings::default());
        screen.feed(b"hello");
        screen.subscribe(20, 5);
        tokio::task::yield_now().await;

        assert_eq!(sink.kinds(), vec![FrameKind::ScreenFull]);
        let mirror = replay(&sink.payloads(), 20, 5);
        assert!(
            mirror.screen().contents().contains("hello"),
            "送った全画面を食わせても同じ画面にならない: {:?}",
            mirror.screen().contents()
        );
        screen.unsubscribe();
    }

    #[tokio::test]
    async fn 入力があると待たずに差分が出る() {
        // 無操作の間隔を長くしておき、**入力で起きたことだけ**が理由になるようにする
        let (screen, sink) = emulator(ScreenSettings {
            screen_ms: 60_000,
            scrollback_lines: 100,
        });
        screen.subscribe(20, 5);
        tokio::task::yield_now().await;

        screen.feed(b"abc");
        screen.note_input();
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert_eq!(
            sink.kinds(),
            vec![FrameKind::ScreenFull, FrameKind::ScreenDiff],
            "入力の直後に差分が出ていない"
        );
        let mirror = replay(&sink.payloads(), 20, 5);
        assert!(mirror.screen().contents().contains("abc"));
        screen.unsubscribe();
    }

    #[tokio::test]
    async fn 変化が無ければ何も送らない() {
        let (screen, sink) = emulator(ScreenSettings {
            screen_ms: 10,
            scrollback_lines: 100,
        });
        screen.subscribe(20, 5);
        tokio::time::sleep(Duration::from_millis(120)).await;

        assert_eq!(
            sink.kinds(),
            vec![FrameKind::ScreenFull],
            "画面が動いていないのに送っています"
        );
        screen.unsubscribe();
    }

    #[tokio::test]
    async fn 購読を止めると出なくなる() {
        let (screen, sink) = emulator(ScreenSettings {
            screen_ms: 10,
            scrollback_lines: 100,
        });
        screen.subscribe(20, 5);
        tokio::time::sleep(Duration::from_millis(30)).await;
        screen.unsubscribe();

        let before = sink.seen.lock().expect("ロックが壊れていない").len();
        screen.feed(b"xyz");
        screen.note_input();
        tokio::time::sleep(Duration::from_millis(60)).await;

        assert_eq!(
            sink.seen.lock().expect("ロックが壊れていない").len(),
            before,
            "止めたのに配信が続いています"
        );
    }

    #[test]
    fn 全画面はスクロールバックを前に置く() {
        // 設計§7-6。5行の画面に8行流すと3行が溢れる
        let (screen, _sink) = emulator(ScreenSettings {
            screen_ms: 20_000,
            scrollback_lines: 100,
        });
        for line in 1..=8 {
            screen.feed(format!("line{line}\r\n").as_bytes());
        }

        let payload = {
            let mut source = screen.source.lock().expect("ロックが壊れていない");
            screen.full_payload(&mut source)
        };
        let mirror = replay(&[payload], 20, 5);

        // 画面には最後の行が見えていて、溢れたぶんは遡ると出てくる
        assert!(mirror.screen().contents().contains("line8"));
        let mut mirror = mirror;
        mirror.screen_mut().set_scrollback(usize::MAX);
        assert!(
            mirror.screen().contents().contains("line1"),
            "溢れた行がスクロールバックに復元されていない: {}",
            mirror.screen().contents()
        );
    }

    #[test]
    fn 遡れる行が無ければ前置もしない() {
        let (screen, _sink) = emulator(ScreenSettings::default());
        screen.feed(b"hi");

        let payload = {
            let mut source = screen.source.lock().expect("ロックが壊れていない");
            screen.full_payload(&mut source)
        };
        assert!(
            !payload.starts_with(b"\x1b[m"),
            "空の前置が付いています: {payload:?}"
        );
    }

    #[test]
    fn 大きさを変えると差分の基準も作り直す() {
        let (screen, _sink) = emulator(ScreenSettings::default());
        screen.feed(b"hello");
        assert!(screen.resize(40, 10));
        assert!(!screen.resize(40, 10), "同じ大きさなら何も起きない");

        let (kind, payload) = screen.next_update().expect("画面が出ること");
        assert_eq!(kind, FrameKind::ScreenDiff);
        let mirror = replay(&[payload], 40, 10);
        assert!(mirror.screen().contents().contains("hello"));
    }

    #[test]
    fn 遡れる行数を変えても画面は残る() {
        let (screen, _sink) = emulator(ScreenSettings::default());
        screen.feed(b"hello");
        screen.rebuild(50, b"hello");

        assert_eq!(screen.scrollback_lines(), 50);
        let payload = {
            let mut source = screen.source.lock().expect("ロックが壊れていない");
            screen.full_payload(&mut source)
        };
        let mirror = replay(&[payload], 20, 5);
        assert!(mirror.screen().contents().contains("hello"));
    }
}
