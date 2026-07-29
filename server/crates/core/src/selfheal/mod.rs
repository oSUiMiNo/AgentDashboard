//! フォーマット変更からの自己修復（設計§9）。
//!
//! # 何をするものか
//!
//! Claude Code のトランスクリプト（JSONL）は「バージョン間で変わりうる内部形式」で、
//! 安定の保証がない。変わった瞬間に構造化ビューが壊れ、**人が気づいて直すまで
//! 壊れたまま**になる。ここはその1本道を自動化する。
//!
//! ```text
//! パーサの健康状態 → 検知 → カナリアで新しい版のサンプルを採る → ゲート
//!   ├ 通った → 対応表に載せて終わり（修復セッションは起動しない）
//!   └ 落ちた → 修復セッションを起動 → こちらでゲートを再実行
//!        ├ 通った → ビルド → パーサだけ差し替え → コミット
//!        └ 落ちた → 上限まで再試行 → 諦めて縮退＋クールダウン
//! ```
//!
//! # 歯止め
//!
//! 修復セッションは**権限確認を出さない設定で無人実行する**（利用者の判断）。
//! 走りきることと引き換えに、次の歯止めを機械側で持つ。
//!
//! 1. 作業場所は git worktree に限る（本体の作業ツリーには触らせない）
//! 2. 触った範囲を `git status` で検査し、パーサとフィクスチャ以外が動いていたら不合格
//! 3. 合否は **core が独立に実行したテスト**だけで決める（自己申告は使わない）
//! 4. 失敗は上限で打ち切り、同じ版はしばらく再挑戦しない
//! 5. 差し替え後に悪化したら自動で戻す
//! 6. `selfheal_enabled = false` で機能ごと止められる
//! 7. **プッシュはしない**（コミットまで）

pub mod ops;
pub mod repair;
pub mod state;
pub mod watchdog;

use crate::config::Config;
use crate::parser::{ParserSupervisor, StatsReport};
use crate::session::{SessionManager, now_ms};
use ops::SelfhealOps;
use protocol::ws::{SelfhealPhase, ServerMessage};
use protocol::{CardId, SessionStatus};
use state::SelfhealState;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use watchdog::{Counters, Trigger, Watchdog};

/// 健康状態の待ち行列。溢れたぶんは捨てる（次の報告でまた届く）。
const STATS_QUEUE: usize = 64;

/// 修復セッションの1ターンを待つ上限。
///
/// 無人で走らせる以上、返ってこないセッションを永久に待つわけにいかない。
const TURN_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// 起動から「指示を受け付けられる状態」になるまで待つ上限。
///
/// 本物の CLI は起動に十数秒かかることがあり、初回のフォルダ信頼の確認も挟まる。
/// 短く切ると、まだ準備できていない画面へ指示を打ち込むことになる。
const READY_TIMEOUT: Duration = Duration::from_secs(180);

/// フォルダ信頼の確認が出ていると判断する目印（小文字で照合する）。
///
/// **新しい worktree では必ずこれが出る。答えるまで `SessionStart` フックは発火しない**
/// （実測）。つまり「フックを待つ」だけでは永久に進まない。
const TRUST_PROMPT_MARKERS: [&str; 2] = ["trust this folder", "do you trust"];

/// 修復セッションの worktree とブランチの名前。
///
/// 一覧では作業ディレクトリがグループ名になるので、この名前がそのまま
/// 「dashboard-maintenance」のグループとして出る（設計§9-4）。
pub const MAINTENANCE_NAME: &str = "dashboard-maintenance";

/// 自己修復の常駐部分。
pub struct Selfheal {
    manager: Arc<SessionManager>,
    parser: Arc<ParserSupervisor>,
    config: Arc<Config>,
    /// 外の世界へ出る口。前提（Docker とソース）が無い環境では `None`
    ops: Option<Arc<dyn SelfhealOps>>,
    state_dir: PathBuf,
    watchdog: Mutex<Watchdog>,
    /// 修復中は次の検知を受け付けない。並行して2本走らせても混ざるだけ
    busy: Arc<AtomicBool>,
    /// 差し替えた直後の「保護観察」。
    ///
    /// 中身は**差し替える前の失敗率**で、これより悪くなったら戻す。観察を終える条件は
    /// 「一度でも健全な窓を通り抜けたら」。永久に見張り続けると、何か月も先に別の理由で
    /// 起きた異常で、古いパーサへ戻してしまう。
    baseline: Mutex<Option<f64>>,
    /// 発報した時点の失敗率。差し替えたときに保護観察の物差しになる
    ratio_at_trigger: Mutex<f64>,
    /// 「そもそも修復できない」ことを既に伝えたか（設定で止めている／ソースが無い）。
    ///
    /// 状態ファイルに残さないのは、利用者が設定を直したりソースを置いたりしたら
    /// すぐ効いてほしいため。起動しなおせば伝え直す。
    unavailable_notified: AtomicBool,
}

impl Selfheal {
    /// 見張りを始める。
    ///
    /// `ops` が `None` のときは検知の通知だけを行う。設計§9 の実行環境の前提
    /// （Docker とダッシュボード自身のソース）が無い環境で、黙って何もしないより、
    /// 「気づいたが直せない」と伝えるほうが利用者は次の手を打てる。
    pub fn start(
        manager: Arc<SessionManager>,
        parser: Arc<ParserSupervisor>,
        config: Arc<Config>,
        ops: Option<Arc<dyn SelfhealOps>>,
    ) -> Arc<Self> {
        let state_dir = config.resolved_state_dir();
        let selfheal = Arc::new(Self {
            manager,
            parser: Arc::clone(&parser),
            config,
            ops,
            state_dir,
            watchdog: Mutex::new(Watchdog::new()),
            busy: Arc::new(AtomicBool::new(false)),
            baseline: Mutex::new(None),
            ratio_at_trigger: Mutex::new(0.0),
            unavailable_notified: AtomicBool::new(false),
        });

        let (sink, reports) = mpsc::channel(STATS_QUEUE);
        parser.attach_stats_sink(sink);
        tokio::spawn(watch(Arc::clone(&selfheal), reports));
        selfheal
    }

    fn notify(&self, phase: SelfhealPhase, detail: Option<String>) {
        tracing::info!("自己修復 {phase:?}: {}", detail.clone().unwrap_or_default());
        self.manager
            .broadcast(ServerMessage::Selfheal { phase, detail });
    }

    /// いま修復が走っているか（テストと多重起動の防止に使う）。
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

/// 健康状態を受け取り続け、発報したら1本だけ修復を走らせる。
async fn watch(selfheal: Arc<Selfheal>, mut reports: mpsc::Receiver<StatsReport>) {
    while let Some(report) = reports.recv().await {
        let known = SelfhealState::load(&selfheal.state_dir).known_versions;
        let card = report.card_id.to_string();
        let trigger = selfheal
            .watchdog
            .lock()
            .expect("ロックが壊れていない")
            .observe(
                &card,
                Counters {
                    records_total: report.records_total,
                    parse_errors: report.parse_errors,
                    orphans: report.orphans,
                },
                &report.unknown_types,
                &report.versions,
                &known,
            );

        let Some(trigger) = trigger else {
            check_rollback(&selfheal, &card);
            continue;
        };

        // 保護観察中に率の異常が出たのなら、差し替えたパーサが悪い。直しにいくのではなく
        // 戻す。ここで修復へ進むと、悪いパーサを載せたまま何度も直そうとしてしまう
        let on_probation = selfheal
            .baseline
            .lock()
            .expect("ロックが壊れていない")
            .is_some();
        if on_probation && !matches!(trigger, Trigger::UnknownVersion { .. }) {
            rollback(&selfheal, &trigger.detail());
            selfheal
                .watchdog
                .lock()
                .expect("ロックが壊れていない")
                .forget(&card);
            continue;
        }

        // 走っている最中の発報は捨てる。同じ理由で何本も修復を起こしても混ざるだけ
        if selfheal
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            continue;
        }
        // 差し替えたときの物差しになるので、窓を畳む前に控えておく
        {
            let watchdog = selfheal.watchdog.lock().expect("ロックが壊れていない");
            *selfheal
                .ratio_at_trigger
                .lock()
                .expect("ロックが壊れていない") = watchdog.error_ratio(&card).unwrap_or(0.0);
        }
        selfheal
            .watchdog
            .lock()
            .expect("ロックが壊れていない")
            .forget(&card);

        let running = Arc::clone(&selfheal);
        tokio::spawn(async move {
            run_cycle(&running, trigger).await;
            running.busy.store(false, Ordering::SeqCst);
        });
    }
}

/// 差し替えたあとに悪化していないかを見る（設計§9 のロールバック）。
///
/// 発報するほどではない失敗の増え方も見逃さないための経路。閾値を超えた場合は
/// [`watch`] 側で戻す。
fn check_rollback(selfheal: &Arc<Selfheal>, card: &str) {
    let baseline = *selfheal.baseline.lock().expect("ロックが壊れていない");
    let Some(baseline) = baseline else {
        return;
    };
    let Some(current) = selfheal
        .watchdog
        .lock()
        .expect("ロックが壊れていない")
        .error_ratio(card)
    else {
        // 標本が足りないうちは判断しない。少ない標本で戻すほうが害が大きい
        return;
    };

    if current > baseline {
        rollback(
            selfheal,
            &format!(
                "失敗率が {:.1}% から {:.1}% へ悪化しました",
                baseline * 100.0,
                current * 100.0
            ),
        );
        return;
    }

    // 健全な窓を1つ通り抜けた。ここで観察を終えないと、ずっと先に別の理由で起きた
    // 異常で古いパーサへ戻してしまう
    *selfheal.baseline.lock().expect("ロックが壊れていない") = None;
    tracing::info!("差し替えたパーサが健全に動いています。保護観察を終えます");
}

/// 前のパーサへ戻す。
fn rollback(selfheal: &Arc<Selfheal>, reason: &str) {
    let mut state = SelfhealState::load(&selfheal.state_dir);
    let previous = state.previous_parser.take();
    *selfheal.baseline.lock().expect("ロックが壊れていない") = None;
    // 戻した直後にもう一度直しにいかせない。読めないデータが原因なら、
    // 何度やり直しても同じところで戻ることになる
    state.hold_off(now_ms(), selfheal.config.selfheal_cooldown_hours);
    state.save(&selfheal.state_dir);

    // 戻す先が無い＝もともと同梱のパーサだった。ポインタを外せば既定に戻る
    write_pointer(&selfheal.state_dir, previous.as_deref());
    selfheal.parser.restart();

    let destination = match previous {
        Some(_) => "前のパーサ",
        None => "同梱のパーサ",
    };
    selfheal.notify(
        SelfhealPhase::RolledBack,
        Some(format!("{reason}。{destination}へ戻しました")),
    );
}

/// 検知から差し替えまでの1本道（設計§9 のシーケンス）。
async fn run_cycle(selfheal: &Arc<Selfheal>, trigger: Trigger) {
    let reason = trigger.detail();
    selfheal.notify(SelfhealPhase::Detected, Some(reason.clone()));

    // 「そもそも修復できない」ことは1度だけ伝える。検知のたびに同じ断りを出しても
    // 増えるのは雑音だけで、利用者が打てる手は変わらない
    if !selfheal.config.selfheal_enabled {
        if !selfheal.unavailable_notified.swap(true, Ordering::SeqCst) {
            selfheal.notify(
                SelfhealPhase::Failed,
                Some("自己修復は設定で止められています（selfheal_enabled = false）".to_string()),
            );
        }
        return;
    }
    let Some(ops) = selfheal.ops.clone() else {
        if !selfheal.unavailable_notified.swap(true, Ordering::SeqCst) {
            selfheal.notify(
                SelfhealPhase::Failed,
                Some(
                    "修復にはダッシュボード自身のソースと Docker が要ります。検知のみ行いました"
                        .to_string(),
                ),
            );
        }
        return;
    };

    let state = SelfhealState::load(&selfheal.state_dir);
    // 直前に諦めた／戻したあとは、版に関わらずしばらく始めない。
    // これが無いと、どのパーサでも読めないデータが混ざっているときに
    // 「直す → 戻す → また直す」が止まらず、クォータを使い切る
    if !state.can_start(now_ms()) {
        selfheal.notify(
            SelfhealPhase::Cooldown,
            Some("直前の修復から間を置いています".to_string()),
        );
        return;
    }
    // 版が分かっている検知なら、その版のクールダウンも見る
    if let Trigger::UnknownVersion { version } = &trigger
        && state.in_cooldown(version, now_ms())
    {
        selfheal.notify(
            SelfhealPhase::Cooldown,
            Some(format!(
                "{version} は先に失敗しているため、しばらく再挑戦しません"
            )),
        );
        return;
    }

    let worktree = match blocking(&ops, |ops| ops.prepare_worktree(MAINTENANCE_NAME)).await {
        Ok(path) => path,
        Err(error) => {
            give_up(selfheal, &format!("作業場所を用意できません: {error}"));
            return;
        }
    };

    // カナリア：新しい版の JSONL を「構造の全部入り」で採る
    selfheal.notify(
        SelfhealPhase::Canary,
        Some(format!(
            "{} でサンプルを採っています",
            selfheal.config.canary_model
        )),
    );
    let sample = match canary(selfheal, &ops, &worktree).await {
        Ok(sample) => sample,
        Err(error) => {
            give_up(selfheal, &format!("カナリアに失敗しました: {error}"));
            return;
        }
    };
    let version = sample.version.clone();

    // ゲート：採ったサンプルを含めてゴールデンテストを回す
    selfheal.notify(SelfhealPhase::Testing, None);
    let worktree_for_gate = worktree.clone();
    let gate = blocking(&ops, move |ops| Ok(ops.run_gate(&worktree_for_gate)))
        .await
        .expect("ゲートは結果を必ず返す");

    if gate.passed {
        // 直す必要が無かった。採ったサンプルはフィクスチャとして残す（設計 安全条件2）
        let mut state = SelfhealState::load(&selfheal.state_dir);
        state.record_success(&version);
        state.save(&selfheal.state_dir);
        commit(
            &ops,
            &worktree,
            &format!("fixtures: {version} のカナリアを追加"),
        )
        .await;
        selfheal.notify(
            SelfhealPhase::Passed,
            Some(format!("{version} はいまのパーサで読めました")),
        );
        return;
    }

    // 落ちているサンプルを消せばテストは通ってしまう。渡したものがそのまま残っている
    // ことを機械で確かめるために、この時点の指紋と中身を控える（§17）
    let sample_file = sample.dir.join("session.jsonl");
    let sample = Sample {
        mark: repair::fingerprint(&sample_file),
        bytes: std::fs::read(&sample_file).ok(),
        path: sample_file,
    };

    repair_loop(
        selfheal,
        &ops,
        &worktree,
        &reason,
        &version,
        gate.output,
        sample,
    )
    .await;
}

/// 修復が終わったあとも、そのまま残っていなければならないサンプル。
struct Sample {
    path: PathBuf,
    mark: Option<u64>,
    /// 渡した時点の中身。消されたら**こちらで戻す**ために持つ
    bytes: Option<Vec<u8>>,
}

impl Sample {
    /// 消されたり書き換えられたりしていないか。
    fn intact(&self) -> bool {
        repair::fingerprint(&self.path) == self.mark
    }

    /// 元の中身に戻す。
    ///
    /// 戻すのをこちら側でやるのは、**消した本人には戻せない**から。採取したサンプルの
    /// 中身はエージェントの手元に無く、「元に戻して」と言うだけでは詰んでしまう。
    fn restore(&self) -> bool {
        let Some(bytes) = &self.bytes else {
            return false;
        };
        if let Some(dir) = self.path.parent()
            && std::fs::create_dir_all(dir).is_err()
        {
            return false;
        }
        std::fs::write(&self.path, bytes).is_ok()
    }
}

/// 修復セッションを起こし、通るまで（上限まで）繰り返す。
#[allow(clippy::too_many_arguments)]
async fn repair_loop(
    selfheal: &Arc<Selfheal>,
    ops: &Arc<dyn SelfhealOps>,
    worktree: &Path,
    reason: &str,
    version: &str,
    mut gate_output: String,
    sample: Sample,
) {
    let retry_limit = selfheal.config.selfheal_retry;
    let mut card: Option<CardId> = None;

    for attempt in 1..=retry_limit {
        selfheal.notify(
            SelfhealPhase::Repairing,
            Some(format!(
                "修復セッションが作業しています（{attempt}/{retry_limit}）"
            )),
        );

        let message = match card {
            None => repair::repair_prompt(&repair::RepairContext {
                reason,
                gate_output: &gate_output,
                attempt,
                retry_limit,
            }),
            Some(_) => repair::retry_prompt(&gate_output, attempt, retry_limit),
        };

        let card_id = match card {
            Some(card_id) => card_id,
            None => match start_repair_session(selfheal, worktree).await {
                Ok(card_id) => {
                    card = Some(card_id);
                    card_id
                }
                Err(error) => {
                    selfheal.notify(
                        SelfhealPhase::Failed,
                        Some(format!("修復セッションを起動できません: {error}")),
                    );
                    finish_failure(selfheal, version);
                    return;
                }
            },
        };

        if !send_and_wait(selfheal, card_id, &message).await {
            selfheal.notify(
                SelfhealPhase::Failed,
                Some("修復セッションが応答しませんでした".to_string()),
            );
            break;
        }

        // ここから先はエージェントの言い分ではなく、こちらで確かめた事実だけを使う
        selfheal.notify(SelfhealPhase::Verifying, None);
        let worktree_owned = worktree.to_path_buf();
        let changed = blocking(ops, move |ops| ops.changed_files(&worktree_owned))
            .await
            .unwrap_or_default();
        let violations = repair::scope_violations(&changed);
        if !violations.is_empty() {
            gate_output = format!(
                "変更してよい範囲の外に手が入っています: {}。\
                これらを元に戻してから、パーサとフィクスチャだけで直してください。",
                violations.join(", ")
            );
            continue;
        }

        // 落ちているサンプルを消せばテストは通る。それは対応したことにならない。
        // 採りたてのファイルは追跡対象外なので、消しても `git status` には出ない
        if !sample.intact() {
            let restored = sample.restore();
            gate_output = format!(
                "検証用のサンプル {} が消えているか書き換えられていました。{}\
                このサンプルが読めるようになって初めて、新しい形式に対応したと言えます。\
                フィクスチャではなく **パーサ側** を直してください。",
                sample.path.display(),
                if restored {
                    "こちらで元の内容に戻しました。"
                } else {
                    ""
                }
            );
            continue;
        }

        let worktree_owned = worktree.to_path_buf();
        let gate = blocking(ops, move |ops| Ok(ops.run_gate(&worktree_owned)))
            .await
            .expect("ゲートは結果を必ず返す");
        if !gate.passed {
            gate_output = gate.output;
            continue;
        }

        if swap_parser(selfheal, ops, worktree, version).await {
            close_session(selfheal, card);
            return;
        }
        gate_output = "ビルドに失敗しました。コンパイルが通る状態にしてください。".to_string();
    }

    close_session(selfheal, card);
    finish_failure(selfheal, version);
}

/// ビルドして、パーサを新しいものへ差し替える。
async fn swap_parser(
    selfheal: &Arc<Selfheal>,
    ops: &Arc<dyn SelfhealOps>,
    worktree: &Path,
    version: &str,
) -> bool {
    let worktree_owned = worktree.to_path_buf();
    let built = match blocking(ops, move |ops| ops.build_parser(&worktree_owned)).await {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!("パーサをビルドできません: {error}");
            return false;
        }
    };

    // 版ごとの場所へ写す。上書きしないのは、戻す先を残すため
    let destination = selfheal
        .state_dir
        .join("parsers")
        .join(format!("{version}-{}", now_ms()))
        .join("transcript-parser");
    if let Some(dir) = destination.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return false;
        }
    }
    if std::fs::copy(&built, &destination).is_err() {
        return false;
    }

    let mut state = SelfhealState::load(&selfheal.state_dir);
    state.previous_parser = read_pointer(&selfheal.state_dir);
    state.record_success(version);
    state.save(&selfheal.state_dir);
    write_pointer(&selfheal.state_dir, Some(&destination));

    // 差し替え前の失敗率を物差しにして保護観察に入る（悪化したら戻す）
    let before = *selfheal
        .ratio_at_trigger
        .lock()
        .expect("ロックが壊れていない");
    *selfheal.baseline.lock().expect("ロックが壊れていない") = Some(before);
    selfheal.parser.restart();

    commit(
        ops,
        worktree,
        &format!("fix(transcript-parser): {version} のフォーマットに追随する"),
    )
    .await;
    selfheal.notify(
        SelfhealPhase::Swapped,
        Some(format!("{version} に対応したパーサへ差し替えました")),
    );
    true
}

/// 版に辿り着く前に諦めたときの後始末。
///
/// **必ず間を置く。** 置かないと、claude が居ない・git が使えないといった直らない事情の
/// ときに、健康状態が届くたび何度でも同じことを試すことになる（カナリアは本物の CLI を
/// 起動するので、そのぶんクォータを使う）。
fn give_up(selfheal: &Arc<Selfheal>, reason: &str) {
    let mut state = SelfhealState::load(&selfheal.state_dir);
    state.hold_off(now_ms(), selfheal.config.selfheal_cooldown_hours);
    state.save(&selfheal.state_dir);
    selfheal.notify(SelfhealPhase::Failed, Some(reason.to_string()));
}

/// 諦めたときの後始末。縮退のまま、同じ版はしばらく触らない。
fn finish_failure(selfheal: &Arc<Selfheal>, version: &str) {
    let mut state = SelfhealState::load(&selfheal.state_dir);
    state.record_failure(version, now_ms(), selfheal.config.selfheal_cooldown_hours);
    state.save(&selfheal.state_dir);

    // 縮退モードの宣言（設計§9-6）。パーサのプロセスは動いていても、中身を正しく
    // 読めていない以上、履歴の表示を信じてよいかどうかは伝えなければならない
    selfheal.parser.degrade(format!(
        "{version} のフォーマットに追随できていません。ターミナルと指示送信は使えます"
    ));
    selfheal.notify(
        SelfhealPhase::Failed,
        Some(format!(
            "{version} に自動で追随できませんでした。構造化ビューは縮退したままですが、\
            ターミナルと指示送信はそのまま使えます"
        )),
    );
    selfheal.notify(
        SelfhealPhase::Cooldown,
        Some(format!(
            "{}時間は同じ版へ再挑戦しません",
            selfheal.config.selfheal_cooldown_hours
        )),
    );
}

/// カナリアを走らせる。薄いサンプルなら1回だけ別のモデルで採り直す。
async fn canary(
    selfheal: &Arc<Selfheal>,
    ops: &Arc<dyn SelfhealOps>,
    worktree: &Path,
) -> anyhow::Result<ops::CanarySample> {
    let model = selfheal.config.canary_model.clone();
    let worktree_owned = worktree.to_path_buf();
    let sample = blocking(ops, move |ops| ops.run_canary(&model, &worktree_owned)).await?;
    if !sample.is_thin() {
        return Ok(sample);
    }

    let fallback = selfheal.config.canary_fallback_model.clone();
    selfheal.notify(
        SelfhealPhase::Canary,
        Some(format!(
            "サンプルにツールコールかサブエージェントが入りませんでした。{fallback} で採り直します"
        )),
    );
    let worktree_owned = worktree.to_path_buf();
    match blocking(ops, move |ops| ops.run_canary(&fallback, &worktree_owned)).await {
        Ok(retried) => Ok(retried),
        // 採り直しに失敗しても、薄いサンプルで先へ進めたほうが何もしないよりまし
        Err(error) => {
            tracing::warn!("カナリアの採り直しに失敗しました: {error}");
            Ok(sample)
        }
    }
}

/// 修復セッションを起動し、入力を受け付ける状態まで待つ。
async fn start_repair_session(selfheal: &Arc<Selfheal>, worktree: &Path) -> anyhow::Result<CardId> {
    let mut args = vec![
        // 無人で走りきらせる（利用者の判断）
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
        // バイパスと必ず組で使う。これが無いと利用者のグローバル設定のフックやスキルまで
        // 自動承認で走ってしまい、爆発半径がパーサ修復の外へ広がる
        "--setting-sources".to_string(),
        "project,local".to_string(),
    ];
    if let Some(model) = &selfheal.config.repair_model {
        args.push("--model".to_string());
        args.push(model.clone());
    }

    let session = selfheal
        .manager
        .spawn_with_args(&worktree.to_string_lossy(), &args)?;
    let card_id = session.meta().card_id;

    // 起動直後に入力待ちへ入らない場合、フォルダ信頼の確認のような確定待ちの画面で
    // 止まっている可能性がある。状態を見たうえで1回だけ確定を送る
    if !wait_ready(selfheal, &session, card_id).await {
        anyhow::bail!("修復セッションが指示を受け付ける状態になりませんでした");
    }
    Ok(card_id)
}

/// 起動が済んで指示を受け付けられる状態になるまで待つ。
///
/// # 画面を見てから答える
///
/// 新しい worktree では**フォルダ信頼の確認**が必ず出る。そして**答えるまで
/// `SessionStart` フックは発火しない**（実測）。つまりフックだけを待っていると
/// 永久に進まない。かといって時間で区切って闇雲に確定キーを送ると、別の画面へ
/// 届いて意図しない選択をしてしまう（フェーズ3で実測した事故）。
/// **その画面が出ていることを確かめてから**答える。
async fn wait_ready(
    selfheal: &Arc<Selfheal>,
    session: &Arc<crate::session::Session>,
    card_id: CardId,
) -> bool {
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    let mut answered_trust = false;

    while tokio::time::Instant::now() < deadline {
        match selfheal.manager.get(card_id).map(|found| found.status()) {
            // SessionStart が届いた＝指示を受け付けられる
            Some(SessionStatus::WaitingInput) => return true,
            Some(SessionStatus::Ended { .. }) | None => return false,
            _ => {}
        }

        if !answered_trust {
            let screen = session.scrollback_text().to_lowercase();
            if TRUST_PROMPT_MARKERS
                .iter()
                .any(|marker| screen.contains(marker))
            {
                tracing::info!("修復セッションのフォルダ信頼の確認に答えます");
                let _ = session.write_input(b"\r");
                answered_trust = true;
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    false
}

/// 指示を送り、そのターンが終わる（＝入力待ちに戻る）まで待つ。
///
/// **送る前に購読を始める**のが要点。状態を覗きにいく方式だと、作業がごく短いときに
/// 「作業中」を見逃して始まりを待ち続けてしまう。イベントで受ければ、通り過ぎた変化も
/// 順番どおりに拾える。
async fn send_and_wait(selfheal: &Arc<Selfheal>, card_id: CardId, message: &str) -> bool {
    let Some(session) = selfheal.manager.get(card_id) else {
        return false;
    };
    let mut events = selfheal.manager.subscribe_events();
    if session
        .write_input(&crate::session::input::encode_input(message))
        .is_err()
    {
        return false;
    }
    wait_for_waiting_input(&mut events, card_id, TURN_TIMEOUT).await
}

/// そのカードが入力待ちになるまでイベントを待つ。終了したら false。
async fn wait_for_waiting_input(
    events: &mut tokio::sync::broadcast::Receiver<ServerMessage>,
    card_id: CardId,
    timeout: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let status = match tokio::time::timeout(remaining, events.recv()).await {
            Ok(Ok(ServerMessage::Status {
                card_id: id,
                status,
                ..
            })) if id == card_id => status,
            // ターンの終わりでは直前の応答の要約も変わるので、カード全体で届くことがある
            Ok(Ok(ServerMessage::SessionUpsert { session })) if session.card_id == card_id => {
                session.status
            }
            Ok(Ok(ServerMessage::SessionRemoved { card_id: id })) if id == card_id => return false,
            // 取りこぼしても、次の変化で拾い直せる
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) | Err(_) => return false,
            _ => continue,
        };
        match status {
            SessionStatus::WaitingInput => return true,
            // 終わったセッションにこれ以上頼めることは無い
            SessionStatus::Ended { .. } => return false,
            _ => continue,
        }
    }
}

/// 修復セッションを終わらせる。
///
/// カードは Ended として一覧に残るので、何が起きたかは後から追える。生かしたままに
/// しないのは、権限確認を出さない設定のセッションを放置しないため。
fn close_session(selfheal: &Arc<Selfheal>, card: Option<CardId>) {
    if let Some(card_id) = card {
        let _ = selfheal.manager.kill(card_id);
    }
}

async fn commit(ops: &Arc<dyn SelfhealOps>, worktree: &Path, message: &str) {
    let worktree = worktree.to_path_buf();
    let message = message.to_string();
    if let Err(error) = blocking(ops, move |ops| ops.commit(&worktree, &message)).await {
        // コミットできなくても、直ったこと自体は変わらない
        tracing::warn!("worktree をコミットできません: {error}");
    }
}

/// 外の世界に出る操作を、非同期の実行を止めないように専用スレッドで動かす。
async fn blocking<T, F>(ops: &Arc<dyn SelfhealOps>, work: F) -> anyhow::Result<T>
where
    T: Send + 'static,
    F: FnOnce(&dyn SelfhealOps) -> anyhow::Result<T> + Send + 'static,
{
    let ops = Arc::clone(ops);
    tokio::task::spawn_blocking(move || work(ops.as_ref())).await?
}

/// 使うパーサを指すポインタを書く（消したいときは `None`）。
fn write_pointer(state_dir: &Path, path: Option<&Path>) {
    let pointer = state_dir.join(crate::parser::PARSER_POINTER);
    match path {
        Some(path) => {
            let _ = std::fs::create_dir_all(state_dir);
            let _ = std::fs::write(&pointer, path.to_string_lossy().as_bytes());
        }
        None => {
            let _ = std::fs::remove_file(&pointer);
        }
    }
}

fn read_pointer(state_dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(state_dir.join(crate::parser::PARSER_POINTER)).ok()?;
    let path = PathBuf::from(text.trim());
    path.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-pointer-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ポインタは書いて読んで消せる() {
        let dir = temp_dir("roundtrip");
        let binary = dir.join("transcript-parser");
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();

        write_pointer(&dir, Some(&binary));
        assert_eq!(read_pointer(&dir), Some(binary));

        write_pointer(&dir, None);
        assert_eq!(read_pointer(&dir), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 指す先が消えていたらポインタは無効として扱う() {
        // 差し替えたバイナリを誰かが消しても、既定のパーサで起動できなければ困る
        let dir = temp_dir("dangling");
        write_pointer(&dir, Some(&dir.join("居ない")));

        assert_eq!(read_pointer(&dir), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
