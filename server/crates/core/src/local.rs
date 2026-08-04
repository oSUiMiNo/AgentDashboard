//! ローカルモードの配線（セルフホスト化設計§2-3）。
//!
//! サーバ側（[`server_core`]）から見た「PC 側」を、**同じプロセスの
//! [`session_host_core`] へ直結**する実装。セルフホストモードではここが A2S（WebSocket）越しの
//! 実装に差し替わるが、ブラウザから見た口は変わらない（フェーズ3）。
//!
//! # ここに判断を足さない
//!
//! このモジュールがやるのは**呼び替えだけ**にする。「手元のウィンドウで足りるか」
//! 「パーサへ読み直しを頼むか」のような判断は、データを持っている
//! [`session_host_core`] 側か、画面の都合を知っている [`server_core`] 側のどちらかに置く。
//! 中間の層に判断が溜まると、フェーズ3 で差し替えるときにその判断だけが取り残される。
//!
//! # 直列化もコピーも増やさない
//!
//! PTY のバイトは [`SessionHost::subscribe_pty`] が返す購読口からそのまま流れる。
//! ローカルモードの体感速度は初期実装フェーズ4 の実測（12セッションで61fps）が前提なので、
//! 境界を挟んだぶんの手数を足してはいけない。

use bytes::Bytes;
use protocol::{CardId, ModelId, PermissionMode, ws::ParserState, ws::ServerMessage};
use server_core::{agent::SessionHost, registry::SessionRegistry};
use session_host_core::{
    events::{EventSink, LocalEventBus, TranscriptReport},
    offsets::OffsetStore,
    parser::ParserSupervisor,
    session::SessionManager,
};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

/// 見つからないカードを指されたときの説明。
const NOT_FOUND: &str = "セッションが見つかりません";

pub struct LocalSessionHost {
    manager: Arc<SessionManager>,
    /// パーサの世話役。**居なくても動く**（構造化ビューだけが縮退する）。
    ///
    /// 設計§11 の「パーサが停止しても、ターミナルと指示送信は通常動作」を型で表している。
    parser: Option<Arc<ParserSupervisor>>,
}

impl LocalSessionHost {
    pub fn new(manager: Arc<SessionManager>) -> Self {
        Self {
            manager,
            parser: None,
        }
    }

    /// パーサを繋いだ状態にする。
    pub fn with_parser(mut self, parser: Arc<ParserSupervisor>) -> Self {
        self.parser = Some(parser);
        self
    }
}

#[async_trait::async_trait]
impl SessionHost for LocalSessionHost {
    fn exists(&self, card_id: CardId) -> bool {
        self.manager.get(card_id).is_some()
    }

    /// **宛先は見ない。** ローカルモードに PC という単位は存在しないので、
    /// 指名されていたとしても送る先はここしか無い（画面も選択肢を出さない）。
    async fn spawn(&self, request: server_core::agent::SpawnRequest<'_>) -> Result<(), String> {
        self.manager
            .spawn_with_mode(request.cwd, request.permission_mode)
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    fn kill(&self, card_id: CardId) -> Result<(), String> {
        self.manager.kill(card_id).map_err(|err| err.to_string())
    }

    fn archive(&self, card_id: CardId) -> Result<(), String> {
        self.manager.archive(card_id).map_err(|err| err.to_string())
    }

    /// **見ている人数は数えない。** ローカルは生バイトをそのまま配るので、
    /// 何人が見ていようと PTY の読み取りは同じように動く（設計§7-2）。
    fn subscribe_pty(
        &self,
        card_id: CardId,
        _client_id: u64,
        _cols: u16,
        _rows: u16,
    ) -> Option<(Bytes, broadcast::Receiver<Bytes>)> {
        Some(self.manager.get(card_id)?.subscribe_with_snapshot())
    }

    fn pty_snapshot(&self, card_id: CardId) -> Option<Bytes> {
        Some(self.manager.get(card_id)?.snapshot_frame())
    }

    fn write_input(&self, card_id: CardId, bytes: &[u8]) -> Result<(), String> {
        let session = self.manager.get(card_id).ok_or(NOT_FOUND)?;
        session
            .write_input(bytes)
            .map_err(|err| format!("端末へ書き込めませんでした: {err:#}"))
    }

    fn resize(&self, card_id: CardId, cols: u16, rows: u16) {
        if let Some(session) = self.manager.get(card_id) {
            let _ = session.resize(cols, rows);
        }
    }

    fn set_flow(&self, card_id: CardId, client_id: u64, paused: bool) {
        if let Some(session) = self.manager.get(card_id) {
            session.set_client_pause(client_id, paused);
        }
    }

    fn release_client(&self, card_id: CardId, client_id: u64) {
        if let Some(session) = self.manager.get(card_id) {
            session.release_client(client_id);
        }
    }

    fn parser_state(&self) -> Option<ParserState> {
        self.parser.as_ref().map(|parser| parser.state())
    }

    async fn send_input(&self, card_id: CardId, text: String) -> Result<(), String> {
        let session = self.manager.get(card_id).ok_or(NOT_FOUND)?;
        session
            .send_instruction(&text)
            .await
            .map_err(|err| format!("指示を送れませんでした: {err:#}"))
    }

    async fn set_permission_mode(
        &self,
        card_id: CardId,
        mode: PermissionMode,
    ) -> Result<(), String> {
        let session = self.manager.get(card_id).ok_or(NOT_FOUND)?;
        let outcome = session.switch_permission_mode(&mode).await;
        // 着いても着かなくても、いまどこに居るのかは配る（途中まで動いた結果も伝わる）
        self.manager.broadcast_session(&session);
        outcome.map(|_| ()).map_err(|err| err.to_string())
    }

    async fn set_model(&self, card_id: CardId, model: ModelId) -> Result<(), String> {
        let session = self.manager.get(card_id).ok_or(NOT_FOUND)?;
        match self.manager.switch_model(&session, &model).await {
            // 成功時の配信は切替の中で済んでいる（楽観更新と確定の2回）
            Ok(()) => Ok(()),
            Err(err) => {
                // 途中まで動いた結果も配る（楽観更新が立っていれば、それも伝わる）
                self.manager.broadcast_session(&session);
                Err(err.to_string())
            }
        }
    }
}

/// セッションホストの報告を**記録層へ運ぶ**報告先（セルフホスト化設計§2-3・§3-3）。
///
/// フェーズ1 では、セッションホストの報告はそのままブラウザへ配られていた。フェーズ2 で
/// DB が真実になったので、間に記録層（[`SessionRegistry`]）が入る。
///
/// ```text
/// SessionManager --emit--> ReportingSink --(待ち行列)--> SessionRegistry
///                                                         ├ DB へ書く
///                                                         └ ブラウザへ配る
/// ```
///
/// # 待ち行列に上限を置かない
///
/// DB への書き込みは非同期なので、報告（同期）と書き込みの間に待ち行列が要る。ここを
/// **上限つきにして溢れたら捨てる**形にはできない——捨てた履歴は二度と来ないので、
/// 「欠落なし」（要件の非機能）が壊れる。設計§6-1 が「欠落より重複を選ぶ」と決めている
/// のと同じ判断で、**遅れは許容し、欠落は許容しない**。
///
/// # 手元の配信も残す
///
/// 自己修復は、自分が起こしたセッションの様子を**同じプロセスの中で**見ながら進む
/// （`selfheal`）。記録層へ流すだけにすると、その購読者が居なくなる。
pub struct ReportingSink {
    /// 同じプロセス内の購読者（自己修復）向け
    bus: LocalEventBus,
    /// 記録層への待ち行列
    reports: mpsc::UnboundedSender<Report>,
}

/// 記録層へ運ぶもの1件。
///
/// 履歴だけ別扱いなのは、**取り込めたら位置を進める**という後始末が付くため（§6-1）。
enum Report {
    /// 状態や自己修復の知らせ。取り込めたかどうかで何かが変わることはない
    Volatile(ServerMessage),
    Transcript(TranscriptReport),
    Reset(protocol::CardId),
}

impl EventSink for ReportingSink {
    fn emit(&self, event: ServerMessage) {
        // 記録層が落ちている（受け口が閉じた）場合でも、手元の購読者へは配り続ける
        let _ = self.reports.send(Report::Volatile(event.clone()));
        self.bus.emit(event);
    }

    fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
        self.bus.subscribe()
    }

    fn report_transcript(&self, report: TranscriptReport) {
        // **手元の配信へは流さない。** 同じプロセスの購読者は自己修復だけで、見ているのは
        // セッションの状態（`Status`）である。履歴を配ると、ノードを丸ごと複製する仕事が
        // 誰も読まないまま毎回増える
        let _ = self.reports.send(Report::Transcript(report));
    }

    fn reset_transcript(&self, card_id: protocol::CardId) {
        let _ = self.reports.send(Report::Reset(card_id));
    }
}

/// 記録層へ繋いだ報告先を作り、運ぶ役を1本立てる。
///
/// 呼び出し側は**この1本を [`SessionManager`] へ渡すだけ**でよい。
///
/// # 位置を進めるのはここ
///
/// 記録層が「書けた」と答えたときだけ、再開位置を進める（設計§6-1）。ローカルモードにも
/// この規約を通してあるのは、**保証がモードで食い違うと、ローカルで緑なのにセルフホストで
/// 欠ける**という一番たちの悪い形になるため。取り込む先が無かったもの（外した直後の
/// カード宛て）も「終わった」と扱う——二度と書ける見込みが無いものを待ち続けると、
/// そのカードの位置が永久に止まる。
pub fn reporting(registry: Arc<SessionRegistry>, offsets: Arc<OffsetStore>) -> Arc<ReportingSink> {
    let (reports, mut inbox) = mpsc::unbounded_channel::<Report>();
    tokio::spawn(async move {
        // 報告の出どころは常に同じ（このプロセスの中の1台）。セルフホストモードでは
        // 接続ごとに変わるが、ローカルには PC という単位が無いので `agent_id` は無い
        let origin = server_core::registry::ReportOrigin::local();
        // 1本のタスクで順に処理する。**順序がそのまま DB への書き込み順になる**ので、
        // 巻き戻し（TranscriptReset）が履歴を追い越さない（設計§6-2）
        while let Some(report) = inbox.recv().await {
            match report {
                Report::Volatile(message) => {
                    registry.apply(&origin, message).await;
                }
                Report::Transcript(report) => {
                    let TranscriptReport {
                        card_id,
                        transcript_path,
                        source,
                        next_offset,
                        nodes,
                    } = report;
                    if registry
                        .apply(&origin, ServerMessage::TranscriptAppend { card_id, nodes })
                        .await
                    {
                        offsets.commit(card_id, &transcript_path, &source, next_offset);
                    }
                }
                Report::Reset(card_id) => {
                    if registry
                        .apply(&origin, ServerMessage::TranscriptReset { card_id })
                        .await
                    {
                        offsets.forget(card_id);
                    }
                }
            }
        }
    });
    Arc::new(ReportingSink {
        bus: LocalEventBus::new(),
        reports,
    })
}
