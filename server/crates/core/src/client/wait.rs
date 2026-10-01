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

use protocol::ws::{ErrorKind, OpId, ServerMessage};
use protocol::{CardId, PermissionMode, SessionStatus};

use super::ClientError;
use super::ws::Ws;

/// 各操作の待ちの上限（CLI設計§8-2 の表の右端）。
pub const SPAWN_CAP: Duration = Duration::from_secs(60);
pub const KILL_CAP: Duration = Duration::from_secs(30);
pub const REMOVE_CAP: Duration = Duration::from_secs(30);
/// `revive`：起動を待つ長さ ＋ 起こし直しの判定が Windows 側の空きを確かめる上限
/// （寝ているカードばかりなのに、メモリ不足でセッションを起こせない 設計§6-5）。
///
/// **確かめる上限は `session-host-core` の定数を参照する。** 2箇所に数を書くと、片方だけ
/// 直したときに CLI が裏の判定より先に諦める。
///
/// **断りは `Error{kind: Revive}` で届いてその場で落ちる**ので、長くなるのは通る道だけ。
/// **席待ちは含まれない**——まとめて投げると行列は長くなりうるので、上限をいくら上げても
/// 全部は吸収できない。**時間切れの文面（[`note_revive_timeout`]）が本体である。**
pub const REVIVE_CAP: Duration =
    Duration::from_secs(SPAWN_CAP.as_secs() + session_host_core::resources::CONFIRM_WAIT.as_secs());
/// `branch`：寝ている元を起こし直す長さ（[`REVIVE_CAP`]。Windows 側の空きの確かめを含む）
/// ＋ 枝分かれ自身の長さ（[`SPAWN_CAP`]。以前はこれだけだった）（実装レビュー第2回 Astra 3）。
///
/// 以前は寝ている元の確かめ（最大 65 秒）だけで枠を使い切り、正常に進んでいる枝分かれでも
/// CLI が先に時間切れになった。**作業中の元のターンの終わりを待つ段は含めない**——サーバは
/// 最大 30 分待つので、上限をいくら上げても吸収しきれない。時間切れの文面
/// （[`note_revive_timeout`]）で、裏で続いていることを伝える。
pub const BRANCH_CAP: Duration = Duration::from_secs(REVIVE_CAP.as_secs() + SPAWN_CAP.as_secs());

/// 起こし直しの時間切れに、**裏ではまだ続いているかもしれない**ことと確かめ方を添える。
///
/// 時間切れは「断られた」ではない。添えないと、利用者もエージェントも送り直して
/// 「このカードは復旧中です」に当たる。**枝分かれも同じ**（段取りはサーバが持っていて、
/// CLI が待つのをやめても止まらない。実装レビュー第2回 Astra 3）。
pub fn note_revive_timeout(error: ClientError) -> ClientError {
    match error {
        ClientError::Timeout { what, secs, .. } => ClientError::Timeout {
            what,
            secs,
            note: Some(
                "裏ではまだ続いている可能性があります（session ls で確かめられます）".to_string(),
            ),
        },
        other => other,
    }
}
/// 終了の時間切れに、**答えが届かなかっただけかもしれない**ことと確かめ方を添える（実装レビュー
/// 第6回 Astra 1）。
///
/// 終了は頼みの番号が付いた答えでしか満ちない。サーバか PC が古い版だと番号を運ばないので、
/// 止まっていても答えが来ない——時間切れは「止められなかった」ではない。
pub fn note_kill_timeout(error: ClientError) -> ClientError {
    match error {
        ClientError::Timeout { what, secs, .. } => ClientError::Timeout {
            what,
            secs,
            note: Some(
                "止まっていても、サーバか PC が古い版だと答えが届きません（session ls で確かめられます）"
                    .to_string(),
            ),
        },
        other => other,
    }
}

/// 起こし直しの時間切れに、裏で続いているかもしれないことと、**答えが届かなかっただけかも
/// しれない**ことを添える（実装レビュー第6回）。
///
/// 枝分かれの時間切れ（[`note_revive_timeout`]）とは分ける。枝分かれは新しいカードが増えるのを
/// 待つので、版が古くても答えの届かない形にならない。
pub fn note_revive_answer_timeout(error: ClientError) -> ClientError {
    match error {
        ClientError::Timeout { what, secs, .. } => ClientError::Timeout {
            what,
            secs,
            note: Some(
                "裏ではまだ続いている可能性があります。起きていても、サーバか PC が古い版だと答えが届きません（session ls で確かめられます）"
                    .to_string(),
            ),
        },
        other => other,
    }
}

pub const MODEL_CAP: Duration = Duration::from_secs(60);
pub const MODE_CAP: Duration = Duration::from_secs(60);
/// 名前を付ける（名前付け設計§11-2）。**記録へ書くだけ**なので PTY を待たない
pub const NICKNAME_CAP: Duration = Duration::from_secs(30);
/// メモの反映。**記録へ書いてから配られる**（設計§9-1）ので、待つのは1往復ぶん。
pub const MEMO_CAP: Duration = Duration::from_secs(30);
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
    ///
    /// # `origin` は「頼んだ相手の席」（ブランチ設計§8-4）
    ///
    /// `spawn` と `recall` は**頼む時点で席が無い**ので `None`。**枝分かれだけは
    /// 押した席がある**ので、そこを入れる。
    ///
    /// 入れないと、**その席宛ての断りが「別のカードの知らせ」として流され、待ちは
    /// 時間切れまで続く**——表に出るのは「終わりませんでした」だけになり、**症状は
    /// 見えるが理由は見えない**（2026-09-08 に実運用で踏んだ）。
    NewCard {
        known: HashSet<String>,
        origin: Option<CardId>,
    },
    /// `send --wait`：status が `WaitingInput` へ**戻る**。二段で見る——接続直後に
    /// 流れてくる写し（送る前の `WaitingInput`）を掴まないため、**忙しい状態
    /// （Working／WaitingPermission／Stalled）を一度見てからでないと満ちない**。
    /// 「WaitingInput 以外」で武装すると、写しの WaitingInput 自身が武装役になり、
    /// 定期報告の WaitingInput がもう1発来ただけで満ちてしまう（コードレビュー対応1）
    TurnEnded { card: CardId, seen_busy: bool },
    /// `kill`：**頼んだ番号（`op`）が付いた答え**で決まる（寝ているカードばかりなのに、メモリ不足で
    /// セッションを起こせない 実装レビュー第6回 Astra 1）。
    ///
    /// - その番号の付いた `Status`（サーバが記録のいまの状態に添えて配る）→ 止まった
    /// - その番号を含む `Error` → 止められなかった・届かなかった
    /// - **それ以外は合否に使わない**（状態の変化も、他の頼みへの答えも、番号の無い断りも）
    ///
    /// # なぜ番号なのか
    ///
    /// 以前は接続直後の写しを1枚見送り、その後の `Ended` と、取り下げの断り（`withdrawn`）と、
    /// 写しが終わっていたかで推し量っていた。それぞれ別の順で破れた：写しは連絡係を使う構成で
    /// 2枚届き、2枚目の `Ended` で頼みの結果を待たずに満ちた。写しが終わっていれば種別 `kill` の
    /// 断りを全部成功に変えたので、確かめ待ちの起こし直しへ頼みが**届かなかった**断りまで成功に
    /// なり、後からプロセスが起きた。**どの頼みへの答えかを推し量るのをやめ、番号で対応づける。**
    ///
    /// 何も無かったカード（前回の起動が残した抜け殻）を成功とするか、届かなかったか、の見分けは
    /// サーバが記録と合わせて決めて、答えの形（`Status`／`Error`）で返してくる。
    ///
    /// 古いサーバ・古い PC は番号を運ばないので答えが来ず、時間切れで終わる
    /// （[`note_kill_timeout`]）。止まっていないものを「止まった」とは言わない側に倒す。
    Ended { card: CardId, op: OpId },
    /// `session nickname`：そのカードの `SessionUpsert` が、頼んだ名前を持って返る
    /// （名前付け設計§11-2）。
    ///
    /// **二段にしない。** 復旧（[`Goal::Revived`]）が二段なのは、満ちる条件
    /// （`Starting` かつ繋がっている）を**接続直後の写しがそのまま満たしてしまう**ため
    /// だった。こちらが待つのは「頼んだ名前になっていること」で、**まだ頼んでいない
    /// 写しがその値を持っているなら、それは既にそうなっているということ**である——
    /// 嘘にならないので、見送る必要が無い。
    ///
    /// **`Status`（差分）では満ちない。** あちらは名前を運ばない（設計§5-4）。
    NicknameSet {
        card: CardId,
        expected: Option<String>,
    },
    /// `rm`：`SessionRemoved` が来る
    Removed { card: CardId },
    /// `memo …`：宛先ぶんの一覧（`Memos`）が来る。
    ///
    /// **書いたあとは必ず一覧が配られる**（記録へ書いてから配る・設計§9-1）ので、
    /// 5つの口すべてがこれで満ちる。**宛先を指定しないのは編集・チェック・削除**——
    /// あちらは宛先を運ばず、**サーバが行から引く**ので、こちらは知らない。
    MemosSeen {
        target: Option<protocol::AnnotationTarget>,
    },
    /// `revive`：**頼んだ番号（`op`）が付いた答え**で決まる（寝ているカードばかりなのに、メモリ
    /// 不足でセッションを起こせない 実装レビュー第6回）。決まり方は [`Goal::Ended`] と同じ：
    ///
    /// - その番号の付いた `Status`（PC が実体を作り終えた答えを、サーバが記録のいまの状態に添えて
    ///   配る）→ 起こせた
    /// - その番号を含む `Error` → 断られた（メモリ不足・競合・動いている・届かなかった など）
    /// - **それ以外は合否に使わない**
    ///
    /// # なぜ番号なのか
    ///
    /// 以前は接続直後の写しを1枚見送り、その後の `SessionUpsert` が「起動中かつ繋がっている」
    /// なら満ちていた。**写しは連絡係を使う構成では2枚届く**（接続直後の読み直しと初期一覧）ので、
    /// 起こしたてで起動中のまま繋がっているカードでは2枚目の写しで満ち、サーバが「動いています」
    /// と断っているのに「起こし直しました」と言いえた。終了の待ちと同じ穴である。
    ///
    /// 古いサーバ・古い PC は番号を運ばないので答えが来ず、時間切れで終わる
    /// （[`note_revive_answer_timeout`]）。
    Revived { card: CardId, op: OpId },
    /// `model`：切替要求の印（`model_requested`）が立ってから消える。二段で見るのは
    /// `TurnEnded` と同じ理由（写しの `None` を「もう終わった」と読まないため）
    ModelApplied { card: CardId, seen_requested: bool },
    /// `mode`：`permission_mode` が要求した値になる
    ModeApplied { card: CardId, mode: PermissionMode },
}

impl Goal {
    /// 知らせを1つ観測する。
    pub fn observe(&mut self, message: &ServerMessage) -> Step {
        // **外す待ちは、取り下げた起こし直しの断りでだけ待ち続ける**（実装レビュー Astra 1・
        // 第2回 Astra 4）。外すと、そのカードで進んでいた起こし直しが取り下げられ、その断り
        // （種別 `revive`）が外れた知らせより先に届くことがある。下の規則のまま読むと、
        // 外れたのに「外せませんでした」と言う。
        //
        // **それ以外は下の規則で落ちる。** 以前は外す種別以外を全部聞き流していたので、
        // 解決した後に別の画面でカードが外されたとき、持ち主の門が返す `NotFound` まで
        // 聞き流し、もう届かない外れた知らせを上限まで待っていた
        if let (
            Self::Removed { card },
            ServerMessage::Error {
                card_id: Some(errored),
                message,
                kind: ErrorKind::Revive,
                ..
            },
        ) = (&*self, message)
            && errored == card
        {
            return Step::Note(format!("（外す前に進んでいた起こし直しの知らせ）{message}"));
        }
        // **番号で待つ待ち（終了・起こし直し）は、頼みの番号が付いた答えでだけ決まる**（実装
        // レビュー第6回 Astra 1）。断りはこの番号を含むものだけが答えで、他は宛先のカードが同じでも
        // 聞き流す（起こし直しの取り下げの断り・他の頼みへの断り・番号の無い古い断り）
        if let (
            Some((card, op)),
            ServerMessage::Error {
                message: text, ops, ..
            },
        ) = (self.answered_by(), message)
        {
            if ops.contains(op) {
                return Step::Fail(text.clone());
            }
            let 宛先 = match message {
                ServerMessage::Error {
                    card_id: Some(errored),
                    ..
                } if errored == card => "このカードの、頼みとは別の知らせ".to_string(),
                ServerMessage::Error {
                    card_id: Some(errored),
                    ..
                } => format!(
                    "待っている操作とは別のカード {} の知らせ",
                    super::output::short_id(&errored.to_string())
                ),
                _ => "カードに紐づかない知らせ".to_string(),
            };
            return Step::Note(format!("（{宛先}）{text}"));
        }
        // **枝分かれの待ちは、元のセッションの起こし直しの知らせでは落ちない**（実装
        // レビュー第2回 Astra 2）。寝ている元はサーバの段取りが起こすので、その知らせが元の
        // 席宛てに届く。競合（人が先に起こしていた）なら待てば起きるし、終わった断りなら
        // 段取り自身が理由を添えて枝分かれを断る（種別 `branch`）。**枝分かれが済んだか
        // 断られたかを決めるのは段取りの知らせだけ**にする——ここで落ちると、CLI が失敗を
        // 返した後も裏で枝分かれが進む
        if let (
            Self::NewCard {
                origin: Some(origin),
                ..
            },
            ServerMessage::Error {
                card_id: Some(errored),
                message,
                kind: ErrorKind::Revive,
                ..
            },
        ) = (&*self, message)
            && errored == origin
        {
            return Step::Note(format!("（元のセッションの起こし直しの知らせ）{message}"));
        }
        // Error はどの Goal でも同じ扱い（CLI設計§8-2・§7-3）：
        // 対象カード宛てか宛先なし（Spawn の失敗・解釈不能）は即座に落ち、
        // 別のカード宛ては標準エラーへ出して待ち続ける
        if let ServerMessage::Error {
            card_id, message, ..
        } = message
        {
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
            Self::NewCard { known, .. } => {
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
                    // `WaitingSubagents` もここに入れる。**ターンは終わっているが仕事は
                    // 終わっていない**ので（設計§14）、待っている側から見れば進行中である
                    Some(
                        SessionStatus::Working
                        | SessionStatus::WaitingPermission
                        | SessionStatus::Stalled
                        | SessionStatus::WaitingSubagents,
                    ) => {
                        *seen_busy = true;
                        Step::Continue
                    }
                    Some(_) => Step::Continue,
                    None => Step::Continue,
                }
            }
            Self::Ended { card, op } => match message {
                ServerMessage::Status {
                    card_id,
                    status,
                    op: Some(answered),
                    ..
                } if card_id == card && answered == op => done(
                    match status {
                        SessionStatus::Ended { ok } => format!(
                            "終了しました（{}）",
                            if *ok { "正常終了" } else { "異常終了" }
                        ),
                        // 合否には使わない（答えが番号付きで届いたことが根拠）。添えるだけ
                        _ => "止めました".to_string(),
                    },
                    message,
                ),
                _ => Step::Continue,
            },
            Self::NicknameSet { card, expected } => match message {
                ServerMessage::SessionUpsert { session }
                    if session.card_id == *card && session.nickname == *expected =>
                {
                    done(
                        match expected {
                            Some(name) => format!("名前を「{name}」にしました"),
                            None => "名前を消しました".to_string(),
                        },
                        message,
                    )
                }
                _ => Step::Continue,
            },
            Self::Removed { card } => match message {
                ServerMessage::SessionRemoved { card_id } if card_id == card => {
                    done("一覧から外しました".to_string(), message)
                }
                _ => Step::Continue,
            },
            Self::MemosSeen { target } => match message {
                // 宛先を指定しているとき（一覧・追加）は突き合わせる。指定していない
                // とき（編集・チェック・削除）は、来た一覧をそのまま結果とする
                ServerMessage::Memos { target: got, memos }
                    if target.as_ref().is_none_or(|want| want == got) =>
                {
                    done(format!("メモ {} 件", memos.len()), message)
                }
                _ => Step::Continue,
            },
            Self::Revived { card, op } => match message {
                ServerMessage::Status {
                    card_id,
                    status,
                    op: Some(answered),
                    ..
                } if card_id == card && answered == op => done(
                    match status {
                        // 合否には使わない（起こせたこと自体は本当）。起動直後に落ちたことを添える
                        SessionStatus::Ended { .. } => {
                            "起こし直しましたが、すぐに終了しました".to_string()
                        }
                        _ => "起こし直しました".to_string(),
                    },
                    message,
                ),
                _ => Step::Continue,
            },
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

    /// 番号で待つ待ちなら、そのカードと頼みの番号（終了・起こし直し）。
    fn answered_by(&self) -> Option<(&CardId, &OpId)> {
        match self {
            Self::Ended { card, op } | Self::Revived { card, op } => Some((card, op)),
            _ => None,
        }
    }

    /// この Goal が見ているカード。
    ///
    /// `NewCard` は**頼んだ相手の席があるときだけ**持つ（枝分かれ）。`spawn` と
    /// `recall` は頼む時点で席が無いので `None` のまま。
    fn card(&self) -> Option<&CardId> {
        match self {
            Self::NewCard { origin, .. } => origin.as_ref(),
            Self::TurnEnded { card, .. }
            | Self::Ended { card, .. }
            | Self::Removed { card }
            | Self::NicknameSet { card, .. }
            | Self::Revived { card, .. }
            | Self::ModelApplied { card, .. }
            | Self::ModeApplied { card, .. } => Some(card),
            // **メモはカードに紐づかない**（宛先はアカウントか CLI セッション）
            Self::MemosSeen { .. } => None,
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
        note: None,
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{ProjectId, SessionMeta};

    /// 復旧待ちの上限は、起動の上限と判定の確認段階の上限から組む（寝ているカードばかり
    /// なのに、メモリ不足でセッションを起こせない 設計§6-5）。
    #[test]
    fn 復旧待ちの上限は定数から組まれる() {
        assert_eq!(
            REVIVE_CAP,
            SPAWN_CAP + session_host_core::resources::CONFIRM_WAIT,
            "★裏の判定より先に CLI が諦めないこと"
        );
        assert_eq!(REVIVE_CAP, Duration::from_secs(125));
    }

    #[test]
    fn 復旧の時間切れは裏で続いている可能性と確かめ方を添える() {
        let error = note_revive_timeout(ClientError::Timeout {
            what: "セッションの起こし直し".to_string(),
            secs: REVIVE_CAP.as_secs(),
            note: None,
        });
        assert_eq!(error.exit_code(), 3, "時間切れのまま（断られたと混ぜない）");
        let text = error.to_string();
        assert!(text.contains("125 秒以内に終わりませんでした"), "{text}");
        assert!(
            text.contains("裏ではまだ続いている可能性があります"),
            "{text}"
        );
        assert!(text.contains("session ls"), "{text}");
        // 時間切れ以外は触らない
        let refused = note_revive_timeout(ClientError::Refused {
            status: 400,
            message: "断り".to_string(),
        });
        assert_eq!(refused.to_string(), "断り");
    }

    /// 枝分かれの待ちの上限は、寝ている元の起こし直し（確かめを含む）と枝分かれ自身の長さから
    /// 組む（実装レビュー第2回 Astra 3）。**確かめだけで 60 秒をまたぐ**ので、枝分かれ自身の
    /// 60 秒のままだと、正常に進んでいる枝分かれでも CLI が先に諦める。
    #[test]
    fn 枝分かれの待ちの上限は元の起こし直しを含めて定数から組まれる() {
        assert_eq!(BRANCH_CAP, REVIVE_CAP + SPAWN_CAP);
        assert!(
            session_host_core::resources::CONFIRM_WAIT > SPAWN_CAP,
            "前提：確かめだけで枝分かれ自身の枠をまたぐ"
        );
        assert!(
            BRANCH_CAP >= session_host_core::resources::CONFIRM_WAIT + SPAWN_CAP + SPAWN_CAP,
            "★確かめ・起こし直し・枝分かれ自身を吸収できない"
        );
        assert_eq!(BRANCH_CAP, Duration::from_secs(185));
    }

    /// **定数だけ直しても、`branch` が古い枠のままなら CLI は先に諦める。** 使う側を本文で見る
    /// （前例：`session-host-core` の `印は仕事を切り離す前に立てる`）。
    #[test]
    fn 枝分かれはその枠で待ち時間切れに裏で続いていることを添える() {
        let source = include_str!("mod.rs");
        let 本体 = source
            .find("pub async fn branch(")
            .map(|start| &source[start..])
            .expect("枝分かれの口があること");
        let 本体 = &本体[..本体.find("\n}\n").expect("関数の終わりがあること")];
        assert!(
            本体.contains("wait::BRANCH_CAP"),
            "★枝分かれが元の起こし直しを含めた枠で待っていない"
        );
        assert!(
            本体.contains("note_revive_timeout"),
            "★枝分かれの時間切れに、裏で続いていることを添えていない"
        );
    }

    #[test]
    fn 枝分かれの待ちは元の起こし直しの知らせでは落ちず段取りの知らせで決まる() {
        // 実装レビュー第2回 Astra 2。寝ている元はサーバの段取りが起こすので、その知らせが
        // 元の席宛てに届く。**競合は待てば起き、終わった断りは段取りが理由を添えて断る**——
        // 済んだか断られたかを決めるのは段取りの知らせだけ
        let 押した席 = CardId::new();
        let mut goal = Goal::NewCard {
            known: HashSet::new(),
            origin: Some(押した席),
        };
        for busy in [Some(true), Some(false), None] {
            let step = goal.observe(&ServerMessage::Error {
                card_id: Some(押した席),
                message: "このカードは復旧中です".to_string(),
                kind: ErrorKind::Revive,
                busy,
                withdrawn: None,
                ops: Vec::new(),
            });
            assert!(
                matches!(step, Step::Note(_)),
                "★元の起こし直しの知らせ（busy: {busy:?}）で、枝分かれの待ちが落ちている"
            );
        }
        // 段取り自身の断りでは、今までどおりその場で落ちる
        assert!(matches!(
            goal.observe(&ServerMessage::Error {
                card_id: Some(押した席),
                message: "元のセッションを起こせませんでした：メモリが足りない".to_string(),
                kind: ErrorKind::Branch,
                busy: None,
                withdrawn: None,
                ops: Vec::new(),
            }),
            Step::Fail(_)
        ));
        // 段取りが済めば、新しいカードで満ちる
        let mut goal = Goal::NewCard {
            known: HashSet::new(),
            origin: Some(押した席),
        };
        let 新しい席 = CardId::new();
        assert!(matches!(
            goal.observe(&ServerMessage::SessionUpsert {
                session: Box::new(meta(新しい席, SessionStatus::Starting)),
            }),
            Step::Done(_)
        ));
    }

    #[test]
    fn 外す待ちは持ち主の門の断りでその場で落ちる() {
        // 実装レビュー第2回 Astra 4。**聞き流すのは取り下げた起こし直しの断りだけ。** 解決の後に
        // 別の画面で外されると、持ち主の門は `NotFound` を返す。聞き流すと、もう届かない
        // 外れた知らせを上限まで待つ
        let card = CardId::new();
        let mut goal = Goal::Removed { card };
        assert!(
            matches!(
                goal.observe(&ServerMessage::Error {
                    card_id: Some(card),
                    message: "セッションが見つかりません".to_string(),
                    kind: ErrorKind::NotFound,
                    busy: None,
                    withdrawn: None,
                    ops: Vec::new(),
                }),
                Step::Fail(_)
            ),
            "★持ち主の門の断りを聞き流している"
        );
    }

    fn meta(card: CardId, status: SessionStatus) -> SessionMeta {
        SessionMeta {
            card_id: card,
            project: ProjectId("/tmp/proj".to_string()),
            claude_session_id: None,
            resumed_from: None,
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
            position: 0,
            nickname: None,
            branched_from: None,
            context_usage: None,
            rate_limits: None,
            cost: None,
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
            origin: None,
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
                op: None,
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
                op: None,
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
        // 終了の待ちは番号で決まるので、ここには入れない（下の `終了待ちは…` の試験）
        let card = CardId::new();
        let mut goal = Goal::TurnEnded {
            card,
            seen_busy: false,
        };
        assert!(matches!(
            goal.observe(&ServerMessage::Error {
                card_id: Some(card),
                message: "駄目でした".to_string(),
                kind: ErrorKind::Other,
                busy: None,
                withdrawn: None,
                ops: Vec::new(),
            }),
            Step::Fail(_)
        ));
        // 宛先なし（Spawn の失敗・解釈不能）はどの Goal でも打ち切り
        let mut spawn_goal = Goal::NewCard {
            known: HashSet::new(),
            origin: None,
        };
        assert!(matches!(
            spawn_goal.observe(&ServerMessage::Error {
                card_id: None,
                message: "起こせませんでした".to_string(),
                kind: ErrorKind::Other,
                busy: None,
                withdrawn: None,
                ops: Vec::new(),
            }),
            Step::Fail(_)
        ));
    }

    /// 番号付きの答え（サーバが記録のいまの状態に添えて配る `Status`）。
    fn 答え(card: CardId, op: OpId, status: SessionStatus) -> ServerMessage {
        ServerMessage::Status {
            card_id: card,
            status,
            subagent_active: 0,
            last_activity_at: 1,
            op: Some(op),
        }
    }

    fn 断り(card: Option<CardId>, kind: ErrorKind, ops: &[OpId]) -> ServerMessage {
        ServerMessage::Error {
            card_id: card,
            message: "止められませんでした".to_string(),
            kind,
            busy: None,
            withdrawn: None,
            ops: ops.to_vec(),
        }
    }

    #[test]
    fn 終了待ちは接続直後の写しのendedでは満ちず頼みへの答えで満ちる() {
        // 実装レビュー第6回 Astra 1(b)。連絡係を使う構成では、接続直後の読み直し
        // （`attach_browser`）と初期一覧で**同じ `Ended` の写しが2枚届く**。以前は1枚目だけを
        // 見送ったので、2枚目で頼みの結果を待たずに満ちた
        let card = CardId::new();
        let op = OpId::new();
        let mut goal = Goal::Ended { card, op };
        let 写し = upsert(meta(card, SessionStatus::Ended { ok: true }));
        for 何枚目 in 1..=3 {
            assert!(
                matches!(goal.observe(&写し), Step::Continue),
                "★{何枚目}枚目の写しの `Ended` で満ちた"
            );
        }
        for (何の知らせ, message) in [
            (
                "番号の無い状態の `Ended`",
                ServerMessage::Status {
                    card_id: card,
                    status: SessionStatus::Ended { ok: true },
                    subagent_active: 0,
                    last_activity_at: 1,
                    op: None,
                },
            ),
            (
                "別の頼みへの答え",
                答え(card, OpId::new(), SessionStatus::Ended { ok: true }),
            ),
            (
                "別のカードへの同じ番号",
                答え(CardId::new(), op, SessionStatus::Ended { ok: true }),
            ),
        ] {
            assert!(
                matches!(goal.observe(&message), Step::Continue),
                "★{何の知らせ}で満ちた"
            );
        }
        match goal.observe(&答え(card, op, SessionStatus::Ended { ok: false })) {
            Step::Done(outcome) => {
                assert!(outcome.human.contains("異常終了"), "{}", outcome.human);
                assert!(
                    outcome.raw.contains(&op.to_string()),
                    "確定に使った答えをそのまま持ち帰ること"
                );
            }
            _ => panic!("★頼みの番号が付いた答えで満ちていない"),
        }
        let mut goal = Goal::Ended { card, op };
        match goal.observe(&答え(card, op, SessionStatus::Ended { ok: true })) {
            Step::Done(outcome) => assert!(outcome.human.contains("正常終了"), "{}", outcome.human),
            _ => panic!("満ちること"),
        }
    }

    #[test]
    fn 終了待ちは自分の番号を含む断りでだけ落ち配送の失敗を成功に変えない() {
        // 実装レビュー第6回 Astra 1(a)。以前は写しが `Ended` なら種別 `kill` の断りを全部成功に
        // 変えていたので、**確かめ待ちの起こし直しへ終了の頼みが届かなかった断り**まで成功になり、
        // 後からプロセスが起きた。届かなかったことは失敗で返す——写しを見ていても同じ
        let card = CardId::new();
        let op = OpId::new();
        let mut goal = Goal::Ended { card, op };
        assert!(matches!(
            goal.observe(&upsert(meta(card, SessionStatus::Ended { ok: true }))),
            Step::Continue
        ));
        match goal.observe(&ServerMessage::Error {
            card_id: Some(card),
            message: "セッションホストが繋がっていません".to_string(),
            kind: ErrorKind::Kill,
            busy: None,
            withdrawn: None,
            ops: vec![op],
        }) {
            Step::Fail(text) => assert!(text.contains("繋がっていません"), "{text}"),
            _ => panic!("★終了の頼みが届かなかった断りを、成功に変えている"),
        }

        // **自分の番号を含まない断りでは、満ちも落ちもしない**（聞き流して答えを待つ）
        for (何の断り, message) in [
            (
                "番号の無い終了の断り（古い相手）",
                断り(Some(card), ErrorKind::Kill, &[]),
            ),
            (
                "他の頼みへの終了の断り",
                断り(Some(card), ErrorKind::Kill, &[OpId::new()]),
            ),
            (
                "別のカードの断り",
                断り(Some(CardId::new()), ErrorKind::Other, &[]),
            ),
            ("カードに紐づかない断り", 断り(None, ErrorKind::Other, &[])),
        ] {
            let mut goal = Goal::Ended { card, op };
            assert!(
                matches!(goal.observe(&message), Step::Note(_)),
                "★{何の断り}で満ちたか落ちた"
            );
        }

        // 束ねられた番号の中に自分の番号があれば、それは自分への答え
        let mut goal = Goal::Ended { card, op };
        assert!(matches!(
            goal.observe(&断り(Some(card), ErrorKind::Kill, &[OpId::new(), op])),
            Step::Fail(_)
        ));
    }

    /// 起こし直しの断り（種別 `revive`）。`ops` は**起こし直しの**頼みの番号（終了の番号ではない）。
    fn 起こし直しの断り(
        card: CardId,
        busy: Option<bool>,
        withdrawn: Option<protocol::ws::Withdrawal>,
    ) -> ServerMessage {
        ServerMessage::Error {
            card_id: Some(card),
            message: "起こし直しの断り".to_string(),
            kind: ErrorKind::Revive,
            busy,
            withdrawn,
            ops: vec![OpId::new()],
        }
    }

    #[test]
    fn 終了待ちは終了の頼み以外の起こし直しの断りでは満ちない() {
        // 実装レビュー第4回 Astra 1・第6回 Astra 1。起こし直しの断りは、取り下げた理由が終了でも、
        // **起こし直しの頼みへの答え**であって終了の頼みへの答えではない（番号が違う）。満ちも
        // 落ちもせず、終了の頼みへの答えを待ち続ける。以前は取り下げの理由（`withdrawn: kill`）と
        // 写しの実体の有無から推し量って満ちていた
        let card = CardId::new();
        let op = OpId::new();
        for (何の断り, message) in [
            ("メモリ不足", 起こし直しの断り(card, Some(false), None)),
            (
                "終了の頼みで取り下げた",
                起こし直しの断り(card, Some(false), Some(protocol::ws::Withdrawal::Kill)),
            ),
            (
                "外し始めた",
                起こし直しの断り(
                    card,
                    Some(false),
                    Some(protocol::ws::Withdrawal::Removing),
                ),
            ),
            (
                "外した",
                起こし直しの断り(card, Some(false), Some(protocol::ws::Withdrawal::Remove)),
            ),
            (
                "知らない理由",
                起こし直しの断り(
                    card,
                    Some(false),
                    Some(protocol::ws::Withdrawal::Unknown),
                ),
            ),
            ("競合", 起こし直しの断り(card, Some(true), None)),
        ] {
            let mut goal = Goal::Ended { card, op };
            assert!(
                matches!(goal.observe(&message), Step::Note(_)),
                "★{何の断り}の起こし直しの断りで、終了の待ちが満ちたか落ちた"
            );
            // その後に届いた終了の頼みへの答えで満ちる
            assert!(matches!(
                goal.observe(&答え(card, op, SessionStatus::Ended { ok: true })),
                Step::Done(_)
            ));
        }
    }

    #[test]
    fn 終了待ちは生きた実体があれば取り下げの断りでは満ちず終了を待つ() {
        // 実装レビュー第4回 Astra 1・第6回 Astra 1。生きた実体があるカードで、起こし直しを取り下げた
        // 断りが先に届いても止まったとは言わない。番号の無い `Ended`（他の画面の写し・報告）でも
        // 満ちず、**終了の頼みへの答え**で満ちる
        let card = CardId::new();
        let op = OpId::new();
        let mut goal = Goal::Ended { card, op };
        let mut 写し = meta(card, SessionStatus::Working);
        写し.agent_connected = true;
        assert!(matches!(goal.observe(&upsert(写し)), Step::Continue));
        assert!(
            matches!(
                goal.observe(&起こし直しの断り(
                    card,
                    Some(false),
                    Some(protocol::ws::Withdrawal::Kill)
                )),
                Step::Note(_)
            ),
            "★生きた実体があるのに、取り下げの断りで止まったと言っている"
        );
        assert!(
            matches!(
                goal.observe(&upsert(meta(card, SessionStatus::Ended { ok: true }))),
                Step::Continue
            ),
            "★番号の無い `Ended` で、終了の頼みへの答えを待たずに満ちている"
        );
        match goal.observe(&答え(card, op, SessionStatus::Ended { ok: true })) {
            Step::Done(outcome) => assert!(outcome.human.contains("終了しました")),
            _ => panic!("終了の頼みへの答えで満ちること"),
        }
    }

    #[test]
    fn 終了の時間切れは答えが届かなかっただけかもしれないことと確かめ方を添える() {
        let error = note_kill_timeout(ClientError::Timeout {
            what: "セッションの終了".to_string(),
            secs: KILL_CAP.as_secs(),
            note: None,
        });
        assert_eq!(error.exit_code(), 3, "時間切れのまま（断られたと混ぜない）");
        let text = error.to_string();
        assert!(text.contains("古い版だと答えが届きません"), "{text}");
        assert!(text.contains("session ls"), "{text}");
    }

    /// `session kill` が頼みに番号を振り、その番号で待つこと。**待ち方だけ直して、送る側が
    /// 番号を付け忘れると、新しいサーバでも答えが来ずに時間切れになる**（前例：`branch` の枠）。
    #[test]
    fn 終了は番号を振って送りその番号で待つ() {
        let source = include_str!("mod.rs");
        let 本体 = source
            .find("pub async fn kill(")
            .map(|start| &source[start..])
            .expect("終了の口があること");
        let 本体 = &本体[..本体.find("\n}\n").expect("関数の終わりがあること")];
        assert!(
            本体.contains("op: Some(op)"),
            "★終了の頼みに番号を付けていない"
        );
        assert!(
            本体.contains("Goal::Ended { card, op }"),
            "★付けた番号で待っていない"
        );
        assert!(
            本体.contains("note_kill_timeout"),
            "★時間切れに、答えが届かなかっただけかもしれないことを添えていない"
        );
    }

    #[test]
    fn 外す待ちは取り下げた起こし直しの断りでは落ちず外れた知らせで終わる() {
        // 実装レビュー Astra 1。外したことで起こし直しが取り下げられ、その断りが
        // 外れた知らせより先に届く。**外れたのに「外せませんでした」と言わない**
        let card = CardId::new();
        let mut goal = Goal::Removed { card };
        let step = goal.observe(&ServerMessage::Error {
            card_id: Some(card),
            message: "一覧から外されたので、起こし直しをやめました".to_string(),
            kind: ErrorKind::Revive,
            busy: Some(false),
            withdrawn: None,
            ops: Vec::new(),
        });
        assert!(
            matches!(step, Step::Note(_)),
            "★起こし直しの断りを、外す断りと読んで落ちている"
        );
        assert!(matches!(
            goal.observe(&ServerMessage::SessionRemoved { card_id: card }),
            Step::Done(_)
        ));
        // 外す断りでは今までどおり落ちる
        let mut goal = Goal::Removed { card };
        assert!(matches!(
            goal.observe(&ServerMessage::Error {
                card_id: Some(card),
                message: "セッションが見つかりません".to_string(),
                kind: ErrorKind::Archive,
                busy: None,
                withdrawn: None,
                ops: Vec::new(),
            }),
            Step::Fail(_)
        ));
    }

    #[test]
    fn 枝分かれは押した席の断りでその場で落ちる() {
        // **時間切れは症状であって理由ではない**（ブランチ設計§8-4）。
        //
        // `origin` を渡さないと、押した席宛ての断りが「別のカードの知らせ」として
        // 流され、**待ちは上限まで続く**。表に出るのは「終わりませんでした」だけになり、
        // **本当の理由は先に流れて見えなくなる**（2026-09-08 に実運用で踏んだ）。
        let 押した席 = CardId::new();
        let mut goal = Goal::NewCard {
            known: HashSet::new(),
            origin: Some(押した席),
        };
        let step = goal.observe(&ServerMessage::Error {
            card_id: Some(押した席),
            message: "まだ枝分かれできません".to_string(),
            kind: ErrorKind::Branch,
            busy: None,
            withdrawn: None,
            ops: Vec::new(),
        });
        match step {
            Step::Fail(理由) => assert!(
                理由.contains("まだ枝分かれできません"),
                "断りの理由がそのまま出ていない: {理由}"
            ),
            _ => panic!("押した席の断りで落ちていない"),
        }
    }

    #[test]
    fn 起動と呼び戻しは席を持たないので断りで落ちない() {
        // **`origin` を入れてよいのは枝分かれだけ**。`spawn` と `recall` は頼む時点で
        // 席が無く、**無関係なカードの断りで落ちてはいけない**
        let 無関係 = CardId::new();
        let mut goal = Goal::NewCard {
            known: HashSet::new(),
            origin: None,
        };
        assert!(
            matches!(
                goal.observe(&ServerMessage::Error {
                    card_id: Some(無関係),
                    message: "別件".to_string(),
                    kind: ErrorKind::Other,
                    busy: None,
                    withdrawn: None,
                    ops: Vec::new(),
                }),
                Step::Note(_)
            ),
            "席を持たない待ちが、無関係な断りで落ちている"
        );
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
            kind: ErrorKind::Other,
            busy: None,
            withdrawn: None,
            ops: Vec::new(),
        }) {
            // 黙って失敗させないための Note（CLI設計§7-3）。待ちそのものは続く
            Step::Note(text) => assert!(text.contains("よそで何か"), "本文が残ること: {text}"),
            _ => panic!("別カードのエラーは Note になること"),
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
    #[test]
    fn 起こし直しは写しが何枚届いても番号の付いた答えでだけ満ちる() {
        // 実装レビュー第6回（終了の待ちと同じ穴）。連絡係を使う構成では、接続直後の読み直しと
        // 初期一覧で**同じ写しが2枚届く**。起こしたてでフックがまだ来ていないカードは起動中の
        // まま繋がっているので、以前は2枚目の写しで「起こし直しました」と言った——サーバは
        // 「動いています」と断っているのに
        let card = CardId::new();
        let op = OpId::new();
        let mut goal = Goal::Revived { card, op };
        let mut 起こしたて = meta(card, SessionStatus::Starting);
        起こしたて.agent_connected = true;
        for 何枚目 in 1..=3 {
            assert!(
                matches!(goal.observe(&upsert(起こしたて.clone())), Step::Continue),
                "★{何枚目}枚目の写しで満ちた"
            );
        }
        for (何の知らせ, message) in [
            (
                "番号の無い状態",
                ServerMessage::Status {
                    card_id: card,
                    status: SessionStatus::Starting,
                    subagent_active: 0,
                    last_activity_at: 0,
                    op: None,
                },
            ),
            (
                "別の頼みへの答え",
                答え(card, OpId::new(), SessionStatus::Starting),
            ),
            (
                "別のカードへの同じ番号",
                答え(CardId::new(), op, SessionStatus::Starting),
            ),
        ] {
            assert!(
                matches!(goal.observe(&message), Step::Continue),
                "★{何の知らせ}で満ちた"
            );
        }
        match goal.observe(&答え(card, op, SessionStatus::Starting)) {
            Step::Done(outcome) => {
                assert!(
                    outcome.human.contains("起こし直しました"),
                    "{}",
                    outcome.human
                );
                assert!(outcome.raw.contains(&op.to_string()));
            }
            _ => panic!("★頼みの番号が付いた答えで満ちていない"),
        }
        // 起動直後に落ちていても、起こせたこと自体は本当（合否に状態を使わない）
        let mut goal = Goal::Revived { card, op };
        match goal.observe(&答え(card, op, SessionStatus::Ended { ok: false })) {
            Step::Done(outcome) => {
                assert!(outcome.human.contains("すぐに終了"), "{}", outcome.human)
            }
            _ => panic!("満ちること"),
        }
    }

    #[test]
    fn 起こし直しは自分の番号を含む断りでその場で落ち他の断りは聞き流す() {
        // 断られた（メモリ不足・競合・動いている・届かなかった）ことは、その頼みの番号を含む
        // 断りで返る。**番号を含まない断りでは落ちない**——同じカードへの別の頼み（画面・
        // 枝分かれ）の断りかもしれない。古い相手は番号を運ばないので、時間切れで終わる
        let card = CardId::new();
        let op = OpId::new();
        for (何の断り, message) in [
            (
                "動いている",
                ServerMessage::Error {
                    card_id: Some(card),
                    message: "このセッションは動いています（復旧は要りません）".to_string(),
                    kind: ErrorKind::Revive,
                    busy: None,
                    withdrawn: None,
                    ops: vec![op],
                },
            ),
            (
                "競合（先の起こし直しへ束ねられた）",
                ServerMessage::Error {
                    card_id: Some(card),
                    message: "このカードは復旧中です".to_string(),
                    kind: ErrorKind::Revive,
                    busy: Some(true),
                    withdrawn: None,
                    ops: vec![op],
                },
            ),
            (
                "先の起こし直しの終わった断り（束の中）",
                ServerMessage::Error {
                    card_id: Some(card),
                    message: "メモリが足りない".to_string(),
                    kind: ErrorKind::Revive,
                    busy: Some(false),
                    withdrawn: None,
                    ops: vec![OpId::new(), op],
                },
            ),
            (
                "見つからない（門）",
                断り(Some(card), ErrorKind::NotFound, &[op]),
            ),
        ] {
            let mut goal = Goal::Revived { card, op };
            assert!(
                matches!(goal.observe(&message), Step::Fail(_)),
                "★{何の断り}でその場で落ちていない"
            );
        }
        for (何の断り, message) in [
            (
                "番号の無い断り（古い相手）",
                断り(Some(card), ErrorKind::Revive, &[]),
            ),
            (
                "他の頼みへの断り",
                断り(Some(card), ErrorKind::Revive, &[OpId::new()]),
            ),
            (
                "別のカードの断り",
                断り(Some(CardId::new()), ErrorKind::Other, &[]),
            ),
        ] {
            let mut goal = Goal::Revived { card, op };
            assert!(
                matches!(goal.observe(&message), Step::Note(_)),
                "★{何の断り}で満ちたか落ちた"
            );
        }
    }

    #[test]
    fn 起こし直しの時間切れは答えが届かなかっただけかもしれないことと確かめ方を添える() {
        let error = note_revive_answer_timeout(ClientError::Timeout {
            what: "セッションの起こし直し".to_string(),
            secs: REVIVE_CAP.as_secs(),
            note: None,
        });
        assert_eq!(error.exit_code(), 3, "時間切れのまま（断られたと混ぜない）");
        let text = error.to_string();
        assert!(
            text.contains("裏ではまだ続いている可能性があります"),
            "{text}"
        );
        assert!(text.contains("古い版だと答えが届きません"), "{text}");
        assert!(text.contains("session ls"), "{text}");
    }

    /// `session revive` が頼みに番号を振り、その番号で待つこと（`kill` と同じ見張り）。
    #[test]
    fn 起こし直しは番号を振って送りその番号で待つ() {
        let source = include_str!("mod.rs");
        let 本体 = source
            .find("async fn revive_one(")
            .map(|start| &source[start..])
            .expect("起こし直しの口があること");
        let 本体 = &本体[..本体.find("\n}\n").expect("関数の終わりがあること")];
        assert!(
            本体.contains("op: Some(op)"),
            "★起こし直しの頼みに番号を付けていない"
        );
        assert!(
            本体.contains("Goal::Revived { card, op }"),
            "★付けた番号で待っていない"
        );
        assert!(
            本体.contains("note_revive_answer_timeout"),
            "★時間切れに、答えが届かなかっただけかもしれないことを添えていない"
        );
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
