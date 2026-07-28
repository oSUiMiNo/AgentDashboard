//! transcript-parser プロセスの入口。
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

use protocol::CardId;
use protocol::ipc::{PROTOCOL_VERSION, ParsedNode, ParserCommand, ParserEvent};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;
use transcript_parser::session::{self, SessionState};
use transcript_parser::tail::DirWatcher;

/// 巡回の間隔。notify の取りこぼしに対する保険。
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 1つの `nodes` イベントに載せるノード数の上限。
const MAX_NODES_PER_EVENT: usize = 500;

enum Message {
    Command(ParserCommand),
    /// 何かが変わったかもしれないので見に行く合図
    Poke,
    Stop,
}

fn main() -> anyhow::Result<()> {
    let (tx, rx) = mpsc::channel();
    spawn_stdin_reader(tx.clone());
    spawn_ticker(tx.clone());
    let watcher = spawn_watcher(tx)?;

    emit(&ParserEvent::Hello {
        protocol_version: PROTOCOL_VERSION,
        parser_version: env!("CARGO_PKG_VERSION").to_string(),
    });

    run(rx, watcher);
    Ok(())
}

fn run(rx: Receiver<Message>, mut watcher: Option<DirWatcher>) {
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
            Message::Command(ParserCommand::Shutdown) | Message::Stop => break,
            Message::Poke => poll(&mut sessions, &mut watcher),
        }
    }
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

fn emit(event: &ParserEvent) {
    let Ok(line) = serde_json::to_string(event) else {
        return;
    };
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    // 書けない＝core が居なくなった。次のループで stdin 側も閉じるので黙って捨てる
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
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
                Err(error) => eprintln!("解釈できない指示を無視しました: {error}: {line}"),
            }
        }
        let _ = tx.send(Message::Stop);
    });
}

fn spawn_ticker(tx: Sender<Message>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(POLL_INTERVAL);
            if tx.send(Message::Poke).is_err() {
                break;
            }
        }
    });
}

/// ファイル監視を立ち上げる。使えなくても致命傷にはしない（巡回だけで動く）。
fn spawn_watcher(tx: Sender<Message>) -> anyhow::Result<Option<DirWatcher>> {
    let (notify_tx, notify_rx) = mpsc::channel();
    let watcher = match DirWatcher::new(notify_tx) {
        Ok(watcher) => watcher,
        Err(error) => {
            eprintln!("ファイル監視を使えないので巡回だけで動きます: {error}");
            return Ok(None);
        }
    };
    std::thread::spawn(move || {
        while notify_rx.recv().is_ok() {
            if tx.send(Message::Poke).is_err() {
                break;
            }
        }
    });
    Ok(Some(watcher))
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use protocol::{Node, NodeId, TreeNode};

    fn node(offset: u64) -> ParsedNode {
        ParsedNode {
            node: TreeNode {
                id: NodeId(format!("n{offset}")),
                parent: None,
                node: Node::AssistantText {
                    text: String::new(),
                },
                ts: 0,
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
    fn nodes以外はそのまま通る() {
        let card_id = CardId::new();
        let split = split_event(ParserEvent::Reset { card_id });
        assert_eq!(split, vec![ParserEvent::Reset { card_id }]);
    }
}
