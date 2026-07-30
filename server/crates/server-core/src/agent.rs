//! サーバから見た「PC 側」の境界（セルフホスト化設計§2-3）。
//!
//! ブラウザ配信の側（[`crate::ws`]）は、セッションの実体（PTY・claude のプロセス・
//! トランスクリプトのファイル）を**一切知らない**。知っているのはこのトレイト越しに
//! 頼めることだけで、実体は次の2つに差し替わる。
//!
//! | モード | 実体 |
//! |---|---|
//! | ローカル | 同じプロセスの `agent_core` へ直結（`agentdashboard_core::local::LocalAgent`） |
//! | セルフホスト | A2S（WebSocket）越しのエージェント（フェーズ3） |
//!
//! # ここを通っても遅くならない
//!
//! PTY のバイトは [`AgentHost::subscribe_pty`] が返す [`broadcast::Receiver`] から
//! そのまま流れる。**境界を挟んでも直列化もコピーも増えない**（同じ [`Bytes`] の
//! 参照カウントが増えるだけ）。ローカルモードの体感速度は初期実装フェーズ4 の実測が
//! 前提になっているので、ここに手数を足してはいけない。
//!
//! # 戻り値が `String` のエラーなのはなぜか
//!
//! 失敗の中身は画面へ文字列として出る（`ServerMessage::Error`）。境界の向こうが
//! ネットワークになると、エラーの型をそのまま運ぶには型の共有が要る。**運ぶのは
//! 「人が読む説明」だけ**と決めておけば、フェーズ3 でここを A2S に差し替えても
//! 表示は変わらない。

use bytes::Bytes;
use protocol::{CardId, ModelId, PermissionMode, ws::ParserState};
use tokio::sync::broadcast;

#[async_trait::async_trait]
pub trait AgentHost: Send + Sync + 'static {
    // --- 生存確認 -------------------------------------------------------------

    /// そのカードが**いま生きているか**。
    ///
    /// 記録として残っているかとは別物である点に注意。DB から復元したカード
    /// （前回の起動が残したもの）は一覧にも履歴にも出るが、PTY を持たないので
    /// ここでは `false` になり、指示送信や切替は「見つかりません」で断られる。
    ///
    /// 時間のかかる操作（切替）を別タスクへ逃がす**前に**、居ないことだけは即座に
    /// 返すために要る。逃がしたあとで気づくと、押しても何も起きない時間ができる。
    fn exists(&self, card_id: CardId) -> bool;

    // --- 生存操作 -------------------------------------------------------------

    fn spawn(&self, cwd: &str, permission_mode: Option<PermissionMode>) -> Result<CardId, String>;
    fn kill(&self, card_id: CardId) -> Result<(), String>;
    fn archive(&self, card_id: CardId) -> Result<(), String>;

    // --- ターミナル -----------------------------------------------------------

    /// いまの画面（スクロールバック）と、その続きを受け取る口を**同時に**取る。
    ///
    /// 2つに分けて取ると、間に流れたバイトを取りこぼすか二重に書くことになり、
    /// どちらも端末の表示を壊す。
    fn subscribe_pty(&self, card_id: CardId) -> Option<(Bytes, broadcast::Receiver<Bytes>)>;

    /// いまの画面だけを取る（取りこぼしたクライアントを作り直すため）。
    fn pty_snapshot(&self, card_id: CardId) -> Option<Bytes>;

    fn write_input(&self, card_id: CardId, bytes: &[u8]) -> Result<(), String>;
    fn resize(&self, card_id: CardId, cols: u16, rows: u16);

    /// フロー制御。1つでも停止を要求しているクライアントがあれば読み取りを止める。
    fn set_flow(&self, card_id: CardId, client_id: u64, paused: bool);

    /// クライアントが去った。**忘れるとそのクライアントの停止要求が残り、端末が二度と動かない。**
    fn release_client(&self, card_id: CardId, client_id: u64);

    // --- 履歴 -----------------------------------------------------------------

    /// パーサの健康状態。居なければ `None`（縮退の通知そのものを出さない）。
    ///
    /// 履歴そのものはここを通らない。**記録の持ち主はサーバ**（[`crate::registry`]）で、
    /// PC 側は読んだノードを報告するだけになった（設計§3-3・§6-1）。
    fn parser_state(&self) -> Option<ParserState>;

    // --- 指示・切替 -----------------------------------------------------------

    /// Composer からの指示送信。PTY へ届くまでの作法（初期実装§18）は向こう側の責任。
    async fn send_input(&self, card_id: CardId, text: String) -> Result<(), String>;

    /// 権限モードの切替（TUI へのキー送出なので時間がかかる）。
    async fn set_permission_mode(
        &self,
        card_id: CardId,
        mode: PermissionMode,
    ) -> Result<(), String>;

    /// モデルの切替（利用者のグローバル既定の保護まで含めて向こう側で行う）。
    async fn set_model(&self, card_id: CardId, model: ModelId) -> Result<(), String>;
}
