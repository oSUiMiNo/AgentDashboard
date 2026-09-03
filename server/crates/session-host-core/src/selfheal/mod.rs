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

pub mod model_table;
pub mod ops;
pub mod repair;
pub mod state;
pub mod watchdog;

use crate::config::SessionHostConfig;
use crate::parser::{ParserSupervisor, ParserTrouble, StatsReport};
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

/// 「載っているものが悪い」の待ち行列。
///
/// **深く持つ意味が無い。** 同じ知らせを積んでも、戻す回数が増えるだけ（戻すのは1回で足りる）。
const TROUBLE_QUEUE: usize = 4;

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

/// 信頼の確認を探すときに読むスクロールバックの末尾の長さ（バイト）。
///
/// 全体（既定 1MiB）を 300ms ごとに複製すると、180秒で 600 回コピーすることになる。
/// 確認は起動直後の画面に出るので、末尾だけで足りる。
const TRUST_TAIL: usize = 32 * 1024;

/// 修復セッションの worktree とブランチの名前。
///
/// 一覧では作業ディレクトリがグループ名になるので、この名前がそのまま
/// 「dashboard-maintenance」のグループとして出る（設計§9-4）。
pub const MAINTENANCE_NAME: &str = "dashboard-maintenance";

/// 自己修復の常駐部分。
pub struct Selfheal {
    manager: Arc<SessionManager>,
    parser: Arc<ParserSupervisor>,
    config: Arc<SessionHostConfig>,
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
    /// 直前に伝えた進み具合。同じ内容を繰り返さないための控え
    last_notice: Mutex<Option<(SelfhealPhase, Option<String>)>>,
}

impl Selfheal {
    /// 見張りを始める。
    ///
    /// `ops` が `None` のときは検知の通知だけを行う。設計§9 の実行環境の前提
    /// （Docker とダッシュボード自身のソース）が無い環境で、黙って何もしないより、
    /// 「気づいたが直せない」と伝えるほうが利用者は次の手を打てる。
    ///
    /// `cli_version` は**呼び出し側が読んで渡す**。ここで読むと、対応表を取り出すときの
    /// 1回と合わせて起動のたびに CLI を2回起こすことになる。同じプロセスで版が
    /// 変わるわけがないので、[`crate::model_catalog::ModelCatalog::cli_version`] を回す。
    /// 読めなかった場合は空文字で、そのときは見直しを起こさない
    /// （比べる相手が無いので「上がった」と判断できない）。
    pub fn start(
        manager: Arc<SessionManager>,
        parser: Arc<ParserSupervisor>,
        config: Arc<SessionHostConfig>,
        ops: Option<Arc<dyn SelfhealOps>>,
        cli_version: String,
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
            last_notice: Mutex::new(None),
        });

        let (sink, reports) = mpsc::channel(STATS_QUEUE);
        parser.attach_stats_sink(sink);
        tokio::spawn(watch(Arc::clone(&selfheal), reports));

        // 「載っているものが悪い」ことの受け口（設計§6-1）。**自己修復を止めていても
        // 差し込む**——これは自己修復の一部ではなく、機械を守るためのものなので、
        // `selfheal_enabled` や `ops` の有無で切らない（設計§10）
        let (trouble_sink, troubles) = mpsc::channel(TROUBLE_QUEUE);
        parser.attach_trouble_sink(trouble_sink);
        tokio::spawn(watch_trouble(Arc::clone(&selfheal), troubles));

        // CLI が上がっていたら、モデル別名の表を見直す（設計§14）。
        // **契機は観測ではなくバージョン変化。** 誰も使っていない新しい別名は
        // 観測されないので、観測を待っていると永久に気づけない
        if selfheal.config.selfheal_enabled
            && selfheal.ops.is_some()
            && model_table::needs_review(&selfheal.state_dir, &cli_version)
        {
            tokio::spawn(review_model_table(Arc::clone(&selfheal), cli_version));
        }
        selfheal
    }

    /// 進み具合を伝える。**直前と同じ内容なら黙る。**
    ///
    /// クールダウン中は健康状態が届くたびに同じ判断へ辿り着くので、素通しにすると
    /// 「検知しました」「間を置いています」が延々と出続ける。利用者から見ると
    /// バナーが消えなくなるだけで、新しく分かることは何も無い。進展があれば
    /// 段階か中身のどちらかは必ず変わる。
    fn notify(&self, phase: SelfhealPhase, detail: Option<String>) {
        let notice = (phase, detail.clone());
        {
            let mut last = self.last_notice.lock().expect("ロックが壊れていない");
            if last.as_ref() == Some(&notice) {
                return;
            }
            *last = Some(notice);
        }
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

/// 「載っているものが悪い」を受けて戻す（設計§6-1）。
///
/// **判断は世話役が済ませてある。** ここへ届くのは出どころがポインタのものだけで、
/// 戻す先が必ずある。やることは、既にある [`rollback`] を理由付きで呼ぶことだけ——
/// あれが「ポインタを戻す・間を置く・立て直す・画面へ知らせる」を1組で持っている。
///
/// **`selfheal_enabled` を見ない。** 自己修復を止めていても、載っているものが機械を
/// 落としにかかっているなら降ろす（設計§10）。
async fn watch_trouble(selfheal: Arc<Selfheal>, mut troubles: mpsc::Receiver<ParserTrouble>) {
    while let Some(trouble) = troubles.recv().await {
        let reason = match trouble {
            ParserTrouble::Runaway {
                pid,
                rss_bytes,
                reads_per_sec,
                growth_per_min,
            } => format!(
                // **pid も出す**（設計§18-7）。ログの行と突き合わせるための番号なので、
                // 運ぶだけ運んで画面に出さないと、知らせから先へ辿れない
                "差し替えたパーサ（pid {}）が資源を食い続けています（{}MB・毎秒 {reads_per_sec} 回の read・毎分 {}MB 増）",
                match pid {
                    Some(pid) => pid.to_string(),
                    // 刈り取られた後だと取れない。**「不明」と書く**——欄ごと消すと、
                    // 読む側は「出し忘れ」と区別が付かない
                    None => "不明".to_string(),
                },
                rss_bytes / (1024 * 1024),
                growth_per_min / (1024 * 1024),
            ),
            ParserTrouble::CrashLoop { times, within } => format!(
                "差し替えたパーサが{}分のうちに{times}回落ちました",
                within.as_secs() / 60
            ),
            ParserTrouble::VersionMismatch { parser_version } => format!(
                "差し替えたパーサが本体と違う版を名乗りました（core={} / parser={parser_version}）。\
                 古い木から作られています",
                env!("CARGO_PKG_VERSION")
            ),
        };
        rollback(&selfheal, &reason);
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

    // **戻る先は「1つ前の版」で、同梱版になるのは戻す先が無いときだけ**（設計§18-8）。
    // 「同梱の版へ戻しました」と言い切ると、実際には別の差し替え版が載っている場面で
    // 嘘になる
    let destination = match previous {
        Some(_) => "1つ前の版",
        None => "同梱の版",
    };
    selfheal.notify(
        SelfhealPhase::RolledBack,
        Some(format!("{reason}。{destination}へ戻しました")),
    );
}

/// 検知から差し替えまでの1本道（設計§9 のシーケンス）。
async fn run_cycle(selfheal: &Arc<Selfheal>, trigger: Trigger) {
    let reason = trigger.detail();

    // **何もしないと決まっているなら「検知しました」は出さない。**
    // 健康状態は数秒おきに届くので、出してから断ると「検知」と「断り」が交互に並び、
    // 画面のバナーが消えなくなる。断りの中に理由を含めれば、伝わる中身は変わらない
    //
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
        // 配ったバイナリで動いている PC（設計§10-2）。**検知は動かし続け、直せない
        // ことだけを伝える。** 利用者が打てる手は「新しいバイナリを取ってくる」なので、
        // 「修復に失敗しました」ではなく**次の一手**を書く
        if !selfheal.unavailable_notified.swap(true, Ordering::SeqCst) {
            selfheal.notify(
                SelfhealPhase::Failed,
                Some(format!(
                    "パーサの更新が必要です。この PC では直せません\
                     （ダッシュボード自身のソースと Docker が要ります）。{reason}"
                )),
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
            Some(format!("{reason}。直前の修復から間を置いています")),
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

    // ここまで来たら実際に手を動かす。この時点で初めて「検知しました」を出す
    selfheal.notify(SelfhealPhase::Detected, Some(reason.clone()));

    let worktree = match blocking(&ops, |ops| ops.prepare_worktree(MAINTENANCE_NAME)).await {
        Ok(path) => path,
        Err(error) => {
            give_up(selfheal, &format!("作業場所を用意できません: {error}"));
            return;
        }
    };

    // **基準の SHA は、ここで1回だけ読む**（設計§18-1）。門のたびに読み直すと、
    // 修復中に本体が進んだだけで——このリポジトリは複数のセッションが同時に触るので
    // 珍しくない——正しく直った成果を捨てて24時間のクールダウンへ入ってしまう。
    //
    // 付け替えの直後に読むので、**土台が古ければ偽のまま**になる。門の目的は保たれる
    let baseline = match blocking(&ops, |ops| ops.repo_head()).await {
        Ok(sha) => sha,
        Err(error) => {
            give_up(selfheal, &format!("本体の HEAD を読めません: {error}"));
            return;
        }
    };

    // 門①：古い土台の上で修復を始めない（設計§4-1）。
    // ここで無理に進めると、**本体で直したことが入っていない実行ファイル**が出来上がる
    if !worktree_contains(selfheal, &ops, &worktree, &baseline, "修復を始める前").await {
        return;
    }

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
        &baseline,
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
    /// 中身はセッションホストの手元に無く、「元に戻して」と言うだけでは詰んでしまう。
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
    // 門が見る基準。**周回の開始時に決めたものをそのまま使う**（設計§18-1）
    baseline: &str,
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

        // ここから先はセッションホストの言い分ではなく、こちらで確かめた事実だけを使う
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

        // 門②：修復セッションが積んだコミットまで含めて、まだ本体の子孫か（設計§4-1）。
        // **ここで断ったら、直しをやり直させない**——木そのものが古いので、何度直しても
        // 出来上がるものは同じように古い
        if !worktree_contains(selfheal, ops, worktree, baseline, "ビルドの直前").await {
            close_session(selfheal, card);
            return;
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

/// 作業場所が基準の SHA を含んでいるかを見て、含んでいなければ**間を置いて諦める**。
///
/// 2回見るのは、修復セッションが**その間にコミットを積む**ため（設計§4-1）。積んだ結果まで
/// 含めて基準の子孫でなければ、出来上がる実行ファイルには本体の直しが入っていない。
///
/// **基準は周回の開始時に決めたものを渡す。** ここで読み直すと、修復中に本体が進んだだけで
/// 断ってしまう（設計§18-1）。
async fn worktree_contains(
    selfheal: &Arc<Selfheal>,
    ops: &Arc<dyn SelfhealOps>,
    worktree: &Path,
    baseline: &str,
    when: &str,
) -> bool {
    let worktree_owned = worktree.to_path_buf();
    let baseline_owned = baseline.to_string();
    match blocking(ops, move |ops| {
        ops.worktree_contains(&worktree_owned, &baseline_owned)
    })
    .await
    {
        Ok(true) => true,
        Ok(false) => {
            give_up(
                selfheal,
                &format!(
                    "修復の作業場所が本体に追いついていません（{when}）。\
                     古い木から作ると、本体で直したことが入らない実行ファイルが出来上がります"
                ),
            );
            false
        }
        Err(error) => {
            // 見られないなら通さない。**素通しにすると、門が在ることにならない**
            give_up(
                selfheal,
                &format!(
                    "修復の作業場所が本体に追いついているか確かめられません（{when}）: {error}"
                ),
            );
            false
        }
    }
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

/// 別名の表を、公式ドキュメントから見直させる（設計§14）。
///
/// # なぜパーサの修復と別の流れなのか
///
/// 直す対象も、壊れているかの判断も、ゲートも違う。パーサは「テストが落ちている」
/// という**明確な故障**から始まるが、こちらは「CLI が上がったので古いかもしれない」
/// という**疑い**から始まる。落ちているものが無いので、カナリアも再試行も要らない。
///
/// 1回で済ませ、通らなければ何もしなかったことにする。
///
/// # 公開しているのはテストのため
///
/// 本番の契機は [`Selfheal::start`] の中にしかない（CLI の版が上がったとき）。
/// 擬似 claude は `--version` を答えないので版が空になり、テストからはその契機を
/// 踏めない。**流れを一度も通さないまま出荷したのが B-1 の教訓**なので、
/// ここを直接呼べるようにして棄却と採用の分岐をテストで固定する。
pub async fn review_model_table(selfheal: Arc<Selfheal>, cli_version: String) {
    let Some(ops) = selfheal.ops.clone() else {
        return;
    };
    // パーサの修復と同時に走らせない。worktree もセッションも取り合う
    if selfheal
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    // **成否によらず、この版では二度と起こさない。** 同じ版で繰り返しても結果は同じで、
    // 無人セッションを撃ち続けることになる
    model_table::mark_reviewed(&selfheal.state_dir, &cli_version);

    let observed: Vec<String> = selfheal
        .manager
        .aliases()
        .all()
        .into_iter()
        .map(|entry| entry.alias.0)
        .collect();

    selfheal.notify(
        SelfhealPhase::Repairing,
        Some(format!(
            "CLI が {cli_version} に上がったので、モデル別名の表を見直します"
        )),
    );

    let outcome = run_model_review(&selfheal, &ops, &cli_version, &observed).await;
    match outcome {
        Ok(true) => selfheal.notify(
            SelfhealPhase::Swapped,
            Some("モデル別名の表を更新しました".to_string()),
        ),
        Ok(false) => selfheal.notify(
            SelfhealPhase::Passed,
            Some("モデル別名の表は最新でした".to_string()),
        ),
        Err(error) => {
            tracing::warn!("モデル別名の表を見直せませんでした: {error:#}");
            selfheal.notify(
                SelfhealPhase::Failed,
                Some(format!("モデル別名の表を見直せませんでした: {error}")),
            );
        }
    }
    selfheal.busy.store(false, Ordering::SeqCst);
}

/// 見直しの本体。変更を採用したら `Ok(true)`。
async fn run_model_review(
    selfheal: &Arc<Selfheal>,
    ops: &Arc<dyn SelfhealOps>,
    cli_version: &str,
    observed: &[String],
) -> anyhow::Result<bool> {
    let branch = format!("{MAINTENANCE_NAME}-models");
    let worktree = {
        let branch = branch.clone();
        blocking(ops, move |ops| ops.prepare_worktree(&branch)).await?
    };

    // **門はこちらにも要る**（設計§18-10）。パーサ側は「付け替え＋門2枚」なのに、
    // ここだけ付け替えだけだった。あちらが書き換えるのは `web/src/lib/models.ts` の
    // 1ファイルなので、古い木から作ると**3週間前の表を「最新」として採用する**——
    // **症状が静かなぶん、こちらのほうが気づきにくい**
    let baseline = blocking(ops, |ops| ops.repo_head()).await?;
    let current = {
        let worktree = worktree.clone();
        let baseline = baseline.clone();
        blocking(ops, move |ops| ops.worktree_contains(&worktree, &baseline)).await?
    };
    if !current {
        anyhow::bail!(
            "見直しの作業場所が本体に追いついていません。\
             古い木から作ると、3週間前の表を「最新」として採用することになります"
        );
    }

    let card = start_repair_session(selfheal, &worktree).await.ok();
    let Some(card_id) = card else {
        anyhow::bail!("見直しセッションを起動できませんでした");
    };

    let answered = send_and_wait(
        selfheal,
        card_id,
        &model_table::review_prompt(cli_version, observed),
    )
    .await;
    close_session(selfheal, card);
    if !answered {
        anyhow::bail!("見直しセッションが応答しませんでした");
    }

    let changed = {
        let worktree = worktree.clone();
        blocking(ops, move |ops| ops.changed_files(&worktree)).await?
    };
    if changed.is_empty() {
        // 変える必要が無かった。これは失敗ではない
        return Ok(false);
    }

    // **言葉ではなく機械で見る。** 触った範囲と表の形の両方を確かめる
    let violations = model_table::scope_violations(&changed);
    if !violations.is_empty() {
        discard(ops, &worktree).await;
        anyhow::bail!("範囲外を変更しました: {}", violations.join(", "));
    }
    let source = match std::fs::read_to_string(worktree.join(model_table::TABLE_PATH)) {
        Ok(source) => source,
        // 表ごと消された場合もここへ来る。読めないまま帰ると変更が残る
        Err(error) => {
            discard(ops, &worktree).await;
            anyhow::bail!("表を読めません: {error}");
        }
    };
    let problems = model_table::table_violations(&source, observed);
    if !problems.is_empty() {
        discard(ops, &worktree).await;
        anyhow::bail!("表の形が壊れています: {}", problems.join(", "));
    }

    let gate = {
        let worktree = worktree.clone();
        blocking(ops, move |ops| Ok(ops.run_web_gate(&worktree))).await?
    };
    if !gate.passed {
        tracing::warn!("画面側のゲートの出力: {}", gate.output);
        discard(ops, &worktree).await;
        anyhow::bail!("画面側のゲートが通りませんでした");
    }

    commit(
        ops,
        &worktree,
        &format!("chore(web): モデル別名の表を CLI {cli_version} に合わせる"),
    )
    .await;
    Ok(true)
}

/// 採用しない変更を捨てて、worktree を HEAD の状態へ戻す。
///
/// **採用しないと決めたら必ずここを通る。** 以前はここが「表のファイルを消す」だったが、
/// それでは戻したことにならない——**範囲外を触られていた場合、そちらが残る**。
/// 触ってよい範囲を1ファイルに限っているのは検査を簡単にするためであって、
/// 相手が守った前提で後始末を書いてよい理由にはならない。
///
/// 戻せなくても致命ではない（次の `prepare_worktree` が作り直す）ので、
/// ここで流れは止めずに警告だけ残す。
async fn discard(ops: &Arc<dyn SelfhealOps>, worktree: &Path) {
    let target = worktree.to_path_buf();
    if let Err(error) = blocking(ops, move |ops| ops.discard_changes(&target)).await {
        tracing::warn!(
            worktree = %worktree.display(),
            "採用しなかった変更を戻せませんでした: {error:#}"
        );
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
    args.push("--model".to_string());
    args.push(selfheal.config.repair_model.clone());

    let session = selfheal
        .manager
        .spawn_with_args(&worktree.to_string_lossy(), &args)?;
    let card_id = session.meta().card_id;

    // 起動直後に入力待ちへ入らない場合、フォルダ信頼の確認のような確定待ちの画面で
    // 止まっている可能性がある。状態を見たうえで1回だけ確定を送る
    if !wait_ready(selfheal, &session, card_id).await {
        anyhow::bail!("修復セッションが指示を受け付ける状態になりませんでした");
    }
    // フックが「入力待ち」を告げても、TUI がまだ描画中のことがある。そこへ貼り付けを
    // 流し込むと、括弧付き貼り付けの合図がただの文字として解釈され、**指示が送られない
    // まま静かに終わる**（実測。画面には出ているのに会話が始まらない）
    wait_until_settled(&session).await;
    Ok(card_id)
}

/// 端末の描画が落ち着くまで待つ。
///
/// 出力が増えなくなったら落ち着いたとみなす。判断を長さで行うのは、内容を毎回
/// 文字列へ起こすとスクロールバックを何度も複製することになるため。
async fn wait_until_settled(session: &Arc<crate::session::Session>) {
    const QUIET: Duration = Duration::from_secs(2);
    const CAP: Duration = Duration::from_secs(30);
    const STEP: Duration = Duration::from_millis(250);

    let deadline = tokio::time::Instant::now() + CAP;
    let mut last = session.scrollback_len();
    let mut quiet_since = tokio::time::Instant::now();

    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(STEP).await;
        let now = session.scrollback_len();
        if now != last {
            last = now;
            quiet_since = tokio::time::Instant::now();
        } else if quiet_since.elapsed() >= QUIET {
            return;
        }
    }
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
            // `WaitingSubagents`（設計§14）もここへ落ちて待ち続ける。**これでよい**——
            // サブが終われば `WaitingInput` になるので、待っていれば必ず捕まる
            _ => {}
        }

        if !answered_trust {
            // **空白を当てにしない。** TUI は語ごとに別々に書き、間をカーソル移動で埋めるので、
            // 生のバイト列では `trust this folder` が `trustthisfolder` になる
            // （PJTガイドライン「端末の表示を読んで判断するとき」）。
            // ここを素の contains で見ていたせいで、確認が出ている実機で
            // 180秒待って落ちていた。**開発環境では既に信頼済みで確認が出ず、気づけなかった**
            let screen = crate::session::permission::squeeze(
                &crate::session::permission::strip_ansi(&session.scrollback_tail(TRUST_TAIL)),
            )
            .to_lowercase();
            if TRUST_PROMPT_MARKERS.iter().any(|marker| {
                screen.contains(&crate::session::permission::squeeze(marker).to_lowercase())
            }) {
                tracing::info!(
                    card_id = %session.card_id,
                    "修復セッションのフォルダ信頼の確認に答えます"
                );
                // 設計§10-3 の表には無いが**同じ性質**。無人の修復セッションが確認に
                // 答えられずに落ちる事故を実測しているので、ここも声を持たせる
                session.send_key(b"\r", "フォルダ信頼の確認への回答");
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
    if session.send_instruction(message).await.is_err() {
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
            // `WaitingSubagents` は待ち続ける（上の `wait_ready` と同じ理由）
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
            if let Err(err) = std::fs::create_dir_all(state_dir) {
                tracing::warn!(
                    dir = %state_dir.display(),
                    %err,
                    "パーサのポインタの置き場所を作れません"
                );
            }
            if let Err(err) = std::fs::write(&pointer, path.to_string_lossy().as_bytes()) {
                tracing::warn!(
                    pointer = %pointer.display(),
                    target = %path.display(),
                    %err,
                    "パーサのポインタを書けません。修復しても古いパーサを使い続けます"
                );
            }
        }
        None => {
            // 版のポインタ（`crate::version::write_pointer`）と同じ扱い。
            // **もともと無いのは正常**なので、そこでは黙る
            if let Err(err) = std::fs::remove_file(&pointer)
                && err.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(
                    pointer = %pointer.display(),
                    %err,
                    "パーサのポインタを消せません。差し替えたパーサを使い続けます"
                );
            }
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

    /// パーサのポインタも声を持つこと（設計§10-3）。
    ///
    /// 版のポインタ（`crate::version`）と**同じ形**にしてある。片方だけ腐らないよう、
    /// 台帳（設計§10-5）でも対にして持つ。
    mod ポインタが声を持つ {
        use super::*;
        use crate::logging::capture;

        fn 行(mark: usize, 含む: &str) -> Vec<serde_json::Value> {
            capture::sink()
                .since(mark)
                .into_iter()
                .filter(|line| {
                    line.get("msg")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|msg| msg.contains(含む))
                })
                .collect()
        }

        #[test]
        fn 書けないときは理由が残る() {
            let blocked = temp_dir("parser-pointer-blocked").join("塞ぎ");
            std::fs::write(&blocked, "邪魔").unwrap();

            let sink = capture::sink();
            let mark = sink.mark();
            write_pointer(&blocked, Some(Path::new("/bin/true")));

            assert_eq!(行(mark, "パーサのポインタの置き場所を作れません").len(), 1);
            let 書けない = 行(mark, "パーサのポインタを書けません");
            assert_eq!(書けない.len(), 1, "{書けない:#?}");
            assert_eq!(書けない[0]["level"], "WARN");
        }

        #[test]
        fn もともと無いときは黙る() {
            let dir = temp_dir("parser-pointer-absent");
            let sink = capture::sink();
            let mark = sink.mark();
            write_pointer(&dir, None);
            assert!(行(mark, "パーサのポインタを消せません").is_empty());
        }

        #[test]
        fn 消せないときは理由が残る() {
            let dir = temp_dir("parser-pointer-undeletable");
            std::fs::create_dir_all(dir.join(crate::parser::PARSER_POINTER)).unwrap();

            let sink = capture::sink();
            let mark = sink.mark();
            write_pointer(&dir, None);

            assert_eq!(行(mark, "パーサのポインタを消せません").len(), 1);
        }
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

#[cfg(test)]
mod trust_tests {
    #![allow(non_snake_case)]

    use super::TRUST_PROMPT_MARKERS;
    use crate::session::permission::{squeeze, strip_ansi};

    /// `wait_ready` が行っている照合と同じ手順。
    fn matches(raw: &str) -> bool {
        let screen = squeeze(&strip_ansi(raw)).to_lowercase();
        TRUST_PROMPT_MARKERS
            .iter()
            .any(|marker| screen.contains(&squeeze(marker).to_lowercase()))
    }

    #[test]
    fn 実機に出た信頼の確認を見分けられる() {
        // 実機のダッシュボードで実際に止まっていた画面
        let screen = "\
Quick safety check: Is this a project you created or one you trust?
❯ 1. Yes, I trust this folder
  2. No, exit
Enter to confirm · Esc to cancel";
        assert!(matches(screen));
    }

    #[test]
    fn 語間の空白が消えていても見分けられる() {
        // **これができていなかった。** TUI は語ごとに別々に書くので、生のバイト列では
        // 空白が落ちる。素の contains で見ていたせいで実機で 180 秒待って落ちた
        assert!(matches("Yes,Itrustthisfolder"));
        assert!(matches("\u{1b}[32mDo you\u{1b}[0m trust this folder?"));
    }

    #[test]
    fn 関係のない画面は信頼の確認と間違えない() {
        assert!(!matches(""));
        assert!(!matches("⏵⏵ accept edits on\n> 何かしますか"));
    }
}
