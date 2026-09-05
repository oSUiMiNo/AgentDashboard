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
        branchable(&meta)?;

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

        // ── ⑧ 枝を元の席のすぐ左へ並べ直す ───────────────────────────
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

    /// 枝を元の席のすぐ左へ置く。
    ///
    /// **枠の全カードを渡す**（差分ではない）。渡さなかったカードは末尾へ回るので、
    /// 一部だけ渡すと関係のないカードの並びが崩れる。
    async fn 並べ直す(
        &self, 枝のmeta: &SessionMeta, 元のカード: CardId
    ) -> Result<(), String> {
        let agent_id: Option<AgentId> = 枝のmeta.agent_id;
        let project = 枝のmeta.project.0.clone();

        let mut 枠: Vec<SessionMeta> = self
            .registry
            .list(self.account_id)
            .into_iter()
            .filter(|meta| meta.agent_id == agent_id && meta.project.0 == project)
            .collect();
        枠.sort_by_key(|meta| meta.position);

        let mut 並び: Vec<CardId> = 枠.iter().map(|meta| meta.card_id).collect();
        並び.retain(|id| *id != self.card_id);
        let 置く場所 = 並び
            .iter()
            .position(|id| *id == 元のカード)
            .ok_or_else(|| {
                "並べ直せませんでした（呼び戻した席が枠に見つかりません）".to_string()
            })?;
        並び.insert(置く場所, self.card_id);

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
/// # なぜ `last_assistant_message` を見るのか
///
/// 同じ実測で、1ターン終えた席は `Some("はい")` を持ち、**`session_title` は `None` の
/// ままだった**（CLI が題を付けるのはもっと後）。**題では見分けられない。**
///
/// # なぜ画面の文言を待たないのか
///
/// 断りの英文を読む形にすると、CLI の文言が変わった日に黙って壊れる。**送る前に、
/// こちらの持っている記録で断る。**
fn branchable(meta: &SessionMeta) -> Result<(), String> {
    if meta.last_assistant_message.is_some() {
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
        // §3-4。**状態では見分けられない**——起こした直後の席も「入力待ち」である
        let mut meta = protocol::SessionMeta {
            card_id: CardId::new(),
            project: protocol::ProjectId("/p".to_string()),
            claude_session_id: Some(ClaudeSessionId::new()),
            permission_mode: None,
            model: None,
            model_label: None,
            model_requested: None,
            status: SessionStatus::WaitingInput,
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
            branched_from: None,
        };
        let 断り = branchable(&meta).expect_err("会話が無ければ断ること");
        assert!(断り.contains("会話"), "理由が読めない: {断り}");

        // **題では見分けられない**（実測で `None` のままだった）ので、題を入れても断る
        meta.session_title = Some("それらしい題".to_string());
        assert!(branchable(&meta).is_err(), "題で通してはいけない");

        meta.last_assistant_message = Some("はい".to_string());
        branchable(&meta).expect("1ターン終えていれば通ること");
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
