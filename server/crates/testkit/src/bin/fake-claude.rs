//! PTY テスト用の擬似 claude。
//!
//! 本物の CLI を起動せずに PTY のライフサイクル（起動 → 出力読み取り → 入力書き込み →
//! 正常/異常終了 → EOF）と、フック経由の状態通知（設計§5/§7）を検証するためのハーネス。
//! テスト計画フェーズ1 は「スクリプト」と書いているが、Rust バイナリにしているのは、
//! cargo テストがコンテナ内で走るこの環境に Python 等のインタプリタ依存を持ち込まないため。
//!
//! 起動オプション:
//!   fake-claude                    対話モード。1行受け取るごとに応答を返す
//!   fake-claude --exit-code <N>    何もせず終了コード N で終了する（異常終了の検証用）
//!   fake-claude --echo-only        受け取った行をそのまま返す（余計な装飾なし）
//!   fake-claude --help             本物に似せた使い方を出す（権限モードの choices を含む）
//!   （本物と同じく `--session-id <UUID>` `--settings <PATH>` `--permission-mode <MODE>`
//!     `--resume <UUID>` を付けて起動される。知らないオプションは黙って無視する）
//!
//! 対話モードで受け付ける命令:
//!   dump          自分の起動引数と環境変数を1行ずつ書き出す
//!   flood <N>     N バイトをまとめて吐き出す（フロー制御と大量出力の検証用）
//!   hook <名前> [JSON]  注入された settings のフックを実際に起動する
//!   jsonl <元ファイル> [行数]  フックが運ぶトランスクリプトへ JSONL を追記する
//!   queue <本文>  待ち行列へ1件入れる（`queue-operation` の `enqueue` を書く）
//!   dequeue       待ち行列から1件取り出す（本文を持たない）
//!   said <本文>   読まれた指示を、本物の発言レコードとして書く
//!   crash <N>     終了コード N で自ら異常終了する
//!   exit          終了する
//!   その他        受け取った行を返す
//!
//! # 権限モードの模擬（設計§11 の実測に合わせる）
//!
//! 本物の TUI は画面下部にフッタ（`⏸ manual mode on` 等）を出し続け、Shift+Tab で
//! モードを巡回する。ダッシュボードはフッタからモードを読み、Shift+Tab を送って
//! 切り替えるので、**その2つを擬似 claude でも本物と同じ形で再現する**。これができないと、
//! 切替の検証が本物の claude を起こす経路（＝クォータを使う経路）でしかできなくなる。
//!
//! # 行単位ではなくバイト単位で読む
//!
//! Shift+Tab（`ESC [ Z`）は**改行を伴わない**。端末が既定の行編集モード（icanon）の
//! ままだと、改行が来るまで子プロセスへ届かず、切替のキーが永久に読めない。起動時に
//! `stty -icanon` で行編集だけを切り、**エコーは残す**（ブラウザの端末に打った文字が
//! 出るのは行編集ではなくエコーの働きで、既存のテストがそれを見ている）。

use std::io::{Read as _, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use testkit::fake_claude::{
    ARGV_PREFIX, BYE_MARKER, BYPASS_ACCEPTED_MARKER, BYPASS_NOTICE, BYPASS_OPTIONS,
    CANCELLED_MARKER, CRASH_MARKER, CYCLE_MODES, DEQUEUED_MARKER, DUMP_END_MARKER, ENV_PREFIX,
    FLOOD_END_MARKER, FLOOD_PATTERN, FOOTER_PREFIX, HOOK_FAILED_PREFIX, HOOK_SENT_PREFIX,
    JSONL_APPENDED_PREFIX, JSONL_FAILED_PREFIX, MODEL_SET_PREFIX, MODEL_SWITCH_NOTICE,
    MODEL_SWITCH_OPTIONS, QUEUED_PREFIX, READY_MARKER, RECEIVED_PREFIX, REPLIED_PREFIX,
    RESIZED_PREFIX, SAID_PREFIX, STATUS_LINE_SENT_PREFIX, footer_for, physical_lines,
    render_dialog, resolve_model,
};

/// 起動時に受け取った、フック実行に必要な情報。
struct Injected {
    session_id: String,
    /// `--transcript` で渡された書き出し先。フックが運ぶ値もこれになる
    transcript: Option<String>,
    settings: Option<serde_json::Value>,
    /// いまの権限モード（正規値）。フックの payload にもこれを載せる
    mode: String,
    /// 起動時に全承認をスキップを指定したか。**巡回に bypass が入るかどうかが変わる**
    launched_bypass: bool,
    /// いま名乗っているモデル。注入設定の `model` が初期値になる（設計§6 の主の仕掛け）。
    ///
    /// **複数スレッドから触る。** `refreshInterval` の周期実行が別スレッドで走るので、
    /// 本体が `/model` で書き換えるのと同時に読まれうる
    model: Arc<Mutex<String>>,
    /// 最後に statusLine を走らせた時刻。デバウンスの判定に使う
    last_status_line: Option<std::time::Instant>,
}

/// statusLine のデバウンス幅。
///
/// 本物は 300ms でまとめる（公式ドキュメント明記）。**ここを省くと1行ごとに子プロセスが
/// 起きる**ので、行を多く送るテストが軒並み重くなり、資源を取り合う別のテストが
/// 巻き添えで落ちる（実際にコアレッシングの測定が不安定になった）。
const STATUS_LINE_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(300);

impl Injected {
    /// Shift+Tab の巡回に入るモードを、実測の順序で並べる（設計§11）。
    fn cycle(&self) -> Vec<&'static str> {
        let mut modes: Vec<&'static str> = Vec::new();
        if self.launched_bypass {
            modes.push("bypassPermissions");
        }
        modes.extend(CYCLE_MODES);
        modes
    }

    /// 注入設定から `statusLine` のコマンド行を取り出す。
    fn status_line_command(&self) -> Option<String> {
        self.settings.as_ref()?["statusLine"]["command"]
            .as_str()
            .map(str::to_string)
    }

    /// 注入設定から `refreshInterval`（秒）を取り出す。
    fn refresh_secs(&self) -> Option<u64> {
        self.settings.as_ref()?["statusLine"]["refreshInterval"].as_u64()
    }

    /// いま名乗っているモデルの別名。
    fn model(&self) -> String {
        self.model.lock().expect("ロックが壊れていない").clone()
    }

    /// 1つ進めた先のモード。いまのモードが巡回に入っていなければ先頭へ。
    fn next_mode(&self) -> String {
        let cycle = self.cycle();
        let at = cycle.iter().position(|mode| *mode == self.mode);
        match at {
            Some(at) => cycle[(at + 1) % cycle.len()].to_string(),
            None => cycle[0].to_string(),
        }
    }
}

/// 本物に似せた `--help`。`--permission-mode` の choices の形だけを合わせる。
///
/// 折り返しをまたぐのも本物と同じにしてある（そこを解析できることが検証の対象）。
const HELP_TEXT: &str = "\
Usage: fake-claude [options]

Options:
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: \"acceptEdits\", \"auto\",
                                        \"bypassPermissions\", \"manual\",
                                        \"dontAsk\", \"plan\")
  --session-id <uuid>                   Use a specific session ID
  --resume <uuid>                       Resume a conversation
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|arg| arg == "--help") {
        print!("{HELP_TEXT}");
        return;
    }

    let mut echo_only = false;
    let mut session_id = String::new();
    let mut settings_path: Option<String> = None;
    let mut transcript_path: Option<String> = None;
    let mut mode: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            // 本物と同じく権限モードを受け取る。CLI の別名 manual は正規値へ寄せる
            "--permission-mode" => {
                mode = args.get(index + 1).map(|value| match value.as_str() {
                    "manual" => "default".to_string(),
                    other => other.to_string(),
                });
                index += 2;
            }
            "--exit-code" => {
                let code = args
                    .get(index + 1)
                    .and_then(|value| value.parse::<i32>().ok())
                    .unwrap_or(1);
                std::process::exit(code);
            }
            "--echo-only" => {
                echo_only = true;
                index += 1;
            }
            // 本物と同じく、ダッシュボードが採番したIDを受け取る。
            //
            // `--resume` も同じ扱いにする。**本物は `--fork-session` を付けないかぎり
            // 元のIDを再利用する**（接続断のカードを復旧ボタンで戻す 設計§15-1 で実測。
            // 同じ JSONL へ完全な追記になり、ファイル内の `sessionId` も頼んだ値のまま
            // 1つだけだった）ので、名乗り直す形にするほうが本物に近い。
            "--session-id" | "--resume" => {
                session_id = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            // 本物と同じく、追加で読み込む設定ファイルを受け取る（設計§7）
            "--settings" => {
                settings_path = args.get(index + 1).cloned();
                index += 2;
            }
            // 本物には無い。フックが運ぶ transcript_path を実在するパスにして、
            // `jsonl` 命令で中身を書けるようにするためのテスト用の入口
            "--transcript" => {
                transcript_path = args.get(index + 1).cloned();
                index += 2;
            }
            _ => index += 1,
        }
    }

    let launched_bypass = mode.as_deref() == Some("bypassPermissions");
    let settings: Option<serde_json::Value> = settings_path
        .as_deref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok());
    // 注入設定の `model` を初期値として名乗る（設計§6 の主の仕掛け）。
    // 指定が無ければ本物と同じくアカウントの既定＝`default` で始まる
    let initial_model = settings
        .as_ref()
        .and_then(|value| value["model"].as_str())
        .unwrap_or("default")
        .to_string();
    let mut injected = Injected {
        session_id,
        transcript: transcript_path,
        settings,
        // 指定が無ければ本物と同じく既定（毎回確認する）で始まる
        mode: mode.unwrap_or_else(|| "default".to_string()),
        launched_bypass,
        model: Arc::new(Mutex::new(initial_model)),
        last_status_line: None,
    };

    // 行編集を切る。Shift+Tab は改行を伴わないので、これが無いと切替のキーが届かない。
    // エコーは残す（ブラウザの端末に打った文字が出るのはエコーの働き）
    let _ = Command::new("stty")
        .args(["-icanon", "min", "1", "time", "0"])
        .status();

    // SIGWINCH（画面サイズの変更）に反応する。本物も反応する（再描画で応える）——
    // 擬似はテストが読める形＝マーカー1行で応える。「リサイズが子まで届いた」ことを
    // PTY の外から観測する唯一の口（PTY のサイズに getter は無い）
    #[cfg(unix)]
    start_winch_reporter();

    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    // 全承認をスキップで起動した初回だけ、本物は責任の受諾を尋ねてくる。
    // **答えるまで起動は完了しない**ので、`ready` もフッタもまだ出さない。
    // ここを先に出してしまうと、受諾より先に指示が届いて黙って捨てられる
    // （テストからは「フックが飛ばない」という分かりにくい形でしか見えない）
    let mut awaiting_accept = launched_bypass;
    if awaiting_accept {
        let _ = writeln!(out, "{}", render_dialog(BYPASS_NOTICE, BYPASS_OPTIONS, 0));
    } else {
        let _ = writeln!(out, "{READY_MARKER}");
        let _ = writeln!(out, "{FOOTER_PREFIX}{}", footer_for(&injected.mode));
    }
    let _ = out.flush();

    // 本物は「セッション開始時」に statusLine を1回走らせる（設計§11 前提6）
    send_status_line(&mut out, &mut injected, true);
    start_refresh_ticker(&injected);

    // 会話が進んだかどうか。**進んでいるときだけ**モデル切替の確認画面が出る（本物と同じ）
    let mut conversation_started = false;
    // 確認画面を出している間、答えを待っている切替先
    let mut awaiting_model_choice: Option<String> = None;
    // 選択ダイアログで**いま選ばれている位置**。本物は方向キーで動き、Enter で確定する
    let mut choice = 0usize;
    // これまでに出した添付チップの数。**通し番号**なので送信をまたいでも戻さない
    let mut image_marks = 0usize;
    // 貼り付けで受け取り、まだ確定していない画像の置き場所
    let mut pending_images: Vec<String> = Vec::new();
    // 記録に書いたターンの数。レコードの `uuid` と `promptId` を分けるための連番
    let mut image_turns = 0usize;
    // `said` で書いた発言の数。こちらも `uuid` を分けるための連番
    let mut said_turns = 0usize;
    // `replied` で書いたアシスタント本文の数。同じく `uuid` を分けるための連番
    let mut replied_turns = 0usize;

    for input in InputReader::new() {
        let line = match input {
            // Shift+Tab。モードを1つ進めてフッタを出し直す
            Input::Cycle => {
                if awaiting_accept {
                    continue;
                }
                injected.mode = injected.next_mode();
                let _ = writeln!(out, "{FOOTER_PREFIX}{}", footer_for(&injected.mode));
                let _ = out.flush();
                continue;
            }
            // 矢印。**選択ダイアログが出ている間だけ**選択を動かして描き直す。
            // 出ていないときに何もしないのは本物と同じ（気を利かせない）
            key @ (Input::Up | Input::Down) => {
                let options = if awaiting_accept {
                    Some((BYPASS_NOTICE, BYPASS_OPTIONS))
                } else if awaiting_model_choice.is_some() {
                    Some((MODEL_SWITCH_NOTICE, MODEL_SWITCH_OPTIONS))
                } else {
                    None
                };
                if let Some((header, items)) = options {
                    let last = items.len() - 1;
                    // 端で止める（本物は巡回しない。行き過ぎても選択は動かない）
                    let down = matches!(key, Input::Down);
                    let moved = if down && choice < last {
                        choice + 1
                    } else if !down && choice > 0 {
                        choice - 1
                    } else {
                        choice
                    };
                    // **描き直す前に、いま出ているものを消す。**
                    //
                    // 消さずに新しいのを書き足すと、押した回数だけダイアログが積み上がる。
                    // **本物はその場で描き直す**ので、積み上がるのは擬似だけの姿になる。
                    //
                    // 実害が出た形（十字ボタンのイシュー フェーズ5）：エコーが `^[[B` という
                    // 字として1行を占めるため、確定のときの `clear_dialog` が新しいほうしか
                    // 消せず、**前のダイアログが画面に残る**。画面テキストから「いま選択待ちか」を
                    // 導く側から見ると、閉じたのに選択待ちのままに見える
                    clear_dialog(&mut out, &render_dialog(header, items, choice));
                    choice = moved;
                    let _ = writeln!(out, "{}", render_dialog(header, items, choice));
                    let _ = out.flush();
                }
                continue;
            }
            // 貼り付けから拾った画像のぶんだけチップを出す。**番号は通し**で、
            // セッションを跨いでも振り直さない（本物の実測・設計§21 読み替え1）
            Input::PasteEnd(images) => {
                // 本物はディスクから読んで縮めるので、すぐには出ない
                std::thread::sleep(IMAGE_DELAY);
                for _ in &images {
                    image_marks += 1;
                    let _ = write!(out, "[Image #{image_marks}]");
                }
                let _ = out.flush();
                // 確定が来るまで抱えておく。**記録は確定したターンのぶんだけ**書く
                // ——チップが出た時点で書くと、送らずに畳んだぶんまで履歴に残る
                pending_images = images;
                continue;
            }
            // 入力欄が畳まれた。**チップごと消える**のが `Ctrl+U` との違い
            Input::Cancel => {
                // 送らずに畳んだので、記録にも残さない
                pending_images.clear();
                let _ = writeln!(out, "{CANCELLED_MARKER}");
                let _ = out.flush();
                continue;
            }
            Input::Line(line) => line,
        };
        let line = line.trim_end_matches('\r');

        // 受諾の画面が出ている間は、選択肢の番号か **CR（いま選ばれているものを確定）** を受ける。
        // 本物は方向キーで選んで Enter で確定するので、番号だけを受ける形は嘘になる
        if awaiting_accept {
            let picked = match line.trim() {
                "1" => Some(0),
                "2" => Some(1),
                // CR だけ ＝ 選択中の項目を確定
                "" => Some(choice),
                _ => None,
            };
            if picked == Some(0) {
                // 「No, exit」。**本物はここで終わる**ので、そちらへ合わせる
                let _ = writeln!(out, "{BYE_MARKER}");
                let _ = out.flush();
                break;
            }
            if picked == Some(1) {
                awaiting_accept = false;
                choice = 0;
                clear_dialog(
                    &mut out,
                    &render_dialog(BYPASS_NOTICE, BYPASS_OPTIONS, choice),
                );
                let _ = writeln!(out, "{BYPASS_ACCEPTED_MARKER}");
                let _ = writeln!(out, "{READY_MARKER}");
                let _ = writeln!(out, "{FOOTER_PREFIX}{}", footer_for(&injected.mode));
                let _ = out.flush();
            }
            continue;
        }

        // モデル切替の確認画面。こちらも番号と CR の両方を受ける
        if let Some(target) = awaiting_model_choice.clone() {
            let picked = match line.trim() {
                "1" => Some(0),
                "2" => Some(1),
                "" => Some(choice),
                _ => None,
            };
            match picked {
                Some(0) => {
                    awaiting_model_choice = None;
                    choice = 0;
                    clear_dialog(
                        &mut out,
                        &render_dialog(MODEL_SWITCH_NOTICE, MODEL_SWITCH_OPTIONS, 0),
                    );
                    apply_model(&mut out, &injected, &target);
                }
                Some(1) => {
                    awaiting_model_choice = None;
                    choice = 0;
                    clear_dialog(
                        &mut out,
                        &render_dialog(MODEL_SWITCH_NOTICE, MODEL_SWITCH_OPTIONS, 0),
                    );
                    let _ = writeln!(out, "{MODEL_SET_PREFIX}（取りやめ）");
                    let _ = out.flush();
                }
                _ => {}
            }
            continue;
        }

        if line == "exit" {
            let _ = writeln!(out, "{BYE_MARKER}");
            let _ = out.flush();
            break;
        }

        // 本物と同じく `/model <値>` でモデルを切り替える。
        // **会話が進んでいると確認を求める**（設計§11 前提2 で実測）
        if let Some(target) = line.strip_prefix("/model ") {
            let target = target.trim().to_string();
            if conversation_started {
                choice = 0;
                let _ = writeln!(
                    out,
                    "{}",
                    render_dialog(MODEL_SWITCH_NOTICE, MODEL_SWITCH_OPTIONS, 0)
                );
                let _ = out.flush();
                awaiting_model_choice = Some(target);
            } else {
                apply_model(&mut out, &injected, &target);
            }
            continue;
        }

        if line == "dump" {
            dump(&mut out);
            continue;
        }

        // 画面へ好きな1行を出す。**停滞したカードの画面読み**（`session::activity`）を
        // 相手にするテストのために足した。
        //
        // **本物の claude が出す「走っている印」（`✽ Ebbing… (2m 10s)`）を再現する口が
        // 他に無い。** 既定のエコーは `[fake-claude] received: ` が付くので印にならず、
        // 印は行の頭に無ければならない。`RESIZED_PREFIX` を足したときと同じ理由で、
        // PTY の外から観測できる形が要る。
        //
        // **打鍵のエコー側は印にならない。** こちらの行は `paint ` で始まるので、
        // 行の頭が5文字の語になり、判定は落ちる。
        if let Some(rest) = line.strip_prefix("paint ") {
            let _ = writeln!(out, "{}", rest.trim_end());
            let _ = out.flush();
            continue;
        }

        if let Some(size) = line.strip_prefix("flood ") {
            flood(&mut out, size.trim().parse::<usize>().unwrap_or(0));
            continue;
        }

        if let Some(rest) = line.strip_prefix("hook ") {
            hook(&mut out, &injected, rest.trim());
            continue;
        }

        if let Some(rest) = line.strip_prefix("jsonl ") {
            append_jsonl(&mut out, &injected, rest.trim());
            continue;
        }

        // 待ち行列へ1件入れる（作業中に送った追加メッセージ テスト計画フェーズ1）。
        //
        // **書いただけでは読まれない。** 本物はターンの区切りでフックを撃ち、それが
        // セッションホストに履歴を読ませる契機になる（画像のターンと同じ理由）。
        // ここを省くと「ファイルには在るのに画面に出ない」形で E2E だけが落ちる
        if let Some(rest) = line.strip_prefix("queue ") {
            let text = rest.trim();
            append_queue(&injected, "enqueue", Some(text));
            let _ = writeln!(out, "{QUEUED_PREFIX}{text}");
            let _ = out.flush();
            hook(&mut out, &injected, "Stop");
            continue;
        }

        // 待ち行列から取り出す（読まれた／取り消された）。**本文は持たない**
        if line.trim() == "dequeue" {
            append_queue(&injected, "dequeue", None);
            let _ = writeln!(out, "{DEQUEUED_MARKER}");
            let _ = out.flush();
            hook(&mut out, &injected, "Stop");
            continue;
        }

        // 読まれた指示を、本物の発言レコードとして書く
        if let Some(rest) = line.strip_prefix("said ") {
            let text = rest.trim();
            said_turns += 1;
            append_said(&injected, text, said_turns);
            let _ = writeln!(out, "{SAID_PREFIX}{text}");
            let _ = out.flush();
            hook(&mut out, &injected, "Stop");
            continue;
        }

        // アシスタントの発言レコードを1件書く。
        //
        // **待っているあいだに、エージェント側だけが喋る状況を作るための口**である
        // （作業中に送った追加メッセージ 設計§7-5）。`jsonl` でフィクスチャを流すと
        // **その中の `dequeue` が待たせている指示を巻き添えで畳む**ので、
        // 並びを見たいテストでは使えない
        if let Some(rest) = line.strip_prefix("replied ") {
            let text = rest.trim();
            replied_turns += 1;
            append_replied(&injected, text, replied_turns);
            let _ = writeln!(out, "{REPLIED_PREFIX}{text}");
            let _ = out.flush();
            hook(&mut out, &injected, "Stop");
            continue;
        }

        if let Some(code) = line.strip_prefix("crash ") {
            let _ = writeln!(out, "{CRASH_MARKER}");
            let _ = out.flush();
            std::process::exit(code.trim().parse::<i32>().unwrap_or(1));
        }

        if echo_only {
            let _ = writeln!(out, "{line}");
        } else {
            let _ = writeln!(out, "{RECEIVED_PREFIX}{line}");
        }
        let _ = out.flush();

        // 画像を抱えたまま確定した＝画像付きのターン。**本物と同じ2レコード**を書く
        if !pending_images.is_empty() {
            image_turns += 1;
            let paths = std::mem::take(&mut pending_images);
            append_image_turn(&injected, line, &paths, image_turns);
            // **書いただけでは読まれない。** 本物はターンの終わりにフックを撃ち、
            // それがセッションホストに履歴を読ませる契機になる（初期実装§5）。
            // ここを省くと「ファイルには在るのに画面に出ない」形で E2E だけが落ちる
            hook(&mut out, &injected, "Stop");
        }

        // 本物は「新しいアシスタントメッセージが届いたとき」に statusLine を走らせる
        conversation_started = true;
        send_status_line(&mut out, &mut injected, true);
    }
}

/// 選択ダイアログを画面から消す。
///
/// **本物の TUI は選択が終わると描き直してダイアログを消す。** 擬似 claude は行を追記して
/// いくだけなので、何もしないと確定した後も画面に残り続ける——ブラウザの判定は**可視領域**を
/// 見るので、残っていると「まだ選択待ち」と読まれ、次に打った Enter まで確定になる
/// （E2E で実際に踏んだ）。
///
/// 画面を丸ごと消す（`ESC[2J`）と**スクロールバックまで巻き込んで**既存のテストが読めなく
/// なるので、カーソルをダイアログの先頭へ戻して、そこから下だけを消す。
fn clear_dialog(out: &mut impl Write, dialog: &str) {
    // **論理行では足りない。** 狭い画面では選択肢が折り返して**2行を占める**ので、
    // 論理行ぶんしか上げないと下側が消え残る。残ったものをブラウザの判定が読んで
    // **閉じたのに十字が出たまま**になる（[`physical_lines`]）
    let lines = physical_lines(dialog, terminal_cols());
    // **桁も戻す。** カーソルを上げるだけだと桁はそのまま残るので、行の途中から
    // 消し始めて左側が生き残る。矢印のエコー（`^[[B`）で桁が進んでいる状態から
    // 呼ばれるので、`\r` が無いと消し残す
    let _ = write!(out, "\x1b[{lines}A\r\x1b[J");
    let _ = out.flush();
}

/// いまの端末の桁数。**取れなければ 80**（端末の既定）。
///
/// 折り返しを数えるのに要る。`TIOCGWINSZ` は Windows の libc に無いので囲ってある
/// （リリースは Windows でもワークスペース全体を作るため。[`start_winch_reporter`] と同じ理由）。
fn terminal_cols() -> usize {
    #[cfg(unix)]
    {
        let mut size: libc::winsize = unsafe { std::mem::zeroed() };
        if unsafe { libc::ioctl(0, libc::TIOCGWINSZ, &mut size) } == 0 && size.ws_col > 0 {
            return usize::from(size.ws_col);
        }
    }
    80
}

/// SIGWINCH を受けたら、いまの画面サイズをマーカー1行で報告する。
///
/// # なぜ自己パイプなのか
///
/// シグナルハンドラの中でできることは限られている（async-signal-safe な関数だけ）。
/// `write(2)` はその1つなので、ハンドラは**パイプへ1バイト書くだけ**にして、
/// サイズの取得と報告は普通のスレッドで行う。
///
/// # なぜ標準出力のロックを通さないのか
///
/// main は起動直後に `stdout.lock()` を取って持ち続けるので、別スレッドから
/// `println!` するとロック待ちで永久に止まる。fd 1 へ直接 `write(2)` すれば、
/// 1回の write は行単位で崩れずに出る（割り込まれるのは行と行の間だけ）。
///
/// # Unix 専用
///
/// SIGWINCH も ioctl(TIOCGWINSZ) も Windows の libc には無い。リリースは
/// **Windows でもワークスペース全体を作る**ので、囲わないとタグを打つまで
/// 気づけない形で3 OS ビルドが落ちる（v0.1.13 の1回目で実際に落ちた）。
#[cfg(unix)]
fn start_winch_reporter() {
    use std::sync::atomic::{AtomicI32, Ordering};

    static PIPE_WRITE: AtomicI32 = AtomicI32::new(-1);

    extern "C" fn on_winch(_: libc::c_int) {
        let fd = PIPE_WRITE.load(Ordering::Relaxed);
        if fd >= 0 {
            let byte = 1u8;
            unsafe { libc::write(fd, std::ptr::from_ref(&byte).cast(), 1) };
        }
    }

    let mut fds = [0i32; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    PIPE_WRITE.store(fds[1], Ordering::Relaxed);
    // glibc の signal(2) は BSD 意味論（SA_RESTART）なので、main の stdin 読みは
    // シグナルで中断されず勝手に再開される（EINTR で行読みが壊れることはない）
    unsafe { libc::signal(libc::SIGWINCH, on_winch as *const () as usize) };

    let read_fd = fds[0];
    std::thread::spawn(move || {
        let mut byte = [0u8; 1];
        loop {
            let read = unsafe { libc::read(read_fd, byte.as_mut_ptr().cast(), 1) };
            if read <= 0 {
                return;
            }
            let mut size: libc::winsize = unsafe { std::mem::zeroed() };
            if unsafe { libc::ioctl(0, libc::TIOCGWINSZ, &mut size) } == 0 {
                let line = format!("{RESIZED_PREFIX}{}x{}\n", size.ws_col, size.ws_row);
                unsafe { libc::write(1, line.as_ptr().cast(), line.len()) };
            }
        }
    });
}

/// モデルを切り替えて名乗り直す。
///
/// # 切り替えただけでは statusLine を走らせない
///
/// **本物の契機にモデル変更は入っていない**（設計§11 前提6 で実測）。ここで走らせて
/// しまうと、ダッシュボード側の楽観更新と `refreshInterval` による確定という経路
/// （設計§5）が一度も試されないまま「動いているように見える」テストになる。
fn apply_model(out: &mut impl Write, injected: &Injected, target: &str) {
    *injected.model.lock().expect("ロックが壊れていない") = target.to_string();
    let _ = writeln!(out, "{MODEL_SET_PREFIX}{target}");
    let _ = out.flush();
}

/// 注入された `statusLine` を子プロセスとして実行する（設計§4）。
///
/// 本物と同じ形の JSON を標準入力へ渡す。キーは実測した12個のうち、ダッシュボードが
/// 読む3つ（`session_id` / `transcript_path` / `model`）を中心に揃えてある。
fn send_status_line(out: &mut impl Write, injected: &mut Injected, announce: bool) {
    // 本物と同じ 300ms のデバウンス。連続した契機は1回にまとめる
    let now = std::time::Instant::now();
    if let Some(last) = injected.last_status_line
        && now.duration_since(last) < STATUS_LINE_DEBOUNCE
    {
        return;
    }
    let Some(command) = injected.status_line_command() else {
        return;
    };
    injected.last_status_line = Some(now);
    let alias = injected.model();
    let (id, display_name) = resolve_model(&alias);
    let payload = serde_json::json!({
        "session_id": injected.session_id,
        "transcript_path": transcript_path(injected),
        "cwd": std::env::current_dir().unwrap_or_default().to_string_lossy(),
        "model": { "id": id, "display_name": display_name },
        "version": "2.1.220",
    });

    let result = run_hook(&command, &payload.to_string());
    if announce {
        match result {
            Ok(_) => {
                let _ = writeln!(out, "{STATUS_LINE_SENT_PREFIX}{id}");
            }
            Err(reason) => {
                let _ = writeln!(out, "{HOOK_FAILED_PREFIX}statusLine: {reason}");
            }
        }
        let _ = out.flush();
    }
}

/// `refreshInterval` の周期実行を始める（設計§11 前提6）。
///
/// **標準出力には何も書かない。** 本体の書き込みと混ざると、テストが待っている
/// マーカーの途中に別の行が割り込む。周期実行が効いていることは、ダッシュボードの
/// `SessionMeta` が更新されることで観測する。
fn start_refresh_ticker(injected: &Injected) {
    let Some(secs) = injected.refresh_secs().filter(|secs| *secs > 0) else {
        return;
    };
    let Some(command) = injected.status_line_command() else {
        return;
    };
    let session_id = injected.session_id.clone();
    let transcript = transcript_path(injected);
    let model = Arc::clone(&injected.model);

    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(secs));
            let alias = model.lock().expect("ロックが壊れていない").clone();
            let (id, display_name) = resolve_model(&alias);
            let payload = serde_json::json!({
                "session_id": session_id,
                "transcript_path": transcript,
                "model": { "id": id, "display_name": display_name },
                "version": "2.1.220",
            });
            let _ = run_hook(&command, &payload.to_string());
        }
    });
}

/// 標準入力から読み取った1件。
enum Input {
    /// 改行で区切られた1行
    Line(String),
    /// Shift+Tab（`ESC [ Z`）。改行を伴わないので行としては読めない
    Cycle,
    /// 上矢印（`ESC [ A`）。選択ダイアログの選択を1つ戻す
    Up,
    /// 下矢印（`ESC [ B`）。選択ダイアログの選択を1つ進める
    Down,
    /// 貼り付けが終わった（`ESC [ 2 0 1 ~`）。中身は**行末が画像の拡張子だった行**。
    ///
    /// 本物は貼り付けを受け取った時点でディスクから画像を読み、入力欄へチップを出す
    /// （画像添付 設計§1-1）。**確定より前に出る**ので、送る側はこれを見てから確定できる。
    PasteEnd(Vec<String>),
    /// `Esc` を2回。本物はこれで入力欄が畳まれる（画像添付 設計§21 読み替え3）。
    ///
    /// **`Ctrl+U` とは別物。** あちらはテキストしか消さず、添付のチップは残る。
    Cancel,
}

/// 画像を読み終えてチップを出すまでの間。
///
/// **0 にしてはいけない。** 本物は貼り付けからチップまで実測 200ms 前後かかる
/// （画像添付 設計§21 読み替え2）ので、ここを即時にすると **「印を待たずに確定する」
/// 実装でもテストが通ってしまう**——待たせる仕組みを確かめられなくなる。
/// 待ちの上限（5秒）よりは十分短くする。
const IMAGE_DELAY: std::time::Duration = std::time::Duration::from_millis(300);

/// 貼り付けの中から、画像として拾われる行を抜き出す。
///
/// 本物の判定は**断片の末尾**が画像の拡張子かどうかで、切れ目は改行と「スペース＋パスの
/// 始まり」しかない（設計§6-1）。ここでは**行末だけ**を見る——ダッシュボードがパスを
/// 1行に1つ・行末に置くと決めた（§6）ので、擬似が拾う形もそれに合わせる。
///
/// **表を製品と共有しない。** ここは本物の claude の代役であって、ダッシュボードの
/// 対応表を写すと「自分で決めた表を自分で満たす」テストになる。
fn pasted_images(body: &str) -> Vec<String> {
    const 拡張子: &[&str] = &[".png", ".jpg", ".jpeg", ".gif", ".webp"];
    body.lines()
        .map(str::trim_end)
        .filter(|line| {
            let lower = line.to_lowercase();
            拡張子.iter().any(|ext| lower.ends_with(ext))
        })
        .map(str::to_string)
        .collect()
}

/// 標準入力を**バイト単位**で読み、行と Shift+Tab に振り分ける。
///
/// 行編集を切ってあるので、1バイトずつ届く。改行を待たずに制御シーケンスを拾えるのが要点。
struct InputReader {
    buffer: Vec<u8>,
    /// 貼り付けの最中に見つけた画像のパス。
    ///
    /// **貼り付けの終わりでまとめて数えられない。** この読み手は貼り付けの中の改行も
    /// 行の区切りとして扱う（複数行の指示が行ごとに届く、という既存の振る舞い）ので、
    /// `201~` に着いた時点で手元に残っているのは**最後の断片だけ**になる。
    /// 通り過ぎるたびに拾っておかないと、2枚目以降を取りこぼす。
    pasted: Vec<String>,
}

impl InputReader {
    fn new() -> Self {
        Self {
            buffer: Vec::new(),
            pasted: Vec::new(),
        }
    }

    /// いま溜まっている断片が画像なら覚える。
    fn 拾う(&mut self) {
        let fragment = String::from_utf8_lossy(&self.buffer).into_owned();
        self.pasted.extend(pasted_images(&fragment));
    }

    fn read_byte(&mut self) -> Option<u8> {
        let mut byte = [0u8; 1];
        match std::io::stdin().read(&mut byte) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(byte[0]),
        }
    }
}

impl InputReader {
    /// `ESC [` の続きを**終端バイトまで**読み切って、その中身を返す。
    ///
    /// 途中で読むのをやめてはいけない。貼り付けの合図（`ESC [ 2 0 0 ~`）を
    /// 途中まで食べると、残りの `0 0 ~` が本文へ紛れ込む。本物の TUI は
    /// 制御シーケンスを解釈して**表示にも本文にも出さない**ので、そちらに合わせる。
    fn read_csi(&mut self) -> Option<String> {
        let mut body = String::new();
        loop {
            let byte = self.read_byte()?;
            body.push(byte as char);
            // CSI の終端は 0x40〜0x7E（`Z` や `~` など）
            if (0x40..=0x7e).contains(&byte) {
                return Some(body);
            }
        }
    }
}

impl Iterator for InputReader {
    type Item = Input;

    fn next(&mut self) -> Option<Input> {
        loop {
            let byte = self.read_byte()?;
            match byte {
                // 入力行を消す（Ctrl+U）。本物の TUI と同じく、溜めていた本文を捨てる。
                // ダッシュボードは指示を送る前にこれを打つ（設計§18）
                0x15 => self.buffer.clear(),
                // ESC で始まる並び。`[Z` が Shift+Tab、`CR` が改行で、他は解釈して捨てる
                0x1b => match self.read_byte()? {
                    // `Esc` を2回。入力欄を畳む（画像添付 設計§21 読み替え3）。
                    // **溜めていた本文も添付のチップも消える**
                    0x1b => {
                        self.buffer.clear();
                        self.pasted.clear();
                        return Some(Input::Cancel);
                    }
                    // Shift+Enter（と Option+Enter）。**確定ではなく改行**。
                    //
                    // 本物がこの並びを改行として扱うことは、claude のバイナリが
                    // `/terminal-setup` で VS Code へ書き込む keybinding で確かめた。
                    // `{ key: "shift+enter", ..., args: { text: "\x1B\r" } }`（v2.1.220）
                    b'\r' | b'\n' => self.buffer.push(b'\n'),
                    // **矢印も拾う。** 本物の選択ダイアログは方向キーで選択が動くので、
                    // ここで捨てるとブラウザから選び直せるかを確かめられない
                    b'[' => match self.read_csi()?.as_str() {
                        "Z" => return Some(Input::Cycle),
                        "A" => return Some(Input::Up),
                        "B" => return Some(Input::Down),
                        // 貼り付けの終わり。**ここで拾う**——確定の CR より前に出さないと、
                        // 送る側が「印を見てから確定する」道を確かめられない
                        // 貼り付けの始まり。前の貼り付けの拾い物を持ち越さない
                        "200~" => self.pasted.clear(),
                        "201~" => {
                            // 最後の断片はまだ行になっていないので、ここで拾う
                            self.拾う();
                            let images = std::mem::take(&mut self.pasted);
                            if !images.is_empty() {
                                return Some(Input::PasteEnd(images));
                            }
                        }
                        _ => {}
                    },
                    _ => {}
                },
                // 端末の作法では確定は CR。行編集を切っているので自分で扱う
                b'\n' | b'\r' => {
                    // 行になる前に、それが画像だったかを覚えておく（[`InputReader::pasted`]）
                    self.拾う();
                    let line =
                        String::from_utf8_lossy(&std::mem::take(&mut self.buffer)).into_owned();
                    return Some(Input::Line(line));
                }
                other => self.buffer.push(other),
            }
        }
    }
}

/// トランスクリプトへ JSONL を追記する（`jsonl <元ファイル> [行数]`）。
///
/// 本物の claude が書くものをテストから再現するための入口。行数を指定できるのは、
/// **書きかけの状態**を作れるようにするため。増分読み取りと末尾追従は「途中まで
/// 書かれている」状況でこそ検証の値がある。
///
/// 書き出し先はフックが運ぶ `transcript_path` と同じ場所（[`transcript_path`]）。
fn append_jsonl(out: &mut impl Write, injected: &Injected, argument: &str) {
    let mut parts = argument.splitn(2, char::is_whitespace);
    let source = parts.next().unwrap_or_default();
    let take = parts
        .next()
        .and_then(|value| value.trim().parse::<usize>().ok());

    // 書き出し先は、フックが運ぶ値と必ず同じにする。ずれると「フックは届くのに
    // 履歴が出ない」という追いにくい状態になる
    let target = transcript_path(injected);
    let target = target.as_str();
    let Ok(text) = std::fs::read_to_string(source) else {
        let _ = writeln!(out, "{JSONL_FAILED_PREFIX}元ファイルを読めません: {source}");
        let _ = out.flush();
        return;
    };

    // 既に書いた行数を数え、その続きから追記する。同じ行を二度書かない
    let written = std::fs::read_to_string(target)
        .map(|current| current.lines().count())
        .unwrap_or(0);
    let lines: Vec<&str> = text.lines().skip(written).collect();
    let lines = match take {
        Some(count) => &lines[..count.min(lines.len())],
        None => &lines[..],
    };

    if let Some(parent) = std::path::Path::new(target).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // **子を先に置く。** 本体を先に書くと、その追記でパーサが起きたときに
    // 子ツリーがまだ無く、**サブエージェントの行が付かないまま確定する**。
    // 起きる隙間は数ミリ秒なので、E2E が時々だけ落ちる形で表に出ていた
    copy_session_dir(source, target);

    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(target);
    let Ok(mut file) = file else {
        let _ = writeln!(out, "{JSONL_FAILED_PREFIX}書き込めません: {target}");
        let _ = out.flush();
        return;
    };
    for line in lines {
        let _ = writeln!(file, "{line}");
    }
    let _ = file.flush();

    let _ = writeln!(out, "{JSONL_APPENDED_PREFIX}{}", lines.len());
    let _ = out.flush();
}

/// `<元>.jsonl` の隣にある `<元>/` を、`<先>.jsonl` の隣へ写す。
///
/// 本物は `<セッションID>/subagents/` に別ファイルで書くので、本体だけ写しても
/// 子ツリーがマウントされない。**呼ぶのは本体を書く前**（上記）。
fn copy_session_dir(source: &str, target: &str) {
    let source = std::path::Path::new(source);
    let target = std::path::Path::new(target);
    let (Some(from), Some(to)) = (sibling_dir(source), sibling_dir(target)) else {
        return;
    };
    if !from.is_dir() || to.exists() {
        return;
    }
    copy_tree(&from, &to);
}

fn sibling_dir(path: &std::path::Path) -> Option<std::path::PathBuf> {
    Some(path.parent()?.join(path.file_stem()?))
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
    if std::fs::create_dir_all(to).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(from) else {
        return;
    };
    for entry in entries.flatten() {
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_tree(&source, &target);
        } else {
            let _ = std::fs::copy(&source, &target);
        }
    }
}

/// 自分がどんな引数と環境で起動されたかを報告する。
///
/// 環境変数のサニタイズ（設計§6）と `--session-id` の受け渡しを、**実際に起動された
/// 子プロセスの側から**確認するために使う。親側で組み立てた値を見るだけだと、
/// 途中で環境が混ざる経路を見落とす。
fn dump(out: &mut impl Write) {
    for arg in std::env::args() {
        let _ = writeln!(out, "{ARGV_PREFIX}{arg}");
    }
    for (name, value) in std::env::vars() {
        let _ = writeln!(out, "{ENV_PREFIX}{name}={value}");
    }
    let _ = writeln!(out, "{DUMP_END_MARKER}");
    let _ = out.flush();
}

/// 指定バイト数をまとめて吐く。フロー制御と大量出力の検証用。
fn flood(out: &mut impl Write, size: usize) {
    let mut written = 0;
    while written < size {
        let remaining = size - written;
        let chunk = &FLOOD_PATTERN[..FLOOD_PATTERN.len().min(remaining)];
        if out.write_all(chunk).is_err() {
            return;
        }
        written += chunk.len();
    }
    let _ = writeln!(out, "\n{FLOOD_END_MARKER}");
    let _ = out.flush();
}

/// 注入された settings に書かれたフックコマンドを、本物と同じ形で起動する。
///
/// 本物の Claude Code は `"async": true` を見て非同期に走らせるが、こちらは**同期実行**に
/// してある。テストは「フックが届き終わってから状態を確かめたい」ので、待てる方がよい。
///
/// 引数は `hook <イベント名> [payload に混ぜる JSON]`。
fn hook(out: &mut impl Write, injected: &Injected, rest: &str) {
    let (event, extra) = match rest.split_once(' ') {
        Some((event, extra)) => (event, extra.trim()),
        None => (rest, ""),
    };

    let Some(settings) = injected.settings.as_ref() else {
        let _ = writeln!(out, "{HOOK_FAILED_PREFIX}{event} (settings が読めていない)");
        let _ = out.flush();
        return;
    };
    let Some(command) = settings["hooks"][event][0]["hooks"][0]["command"].as_str() else {
        let _ = writeln!(out, "{HOOK_FAILED_PREFIX}{event} (コマンドが見つからない)");
        let _ = out.flush();
        return;
    };

    let payload = build_payload(injected, event, extra);
    match run_hook(command, &payload) {
        Ok(stdout) => {
            // 観測専用のフックは stdout に何も出さないのが正しい（設計§7）。
            // 何か出ていたら、それは Claude へ注入されてしまう内容なので必ず表に出す
            if stdout.is_empty() {
                let _ = writeln!(out, "{HOOK_SENT_PREFIX}{event}");
            } else {
                let _ = writeln!(
                    out,
                    "{HOOK_FAILED_PREFIX}{event} (stdout に出力があった: {stdout:?})"
                );
            }
        }
        Err(err) => {
            let _ = writeln!(out, "{HOOK_FAILED_PREFIX}{event} ({err})");
        }
    }
    let _ = out.flush();
}

/// フックへ渡す JSON を組み立てる。
///
/// 本物が必ず載せてくる `session_id` / `transcript_path` / `hook_event_name` を入れ、
/// テストが指定した追加フィールド（`notification_type` など）を混ぜる。
fn build_payload(injected: &Injected, event: &str, extra: &str) -> String {
    let mut payload = serde_json::json!({
        "session_id": injected.session_id,
        "transcript_path": transcript_path(injected),
        "hook_event_name": event,
    });

    // 本物は一部のイベントにだけ載せる（設計§11 の実測）。運ぶ側のイベントを模して、
    // ダッシュボードが「載っていれば拾い、無ければ触らない」ことを検証できるようにする。
    // テストが `{"permission_mode": ...}` を明示した場合は下の合流で上書きされる
    if matches!(
        event,
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop"
    ) && let Some(target) = payload.as_object_mut()
    {
        target.insert(
            "permission_mode".to_string(),
            serde_json::Value::String(injected.mode.clone()),
        );
    }

    if !extra.is_empty()
        && let Ok(serde_json::Value::Object(fields)) = serde_json::from_str(extra)
        && let Some(target) = payload.as_object_mut()
    {
        for (key, value) in fields {
            target.insert(key, value);
        }
    }
    payload.to_string()
}

/// フックが運ぶトランスクリプトの場所。
///
/// `--transcript` を渡されていればそれを使う（`jsonl` 命令で中身を書ける）。
/// 渡されていなければ本物に似せた、存在しなくてよいパスを返す。**存在しないことは
/// 異常ではない**（JSONL は結果整合のチャネルで、フックより遅れて現れる）。
/// 画像を添付したターンの記録を、**本物と同じ2レコードの形**で書く
/// （画像添付 設計§21 読み替え1）。
///
/// 本物は `user` レコードを2つ書く。本体が `imagePasteIds` と `image` ブロックを持ち、
/// 相棒（`isMeta` ＋ `turnCompanion`）が**画像1枚につき1ブロック**の
/// `[Image: source: <絶対パス>]` を持つ。両者は `promptId` が同じ。
///
/// **形を勝手に決めない。** ここが本物とずれると、擬似だけが通る実装ができる——
/// パーサは相棒から置き場所を取るので、相棒が無い形にすると絵が出ないまま緑になる。
fn append_image_turn(injected: &Injected, text: &str, paths: &[String], seq: usize) {
    let target = transcript_path(injected);
    if let Some(parent) = std::path::Path::new(&target).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
    else {
        return;
    };

    let prompt = format!("prompt-{seq}");
    let ids: Vec<String> = (1..=paths.len()).map(|n| n.to_string()).collect();
    let images: Vec<String> = paths
        .iter()
        .map(|_| {
            r#"{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}"#
                .to_string()
        })
        .collect();
    let body = format!(
        r#"{{"type":"user","uuid":"img-body-{seq}","promptId":"{prompt}","imagePasteIds":[{}],"message":{{"content":[{{"type":"text","text":{}}},{}]}}}}"#,
        ids.join(","),
        serde_json::Value::String(text.to_string()),
        images.join(",")
    );
    let sources: Vec<String> = paths
        .iter()
        .map(|path| {
            let 綴り = serde_json::Value::String(format!("[Image: source: {path}]"));
            format!(r#"{{"type":"text","text":{綴り}}}"#)
        })
        .collect();
    let companion = format!(
        r#"{{"type":"user","uuid":"img-companion-{seq}","promptId":"{prompt}","isMeta":true,"turnCompanion":true,"message":{{"content":[{}]}}}}"#,
        sources.join(",")
    );

    let _ = writeln!(file, "{body}");
    let _ = writeln!(file, "{companion}");
    let _ = file.flush();
}

/// トランスクリプトへ1行足す。
///
/// 書き出し先は必ず [`transcript_path`]（フックが運ぶ値と同じ場所）。ずれると
/// 「フックは届くのに履歴が出ない」という追いにくい状態になる。
fn append_transcript_line(injected: &Injected, line: &str) {
    let target = transcript_path(injected);
    if let Some(parent) = std::path::Path::new(&target).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
    else {
        return;
    };
    let _ = writeln!(file, "{line}");
    let _ = file.flush();
}

/// 待ち行列の出入りを1件書く（作業中に送った追加メッセージ テスト計画フェーズ1）。
///
/// **本物と同じ形にする。** `uuid` も `parentUuid` も持たず、`content` は
/// **トップレベル**に置く（実データ 72,058件で確認した形。`message` の中ではない）。
/// **形を勝手に決めない**——ここが本物とずれると、擬似だけが通る実装ができる。
fn append_queue(injected: &Injected, operation: &str, content: Option<&str>) {
    let body = match content {
        Some(text) => format!(
            r#","content":{}"#,
            serde_json::Value::String(text.to_string())
        ),
        None => String::new(),
    };
    let session = &injected.session_id;
    append_transcript_line(
        injected,
        &format!(
            r#"{{"type":"queue-operation","operation":"{operation}","timestamp":"2026-01-01T00:00:00.000Z","sessionId":"{session}"{body}}}"#
        ),
    );
}

/// 読まれた指示（本物の `user` レコード）を1件書く。
///
/// **待ち行列とは別の経路である。** 本物は、待ちが読まれたときに**初めて**この形の
/// レコードを書く。だから「待ちが消えて本物が並ぶ」を擬似で作るには、この2つを
/// 別々に打てる必要がある。
fn append_said(injected: &Injected, text: &str, seq: usize) {
    append_transcript_line(
        injected,
        &format!(
            r#"{{"type":"user","uuid":"said-{seq}","message":{{"content":{}}}}}"#,
            serde_json::Value::String(text.to_string())
        ),
    );
}

/// アシスタントの発言レコードを1件書く。
///
/// **`append_said` と対になる形にする。** あちらが `"type":"user"` を書くのに対し、
/// こちらは `"type":"assistant"` と `message.content` の配列を書く——本物が
/// アシスタント本文を運ぶ形（`content` が `[{"type":"text","text":…}]`）に合わせる。
fn append_replied(injected: &Injected, text: &str, seq: usize) {
    append_transcript_line(
        injected,
        &format!(
            r#"{{"type":"assistant","uuid":"replied-{seq}","message":{{"content":[{{"type":"text","text":{}}}]}}}}"#,
            serde_json::Value::String(text.to_string())
        ),
    );
}

fn transcript_path(injected: &Injected) -> String {
    if let Some(path) = &injected.transcript {
        return path.clone();
    }
    std::env::temp_dir()
        .join("fake-claude")
        .join(format!("{}.jsonl", injected.session_id))
        .to_string_lossy()
        .into_owned()
}

fn run_hook(command: &str, payload: &str) -> Result<String, String> {
    // フックはシェル経由で起動される。引用符付きのコマンド行をそのまま渡せる形にする
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("起動できない: {err}"))?;

    child
        .stdin
        .take()
        .ok_or_else(|| "stdin を掴めない".to_string())?
        .write_all(payload.as_bytes())
        .map_err(|err| format!("payload を渡せない: {err}"))?;

    let output = child
        .wait_with_output()
        .map_err(|err| format!("終了を待てない: {err}"))?;
    if !output.status.success() {
        // 失敗しても終了コード 0 で終わるのが hook-post の約束（設計§7）
        return Err(format!("終了コードが 0 でない: {}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
