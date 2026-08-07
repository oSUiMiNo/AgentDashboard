//! transcript-parser プロセスの起動・監視・差し替え（設計§8/§9）。
//!
//! # なぜ別プロセスなのか
//!
//! 自己修復（設計§9）は「フォーマットが変わったら修復セッションがパーサを直し、テストに
//! 通ったらパーサだけ差し替える」という仕組みで、これが成立するには**直す対象**と
//! **動き続けなければならないもの**（PTY 上の生きたセッション）がプロセスとして
//! 分かれている必要がある。パーサが落ちてもターミナルと状態表示は無傷、というのが
//! 縮退の仕様（設計§11）でもある。
//!
//! # 再開位置はセッションホストが持つ。ただし進めるのは運び手
//!
//! パーサを差し替えても履歴が欠けないよう、どこまで読んだかはセッションホスト側で
//! 永続化する（[`crate::offsets::OffsetStore`]）。ここが読むのは**監視を頼むとき**だけで、
//! 進めるのは報告の運び手——**記録に入ったことを確かめてから**（セルフホスト化設計§6-1）。
//!
//! フェーズ2 までは「配った直後」に書いていた。配る先がメモリの窓だったころはそれで
//! 足りたが、記録が DB になり、さらにネットワークを跨ぐようになると「配った」と
//! 「残った」の間が開く。その間に落ちるとノードが静かに消えるので、条件を揃えた。
//! **欠落より重複を選ぶ**という原則そのものは変わっていない。

use crate::config::SessionHostConfig;
use crate::offsets::OffsetStore;
use crate::session::SessionManager;
use protocol::CardId;
use protocol::ipc::{PROTOCOL_VERSION, ParserCommand, ParserEvent};
use protocol::ws::{ParserState, ServerMessage};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// パーサ実行ファイルを差し替えるための環境変数。
///
/// 既定は `current_exe()` の隣。統合テストでは core が**ライブラリとして**動くため
/// `current_exe()` がテストバイナリを指してしまうので、この入口が要る
/// （フックの [`crate::session::hooks_settings::HOOK_BIN_ENV`] と同じ理由）。
pub const PARSER_BIN_ENV: &str = "AGENTDASHBOARD_PARSER_BIN";

/// 再起動の待ち時間。落ち続けるパーサで CPU を焼かないよう、上限まで伸ばす。
const RESTART_BACKOFF_MS: [u64; 5] = [200, 500, 1_000, 2_000, 5_000];

/// 指示の待ち行列。
const REQUEST_QUEUE: usize = 256;

/// SessionManager からパーサへ出す依頼。
///
/// 再開位置は supervisor 側が持っているので、依頼側は知らなくてよい。
#[derive(Debug, Clone)]
pub enum ParserRequest {
    Watch { card_id: CardId, path: String },
    Unwatch { card_id: CardId },
}

/// SessionManager が持つ、パーサへの細い口。
///
/// 逆参照（パーサ側から SessionManager）は持たせない。フックの処理は同期関数なので、
/// 送信は `try_send`（待たない）にしてある。ダッシュボードの都合でフックの処理が
/// 止まることがあってはならない。
#[derive(Debug, Clone)]
pub struct ParserHandle {
    requests: mpsc::Sender<ParserRequest>,
}

impl ParserHandle {
    pub fn watch(&self, card_id: CardId, path: String) {
        let _ = self
            .requests
            .try_send(ParserRequest::Watch { card_id, path });
    }

    pub fn unwatch(&self, card_id: CardId) {
        let _ = self.requests.try_send(ParserRequest::Unwatch { card_id });
    }
}

/// パーサ子プロセスの世話役。
pub struct ParserSupervisor {
    manager: Arc<SessionManager>,
    config: Arc<SessionHostConfig>,
    /// 再開位置。**読むのはここ、進めるのは運び手**（設計§6-1）
    offsets: Arc<OffsetStore>,
    requests: mpsc::Sender<ParserRequest>,
    state: Arc<Mutex<ParserState>>,
    /// 差し替え後に立て直しを頼む口（設計§9）
    restarts: mpsc::Sender<()>,
    /// stats の届け先。自己修復が居るときだけ差し込まれる
    stats_sink: Mutex<Option<mpsc::Sender<StatsReport>>>,
}

/// パーサが報告してきた健康状態を、自己修復へ渡すときの形。
///
/// `ParserEvent` をそのまま渡さないのは、受け手が IPC の型に依存しないようにするため。
#[derive(Debug, Clone)]
pub struct StatsReport {
    pub card_id: CardId,
    pub records_total: u64,
    pub parse_errors: u64,
    pub unknown_types: BTreeMap<String, u64>,
    pub orphans: u64,
    pub versions: std::collections::BTreeSet<String>,
}

impl ParserSupervisor {
    /// パーサを起動し、世話をする常駐タスクを立てる。
    ///
    /// 再開位置の置き場所は**外から渡す**。読むのはここだが進めるのは報告の運び手なので、
    /// 2人が同じ置き場所を見る必要がある（設計§6-1）。
    pub fn start(
        manager: Arc<SessionManager>,
        config: Arc<SessionHostConfig>,
        offsets: Arc<OffsetStore>,
    ) -> Arc<Self> {
        let (requests, request_rx) = mpsc::channel(REQUEST_QUEUE);
        // 立て直しの依頼は溜める意味が無い（1回入っていれば十分）
        let (restarts, restart_rx) = mpsc::channel(1);

        let supervisor = Arc::new(Self {
            manager: Arc::clone(&manager),
            config: Arc::clone(&config),
            offsets,
            requests,
            state: Arc::new(Mutex::new(ParserState::Ok)),
            restarts,
            stats_sink: Mutex::new(None),
        });

        tokio::spawn(run(Arc::clone(&supervisor), request_rx, restart_rx));
        supervisor
    }

    /// 健康状態の届け先を差し込む（自己修復が起動したときに呼ばれる）。
    pub fn attach_stats_sink(&self, sink: mpsc::Sender<StatsReport>) {
        *self.stats_sink.lock().expect("ロックが壊れていない") = Some(sink);
    }

    /// 構造化ビューを縮退として宣言する（設計§9-6 の縮退モード）。
    ///
    /// パーサのプロセス自体は動いているのに**中身を正しく読めていない**という状態が
    /// あるため、プロセスの生死とは別に外から落とせる口が要る。自動修復に失敗した
    /// ときがそれで、履歴の表示を信じてよいかどうかは利用者に伝えなければならない。
    /// ターミナルと指示送信には影響しない。
    pub fn degrade(&self, detail: String) {
        self.set_state(ParserState::Degraded, Some(detail));
    }

    /// パーサを立て直す（差し替えたバイナリを使わせる）。
    ///
    /// 再開位置は core が持っているので、立て直しても履歴は欠けない。落ちたときの
    /// 立て直しと同じ道を通るので、監視中のカードは自動で登録し直される。
    pub fn restart(&self) {
        let _ = self.restarts.try_send(());
    }

    pub fn handle(&self) -> ParserHandle {
        ParserHandle {
            requests: self.requests.clone(),
        }
    }

    pub fn state(&self) -> ParserState {
        *self.state.lock().expect("ロックが壊れていない")
    }

    fn set_state(&self, next: ParserState, detail: Option<String>) {
        let mut state = self.state.lock().expect("ロックが壊れていない");
        if *state == next {
            return;
        }
        *state = next;
        drop(state);
        self.manager.broadcast(ServerMessage::ParserStatus {
            state: next,
            detail,
        });
    }
}

/// 自己修復が差し替えたパーサを指すポインタファイルの名前（[`SessionHostConfig::resolved_state_dir`] 配下）。
///
/// 中身は実行ファイルの絶対パス1行。symlink ではなくファイルにしてあるのは、
/// 「いま何を使っているか」を人が開いて確かめられるようにするため。
pub const PARSER_POINTER: &str = "parser-current";

/// パーサ実行ファイルの場所を決める。
///
/// 探索順は **環境変数 → ポインタ → 実行ファイルの隣 → PATH**。
///
/// - 環境変数が先頭なのは、テストがビルド済みのパーサを名指しできるようにするため
/// - ポインタが隣より先なのは、自己修復が差し替えた新しいパーサを使わせるため。
///   ポインタの指す先が消えていたら既定へ戻る（起動できなくなるほうが困る）
pub fn parser_program(config: &SessionHostConfig) -> PathBuf {
    if let Ok(path) = std::env::var(PARSER_BIN_ENV) {
        return PathBuf::from(path);
    }
    if let Ok(text) = std::fs::read_to_string(config.resolved_state_dir().join(PARSER_POINTER)) {
        let path = PathBuf::from(text.trim());
        if path.is_file() {
            return path;
        }
        tracing::warn!(
            "差し替え済みのパーサが見つかりません（既定に戻します）: {}",
            path.display()
        );
    }
    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            let sibling = dir.join("transcript-parser");
            if sibling.is_file() {
                return sibling;
            }
        }
    }
    PathBuf::from("transcript-parser")
}

/// 常駐タスク。パーサが落ちたら間を置いて立て直し、監視中のカードを全部登録し直す。
async fn run(
    supervisor: Arc<ParserSupervisor>,
    mut requests: mpsc::Receiver<ParserRequest>,
    mut restarts: mpsc::Receiver<()>,
) {
    // カード → 本体トランスクリプトのパス。再起動のたびに登録し直すために持つ
    let mut watched: HashMap<CardId, String> = HashMap::new();
    let mut attempt = 0usize;

    loop {
        match spawn_parser(&supervisor.config).await {
            Ok(child) => {
                attempt = 0;
                supervisor.set_state(ParserState::Ok, None);
                let reason = pump(
                    &supervisor,
                    child,
                    &mut requests,
                    &mut restarts,
                    &mut watched,
                )
                .await;
                match reason {
                    PumpEnd::Shutdown => return,
                    // 差し替えによる立て直しは異常ではないので、縮退にも待ちにも入らない
                    PumpEnd::Restart => continue,
                    PumpEnd::ParserGone => {
                        supervisor.set_state(
                            ParserState::Degraded,
                            Some("パーサが終了しました。立て直しています".to_string()),
                        );
                    }
                }
            }
            Err(error) => {
                supervisor.set_state(
                    ParserState::Degraded,
                    Some(format!("パーサを起動できません: {error}")),
                );
            }
        }

        let wait = RESTART_BACKOFF_MS[attempt.min(RESTART_BACKOFF_MS.len() - 1)];
        attempt += 1;
        tokio::time::sleep(Duration::from_millis(wait)).await;
    }
}

enum PumpEnd {
    /// core 自体が終わる
    Shutdown,
    /// パーサが死んだので立て直す
    ParserGone,
    /// 自己修復が差し替えたので、こちらから立て直す
    Restart,
}

async fn spawn_parser(config: &SessionHostConfig) -> std::io::Result<tokio::process::Child> {
    tokio::process::Command::new(parser_program(config))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // core が落ちたときにパーサだけ生き残らないようにする
        .kill_on_drop(true)
        .spawn()
}

async fn pump(
    supervisor: &Arc<ParserSupervisor>,
    mut child: tokio::process::Child,
    requests: &mut mpsc::Receiver<ParserRequest>,
    restarts: &mut mpsc::Receiver<()>,
    watched: &mut HashMap<CardId, String>,
) -> PumpEnd {
    let Some(mut stdin) = child.stdin.take() else {
        return PumpEnd::ParserGone;
    };
    let Some(stdout) = child.stdout.take() else {
        return PumpEnd::ParserGone;
    };
    if let Some(stderr) = child.stderr.take() {
        // パーサのログは stderr にしか出さない約束。core のログへ合流させる
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match strip_pid(&line) {
                    Some((pid, rest)) => {
                        tracing::warn!(parser_pid = pid, "transcript-parser: {rest}");
                    }
                    None => tracing::warn!("transcript-parser: {line}"),
                }
            }
        });
    }

    let (events_tx, mut events) = mpsc::channel::<ParserEvent>(REQUEST_QUEUE);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            match serde_json::from_str::<ParserEvent>(&line) {
                Ok(event) => {
                    if events_tx.send(event).await.is_err() {
                        break;
                    }
                }
                // 知らないイベントで落ちない。パーサが新しくなっても core は動き続ける
                Err(error) => tracing::warn!("パーサの出力を解釈できません: {error}: {line}"),
            }
        }
    });

    // 立て直し後は、監視していたカードを保存済みの位置から登録し直す（無欠落再開）
    for (card_id, path) in watched.iter() {
        let command = watch_command(&supervisor.offsets, *card_id, path.clone());
        if write_command(&mut stdin, &command).await.is_err() {
            return PumpEnd::ParserGone;
        }
    }

    loop {
        tokio::select! {
            request = requests.recv() => match request {
                Some(ParserRequest::Watch { card_id, path }) => {
                    watched.insert(card_id, path.clone());
                    let command = watch_command(&supervisor.offsets, card_id, path);
                    if write_command(&mut stdin, &command).await.is_err() {
                        return PumpEnd::ParserGone;
                    }
                }
                Some(ParserRequest::Unwatch { card_id }) => {
                    watched.remove(&card_id);
                    supervisor.offsets.forget(card_id);
                    if write_command(&mut stdin, &ParserCommand::Unwatch { card_id }).await.is_err() {
                        return PumpEnd::ParserGone;
                    }
                }
                // core が畳まれた
                None => {
                    if let Err(err) = write_command(&mut stdin, &ParserCommand::Shutdown).await {
                        // **孤児が生まれるのはここ**（未解明事象2。36分生き残った実測）。
                        // 停止指示が届かなかった相手の pid が出ることに全部が懸かっている
                        tracing::warn!(
                            parser_pid = ?child.id(),
                            watching = watched.len(),
                            %err,
                            "畳むときにパーサへ停止を指示できません。孤児が残る恐れがあります"
                        );
                    }
                    return PumpEnd::Shutdown;
                }
            },

            event = events.recv() => match event {
                Some(event) => handle_event(supervisor, event, watched),
                // パーサの stdout が閉じた＝プロセスが終わった
                None => return PumpEnd::ParserGone,
            },

            restart = restarts.recv() => match restart {
                Some(()) => {
                    // 読みかけを畳ませてから落とす。応答を待たないのは、差し替えの目的が
                    // 「新しいバイナリに変わること」であって、綺麗に終わることではないため
                    //
                    // **`kill().await` より前に控える。** あれは子を刈り取るので、
                    // あとから `child.id()` を呼ぶと `None` になり、いちばん要る番号が消える
                    let parser_pid = child.id();
                    if let Err(err) = write_command(&mut stdin, &ParserCommand::Shutdown).await {
                        tracing::warn!(
                            parser_pid = ?parser_pid,
                            watching = watched.len(),
                            %err,
                            "差し替えのための停止指示がパーサへ届きません"
                        );
                    }
                    if let Err(err) = child.kill().await {
                        tracing::warn!(
                            parser_pid = ?parser_pid,
                            %err,
                            "差し替えのためのパーサ停止に失敗しました。古いパーサが生き残ります"
                        );
                    }
                    return PumpEnd::Restart;
                }
                None => return PumpEnd::Shutdown,
            },

            status = child.wait() => {
                tracing::warn!("transcript-parser が終了しました: {status:?}");
                return PumpEnd::ParserGone;
            }
        }
    }
}

fn watch_command(offsets: &OffsetStore, card_id: CardId, path: String) -> ParserCommand {
    let from_offsets = offsets.resume(card_id, &path);
    ParserCommand::Watch {
        card_id,
        path,
        from_offsets,
    }
}

async fn write_command(
    stdin: &mut tokio::process::ChildStdin,
    command: &ParserCommand,
) -> std::io::Result<()> {
    let mut line = serde_json::to_string(command).unwrap_or_default();
    line.push('\n');
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await
}

fn handle_event(
    supervisor: &Arc<ParserSupervisor>,
    event: ParserEvent,
    watched: &HashMap<CardId, String>,
) {
    match event {
        ParserEvent::Hello {
            protocol_version,
            parser_version,
        } => {
            if protocol_version != PROTOCOL_VERSION {
                // 噛み合わないバイナリを黙って使うと、静かに間違ったツリーが出る。
                // 目に見える縮退のほうがまだ良い
                supervisor.set_state(
                    ParserState::Degraded,
                    Some(format!(
                        "パーサの版が噛み合いません（core={PROTOCOL_VERSION} / parser={protocol_version}）"
                    )),
                );
            } else {
                tracing::info!("transcript-parser {parser_version} と接続しました");
            }
        }

        ParserEvent::Nodes {
            card_id,
            source,
            nodes,
            next_offset,
        } => {
            // **窓へ書くのではなく、上へ報告する**（セルフホスト化設計§3-3）。
            // 履歴の持ち主はサーバ側の記録（DB）なので、こちらは読んだものと
            // 「入ったら進めてよい位置」を渡すだけ。セルフホストでは同じ報告が
            // A2S を渡って TranscriptBatch になる（§6-1）
            let Some(path) = watched.get(&card_id) else {
                // 監視していないカードの報告。位置の持ち主が決まらないので捨てる
                return;
            };
            supervisor
                .manager
                .report_transcript(card_id, path, &source, next_offset, &nodes);
        }

        ParserEvent::Reset { card_id } => {
            // 位置を忘れるのも**記録に入ってから**。ここで忘れると、消せなかった
            // ときに読み直す手掛かりまで失う
            supervisor.manager.report_transcript_reset(card_id);
        }

        // 過去範囲の読み直しは**もう頼まない**（セルフホスト化設計§3-3）。
        // 遡りの読み先が JSONL から DB へ変わったので、この応答は来ない。
        // `ipc.rs` は凍結境界（設計§4-4）なので、変種そのものは残っている
        ParserEvent::Range { .. } => {}

        ParserEvent::Stats {
            card_id,
            records_total,
            parse_errors,
            unknown_types,
            orphans,
            versions,
        } => {
            // 率の判定は core（自己修復）の仕事。ここは中継するだけで、
            // 届け先が居なければ何もしない（設計§9）
            if let Some(sink) = supervisor
                .stats_sink
                .lock()
                .expect("ロックが壊れていない")
                .as_ref()
            {
                // 溢れたら捨てる。健康状態は次の報告でも届くので、ここで待つ理由が無い
                let _ = sink.try_send(StatsReport {
                    card_id,
                    records_total,
                    parse_errors,
                    unknown_types,
                    orphans,
                    versions,
                });
            }
        }

        ParserEvent::Error { message, .. } => {
            tracing::warn!("パーサからのエラー: {message}");
        }
    }
}

/// パーサが前置した `[<pid>] ` を剥がす（ログ設計§8-3）。
///
/// **剥がせなければ丸ごと本文として扱い、警告も出さない。** ここはパーサの stderr を
/// そのまま運ぶ道であって、書式を強制する道ではない。厳しくすると、
///
/// - 前置を持たない古いパーサ（保管庫や自己修復が置いた版）を繋いだ瞬間に警告が洪水になる
/// - `[` で始まる panic メッセージやバックトレースを壊す
///
/// という形で、**いちばん読みたい行を潰す**。
fn strip_pid(line: &str) -> Option<(u32, &str)> {
    let rest = line.strip_prefix('[')?;
    let (pid, rest) = rest.split_once("] ")?;
    Some((pid.parse().ok()?, rest))
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 前置したpidを剥がして欄へ移せる() {
        assert_eq!(
            strip_pid("[15637] ファイル監視を使えないので巡回だけで動きます: x"),
            Some((15637, "ファイル監視を使えないので巡回だけで動きます: x"))
        );
    }

    #[test]
    fn 剥がせない行は丸ごと本文として残す() {
        // 前置を持たない古いパーサ、panic メッセージ、バックトレース
        for line in [
            "前置の無い行",
            "[まだ] 数字ではない",
            "[15637]区切りが無い",
            "[",
            "",
            "thread 'main' panicked at src/main.rs:1:1:",
        ] {
            assert!(strip_pid(line).is_none(), "{line} を剥がしてしまった");
        }
    }

    /// 監視を頼むときの「ここから読め」は、保存済みの位置をそのまま渡す。
    ///
    /// 位置そのものの振る舞い（パスが変わったら使わない・巻き戻したら忘れる）は
    /// [`crate::offsets`] 側で固めてある。ここで見るのは**受け渡しの形**だけ。
    #[test]
    fn 保存済みの位置から読み直しを頼む() {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-parser-watch-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");
        let offsets = OffsetStore::open(dir.clone());
        let card_id = CardId::new();
        offsets.commit(card_id, "/p/s.jsonl", "/p/s.jsonl", 42);

        match watch_command(&offsets, card_id, "/p/s.jsonl".to_string()) {
            ParserCommand::Watch { from_offsets, .. } => {
                assert_eq!(from_offsets["/p/s.jsonl"], 42);
            }
            other => panic!("Watch ではない: {other:?}"),
        }

        // まだ何も読んでいないカードは先頭から
        match watch_command(&offsets, CardId::new(), "/p/other.jsonl".to_string()) {
            ParserCommand::Watch { from_offsets, .. } => assert!(from_offsets.is_empty()),
            other => panic!("Watch ではない: {other:?}"),
        }

        let _ = std::fs::remove_dir_all(dir);
    }
}
