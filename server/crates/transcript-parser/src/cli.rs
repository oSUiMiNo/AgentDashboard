//! transcript-parser プロセスの中身。
//!
//! 実行ファイルそのものは**配布用のパッケージ**（`crates/dist`）が持っている。
//! パーサは `agentdashboard` と `agentdashboard-agent` の**どちらの隣にも居る**必要があり
//! （設計§10-3）、cargo-dist はパッケージを跨いでバイナリを同梱できないため、3本を
//! 1つのパッケージへ集めてある（§25 読み替え1）。
//!
//! core とは stdin/stdout の JSON Lines で会話する（設計§8）。別プロセスに分離しているのは、
//! 自己修復でこのバイナリだけを差し替え・再起動できるようにするため。core と生きている PTY には
//! 一切触れずにパーサだけを入れ替えられることが、設計上の要になっている。
//!
//! # stdout は IPC 専用
//!
//! ログは**必ず stderr**。stdout に1行でも他のものが混ざると core の行パースが壊れ、
//! 「繋がっているのに何も届かない」という追いにくい沈黙になる。
//!
//! # 見張りは2系統
//!
//! notify（inotify）だけに頼らず、低頻度の巡回も併用する。inotify はイベントが溢れると
//! 取りこぼし、そうなると構造化ビューだけが静かに止まる（ターミナルは動き続けるので
//! 利用者からは原因が分からない）。巡回1回のコストは `metadata()` 数回ぶんで、
//! この一群の不具合を消せるなら安い。

use crate::session::{self, SessionState};
use crate::tail::DirWatcher;
use protocol::CardId;
use protocol::ipc::{PROTOCOL_VERSION, ParsedNode, ParserCommand, ParserEvent};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

/// 巡回の間隔。notify の取りこぼしに対する保険。
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 1つの `nodes` イベントに載せるノード数の上限。
const MAX_NODES_PER_EVENT: usize = 500;

enum Message {
    Command(ParserCommand),
    /// 何かが変わったかもしれないので見に行く合図
    Poke,
}

/// 「見に行け」がもう積んである、という1枚の旗。
///
/// # なぜ列ではなく旗なのか
///
/// 合図に回数の意味が無いからである。100回来ても1回来ても、やることは「見に行く」1回
/// でしかない。冪等なものを境界なしの列へ積むと、溜まった数がそのまま嵩になる——
/// パーサ自身の `open` が通知を生む輪と噛み合って、実測で毎分 340〜500 MB がこれで消えた。
///
/// 上限付きの列でも同じ効果は得られるが、上限をいくつにするかという決めなくてよい数字が
/// 1つ増える。旗は定義から上限が1なので、決める余地が無い。
#[derive(Clone, Default)]
struct Signal(Arc<AtomicBool>);

impl Signal {
    /// 旗を立て、**まだ立っていなかったときだけ** true を返す。
    ///
    /// 送り手はこれが true のときだけ `Message::Poke` を積む。既に積んであるなら、
    /// もう1件積んでも読む側のすることは変わらない。
    fn raise(&self) -> bool {
        !self.0.swap(true, Ordering::AcqRel)
    }

    /// 旗を降ろす。
    fn lower(&self) {
        self.0.store(false, Ordering::Release);
    }
}

/// パーサプロセスの入口。
pub fn run() -> anyhow::Result<()> {
    let (tx, rx) = mpsc::channel();
    let signal = Signal::default();
    spawn_stdin_reader(tx.clone());
    spawn_ticker(tx.clone(), signal.clone());
    let watcher = spawn_watcher(tx, signal.clone())?;

    emit(&ParserEvent::Hello {
        protocol_version: PROTOCOL_VERSION,
        parser_version: env!("CARGO_PKG_VERSION").to_string(),
    });

    pump(rx, watcher, signal);
    Ok(())
}

/// 指示と合図を1本の列で受けて捌く。
fn pump(rx: Receiver<Message>, mut watcher: Option<DirWatcher>, signal: Signal) {
    let mut sessions: HashMap<CardId, SessionState> = HashMap::new();

    while let Ok(message) = rx.recv() {
        match message {
            Message::Command(ParserCommand::Watch {
                card_id,
                path,
                from_offsets,
            }) => {
                let session = SessionState::new(card_id, PathBuf::from(path), &from_offsets);
                sessions.insert(card_id, session);
                poll(&mut sessions, &mut watcher);
            }
            Message::Command(ParserCommand::Unwatch { card_id }) => {
                sessions.remove(&card_id);
                // 外したカードのぶんだけ解除してはいけない。残っているものから
                // 集合を作り直す（設計§4）
                if let Some(watcher) = watcher.as_mut() {
                    watcher.retain(&dirs_in_use(&sessions));
                }
            }
            Message::Command(ParserCommand::ReadRange {
                req_id,
                card_id: _,
                source,
                from_offset,
                to_offset,
            }) => {
                let nodes = session::read_range(&PathBuf::from(source), from_offset, to_offset);
                emit(&ParserEvent::Range { req_id, nodes });
            }
            Message::Command(ParserCommand::Shutdown) => break,
            Message::Poke => {
                // 降ろすのは読む前。逆にすると、読んでいる最中に届いた変更が
                // 降ろした拍子に消え、次の巡回まで最大 500ms 遅れる
                signal.lower();
                poll(&mut sessions, &mut watcher);
            }
        }
    }
}

/// 残っているセッションが要る場所の集合。
///
/// **引き算にしない。** 外したカードが使っていたディレクトリをそのまま解除すると、
/// 同じフォルダで走っている別のセッションの見張りまで外れる
/// （`~/.claude/projects/<プロジェクト>/` は同じプロジェクトの全セッションで同じ）。
/// 残っているものから作り直せば、共有されているかどうかを数えずに済む。
fn dirs_in_use(sessions: &HashMap<CardId, SessionState>) -> HashSet<PathBuf> {
    sessions.values().flat_map(SessionState::dirs).collect()
}

fn poll(sessions: &mut HashMap<CardId, SessionState>, watcher: &mut Option<DirWatcher>) {
    for session in sessions.values_mut() {
        // サブエージェントのディレクトリは後から生えるので、毎回登録し直す（冪等）
        if let Some(watcher) = watcher.as_mut() {
            for dir in session.dirs() {
                let _ = watcher.watch(&dir);
            }
        }
        for event in session.poll() {
            for event in split_event(event) {
                emit(&event);
            }
        }
    }
}

/// ノードが多すぎるイベントを分ける。
///
/// 1発で数千ノードを送ると、受け手（core → WebSocket）の送信キューを一撃で詰まらせる。
/// 途中のイベントの `next_offset` は**次のかたまりの先頭**にしておく。ここで最終位置を
/// 書いてしまうと、途中で落ちたときに読み飛ばした範囲が二度と読まれない。
fn split_event(event: ParserEvent) -> Vec<ParserEvent> {
    let ParserEvent::Nodes {
        card_id,
        source,
        nodes,
        next_offset,
    } = event
    else {
        return vec![event];
    };
    if nodes.len() <= MAX_NODES_PER_EVENT {
        return vec![ParserEvent::Nodes {
            card_id,
            source,
            nodes,
            next_offset,
        }];
    }

    let chunks: Vec<Vec<ParsedNode>> = nodes
        .chunks(MAX_NODES_PER_EVENT)
        .map(<[ParsedNode]>::to_vec)
        .collect();
    let boundaries: Vec<u64> = chunks
        .iter()
        .skip(1)
        .map(|chunk| chunk.first().map_or(next_offset, |node| node.offset))
        .chain(std::iter::once(next_offset))
        .collect();

    chunks
        .into_iter()
        .zip(boundaries)
        .map(|(nodes, next_offset)| ParserEvent::Nodes {
            card_id,
            source: source.clone(),
            nodes,
            next_offset,
        })
        .collect()
}

/// stderr へ1行残す。**必ずこの口を通す。**
///
/// 行の先頭に `[<pid>]` を付けるのがこの関数の仕事（ログ設計§8-3）。親
/// （`session-host-core` の `parser.rs`）が拾うとき、ここを剥がして `parser_pid` の
/// 欄へ移す。
///
/// # なぜ前置するのか
///
/// 親は `child.id()` でも pid を知れるが、それは「親がいま掴んでいる子」であって
/// **その行を書いた主体とは限らない**。孤児になったパーサの行は新しい親の stderr へは
/// 流れないので、**前置だけが「どの起動に紐づく子か」を支える**（未解明事象2）。
///
/// # stdout には絶対に書かない
///
/// あちらは IPC 専用で、1行でも混ざると「繋がっているのに何も届かない」沈黙になる。
fn note(args: std::fmt::Arguments<'_>) {
    eprintln!("{}", format_note(std::process::id(), args));
}

/// 前置を組む純関数。`eprintln!` そのものは捕まえられないので、判断はこちらに置く。
fn format_note(pid: u32, args: std::fmt::Arguments<'_>) -> String {
    format!("[{pid}] {args}")
}

/// IPC が壊れたことを既に告げたか。
///
/// **告げるのは1回だけ。** 書けない状態は回復しない（core が居なくなっている）ので、
/// ノードごとに鳴らすと親の stderr 取り込みが warn を毎ノード生む。設計§9-2 の
/// 「ノードごとの書き出しは書けなかったときだけ」は、ここでは「1回だけ」の意味になる。
static IPC_BROKEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn emit(event: &ParserEvent) {
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    if let Some(complaint) = emit_into(&mut stdout, event) {
        note(format_args!("{complaint}"));
    }
}

/// 書き出し先を受け取る側。**告げる中身だけを返し、告げるのは呼び出し側**。
///
/// `eprintln!` そのものはテストから捕まえられないので、`format_note` と同じ作法で
/// 判断をこちらへ置く。
///
/// # 捨てるのは変えない
///
/// 書けなければ次のループで stdin 側も閉じる。**変えたのは、消えたことが誰にも
/// 見えないところだけ**（設計§10-3。未解明事象1「構造化ビューが永久に空」の経路）。
fn emit_into(out: &mut impl Write, event: &ParserEvent) -> Option<String> {
    let Ok(line) = serde_json::to_string(event) else {
        return None;
    };
    let wrote = writeln!(out, "{line}");
    // **`and_then` にしてはいけない。** `writeln!` が失敗したときに `flush` が
    // 走らなくなり、制御の流れが変わる
    let flushed = out.flush();
    let err = wrote.and(flushed).err()?;
    (!IPC_BROKEN.swap(true, std::sync::atomic::Ordering::Relaxed)).then(|| {
        format!(
            "core へ結果を書けません（以降は黙って捨てます）: {err}: {}",
            event_label(event)
        )
    })
}

/// 事故のときに載せる見出し。
///
/// **中身は載せない。** `nodes` の本体は会話そのもので、stderr へ流すと親のログへ
/// 会話が丸ごと入る（設計§9-3）。
fn event_label(event: &ParserEvent) -> String {
    match event {
        ParserEvent::Hello { parser_version, .. } => format!("hello({parser_version})"),
        ParserEvent::Nodes { card_id, nodes, .. } => {
            format!("nodes card_id={card_id} n={}", nodes.len())
        }
        ParserEvent::Reset { card_id } => format!("reset card_id={card_id}"),
        ParserEvent::Range { req_id, nodes } => format!("range req_id={req_id} n={}", nodes.len()),
        ParserEvent::Stats { card_id, .. } => format!("stats card_id={card_id}"),
        ParserEvent::Error { card_id, .. } => match card_id {
            Some(card_id) => format!("error card_id={card_id}"),
            None => "error".to_string(),
        },
    }
}

/// 列を通さずに、その場で終わる。**止まる道はここ1つに集める。**
///
/// 呼ぶのは「core が居なくなった」と分かった2箇所だけ（stdin の EOF と孤児の検知）。
/// どちらも合図を受け取る相手がもう居ないので、列へ積んでも意味が無い。
///
/// # ロックを先に取るのが肝
///
/// `emit` は書き込みのあいだ stdout のロックを持つ。ここで取ってから終われば、
/// **行が途中で切れた状態で終わることがない。** 切れた行は core の行パースを壊し、
/// 「繋がっているのに何も届かない」という最も追いにくい沈黙になる。
///
/// # `flush` を自分で呼ぶ理由
///
/// `std::process::exit` はデストラクタも Rust の後始末も走らせないので、
/// 溜めたぶんは黙って消える。明示して初めて出し切れる。
///
/// # 終了コードは 0
///
/// 異常ではなく、**役目が終わったから終わる**。親（`session-host-core` の `parser.rs`）は
/// パーサが落ちれば起こし直すが、孤児の場面ではそもそも親が居ないので相手も居ない。
fn end_now() -> ! {
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let _ = stdout.flush();
    std::process::exit(0);
}

fn spawn_stdin_reader(tx: Sender<Message>) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<ParserCommand>(&line) {
                Ok(command) => {
                    if tx.send(Message::Command(command)).is_err() {
                        break;
                    }
                }
                // 知らない指示で落ちない。core が新しくなっても動き続ける
                Err(error) => note(format_args!(
                    "解釈できない指示を無視しました: {error}: {line}"
                )),
            }
        }
        // ここへ来るのは stdin が閉じたか、受け手が畳まれたときだけ。どちらも
        // core が居ないという意味なので、終わり方を分ける理由が無い
        end_now();
    });
}

fn spawn_ticker(tx: Sender<Message>, signal: Signal) {
    let born_under = parent_pid();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(POLL_INTERVAL);
            // core が消えたら道連れで終わる（下記参照）。**列を通さない**——
            // 積んだところで、読む側を起こす相手がもう居ない
            if orphaned(born_under) {
                end_now();
            }
            // 既に積んであるなら積まない。旗が立ったままなのは、読む側がまだ
            // 見に行っていないということなので、もう1件積んでも結果は同じ
            if signal.raise() && tx.send(Message::Poke).is_err() {
                break;
            }
        }
    });
}

/// 自分の親プロセスID。取れなければ `None`。
///
/// `/proc` を読むのは、この1点のために libc を足したくないため。Linux 専用だが、
/// 本アプリはもともと Linux でしか動かさない。
fn parent_pid() -> Option<u32> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("PPid:"))
        .and_then(|value| value.trim().parse().ok())
}

/// 起動時の親が居なくなっていたら true。
///
/// # なぜ要るのか
///
/// core は `kill_on_drop` でこの子プロセスを畳むが、それが効くのは Child が
/// **drop されたとき**だけ。core が SIGTERM や SIGKILL で即死するとデストラクタは
/// 走らず、パーサだけが生き残る。実際にフェーズ6で、core を落としたあとも36分
/// 生き続けている孤児を観測した。core を落とすたびに1つずつ積み上がる。
///
/// 親の消滅は**起動時の親と今の親を比べる**ことで判定する。「親が 1 番か」で
/// 判定しないのは、WSL のように 1 番が `/init` でない再親付け先を持つ環境が
/// あるため（実際に観測した孤児の親は 1 ではなかった）。
fn orphaned(born_under: Option<u32>) -> bool {
    let Some(born_under) = born_under else {
        // 親が分からない環境では、この見張りは黙って無効にする
        return false;
    };
    parent_pid().is_some_and(|now| now != born_under)
}

/// ファイル監視を立ち上げる。使えなくても致命傷にはしない（巡回だけで動く）。
///
/// # 中継を挟まない
///
/// notify のコールバックから直に旗を立てて積む。以前はチャネルと中継スレッドを1本ずつ
/// 挟んでいたが、そこでやることは何も無かった。コールバックの中で行うのは
/// `AtomicBool::swap` と、立っていなかったときだけの `send` で、**どちらも待たない**。
fn spawn_watcher(tx: Sender<Message>, signal: Signal) -> anyhow::Result<Option<DirWatcher>> {
    let watcher = DirWatcher::new(move || {
        // 既に積んであるなら積まない。旗が立ったままなのは、読む側がまだ
        // 見に行っていないということなので、もう1件積んでも結果は同じ
        if signal.raise() {
            let _ = tx.send(Message::Poke);
        }
    });
    match watcher {
        Ok(watcher) => Ok(Some(watcher)),
        Err(error) => {
            note(format_args!(
                "ファイル監視を使えないので巡回だけで動きます: {error}"
            ));
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use protocol::{Node, NodeId, TreeNode};
    use std::path::Path;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn stderrの行は先頭にpidが付く() {
        // 親（session-host-core の parser.rs）がここを剥がして parser_pid へ移す。
        // 孤児になった子の行は新しい親へは流れないので、前置だけが
        // 「どの起動に紐づく子か」を支える
        assert_eq!(
            format_note(
                15637,
                format_args!("ファイル監視を使えないので巡回だけで動きます: x")
            ),
            "[15637] ファイル監視を使えないので巡回だけで動きます: x"
        );
    }

    fn node(offset: u64) -> ParsedNode {
        ParsedNode {
            node: TreeNode {
                id: NodeId(format!("n{offset}")),
                parent: None,
                node: Node::AssistantText {
                    text: String::new(),
                },
                ts: 0,
                branch: 0,
            },
            offset,
        }
    }

    #[test]
    fn 小さいイベントは分けない() {
        let event = ParserEvent::Nodes {
            card_id: CardId::new(),
            source: "/p/s.jsonl".to_string(),
            nodes: vec![node(0)],
            next_offset: 10,
        };
        assert_eq!(split_event(event).len(), 1);
    }

    #[test]
    fn 大きいイベントは分けて途中の再開位置は次のかたまりの先頭になる() {
        // ここで最終位置を書くと、途中で落ちたときに読み飛ばした範囲が二度と読まれない
        let nodes: Vec<ParsedNode> = (0..MAX_NODES_PER_EVENT as u64 + 5)
            .map(|index| node(index * 100))
            .collect();
        let split = split_event(ParserEvent::Nodes {
            card_id: CardId::new(),
            source: "/p/s.jsonl".to_string(),
            nodes,
            next_offset: 999_999,
        });

        assert_eq!(split.len(), 2);
        match (&split[0], &split[1]) {
            (
                ParserEvent::Nodes {
                    nodes: first,
                    next_offset: first_next,
                    ..
                },
                ParserEvent::Nodes {
                    nodes: second,
                    next_offset: second_next,
                    ..
                },
            ) => {
                assert_eq!(first.len(), MAX_NODES_PER_EVENT);
                assert_eq!(second.len(), 5);
                assert_eq!(*first_next, second[0].offset);
                assert_eq!(*second_next, 999_999);
            }
            other => panic!("Nodes ではない: {other:?}"),
        }
    }

    #[test]
    fn 親が変わっていなければ孤児とみなさない() {
        let now = parent_pid();
        assert!(now.is_some(), "Linux では自分の親IDが読めること");
        assert!(!orphaned(now), "起動時と同じ親なら生き続ける");
    }

    #[test]
    fn 親が変わったら孤児とみなす() {
        // core が SIGTERM で即死すると kill_on_drop が効かず、この見張りだけが
        // パーサを畳む手段になる。実際に36分生き残った孤児を観測している
        let bogus = parent_pid().map(|pid| pid.wrapping_add(1));
        assert!(orphaned(bogus), "起動時と違う親になったら終わる");
    }

    #[test]
    fn 親が分からない環境では見張りを止める() {
        // /proc が無い環境で「常に孤児」と判定すると、起動した瞬間に終わってしまう
        assert!(!orphaned(None));
    }

    #[test]
    fn 同じフォルダを2本が使っていたら片方を外しても残る() {
        // 引き算で外すと、ここで共有のフォルダまで消える。実運用では
        // `~/.claude/projects/<プロジェクト>/` を同じプロジェクトの全セッションが
        // 共有するので、これは例外的な状況ではなく普通の状況である
        let mut sessions = HashMap::new();
        let a = CardId::new();
        let b = CardId::new();
        let 空 = std::collections::BTreeMap::new();
        sessions.insert(a, SessionState::new(a, PathBuf::from("/x/a.jsonl"), &空));
        sessions.insert(b, SessionState::new(b, PathBuf::from("/x/b.jsonl"), &空));

        let 全部 = dirs_in_use(&sessions);
        assert!(
            全部.contains(Path::new("/x")),
            "前提：共有の親が入っていること"
        );
        assert!(
            全部.contains(Path::new("/x/a")),
            "前提：a 専用の場所も入っていること"
        );

        sessions.remove(&a);
        let 残り = dirs_in_use(&sessions);

        assert!(
            残り.contains(Path::new("/x")),
            "共有している親は、片方を外しても要り続けること"
        );
        assert!(
            !残り.contains(Path::new("/x/a")),
            "外したセッション専用の場所は要らなくなること"
        );
        assert!(
            残り.contains(Path::new("/x/b")),
            "残ったセッションの場所は要り続けること"
        );
    }

    #[test]
    fn 立っていない旗は立てられる() {
        assert!(Signal::default().raise());
    }

    #[test]
    fn 既に立っている旗は立てられない() {
        // これが二重に積まないことの根拠。偽が返るあいだ、送り手は列へ何も積まない
        let signal = Signal::default();
        assert!(signal.raise());
        assert!(!signal.raise(), "2回目は偽であること");
    }

    #[test]
    fn 降ろせばまた立てられる() {
        let signal = Signal::default();
        assert!(signal.raise());
        signal.lower();
        assert!(signal.raise(), "降ろしたあとは真に戻ること");
    }

    #[test]
    fn 同時に立てても真を返すのは1回だけ() {
        // 送り手は見張りと巡回の2本あり、別々のスレッドから同時に立てにくる。
        // ここが崩れると、1回の合図で複数の Poke が積まれて旗の意味が消える
        let signal = Signal::default();
        let raised = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..16 {
            let signal = signal.clone();
            let raised = Arc::clone(&raised);
            handles.push(std::thread::spawn(move || {
                if signal.raise() {
                    raised.fetch_add(1, Ordering::Relaxed);
                }
            }));
        }
        for handle in handles {
            handle.join().expect("スレッドを畳めること");
        }
        assert_eq!(raised.load(Ordering::Relaxed), 1, "真を返すのは1回だけ");
    }

    #[test]
    fn 合図が溜まっていても終了の指示は届く() {
        // 旗を入れる前は、送り手が積んだ合図の後ろで Shutdown が埋もれた。
        // 溜まった状態を人為的に作り、それでも pump が返ることを見る。
        // 見張っているセッションが無いので poll は何もしない
        let (tx, rx) = mpsc::channel();
        for _ in 0..10_000 {
            tx.send(Message::Poke).expect("列へ積めること");
        }
        tx.send(Message::Command(ParserCommand::Shutdown))
            .expect("列へ積めること");
        drop(tx);

        pump(rx, None, Signal::default());
    }

    #[test]
    fn nodes以外はそのまま通る() {
        let card_id = CardId::new();
        let split = split_event(ParserEvent::Reset { card_id });
        assert_eq!(split, vec![ParserEvent::Reset { card_id }]);
    }

    /// IPC の書き込み失敗に声を与える（設計§10-3。未解明事象1 の経路）。
    ///
    /// **この crate は `tracing` を持てない**（設計§8-3）ので、告げるのは `note` 経由の
    /// stderr。親が拾って `parser_pid` の欄へ移す。
    mod 書けないことを告げる {
        use super::*;

        struct 壊れた口;

        impl Write for 壊れた口 {
            fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "core が居ない",
                ))
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "core が居ない",
                ))
            }
        }

        #[test]
        fn 何度書けなくても告げるのは1回だけ() {
            // 書けない状態は回復しない。ノードごとに鳴らすと、親の stderr 取り込みが
            // warn を毎ノード生む（設計§9-2）。
            //
            // **`IPC_BROKEN` は戻らないラッチで、この binary 全体で1つである。**
            // ここが「1回目は告げる」を見られるのは、いまこのラッチに触るテストが
            // 1本しか無いため。**書き込み失敗を試すテストをこの binary へ足すなら、
            // 先に灼けるのはそちら**で、この検査が無関係な理由で落ちる。
            // ラッチを戻す口は足さない——「告げるのは1回だけ」は設計の判断で、
            // 検査の都合で緩めるものではない
            let card_id = CardId::new();
            let event = ParserEvent::Reset { card_id };
            let mut out = 壊れた口;

            let complaint = emit_into(&mut out, &event).expect("1回目は告げること");
            assert!(complaint.contains("core へ結果を書けません"), "{complaint}");
            assert!(
                complaint.contains(&format!("reset card_id={card_id}")),
                "何が消えたかの見出しが載ること: {complaint}"
            );

            for _ in 0..200 {
                assert!(emit_into(&mut out, &event).is_none(), "2回目以降は黙ること");
            }
        }

        #[test]
        fn 書けたときは何も言わず1行1レコードで出す() {
            let mut out: Vec<u8> = Vec::new();
            let event = ParserEvent::Reset {
                card_id: CardId::new(),
            };
            assert!(emit_into(&mut out, &event).is_none());

            let text = String::from_utf8(out).expect("UTF-8 であること");
            assert!(text.ends_with('\n'));
            assert_eq!(text.lines().count(), 1, "1行1レコード");
        }

        #[test]
        fn 見出しは短く保つ() {
            // **会話そのものを stderr へ流さない**（設計§9-3）。件数と相手だけ
            let card_id = CardId::new();
            let label = event_label(&ParserEvent::Nodes {
                card_id,
                source: "/どこかの/長いパス/session.jsonl".to_string(),
                nodes: Vec::new(),
                next_offset: 0,
            });
            assert_eq!(label, format!("nodes card_id={card_id} n=0"));
        }
    }
}
