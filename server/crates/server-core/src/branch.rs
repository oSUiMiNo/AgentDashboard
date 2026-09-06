//! 会話を枝分かれさせ、元の会話を隣の席へ呼び戻す段取り（ブランチ設計§3・§4）。
//!
//! # なぜ段取りをサーバに置くのか
//!
//! [`SessionHost::recall`] は**できたカードIDを同期で返さない**（ネットワークを跨ぐと
//! 返せないため）。したがって「押す → 枝 → 呼び戻し → 並べ替え」には**購読を伴う待ちが
//! 2回**要る。この待ちは**ブラウザにも CLI にも同じものが必要**なので、両方が持てる
//! 置き場所はここしかない。ブラウザ側に置くと、同じ手順を TypeScript と Rust で
//! 二重に持つことになり、失敗の後始末が2箇所へ散る。
//!
//! # 端末の出力は1バイトも読まない
//!
//! 元の会話は `state.rs` がフックのたびに張り替えている `meta.claude_session_id` から取る。
//! CLI が画面に出す `Use /resume …` の文言には触れない——**文言が変われば黙って壊れる**
//! うえ、「画面は ANSI の解析では作らない」という本 PJT の中心思想に正面から反する。
//!
//! # 撃つ前に購読を張る
//!
//! 手順の②が③より先に来ているのは偶然ではない。逆にすると、**撃った直後に張り替えが
//! 起きた場合にその報せを取り逃がし、永遠に待つ**。
//!
//! # 取りこぼしても止まらない
//!
//! 配信は取りこぼしうる（`broadcast` の `Lagged`）。待ちは**購読と記録の両方**を見る
//! ——報せを待ちつつ、一定の間隔で記録層を直に確かめる。片方だけに頼ると、混んだ
//! ときにだけ返らなくなる。

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use protocol::{
    AgentId, CardId, ClaudeSessionId, SessionMeta, SessionStatus,
    ws::{ErrorKind, ServerMessage},
};

use crate::registry::SessionRegistry;
use crate::session_host::{RecallRequest, SessionHost};

/// 待ち①（`/branch` を撃ってから、席の CLI 側IDが張り替わるまで）の上限。
///
/// **実測 387ms**（2026-09-05・本物の claude。設計§3-5）。`/branch` は指示ではなく
/// 画面の操作として即座に効くので短い。**§3-4 で「指示を受け付けられる状態」に
/// 絞っている**ので、入力欄へ積まれて延びることも無い。
///
/// 1回しか測っていないので、**実測の2桁上**に置いてある。ここを長く取りすぎると、
/// 効かなかったときに黙って待ち続けることになる。
const BRANCH_TIMEOUT: Duration = Duration::from_secs(30);

/// 待ち②（呼び戻しを頼んでから、席が立って最初のフックが届くまで）の上限。
///
/// **実測 20.3 秒**（同上）。claude の起動を含むので待ち①とは桁が違う——**同じ値を
/// 共有すると、どちらかが必ず不適切になる**。実測の1桁上に置いてある。
const RECALL_TIMEOUT: Duration = Duration::from_secs(180);

/// 記録層を直に確かめに行く間隔（取りこぼしの保険）。
const POLL: Duration = Duration::from_millis(200);

/// 呼び戻した席が**枠に載る**（帰属と並びが決まる）のを待つ上限。
///
/// 待ち②は配信の1通で明けるが、**枠へ載るのはその後になることがある**。載る前に
/// 並べ替えると記録の側が「知らないカード」として断り、**席はあるのに並びだけが
/// 直らない**——2026-09-06 に A2S 越しで踏んだ形がこれである。
const FRAME_TIMEOUT: Duration = Duration::from_secs(10);

/// いま枝分かれの段取りが走っているカード（二度押しの門）。
///
/// **状態を持つのはここだけ。** 段取りは接続に紐づかないので、接続ごとの入れ物には
/// 置けない。プロセスの寿命と同じでよい——落ちたら段取りも消えるが、そのとき元の
/// 会話は記録に残っており、呼び戻しの道から拾える（§4-1 の最終行）。
#[derive(Clone, Default)]
pub struct Branching(Arc<Mutex<HashSet<CardId>>>);

impl Branching {
    /// 段取りを始めてよければ印を立てて真を返す。既に走っていれば偽。
    fn begin(&self, card_id: CardId) -> bool {
        self.0.lock().expect("ロックが壊れていない").insert(card_id)
    }

    fn end(&self, card_id: CardId) {
        self.0
            .lock()
            .expect("ロックが壊れていない")
            .remove(&card_id);
    }
}

/// 段取りに要るものひと揃い。
pub struct Branch {
    pub registry: Arc<SessionRegistry>,
    pub agent: Arc<dyn SessionHost>,
    pub branching: Branching,
    pub account_id: uuid::Uuid,
    pub card_id: CardId,
}

/// 枝分かれの段取りを始める（呼んだらすぐ返る。結果は配信で届く）。
///
/// **受け口の中で待たない。** WebSocket の1通の処理で数十秒待つと、同じ接続の他の
/// 操作が止まる。
pub fn start(branch: Branch) {
    tokio::spawn(async move {
        let card_id = branch.card_id;
        let branching = branch.branching.clone();
        if !branching.begin(card_id) {
            // 二度押し。**黙って捨てない**——押した人には何も起きていないように見える
            branch.refuse("いま枝分かれの最中です。終わるまで待ってください");
            return;
        }
        let outcome = branch.run().await;
        branching.end(card_id);
        if let Err(message) = outcome {
            branch.refuse(&message);
        }
    });
}

impl Branch {
    /// 断りをそのアカウントのブラウザ全部へ配る。
    ///
    /// **接続の `outbound` を持たない**ので `announce_account` を使う。段取りを頼んだ
    /// 端末が既に閉じていても、他の端末には届く。
    fn refuse(&self, message: &str) {
        self.registry.announce_account(
            self.account_id,
            ServerMessage::Error {
                card_id: Some(self.card_id),
                message: message.to_string(),
                kind: ErrorKind::Branch,
            },
        );
    }

    async fn run(&self) -> Result<(), String> {
        // ── ① 押されたカードを引き、元の会話を控える ───────────────────────
        let record = self
            .registry
            .owned(self.account_id, self.card_id)
            .ok_or_else(|| "そのカードは見つかりません".to_string())?;
        let meta = record.meta();
        let 元の会話 = meta.claude_session_id.ok_or_else(|| {
            "まだ枝分かれできません（このセッションのIDが決まっていません）".to_string()
        })?;

        pushable(meta.status)?;
        branchable(record.has_transcript() || meta.last_assistant_message.is_some())?;

        // **同じ会話を2つのプロセスに開かせない**（§4-1）。呼び戻す先が既に別の席で
        // 開いていると、1つの JSONL へ二重に書き込む形になる
        if self.已に開いている(元の会話) {
            return Err("その会話は既に別の席で開いています".to_string());
        }

        // ── ② 撃つ前に購読を張る ─────────────────────────────────────
        let mut events = self.registry.subscribe_events();

        // ── ③ `/branch` を撃つ ────────────────────────────────────────
        self.agent
            .send_input(self.card_id, "/branch".to_string(), Vec::new())
            .await
            .map_err(|reason| format!("枝分かれを頼めませんでした：{reason}"))?;

        // ── ④ 待ち①：席の CLI 側IDが別物へ張り替わる ────────────────
        let card_id = self.card_id;
        let 枝 = self
            .wait_for(&mut events, BRANCH_TIMEOUT, move |meta| {
                meta.card_id == card_id
                    && meta.claude_session_id.is_some_and(|id| id != 元の会話)
            })
            .await
            .ok_or_else(|| {
                "枝分かれが確かめられませんでした（元の会話はこの席のままです）".to_string()
            })?;
        let 枝の会話 = 枝.claude_session_id.expect("待ちの条件で確かめている");

        // ── ⑤ 枝の印を記録する ───────────────────────────────────────
        // **配るのは記録層が行う。** ここで失敗しても段取りは続ける——印が無いのは
        // 「どちらが枝か分かりにくい」だけで、席を失うのに比べれば軽い
        if let Err(reason) = self
            .registry
            .mark_branch(self.account_id, 枝の会話, 元の会話)
            .await
        {
            tracing::warn!(card_id = %self.card_id, "枝の印を残せませんでした: {reason}");
        }

        // ── ⑥ 元を呼び戻す ───────────────────────────────────────────
        // **作業ディレクトリと宛先は控えた `meta` から取る。** 記録を引き直すと、
        // 張り替えの後なので枝の側を指してしまう
        self.agent
            .recall(RecallRequest {
                account_id: self.account_id,
                target: meta.agent_id,
                cwd: meta.project.0.clone(),
                permission_mode: meta.permission_mode.clone(),
                claude_session_id: 元の会話,
            })
            .await
            .map_err(|reason| {
                format!("元の会話を呼び戻せませんでした：{reason}。もう一度呼び戻せます")
            })?;

        // ── ⑦ 待ち②：元の会話を持つ、別のカードが立つ ─────────────────
        let 元の席 = self
            .wait_for(&mut events, RECALL_TIMEOUT, move |meta| {
                meta.card_id != card_id && meta.claude_session_id == Some(元の会話)
            })
            .await
            .ok_or_else(|| "元の会話の席が立ちませんでした。もう一度呼び戻せます".to_string())?;

        // ── ⑧ 元をその席へ戻し、枝をその1つ右隣へ並べ直す ─────────────
        self.並べ直す(&meta, 元の席.card_id).await
    }

    /// 元の会話を持つ生きたカードが、押された席以外にあるか。
    fn 已に開いている(&self, 元の会話: ClaudeSessionId) -> bool {
        self.registry.list(self.account_id).into_iter().any(|meta| {
            meta.card_id != self.card_id
                && meta.claude_session_id == Some(元の会話)
                && !matches!(meta.status, SessionStatus::Ended { .. })
        })
    }

    /// 条件に合うカードが現れるまで待つ。
    ///
    /// **購読と記録の両方を見る。** 配信は `Lagged` で取りこぼしうるので、報せを待つ
    /// 傍らで一定の間隔で記録層を直に確かめる。
    async fn wait_for(
        &self,
        events: &mut tokio::sync::broadcast::Receiver<crate::registry::AccountEvent>,
        限度: Duration,
        条件: impl Fn(&SessionMeta) -> bool,
    ) -> Option<SessionMeta> {
        let 期限 = tokio::time::Instant::now() + 限度;
        loop {
            // 記録を直に確かめる（取りこぼしの保険であり、既に満たしている場合の近道）
            if let Some(meta) = self
                .registry
                .list(self.account_id)
                .into_iter()
                .find(|meta| 条件(meta))
            {
                return Some(meta);
            }
            if tokio::time::Instant::now() >= 期限 {
                return None;
            }
            let 待つ = POLL.min(期限 - tokio::time::Instant::now());
            // **待つ間隔が過ぎただけなら、次の周回で記録を直に確かめる。**
            // ここを `Err(_) => {}` と書くと「別の綴りで結果を捨てている」ことになる
            let Ok(受け取った) = tokio::time::timeout(待つ, events.recv()).await else {
                continue;
            };
            match 受け取った {
                Ok(event) => {
                    if event.account_id != self.account_id {
                        continue;
                    }
                    if let ServerMessage::SessionUpsert { session } = event.message
                        && 条件(&session)
                    {
                        return Some(*session);
                    }
                }
                // 取りこぼした。次の周回で記録を直に確かめるので、ここでは待ちへ戻る
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                // 配信そのものが閉じた。記録の確認だけで続ける意味は無い
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    }

    /// 元をその席へ戻し、枝をその**1つ右隣**へ置く（§3-3）。
    ///
    /// **基準にするのは「押した席」であって、呼び戻した席ではない。**
    /// 呼び戻した席は**新しいカードなので必ず枠の末尾に付く**——そちらを基準にすると、
    /// **2枚とも右端へ移動してしまう**（2026-09-06 に実機で踏んだ）。押した席は
    /// 動いていないので、そこが「元居た場所」である。
    ///
    /// **枠の全カードを渡す**（差分ではない）。渡さなかったカードは末尾へ回るので、
    /// 一部だけ渡すと関係のないカードの並びが崩れる。
    async fn 並べ直す(
        &self, 枝のmeta: &SessionMeta, 元のカード: CardId
    ) -> Result<(), String> {
        let agent_id: Option<AgentId> = 枝のmeta.agent_id;
        let project = 枝のmeta.project.0.clone();

        // **呼び戻した席が枠に載るまで待つ**（`FRAME_TIMEOUT` の説明を参照）
        let 期限 = tokio::time::Instant::now() + FRAME_TIMEOUT;
        let mut 枠 = loop {
            let 枠: Vec<SessionMeta> = self
                .registry
                .list(self.account_id)
                .into_iter()
                .filter(|meta| meta.agent_id == agent_id && meta.project.0 == project)
                .collect();
            if 枠.iter().any(|meta| meta.card_id == 元のカード) {
                break 枠;
            }
            if tokio::time::Instant::now() >= 期限 {
                return Err(
                    "枝は作れましたが、並べ直せませんでした（呼び戻した席が枠に載りません）"
                        .to_string(),
                );
            }
            tokio::time::sleep(POLL).await;
        };
        枠.sort_by_key(|meta| meta.position);

        let mut 並び: Vec<CardId> = 枠.iter().map(|meta| meta.card_id).collect();
        // 呼び戻した席をいったん外す（末尾に付いている）。**残った並びの中で押した席が
        // 居る場所が、元の席**——枝はいまそこに座っている
        並び.retain(|id| *id != 元のカード);
        let 席 = 並び
            .iter()
            .position(|id| *id == self.card_id)
            .ok_or_else(|| "並べ直せませんでした（押した席が枠に見つかりません）".to_string())?;
        // その席へ元を戻し、枝は1つ右隣へずらす
        並び[席] = 元のカード;
        並び.insert(席 + 1, self.card_id);

        match self
            .registry
            .reorder_cards(self.account_id, agent_id, &project, &並び)
            .await
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err(refusal)) => Err(format!(
                "枝は作れましたが、並べ直せませんでした：{refusal:?}"
            )),
            Err(err) => Err(format!("枝は作れましたが、並べ直せませんでした：{err}")),
        }
    }
}

/// 分かれる元の会話があるか（§3-4）。
///
/// **まだ1ターンも会話していない席は、CLI 自身が断る**——2026-09-05 に実機で確かめた。
/// 画面には `Failed to branch conversation: No conversation to branch` と出て何も起きない。
/// 起こした直後の席も「入力待ち」なので、**状態だけでは見分けられない**。
///
/// # 見るのは履歴である（2026-09-06 に入れ替えた）
///
/// **かつては `last_assistant_message` を見ていた。それは誤りだった。**
/// あの欄は `Stop` フックが運んできたときにだけ書かれるので、**運ばれなかった席では
/// 永久に空**になる。実データでは、生きている14枚のうち8枚が画面に会話を写しながら
/// この門で止まっていた。**とりわけ、枝を作った直後の「呼び戻した元」は必ず空**なので、
/// **1本目を作ると2本目が作れない**——本命の使い方（よく育った1本から何本も分ける）が
/// 丸ごと潰れていた。
///
/// **いまは2つを「会話がある証拠」として扱い、どちらか片方でも立てば通す。**
/// 履歴（パーサが読んだ木）と、直前の応答（`Stop` が運んだ文）である。**片方だけを
/// 権威にしない**——履歴は呼び戻した直後にパーサが追いつくまで空でありうるし、
/// 直前の応答は運ばれなければ永久に空である。**どちらも「無いこと」は証拠にならない。**
///
/// **`session_title` も見ない。** 1ターン終えた席でも `None` のままだった（CLI が題を
/// 付けるのはもっと後）という実測は、いまも有効である。
///
/// # なぜ画面の文言を待たないのか
///
/// 断りの英文を読む形にすると、CLI の文言が変わった日に黙って壊れる。**送る前に、
/// こちらの持っている記録で断る。**
fn branchable(履歴がある: bool) -> Result<(), String> {
    if 履歴がある {
        return Ok(());
    }
    Err("まだ枝分かれできません（この席はまだ1ターンも会話していません）".to_string())
}

/// 枝分かれを頼んでよい状態か（§3-4）。
///
/// **`/branch` は指示として送られる**ので、claude が作業中なら入力欄に積まれ、
/// いまのターンが終わってから効く。押した本人は「いま分かれた」と思っているのに、
/// **実際にはしばらく後の別の地点で分かれる**——これは取り返しがつかない。
fn pushable(status: SessionStatus) -> Result<(), String> {
    match status {
        SessionStatus::WaitingInput | SessionStatus::WaitingSubagents => Ok(()),
        SessionStatus::Working | SessionStatus::Stalled => Err(
            "作業中は枝分かれできません（いまのターンが終わってから分かれることになります）"
                .to_string(),
        ),
        SessionStatus::WaitingPermission => {
            Err("権限確認に答えてから枝分かれしてください".to_string())
        }
        SessionStatus::Starting => Err("起動中です。少し待ってください".to_string()),
        SessionStatus::Ended { .. } => {
            Err("止まっているセッションからは枝分かれできません".to_string())
        }
        SessionStatus::Unknown => Err("いまの状態が分からないので枝分かれできません".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 指示を受け付けられる状態だけ通す() {
        assert!(pushable(SessionStatus::WaitingInput).is_ok());
        assert!(pushable(SessionStatus::WaitingSubagents).is_ok());
        for 駄目 in [
            SessionStatus::Working,
            SessionStatus::Stalled,
            SessionStatus::WaitingPermission,
            SessionStatus::Starting,
            SessionStatus::Ended { ok: true },
            SessionStatus::Unknown,
        ] {
            let 断り = pushable(駄目).expect_err("断ること");
            assert!(!断り.is_empty(), "断る理由が空（{駄目:?}）");
        }
    }

    #[test]
    fn 会話が無い席は断る() {
        // §3-4。**状態では見分けられない**——起こした直後の席も「入力待ち」である。
        //
        // **見るのは履歴。** `last_assistant_message` を見ていた版は、**呼び戻した席で
        // 必ず空になる**ため「1本目を作ると2本目が作れない」という形で壊れていた
        // （2026-09-06 に入れ替えた。経緯は `branchable` の説明）。
        let 断り = branchable(false).expect_err("履歴が無ければ断ること");
        assert!(断り.contains("会話"), "理由が読めない: {断り}");

        branchable(true).expect("履歴があれば通ること");
    }

    #[test]
    fn 二度押しは門で止まる() {
        let branching = Branching::default();
        let card = CardId::new();
        assert!(branching.begin(card), "1本目は通ること");
        assert!(!branching.begin(card), "2本目は止まること");
        branching.end(card);
        assert!(branching.begin(card), "終わったあとはまた通ること");
    }
}
