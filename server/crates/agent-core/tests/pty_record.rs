//! 実 claude の TUI を PTY 越しに録画してフィクスチャにする（セルフホスト化 計画.md フェーズ0）。
//!
//! # 何のためにあるか
//!
//! セルフホスト化ではリモートのブラウザへ**画面**を配信する（設計§7）。その画面は
//! エージェント内の端末エミュレータが作るので、「本物の claude が吐くバイト列を食わせたら
//! どう見えるか」を確かめないと方式そのものが決まらない。ここで採った録画が、
//! 実機検証#1・#2・#4 と #3 の前倒し計測（`screen_probe.rs`）の入力になる。
//! フェーズ4 では vt100 ゴールデンのフィクスチャを兼ねる（テスト計画フェーズ4）。
//!
//! # なぜ製品と同じ PTY 経路で録るのか
//!
//! [`lifecycle::build_command_with_extra`] と [`PtyProcess`] をそのまま使う。TERM の固定値・
//! 環境変数の許可リスト・読み取りの粒度が製品と1つでも違うと、**本番でエミュレータに届く
//! バイト列とは別物**を録ることになり、フィクスチャとしての意味が無くなる。
//!
//! [`Session`](agent_core::session::Session) を使わないのも同じ理由。あちらの配信は
//! 合流タスク（`coalesce_loop`）を通った後で、設計§7-2 が要求する「合流前の生バイト」では
//! なくなっている。
//!
//! # 記録形式は asciicast v2
//!
//! 1行目がヘッダの JSON、以降が `[経過秒, "o"|"i"|"r", データ]`。この形式を選ぶ理由は3つ。
//!
//! - **出力と入力の両方に時刻が付く**（計画.md フェーズ0 の要求そのもの。実機検証#3 の
//!   前倒し計測は入力時刻を起点に測る）
//! - リサイズも `"r"` で残せる
//! - vt100 が実機検証#1 で落ちたときの乗り換え先 avt は asciinema 本体のエミュレータなので、
//!   同じファイルをそのまま食わせられる
//!
//! # 実行方法
//!
//! ```text
//! make record-terminal
//! ```
//!
//! `#[ignore]` を付けてあるので `make test` では走らない。**本物の claude が起動し、
//! アカウントのクォータを消費する**。cargo はコンテナ、claude と認証情報はホストにあるので、
//! `scripts/record-terminal.sh` が「コンテナでビルド → ホストで実行」に分けている。
//!
//! 書き出し先は既定でリポジトリの外（`$TMPDIR`）。**匿名化を通す前の録画をリポジトリへ
//! 置かない**ための既定値で、`fixtures/` への設置は `scripts/record-terminal.sh` が行う。

// テスト名は日本語で書く（`real_cli.rs` 等と同じ扱い）。
#![allow(non_snake_case)]

use agent_core::session::{
    lifecycle::{self, SessionStart},
    pty::{PtyExit, PtyProcess},
};
use portable_pty::PtySize;
use protocol::ClaudeSessionId;
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{mpsc, oneshot},
    time::{Instant, timeout},
};

/// 録画の書き出し先を差し替える環境変数。既定はリポジトリの外。
const RECORD_DIR_ENV: &str = "AGENTDASHBOARD_RECORD_DIR";

/// 録画に使うモデルを差し替える環境変数。
const MODEL_ENV: &str = "AGENTDASHBOARD_RECORD_MODEL";

/// 既定のモデル。既存の probe（`gen-fixtures.sh` / `rewind-probe.sh`）と揃える。
const DEFAULT_MODEL: &str = "haiku";

/// 録画する端末の大きさ。ブラウザでターミナルを開いたときによくある大きさに寄せる。
///
/// 製品の起動直後は 80x24 で、ブラウザが開いた時点で resize が届く（`session/mod.rs`）。
/// 録画は定常状態を写したいので、最初からその大きさで開く。
const COLS: u16 = 120;
const ROWS: u16 = 40;

/// PTY から受け取るチャンクのキュー長。製品と同じ桁にしておく。
const CHUNK_QUEUE: usize = 256;

/// 1ターンの応答を待つ上限。本物の CLI は考える時間がある。
const TURN_LIMIT: Duration = Duration::from_secs(240);

/// 画面が落ち着いたと見なす無出力の長さ。
///
/// 考えている間はスピナーが 100ms 前後で描き直され続けるので、**出力が途切れたこと**が
/// そのままターンの完了を意味する。画面を読んで「esc to interrupt が消えた」を見る手も
/// あるが、それには端末エミュレータが要る——いま検証しようとしている当のものなので、
/// ここで使うと循環になる。
const SETTLED: Duration = Duration::from_secs(3);

/// 短い操作（メニューの移動など）の落ち着き待ち。
const SETTLED_SHORT: Duration = Duration::from_millis(1200);

/// 手元に残す末尾の長さ。目印は必ず末尾側に出るので全部は要らない。
const TAIL_LIMIT: usize = 32 * 1024;

// ---------------------------------------------------------------------------
// 録画そのもの
// ---------------------------------------------------------------------------

/// asciicast v2 のイベント列を組み立てながら、PTY の出力を読む。
///
/// 受信は所有権を1箇所に集めて、ロックも別タスクも使わない。待ち合わせの都合で
/// 「読む」と「溜める」が必ず同じ場所から呼ばれるため。
struct Recorder {
    start: Instant,
    events: Vec<String>,
    rx: mpsc::Receiver<Vec<u8>>,
    /// UTF-8 の途中で切れたバイトの持ち越し
    carry: Vec<u8>,
    tail: String,
    raw_bytes: usize,
    output_events: usize,
    /// UTF-8 として解釈できなかったバイト数（0 でなければ録画を疑う）
    invalid_bytes: usize,
}

impl Recorder {
    fn new(rx: mpsc::Receiver<Vec<u8>>) -> Self {
        Self {
            start: Instant::now(),
            events: Vec::new(),
            rx,
            carry: Vec::new(),
            tail: String::new(),
            raw_bytes: 0,
            output_events: 0,
            invalid_bytes: 0,
        }
    }

    fn at(&self) -> f64 {
        self.start.elapsed().as_secs_f64()
    }

    fn push(&mut self, code: &str, data: &str) {
        let at = self.at();
        let encoded = serde_json::to_string(data).expect("文字列を JSON へ直せること");
        self.events
            .push(format!("[{at:.6}, \"{code}\", {encoded}]"));
    }

    /// PTY から届いたチャンクを1つ取り込む。
    ///
    /// asciicast のデータは UTF-8 文字列なので、**チャンクの境目で多バイト文字が割れる**と
    /// そのままでは載せられない。割れた尾を次のチャンクへ持ち越すことで、つなぎ直すと
    /// 元のバイト列に一致する状態を保つ。
    fn absorb(&mut self, chunk: &[u8]) {
        self.raw_bytes += chunk.len();
        self.carry.extend_from_slice(chunk);

        let text = match std::str::from_utf8(&self.carry) {
            Ok(text) => {
                let text = text.to_string();
                self.carry.clear();
                text
            }
            Err(error) => {
                let valid = error.valid_up_to();
                let text = String::from_utf8_lossy(&self.carry[..valid]).into_owned();
                match error.error_len() {
                    // 末尾が途中で切れているだけ。残りは次のチャンクへ持ち越す
                    None => {
                        self.carry.drain(..valid);
                    }
                    // 本当に UTF-8 でないバイト。claude の出力では起きないはずなので、
                    // 起きたら分かるように数えておく（テストの最後で 0 を確かめる）
                    Some(len) => {
                        self.invalid_bytes += len;
                        self.carry.drain(..valid + len);
                    }
                }
                text
            }
        };

        if text.is_empty() {
            return;
        }
        self.output_events += 1;
        self.push("o", &text);

        self.tail.push_str(&text);
        if self.tail.len() > TAIL_LIMIT {
            let target = self.tail.len() - TAIL_LIMIT;
            let cut = (target..self.tail.len())
                .find(|index| self.tail.is_char_boundary(*index))
                .unwrap_or(self.tail.len());
            self.tail.drain(..cut);
        }
    }

    /// 出力が `quiet` の間ぴたりと止まるまで読み続ける。
    ///
    /// `limit` を超えたら諦めて戻る（呼び出し側が判断できるよう、落ちたかどうかを返す）。
    async fn settle(&mut self, quiet: Duration, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        loop {
            if Instant::now() >= deadline {
                return false;
            }
            match timeout(quiet, self.rx.recv()).await {
                Ok(Some(chunk)) => self.absorb(&chunk),
                // 送り手が消えた＝子プロセスが終わった
                Ok(None) => return true,
                Err(_) => return true,
            }
        }
    }

    fn seen(&self) -> &str {
        &self.tail
    }

    /// 溜めたイベントを asciicast v2 として書き出す。
    ///
    /// ヘッダに載せるのは端末の大きさと TERM だけにする。asciicast は `command` や `env` に
    /// 起動コマンドやシェルを書けるが、**そこは環境固有の情報がそのまま入る場所**で、
    /// 公開リポジトリへ置くフィクスチャには要らない。
    fn write_cast(&self, path: &Path, title: &str, cols: u16, rows: u16) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("1970年より後であること")
            .as_secs();
        let header = serde_json::json!({
            "version": 2,
            "width": cols,
            "height": rows,
            "timestamp": stamp,
            "title": title,
            "env": { "TERM": lifecycle::TERM_VALUE },
        });

        let mut body = String::new();
        body.push_str(&serde_json::to_string(&header).expect("ヘッダを JSON へ直せること"));
        body.push('\n');
        for event in &self.events {
            body.push_str(event);
            body.push('\n');
        }

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("書き出し先を作れること");
        }
        std::fs::write(path, body).expect("録画を書き出せること");
    }
}

// ---------------------------------------------------------------------------
// 起動と後片付け
// ---------------------------------------------------------------------------

/// 使い捨ての作業ディレクトリ。**`$HOME` の下には作らない**。
///
/// claude の TUI は作業ディレクトリを画面に出す。`$HOME` の下だと利用者名がそのまま
/// 録画に写り込み、匿名化で消す対象が増える。`/tmp` の下なら最初から写らない。
struct WorkDir(PathBuf);

impl WorkDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "agentdashboard-record-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("作業ディレクトリを作れること");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 題材の合成ファイルを置く。
///
/// 実在のコードは使わない。`gen-fixtures.sh` と同じ考え方で、**最初から機微情報が
/// 入らない作り方**にしておくのが安全側。
fn put_material(dir: &Path) {
    std::fs::write(
        dir.join("notes.md"),
        "# サンプルメモ\n\n- [ ] TODO: 集計処理のテストを書く\n- [ ] TODO: README を更新する\n",
    )
    .expect("メモを置けること");
    std::fs::write(
        dir.join("calc.py"),
        "def add(a, b):\n    return a + b\n\n\ndef total(values):\n    result = 0\n    for value in values:\n        result = add(result, value)\n    return result\n",
    )
    .expect("題材を置けること");
}

/// 追加で読み込ませる設定を書く。
///
/// 製品はフックと `statusLine` を注入した設定を渡す（設計§7）。録画で必要なのは
/// **画面の見え方**なので、フックは要らないが `statusLine` は入れる——これは画面に1行
/// 増える設定で、入れないと本番と違う画面を録ることになる。宛先が要らないように
/// 中身は固定文字列にしてある（全角を含めてあるので、桁揃えの確認にも使える）。
fn write_settings(dir: &Path) -> PathBuf {
    let path = dir.join("record-settings.json");
    let settings = serde_json::json!({
        "statusLine": {
            "type": "command",
            "command": "echo '録画用ステータス | AgentDashboard'",
            "refreshInterval": 3,
        }
    });
    std::fs::write(&path, settings.to_string()).expect("設定を書けること");
    path
}

/// 録画中のセッション1本。
struct Recording {
    #[allow(dead_code)]
    dir: WorkDir,
    pty: PtyProcess,
    rec: Recorder,
    exit: oneshot::Receiver<PtyExit>,
    session_id: ClaudeSessionId,
    cols: u16,
    rows: u16,
}

impl Recording {
    /// 端末へ送る。**入力の時刻はここで採る**（実機検証#3 の起点）。
    fn send(&mut self, bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes).into_owned();
        self.rec.push("i", &text);
        self.pty.write_input(bytes).expect("端末へ書き込めること");
    }

    /// 1行送る。文字を入れてから確定するまで少し置くのは、入力欄の描き直しと
    /// 確定の描き直しを別々の出来事として録るため（`rewind-probe.sh` と同じ間の取り方）。
    async fn send_line(&mut self, line: &str) {
        self.send(line.as_bytes());
        self.rec
            .settle(SETTLED_SHORT, Duration::from_secs(10))
            .await;
        self.send(b"\r");
    }

    /// 端末の大きさを変える。asciicast の `"r"` として残す。
    async fn resize(&mut self, cols: u16, rows: u16) {
        self.pty
            .resize(cols, rows)
            .expect("端末の大きさを変えられること");
        self.rec.push("r", &format!("{cols}x{rows}"));
        self.cols = cols;
        self.rows = rows;
        self.rec
            .settle(SETTLED_SHORT, Duration::from_secs(20))
            .await;
    }

    /// 1ターンの応答が終わる（＝出力が止まる）まで待つ。
    async fn wait_turn(&mut self) {
        let settled = self.rec.settle(SETTLED, TURN_LIMIT).await;
        assert!(
            settled,
            "{TURN_LIMIT:?} 以内に応答が終わりませんでした。画面の末尾:\n{}",
            self.rec.seen()
        );
    }

    /// 録画を閉じて書き出す。
    async fn finish(mut self, name: &str) {
        // `/exit` で行儀よく終わらせる。終了までの描き直しも録画に含める
        self.send_line("/exit").await;
        self.rec
            .settle(SETTLED_SHORT, Duration::from_secs(20))
            .await;
        // 反応が無ければ落とす。どちらの道でも最後に kill を呼んでおけば PTY は残らない
        let _ = timeout(Duration::from_secs(10), &mut self.exit).await;
        self.pty.kill();

        assert_eq!(
            self.rec.invalid_bytes, 0,
            "UTF-8 として読めないバイトが混ざりました。録画がバイト列を保てていません"
        );

        let path = record_dir().join(format!("{name}.cast"));
        let title = format!("claude {} / {name}", claude_version());
        self.rec.write_cast(&path, &title, self.cols, self.rows);

        let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        println!(
            "録画: {} （生バイト {} / 出力イベント {} / ファイル {} KiB）",
            path.display(),
            self.rec.raw_bytes,
            self.rec.output_events,
            bytes / 1024
        );

        cleanup_transcript(self.session_id);
    }
}

/// 録画の書き出し先。
fn record_dir() -> PathBuf {
    match std::env::var(RECORD_DIR_ENV) {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => std::env::temp_dir().join("agentdashboard-terminal-record"),
    }
}

fn claude_version() -> String {
    std::process::Command::new(lifecycle::claude_program())
        .arg("--version")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        // 表題に入れるので1行に収める（差し替えた実行ファイルが何行も出す場合がある）
        .and_then(|text| text.lines().next().map(|line| line.trim().to_string()))
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// 実測で `~/.claude/projects/` に生えたトランスクリプトを片付ける。
///
/// 消す前に「本当に projects の下か」「自分が採番したIDのものか」を確かめる。
/// 空文字や `.` を掴むと事故になるので、パスの形を必ず見る（`rewind-probe.sh` と同じ作法）。
fn cleanup_transcript(session_id: ClaudeSessionId) {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let projects = PathBuf::from(home).join(".claude").join("projects");
    let Ok(entries) = std::fs::read_dir(&projects) else {
        return;
    };
    let stem = session_id.to_string();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        // 使い捨ての作業ディレクトリから作られた置き場所だけを対象にする
        let name = dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        if !name.contains("agentdashboard-record-") {
            continue;
        }
        if dir.join(format!("{stem}.jsonl")).exists() && dir.starts_with(&projects) {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

/// 使い捨てのディレクトリで claude を起動し、最初の画面が落ち着くまで進める。
async fn launch(name: &str, permission_mode: &str, cols: u16, rows: u16) -> Recording {
    let dir = WorkDir::new(name);
    put_material(dir.path());
    let settings = write_settings(dir.path());
    let session_id = ClaudeSessionId::new();
    let model = std::env::var(MODEL_ENV).unwrap_or_else(|_| DEFAULT_MODEL.to_string());

    // `--setting-sources project,local` を付ける理由は `rewind-probe.sh` に記録がある。
    // 利用者のグローバル設定でセッション開始時にスキルが起動すると、そのスキルが出す
    // 権限確認がメニューへ送ったキーを吸ってしまい、実測が完走しない。
    // 録画では加えて、**利用者の環境固有の情報が画面に写り込むのを防ぐ**意味もある。
    let extra = vec![
        "--setting-sources".to_string(),
        "project,local".to_string(),
        "--model".to_string(),
        model,
        "--permission-mode".to_string(),
        permission_mode.to_string(),
    ];
    let command = lifecycle::build_command_with_extra(
        &lifecycle::claude_program(),
        dir.path(),
        SessionStart::Fresh(session_id),
        &settings,
        &extra,
    );

    let (chunk_tx, chunk_rx) = mpsc::channel(CHUNK_QUEUE);
    let (pty, exit) = PtyProcess::spawn(
        command,
        PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        },
        chunk_tx,
    )
    .expect("PTY を開けること");

    let mut recording = Recording {
        dir,
        pty,
        rec: Recorder::new(chunk_rx),
        exit,
        session_id,
        cols,
        rows,
    };

    // 起動しきるまで待つ。使い捨てディレクトリではフォルダ信頼の確認が出る
    recording.rec.settle(SETTLED, Duration::from_secs(90)).await;
    if recording.rec.seen().to_lowercase().contains("trust") {
        recording.send(b"\r");
        recording.rec.settle(SETTLED, Duration::from_secs(60)).await;
    }
    assert!(
        recording.rec.raw_bytes > 0,
        "claude が何も出力しませんでした。起動に失敗している可能性があります"
    );
    recording
}

// ---------------------------------------------------------------------------
// シナリオ
// ---------------------------------------------------------------------------

/// 基本：色・全角・スピナー・スクロールバックの素材を採る。
///
/// スラッシュコマンドで画面を埋める手（`/status` や `/help`）は採らない。**利用者の
/// アカウントや導入済みの拡張がそのまま画面に出る**種類の表示があり、公開リポジトリへ
/// 置くフィクスチャとしては危ない。普通の会話を数ターン回せばスクロールバックは埋まる。
#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make record-terminal）"]
async fn 録画_基本() {
    let mut recording = launch("basic", "acceptEdits", COLS, ROWS).await;

    recording
        .send_line("calc.py と notes.md を読んで、それぞれ1行で説明してください。")
        .await;
    recording.wait_turn().await;

    recording
        .send_line("calc.py の add 関数に、日本語の docstring を1行だけ追加してください。")
        .await;
    recording.wait_turn().await;

    recording
        .send_line("いま行った変更を、日本語の箇条書き5行で説明してください。")
        .await;
    recording.wait_turn().await;

    recording.finish("basic").await;
}

/// 対話：入力イベントと再描画の対応を採る（実機検証#3 の前倒し計測の素材）。
///
/// 権限プロンプトへの応答と `/rewind` のメニュー移動は、**入力から TUI が描き直されるまで
/// 遅れる**という設計§7-5 の前提そのものを含む操作で、ホットウィンドウの妥当性は
/// ここでしか測れない。
#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make record-terminal）"]
async fn 録画_対話() {
    // 権限確認が必ず出るモード。`default` の CLI 上の綴りが `manual`（permission.rs の表）
    let mut recording = launch("interactive", "manual", COLS, ROWS).await;

    recording
        .send_line("notes.md の TODO 行を「DONE:」に書き換えてください。")
        .await;
    // 権限確認が出るまでは考えている時間があるので、落ち着くまで待ってから応答する
    recording.wait_turn().await;
    recording.send(b"\r");
    recording.wait_turn().await;

    recording
        .send_line("calc.py の total 関数に、日本語の docstring を1行だけ追加してください。")
        .await;
    recording.wait_turn().await;
    recording.send(b"\r");
    recording.wait_turn().await;

    // `/rewind` のメニュー。候補は古い順に並び、初期選択は (current)。
    // 2つ上＝1ターン目の直前まで戻る（`rewind-probe.sh` で確かめた並び）
    recording.send_line("/rewind").await;
    recording.rec.settle(SETTLED, Duration::from_secs(60)).await;
    recording.send(b"\x1b[A");
    recording
        .rec
        .settle(SETTLED_SHORT, Duration::from_secs(30))
        .await;
    recording.send(b"\x1b[A");
    recording
        .rec
        .settle(SETTLED_SHORT, Duration::from_secs(30))
        .await;
    recording.send(b"\r");
    recording.rec.settle(SETTLED, Duration::from_secs(60)).await;
    // 確認画面。既定の「Restore code and conversation」を選ぶ
    recording.send(b"\r");
    recording.wait_turn().await;
    // 巻き戻すと直前の発言が入力欄に戻ってくるので消しておく
    recording.send(b"\x15");
    recording
        .rec
        .settle(SETTLED_SHORT, Duration::from_secs(30))
        .await;

    recording.finish("interactive").await;
}

/// リサイズ：大きさが変わったときの描き直しを採る。
///
/// フェーズ4 の「リサイズ直後に SCREEN_FULL を送る」（設計§7-4）の検証材料になる。
#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make record-terminal）"]
async fn 録画_リサイズ() {
    let mut recording = launch("resize", "acceptEdits", COLS, ROWS).await;

    // 空の画面をリサイズしても描き直す中身が無いので、先に1ターン回して画面を埋める
    recording
        .send_line("calc.py を読んで、日本語の箇条書き5行で説明してください。")
        .await;
    recording.wait_turn().await;

    recording.resize(80, 24).await;
    recording.resize(140, 50).await;
    recording.resize(COLS, ROWS).await;

    recording.finish("resize").await;
}
