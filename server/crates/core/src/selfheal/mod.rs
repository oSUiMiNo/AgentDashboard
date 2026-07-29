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

/// 起動直後、最初の入力待ちになるまで待つ時間。
///
/// これを過ぎても入力待ちにならない場合、初回起動のフォルダ信頼の確認のような
/// **確定キー待ちの画面**で止まっている可能性がある。1回だけ確定を送って様子を見る。
/// 闇雲にキーを送らないのは、フェーズ3で「送ったキーが別の相手に吸われる」事故を
/// 実測しているため（PJTガイドライン）。
const READY_TIMEOUT: Duration = Duration::from_secs(20);

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
    /// 差し替え直前の失敗率。悪化したかどうかの物差し
    baseline: Mutex<Option<f64>>,
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
        // 走っている最中の発報は捨てる。同じ理由で何本も修復を起こしても混ざるだけ
        if selfheal
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            continue;
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
        return;
    };
    if current <= baseline {
        return;
    }

    let mut state = SelfhealState::load(&selfheal.state_dir);
    let previous = state.previous_parser.take();
    *selfheal.baseline.lock().expect("ロックが壊れていない") = None;

    match previous {
        Some(previous) => {
            write_pointer(&selfheal.state_dir, Some(&previous));
            state.save(&selfheal.state_dir);
            selfheal.parser.restart();
            selfheal.notify(
                SelfhealPhase::RolledBack,
                Some(format!(
                    "差し替え後に失敗率が悪化しました（{:.1}% → {:.1}%）。前のパーサへ戻しました",
                    baseline * 100.0,
                    current * 100.0
                )),
            );
        }
        None => {
            // 戻す先が無い＝もともと同梱のパーサ。ポインタを外せば既定に戻る
            write_pointer(&selfheal.state_dir, None);
            state.save(&selfheal.state_dir);
            selfheal.parser.restart();
            selfheal.notify(
                SelfhealPhase::RolledBack,
                Some("差し替え後に悪化したため、同梱のパーサへ戻しました".to_string()),
            );
        }
    }
}

/// 検知から差し替えまでの1本道（設計§9 のシーケンス）。
async fn run_cycle(selfheal: &Arc<Selfheal>, trigger: Trigger) {
    let reason = trigger.detail();
    selfheal.notify(SelfhealPhase::Detected, Some(reason.clone()));

    if !selfheal.config.selfheal_enabled {
        selfheal.notify(
            SelfhealPhase::Failed,
            Some("自己修復は設定で止められています（selfheal_enabled = false）".to_string()),
        );
        return;
    }
    let Some(ops) = selfheal.ops.clone() else {
        selfheal.notify(
            SelfhealPhase::Failed,
            Some(
                "修復にはダッシュボード自身のソースと Docker が要ります。検知のみ行いました"
                    .to_string(),
            ),
        );
        return;
    };

    // 版が分かっている検知なら、クールダウン中かどうかをここで見る
    if let Trigger::UnknownVersion { version } = &trigger {
        let state = SelfhealState::load(&selfheal.state_dir);
        if state.in_cooldown(version, now_ms()) {
            selfheal.notify(
                SelfhealPhase::Cooldown,
                Some(format!(
                    "{version} は先に失敗しているため、しばらく再挑戦しません"
                )),
            );
            return;
        }
    }

    let worktree = match blocking(&ops, |ops| ops.prepare_worktree(MAINTENANCE_NAME)).await {
        Ok(path) => path,
        Err(error) => {
            selfheal.notify(
                SelfhealPhase::Failed,
                Some(format!("作業場所を用意できません: {error}")),
            );
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
            selfheal.notify(
                SelfhealPhase::Failed,
                Some(format!("カナリアに失敗しました: {error}")),
            );
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

    repair_loop(selfheal, &ops, &worktree, &reason, &version, gate.output).await;
}

/// 修復セッションを起こし、通るまで（上限まで）繰り返す。
async fn repair_loop(
    selfheal: &Arc<Selfheal>,
    ops: &Arc<dyn SelfhealOps>,
    worktree: &Path,
    reason: &str,
    version: &str,
    mut gate_output: String,
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

    // 差し替え前の失敗率を控えてから立て直す。悪化したかどうかはこれと比べて決める
    *selfheal.baseline.lock().expect("ロックが壊れていない") = Some(0.0);
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

/// 諦めたときの後始末。縮退のまま、同じ版はしばらく触らない。
fn finish_failure(selfheal: &Arc<Selfheal>, version: &str) {
    let mut state = SelfhealState::load(&selfheal.state_dir);
    state.record_failure(version, now_ms(), selfheal.config.selfheal_cooldown_hours);
    state.save(&selfheal.state_dir);

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
    if !wait_for_status(selfheal, card_id, READY_TIMEOUT).await {
        tracing::info!("修復セッションが入力待ちになりません。確定キーを1回送ります");
        let _ = session.write_input(b"\r");
        wait_for_status(selfheal, card_id, READY_TIMEOUT).await;
    }
    Ok(card_id)
}

/// 指示を送り、そのターンが終わるまで待つ。
async fn send_and_wait(selfheal: &Arc<Selfheal>, card_id: CardId, message: &str) -> bool {
    let Some(session) = selfheal.manager.get(card_id) else {
        return false;
    };
    if session
        .write_input(&crate::session::input::encode_input(message))
        .is_err()
    {
        return false;
    }
    // 送った直後はまだ入力待ちのままなので、作業に入るのを待ってから終わりを待つ
    wait_for_working(selfheal, card_id).await;
    wait_for_status(selfheal, card_id, TURN_TIMEOUT).await
}

/// 作業中になるまで待つ（取りこぼしても先へ進む）。
async fn wait_for_working(selfheal: &Arc<Selfheal>, card_id: CardId) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while tokio::time::Instant::now() < deadline {
        match selfheal
            .manager
            .get(card_id)
            .map(|session| session.status())
        {
            Some(SessionStatus::Working) | Some(SessionStatus::Ended { .. }) | None => return,
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

/// 入力待ち（＝ターンが終わった）か、終了になるまで待つ。
async fn wait_for_status(selfheal: &Arc<Selfheal>, card_id: CardId, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        match selfheal
            .manager
            .get(card_id)
            .map(|session| session.status())
        {
            Some(SessionStatus::WaitingInput) => return true,
            // 終了したセッションにこれ以上頼めることは無い
            Some(SessionStatus::Ended { .. }) | None => return false,
            _ => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
    false
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
