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
use protocol::{
    CardId, ModelId, PermissionMode, ws::ErrorKind, ws::ParserState, ws::ServerMessage,
};
use server_core::{registry::SessionRegistry, session_host::SessionHost};
use session_host_core::{
    events::{EventSink, LocalEventBus, TranscriptReport},
    offsets::OffsetStore,
    parser::ParserSupervisor,
    session::{self, SessionManager},
};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

/// 見つからないカードを指されたときの説明。
const NOT_FOUND: &str = "セッションが見つかりません";

/// 記録を繋がずに組み立てられた土台で、復旧を頼まれたときの説明。
///
/// **製品の経路では起こらない**（`lib.rs` が必ず繋ぐ）が、`Option` である以上
/// 通らない道が1本残る。**黙って何もしないより、届かなかったと言うほうがよい。**
const NO_REGISTRY: &str = "カードの記録に繋がっていないので、復旧を頼めません";

/// 呼び戻す先を持たないカードを指されたときの説明。
///
/// 入口（`server_core::ws`）が既に断っているので、ここへは来ない見込み。
/// **来ないはずの道でも、通ったときに何が起きたか言えるようにしておく。**
const NO_RESUME_TARGET: &str = "呼び戻す先が記録されていません";

pub struct LocalSessionHost {
    manager: Arc<SessionManager>,
    /// パーサの世話役。**居なくても動く**（構造化ビューだけが縮退する）。
    ///
    /// 設計§11 の「パーサが停止しても、ターミナルと指示送信は通常動作」を型で表している。
    parser: Option<Arc<ParserSupervisor>>,
    /// カードの記録。**起こし直し（復旧）にだけ要る。**
    ///
    /// 戻すための材料（作業ディレクトリ・権限モード・呼び戻し先）を持っているのは記録の
    /// ほうで、実体（[`SessionManager`]）は抜け殻のカードを1枚も知らない。
    ///
    /// # なぜ `Option` なのか
    ///
    /// [`LocalSessionHost::new`] は**記録を持たない土台からも呼ばれる**（ログとフォルダ閲覧の
    /// テストは DB を立てない）。必須の引数にすると、記録を1行も読まないテストにまで
    /// DB を立てさせることになる。`parser` を `Option` にしてあるのと同じ形。
    registry: Option<Arc<SessionRegistry>>,
}

impl LocalSessionHost {
    pub fn new(manager: Arc<SessionManager>) -> Self {
        Self {
            manager,
            parser: None,
            registry: None,
        }
    }

    /// パーサを繋いだ状態にする。
    pub fn with_parser(mut self, parser: Arc<ParserSupervisor>) -> Self {
        self.parser = Some(parser);
        self
    }

    /// 記録を繋いだ状態にする（復旧が材料を引くため）。
    pub fn with_registry(mut self, registry: Arc<SessionRegistry>) -> Self {
        self.registry = Some(registry);
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
    async fn spawn(
        &self,
        request: server_core::session_host::SpawnRequest<'_>,
    ) -> Result<(), String> {
        self.manager
            .spawn_with_mode(request.cwd, request.permission_mode)
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    /// 抜け殻のカードを起こし直す（接続断のカードを復旧ボタンで戻す 設計§7・§8）。
    ///
    /// **宛先は見ない**（[`LocalSessionHost::spawn`] と同じ理由）。材料は記録から引く。
    ///
    /// 印を立てる（`begin_revive`）のは**切り離す前**（設計§8-3）。後にすると、続けて
    /// 2回押したときに切り離した2つが同時に印を見て両方通る。席を待つのは切り離した先で、
    /// ここで待つと押したブラウザの他の操作まで止まる。
    async fn revive(
        &self,
        request: server_core::session_host::ReviveRequest,
    ) -> Result<(), String> {
        let registry = self.registry.as_ref().ok_or(NO_REGISTRY)?;
        let meta = registry
            .owned(request.account_id, request.card_id)
            .map(|record| record.meta())
            .ok_or(NOT_FOUND)?;
        // 戻せるかは入口（`server_core::ws`）が確かめてある。ここで見るのは
        // 「材料が揃っているか」だけ——呼び戻し先が無ければ `--resume` に渡す値が無い
        let claude_session_id = meta.claude_session_id.ok_or(NO_RESUME_TARGET)?;
        let in_flight = self
            .manager
            .begin_revive(request.card_id)
            .ok_or(session::ALREADY_REVIVING)?;

        let manager = Arc::clone(&self.manager);
        let cwd = meta.project.0.clone();
        let mode = meta.permission_mode.clone();
        tokio::spawn(async move {
            if let Err(err) = manager
                .revive(in_flight, &cwd, mode, claude_session_id)
                .await
            {
                // **黙って失敗させない。** 待っている相手（画面・CLI）には状態でしか
                // 返らないので、届かなかったことは自分から配る（`link.rs` と同じ形）
                manager.broadcast(ServerMessage::Error {
                    card_id: Some(request.card_id),
                    message: err.to_string(),
                    kind: ErrorKind::Other,
                });
            }
        });
        Ok(())
    }

    async fn recall(
        &self,
        request: server_core::session_host::RecallRequest,
    ) -> Result<(), String> {
        // 材料（作業ディレクトリ・権限モード・呼び戻し先）は呼ぶ側が記録から引いてある。
        // **席は取らない**——復旧と違い、毎回新しいカードを作るので二度押しは
        // カードが2枚できるだけになる（利用者から見て説明の付く結果）
        self.manager
            .recall(
                &request.cwd,
                request.permission_mode,
                request.claude_session_id,
            )
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    async fn sessions_exist(
        &self,
        request: server_core::session_host::HostAskRequest,
        ids: &[protocol::ClaudeSessionId],
    ) -> Result<Vec<protocol::ClaudeSessionId>, server_core::session_host::HostAskError> {
        reject_target(&request)?;
        // **ローカルもこの口を通す。** 近道を作ると経路の違いが原因の壊れ方が残る
        // （`list_dir` と同じ理由）。走査はファイルを触るので逃がす
        let ids = ids.to_vec();
        Ok(tokio::task::spawn_blocking(move || {
            session_host_core::claude_home::existing_sessions(&ids)
        })
        .await
        .unwrap_or_default())
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

    async fn send_input(
        &self,
        card_id: CardId,
        text: String,
        attachments: Vec<String>,
    ) -> Result<(), String> {
        let session = self.manager.get(card_id).ok_or(NOT_FOUND)?;
        session
            .send_instruction_with(&text, &attachments)
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

    /// フォルダの中身（イシューグループ_2026_0805_0514 設計§5・§19）。
    ///
    /// **ここでディレクトリを読まない。** 読むのは `session_host_core::hostfs` で、
    /// このモジュールがやるのは呼び替えだけ——ローカルだけの近道を作ると、
    /// セルフホストとの間に「経路の違いでしか出ない壊れ方」が残る。
    ///
    /// `target` は見ない。ローカルモードには PC という単位が無いので、
    /// **宛先を指定される余地そのものが無い**（帰属の確認は §18 のとおりサーバ側の口で行う）。
    async fn list_dir(
        &self,
        request: server_core::session_host::HostAskRequest,
        start: Option<&str>,
    ) -> Result<protocol::fs::DirListing, server_core::session_host::HostAskError> {
        reject_target(&request)?;
        // 省略ならホーム、貼られた形なら読み替える（設計§26-2・§13）。
        // セルフホストでは PC 側が同じ1本を通る。**解決も逃がした先で行う**——
        // 候補ごとに `is_dir()` を叩くので、ここでやると配信と同じワーカーが止まる
        let start = start.map(str::to_string);
        blocking_ask(move || session_host_core::hostfs::list_dir_from(start.as_deref())).await
    }

    async fn read_file(
        &self,
        request: server_core::session_host::HostAskRequest,
        path: &str,
    ) -> Result<protocol::fs::FileContent, server_core::session_host::HostAskError> {
        reject_target(&request)?;
        let path = path.to_string();
        blocking_ask(move || session_host_core::hostfs::read_file(std::path::Path::new(&path)))
            .await
    }

    /// この機械のファイルを**バイト列で**（`ファイル閲覧で画像とHTMLも表示する` 設計§3-5）。
    ///
    /// **近道を作らない。** サーバ側で「同じプロセスなら自分で読む」と書くと、
    /// 「ローカルでは動くのにセルフホストで欠ける」が残る。
    async fn read_blob(
        &self,
        request: server_core::session_host::HostAskRequest,
        path: &str,
    ) -> Result<protocol::fs::FileBlob, server_core::session_host::HostAskError> {
        reject_target(&request)?;
        let path = path.to_string();
        blocking_ask(move || session_host_core::hostfs::read_blob(std::path::Path::new(&path)))
            .await
    }

    /// 添付を1枚置く（`メッセージに画像を添付できるようにする` 設計§4）。
    ///
    /// **近道を作らない。** [`Self::read_blob`] と同じ理由で、同じプロセスでも trait を通る。
    async fn write_blob(
        &self,
        request: server_core::session_host::HostAskRequest,
        card_id: protocol::CardId,
        media_type: &str,
        data: Vec<u8>,
    ) -> Result<protocol::fs::WrittenBlob, server_core::session_host::HostAskError> {
        reject_target(&request)?;
        let media_type = media_type.to_string();
        let config = self.manager.config().clone();
        blocking_ask(move || {
            session_host_core::attachments::write_blob(
                &config.resolved_state_dir(),
                card_id,
                &media_type,
                &data,
                config.attachment_retention_days,
                config.attachment_max_bytes,
                config.attachment_sweep_bytes,
            )
        })
        .await
    }

    /// この機械のログ（ログ設計§13-1）。
    ///
    /// フォルダと同じで、**読むのは `session_host_core::logs`**。ローカルだけの近道を
    /// 作らない。宛先を指名されたら断るのも同じ（ローカルに PC という単位は無い）。
    async fn read_log(
        &self,
        request: server_core::session_host::HostAskRequest,
        query: &protocol::logs::LogQuery,
    ) -> Result<protocol::logs::LogChunk, server_core::session_host::HostAskError> {
        reject_target(&request)?;
        let query = query.clone();
        let config = self.manager.config().clone();
        blocking_ask(move || session_host_core::logs::collect(&config, &query)).await
    }

    async fn host_resources(
        &self,
        request: server_core::session_host::HostAskRequest,
    ) -> Result<protocol::HostResources, server_core::session_host::HostAskError> {
        reject_target(&request)?;
        // **3箇所目の組み立てを作らない**（コードレビュー対応4）。予算も見込みも
        // `SessionManager` の口が持っているので、そのまま呼ぶ——ここで組み立て直すと、
        // 床の判定と食い違ったときに**画面が「入る」と言ったものを PC が断る**
        let manager = Arc::clone(&self.manager);
        // `/proc/meminfo` を読むのでファイルに触る。**配信と同じワーカーを止めない**。
        // **`blocking_ask` に載せる**ので、逃がした先が落ちた（`JoinError`）ことは
        // 「この PC では読めない」とは別の答えになる
        blocking_ask(move || {
            manager
                .host_resources()
                .ok_or_else(session_host_core::resources::ReadError::unreadable)
        })
        .await
    }
}

/// ローカルモードで宛先を指名されたら断る（設計§19）。
///
/// **ローカルモードには PC という単位が無い。** 黙って無視すると、`/api/hosts/<でたらめ>/dir`
/// が手元のファイルを返すことになり、口の意味が構成によって変わる。**知らない PC と
/// 同じ言葉で断る**ので、綴りを変えて探る余地も残らない。
fn reject_target(
    request: &server_core::session_host::HostAskRequest,
) -> Result<(), server_core::session_host::HostAskError> {
    match request.target {
        None => Ok(()),
        Some(_) => Err(server_core::session_host::HostAskError::UnknownHost),
    }
}

/// 逃がした先が返す「理由と説明」。
///
/// フォルダとログで**型が違う**（それぞれの名前が本当のことを言っているため）ので、
/// 逃がす関数の側で1つに畳む。畳まないと、同じ形の関数を2本書くことになる。
trait AskFailure {
    fn parts(self) -> (protocol::a2s::HostFailure, String);
}

impl AskFailure for session_host_core::hostfs::HostFsError {
    fn parts(self) -> (protocol::a2s::HostFailure, String) {
        (self.reason, self.detail)
    }
}

impl AskFailure for session_host_core::logs::LogReadError {
    fn parts(self) -> (protocol::a2s::HostFailure, String) {
        (self.reason, self.detail)
    }
}

impl AskFailure for session_host_core::resources::ReadError {
    fn parts(self) -> (protocol::a2s::HostFailure, String) {
        (self.reason, self.detail)
    }
}

/// 読み取りの仕事を**専用のスレッドへ逃がす**。
///
/// ローカルモードでは、この呼び出しはブラウザ配信と同じランタイムの上に居る。
/// 大きなフォルダを非同期タスクの中で直接読むと、その間そのワーカーの上にある全部が
/// 止まる（PJTガイドライン「遅いハッシュは専用のスレッドへ逃がす」と同じ理屈）。
/// 渡すのは**読む仕事そのもの**にしてある。パスと関数に分けると、パスを作る側
/// （起点の解決）だけがこちら側に残り、逃がしたはずのものが手前に漏れる。
async fn blocking_ask<T, E, F>(read: F) -> Result<T, server_core::session_host::HostAskError>
where
    T: Send + 'static,
    E: AskFailure + Send + 'static,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    use server_core::session_host::HostAskError;
    match tokio::task::spawn_blocking(read).await {
        // **ローカルが作るのは `Failed` だけ。** 線を跨がないので、届かなかったことを
        // 表す残りの理由は起こりえない（設計§19：見え方をモードで食い違わせない）
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => {
            let (reason, detail) = err.parts();
            Err(HostAskError::Failed { reason, detail })
        }
        // 逃がした先が落ちたのは実装の誤り。握り潰さず、そのまま説明にする
        Err(err) => Err(HostAskError::Failed {
            reason: protocol::a2s::HostFailure::Unsupported,
            detail: format!("読み取りを完了できませんでした（{err}）"),
        }),
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
