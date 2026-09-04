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

use crate::{CardId, ModelId, PermissionMode, SessionMeta, SessionStatus, Timestamp, TreeNode};
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

/// 自己修復の進み具合（設計§9）。
///
/// 文字列ではなく型にしてあるのは、送り手と受け手が別々の言語で手書きされているため。
/// 綴り違いはコンパイルを通ってしまい、「進行が画面に出ない」という追いにくい形でしか
/// 表に出ない。段階の増減は [`ServerMessage::Selfheal`] と同じく4箇所同期の対象。
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
    /// カードが見つからない（持ち主違いを含む。**呼び分けない**）
    NotFound,
    /// 上のどれでもないもの
    #[default]
    Other,
}

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
    /// セッションを終了させる（PTY プロセスを落とす）
    Kill {
        card_id: CardId,
    },
    /// 終了済みのカードを一覧から消す
    Archive {
        card_id: CardId,
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
    },
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
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use crate::{ClaudeSessionId, Node, NodeId, PermissionMode, ProjectId};

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
            ClientMessage::ReviveSession { card_id },
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
            ClientMessage::Kill { card_id },
            ClientMessage::Archive { card_id },
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
        })
        .unwrap();
        assert!(json.contains(r#""kind":"revive""#), "{json}");
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
            },
            ServerMessage::TranscriptAppend {
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
            ServerMessage::TranscriptReset { card_id },
            ServerMessage::BusStatus {
                state: BusState::Degraded,
                detail: Some("連絡係に繋がりません".to_string()),
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
            },
            ServerMessage::Error {
                card_id: None,
                message: "claude を起動できませんでした".to_string(),
                kind: ErrorKind::Other,
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
        // 材料をブラウザに持たせると、古い写しで起こし直す経路ができる（設計§4-1）
        let text = serde_json::to_string(&ClientMessage::ReviveSession { card_id }).unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"revive_session","card_id":"{card_id}"}}"#)
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
