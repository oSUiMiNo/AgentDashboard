//! セッションホスト ⇄ ダッシュボードサーバのメッセージ（セルフホスト化設計§4）。
//!
//! ブラウザ向けの [`crate::ws`] とは**別のプロトコル**にしてある。同じ列挙を使い回すと
//! 方向の意味論が濁り（`Spawn` は誰から誰へ？）、セッションホスト固有の知らせ（Hello・ack・
//! 画面の購読制御）がブラウザ向けの型に混ざる。**ブラウザ向けの型は不変**というのが
//! セルフホスト化の前提なので、線を分ける。
//!
//! # 運ぶのは構造化されたものだけ
//!
//! JSONL の生の行も、フックの生ペイロードも、ここには載らない（§5-3）。載るのは
//! パーサが解釈し終えた [`TreeNode`] と、状態機械が導出し終えた [`SessionStatus`] だけ。
//! 検収条件「生 JSONL が流れない」は、この型に載せる口が無いことで機構的に満たす。
//!
//! # 版はハンドシェイクで交渉する
//!
//! セッションホストは利用者の PC にあり、サーバより更新が遅れがちになる。噛み合わない版で
//! 動き出してから気づくより、**接続の最初に断る**ほうがよい。WebSocket のサブプロトコル
//! （[`A2S_PROTOCOL`]）で交渉するので、upgrade の段階で拒否できる。

use crate::{
    AgentId, CardId, ModelId, PermissionMode, SessionMeta, SessionStatus, Timestamp, TreeNode,
};
use serde::{Deserialize, Serialize};

/// WebSocket のサブプロトコル名。**版番号を名前に含める**（§4-1）。
///
/// サーバが知らない版はハンドシェイクで拒否できる。ヘッダに載る文字列なので、
/// 増やすときは新しい定数を足して両方を受け付ける期間を作る。
pub const A2S_PROTOCOL: &str = "adash-a2s-v1";

/// [`A2S_PROTOCOL`] に対応するプロトコル版。Hello で突き合わせる。
pub const A2S_VERSION: u32 = 1;

/// 履歴のバッチにつける通し番号（§6-1）。
///
/// セッションホストのプロセス内で単調に増える。**サーバは順序を仮定しない**——ack は
/// 「この番号は書けた」だけを意味し、抜けや追い越しの管理はセッションホスト側の責任。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BatchId(pub u64);

impl std::fmt::Display for BatchId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// 問いと答えを対応づける番号（イシューグループ_2026_0805_0514 設計§4）。
///
/// この線に**初めて「答えが要る問い」を通す**ために足した。それまで往復は
/// [`BatchId`] の ack しか無く、指示に返事は無かった。
///
/// 対応づけが要るのは、**答えを待っているのがサーバ側の別々の要求**だからである。
/// 番号が無いと、2人が同時にフォルダを聞いたときにどちらの答えか分からない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RequestId(pub uuid::Uuid);

impl RequestId {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }
}

impl std::fmt::Display for RequestId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// 問いへの答え（設計§4）。
///
/// **1種類にまとめてある。** 一覧と中身で別々の答えを作ると、対応づけの仕組みを
/// 2つ持つことになる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum HostReply {
    Dir(crate::fs::DirListing),
    File(crate::fs::FileContent),
    /// 引いてきたログ（ログ設計§13-1）。
    ///
    /// **別の答えの型を作らずここへ足した。** 分けると待ち口（`pending`）・答えの
    /// 解決・連絡係の封筒の**5箇所が二重になる**。1つにまとめてある理由は上の
    /// とおりで、ログもその理由に当てはまる。
    Log(crate::logs::LogChunk),
    /// バイト列で読んだファイル（`ファイル閲覧で画像とHTMLも表示する` 設計§3-3）。
    ///
    /// **`Log` と `Resources` と同じ理由でここへ足した。** 別の答えの型を作ると、
    /// 待ち口・答えの解決・連絡係の封筒の5箇所が二重になる。
    ///
    /// 中身は base64 の文字列として線に載る（[`crate::fs::FileBlob`]）。
    Blob(crate::fs::FileBlob),
    /// 置いた添付の場所（`メッセージに画像を添付できるようにする` 設計§4）。
    ///
    /// **[`Self::Blob`] と別の腕にしてある。** あちらは「読んだ中身」で、こちらは
    /// 「書いた場所」——同じ型に載せると、`data` が空なのは中身が空だからなのか
    /// 書いた側だからなのかが読めなくなる（[`crate::fs::FileContent`] と
    /// [`crate::fs::FileBlob`] を分けたのと同じ理由）。
    Written(crate::fs::WrittenBlob),
    /// **履歴が実在する CLI セッション**（名前付け設計§8-3）。
    ///
    /// `Log` や `Resources` と同じ理由でここへ足した。別の答えの型を作ると、待ち口・
    /// 答えの解決・連絡係の封筒の5箇所が二重になる。
    ///
    /// **返るのは「実在したものだけ」**で、渡した全部ではない。差が「消えたもの」に
    /// あたるが、**答えが返らなかったとき（PC が居ない・版が古い・時間切れ）とは
    /// 区別する**——あちらは「確かめていない」であって「無い」ではない（§8-5）。
    ///
    /// **欄に名前を付けてある。** 内部タグ付き（`#[serde(tag = "t")]`）の列挙では、
    /// 列を直に包む腕を serde が**シリアライズできない**（`cannot serialize tagged
    /// newtype variant ... containing a sequence`）。他の腕が構造体を包んでいるのは
    /// 地図になるからで、**列だけは名前を付けて包む必要がある**。
    Sessions {
        ids: Vec<crate::ClaudeSessionId>,
    },
    /// この PC の資源（起こし直し設計§18）。
    ///
    /// **`Log` と同じ理由でここへ足した。** 別の答えの型を作ると、待ち口・答えの解決・
    /// 連絡係の封筒の5箇所が二重になる。
    Resources(crate::HostResources),
    /// 応えられなかった。**理由を分ける**のは、どれも利用者が直せるものだから（設計§8）
    Failed {
        reason: HostFailure,
        /// 人が読む説明。画面へそのまま出る
        detail: String,
    },
}

/// 応えられない理由（設計§8・§9）。
///
/// まとめて「駄目でした」にすると、**権限が無いのか消えているのか**が利用者から
/// 区別できず、直しようが無くなる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostFailure {
    /// そこに無い
    NotFound,
    /// 権限が無い
    Denied,
    /// フォルダを頼まれたがファイルだった
    NotDirectory,
    /// 上限を超えている（大きさは `detail` に添える）
    TooLarge,
    /// テキストとして読めない（バイナリ・UTF-8 でない）
    Unsupported,
    /// **この機械ではできない**（OS が違う・口が無い）。**異常ではない**
    ///
    /// `Unsupported` と分けてあるのは、**状態コードが別だから**である
    /// （コードレビュー対応8）。あちらは「渡されたものがテキストではない」で 415 が
    /// 正しいが、こちらは相手の機械にその口が無いので、415 だと**メディア型の話に
    /// 見えて理由が伝わらない**（Linux 以外へメモリの空きを聞いた場合が実例）。
    ///
    /// **足しても `A2S_VERSION` は上げない。** これは PC → サーバ方向の理由で、
    /// 古い PC は送らない。新しい PC が古いサーバへ送る組み合わせは、能力の名乗りが
    /// 閉じている（知らないサーバはそもそも聞かない）。
    Unavailable,
}

/// 画面と履歴の更新間隔（§13-3）。DB settings の値をセッションホストへ運ぶ。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Intervals {
    /// 履歴のバッチを送る周期（秒）
    pub sync_secs: u64,
    /// 画面の差分を送る周期（ミリ秒。フェーズ4）
    pub screen_ms: u64,
    /// 画面のスクロールバック行数（フェーズ4）
    pub scrollback_lines: usize,
}

/// セッションホスト → サーバ。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum AgentMessage {
    /// 接続の1通目（§4-2）。復帰時もここから始める。
    ///
    /// # PC の能力もここで名乗る
    ///
    /// `available_modes` と `always_bypass_permissions` は、`GET /api/settings` が
    /// 返す内容のうち **PC 側にしか無いもの**（起動している CLI が受け付ける権限モードと、
    /// セッションホストの toml のトグル）。サーバモードにはローカルの CLI が居ないので、
    /// ここで受け取らないと起動ボタンと権限モードの選択肢が空になる。
    /// モデルの表は量が違う（数KB）ので [`AgentMessage::ModelTable`] に分けてある。
    Hello {
        protocol_version: u32,
        agent_version: String,
        agent_name: String,
        available_modes: Vec<PermissionMode>,
        always_bypass_permissions: bool,
        /// この PC のフォルダを覗けるか（イシューグループ_2026_0805_0514 設計§4）。
        ///
        /// # なぜ `#[serde(default)]` が要るのか
        ///
        /// **これを外すと、古いセッションホストが繋がらなくなる。** 名乗りに欄が
        /// 足りず、必須欄の欠落で Hello そのものが解けなくなるためである。
        ///
        /// # なぜ名乗らせるのか
        ///
        /// 接続を守るためではない（§23-1 で前提が覆った）。古いホストは知らない種別を
        /// 受け取っても**接続を保ち、警告を出して無視する**——`link.rs` が意図的に
        /// そう作ってある。ただし**永遠に答えない**。
        ///
        /// 名乗りが無いと、画面には時間切れの「PC が応じません」しか出せず、
        /// **本当の理由（版が古い）を伝えられない**。判定を通すのはそのため。
        #[serde(default)]
        supports_host_fs: bool,
        /// この PC のログを引けるか（ログ設計§13-1）。
        ///
        /// `supports_host_fs` とまったく同じ形で足してある。**能力ごとに1欄**にするのは、
        /// 版を1つ上げるだけで済ませようとすると `A2S_VERSION` を上げることになり、
        /// **既に配ったセッションホストが全部繋がらなくなる**ため（§13-2）。
        ///
        /// `#[serde(default)]` が要る理由も同じ——名乗りに欄が足りないと Hello そのものが
        /// 解けなくなる。名乗らない＝引けない、として扱う。
        #[serde(default)]
        supports_log_read: bool,
        /// この PC の資源（空きメモリ）を答えられるか（起こし直し設計§18-4）。
        ///
        /// 上と同じ形。名乗らない古いホストには**聞かずに済ませる**——聞くと永遠に
        /// 答えが返らず、画面は時間切れを待つことになる。答えが無ければ
        /// **歯止め無しで進む**（分からないことを理由に止めない）。
        #[serde(default)]
        supports_resources: bool,
        /// 抜け殻のカードを起こし直せるか（接続断のカードを復旧ボタンで戻す 設計§5-2）。
        ///
        /// 上の2つとまったく同じ形。**能力ごとに1欄**にするのは、版を1つ上げて済ませようと
        /// すると [`A2S_VERSION`] を上げることになり、**既に配ったセッションホストが
        /// 全部繋がらなくなる**ため。
        ///
        /// 名乗らせる理由も同じで、[`ServerToAgent::ReviveSession`] は**答えを返さない
        /// 種別**（`request_id` を持たない）である。古いホストへ投げると無視されるだけで
        /// 永遠に何も起きないので、名乗りが無いと画面には理由を出せない。
        #[serde(default)]
        supports_revive: bool,
        /// ファイルを**バイト列で**読めるか（`ファイル閲覧で画像とHTMLも表示する` 設計§3-4）。
        ///
        /// 上の4つとまったく同じ形。**`supports_host_fs` に相乗りさせない**——古い PC でも
        /// フォルダとテキストは読めるので、まとめると「フォルダも読めません」と嘘をつく。
        ///
        /// `#[serde(default)]` が要る理由も同じで、欄が足りないと Hello そのものが解けなくなる。
        #[serde(default)]
        supports_blob_read: bool,
        /// 添付を**バイト列で書ける**か（`メッセージに画像を添付できるようにする` 設計§4-1）。
        ///
        /// 上の5つとまったく同じ形。**`supports_blob_read` に相乗りさせない**——読む道は
        /// 既に配ったホストが持っているが、書く道は持っていない。まとめると
        /// 「画像も見られません」と嘘をつく。
        ///
        /// [`ServerToAgent::WriteBlob`] は答えを返す種別だが、**名乗らない PC は接続を
        /// 保ったまま無視する**ので、投げると永遠に答えが返らない。だから投げる前に見る。
        #[serde(default)]
        supports_blob_write: bool,
        /// 過去の CLI セッションを**指定して起こせる**か、そして**実在を確かめられる**か
        /// （名前付け設計§7-2）。
        ///
        /// 上の6つとまったく同じ形。**2つの口をまとめて1つの名乗りにしてある**——
        /// どちらも同じ工事で入るので、片方だけ持つ版は存在しない。
        ///
        /// [`ServerToAgent::RecallSession`] は**答えを返さない種別**なので、名乗りが
        /// 無いと投げても永遠に何も起きず、画面に理由を出せない。
        #[serde(default)]
        supports_recall: bool,
    },
    /// カード1枚の最新（意味は [`crate::ws::ServerMessage::SessionUpsert`] と同じ）。
    ///
    /// 復帰したときは、全セッションぶんをここで送り直して再同期する（§6-4）。
    SessionUpsert {
        session: Box<SessionMeta>,
    },
    SessionRemoved {
        card_id: CardId,
    },
    Status {
        card_id: CardId,
        status: SessionStatus,
        subagent_active: u32,
        last_activity_at: Timestamp,
    },
    /// 履歴のバッチ（§6-1）。**ack が返るまで再送責任はセッションホスト側**。
    ///
    /// どのファイルのどこまで読んだか（オフセット）は載せない。サーバに使い道が無く、
    /// 利用者の PC のパスをネットワークへ出す理由も無い。位置の管理はセッションホストが持つ。
    TranscriptBatch {
        batch_id: BatchId,
        card_id: CardId,
        nodes: Vec<TreeNode>,
    },
    /// 巻き戻り（`/rewind`）。**バッチ列の順序の中で送る**（§6-2）。
    ///
    /// これにも番号を付けるのは、ack を待つ列が1本だからである。番号が無いと
    /// 「巻き戻しは書けたのか」を確かめる手段が無く、後続のバッチだけが先に確定しうる。
    TranscriptReset {
        batch_id: BatchId,
        card_id: CardId,
    },
    ParserStatus {
        state: crate::ws::ParserState,
        detail: Option<String>,
    },
    Selfheal {
        phase: crate::ws::SelfhealPhase,
        detail: Option<String>,
    },
    /// 操作の失敗（モデル切替の連打拒否など。§5-6）。サーバは `ServerMessage::Error` へ移す。
    Error {
        card_id: Option<CardId>,
        message: String,
    },
    /// モデルの表（§13-4）。接続直後と、変化した時だけ送る。定期送信はしない。
    ///
    /// 中身をこのクレートの型にしないのは、**サーバが解釈しないため**。受け取った形の
    /// まま `agents.model_table` へ保存し、`GET /api/settings` で配り直すだけなので、
    /// 表の形が変わってもサーバとスキーマは無傷でいられる（`sessions.status` と同じ判断）。
    ModelTable {
        cli_version: String,
        catalog: serde_json::Value,
        aliases: serde_json::Value,
    },
    /// 問いへの答え（設計§4）。**この線で唯一、指示に返事を返すもの。**
    ///
    /// 答えられなかった場合も必ず返す（`HostReply::Failed`）。黙ると、サーバ側は
    /// 時間切れを待つしかなくなり、**フォルダが無いことと区別が付かない**。
    HostReply {
        request_id: RequestId,
        reply: HostReply,
    },
}

/// サーバ → セッションホスト。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerToAgent {
    /// 接続の1通目の応答。確定した設定値を初期値として含める（§4-2・§6-4）。
    Hello {
        protocol_version: u32,
        server_version: String,
        /// このセッションホストに割り当てられた ID。カードの帰属はサーバが決める（§5-1）
        agent_id: AgentId,
        intervals: Intervals,
    },
    /// 履歴が **DB へ入った**ことの応答（§6-1）。
    ///
    /// セッションホストはこれを見てから JSONL のオフセットを進める。返さないことが
    /// そのまま「まだ書けていない」を意味するので、DB 断のときは黙って返さない（§12）。
    BatchAck {
        batch_id: BatchId,
    },
    /// 新しいセッションを起こす。**CardId はセッションホストが採番する**（§5-2）ので、
    /// ここでは指定しない。結果は `SessionUpsert` で返る。
    Spawn {
        cwd: String,
        permission_mode: Option<PermissionMode>,
    },
    /// 抜け殻になったカードを、元の CLI セッションで起こし直す
    /// （接続断のカードを復旧ボタンで戻す 設計§5-1）。
    ///
    /// # `Spawn` に欄を足さなかった理由
    ///
    /// **古いセッションホストは知らない欄を読み飛ばす。** 欄を足す形にすると、
    /// あちらでは**ふつうの起動として成立してしまう**——復旧のつもりが、抜け殻の隣に
    /// 新しいカードが1枚増える。種別を分ければ、古いホストは**接続を保ったまま
    /// 警告を出して無視する**だけで済む（`link.rs` が意図してそう作ってある）。
    ///
    /// # CardId をサーバから渡す唯一の種別
    ///
    /// [`ServerToAgent::Spawn`] は PC が採番する（§5-2）。こちらは**既にあるカードへ
    /// 戻す**のが目的なので、採番させると意味を成さない。
    ///
    /// 作業ディレクトリ・権限モード・呼び戻し先は、どれもサーバ側の記録が持っている
    /// （`sessions` 表）。ブラウザからは運ばない——古い写しで起こし直す経路ができる。
    ReviveSession {
        card_id: CardId,
        cwd: String,
        permission_mode: Option<PermissionMode>,
        claude_session_id: crate::ClaudeSessionId,
    },
    /// **過去の CLI セッションを指定して、新しいカードで起こす**（名前付け設計§7-1）。
    ///
    /// # `Spawn` に欄を足さなかった理由
    ///
    /// [`ServerToAgent::ReviveSession`] とまったく同じ。古いセッションホストは知らない
    /// 欄を読み飛ばすので、`Spawn` に呼び戻し先を足すと**あちらではふつうの起動として
    /// 成立してしまう**——呼び戻したつもりが、まっさらな新しいセッションが立つ。
    /// しかも利用者から見れば「起こせた」ので、**間違いに気づくのは履歴を開いたとき**になる。
    ///
    /// # `ReviveSession` との違いは CardId を運ばないこと
    ///
    /// あちらは**既にあるカード**を起こし直すのでサーバが CardId を渡す。こちらは
    /// **新しいカードを作る**ので、採番はセッションホスト側（`Spawn` と同じ）。
    RecallSession {
        cwd: String,
        permission_mode: Option<PermissionMode>,
        claude_session_id: crate::ClaudeSessionId,
    },
    /// 渡したIDのうち、**履歴が実在するもの**を尋ねる（名前付け設計§8-3）。
    ///
    /// **答えを待つ種別**（`request_id` を持つ）。[`AgentMessage::HostReply`] の
    /// [`HostReply::Sessions`] で返る。
    ///
    /// **IDをまとめて渡す。** 1件ずつ聞くと、一覧を開くたびに件数ぶんの往復が出る。
    SessionsExist {
        request_id: RequestId,
        ids: Vec<crate::ClaudeSessionId>,
    },
    Kill {
        card_id: CardId,
    },
    Archive {
        card_id: CardId,
    },
    /// Composer からの指示。PTY へ届くまでの作法（初期実装§18）はセッションホスト側の責任（§5-5）
    SendInput {
        card_id: CardId,
        text: String,
        /// 添付の置き場所（画像添付 設計§6）。**セッションホストのディスク上の絶対パス。**
        ///
        /// 画像は先に [`ServerToAgent::WriteBlob`] で向こうへ置いてあるので、ここを
        /// 通るのはその返事に入っていたパスだけ。サーバは中身を持たない。
        ///
        /// `#[serde(default)]` を付けるのは **`A2S_VERSION` を上げないため**。上げると
        /// 既に配ったセッションホストが全部繋がらなくなる（`supports_blob_read` の doc と
        /// 同じ判断）。古いセッションホストはこの欄を無視するので、添付の付いた指示は
        /// パスが本文に混ざったまま届く。
        ///
        /// # 古い PC でも、画面には添付の口が出る
        ///
        /// 設計§4-1 は「名乗らない PC のカードには口を出さない」と書いているが、
        /// **そうは作っていない**——ブラウザは `supports_blob_write` を読んでいない。
        /// 置く側（`POST /api/hosts/{host}/attachments`）が `Need::BlobWrite` で名乗りを
        /// 見て **409 で断る**ので、押した人には「いまのこの相手ではできない」が届く。
        ///
        /// **`supports_blob_read`（ファイル閲覧）も同じ形**で、あちらも口を隠していない。
        /// 隠す側へ寄せるなら `SessionMeta` に能力の欄を足す配線が要る（利用者の判断待ち）。
        #[serde(default)]
        attachments: Vec<String>,
    },
    SetPermissionMode {
        card_id: CardId,
        mode: PermissionMode,
    },
    SetModel {
        card_id: CardId,
        model: ModelId,
    },
    Resize {
        card_id: CardId,
        cols: u16,
        rows: u16,
    },
    /// 画面の配信を始める（§7-4）。**中身の実装はフェーズ4**。
    SubScreen {
        card_id: CardId,
        cols: u16,
        rows: u16,
    },
    /// 画面の配信を止める。視聴者が居なくなったときだけ飛ぶ（§7-4）
    UnsubScreen {
        card_id: CardId,
    },
    /// 設定変更の即時反映（§13-3）。次の接続を待たせない
    SetIntervals {
        intervals: Intervals,
    },
    /// フォルダの中身を教えてほしい（イシューグループ_2026_0805_0514 設計§4・§8）。
    ///
    /// **答えは [`AgentMessage::HostReply`] で返る。** カードに紐づかない問いなので、
    /// `card_id` は持たない——PJT を追加する場面では、まだカードが1枚も無い。
    ListDir {
        request_id: RequestId,
        /// 絶対パス。**`None` は「始まりの場所」＝その PC のホーム**（設計§26-2）。
        ///
        /// ホームを知っているのは PC 側だけなので、サーバが `~` を解決して送ることは
        /// できない。設計§13 は名乗りに添えて受け取る形にしていたが、それだと
        /// **ローカルモードで受け取れない**（あちらは PC の一覧そのものを持たない）。
        /// 省略できる形にすると、どちらの構成でも同じ1本の口で始まりへ辿り着ける。
        path: Option<String>,
    },
    /// ファイルの中身を教えてほしい（設計§4・§9）。
    ///
    /// **読むだけ。** 書く口はこの工事では作らない（設計§9）。
    ReadFile {
        request_id: RequestId,
        path: String,
    },
    /// ファイルを**バイト列で**教えてほしい（`ファイル閲覧で画像とHTMLも表示する` 設計§3-3）。
    ///
    /// **[`Self::ReadFile`] と別の種別にしてある。** あちらは「テキストだけ」を契約に
    /// していて、答えの型（[`crate::fs::FileContent`]）もそれに合わせてある。
    ///
    /// 投げる前に**名乗り**（`supports_blob_read`）を見ること。名乗らない PC は
    /// 接続を保ったまま無視するので、投げると永遠に答えが返らない。
    ReadBlob {
        request_id: RequestId,
        path: String,
    },
    /// 添付を**置いてほしい**（`メッセージに画像を添付できるようにする` 設計§4）。
    ///
    /// **置き場所を決めるのは PC 側**である。サーバは「このカードの、この媒体型の
    /// バイト列」だけを渡し、`<state_dir>` の下のどこへ置くかには口を出さない——
    /// `state_dir` の解決は PC 側の設定に属するので、サーバが組み立てると
    /// **繋いだ PC ごとに違う場所を指す**ことになる。
    ///
    /// 投げる前に**名乗り**（`supports_blob_write`）を見ること。名乗らない PC は
    /// 接続を保ったまま無視するので、投げると永遠に答えが返らない。
    WriteBlob {
        request_id: RequestId,
        card_id: CardId,
        /// `image/png` など。**PC 側がここから拡張子を決める**
        media_type: String,
        /// 中身。**線に載るときだけ base64 の文字列になる**（[`crate::fs::WrittenBlob`] と同じ）
        #[serde(with = "crate::fs::base64_bytes")]
        data: Vec<u8>,
    },
    /// この PC のログを引かせてほしい（ログ設計§13-1）。
    ///
    /// **答えは [`AgentMessage::HostReply`] で返る**——フォルダ・ファイルと同じ1本の
    /// 問答の道に相乗りする。カードに紐づかないので `card_id` は持たない。
    ///
    /// 絞り込みを [`crate::logs::LogQuery`] として**まるごと相手へ渡す**のは、線の予算
    /// （512 KiB）に対してファイルの上限が 512 MiB あるためで、こちらで絞る形にすると
    /// そもそも運びきれない（ログ設計§25-2）。
    ReadLog {
        request_id: RequestId,
        query: crate::logs::LogQuery,
    },
    /// この PC の資源を聞く（起こし直し設計§18-4）。
    ///
    /// **押した瞬間にだけ聞く。** 常時報告にしないのは、メモリは秒単位で動くので
    /// 定期的に運んでも**古い値を配るだけ**になり、経路と嵩だけが増えるため。
    /// 「入るか」を判断したいのは押した瞬間の1回きりである。
    HostResources {
        request_id: RequestId,
    },
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use crate::{Node, NodeId, ProjectId, ws::ParserState, ws::SelfhealPhase};

    fn roundtrip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let text = serde_json::to_string(value).expect("シリアライズできること");
        serde_json::from_str(&text).expect("デシリアライズできること")
    }

    fn sample_meta() -> SessionMeta {
        SessionMeta {
            card_id: CardId::new(),
            project: ProjectId("/home/example/dev/app".to_string()),
            claude_session_id: None,
            permission_mode: Some(PermissionMode::new("acceptEdits")),
            model: Some(ModelId::new("claude-opus-5")),
            model_label: Some("Opus 5".to_string()),
            model_requested: None,
            status: SessionStatus::Working,
            subagent_active: 0,
            last_activity_at: 1_700_000_000_000,
            last_assistant_message: None,
            created_at: 1_699_999_000_000,
            hooks_seen: true,
            agent_id: None,
            agent_connected: true,
            account: None,
            toml_account: None,
            session_title: None,
            position: 0,
            nickname: None,
        }
    }

    fn sample_listing() -> crate::fs::DirListing {
        crate::fs::DirListing {
            path: "/home/example/dev/app".to_string(),
            entries: vec![
                crate::fs::DirEntry {
                    name: ".claude".to_string(),
                    kind: crate::fs::EntryKind::Dir,
                    is_project: false,
                },
                crate::fs::DirEntry {
                    name: "計画.md".to_string(),
                    kind: crate::fs::EntryKind::File,
                    is_project: false,
                },
            ],
            truncated: false,
        }
    }

    fn sample_query() -> crate::logs::LogQuery {
        crate::logs::LogQuery {
            // **絶対時刻で送る。** 相対の綴りを相手に解かせると時計のずれが見えなくなる
            since: "2026-08-08T00:00:00.000Z".to_string(),
            level: "INFO".to_string(),
            card: None,
            proc: Some("session-host".to_string()),
            grep: Some("パーサ".to_string()),
            grep_on_raw: false,
            sanitize: false,
        }
    }

    fn sample_chunk() -> crate::logs::LogChunk {
        crate::logs::LogChunk {
            // PC は空で返す。埋めるのはサーバ
            host: String::new(),
            host_now: "2026-08-08T01:23:45.678Z".to_string(),
            lines: vec![
                r#"{"ts":"2026-08-08T01:00:00.000Z","level":"WARN","target":"session_host_core::parser","proc":"session-host","pid":29381,"run_id":"9f2c","msg":"パーサへ履歴の監視を頼みました"}"#
                    .to_string(),
            ],
            truncated: false,
            broken: 0,
            leaks: 0,
        }
    }

    #[test]
    fn agent_messageは全種が往復する() {
        let card_id = CardId::new();
        let all = vec![
            AgentMessage::Hello {
                protocol_version: A2S_VERSION,
                agent_version: "0.1.0".to_string(),
                agent_name: "仕事用ノート".to_string(),
                available_modes: vec![
                    PermissionMode::new("default"),
                    PermissionMode::new("acceptEdits"),
                ],
                always_bypass_permissions: false,
                supports_host_fs: true,
                supports_log_read: true,
                supports_resources: true,
                supports_revive: true,
                supports_blob_read: true,
                supports_blob_write: true,
                supports_recall: true,
            },
            AgentMessage::SessionUpsert {
                session: Box::new(sample_meta()),
            },
            AgentMessage::SessionRemoved { card_id },
            AgentMessage::Status {
                card_id,
                status: SessionStatus::Ended { ok: true },
                subagent_active: 0,
                last_activity_at: 1_700_000_000_000,
            },
            AgentMessage::TranscriptBatch {
                batch_id: BatchId(7),
                card_id,
                nodes: vec![TreeNode {
                    id: NodeId("node-1".to_string()),
                    parent: None,
                    node: Node::AssistantText {
                        text: "了解しました".to_string(),
                    },
                    ts: 1_700_000_000_000,
                    branch: 0,
                }],
            },
            AgentMessage::TranscriptReset {
                batch_id: BatchId(8),
                card_id,
            },
            AgentMessage::ParserStatus {
                state: ParserState::Degraded,
                detail: Some("パーサが応答しません".to_string()),
            },
            AgentMessage::Selfheal {
                phase: SelfhealPhase::Swapped,
                detail: None,
            },
            AgentMessage::Error {
                card_id: Some(card_id),
                message: "切替中です".to_string(),
            },
            AgentMessage::ModelTable {
                cli_version: "2.1.220".to_string(),
                catalog: serde_json::json!([{ "id": "claude-opus-5", "label": "Opus 5" }]),
                aliases: serde_json::json!([{ "alias": "opus", "resolved": "claude-opus-5" }]),
            },
            AgentMessage::HostReply {
                request_id: RequestId::new(),
                reply: HostReply::Dir(sample_listing()),
            },
        ];
        for message in &all {
            assert_eq!(&roundtrip(message), message);
        }
    }

    #[test]
    fn server_to_agentは全種が往復する() {
        let card_id = CardId::new();
        let intervals = Intervals {
            sync_secs: 20,
            screen_ms: 20_000,
            scrollback_lines: 1000,
        };
        let all = vec![
            ServerToAgent::Hello {
                protocol_version: A2S_VERSION,
                server_version: "0.1.0".to_string(),
                agent_id: AgentId::new(),
                intervals,
            },
            ServerToAgent::BatchAck {
                batch_id: BatchId(7),
            },
            ServerToAgent::Spawn {
                cwd: "/home/example/dev/app".to_string(),
                permission_mode: None,
            },
            // 復旧（設計§5-1）。**モードを持った形で置く**——記録どおりのモードで
            // 起こすのがこの機能の約束なので、省いた形だけを固定すると、
            // 組で運べることを誰も見ていない状態になる
            ServerToAgent::ReviveSession {
                card_id,
                cwd: "/home/example/dev/app".to_string(),
                permission_mode: Some(PermissionMode::new("bypassPermissions")),
                claude_session_id: crate::ClaudeSessionId::new(),
            },
            ServerToAgent::Kill { card_id },
            ServerToAgent::Archive { card_id },
            ServerToAgent::SendInput {
                card_id,
                text: "/rewind".to_string(),
                attachments: Vec::new(),
            },
            ServerToAgent::SendInput {
                card_id,
                text: "これを見て".to_string(),
                attachments: vec!["/state/attachments/x/20260902-010203-a1b2c3d4.png".to_string()],
            },
            ServerToAgent::SetPermissionMode {
                card_id,
                mode: PermissionMode::new("acceptEdits"),
            },
            ServerToAgent::SetModel {
                card_id,
                model: ModelId::new("opus"),
            },
            ServerToAgent::Resize {
                card_id,
                cols: 120,
                rows: 40,
            },
            ServerToAgent::SubScreen {
                card_id,
                cols: 120,
                rows: 40,
            },
            ServerToAgent::UnsubScreen { card_id },
            ServerToAgent::SetIntervals { intervals },
            ServerToAgent::ListDir {
                request_id: RequestId::new(),
                path: Some("/home/example/dev/app".to_string()),
            },
            // 省略＝ホームから始める（§26-2）。**省いた形も往復すること**を固定する
            ServerToAgent::ListDir {
                request_id: RequestId::new(),
                path: None,
            },
            ServerToAgent::ReadFile {
                request_id: RequestId::new(),
                path: "/home/example/dev/app/計画.md".to_string(),
            },
            ServerToAgent::ReadBlob {
                request_id: RequestId::new(),
                path: "/home/example/dev/app/撮った.png".to_string(),
            },
            ServerToAgent::ReadLog {
                request_id: RequestId::new(),
                query: sample_query(),
            },
            // 資源を聞く（起こし直し設計§18-4）。**足したら必ずここへ足す**——
            // この検査の名前は「全種が往復する」なので、抜けると意図と食い違う
            ServerToAgent::HostResources {
                request_id: RequestId::new(),
            },
        ];
        for message in &all {
            assert_eq!(&roundtrip(message), message);
        }
    }

    #[test]
    fn 種別名はスネークケースのtフィールドで表現される() {
        // ブラウザ向け（`ws.rs`）と同じ作りにしてある。**同じ名前の別物**が両方に
        // 存在するので、線の上の形をここで固定しておかないと取り違えに気づけない
        let card_id = CardId::new();
        let text = serde_json::to_string(&AgentMessage::TranscriptReset {
            batch_id: BatchId(3),
            card_id,
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"transcript_reset","batch_id":3,"card_id":"{card_id}"}}"#)
        );

        let text = serde_json::to_string(&ServerToAgent::BatchAck {
            batch_id: BatchId(3),
        })
        .unwrap();
        assert_eq!(text, r#"{"t":"batch_ack","batch_id":3}"#);
    }

    #[test]
    fn 知らない種別は受け取りを拒否する() {
        // 版交渉を通ったのに解釈できないものが来たなら、それは実装の食い違い。
        // 黙って無視すると「繋がっているのに何も起きない」になる
        assert!(serde_json::from_str::<AgentMessage>(r#"{"t":"未来の種別"}"#).is_err());
        assert!(serde_json::from_str::<ServerToAgent>(r#"{"t":"未来の種別"}"#).is_err());
    }

    #[test]
    fn モデルの表は解釈せずそのまま運ぶ() {
        // サーバが表の形を知らないままで済むことが、この設計の狙い（§13-4）。
        // 知らないキーが増えても落ちないことを固定する
        let message = AgentMessage::ModelTable {
            cli_version: "9.9.9".to_string(),
            catalog: serde_json::json!([{ "まだ無いキー": { "深い": [1, null] } }]),
            aliases: serde_json::json!({}),
        };
        assert_eq!(roundtrip(&message), message);
    }

    #[test]
    fn 答えの7種と理由の6値がすべて往復する() {
        // 断る側を1つでも落とすと、その理由だけが画面へ出せなくなる。
        // 「まとめて駄目でした」に潰れるのを防ぐため、**6値を数え上げて**固定する
        let reasons = [
            HostFailure::NotFound,
            HostFailure::Denied,
            HostFailure::NotDirectory,
            HostFailure::TooLarge,
            HostFailure::Unsupported,
            HostFailure::Unavailable,
        ];
        let mut all = vec![
            HostReply::Dir(sample_listing()),
            HostReply::File(crate::fs::FileContent {
                path: "/home/example/dev/app/計画.md".to_string(),
                text: "# 計画\n- [x] 済み\n".to_string(),
                truncated: false,
                bytes: 24,
            }),
            HostReply::Log(sample_chunk()),
            // バイト列（`ファイル閲覧で画像とHTMLも表示する` 設計§3-3）。**足したら必ずここへ足す**
            HostReply::Blob(crate::fs::FileBlob {
                path: "/home/example/dev/app/撮った.png".to_string(),
                media_type: "image/png".to_string(),
                bytes: 3,
                data: vec![0x00, 0x7f, 0xff],
            }),
            // 資源（起こし直し設計§18-4）。**足したら必ずここへ足す**——
            // 台帳が数えていない種別は、綴りが変わっても誰も気づかない
            HostReply::Resources(crate::HostResources {
                total_mb: 15_700,
                available_mb: 8_192,
                swap_free_mb: 4_096,
                estimate_mb: 780,
                headroom_mb: 2_048,
                fits_now: Some(7),
            }),
            // 実在する CLI セッション（名前付け設計§8-3）。**足したら必ずここへ足す**
            HostReply::Sessions {
                ids: vec![crate::ClaudeSessionId::new()],
            },
        ];
        for reason in reasons {
            all.push(HostReply::Failed {
                reason,
                detail: "実際の理由がここに入る".to_string(),
            });
        }
        assert_eq!(all.len(), 6 + reasons.len());
        for reply in &all {
            assert_eq!(&roundtrip(reply), reply);
        }
    }

    #[test]
    fn request_idは薄い包みとして往復する() {
        // `BatchId` と同じ形にしてある。包みが厚いと、線の上の見た目が変わる
        let id = RequestId::new();
        assert_eq!(roundtrip(&id), id);
        assert_eq!(serde_json::to_string(&id).unwrap(), format!("\"{}\"", id.0));
    }

    #[test]
    fn 能力の欄を持たない古いhelloも解ける() {
        // **この工事でいちばん壊してはいけないところ。** `#[serde(default)]` を外すと、
        // 古いセッションホストの名乗りが必須欄の欠落で解けなくなり、繋がらなくなる。
        // 実物の 0.1.5 が送ってくる5欄そのままを食わせる
        let old = r#"{
            "t": "hello",
            "protocol_version": 1,
            "agent_version": "0.1.5",
            "agent_name": "OMEN",
            "available_modes": ["default"],
            "always_bypass_permissions": false
        }"#;
        let parsed: AgentMessage = serde_json::from_str(old).expect("古い名乗りが解けること");
        let AgentMessage::Hello {
            supports_host_fs,
            supports_log_read,
            supports_resources,
            supports_revive,
            supports_recall,
            agent_version,
            ..
        } = parsed
        else {
            panic!("Hello として解けること");
        };
        // 名乗らない＝覗けない。**黙って「できる」にしない**
        assert!(!supports_host_fs);
        // ログの能力も同じ扱い。**欄を足したこの工事でいちばん壊してはいけないところ**
        assert!(!supports_log_read);
        // 復旧の能力も同じ。名乗らない古いホストへ投げると、無視されて永遠に何も
        // 起きない——画面には理由が出せなくなる（設計§5-2）
        assert!(!supports_revive);
        // 資源の能力も同じ。名乗らないホストへ聞くと永遠に答えが返らない（設計§18-4）
        assert!(!supports_resources);
        // 呼び戻しの能力も同じ（名前付け設計§7-3）。名乗らないホストへ投げると、
        // 過去のセッションを起こしたつもりで**何も起きない**
        assert!(!supports_recall);
        assert_eq!(agent_version, "0.1.5");
    }

    #[test]
    fn 能力を足しても版は上がらない() {
        // **ここが上がると、既に配ったセッションホストが全部繋がらなくなる**（§13-2）。
        // 版の突き合わせは完全一致なので、サーバだけ新しくすると誰も入れない。
        //
        // 能力は Hello の `#[serde(default)]` な欄で足す、というのがこの PJT の作法で、
        // それが守られているかどうかは**この数字が動いていないこと**でしか見られない
        assert_eq!(A2S_VERSION, 1);
        assert_eq!(A2S_PROTOCOL, "adash-a2s-v1");
    }
}
