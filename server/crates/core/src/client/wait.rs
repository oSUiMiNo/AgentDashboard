//! 待ちの作法（CLI設計§8）。
//!
//! `ClientMessage` は投げっぱなしで、結果は後から `SessionUpsert`／`Error` で返る。
//! ブラウザは画面を開き続けているのでそれで困らないが、**1回で終わる CLI は
//! 「いつ待つのをやめるか」を自分で決めなければならない**（§8-1）。ここがその置き場所。
//!
//! # 観測は純関数、時間は外側
//!
//! 「何をもって届いたとするか」（[`Goal`]）は知らせを1つずつ見る純関数にして、
//! ソケットもタイマーも持たせない——机の上で単体テストを書けるようにするため。
//! 時間切れは駆動側（[`run`]）が `tokio::time::timeout` で外から掛ける。

use std::collections::HashSet;
use std::time::Duration;

use protocol::ws::ServerMessage;
use protocol::{CardId, PermissionMode, SessionStatus};

use super::ClientError;
use super::ws::Ws;

/// 各操作の待ちの上限（CLI設計§8-2 の表の右端）。
pub const SPAWN_CAP: Duration = Duration::from_secs(60);
pub const KILL_CAP: Duration = Duration::from_secs(30);
pub const REMOVE_CAP: Duration = Duration::from_secs(30);
/// `revive`：起動を待つのと同じ長さ。**やっていることが起動そのもの**なので揃える
pub const REVIVE_CAP: Duration = Duration::from_secs(60);
pub const MODEL_CAP: Duration = Duration::from_secs(60);
pub const MODE_CAP: Duration = Duration::from_secs(60);
/// `send --wait` の既定。`--timeout` で変えられる唯一の枠（他は固定でよい——
/// 変えたくなる長さを持つのは「本物のターンの終わり」を待つ send だけ）
pub const SEND_DEFAULT_CAP_SECS: u64 = 600;

/// 待ちが満ちたときの持ち帰り。
#[derive(Debug)]
pub struct Outcome {
    /// 人が読む1行（`spawn` ならフルの カードID）
    pub human: String,
    /// 確定に使った知らせをそのまま（`--json` 用。CLI設計§10-2——CLI 側で作り直さない）
    pub raw: String,
}

/// 観測の結果。
pub enum Step {
    Done(Outcome),
    Continue,
    /// 標準エラーへ出す文（待っている操作と無関係な `Error`。§7-3——黙って失敗させない）
    Note(String),
    /// 断られた。**時間切れを待たずにその場で落ちる**（§8-2）
    Fail(String),
}

/// 何をもって「届いた」とするか（CLI設計§8-2 の表の左側）。
pub enum Goal {
    /// `spawn`：**送る前に控えた集合に無い**カードの `SessionUpsert`（§8-3）。
    /// `cwd` の一致で待つと、同じフォルダで既に走っているカードの更新を掴む
    NewCard { known: HashSet<String> },
    /// `send --wait`：status が `WaitingInput` へ**戻る**。二段で見る——接続直後に
    /// 流れてくる写し（送る前の `WaitingInput`）を掴まないため、**忙しい状態
    /// （Working／WaitingPermission／Stalled）を一度見てからでないと満ちない**。
    /// 「WaitingInput 以外」で武装すると、写しの WaitingInput 自身が武装役になり、
    /// 定期報告の WaitingInput がもう1発来ただけで満ちてしまう（コードレビュー対応1）
    TurnEnded { card: CardId, seen_busy: bool },
    /// `kill`：status が `Ended` になる
    Ended { card: CardId },
    /// `rm`：`SessionRemoved` が来る
    Removed { card: CardId },
    /// `revive`：**接続直後の写しを1枚見送ってから**、`SessionUpsert` で `Starting` かつ
    /// 「繋がっている」（接続断のカードを復旧ボタンで戻す 設計§10-2）。
    ///
    /// # なぜ二段なのか
    ///
    /// **写しは必ず来る。** サーバは接続直後、そのアカウントの全カードを
    /// `SessionUpsert` で流してから受け付けを始める（`server-core/src/ws.rs`）ので、
    /// 送る前に必ずそのカードの写しが1枚届く。
    ///
    /// 一段（`Starting` かつ繋がっている）では**動いているカードで嘘をつく**。
    /// 起こしたてでフックがまだ1件も来ていないカードは `Starting` のまま繋がっており、
    /// 写しがそのまま条件を満たす——サーバは正しく断っているのに、**その断りが届く前に
    /// 「起こし直しました」と言ってしまう**（実際にこれを踏んだ）。
    ///
    /// 二段にすれば、満ちるのは**送ったあとに動いた**ときだけになる。
    ///
    /// **`Status`（差分）では満ちない。** あちらは `agent_connected` を運ばないので、
    /// 起こし直した実体かどうかを見分けられない。
    Revived { card: CardId, seen_snapshot: bool },
    /// `model`：切替要求の印（`model_requested`）が立ってから消える。二段で見るのは
    /// `TurnEnded` と同じ理由（写しの `None` を「もう終わった」と読まないため）
    ModelApplied { card: CardId, seen_requested: bool },
    /// `mode`：`permission_mode` が要求した値になる
    ModeApplied { card: CardId, mode: PermissionMode },
}

impl Goal {
    /// 知らせを1つ観測する。
    pub fn observe(&mut self, message: &ServerMessage) -> Step {
        // Error はどの Goal でも同じ扱い（CLI設計§8-2・§7-3）：
        // 対象カード宛てか宛先なし（Spawn の失敗・解釈不能）は即座に落ち、
        // 別のカード宛ては標準エラーへ出して待ち続ける
        if let ServerMessage::Error { card_id, message } = message {
            return match (card_id, self.card()) {
                (None, _) => Step::Fail(message.clone()),
                (Some(errored), Some(card)) if errored == card => Step::Fail(message.clone()),
                (Some(errored), _) => Step::Note(format!(
                    "（待っている操作とは別のカード {} の知らせ）{message}",
                    super::output::short_id(&errored.to_string())
                )),
            };
        }
        match self {
            Self::NewCard { known } => {
                if let ServerMessage::SessionUpsert { session } = message {
                    let id = session.card_id.to_string();
                    if !known.contains(&id) {
                        return done(id, message);
                    }
                }
                Step::Continue
            }
            Self::TurnEnded { card, seen_busy } => {
                let card = *card;
                match status_of(message, &card) {
                    Some(SessionStatus::WaitingInput) if *seen_busy => {
                        done("ターンが終わり、入力待ちへ戻りました".to_string(), message)
                    }
                    Some(SessionStatus::Ended { ok }) => Step::Fail(format!(
                        "待っている間にセッションが終了しました（{}）",
                        if ok { "正常終了" } else { "異常終了" }
                    )),
                    // 武装するのは**ターンの進行中と言える状態だけ**を名指しで。
                    // Starting（指示がまだ届いていないかもしれない）と Unknown で
                    // 武装すると、届かなかった指示を「終わった」と読み違える
                    Some(
                        SessionStatus::Working
                        | SessionStatus::WaitingPermission
                        | SessionStatus::Stalled,
                    ) => {
                        *seen_busy = true;
                        Step::Continue
                    }
                    Some(_) => Step::Continue,
                    None => Step::Continue,
                }
            }
            Self::Ended { card } => match status_of(message, card) {
                Some(SessionStatus::Ended { ok }) => done(
                    format!(
                        "終了しました（{}）",
                        if ok { "正常終了" } else { "異常終了" }
                    ),
                    message,
                ),
                _ => Step::Continue,
            },
            Self::Removed { card } => match message {
                ServerMessage::SessionRemoved { card_id } if card_id == card => {
                    done("一覧から外しました".to_string(), message)
                }
                _ => Step::Continue,
            },
            Self::Revived {
                card,
                seen_snapshot,
            } => {
                if let ServerMessage::SessionUpsert { session } = message
                    && session.card_id == *card
                {
                    // 1枚目は接続直後の写し。**見送る**（送る前の姿なので、何を
                    // 言っていても起こし直しの結果ではない）
                    if !*seen_snapshot {
                        *seen_snapshot = true;
                        return Step::Continue;
                    }
                    if session.status == SessionStatus::Starting && session.agent_connected {
                        return done("起こし直しました".to_string(), message);
                    }
                }
                Step::Continue
            }
            Self::ModelApplied {
                card,
                seen_requested,
            } => {
                if let ServerMessage::SessionUpsert { session } = message
                    && session.card_id == *card
                {
                    if let SessionStatus::Ended { .. } = session.status {
                        return Step::Fail("待っている間にセッションが終了しました".to_string());
                    }
                    if session.model_requested.is_some() {
                        *seen_requested = true;
                        return Step::Continue;
                    }
                    if *seen_requested {
                        let label = session
                            .model_label
                            .clone()
                            .or_else(|| session.model.as_ref().map(|model| model.to_string()))
                            .unwrap_or_else(|| "不明".to_string());
                        return done(format!("モデルを切り替えました：{label}"), message);
                    }
                }
                Step::Continue
            }
            Self::ModeApplied { card, mode } => {
                if let ServerMessage::SessionUpsert { session } = message
                    && session.card_id == *card
                {
                    if let SessionStatus::Ended { .. } = session.status {
                        return Step::Fail("待っている間にセッションが終了しました".to_string());
                    }
                    if session.permission_mode.as_ref() == Some(mode) {
                        return done(
                            format!("権限モードを切り替えました：{}", mode.as_str()),
                            message,
                        );
                    }
                }
                Step::Continue
            }
        }
    }

    /// この Goal が見ているカード。`NewCard` はまだ持っていない。
    fn card(&self) -> Option<&CardId> {
        match self {
            Self::NewCard { .. } => None,
            Self::TurnEnded { card, .. }
            | Self::Ended { card }
            | Self::Removed { card }
            | Self::Revived { card, .. }
            | Self::ModelApplied { card, .. }
            | Self::ModeApplied { card, .. } => Some(card),
        }
    }
}

/// 確定に使った知らせをそのまま持ち帰る（`--json` の約束）。
fn done(human: String, message: &ServerMessage) -> Step {
    Step::Done(Outcome {
        human,
        raw: serde_json::to_string_pretty(message).expect("受け取れた知らせは必ず JSON へ戻せる"),
    })
}

/// カード宛ての status を取り出す。`SessionUpsert`（全体）と `Status`（差分）の両方が運ぶ。
fn status_of(message: &ServerMessage, card: &CardId) -> Option<SessionStatus> {
    match message {
        ServerMessage::SessionUpsert { session } if session.card_id == *card => {
            Some(session.status)
        }
        ServerMessage::Status {
            card_id, status, ..
        } if card_id == card => Some(*status),
        _ => None,
    }
}

/// 満ちるか・断られるか・時間が切れるまで、知らせを受け取り続ける。
///
/// 時間切れは [`ClientError::Timeout`]（終了コード3）。**1（断られた）と分ける**のが
/// 要点で、同じにするとエージェントが「確かめられなかっただけ」の操作を送り直して
/// 二重に効かせる経路ができる（CLI設計§8-4）。
pub async fn run(
    ws: &mut Ws,
    mut goal: Goal,
    what: &str,
    cap: Duration,
) -> Result<Outcome, ClientError> {
    tokio::time::timeout(cap, async {
        loop {
            let message = ws.next_event().await?;
            match goal.observe(&message) {
                Step::Done(outcome) => return Ok(outcome),
                Step::Continue => {}
                Step::Note(text) => eprintln!("{text}"),
                Step::Fail(message) => {
                    return Err(ClientError::Refused {
                        status: 400,
                        message,
                    });
                }
            }
        }
    })
    .await
    .map_err(|_| ClientError::Timeout {
        what: what.to_string(),
        secs: cap.as_secs(),
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{ProjectId, SessionMeta};

    fn meta(card: CardId, status: SessionStatus) -> SessionMeta {
        SessionMeta {
            card_id: card,
            project: ProjectId("/tmp/proj".to_string()),
            claude_session_id: None,
            permission_mode: None,
            model: None,
            model_label: None,
            model_requested: None,
            status,
            subagent_active: 0,
            last_activity_at: 0,
            last_assistant_message: None,
            created_at: 0,
            hooks_seen: false,
            agent_id: None,
            agent_connected: true,
            account: None,
            toml_account: None,
            session_title: None,
        }
    }

    fn upsert(meta: SessionMeta) -> ServerMessage {
        ServerMessage::SessionUpsert {
            session: Box::new(meta),
        }
    }

    #[test]
    fn 新しいカードは控えた集合との差で見つける() {
        let old = CardId::new();
        let new = CardId::new();
        let mut goal = Goal::NewCard {
            known: HashSet::from([old.to_string()]),
        };
        // 控えにあるカードの知らせ（接続直後の写しと同じ形）では満ちない
        assert!(matches!(
            goal.observe(&upsert(meta(old, SessionStatus::WaitingInput))),
            Step::Continue
        ));
        // 控えに無いカードで満ち、フルの ID が持ち帰りになる
        match goal.observe(&upsert(meta(new, SessionStatus::Starting))) {
            Step::Done(outcome) => assert_eq!(outcome.human, new.to_string()),
            _ => panic!("新しいカードで満ちること"),
        }
    }

    #[test]
    fn ターンの終わりは一度忙しくなってから戻ったときだけ満ちる() {
        let card = CardId::new();
        let mut goal = Goal::TurnEnded {
            card,
            seen_busy: false,
        };
        // 接続直後の写し（送る前の WaitingInput）では満ちない——これを掴むと
        // 「送った指示のターンが終わった」と嘘をつくことになる
        assert!(matches!(
            goal.observe(&upsert(meta(card, SessionStatus::WaitingInput))),
            Step::Continue
        ));
        // 忙しくなったのを見て
        assert!(matches!(
            goal.observe(&ServerMessage::Status {
                card_id: card,
                status: SessionStatus::Working,
                subagent_active: 0,
                last_activity_at: 0,
            }),
            Step::Continue
        ));
        // 戻ったときに満ちる
        assert!(matches!(
            goal.observe(&ServerMessage::Status {
                card_id: card,
                status: SessionStatus::WaitingInput,
                subagent_active: 0,
                last_activity_at: 0,
            }),
            Step::Done(_)
        ));
    }

    #[test]
    fn 写しと定期報告の入力待ちだけでは満ちない() {
        // 接続直後の写し（WaitingInput）が武装役になってしまうと、statusLine 由来の
        // 定期報告がもう1発来ただけで「ターンが終わった」と嘘をつく（コードレビュー対応1）。
        // 武装は忙しい状態（Working 等）を名指しで見たときだけ
        let card = CardId::new();
        let mut goal = Goal::TurnEnded {
            card,
            seen_busy: false,
        };
        for _ in 0..3 {
            assert!(
                matches!(
                    goal.observe(&upsert(meta(card, SessionStatus::WaitingInput))),
                    Step::Continue
                ),
                "WaitingInput を何度見ても、忙しさを見る前に満ちてはいけない"
            );
        }
        // Starting も武装役にしない——指示がまだ届いていない可能性がある（初期実装§17）
        assert!(matches!(
            goal.observe(&upsert(meta(card, SessionStatus::Starting))),
            Step::Continue
        ));
        assert!(matches!(
            goal.observe(&upsert(meta(card, SessionStatus::WaitingInput))),
            Step::Continue
        ));
        // 忙しさを見てから戻れば満ちる
        assert!(matches!(
            goal.observe(&upsert(meta(card, SessionStatus::Working))),
            Step::Continue
        ));
        assert!(matches!(
            goal.observe(&upsert(meta(card, SessionStatus::WaitingInput))),
            Step::Done(_)
        ));
    }

    #[test]
    fn 対象カードのエラーと宛先なしのエラーは待ちを打ち切る() {
        let card = CardId::new();
        let mut goal = Goal::Ended { card };
        assert!(matches!(
            goal.observe(&ServerMessage::Error {
                card_id: Some(card),
                message: "駄目でした".to_string(),
            }),
            Step::Fail(_)
        ));
        // 宛先なし（Spawn の失敗・解釈不能）はどの Goal でも打ち切り
        let mut spawn_goal = Goal::NewCard {
            known: HashSet::new(),
        };
        assert!(matches!(
            spawn_goal.observe(&ServerMessage::Error {
                card_id: None,
                message: "起こせませんでした".to_string(),
            }),
            Step::Fail(_)
        ));
    }

    #[test]
    fn 別のカードのエラーは標準エラーへ出して待ち続ける() {
        let card = CardId::new();
        let other = CardId::new();
        let mut goal = Goal::TurnEnded {
            card,
            seen_busy: true,
        };
        match goal.observe(&ServerMessage::Error {
            card_id: Some(other),
            message: "よそで何か".to_string(),
        }) {
            // 黙って失敗させないための Note（CLI設計§7-3）。待ちそのものは続く
            Step::Note(text) => assert!(text.contains("よそで何か"), "本文が残ること: {text}"),
            _ => panic!("別カードのエラーは Note になること"),
        }
    }

    #[test]
    fn 終了待ちは正常異常を言い分けて満ちる() {
        let card = CardId::new();
        let mut goal = Goal::Ended { card };
        match goal.observe(&upsert(meta(card, SessionStatus::Ended { ok: false }))) {
            Step::Done(outcome) => assert!(outcome.human.contains("異常終了")),
            _ => panic!("Ended で満ちること"),
        }
    }

    #[test]
    fn 外し待ちは該当カードの知らせだけで満ちる() {
        let card = CardId::new();
        let other = CardId::new();
        let mut goal = Goal::Removed { card };
        assert!(matches!(
            goal.observe(&ServerMessage::SessionRemoved { card_id: other }),
            Step::Continue
        ));
        assert!(matches!(
            goal.observe(&ServerMessage::SessionRemoved { card_id: card }),
            Step::Done(_)
        ));
    }

    /// 起こし直しの待ちを、接続直後の写しを1枚見送った状態で作る。
    fn 写しを見送った起こし直し(card: CardId, 写し: SessionMeta) -> Goal {
        let mut goal = Goal::Revived {
            card,
            seen_snapshot: false,
        };
        assert!(
            matches!(goal.observe(&upsert(写し)), Step::Continue),
            "接続直後の写しで満ちてはいけない"
        );
        goal
    }

    #[test]
    fn 起こし直しは写しを見送ってから繋がった起動中で満ちる() {
        let card = CardId::new();
        let mut shell = meta(card, SessionStatus::Working);
        shell.agent_connected = false;
        let mut goal = 写しを見送った起こし直し(card, shell);

        let mut revived = meta(card, SessionStatus::Starting);
        revived.agent_connected = true;
        assert!(matches!(goal.observe(&upsert(revived)), Step::Done(_)));
    }

    #[test]
    fn 動いているカードの写しでは起こし直しは満ちない() {
        // **一段（Starting かつ繋がっている）だとここで嘘をつく。** 起こしたてで
        // フックがまだ来ていないカードは `Starting` のまま繋がっているので、写しが
        // そのまま条件を満たす——サーバは正しく断っているのに、その断りが届く前に
        // 「起こし直しました」と言ってしまう（実際に踏んだ）
        let card = CardId::new();
        let mut 起こしたて = meta(card, SessionStatus::Starting);
        起こしたて.agent_connected = true;
        let mut goal = Goal::Revived {
            card,
            seen_snapshot: false,
        };
        assert!(
            matches!(goal.observe(&upsert(起こしたて)), Step::Continue),
            "写しで満ちている"
        );
        // 断りが届けば、そこで落ちる
        assert!(matches!(
            goal.observe(&ServerMessage::Error {
                card_id: Some(card),
                message: "このセッションは動いています（復旧は要りません）".to_string(),
            }),
            Step::Fail(_)
        ));
    }

    #[test]
    fn 起こし直しは写しのあとでも状態が揃わなければ満ちない() {
        let card = CardId::new();
        let mut shell = meta(card, SessionStatus::Working);
        shell.agent_connected = false;
        let mut goal = 写しを見送った起こし直し(card, shell.clone());

        // 繋がっていない Starting（起こし直しの前に別の報告が挟まった形）
        let mut 繋がらない = meta(card, SessionStatus::Starting);
        繋がらない.agent_connected = false;
        assert!(matches!(goal.observe(&upsert(繋がらない)), Step::Continue));
        // 繋がっているが Starting ではない
        let mut 起動中でない = meta(card, SessionStatus::WaitingInput);
        起動中でない.agent_connected = true;
        assert!(matches!(
            goal.observe(&upsert(起動中でない)),
            Step::Continue
        ));
    }

    #[test]
    fn 起こし直しは差分の知らせでは満ちない() {
        // `Status` は `agent_connected` を運ばないので、起こし直した実体かどうかを
        // 見分けられない。**運んでいない値で判断しない**
        let card = CardId::new();
        let mut shell = meta(card, SessionStatus::Working);
        shell.agent_connected = false;
        let mut goal = 写しを見送った起こし直し(card, shell);
        assert!(matches!(
            goal.observe(&ServerMessage::Status {
                card_id: card,
                status: SessionStatus::Starting,
                subagent_active: 0,
                last_activity_at: 0,
            }),
            Step::Continue
        ));
    }

    #[test]
    fn モデル切替は要求の印が立ってから消えたときだけ満ちる() {
        let card = CardId::new();
        let mut goal = Goal::ModelApplied {
            card,
            seen_requested: false,
        };
        // 接続直後の写し（印なし）では満ちない
        assert!(matches!(
            goal.observe(&upsert(meta(card, SessionStatus::WaitingInput))),
            Step::Continue
        ));
        // 印が立つ（切替要求が渡った）
        let mut requested = meta(card, SessionStatus::WaitingInput);
        requested.model_requested = Some(protocol::ModelId::new("opus"));
        assert!(matches!(goal.observe(&upsert(requested)), Step::Continue));
        // 印が消えて、確定したモデルが持ち帰りになる
        let mut applied = meta(card, SessionStatus::WaitingInput);
        applied.model = Some(protocol::ModelId::new("claude-opus-5"));
        applied.model_label = Some("Opus 5".to_string());
        match goal.observe(&upsert(applied)) {
            Step::Done(outcome) => assert!(outcome.human.contains("Opus 5")),
            _ => panic!("印が消えたら満ちること"),
        }
    }

    #[test]
    fn 権限モード切替は要求した値になったときに満ちる() {
        let card = CardId::new();
        let mut goal = Goal::ModeApplied {
            card,
            mode: PermissionMode::new("acceptEdits"),
        };
        let mut wrong = meta(card, SessionStatus::WaitingInput);
        wrong.permission_mode = Some(PermissionMode::new("plan"));
        assert!(matches!(goal.observe(&upsert(wrong)), Step::Continue));
        let mut right = meta(card, SessionStatus::WaitingInput);
        right.permission_mode = Some(PermissionMode::new("acceptEdits"));
        assert!(matches!(goal.observe(&upsert(right)), Step::Done(_)));
    }
}
