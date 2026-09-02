//! サーバ・フロントエンド・パーサが共有するドメインモデル（設計§3）。
//!
//! このクレートは「型の定義」だけを持ち、振る舞いは持たない。自己修復機構（設計§9）が
//! 変更してよいのは transcript-parser だけで、このクレートは変更禁止の共有境界にあたる。
//! 未知のフォーマットは必ず [`Node::Unknown`] へ写像することで、この制約と両立させる。

pub mod a2s;
pub mod client_log;
pub mod frame;
pub mod fs;
pub mod ipc;
pub mod logs;
pub mod ws;

use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

/// エポックからのミリ秒。
///
/// 日時ライブラリに依存せず、フロントエンド（TypeScript）がそのまま `number` として
/// 扱える表現を選んでいる。共有境界であるこのクレートの依存を増やさないための判断。
pub type Timestamp = i64;

/// ダッシュボード内で不変のセッションカードID。
///
/// UI とPTYプロセスはこのIDに紐づく。CLI 側のセッションID（[`ClaudeSessionId`]）は
/// resume などで変わりうるが、こちらは生涯不変。先行事例で頻発した「ID追跡切れ」を
/// 構造的に防ぐための分離（設計§3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CardId(pub Uuid);

impl CardId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for CardId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for CardId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Claude Code CLI 側のセッションID。resume や fork で変わりうる「属性」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ClaudeSessionId(pub Uuid);

impl ClaudeSessionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ClaudeSessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for ClaudeSessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// 登録済みの PC（セッションホスト）のID（セルフホスト化設計§3-1）。
///
/// ローカルモードでは**セッションホストという単位が存在しない**ので、セッションの
/// [`SessionMeta::agent_id`] は `None` になる。「1台だけの PC」を表す ID を作って
/// 埋めることはしない——ローカルには結び付ける相手（`agents` の行）が無く、
/// 存在しないものを指す ID は、後から本物の PC が繋がったときに区別できなくなる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AgentId(pub Uuid);

impl AgentId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for AgentId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for AgentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// 作業ディレクトリの絶対パス。一覧画面のグループ化キーになる。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectId(pub String);

impl fmt::Display for ProjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// セッションの権限モード（`--permission-mode` の値）。
///
/// **列挙型にしない。** CLI 側はモードを増やしてきた実績があり（`auto` / `dontAsk` は
/// 比較的新しい）、知らない値で古いダッシュボードが落ちるほうが困る。知らない値は
/// **知らないまま運んで、そのまま表示する**（[`Node::Unknown`] と同じ考え方）。
/// 表示名・危険度・CLI へ渡す形は、受け手側が表で引く。
///
/// # 正規値は `default`、CLI へ渡す形は `manual`
///
/// 「毎回確認する」モードは、フックの payload と設定ファイルでは **`default`**、
/// CLI の `--permission-mode` では **`manual`** という2つの名前を持つ（`--help` の
/// choices に `default` は無い）。混ざると「manual で起動したのにフックが default と
/// 言ってきて、別のモードへ変わったように見える」ので、**運ぶ値は常に正規値へ寄せる**。
/// 変換規則をここに置いているのは、サーバもブラウザも同じ規則で判断する必要があるため。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PermissionMode(pub String);

impl PermissionMode {
    /// CLI が別名として受け付ける綴り。
    pub const MANUAL_ALIAS: &'static str = "manual";
    /// フックと設定ファイルが使う正規の綴り。
    pub const DEFAULT: &'static str = "default";

    /// 受け取った文字列を正規値へ寄せて包む。知らない値はそのまま通す。
    pub fn new(raw: impl Into<String>) -> Self {
        let raw = raw.into();
        if raw == Self::MANUAL_ALIAS {
            return Self(Self::DEFAULT.to_string());
        }
        Self(raw)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PermissionMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// セッションが使っている LLM モデル（`/model` の値、または CLI が名乗るフルID）。
///
/// **列挙型にしない。** 理由は [`PermissionMode`] と同じだが、こちらのほうが強く効く。
/// モデルは権限モードよりずっと頻繁に増えるので、列挙型にすると Anthropic が新しい
/// モデルを出した瞬間に古いダッシュボードが未知の値で落ちる。
///
/// # 2つの顔があることに注意
///
/// この型が運ぶ文字列には、出どころの違う2種類がある。
///
/// | 出どころ | 例 | どこで使うか |
/// |---|---|---|
/// | 切り替え先として利用者が選ぶ**別名** | `opus` / `sonnet` / `default` | `/model <値>` として送る |
/// | CLI が名乗る**フルID** | `claude-opus-5` | いま動いているモデルとして受け取る |
///
/// 別名を送ってもフルIDが返ってくるので、**送った値と返る値は一致しない**。
/// 「いま何で動いているか」の正は常に CLI 側にある（設計§1）。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ModelId(pub String);

impl ModelId {
    /// 指定を消してアカウントの既定へ戻す特別な値。モデル名ではない。
    pub const DEFAULT: &'static str = "default";

    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ModelId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// ダッシュボード自身の版（CICD設計§2）。
///
/// **列挙型にしない。** 理由は [`PermissionMode`] や [`ModelId`] と同じで、これから出る
/// 版を古い画面が知らないのは当たり前だから。知らない値でも**表示だけはできる**必要がある。
///
/// # 並び順は自前で3つ組にする
///
/// `semver` クレートは入れない（実行時の直接依存を増やさない）。素の文字列比較だと
/// `0.10.0 < 0.9.0` になってしまうので、`0.10.2` のような3つ組として読んで比べる。
/// **3つ組として読めない版**（試作版の接尾辞など）は大小を判定せず、**末尾へ置く**——
/// 並び順が分からないことと、選べないことは別。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VersionId(pub String);

impl VersionId {
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `0.10.2` のような3つ組として読む。読めなければ `None`。
    pub fn triple(&self) -> Option<(u64, u64, u64)> {
        let mut parts = self.0.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        // 4つ目があるものは3つ組ではない。読めたふりをしない
        parts.next().is_none().then_some((major, minor, patch))
    }
}

impl Ord for VersionId {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        match (self.triple(), other.triple()) {
            // 3つ組が同じでも綴りが違えば別物なので、綴りで決着させる（`Eq` と揃える）
            (Some(left), Some(right)) => left.cmp(&right).then_with(|| self.0.cmp(&other.0)),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => self.0.cmp(&other.0),
        }
    }
}

impl PartialOrd for VersionId {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for VersionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// 版の出どころ（CICD設計§6）。**消せるかどうかがここで決まる。**
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VersionOrigin {
    /// 入れる側（配布インストーラ）が置いたもの。**消す道の持ち物なので消さない。**
    Installed,
    /// 保管庫（`<state_dir>/versions/`）にあるもの。
    Stored,
}

/// 版の一覧の1行（CICD設計§2）。
///
/// **実パスを持つのは、同じ版名の行が複数並ぶため。** ソースからビルドした版と配った版は
/// 同じ番号を名乗る（ワークスペースの版は1箇所にしかない）ので、開発者の機械では初日から
/// 「入れる側」「保管庫」「走っている版」の3行が同名で並ぶ。名前だけでは選びようがない。
///
/// パスを `PathBuf` ではなく文字列で持つのは、これが**画面へ出すための値**だから。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionEntry {
    pub version: VersionId,
    pub origin: VersionOrigin,
    /// `agentdashboard` 実行ファイルの絶対パス。
    pub path: String,
    /// 3本揃っていて、3本とも同じ版を名乗るか（CICD設計§6）。
    pub usable: bool,
    /// いまこの実行ファイルで動いているか。
    pub running: bool,
    /// ポインタが指しているか（＝次に起こすときの版）。
    pub selected: bool,
    pub size_bytes: u64,
    /// 選べない理由（選べるときは `None`）。
    ///
    /// **選べない版を選択肢から消さず、理由を添える**（CICD設計§14）。消してしまうと
    /// 「置いたはずの版が出てこない」になり、原因まで辿れない。理由を作れるのは
    /// サーバ側だけ——3本の版が食い違っていることは、実行ファイルに聞かないと分からない。
    #[serde(default)]
    pub reason: Option<String>,
}

/// セッションを抱える機械の資源（起こし直し設計§18）。
///
/// **サーバではなく PC の値である。** セルフホストでは擬似ターミナルを持っているのは
/// PC なので、サーバが自分のメモリを答えると**別の機械の話**になる。
///
/// # なぜ `fits_now` まで運ぶのか
///
/// 「何枚入るか」の規則を Rust と TypeScript の2箇所に書くと、**画面が「入る」と
/// 言ったものを PC が断る**（あるいは逆）ことが起こる。戻せるかの判定
/// （起こし直し設計§3-3）は二重に持ってよいと決めたが、あちらはずれても
/// 「押せてしまってサーバが断る」に倒れるだけだった。**こちらはずれると機械が死ぬ。**
///
/// だから**数えるのは PC 側の1箇所**にして、画面は受け取った数と対象の枚数を比べるだけにする。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostResources {
    /// 積んでいるメモリ（MB）
    pub total_mb: u64,
    /// いま渡せるメモリ（MB）。`MemAvailable` であって `MemFree` ではない
    pub available_mb: u64,
    /// スワップの空き（MB）。**数える対象には入れない**——ここへ落ちた時点で
    /// 機械は使い物にならないので、「入る」の根拠にしてはいけない。見せるだけ
    pub swap_free_mb: u64,
    /// 起こし直し1枚あたりの見積もり（MB。設定 `revive_estimate_mb`）
    pub estimate_mb: u64,
    /// 使い切らずに残す余白（MB。設定 `revive_headroom_mb`）
    pub headroom_mb: u64,
    /// **いま何枚起こし直せるか。** `(available − headroom) / estimate` の切り捨て。
    ///
    /// **`None` は「数えない」**（`estimate_mb = 0`＝歯止めを外している）。
    /// 以前はここへ番兵（`u32::MAX`）を載せていたが、**数として運ぶと見せるところで
    /// 1つずつ潰すことになる**——CLI が「いま 4294967295 枚まで起こし直せます」と
    /// 出していた（コードレビュー対応2）。
    ///
    /// 受け取る側は、**`None` を「歯止め無しで進む」**として扱う（分からないことを
    /// 理由に止めない）。画面から見ると「聞けなかった」と同じふるまいでよいが、
    /// **CLI は言い分ける**——人が読む答えなので、外しているのか聞けなかったのかは別の話。
    pub fits_now: Option<u32>,
}

/// 小窓に表示するセッションの状態（設計§5 の導出結果）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionStatus {
    /// PTY 起動済みだが SessionStart フックをまだ受けていない
    Starting,
    Working,
    WaitingPermission,
    WaitingInput,
    /// Working のままイベントが途絶した（ハング検知）
    Stalled,
    Ended {
        ok: bool,
    },
    /// PTY 出力はあるのにフックが1件も届いていない等、判断できない状態
    Unknown,
}

/// 一覧画面の小窓1枚分の情報。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub card_id: CardId,
    pub project: ProjectId,
    pub claude_session_id: Option<ClaudeSessionId>,
    /// いまの権限モード。
    ///
    /// `None` は「まだ分からない」— 起動時に指定せず、フックも端末フッタも
    /// まだ何も教えてくれていない状態。空欄にするのではなく **分からないことを
    /// 分からないと表示できる**ようにするための `Option`（`hooks_seen` と同じ理由）。
    pub permission_mode: Option<PermissionMode>,
    /// CLI が名乗った、いま動いているモデルのフルID（設計§4）。
    ///
    /// `None` は「モデルが無い」ではなく **まだ CLI が名乗っていない**。注入した
    /// `statusLine` が最初の値を送ってくるまでは必ずここから始まるので、画面は
    /// これを「不明」と出す。
    pub model: Option<ModelId>,
    /// 画面に出すモデルの名前（`Opus 5` など）。
    ///
    /// [`SessionMeta::model`] と2つ持つのは、**版番号をこちらで管理しないため**。
    /// 別名がどの版に解決されるかはプロバイダによって違う（`opus` は Anthropic API
    /// なら Opus 5、Microsoft Foundry なら Opus 4.6）ので、こちらの表には書けない。
    /// CLI が `statusLine` 経由で `display_name` をくれるので、それをそのまま出す。
    pub model_label: Option<String>,
    /// 切替を要求したが、まだ CLI が名乗り直していない値（設計§5 の楽観更新）。
    ///
    /// `statusLine` が走る契機に**モデル変更は入っていない**ので、`/model` を送った
    /// 直後は確定値が古いままになる。その間「押した手応え」を返すために要求値を先に
    /// 出すが、これは推測でしかないので確定値とは**別のフィールドに分けて持つ**。
    /// 画面はこれがあるあいだ、確定した値とは違う見た目にする。
    ///
    /// bool の印ではなく値そのものを持つのは、「Sonnet へ切替中」と具体的に出せるため。
    pub model_requested: Option<ModelId>,
    pub status: SessionStatus,
    /// 稼働中サブエージェント数。バッジ表示用で、status とは独立に増減する
    pub subagent_active: u32,
    pub last_activity_at: Timestamp,
    /// Stop フックの `last_assistant_message`。JSONL を読まずに小窓へ要約を出せる
    pub last_assistant_message: Option<String>,
    pub created_at: Timestamp,
    /// フックを1件でも受け取ったか（設計§11 の「フック未受信」警告の判定材料）。
    ///
    /// [`SessionStatus::Unknown`] には「フックが来ない」以外の理由もありうるので、
    /// *なぜ* 判断できないのかを画面に出すにはこの印が要る。フックが届かない原因は
    /// 設定の注入漏れやポートの塞がりで、利用者が直せるものが多い。
    pub hooks_seen: bool,
    /// どの PC のセッションか（セルフホスト化設計§3-1）。**ローカルモードは `None`**。
    ///
    /// 一覧に PC 名バッジを出すための材料（要件4-4「どの PC のセッションかは一覧で
    /// 判別できる」）。名前ではなく ID を運ぶのは、PC の名前が後から変わりうるため。
    pub agent_id: Option<AgentId>,
    /// この記録を持っている PC と、いま繋がっているか（セルフホスト化設計§6-3）。
    ///
    /// # なぜ [`SessionStatus`] の一種にしないのか
    ///
    /// 切断は「最後に知っていた状態」を**上書きする情報ではなく、その鮮度に関する
    /// 情報**だから。要件2-3 の「作業中のまま固まってはならない」は、状態を偽らずに
    /// 「古いこと」を明示することで満たす——画面には「作業中（接続断）」と出る。
    ///
    /// ローカルモードでも意味を持つ。DB が真実になったので、**再起動前のカードが
    /// 記録として戻ってくる**（PTY は道連れで死んでいる）。それを `false` で示す。
    pub agent_connected: bool,
    /// 帰属アカウント名（表示用。セルフホスト化設計§3-1）。
    ///
    /// 権限そのものではない——**権限の源はペアリングトークン**（§8-5）で、これは
    /// 画面に出すための名前。ローカルモードはアカウントを表に出さないので `None`。
    pub account: Option<String>,
    /// `.agent-dashboard.toml` がこのセッションについて名乗ったアカウント名（設計§8-5）。
    ///
    /// # [`SessionMeta::account`] と分けて持つ理由
    ///
    /// あちらは**サーバが決めた帰属**、こちらは**セッションホストが申告した希望**。
    /// 同じ欄に入れると、上書きされたのか一致したのかを後から区別できなくなる。
    /// セルフホストでは食い違いが警告の材料になり、ローカルモードでは一覧の
    /// 絞り込み（攻撃者のいない自己整理機能）としてだけ働く。
    ///
    /// **持っていない権限は名乗れない。** ここに他人の名前を書いても帰属は動かない。
    pub toml_account: Option<String>,
    /// CLI が付けたセッションの名前（`--resume` の一覧に出るもの。設計§5-1）。
    ///
    /// `None` は「まだ付いていない」。名前は最初のターンのあとに付くので、
    /// **起こした直後は必ずここから始まる**。
    ///
    /// # なぜ `#[serde(default)]` を書くのか
    ///
    /// **動作としては要らない。** `Option` なので、欄を持たない古い版の名乗りでも
    /// serde が `None` として受ける（フェーズ1で実測。設計§5-1-1）。
    ///
    /// **それでも書くのは意図を残すため**である。属性が付いていれば「ここは欠けてよい欄だ」
    /// と1行で分かる。書かないでおくと、**型を `Option` から外した瞬間に静かに壊れる**——
    /// そのとき壊れるのは名前の表示ではなく、**カードの報告そのもの**である。
    #[serde(default)]
    pub session_title: Option<String>,
    /// **その枠の中での**カードの並び（並べ替え設計§9-2）。小さいほうが先。
    ///
    /// # セッションホストはこれを知らない
    ///
    /// 並びは**記録の側の性質**で、生まれた時刻や名前と同じ扱いになる。セッションホストは
    /// 0 を置いて名乗り、**サーバが記録の値で上書きする**。上書きしないと、報告が届く
    /// たびに並べ替えた結果が 0 へ戻る。
    ///
    /// # なぜ `#[serde(default)]` を書くのか
    ///
    /// 欄を持たない古い版の名乗りを 0 として受けるため。**版（`A2S_VERSION`）は
    /// 上げない**ので、配ってある PC はそのまま繋がり続ける。
    #[serde(default)]
    pub position: i32,
    /// **利用者が付けた名前**（名前付け設計§4）。`None` は「まだ付けていない」。
    ///
    /// CLI が付ける [`SessionMeta::session_title`] とは**別物**である。あちらは履歴に
    /// 書かれた `ai-title` を運んでいるだけで、パーサが読むたびに上書きされる。
    /// 同じ欄へ載せると、**名前を付けた直後に CLI の名前へ潰される**。
    ///
    /// # セッションホストはこれを知らない
    ///
    /// 名前は `ClaudeSessionId` に紐づく**記録の側の性質**で、[`SessionMeta::position`]
    /// と同じ扱いになる。セッションホストは `None` を置いて名乗り、**サーバが記録の値で
    /// かぶせる**。報告の値は捨てる。
    ///
    /// # なぜ `#[serde(default)]` を書くのか
    ///
    /// 欄を持たない古い版の名乗りを `None` として受けるため。**版（`A2S_VERSION`）は
    /// 上げない**ので、配ってある PC はそのまま繋がり続ける。
    #[serde(default)]
    pub nickname: Option<String>,
}

/// 利用者が付けたものの**宛先**（名前付け設計§3-2）。
///
/// 名前もメモも「人がカードへ付けたもの」で、**宛先が1つの値として表せていれば
/// 画面も口も記録も1組で済む**。入れ物の形は違う（名前は欄1つ、メモは表1つ）ので
/// **入れ物は共有しない**——共有するのはこの型と、記録側を正とする作法だけである。
///
/// | 枝 | 何を指すか |
/// |---|---|
/// | [`AnnotationTarget::Global`] | どのセッションにも紐づかない、アカウントに1つのもの |
/// | [`AnnotationTarget::Session`] | 1つの CLI セッション |
///
/// # なぜ `CardId` ではなく `ClaudeSessionId` なのか
///
/// **乗り換えても付いてこなければならない**（名前付け要件4）。カードは `--resume` で
/// 別のセッションへ移れるので、カードに紐づけると**別のセッションに前の名前が残る**。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum AnnotationTarget {
    /// アカウントに1つ。特定のセッションに紐づかない。
    Global,
    /// 1つの CLI セッション。
    Session {
        /// 宛先の CLI セッション。
        claude_session_id: ClaudeSessionId,
    },
}

/// 利用者が付けた名前の長さの上限（名前付け設計§10）。
///
/// カードは幅 294px・両側の余白 12px ずつ・字の大きさ 12px なので、**日本語で約22文字、
/// 英数字で約40文字**で「…」に切れる。ここはその9倍ほどで、**長い名前を書きたい人を
/// 止めず、記録に無制限のものを入れない**線として置いてある。
///
/// **画面ではなく保存側で断る。** 画面だけで止めると CLI から入る。
pub const NICKNAME_MAX_CHARS: usize = 200;

/// 受け取った名前を整える。断るべきものは `Err` で理由を返す（名前付け設計§10）。
///
/// | 決め | 何をするか |
/// |---|---|
/// | 前後の空白 | 落とす |
/// | 空になったもの | `Ok(None)` ——「消す」と同義 |
/// | 改行を含む | **断る。** カードは1行で「…」に切る作りなので、切った先が読めなくなる |
/// | [`NICKNAME_MAX_CHARS`] を超える | **断る** |
///
/// 数えるのは**文字**であってバイトではない。日本語で 200 文字書ける。
pub fn normalize_nickname(raw: &str) -> Result<Option<String>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.contains(['\n', '\r']) {
        return Err("名前に改行は使えません".to_string());
    }
    let chars = trimmed.chars().count();
    if chars > NICKNAME_MAX_CHARS {
        return Err(format!(
            "名前が長すぎます（{chars} 文字。{NICKNAME_MAX_CHARS} 文字まで）"
        ));
    }
    Ok(Some(trimmed.to_string()))
}

impl SessionMeta {
    /// このカードを起こし直せるか（接続断のカードを復旧ボタンで戻す 設計§3-1・§3-4）。
    ///
    /// 規則は1つ——**いま操作できる実体が無く、かつ戻す先がある。**
    ///
    /// | 何 | なぜ |
    /// |---|---|
    /// | `!agent_connected` | PC が居ない、または**PC は居るがそのカードを持っていない**。繋ぎ直しのとき、サーバはその PC の全カードを一旦倒し、報告し直されたものだけ戻す。だから起き直して失われたカードは、PC が繋がっていても倒れたまま残る |
    /// | `status` が `Ended` | 擬似ターミナルが実際に消えた。PC は繋がっていることもある |
    /// | `claude_session_id` がある | `--resume` に渡す先。無ければ戻しようが無い |
    ///
    /// **構成で分岐しない。** ローカルの再起動・セッションホストの再起動・サーバだけの
    /// 再起動の3通りが、この1つの規則で表せる（サーバだけ落とした場合は PC が繋ぎ直して
    /// 自分で印を戻すので、そもそも対象にならない）。
    ///
    /// # ここに置いた理由
    ///
    /// **Rust 側で判定が要る場所が2つある**——サーバの断り（`server_core::ws`）と、
    /// CLI の `session revive --all` の絞り込み。2箇所に書くと、片方だけ直したときに
    /// 「CLI では飛ばされるのにサーバは通す」が起きる。
    ///
    /// ブラウザ側（TypeScript）は同じ規則を書き直す。**突き合わせる台帳は作らない**
    /// （設計§3-3）——ずれても「押せてしまってサーバが断る」に倒れるだけで、
    /// 危険側には倒れないため。
    pub fn revivable(&self) -> bool {
        let 実体が無い =
            !self.agent_connected || matches!(self.status, SessionStatus::Ended { .. });
        実体が無い && self.claude_session_id.is_some()
    }
}

/// JSONL レコードの `uuid` に対応するノードID。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(pub String);

impl fmt::Display for NodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// ツールコールの完了状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    /// tool_use は観測したが対応する toolUseResult がまだ来ていない
    Pending,
    Ok,
    Error,
}

/// 親のツールコールにぶら下がるサブエージェントの参照情報。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentRef {
    pub agent_type: String,
    /// `<セッションID>/subagents/agent-*.jsonl` へのパス
    pub transcript_path: String,
    pub spawn_depth: u32,
}

/// 正規化イベントモデル。transcript-parser の出力単位（設計§3）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Node {
    UserMessage {
        text: String,
    },
    AssistantText {
        text: String,
    },
    /// アシスタントの思考（`thinking` ブロック）。
    ///
    /// 実データでは assistant の content ブロックの相当数を占めるため、受け皿が無いと
    /// 思考が丸ごと [`Node::Unknown`] に落ちる。表示は既定で折り畳む想定。
    Thinking {
        text: String,
    },
    ToolCall {
        name: String,
        input: serde_json::Value,
        result: Option<serde_json::Value>,
        status: ToolStatus,
        /// サブエージェントを起動するツールの場合、子ツリーのマウント先情報が入る
        subagent: Option<SubagentRef>,
    },
    Subagent {
        agent_type: String,
        spawn_depth: u32,
    },
    /// 送った画像（`メッセージに画像を添付できるようにする` 設計§10-1）。
    ///
    /// **画像そのものは載せない。** 載せるのは置き場所・媒体型・元の名前だけで、
    /// 絵は履歴を開いたときに生ファイルの口から取り返す（§10-3）。base64 を
    /// ここへ載せると、履歴を1画面ぶん配るたびに画像が丸ごと線に乗る——
    /// 実測で20枚のターン1本が 854,952 バイトになっている（§19 前提2）。
    ///
    /// **`path` は `None` になりうる。** claude がクリップボードから直に受けた画像には
    /// ディスク上の置き場所が無く、置き場所を運ぶ相棒レコードも出ない（§21 読み替え1）。
    /// そのときは**絵は出せないが「画像があった」ことは出せる**。
    ///
    /// 欄に `#[serde(default)]` を付けるのは、**古い記録を読み直すため**。
    /// `transcript_nodes.payload` はこの型を丸ごと JSON で持っているので、
    /// 欄を必須にすると、この種別を知らない版が書いた行が解けなくなる。
    Image {
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        media_type: Option<String>,
        /// 利用者が付けていた名前。**ディスク上の採番した名前とは別物**（§5）
        #[serde(default)]
        file_name: Option<String>,
    },
    /// 寛容パースの受け皿。未知の type / 構造はすべてここへ写像する。
    ///
    /// このバリアントがあるおかげで、パーサは共有境界（このクレート）を変更せずに
    /// 新フォーマットへ対応できる。自己修復の変更範囲を transcript-parser だけに
    /// 限定するための要（設計§14 の引き継ぎ事項1）。
    Unknown {
        record_type: String,
        raw: serde_json::Value,
    },
}

/// スレッディング層が組み立てるツリーの1ノード。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TreeNode {
    pub id: NodeId,
    pub parent: Option<NodeId>,
    pub node: Node,
    pub ts: Timestamp,
    /// 何本目の会話の枝に属するか（0 始まり）。
    ///
    /// `/rewind` は JSONL を物理的に巻き戻さず、**同じファイルの末尾に2つ目の根として
    /// 追記する**（設計§16 の実測）。そのため巻き戻して捨てたはずのやりとりも履歴に
    /// 残り続ける。番号を振っておくと、画面が「最新の枝以外は畳む」判断をできる。
    ///
    /// 増えるのは本体ファイルに `parentUuid` を持たないユーザ発言が現れたとき。
    /// サブエージェントのファイルは、起動元のツールコールの枝を引き継ぐ。
    #[serde(default)]
    pub branch: u32,
}

#[cfg(test)]
mod tests {
    // テスト名は日本語で書いている。英大文字（JSON 等）が混ざると snake_case 判定に
    // 引っかかるだけで実害はないため、このモジュールに限って許可する。
    #![allow(non_snake_case)]

    use super::*;
    use serde_json::json;

    fn roundtrip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let text = serde_json::to_string(value).expect("シリアライズできること");
        serde_json::from_str(&text).expect("デシリアライズできること")
    }

    #[test]
    fn id型はJSONでは裸の値として表現される() {
        let card = CardId::new();
        let text = serde_json::to_string(&card).unwrap();
        assert_eq!(text, format!("\"{}\"", card.0));

        let project = ProjectId("/home/example/dev/app".to_string());
        assert_eq!(
            serde_json::to_string(&project).unwrap(),
            "\"/home/example/dev/app\""
        );
    }

    /// 起こし直しの判定を当てるための1枚。**既定は「動いている、戻す先つき」**——
    /// つまり戻せない側から始める。ここを戻せる側にすると、条件を1つ落とした実装でも
    /// 全部通ってしまう。
    fn 生きたカード() -> SessionMeta {
        SessionMeta {
            card_id: CardId::new(),
            project: ProjectId("/home/example/dev/app".to_string()),
            claude_session_id: Some(ClaudeSessionId::new()),
            permission_mode: None,
            model: None,
            model_label: None,
            model_requested: None,
            status: SessionStatus::Working,
            subagent_active: 0,
            last_activity_at: 0,
            last_assistant_message: None,
            created_at: 0,
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
    fn 実体があるカードは起こし直せない() {
        // 走っている claude を畳んでから起こし直すことになる。押した人には
        // 「戻した」としか見えないので、規則の側で塞ぐ（設計§3-5）
        assert!(!生きたカード().revivable());
    }

    #[test]
    fn 接続断のカードは起こし直せる() {
        let mut meta = 生きたカード();
        meta.agent_connected = false;
        assert!(meta.revivable(), "抜け殻がこの機能の本命");
    }

    #[test]
    fn 終了したカードはPCが繋がっていても起こし直せる() {
        // 擬似ターミナルが実際に消えた側。PC は繋がったままのことがある
        let mut meta = 生きたカード();
        meta.status = SessionStatus::Ended { ok: true };
        assert!(meta.revivable());
        meta.status = SessionStatus::Ended { ok: false };
        assert!(meta.revivable(), "異常終了も戻せる側");
    }

    #[test]
    fn 呼び戻す先を持たないカードは起こし直せない() {
        // `--resume` に渡す値が無い。実体が無くても戻しようが無い
        let mut meta = 生きたカード();
        meta.agent_connected = false;
        meta.claude_session_id = None;
        assert!(!meta.revivable());
    }

    #[test]
    fn session_statusは全バリアントが往復する() {
        let all = [
            SessionStatus::Starting,
            SessionStatus::Working,
            SessionStatus::WaitingPermission,
            SessionStatus::WaitingInput,
            SessionStatus::Stalled,
            SessionStatus::Ended { ok: true },
            SessionStatus::Ended { ok: false },
            SessionStatus::Unknown,
        ];
        for status in all {
            assert_eq!(roundtrip(&status), status);
        }
    }

    #[test]
    fn session_metaが往復する() {
        let meta = SessionMeta {
            card_id: CardId::new(),
            project: ProjectId("/home/example/dev/app".to_string()),
            claude_session_id: Some(ClaudeSessionId::new()),
            permission_mode: Some(PermissionMode::new("acceptEdits")),
            model: Some(ModelId::new("claude-opus-5")),
            model_label: Some("Opus 5".to_string()),
            model_requested: Some(ModelId::new("sonnet")),
            status: SessionStatus::WaitingPermission,
            subagent_active: 2,
            last_activity_at: 1_700_000_000_000,
            last_assistant_message: Some("実装が完了しました".to_string()),
            created_at: 1_699_999_000_000,
            hooks_seen: true,
            agent_id: Some(AgentId::new()),
            agent_connected: false,
            account: Some("mao".to_string()),
            toml_account: None,
            session_title: None,
            position: 0,
            nickname: None,
        };
        assert_eq!(roundtrip(&meta), meta);
    }

    #[test]
    fn session_metaのPCまわりは省略できない() {
        // TypeScript 側と手で二重に定義しているので（PJTガイドライン）、片方だけ
        // 直しても Rust は通ってしまう。**JSON の形そのもの**を突き合わせて、
        // 増えた4つが確かに線を渡っていることを見る
        let meta = SessionMeta {
            card_id: CardId(uuid::uuid!("00000000-0000-0000-0000-000000000001")),
            project: ProjectId("/p".to_string()),
            claude_session_id: None,
            permission_mode: None,
            model: None,
            model_label: None,
            model_requested: None,
            status: SessionStatus::Working,
            subagent_active: 0,
            last_activity_at: 1,
            last_assistant_message: None,
            created_at: 1,
            hooks_seen: false,
            agent_id: None,
            agent_connected: true,
            account: None,
            toml_account: None,
            session_title: None,
            position: 0,
            nickname: None,
        };
        assert_eq!(
            serde_json::to_string(&meta).unwrap(),
            r#"{"card_id":"00000000-0000-0000-0000-000000000001","project":"/p","claude_session_id":null,"permission_mode":null,"model":null,"model_label":null,"model_requested":null,"status":{"kind":"working"},"subagent_active":0,"last_activity_at":1,"last_assistant_message":null,"created_at":1,"hooks_seen":false,"agent_id":null,"agent_connected":true,"account":null,"toml_account":null,"session_title":null,"position":0,"nickname":null}"#
        );
    }

    #[test]
    fn session_metaは利用者が付けた名前を運ぶ() {
        // 対になる TypeScript 側：`web/src/lib/protocol.test.ts` の
        // `SessionMeta は利用者が付けた名前を運ぶ`。
        let mut meta = 生きたカード();
        meta.nickname = Some("あとで直すやつ".to_string());
        assert_eq!(roundtrip(&meta).nickname.as_deref(), Some("あとで直すやつ"));

        // 付けていないカードはここを通る
        meta.nickname = None;
        assert_eq!(roundtrip(&meta).nickname, None);
    }

    #[test]
    fn 利用者の名前とcliの名前は別々に残る() {
        // **これが別表にした理由そのもの**（名前付け設計§4-1）。同じ欄へ載せると、
        // パーサが `ai-title` を運んだ瞬間に利用者の名前が消える。
        let mut meta = 生きたカード();
        meta.nickname = Some("あとで直すやつ".to_string());
        meta.session_title = Some("TODOを完了に変更し作業内容をまとめる".to_string());
        let back = roundtrip(&meta);
        assert_eq!(back.nickname.as_deref(), Some("あとで直すやつ"));
        assert_eq!(
            back.session_title.as_deref(),
            Some("TODOを完了に変更し作業内容をまとめる"),
            "片方がもう片方を潰さない"
        );
    }

    #[test]
    fn 名前の決まりは保存側で断る() {
        // 画面だけで止めると CLI から入る（名前付け設計§10）
        assert_eq!(
            normalize_nickname("  あとで直すやつ  ").unwrap().as_deref(),
            Some("あとで直すやつ"),
            "前後の空白は落とす"
        );
        assert_eq!(
            normalize_nickname("   ").unwrap(),
            None,
            "空白だけは「付いている」扱いにしない"
        );
        assert_eq!(normalize_nickname("").unwrap(), None, "空は消すと同義");
        assert!(
            normalize_nickname("上の行\n下の行").is_err(),
            "改行は断る。カードは1行で切るので、切った先が読めなくなる"
        );
        assert!(
            normalize_nickname(&"あ".repeat(NICKNAME_MAX_CHARS)).is_ok(),
            "上限ちょうどは通る"
        );
        assert!(
            normalize_nickname(&"あ".repeat(NICKNAME_MAX_CHARS + 1)).is_err(),
            "上限を1文字でも超えたら断る"
        );
        // 数えるのは文字であってバイトではない。日本語で 200 文字書ける
        assert!(
            "あ".repeat(NICKNAME_MAX_CHARS).len() > NICKNAME_MAX_CHARS,
            "この主張が意味を持つのは、日本語がバイトでは溢れるから"
        );
    }

    #[test]
    fn session_metaはセッション名を運ぶ() {
        // 対になる TypeScript 側：`web/src/lib/protocol.test.ts` の
        // `SessionMeta はセッション名を運ぶ`。**型はどちらも手書き**なので、片方だけ
        // 直すと「繋がるのに名前だけ出ない」形で静かに壊れる。
        let mut meta = 生きたカード();
        meta.session_title = Some("TODOを完了に変更し作業内容をまとめる".to_string());
        let back = roundtrip(&meta);
        assert_eq!(
            back.session_title.as_deref(),
            Some("TODOを完了に変更し作業内容をまとめる")
        );

        // 起こした直後は必ずここを通る。名前は最初のターンのあとに CLI が付ける
        meta.session_title = None;
        assert_eq!(roundtrip(&meta).session_title, None);
    }

    #[test]
    fn 名前の欄を持たない古い名乗りも実物の型で解ける() {
        // **実物の [`SessionMeta`] に対する主張**。下の実験用の型は「属性を外したら
        // どうなるか」を残すためのもので、こちらは**いま配ってある PC が名乗る形が
        // 本当に解けること**を見る（設計§5-1・フェーズ1の引き継ぎ）。
        //
        // ここが落ちるなら、繋いである古い PC の**カードの報告そのものが届かない**。
        let 名前の欄が無い古い名乗り = r#"{"card_id":"00000000-0000-0000-0000-000000000001","project":"/p","claude_session_id":null,"permission_mode":null,"model":null,"model_label":null,"model_requested":null,"status":{"kind":"working"},"subagent_active":0,"last_activity_at":1,"last_assistant_message":null,"created_at":1,"hooks_seen":false,"agent_id":null,"agent_connected":true,"account":null,"toml_account":null}"#;
        let meta: SessionMeta =
            serde_json::from_str(名前の欄が無い古い名乗り).expect("古い名乗りが解けること");
        assert_eq!(meta.card_id.0.as_u128(), 1);
        assert_eq!(meta.session_title, None, "名前は空として受ける");
        assert_eq!(meta.status, SessionStatus::Working, "他の欄は今までどおり");
    }

    /// 「新しい欄を足すとき、古い名乗りが解けなくなるのはどういう形か」を実行できる形で
    /// 残すための3つ。**製品コードではない。**
    ///
    /// # なぜ実物の [`SessionMeta`] では書けないのか
    ///
    /// 欄を足して既定を付けた瞬間、「**付けなかったらどうなるか**」は表現できなくなる。
    /// 属性が要る理由を残せるのはこの形だけなので、捨てずに置く
    /// （`一覧のカードのレイアウトを変える` 設計§5-1）。
    ///
    /// カードの報告は PC からサーバへ `SessionMeta` を**丸ごと**運ぶので、古い版の PC が
    /// 名乗る JSON には新しい欄が無い。ここを外すと**そのカードの報告そのものが届かない**。
    // この1つだけ欄を読まない。**解けないことを確かめる相手**なので、解けた値が手に入る
    // 機会が原理的に無い。読める形にすると「解けてしまった」ことを見逃す。
    #[allow(dead_code)]
    #[derive(Debug, Deserialize)]
    struct 既定の無い必須欄 {
        card_id: CardId,
        /// **わざと `#[serde(default)]` を付けていない。** `Option` でもない。
        session_title: String,
    }

    #[derive(Debug, Deserialize)]
    struct 既定を書いていないOptionの欄 {
        card_id: CardId,
        /// こちらも `#[serde(default)]` を書いていない。**`Option` であることだけが違う。**
        session_title: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    struct 既定を付けた欄 {
        card_id: CardId,
        #[serde(default)]
        session_title: String,
    }

    /// 古い版のセッションホストが名乗る形（新しい欄を持たない）。
    const 欄の無い古い名乗り: &str = r#"{"card_id":"00000000-0000-0000-0000-000000000001"}"#;

    #[test]
    fn 既定の無い欄は古い名乗りを丸ごと落とす() {
        let err = serde_json::from_str::<既定の無い必須欄>(欄の無い古い名乗り)
            .expect_err("必須欄が欠けているので解けないこと");
        // **名前が出ないどころか、カードの報告そのものが届かなくなる**——欄1つのために
        // JSON が丸ごと解けなくなる、という壊れ方をする
        assert!(
            err.to_string().contains("session_title"),
            "欠けた欄の名前が理由に出ること: {err}"
        );
    }

    #[test]
    fn Optionの欄は既定を書かなくても古い名乗りで空になる() {
        // **設計§5-1 の前提を1つ訂正するテスト。** serde は欠けた欄を
        // `missing_field` で埋めようとし、その口が `Option` を `None` として受ける。
        // つまり `Option<T>` にしておけば `#[serde(default)]` は**動作としては要らない**。
        //
        // それでも書くのは**意図を残すため**である。この属性が付いていれば、次に読む人が
        // 「ここは欠けてよい欄だ」と1行で分かる。動作に効かないから書かない、にすると、
        // 型を `Option` から外した瞬間に静かに壊れる。
        let parsed: 既定を書いていないOptionの欄 =
            serde_json::from_str(欄の無い古い名乗り).expect("古い名乗りが解けること");
        assert_eq!(parsed.card_id.0.as_u128(), 1);
        assert_eq!(parsed.session_title, None);
    }

    #[test]
    fn 既定を付ければ古い名乗りが解けて欄は空になる() {
        let parsed: 既定を付けた欄 =
            serde_json::from_str(欄の無い古い名乗り).expect("古い名乗りが解けること");
        assert_eq!(parsed.card_id.0.as_u128(), 1);
        assert_eq!(parsed.session_title, "");
    }

    #[test]
    fn session_metaは知らない欄を黙って読み飛ばす() {
        // 逆向き——**新しい PC ＋ 古いサーバ**。`deny_unknown_fields` を持たないので通る。
        // **A2S の版交渉に手を入れずに済む根拠がこれである**（設計§5-1）。
        //
        // 混ぜる欄の名前を、フェーズ2 で足す `session_title` に**しない**。あれは足した
        // 瞬間に「知らない欄」ではなくなり、このテストは何も確かめなくなる。
        let text = r#"{"card_id":"00000000-0000-0000-0000-000000000001","project":"/p","claude_session_id":null,"permission_mode":null,"model":null,"model_label":null,"model_requested":null,"status":{"kind":"working"},"subagent_active":0,"last_activity_at":1,"last_assistant_message":null,"created_at":1,"hooks_seen":false,"agent_id":null,"agent_connected":true,"account":null,"toml_account":null,"まだ存在しない欄":1}"#;
        let meta: SessionMeta =
            serde_json::from_str(text).expect("知らない欄が混ざっても解けること");
        assert_eq!(meta.card_id.0.as_u128(), 1);
        assert_eq!(meta.status, SessionStatus::Working);
    }

    #[test]
    fn 名前を運ぶ工事でパーサとの契約の版は上がらない() {
        // **ここが上がると、自己修復が差し替えた古いパーサを抱えている機械で、
        // 構造化ビューが丸ごと縮退する**（設計§3-2）。名前が出ないだけで済むはずの差で、
        // 履歴を殺すことになる。
        //
        // 報告を1つ足すのは `ParserEvent` の変種を増やすだけでよい——受け口
        // （`session-host-core/src/parser.rs`）が知らない報告を警告1行で捨てる作りに
        // なっているので、古い PC 側は落ちない。
        assert_eq!(crate::ipc::PROTOCOL_VERSION, 1);
    }

    #[test]
    fn 申告したアカウントと帰属したアカウントは別々に運ばれる() {
        // 同じ欄に入れると、**上書きされたのか一致したのか**を後から区別できない。
        // 「持っていない権限は名乗れない」（§8-5）を確かめる側が、申告の原文を
        // 見られなくなる
        let meta = SessionMeta {
            toml_account: Some("よその人".to_string()),
            account: Some("わたし".to_string()),
            ..SessionMeta {
                card_id: CardId::new(),
                project: ProjectId("/p".to_string()),
                claude_session_id: None,
                permission_mode: None,
                model: None,
                model_label: None,
                model_requested: None,
                status: SessionStatus::Unknown,
                subagent_active: 0,
                last_activity_at: 0,
                last_assistant_message: None,
                created_at: 0,
                hooks_seen: false,
                agent_id: None,
                agent_connected: false,
                account: None,
                toml_account: None,
                session_title: None,
                position: 0,
                nickname: None,
            }
        };
        let back = roundtrip(&meta);
        assert_eq!(back.account.as_deref(), Some("わたし"));
        assert_eq!(back.toml_account.as_deref(), Some("よその人"));
    }

    #[test]
    fn manualは正規値のdefaultへ寄せられる() {
        // CLI では manual、フックと設定では default。混ざると「起動したモードと
        // フックが言うモードが違う」ように見えるので、運ぶ値は片方へ寄せる
        assert_eq!(PermissionMode::new("manual").as_str(), "default");
        assert_eq!(PermissionMode::new("default").as_str(), "default");
    }

    #[test]
    fn モデルは裸の文字列として運ばれ知らない値も通る() {
        // モデルは権限モードよりずっと頻繁に増える。知らない値で落ちてはいけない
        // （列挙型にしない理由そのもの）
        let known = ModelId::new("claude-opus-5");
        assert_eq!(roundtrip(&known), known);
        assert_eq!(
            serde_json::to_string(&known).unwrap(),
            r#""claude-opus-5""#,
            "裸の文字列として運ばれること"
        );

        let unknown = ModelId::new("まだ知らないモデル");
        assert_eq!(unknown.as_str(), "まだ知らないモデル");
        assert_eq!(roundtrip(&unknown), unknown);
    }

    #[test]
    fn 確定したモデルと切替を要求した値は別のフィールドで運ばれる() {
        // 楽観更新した値が確定値と同じ顔をすると、CLI に拒否されたときに
        // 画面が嘘をつき続ける（設計§5）
        let meta = SessionMeta {
            card_id: CardId::new(),
            project: ProjectId("/home/example/dev/app".to_string()),
            claude_session_id: None,
            permission_mode: None,
            model: Some(ModelId::new("claude-haiku-4-5")),
            model_label: Some("Haiku 4.5".to_string()),
            model_requested: Some(ModelId::new("opus")),
            status: SessionStatus::Working,
            subagent_active: 0,
            last_activity_at: 1,
            last_assistant_message: None,
            created_at: 1,
            hooks_seen: false,
            agent_id: None,
            agent_connected: true,
            account: None,
            toml_account: None,
            session_title: None,
            position: 0,
            nickname: None,
        };
        let back = roundtrip(&meta);
        assert_eq!(back.model, meta.model);
        assert_eq!(back.model_requested, meta.model_requested);
        assert_ne!(
            back.model, back.model_requested,
            "確定値と要求値が同じ入れ物に潰れていないこと"
        );
    }

    #[test]
    fn まだ名乗っていないモデルはnullとして運ばれる() {
        // 「モデルが無い」ではなく「まだ CLI が名乗っていない」を表す null。
        // フロントの `ModelId | null` と1対1で対応させるため、キーごと消してはいけない
        let meta = SessionMeta {
            card_id: CardId::new(),
            project: ProjectId("/tmp".to_string()),
            claude_session_id: None,
            permission_mode: None,
            model: None,
            model_label: None,
            model_requested: None,
            status: SessionStatus::Starting,
            subagent_active: 0,
            last_activity_at: 1,
            last_assistant_message: None,
            created_at: 1,
            hooks_seen: false,
            agent_id: None,
            agent_connected: true,
            account: None,
            toml_account: None,
            session_title: None,
            position: 0,
            nickname: None,
        };
        let text = serde_json::to_string(&meta).unwrap();
        assert!(text.contains(r#""model":null"#), "実際: {text}");
        assert!(text.contains(r#""model_label":null"#), "実際: {text}");
        assert!(text.contains(r#""model_requested":null"#), "実際: {text}");
    }

    #[test]
    fn 知らないモードはそのまま運ばれる() {
        // CLI がモードを増やしても古いダッシュボードが落ちないこと（列挙型にしない理由）
        let unknown = PermissionMode::new("まだ知らないモード");
        assert_eq!(unknown.as_str(), "まだ知らないモード");
        assert_eq!(roundtrip(&unknown), unknown);
        assert_eq!(
            serde_json::to_string(&unknown).unwrap(),
            r#""まだ知らないモード""#,
            "裸の文字列として運ばれること"
        );
    }

    #[test]
    fn 版は3つ組の大小で並ぶ() {
        // **文字列比較だと 0.10.0 < 0.9.0 になる。** ここが逆だと、一覧で新しい版が
        // 古い版の上に来なくなる
        let mut versions = [
            VersionId::new("0.9.0"),
            VersionId::new("0.10.0"),
            VersionId::new("0.1.2"),
            VersionId::new("1.0.0"),
        ];
        versions.sort();
        let sorted: Vec<&str> = versions.iter().map(VersionId::as_str).collect();
        assert_eq!(sorted, ["0.1.2", "0.9.0", "0.10.0", "1.0.0"]);
    }

    #[test]
    fn 三つ組として読めない版は末尾へ置かれる() {
        // 並び順が分からないことと、選べないことは別（設計§2）。落ちずに末尾へ寄せる
        let mut versions = [
            VersionId::new("0.2.0-rc1"),
            VersionId::new("1.0.0"),
            VersionId::new("nightly"),
            VersionId::new("0.9.0"),
        ];
        versions.sort();
        let sorted: Vec<&str> = versions.iter().map(VersionId::as_str).collect();
        assert_eq!(
            sorted,
            ["0.9.0", "1.0.0", "0.2.0-rc1", "nightly"],
            "読める版が先、読めない版は綴り順で末尾"
        );

        assert_eq!(VersionId::new("0.1.1").triple(), Some((0, 1, 1)));
        assert_eq!(VersionId::new("0.1").triple(), None, "3つに満たない");
        assert_eq!(VersionId::new("0.1.1.1").triple(), None, "4つ目がある");
        assert_eq!(VersionId::new("0.1.x").triple(), None, "数字でない");
    }

    #[test]
    fn 版の一覧の1行が往復する() {
        // REST の応答なので**4箇所同期は要らない**（設計§15 で ServerMessage に載せないと
        // 決めた）。Rust 側で往復することだけを見る
        let entry = VersionEntry {
            version: VersionId::new("0.1.1"),
            origin: VersionOrigin::Stored,
            path: "/home/example/.local/state/agentdashboard/versions/0.1.1/agentdashboard"
                .to_string(),
            usable: true,
            running: false,
            selected: true,
            size_bytes: 29_884_416,
            reason: None,
        };
        assert_eq!(roundtrip(&entry), entry);

        let text = serde_json::to_string(&entry).unwrap();
        assert!(
            text.contains(r#""version":"0.1.1""#),
            "版は裸の文字列: {text}"
        );
        assert!(
            text.contains(r#""origin":"stored""#),
            "出どころは小文字: {text}"
        );
    }

    #[test]
    fn 選べない理由も往復する() {
        // 理由は「選択肢から消さずに添える」ためのもの（設計§14）。落ちると
        // 画面には選べない版が理由なしで並ぶ
        let entry = VersionEntry {
            version: VersionId::new("0.1.0"),
            origin: VersionOrigin::Installed,
            path: "/home/example/.local/bin/agentdashboard".to_string(),
            usable: false,
            running: false,
            selected: false,
            size_bytes: 0,
            reason: Some("3本の版が食い違っています".to_string()),
        };
        assert_eq!(roundtrip(&entry), entry);
    }

    #[test]
    fn nodeは全バリアントが往復する() {
        let nodes = vec![
            Node::UserMessage {
                text: "テストを流して".to_string(),
            },
            Node::AssistantText {
                text: "了解しました".to_string(),
            },
            Node::Thinking {
                text: "まず失敗しているテストを確認する".to_string(),
            },
            Node::ToolCall {
                name: "Edit".to_string(),
                input: json!({ "old_string": "a", "new_string": "b" }),
                result: Some(json!({ "ok": true })),
                status: ToolStatus::Ok,
                subagent: None,
            },
            // サブエージェント起動ツールの実名は v2.1.220 の実データでは `Agent`
            Node::ToolCall {
                name: "Agent".to_string(),
                input: json!({ "prompt": "調査して" }),
                result: None,
                status: ToolStatus::Pending,
                subagent: Some(SubagentRef {
                    agent_type: "Explore".to_string(),
                    transcript_path: "subagents/agent-001.jsonl".to_string(),
                    spawn_depth: 1,
                }),
            },
            Node::Subagent {
                agent_type: "Explore".to_string(),
                spawn_depth: 1,
            },
            Node::Unknown {
                record_type: "queue-operation".to_string(),
                raw: json!({ "type": "queue-operation", "未知フィールド": 1 }),
            },
        ];
        for node in &nodes {
            assert_eq!(&roundtrip(node), node);
        }
    }

    #[test]
    fn 未知レコードは生データを保持したまま往復する() {
        // 寛容パースの肝：知らない構造でも情報を落とさずに運べること
        let raw = json!({
            "type": "brand-new-type",
            "nested": { "deep": [1, 2, { "x": null }] },
        });
        let node = Node::Unknown {
            record_type: "brand-new-type".to_string(),
            raw: raw.clone(),
        };
        match roundtrip(&node) {
            Node::Unknown { raw: restored, .. } => assert_eq!(restored, raw),
            other => panic!("Unknown 以外になった: {other:?}"),
        }
    }

    #[test]
    fn tree_nodeが往復する() {
        let node = TreeNode {
            id: NodeId("11111111-2222-3333-4444-555555555555".to_string()),
            parent: Some(NodeId("00000000-0000-0000-0000-000000000000".to_string())),
            node: Node::AssistantText {
                text: "done".to_string(),
            },
            ts: 1_700_000_000_123,
            branch: 1,
        };
        assert_eq!(roundtrip(&node), node);
    }
}
