//! 擬似パーサ。**本物のパーサでは作れない状態**を人工的に用意するための道具。
//!
//! 未解明2事象を「辿れる」で確かめる（ログ設計§16-2）には、次の状態が要る。どちらも
//! 本物では作れない。
//!
//! | 型（`AGENTDASHBOARD_FAKE_PARSER`） | 何をするか | 何を作るか |
//! |---|---|---|
//! | `silent`（既定） | Hello だけ出し、指示は読むが**何も報告しない**。stdin が閉じても生き続ける | 事象1 の「読まれなかった」／事象2 の孤児 |
//! | `deaf` | **stdin を閉じてから** Hello を出し、以後生き続ける | 事象1 の「届かなかった」 |
//!
//! # なぜ本物では作れないのか
//!
//! - 本物は指示を読めば必ず報告を返す。**返さない個体**は作れない
//! - 本物には孤児の見張り（起動時の親IDと現在の親を比べて畳む）が入っている。
//!   親を失って**生き続ける個体**は作れない——それは既に直してある挙動である
//!
//! ここは本物の劣化版ではなく、**壊れ方そのものを再現する道具**である。
//!
//! # なぜ Hello を出すのか
//!
//! 出さないと親は「起動直後に落ちたパーサ」と見なし、縮退の側の行が出る。
//! こちらが作りたいのは**繋がっているのに何も起きない**状態なので、健康に見えなければ
//! ならない。`deaf` で**閉じてから**出すのはそのためでもある——親がこの行を見た時点で
//! 「次に書けば必ず失敗する」と言い切れる（待ち時間で当たりを付けなくてよい）。

use std::io::Write as _;

/// 型を選ぶ環境変数。
const MODE_ENV: &str = "AGENTDASHBOARD_FAKE_PARSER";

/// 何があっても最後は自分で終わる時間。
///
/// **孤児は誰も畳んでくれない。** 親を殺して作るので `kill_on_drop` も効かず、
/// 検査が途中で落ちれば置き去りになる。開発機に居座らせないための最後の綱で、
/// 検査の待ち時間（数秒）よりはるかに長く採ってある。
const LIFETIME: std::time::Duration = std::time::Duration::from_secs(120);

fn main() {
    let mode = std::env::var(MODE_ENV).unwrap_or_else(|_| "silent".to_string());

    if mode == "deaf" {
        close_stdin();
    }

    // 版は本物と噛み合わせる。噛み合わないと親は縮退させ、こちらが作りたい
    // 「健康に見えるのに何も起きない」状態にならない。
    //
    // **綴りを手で書かず、共有の型から起こす。** IPC の形が変わったときに、
    // 擬似が黙って通じなくなるのではなくコンパイルで止まる
    let hello = protocol::ipc::ParserEvent::Hello {
        protocol_version: protocol::ipc::PROTOCOL_VERSION,
        parser_version: format!("fake-{mode}"),
    };
    println!(
        "{}",
        serde_json::to_string(&hello).expect("Hello を書けること")
    );
    let _ = std::io::stdout().flush();

    // **どちらの型でも、指示を読んでも何も返さない。**
    //
    // `deaf` は stdin が閉じているので読むものが無い。`silent` は読めるが捨てる。
    // そして**どちらも EOF で終わらない**——停止経路が効かずに生き残るのが
    // 事象2 で観測された姿そのもので、それを再現するのがこの道具の役目である。
    if mode != "deaf" {
        std::thread::spawn(|| {
            let mut line = String::new();
            while std::io::stdin().read_line(&mut line).is_ok_and(|n| n > 0) {
                line.clear();
            }
        });
    }

    std::thread::sleep(LIFETIME);
    eprintln!("[{}] 擬似パーサの寿命が尽きました", std::process::id());
}

/// 標準入力を閉じる。
///
/// 読み手が居なくなったパイプへ書くと `EPIPE` が返るので、**親の書き込みが必ず失敗する**
/// 状態を作れる。fd を握って落とすだけなので、余分な依存は要らない。
#[cfg(unix)]
fn close_stdin() {
    use std::os::fd::FromRawFd as _;
    // fd 0 の持ち主になって、そのまま落とす
    drop(unsafe { std::fs::File::from_raw_fd(0) });
}

/// Windows では作れない状態なので、そのことを言って `silent` と同じに振る舞う。
///
/// **黙って別物になるのがいちばん悪い。** 使う側の検査は `#[cfg(unix)]` で外してあるが、
/// 手で起こしたときに気づけるようにしておく。
#[cfg(not(unix))]
fn close_stdin() {
    eprintln!(
        "[{}] この OS では標準入力を閉じられません（silent と同じ振る舞いになります）",
        std::process::id()
    );
}
