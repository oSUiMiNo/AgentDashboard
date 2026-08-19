//! transcript-parser プロセスの起動・監視・差し替え（設計§8/§9）。
//!
//! # なぜ別プロセスなのか
//!
//! 自己修復（設計§9）は「フォーマットが変わったら修復セッションがパーサを直し、テストに
//! 通ったらパーサだけ差し替える」という仕組みで、これが成立するには**直す対象**と
//! **動き続けなければならないもの**（PTY 上の生きたセッション）がプロセスとして
//! 分かれている必要がある。パーサが落ちてもターミナルと状態表示は無傷、というのが
//! 縮退の仕様（設計§11）でもある。
//!
//! # 再開位置はセッションホストが持つ。ただし進めるのは運び手
//!
//! パーサを差し替えても履歴が欠けないよう、どこまで読んだかはセッションホスト側で
//! 永続化する（[`crate::offsets::OffsetStore`]）。ここが読むのは**監視を頼むとき**だけで、
//! 進めるのは報告の運び手——**記録に入ったことを確かめてから**（セルフホスト化設計§6-1）。
//!
//! フェーズ2 までは「配った直後」に書いていた。配る先がメモリの窓だったころはそれで
//! 足りたが、記録が DB になり、さらにネットワークを跨ぐようになると「配った」と
//! 「残った」の間が開く。その間に落ちるとノードが静かに消えるので、条件を揃えた。
//! **欠落より重複を選ぶ**という原則そのものは変わっていない。

use crate::config::SessionHostConfig;
use crate::offsets::OffsetStore;
use crate::session::SessionManager;
use protocol::CardId;
use protocol::ipc::{PROTOCOL_VERSION, ParserCommand, ParserEvent};
use protocol::ws::{ParserState, ServerMessage};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// パーサ実行ファイルを差し替えるための環境変数。
///
/// 既定は `current_exe()` の隣。統合テストでは core が**ライブラリとして**動くため
/// `current_exe()` がテストバイナリを指してしまうので、この入口が要る
/// （フックの [`crate::session::hooks_settings::HOOK_BIN_ENV`] と同じ理由）。
pub const PARSER_BIN_ENV: &str = "AGENTDASHBOARD_PARSER_BIN";

/// 再起動の待ち時間。落ち続けるパーサで CPU を焼かないよう、上限まで伸ばす。
const RESTART_BACKOFF_MS: [u64; 5] = [200, 500, 1_000, 2_000, 5_000];

/// 指示の待ち行列。
const REQUEST_QUEUE: usize = 256;

/// SessionManager からパーサへ出す依頼。
///
/// 再開位置は supervisor 側が持っているので、依頼側は知らなくてよい。
#[derive(Debug, Clone)]
pub enum ParserRequest {
    Watch { card_id: CardId, path: String },
    Unwatch { card_id: CardId },
}

/// SessionManager が持つ、パーサへの細い口。
///
/// 逆参照（パーサ側から SessionManager）は持たせない。フックの処理は同期関数なので、
/// 送信は `try_send`（待たない）にしてある。ダッシュボードの都合でフックの処理が
/// 止まることがあってはならない。
#[derive(Debug, Clone)]
pub struct ParserHandle {
    requests: mpsc::Sender<ParserRequest>,
}

impl ParserHandle {
    pub fn watch(&self, card_id: CardId, path: String) {
        if let Err(err) = self
            .requests
            .try_send(ParserRequest::Watch { card_id, path })
        {
            undelivered(card_id, "監視", &err);
        }
    }

    pub fn unwatch(&self, card_id: CardId) {
        if let Err(err) = self.requests.try_send(ParserRequest::Unwatch { card_id }) {
            undelivered(card_id, "監視の解除", &err);
        }
    }
}

/// 世話役へ渡せなかったことを告げる。**満杯と畳み済みを言い分ける。**
///
/// 畳み済みは正常で、core が終わりかけているだけ。**満杯だけが未解明事象1 の候補**に
/// なる——落ちた Watch は、そのカードの構造化ビューを永久に空のまま残す。一覧も
/// ターミナルも動くので、利用者からは原因が見えない。
///
/// 同じ文言で出すと、この2つを後から区別できない。区別が付かない行は、
/// 追う側にとって無いのと変わらない。
fn undelivered(card_id: CardId, what: &str, err: &mpsc::error::TrySendError<ParserRequest>) {
    match err {
        mpsc::error::TrySendError::Full(_) => tracing::warn!(
            %card_id,
            queue = REQUEST_QUEUE,
            "パーサの待ち行列が満杯で{what}を頼めません。この指示は消えました"
        ),
        mpsc::error::TrySendError::Closed(_) => tracing::debug!(
            %card_id,
            "パーサの世話役が畳まれているため{what}を頼めません"
        ),
    }
}

/// パーサ子プロセスの世話役。
pub struct ParserSupervisor {
    manager: Arc<SessionManager>,
    config: Arc<SessionHostConfig>,
    /// 再開位置。**読むのはここ、進めるのは運び手**（設計§6-1）
    offsets: Arc<OffsetStore>,
    requests: mpsc::Sender<ParserRequest>,
    state: Arc<Mutex<ParserState>>,
    /// 差し替え後に立て直しを頼む口（設計§9）
    restarts: mpsc::Sender<()>,
    /// stats の届け先。自己修復が居るときだけ差し込まれる
    stats_sink: Mutex<Option<mpsc::Sender<StatsReport>>>,
    /// 「載っているものが悪い」ことの届け先（設計§6-1）。
    ///
    /// **戻す道は1本**にしてある。ここへ渡した先で、既にある `rollback()` が
    /// 「ポインタを戻す・間を置く・立て直す・画面へ知らせる」を1組で行う。
    trouble_sink: Mutex<Option<mpsc::Sender<ParserTrouble>>>,
}

/// 載っているパーサそのものが悪い、と分かったときの知らせ（設計§6・§8）。
///
/// **出どころがポインタのときだけ流れる。** 同梱版や環境変数で名指ししたものには
/// 戻す先が無いので、世話役がその場で縮退にする。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParserTrouble {
    /// 資源を食い続けている（設計§5）
    Runaway {
        pid: Option<u32>,
        rss_bytes: u64,
        reads_per_sec: u64,
        growth_per_min: i64,
    },
    /// 短い間に何度も落ちている（設計§8-2）
    CrashLoop { times: usize, within: Duration },
    /// 本体と違う版を名乗った＝**古い木から作られている**（設計§4-2）
    VersionMismatch { parser_version: String },
}

/// パーサが報告してきた健康状態を、自己修復へ渡すときの形。
///
/// `ParserEvent` をそのまま渡さないのは、受け手が IPC の型に依存しないようにするため。
#[derive(Debug, Clone)]
pub struct StatsReport {
    pub card_id: CardId,
    pub records_total: u64,
    pub parse_errors: u64,
    pub unknown_types: BTreeMap<String, u64>,
    pub orphans: u64,
    pub versions: std::collections::BTreeSet<String>,
}

impl ParserSupervisor {
    /// パーサを起動し、世話をする常駐タスクを立てる。
    ///
    /// 再開位置の置き場所は**外から渡す**。読むのはここだが進めるのは報告の運び手なので、
    /// 2人が同じ置き場所を見る必要がある（設計§6-1）。
    pub fn start(
        manager: Arc<SessionManager>,
        config: Arc<SessionHostConfig>,
        offsets: Arc<OffsetStore>,
    ) -> Arc<Self> {
        let (requests, request_rx) = mpsc::channel(REQUEST_QUEUE);
        // 立て直しの依頼は溜める意味が無い（1回入っていれば十分）
        let (restarts, restart_rx) = mpsc::channel(1);

        let supervisor = Arc::new(Self {
            manager: Arc::clone(&manager),
            config: Arc::clone(&config),
            offsets,
            requests,
            state: Arc::new(Mutex::new(ParserState::Ok)),
            restarts,
            stats_sink: Mutex::new(None),
            trouble_sink: Mutex::new(None),
        });

        tokio::spawn(run(Arc::clone(&supervisor), request_rx, restart_rx));
        supervisor
    }

    /// 健康状態の届け先を差し込む（自己修復が起動したときに呼ばれる）。
    pub fn attach_stats_sink(&self, sink: mpsc::Sender<StatsReport>) {
        *self.stats_sink.lock().expect("ロックが壊れていない") = Some(sink);
    }

    /// 「載っているものが悪い」ことの届け先を差し込む（設計§6-1）。
    pub fn attach_trouble_sink(&self, sink: mpsc::Sender<ParserTrouble>) {
        *self.trouble_sink.lock().expect("ロックが壊れていない") = Some(sink);
    }

    /// 戻す側へ知らせる。**受け手が居なければ偽**——そのときは世話役が自分で畳む。
    ///
    /// # なぜ公開しているか
    ///
    /// 暴走の契機は**8GB 食う個体を用意しないと踏めない**。踏めない経路を確かめない
    /// 理由にはしない、というのがこのリポジトリの決まりなので、入口を開けて検査から
    /// 直接呼べるようにしてある（ガイドライン「通していない経路は『動く』と書いては
    /// いけない」）。**判定そのものは [`RunawayWatch`] 側**にあり、こちらは運ぶだけ。
    pub fn report_trouble(&self, trouble: ParserTrouble) -> bool {
        let sink = self
            .trouble_sink
            .lock()
            .expect("ロックが壊れていない")
            .clone();
        match sink {
            // 溢れたら捨てる。同じ知らせを積んでも、戻す回数が増えるだけ
            Some(sink) => sink.try_send(trouble).is_ok(),
            None => false,
        }
    }

    /// 構造化ビューを縮退として宣言する（設計§9-6 の縮退モード）。
    ///
    /// パーサのプロセス自体は動いているのに**中身を正しく読めていない**という状態が
    /// あるため、プロセスの生死とは別に外から落とせる口が要る。自動修復に失敗した
    /// ときがそれで、履歴の表示を信じてよいかどうかは利用者に伝えなければならない。
    /// ターミナルと指示送信には影響しない。
    pub fn degrade(&self, detail: String) {
        self.set_state(ParserState::Degraded, Some(detail));
    }

    /// パーサを立て直す（差し替えたバイナリを使わせる）。
    ///
    /// 再開位置は core が持っているので、立て直しても履歴は欠けない。落ちたときの
    /// 立て直しと同じ道を通るので、監視中のカードは自動で登録し直される。
    pub fn restart(&self) {
        let _ = self.restarts.try_send(());
    }

    pub fn handle(&self) -> ParserHandle {
        ParserHandle {
            requests: self.requests.clone(),
        }
    }

    pub fn state(&self) -> ParserState {
        *self.state.lock().expect("ロックが壊れていない")
    }

    fn set_state(&self, next: ParserState, detail: Option<String>) {
        let mut state = self.state.lock().expect("ロックが壊れていない");
        if *state == next {
            return;
        }
        *state = next;
        drop(state);
        self.manager.broadcast(ServerMessage::ParserStatus {
            state: next,
            detail,
        });
    }
}

/// 自己修復が差し替えたパーサを指すポインタファイルの名前（[`SessionHostConfig::resolved_state_dir`] 配下）。
///
/// 中身は実行ファイルの絶対パス1行。symlink ではなくファイルにしてあるのは、
/// 「いま何を使っているか」を人が開いて確かめられるようにするため。
pub const PARSER_POINTER: &str = "parser-current";

/// いま動いているパーサが、どこから来たか（設計§4-3）。
///
/// 版が食い違ったとき・暴走したとき・落ち続けたときに、**ポインタを外してよいかどうか**が
/// これで決まる。3箇所が同じことを別々に推測しないよう、決めた場所から1つの値として運ぶ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParserOrigin {
    /// 環境変数で名指しされた。テストと実験の経路——**版が違っても利用者が意図している**
    Env,
    /// 自己修復が差し替えた（`parser-current` が指している）。**外せる唯一の出どころ**
    Pointer,
    /// 実行ファイルの隣（＝同梱版）
    Sibling,
    /// PATH 任せ
    Path,
}

impl ParserOrigin {
    /// ポインタを外して同梱版へ戻せるか。
    pub fn can_roll_back(self) -> bool {
        matches!(self, ParserOrigin::Pointer)
    }

    /// ログの欄に載せる短い名前。
    pub fn label(self) -> &'static str {
        match self {
            ParserOrigin::Env => "env",
            ParserOrigin::Pointer => "pointer",
            ParserOrigin::Sibling => "sibling",
            ParserOrigin::Path => "path",
        }
    }
}

/// パーサ実行ファイルの場所と、その出どころを決める。
///
/// 探索順は **環境変数 → ポインタ → 実行ファイルの隣 → PATH**。
///
/// - 環境変数が先頭なのは、テストがビルド済みのパーサを名指しできるようにするため
/// - ポインタが隣より先なのは、自己修復が差し替えた新しいパーサを使わせるため。
///   ポインタの指す先が消えていたら既定へ戻る（起動できなくなるほうが困る）。
///   **そのとき出どころは `Pointer` にしない**——外す必要の無いポインタを外さないため
pub fn parser_program(config: &SessionHostConfig) -> (PathBuf, ParserOrigin) {
    if let Ok(path) = std::env::var(PARSER_BIN_ENV) {
        return (PathBuf::from(path), ParserOrigin::Env);
    }
    if let Ok(text) = std::fs::read_to_string(config.resolved_state_dir().join(PARSER_POINTER)) {
        let path = PathBuf::from(text.trim());
        if path.is_file() {
            return (path, ParserOrigin::Pointer);
        }
        tracing::warn!(
            "差し替え済みのパーサが見つかりません（既定に戻します）: {}",
            path.display()
        );
    }
    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            let sibling = dir.join("transcript-parser");
            if sibling.is_file() {
                return (sibling, ParserOrigin::Sibling);
            }
        }
    }
    (PathBuf::from("transcript-parser"), ParserOrigin::Path)
}

/// 資源の見張りの標本を採る間隔（設計§5-3）。
const RUNAWAY_SAMPLE_EVERY: Duration = Duration::from_secs(10);

/// `read` の線（回/秒）。
///
/// **単独では健全なパーサも越える**（書き手が速いと実測 140,793回/秒）。それでも低いまま
/// にしてあるのは、AND のもう片方（メモリの増え方）が効くうえ、**見落とすと機械が落ちる**側
/// だから。緩く持って、続くかどうかで決める（設計§16-1）。
const RUNAWAY_READS_PER_SEC: u64 = 50_000;

/// メモリの増え方の線（バイト/分）。こちらも単独では健全な追いつきが越える。
const RUNAWAY_GROWTH_PER_MIN: i64 = 100 * 1024 * 1024;

/// 何回続いたら暴走とみなすか（設計§16-1。実測で 3回から改めた）。
///
/// 健全な追いつきも1窓は**両方の線を越える**。分けているのは「続くかどうか」だけで、
/// 追いつきの増え方は**ファイルの長さで頭打ちになる**のに対し、暴走は頭打ちにならない。
/// 6回 × 10秒 ＝ 60秒で、線どおりなら 100MB の増加が要る——実測した最大の履歴（64MB）の
/// 追いつきでも RSS の増加は 46MB で、続けようがない。
const RUNAWAY_STREAK: u32 = 6;

/// パーサ1個体から採った、その瞬間の値。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceSample {
    pub rss_bytes: u64,
    /// `read` の**累計**回数。単調増加する
    pub reads: u64,
}

/// 暴走とみなしたときの実測値。**そのままログの欄になる**（設計§6-4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Runaway {
    pub rss_bytes: u64,
    pub reads_per_sec: u64,
    pub growth_per_min: i64,
}

/// 暴走の判定（設計§5-5）。
///
/// **`/proc` を読む側とは分けてある。** 分けないと、8GB 食う個体を用意しないと確かめられない。
#[derive(Debug, Default)]
pub struct RunawayWatch {
    previous: Option<ResourceSample>,
    streak: u32,
}

impl RunawayWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// 標本を1つ与えて、暴走と判定できたかを返す。
    ///
    /// `sample` が `None` は「測れなかった」。**0 として扱わない**——0 と読むと
    /// 「増えていない」に化けて、暴走を見落とす（設計§5-4）。
    pub fn observe(
        &mut self,
        sample: Option<ResourceSample>,
        elapsed: Duration,
    ) -> Option<Runaway> {
        let Some(sample) = sample else {
            // 測れなかった窓は、前後を繋げない。跨いで差分を取ると別物の引き算になる
            self.previous = None;
            self.streak = 0;
            return None;
        };
        let millis = elapsed.as_millis().max(1) as u64;
        // 1本目は物差しになるだけ（差分が取れない）
        let previous = self.previous.replace(sample)?;
        // 累計が減った＝別の個体になった。差分を取ってはいけない
        if sample.reads < previous.reads {
            self.streak = 0;
            return None;
        }

        let reads_per_sec = (sample.reads - previous.reads) * 1_000 / millis;
        let growth_per_min =
            (sample.rss_bytes as i64 - previous.rss_bytes as i64) * 60_000 / millis as i64;

        // **両方が線を越えたときだけ数える。** 片方は健全なパーサでも越える
        if reads_per_sec < RUNAWAY_READS_PER_SEC || growth_per_min < RUNAWAY_GROWTH_PER_MIN {
            self.streak = 0;
            return None;
        }

        self.streak += 1;
        if self.streak < RUNAWAY_STREAK {
            return None;
        }
        // 鳴らしたら数え直す。この後は立て直しへ進むので、同じ個体で二度鳴らす意味が無い
        self.streak = 0;
        Some(Runaway {
            rss_bytes: sample.rss_bytes,
            reads_per_sec,
            growth_per_min,
        })
    }

    /// 個体が変わったので、いままでの標本を捨てる。
    pub fn reset(&mut self) {
        self.previous = None;
        self.streak = 0;
    }
}

/// `/proc` からその pid の標本を採る。**読めなければ `None`。**
///
/// `/proc` を持たない環境では見張りが黙って止まる。パーサの `orphaned()` が
/// 「親が分からない環境ではこの見張りを無効にする」としているのと同じ作法で、
/// **動かないことを異常にしない**（設計§5-4）。
fn sample_process(pid: u32) -> Option<ResourceSample> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let rss_kb: u64 = status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .and_then(|value| value.trim().trim_end_matches(" kB").trim().parse().ok())?;
    let io = std::fs::read_to_string(format!("/proc/{pid}/io")).ok()?;
    let reads: u64 = io
        .lines()
        .find_map(|line| line.strip_prefix("syscr:"))
        .and_then(|value| value.trim().parse().ok())?;
    Some(ResourceSample {
        rss_bytes: rss_kb * 1024,
        reads,
    })
}

/// 常駐タスク。パーサが落ちたら間を置いて立て直し、監視中のカードを全部登録し直す。
async fn run(
    supervisor: Arc<ParserSupervisor>,
    mut requests: mpsc::Receiver<ParserRequest>,
    mut restarts: mpsc::Receiver<()>,
) {
    // カード → 本体トランスクリプトのパス。再起動のたびに登録し直すために持つ
    let mut watched: HashMap<CardId, String> = HashMap::new();
    let mut attempt = 0usize;
    // 落ち続けの数え方（設計§8-2）。**実行ファイルが変わったら数え直す**——
    // 前の個体が落ちたことは、いまの個体の証明にならない
    let mut crashes: CrashLog<std::time::Instant> = CrashLog::new();
    let mut last_program: Option<PathBuf> = None;

    loop {
        let (program, origin) = parser_program(&supervisor.config);
        if last_program.as_ref() != Some(&program) {
            crashes.reset();
            last_program = Some(program.clone());
        }

        match spawn_parser(&program).await {
            Ok(child) => {
                attempt = 0;
                // **どの起動の子か**をここで残す。Hello の行だけでは pid が分からず、
                // 孤児が出たとき（未解明事象2）に「誰が置き去りにされたか」を
                // 後から名指しできない。ファイル名の pid（親）と行の `run_id` に、
                // この番号が加わって初めて親子の対応が付く。
                //
                // **数として載せる**（`?` の Debug ではなく）。読むのは人だけでなく、
                // 置き去りにされた子を突き合わせる側でもある
                match child.id() {
                    Some(parser_pid) => {
                        tracing::info!(parser_pid, "transcript-parser を起こしました");
                    }
                    // 起こした直後に取れないのは、刈り取られた後だけ。**起きないはずだが
                    // 黙らない**——ここが取れないと、その子は孤児になっても辿れない
                    None => tracing::warn!(
                        "transcript-parser を起こしましたが pid を取れません（孤児になっても辿れません）"
                    ),
                }
                supervisor.set_state(ParserState::Ok, None);
                let reason = pump(
                    &supervisor,
                    child,
                    &mut requests,
                    &mut restarts,
                    &mut watched,
                    origin,
                )
                .await;
                match reason {
                    PumpEnd::Shutdown => return,
                    // 差し替えによる立て直しは異常ではないので、縮退にも待ちにも入らない
                    PumpEnd::Restart => continue,
                    // 戻す先が無い個体が暴走した。**立て直さない**——同じものを起こし直せば
                    // また食い始める。機械を守るほうを採り、構造化ビューは縮退のまま置く
                    PumpEnd::Runaway => return,
                    PumpEnd::ParserGone => {
                        supervisor.set_state(
                            ParserState::Degraded,
                            Some("パーサが終了しました。立て直しています".to_string()),
                        );
                        if origin.can_roll_back() {
                            let 見切る = crashes.record(std::time::Instant::now(), |now, at| {
                                now.duration_since(at)
                            });
                            if 見切る {
                                let times = CRASH_LIMIT;
                                tracing::warn!(
                                    origin = origin.label(),
                                    times,
                                    within_secs = CRASH_WINDOW.as_secs(),
                                    "差し替えたパーサが落ち続けています。同梱のパーサへ戻します"
                                );
                                supervisor.report_trouble(ParserTrouble::CrashLoop {
                                    times,
                                    within: CRASH_WINDOW,
                                });
                            }
                        }
                    }
                }
            }
            Err(error) => {
                supervisor.set_state(
                    ParserState::Degraded,
                    Some(format!("パーサを起動できません: {error}")),
                );
            }
        }

        let wait = RESTART_BACKOFF_MS[attempt.min(RESTART_BACKOFF_MS.len() - 1)];
        attempt += 1;
        tokio::time::sleep(Duration::from_millis(wait)).await;
    }
}

/// 落ち続けを見る窓（設計§8-2）。
const CRASH_WINDOW: Duration = Duration::from_secs(5 * 60);
/// この回数だけ落ちたら、ポインタを外す。1回は事故でも起こり、2回は偶然が残る。
/// 3回続くのは**その実行ファイルの性質**である。
const CRASH_LIMIT: usize = 3;

/// 落ちた回数の数え方（設計§8-2）。
///
/// **時計を持たせず、外から渡す。** 5分待つ検査は書けないので、判定だけを切り離す。
#[derive(Debug, Default)]
pub struct CrashLog<T> {
    落ちた: Vec<T>,
}

impl<T: Copy> CrashLog<T> {
    pub fn new() -> Self {
        Self {
            落ちた: Vec::new()
        }
    }

    /// 1回落ちたことを記録し、**見切る回数に達したか**を返す。
    ///
    /// `age` は「その時刻から何秒経ったか」を返す関数。窓の外へ出たものは数えない。
    pub fn record(&mut self, now: T, age: impl Fn(T, T) -> Duration) -> bool {
        self.落ちた.retain(|at| age(now, *at) < CRASH_WINDOW);
        self.落ちた.push(now);
        if self.落ちた.len() < CRASH_LIMIT {
            return false;
        }
        // 見切ったら数え直す。**戻したあとの1回目の落ちで、また外そうとしない**
        self.落ちた.clear();
        true
    }

    /// 別の実行ファイルになったので、いままでの回数を捨てる。
    ///
    /// **前の個体が落ちたことは、いまの個体の証明にならない**（報告の記録を
    /// 立て直しのたびに空から始めているのと同じ考え方）。
    pub fn reset(&mut self) {
        self.落ちた.clear();
    }

    pub fn len(&self) -> usize {
        self.落ちた.len()
    }

    pub fn is_empty(&self) -> bool {
        self.落ちた.is_empty()
    }
}

enum PumpEnd {
    /// core 自体が終わる
    Shutdown,
    /// パーサが死んだので立て直す
    ParserGone,
    /// 自己修復が差し替えたので、こちらから立て直す
    Restart,
    /// 戻す先の無い個体が暴走したので畳んだ。**立て直さない**
    Runaway,
}

async fn spawn_parser(program: &Path) -> std::io::Result<tokio::process::Child> {
    tokio::process::Command::new(program)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // core が落ちたときにパーサだけ生き残らないようにする
        .kill_on_drop(true)
        .spawn()
}

async fn pump(
    supervisor: &Arc<ParserSupervisor>,
    mut child: tokio::process::Child,
    requests: &mut mpsc::Receiver<ParserRequest>,
    restarts: &mut mpsc::Receiver<()>,
    watched: &mut HashMap<CardId, String>,
    origin: ParserOrigin,
) -> PumpEnd {
    let Some(mut stdin) = child.stdin.take() else {
        return PumpEnd::ParserGone;
    };
    let Some(stdout) = child.stdout.take() else {
        return PumpEnd::ParserGone;
    };
    if let Some(stderr) = child.stderr.take() {
        // パーサのログは stderr にしか出さない約束。core のログへ合流させる
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match strip_pid(&line) {
                    Some((pid, rest)) => {
                        tracing::warn!(parser_pid = pid, "transcript-parser: {rest}");
                    }
                    None => tracing::warn!("transcript-parser: {line}"),
                }
            }
        });
    }

    let (events_tx, mut events) = mpsc::channel::<ParserEvent>(REQUEST_QUEUE);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            match serde_json::from_str::<ParserEvent>(&line) {
                Ok(event) => {
                    if events_tx.send(event).await.is_err() {
                        break;
                    }
                }
                // 知らないイベントで落ちない。パーサが新しくなっても core は動き続ける
                Err(error) => tracing::warn!("パーサの出力を解釈できません: {error}: {line}"),
            }
        }
    });

    // このパーサから1件でも報告が返ってきたカード。**「読まれた」の肯定側**（設計§10-3）。
    // 立て直しのたびに空から始める——前の個体が読めたことは、いまの個体の証明にならない
    let mut reported: std::collections::HashSet<CardId> = std::collections::HashSet::new();

    // 資源の見張り（設計§5）。**個体ごとに空から始める**
    let parser_pid = child.id();
    let mut watch = RunawayWatch::new();
    let mut ticker = tokio::time::interval(RUNAWAY_SAMPLE_EVERY);
    // 1回目は即座に返るので捨てる（窓の長さが 0 になる）
    ticker.tick().await;
    let mut sampled_at = std::time::Instant::now();

    // 立て直し後は、監視していたカードを保存済みの位置から登録し直す（無欠落再開）
    for (card_id, path) in watched.iter() {
        let command = watch_command(&supervisor.offsets, *card_id, path.clone());
        if let Err(err) = write_command(&mut stdin, &command).await {
            undelivered_to_child(child.id(), *card_id, "監視の登録し直し", &err);
            return PumpEnd::ParserGone;
        }
    }

    loop {
        tokio::select! {
            request = requests.recv() => match request {
                Some(ParserRequest::Watch { card_id, path }) => {
                    watched.insert(card_id, path.clone());
                    let command = watch_command(&supervisor.offsets, card_id, path);
                    if let Err(err) = write_command(&mut stdin, &command).await {
                        undelivered_to_child(child.id(), card_id, "監視の指示", &err);
                        return PumpEnd::ParserGone;
                    }
                }
                Some(ParserRequest::Unwatch { card_id }) => {
                    watched.remove(&card_id);
                    supervisor.offsets.forget(card_id);
                    if let Err(err) = write_command(&mut stdin, &ParserCommand::Unwatch { card_id }).await {
                        undelivered_to_child(child.id(), card_id, "監視の解除の指示", &err);
                        return PumpEnd::ParserGone;
                    }
                }
                // core が畳まれた
                None => {
                    if let Err(err) = write_command(&mut stdin, &ParserCommand::Shutdown).await {
                        // **孤児が生まれるのはここ**（未解明事象2。36分生き残った実測）。
                        // 停止指示が届かなかった相手の pid が出ることに全部が懸かっている
                        tracing::warn!(
                            parser_pid = ?child.id(),
                            watching = watched.len(),
                            %err,
                            "畳むときにパーサへ停止を指示できません。孤児が残る恐れがあります"
                        );
                    }
                    return PumpEnd::Shutdown;
                }
            },

            event = events.recv() => match event {
                Some(event) => handle_event(supervisor, event, watched, &mut reported, origin),
                // パーサの stdout が閉じた＝プロセスが終わった
                None => return PumpEnd::ParserGone,
            },

            restart = restarts.recv() => match restart {
                Some(()) => {
                    // 読みかけを畳ませてから落とす。応答を待たないのは、差し替えの目的が
                    // 「新しいバイナリに変わること」であって、綺麗に終わることではないため
                    //
                    // **`kill().await` より前に控える。** あれは子を刈り取るので、
                    // あとから `child.id()` を呼ぶと `None` になり、いちばん要る番号が消える
                    let parser_pid = child.id();
                    if let Err(err) = write_command(&mut stdin, &ParserCommand::Shutdown).await {
                        tracing::warn!(
                            parser_pid = ?parser_pid,
                            watching = watched.len(),
                            %err,
                            "差し替えのための停止指示がパーサへ届きません"
                        );
                    }
                    if let Err(err) = child.kill().await {
                        tracing::warn!(
                            parser_pid = ?parser_pid,
                            %err,
                            "差し替えのためのパーサ停止に失敗しました。古いパーサが生き残ります"
                        );
                    }
                    return PumpEnd::Restart;
                }
                None => return PumpEnd::Shutdown,
            },

            // 資源の見張り（設計§5）。**判定そのものは行を出さない**——10秒ごとに
            // 回る場所なので、越えた回だけ残す（設計§6-4）
            _ = ticker.tick() => {
                let now = std::time::Instant::now();
                let elapsed = now.duration_since(sampled_at);
                sampled_at = now;
                let sample = parser_pid.and_then(sample_process);
                let Some(runaway) = watch.observe(sample, elapsed) else {
                    continue;
                };
                tracing::warn!(
                    parser_pid = ?parser_pid,
                    rss_mb = runaway.rss_bytes / (1024 * 1024),
                    reads_per_sec = runaway.reads_per_sec,
                    growth_mb_per_min = runaway.growth_per_min / (1024 * 1024),
                    origin = origin.label(),
                    "パーサが資源を食い続けています（暴走とみなしました）"
                );

                // 戻す先があるなら、戻す側へ渡す。**ポインタを外してから立て直す**
                // 順序は向こうが持っている（設計§6-2・§8-1）
                if origin.can_roll_back()
                    && supervisor.report_trouble(ParserTrouble::Runaway {
                        pid: parser_pid,
                        rss_bytes: runaway.rss_bytes,
                        reads_per_sec: runaway.reads_per_sec,
                        growth_per_min: runaway.growth_per_min,
                    })
                {
                    continue;
                }

                // 戻す先が無い（同梱・環境変数・PATH）か、受け手が居ない。
                // **畳んで縮退にする。** 起こし直せばまた食い始めるので、立て直さない
                supervisor.degrade(format!(
                    "パーサが資源を食い続けているため畳みました\
                     （{}MB・毎秒 {} 回の read）。ターミナルと指示送信はそのまま使えます",
                    runaway.rss_bytes / (1024 * 1024),
                    runaway.reads_per_sec
                ));
                if let Err(err) = child.kill().await {
                    tracing::warn!(parser_pid = ?parser_pid, %err, "暴走したパーサを落とせません");
                }
                return PumpEnd::Runaway;
            }

            status = child.wait() => {
                tracing::warn!("transcript-parser が終了しました: {status:?}");
                return PumpEnd::ParserGone;
            }
        }
    }
}

fn watch_command(offsets: &OffsetStore, card_id: CardId, path: String) -> ParserCommand {
    let from_offsets = offsets.resume(card_id, &path);
    ParserCommand::Watch {
        card_id,
        path,
        from_offsets,
    }
}

async fn write_command(
    stdin: &mut tokio::process::ChildStdin,
    command: &ParserCommand,
) -> std::io::Result<()> {
    let mut line = serde_json::to_string(command).unwrap_or_default();
    line.push('\n');
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await
}

/// 子へ指示を渡せなかったことを告げる（設計§10-3。未解明事象1 の「届かなかったのか」）。
///
/// **ここが無言だと、3択のうち真ん中だけが読めない。** 「頼みました」の行は出ているのに
/// 何も起きない、という追いようのない沈黙になる。**流れは変えない**——渡せなかった時点で
/// 立て直しへ抜けるのは元のままで、抜けたことが見えるようになっただけ。
fn undelivered_to_child(
    parser_pid: Option<u32>,
    card_id: CardId,
    what: &str,
    err: &std::io::Error,
) {
    tracing::warn!(
        parser_pid = ?parser_pid,
        %card_id,
        %err,
        "パーサへ{what}を渡せません。この指示は届いていません"
    );
}

fn handle_event(
    supervisor: &Arc<ParserSupervisor>,
    event: ParserEvent,
    watched: &HashMap<CardId, String>,
    reported: &mut std::collections::HashSet<CardId>,
    origin: ParserOrigin,
) {
    match event {
        ParserEvent::Hello {
            protocol_version,
            parser_version,
        } => {
            if protocol_version != PROTOCOL_VERSION {
                // 噛み合わないバイナリを黙って使うと、静かに間違ったツリーが出る。
                // 目に見える縮退のほうがまだ良い
                supervisor.set_state(
                    ParserState::Degraded,
                    Some(format!(
                        "パーサの版が噛み合いません（core={PROTOCOL_VERSION} / parser={protocol_version}）"
                    )),
                );
            } else if origin.can_roll_back() && parser_version != env!("CARGO_PKG_VERSION") {
                // **古い木から作られたものが載っている**（設計§4-2）。`Hello` は初期実装から
                // 在るので、相手が新しい仕組みを何も持っていなくてもこの門は成立する——
                // 「相手が3週間前」の場面でこそ効かなければならない、という条件を満たす
                // 唯一の材料である。
                //
                // **環境変数で名指しした経路は巻き込まない。** そちらは版が食い違っても
                // 利用者が意図している
                tracing::warn!(
                    parser_version,
                    core_version = env!("CARGO_PKG_VERSION"),
                    origin = origin.label(),
                    "差し替えたパーサが本体と違う版を名乗りました。同梱のパーサへ戻します"
                );
                supervisor.report_trouble(ParserTrouble::VersionMismatch {
                    parser_version: parser_version.clone(),
                });
            } else {
                tracing::info!("transcript-parser {parser_version} と接続しました");
            }
        }

        ParserEvent::Nodes {
            card_id,
            source,
            nodes,
            next_offset,
        } => {
            // **窓へ書くのではなく、上へ報告する**（セルフホスト化設計§3-3）。
            // 履歴の持ち主はサーバ側の記録（DB）なので、こちらは読んだものと
            // 「入ったら進めてよい位置」を渡すだけ。セルフホストでは同じ報告が
            // A2S を渡って TranscriptBatch になる（§6-1）
            let Some(path) = watched.get(&card_id) else {
                // 監視していないカードの報告。位置の持ち主が決まらないので捨てる
                return;
            };
            // **「読まれた」の肯定側**（設計§10-3。未解明事象1 の3択の3番目）。
            //
            // 「届かなかった」と「読まれなかった」は、どちらも**何も起きない**という
            // 同じ見え方をする。頼んだ行と届かなかった行だけでは、届いたのに
            // 読まれていない状態を名指しできない。**最初の1件だけ**出すのは、
            // ノード単位で回る場所に行を置かない約束（設計§9-2）を守るため
            if reported.insert(card_id) {
                tracing::info!(
                    %card_id,
                    nodes = nodes.len(),
                    "パーサから最初の報告が届きました"
                );
            }
            supervisor
                .manager
                .report_transcript(card_id, path, &source, next_offset, &nodes);
        }

        ParserEvent::Reset { card_id } => {
            // 位置を忘れるのも**記録に入ってから**。ここで忘れると、消せなかった
            // ときに読み直す手掛かりまで失う
            supervisor.manager.report_transcript_reset(card_id);
        }

        // 過去範囲の読み直しは**もう頼まない**（セルフホスト化設計§3-3）。
        // 遡りの読み先が JSONL から DB へ変わったので、この応答は来ない。
        // `ipc.rs` は凍結境界（設計§4-4）なので、変種そのものは残っている
        ParserEvent::Range { .. } => {}

        ParserEvent::Stats {
            card_id,
            records_total,
            parse_errors,
            unknown_types,
            orphans,
            versions,
        } => {
            // 率の判定は core（自己修復）の仕事。ここは中継するだけで、
            // 届け先が居なければ何もしない（設計§9）
            if let Some(sink) = supervisor
                .stats_sink
                .lock()
                .expect("ロックが壊れていない")
                .as_ref()
            {
                // 溢れたら捨てる。健康状態は次の報告でも届くので、ここで待つ理由が無い
                let _ = sink.try_send(StatsReport {
                    card_id,
                    records_total,
                    parse_errors,
                    unknown_types,
                    orphans,
                    versions,
                });
            }
        }

        ParserEvent::Error {
            card_id, message, ..
        } => {
            // `card_id` は `Option`。指示に紐づかないエラー（起動時など）では無い
            match card_id {
                Some(card_id) => {
                    tracing::warn!(%card_id, "パーサからのエラー: {message}");
                }
                None => tracing::warn!("パーサからのエラー: {message}"),
            }
        }
    }
}

/// パーサが前置した `[<pid>] ` を剥がす（ログ設計§8-3）。
///
/// **剥がせなければ丸ごと本文として扱い、警告も出さない。** ここはパーサの stderr を
/// そのまま運ぶ道であって、書式を強制する道ではない。厳しくすると、
///
/// - 前置を持たない古いパーサ（保管庫や自己修復が置いた版）を繋いだ瞬間に警告が洪水になる
/// - `[` で始まる panic メッセージやバックトレースを壊す
///
/// という形で、**いちばん読みたい行を潰す**。
fn strip_pid(line: &str) -> Option<(u32, &str)> {
    let rest = line.strip_prefix('[')?;
    let (pid, rest) = rest.split_once("] ")?;
    Some((pid.parse().ok()?, rest))
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 前置したpidを剥がして欄へ移せる() {
        assert_eq!(
            strip_pid("[15637] ファイル監視を使えないので巡回だけで動きます: x"),
            Some((15637, "ファイル監視を使えないので巡回だけで動きます: x"))
        );
    }

    #[test]
    fn 剥がせない行は丸ごと本文として残す() {
        // 前置を持たない古いパーサ、panic メッセージ、バックトレース
        for line in [
            "前置の無い行",
            "[まだ] 数字ではない",
            "[15637]区切りが無い",
            "[",
            "",
            "thread 'main' panicked at src/main.rs:1:1:",
        ] {
            assert!(strip_pid(line).is_none(), "{line} を剥がしてしまった");
        }
    }

    /// 10秒窓ぶんの標本を作る。`reads` は累計、`rss_mb` はそのときの実測値。
    fn 窓(reads: u64, rss_mb: u64) -> Option<ResourceSample> {
        Some(ResourceSample {
            rss_bytes: rss_mb * 1024 * 1024,
            reads,
        })
    }

    const 窓の長さ: Duration = Duration::from_secs(10);

    /// 実測（設計§16-1）に合わせた、暴走側の1窓ぶんの進み方。
    /// `read` 約303,000回/秒 ＝ 10秒で約303万回。メモリ +300MB/分 ＝ 10秒で 50MB。
    const 暴走の読み: u64 = 3_030_000;
    const 暴走の増え: u64 = 50;

    #[test]
    fn 両方が線を越えて6回続いたときだけ暴走とみなす() {
        let mut watch = RunawayWatch::new();
        // 1本目は物差しが無いので判定しない
        assert_eq!(watch.observe(窓(0, 100), 窓の長さ), None);
        for 回 in 1..RUNAWAY_STREAK {
            let 判定 = watch.observe(
                窓(暴走の読み * 回 as u64, 100 + 暴走の増え * 回 as u64),
                窓の長さ,
            );
            assert_eq!(判定, None, "{回}回目で鳴ってしまった");
        }
        let 判定 = watch.observe(
            窓(
                暴走の読み * RUNAWAY_STREAK as u64,
                100 + 暴走の増え * RUNAWAY_STREAK as u64,
            ),
            窓の長さ,
        );
        let 暴走 = 判定.expect("6回目で鳴ること");
        assert_eq!(暴走.reads_per_sec, 303_000);
        assert_eq!(暴走.growth_per_min, 300 * 1024 * 1024);
    }

    #[test]
    fn 片方だけでは鳴らない() {
        // メモリだけ増えている＝大きなファイルへ追いついている最中（実測 +287MB/分）
        let mut 追いつき = RunawayWatch::new();
        assert_eq!(追いつき.observe(窓(0, 100), 窓の長さ), None);
        for 回 in 1..=(RUNAWAY_STREAK + 2) {
            let 判定 =
                追いつき.observe(窓(200 * 回 as u64, 100 + 暴走の増え * 回 as u64), 窓の長さ);
            assert_eq!(判定, None, "追いつきを暴走とみなした（{回}回目）");
        }

        // read だけ多い＝書き手が速いだけ（実測 140,793回/秒でも健全）
        let mut 速い書き手 = RunawayWatch::new();
        assert_eq!(速い書き手.observe(窓(0, 100), 窓の長さ), None);
        for 回 in 1..=(RUNAWAY_STREAK + 2) {
            let 判定 = 速い書き手.observe(窓(1_400_000 * 回 as u64, 100), 窓の長さ);
            assert_eq!(判定, None, "速い書き手を暴走とみなした（{回}回目）");
        }
    }

    /// 暴走側の進み方を積む役。**テストごとに手で足し算を書くと、どこかで取り違える。**
    struct 暴走を積む {
        reads: u64,
        rss_mb: u64,
    }

    impl 暴走を積む {
        fn 始める(watch: &mut RunawayWatch) -> Self {
            let 積む = Self {
                reads: 0,
                rss_mb: 100,
            };
            // 1本目は物差しになるだけ
            assert_eq!(watch.observe(窓(積む.reads, 積む.rss_mb), 窓の長さ), None);
            積む
        }

        fn ひと窓(&mut self, watch: &mut RunawayWatch) -> Option<Runaway> {
            self.reads += 暴走の読み;
            self.rss_mb += 暴走の増え;
            watch.observe(窓(self.reads, self.rss_mb), 窓の長さ)
        }

        fn 複数窓(&mut self, watch: &mut RunawayWatch, 回数: u32) -> Option<Runaway> {
            let mut 最後 = None;
            for _ in 0..回数 {
                最後 = self.ひと窓(watch);
            }
            最後
        }

        /// 線を越えない窓を1つ挟む（落ち着いた）。
        fn 落ち着く(&mut self, watch: &mut RunawayWatch) -> Option<Runaway> {
            self.reads += 100;
            watch.observe(窓(self.reads, self.rss_mb), 窓の長さ)
        }
    }

    /// **回数を字で書く。** 上の検査は `RUNAWAY_STREAK` から回数を作っているので、
    /// 定数を 1 に書き換えると**テストのほうも一緒に動いて通ってしまう**
    /// （ガイドライン「テストの既定値が壊れた状態だと、全テストが崩れたまま緑になる」）。
    /// ここだけは実測で決めた数（設計§16-1）を直接書き、番人にする。
    #[test]
    fn 五回で止まったら鳴らず六回目で鳴る() {
        let mut watch = RunawayWatch::new();
        let mut 積む = 暴走を積む::始める(&mut watch);
        for 回 in 1..=5 {
            assert_eq!(積む.ひと窓(&mut watch), None, "{回}回目で鳴った");
        }
        assert!(積む.ひと窓(&mut watch).is_some(), "6回目で鳴らない");
    }

    #[test]
    fn 途切れたら数え直す() {
        let mut watch = RunawayWatch::new();
        let mut 積む = 暴走を積む::始める(&mut watch);

        assert_eq!(
            積む.複数窓(&mut watch, RUNAWAY_STREAK - 1),
            None,
            "5回で鳴った"
        );
        assert_eq!(積む.落ち着く(&mut watch), None);
        // 数え直しになっているので、あと5回では鳴らない
        assert_eq!(
            積む.複数窓(&mut watch, RUNAWAY_STREAK - 1),
            None,
            "途切れたのに数え直していない"
        );
        // 6回そろって、ようやく鳴る
        assert!(積む.ひと窓(&mut watch).is_some(), "6回そろっても鳴らない");
    }

    #[test]
    fn 累計が減ったら別の個体として数え直す() {
        let mut watch = RunawayWatch::new();
        let mut reads = 0u64;
        let mut rss = 100u64;
        assert_eq!(watch.observe(窓(reads, rss), 窓の長さ), None);
        for _ in 0..(RUNAWAY_STREAK - 1) {
            reads += 暴走の読み;
            rss += 暴走の増え;
            assert_eq!(watch.observe(窓(reads, rss), 窓の長さ), None);
        }
        // 立て直しで新しい個体になった＝累計が 0 から数え直される
        assert_eq!(
            watch.observe(窓(0, 8), 窓の長さ),
            None,
            "減った差分で鳴った"
        );

        // 新しい個体で、また6回そろうまでは鳴らない
        let mut reads = 0u64;
        let mut rss = 8u64;
        for 回 in 1..RUNAWAY_STREAK {
            reads += 暴走の読み;
            rss += 暴走の増え;
            assert_eq!(
                watch.observe(窓(reads, rss), 窓の長さ),
                None,
                "前の個体の回数を引き継いでいる（{回}回目）"
            );
        }
        reads += 暴走の読み;
        rss += 暴走の増え;
        assert!(watch.observe(窓(reads, rss), 窓の長さ).is_some());
    }

    #[test]
    fn 測れなかった標本を0として扱わない() {
        let mut watch = RunawayWatch::new();
        let mut reads = 0u64;
        let mut rss = 100u64;
        assert_eq!(watch.observe(窓(reads, rss), 窓の長さ), None);
        for _ in 0..(RUNAWAY_STREAK - 1) {
            reads += 暴走の読み;
            rss += 暴走の増え;
            assert_eq!(watch.observe(窓(reads, rss), 窓の長さ), None);
        }
        // ここで読めなかった。**0 と読むと「増えていない」に化ける**ので、繋げない
        assert_eq!(watch.observe(None, 窓の長さ), None);

        // 繋げていないなら、次の1本は物差しになるだけで判定に使われない
        reads += 暴走の読み;
        rss += 暴走の増え;
        assert_eq!(
            watch.observe(窓(reads, rss), 窓の長さ),
            None,
            "測れなかった窓を跨いで差分を取っている"
        );
        for 回 in 1..RUNAWAY_STREAK {
            reads += 暴走の読み;
            rss += 暴走の増え;
            assert_eq!(
                watch.observe(窓(reads, rss), 窓の長さ),
                None,
                "測れなかったのに回数が残っている（{回}回目）"
            );
        }
        reads += 暴走の読み;
        rss += 暴走の増え;
        assert!(watch.observe(窓(reads, rss), 窓の長さ).is_some());
    }

    /// 資源の見張りは**終わらない**（設計§7-2）。
    ///
    /// 率の観察（`selfheal` の `baseline`）は「健全な窓を1つ通れば終わり」で、それには
    /// 理由がある——率は読んでいるデータの性質で動くので、時間が経つほど「パーサが悪いのか
    /// データが変わったのか」が言えなくなる。**資源の見張りにその終わり方を持ち込むと、
    /// 今回と同じ見落としに戻る**（輪へ入ったのは差し替えの直後ではなく、大きなファイルを
    /// 監視した瞬間だった）。ここは1度鳴らしても畳まないことを型で押さえる。
    #[test]
    fn 一度鳴らしたあとも見張りは続く() {
        let mut watch = RunawayWatch::new();
        let mut 積む = 暴走を積む::始める(&mut watch);
        assert!(
            積む.複数窓(&mut watch, RUNAWAY_STREAK).is_some(),
            "1度目が鳴らない"
        );
        assert!(
            積む.複数窓(&mut watch, RUNAWAY_STREAK).is_some(),
            "1度鳴らしたら終わってしまっている"
        );
    }

    /// 落ち続けの数え方（設計§8-2）。**時計は外から渡す**ので、5分待たずに当たれる。
    mod 落ち続け {
        use super::*;

        /// 「いま」を秒で表した目盛り。差がそのまま経過時間になる。
        fn 経過(now: u64, at: u64) -> Duration {
            Duration::from_secs(now - at)
        }

        #[test]
        fn 三回落ちたら見切る() {
            let mut log = CrashLog::new();
            assert!(!log.record(0, 経過), "1回は事故でも起こる");
            assert!(!log.record(1, 経過), "2回は偶然が残る");
            assert!(log.record(2, 経過), "3回続いたら見切る");
        }

        #[test]
        fn 窓の外へ出たものは数えない() {
            let mut log = CrashLog::new();
            assert!(!log.record(0, 経過));
            assert!(!log.record(1, 経過));
            // 5分を大きく越えてから3回目。**たまたま2回落ちていたものを巻き込まない**
            assert!(!log.record(1000, 経過), "窓の外の落ちを数えている");
            assert_eq!(log.len(), 1, "窓の中に残るのは最後の1回だけ");
        }

        #[test]
        fn 見切ったら数え直す() {
            // **戻したあとの1回目の落ちで、また外そうとしない**
            let mut log = CrashLog::new();
            log.record(0, 経過);
            log.record(1, 経過);
            assert!(log.record(2, 経過));
            assert!(log.is_empty(), "見切ったのに回数が残っている");
            assert!(!log.record(3, 経過), "戻した直後の1回でまた見切っている");
        }

        #[test]
        fn 実行ファイルが変わったら数え直す() {
            // 前の個体が落ちたことは、いまの個体の証明にならない
            let mut log = CrashLog::new();
            log.record(0, 経過);
            log.record(1, 経過);
            log.reset();
            assert!(!log.record(2, 経過), "前の個体の回数を引き継いでいる");
        }
    }

    /// 出どころの4通り（設計§4-3）。**ポインタだけが外せる。**
    #[test]
    fn 実行ファイルの出どころを名乗る() {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-parser-origin-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");
        let config = SessionHostConfig {
            state_dir: Some(dir.clone()),
            ..SessionHostConfig::default()
        };
        let pointer = dir.join(PARSER_POINTER);

        // 環境変数は他のテストと衝突しうるので、この1本の中では触らない。
        // 代わりに「環境変数が無いとき」の3通りを見る
        assert!(
            std::env::var(PARSER_BIN_ENV).is_err(),
            "この検査は環境変数が無いことを前提にしている"
        );

        // ポインタが実在のファイルを指していれば Pointer
        let swapped = dir.join("transcript-parser-swapped");
        std::fs::write(&swapped, b"#!/bin/false\n").expect("差し替え版を置けること");
        std::fs::write(&pointer, swapped.to_string_lossy().as_bytes())
            .expect("ポインタを書けること");
        let (path, origin) = parser_program(&config);
        assert_eq!(path, swapped);
        assert_eq!(origin, ParserOrigin::Pointer);
        assert!(origin.can_roll_back(), "ポインタ由来は外せる");

        // 指す先が消えていたら既定へ落ちる。**そのとき Pointer と名乗ってはいけない**
        std::fs::remove_file(&swapped).expect("差し替え版を消せること");
        let (_, origin) = parser_program(&config);
        assert_ne!(
            origin,
            ParserOrigin::Pointer,
            "落ちた先を Pointer と名乗ると、外す必要の無いポインタを外す"
        );
        assert!(!origin.can_roll_back());

        // ポインタが無ければ、隣か PATH
        std::fs::remove_file(&pointer).expect("ポインタを消せること");
        let (_, origin) = parser_program(&config);
        assert!(matches!(origin, ParserOrigin::Sibling | ParserOrigin::Path));
        assert!(!origin.can_roll_back());

        let _ = std::fs::remove_dir_all(dir);
    }

    /// 監視を頼むときの「ここから読め」は、保存済みの位置をそのまま渡す。
    ///
    /// 位置そのものの振る舞い（パスが変わったら使わない・巻き戻したら忘れる）は
    /// [`crate::offsets`] 側で固めてある。ここで見るのは**受け渡しの形**だけ。
    #[test]
    fn 保存済みの位置から読み直しを頼む() {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-parser-watch-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");
        let offsets = OffsetStore::open(dir.clone());
        let card_id = CardId::new();
        offsets.commit(card_id, "/p/s.jsonl", "/p/s.jsonl", 42);

        match watch_command(&offsets, card_id, "/p/s.jsonl".to_string()) {
            ParserCommand::Watch { from_offsets, .. } => {
                assert_eq!(from_offsets["/p/s.jsonl"], 42);
            }
            other => panic!("Watch ではない: {other:?}"),
        }

        // まだ何も読んでいないカードは先頭から
        match watch_command(&offsets, CardId::new(), "/p/other.jsonl".to_string()) {
            ParserCommand::Watch { from_offsets, .. } => assert!(from_offsets.is_empty()),
            other => panic!("Watch ではない: {other:?}"),
        }

        let _ = std::fs::remove_dir_all(dir);
    }
}
