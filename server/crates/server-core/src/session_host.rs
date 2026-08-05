//! サーバから見た「PC 側」の境界（セルフホスト化設計§2-3）。
//!
//! ブラウザ配信の側（[`crate::ws`]）は、セッションの実体（PTY・claude のプロセス・
//! トランスクリプトのファイル）を**一切知らない**。知っているのはこのトレイト越しに
//! 頼めることだけで、実体は次の2つに差し替わる。
//!
//! | モード | 実体 |
//! |---|---|
//! | ローカル | 同じプロセスの `session_host_core` へ直結（`agentdashboard_core::local::LocalSessionHost`） |
//! | セルフホスト | A2S（WebSocket）越しのセッションホスト（フェーズ3） |
//!
//! # ここを通っても遅くならない
//!
//! PTY のバイトは [`SessionHost::subscribe_pty`] が返す [`broadcast::Receiver`] から
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
use protocol::{
    AgentId, CardId, ModelId, PermissionMode,
    fs::{DirListing, FileContent},
    ws::ParserState,
};
use tokio::sync::broadcast;

/// 新しいセッションを起こす頼み（設計§5-1）。
///
/// 引数を並べずに1つの型へまとめてあるのは、**宛先とアカウントが後から増えた**ため。
/// 位置引数のままだと、`Option<AgentId>` と `Option<PermissionMode>` が並んで
/// 取り違えても型で気づけない。
pub struct SpawnRequest<'a> {
    /// 頼んだ人のアカウント。**他人の PC を宛先にできない**ことをここで確かめる（§8-6）
    pub account_id: uuid::Uuid,
    /// どの PC で起こすか。`None` は「選ばれていない」
    pub target: Option<AgentId>,
    pub cwd: &'a str,
    pub permission_mode: Option<PermissionMode>,
}

#[async_trait::async_trait]
pub trait SessionHost: Send + Sync + 'static {
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

    /// 新しいセッションを起こす。
    ///
    /// **できた CardId は返さない。** 採番するのはセッションホスト側（設計§5-2）で、
    /// ネットワークを跨ぐと同期には返せない。起動できたことは `SessionUpsert` が
    /// 記録層へ届いた時点で分かる——ブラウザ配信は元からその形で待っている。
    ///
    /// `target` はどの PC で起こすか（設計§5-1）。**ローカルモードは常に `None`**
    /// （PC という単位が無い）。セルフホストで `None` が来たら、繋がっているのが
    /// 1台のときだけ通す——黙って1台目へ送ると、意図しない PC で本物の claude が動く。
    ///
    /// **待つ形にしてある**のは、繋がっている PC を数えるのに連絡係と DB を引く
    /// ことがあるため（設計§9-4）。ローカルモードでは即座に返る。
    async fn spawn(&self, request: SpawnRequest<'_>) -> Result<(), String>;
    fn kill(&self, card_id: CardId) -> Result<(), String>;
    fn archive(&self, card_id: CardId) -> Result<(), String>;

    // --- ターミナル -----------------------------------------------------------

    /// いまの画面（スクロールバック）と、その続きを受け取る口を**同時に**取る。
    ///
    /// 2つに分けて取ると、間に流れたバイトを取りこぼすか二重に書くことになり、
    /// どちらも端末の表示を壊す。
    ///
    /// # 誰が・どの大きさで見るのかまで渡す
    ///
    /// リモートでは、見ている人が居るあいだだけセッションホストが画面を作る（設計§7-4）。
    /// 「誰が」が要るのは**開き直しで二重に数えないため**、「どの大きさ」が要るのは
    /// セッションホスト側の端末をその桁に揃えるため。ローカルではどちらも使わない
    /// （生バイトをそのまま配るので、見ている人数と関係が無い）。
    fn subscribe_pty(
        &self,
        card_id: CardId,
        client_id: u64,
        cols: u16,
        rows: u16,
    ) -> Option<(Bytes, broadcast::Receiver<Bytes>)>;

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

    // --- ファイルシステム -----------------------------------------------------

    /// フォルダ1つの中身（イシューグループ_2026_0805_0514 設計§5・§8）。
    ///
    /// **ローカルモードもここを通る。** サーバ側で「同じプロセスなら自分で読む」と
    /// 近道を作らない——片側だけ速くすると「ローカルでは動くのにセルフホストで欠ける」
    /// という、経路の違いが原因でテストを増やしても見つからない壊れ方が残る（§19）。
    async fn list_dir(&self, request: HostFsRequest<'_>) -> Result<DirListing, HostFsError>;

    /// ファイル1つの中身（設計§5・§9）。**読むだけ**で、書く口は持たない。
    async fn read_file(&self, request: HostFsRequest<'_>) -> Result<FileContent, HostFsError>;
}

/// ファイルの口が応えられなかった理由（設計§10 の状態コードの表）。
///
/// # なぜここだけ `String` ではないのか
///
/// 他のメソッドは `Result<_, String>` で、「運ぶのは人が読む説明だけ」と決めてある。
/// この2つだけ型を持つのは、**設計§10 が状態コードの写しを求めている**ため——
/// `403` と `413` と `404` は、文字列からは作れない。
///
/// **ローカルとリモートで食い違わせない**のが要点（フェーズ1 の引き継ぎ）。
/// ローカルモードは [`HostFsError::Failed`] しか作らず、残りは線の向こうへ
/// 届かなかったことを表す——どちらの構成でも同じ入口で同じ写し方をする。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostFsError {
    /// その PC が居ない。**他人のもの・知らない・繋がっていない を言い分けない**（§18）——
    /// 分けると、IDを総当たりして他人の PC の存在を調べられる
    UnknownHost,
    /// その PC が古くて、フォルダを覗く能力を名乗っていない（§4）。
    ///
    /// 投げても永遠に答えないので、**投げる前に断る**。時間切れと混ぜると、
    /// 利用者は回線を疑うことになる
    Unsupported,
    /// 時間内に答えが返らなかった（§7）
    Timeout,
    /// 連絡係が切れていて、別のインスタンスに繋がっている PC へ届けられない（§17）
    Unreachable(String),
    /// PC は答えたが、読めなかった（§8・§9）。**理由をそのまま写す**
    Failed {
        reason: protocol::a2s::HostFailure,
        detail: String,
    },
}

impl HostFsError {
    /// 画面へ出す説明。**どの構成でも同じ文になる。**
    pub fn message(&self) -> String {
        match self {
            // 「知らない」と「他人のもの」に同じ言葉を返す（§18）
            Self::UnknownHost => "指定された PC が繋がっていません".to_string(),
            Self::Unsupported => {
                "この PC は版が古いのでフォルダを覗けません（セッションホストを更新してください）"
                    .to_string()
            }
            Self::Timeout => "PC が応じません".to_string(),
            Self::Unreachable(detail) => detail.clone(),
            Self::Failed { detail, .. } => detail.clone(),
        }
    }
}

/// ファイルシステムへの頼み（イシューグループ_2026_0805_0514 設計§5）。
///
/// 引数を並べずに1つの型へまとめてあるのは [`SpawnRequest`] と同じ理由——
/// **宛先とアカウントを取り違えても型で気づけない**ため。
pub struct HostFsRequest<'a> {
    /// 頼んだ人のアカウント。**他人の PC を宛先にできない**ことをここで確かめる（§18）
    pub account_id: uuid::Uuid,
    /// どの PC に聞くか。`None` は「選ばれていない」——ローカルモードは常に `None`
    pub target: Option<AgentId>,
    /// 絶対パス。**`None` はその PC のホーム**（設計§26-2）。
    ///
    /// `None` を渡してよいのは [`SessionHost::list_dir`] だけである。中身の読み取りに
    /// 「始まり」は無く、REST の口も `path` を必須にしているので、
    /// [`SessionHost::read_file`] がここで `None` を受け取ることはない。
    pub path: Option<&'a str>,
}
