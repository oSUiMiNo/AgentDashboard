//! フックイベントからセッションの状態を導き出す状態機械（設計§5）。
//!
//! # なぜ画面ではなくフックを見るのか
//!
//! ターミナルの表示（ANSI）を読んで「いま何をしているか」を推測する方式は、CLI の見た目が
//! 変わるたびに壊れる。フックは「どのツールを使ったか」「権限を求めたか」を**構造化された
//! JSON** で渡してくるので、表示の変更に左右されない。状態をフックから導くのはこのため。
//!
//! # 「画面を読むな」という禁止ではない
//!
//! **ここにはかつて「要件が画面のスクレイピングを禁じている」と書いてあったが、言い過ぎ
//! だった。** 要件（初期実装 `要件.md`）が禁じているのは **ANSI 画面のスクレイピングで
//! 構造化UIを作ること**だけで、方針・設計にはそもそも記述が無い。
//!
//! 実際、カードの属性を画面から読む例はこの crate に既にある。
//!
//! - **権限モード**は端末のフッタを読んで決める（`Session::read_footer_mode`。呼び出し元は
//!   [`sweep_stalled`] と**同じ1秒周期の見張り**）
//! - **フォルダ信頼の確認**が出ているかも画面で見分ける（`selfheal`）
//!
//! つまり**フックで足りるなら使わない、というだけ**である。フックが存在しない場面
//! （例：`AskUserQuestion` は `PreToolUse` も `Notification` も出さない）で画面を見る判断は、
//! この段落を根拠に禁止されるものではない。**採否は「壊れやすさに見合うか」で決めること。**
//!
//! # 設計の要点：時刻も副作用も持たない
//!
//! [`apply`] は「いまの [`SessionMeta`] ＋ 届いたフック ＋ 現在時刻」から次の状態を決める
//! だけの関数で、時計も配信も触らない。おかげで設計§5 の遷移表をそのまま表駆動テストに
//! 落とせる。実際に時計を読んで配信するのは [`crate::session::SessionManager`] の仕事。

use protocol::{ClaudeSessionId, PermissionMode, SessionMeta, SessionStatus, Timestamp};
use serde_json::Value;

/// Claude Code に注入するフックイベント（設計§5 の9種＋`StopFailure`）。
///
/// これがそのまま「注入する settings のキー」であり「受信URLの末尾」でもある。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HookEvent {
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    Notification,
    Stop,
    StopFailure,
    SubagentStart,
    SubagentStop,
    SessionEnd,
}

impl HookEvent {
    /// 注入する全イベント。settings の生成と、受信側の解釈の両方がこの並びを使う。
    pub const ALL: [HookEvent; 10] = [
        Self::SessionStart,
        Self::UserPromptSubmit,
        Self::PreToolUse,
        Self::PostToolUse,
        Self::Notification,
        Self::Stop,
        Self::StopFailure,
        Self::SubagentStart,
        Self::SubagentStop,
        Self::SessionEnd,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionStart => "SessionStart",
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
            Self::Notification => "Notification",
            Self::Stop => "Stop",
            Self::StopFailure => "StopFailure",
            Self::SubagentStart => "SubagentStart",
            Self::SubagentStop => "SubagentStop",
            Self::SessionEnd => "SessionEnd",
        }
    }

    /// URL の末尾から解釈する。知らない名前は `None`。
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|event| event.as_str() == name)
    }

    /// ツール名での絞り込み（matcher）を受け付けるイベントか。
    ///
    /// ツールに紐づかないイベントに matcher を書くと設定として不正になるため、
    /// settings を生成するときにここで振り分ける。
    pub fn takes_matcher(self) -> bool {
        matches!(self, Self::PreToolUse | Self::PostToolUse)
    }
}

/// 受け取ったフック1件。
///
/// payload は Claude Code が stdin へ渡した JSON そのもの。必要な値だけを取り出して使い、
/// 知らないフィールドには触れない（フォーマットが増えても壊れないようにするため）。
#[derive(Debug, Clone)]
pub struct HookInput {
    pub event: HookEvent,
    pub payload: Value,
}

impl HookInput {
    pub fn new(event: HookEvent, payload: Value) -> Self {
        Self { event, payload }
    }

    fn text(&self, key: &str) -> Option<&str> {
        self.payload.get(key)?.as_str()
    }

    /// CLI 側のセッションID。resume などで変わりうるので毎回見る。
    pub fn session_id(&self) -> Option<ClaudeSessionId> {
        let raw = self.text("session_id")?;
        uuid::Uuid::parse_str(raw).ok().map(ClaudeSessionId)
    }

    /// トランスクリプト（JSONL）の場所。フェーズ3のパーサが監視する対象になる。
    pub fn transcript_path(&self) -> Option<&str> {
        self.text("transcript_path")
    }

    /// 権限確認かどうかの判定に使う。
    ///
    /// 実機検証で `notification_type` という型フィールドが付くことを確認済みなので、
    /// 通知メッセージの文字列を解析する必要はない。
    pub fn notification_type(&self) -> Option<&str> {
        self.text("notification_type")
    }

    /// Stop フックが運んでくる直前の応答。小窓の要約表示に使う。
    pub fn last_assistant_message(&self) -> Option<&str> {
        self.text("last_assistant_message")
    }

    /// `SessionEnd` が運んでくる終了の理由。**判定には使わない。**
    ///
    /// 綴りも顔ぶれも CLI 側の都合で変わる。実際、公式ドキュメントの列挙は4つから6つへ
    /// 増えている（`resume` と `bypass_permissions_disabled` が後から入った）。ここに判定を
    /// 載せると、**表に無い値が来たときだけ**壊れる——しかも壊れ方は「生きているカードが
    /// 終了に落ちる」という、いま直したものとまったく同じになる。
    ///
    /// 使い道は記録だけ。無くても `None` になるだけで、判定は1バイトも変わらない。
    pub fn end_reason(&self) -> Option<&str> {
        self.text("reason")
    }

    /// いまの権限モード。
    ///
    /// **全てのフックが運んでくるわけではない**（設計§11 の実測）。運ぶのは
    /// UserPromptSubmit / PreToolUse / PostToolUse / Stop の4つで、`SessionStart` /
    /// `Notification` / `SessionEnd` には入らない。無いことは異常ではないので、
    /// 届いたときだけ更新する。
    ///
    /// 値は CLI 側の正規値（「毎回確認する」は `manual` ではなく `default`）で来る。
    pub fn permission_mode(&self) -> Option<PermissionMode> {
        self.text("permission_mode").map(PermissionMode::new)
    }
}

/// 権限確認を表す `notification_type`（公式ドキュメントに明記された値）。
pub const PERMISSION_PROMPT: &str = "permission_prompt";

/// 何が変わったか。配信するメッセージの種類を選ぶために使う。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Changed {
    /// `status` / `subagent_active` / `last_activity_at` が変わった。差分（`status`）で足りる
    pub status: bool,
    /// 差分メッセージに載らない項目が変わった。カード全体（`session_upsert`）を送り直す
    pub meta: bool,
}

impl Changed {
    pub fn any(self) -> bool {
        self.status || self.meta
    }
}

/// フック1件を適用して、次の状態を決める（設計§5 の遷移表）。
///
/// 優先順位 `Ended > WaitingPermission > Working|Stalled > WaitingSubagents > WaitingInput
/// > Starting > Unknown` は、次の2つのガードとして表現している。
///
/// - **`Ended` は終端**。終了後に遅れて届いたフックでカードを生き返らせない
/// - **`WaitingInput` は `WaitingPermission` を上書きしない**。権限確認で止まっているのに
///   「入力待ち」と出ると、人が対処すべき状況を見落とす
///
/// `WaitingSubagents` が `WaitingInput` より上にあるのは、**ターンが終わっていても仕事は
/// 終わっていない**からである（設計§14）。どちらも指示は受け付けるので、優先されるのは
/// 「まだ終わっていない」と読める側になる。
///
/// **ただしフックだけでは `WaitingSubagents` に入らない**（設計§14 読み替え）。この関数が
/// 選ぶのは `WaitingInput` までで、そこからサブ待ちへ移す／戻すのは画面を読む
/// [`sync_subagent_wait`] である。理由は `subagent_active` が当てにならないこと——
/// `SubagentStop` は**サブが生きているうちに届く**（実機で確認）。
pub fn apply(meta: &mut SessionMeta, input: &HookInput, now: Timestamp) -> Changed {
    let mut changed = Changed::default();
    // ここへ来る `Ended` は**プロセスが消えたことが確定したもの**だけになった
    // （`SessionEnd` フックはもう終端へ落とさない）。したがってこのガードの役目は
    // 「死んだプロセスから遅れて届いたフックで蘇らせない」ことだけである
    if matches!(meta.status, SessionStatus::Ended { .. }) {
        return changed;
    }

    // フックが届いたという事実そのものを控える。設計§11 の「フック未受信」警告は
    // これが立たないことを根拠にする
    if !meta.hooks_seen {
        meta.hooks_seen = true;
        changed.meta = true;
    }

    // どのフックでも「生きている証拠」にはなる。小窓の「最終活動 N分前」の元になる値
    if meta.last_activity_at != now {
        meta.last_activity_at = now;
        changed.status = true;
    }

    // 何かしらフックが届いた時点で停滞ではない。個別の効果はこの後で上書きされる
    if meta.status == SessionStatus::Stalled {
        meta.status = SessionStatus::Working;
        changed.status = true;
    }

    // resume などで CLI 側のIDが変わっても、CardId は変えずに属性だけ張り替える
    if let Some(session_id) = input.session_id()
        && meta.claude_session_id != Some(session_id)
    {
        meta.claude_session_id = Some(session_id);
        changed.meta = true;
    }

    // 権限モードは CLI 側が正（設計§1）。届いたときだけ、しかも**変わったときだけ**
    // 更新する。フックはツールコールのたびに飛んでくるので、毎回配信すると無駄が大きい
    if let Some(mode) = input.permission_mode()
        && meta.permission_mode.as_ref() != Some(&mode)
    {
        meta.permission_mode = Some(mode);
        changed.meta = true;
    }

    match input.event {
        // 起動が完了して入力を待っている状態
        HookEvent::SessionStart => {
            set_unless_permission(meta, SessionStatus::WaitingInput, &mut changed)
        }

        // 人が打ったのだから、メインが動き出したことが確かである
        HookEvent::UserPromptSubmit => {
            set(meta, SessionStatus::Working, &mut changed);
        }

        HookEvent::PreToolUse | HookEvent::PostToolUse => {
            // ツールが動いた＝権限確認は解けている。ターミナルで直接許可した場合も
            // この経路で自然に復帰する
            //
            // **ただしサブ待ちのときは動かさない**（設計§14）。**ツールを叩いたのが
            // メインとは限らない**——サブエージェントのツールコールも同じフックを
            // 飛ばすので、ここで作業中へ戻すと、`Stop` でせっかくサブ待ちにしても
            // **サブの次の一手で即座に消える**。実際、画面には出ないまま「作業中」に
            // 見え続けていた（利用者が実機で踏んだ）。
            //
            // **サブ待ちから出る道は2つだけ**にする——人が指示を打つ
            // （`UserPromptSubmit`）か、**端末のフッタから一覧が消える**
            // （[`sync_subagent_wait`]）か。`SubagentStop` は出口ではない（設計§14 読み替え）。
            if meta.status != SessionStatus::WaitingSubagents {
                set(meta, SessionStatus::Working, &mut changed);
            }
        }

        HookEvent::Notification => {
            if input.notification_type() == Some(PERMISSION_PROMPT) {
                set(meta, SessionStatus::WaitingPermission, &mut changed);
            }
            // それ以外の通知は状態を変えない（設計§5）
        }

        HookEvent::Stop => {
            set_unless_permission(meta, SessionStatus::WaitingInput, &mut changed);
            let message = input.last_assistant_message().map(str::to_string);
            if message.is_some() && meta.last_assistant_message != message {
                meta.last_assistant_message = message;
                changed.meta = true;
            }
        }

        // **`Stop` と同じ扱いにする。** どちらも「そのターンは終わった」を意味する。
        //
        // `Stop` は応答が完了したときのイベントなので、API エラーで終わったターンでは
        // 飛ばない——代わりにこちらが飛ぶ（公式）。受け取らないと、レート制限で止まった
        // セッションが `Working` のまま取り残され、120秒で停滞に落ちて戻らなくなる。
        //
        // エラーの種別（`rate_limit` ほか）で表示を変えないのは、それが新しい状態を作る
        // 話になるため（設計§6-2・§10-1）。エラーで終わったことは端末に出ている。
        HookEvent::StopFailure => {
            set_unless_permission(meta, SessionStatus::WaitingInput, &mut changed);
        }

        // **数だけを動かし、状態は触らない**（設計§14 読み替え）。
        //
        // このフックの数は**当てにならないと実測で分かっている**——`SubagentStop` は
        // サブがまだ生きているうちに届き、実機で `sub=1` のサブ待ちが2分後に `sub=0` へ
        // 戻ったとき、サブはまだ走っていた。**数を根拠に状態を動かすと、いちばん長い
        // 待ちのときに限って外す。**
        //
        // サブ待ちの出入りは、端末のフッタに出る**走っているサブの一覧**を根拠にする
        // （[`sync_subagent_wait`]）。数はバッジの表示に残す。
        HookEvent::SubagentStart => {
            meta.subagent_active += 1;
            changed.status = true;
        }
        HookEvent::SubagentStop => {
            // 取りこぼしや二重送信で 0 を下回らないようにする
            meta.subagent_active = meta.subagent_active.saturating_sub(1);
            changed.status = true;
        }

        // **状態を動かさない。** フックは「会話が終わった」までしか言えない。
        //
        // `SessionEnd` は `/resume` や `/clear` のように**会話が入れ替わるだけ**の場面でも
        // 飛ぶ（公式の `reason` に `resume` / `clear` が並んでいる）。ここで終端へ落とすと、
        // 生きている claude のカードが操作できなくなる。**終わったと言えるのはプロセスだけ**
        // なので、確定は PTY の終了（`SessionManager::on_exit`）が受け持つ。
        //
        // 空の腕なのは書き忘れではない。埋め戻さないこと
        HookEvent::SessionEnd => {}
    }

    changed
}

fn set(meta: &mut SessionMeta, next: SessionStatus, changed: &mut Changed) {
    if meta.status != next {
        meta.status = next;
        changed.status = true;
    }
}

/// 画面の申告で、サブ待ちへ入る／サブ待ちから出る（設計§14 読み替え）。
///
/// `waiting` は「端末に『サブエージェントの終わりを待っている』行が出ているか」で、
/// [`crate::session::activity::waits_for_subagents`] が画面から求める。停滞の
/// [`sweep_stalled_idle`] と同じ形で、**判定そのものをここへ持ち込まない**——この module は
/// 時刻も副作用も持たず、遷移表をそのまま表駆動テストに落とせることを要点にしている。
///
/// # なぜ本数（`subagent_active`）だけでは足りないのか
///
/// **`SubagentStop` はサブがまだ生きているうちに届く。** 実機で、`sub=1` で立ったサブ待ちが
/// 2分後に `sub=0` へ戻り、**そのときサブはまだ走っていた**。本数を根拠にすると、待ちが
/// 長いときに限って「入力待ち」に見える——利用者が踏んだのはこの形である。
///
/// **数は入り口にも使えない**（2026-09-05・読み替え2）。ターンが終わった時点でまだ
/// `SubagentStart` が届いていないことがあるので、`Stop` の腕は本数を見ずに入力待ちへ倒し、
/// **入り口も出口も画面が受け持つ**。
///
/// # 作業中からも入る
///
/// **フックはツールを叩いたのがメインかサブかを区別できない。** サブのツールコールも
/// `PreToolUse` を飛ばすので、ターンが終わって入力待ちになった直後にサブが一手打つと
/// 作業中へ落ちる——そして次に画面を読むまでのあいだ、誰もキーボードの前に居ないのに
/// 「作業中」に見える。実機ではこの形で、**120秒の無音で停滞へ落ちては画面判定で
/// 入力待ちへ救出される、を14回**繰り返していた。
///
/// **画面は区別できる。** メインが走っていればスピナーが出るので、`main_running` が偽で
/// あることを条件にすれば、作業中から移しても取り違えない。
///
/// # 触らない状態
///
/// `WaitingPermission` ／ `Stalled` ／ `Ended` ／ `Starting` へは入らないし、そこからも
/// 動かさない。**この絞り込みは競合に対する防壁でもある**——呼ぶ側（`Session::sweep`）は
/// `meta` のロックを一度離してから画面を読むので、その隙間にフックが届いていれば
/// [`apply`] が状態を進めている。そこへ無条件に書き戻すと**届いたばかりのフックを
/// 踏み潰す**。
///
/// # 出るときの行き先も画面が決める
///
/// 一覧が消えたとき、スピナーが出ていれば作業中・出ていなければ入力待ちへ返す。
/// **同じ1枚の画面から両方を取ること**——別々に読むと、あいだに1ターン挟まって
/// 「走行中かつ一覧在り」が両立して見える。
///
/// # 画面読みは版で壊れる前提
///
/// 壊れたときに残るのは「サブ待ちのまま解けない」側で、**人が指示を打てば
/// `UserPromptSubmit` で作業中へ戻る**（自分では直らないが、行き止まりにはならない）。
pub fn sync_subagent_wait(meta: &mut SessionMeta, waiting: bool, main_running: bool) -> bool {
    let entering = matches!(
        meta.status,
        SessionStatus::WaitingInput | SessionStatus::Working
    );
    let next = if waiting && !main_running && entering {
        SessionStatus::WaitingSubagents
    } else if !waiting && meta.status == SessionStatus::WaitingSubagents {
        if main_running {
            SessionStatus::Working
        } else {
            SessionStatus::WaitingInput
        }
    } else {
        return false;
    };
    if meta.status == next {
        return false;
    }
    meta.status = next;
    true
}

/// 権限確認待ちのときだけは上書きしない（優先順位のガード）。
fn set_unless_permission(meta: &mut SessionMeta, next: SessionStatus, changed: &mut Changed) {
    if meta.status == SessionStatus::WaitingPermission {
        return;
    }
    set(meta, next, changed);
}

/// 作業中のままイベントが途絶しているセッションを停滞と判定する（設計§5 のタイマー）。
///
/// 「作業中」の表示のまま実はハングしている、というのが一番怖い見落としなので、
/// 一定時間フックが来ないことをもって別の状態に落とす。`last_activity_at` は
/// **更新しない**（更新すると停滞の判定そのものが消えてしまう）。
pub fn sweep_stalled(meta: &mut SessionMeta, now: Timestamp, threshold_secs: u64) -> bool {
    if meta.status != SessionStatus::Working {
        return false;
    }
    let elapsed_ms = now.saturating_sub(meta.last_activity_at);
    if elapsed_ms < (threshold_secs as i64).saturating_mul(1000) {
        return false;
    }
    meta.status = SessionStatus::Stalled;
    true
}

/// 停滞に落ちたカードを、画面の様子で入力待ちへ戻す（設計§4）。
///
/// `running` は「端末に走っている印が出ているか」で、[`crate::session::activity`] が
/// 画面から求める。**判定そのものをここへ持ち込まない**——この module は時刻も副作用も
/// 持たず、遷移表をそのまま表駆動テストに落とせることを設計の要点にしている。
///
/// # `Stalled` のときしか動かないのは、範囲を絞るためではない
///
/// **これは競合に対する唯一の防壁である。** 呼ぶ側（`Session::sweep`）は `meta` のロックを
/// **一度離してから**画面を読み、取り直してここへ来る。その隙間にフックが1件でも届いて
/// いれば、[`apply`] が状態を `Working` へ戻している——そこへ入力待ちを書くと、**届いた
/// ばかりのフックを踏み潰す**ことになる。
///
/// # `last_activity_at` は更新しない
///
/// [`sweep_stalled`] と同じ。ここは「新しい活動があった」場面ではなく、「もともと活動が
/// 無かったことに気づいた」場面である。進めると小窓の経過時間が嘘になる。
///
/// # 往復はしない
///
/// [`sweep_stalled`] は `Working` のときしか動かないので、入力待ちへ入れたあと停滞へ戻る
/// ことはない（設計§4-2）。カードが点滅する心配は要らない。
pub fn sweep_stalled_idle(meta: &mut SessionMeta, running: bool) -> bool {
    if meta.status != SessionStatus::Stalled || running {
        return false;
    }
    meta.status = SessionStatus::WaitingInput;
    true
}

/// フックが1件も届かないまま動いているセッションを「判断できない」に落とす（設計§11）。
///
/// **PTY からは出力があるのにフックが0件**という組み合わせは、CLI は動いているのに
/// 注入した設定が効いていないことを意味する。この状態を「起動中」のまま放置すると、
/// 一覧はいつまでも灰色で、利用者は原因に気づけない。フックが来ないのは設定の注入漏れや
/// ポートの塞がりが典型で、いずれも利用者が直せる。
///
/// 起点は `created_at`。まだ何も出力していないセッション（`saw_output` が false）は
/// 単に起動が遅いだけなので対象にしない。
pub fn sweep_hook_silence(
    meta: &mut SessionMeta,
    now: Timestamp,
    threshold_secs: u64,
    saw_output: bool,
) -> bool {
    if meta.hooks_seen || !saw_output || meta.status != SessionStatus::Starting {
        return false;
    }
    let elapsed_ms = now.saturating_sub(meta.created_at);
    if elapsed_ms < (threshold_secs as i64).saturating_mul(1000) {
        return false;
    }
    meta.status = SessionStatus::Unknown;
    true
}

/// 出力もフックも1バイトも無いまま固まっているか（ログ設計§8-4 の追記）。
///
/// [`sweep_hook_silence`] は `saw_output` が立っているものだけを `Unknown` へ落とす。
/// **こちらは状態を1バイトも動かさない**——§8-4 の3材料のうち「端末の末尾」が空なので、
/// 断じるだけの根拠が無い。原因を1つに決め打ちしないという約束は、材料が欠けている
/// ときにこそ効く。
///
/// それでも**無音にはしない**。出力もフックも無いまま `Starting` で固まったセッションは、
/// いままで何も出ていなかった——このイシューが敵にしている沈黙そのものである。
pub fn hook_silent_without_output(
    meta: &SessionMeta,
    now: Timestamp,
    threshold_secs: u64,
    saw_output: bool,
) -> bool {
    if meta.hooks_seen || saw_output || meta.status != SessionStatus::Starting {
        return false;
    }
    now.saturating_sub(meta.created_at) >= (threshold_secs as i64).saturating_mul(1000)
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use protocol::{CardId, ProjectId};
    use serde_json::json;

    const NOW: Timestamp = 1_700_000_000_000;

    fn meta_with(status: SessionStatus) -> SessionMeta {
        SessionMeta {
            card_id: CardId::new(),
            project: ProjectId("/home/example/dev/app".to_string()),
            claude_session_id: None,
            permission_mode: None,
            model: None,
            model_label: None,
            model_requested: None,
            status,
            subagent_active: 0,
            last_activity_at: NOW - 5_000,
            last_assistant_message: None,
            created_at: NOW - 60_000,
            hooks_seen: false,
            agent_id: None,
            agent_connected: true,
            account: None,
            toml_account: None,
            session_title: None,
            position: 0,
            nickname: None,
            branched_from: None,
        }
    }

    fn hook(event: HookEvent) -> HookInput {
        HookInput::new(event, json!({}))
    }

    #[test]
    fn 設計5の遷移表どおりに状態が決まる() {
        // (開始状態, イベント, 期待する状態)
        let table = [
            (
                SessionStatus::Starting,
                HookEvent::SessionStart,
                SessionStatus::WaitingInput,
            ),
            (
                SessionStatus::WaitingInput,
                HookEvent::UserPromptSubmit,
                SessionStatus::Working,
            ),
            (
                SessionStatus::WaitingInput,
                HookEvent::PreToolUse,
                SessionStatus::Working,
            ),
            (
                SessionStatus::WaitingInput,
                HookEvent::PostToolUse,
                SessionStatus::Working,
            ),
            (
                SessionStatus::Working,
                HookEvent::Stop,
                SessionStatus::WaitingInput,
            ),
            // 会話の終わりでしかないので、状態は動かない（終了の確定は PTY の側）
            (
                SessionStatus::Working,
                HookEvent::SessionEnd,
                SessionStatus::Working,
            ),
            // サブエージェントの増減は状態を動かさない
            (
                SessionStatus::Working,
                HookEvent::SubagentStart,
                SessionStatus::Working,
            ),
            (
                SessionStatus::Working,
                HookEvent::SubagentStop,
                SessionStatus::Working,
            ),
        ];

        for (start, event, expected) in table {
            let mut meta = meta_with(start);
            apply(&mut meta, &hook(event), NOW);
            assert_eq!(
                meta.status,
                expected,
                "{start:?} に {} が届いたとき",
                event.as_str()
            );
        }
    }

    #[test]
    fn 権限確認の通知だけが待ち状態にする() {
        let mut meta = meta_with(SessionStatus::Working);
        apply(
            &mut meta,
            &HookInput::new(
                HookEvent::Notification,
                json!({ "notification_type": PERMISSION_PROMPT }),
            ),
            NOW,
        );
        assert_eq!(meta.status, SessionStatus::WaitingPermission);

        // 型フィールドが別の値なら状態は動かない
        let mut meta = meta_with(SessionStatus::Working);
        apply(
            &mut meta,
            &HookInput::new(
                HookEvent::Notification,
                json!({ "notification_type": "idle_timeout" }),
            ),
            NOW,
        );
        assert_eq!(meta.status, SessionStatus::Working);

        // 型フィールドが無い通知でも落ちない
        let mut meta = meta_with(SessionStatus::Working);
        apply(&mut meta, &hook(HookEvent::Notification), NOW);
        assert_eq!(meta.status, SessionStatus::Working);
    }

    #[test]
    fn ツールの実行で権限確認待ちが解ける() {
        // ターミナルで直接許可した場合、許可されたこと自体を伝えるフックは無い。
        // 次のツール実行で自然に復帰することが唯一の復帰経路になる
        for event in [HookEvent::PreToolUse, HookEvent::PostToolUse] {
            let mut meta = meta_with(SessionStatus::WaitingPermission);
            apply(&mut meta, &hook(event), NOW);
            assert_eq!(meta.status, SessionStatus::Working, "{}", event.as_str());
        }
    }

    #[test]
    fn 権限確認待ちは入力待ちで上書きされない() {
        for event in [
            HookEvent::SessionStart,
            HookEvent::Stop,
            HookEvent::StopFailure,
        ] {
            let mut meta = meta_with(SessionStatus::WaitingPermission);
            apply(&mut meta, &hook(event), NOW);
            assert_eq!(
                meta.status,
                SessionStatus::WaitingPermission,
                "{} で上書きされてはいけない",
                event.as_str()
            );
        }
    }

    #[test]
    fn session_endはどの状態からでも終了にしない() {
        // `/resume` も `/clear` も CLI が生きたまま `SessionEnd` を出す。どの状態から
        // 受けても終端へ落とさないことが、この修正の本体
        for status in [
            SessionStatus::Starting,
            SessionStatus::WaitingInput,
            SessionStatus::Working,
            SessionStatus::WaitingPermission,
        ] {
            let mut meta = meta_with(status);
            apply(&mut meta, &hook(HookEvent::SessionEnd), NOW);
            assert_eq!(meta.status, status, "{status:?} から動かしてはいけない");
        }

        // 停滞だけは例外で、作業中へ戻る。これは `SessionEnd` の効果ではなく
        // **どのフックでも効く共通の停滞解除**（フックが届いた＝生きている証拠）
        let mut meta = meta_with(SessionStatus::Stalled);
        apply(&mut meta, &hook(HookEvent::SessionEnd), NOW);
        assert_eq!(meta.status, SessionStatus::Working);
    }

    #[test]
    fn session_endのあとも最終活動が進む() {
        // 実機で踏んだ症状：終端へ落ちた瞬間に早期 return が効き、以後どのフックも
        // `last_activity_at` を進められなくなって「N分前」が増え続けていた
        let mut meta = meta_with(SessionStatus::Working);
        apply(&mut meta, &hook(HookEvent::SessionEnd), NOW);
        assert_eq!(meta.last_activity_at, NOW);

        apply(&mut meta, &hook(HookEvent::PreToolUse), NOW + 1_000);
        assert_eq!(
            meta.last_activity_at,
            NOW + 1_000,
            "申告のあとに届いたフックでも時刻は進む"
        );
    }

    #[test]
    fn 終了の理由は読めるが判定には使わない() {
        let with_reason = HookInput::new(HookEvent::SessionEnd, json!({ "reason": "resume" }));
        assert_eq!(with_reason.end_reason(), Some("resume"));

        // 欄が無い版・値が文字列でない版でも落ちない。記録に使うだけなので困らない
        assert_eq!(hook(HookEvent::SessionEnd).end_reason(), None);
        for payload in [
            json!({ "reason": 7 }),
            json!({ "reason": { "kind": "clear" } }),
        ] {
            let input = HookInput::new(HookEvent::SessionEnd, payload);
            assert_eq!(input.end_reason(), None);
        }

        // 理由が何であれ状態は動かない（綴りに判定を載せていないことの確認）
        let mut meta = meta_with(SessionStatus::Working);
        apply(&mut meta, &with_reason, NOW);
        assert_eq!(meta.status, SessionStatus::Working);
    }

    #[test]
    fn 終了したセッションはどのフックでも動かない() {
        for event in HookEvent::ALL {
            let mut meta = meta_with(SessionStatus::Ended { ok: false });
            let before = meta.clone();
            let changed = apply(&mut meta, &hook(event), NOW);
            assert_eq!(meta, before, "{} で変化してはいけない", event.as_str());
            assert!(!changed.any());
        }
    }

    #[test]
    fn 停滞は任意のフックで作業中へ戻る() {
        // 状態を変えない種別（サブエージェント・通常の通知）でも復帰すること
        for event in [
            HookEvent::SubagentStart,
            HookEvent::SubagentStop,
            HookEvent::Notification,
            HookEvent::PreToolUse,
        ] {
            let mut meta = meta_with(SessionStatus::Stalled);
            apply(&mut meta, &hook(event), NOW);
            assert_eq!(meta.status, SessionStatus::Working, "{}", event.as_str());
        }

        // Stop は復帰したうえで入力待ちになる
        let mut meta = meta_with(SessionStatus::Stalled);
        apply(&mut meta, &hook(HookEvent::Stop), NOW);
        assert_eq!(meta.status, SessionStatus::WaitingInput);
    }

    #[test]
    fn サブエージェントの数は0を下回らない() {
        let mut meta = meta_with(SessionStatus::Working);
        apply(&mut meta, &hook(HookEvent::SubagentStart), NOW);
        apply(&mut meta, &hook(HookEvent::SubagentStart), NOW);
        assert_eq!(meta.subagent_active, 2);

        for _ in 0..5 {
            apply(&mut meta, &hook(HookEvent::SubagentStop), NOW);
        }
        assert_eq!(meta.subagent_active, 0, "取りこぼしても負にならない");
    }

    #[test]
    fn stopで直前の応答が取り込まれる() {
        let mut meta = meta_with(SessionStatus::Working);
        let changed = apply(
            &mut meta,
            &HookInput::new(
                HookEvent::Stop,
                json!({ "last_assistant_message": "テストが通りました" }),
            ),
            NOW,
        );
        assert_eq!(
            meta.last_assistant_message.as_deref(),
            Some("テストが通りました")
        );
        assert!(changed.meta, "差分では運べないのでカード全体を送り直す");
    }

    #[test]
    fn 権限モードはフックで張り替えられる() {
        let mut meta = meta_with(SessionStatus::Working);
        let changed = apply(
            &mut meta,
            &HookInput::new(
                HookEvent::PreToolUse,
                json!({ "permission_mode": "acceptEdits" }),
            ),
            NOW,
        );
        assert_eq!(
            meta.permission_mode,
            Some(PermissionMode::new("acceptEdits"))
        );
        assert!(changed.meta, "差分では運べないのでカード全体を送り直す");
    }

    #[test]
    fn 同じ権限モードのフックでは配信しない() {
        // フックはツールコールのたびに飛んでくる。毎回カード全体を送ると無駄が大きい
        let mut meta = meta_with(SessionStatus::Working);
        meta.permission_mode = Some(PermissionMode::new("default"));
        meta.hooks_seen = true;
        meta.last_activity_at = NOW;

        let changed = apply(
            &mut meta,
            &HookInput::new(
                HookEvent::PostToolUse,
                json!({ "permission_mode": "default" }),
            ),
            NOW,
        );
        assert!(!changed.meta, "変わっていないのに送り直してはいけない");
    }

    #[test]
    fn 権限モードを運ばないフックでは消さない() {
        // SessionStart / Notification / SessionEnd には載らない（設計§11 の実測）。
        // 「無い」を「不明になった」と解釈すると、表示が点滅する
        let mut meta = meta_with(SessionStatus::Working);
        meta.permission_mode = Some(PermissionMode::new("plan"));

        apply(&mut meta, &hook(HookEvent::Notification), NOW);
        assert_eq!(meta.permission_mode, Some(PermissionMode::new("plan")));
    }

    #[test]
    fn フックのmanualは正規値へ寄る() {
        // CLI とフックで綴りが違う。寄せないと切り替わったように見える
        let mut meta = meta_with(SessionStatus::Working);
        apply(
            &mut meta,
            &HookInput::new(HookEvent::Stop, json!({ "permission_mode": "manual" })),
            NOW,
        );
        assert_eq!(meta.permission_mode, Some(PermissionMode::new("default")));
    }

    #[test]
    fn session_idは毎回張り替えられる() {
        // resume で CLI 側のIDが変わっても CardId は不変のまま追随できること
        let mut meta = meta_with(SessionStatus::Working);
        let card_id = meta.card_id;
        let first = ClaudeSessionId::new();
        let second = ClaudeSessionId::new();

        for id in [first, second] {
            let changed = apply(
                &mut meta,
                &HookInput::new(
                    HookEvent::PreToolUse,
                    json!({ "session_id": id.to_string() }),
                ),
                NOW,
            );
            assert_eq!(meta.claude_session_id, Some(id));
            assert!(changed.meta);
        }
        assert_eq!(meta.card_id, card_id, "CardId は変わらない");
    }

    #[test]
    fn どのフックでも最終活動時刻が更新される() {
        for event in HookEvent::ALL {
            let mut meta = meta_with(SessionStatus::Working);
            apply(&mut meta, &hook(event), NOW);
            assert_eq!(meta.last_activity_at, NOW, "{}", event.as_str());
        }
    }

    #[test]
    fn 作業中のまま無音が続くと停滞になる() {
        let mut meta = meta_with(SessionStatus::Working);
        meta.last_activity_at = NOW - 120_000;

        assert!(
            !sweep_stalled(&mut meta, NOW - 1, 120),
            "境界の直前では出ない"
        );
        assert!(sweep_stalled(&mut meta, NOW, 120));
        assert_eq!(meta.status, SessionStatus::Stalled);
        assert_eq!(
            meta.last_activity_at,
            NOW - 120_000,
            "最終活動時刻は動かさない"
        );

        // 二度目は変化なし（同じ通知を配信し続けない）
        assert!(!sweep_stalled(&mut meta, NOW, 120));
    }

    /// API エラーで終わったターンも「終わった」として扱う（設計§6）。
    ///
    /// `Stop` は応答が完了したときにしか飛ばないので、レート制限などで落ちたターンは
    /// これを受け取らないと `Working` のまま残り、120秒で停滞へ落ちて戻らなくなる。
    #[test]
    fn stop_failureは入力待ちにする() {
        for status in [
            SessionStatus::Starting,
            SessionStatus::Working,
            SessionStatus::Stalled,
        ] {
            let mut meta = meta_with(status);
            apply(&mut meta, &hook(HookEvent::StopFailure), NOW);
            assert_eq!(
                meta.status,
                SessionStatus::WaitingInput,
                "{status:?} から入力待ちへ戻ること"
            );
        }
    }

    /// 人の答えを待っている画面は、停滞の判定に触れない（設計§4-3 の根拠）。
    ///
    /// 停滞へ落ちるのは `Working` からだけなので、権限確認待ちのカードは何時間
    /// 放置されても `sweep_stalled` の対象にならない。**画面を読む判定はここから
    /// 先にしか置かない**ので、この一点が「権限確認待ちを拾わなくてよい」根拠に
    /// なっている。崩れたら設計§4 ごと見直すこと。
    #[test]
    fn 権限確認待ちは何時間経っても停滞にならない() {
        let mut meta = meta_with(SessionStatus::WaitingPermission);
        meta.last_activity_at = NOW - 6 * 60 * 60 * 1000;

        assert!(
            !sweep_stalled(&mut meta, NOW, 120),
            "権限確認待ちは停滞へ落ちない"
        );
        assert_eq!(meta.status, SessionStatus::WaitingPermission);
    }

    #[test]
    fn 作業中以外は停滞にならない() {
        for status in [
            SessionStatus::Starting,
            SessionStatus::WaitingInput,
            SessionStatus::WaitingPermission,
            SessionStatus::Stalled,
            SessionStatus::Ended { ok: true },
            SessionStatus::Unknown,
        ] {
            let mut meta = meta_with(status);
            meta.last_activity_at = NOW - 999_999;
            assert!(!sweep_stalled(&mut meta, NOW, 120), "{status:?}");
        }
    }

    #[test]
    fn 停滞したカードは印が無ければ入力待ちへ戻る() {
        // 設計§4-2。走っている印が見つからないので倒す
        let mut meta = meta_with(SessionStatus::Stalled);

        assert!(sweep_stalled_idle(&mut meta, false));
        assert_eq!(meta.status, SessionStatus::WaitingInput);
    }

    #[test]
    fn 停滞したカードに印があれば停滞のまま留まる() {
        let mut meta = meta_with(SessionStatus::Stalled);

        assert!(!sweep_stalled_idle(&mut meta, true));
        assert_eq!(meta.status, SessionStatus::Stalled);
    }

    /// **倒す側の入力（印が無い）で回すこと。** 印がある側で回すと、どのみち何も起きない
    /// ので、状態の絞り込みを確かめたことにならない。
    #[test]
    fn 停滞以外は画面を見ても動かない() {
        for status in [
            SessionStatus::Starting,
            SessionStatus::Working,
            SessionStatus::WaitingInput,
            SessionStatus::WaitingSubagents,
            SessionStatus::WaitingPermission,
            SessionStatus::Ended { ok: true },
            SessionStatus::Ended { ok: false },
            SessionStatus::Unknown,
        ] {
            let mut meta = meta_with(status);
            assert!(!sweep_stalled_idle(&mut meta, false), "{status:?}");
            assert_eq!(meta.status, status, "{status:?}");
        }
    }

    /// **ターンの終わりは、本数に関わらず入力待ち**（設計§14 読み替え）。
    ///
    /// サブ待ちへ移すのは画面を読む [`sync_subagent_wait`] だけである。`subagent_active`
    /// を行き先の条件にしていた作りは、実測で**数が当てにならない**と分かって外した。
    #[test]
    fn ターンの終わりは本数に関わらず入力待ち() {
        for event in [HookEvent::Stop, HookEvent::StopFailure] {
            for count in [0, 2] {
                let mut meta = meta_with(SessionStatus::Working);
                meta.subagent_active = count;
                apply(&mut meta, &hook(event), NOW);
                assert_eq!(
                    meta.status,
                    SessionStatus::WaitingInput,
                    "{} が届いたとき（サブ {count} 本）",
                    event.as_str()
                );
                assert_eq!(meta.subagent_active, count, "数は触らない");
            }
        }
    }

    /// **サブのフックは数だけを動かす**（設計§14 読み替え）。
    ///
    /// 手が空いていても状態は変わらない。`SubagentStart` は届いたのに端末には一覧が
    /// 出ない、という組み合わせがありうる（別の機械のサブなど）ためではなく、
    /// **出入りの根拠を1つ（画面）に寄せる**ためである。2つあると、片方が外したときに
    /// もう片方が打ち消して、どちらが効いているのか読めなくなる。
    #[test]
    fn サブのフックは数だけを動かす() {
        let mut meta = meta_with(SessionStatus::WaitingInput);
        apply(&mut meta, &hook(HookEvent::SubagentStart), NOW);
        assert_eq!(meta.subagent_active, 1);
        assert_eq!(meta.status, SessionStatus::WaitingInput, "状態は動かさない");
    }

    /// **本数が0へ戻ってもサブ待ちは解かない**（設計§14 読み替え）。
    ///
    /// `SubagentStop` はサブがまだ生きているうちに届く。解くのは画面の側
    /// （[`sync_subagent_wait`]）である。
    #[test]
    fn 本数が0へ戻ってもサブ待ちは解けない() {
        let mut meta = meta_with(SessionStatus::WaitingSubagents);
        meta.subagent_active = 2;

        apply(&mut meta, &hook(HookEvent::SubagentStop), NOW);
        assert_eq!(meta.subagent_active, 1);
        assert_eq!(meta.status, SessionStatus::WaitingSubagents);

        apply(&mut meta, &hook(HookEvent::SubagentStop), NOW);
        assert_eq!(meta.subagent_active, 0, "数は今までどおり数える");
        assert_eq!(
            meta.status,
            SessionStatus::WaitingSubagents,
            "0 になっても状態は動かさない"
        );
    }

    /// 画面の申告でサブ待ちへ入り、消えたら出る（設計§14 読み替え）。
    #[test]
    fn 画面の申告でサブ待ちへ入って出る() {
        let mut meta = meta_with(SessionStatus::WaitingInput);
        assert!(sync_subagent_wait(&mut meta, true, false));
        assert_eq!(meta.status, SessionStatus::WaitingSubagents);

        assert!(sync_subagent_wait(&mut meta, false, false));
        assert_eq!(meta.status, SessionStatus::WaitingInput);
    }

    /// **作業中からも入る**（設計§14 読み替え4）。
    ///
    /// サブのツールコールもメインと同じフックを飛ばすので、ターンが終わった直後に
    /// サブが一手打つと作業中へ落ちる。ここを塞がないと、誰も居ないのに作業中のまま
    /// 残る——実機で踏んだのはこの形である。
    #[test]
    fn 作業中でもスピナーが出ていなければサブ待ちへ移る() {
        let mut meta = meta_with(SessionStatus::Working);
        assert!(sync_subagent_wait(&mut meta, true, false));
        assert_eq!(meta.status, SessionStatus::WaitingSubagents);
    }

    /// **メインが走っているうちは動かさない。** ここが「作業中からも入る」の唯一の歯止め
    /// なので、外れると走っているカードがサブ待ちに見える。
    #[test]
    fn メインが走っていればサブ待ちへ移さない() {
        for status in [SessionStatus::Working, SessionStatus::WaitingInput] {
            let mut meta = meta_with(status);
            assert!(!sync_subagent_wait(&mut meta, true, true), "{status:?}");
            assert_eq!(meta.status, status, "{status:?}");
        }
    }

    /// **出るときの行き先も画面が決める。** 一覧が消えた時点でメインが走っていれば、
    /// 入力待ちへ返すと「動いているのに入力待ち」になる。
    #[test]
    fn 一覧が消えたときの行き先はスピナーで決まる() {
        let mut meta = meta_with(SessionStatus::WaitingSubagents);
        assert!(sync_subagent_wait(&mut meta, false, true));
        assert_eq!(meta.status, SessionStatus::Working);

        let mut meta = meta_with(SessionStatus::WaitingSubagents);
        assert!(sync_subagent_wait(&mut meta, false, false));
        assert_eq!(meta.status, SessionStatus::WaitingInput);
    }

    /// 変化を返し続けると、配信が無駄に増える（[`sweep_stalled_idle`] と同じ作法）。
    #[test]
    fn 画面の申告が同じなら二度目は変化しない() {
        let mut meta = meta_with(SessionStatus::WaitingInput);
        assert!(!sync_subagent_wait(&mut meta, false, false));
        assert!(sync_subagent_wait(&mut meta, true, false));
        assert!(!sync_subagent_wait(&mut meta, true, false));
    }

    /// **触らないと決めた状態は、画面を見ても動かさない。**
    ///
    /// 呼ぶ側は `meta` のロックを一度離して画面を読むので、その隙間にフックが届いて
    /// いれば状態はもう別のものである。ここが競合に対する唯一の防壁になっている。
    /// **作業中はこの一覧から外れた**（読み替え4）——あそこはフックがメインとサブを
    /// 取り違える唯一の場所なので、画面のほうが正しい。
    ///
    /// **入力の組み合わせを全部回すこと。** 片側だけだと、動かない理由が「入力のせい」
    /// なのか「状態の絞り込みのせい」なのか区別できない。
    #[test]
    fn 触らないと決めた状態は画面を見ても動かない() {
        for status in [
            SessionStatus::Starting,
            SessionStatus::Stalled,
            SessionStatus::WaitingPermission,
            SessionStatus::Ended { ok: true },
            SessionStatus::Ended { ok: false },
            SessionStatus::Unknown,
        ] {
            for waiting in [true, false] {
                for main_running in [true, false] {
                    let mut meta = meta_with(status);
                    assert!(
                        !sync_subagent_wait(&mut meta, waiting, main_running),
                        "{status:?} waiting={waiting} running={main_running}"
                    );
                    assert_eq!(meta.status, status, "{status:?}");
                }
            }
        }
    }

    /// **メインが走っている間は、サブの増減で状態を動かさない**（設計§14-2）。
    ///
    /// 動いているのはメインなので、`Working` のままでなければならない。
    #[test]
    fn 作業中はサブが増えても減っても状態が動かない() {
        for event in [HookEvent::SubagentStart, HookEvent::SubagentStop] {
            let mut meta = meta_with(SessionStatus::Working);
            meta.subagent_active = 1;
            apply(&mut meta, &hook(event), NOW);
            assert_eq!(meta.status, SessionStatus::Working, "{}", event.as_str());
        }
    }

    /// **権限確認待ちは、ターンが終わっても上書きしない**（既存のガードに乗る）。
    #[test]
    fn 権限確認待ちはターンの終わりに上書きされない() {
        let mut meta = meta_with(SessionStatus::WaitingPermission);
        meta.subagent_active = 3;
        apply(&mut meta, &hook(HookEvent::Stop), NOW);
        assert_eq!(meta.status, SessionStatus::WaitingPermission);
    }

    /// **サブのツールコールで、サブ待ちが消えないこと**（設計§14）。
    ///
    /// **ツールを叩いたのがメインとは限らない。** サブエージェントのツールコールも
    /// 同じフックを飛ばすので、ここで作業中へ戻すと `Stop` でサブ待ちにした直後に
    /// 消える。**利用者が実機で踏んだ壊れ方そのもの**で、画面には「作業中」としか
    /// 出ず、サブ待ちが一度も見えなかった。
    #[test]
    fn サブ待ちはツールのフックで作業中へ戻らない() {
        for event in [HookEvent::PreToolUse, HookEvent::PostToolUse] {
            let mut meta = meta_with(SessionStatus::WaitingSubagents);
            meta.subagent_active = 1;
            apply(&mut meta, &hook(event), NOW);
            assert_eq!(
                meta.status,
                SessionStatus::WaitingSubagents,
                "{} が届いたとき",
                event.as_str()
            );
        }
    }

    /// **人が打ったときは、サブが残っていても作業中へ戻る。**
    ///
    /// `UserPromptSubmit` はメインが動き出したことが確かな唯一のフックである。
    #[test]
    fn サブ待ちでも人が打てば作業中へ戻る() {
        let mut meta = meta_with(SessionStatus::WaitingSubagents);
        meta.subagent_active = 1;
        apply(&mut meta, &hook(HookEvent::UserPromptSubmit), NOW);
        assert_eq!(meta.status, SessionStatus::Working);
    }

    /// サブ待ち**でなければ**、ツールのフックは今までどおり作業中へ戻す。
    #[test]
    fn サブ待ち以外はツールのフックで今までどおり作業中になる() {
        for start in [
            SessionStatus::WaitingInput,
            SessionStatus::Stalled,
            SessionStatus::Starting,
        ] {
            let mut meta = meta_with(start);
            apply(&mut meta, &hook(HookEvent::PreToolUse), NOW);
            assert_eq!(meta.status, SessionStatus::Working, "{start:?}");
        }
    }

    /// **サブ待ちは停滞に落ちない**（設計§14）。
    ///
    /// 落とすと、落ちた先の画面判定（[`sweep_stalled_idle`]）が走る。サブを待っている間の
    /// 端末には走っている印が出ないので、**入力待ちへ倒されて新しい状態が自分で消える。**
    #[test]
    fn サブ待ちは停滞に落ちない() {
        let mut meta = meta_with(SessionStatus::WaitingSubagents);
        meta.last_activity_at = NOW - 999_000;
        assert!(!sweep_stalled(&mut meta, NOW, 120));
        assert_eq!(meta.status, SessionStatus::WaitingSubagents);
    }

    #[test]
    fn 入力待ちにしたあと続けて呼んでも二度目は変化しない() {
        // 変化を返し続けると、配信が無駄に増える
        let mut meta = meta_with(SessionStatus::Stalled);

        assert!(sweep_stalled_idle(&mut meta, false), "一度目は変わる");
        assert!(!sweep_stalled_idle(&mut meta, false), "二度目は変わらない");
        assert_eq!(meta.status, SessionStatus::WaitingInput);
    }

    /// 停滞へ落とす側と戻す側で往復しないこと（設計§4-2）。
    #[test]
    fn 入力待ちへ戻したカードは停滞へ落ち直さない() {
        let mut meta = meta_with(SessionStatus::Stalled);
        meta.last_activity_at = NOW - 6 * 60 * 60 * 1000;

        assert!(sweep_stalled_idle(&mut meta, false));
        assert!(
            !sweep_stalled(&mut meta, NOW, 120),
            "作業中ではないので停滞へは落ちない"
        );
        assert_eq!(meta.status, SessionStatus::WaitingInput);
    }

    /// 画面を見て倒しても、経過時間の起点は動かさない（設計§4）。
    #[test]
    fn 画面で倒しても最終活動の時刻は進めない() {
        let mut meta = meta_with(SessionStatus::Stalled);
        meta.last_activity_at = NOW - 999_999;
        let before = meta.last_activity_at;

        assert!(sweep_stalled_idle(&mut meta, false));
        assert_eq!(meta.last_activity_at, before);
    }

    #[test]
    fn 出力があるのにフックが来なければ判断できない状態になる() {
        // 設計§11。CLI は動いているのに注入した設定が効いていない、という状況を
        // 「起動中」のまま放置すると、利用者は原因に気づけない
        let mut meta = meta_with(SessionStatus::Starting);
        meta.created_at = NOW - 120_000;

        assert!(
            !sweep_hook_silence(&mut meta, NOW - 1, 120, true),
            "境界の直前では出ない"
        );
        assert!(sweep_hook_silence(&mut meta, NOW, 120, true));
        assert_eq!(meta.status, SessionStatus::Unknown);

        // 二度目は変化なし（同じ通知を配信し続けない）
        assert!(!sweep_hook_silence(&mut meta, NOW, 120, true));
    }

    #[test]
    fn 出力がまだ無いセッションは判断できない状態にしない() {
        // 単に起動が遅いだけかもしれない。警告を出すには早すぎる
        let mut meta = meta_with(SessionStatus::Starting);
        meta.created_at = NOW - 999_999;
        assert!(!sweep_hook_silence(&mut meta, NOW, 120, false));
        assert_eq!(meta.status, SessionStatus::Starting);
    }

    #[test]
    fn フックが1件でも届いていれば判断できない状態にしない() {
        let mut meta = meta_with(SessionStatus::Starting);
        meta.created_at = NOW - 999_999;
        apply(&mut meta, &hook(HookEvent::SubagentStart), NOW);
        assert!(meta.hooks_seen, "フックの受信そのものが印になる");

        assert!(!sweep_hook_silence(&mut meta, NOW, 120, true));
    }

    #[test]
    fn 起動中以外は判断できない状態にしない() {
        // 一度でも状態が決まったなら、フックは届いている
        for status in [
            SessionStatus::Working,
            SessionStatus::WaitingInput,
            SessionStatus::WaitingPermission,
            SessionStatus::Stalled,
            SessionStatus::Ended { ok: true },
            SessionStatus::Unknown,
        ] {
            let mut meta = meta_with(status);
            meta.created_at = NOW - 999_999;
            assert!(!sweep_hook_silence(&mut meta, NOW, 120, true), "{status:?}");
        }
    }

    #[test]
    fn イベント名は往復する() {
        for event in HookEvent::ALL {
            assert_eq!(HookEvent::parse(event.as_str()), Some(event));
        }
        assert_eq!(HookEvent::parse("PreCompact"), None, "注入していない種別");
        assert_eq!(HookEvent::parse("未来のイベント"), None);
    }

    #[test]
    fn matcherを取るのはツール系だけ() {
        assert!(HookEvent::PreToolUse.takes_matcher());
        assert!(HookEvent::PostToolUse.takes_matcher());
        for event in HookEvent::ALL {
            if !matches!(event, HookEvent::PreToolUse | HookEvent::PostToolUse) {
                assert!(!event.takes_matcher(), "{}", event.as_str());
            }
        }
    }
}
