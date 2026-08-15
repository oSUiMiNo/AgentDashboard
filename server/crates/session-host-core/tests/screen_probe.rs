//! 端末エミュレータ（vt100）の実機検証（計画.md フェーズ0・設計§7）。
//!
//! # 何を決めるためのものか
//!
//! 設計§7 は「エミュレータは vt100」「画面はエスケープ列で運ぶ」「ホットウィンドウ
//! 1.5秒／50ms」「スクロールバック1000行」を**暫定で**置いている。ここは `pty_record.rs`
//! が採った実 claude の録画を食わせて、その暫定を実測で確定させる。
//!
//! | 実機検証 | ここで見るもの |
//! |---|---|
//! | #1 | vt100 で claude の TUI を再現できるか（**フェーズ4 の入り口のゲート**） |
//! | #2 | 画面と差分の実サイズ・生バイトに対する削減率 |
//! | #4 | スクロールバックの持ち方と SCREEN_FULL の組み立て方 |
//! | #3 前倒し | 入力から再描画までの遅れの分布と、ホットウィンドウ 1.5秒の妥当性 |
//!
//! # 「見え方」をどう機械で判定するか
//!
//! カーソル位置・色・全角・スピナーの「見え方」は人の目に頼りたくなるが、**運び方そのものを
//! 往復させれば機械で判定できる**。設計§7-3 が主張しているのは
//!
//! ```text
//! 画面 --contents_formatted()--> エスケープ列 --xterm.js--> 画面
//! ```
//!
//! が同じ画面になることなので、xterm.js の代わりに2つ目の vt100 を置いて突き合わせれば、
//! 主張そのものを検査したことになる。差分（`contents_diff`）も同じやり方で追随を見る。
//!
//! # 実行方法
//!
//! ```text
//! make probe-screen
//! ```
//!
//! 録画を読むだけなのでコンテナ内で完結する。`#[ignore]` を付けて `make test` から
//! 外してあるのは、**合否ではなく実測値を出すため**（`make perf` と同じ扱い。負荷や
//! 環境に左右される数値を合否にしない、というフェーズ1 の教訓）。
//! 録画は `make record-terminal` で採る。

#![allow(non_snake_case)]

use std::{collections::BTreeMap, path::PathBuf};

/// 画面配信で使うスクロールバック行数（設計§7-6 の既定値）。
const SCROLLBACK: usize = 1000;

/// 設計§9-5 のフレーム上限。差分がこれを超えたら全画面へ切り替える約束になっている。
const FRAME_LIMIT: usize = 256 * 1024;

/// 設計§7-5 のホットウィンドウ。
const HOT_WINDOW: f64 = 1.5;
const HOT_INTERVAL: f64 = 0.05;

/// 「描き直しが終わった」と見なす無出力の長さ。
const REDRAW_SETTLED: f64 = 0.1;

// ---------------------------------------------------------------------------
// 録画（asciicast v2）の読み込み
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Code {
    Output,
    Input,
    Resize,
}

#[derive(Debug, Clone)]
struct Event {
    at: f64,
    code: Code,
    data: String,
}

#[derive(Debug)]
struct Cast {
    title: String,
    cols: u16,
    rows: u16,
    events: Vec<Event>,
}

impl Cast {
    fn outputs(&self) -> impl Iterator<Item = &Event> {
        self.events.iter().filter(|e| e.code == Code::Output)
    }

    fn inputs(&self) -> impl Iterator<Item = &Event> {
        self.events.iter().filter(|e| e.code == Code::Input)
    }

    fn raw_bytes(&self) -> usize {
        self.outputs().map(|e| e.data.len()).sum()
    }

    fn duration(&self) -> f64 {
        self.events.last().map(|e| e.at).unwrap_or(0.0)
    }
}

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures")
}

/// 録画を読む。バージョン別ディレクトリのうち、名前がいちばん後ろのものを使う。
///
/// フィクスチャは Claude Code のバージョンごとに増えていく（`fixtures/README.md`）。
/// 実機検証はいちばん新しい版の TUI に対して行いたいので、名前順で後ろを採る。
fn load(name: &str) -> Cast {
    let root = fixture_root();
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&root)
        .unwrap_or_else(|error| panic!("{} を読めること: {error}", root.display()))
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.join("terminal").join(format!("{name}.cast")).is_file())
        .collect();
    candidates.sort();

    let dir = candidates.pop().unwrap_or_else(|| {
        panic!(
            "録画 {name}.cast がありません。`make record-terminal` で採取してください（探した場所: {}）",
            root.display()
        )
    });
    let path = dir.join("terminal").join(format!("{name}.cast"));
    let text = std::fs::read_to_string(&path).expect("録画を読めること");

    let mut lines = text.lines();
    let header: serde_json::Value = serde_json::from_str(lines.next().expect("ヘッダがあること"))
        .expect("ヘッダが JSON であること");
    let cols = header["width"].as_u64().expect("width があること") as u16;
    let rows = header["height"].as_u64().expect("height があること") as u16;
    let title = header["title"].as_str().unwrap_or_default().to_string();

    let mut events = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value =
            serde_json::from_str(line).expect("イベントが JSON であること");
        let at = value[0].as_f64().expect("時刻があること");
        let code = match value[1].as_str().expect("種別があること") {
            "o" => Code::Output,
            "i" => Code::Input,
            "r" => Code::Resize,
            other => panic!("知らないイベント種別: {other}"),
        };
        let data = value[2].as_str().expect("データがあること").to_string();
        events.push(Event { at, code, data });
    }

    Cast {
        title,
        cols,
        rows,
        events,
    }
}

fn parse_size(data: &str) -> (u16, u16) {
    let (cols, rows) = data.split_once('x').expect("COLSxROWS の形であること");
    (
        cols.parse().expect("桁数が数であること"),
        rows.parse().expect("行数が数であること"),
    )
}

// ---------------------------------------------------------------------------
// 画面の比較
// ---------------------------------------------------------------------------

/// 1つのセルの見え方。往復の前後で一致すべきものを全部持つ。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Look {
    contents: String,
    fg: String,
    bg: String,
    bold: bool,
    italic: bool,
    underline: bool,
    inverse: bool,
}

fn look_at(screen: &vt100::Screen, row: u16, col: u16) -> Look {
    match screen.cell(row, col) {
        Some(cell) => Look {
            contents: cell.contents().to_string(),
            fg: format!("{:?}", cell.fgcolor()),
            bg: format!("{:?}", cell.bgcolor()),
            bold: cell.bold(),
            italic: cell.italic(),
            underline: cell.underline(),
            inverse: cell.inverse(),
        },
        None => Look {
            contents: String::new(),
            fg: String::new(),
            bg: String::new(),
            bold: false,
            italic: false,
            underline: false,
            inverse: false,
        },
    }
}

/// 2つの画面の食い違いを数える。最初の食い違いは説明用に持ち帰る。
fn compare(left: &vt100::Screen, right: &vt100::Screen) -> (usize, Option<String>) {
    let (rows, cols) = left.size();
    let mut differences = 0;
    let mut first = None;

    for row in 0..rows {
        for col in 0..cols {
            let a = look_at(left, row, col);
            let b = look_at(right, row, col);
            if a != b {
                differences += 1;
                if first.is_none() {
                    first = Some(format!("({row},{col}) 左={a:?} 右={b:?}"));
                }
            }
        }
    }
    if left.cursor_position() != right.cursor_position() {
        differences += 1;
        if first.is_none() {
            first = Some(format!(
                "カーソル 左={:?} 右={:?}",
                left.cursor_position(),
                right.cursor_position()
            ));
        }
    }
    (differences, first)
}

/// 録画を頭から `until` 秒まで流し込んだ状態のパーサを作る。
fn replay(cast: &Cast, until: f64) -> vt100::Parser {
    let mut parser = vt100::Parser::new(cast.rows, cast.cols, SCROLLBACK);
    for event in &cast.events {
        if event.at > until {
            break;
        }
        match event.code {
            Code::Output => parser.process(event.data.as_bytes()),
            Code::Resize => {
                let (cols, rows) = parse_size(&event.data);
                parser.screen_mut().set_size(rows, cols);
            }
            // 入力は端末へ送ったものなので、エミュレータへは食わせない
            Code::Input => {}
        }
    }
    parser
}

fn percentile(sorted: &[f64], ratio: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let index = ((sorted.len() - 1) as f64 * ratio).round() as usize;
    sorted[index]
}

/// 全角として2桁を占める文字か。
///
/// `unicode-width` を直に足さずに済ませるための最小の判定。録画に出るのは日本語なので、
/// 仮名・漢字・全角記号が見られれば足りる。
fn is_wide(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(c as u32,
            0x1100..=0x115F | 0x2E80..=0xA4CF | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF | 0xFE30..=0xFE6F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6)
    })
}

// ---------------------------------------------------------------------------
// 実機検証#1：vt100 で TUI を再現できるか
// ---------------------------------------------------------------------------

/// 画面をエスケープ列にして食べ直しても、セルもカーソルも変わらないこと。
///
/// これが設計§7-3（SCREEN_FULL）の主張そのもの。ここが崩れると、リモートのブラウザに
/// 映るのは「崩れた画面」になり、方式ごと考え直しになる（乗り換え先は avt。§16-1 #1）。
#[test]
#[ignore = "録画フィクスチャを読む実測（make probe-screen）"]
fn 実機検証1_全画面を往復しても画面が変わらない() {
    for name in ["basic", "interactive", "resize"] {
        let cast = load(name);
        let source = replay(&cast, f64::INFINITY);
        let formatted = source.screen().contents_formatted();

        let (rows, cols) = source.screen().size();
        let mut mirror = vt100::Parser::new(rows, cols, SCROLLBACK);
        mirror.process(&formatted);

        let (differences, first) = compare(source.screen(), mirror.screen());
        println!(
            "[{name}] 全画面 {} バイト / 食い違い {} セル",
            formatted.len(),
            differences
        );
        assert_eq!(
            differences, 0,
            "[{name}] 往復で画面が変わりました。最初の食い違い: {first:?}"
        );
    }
}

/// 差分を順に当て続けても一致し続けること（SCREEN_DIFF の正しさ）。
///
/// 配信は全画面を1回送ったあと差分で追う（設計§7-5）。1回でもずれると、以後は
/// ずれたまま積み上がるので、**毎ステップ一致していること**を見る必要がある。
#[test]
#[ignore = "録画フィクスチャを読む実測（make probe-screen）"]
fn 実機検証1_差分を順に当てても一致し続ける() {
    for name in ["basic", "interactive", "resize"] {
        let cast = load(name);
        let mut source = vt100::Parser::new(cast.rows, cast.cols, SCROLLBACK);
        let mut mirror = vt100::Parser::new(cast.rows, cast.cols, SCROLLBACK);

        let mut steps = 0;
        let mut diff_bytes = 0;
        for event in &cast.events {
            match event.code {
                Code::Output => source.process(event.data.as_bytes()),
                Code::Resize => {
                    let (cols, rows) = parse_size(&event.data);
                    source.screen_mut().set_size(rows, cols);
                    // 大きさが変わったら差分では追えない。配信も SCREEN_FULL を送り直す約束
                    mirror.screen_mut().set_size(rows, cols);
                    mirror.process(&source.screen().contents_formatted());
                    continue;
                }
                Code::Input => continue,
            }

            let diff = source.screen().contents_diff(mirror.screen());
            diff_bytes += diff.len();
            mirror.process(&diff);
            steps += 1;

            let (differences, first) = compare(source.screen(), mirror.screen());
            assert_eq!(
                differences, 0,
                "[{name}] {steps} 回目の差分でずれました（{:.3}秒地点）。最初の食い違い: {first:?}",
                event.at
            );
        }
        println!("[{name}] 差分 {steps} 回 / 合計 {diff_bytes} バイト・全部一致");
    }
}

/// 色・全角・カーソル・スピナーが録画から読み取れること。
///
/// 往復の検査は「運び方が無損失か」を見るもので、**そもそも中身が出ているか**は別に
/// 確かめる必要がある。真っ白な画面は無損失に往復するので、往復だけでは通ってしまう。
#[test]
#[ignore = "録画フィクスチャを読む実測（make probe-screen）"]
fn 実機検証1_色と全角とカーソルとスピナーが残る() {
    let cast = load("basic");
    let parser = replay(&cast, f64::INFINITY);
    let screen = parser.screen();
    let (rows, cols) = screen.size();

    // --- 色 ---
    let mut colored = 0;
    let mut palette: BTreeMap<String, usize> = BTreeMap::new();
    for row in 0..rows {
        for col in 0..cols {
            let look = look_at(screen, row, col);
            if look.fg != "Default" || look.bg != "Default" {
                colored += 1;
                *palette.entry(look.fg.clone()).or_default() += 1;
            }
        }
    }
    println!("色の付いたセル: {colored} / 使われた前景色: {palette:?}");

    // --- 全角 ---
    let mut wide_cells = 0;
    let mut aligned = 0;
    for row in 0..rows {
        for col in 0..cols.saturating_sub(1) {
            if is_wide(&look_at(screen, row, col).contents) {
                wide_cells += 1;
                // 全角文字の右隣は「文字を持たないセル」になる。ここが埋まっていると
                // 桁数の数え方が違うということで、枠線や表がずれる
                if look_at(screen, row, col + 1).contents.is_empty() {
                    aligned += 1;
                }
            }
        }
    }
    println!("全角セル: {wide_cells} / うち右隣が空: {aligned}");

    // --- カーソル ---
    let (crow, ccol) = screen.cursor_position();
    println!("カーソル位置: 行 {crow} / 桁 {ccol}（画面は {rows}x{cols}）");

    // --- スピナー（アニメーション）---
    let (changes, place, samples) = spinner_scan(&cast);
    println!("100ms 標本 {samples} 回 / いちばん変わったセル {place:?} が {changes} 回変化");

    assert!(colored > 0, "色が1つも付いていません。録画を疑ってください");
    assert!(wide_cells > 0, "全角文字が画面に出ていません");
    assert_eq!(
        wide_cells, aligned,
        "全角文字の右隣が空でないセルがあります（桁の数え方が合っていない）"
    );
    assert!(crow < rows && ccol < cols, "カーソルが画面の外にあります");
    assert!(
        changes >= 3,
        "画面が動いた形跡がありません。スピナーが録れていない可能性があります"
    );
}

/// 100ms ごとに画面を見て、セルごとの変化回数を数える。
fn spinner_scan(cast: &Cast) -> (usize, (u16, u16), usize) {
    let mut parser = vt100::Parser::new(cast.rows, cast.cols, SCROLLBACK);
    let mut previous: Vec<String> = Vec::new();
    let mut counts: BTreeMap<(u16, u16), usize> = BTreeMap::new();
    let mut samples = 0;
    let mut next_sample = 0.1;

    for event in &cast.events {
        while event.at >= next_sample {
            let screen = parser.screen();
            let (rows, cols) = screen.size();
            let current: Vec<String> = (0..rows)
                .flat_map(|row| (0..cols).map(move |col| (row, col)))
                .map(|(row, col)| look_at(screen, row, col).contents)
                .collect();
            if !previous.is_empty() && previous.len() == current.len() {
                for (index, (before, after)) in previous.iter().zip(current.iter()).enumerate() {
                    if before != after {
                        let row = index as u16 / cols;
                        let col = index as u16 % cols;
                        *counts.entry((row, col)).or_default() += 1;
                    }
                }
            }
            previous = current;
            samples += 1;
            next_sample += 0.1;
        }
        match event.code {
            Code::Output => parser.process(event.data.as_bytes()),
            Code::Resize => {
                let (cols, rows) = parse_size(&event.data);
                parser.screen_mut().set_size(rows, cols);
                previous.clear();
            }
            Code::Input => {}
        }
    }

    counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(place, count)| (count, place, samples))
        .unwrap_or((0, (0, 0), samples))
}

// ---------------------------------------------------------------------------
// 実機検証#2：画面と差分の大きさ・削減率
// ---------------------------------------------------------------------------

/// 更新間隔ごとに、何フレーム・何バイト流れるかを測る。
///
/// 設計§7-5 の既定は20秒間隔。1秒・0.3秒・50ms も測るのは、ホットウィンドウ（50ms）と
/// 手動で詰めた設定でどれだけ増えるかを知るため。§9-5 のフレーム上限（256KiB）に
/// どれだけ余裕があるかもここで分かる。
///
/// 0.3秒 は選択肢の谷を埋めるために足したもの。**合否ではなく記録**なので、
/// ここに数字が残っていると「もっさり感」を測るときに測り直さずに済む。
#[test]
#[ignore = "録画フィクスチャを読む実測（make probe-screen）"]
fn 実機検証2_画面と差分の大きさと削減率() {
    for name in ["basic", "interactive", "resize"] {
        let cast = load(name);
        println!(
            "\n[{name}] {} / 生バイト {} / 長さ {:.1}秒 / 出力イベント {}",
            cast.title,
            cast.raw_bytes(),
            cast.duration(),
            cast.outputs().count()
        );

        let full = replay(&cast, f64::INFINITY)
            .screen()
            .contents_formatted()
            .len();
        println!(
            "  全画面1枚: {full} バイト（フレーム上限 {FRAME_LIMIT} バイトの {:.1}%）",
            full as f64 * 100.0 / FRAME_LIMIT as f64
        );

        for interval in [20.0, 1.0, 0.3, 0.05] {
            let stats = cadence(&cast, interval);
            println!(
                "  間隔 {interval:>5}秒: 差分 {:>4} 枚 / 合計 {:>8} バイト / 最大 {:>6} バイト / 生バイトの {:.2}%",
                stats.frames,
                stats.bytes,
                stats.largest,
                stats.bytes as f64 * 100.0 / cast.raw_bytes().max(1) as f64
            );
            assert!(
                stats.largest <= FRAME_LIMIT,
                "[{name}] 差分がフレーム上限を超えました（{} バイト）。§9-5 の切り替えが要ります",
                stats.largest
            );
        }
    }
}

struct Cadence {
    frames: usize,
    bytes: usize,
    largest: usize,
}

/// 一定間隔で差分を送ったとしたら何枚・何バイトになるかを数える。
///
/// 「変化が無ければ何も送らない」（設計§7-5）ので、空の差分は数えない。
fn cadence(cast: &Cast, interval: f64) -> Cadence {
    let mut source = vt100::Parser::new(cast.rows, cast.cols, SCROLLBACK);
    let mut sent = vt100::Parser::new(cast.rows, cast.cols, SCROLLBACK);
    let mut stats = Cadence {
        frames: 0,
        bytes: 0,
        largest: 0,
    };
    let mut next = interval;

    let flush = |source: &vt100::Parser, sent: &mut vt100::Parser, stats: &mut Cadence| {
        let diff = source.screen().contents_diff(sent.screen());
        if diff.is_empty() {
            return;
        }
        stats.frames += 1;
        stats.bytes += diff.len();
        stats.largest = stats.largest.max(diff.len());
        sent.process(&diff);
    };

    for event in &cast.events {
        while event.at >= next {
            flush(&source, &mut sent, &mut stats);
            next += interval;
        }
        match event.code {
            Code::Output => source.process(event.data.as_bytes()),
            Code::Resize => {
                let (cols, rows) = parse_size(&event.data);
                source.screen_mut().set_size(rows, cols);
                sent.screen_mut().set_size(rows, cols);
                // 大きさが変わったら全画面を送り直す（設計§7-4）
                let full = source.screen().contents_formatted();
                stats.frames += 1;
                stats.bytes += full.len();
                stats.largest = stats.largest.max(full.len());
                sent.process(&full);
            }
            Code::Input => {}
        }
    }
    flush(&source, &mut sent, &mut stats);
    stats
}

// ---------------------------------------------------------------------------
// 実機検証#4：スクロールバックの持ち方
// ---------------------------------------------------------------------------

/// `contents_formatted()` が可視部分だけを返すこと、遡って取り出せることを確かめる。
///
/// SCREEN_FULL は「スクロールバック行 → 画面本体」の順で組み立てる（設計§7-6）と
/// 書いてあるが、その組み立て方は API の実挙動を見ないと決まらない。
#[test]
#[ignore = "録画フィクスチャを読む実測（make probe-screen）"]
fn 実機検証4_スクロールバックの取り出し方() {
    let cast = load("basic");
    let mut parser = replay(&cast, f64::INFINITY);
    let (rows, cols) = parser.screen().size();

    // どこまで遡れるか。set_scrollback は実際の量へ丸められるので、大きい値を入れて訊く
    parser.screen_mut().set_scrollback(usize::MAX);
    let depth = parser.screen().scrollback();
    let scrolled = parser.screen().contents_formatted();
    parser.screen_mut().set_scrollback(0);
    let visible = parser.screen().contents_formatted();

    println!("スクロールバックの深さ: {depth} 行（上限 {SCROLLBACK} 行 / 画面は {rows}x{cols}）");
    println!(
        "可視だけの全画面: {} バイト / 最上部まで遡った全画面: {} バイト",
        visible.len(),
        scrolled.len()
    );
    assert!(
        depth > 0,
        "スクロールバックが溜まっていません。録画が短すぎる可能性があります"
    );
    assert_ne!(
        visible, scrolled,
        "遡っても同じ内容が返りました。contents_formatted はスクロールバックを含んでいるかもしれません"
    );

    // 遡りながら取り出して、SCREEN_FULL に前置する行を組み立てる。
    // rows 行ずつ窓をずらす。最後の窓は端数になるので、余った分だけを採る
    let mut assembled: Vec<Vec<u8>> = Vec::new();
    let mut offset = depth;
    while offset > 0 {
        parser.screen_mut().set_scrollback(offset);
        let take = (offset.min(rows as usize)) as u16;
        let screen = parser.screen();
        for line in screen.rows_formatted(0, cols).take(take as usize) {
            assembled.push(line);
        }
        offset = offset.saturating_sub(rows as usize);
    }
    parser.screen_mut().set_scrollback(0);

    let prefix_bytes: usize = assembled.iter().map(|line| line.len() + 2).sum();
    println!(
        "前置する行: {} 行 / {} バイト。SCREEN_FULL 全体は {} バイト（フレーム上限の {:.1}%）",
        assembled.len(),
        prefix_bytes,
        prefix_bytes + visible.len(),
        (prefix_bytes + visible.len()) as f64 * 100.0 / FRAME_LIMIT as f64
    );
    assert_eq!(
        assembled.len(),
        depth,
        "遡って取り出した行数が深さと合いません。組み立て方の見直しが要ります"
    );
}

// ---------------------------------------------------------------------------
// 実機検証#3 の前倒し：入力から再描画までの遅れ
// ---------------------------------------------------------------------------

/// 入力してから TUI が描き直されるまでの遅れを測り、ホットウィンドウの妥当性を見る。
///
/// 設計§7-5 は「入力直後の1.5秒間は 50ms 間隔で差分を送る」としている。根拠は
/// 「TUI の再描画は入力から非同期に遅れて届く」こと。**どれだけ遅れるのか**を
/// 実測しないと 1.5秒が妥当かどうか分からない。
///
/// # 2つの数字を出す理由
///
/// - **描き直しが窓の中で終わった割合**：1.5秒という長さが足りているかの直接の答え
/// - **窓を閉じた時点でも画面が動いていた割合**：こちらは高くて構わない。claude の TUI は
///   考えている間スピナーを回し続けるので、「もう動かない画面」という状態が存在しない。
///   だからこそ設計は「窓の終わりに1枚送る」ではなく「窓の間 50ms ごとに送り続ける」形に
///   なっている。この数字が高いことは、その形が要るという裏づけになる
#[test]
#[ignore = "録画フィクスチャを読む実測（make probe-screen）"]
fn 実機検証3前倒し_入力から再描画までの遅れ() {
    for name in ["interactive", "basic"] {
        let cast = load(name);
        let outputs: Vec<&Event> = cast.outputs().collect();
        if outputs.is_empty() {
            continue;
        }

        let mut first_delays = Vec::new();
        let mut settle_delays = Vec::new();
        let mut inside_window = 0;
        let mut still_moving = 0;
        let mut window_total = 0;

        for input in cast.inputs() {
            let Some(first) = outputs.iter().find(|e| e.at > input.at) else {
                continue;
            };
            first_delays.push(first.at - input.at);

            // 描き直しが終わった時刻＝出力が REDRAW_SETTLED 秒途切れた最初の点
            let mut settled = first.at;
            for event in outputs.iter().filter(|e| e.at > input.at) {
                if event.at - settled > REDRAW_SETTLED {
                    break;
                }
                settled = event.at;
            }
            settle_delays.push(settled - input.at);

            window_total += 1;
            // その入力に対する描き直しが、窓の中で終わっているか
            if settled - input.at <= HOT_WINDOW {
                inside_window += 1;
            }
            // 窓を閉じた時点の画面が、描き直しが終わった時点の画面とまだ違うか。
            // **違っていて当たり前**なのがこの TUI で、それがこの節の要点になる（下の注記）
            let closing = replay(&cast, input.at + HOT_WINDOW);
            let after = replay(&cast, settled + REDRAW_SETTLED);
            let (differences, _) = compare(closing.screen(), after.screen());
            if differences > 0 {
                still_moving += 1;
            }
        }

        first_delays.sort_by(f64::total_cmp);
        settle_delays.sort_by(f64::total_cmp);
        println!("\n[{name}] 入力 {} 回", first_delays.len());
        println!(
            "  入力→初動出力  : p50 {:.3}秒 / p90 {:.3}秒 / 最大 {:.3}秒",
            percentile(&first_delays, 0.5),
            percentile(&first_delays, 0.9),
            first_delays.last().copied().unwrap_or(f64::NAN)
        );
        println!(
            "  入力→描き直し完了: p50 {:.3}秒 / p90 {:.3}秒 / 最大 {:.3}秒",
            percentile(&settle_delays, 0.5),
            percentile(&settle_delays, 0.9),
            settle_delays.last().copied().unwrap_or(f64::NAN)
        );
        println!(
            "  描き直しが窓（{HOT_WINDOW}秒）の中で終わった割合: {inside_window}/{window_total}"
        );
        println!("  窓を閉じた時点でも画面がまだ動いていた割合: {still_moving}/{window_total}");
        println!(
            "  窓の中に送る差分の枚数: 最大 {:.0} 枚（{HOT_INTERVAL}秒間隔）",
            HOT_WINDOW / HOT_INTERVAL
        );
    }
}
