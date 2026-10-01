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
use crate::session_host::{RecallRequest, ReviveRequest, SessionHost};

/// 待ち①（`/branch` を撃ってから、席の CLI 側IDが張り替わるまで）の上限。
///
/// # 30秒では足りなかった（2026-09-07 に実機で判明）
///
/// **`/branch` は即座に効かない。** 利用者の画面にはこう出ていた。
///
/// ```text
/// > /branch
/// · Cerebrating… (45s)
/// ```
///
/// **45秒以上「考えて」から**枝になる。かかる時間は会話の重さで変わるとみられる。
///
/// **設計へ書いた「実測 387ms」は、1回きり・軽い条件で測った値だった。** それを2桁
/// 上回る 30秒なら十分だと判断したが、**桁の見立てそのものが外れていた**——これが
/// 2026-09-07 に元の会話が席を失った真因である。
///
/// # 伸ばすだけでは直らないので、諦め方も変えた
///
/// 上限をいくら伸ばしても超えるものは超える。**明けても記録を引き直して確かめる**
/// （[`Branch::枝になっているか`]）ことと、**居座る入力を消しに行かない**ことを対で
/// 入れてある。消しても既に送信済みの `/branch` は止まらず、**利用者がその間に打った
/// 文字を巻き添えにする**だけだった。
///
/// 実測（45秒）の13倍に置く。**ここを長く取る代償は「効かなかったときに待たされる」
/// ことだけ**で、短く取る代償（席を失う）とは重さが違う。
const BRANCH_TIMEOUT: Duration = Duration::from_secs(600);

/// ターンが終わるのを待つ上限（§3-4）。
///
/// **作業中に押されたら、いまのターンが終わってから `/branch` を撃つ。** 走っている
/// 作業へ割り込むと**その作業が中止される**ためで、2026-09-07 に利用者が踏んだ。
///
/// 長いターンは何十分も続くので、上限も長く取る。**ここで待っている間も、画面には
/// 「いまの作業が終わるのを待っています」と出る**（`SessionView` が状態から導く）ので、
/// 黙って止まっているようには見えない。
const TURN_TIMEOUT: Duration = Duration::from_secs(1800);

/// 待ち②（呼び戻しを頼んでから、席が立って最初のフックが届くまで）の上限。
///
/// **実測 20.3 秒**（同上）。claude の起動を含むので待ち①とは桁が違う——**同じ値を
/// 共有すると、どちらかが必ず不適切になる**。実測の1桁上に置いてある。
const RECALL_TIMEOUT: Duration = Duration::from_secs(180);

/// 寝ていた元を起こしてから、`/branch` を撃てる状態になるまでの上限（§3-4-2）。
///
/// **中身は claude の起動**なので、待ち②（呼び戻し）と同じ桁に置く。起動中の席を
/// 待つ場合もここを使う——**待っているものが同じ**（最初のフックが届いて入力待ちに
/// なること）だからである。
///
/// **明けても元の会話は失われない。** 起きたまま残るだけで、人が寝かせられる。
/// **迷ったら起きている側へ倒す**という §3-6 の方針がここにも当たる。
const WAKE_TIMEOUT: Duration = Duration::from_secs(180);

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
        // **段取りは跡を残す。** 失敗したとき、画面に出るのは断りの1行だけで、どの段まで
        // 進んでいたかが分からない。2026-09-07 の事故では、ログに migration の2行しか
        // 無く、原因を追う足場が1つも無かった（PJT の作法は「コードより先にログを読む」）
        tracing::info!(%card_id, "枝分かれを始めます");
        let outcome = branch.run().await;
        branching.end(card_id);
        match outcome {
            Ok(()) => tracing::info!(%card_id, "枝分かれが済みました"),
            Err(message) => {
                tracing::warn!(%card_id, "枝分かれを中断しました：{message}");
                branch.refuse(&message);
            }
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
                busy: None,
                withdrawn: None,
                ops: Vec::new(),
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
        // **席ではなく会話に問う**（§3-8）。呼び戻した直後の席は履歴の窓も直前の応答も
        // 空なので、席で問うと**同じ親から2本目を作れない**
        branchable(
            self.registry
                .conversation_has_content(self.account_id, 元の会話)
                .await,
        )?;

        // **同じ会話を2つのプロセスに開かせない**（§4-1）。呼び戻す先が既に別の席で
        // 開いていると、1つの JSONL へ二重に書き込む形になる
        if self.已に開いている(元の会話) {
            return Err("その会話は既に別の席で開いています".to_string());
        }

        // **寝ていたかを、押した瞬間の状態で凍らせる**（§3-4-2）。段取りの途中で見ると、
        // 自分で起こした結果を「起きていた」と読んでしまう
        let もともと寝ていた = matches!(meta.status, SessionStatus::Ended { .. });

        // ── ② 撃つ前に購読を張る ─────────────────────────────────────
        let mut events = self.registry.subscribe_events();
        // **起こす頼みに番号を振る**（実装レビュー第6回 Astra 3）。待つ段で拾うのは、この番号を
        // 運ぶ断りだけ——先に押した人の起こし直しの断りが遅れて届いても取り違えない。人が先に
        // 起こしていて競合で断られたときは、番号が先の起こし直しへ束ねられ、その断りが運ぶ。
        // 配信を取りこぼしても、記録から番号で引き直せる（実装レビュー Astra 4）
        let 起こす頼み = protocol::ws::OpId::new();

        // ── ①′ 寝ていたら起こし、起動中なら整うのを待つ（§3-4-2）───────
        // **`/branch` は生きた claude にしか撃てない。** だからといって押せなくするのでは
        // なく、**居る状態にしてから撃つ**
        if もともと寝ていた || matches!(meta.status, SessionStatus::Starting) {
            if もともと寝ていた {
                tracing::info!(card_id = %self.card_id, "寝ているので、起こしてから枝分かれします");
                // **答えを記録から引き直せるよう、頼みを控えてから撃つ**（実装レビュー第11回
                // Astra 2）。配信を取りこぼしても、成功の答えも断りも番号で引ける
                self.registry
                    .accept_op(self.account_id, self.card_id, 起こす頼み);
                // **届かなかったら、その場でやめる**（実装レビュー第11回 Astra 2）。人が先に起こして
                // いた場合（競合）は、受付は通り、番号が先の起こし直しへ束ねられる——その結果が
                // この頼みの結果として届く。届かなかった頼みには、誰も答えない
                self.agent
                    .revive(ReviveRequest {
                        account_id: self.account_id,
                        card_id: self.card_id,
                        op: Some(起こす頼み),
                    })
                    .await
                    .map_err(|reason| format!("元のセッションを起こせませんでした：{reason}"))?;
            }
            let card_id = self.card_id;
            // **自分が出した起こし直しの頼みの結果を待つのは、この段だけ**（寝ているカード
            // ばかりなのに、メモリ不足でセッションを起こせない 設計§7-3・実装レビュー第11回
            // Astra 2）。断りを拾わないと、断られた後も上限（180 秒）まで待ち、事実と違う理由で
            // 終わる。**起こしていない（起動中で整うのを待つだけの）ときは渡さない**——答えが
            // 来ないので、状態だけで待つ
            self.wait_for(
                &mut events,
                WAKE_TIMEOUT,
                もともと寝ていた.then_some((card_id, 起こす頼み)),
                move |meta| meta.card_id == card_id && 整った(meta.status),
            )
            .await
            .map_err(|reason| format!("元のセッションを起こせませんでした：{reason}"))?
            .ok_or_else(|| {
                // **元の会話は失われていない。** 起きたまま残るだけで、人が寝かせられる
                "元のセッションが起きてきませんでした（会話は残っています）".to_string()
            })?;
        }

        // ── ②′ 作業中なら、いまのターンが終わるのを待つ（§3-4）─────────
        // **割り込むと走っている作業が中止される。** かつてはここを「押せない」ことで
        // 避けていたが、**押せないより待つほうが利用者の役に立つ**（2026-09-07 の指定）
        //
        // **見るのは①′を抜けた後の状態である。** 控えた `meta` は押した瞬間のもので、
        // 起こした後は古い——寝ていた席を「作業中ではない」と読んで素通りするのは
        // たまたま正しいだけで、根拠になっていない
        let 整えた後の状態 = self
            .registry
            .owned(self.account_id, self.card_id)
            .ok_or_else(|| "そのカードは見つかりません".to_string())?
            .meta()
            .status;
        if matches!(
            整えた後の状態,
            SessionStatus::Working | SessionStatus::Stalled
        ) {
            tracing::info!(card_id = %self.card_id, "作業中なので、ターンの終わりを待ちます");
            let card_id = self.card_id;
            self.wait_for(&mut events, TURN_TIMEOUT, None, move |meta| {
                meta.card_id == card_id
                    && !matches!(meta.status, SessionStatus::Working | SessionStatus::Stalled)
            })
            .await?
            .ok_or_else(|| {
                "作業が終わらないので枝分かれを見送りました（もう一度押せます）".to_string()
            })?;
            // 終わった先が「押してよい状態」とは限らない（権限確認で止まった等）
            let いまの状態 = self
                .registry
                .owned(self.account_id, self.card_id)
                .ok_or_else(|| "そのカードは見つかりません".to_string())?
                .meta()
                .status;
            pushable(いまの状態)?;
        }

        // ── ③ `/branch` を撃つ（**届いたことを確かめる**。§3-7）────────
        // **撃ちっぱなしにしない。** 2026-09-08 に、呼び戻した直後の席へ撃った
        // `/branch` がエラーも出ないまま消え、7分待って初めて気づいた
        tracing::info!(card_id = %self.card_id, "/branch を撃ちます");
        self.agent
            .send_input(self.card_id, "/branch".to_string(), Vec::new(), true)
            .await
            .map_err(|reason| format!("枝分かれを頼めませんでした：{reason}"))?;
        tracing::info!(card_id = %self.card_id, "/branch が届きました。枝になるのを待ちます");

        // ── ④ 待ち①：席の CLI 側IDが別物へ張り替わる ────────────────
        let card_id = self.card_id;
        let 枝 = match self
            .wait_for(&mut events, BRANCH_TIMEOUT, None, move |meta| {
                meta.card_id == card_id
                    && meta.claude_session_id.is_some_and(|id| id != 元の会話)
            })
            .await?
        {
            Some(枝) => 枝,
            // **待ちが明けた＝枝になっていない、とは限らない。** 記録を引き直して確かめる
            None => match self.枝になっているか(元の会話) {
                Some(枝) => {
                    tracing::warn!(
                        card_id = %self.card_id,
                        "待ちは明けましたが、記録では枝になっていました。呼び戻しへ進みます"
                    );
                    枝
                }
                None => {
                    // **入力欄を消しに行かない**（2026-09-07 にやめた）。`/branch` は既に
                    // 送信済みで、消しても止まらない——**利用者がその間に打った文字を
                    // 巻き添えにする**だけだった。
                    //
                    // **「この席のままです」と言い切らない。** あとから枝になることが
                    // 実際にある（`Cerebrating…` が長引く）。言い切ると、席を失っている
                    // のに「何も起きていない」と読まれる。
                    tracing::warn!(
                        card_id = %self.card_id,
                        "枝分かれを待ち切れませんでした（あとから効く可能性があります）"
                    );
                    return Err("枝分かれに時間がかかりすぎました。\
                         あとから枝になった場合は、この知らせから元の会話を呼び戻せます"
                        .to_string());
                }
            },
        };
        let 枝の会話 = 枝.claude_session_id.expect("待ちの条件で確かめている");

        tracing::info!(card_id = %self.card_id, 枝の会話 = %枝の会話, "枝になりました");

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
        tracing::info!(card_id = %self.card_id, "元の会話を呼び戻します");
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
            .wait_for(&mut events, RECALL_TIMEOUT, None, move |meta| {
                meta.card_id != card_id && meta.claude_session_id == Some(元の会話)
            })
            .await?
            .ok_or_else(|| "元の会話の席が立ちませんでした。もう一度呼び戻せます".to_string())?;
        tracing::info!(
            card_id = %self.card_id,
            元の席 = %元の席.card_id,
            "元の会話の席が立ちました。並べ直します"
        );

        // ── ⑧ 元をその席へ戻し、枝をその1つ右隣へ並べ直す ─────────────
        let 並べ替えの結果 = self.並べ直す(&meta, 元の席.card_id).await;

        // ── ⑨′ もともと寝ていたなら、元を寝かせ直す（§3-4-2）───────────
        // **寝かせるのは呼び戻した新しい席であって、押した席ではない。** 押した席は
        // 既に枝になっており、**利用者が見たいのはそちら**なので起きたままにする。
        //
        // **並べ替えが失敗していても寝かせる。** 席は2つとも在るので、寝かせて困ることが
        // 無い——並びが崩れているだけである（§4-2）。
        if もともと寝ていた {
            // 答えは待たない（番号を振らない）。寝かせ直せたかは状態に出る
            if let Err(reason) = self.agent.kill(self.account_id, 元の席.card_id, None).await {
                // **段取りは成功として終える。** 寝かせ直せなくても**席も会話も無事**で、
                // 人が寝かせられる（§3-6「迷ったら起きている側へ倒す」）
                tracing::warn!(
                    card_id = %元の席.card_id,
                    "元を寝かせ直せませんでした（起きたまま残ります）: {reason}"
                );
            } else {
                tracing::info!(card_id = %元の席.card_id, "元を寝かせ直しました");
            }
        }

        並べ替えの結果
    }

    /// いま席が枝になっているか、**記録を引き直して**確かめる（§4-2）。
    ///
    /// 待ちが明けたことは「枝になっていない」ことの証拠にならない。**配信を取りこぼす**
    /// ことも、**上限のすぐ外側で張り替わる**こともある。ここを決めつけたまま諦めると、
    /// 呼び戻す者が居ないまま席が枝へ変わり、**元の会話が席を失う**。
    fn 枝になっているか(&self, 元の会話: ClaudeSessionId) -> Option<SessionMeta> {
        let meta = self.registry.owned(self.account_id, self.card_id)?.meta();
        meta.claude_session_id
            .is_some_and(|id| id != 元の会話)
            .then_some(meta)
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
    ///
    /// `起こす頼み` にカードと起こす頼みの番号を渡すと、**その頼みの結果**を待つ（[`頼みの答え`]）。
    /// 終わった断りが届いた時点で、その文面を `Err` で返す。成功の答えを受けるまでは、カードの状態
    /// だけでは満ちない。渡すのは起こした段だけ——他の段で拾うと、無関係な断りで段取りを止めて
    /// しまう。
    /// `Ok(None)` は上限まで待っても現れなかったこと。
    ///
    /// **断りも記録から引き直す**（実装レビュー Astra 4）。配信で取りこぼす（`Lagged`）と
    /// 報せだけでは断りを失い、上限まで待ってから事実と違う理由で終わる。
    async fn wait_for(
        &self,
        events: &mut tokio::sync::broadcast::Receiver<crate::registry::AccountEvent>,
        限度: Duration,
        起こす頼み: Option<(CardId, protocol::ws::OpId)>,
        条件: impl Fn(&SessionMeta) -> bool,
    ) -> Result<Option<SessionMeta>, String> {
        wait_for(
            &self.registry,
            self.account_id,
            events,
            限度,
            起こす頼み,
            条件,
        )
        .await
    }

    /// 元をその席へ戻し、枝をその**1つ右隣**へ置く（§3-3）。
    ///
    /// **基準にするのは「押した席」であって、呼び戻した席ではない。**
    /// 呼び戻した席は**新しいカードなので、採番の端に付く**——項目13より前は末尾、
    /// いまは先頭である。そちらを基準にすると、**2枚とも端へ移動してしまう**
    /// （2026-09-06 に実機で踏んだ）。押した席は動いていないので、そこが「元居た
    /// 場所」である。
    ///
    /// **下の並べ直しは位置ではなく識別子で動く**ので、呼び戻した席が末尾に付こうと
    /// 先頭に付こうと結果は変わらない。項目13で採番の向きを変えても無傷なのはこのため。
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
fn branchable(会話に中身がある: bool) -> Result<(), String> {
    if 会話に中身がある {
        return Ok(());
    }
    // **「この席は」と言わない。** 判定の対象は会話であって席ではない（§3-8）——
    // 席で言うと、呼び戻した直後の席を「喋っていない」と誤って名指しすることになる
    Err("まだ枝分かれできません（この会話はまだ1ターンも交わされていません）".to_string())
}

/// 枝分かれを頼んでよい状態か（§3-4）。
///
/// # 作業中も通す（2026-09-07 に覆した）
///
/// **かつては作業中を断っていた。** 理由は「`/branch` は指示として積まれるので、
/// 押した本人がいま分かれたと思っているのに、しばらく後の別の地点で分かれる」こと
/// だった。**その理由は、待ってから撃つようにした時点で消えた**——[`TURN_TIMEOUT`]
/// でターンの終わりを待つので、**分かれる地点は「いまの作業が終わったところ」に定まる。**
///
/// **むしろ断るほうが害があった。** 実機では、作業中に押すと `/branch` が割り込んで
/// **走っている作業が中止された**（2026-09-07・利用者の報告）。押せなくするだけでは
/// この事故は防げても、**利用者は「作業が終わったら枝を作る」ができないままだった。**
///
/// ここで断るのは、**待っても押せるようにならないもの**だけである。
/// 整え終わって、`/branch` を撃てる状態になったか（§3-4-2）。
///
/// **`pushable` を流用してはいけない。** あちらが答えるのは「**押してよいか**」で、
/// スリープと起動中も通す——**整えてから撃つ**ことにしたからである。ここで要るのは
/// 「**整い終わったか**」で、まったく別の問いになる。
///
/// **一度これを取り違えて踏んだ。** 起こす待ちの条件に `pushable` を使ったところ、
/// **寝ている状態のまま条件を満たして**先へ進み、死んだ席へ `/branch` を撃っていた。
/// **同じ形をした2つの問いは、名前を分けておかないと必ず混ざる。**
fn 整った(status: SessionStatus) -> bool {
    matches!(
        status,
        SessionStatus::WaitingInput
            | SessionStatus::WaitingSubagents
            | SessionStatus::Working
            | SessionStatus::Stalled
    )
}

fn pushable(status: SessionStatus) -> Result<(), String> {
    match status {
        // 作業中・停滞は**ここでは通す**。撃つ前にターンの終わりを待つ（§3-4）
        SessionStatus::WaitingInput
        | SessionStatus::WaitingSubagents
        | SessionStatus::Working
        | SessionStatus::Stalled => Ok(()),
        // 起動中・スリープも**ここでは通す**。撃つ前に整える（§3-4-2）——起動中は
        // 押せる状態になるまで待ち、スリープは起こしてから撃って最後に寝かせ直す
        SessionStatus::Starting | SessionStatus::Ended { .. } => Ok(()),
        SessionStatus::WaitingPermission => {
            Err("権限確認に答えてから枝分かれしてください".to_string())
        }
        // **断る2つに共通するのは「待っても押せるようにならない」こと**（§3-4）。
        // 権限確認待ちは人が答えるまで動かず、不明は動いたことすら分からない
        SessionStatus::Unknown => Err("いまの状態が分からないので枝分かれできません".to_string()),
    }
}

/// [`Branch::wait_for`] の本体。段取りの他の持ち物（`SessionHost`）に触らないので、待ち方だけを
/// 記録層と組んで確かめられる。
///
/// **拾うのは、待っている起こし直しの番号を運ぶ断りだけ**（実装レビュー第6回 Astra 3）。以前は
/// 断りを記録へ取り込んだ時点の通し番号を目印と比べていたが、通し番号は取り込んだ順でしかない。
/// 先の起こし直し A の断りが、枝分かれ B の起こし直しを受け付けた後に取り込まれると B の目印より
/// 大きい番号が付き、B は古い断りを自分の結果と取り違えて止まった。配信で受けたものも記録から
/// 引き直すものも、同じ番号で見分ける。
///
/// # 自分の頼みの結果と、カードの状態を分ける（実装レビュー第11回 Astra 2）
///
/// 以前は、カードが起きた状態を見た時点で満ち、自分の番号への断りを読むのはその後だった。束の
/// 上限を超えてこの頼みが断られていても、先の起こし直しが成功していれば、知らせの届く順で成功に
/// なった（設計§22 の「上限を超えた頼みは終わった断りで終わる」と食い違う）。いまは：
///
/// - **自分への終わった断りがあれば、状態に関わらず `Err`**（毎周、状態より先に見る）
/// - **自分への成功の答え（番号付きの状態）を受けるまで、カードの状態だけでは満ちない**——他の
///   起こし直しで起きたことは、この頼みの結果ではない
/// - 競合（`busy: Some(true)`）は途中の知らせで、束ねた先の起こし直しの結果を待つ
async fn wait_for(
    registry: &SessionRegistry,
    account_id: uuid::Uuid,
    events: &mut tokio::sync::broadcast::Receiver<crate::registry::AccountEvent>,
    限度: Duration,
    起こす頼み: Option<(CardId, protocol::ws::OpId)>,
    条件: impl Fn(&SessionMeta) -> bool,
) -> Result<Option<SessionMeta>, String> {
    let 期限 = tokio::time::Instant::now() + 限度;
    // 起こす頼みが無ければ、状態だけで待つ（起動中で整うのを待つ段・撃った後の段）
    let mut 頼みが通った = 起こす頼み.is_none();
    loop {
        if let Some((拾うカード, 頼み)) = 起こす頼み {
            // **待っている相手が一覧から外されたら、もう起きてこない。** 外したカードは
            // 記録ごと消えるので、断りも残らない——待ち続けると上限まで黙る
            if registry.owned(account_id, 拾うカード).is_none() {
                return Err("一覧から外されました".to_string());
            }
            // 記録から自分の頼みの結果を引き直す（配信の取りこぼしの保険）
            match registry
                .op_answer(account_id, 頼み)
                .and_then(|answer| 頼みの答え(&answer, 拾うカード, 頼み))
            {
                Some(Err(理由)) => return Err(理由),
                Some(Ok(())) => 頼みが通った = true,
                None => {}
            }
            if let Some(理由) = registry.revive_refusal_for(account_id, 拾うカード, 頼み) {
                return Err(理由);
            }
        }
        // 記録を直に確かめる（取りこぼしの保険であり、既に満たしている場合の近道）
        if 頼みが通った
            && let Some(meta) = registry
                .list(account_id)
                .into_iter()
                .find(|meta| 条件(meta))
        {
            return Ok(Some(meta));
        }
        if tokio::time::Instant::now() >= 期限 {
            return Ok(None);
        }
        let 待つ = POLL.min(期限 - tokio::time::Instant::now());
        // **待つ間隔が過ぎただけなら、次の周回で記録を直に確かめる。**
        // ここを `Err(_) => {}` と書くと「別の綴りで結果を捨てている」ことになる
        let Ok(受け取った) = tokio::time::timeout(待つ, events.recv()).await else {
            continue;
        };
        match 受け取った {
            Ok(event) => {
                if event.account_id != account_id {
                    continue;
                }
                if let Some((拾うカード, 頼み)) = 起こす頼み {
                    match 頼みの答え(&event.message, 拾うカード, 頼み) {
                        Some(Err(理由)) => return Err(理由),
                        // 次の周回で記録の状態を見る（状態は答えより先に届いている）
                        Some(Ok(())) => {
                            頼みが通った = true;
                            continue;
                        }
                        None => {}
                    }
                }
                if 頼みが通った
                    && let ServerMessage::SessionUpsert { session } = event.message
                    && 条件(&session)
                {
                    return Ok(Some(*session));
                }
            }
            // 取りこぼした。次の周回で記録を直に確かめるので、ここでは待ちへ戻る
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            // 配信そのものが閉じた。記録の確認だけで続ける意味は無い
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return Ok(None),
        }
    }
}

/// そのカードの、頼み `op` への起こし直しの**結果**（実装レビュー第11回 Astra 2）。
///
/// - 成功の答え（番号付きの状態。PC が実体を作り終えた）：`Ok`
/// - 終わった断り（[`起こし直しの断り`]）：`Err`（文面）
/// - それ以外（競合・他の頼み・他のカード・番号の無い知らせ）：`None`
fn 頼みの答え(
    message: &ServerMessage,
    card_id: CardId,
    op: protocol::ws::OpId,
) -> Option<Result<(), String>> {
    match message {
        ServerMessage::Status {
            card_id: 宛先,
            op: Some(答えた),
            ..
        } if *宛先 == card_id && *答えた == op => Some(Ok(())),
        other => 起こし直しの断り(other, card_id, op).map(|理由| Err(理由.to_string())),
    }
}

/// そのカードの、頼み `op` への起こし直しが**終わった断り**で返ってきたなら、その文面を返す
/// （寝ているカードばかりなのに、メモリ不足でセッションを起こせない 設計§7-3・実装レビュー
/// 第6回 Astra 3）。番号の無い断り（古い PC）と、別の頼みへの断りは拾わない。
///
/// **見分けは `busy` の欄だけで行う。文面の部分一致では見分けない**——競合の文
/// （`ALREADY_REVIVING`）は `session-host-core` にあり、依存の向きで参照できない。
///
/// - `Some(true)`（競合）：先に起こしている側が居るので、待てば起きる。拾わない
/// - `None`（古い PC・判別できない）：**欠けを断りと読まない**。拾わない（いまどおり待つ）
/// - 他のカード・起こし直し以外の種別：拾わない
///
/// 見分けの規則そのものは記録層（[`crate::registry::revive_refusal_of`]）が持つ。
/// 取りこぼしに備えて断りを残す側と、ここで拾う側の規則がずれないようにするため。
fn 起こし直しの断り(
    message: &ServerMessage,
    card_id: CardId,
    op: protocol::ws::OpId,
) -> Option<&str> {
    crate::registry::revive_refusal_of(message)
        .filter(|(宛先, ops, _)| *宛先 == card_id && ops.contains(&op))
        .map(|(_, _, 理由)| 理由)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn 起こし直しの知らせ(
        card_id: CardId,
        kind: ErrorKind,
        busy: Option<bool>,
        ops: &[OpId],
    ) -> ServerMessage {
        ServerMessage::Error {
            card_id: Some(card_id),
            message: "メモリが足りないので起こし直せません".to_string(),
            kind,
            busy,
            withdrawn: None,
            ops: ops.to_vec(),
        }
    }

    use protocol::ws::OpId;

    #[test]
    fn 拾うのはそのカードの起こし直しの終わった断りだけ() {
        // 設計§7-3・実装レビュー第6回 Astra 3。競合（`Some(true)`）は待てば起きる、古い PC の
        // 知らせ（`None`）は判別できない——どちらも失敗にすると、起きるはずの枝分かれを止める。
        // **別の頼みへの断りと、番号の無い断りも拾わない**（どの頼みへの答えか言えない）
        let card_id = CardId::new();
        let 頼み = OpId::new();
        assert_eq!(
            起こし直しの断り(
                &起こし直しの知らせ(card_id, ErrorKind::Revive, Some(false), &[頼み]),
                card_id,
                頼み
            ),
            Some("メモリが足りないので起こし直せません")
        );
        assert_eq!(
            起こし直しの断り(
                &起こし直しの知らせ(
                    card_id,
                    ErrorKind::Revive,
                    Some(false),
                    &[OpId::new(), 頼み]
                ),
                card_id,
                頼み
            ),
            Some("メモリが足りないので起こし直せません"),
            "先の起こし直しへ束ねられた番号でも拾うこと"
        );
        for (理由, message) in [
            (
                "競合",
                起こし直しの知らせ(card_id, ErrorKind::Revive, Some(true), &[頼み]),
            ),
            (
                "判別できない",
                起こし直しの知らせ(card_id, ErrorKind::Revive, None, &[頼み]),
            ),
            (
                "他のカード",
                起こし直しの知らせ(CardId::new(), ErrorKind::Revive, Some(false), &[頼み]),
            ),
            (
                "起こし直し以外",
                起こし直しの知らせ(card_id, ErrorKind::Kill, Some(false), &[頼み]),
            ),
            (
                "★別の頼みへの断り",
                起こし直しの知らせ(
                    card_id,
                    ErrorKind::Revive,
                    Some(false),
                    &[OpId::new()],
                ),
            ),
            (
                "★番号の無い断り（古い PC）",
                起こし直しの知らせ(card_id, ErrorKind::Revive, Some(false), &[]),
            ),
            (
                "宛先なし",
                ServerMessage::Error {
                    card_id: None,
                    message: "x".to_string(),
                    kind: ErrorKind::Revive,
                    busy: Some(false),
                    withdrawn: None,
                    ops: vec![頼み],
                },
            ),
        ] {
            assert_eq!(
                起こし直しの断り(&message, card_id, 頼み),
                None,
                "{理由}で拾っている"
            );
        }
    }

    #[test]
    fn 待てば押せるようになるものは通す() {
        // §3-4。**作業中と停滞も通す**（2026-09-07 に覆した）——撃つ前にターンの
        // 終わりを待つので、分かれる地点は「いまの作業が終わったところ」に定まる。
        // かつてここで断っていたが、**押せなくするだけでは「作業が終わったら枝を作る」
        // ができないまま**だった。
        //
        // **起動中とスリープも通す**（2026-09-08 に覆した。§3-4-2）——寝ていたら
        // 起こしてから撃ち、最後に寝かせ直す。**撃つ相手が居ないなら、居る状態に
        // すればよい**のであって、押せなくする理由にはならなかった。
        for 通す in [
            SessionStatus::WaitingInput,
            SessionStatus::WaitingSubagents,
            SessionStatus::Working,
            SessionStatus::Stalled,
            SessionStatus::Starting,
            SessionStatus::Ended { ok: true },
            SessionStatus::Ended { ok: false },
        ] {
            pushable(通す).unwrap_or_else(|断り| panic!("{通す:?} は通ること：{断り}"));
        }
        // **待っても押せるようにならないもの**だけを断る。権限確認待ちは人が答える
        // まで動かず、不明は動いたことすら分からない
        for 駄目 in [SessionStatus::WaitingPermission, SessionStatus::Unknown] {
            let 断り = pushable(駄目).expect_err("断ること");
            assert!(!断り.is_empty(), "断る理由が空（{駄目:?}）");
        }
    }

    #[test]
    fn 整ったかは押してよいかとは別の問い() {
        // **一度取り違えて踏んだ。** 起こす待ちの条件に `pushable` を使ったところ、
        // **寝ている状態のまま条件を満たして**先へ進み、死んだ席へ `/branch` を
        // 撃っていた（§3-4-2）。
        //
        // `pushable` は「押してよいか」、`整った` は「整い終わったか」——**同じ形を
        // した2つの問いは、名前を分けておかないと必ず混ざる。**
        for まだ in [
            SessionStatus::Starting,
            SessionStatus::Ended { ok: true },
            SessionStatus::Ended { ok: false },
        ] {
            assert!(
                pushable(まだ).is_ok(),
                "押してよい側では通ること（{まだ:?}）"
            );
            assert!(!整った(まだ), "整ったことにしてはいけない（{まだ:?}）");
        }
        for 整い in [
            SessionStatus::WaitingInput,
            SessionStatus::WaitingSubagents,
            SessionStatus::Working,
            SessionStatus::Stalled,
        ] {
            assert!(整った(整い), "整っていること（{整い:?}）");
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

    fn 寝ている元(card_id: CardId, status: SessionStatus) -> ServerMessage {
        ServerMessage::SessionUpsert {
            session: Box::new(SessionMeta {
                card_id,
                project: protocol::ProjectId("/tmp/project".to_string()),
                claude_session_id: None,
                resumed_from: None,
                permission_mode: None,
                model: None,
                model_label: None,
                model_requested: None,
                status,
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
                branched_from: None,
                context_usage: None,
                rate_limits: None,
                cost: None,
            }),
        }
    }

    /// 記録層を1つ立て、寝ている元を1枚載せる（枝分かれの待ちの試験の土台）。
    async fn 寝ている元を載せた記録層()
    -> (Arc<SessionRegistry>, uuid::Uuid, CardId, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "agentdashboard-branch-refusal-{}.db",
            uuid::Uuid::new_v4().simple()
        ));
        let db = crate::db::connect(&format!("sqlite://{}", path.display()))
            .await
            .expect("SQLite へ繋げること");
        let registry =
            SessionRegistry::load(db, 100, None, crate::registry::NoticeLimits::default())
                .await
                .expect("記録層を立てられること");
        let origin = crate::registry::ReportOrigin::local();
        let card_id = CardId::new();
        assert!(
            registry
                .apply(
                    &origin,
                    寝ている元(card_id, SessionStatus::Ended { ok: true })
                )
                .await
        );
        (registry, origin.account_id, card_id, path)
    }

    fn 終わった断り(card_id: CardId, 文面: &str, ops: &[OpId]) -> ServerMessage {
        ServerMessage::Error {
            card_id: Some(card_id),
            message: 文面.to_string(),
            kind: ErrorKind::Revive,
            busy: Some(false),
            withdrawn: None,
            ops: ops.to_vec(),
        }
    }

    #[tokio::test]
    async fn 先の起こし直しの断りが後の受付の後に届いても自分の結果と取り違えない() {
        // 実装レビュー第6回 Astra 3。「先の起こし直し A が断られて札を下ろす → 枝分かれ B が新しい
        // 起こし直しを頼み、受け付けられる → A の断りが記録層へ取り込まれる」の順。以前は取り込んだ
        // 時点の通し番号が B の目印より大きくなり、**B は A の断りで止まった**。時計は使わず、
        // 待ちを手で1回ずつ進めて順を固定する
        let (registry, account_id, card_id, path) = 寝ている元を載せた記録層().await;
        let 先の頼み = OpId::new();
        let 起こす頼み = OpId::new();

        // ② 撃つ前に購読を張る（段取りと同じ順）
        let mut events = registry.subscribe_events();
        let mut 待ち = std::pin::pin!(wait_for(
            &registry,
            account_id,
            &mut events,
            WAKE_TIMEOUT,
            Some((card_id, 起こす頼み)),
            move |meta| meta.card_id == card_id && 整った(meta.status),
        ));
        let 一回目 =
            std::future::poll_fn(|cx| std::task::Poll::Ready(待ち.as_mut().poll(cx))).await;
        assert!(一回目.is_pending(), "まだ何も届いていない: {一回目:?}");

        // B を受け付けた**後**に、A の断りが届く
        registry
            .apply(
                &crate::registry::ReportOrigin::local(),
                終わった断り(card_id, "先の頼みの断り", &[先の頼み]),
            )
            .await;
        let 二回目 =
            std::future::poll_fn(|cx| std::task::Poll::Ready(待ち.as_mut().poll(cx))).await;
        assert!(
            二回目.is_pending(),
            "★先の起こし直しの断りを、自分の起こし直しの結果と取り違えて止まった: {二回目:?}"
        );

        // B の起こし直しが通って起きた（手元に記録があるので DB を通らない）。成功の答えは状態の
        // 後に届く（実装レビュー第11回 Astra 2。自分の頼みの結果を受けるまで状態だけでは満ちない）
        registry
            .adopt(account_id, 寝ている元(card_id, SessionStatus::WaitingInput))
            .await;
        registry.answer_revive(&crate::registry::ReportOrigin::local(), card_id, 起こす頼み);
        let 起きた = 待ち
            .await
            .expect("自分の起こし直しは断られていない")
            .expect("起きたことを受け取ること");
        assert_eq!(起きた.card_id, card_id);
        let _ = std::fs::remove_file(&path);
    }

    /// 1回だけ進める（時計は使わない）。
    async fn 一回進める<F: std::future::Future + ?Sized>(
        待ち: &mut std::pin::Pin<&mut F>,
    ) -> std::task::Poll<F::Output> {
        std::future::poll_fn(|cx| std::task::Poll::Ready(待ち.as_mut().poll(cx))).await
    }

    fn 自分への成功(card_id: CardId, op: OpId) -> ServerMessage {
        ServerMessage::Status {
            card_id,
            status: SessionStatus::WaitingInput,
            subagent_active: 0,
            last_activity_at: 2,
            op: Some(op),
        }
    }

    fn 知らせ(account_id: uuid::Uuid, message: ServerMessage) -> crate::registry::AccountEvent {
        crate::registry::AccountEvent {
            account_id,
            message,
        }
    }

    #[tokio::test]
    async fn 配信で起きた状態と自分への終わった断りがどちらの順で届いても断りで止まる() {
        // 実装レビュー第11回 Astra 2（配信の道）。束の上限を超えてこの枝分かれの起こし直しが断られて
        // いても、先の起こし直しが起こしていれば、以前は起きた状態を見た時点で満ちた——知らせの順で
        // 結果が変わった。**断りは配信だけで運ぶ**（記録層へ入れない）ので、拾えるのは配信の道だけ。
        // 起きた状態は記録にも配信にも載る（本番と同じ）
        for 断りが先 in [false, true] {
            let (registry, account_id, card_id, path) = 寝ている元を載せた記録層().await;
            let 起こす頼み = OpId::new();
            let (配る, mut events) = tokio::sync::broadcast::channel(16);
            let mut 待ち = std::pin::pin!(wait_for(
                &registry,
                account_id,
                &mut events,
                WAKE_TIMEOUT,
                Some((card_id, 起こす頼み)),
                move |meta| meta.card_id == card_id && 整った(meta.status),
            ));
            assert!(一回進める(&mut 待ち).await.is_pending());

            let 断り = 知らせ(
                account_id,
                終わった断り(card_id, "起こし直しの頼みが多すぎます", &[起こす頼み]),
            );
            if 断りが先 {
                配る.send(断り.clone()).expect("受け手が居ること");
            }
            registry
                .adopt(account_id, 寝ている元(card_id, SessionStatus::WaitingInput))
                .await;
            配る
                .send(知らせ(
                    account_id,
                    寝ている元(card_id, SessionStatus::WaitingInput),
                ))
                .expect("受け手が居ること");
            if !断りが先 {
                配る.send(断り).expect("受け手が居ること");
            }
            assert_eq!(
                一回進める(&mut 待ち).await,
                std::task::Poll::Ready(Err("起こし直しの頼みが多すぎます".to_string())),
                "★（断りが{}）先の起こし直しで起きた状態を、自分への終わった断りより優先している",
                if 断りが先 { "先" } else { "後" }
            );
            let _ = std::fs::remove_file(&path);
        }
    }

    #[tokio::test]
    async fn 記録で起きた状態と自分への終わった断りがどちらの順で入っても断りで止まる() {
        // 実装レビュー第11回 Astra 2（記録の道）。待ち始める前に、起きた状態と断りの両方が記録へ
        // 入っている形。以前は毎周の初めに状態を先に見たので、どちらの順で入っても成功した
        for 断りが先 in [false, true] {
            let (registry, account_id, card_id, path) = 寝ている元を載せた記録層().await;
            let origin = crate::registry::ReportOrigin::local();
            let 起こす頼み = OpId::new();
            registry.accept_op(account_id, card_id, 起こす頼み);
            let 断り = 終わった断り(card_id, "起こし直しの頼みが多すぎます", &[起こす頼み]);
            if 断りが先 {
                registry.apply(&origin, 断り.clone()).await;
            }
            registry
                .adopt(account_id, 寝ている元(card_id, SessionStatus::WaitingInput))
                .await;
            if !断りが先 {
                registry.apply(&origin, 断り).await;
            }
            let mut events = registry.subscribe_events();
            let mut 待ち = std::pin::pin!(wait_for(
                &registry,
                account_id,
                &mut events,
                WAKE_TIMEOUT,
                Some((card_id, 起こす頼み)),
                move |meta| meta.card_id == card_id && 整った(meta.status),
            ));
            assert_eq!(
                一回進める(&mut 待ち).await,
                std::task::Poll::Ready(Err("起こし直しの頼みが多すぎます".to_string())),
                "★（断りが{}）記録で起きた状態を、記録に残った自分への終わった断りより優先している",
                if 断りが先 { "先" } else { "後" }
            );
            let _ = std::fs::remove_file(&path);
        }
    }

    #[tokio::test]
    async fn 他の起こし直しで起きただけでは満ちず自分への成功の答えで満ちる() {
        // 実装レビュー第11回 Astra 2。カードが起きた状態は、他の起こし直しの結果でもありうる。自分の
        // 頼みへの成功の答え（番号付きの状態）を受けるまで満ちない。配信の道と記録の道の両方
        let (registry, account_id, card_id, path) = 寝ている元を載せた記録層().await;
        let 起こす頼み = OpId::new();
        let (配る, mut events) = tokio::sync::broadcast::channel(16);
        let mut 待ち = std::pin::pin!(wait_for(
            &registry,
            account_id,
            &mut events,
            WAKE_TIMEOUT,
            Some((card_id, 起こす頼み)),
            move |meta| meta.card_id == card_id && 整った(meta.status),
        ));
        registry
            .adopt(account_id, 寝ている元(card_id, SessionStatus::WaitingInput))
            .await;
        配る
            .send(知らせ(
                account_id,
                寝ている元(card_id, SessionStatus::WaitingInput),
            ))
            .expect("受け手が居ること");
        assert!(
            一回進める(&mut 待ち).await.is_pending(),
            "★自分の頼みの結果を受ける前に、カードが起きた状態だけで満ちている"
        );
        // 競合（途中の知らせ）では満ちない
        配る
            .send(知らせ(
                account_id,
                ServerMessage::Error {
                    card_id: Some(card_id),
                    message: "このカードは復旧中です".to_string(),
                    kind: ErrorKind::Revive,
                    busy: Some(true),
                    withdrawn: None,
                    ops: vec![起こす頼み],
                },
            ))
            .expect("受け手が居ること");
        assert!(一回進める(&mut 待ち).await.is_pending(), "競合で満ちている");
        配る
            .send(知らせ(account_id, 自分への成功(card_id, 起こす頼み)))
            .expect("受け手が居ること");
        assert!(
            matches!(
                一回進める(&mut 待ち).await,
                std::task::Poll::Ready(Ok(Some(meta))) if meta.card_id == card_id
            ),
            "自分への成功の答えを受けたら満ちること"
        );

        // 記録の道：競合が先に控えへ入っても、後から届いた成功の答えで置き換わる
        let 次の頼み = OpId::new();
        let origin = crate::registry::ReportOrigin::local();
        registry.accept_op(account_id, card_id, 次の頼み);
        registry
            .apply(
                &origin,
                ServerMessage::Error {
                    card_id: Some(card_id),
                    message: "このカードは復旧中です".to_string(),
                    kind: ErrorKind::Revive,
                    busy: Some(true),
                    withdrawn: None,
                    ops: vec![次の頼み],
                },
            )
            .await;
        registry.answer_revive(&origin, card_id, 次の頼み);
        let mut events = registry.subscribe_events();
        let mut 待ち = std::pin::pin!(wait_for(
            &registry,
            account_id,
            &mut events,
            WAKE_TIMEOUT,
            Some((card_id, 次の頼み)),
            move |meta| meta.card_id == card_id && 整った(meta.status),
        ));
        assert!(
            matches!(
                一回進める(&mut 待ち).await,
                std::task::Poll::Ready(Ok(Some(_)))
            ),
            "★競合が先に控えへ入ると、後から届いた成功の答えを記録から引けない"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn 競合で先の起こし直しへ束ねられたらその断りで止まる() {
        // 人が先に起こしていて、枝分かれの頼みは競合で断られた（番号は先の札へ束ねられた）。先の
        // 起こし直しがメモリ不足で断られたら、**元はもう起きてこない**ので、その理由ですぐ終わる
        // （設計§7-1。180 秒待って事実と違う理由で終わらない）
        let (registry, account_id, card_id, path) = 寝ている元を載せた記録層().await;
        let 先の頼み = OpId::new();
        let 起こす頼み = OpId::new();
        let mut events = registry.subscribe_events();
        let mut 待ち = std::pin::pin!(wait_for(
            &registry,
            account_id,
            &mut events,
            WAKE_TIMEOUT,
            Some((card_id, 起こす頼み)),
            move |meta| meta.card_id == card_id && 整った(meta.status),
        ));
        let 一回目 =
            std::future::poll_fn(|cx| std::task::Poll::Ready(待ち.as_mut().poll(cx))).await;
        assert!(一回目.is_pending());
        registry
            .apply(
                &crate::registry::ReportOrigin::local(),
                終わった断り(card_id, "メモリが足りない", &[先の頼み, 起こす頼み]),
            )
            .await;
        assert_eq!(
            待ち.await,
            Err("メモリが足りない".to_string()),
            "★束ねられた起こし直しの断りを拾っていない"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn 取りこぼした断りも記録から番号で引き直す() {
        // 実装レビュー Astra 4 の道（配信の取りこぼし）を番号で通す。**断りを配った後に購読を
        // 張る**ので、配信では1通も受け取らない——記録から引くしかない形にする。待ちは手で1回
        // だけ進める（1周目の冒頭で記録を引くので、時計を進めずに確かめられる）
        let (registry, account_id, card_id, path) = 寝ている元を載せた記録層().await;
        let origin = crate::registry::ReportOrigin::local();
        let 起こす頼み = OpId::new();
        registry
            .apply(
                &origin,
                終わった断り(card_id, "先の頼みの断り", &[OpId::new()]),
            )
            .await;
        {
            let mut events = registry.subscribe_events();
            let mut 待ち = std::pin::pin!(wait_for(
                &registry,
                account_id,
                &mut events,
                WAKE_TIMEOUT,
                Some((card_id, 起こす頼み)),
                move |meta| meta.card_id == card_id && 整った(meta.status),
            ));
            let 一回目 =
                std::future::poll_fn(|cx| std::task::Poll::Ready(待ち.as_mut().poll(cx))).await;
            assert!(
                一回目.is_pending(),
                "★記録に残った別の頼みの断りを、自分の結果として引いている: {一回目:?}"
            );
        }

        registry
            .apply(
                &origin,
                終わった断り(card_id, "自分の頼みの断り", &[起こす頼み]),
            )
            .await;
        // さらに後から別の頼みの断りが来ても、**上書きされずに**自分のものを引ける
        registry
            .apply(
                &origin,
                終わった断り(card_id, "後の頼みの断り", &[OpId::new()]),
            )
            .await;
        let mut events = registry.subscribe_events();
        let mut 待ち = std::pin::pin!(wait_for(
            &registry,
            account_id,
            &mut events,
            WAKE_TIMEOUT,
            Some((card_id, 起こす頼み)),
            move |meta| meta.card_id == card_id && 整った(meta.status),
        ));
        let 一回目 =
            std::future::poll_fn(|cx| std::task::Poll::Ready(待ち.as_mut().poll(cx))).await;
        assert_eq!(
            一回目,
            std::task::Poll::Ready(Err("自分の頼みの断り".to_string())),
            "★取りこぼした自分の断りを記録から引き直せない（後の断りに上書きされた）"
        );
        let _ = std::fs::remove_file(&path);
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
