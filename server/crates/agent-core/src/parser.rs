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
//! # 再開位置は core が持つ
//!
//! パーサを差し替えても履歴が欠けないよう、どこまで読んだかは core 側で永続化する。
//! 置き場所は `$XDG_STATE_HOME/agentdashboard/offsets.json`（[`AgentConfig::resolved_state_dir`]）。
//! 一時ディレクトリやビルド成果物の隣に置くと、消えた瞬間に全再パースになり、
//! ブラウザへ履歴が二重に届く。
//!
//! 書き込みは**ノードを配ったあと**にする。前に書くと、その隙間で落ちたときにノードが
//! 静かに消える。後に書けば最悪もう一度届くだけで、同じIDは上書きされるので害が無い。
//! **欠落より重複を選ぶ。**

use crate::config::AgentConfig;
use crate::session::SessionManager;
use protocol::CardId;
use protocol::ipc::{PROTOCOL_VERSION, ParsedNode, ParserCommand, ParserEvent};
use protocol::ws::{ParserState, ServerMessage};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

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

/// 過去範囲の読み直しを待つ上限。返らないときに画面を固めない。
const READ_RANGE_TIMEOUT: Duration = Duration::from_secs(20);

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

/// 永続化する再開位置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Offsets {
    /// カード → そのセッションのファイルごとの再開位置
    cards: HashMap<String, CardOffsets>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CardOffsets {
    path: String,
    files: BTreeMap<String, u64>,
}

/// パーサ子プロセスの世話役。
pub struct ParserSupervisor {
    manager: Arc<SessionManager>,
    config: Arc<AgentConfig>,
    requests: mpsc::Sender<ParserRequest>,
    commands: mpsc::Sender<ParserCommand>,
    /// `read_range` の応答待ち
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Vec<ParsedNode>>>>>,
    next_req: AtomicU64,
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
    pub fn start(manager: Arc<SessionManager>, config: Arc<AgentConfig>) -> Arc<Self> {
        let (requests, request_rx) = mpsc::channel(REQUEST_QUEUE);
        let (commands, command_rx) = mpsc::channel(REQUEST_QUEUE);
        // 立て直しの依頼は溜める意味が無い（1回入っていれば十分）
        let (restarts, restart_rx) = mpsc::channel(1);

        let supervisor = Arc::new(Self {
            manager: Arc::clone(&manager),
            config: Arc::clone(&config),
            requests,
            commands,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_req: AtomicU64::new(1),
            state: Arc::new(Mutex::new(ParserState::Ok)),
            restarts,
            stats_sink: Mutex::new(None),
        });

        tokio::spawn(run(
            Arc::clone(&supervisor),
            request_rx,
            command_rx,
            restart_rx,
        ));
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

    /// 過去の範囲をパーサに読み直してもらう。
    ///
    /// 返らないまま待ち続けると画面が固まるので、必ず上限を切る。パーサが縮退している
    /// あいだは `None` を返し、呼び出し側は「これ以上遡れない」と伝える。
    pub async fn read_range(
        &self,
        card_id: CardId,
        source: String,
        to_offset: u64,
    ) -> Option<Vec<ParsedNode>> {
        let req_id = self.next_req.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("ロックが壊れていない")
            .insert(req_id, tx);

        let sent = self
            .commands
            .send(ParserCommand::ReadRange {
                req_id,
                card_id,
                source,
                from_offset: 0,
                to_offset,
            })
            .await;
        if sent.is_err() {
            self.pending
                .lock()
                .expect("ロックが壊れていない")
                .remove(&req_id);
            return None;
        }

        match tokio::time::timeout(READ_RANGE_TIMEOUT, rx).await {
            Ok(Ok(nodes)) => Some(nodes),
            _ => {
                self.pending
                    .lock()
                    .expect("ロックが壊れていない")
                    .remove(&req_id);
                None
            }
        }
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

/// 自己修復が差し替えたパーサを指すポインタファイルの名前（[`AgentConfig::resolved_state_dir`] 配下）。
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
pub fn parser_program(config: &AgentConfig) -> PathBuf {
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
    mut commands: mpsc::Receiver<ParserCommand>,
    mut restarts: mpsc::Receiver<()>,
) {
    let store = OffsetStore::new(supervisor.config.resolved_state_dir());
    let mut offsets = store.load();
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
                    &mut commands,
                    &mut restarts,
                    &mut offsets,
                    &mut watched,
                    &store,
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

async fn spawn_parser(config: &AgentConfig) -> std::io::Result<tokio::process::Child> {
    tokio::process::Command::new(parser_program(config))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // core が落ちたときにパーサだけ生き残らないようにする
        .kill_on_drop(true)
        .spawn()
}

#[allow(clippy::too_many_arguments)]
async fn pump(
    supervisor: &Arc<ParserSupervisor>,
    mut child: tokio::process::Child,
    requests: &mut mpsc::Receiver<ParserRequest>,
    commands: &mut mpsc::Receiver<ParserCommand>,
    restarts: &mut mpsc::Receiver<()>,
    offsets: &mut Offsets,
    watched: &mut HashMap<CardId, String>,
    store: &OffsetStore,
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
                tracing::warn!("transcript-parser: {line}");
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
        let command = watch_command(*card_id, path.clone(), offsets);
        if write_command(&mut stdin, &command).await.is_err() {
            return PumpEnd::ParserGone;
        }
    }

    loop {
        tokio::select! {
            request = requests.recv() => match request {
                Some(ParserRequest::Watch { card_id, path }) => {
                    watched.insert(card_id, path.clone());
                    let command = watch_command(card_id, path, offsets);
                    if write_command(&mut stdin, &command).await.is_err() {
                        return PumpEnd::ParserGone;
                    }
                }
                Some(ParserRequest::Unwatch { card_id }) => {
                    watched.remove(&card_id);
                    offsets.cards.remove(&card_id.to_string());
                    store.save(offsets);
                    if write_command(&mut stdin, &ParserCommand::Unwatch { card_id }).await.is_err() {
                        return PumpEnd::ParserGone;
                    }
                }
                // core が畳まれた
                None => {
                    let _ = write_command(&mut stdin, &ParserCommand::Shutdown).await;
                    return PumpEnd::Shutdown;
                }
            },

            command = commands.recv() => match command {
                Some(command) => {
                    if write_command(&mut stdin, &command).await.is_err() {
                        return PumpEnd::ParserGone;
                    }
                }
                None => return PumpEnd::Shutdown,
            },

            event = events.recv() => match event {
                Some(event) => handle_event(supervisor, event, offsets, watched, store),
                // パーサの stdout が閉じた＝プロセスが終わった
                None => return PumpEnd::ParserGone,
            },

            restart = restarts.recv() => match restart {
                Some(()) => {
                    // 読みかけを畳ませてから落とす。応答を待たないのは、差し替えの目的が
                    // 「新しいバイナリに変わること」であって、綺麗に終わることではないため
                    let _ = write_command(&mut stdin, &ParserCommand::Shutdown).await;
                    let _ = child.kill().await;
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

fn watch_command(card_id: CardId, path: String, offsets: &Offsets) -> ParserCommand {
    let from_offsets = offsets
        .cards
        .get(&card_id.to_string())
        .filter(|saved| saved.path == path)
        .map(|saved| saved.files.clone())
        .unwrap_or_default();
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
    offsets: &mut Offsets,
    watched: &HashMap<CardId, String>,
    store: &OffsetStore,
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
            if let Some(session) = supervisor.manager.get(card_id) {
                session.append_transcript(&source, &nodes);
            }
            // 配ったあとに位置を書く。前に書くと、その隙間で落ちたノードが静かに消える
            if let Some(path) = watched.get(&card_id) {
                let entry =
                    offsets
                        .cards
                        .entry(card_id.to_string())
                        .or_insert_with(|| CardOffsets {
                            path: path.clone(),
                            files: BTreeMap::new(),
                        });
                entry.path = path.clone();
                if next_offset > 0 {
                    entry.files.insert(source, next_offset);
                }
                store.save(offsets);
            }
        }

        ParserEvent::Reset { card_id } => {
            if let Some(session) = supervisor.manager.get(card_id) {
                session.reset_transcript();
            }
            offsets.cards.remove(&card_id.to_string());
            store.save(offsets);
        }

        ParserEvent::Range { req_id, nodes } => {
            let waiting = supervisor
                .pending
                .lock()
                .expect("ロックが壊れていない")
                .remove(&req_id);
            if let Some(waiting) = waiting {
                let _ = waiting.send(nodes);
            }
        }

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

        ParserEvent::Error {
            req_id, message, ..
        } => {
            tracing::warn!("パーサからのエラー: {message}");
            if let Some(req_id) = req_id {
                let waiting = supervisor
                    .pending
                    .lock()
                    .expect("ロックが壊れていない")
                    .remove(&req_id);
                if let Some(waiting) = waiting {
                    let _ = waiting.send(Vec::new());
                }
            }
        }
    }
}

/// 再開位置の永続化。
///
/// 一時ファイルへ書いてから置き換える。途中で落ちても、壊れた JSON を残さない。
struct OffsetStore {
    path: PathBuf,
}

impl OffsetStore {
    fn new(dir: PathBuf) -> Self {
        Self {
            path: dir.join("offsets.json"),
        }
    }

    fn load(&self) -> Offsets {
        crate::jsonfile::load_or_default(&self.path)
    }

    fn save(&self, offsets: &Offsets) {
        crate::jsonfile::save(&self.path, offsets);
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 再開位置を書いて読み直せる() {
        let dir =
            std::env::temp_dir().join(format!("agentdashboard-offsets-{}", std::process::id()));
        let store = OffsetStore::new(dir.clone());
        let card_id = CardId::new();

        let mut offsets = Offsets::default();
        offsets.cards.insert(
            card_id.to_string(),
            CardOffsets {
                path: "/p/s.jsonl".to_string(),
                files: BTreeMap::from([("/p/s.jsonl".to_string(), 1234)]),
            },
        );
        store.save(&offsets);

        let loaded = OffsetStore::new(dir.clone()).load();
        assert_eq!(
            loaded.cards.get(&card_id.to_string()).unwrap().files["/p/s.jsonl"],
            1234
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 壊れた保存ファイルは既定値として読む() {
        // 位置が読めないなら先頭から読み直せばよい。ここで落ちると起動できなくなる
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-offsets-broken-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("offsets.json"), "{壊れている").unwrap();

        let loaded = OffsetStore::new(dir.clone()).load();
        assert!(loaded.cards.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn パスが変わったカードは保存位置を使わない() {
        // resume でトランスクリプトが別ファイルに変わったら、先頭から読み直す
        let card_id = CardId::new();
        let mut offsets = Offsets::default();
        offsets.cards.insert(
            card_id.to_string(),
            CardOffsets {
                path: "/p/old.jsonl".to_string(),
                files: BTreeMap::from([("/p/old.jsonl".to_string(), 999)]),
            },
        );

        match watch_command(card_id, "/p/new.jsonl".to_string(), &offsets) {
            ParserCommand::Watch { from_offsets, .. } => assert!(from_offsets.is_empty()),
            other => panic!("Watch ではない: {other:?}"),
        }
    }
}
