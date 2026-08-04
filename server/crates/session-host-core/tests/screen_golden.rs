//! 端末エミュレータのゴールデン（テスト計画フェーズ4・設計§7-1）。
//!
//! # 何を守っているのか
//!
//! 実 claude の端末録画（`fixtures/*/terminal/*.cast`）を食わせ、**描き上がった画面を
//! そのまま**保存してある。vt100 を上げた・食わせ方を変えた・合流の仕方を変えた——
//! そのどれかで TUI の再現（カーソル・色・全角・スピナー）が崩れたら、ここが落ちる。
//!
//! transcript-parser のフィクスチャゲート（JSONL を読めること）の**画面版**にあたる。
//! 向こうが「読めること」を守るのに対し、こちらは「見えること」を守る。
//!
//! # なぜバイト列をそのまま保存するのか
//!
//! 文字だけを保存すると、色が全部落ちても・カーソルが行方不明でも通ってしまう。
//! 保存してあるのは `state_formatted()` の出力そのもの——**線に乗るバイト列と同じもの**
//! なので、ここが一致することは「配信される画面が変わっていない」ことと同義になる。
//!
//! # 作り直し方
//!
//! ```text
//! AGENTDASHBOARD_UPDATE_SCREEN_GOLDEN=1 scripts/cargo test -p session-host-core --test screen_golden
//! ```
//!
//! 作り直したら**必ず** `scripts/sanitize-fixtures.py` を通す（公開リポジトリなので、
//! 画面に写り込んだ利用者の情報が残っていないことを機械で確かめる）。

#![allow(non_snake_case)]

use std::path::{Path, PathBuf};

/// 画面配信で使うスクロールバック行数（設計§7-6 の既定値）。
const SCROLLBACK: usize = 1000;

/// 録画を採った端末の大きさ（`.cast` のヘッダにも入っているが、そちらを信じずに読む）。
fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures")
}

/// 録画のあるバージョンのうち、名前がいちばん後ろのものを使う。
fn newest_terminal_dir() -> PathBuf {
    let root = fixture_root();
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&root)
        .unwrap_or_else(|error| panic!("{} を読めること: {error}", root.display()))
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.join("terminal").is_dir())
        .collect();
    candidates.sort();
    candidates
        .pop()
        .unwrap_or_else(|| {
            panic!(
                "端末録画がありません。`make record-terminal` で採取してください（探した場所: {}）",
                root.display()
            )
        })
        .join("terminal")
}

/// asciicast v2 を読んで、出力とリサイズだけを順に返す。
enum Step {
    Output(Vec<u8>),
    Resize(u16, u16),
}

fn read_cast(path: &Path) -> (u16, u16, Vec<Step>) {
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| {
        panic!("{} を読めること: {error}", path.display());
    });
    let mut lines = text.lines();
    let header: serde_json::Value = serde_json::from_str(lines.next().expect("ヘッダがあること"))
        .expect("ヘッダが JSON であること");
    let cols = header["width"].as_u64().expect("width があること") as u16;
    let rows = header["height"].as_u64().expect("height があること") as u16;

    let mut steps = Vec::new();
    for line in lines {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let (Some(code), Some(data)) = (event[1].as_str(), event[2].as_str()) else {
            continue;
        };
        match code {
            "o" => steps.push(Step::Output(data.as_bytes().to_vec())),
            "r" => {
                let (cols, rows) = parse_size(data);
                steps.push(Step::Resize(cols, rows));
            }
            _ => {}
        }
    }
    (cols, rows, steps)
}

/// リサイズイベントの `"120x40"` を読む。
fn parse_size(data: &str) -> (u16, u16) {
    let (cols, rows) = data.split_once('x').expect("桁x行の形であること");
    (
        cols.trim().parse().expect("桁を読めること"),
        rows.trim().parse().expect("行を読めること"),
    )
}

/// 録画を最後まで食わせた画面を、線に乗る形（設計§7-3）で取り出す。
fn render(path: &Path) -> Vec<u8> {
    let (cols, rows, steps) = read_cast(path);
    let mut parser = vt100::Parser::new(rows, cols, SCROLLBACK);
    for step in steps {
        match step {
            Step::Output(bytes) => parser.process(&bytes),
            Step::Resize(cols, rows) => parser.screen_mut().set_size(rows, cols),
        }
    }
    parser.screen().state_formatted()
}

#[test]
fn 録画から描いた画面がゴールデンと一致する() {
    let dir = newest_terminal_dir();
    let update = std::env::var("AGENTDASHBOARD_UPDATE_SCREEN_GOLDEN").is_ok();
    let mut checked = 0;

    for name in ["basic", "interactive", "resize"] {
        let cast = dir.join(format!("{name}.cast"));
        if !cast.is_file() {
            continue;
        }
        let golden = dir.join(format!("{name}.screen"));
        let rendered = render(&cast);

        if update {
            std::fs::write(&golden, &rendered).expect("ゴールデンを書けること");
            println!(
                "{} を作り直しました（{} バイト）",
                golden.display(),
                rendered.len()
            );
            checked += 1;
            continue;
        }

        let expected = std::fs::read(&golden).unwrap_or_else(|error| {
            panic!(
                "{} がありません（{error}）。\
                 AGENTDASHBOARD_UPDATE_SCREEN_GOLDEN=1 を付けて作り直してください",
                golden.display()
            )
        });
        assert_eq!(
            String::from_utf8_lossy(&rendered),
            String::from_utf8_lossy(&expected),
            "[{name}] 録画から描いた画面がゴールデンと違います。\
             vt100 の版か食わせ方が変わった可能性があります"
        );
        checked += 1;
    }

    assert!(
        checked > 0,
        "録画が1本も見つかりませんでした（探した場所: {}）",
        dir.display()
    );
}

#[test]
fn 描いた画面を食べ直すと同じ画面になる() {
    // 設計§7-3 の主張そのものの検査（§19-1 の往復を、製品が使う `state_formatted` で行う）。
    // xterm.js の代わりに2つ目の vt100 を置いて突き合わせる
    let dir = newest_terminal_dir();
    let cast = dir.join("basic.cast");
    if !cast.is_file() {
        return;
    }
    let (cols, rows, _) = read_cast(&cast);

    let sent = render(&cast);
    let mut mirror = vt100::Parser::new(rows, cols, SCROLLBACK);
    mirror.process(&sent);

    assert_eq!(
        mirror.screen().state_formatted(),
        sent,
        "送ったバイト列を食べ直した画面が、送った画面と違います"
    );
}
