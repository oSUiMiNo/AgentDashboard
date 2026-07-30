//! ローカルモードの配線（セルフホスト化設計§2-3）。
//!
//! サーバ側（[`server_core`]）から見た「PC 側」を、**同じプロセスの
//! [`agent_core`] へ直結**する実装。セルフホストモードではここが A2S（WebSocket）越しの
//! 実装に差し替わるが、ブラウザから見た口は変わらない（フェーズ3）。
//!
//! # ここに判断を足さない
//!
//! このモジュールがやるのは**呼び替えだけ**にする。「手元のウィンドウで足りるか」
//! 「パーサへ読み直しを頼むか」のような判断は、データを持っている
//! [`agent_core`] 側か、画面の都合を知っている [`server_core`] 側のどちらかに置く。
//! 中間の層に判断が溜まると、フェーズ3 で差し替えるときにその判断だけが取り残される。
//!
//! # 直列化もコピーも増やさない
//!
//! PTY のバイトは [`AgentHost::subscribe_pty`] が返す購読口からそのまま流れる。
//! ローカルモードの体感速度は初期実装フェーズ4 の実測（12セッションで61fps）が前提なので、
//! 境界を挟んだぶんの手数を足してはいけない。

use agent_core::{parser::ParserSupervisor, session::SessionManager};
use bytes::Bytes;
use protocol::{
    CardId, ModelId, NodeId, PermissionMode, SessionMeta, TreeNode,
    ws::{ParserState, ServerMessage},
};
use server_core::agent::{AgentHost, PageError, TranscriptPage};
use std::sync::Arc;
use tokio::sync::broadcast;

/// 見つからないカードを指されたときの説明。
const NOT_FOUND: &str = "セッションが見つかりません";

pub struct LocalAgent {
    manager: Arc<SessionManager>,
    /// パーサの世話役。**居なくても動く**（構造化ビューだけが縮退する）。
    ///
    /// 設計§11 の「パーサが停止しても、ターミナルと指示送信は通常動作」を型で表している。
    parser: Option<Arc<ParserSupervisor>>,
}

impl LocalAgent {
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
impl AgentHost for LocalAgent {
    fn list(&self) -> Vec<SessionMeta> {
        self.manager.list()
    }

    fn exists(&self, card_id: CardId) -> bool {
        self.manager.get(card_id).is_some()
    }

    fn subscribe_events(&self) -> broadcast::Receiver<ServerMessage> {
        self.manager.subscribe_events()
    }

    fn spawn(&self, cwd: &str, permission_mode: Option<PermissionMode>) -> Result<CardId, String> {
        self.manager
            .spawn_with_mode(cwd, permission_mode)
            .map(|session| session.card_id)
            .map_err(|err| err.to_string())
    }

    fn kill(&self, card_id: CardId) -> Result<(), String> {
        self.manager.kill(card_id).map_err(|err| err.to_string())
    }

    fn archive(&self, card_id: CardId) -> Result<(), String> {
        self.manager.archive(card_id).map_err(|err| err.to_string())
    }

    fn subscribe_pty(&self, card_id: CardId) -> Option<(Bytes, broadcast::Receiver<Bytes>)> {
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

    fn subscribe_transcript(
        &self,
        card_id: CardId,
    ) -> Option<(Vec<TreeNode>, broadcast::Receiver<Arc<String>>)> {
        Some(self.manager.get(card_id)?.subscribe_transcript())
    }

    fn transcript_snapshot(&self, card_id: CardId) -> Option<Vec<TreeNode>> {
        Some(self.manager.get(card_id)?.transcript_snapshot())
    }

    async fn transcript_page(
        &self,
        card_id: CardId,
        before: Option<NodeId>,
        limit: usize,
    ) -> Result<TranscriptPage, PageError> {
        let session = self.manager.get(card_id).ok_or(PageError::NotFound)?;

        let Some(before) = before else {
            // 起点の指定なし＝手元の最新ぶん
            let mut nodes = session.transcript_snapshot();
            let has_more = nodes.len() > limit;
            if has_more {
                nodes = nodes.split_off(nodes.len() - limit);
            }
            return Ok(TranscriptPage { nodes, has_more });
        };

        // 手元のウィンドウで答えられるならパーサへ行かない
        if let Some(nodes) = session.transcript_before(&before, limit) {
            let has_more = nodes.len() == limit;
            return Ok(TranscriptPage { nodes, has_more });
        }

        let Some(anchor) = session.transcript_anchor(&before) else {
            // どこにも位置の記録が無い＝これ以上は遡れない
            return Ok(TranscriptPage {
                nodes: Vec::new(),
                has_more: false,
            });
        };
        let parser = self.parser.as_ref().ok_or(PageError::Unavailable)?;
        let mut parsed = parser
            .read_range(card_id, anchor.source, anchor.offset)
            .await
            .ok_or(PageError::Unavailable)?;

        let has_more = parsed.len() > limit;
        if has_more {
            parsed = parsed.split_off(parsed.len() - limit);
        }
        Ok(TranscriptPage {
            nodes: parsed.into_iter().map(|parsed| parsed.node).collect(),
            has_more,
        })
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
