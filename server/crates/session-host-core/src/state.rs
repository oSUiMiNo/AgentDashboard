//! フックイベントからセッションの状態を導き出す状態機械（設計§5）。
//!
//! # なぜ画面ではなくフックを見るのか
//!
//! ターミナルの表示（ANSI）を読んで「いま何をしているか」を推測する方式は、CLI の見た目が
//! 変わるたびに壊れる。フックは「どのツールを使ったか」「権限を求めたか」を**構造化された
//! JSON** で渡してくるので、表示の変更に左右されない。要件が画面のスクレイピングを禁じて
//! いるのはこのため。
//!
//! # 設計の要点：時刻も副作用も持たない
//!
//! [`apply`] は「いまの [`SessionMeta`] ＋ 届いたフック ＋ 現在時刻」から次の状態を決める
//! だけの関数で、時計も配信も触らない。おかげで設計§5 の遷移表をそのまま表駆動テストに
//! 落とせる。実際に時計を読んで配信するのは [`crate::session::SessionManager`] の仕事。

use protocol::{ClaudeSessionId, PermissionMode, SessionMeta, SessionStatus, Timestamp};
use serde_json::Value;

/// Claude Code に注入するフックイベント（設計§5 の9種）。
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
    SubagentStart,
    SubagentStop,
    SessionEnd,
}

impl HookEvent {
    /// 注入する全イベント。settings の生成と、受信側の解釈の両方がこの並びを使う。
    pub const ALL: [HookEvent; 9] = [
        Self::SessionStart,
        Self::UserPromptSubmit,
        Self::PreToolUse,
        Self::PostToolUse,
        Self::Notification,
        Self::Stop,
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
/// 優先順位 `Ended > WaitingPermission > Working|Stalled > WaitingInput > Starting > Unknown`
/// は、次の2つのガードとして表現している。
///
/// - **`Ended` は終端**。終了後に遅れて届いたフックでカードを生き返らせない
/// - **`WaitingInput` は `WaitingPermission` を上書きしない**。権限確認で止まっているのに
///   「入力待ち」と出ると、人が対処すべき状況を見落とす
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

        HookEvent::UserPromptSubmit | HookEvent::PreToolUse | HookEvent::PostToolUse => {
            // ツールが動いた＝権限確認は解けている。ターミナルで直接許可した場合も
            // この経路で自然に復帰する
            set(meta, SessionStatus::Working, &mut changed);
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

        // サブエージェントはバッジの数だけを動かす。状態そのものは遷移させない（設計§5）
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
        for event in [HookEvent::SessionStart, HookEvent::Stop] {
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
