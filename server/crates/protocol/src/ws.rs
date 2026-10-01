//! ブラウザ ⇄ core サーバの WebSocket メッセージ（設計§4）。
//!
//! 1本の WebSocket に2種類の通信を多重化している。
//!
//! - **テキストフレーム**（このモジュール）… 操作と状態。JSON で `{"t": "<種別>", ...}`
//! - **バイナリフレーム**（[`crate::frame`]）… PTY のバイト列
//!
//! 分けているのは性能のため。PTY バイトを JSON に入れると base64 化で膨らみ、
//! 高頻度の出力でエンコード・デコードのCPUを食う（設計の性能要件の前提）。
//!
//! ここではフェーズ1で扱わない種別も**型としては全て定義している**。プロトコルの全体像を
//! 1ファイルで見渡せるようにするためと、フロントエンドとの型のズレをテストで
//! 検出できるようにするため。ハンドラの実装は該当フェーズで足していく。

use crate::{
    AgentId, AnnotationTarget, CardId, ClaudeLoginFingerprint, ContextUsage, MemoId, ModelId,
    PermissionMode, RateLimits, SessionCost, SessionMeta, SessionStatus, Timestamp, TreeNode,
};
use serde::{Deserialize, Serialize};

/// ターミナルのフロー制御の指示（設計§10 のウォーターマーク方式）。
///
/// ブラウザ側で xterm.js の未書き込みバイトが増えすぎたら `Pause` を送る。サーバは
/// その間 PTY からの読み取りを止め、OS の PTY バッファに滞留させる。滞留しきると
/// CLI 側の書き込みがブロックされるので、**ブラウザの遅さが CLI まで伝わって減速する**。
/// バイトを捨てないのが要点。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowState {
    Pause,
    Resume,
}

/// 構造化ビューの健全性（設計§11 の縮退表示）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParserState {
    Ok,
    Degraded,
}

/// インスタンスの間の連絡係の健全性（セルフホスト化設計§12）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BusState {
    Ok,
    Degraded,
}

/// 断りが**何をしようとして出たか**（細かい修正 設計§7-2）。
///
/// **エラーの原因ではなく、呼び出し側の操作で割る。** 解消の判定が「次に同じ操作が
/// 通ったか」になるためで、原因で割ると**同じ原因の別操作**まで一緒に消える。
///
/// # なぜ `NotFound` だけ操作ではないのか
///
/// 持ち主とカードの存在を確かめる関門は**どの操作より前**にあり、そこで断ったときには
/// まだ操作が決まっていない。しかも設計§7-3 は「カードが見つからない」を**消えない**側に
/// 置いているので、操作の名前へ混ぜると寿命が引けなくなる。
///
/// # 増やすときは寿命も決める
///
/// 値を足したら `web/src/stores/sessions.ts` の寿命の表にも足すこと。**既定は5秒**なので、
/// 足しただけだと「消えてほしくないもの」が黙って5秒で消える。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// 権限モードの切替
    PermissionMode,
    /// モデルの切替
    Model,
    /// 起こし直し
    Revive,
    /// 名前を付ける
    Nickname,
    /// 止める
    Kill,
    /// 片付ける
    Archive,
    /// 端末の購読（**端末が開けない**）
    SubPty,
    /// 履歴の購読
    SubTranscript,
    /// 指示の送信
    SendInput,
    /// 枝分かれ（ブランチ設計§4-3）。
    ///
    /// **寿命は「消えない」側に置く。** 途中で失敗すると**元の会話が席を失う**ので、
    /// 5秒で消すと利用者は会話が消えたと読む。断りには呼び戻しの道を添える。
    Branch,
    /// カードが見つからない（持ち主違いを含む。**呼び分けない**）
    NotFound,
    /// 上のどれでもないもの
    #[default]
    Other,
}

/// 起こし直しを**なぜ取り下げたか**（寝ているカードばかりなのに、メモリ不足でセッションを
/// 起こせない 実装レビュー第4回 Astra 1）。
///
/// 終わった断り（`busy: Some(false)`）には、メモリ不足・確かめられなかった・取り下げたが
/// 混ざっている。CLI の終了の待ちは**終了の頼みで取り下げた断り**でだけ満ちてよく、文面の
/// 部分一致では見分けない（文面は直すたびに変わる）。
///
/// **知らない綴りは [`Withdrawal::Unknown`] で受ける**（[`crate::HostFreeState`] と同じ理由）。
/// 新しい PC が理由を足しても、古いサーバが `Error` ごと読めなくなることはない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Withdrawal {
    /// 終了を頼まれた
    Kill,
    /// 記録の側から一覧から外し始めた（外し終えたかはまだ分からない）
    Removing,
    /// 一覧から外した
    Remove,
    /// 知らない綴り。**どの理由でもない側として読む**（終了の待ちを満たさない）
    #[serde(other)]
    Unknown,
}

/// 頼みの番号（寝ているカードばかりなのに、メモリ不足でセッションを起こせない 実装レビュー
/// 第6回）。**頼む側が振り、答え（断り・取り下げ・完了）が運ぶ。**
///
/// 待つ側は、自分の番号が付いた答えでだけ満ちる。受け取った枚数・接続直後の写しの状態・
/// 記録層の通し番号から「どの頼みへの答えか」を推し量ると、写しの重複や遅れて届いた古い断りを
/// 自分の答えと取り違える（第5回までに3回直して、3回とも別の順で破れた）。
///
/// **運ぶ欄はどれも欠けても読める。** 古い相手は番号を運ばず、番号の無い答えでは誰も満ちない
/// ——待つ側は時間切れで終わり、止まっていないものを「止まった」とは言わない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OpId(pub uuid::Uuid);

impl OpId {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }
}

impl std::fmt::Display for OpId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// 自己修復の進み具合（設計§9）。
///
/// 文字列ではなく型にしてあるのは、送り手と受け手が別々の言語で手書きされているため。
/// 綴り違いはコンパイルを通ってしまい、「進行が画面に出ない」という追いにくい形でしか
/// 表に出ない。段階の増減は [`ServerMessage::Selfheal`] と同じく**5箇所**同期の対象——
/// この型・`session-host-core` の状態遷移・`web/src/lib/protocol.ts`・`core/tests/selfheal.rs`
/// に加えて、**[`SelfhealPhase::as_str`] と [`SelfhealPhase::label`]**（記録と CLI が
/// 読む綴りと日本語。トーストとベル設計§7-1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelfhealPhase {
    /// パースの異常、または知らない版を見つけた
    Detected,
    /// カナリアで新しい版のサンプルを採っている
    Canary,
    /// 採ったサンプルでゴールデンテストを実行している
    Testing,
    /// 修復セッションが作業している
    Repairing,
    /// 修復の結果を core 側で検証している（セッションホストの自己申告は使わない）
    Verifying,
    /// 直す必要が無かった。対応表に登録して終わり
    Passed,
    /// 新しいパーサへ差し替えた
    Swapped,
    /// 差し替えたあとに悪化したので、前のパーサへ戻した
    RolledBack,
    /// 直せなかった。構造化ビューは縮退のまま
    Failed,
    /// 同じ版への再挑戦を抑えている
    Cooldown,
}

/// ブラウザ → サーバ。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMessage {
    /// セッションの履歴（構造化ビュー）を購読する。実装はフェーズ3
    SubTranscript {
        card_id: CardId,
    },
    UnsubTranscript {
        card_id: CardId,
    },
    /// ターミナルを購読する。購読直後にサーバから scrollback のスナップショットが届く
    SubPty {
        card_id: CardId,
        cols: u16,
        rows: u16,
    },
    UnsubPty {
        card_id: CardId,
    },
    /// 指定した作業ディレクトリで新しいセッションを起動する。
    ///
    /// `permission_mode` が `None` のときは **CLI に何も渡さない**。空文字や `manual` を
    /// 明示的に渡すのとは意味が違い、利用者の `permissions.defaultMode` を尊重するという
    /// 意思表示になる。
    Spawn {
        cwd: String,
        permission_mode: Option<PermissionMode>,
        /// どの PC で起こすか（セルフホスト化設計§5-1）。
        ///
        /// **ローカルモードと、繋がっているのが1台のときは `None`**。省略できるように
        /// してあるのは、PC という単位が存在しない使い方（ローカル）と、選ぶ余地の無い
        /// 使い方（1台）で、画面に選択肢を出さずに済ませるため。
        ///
        /// 複数台が繋がっているのに `None` で来たら**断る**。黙って1台目へ送ると、
        /// 意図しない PC で本物の claude が起動する。
        ///
        /// `default` と `skip_serializing_if` を**組で**付けている。ブラウザは選択肢の
        /// 無い場面でキーごと省くので、片方だけだと「同じ JSON になること」を見ている
        /// 両側のテスト（PJTガイドライン）が食い違う。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<crate::AgentId>,
    },
    /// 走っているセッションの権限モードを切り替える。
    ///
    /// 実体は PTY 上の TUI なので、サーバが Shift+Tab を送って**目的のモードへ着くまで
    /// 繰り返す**（設計§6）。着けない組み合わせがある（`dontAsk` は巡回に入らない、
    /// `bypassPermissions` は起動時に有効化した場合だけ）ので、結果は
    /// [`ServerMessage::Error`] で返りうる。
    SetPermissionMode {
        card_id: CardId,
        mode: PermissionMode,
    },
    /// 走っているセッションのモデルを切り替える（設計§5）。
    ///
    /// 実体は TUI へ `/model <値>` を送ることなので、権限モードと同じく時間がかかり、
    /// 失敗しうる。運ぶのは**切り替え先の別名**（`opus` など）で、CLI が名乗り返す
    /// フルID（`claude-opus-5`）とは別物である点に注意（[`ModelId`] のドキュメント）。
    ///
    /// 会話が進んだ状態では CLI が確認を求めてくるので、着地までに数手かかる。
    /// 結果は [`ServerMessage::Error`] で返りうる。
    SetModel {
        card_id: CardId,
        model: ModelId,
    },
    /// Composer からの指示送信。
    ///
    /// 改行の扱いはサーバ側が決める（`crates/core/src/session/input.rs`）。単一行は
    /// CR を付けて確定し、複数行は bracketed paste で包む。加工をブラウザ側と両方で
    /// やると、どちらが正なのか分からなくなるので、ここでは生の文字列だけを運ぶ。
    SendInput {
        card_id: CardId,
        text: String,
        /// 添付の置き場所（画像添付 設計§6）。**画像そのものは載せない。**
        ///
        /// バイト列は先に REST（`POST /api/hosts/{host}/attachments`）で置いてあり、
        /// ここを通るのはその**返ってきた絶対パスだけ**。JSON へ生のバイト列を出すと
        /// base64 で 4/3 に膨らむ（設計§3-1）。
        ///
        /// `#[serde(default)]` は**古いブラウザのタブのため**。開きっぱなしのタブは
        /// 焼き込まれた古い画面のまま喋り続けるので、欄を必須にするとメッセージ全体が
        /// 丸ごと解けなくなる。
        #[serde(default)]
        attachments: Vec<String>,
    },
    Resize {
        card_id: CardId,
        cols: u16,
        rows: u16,
    },
    PtyFlow {
        card_id: CardId,
        state: FlowState,
    },
    /// 抜け殻のカードを、元の CLI セッションで起こし直す
    /// （接続断のカードを復旧ボタンで戻す 設計§4-1）。
    ///
    /// # 運ぶのはカードIDだけ
    ///
    /// 作業ディレクトリ・権限モード・呼び戻し先は、どれも**サーバ側の記録が持っている**
    /// （`sessions` 表）。ブラウザに持たせると、画面が抱えている古い写しで起こし直す
    /// 経路ができる——押した瞬間に画面が古ければ、戻る先も古くなる。
    ///
    /// 戻せるかどうか（[`crate::SessionMeta::revivable`]）はブラウザも見るが、**正はサーバ**
    /// （設計§3-3・§3-5）。ずれても「押せてしまってサーバが断る」に倒れる。
    ReviveSession {
        card_id: CardId,
        /// 頼みの番号（[`OpId`]。実装レビュー第6回）。付けると、答えがこの番号を運んで返る——
        /// 起こせたら `Status{op}`、起こせなかったら `Error{ops}`。
        ///
        /// **画面は付けない**（起きたかは状態の変化で分かる）。付けるのは答えを待つ CLI だけ。
        /// 古いサーバ・古い PC は番号を運ばないので答えが来ず、CLI は時間切れで終わる
        #[serde(default, skip_serializing_if = "Option::is_none")]
        op: Option<OpId>,
    },
    /// **過去の CLI セッションを指定して、新しいカードで起こす**（名前付け設計§7-1）。
    ///
    /// # なぜ `Spawn` に欄を足さないのか
    ///
    /// 古いセッションホストは**知らない欄を読み飛ばす**。`Spawn` に呼び戻し先を足す形に
    /// すると、あちらでは**ふつうの起動として成立してしまう**——呼び戻したつもりが、
    /// まっさらな新しいセッションが立つ。しかも利用者から見れば「起こせた」ので、
    /// **間違いに気づくのは履歴を開いたとき**になる。
    ///
    /// 同じ判断が復旧（[`ClientMessage::ReviveSession`]）でも下されている。
    ///
    /// # 作業ディレクトリを運ばない
    ///
    /// **記録が持っている**（`ReviveSession` と同じ理由）。ブラウザに持たせると、
    /// 画面が抱えている古い写しで起こす経路ができる。
    RecallSession {
        /// 呼び戻す先の CLI セッション。
        claude_session_id: crate::ClaudeSessionId,
        /// 起こすときの権限モード。`None` なら CLI に何も渡さない
        permission_mode: Option<PermissionMode>,
        /// どの PC で起こすか。`Spawn` と同じ扱いで、`default` と
        /// `skip_serializing_if` を**組で**付ける
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<crate::AgentId>,
    },
    /// カードに付いている CLI セッションへ、**利用者の名前を付ける**（名前付け設計§5-1）。
    ///
    /// # 運ぶのはカードIDだけ
    ///
    /// 宛先の `ClaudeSessionId` は**サーバが記録から引く**。ブラウザに持たせると、
    /// 画面が抱えている古い写しで**別のセッションへ書く**経路ができる。
    ///
    /// `nickname` が `None` のときは**消す**。消すための口を別に作らない。
    SetNickname {
        card_id: CardId,
        nickname: Option<String>,
    },
    /// 会話を枝分かれさせ、元の会話を隣の席へ呼び戻す（ブランチ設計§2-1）。
    ///
    /// # 運ぶのはカードIDだけ
    ///
    /// 元の会話のIDは**サーバが記録から引く**。**利用者に UUID を扱わせないことが
    /// この機能の芯**なので、IDを運ぶ設計にした時点で目的から外れる。
    ///
    /// # 押した席が枝になる
    ///
    /// `/branch` は CLI 側の仕様で、**押した席をそのまま枝にする**。したがって元の
    /// 会話は呼び戻した新しい席のほうへ移り、並べ替えで位置を入れ替える——**見た目
    /// には元がその場に残り、左隣に枝が増える**。
    BranchSession {
        card_id: CardId,
    },
    /// セッションを終了させる（PTY プロセスを落とす）
    Kill {
        card_id: CardId,
        /// 頼みの番号（[`OpId`]）。付けると、答えがこの番号を運んで返る——終わったら
        /// `Status{op}`、止められなかったら `Error{ops}`（実装レビュー第6回 Astra 1）。
        ///
        /// **画面は付けない。** 画面は状態の変化を見ていれば足り、答えを待たない。付けるのは
        /// 1回で終わる CLI だけ
        #[serde(default, skip_serializing_if = "Option::is_none")]
        op: Option<OpId>,
    },
    /// 終了済みのカードを一覧から消す
    Archive {
        card_id: CardId,
    },

    // ── メモ（メモ設計§12-1）─────────────────────────────
    //
    // **宛先は引数であって、別の口ではない。** 全体宛てとセッション宛てで口を分けると
    // 要件9（2つのメモを同じ部品・同じ口・同じ記録で作る／利用者の指定）が破れる。
    // 台帳に宛先ごとの口が並んでいないことが、その検査そのものになっている。
    //
    // **カードIDを運ばない。** したがって `target_card` の門は効かず、絞り込みは
    // 記録層（`db::memos`）が `account_id` を必ず条件に入れることで守る。
    // `RecallSession` と同じ立場である。
    /// 宛先ぶんのメモを、画面に出る順で返してもらう。
    MemoList {
        target: AnnotationTarget,
    },
    /// 宛先へ1行積む。**時刻はサーバが打つ**（§7-2）。
    MemoAdd {
        target: AnnotationTarget,
        body: serde_json::Value,
    },
    /// 1件の本文を書き換える。**内容が変わったときだけ時刻が動く**（§7-3）。
    ///
    /// 宛先を運ばないのは、`id` が宛先を含めて1件を指すためである。**他人の `id` を
    /// 渡しても、記録層が `account_id` で弾く。**
    MemoEdit {
        id: MemoId,
        body: serde_json::Value,
    },
    /// チェックを付ける／外す（§7-5）。
    MemoCheck {
        id: MemoId,
        checked: bool,
    },
    /// 1件消す（§7-8）。**チェックは「片付ける」であって「消す」ではない**ので、
    /// 別の口にしてある。
    MemoRemove {
        id: MemoId,
    },
}

/// 追加した PJT 枠1枚（イシューグループ_2026_0805_0514 設計§11）。
///
/// # なぜ「セッションが何本居るか」を持たないのか
///
/// カードから毎回数えるほうが正しいため（設計§2）。ここへ持たせると、カードが増減する
/// たびに枠のほうも配り直す必要が生まれ、片方だけ届いたときに**画面が嘘をつく**。
///
/// # `host` が文字列なのはなぜか
///
/// 画面と REST が使う綴りをそのまま運ぶため。`agent_id` の文字列表現か、ローカルを
/// 表す `"local"` のどちらかになる。**DB の番兵（nil UUID）とは別物**で、あちらは
/// 記録の中だけの値。混ぜると、片方の綴りを変えたときにもう片方が黙って取り残される。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectView {
    pub id: uuid::Uuid,
    pub host: String,
    pub path: String,
    pub created_at: Timestamp,
    /// そのアカウントの中での並び（並べ替え設計§9-2）。**小さいほうが先。**
    ///
    /// **並びの正はこの欄**であって `created_at` ではない。`created_at` は値としては
    /// 守り続けるが、もう並びを決めない。
    ///
    /// # なぜ `#[serde(default)]` を書くのか
    ///
    /// 欄を持たない古い名乗りを 0 として受けるため。**版（`PROTOCOL_VERSION`）は
    /// 上げない**ので、欠けた名乗りが来る道が残る。
    #[serde(default)]
    pub position: i32,
}

/// サーバ → ブラウザ。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMessage {
    /// 接続直後の1通目。クライアント側の実装が必要とするサーバ設定を渡す。
    ///
    /// フロー制御のしきい値は `config.toml`（設計§12）にあるがウォーターマークの判定は
    /// ブラウザ側で行うため、値を渡さないと設定が効かない。
    Hello { flow_high: usize, flow_low: usize },
    /// セッション1枚分の情報。新規・更新の区別なく全体を送る。
    ///
    /// # なぜ `Box` なのか
    ///
    /// この列挙は**購読者ごとに複製されて配信の待ち行列へ積まれる**（1接続あたり
    /// 64件×クライアント数）。[`SessionMeta`] は他のバリアントより桁違いに大きいので、
    /// 直に持つと `Status` のような小さな知らせまで同じ大きさで積まれることになる。
    /// JSON の形は変わらない（`Box` は透過的に直列化される）ので、線の上は同じ。
    SessionUpsert { session: Box<SessionMeta> },
    /// カードが一覧から消えたことを伝える（`archive` の結果）。
    ///
    /// 消えたことを伝える手段が無いと、`archive` したブラウザ以外の画面にカードが
    /// 残り続けてしまう。
    SessionRemoved { card_id: CardId },
    /// 状態だけの差分更新。実装はフェーズ2
    Status {
        card_id: CardId,
        status: SessionStatus,
        subagent_active: u32,
        last_activity_at: Timestamp,
        /// **頼みへの答え**なら、その番号（[`OpId`]。実装レビュー第6回 Astra 1）。
        ///
        /// 終了の頼み（`ClientMessage::Kill{op}`）が済んだとき、サーバがそのカードの記録の
        /// いまの状態に番号を添えて配る。**値そのものは記録のいまの姿**なので、番号を知らない
        /// 画面が受けても何も変わらない。セッションホストからの報告は付けない。
        ///
        /// 種別を足さずに欄にしたのは、画面（`web/src/stores/ws.ts`）が知らない種別を型の
        /// 網羅で拒むため。欄なら古い画面は黙って読み飛ばす
        #[serde(default, skip_serializing_if = "Option::is_none")]
        op: Option<OpId>,
    },
    /// コンテキスト残量だけの差分更新（コンテキスト残量設計§2）。
    ///
    /// [`ServerMessage::Status`] と同じ「軽い便」。**記録を1行も書き換えずに配る**ために
    /// 用意した種別で、[`ServerMessage::SessionUpsert`] で運ぶと3秒ごとに
    /// セッション数ぶんの書き込みが積み上がる。
    ///
    /// `usage` が `None` のときは「**まだ分からない**」であって 0% ではない
    /// （[`ContextUsage`]）。**消える向きも運ぶ**ので、`/compact` の直後に
    /// ゲージが古い値のまま残ることがない。
    ///
    /// 正本は [`SessionMeta::context_usage`]。これは一部だけ更新する近道である。
    ContextUsage {
        card_id: CardId,
        usage: Option<ContextUsage>,
    },
    /// その PC の使用上限だけの差分更新（status 設計「便」）。
    ///
    /// [`ServerMessage::ContextUsage`] と同じ「軽い便」で、記録を1行も書き換えずに配る。
    ///
    /// # 宛先がカードではない
    ///
    /// **これは `card_id` を持たない。** [`RateLimits`] はその PC に入っている claude
    /// ログインの上限であって、セッションの状態ではない。したがって配る先も
    /// **カードの購読者ではなくアカウント内の全ブラウザ**になる（PC の一覧に出る値）。
    ///
    /// # `agent_id` が `None` のときは、局所モードの機械である
    ///
    /// **どの PC のものかはサーバが接続から決める**（`ReportOrigin`）。PC が自分で
    /// 名乗る道は作っていない——[`crate::a2s::AgentMessage::RateLimits`] は
    /// `agent_id` を運ばず、ここへ詰めるのは受け口の仕事である。
    ///
    /// 局所モード（1プロセスで両方を兼ねる構成）には PC の行が無いので `None` になる。
    /// **`None` を「値が無い」と読まないこと**——「この機械自身のもの」である。
    ///
    /// 正本は [`SessionMeta::rate_limits`]。これは一部だけ更新する近道である。
    RateLimits {
        agent_id: Option<AgentId>,
        limits: RateLimits,
        /// **どの claude ログインの上限か**を表す指紋（[`crate::RateLimits`] の
        /// 「ログインが変わったことは、値からは分からない」）。
        ///
        /// # ダッシュボードのアカウントとは別物
        ///
        /// 同じ画面に `account_id`（ダッシュボードの利用者）と `agent_id`（PC）が
        /// 既に居るので、**3つ目の「誰」を `account` と名付けない**。ここが指すのは
        /// **その PC に入っている claude が、いまどのログインで動いているか**である。
        ///
        /// # 中身は指紋だけ
        ///
        /// 元の値（アカウントUUID）は個人を指すので運ばない。**要るのは「前と同じか」
        /// だけ**なので、突き合わせに足りる長さの hex に潰してある。
        ///
        /// # `None` は「分からない」
        ///
        /// 読めない環境（ログインしていない・ファイルが無い・API キー利用）では
        /// `None` になる。**受け取る側は、`None` を「変わった」と読んではいけない**
        /// ——読めないだけで切り替えを起こすと、値が3秒ごとに入れ替わる。
        ///
        /// # なぜ `#[serde(default)]` を書くのか
        ///
        /// 欄を持たない古い名乗りを `None` として受けるため。**版
        /// （`PROTOCOL_VERSION` ／ `A2S_VERSION`）は上げない**ので、欠けた名乗りが
        /// 来る道が残る。`skip_serializing_if` を添えてあるので、**`None` のときは
        /// 線に何も乗らない**——既存の綴りを1文字も変えない。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        login: Option<ClaudeLoginFingerprint>,
    },
    /// そのセッションの費用と手間だけの差分更新（status 設計「便」）。
    ///
    /// 上の [`ServerMessage::RateLimits`] と**同じ payload から届くが、属する相手が違う**。
    /// 費用はセッションごとの値なので、**こちらはカード宛**である。
    ///
    /// 正本は [`SessionMeta::cost`]。これは一部だけ更新する近道である。
    SessionCost { card_id: CardId, cost: SessionCost },
    /// 履歴の追記。
    ///
    /// **同じ [`NodeId`] のノードは上書き（upsert）として扱うこと。**「追記」という名だが
    /// 純粋な追加ではない。ツールコールのノードは結果が届く前に発行され、結果が来てから
    /// 同じIDで送り直されるため。
    ///
    /// 「結果が揃うまで出さない」方式にしなかったのは、長いコマンドを実行している間
    /// そのツールコールが画面に一切出ないことになり、「いま何をしているか一目で分かる」
    /// という本ツールの目的を正面から損なうため。
    ///
    /// [`NodeId`]: crate::NodeId
    TranscriptAppend {
        card_id: CardId,
        nodes: Vec<TreeNode>,
    },
    /// トランスクリプトの巻き戻り検知。
    ///
    /// 受け取ったら、そのカードの履歴を捨てて作り直す。`/rewind` でファイルが
    /// 巻き戻ったときのほか、購読を始めるときにも先頭で1回送る（再購読を冪等にするため）。
    TranscriptReset { card_id: CardId },
    /// 構造化ビューの縮退通知。実装はフェーズ3
    ParserStatus {
        state: ParserState,
        detail: Option<String>,
    },
    /// インスタンスの間の連絡係の縮退通知（セルフホスト化設計§12・§9-1）。
    ///
    /// **止まるのは跨ぎの更新だけ**で、そのインスタンスの中で完結する配信は動き続ける。
    /// バナーに出すのは「片方のブラウザにだけ更新が来ない」という、症状からは
    /// 原因の分からない状態を利用者が読み解けるようにするため。
    ///
    /// 連絡係を持たない構成（ローカルモード・インスタンス1台）では**一度も送らない**。
    BusStatus {
        state: BusState,
        detail: Option<String>,
    },
    /// 自己修復の進行通知（設計§9）。
    ///
    /// `detail` には、人が読んで次の一手を決められる手掛かりを入れる（失敗したテストの
    /// 抜粋・見つけた新しい版など）。段階だけでは「何が起きたのか」が分からない。
    Selfheal {
        phase: SelfhealPhase,
        detail: Option<String>,
    },
    /// 操作が失敗したことをユーザへ伝える。
    ///
    /// 起動失敗のようにカードが作られないケースがあり、黙って何も起きないと
    /// 「押したのに反応しない」状態になるため、明示的に返す種別を用意している。
    Error {
        card_id: Option<CardId>,
        message: String,
        /// 何をしようとして断られたか（細かい修正 設計§7-2）。
        ///
        /// # なぜ `#[serde(default)]` を書くのか
        ///
        /// 欄を持たない古い名乗りを [`ErrorKind::Other`] として受けるため。
        /// **版（`PROTOCOL_VERSION`）は上げない**ので、欠けた名乗りが来る道が残る。
        #[serde(default)]
        kind: ErrorKind,
        /// その知らせの性質（寝ているカードばかりなのに、メモリ不足でセッションを
        /// 起こせない 設計§7-3）。
        ///
        /// - `Some(true)`＝既に同じ操作が進んでいる（競合。待ってよい）
        /// - `Some(false)`＝その操作は終わった断り（待っても起きない）
        /// - `None`＝判別できない（古い相手・起こし直し以外）。待つ側はいまどおり待つ
        ///
        /// **欠けを `false` と読まない。** 古い PC の競合を失敗と誤読する。
        /// [`ErrorKind`] の腕を足さないのは、閉じた列挙なので古いサーバが新しい PC の
        /// 知らせを読めなくなるため。欄なら古い側は黙って読み飛ばす
        #[serde(default, skip_serializing_if = "Option::is_none")]
        busy: Option<bool>,
        /// 起こし直しを取り下げた断りなら、その理由（実装レビュー第4回 Astra 1）。
        ///
        /// `None`＝取り下げではない、または判別できない（古い相手）。**欠けを「取り下げ
        /// ではない」と読む側に倒すのは安全側**——終了の待ちは満ちず、実体が無ければ時間切れで
        /// 終わるだけで、止まっていないものを「止まった」とは言わない。`busy` と同じく欄にする
        #[serde(default, skip_serializing_if = "Option::is_none")]
        withdrawn: Option<Withdrawal>,
        /// この知らせが答えている頼みの番号（[`OpId`]。実装レビュー第6回 Astra 1・3）。
        ///
        /// **複数ありうる。** 起こし直しは、先に進んでいる起こし直しへ後から来た頼みを束ねる
        /// （競合で断った頼みも、先の起こし直しが終われば同じ結果になる）ので、終わった断りは
        /// 束ねた番号を全部運ぶ。空＝どの頼みへの答えとも言えない（古い相手・頼みと関係の
        /// 無い知らせ）。**空の知らせでは誰も満ちない**
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        ops: Vec<OpId>,
    },
    /// PJT 枠1枚の最新（イシューグループ_2026_0805_0514 設計§11）。
    ///
    /// **記録へ書けてから配る。** 書けなかったものを配ると、画面には出ているのに
    /// 読み込み直すと消える——嘘をつくことになる。
    ProjectUpsert { project: ProjectView },
    /// PJT 枠が消えたことを伝える。
    ///
    /// 消したブラウザ以外の画面にも届ける必要があるので、`SessionRemoved` と同じ形で
    /// 用意してある。
    ProjectRemoved { project_id: uuid::Uuid },
    /// アプリ全体の知らせが1件増えた（トーストとベル設計§6-1）。
    ///
    /// **未読の数を同梱する。** 別に数えさせると、1件届くたびにバッジのために
    /// 問い合わせが飛ぶ。
    ///
    /// **既存の [`ServerMessage::Error`] と [`ServerMessage::Selfheal`] は残してある。**
    /// これは横に流す追加のプッシュで、置き換えではない。
    NoticeCreated {
        notice: NoticeView,
        unread_count: u32,
    },
    /// 未読をまとめて既読にした。**別のタブや端末のバッジを揃えるために配る。**
    NoticeRead {
        read_at: Timestamp,
        unread_count: u32,
    },

    /// 宛先ぶんのメモを、画面に出る順で丸ごと配る（メモ設計§7-1）。
    ///
    /// # 1件ずつではなく、丸ごと送る
    ///
    /// 並びは**2段**（上段＝チェック済みを `checked_at` 順、下段＝未チェックを
    /// `noted_at` 順）で、1件の編集で**その1件が段をまたいで動く**。差分で送ると
    /// 受け手が並べ直すことになり、**並びを決める場所が2つに割れる**。
    ///
    /// # セッションホストからは来ない
    ///
    /// メモはサーバの記録だけで完結する（§1-2）。`registry::apply` は
    /// **この便をセッションホストから受け取ったら捨てる**——通すと、記録に無いメモが
    /// 画面へ出る道になる。
    Memos {
        target: AnnotationTarget,
        memos: Vec<MemoView>,
    },
}

/// アプリ全体の知らせ1件（トーストとベル設計§4-1・§6-1）。
///
/// REST の一覧応答と WebSocket のプッシュで**同じ型**を使う。CLI もこれを読み戻すので、
/// `Deserialize` を持たせてある（CLI 側に写しの型を作らない）。
///
/// # カード単位の断りとは別物
///
/// `web/src/stores/sessions.ts` の断りは**カード1枚に効く**もので、メモリだけに積む。
/// こちらは**アプリ全体に効く**もので、記録に残って端末をまたぐ。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoticeView {
    pub id: uuid::Uuid,
    /// 名指し先。**いまは常に `None`**（将来カードを名指しする知らせの受け皿）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_id: Option<CardId>,
    /// `"error"` か `"selfheal"`。
    pub source: String,
    /// `source` に応じた種別の snake_case。
    pub kind: String,
    /// 画面へそのまま出す1行。
    pub message: String,
    pub created_at: Timestamp,
    /// **空なら未読。**
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<Timestamp>,
}

/// メモ1件（メモ設計§3-2・§7-1）。
///
/// **`account_id` は載せない。** 誰のものかは接続の身元で決まっており、線に流す理由が
/// 無い——載せると、画面が持っている値で宛先を差し替える経路ができる。
///
/// # 並びはサーバが決めている
///
/// 受け取った順がそのまま画面の順である（上段＝チェック済みを `checked_at` 順、
/// 下段＝未チェックを `noted_at` 順）。**ブラウザで並べ直さない**——端末ごとに
/// 時計が違うと並びが端末ごとに変わる。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoView {
    pub id: MemoId,
    /// 本文。ブロックエディタの中身をそのまま持つ（形は画面側が決める）。
    pub body: serde_json::Value,
    /// メモの時刻。**内容が変わった編集で動く**（§7-3）。
    pub noted_at: Timestamp,
    /// **空ならチェックされていない。** 入っていればチェックした時刻で、上段の並びを決める。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<Timestamp>,
}

impl ErrorKind {
    /// 記録に書く綴り。**JSON の綴りと同じ**（`serde` の `snake_case` に合わせてある）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PermissionMode => "permission_mode",
            Self::Model => "model",
            Self::Revive => "revive",
            Self::Nickname => "nickname",
            Self::Kill => "kill",
            Self::Archive => "archive",
            Self::SubPty => "sub_pty",
            Self::SubTranscript => "sub_transcript",
            Self::SendInput => "send_input",
            Self::Branch => "branch",
            Self::NotFound => "not_found",
            Self::Other => "other",
        }
    }
}

impl SelfhealPhase {
    /// 記録に書く綴り。**JSON の綴りと同じ。**
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Detected => "detected",
            Self::Canary => "canary",
            Self::Testing => "testing",
            Self::Repairing => "repairing",
            Self::Verifying => "verifying",
            Self::Passed => "passed",
            Self::Swapped => "swapped",
            Self::RolledBack => "rolled_back",
            Self::Failed => "failed",
            Self::Cooldown => "cooldown",
        }
    }

    /// 画面に出す日本語。
    ///
    /// **`web/src/lib/protocol.ts` の `selfhealLabel` と一字一句同じにすること。**
    /// 片方だけ直すと、同じ出来事が画面と CLI で違う文言になる——どちらが正なのか
    /// 読む側には分からない。
    pub fn label(self) -> &'static str {
        match self {
            Self::Detected => "履歴の異常を検知しました",
            Self::Canary => "新しい版のサンプルを採っています",
            Self::Testing => "サンプルでパーサを検証しています",
            Self::Repairing => "修復セッションが作業しています",
            Self::Verifying => "修復の結果を検証しています",
            Self::Passed => "対応済みでした（修復は不要）",
            Self::Swapped => "パーサを差し替えました",
            Self::RolledBack => "悪化したため前のパーサへ戻しました",
            Self::Failed => "自動修復に失敗しました",
            Self::Cooldown => "同じ版への再挑戦を控えています",
        }
    }
}

/// 自己修復の段階を、記録に書く1行へ組み立てる（トーストとベル設計§7-1）。
///
/// **サーバ側にラベルを持たせたのは、CLI が画面を通らないためである。** これまで日本語は
/// `web/src/lib/protocol.ts` にしか無く、`agentdashboard notice ls` からは読めなかった。
pub fn selfheal_label(phase: SelfhealPhase, detail: Option<&str>) -> String {
    match detail {
        Some(detail) if !detail.is_empty() => format!("{} {detail}", phase.label()),
        _ => phase.label().to_string(),
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use crate::{ClaudeSessionId, Node, NodeId, PermissionMode, ProjectId, RateLimitWindow};

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
            claude_session_id: Some(ClaudeSessionId::new()),
            resumed_from: None,
            permission_mode: Some(PermissionMode::new("acceptEdits")),
            model: Some(ModelId::new("claude-opus-5")),
            model_label: Some("Opus 5".to_string()),
            model_requested: None,
            status: SessionStatus::Working,
            subagent_active: 1,
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
            branched_from: None,
            context_usage: None,
            rate_limits: None,
            cost: None,
        }
    }

    #[test]
    fn client_messageは全種が往復する() {
        let card_id = CardId::new();
        let all = vec![
            ClientMessage::SubTranscript { card_id },
            ClientMessage::UnsubTranscript { card_id },
            ClientMessage::SubPty {
                card_id,
                cols: 120,
                rows: 40,
            },
            ClientMessage::UnsubPty { card_id },
            ClientMessage::Spawn {
                cwd: "/home/example/dev/app".to_string(),
                permission_mode: None,
                agent_id: None,
            },
            ClientMessage::Spawn {
                cwd: "/home/example/dev/app".to_string(),
                permission_mode: Some(PermissionMode::new("bypassPermissions")),
                agent_id: Some(crate::AgentId::new()),
            },
            ClientMessage::SetPermissionMode {
                card_id,
                mode: PermissionMode::new("acceptEdits"),
            },
            ClientMessage::SetModel {
                card_id,
                model: ModelId::new("opus"),
            },
            ClientMessage::SendInput {
                card_id,
                text: "/rewind".to_string(),
                attachments: Vec::new(),
            },
            ClientMessage::SendInput {
                card_id,
                text: "これを見て".to_string(),
                attachments: vec!["/state/attachments/x/20260902-010203-a1b2c3d4.png".to_string()],
            },
            ClientMessage::Resize {
                card_id,
                cols: 80,
                rows: 24,
            },
            ClientMessage::PtyFlow {
                card_id,
                state: FlowState::Pause,
            },
            ClientMessage::PtyFlow {
                card_id,
                state: FlowState::Resume,
            },
            ClientMessage::ReviveSession { card_id, op: None },
            ClientMessage::ReviveSession {
                card_id,
                op: Some(OpId::new()),
            },
            ClientMessage::RecallSession {
                claude_session_id: crate::ClaudeSessionId::new(),
                permission_mode: None,
                agent_id: None,
            },
            ClientMessage::RecallSession {
                claude_session_id: crate::ClaudeSessionId::new(),
                permission_mode: Some(PermissionMode::new("acceptEdits")),
                agent_id: Some(crate::AgentId::new()),
            },
            ClientMessage::SetNickname {
                card_id,
                nickname: Some("あとで直すやつ".to_string()),
            },
            ClientMessage::SetNickname {
                card_id,
                nickname: None,
            },
            ClientMessage::Kill { card_id, op: None },
            ClientMessage::Archive { card_id },
            // **宛先2つとも往復させる。** `AnnotationTarget` の欄の形には見張りが
            // 無く（`cli_surface` が見るのは種別の綴りだけ）、ここと
            // `web/src/lib/protocol.test.ts` が唯一のズレ検出手段である
            ClientMessage::MemoList {
                target: AnnotationTarget::Global,
            },
            ClientMessage::MemoList {
                target: AnnotationTarget::Session {
                    claude_session_id: ClaudeSessionId::new(),
                },
            },
            ClientMessage::MemoAdd {
                target: AnnotationTarget::Global,
                body: serde_json::json!({"blocks": [{"type": "paragraph", "text": "あとで読む"}]}),
            },
            ClientMessage::MemoAdd {
                target: AnnotationTarget::Session {
                    claude_session_id: ClaudeSessionId::new(),
                },
                body: serde_json::json!({"blocks": []}),
            },
            ClientMessage::MemoEdit {
                id: MemoId::new(),
                body: serde_json::json!({"blocks": [{"type": "heading", "text": "見出し"}]}),
            },
            ClientMessage::MemoCheck {
                id: MemoId::new(),
                checked: true,
            },
            ClientMessage::MemoCheck {
                id: MemoId::new(),
                checked: false,
            },
            ClientMessage::MemoRemove { id: MemoId::new() },
        ];
        for message in &all {
            assert_eq!(&roundtrip(message), message);
        }
    }

    #[test]
    fn 断りの種別は欄が欠けていても受かる() {
        /*
            **版を上げずに欄を足す**ための約束（細かい修正 設計§7-2）。欄を持たない古い
            名乗りが来る道が残っているので、`#[serde(default)]` が効いていないと
            **その相手からの断りが1件も届かなくなる**。
        */
        let 古い名乗り = r#"{"t":"error","card_id":null,"message":"しくじりました"}"#;
        let message: ServerMessage = serde_json::from_str(古い名乗り).unwrap();
        let ServerMessage::Error { kind, .. } = message else {
            panic!("error として読めていない");
        };
        assert_eq!(kind, ErrorKind::Other);
    }

    #[test]
    fn 断りの種別は綴りのまま運ばれる() {
        // 綴りが変わると、**ブラウザ側の寿命の表が黙って引けなくなる**（既定の5秒へ落ちる）
        let json = serde_json::to_string(&ServerMessage::Error {
            card_id: None,
            message: "起こせません".to_string(),
            kind: ErrorKind::Revive,
            busy: None,
            withdrawn: None,
            ops: Vec::new(),
        })
        .unwrap();
        assert!(json.contains(r#""kind":"revive""#), "{json}");
    }

    #[test]
    fn 断りの性質は3値とも運ばれ_欠けは判別できないと読む() {
        /*
            設計§7-3。**欠けを `false` と読むと、古い PC の競合を失敗と誤読する**ので、
            欄の無い名乗りは `None` に落ちなければならない。`None` は書き出さない——
            書くと、欄を知らない相手（画面の突き合わせ）の文字列が1文字ずれる
        */
        let 古い名乗り = r#"{"t":"error","card_id":null,"message":"復旧中です","kind":"revive"}"#;
        let ServerMessage::Error { busy, .. } = serde_json::from_str(古い名乗り).unwrap()
        else {
            panic!("error として読めていない");
        };
        assert_eq!(busy, None, "欄の無い名乗りを判別できたことにしている");

        // 画面側（`web/src/lib/protocol.test.ts` の同じ綴りの検査）と1文字も違わないこと
        assert_eq!(
            serde_json::to_string(&ServerMessage::Error {
                card_id: None,
                message: "復旧中です".to_string(),
                kind: ErrorKind::Revive,
                busy: Some(true),
                withdrawn: None,
                ops: Vec::new(),
            })
            .unwrap(),
            r#"{"t":"error","card_id":null,"message":"復旧中です","kind":"revive","busy":true}"#
        );

        for (busy, 綴り) in [
            (Some(true), Some(r#""busy":true"#)),
            (Some(false), Some(r#""busy":false"#)),
            (None, None),
        ] {
            let message = ServerMessage::Error {
                card_id: Some(CardId::new()),
                message: "起こせません".to_string(),
                kind: ErrorKind::Revive,
                busy,
                withdrawn: None,
                ops: Vec::new(),
            };
            let json = serde_json::to_string(&message).unwrap();
            match 綴り {
                Some(綴り) => assert!(json.contains(綴り), "{json}"),
                None => assert!(!json.contains("busy"), "None を書き出している：{json}"),
            }
            assert_eq!(roundtrip(&message), message);
        }
    }

    #[test]
    fn 取り下げの理由は綴りのまま運ばれ_欠けと知らない綴りは取り下げではないと読む() {
        /*
            実装レビュー第4回 Astra 1。**欠けを「終了の頼みで取り下げた」と読まない**——古い
            相手の終わった断りにはメモリ不足も混ざるので、CLI の終了が満ちてはいけない。
            知らない綴りは `Unknown` に落ち、**`Error` ごと読めなくならない**こと（`serde(other)`
            が無いと、新しい PC が理由を足した途端に古いサーバが断りを1件も配れなくなる）
        */
        let 古い名乗り =
            r#"{"t":"error","card_id":null,"message":"x","kind":"revive","busy":false}"#;
        let ServerMessage::Error { withdrawn, .. } = serde_json::from_str(古い名乗り).unwrap()
        else {
            panic!("error として読めていない");
        };
        assert_eq!(withdrawn, None, "欄の無い名乗りを取り下げと読んでいる");

        let 知らない綴り = r#"{"t":"error","card_id":null,"message":"x","kind":"revive","busy":false,"withdrawn":"paused"}"#;
        let ServerMessage::Error { withdrawn, .. } =
            serde_json::from_str(知らない綴り).expect("知らない綴りでも error として読めること")
        else {
            panic!("error として読めていない");
        };
        assert_eq!(withdrawn, Some(Withdrawal::Unknown));

        for (withdrawn, 綴り) in [
            (Some(Withdrawal::Kill), Some(r#""withdrawn":"kill""#)),
            (
                Some(Withdrawal::Removing),
                Some(r#""withdrawn":"removing""#),
            ),
            (Some(Withdrawal::Remove), Some(r#""withdrawn":"remove""#)),
            (None, None),
        ] {
            let message = ServerMessage::Error {
                card_id: Some(CardId::new()),
                message: "起こし直しをやめました".to_string(),
                kind: ErrorKind::Revive,
                busy: Some(false),
                withdrawn,
                ops: Vec::new(),
            };
            let json = serde_json::to_string(&message).unwrap();
            match 綴り {
                Some(綴り) => assert!(json.contains(綴り), "{json}"),
                None => assert!(!json.contains("withdrawn"), "None を書き出している：{json}"),
            }
            assert_eq!(roundtrip(&message), message);
        }
    }

    #[test]
    fn 頼みの番号は欠けても読め_無ければ書き出さず_あれば綴りのまま往復する() {
        /*
            実装レビュー第6回 Astra 1・3。頼み（`Kill.op`）・断り（`Error.ops`）・成功の答え
            （`Status.op`）。**欠けた古い名乗りが読めること**（版は上げない）と、**無いときに書き
            出さないこと**（古い相手へ空の欄を送らない）。番号は uuid の文字列そのまま
        */
        let op = OpId::new();
        let 綴り = format!(r#""{op}""#);

        let 古い終了 = r#"{"t":"kill","card_id":"00000000-0000-0000-0000-000000000001"}"#;
        let ClientMessage::Kill { op: 欠け, .. } = serde_json::from_str(古い終了).unwrap()
        else {
            panic!("kill として読めていない");
        };
        assert_eq!(欠け, None, "欄の無い終了の頼みを番号付きと読んでいる");
        for (頼み, 書く) in [(Some(op), true), (None, false)] {
            let message = ClientMessage::Kill {
                card_id: CardId::new(),
                op: 頼み,
            };
            let json = serde_json::to_string(&message).unwrap();
            assert_eq!(json.contains(r#""op":"#), 書く, "{json}");
            if 書く {
                assert!(json.contains(&綴り), "{json}");
            }
            assert_eq!(roundtrip(&message), message);
        }

        let 古い状態 = r#"{"t":"status","card_id":"00000000-0000-0000-0000-000000000001","status":{"kind":"working"},"subagent_active":0,"last_activity_at":1}"#;
        let ServerMessage::Status { op: 欠け, .. } = serde_json::from_str(古い状態).unwrap()
        else {
            panic!("status として読めていない");
        };
        assert_eq!(欠け, None, "欄の無い状態を答えと読んでいる");
        for (頼み, 書く) in [(Some(op), true), (None, false)] {
            let message = ServerMessage::Status {
                card_id: CardId::new(),
                status: SessionStatus::Ended { ok: true },
                subagent_active: 0,
                last_activity_at: 1,
                op: 頼み,
            };
            let json = serde_json::to_string(&message).unwrap();
            assert_eq!(json.contains(r#""op":"#), 書く, "{json}");
            assert_eq!(roundtrip(&message), message);
        }

        let 古い断り = r#"{"t":"error","card_id":null,"message":"x","kind":"revive","busy":false}"#;
        let ServerMessage::Error { ops, .. } = serde_json::from_str(古い断り).unwrap() else {
            panic!("error として読めていない");
        };
        assert!(
            ops.is_empty(),
            "欄の無い断りを、どれかの頼みへの答えと読んでいる"
        );
        for (束, 書く) in [(vec![op, OpId::new()], true), (Vec::new(), false)] {
            let message = ServerMessage::Error {
                card_id: Some(CardId::new()),
                message: "起こし直しをやめました".to_string(),
                kind: ErrorKind::Revive,
                busy: Some(false),
                withdrawn: None,
                ops: 束,
            };
            let json = serde_json::to_string(&message).unwrap();
            assert_eq!(json.contains(r#""ops":"#), 書く, "{json}");
            assert_eq!(roundtrip(&message), message);
        }
    }

    #[test]
    fn server_messageは全種が往復する() {
        let card_id = CardId::new();
        let all = vec![
            ServerMessage::Hello {
                flow_high: 262_144,
                flow_low: 32_768,
            },
            ServerMessage::SessionUpsert {
                session: Box::new(sample_meta()),
            },
            ServerMessage::SessionRemoved { card_id },
            ServerMessage::Status {
                card_id,
                status: SessionStatus::Ended { ok: true },
                subagent_active: 0,
                last_activity_at: 1_700_000_000_000,
                op: None,
            },
            ServerMessage::TranscriptAppend {
                card_id,
                nodes: vec![TreeNode {
                    id: NodeId("node-1".to_string()),
                    parent: None,
                    node: Node::AssistantText {
                        text: "了解しました".to_string(),
                        error: false,
                    },
                    ts: 1_700_000_000_000,
                    branch: 0,
                }],
            },
            ServerMessage::TranscriptReset { card_id },
            ServerMessage::BusStatus {
                state: BusState::Degraded,
                detail: Some("連絡係に繋がりません".to_string()),
            },
            ServerMessage::ContextUsage {
                card_id,
                usage: Some(ContextUsage {
                    used_percentage: 24,
                    total_input_tokens: 241_479,
                    context_window_size: 1_000_000,
                }),
            },
            // 「まだ分からない」も運ぶ形（`/compact` の直後）
            ServerMessage::ContextUsage {
                card_id,
                usage: None,
            },
            ServerMessage::ParserStatus {
                state: ParserState::Degraded,
                detail: Some("パーサプロセスが応答しません".to_string()),
            },
            ServerMessage::Selfheal {
                phase: SelfhealPhase::Canary,
                detail: None,
            },
            ServerMessage::Selfheal {
                phase: SelfhealPhase::Swapped,
                detail: Some("transcript-parser を差し替えました".to_string()),
            },
            ServerMessage::Error {
                card_id: Some(card_id),
                message: "作業ディレクトリが存在しません".to_string(),
                kind: ErrorKind::NotFound,

                busy: None,
                withdrawn: None,
                ops: Vec::new(),
            },
            ServerMessage::Error {
                card_id: None,
                message: "claude を起動できませんでした".to_string(),
                kind: ErrorKind::Other,

                busy: None,
                withdrawn: None,
                ops: Vec::new(),
            },
            ServerMessage::Error {
                card_id: Some(card_id),
                message: "このカードは復旧中です".to_string(),
                kind: ErrorKind::Revive,
                busy: Some(true),
                withdrawn: None,
                ops: Vec::new(),
            },
            ServerMessage::Error {
                card_id: Some(card_id),
                message: "メモリが足りないので起こし直せません".to_string(),
                kind: ErrorKind::Revive,
                busy: Some(false),
                withdrawn: None,
                ops: Vec::new(),
            },
            ServerMessage::ProjectUpsert {
                project: ProjectView {
                    id: uuid::Uuid::new_v4(),
                    host: "local".to_string(),
                    path: "/home/example/dev/app".to_string(),
                    created_at: 1_700_000_000_000,
                    position: 0,
                },
            },
            ServerMessage::ProjectRemoved {
                project_id: uuid::Uuid::new_v4(),
            },
            // 空の一覧も往復させる——**宛先はあるがメモが0件**という状態は、
            // 画面を初めて開いたときに必ず通る
            ServerMessage::Memos {
                target: AnnotationTarget::Global,
                memos: vec![],
            },
            ServerMessage::Memos {
                target: AnnotationTarget::Session {
                    claude_session_id: ClaudeSessionId::new(),
                },
                memos: vec![
                    MemoView {
                        id: MemoId::new(),
                        body: serde_json::json!({"blocks": []}),
                        noted_at: 1_700_000_000_000,
                        checked_at: None,
                    },
                    MemoView {
                        id: MemoId::new(),
                        body: serde_json::json!({"blocks": []}),
                        noted_at: 1_700_000_000_000,
                        checked_at: Some(1_700_000_001_000),
                    },
                ],
            },
        ];
        for message in &all {
            assert_eq!(&roundtrip(message), message);
        }
    }

    /// 枠の種別が、TypeScript 側（`web/src/lib/protocol.ts`）と同じ JSON になること。
    ///
    /// 手書きで二重に定義しているので、**ここが唯一のズレ検出手段**になる。
    /// 片方だけ直すとコンパイルは通るのに動かない、という追いにくい状態を防ぐ。
    #[test]
    fn 枠の増減は決まった綴りで線に乗る() {
        let id = uuid::Uuid::nil();
        let text = serde_json::to_string(&ServerMessage::ProjectUpsert {
            project: ProjectView {
                id,
                host: "local".to_string(),
                path: "/home/example/dev/app".to_string(),
                created_at: 1_700_000_000_000,
                position: 0,
            },
        })
        .unwrap();
        assert_eq!(
            text,
            format!(
                r#"{{"t":"project_upsert","project":{{"id":"{id}","host":"local","path":"/home/example/dev/app","created_at":1700000000000,"position":0}}}}"#
            )
        );

        let text =
            serde_json::to_string(&ServerMessage::ProjectRemoved { project_id: id }).unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"project_removed","project_id":"{id}"}}"#)
        );
    }

    /// コンテキスト残量の便が、TypeScript 側と同じ JSON になること。
    ///
    /// **台帳（`cli_surface`）はここを見ていない。** あちらが突き合わせているのは
    /// `ClientMessage` だけなので、`ServerMessage` に種別を足しても1つも落ちない
    /// ——綴りを間違えても欄の形がずれても、誰も気づかない。**その穴を埋めるのが
    /// この検査**で、`web/src/lib/protocol.test.ts` に同じ JSON を置いた対がある。
    #[test]
    fn メモの便は決まった綴りで線に乗る() {
        // **`AnnotationTarget` の欄の形には見張りが無い。** `cli_surface` が突き合わせて
        // いるのは口の種別（`t` の綴り）の在否だけで、中身の欄までは見ない。
        // ここと `web/src/lib/protocol.test.ts` の対が、唯一のズレ検出手段である。
        let session = crate::ClaudeSessionId::new();

        // 宛先：全体。**欄を持たない**ので `{"t":"global"}` だけになる
        let text = serde_json::to_string(&ClientMessage::MemoList {
            target: AnnotationTarget::Global,
        })
        .unwrap();
        assert_eq!(text, r#"{"t":"memo_list","target":{"t":"global"}}"#);

        // 宛先：セッション。**`claude_session_id` の綴りまで固定する**
        let text = serde_json::to_string(&ClientMessage::MemoList {
            target: AnnotationTarget::Session {
                claude_session_id: session,
            },
        })
        .unwrap();
        assert_eq!(
            text,
            format!(
                r#"{{"t":"memo_list","target":{{"t":"session","claude_session_id":"{session}"}}}}"#
            )
        );

        // 配る便。**`checked_at` は空なら欄ごと消える**（`skip_serializing_if`）——
        // 「未チェック」と「チェック時刻が 0」を混ぜないため
        let id = MemoId::new();
        let text = serde_json::to_string(&ServerMessage::Memos {
            target: AnnotationTarget::Global,
            memos: vec![MemoView {
                id,
                body: serde_json::json!({"blocks": []}),
                noted_at: 1_700_000_000_000,
                checked_at: None,
            }],
        })
        .unwrap();
        assert_eq!(
            text,
            format!(
                r#"{{"t":"memos","target":{{"t":"global"}},"memos":[{{"id":"{id}","body":{{"blocks":[]}},"noted_at":1700000000000}}]}}"#
            )
        );
    }

    #[test]
    fn コンテキスト残量の便は決まった綴りで線に乗る() {
        let card_id = CardId::new();
        let text = serde_json::to_string(&ServerMessage::ContextUsage {
            card_id,
            usage: Some(ContextUsage {
                used_percentage: 24,
                total_input_tokens: 241_479,
                context_window_size: 1_000_000,
            }),
        })
        .unwrap();
        assert_eq!(
            text,
            format!(
                r#"{{"t":"context_usage","card_id":"{card_id}","usage":{{"used_percentage":24,"total_input_tokens":241479,"context_window_size":1000000}}}}"#
            )
        );

        // **「まだ分からない」は `null` で線に乗る。欄ごと消えるのではない。**
        // 消える形にすると、受け取る側で「欄が無い」と「値が無い」が混ざる
        let text = serde_json::to_string(&ServerMessage::ContextUsage {
            card_id,
            usage: None,
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"context_usage","card_id":"{card_id}","usage":null}}"#)
        );
    }

    #[test]
    fn 使用上限の便は決まった綴りで線に乗る() {
        let agent_id = AgentId::new();
        let uuid = agent_id.0;
        let text = serde_json::to_string(&ServerMessage::RateLimits {
            agent_id: Some(agent_id),
            limits: RateLimits {
                windows: vec![
                    RateLimitWindow {
                        name: "five_hour".to_string(),
                        used_percentage: 41,
                        resets_at: 1_757_000_000,
                    },
                    RateLimitWindow {
                        name: "seven_day".to_string(),
                        used_percentage: 63,
                        resets_at: 1_757_400_000,
                    },
                ],
            },
            // **指紋が無いときは、線に欄ごと現れない。** 既存の綴りを1文字も
            // 変えないための約束（`ServerMessage::RateLimits` の doc）
            login: None,
        })
        .unwrap();
        assert_eq!(
            text,
            format!(
                r#"{{"t":"rate_limits","agent_id":"{uuid}","limits":{{"windows":[{{"name":"five_hour","used_percentage":41,"resets_at":1757000000}},{{"name":"seven_day","used_percentage":63,"resets_at":1757400000}}]}}}}"#
            )
        );

        // **`card_id` が線に乗らない。** 使用上限はその PC のものなので、カードを
        // 名乗らせると「最後に報告したカード」という無意味な区別が線に乗る
        assert!(!text.contains("card_id"));

        // **局所モードは `agent_id` が `null` で乗る。** 欄ごと消える形にすると、
        // 受け取る側で「どの PC か分からない」と「この機械自身のもの」が混ざる
        let text = serde_json::to_string(&ServerMessage::RateLimits {
            agent_id: None,
            limits: RateLimits { windows: vec![] },
            login: None,
        })
        .unwrap();
        assert_eq!(
            text,
            r#"{"t":"rate_limits","agent_id":null,"limits":{"windows":[]}}"#
        );
    }

    /// **ログインの指紋は、在るときだけ線に乗り、往復して戻る。**
    ///
    /// 欄を足したのに載らない・戻らないと、受け口はいつまでも「分からない」を
    /// 受け取り、**別アカウントへ切り替えても使用上限が入れ替わらない**（元の不具合）。
    #[test]
    fn ログインの指紋は在るときだけ線に乗る() {
        let 便 = ServerMessage::RateLimits {
            agent_id: None,
            limits: RateLimits { windows: vec![] },
            login: Some(ClaudeLoginFingerprint("0123456789abcdef".to_string())),
        };
        let text = serde_json::to_string(&便).unwrap();
        assert_eq!(
            text,
            r#"{"t":"rate_limits","agent_id":null,"limits":{"windows":[]},"login":"0123456789abcdef"}"#
        );
        assert_eq!(
            serde_json::from_str::<ServerMessage>(&text).unwrap(),
            便,
            "往復で指紋が落ちている"
        );

        // **欄を持たない古い名乗りも受ける。** 版を上げないので、欠けた便が来る道が残る
        let 古い = r#"{"t":"rate_limits","agent_id":null,"limits":{"windows":[]}}"#;
        assert_eq!(
            serde_json::from_str::<ServerMessage>(古い).unwrap(),
            ServerMessage::RateLimits {
                agent_id: None,
                limits: RateLimits { windows: vec![] },
                login: None,
            }
        );
    }

    #[test]
    fn 費用の便は決まった綴りで線に乗る() {
        let card_id = CardId::new();
        let text = serde_json::to_string(&ServerMessage::SessionCost {
            card_id,
            cost: SessionCost {
                // **セント単位の整数**（$64.77）。小数で持つと `SessionMeta` の `Eq` が
                // 壊れ、毎ターン動く値をそのまま関門の鍵にすると関門が素通しになる
                total_cost_cents: 6477,
                total_api_duration_ms: 812_345,
                total_duration_ms: 3_600_000,
                total_lines_added: 1240,
                total_lines_removed: 318,
            },
        })
        .unwrap();
        assert_eq!(
            text,
            format!(
                r#"{{"t":"session_cost","card_id":"{card_id}","cost":{{"total_cost_cents":6477,"total_api_duration_ms":812345,"total_duration_ms":3600000,"total_lines_added":1240,"total_lines_removed":318}}}}"#
            )
        );
    }

    /// フロントエンド（TypeScript）は手書きの型で同じ JSON を組み立てる。
    /// 種別名が変わればここが落ちるので、両者のズレに気づける。
    #[test]
    fn 種別名はスネークケースのtフィールドで表現される() {
        let card_id = CardId::new();
        let text = serde_json::to_string(&ClientMessage::SubPty {
            card_id,
            cols: 80,
            rows: 24,
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"sub_pty","card_id":"{card_id}","cols":80,"rows":24}}"#)
        );

        let text = serde_json::to_string(&ClientMessage::PtyFlow {
            card_id,
            state: FlowState::Pause,
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"pty_flow","card_id":"{card_id}","state":"pause"}}"#)
        );

        // 起動の指定なしは `null` として運ぶ。ブラウザ側も同じ形で組み立てる。
        // **宛先はキーごと消える**（選ぶ余地の無い場面でブラウザが送らないのと同じ形）
        let text = serde_json::to_string(&ClientMessage::Spawn {
            cwd: "/home/example/dev/app".to_string(),
            permission_mode: None,
            agent_id: None,
        })
        .unwrap();
        assert_eq!(
            text,
            r#"{"t":"spawn","cwd":"/home/example/dev/app","permission_mode":null}"#
        );

        let text = serde_json::to_string(&ClientMessage::Spawn {
            cwd: "/home/example/dev/app".to_string(),
            permission_mode: None,
            agent_id: Some(crate::AgentId(uuid::uuid!(
                "11111111-1111-1111-1111-111111111111"
            ))),
        })
        .unwrap();
        assert_eq!(
            text,
            r#"{"t":"spawn","cwd":"/home/example/dev/app","permission_mode":null,"agent_id":"11111111-1111-1111-1111-111111111111"}"#
        );

        let text = serde_json::to_string(&ClientMessage::SetPermissionMode {
            card_id,
            mode: PermissionMode::new("manual"),
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"set_permission_mode","card_id":"{card_id}","mode":"default"}}"#),
            "CLI の別名 manual は正規値 default に寄せてから運ぶ"
        );

        // モデルは権限モードと違って寄せる別名が無い。受け取った値をそのまま運ぶ
        let text = serde_json::to_string(&ClientMessage::SetModel {
            card_id,
            model: ModelId::new("opus"),
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"set_model","card_id":"{card_id}","model":"opus"}}"#)
        );

        // 起こし直しはカードIDだけを運ぶ。**欄が増えていないこと**もここで固定する——
        // 材料をブラウザに持たせると、古い写しで起こし直す経路ができる（設計§4-1）。
        // 頼みの番号（実装レビュー第6回）は材料ではなく答えの宛名で、画面は付けない
        let text =
            serde_json::to_string(&ClientMessage::ReviveSession { card_id, op: None }).unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"revive_session","card_id":"{card_id}"}}"#)
        );
        let op = OpId::new();
        let text = serde_json::to_string(&ClientMessage::ReviveSession {
            card_id,
            op: Some(op),
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"revive_session","card_id":"{card_id}","op":"{op}"}}"#)
        );

        // 過去から起こす口は**カードIDを持たない**（カードはまだ無い）。`agent_id` は
        // 選択肢が無い場面でキーごと省く——`Spawn` と同じ形（設計§7-1）
        let session = crate::ClaudeSessionId::new();
        let text = serde_json::to_string(&ClientMessage::RecallSession {
            claude_session_id: session,
            permission_mode: None,
            agent_id: None,
        })
        .unwrap();
        assert_eq!(
            text,
            format!(
                r#"{{"t":"recall_session","claude_session_id":"{session}","permission_mode":null}}"#
            )
        );

        // 名前を付ける口もカードIDだけを運ぶ。**宛先の CLI セッションは載せない**——
        // 載せるとブラウザの古い写しで別のセッションへ書ける（名前付け設計§5-1）
        let text = serde_json::to_string(&ClientMessage::SetNickname {
            card_id,
            nickname: Some("あとで直すやつ".to_string()),
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"set_nickname","card_id":"{card_id}","nickname":"あとで直すやつ"}}"#)
        );

        // 消すときは `null` を運ぶ。**キーごと省かない**——省くと「触っていない」と
        // 区別が付かなくなる
        let text = serde_json::to_string(&ClientMessage::SetNickname {
            card_id,
            nickname: None,
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"set_nickname","card_id":"{card_id}","nickname":null}}"#)
        );

        let text = serde_json::to_string(&ServerMessage::Hello {
            flow_high: 262_144,
            flow_low: 32_768,
        })
        .unwrap();
        assert_eq!(text, r#"{"t":"hello","flow_high":262144,"flow_low":32768}"#);

        // 自己修復の段階も、TypeScript 側と同じ綴りになることを固定する
        let text = serde_json::to_string(&ServerMessage::Selfheal {
            phase: SelfhealPhase::RolledBack,
            detail: None,
        })
        .unwrap();
        assert_eq!(
            text,
            r#"{"t":"selfheal","phase":"rolled_back","detail":null}"#
        );
    }

    #[test]
    fn 自己修復の段階は全部スネークケースで往復する() {
        let all = [
            (SelfhealPhase::Detected, "detected"),
            (SelfhealPhase::Canary, "canary"),
            (SelfhealPhase::Testing, "testing"),
            (SelfhealPhase::Repairing, "repairing"),
            (SelfhealPhase::Verifying, "verifying"),
            (SelfhealPhase::Passed, "passed"),
            (SelfhealPhase::Swapped, "swapped"),
            (SelfhealPhase::RolledBack, "rolled_back"),
            (SelfhealPhase::Failed, "failed"),
            (SelfhealPhase::Cooldown, "cooldown"),
        ];
        for (phase, name) in all {
            assert_eq!(
                serde_json::to_string(&phase).unwrap(),
                format!(r#""{name}""#)
            );
            assert_eq!(roundtrip(&phase), phase);
        }
    }

    #[test]
    fn 知らない種別は受け取りを拒否する() {
        // 対応していないメッセージを黙って無視すると、動かない原因が追えなくなる
        let err = serde_json::from_str::<ClientMessage>(r#"{"t":"未来の種別"}"#);
        assert!(err.is_err());
    }
}
