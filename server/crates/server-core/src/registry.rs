//! カードの記録（セルフホスト化設計§3-2・§3-3）。
//!
//! # ここが「サーバから見たセッション」
//!
//! PTY も claude のプロセスも持たない。持っているのは**記録**——DB に書いた内容と、
//! それをブラウザへ配るための口だけ。実体（[`crate::session_host::SessionHost`] の向こう）とは
//! 完全に分かれていて、フェーズ1 で切った境界（設計§2-3）の、記録側の中身にあたる。
//!
//! フェーズ1 でここを作らなかったのは、写しを持つと**実体と二重化して起動直後の
//! カードを取りこぼす窓**が生まれるためだった（設計§18 読み替え1）。DB が真実になった
//! いまはその窓を塞げる——**書いてから配る**（§9-1）ので、ブラウザが知った時点で
//! DB には必ず入っている。
//!
//! # 何が来ても、まず書く
//!
//! セッションホストからの報告は [`SessionRegistry::apply`] を通る。ここでの順序は
//! 「DB へ書く → ブラウザへ配る」で固定する。**書けなかったものは配らない**——
//! 配ってしまうと、画面には出るのに再読み込みで消える（嘘になる）。代わりに
//! エラーを配ってバナーに出す（設計§12 の DB 断の行）。
//!
//! 揮発の知らせ（パーサの健康状態・自己修復の進行・操作の失敗）は DB へ書かずに
//! 素通しする。真実として残す性質のものではない。

use crate::{
    bus::{self, Bus},
    db::{self, entity, transcript as db_transcript},
    transcript::TranscriptWindow,
};
use protocol::{
    AgentId, AnnotationTarget, CardId, ClaudeLoginFingerprint, ClaudeSessionId, ContextUsage,
    MemoId, ModelId, NodeId, PermissionMode, ProjectId, RateLimits, SessionCost, SessionMeta,
    SessionStatus, TreeNode,
    a2s::KillOutcome,
    ws::{ErrorKind, MemoView, NoticeView, OpId, ServerMessage},
};
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, QueryFilter,
    QueryOrder,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{broadcast, oneshot, watch};
use uuid::Uuid;

/// 一覧の更新通知の待ち行列（メッセージ数）。
///
/// 取りこぼした購読者は `GET /api/sessions` で取り直せる（[`crate::ws`]）ので、
/// ここで待たない。一覧の更新がセッションの実行を遅らせてはいけない。
const EVENT_QUEUE_MESSAGES: usize = 256;

/// 書けなかった「外した」の報告を取り込み直す間隔の、初めと上限（[`SessionRegistry::retry_removal`]）。
/// 失敗するたびに倍にする。DB が止まっている間、1分に1回より多くは叩かない。
const REMOVAL_RETRY_FIRST: Duration = Duration::from_secs(1);
const REMOVAL_RETRY_MAX: Duration = Duration::from_secs(60);

/// 外したカードの印を覚えておく枚数（[`RemovedCards`]）。1枚 16 バイトの ID を2か所に持つだけ
/// なので、上限まで溜まっても数十 KB に収まる。
const REMOVED_CARDS_KEPT: usize = 1024;

/// 1枚のカードにつき残す起こし直しの終わった断りの件数（[`SessionRecord::revive_refusals`]）。
///
/// 待っている枝分かれが取りこぼした後に引き直せればよいので、同じカードへ立て続けに来た
/// 断りの数だけあれば足りる。溢れたら古い順に忘れる。
const REVIVE_REFUSALS_KEPT: usize = 8;

/// 1つのアカウントにつき控える番号付きの頼みの数（[`OpLedger`]）。
///
/// 控えが要るのは、頼んだ CLI が答えを待っている間（長くて枝分かれの上限 185 秒）だけである。
/// 1つの CLI は頼みを1つしか待たないので、同じアカウントから同時に待たれる数より十分に多ければ
/// 足りる。溢れたら古い順に忘れる——忘れた頼みは、取りこぼしたときに引き直せず時間切れになる
/// （止まったと嘘はつかない）。
const OPS_KEPT: usize = 256;

/// 在席の印がこれだけ古くなったら死んだものとみなす（ミリ秒。設計§9-4）。
///
/// 記す側（[`crate::gateway`]）と同じ値でなければならない。ずれると、記し直す前に
/// 消えたり、落ちた PC がいつまでも生きて見えたりする。
pub const PRESENCE_TTL_MS: i64 = 30_000;

/// 履歴購読1本あたりの配信待ち行列（メッセージ数）。
pub const TRANSCRIPT_QUEUE_MESSAGES: usize = 64;

/// 履歴1ページ分（`GET /api/sessions/{card_id}/transcript` の応答）。
///
/// `Deserialize` も持つのは、CLI（`agentdashboard session transcript`）が同じ型で
/// 応答を読み戻すため（CLI設計§6-3）。CLI 側に写しの型を定義しない。
#[derive(Debug, Serialize, Deserialize)]
pub struct TranscriptPage {
    pub nodes: Vec<TreeNode>,
    /// さらに前があるかもしれない
    pub has_more: bool,
}

/// 起こし直しの**終わった断り**なら、宛先のカード・答える頼みの番号・文面（寝ているカード
/// ばかりなのに、メモリ不足でセッションを起こせない 設計§7-3・実装レビュー第6回 Astra 3）。
///
/// 競合（`busy: Some(true)`）と判別できない知らせ（`None`）は含めない——待てば起きるか、
/// 起きるかどうか分からないので、待っている側を止めてはいけない。**見分けの正本はここ**
/// （記録へ残す側と、配信で拾う枝分かれの側が同じ規則を使う）。
///
/// **どの頼みへの答えかは番号で決める。** 番号の無い断り（古い PC）は、誰の頼みへの答えとも
/// 言えないので、待つ側はどれも拾わない。
pub fn revive_refusal_of(message: &ServerMessage) -> Option<(CardId, &[OpId], &str)> {
    match message {
        ServerMessage::Error {
            card_id: Some(card_id),
            message,
            kind: ErrorKind::Revive,
            busy: Some(false),
            ops,
            ..
        } => Some((*card_id, ops.as_slice(), message.as_str())),
        _ => None,
    }
}

/// 記録の行を、線に乗る形へ写す。
///
/// **写す場所を1つに閉じてある。** REST とプッシュで別々に組み立てると、片方だけ列を
/// 足したときに黙ってずれる。
pub fn notice_view(row: entity::notices::Model) -> NoticeView {
    NoticeView {
        id: row.id,
        card_id: row.card_id.map(CardId),
        source: row.source,
        kind: row.kind,
        message: row.message,
        created_at: row.created_at,
        read_at: row.read_at,
    }
}

/// 知らせを溜めておく量の上限（トーストとベル設計§5-1）。
///
/// **2本立てにしてあるのは、片方だけだと取りこぼすためである。** 日数だけだと
/// 「1日で200件出た」を、件数だけだと「30日かけて少しずつ溜まった」を取りこぼす。
///
/// 2つの数を裸で並べて渡さないのは、**どちらも `u64` で入れ替えても気づけない**から。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoticeLimits {
    /// これより古いものは消える。
    pub retention_days: u64,
    /// **アカウントごと**の件数の上限。超えたら古い順に削る。
    pub max_rows: u64,
}

impl Default for NoticeLimits {
    /// `server/config.toml.example` の既定と揃えてある。
    ///
    /// **テストのためだけの値ではない。** 設定を書かずに起動した人がこの値で動く。
    fn default() -> Self {
        Self {
            retention_days: 30,
            max_rows: 200,
        }
    }
}

/// 報告の出どころ（セルフホスト化設計§5-1 の手順4）。
///
/// **帰属を決めるのはサーバの仕事**なので、セッションホストが `SessionMeta` に何を書いて
/// 寄越しても、記録に残る `agent_id` と `account_id` はここの値で上書きする。ローカル
/// モードは「1つのアカウントの、PC という単位が無い報告」として同じ形に流し込む。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportOrigin {
    pub account_id: Uuid,
    /// どの PC からか。**ローカルモードは `None`**（結び付ける `agents` の行が無い）
    pub agent_id: Option<AgentId>,
    /// 画面に出すアカウント名。ローカルはアカウントを表に出さないので `None`
    pub account: Option<String>,
}

impl ReportOrigin {
    /// ローカルモードの出どころ。
    pub fn local() -> Self {
        Self {
            account_id: db::LOCAL_ACCOUNT_ID,
            agent_id: None,
            account: None,
        }
    }
}

/// 履歴のページを作れなかった理由。
#[derive(Debug, PartialEq, Eq)]
pub enum PageError {
    /// そのカードを知らない
    NotFound,
    /// DB に聞けなかった。
    ///
    /// **パーサの縮退ではここへ来ない**のが初期実装との違い。読み先が JSONL から DB へ
    /// 変わったので、パーサが止まっていても DB にある範囲は返せる（設計§3-3 の改善）。
    Unavailable,
}

/// 一覧の更新通知。**誰のカードの話か**を添えて配る。
///
/// 配信の口を1本にしたまま、購読側が自分のアカウントのぶんだけを拾えるようにするための形
/// （設計§8-6）。アカウントごとにチャネルを分けるのはインスタンスを跨ぐとき（§9-2）の話で、
/// 1インスタンスのうちは**配るときに絞る**ほうが、購読の作りが1つで済む。
#[derive(Debug, Clone)]
pub struct AccountEvent {
    pub account_id: Uuid,
    pub message: ServerMessage,
}

/// カード1枚の記録。
pub struct SessionRecord {
    pub card_id: CardId,
    /// 誰のカードか（設計§8-6）。**帰属は接続が決める**ので、ここは書き換わらない
    pub account_id: Uuid,
    meta: Mutex<SessionMeta>,
    /// 直近ぶんの写し（設計§3-3）。真実は DB
    window: Mutex<TranscriptWindow>,
    /// 履歴の配信。**購読しているクライアントにだけ**流す（一覧の配信とは別口）
    transcript_tx: broadcast::Sender<Arc<String>>,
    /// 次に振る `seq`。書き込みは1本の経路を通るので、ここで直列化すれば足りる
    next_seq: tokio::sync::Mutex<i64>,
    /// この記録を持っている相手が、いま報告してきているか（設計§6-3）。
    ///
    /// ローカルモードでは「前回の起動が残した記録」が `false` になる。PTY は
    /// 再起動で道連れなので、戻ってきたカードは履歴だけが読める抜け殻になる。
    live: AtomicBool,
    /// 配った**起こし直しの終わった断り**と、それが答える頼みの番号（実装レビュー Astra 4・
    /// 第6回 Astra 3）。新しい順に最大 [`REVIVE_REFUSALS_KEPT`] 件。
    ///
    /// 配信は取りこぼしうる（`Lagged`）。起きるのを待っている枝分かれが断りを
    /// 取りこぼすと、上限（180 秒）まで待ってから事実と違う理由で終わる——配った後も
    /// 引けるように、ここへ残す。**DB には持たない**（揮発の知らせで、待っている側も
    /// このインスタンスの中にしか居ない）。
    ///
    /// # 番号で引く（以前は通し番号の目印だった）
    ///
    /// 以前は1枚につき最新の1件を、記録へ取り込んだ時点の通し番号付きで持ち、待つ側は控えた
    /// 目印より後のものを拾っていた。通し番号は取り込んだ順でしかないので、先の起こし直しの
    /// 断りが遅れて取り込まれると、後から受け付けた起こし直しを待っている枝分かれの目印より
    /// 大きい番号が付き、古い断りを自分の結果と取り違えた。しかも1件しか持たないので、遅れた
    /// 断りが後の断りを上書きする。**どの頼みへの答えかは、断りが運ぶ頼みの番号で決める。**
    revive_refusals: Mutex<VecDeque<(Vec<OpId>, String)>>,
}

impl SessionRecord {
    fn new(
        meta: SessionMeta,
        account_id: Uuid,
        window_nodes: usize,
        next_seq: i64,
        live: bool,
    ) -> Self {
        Self {
            card_id: meta.card_id,
            account_id,
            meta: Mutex::new(meta),
            window: Mutex::new(TranscriptWindow::new(window_nodes)),
            transcript_tx: broadcast::channel(TRANSCRIPT_QUEUE_MESSAGES).0,
            next_seq: tokio::sync::Mutex::new(next_seq),
            live: AtomicBool::new(live),
            revive_refusals: Mutex::new(VecDeque::new()),
        }
    }

    /// いまのカード情報。**接続の鮮度はここで被せる**（DB には持たない）。
    pub fn meta(&self) -> SessionMeta {
        let mut meta = self.meta.lock().expect("ロックが壊れていない").clone();
        meta.agent_connected = self.live.load(Ordering::Relaxed);
        meta
    }

    /// カード情報を入れ替える。**鮮度の印は渡された値に従う。**
    ///
    /// 自分の受け口から来た報告は「いま届いた」ので必ず繋がっている（セッションホスト側が
    /// `true` を立てて寄越す）。他インスタンスから回ってきたものは向こうの見立てが正で、
    /// ここで `true` に塗り替えると**切断の知らせが跨いだ瞬間に消える**。
    fn store_meta(&self, meta: SessionMeta) {
        self.live.store(meta.agent_connected, Ordering::Relaxed);
        *self.meta.lock().expect("ロックが壊れていない") = meta;
    }

    /// 履歴の購読を、いま持っているぶんの取得と**同じロックの中で**始める。
    ///
    /// 取得と購読開始がずれると、その隙間に届いたノードを取りこぼす。逆側にずれた
    /// 場合は同じノードが二度届くが、履歴は「同じIDは上書き」なので害が無い。
    /// **迷ったら重ねる側に倒す。**
    pub fn subscribe_transcript(&self) -> (Vec<TreeNode>, broadcast::Receiver<Arc<String>>) {
        let window = self.window.lock().expect("ロックが壊れていない");
        let receiver = self.transcript_tx.subscribe();
        (window.snapshot(), receiver)
    }

    pub fn transcript_snapshot(&self) -> Vec<TreeNode> {
        self.window.lock().expect("ロックが壊れていない").snapshot()
    }

    /// 分かれる元の会話を持っているか（ブランチ設計§3-4）。
    ///
    /// **数えるだけで写しは作らない。** 判定に `transcript_snapshot` を使うと、
    /// 窓いっぱい（既定 2000 ノード）を毎回複製することになる。
    pub fn has_transcript(&self) -> bool {
        !self.window.lock().expect("ロックが壊れていない").is_empty()
    }

    /// 購読者が居るときだけ直列化して配る。
    ///
    /// 巨大な Edit の結果を JSON にする処理がコストの本体なので、誰も見ていないカードで
    /// それをやらない。窓の更新は購読の有無に関わらず続ける（開いた瞬間に履歴が出るのは
    /// このため）。
    fn fanout(&self, message: &ServerMessage) {
        if self.transcript_tx.receiver_count() == 0 {
            return;
        }
        if let Ok(text) = serde_json::to_string(message) {
            let _ = self.transcript_tx.send(Arc::new(text));
        }
    }
}

/// 見つからないカードへの断り文言（設計§8-6・名前付け設計§11-4）。
///
/// **他人のカードでも、存在しないカードでも同じ言葉を返す。** 呼び分けると、IDを
/// 総当たりして「他人のカードがあること」だけを言い当てられる。
///
/// 記録層に置いてあるのは、**絞り込みの入口がここだから**（設計§8-6 の読み替え2）。
/// 断る場所と断り文言が別の層にあると、片方だけ直したときに言葉がずれる。
pub(crate) const NOT_FOUND: &str = "セッションが見つかりません";

/// メモが見つからないときの言い分。**他人のものを指したときも同じ答えになる**——
/// 言い分けると、IDの総当たりで他人のメモの存在を調べられる（`NOT_FOUND` と同じ理由）。
pub(crate) const MEMO_NOT_FOUND: &str = "そのメモは見つかりません";

/// 全カードの記録と、その配信。
pub struct SessionRegistry {
    db: DatabaseConnection,
    records: Mutex<HashMap<CardId, Arc<SessionRecord>>>,
    /// 一覧から外したカードの印（実装レビュー第5回 Astra 1）。**`records` のロックを握ったまま
    /// 見る・立てる**（[`Self::drop_record`]・[`Self::record_for`]）。
    removed: Mutex<RemovedCards>,
    /// 次の照合の読み取りを1回失敗させる（**テスト専用**。[`Self::照合の読みを1回失敗させる`]）
    reconcile_fail_once: AtomicBool,
    /// 照合の読み取りを止める門（**テスト専用**。[`Self::照合の読みを止める`]）
    reconcile_hold: Mutex<Option<照合の止め所>>,
    /// 番号付きの頼みの控え（実装レビュー第7回 Astra 3・4。[`OpLedger`]）。**他のロックと跨がない**
    ops: Mutex<OpLedger>,
    events: broadcast::Sender<AccountEvent>,
    /// 失効した札（cli）の知らせ。**このインスタンスの `/ws` 接続を畳むためだけ**の道
    /// （コードレビュー対応3）。PC 側の失効（gateway の `disconnect_token`）と同じく
    /// インスタンス跨ぎは扱わない——よそのインスタンスの接続は、新しい要求が
    /// `resolve_token` で断られる形に任せる
    revocations: broadcast::Sender<Uuid>,
    window_nodes: usize,
    /// インスタンスを跨ぐ連絡係（設計§9）。**無ければプロセスの中で完結する**——
    /// ローカルモードと、インスタンスが1台だけのセルフホストがこれにあたる
    bus: Option<Arc<dyn Bus>>,
    /// このインスタンスの通し番号。**自分が出した知らせを自分で取り込まない**ための印
    instance_id: Uuid,
    /// アカウントごとの、いま繋がっているブラウザの数。
    ///
    /// 0→1 で知らせの購読を開け、1→0 で閉じる（設計§9-2）。**全アカウントを
    /// まとめて購読しない**のは、そうするとチャネル名でアカウントを分けた意味が
    /// 無くなるため（§8-6）——他人のチャネルは名前を作れないから購読できない、
    /// という形が分離の実体になっている
    browsers: Mutex<HashMap<Uuid, usize>>,
    /// 利用者が付けた名前（名前付け設計§4-2）。**記録側が正**なので手元にも写しを持つ。
    ///
    /// 鍵が `(アカウント, CLI セッション)` なのは、名前が**カードではなく CLI セッション**に
    /// 付くため（要件4）。カードが乗り換えても、乗り換え先の名前がそのまま出る。
    ///
    /// 写しを持つのは、報告が届くたびに DB を引かないため。`position` が記録の値を
    /// 引き直しているのと違い、こちらは**カードの数だけ引くことになる**——一覧の
    /// 復元1回で枚数ぶんの問い合わせが出る。
    nicknames: Mutex<HashMap<(Uuid, ClaudeSessionId), String>>,
    /// 枝分かれの印（ブランチ設計§5-1）。鍵は**枝の側**、値は**分かれ元**。
    ///
    /// 名前とまったく同じ性質・同じ扱いである——**記録側が正**で、鍵が
    /// `(アカウント, CLI セッション)` なのは、印が**カードではなく会話**に付くため。
    /// カードが乗り換えても印は消えない。写しを持つ理由も名前と同じ（報告のたびに
    /// カードの数だけ DB を引かないため）。
    branches: Mutex<HashMap<(Uuid, ClaudeSessionId), ClaudeSessionId>>,
    /// PC ごとの使用上限（status設計「保管」）。鍵は **(アカウント, PC)**。
    ///
    /// # 鍵が `Option<AgentId>` なのは、局所モードに PC の行が無いから
    ///
    /// ローカルモードは `agents` の表そのものが空である（`account::no_agents` の
    /// doc が「`"local"` を1台として並べたりはしない」と決めている）。だから
    /// `None` を「この機械」として持つ。**捨てないこと**——捨てると、後から
    /// 出し先を作っても値が無い。**保管は宛先を決めない。**
    ///
    /// # `nicknames` / `branches` と同じ形だが、あちらは写し、こちらは正本である
    ///
    /// 上の2つは**記録側（DB）が正**で、報告のたびに DB を引かないための写しを
    /// ここに置いている。**こちらは DB に持たない**ので、ここが唯一の在り処になる。
    /// 落ちれば消えるのが正しい——保存すると**繋がっていない PC の古い数字が残る**
    /// （`context_usage` を保存しないのと同じ形だが、あちらは「空のセッションに
    /// 前回の使用率」、こちらは「居ない PC の使用率」で、**誰の実態と食い違うかが違う**）。
    rate_limits: Mutex<HashMap<(Uuid, Option<AgentId>), StoredRateLimits>>,
    /// 自分への弱い参照。`apply` は `&self` で呼ばれるので、書けなかった「外した」の報告を
    /// 切り離して取り込み直す（[`Self::retry_removal`]）ための `Arc` を自分で引く
    me: Weak<Self>,
    /// 取り込み直しの間隔の初め。**テストだけが延ばす**（急かす口で1回ずつ進めるため）
    removal_retry_first: Mutex<Duration>,
    /// 取り込み直しを急かす口（**テスト用**）。値は回数で、変わったら待たずに次を試す
    removal_retry_kick: watch::Sender<u64>,
    /// 更新（[`Self::upsert`]）を決めた所で1回止める口（**テスト用**）
    update_pause: Mutex<Option<UpdatePause>>,
}

/// 一覧から外したカードの印（実装レビュー第5回 Astra 1）。
///
/// # なぜ要るのか
///
/// 外す処理と遅れて届いた更新が行き違うと、更新側が記録を作り直して一覧へ戻していた。更新側は
/// 記録が手元にあるうちに「外したか」の確かめ（DB）を済ませ、DB へ書くのを待っている間に外れても
/// 気づかない。書き終えると、記録が無いので作り直して配る——**DB では外れているのに一覧に戻り、
/// PC では起こし直しを断られるカード**になる。書けなかった「外した」の報告の取り込み直し
/// （[`SessionRegistry::retry_removal`]）が更新と並んで走るので、この行き違いが起きる。
///
/// 印は記録を消すのと同じロックの中で立て、記録を作る側も同じロックの中で見る。「見てから作る」の
/// 間にすり抜けない。
///
/// # 寿命と量
///
/// 外したことは取り消されない（`archived` を戻す道は無く、カード ID は UUIDv4 で使い回されない）
/// ので、時間で失効させる理由は無い。量の上限（[`REMOVED_CARDS_KEPT`]）は**メモリを守るためだけ**
/// で、溢れたら古い順に忘れる——忘れたカードへの報告も、手元に記録が無ければ [`SessionRegistry::upsert`]
/// が DB で外したことを確かめて捨てる。
///
/// # 印はアカウントごと（実装レビュー第9回 Astra 1）
///
/// 以前はカード ID だけで持っていた。他のアカウントのカード ID を名指しした「外した」の報告が、
/// 手元に記録の無いカードに印を立てると、**正当な持ち主の報告まで記録を作り直せなくなった**
/// （他のアカウントから一覧を消せる）。印は「どのアカウントが外したか」と組で持ち、見るときも
/// 記録の持ち主と組で見る。
#[derive(Default)]
struct RemovedCards {
    cards: HashSet<(Uuid, CardId)>,
    /// 外した順（溢れたときに古いものから忘れるため）
    order: VecDeque<(Uuid, CardId)>,
}

impl RemovedCards {
    fn mark(&mut self, account_id: Uuid, card_id: CardId) {
        if !self.cards.insert((account_id, card_id)) {
            return;
        }
        self.order.push_back((account_id, card_id));
        while self.order.len() > REMOVED_CARDS_KEPT {
            if let Some(oldest) = self.order.pop_front() {
                self.cards.remove(&oldest);
            }
        }
    }

    fn contains(&self, account_id: Uuid, card_id: CardId) -> bool {
        self.cards.contains(&(account_id, card_id))
    }
}

/// 照合の DB の読み取りを止める門（**テスト専用**。[`SessionRegistry::照合の読みを止める`]）。
#[doc(hidden)]
#[derive(Clone)]
pub struct 照合の止め所 {
    gate: Arc<tokio::sync::Semaphore>,
    reached: Arc<std::sync::atomic::AtomicUsize>,
}

impl 照合の止め所 {
    /// 門まで来た照合の数（通った数ではない。一度来たら数え続ける）。
    pub fn 来た数(&self) -> usize {
        self.reached.load(Ordering::SeqCst)
    }

    /// 門を開ける。待っている照合も、これから来るものも通る。
    pub fn 開ける(&self) {
        self.gate
            .add_permits(tokio::sync::Semaphore::MAX_PERMITS / 2);
    }
}

/// 番号付きの頼みの控え（寝ているカードばかりなのに、メモリ不足でセッションを起こせない
/// 実装レビュー第7回 Astra 3・4）。
///
/// **答えの配送を、配信の取りこぼしとカードの有無から切り離す**ために持つ。
///
/// - **取りこぼし（Astra 4）**：答え（番号付きの `Status`・断り）は1回しか出ないのに、ふだんの
///   知らせと同じ配信（溢れたら古いものを捨てる）へ1回流すだけだった。混んで捨てられると、
///   後の知らせには番号が無いので CLI は時間切れになった。答えを配る前にここへ残し、接続が
///   取りこぼしたら番号で引き直す（[`SessionRegistry::op_answer`]。第5回で起こし直しの断りを
///   記録に残したのと同じ「残してから配る」）
/// - **カードの有無（Astra 3）**：他のインスタンスから回ってきた答えは、カードの記録が手元に
///   あることを持ち主の確かめにしていた。CLI の居るインスタンスで外すのが先に済むと、答えが
///   届いているのに捨てた。ここに控えた**受け付けた頼み**の持ち主で確かめる
///
/// 控えるのは**このインスタンスが受け付けた頼みだけ**（`ws.rs` が持ち主の門を通した後に
/// [`SessionRegistry::accept_op`] で入れる。枝分かれの段取りも自分の起こし直しの頼みを入れる）。
/// 答えは最初の1つだけを残す。**ただし競合（途中の知らせ）は、後から届く終わりの答えで置き換える**
/// （実装レビュー第11回 Astra 2。[`is_interim_answer`]）。CLI は自分の番号の断りなら競合でも
/// その場で落ちるので、配信で受けた CLI の結果は変わらない。
///
/// **再起動で消える**（メモリにだけ持つ）。消えた後に取りこぼした答えは引き直せず、CLI は
/// 時間切れで終わる。
#[derive(Default)]
struct OpLedger {
    entries: HashMap<OpId, OpEntry>,
    /// アカウントごとの受け付けた順（溢れたときに古いものから忘れるため）
    order: HashMap<Uuid, VecDeque<OpId>>,
}

struct OpEntry {
    account_id: Uuid,
    card_id: CardId,
    /// **答えの本体は、同じ答えが運ぶ番号のあいだで1つを分け合う**（実装レビュー第10回 Astra 2）。
    /// 断り1件は束ねた番号を全部運ぶので、番号ごとに写すと束の大きさの2乗で育つ
    answer: Option<Arc<ServerMessage>>,
}

impl OpLedger {
    fn accept(&mut self, account_id: Uuid, card_id: CardId, op: OpId) {
        // 同じ番号を2度受け付けたら、先の控えを保つ（答えを上書きさせない）
        if self.entries.contains_key(&op) {
            return;
        }
        self.entries.insert(
            op,
            OpEntry {
                account_id,
                card_id,
                answer: None,
            },
        );
        let order = self.order.entry(account_id).or_default();
        order.push_back(op);
        while order.len() > OPS_KEPT {
            if let Some(oldest) = order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    /// そのアカウントがそのカードへ頼んだ番号として受け付けたか。
    fn accepted(&self, account_id: Uuid, card_id: CardId, op: OpId) -> bool {
        self.entries
            .get(&op)
            .is_some_and(|entry| entry.account_id == account_id && entry.card_id == card_id)
    }

    /// 答えを控える。受け付けた頼みで、持ち主とカードが合い、まだ答えが無いときだけ。
    fn record(&mut self, account_id: Uuid, message: &ServerMessage) {
        let Some((card_id, ops)) = op_answer_of(message) else {
            return;
        };
        let mut shared: Option<Arc<ServerMessage>> = None;
        let 途中 = is_interim_answer(message);
        for op in ops {
            if let Some(entry) = self.entries.get_mut(op)
                && entry.account_id == account_id
                && card_id.is_none_or(|card_id| card_id == entry.card_id)
                && (entry.answer.is_none()
                    || (!途中 && entry.answer.as_deref().is_some_and(is_interim_answer)))
            {
                let body = shared.get_or_insert_with(|| Arc::new(message.clone()));
                entry.answer = Some(Arc::clone(body));
            }
        }
    }

    /// 写すのは引かれたときだけ（取りこぼした接続が引き直すとき）。
    fn answer(&self, account_id: Uuid, op: OpId) -> Option<ServerMessage> {
        self.entries
            .get(&op)
            .filter(|entry| entry.account_id == account_id)
            .and_then(|entry| entry.answer.as_deref().cloned())
    }

    /// 控えた答えの本体が運ぶ番号の数の合計（本体ごとに1回だけ数える。**テスト専用**の口が使う）。
    fn kept_answer_ops(&self) -> usize {
        let mut seen = HashSet::new();
        self.entries
            .values()
            .filter_map(|entry| entry.answer.as_ref())
            .filter(|body| seen.insert(Arc::as_ptr(body)))
            .map(|body| op_answer_of(body).map_or(0, |(_, ops)| ops.len()))
            .sum()
    }
}

/// 途中の知らせ（起こし直しの競合。`busy: Some(true)`）か（実装レビュー第11回 Astra 2）。
///
/// 競合で束ねた頼みは、先の起こし直しの結果（成功の答え・終わった断り）が後から届く。控えに競合を
/// 先に残すと、後の結果が残らず、記録から引き直す枝分かれは結果を知れない。**途中の知らせは、
/// 後から届いた終わりの答えで置き換える**（終わりの答え同士は、これまでどおり最初のものを残す）。
fn is_interim_answer(message: &ServerMessage) -> bool {
    matches!(
        message,
        ServerMessage::Error {
            kind: ErrorKind::Revive,
            busy: Some(true),
            ..
        }
    )
}

/// 番号付きの頼みへの答えなら、宛先のカードと答えた番号（実装レビュー第7回 Astra 3・4）。
///
/// 答えの形は2つ：成功の `Status`（番号1つ）と、断り（`Error`。束ねた番号を全部運ぶ）。
/// 番号の無いものは答えではない。
pub(crate) fn op_answer_of(message: &ServerMessage) -> Option<(Option<CardId>, &[OpId])> {
    match message {
        ServerMessage::Status {
            card_id,
            op: Some(op),
            ..
        } => Some((Some(*card_id), std::slice::from_ref(op))),
        ServerMessage::Error { card_id, ops, .. } if !ops.is_empty() => {
            Some((*card_id, ops.as_slice()))
        }
        _ => None,
    }
}

/// 記録の姿をどこまで配るか（[`SessionRegistry::publish_record`]）。
#[derive(Clone, Copy)]
enum Reach {
    /// 手元のブラウザと連絡係の両方（自分が書いた報告）
    AllInstances,
    /// 手元のブラウザだけ（他インスタンスから回ってきたもの・DB から読み直したもの）
    ThisInstance,
}

/// 更新（[`SessionRegistry::upsert`]）をどこで止めるか（**テスト専用**）。
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum 更新の止め所 {
    /// DB へ書き終え、手元の記録を取る（無ければ作る）前
    記録を取る前,
    /// 手元の記録へ入れ終え、配る前
    配る前,
}

struct UpdatePause {
    at: 更新の止め所,
    reached: oneshot::Sender<()>,
    resume: oneshot::Receiver<()>,
}

/// 止めた更新の手綱（**テスト専用**。[`SessionRegistry::更新を止める`]）。
#[doc(hidden)]
pub struct 止めた更新 {
    reached: oneshot::Receiver<()>,
    resume: oneshot::Sender<()>,
}

impl 止めた更新 {
    /// 更新が止め所まで来るのを待つ。
    pub async fn 止まるまで待つ(&mut self) {
        (&mut self.reached)
            .await
            .expect("止め所まで来る前に、止める口ごと捨てられていない");
    }

    /// 止めた更新を先へ進める。
    pub fn 進める(self) {
        self.resume
            .send(())
            .expect("止めた更新が、進めるのを待っていること");
    }
}

/// 保管している使用上限と、**それが誰のものか**。
///
/// # 値だけを持っていると、切り替えを取り逃がす
///
/// [`merge_rate_limits`] は「リセット時刻は前へ戻らない」を頼りに遅れて届いた報告を
/// 捨てるが、**その約束は1つの claude ログインの中でしか成り立たない**。別アカウントへ
/// ログインし直すと新しい窓が手前で戻ることがあり、合流はそれを「遅れて届いたもの」と
/// 読んで捨てる——**画面に前のアカウントの数字が残り続ける**（2026-09-14 申告）。
///
/// だから**誰のものかを値と一緒に控える**。違う相手から届いたら合流させず入れ替える。
#[derive(Debug, Clone, PartialEq)]
struct StoredRateLimits {
    /// どの claude ログインのものか。**読めない環境では `None`**（[`ClaudeLoginFingerprint`]）。
    login: Option<ClaudeLoginFingerprint>,
    limits: RateLimits,
}

impl SessionRegistry {
    /// DB から復元して立ち上げる。
    ///
    /// 外していない（`archived=false`）カードを読み戻し、**すべて「接続していない」印**で
    /// 一覧に出す。ローカルモードでは、これが前回の起動が残した記録にあたる——
    /// 履歴は読めるが PTY は道連れで死んでいる（設計§1-3）。セルフホストモードでは、
    /// セッションホストが繋ぎ直してくるまでの間がこの状態になる（§6-3 と同じ見え方）。
    ///
    /// **全アカウントぶんを読む。** このインスタンスは誰のブラウザも受けるので、
    /// 読む時点で絞る相手が決まっていない。絞るのは配るとき・返すときで、
    /// その判定は [`SessionRecord::account_id`] が持つ（§8-6）。
    /// **知らせの上限を引数で取るのは、掃除を起こし忘れないためである**（トーストと
    /// ベル設計§5-3）。掃除を起こす行は、忘れても何も起きない——だから忘れる。
    /// ここで受け取って内部で起こせば、**渡し忘れた時点でコンパイルが通らない**。
    pub async fn load(
        db: DatabaseConnection,
        window_nodes: usize,
        bus: Option<Arc<dyn Bus>>,
        notice_limits: NoticeLimits,
    ) -> Result<Arc<Self>, anyhow::Error> {
        let rows = entity::sessions::Entity::find()
            .filter(entity::sessions::Column::Archived.eq(false))
            .order_by_asc(entity::sessions::Column::CreatedAt)
            .all(&db)
            .await?;

        // 画面に出すアカウント名（`SessionMeta::account`）は行に持っていないので、
        // まとめて引いておく。カードごとに引くと、復元するだけで枚数ぶんの問い合わせになる
        let names: HashMap<Uuid, String> = entity::accounts::Entity::find()
            .all(&db)
            .await?
            .into_iter()
            .map(|row| (row.id, row.name))
            .collect();

        // 利用者が付けた名前をまとめて読む。**カードごとに引かない**——復元するだけで
        // 枚数ぶんの問い合わせになる（アカウント名を先に引いているのと同じ理由）
        let nicknames = load_nicknames(&db, None).await?;
        // 枝分かれの印も同じくまとめて読む（ブランチ設計§5-1）
        let branches = load_branches(&db, None).await?;

        let mut records = HashMap::new();
        for row in rows {
            let account_id = row.account_id;
            let mut meta = meta_from_row(row);
            // ローカルのアカウントは画面に出さない（アカウントという単位が無い）
            if account_id != db::LOCAL_ACCOUNT_ID {
                meta.account = names.get(&account_id).cloned();
            }
            // **名前は記録の側が正**（設計§4-2）。行から作った `meta` は必ず空なので、
            // ここでかぶせる
            meta.nickname = meta
                .claude_session_id
                .and_then(|id| nicknames.get(&(account_id, id)).cloned());
            // 枝の印も同じく記録の側が正
            meta.branched_from = meta
                .claude_session_id
                .and_then(|id| branches.get(&(account_id, id)).copied());
            let card_id = meta.card_id;
            let next_seq = db_transcript::next_seq(&db, card_id).await?;
            // 窓を DB の直近ぶんで満たす。空のままだと、購読を始めたクライアントに
            // 「履歴が無い」と見えてしまう（DB には残っているのに）。
            // **読み終えてからロックを取る**（ロックを持ったまま待たない）
            let latest = db_transcript::latest(&db, card_id, window_nodes).await?;
            // 前回の起動が残したカードなので live=false
            let record = SessionRecord::new(meta, account_id, window_nodes, next_seq, false);
            record
                .window
                .lock()
                .expect("ロックが壊れていない")
                .fill(latest);
            records.insert(card_id, Arc::new(record));
        }
        if !records.is_empty() {
            tracing::info!("前回の記録から {} 枚のカードを復元しました", records.len());
        }

        // **知らせの掃除をここで起こす。** 呼び出し側に任せると忘れる（設計§5-3）
        db::notices::start_sweeper(
            db.clone(),
            notice_limits.retention_days,
            notice_limits.max_rows,
        );

        // **メモの掃除も同じ場所で起こす。** 呼び出し側に任せると忘れる（メモ設計§11）。
        // 保持日数はアカウントごとの設定なので、ここで渡すのは**行が無いときの初期値**
        db::memos::start_sweeper(db.clone(), db::settings::DEFAULT_MEMO_RETENTION_DAYS);

        // **画像の掃除も同じ場所で起こす**（レビュー対応2）。**呼び出し側に任せると
        // 忘れる**——実際、これが無かったせいで**消したメモや期限切れの画像が永久に
        // 残っていた**。容量のぶんは同意が要るので、ここで掃くのは期間ぶんだけである
        db::memo_blobs::start_sweeper(db.clone(), db::settings::DEFAULT_MEMO_RETENTION_DAYS);

        Ok(Arc::new_cyclic(|me| Self {
            db,
            records: Mutex::new(records),
            removed: Mutex::new(RemovedCards::default()),
            reconcile_fail_once: AtomicBool::new(false),
            reconcile_hold: Mutex::new(None),
            ops: Mutex::new(OpLedger::default()),
            events: broadcast::channel(EVENT_QUEUE_MESSAGES).0,
            revocations: broadcast::channel(EVENT_QUEUE_MESSAGES).0,
            window_nodes,
            bus,
            instance_id: Uuid::new_v4(),
            browsers: Mutex::new(HashMap::new()),
            nicknames: Mutex::new(nicknames),
            branches: Mutex::new(branches),
            rate_limits: Mutex::new(HashMap::new()),
            me: me.clone(),
            removal_retry_first: Mutex::new(REMOVAL_RETRY_FIRST),
            removal_retry_kick: watch::channel(0).0,
            update_pause: Mutex::new(None),
        }))
    }

    /// このインスタンスの通し番号（視聴リースの名乗りにも使う。設計§9-4）。
    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }

    pub fn bus(&self) -> Option<&Arc<dyn Bus>> {
        self.bus.as_ref()
    }

    /// 記録そのもの。**カード以外の表**（PJT 枠など）を読み書きする口が使う。
    ///
    /// カードの読み書きはこの型のメソッド越しに行うこと——**外から直に触ると
    /// 「手元の写しと DB」の順序を守る場所が増える**（設計§9-1 の配線）。
    pub fn db(&self) -> &DatabaseConnection {
        &self.db
    }

    /// カード以外の知らせを、そのアカウントのブラウザへ配る（設計§11）。
    ///
    /// 配り方は [`Self::publish`] と同じ——**連絡係にも流す**ので、別のインスタンスに
    /// 繋いでいるブラウザにも届く。呼ぶ側は**記録へ書けてから**呼ぶこと。
    pub fn announce_account(&self, account_id: Uuid, message: ServerMessage) {
        self.publish(account_id, message);
    }

    /// 一覧の更新通知を購読する。**どのアカウントのぶんかは受け取る側が捨てる。**
    ///
    /// **購読を始めてから [`Self::list`] を呼ぶ**こと。逆順にすると、その隙間に起動した
    /// セッションを取りこぼす（順序を守れば重複するだけで、upsert は重複しても害がない）。
    pub fn subscribe_events(&self) -> broadcast::Receiver<AccountEvent> {
        self.events.subscribe()
    }

    /// 札の失効を購読する（札で入った `/ws` 接続が自分を畳むため。コードレビュー対応3）。
    pub fn subscribe_revocations(&self) -> broadcast::Receiver<Uuid> {
        self.revocations.subscribe()
    }

    /// 札の失効を知らせる。呼ぶのは revoke の口だけ。
    pub fn broadcast_revocation(&self, token_id: Uuid) {
        // 受け手（札で入った接続）が1つも居ないのは正常な状態
        let _ = self.revocations.send(token_id);
    }

    /// そのアカウントのカード一覧を、**利用者が並べた順**に返す（設計§8-6）。
    ///
    /// 並びの正は `position`（並べ替え設計§2-3）。**カードの `position` は枠の中で
    /// 閉じている**ので、枠をまたぐと同じ番号が何度も出てくる——ここが返すのは
    /// アカウント全体の平らな一覧なので、枠が入れ子に並ぶわけではない。**枠ごとに
    /// まとめ直すのは画面の仕事**で、そのとき枠の中の相対順がこの並びで決まる。
    ///
    /// 同着は `created_at` で崩す。崩さないと、同じ番号のカードの前後が呼ぶたびに
    /// 変わる（`HashMap` を辿っているため）。
    pub fn list(&self, account_id: Uuid) -> Vec<SessionMeta> {
        let mut metas: Vec<SessionMeta> = self
            .records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .filter(|record| record.account_id == account_id)
            .map(|record| record.meta())
            .collect();
        metas.sort_by_key(|meta| (meta.position, meta.created_at));
        metas
    }

    /// 1つの枠の中で、カードの並びを**丸ごと**差し替える（並べ替え設計§9-1）。
    ///
    /// 枠は `(agent, project)` で名指す。**カードの `position` は枠の中で閉じている**ので、
    /// 書き換える行もその枠の中だけで済む。
    ///
    /// 断り方と、渡されなかったカードの扱いは枠の側（[`db::projects::reorder`]）と同じ
    /// ——**1つでも知らない ID があれば1行も書かない**／渡されなかったものは今の順の
    /// まま後ろへ続ける。
    pub async fn reorder_cards(
        &self,
        account_id: Uuid,
        agent_id: Option<AgentId>,
        project: &str,
        card_ids: &[CardId],
    ) -> Result<Result<(), db::projects::ReorderRefusal>, DbErr> {
        // いまの枠の中身を、並び順のまま取り出す
        let mut inside: Vec<SessionMeta> = self
            .list(account_id)
            .into_iter()
            .filter(|meta| meta.agent_id == agent_id && meta.project.0 == project)
            .collect();
        inside.sort_by_key(|meta| (meta.position, meta.created_at));

        let mut seen = std::collections::HashSet::new();
        for card_id in card_ids {
            if !seen.insert(*card_id) {
                return Ok(Err(db::projects::ReorderRefusal::Duplicate(card_id.0)));
            }
            if !inside.iter().any(|meta| meta.card_id == *card_id) {
                return Ok(Err(db::projects::ReorderRefusal::Unknown(card_id.0)));
            }
        }

        let tail = inside
            .iter()
            .map(|meta| meta.card_id)
            .filter(|card_id| !seen.contains(card_id));
        let ordered: Vec<CardId> = card_ids.iter().copied().chain(tail).collect();

        for (position, card_id) in ordered.iter().enumerate() {
            let position = i32::try_from(position).unwrap_or(i32::MAX);
            if inside
                .iter()
                .any(|meta| meta.card_id == *card_id && meta.position == position)
            {
                continue;
            }
            entity::sessions::Entity::update_many()
                .col_expr(entity::sessions::Column::Position, position.into())
                .filter(entity::sessions::Column::CardId.eq(card_id.0))
                .filter(entity::sessions::Column::AccountId.eq(account_id))
                .exec(&self.db)
                .await?;

            // **手元の写しも直して配る。** 直さないと、次の報告が来るまで一覧が古い並びの
            // ままになり、そのあいだに別のタブが並べ替えると古い値を土台に上書きされる
            if let Some(record) = self.get(*card_id) {
                let mut meta = record.meta();
                meta.position = position;
                self.announce_card(account_id, meta);
            }
        }
        Ok(Ok(()))
    }

    /// そのカードの持ち主。知らないカードなら `None`。
    ///
    /// 操作の可否（§8-6 の WS 操作の行）はこれ1つで判断する。**「実体が居るか」とは
    /// 別物**で、前回の起動が残した記録にも持ち主は居る。
    pub fn owner_of(&self, card_id: CardId) -> Option<Uuid> {
        self.get(card_id).map(|record| record.account_id)
    }

    /// 自分のカードとして扱ってよいときだけ記録を返す。
    ///
    /// **他人のカードと知らないカードを呼び分けない。** 分けると、IDを総当たりして
    /// 「そのカードは存在する」ことだけを調べられる。
    pub fn owned(&self, account_id: Uuid, card_id: CardId) -> Option<Arc<SessionRecord>> {
        self.get(card_id)
            .filter(|record| record.account_id == account_id)
    }

    /// そのアカウントが CLI セッションへ付けている名前（名前付け設計§4-2）。
    fn nickname_of(&self, account_id: Uuid, claude_session_id: ClaudeSessionId) -> Option<String> {
        self.nicknames
            .lock()
            .expect("ロックが壊れていない")
            .get(&(account_id, claude_session_id))
            .cloned()
    }

    /// その会話が**どの会話から分かれたか**（ブランチ設計§5-1）。枝でなければ `None`。
    fn branch_of(
        &self,
        account_id: Uuid,
        claude_session_id: ClaudeSessionId,
    ) -> Option<ClaudeSessionId> {
        self.branches
            .lock()
            .expect("ロックが壊れていない")
            .get(&(account_id, claude_session_id))
            .copied()
    }

    /// **その会話から分かれた枝**を1つ返す（ブランチ設計§4-3）。分かれていなければ `None`。
    ///
    /// [`Self::branch_of`] の逆引きで、**席を失った元の会話を辿り直す**ために要る。
    /// 印は「枝 → 分かれ元」の向きに持っているので、こちらは値のほうを探す。
    ///
    /// 同じ会話から何本も分かれていれば複数当たるが、**どれでもよい**——欲しいのは
    /// 枠（作業ディレクトリ・PC・権限モード）で、枝はどれも元と同じ枠に居る。
    fn branch_child_of(
        &self,
        account_id: Uuid,
        branched_from: ClaudeSessionId,
    ) -> Option<ClaudeSessionId> {
        self.branches
            .lock()
            .expect("ロックが壊れていない")
            .iter()
            .find(|((owner, _), 元)| *owner == account_id && **元 == branched_from)
            .map(|((_, 枝), _)| *枝)
    }

    /// **その会話に中身があるか**（ブランチ設計§3-8）。
    ///
    /// # なぜ席ではなく会話で問うのか
    ///
    /// 枝分かれの可否は「分かれる元の会話があるか」で決まる。ところが判定の材料を
    /// **席（カード）**から取ると、**呼び戻した直後の席では必ず空になる**——履歴の窓も
    /// 直前の応答もカードに紐づくので、新しい席は生まれたてで何も持たない。
    ///
    /// **枝分かれのたびに元の会話は新しい席へ移る**ので、これは「同じ親から2本目を
    /// 作れない」という形で出る（2026-09-08 に実運用で踏んだ）。**席が新しいだけで、
    /// 会話は空ではない。**
    ///
    /// # 迷ったら通す側へ倒す
    ///
    /// 誤って断ると**機能そのものが使えなくなる**（親を1つ用意して枝を何本も生やす、
    /// という本来の使い方が成立しない）。誤って通したときの代償は**試行が1回無駄になり、
    /// CLI が断る**だけである。**重さが違うので、分からないときは通す。**
    pub async fn conversation_has_content(
        &self,
        account_id: Uuid,
        claude_session_id: ClaudeSessionId,
    ) -> bool {
        // **枝の台帳は会話を鍵に持っており、同期で引ける**（ブランチ設計§5-2）。
        // しかも印は**呼び戻しより前**に書かれる（段取りの⑤が⑥より先）ので、
        // 2本目を作るときには必ず立っている——**時間に依らない。**
        //
        // - その会話が**枝である**：分かれ元の履歴を丸ごと引き継いでいる
        // - その会話から**枝が分かれている**：分かれられたのだから中身があった
        if self.branch_of(account_id, claude_session_id).is_some()
            || self
                .branch_child_of(account_id, claude_session_id)
                .is_some()
        {
            return true;
        }

        // 手元の記録。**その会話を指しているカードのどれか**が中身を持っていればよい
        // （乗り換えの履歴で複数のカードが同じ会話を指す）
        let 指しているカード: Vec<Arc<SessionRecord>> = self
            .records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .filter(|record| record.account_id == account_id)
            .filter(|record| record.meta().claude_session_id == Some(claude_session_id))
            .cloned()
            .collect();
        for record in &指しているカード {
            if record.has_transcript() || record.meta().last_assistant_message.is_some() {
                return true;
            }
        }

        // **記録（DB）まで見る。** 手元に写しが無いカード（起こし直す前の履歴）でも、
        // 履歴の行が残っていれば会話には中身がある
        let rows = entity::sessions::Entity::find()
            .filter(entity::sessions::Column::AccountId.eq(account_id))
            .filter(entity::sessions::Column::ClaudeSessionId.eq(claude_session_id.0))
            .all(&self.db)
            .await
            .unwrap_or_default();
        for row in rows {
            if row.last_assistant_message.is_some() {
                return true;
            }
            if db_transcript::next_seq(&self.db, CardId(row.card_id))
                .await
                .is_ok_and(|seq| seq > 0)
            {
                return true;
            }
        }
        false
    }

    /// 枝分かれの印を残す（ブランチ設計§5-2）。
    ///
    /// # 印が付くのは枝の側
    ///
    /// 鍵は**枝**の `ClaudeSessionId`、値は**分かれ元**。画面はこれを見て札を出し、
    /// 呼び戻しの宛先もここから引ける。
    ///
    /// # 書いてから配る
    ///
    /// 名前と同じ作法（設計§9-1）。手元の写しもここで揃え、**その会話を指している
    /// カードを全部**配り直す——1枚だけ配ると、乗り換えの履歴で残っている別のカードが
    /// 印の無いまま画面に居座る。
    pub async fn mark_branch(
        &self,
        account_id: Uuid,
        claude_session_id: ClaudeSessionId,
        branched_from: ClaudeSessionId,
    ) -> Result<(), String> {
        let row = entity::session_branches::ActiveModel {
            account_id: Set(account_id),
            claude_session_id: Set(claude_session_id.0),
            branched_from: Set(branched_from.0),
            created_at: Set(db::now_ms()),
        };
        entity::session_branches::Entity::insert(row)
            .on_conflict(
                OnConflict::columns([
                    entity::session_branches::Column::AccountId,
                    entity::session_branches::Column::ClaudeSessionId,
                ])
                .update_columns([
                    entity::session_branches::Column::BranchedFrom,
                    entity::session_branches::Column::CreatedAt,
                ])
                .to_owned(),
            )
            .exec(&self.db)
            .await
            .map_err(|err| format!("枝の印を保存できませんでした：{err}"))?;

        self.branches
            .lock()
            .expect("ロックが壊れていない")
            .insert((account_id, claude_session_id), branched_from);

        let 対象: Vec<Arc<SessionRecord>> = self
            .records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .filter(|record| record.account_id == account_id)
            .filter(|record| record.meta().claude_session_id == Some(claude_session_id))
            .cloned()
            .collect();
        for record in 対象 {
            let mut meta = record.meta();
            meta.branched_from = Some(branched_from);
            record.store_meta(meta);
            self.publish(
                account_id,
                ServerMessage::SessionUpsert {
                    session: Box::new(record.meta()),
                },
            );
        }
        Ok(())
    }

    /// **過去のセッションの一覧**（名前付け設計§6）。
    ///
    /// # `GET /api/sessions` では引けない
    ///
    /// あちらは外していないカードだけを返す。外したカードの行は残っているが、
    /// **読み込みから除かれている**（`Archived.eq(false)` で絞る）ので、記録から
    /// 直に引く道がここに要る。
    ///
    /// # 何を出さないか
    ///
    /// **実体があるカードが指しているセッション**（§6-4）。起こしても二重になるだけで、
    /// 利用者が求めているのは「戻ってこないもの」である。接続断・終了のカードが
    /// 指しているものは**出す**（あちらは「復旧」で戻すほうが自然だが、選べること
    /// 自体は妨げない）。
    ///
    /// # 枠で絞るのはここ
    ///
    /// `frame` を渡すと、その枠（PC と作業ディレクトリの組）のぶんだけ返す。
    /// **枠の「＋」は「この PJT で起こす」操作**なので、別の PJT のセッションを混ぜると
    /// 押した先に別の枠のカードができる。
    ///
    /// **画面側で絞らせない。** かつては全件返して画面が捨てていたが、
    /// **「どの枠か」の規則が2箇所に在る**うえ、件数の上限が枠を跨いで先に効くため、
    /// 枠あたり数件しか残らなかった（実測：75本 → 上限20 → 枠で絞って8件）。
    ///
    /// # 件数は切らない
    ///
    /// **上限は 2026-09-10 に外した**（かつては `cap_unnamed` が無名を20件へ切っていた）。
    /// 黙って落ちるので、利用者からは見失ったのと区別が付かなかった。上限が守っていた
    /// 「選べること」は**並び**で満たす——名前付きを先に出す。
    ///
    /// `exists` はここでは埋めない（PC に聞くのは呼ぶ側の仕事）。
    pub async fn past_sessions(
        &self,
        account_id: Uuid,
        frame: Option<(Option<protocol::AgentId>, &str)>,
    ) -> Result<Vec<protocol::PastSession>, DbErr> {
        // いま実体があるカードが指しているセッションは外す。**手元の記録から数える**
        // ——DB には「繋がっているか」が無い（読み出し時にかぶせる値）
        //
        // **`resumed_from` の側も数える。** 生きたカードが `--resume` した元の会話を
        // 一覧へ出すと、**同じ会話を2つのプロセスに開かせる**ことになる（§6-4）。
        // 出す側が2つの欄を見るようになったので、外す側も揃えないと片側だけ漏れる。
        let 生きている: std::collections::HashSet<ClaudeSessionId> = self
            .records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .filter(|record| record.account_id == account_id)
            .flat_map(|record| {
                let meta = record.meta();
                // 「実体がある」の裏は `revivable`（実体が無く戻す先がある）。
                // **同じ規則を二度書かない**
                if meta.revivable() {
                    return Vec::new();
                }
                [meta.claude_session_id, meta.resumed_from]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
            })
            .collect();

        let rows = entity::sessions::Entity::find()
            .filter(entity::sessions::Column::AccountId.eq(account_id))
            // **どちらか片方でも入っていれば拾う。** `claude_session_id` だけで絞ると、
            // 素の引き継ぎ（`resume`）で起こして**フックが1件も来ないまま終わったカード**が
            // 落ちる——`claude_session_id` は最初のフックが確定させるので空のままだが、
            // `resumed_from` には頼んだ会話が入っている。**履歴が消えていたときに
            // まさにこの形になる**ので、いちばん拾いたい行が落ちていた
            .filter(
                Condition::any()
                    .add(entity::sessions::Column::ClaudeSessionId.is_not_null())
                    .add(entity::sessions::Column::ResumedFrom.is_not_null()),
            )
            .order_by_desc(entity::sessions::Column::LastActivityAt)
            .all(&self.db)
            .await?;

        let nicknames = load_nicknames(&self.db, Some(account_id))
            .await
            .unwrap_or_default();

        // 同じ CLI セッションを指す行を1つに畳む。**新しいほうを採る**——
        // 並びが降順なので、最初に見たものが最新
        let mut 畳んだ: Vec<protocol::PastSession> = Vec::new();
        let mut 見た = std::collections::HashSet::new();
        // **id を本当に持つ行を先に通し、借用はそのあと。**
        //
        // | 段 | 何を出すか |
        // |---|---|
        // | 1段目 | 行の `claude_session_id`。**その会話の本当の持ち主**（題も活動時刻も本物） |
        // | 2段目 | 行の `resumed_from`。**持ち主が居ないときだけ**、枠を借りて出す |
        //
        // **順序が要る理由。** 並びは最終活動の新しい順なので、素直に1行ずつ2つ出すと
        // **`--resume` した新しいカードのほうが先に来て、借り物の項目が本物を押しのける**
        // ——元の会話が自分の題を失い、`aabbccdd…` と出る。実際に呼び戻せはするが、
        // **何を呼び戻すのか読めなくなる。**
        for row in &rows {
            let Some(session) = row.claude_session_id.map(ClaudeSessionId) else {
                continue;
            };
            if 生きている.contains(&session) || !見た.insert(session) {
                continue;
            }
            畳んだ.push(protocol::PastSession {
                claude_session_id: session,
                nickname: nicknames.get(&(account_id, session)).cloned(),
                session_title: row.session_title.clone(),
                project: ProjectId(row.project.clone()),
                agent_id: row.agent_id.map(protocol::AgentId),
                permission_mode: row.permission_mode.clone().map(PermissionMode::new),
                last_activity_at: row.last_activity_at,
                exists: None,
            });
        }
        // 2段目：**張り替えで持ち主を失った会話**を、頼んだ側の記録から出す。
        //
        // ここへ来るのは「`--resume` で頼んだのに、そのIDを持つ行がどこにも無い」
        // ものだけである——`--resume` した claude が別のIDを名乗った、まさにその形。
        // とくに `revive` は同じカードを使い回すため、上書きされるのが
        // **その会話が持つ唯一の行**になる。
        for row in &rows {
            let Some(頼んだ会話) = row.resumed_from.map(ClaudeSessionId) else {
                continue;
            };
            if 生きている.contains(&頼んだ会話) || !見た.insert(頼んだ会話) {
                continue;
            }
            畳んだ.push(protocol::PastSession {
                claude_session_id: 頼んだ会話,
                nickname: nicknames.get(&(account_id, 頼んだ会話)).cloned(),
                // **題は貼らない。** 題は CLI が**いまの会話**に付けたものなので、
                // 元の会話に貼ると別の会話の題を名乗ることになる
                // （`past_session_of` の枝の迂回が同じ理由で `None` を置いている）
                session_title: None,
                // 枠（PC・作業ディレクトリ・権限モード）は借りる。**元の会話は
                // 必ず同じ枠に居る**——同じカードが `--resume` したのだから
                project: ProjectId(row.project.clone()),
                agent_id: row.agent_id.map(protocol::AgentId),
                permission_mode: row.permission_mode.clone().map(PermissionMode::new),
                // **活動時刻も借り物である。** 元の会話の本当の最終活動は、行が
                // 無い以上どこにも残っていない。借りているのは「その会話が最後に
                // 呼び戻された時刻」で、**本人が最後に喋った時刻ではない**——
                // 並びがこれで決まるので、借り物だと分かるように書いておく
                last_activity_at: row.last_activity_at,
                exists: None,
            });
        }

        // **`resumed_from` が入る前に壊れた行を、枝の印から救う。**
        //
        // 上の `resumed_from` は**これから起こすものにしか入らない**ので、欄を足す前に
        // 張り替えで行を失った会話は救えない（実測で1本。`ブランチの親_2026-0908`）。
        // **枝の印だけは「枝 → 分かれ元」を覚えている**ので、そこから辿り直せる。
        //
        // # 規則を二重に持たない
        //
        // 組み立ては [`Self::past_session_of`] をそのまま呼ぶ。**同じ迂回を2箇所に
        // 書くと、片方だけ直したときに「一覧には出るのに呼び戻せない」（またはその逆）
        // が起きる。**
        //
        // # これは再発を防ぐ手ではない
        //
        // 枝の台帳に載らない経路（`revive` など）は救えない。**再発を止めるのは
        // `resumed_from` の側**で、こちらは既に失われたものを拾うだけである。
        //
        // # 問い合わせる前に、手元で削る
        //
        // 組み立ては1件ずつ DB を引く（`past_session_of` → `past_row`）。**一覧は
        // 画面を開くたびに引かれる**ので、枝の本数だけ問い合わせが増えると効いてくる。
        //
        // **手元にある `rows` で先に落とせる**——行を持っている親はそもそも救う必要が
        // 無いので、問い合わせに行くのは「本当にどこにも行が無いもの」だけになる。
        // 実測（2026-09-10）：枝の親7本のうち、ここへ残るのは1本。
        let 行がある: std::collections::HashSet<ClaudeSessionId> = rows
            .iter()
            .filter_map(|row| row.claude_session_id.map(ClaudeSessionId))
            .collect();
        let 行を失った親: Vec<ClaudeSessionId> = {
            let branches = self.branches.lock().expect("ロックが壊れていない");
            branches
                .iter()
                .filter(|((owner, _), _)| *owner == account_id)
                .map(|((_, _), 元)| *元)
                .filter(|元| {
                    !生きている.contains(元) && !見た.contains(元) && !行がある.contains(元)
                })
                .collect()
        };
        for 親 in 行を失った親 {
            // 同じ親から枝が何本も出ていることがあるので、ここでも重複を弾く
            if !見た.insert(親) {
                continue;
            }
            if let Some(past) = self.past_session_of(account_id, 親).await? {
                畳んだ.push(past);
            }
        }

        // **名前付きを先に、その中で最終活動の新しい順に整える。**
        //
        // 上の2つ（頼んだ会話・枝から救った親）は行の並びに乗らないので、足したままだと
        // 末尾に固まる。並べ直しはそのためにも要る。
        //
        // # 名前付きを先にするのは、上限を外した代わりである
        //
        // かつては無名を20件で切っていた（`cap_unnamed`）。**「付けた行為が『また使う』の
        // 意思表示だから名前付きは切らない」という判断は正しかったので、それを件数では
        // なく順序で表す。** 捨てずに、探しやすいところへ置く。
        畳んだ.sort_by(|a, b| {
            b.nickname
                .is_some()
                .cmp(&a.nickname.is_some())
                .then(b.last_activity_at.cmp(&a.last_activity_at))
        });

        // 枠を指定されたら、その枠のぶんだけ残す。**畳んだあとに絞る**——先に絞ると、
        // 同じセッションを指す別の枠のカードのほうが新しいときに取り違える
        if let Some((agent_id, project)) = frame {
            畳んだ.retain(|past| past.agent_id == agent_id && past.project.0 == project);
        }
        Ok(畳んだ)
    }

    // **`cap_unnamed`（無名を最近20件へ切り詰める関数）は 2026-09-10 に消した。**
    //
    // 「名前を付けたものは切らない」という判断そのものは正しかった——付けた行為が
    // 「また使う」の意思表示だからである。**その判断は並びのほうへ移した**
    // （[`Self::past_sessions`] が名前付きを先に並べる）。**件数で捨てるのをやめ、
    // 順序で表す形にした。**
    //
    // 消した理由は `ws.rs` の該当箇所に書いてある（黙って落ちるので、利用者からは
    // 見失ったのと区別が付かない）。

    /// 過去のセッションを**1本だけ**引く（名前付け設計§7・§11-4）。
    ///
    /// # `account_id` を必ず条件に入れる
    ///
    /// この口を使う `RecallSession` は**カードIDを運ばない**ので `target_card` の門が
    /// 効かない。ここで絞らないと、**他人のセッションを起こせてしまう**。
    ///
    /// 一覧（[`Self::past_sessions`]）と違い、**実体があるかは見ない**。押した時点で
    /// 走っていたとしても、新しいカードで起こすこと自体は成立する。
    pub async fn past_session_of(
        &self,
        account_id: Uuid,
        claude_session_id: ClaudeSessionId,
    ) -> Result<Option<protocol::PastSession>, DbErr> {
        if let Some(past) = self.past_row(account_id, claude_session_id).await? {
            return Ok(Some(past));
        }

        // **枝がカードを乗っ取ると、元の会話は記録から引けなくなる**（ブランチ設計§4-3）。
        // カードの行は枝のIDで上書きされるので、元のIDを持つ行が1つも残らない。
        //
        // **そのままだと、席を失った利用者に戻る道が無い**——断りの「もう一度呼び戻す」も
        // `session recall` も「見つかりません」で終わる（2026-09-07 に実機で踏んだ）。
        //
        // **枝の印は「どの会話から分かれたか」を覚えている**ので、そこから枝を辿り、
        // **枝の枠を借りて**元の会話を呼び戻せる形にする。枝は必ず元と同じ枠に居る。
        let Some(枝の会話) = self.branch_child_of(account_id, claude_session_id) else {
            return Ok(None);
        };
        let Some(mut past) = self.past_row(account_id, 枝の会話).await? else {
            return Ok(None);
        };
        // 借りたのは枠だけ。**中身は元の会話のもの**へ差し替える
        past.claude_session_id = claude_session_id;
        past.nickname = self.nickname_of(account_id, claude_session_id);
        past.session_title = None;
        Ok(Some(past))
    }

    /// `sessions` の行から1件だけ組み立てる（[`Self::past_session_of`] の素）。
    async fn past_row(
        &self,
        account_id: Uuid,
        claude_session_id: ClaudeSessionId,
    ) -> Result<Option<protocol::PastSession>, DbErr> {
        let row = entity::sessions::Entity::find()
            .filter(entity::sessions::Column::AccountId.eq(account_id))
            .filter(entity::sessions::Column::ClaudeSessionId.eq(claude_session_id.0))
            .order_by_desc(entity::sessions::Column::LastActivityAt)
            .one(&self.db)
            .await?;
        Ok(row.map(|row| protocol::PastSession {
            claude_session_id,
            nickname: self.nickname_of(account_id, claude_session_id),
            session_title: row.session_title,
            project: ProjectId(row.project),
            agent_id: row.agent_id.map(protocol::AgentId),
            permission_mode: row.permission_mode.map(PermissionMode::new),
            last_activity_at: row.last_activity_at,
            exists: None,
        }))
    }

    // ── メモ（メモ設計§9-1「書いてから配る」）─────────────────
    //
    // **SQL は持たない。** 読み書きの本体は `db::memos` にあり、ここがやるのは
    // 「書いて、宛先ぶんを引き直して、配る」の3つだけである。
    //
    // **なぜ受け口（`ws.rs`）から直に `db::memos` を呼ばないのか**——`db` も
    // `publish` も記録層の私有で、外へ出すと「書かずに配る」経路が作れてしまう。
    // 書いてから配ることを型で守るため、入口をここ1つに絞ってある。

    /// 宛先を記録の2列へ開く。**全体は「セッションIDが空」まで含めて宛先である。**
    fn memo_target(target: &AnnotationTarget) -> (&'static str, Option<Uuid>) {
        match target {
            AnnotationTarget::Global => (db::memos::TARGET_GLOBAL, None),
            AnnotationTarget::Session { claude_session_id } => {
                (db::memos::TARGET_SESSION, Some(claude_session_id.0))
            }
        }
    }

    fn memo_view(row: &db::entity::memos::Model) -> MemoView {
        MemoView {
            id: MemoId(row.id),
            body: row.body.clone(),
            noted_at: row.noted_at,
            checked_at: row.checked_at,
        }
    }

    /// 宛先ぶんを引き直して配る。**書いたあとは必ずここを通る。**
    ///
    /// 1件ずつ差分で配らないのは、**1件の編集でその1件が段をまたいで動く**ため
    /// （§7-1）。差分にすると受け手が並べ直すことになり、並びを決める場所が2つに割れる。
    async fn memo_fanout(&self, account_id: Uuid, target: AnnotationTarget) -> Result<(), String> {
        let (kind, session) = Self::memo_target(&target);
        let rows = db::memos::list(&self.db, account_id, kind, session)
            .await
            .map_err(|err| format!("メモを読めませんでした：{err}"))?;
        let memos = rows.iter().map(Self::memo_view).collect();
        self.publish(account_id, ServerMessage::Memos { target, memos });
        Ok(())
    }

    /// 宛先ぶんを配る（読むだけ）。
    pub async fn memo_list(
        &self,
        account_id: Uuid,
        target: AnnotationTarget,
    ) -> Result<(), String> {
        self.memo_fanout(account_id, target).await
    }

    /// 1行積んで配る。**時刻は記録層が打つ**（端末から受け取らない・§7-2）。
    pub async fn memo_add(
        &self,
        account_id: Uuid,
        target: AnnotationTarget,
        body: serde_json::Value,
    ) -> Result<(), String> {
        let (kind, session) = Self::memo_target(&target);
        db::memos::add(&self.db, account_id, kind, session, body)
            .await
            .map_err(|err| format!("メモを保存できませんでした：{err}"))?;
        self.memo_fanout(account_id, target).await
    }

    /// 本文を書き換えて配る。**内容が変わったときだけ時刻が動く**（§7-3）。
    ///
    /// 宛先は**書き換えた行から引く**——引数で受けると、画面が抱えている古い写しで
    /// 別の宛先へ配れてしまう。
    pub async fn memo_edit(
        &self,
        account_id: Uuid,
        id: MemoId,
        body: serde_json::Value,
    ) -> Result<(), String> {
        let updated = db::memos::edit(&self.db, account_id, id.0, body)
            .await
            .map_err(|err| format!("メモを保存できませんでした：{err}"))?;
        // 見つからないのと他人のものを指したのは**同じ答え**になる（存在を当てさせない）
        let Some(row) = updated else {
            return Err(MEMO_NOT_FOUND.to_string());
        };
        self.memo_fanout(account_id, Self::memo_annotation(&row))
            .await
    }

    /// チェックを付ける／外して配る（§7-5）。
    pub async fn memo_check(
        &self,
        account_id: Uuid,
        id: MemoId,
        checked: bool,
    ) -> Result<(), String> {
        let updated = db::memos::check(&self.db, account_id, id.0, checked)
            .await
            .map_err(|err| format!("メモを保存できませんでした：{err}"))?;
        let Some(row) = updated else {
            return Err(MEMO_NOT_FOUND.to_string());
        };
        self.memo_fanout(account_id, Self::memo_annotation(&row))
            .await
    }

    /// 1件消して配る（§7-8）。
    ///
    /// **消す前に宛先を引く。** 消してからでは、どの宛先を配り直せばよいか分からない。
    pub async fn memo_remove(&self, account_id: Uuid, id: MemoId) -> Result<(), String> {
        let found = db::memos::find(&self.db, account_id, id.0)
            .await
            .map_err(|err| format!("メモを読めませんでした：{err}"))?;
        let Some(row) = found else {
            return Err(MEMO_NOT_FOUND.to_string());
        };
        let target = Self::memo_annotation(&row);
        db::memos::remove(&self.db, account_id, id.0)
            .await
            .map_err(|err| format!("メモを消せませんでした：{err}"))?;
        self.memo_fanout(account_id, target).await
    }

    /// 記録の2列から宛先へ畳み直す。
    fn memo_annotation(row: &db::entity::memos::Model) -> AnnotationTarget {
        match row.target_session_id {
            Some(id) => AnnotationTarget::Session {
                claude_session_id: ClaudeSessionId(id),
            },
            None => AnnotationTarget::Global,
        }
    }

    /// カードに付いている CLI セッションへ、利用者の名前を付ける（名前付け設計§5）。
    ///
    /// # 宛先はカードから引く
    ///
    /// 呼ぶ側はカードIDしか渡さない。**ブラウザに `ClaudeSessionId` を持たせると、
    /// 画面が抱えている古い写しで別のセッションへ書ける**（設計§5-1）。
    ///
    /// # 名前が付くのはカードではなくセッション
    ///
    /// したがって、**同じセッションを指しているカードすべて**の表示が変わる。配り直しも
    /// その全部に対して行う——1枚だけ配ると、乗り換えの履歴で残っている別のカードが
    /// 古い名前のまま画面に居座る。
    ///
    /// # 消すときは行ごと消す
    ///
    /// 空文字を入れない。「付いていない」と「空の名前が付いている」を記録の上で
    /// 区別しないため（設計§10）。
    pub async fn set_nickname(
        &self,
        account_id: Uuid,
        card_id: CardId,
        raw: Option<&str>,
    ) -> Result<(), String> {
        let record = self
            .owned(account_id, card_id)
            .ok_or_else(|| NOT_FOUND.to_string())?;
        let claude_session_id = record.meta().claude_session_id.ok_or_else(|| {
            "まだ名前を付けられません（このセッションのIDが決まっていません）".to_string()
        })?;

        // 断るのは保存側の仕事。画面だけで止めると CLI から入る（設計§10）
        let nickname = match raw {
            Some(text) => protocol::normalize_nickname(text)?,
            None => None,
        };

        let now = db::now_ms();
        let key = (account_id, claude_session_id);
        match &nickname {
            Some(name) => {
                let row = entity::session_nicknames::ActiveModel {
                    account_id: Set(account_id),
                    claude_session_id: Set(claude_session_id.0),
                    nickname: Set(name.clone()),
                    updated_at: Set(now),
                };
                entity::session_nicknames::Entity::insert(row)
                    .on_conflict(
                        OnConflict::columns([
                            entity::session_nicknames::Column::AccountId,
                            entity::session_nicknames::Column::ClaudeSessionId,
                        ])
                        .update_columns([
                            entity::session_nicknames::Column::Nickname,
                            entity::session_nicknames::Column::UpdatedAt,
                        ])
                        .to_owned(),
                    )
                    .exec(&self.db)
                    .await
                    .map_err(|err| format!("名前を保存できませんでした：{err}"))?;
            }
            None => {
                entity::session_nicknames::Entity::delete_many()
                    .filter(entity::session_nicknames::Column::AccountId.eq(account_id))
                    .filter(
                        entity::session_nicknames::Column::ClaudeSessionId.eq(claude_session_id.0),
                    )
                    .exec(&self.db)
                    .await
                    .map_err(|err| format!("名前を消せませんでした：{err}"))?;
            }
        }

        // **書いてから配る**（設計§9-1）。手元の写しもここで揃える
        {
            let mut map = self.nicknames.lock().expect("ロックが壊れていない");
            match &nickname {
                Some(name) => map.insert(key, name.clone()),
                None => map.remove(&key),
            };
        }

        // 同じセッションを指しているカードを**全部**配り直す。`Status` の差分は名前を
        // 運ばないので、丸ごと（`SessionUpsert`）配る（設計§5-4）
        let affected: Vec<Arc<SessionRecord>> = self
            .records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .filter(|record| record.account_id == account_id)
            .filter(|record| record.meta().claude_session_id == Some(claude_session_id))
            .cloned()
            .collect();
        for record in affected {
            let mut meta = record.meta();
            meta.nickname = nickname.clone();
            record.store_meta(meta);
            self.publish(
                account_id,
                ServerMessage::SessionUpsert {
                    session: Box::new(record.meta()),
                },
            );
        }
        Ok(())
    }

    /// その PC のカードの**鮮度の印**を切り替えて配り直す（設計§6-3）。
    ///
    /// **`status` は書き換えない。** 切断は「最後に知っていた状態」を上書きする情報では
    /// なく、その鮮度に関する情報だから（§3-1）。画面には「作業中（接続断）」と出る。
    ///
    /// DB にも書かない（§20 読み替え4）。接続はインスタンスローカルの事実で、保存すると
    /// **落ちた瞬間の値が残る**——次に起動したサーバが「繋がっている」と信じてしまう。
    pub fn set_agent_live(&self, agent_id: AgentId, live: bool) {
        let all: Vec<Arc<SessionRecord>> = self
            .records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .cloned()
            .collect();
        for record in all {
            let meta = record.meta();
            if meta.agent_id != Some(agent_id) || meta.agent_connected == live {
                continue;
            }
            record.live.store(live, Ordering::Relaxed);
            self.publish(
                record.account_id,
                ServerMessage::SessionUpsert {
                    session: Box::new(record.meta()),
                },
            );
        }
    }

    /// 一覧の更新を配る。**誰のカードの話かを必ず添える**（設計§8-6）。
    ///
    /// 自分のブラウザへ配ってから、連絡係にも流す（設計§9-2）。順序がこうなのは、
    /// **手元の配信を跨ぎの都合で遅らせない**ため。連絡係が居なければ後半は何もしない。
    fn publish(&self, account_id: Uuid, message: ServerMessage) {
        self.publish_bus(account_id, &message);
        self.publish_local(account_id, message);
    }

    /// アプリ全体の知らせを記録へ積み、積めたら未読の数と一緒に配る（設計§4-2・§6-1）。
    ///
    /// # 失敗しても `Err` を返さない
    ///
    /// **書けなくても、リアルタイムの配信は続ける**（設計§4-3）。`Err` を返すと
    /// [`Self::apply`] の失敗側が「記録を保存できませんでした」を**同じ経路で**知らせに
    /// 行き、それがまた記録を試みる——**DB が落ちているときに DB へ書きに行く輪**になる。
    ///
    /// **知らせは、残すことよりも届くことが先である。**
    async fn record_notice(
        &self,
        origin: &ReportOrigin,
        card_id: Option<Uuid>,
        source: &str,
        kind: &str,
        message: &str,
    ) {
        let now = db::now_ms();
        let row = match db::notices::push(
            &self.db,
            origin.account_id,
            card_id,
            source,
            kind,
            message,
            now,
        )
        .await
        {
            Ok(row) => row,
            Err(err) => {
                tracing::warn!("知らせを記録できませんでした: {err}");
                return;
            }
        };

        // **未読の数を同梱する。** そうしないと、1件届くたびにバッジのために
        // 数えに行くことになる（設計§6-1）
        let unread = db::notices::unread_count(&self.db, origin.account_id)
            .await
            .unwrap_or_default();

        self.publish(
            origin.account_id,
            ServerMessage::NoticeCreated {
                notice: notice_view(row),
                unread_count: unread as u32,
            },
        );
    }

    /// このインスタンスの中だけへ配る。
    ///
    /// **他インスタンスから回ってきたものはこちらを使う。** `publish` を使うと、
    /// 受け取ったものをそのまま配り直し、それがまた返ってきて止まらなくなる。
    fn publish_local(&self, account_id: Uuid, message: ServerMessage) {
        // **配る前に残す**（実装レビュー Astra 4）。手元からの報告（`publish`）も、
        // 他インスタンスから回ってきたもの（`adopt`）もここを通るので、残すのは1箇所で足りる。
        // 待つ側が取りこぼした後に引いても、配ったものは必ず残っている
        if let Some((card_id, ops, 理由)) = revive_refusal_of(&message) {
            self.note_revive_refusal(account_id, card_id, ops, 理由);
        }
        // 番号付きの答えも配る前に控える（実装レビュー第7回 Astra 4）。配信を取りこぼした接続が
        // 番号で引き直す（[`Self::op_answer`]）
        self.ops
            .lock()
            .expect("ロックが壊れていない")
            .record(account_id, &message);
        let _ = self.events.send(AccountEvent {
            account_id,
            message,
        });
    }

    /// 起こし直しの終わった断りを、そのカードの記録へ残す（実装レビュー Astra 4）。
    ///
    /// **記録が無ければ残さない。** 外したカードの断りを引く者は居ない（待っている側は
    /// 記録が消えたこと自体で終わる）。持ち主の違うカードにも残さない（§8-6）。**番号の無い
    /// 断りも残さない**——番号で引くので、誰にも引かれない（実装レビュー第6回 Astra 3）。
    fn note_revive_refusal(&self, account_id: Uuid, card_id: CardId, ops: &[OpId], 理由: &str) {
        if ops.is_empty() {
            return;
        }
        let Some(record) = self.owned(account_id, card_id) else {
            return;
        };
        let mut refusals = record.revive_refusals.lock().expect("ロックが壊れていない");
        refusals.push_front((ops.to_vec(), 理由.to_string()));
        refusals.truncate(REVIVE_REFUSALS_KEPT);
    }

    /// 頼み `op` に答えた、そのカードの起こし直しの終わった断り（実装レビュー第6回 Astra 3）。
    ///
    /// 配信を取りこぼした待ち手が、**配られたはずの断りを引き直す**ための口。他の頼みへの
    /// 断り（前に押した人の・後から受け付けた別の起こし直しの）は返さない。
    pub fn revive_refusal_for(
        &self,
        account_id: Uuid,
        card_id: CardId,
        op: OpId,
    ) -> Option<String> {
        let record = self.owned(account_id, card_id)?;
        let refusals = record.revive_refusals.lock().expect("ロックが壊れていない");
        refusals
            .iter()
            .find(|(ops, _)| ops.contains(&op))
            .map(|(_, 理由)| 理由.clone())
    }

    /// 番号付きの頼みを受け付けたことを控える（実装レビュー第7回 Astra 3・4。[`OpLedger`]）。
    ///
    /// **持ち主の門を通した後に呼ぶ**（`ws.rs` の `handle_request`）。ここで控えた持ち主が、
    /// 他のインスタンスから回ってきた答えを手元へ配ってよいかの確かめになる（カードの記録が
    /// 先に外れていても）。**頼みを送り出す前に呼ぶ**——答えがその場で返る道（ローカルの
    /// 「何も無かった」など）でも控えから漏れない。
    pub fn accept_op(&self, account_id: Uuid, card_id: CardId, op: OpId) {
        self.ops
            .lock()
            .expect("ロックが壊れていない")
            .accept(account_id, card_id, op);
    }

    /// 控えた答えの本体が運ぶ番号の数の合計（**テスト専用**。実装レビュー第10回 Astra 2）。本体を
    /// 番号ごとに写すと、束ねた番号の数の2乗になる。
    #[doc(hidden)]
    pub fn 控えの答えが持つ番号の数(&self) -> usize {
        self.ops
            .lock()
            .expect("ロックが壊れていない")
            .kept_answer_ops()
    }

    /// 受け付けた頼み `op` への答え（実装レビュー第7回 Astra 4）。まだ答えが無ければ `None`。
    ///
    /// 配信を取りこぼした接続が、**配られたはずの答えを引き直す**ための口。他のアカウントの
    /// 頼みの答えは返さない。カードの記録が外れていても返す（答えは記録と別に控えてある）。
    pub fn op_answer(&self, account_id: Uuid, op: OpId) -> Option<ServerMessage> {
        self.ops
            .lock()
            .expect("ロックが壊れていない")
            .answer(account_id, op)
    }

    /// 起こし直しの頼み（番号付き）への PC の成功の答えを配る（実装レビュー第6回）。
    ///
    /// 配る形は終了と同じ——記録のいまの状態に番号を添えた `Status`。**状態は合否に使わない**
    /// （起動直後に落ちた実体なら `Ended` で届きうるが、起こせたこと自体は本当である）。失敗の
    /// 答えは PC の断り（`Error{ops}`）がそのまま運ぶので、ここは通らない。
    ///
    /// 記録が無い（答えが届く前に外された）ときは、番号付きの断りにする。黙って捨てると、
    /// 待っている CLI は上限まで待つ。
    pub fn answer_revive(&self, origin: &ReportOrigin, card_id: CardId, op: OpId) {
        let Some(record) = self.owned(origin.account_id, card_id) else {
            self.publish(
                origin.account_id,
                ServerMessage::Error {
                    card_id: Some(card_id),
                    message: "一覧から外されたので、起こし直しを確かめられません".to_string(),
                    kind: ErrorKind::Revive,
                    busy: None,
                    withdrawn: None,
                    ops: vec![op],
                },
            );
            return;
        };
        let meta = record.meta();
        self.publish(
            origin.account_id,
            ServerMessage::Status {
                card_id,
                status: meta.status,
                subagent_active: meta.subagent_active,
                last_activity_at: meta.last_activity_at,
                op: Some(op),
            },
        );
    }

    /// 終了の頼み（番号付き）への PC の答えを、合否にして配る（実装レビュー第6回 Astra 1・2）。
    ///
    /// PC は「何をしたか」だけを言う（[`KillOutcome`]）。**合否はここで決める**：
    ///
    /// | PC の答え | 配るもの |
    /// |---|---|
    /// | 取り下げた・止めた・既に終わっていた | 記録のいまの状態に番号を添えた `Status`（成功） |
    /// | 何も無かった | カードの記録が終わっていれば成功、そうでなければ番号付きの断り |
    /// | 知らない綴り | 番号付きの断り（成功とは読まない） |
    ///
    /// 「何も無かった」を PC の側で合否にしないのは、前回の起動が残した抜け殻（止めるものが
    /// 無くて当然）と、記録の上では動いているのに PC に実体が無い食い違いを、PC は見分けられない
    /// ため。以前は CLI が接続直後の写しで見分けていたが、写しは頼む前の姿で、届かなかった
    /// 頼みの断りまで成功に変えていた。
    ///
    /// **連絡係にも流す**（`publish`）。CLI が別のインスタンスに繋がっていても届くように。
    /// 成功の `Status` の値は記録のいまの姿なので、番号を知らない画面が受けても何も変わらない。
    /// 止めた実体の `Ended` は答えより先に同じ順の道で届いて記録に書かれている（ローカルは
    /// `ReportingSink` の1本の列、セルフホストは PC の送り出しの1本の列）が、**合否には状態を
    /// 使わない**——答えが番号付きで届いたこと自体が根拠である。
    pub fn answer_kill(
        &self,
        origin: &ReportOrigin,
        card_id: CardId,
        op: OpId,
        outcome: KillOutcome,
    ) {
        let refuse = |message: &str| {
            self.publish(
                origin.account_id,
                ServerMessage::Error {
                    card_id: Some(card_id),
                    message: message.to_string(),
                    kind: ErrorKind::Kill,
                    busy: None,
                    withdrawn: None,
                    ops: vec![op],
                },
            );
        };
        // 記録が無い（外した・持ち主違い）。状態を添えられないので、確かめられなかったと言う
        let Some(record) = self.owned(origin.account_id, card_id) else {
            refuse("一覧から外されたので、終了を確かめられません");
            return;
        };
        let meta = record.meta();
        let ended = matches!(meta.status, SessionStatus::Ended { .. });
        let 止まった = match outcome {
            KillOutcome::Withdrew | KillOutcome::Stopped | KillOutcome::AlreadyEnded => true,
            KillOutcome::Nothing => ended,
            KillOutcome::Unknown => false,
        };
        if !止まった {
            refuse(match outcome {
                KillOutcome::Nothing => {
                    "セッションが見つかりません（PC にこのカードの実体がありません）"
                }
                _ => "PC の答えを読めませんでした（session ls で確かめられます）",
            });
            return;
        }
        self.publish(
            origin.account_id,
            ServerMessage::Status {
                card_id,
                status: meta.status,
                subagent_active: meta.subagent_active,
                last_activity_at: meta.last_activity_at,
                op: Some(op),
            },
        );
    }

    /// いま繋がっている全ブラウザへ知らせる（連絡係の縮退など、カードに紐づかない話）。
    ///
    /// **連絡係へは流さない。** 縮退はインスタンスごとの事実で、しかも流す相手が
    /// 切れているときに出す知らせなので、跨いで配ること自体が成り立たない。
    pub fn announce(&self, message: ServerMessage) {
        let accounts: Vec<Uuid> = self
            .browsers
            .lock()
            .expect("ロックが壊れていない")
            .keys()
            .copied()
            .collect();
        for account_id in accounts {
            self.publish_local(account_id, message.clone());
        }
    }

    /// 連絡係がいま繋がっているか。**持っていなければ `None`**（縮退という概念が無い）。
    pub fn bus_state(&self) -> Option<crate::bus::BusState> {
        self.bus.as_ref().map(|bus| *bus.state().borrow())
    }

    /// 連絡係へ流す（他インスタンスのブラウザ向け）。
    fn publish_bus(&self, account_id: Uuid, message: &ServerMessage) {
        let Some(bus) = &self.bus else {
            return;
        };
        bus.publish(
            &bus::account_events(account_id),
            bus::encode_json(
                self.instance_id,
                &bus::AccountMessage::Event(Box::new(message.clone())),
            ),
        );
    }

    /// 「いま持っているカードを名乗り直してほしい」と頼む（設計§6-4 のサーバ版）。
    ///
    /// 立ち上げ直した直後は、**どのカードが生きているかを知らない**。動きの無い
    /// セッションは報告を出さないので、待っていても来ない。
    pub fn request_resync(&self, account_id: Uuid) {
        let Some(bus) = &self.bus else {
            return;
        };
        bus.publish(
            &bus::account_events(account_id),
            bus::encode_json(self.instance_id, &bus::AccountMessage::Resync),
        );
    }

    /// そのカードの記録へ、外から「いまの姿」を入れ直す（名乗り直しの受け口）。
    pub fn announce_card(&self, account_id: Uuid, meta: SessionMeta) {
        let Some(record) = self.owned(account_id, meta.card_id) else {
            return;
        };
        record.store_meta(meta);
        self.publish(
            account_id,
            ServerMessage::SessionUpsert {
                session: Box::new(record.meta()),
            },
        );
    }

    /// 他インスタンスから回ってきた知らせを取り込む（設計§9-2）。
    ///
    /// # ここでは DB へ書かない
    ///
    /// 書いたのは発信元のインスタンスで、真実はもう DB にある。二重に書くと、
    /// 履歴の通し番号（`seq`）が両方で進んで**並びが飛ぶ**。ここでやるのは、
    /// このインスタンスのブラウザへ見せるための手元の写しを合わせることだけ。
    ///
    /// **持ち主はチャネル名で決まる**（`account_id` は呼び出し側が名前から取る）。
    /// 封筒の中身を信じると、名前でアカウントを分けた意味が無くなる。
    pub async fn adopt(&self, account_id: Uuid, message: ServerMessage) {
        match message {
            ServerMessage::SessionUpsert { session } => {
                let card_id = session.card_id;
                // **外したカードは戻さない。** 跨ぎの経路にも同じ門が要る
                // （`upsert` と対）——外した直後に他インスタンスから流れてきたぶんや、
                // 名乗り直しと行き違ったぶんを素直に取り込むと、記録が作り直されて
                // 一覧へ戻ってくる。しかも `list` はメモリの記録を見るので、
                // **DB では外れているのに画面には出続ける**という食い違いになる
                //
                // **手元に記録があっても DB を見る**（実装レビュー第9回 Astra 2）。手元の記録は、
                // 外した知らせを購読していなかった間の古いものでありうる。外れていたら古い記録を
                // 外し、このサーバのブラウザにも外した知らせを配る
                match self.stored(card_id).await {
                    Ok(Some((owner, true, _, _))) if owner == account_id => {
                        self.drop_stale(account_id, card_id, Reach::ThisInstance);
                        return;
                    }
                    Ok(Some((_, true, _, _))) => return,
                    Ok(_) => {}
                    Err(err) => {
                        tracing::warn!(%card_id, "跨ぎで届いたカードが外されていないかを確かめられません: {err}");
                        return;
                    }
                }
                let record = match self.record_for(account_id, card_id).await {
                    Ok(Some(record)) => record,
                    // 外したカード（実装レビュー第5回 Astra 1）
                    Ok(None) => return,
                    Err(err) => {
                        tracing::warn!(%card_id, "跨ぎで届いたカードを用意できません: {err}");
                        return;
                    }
                };
                // 他人のカードとして届いたものは取り込まない。チャネルは持ち主ごとに
                // 分かれているので通常は起こらないが、**名前と中身が食い違ったときに
                // 名前を正とする**ことをここでも守る
                if record.account_id != account_id {
                    return;
                }
                record.store_meta(*session);
                self.publish_record(&record, Reach::ThisInstance);
            }

            ServerMessage::SessionRemoved { card_id } => {
                if self.owned(account_id, card_id).is_none() {
                    return;
                }
                self.drop_record(account_id, card_id);
                self.publish_local(account_id, ServerMessage::SessionRemoved { card_id });
            }

            // **頼みへの答え（番号付き）は記録を書き換えない**（実装レビュー第6回 Astra 1）。値は
            // 発信元の記録のいまの姿で、こちらの状態は別の便（報告）で揃う。番号を落とさずに
            // 手元へ配るだけ——CLI がこちらのインスタンスに繋がっていても答えが届くように。
            //
            // **持ち主はカードの記録か、受け付けた頼みの控えで確かめる**（実装レビュー第7回
            // Astra 3）。PC の居るインスタンスが答えを作った後に、こちらで外すのが先に済むと、
            // 記録はもう無い。記録だけで確かめると、届いている答えを捨てて CLI を時間切れに
            // していた。控えはこのインスタンスが持ち主の門を通して受け付けた頼みにしか無いので、
            // 他人の頼みへの答えは通らない
            ServerMessage::Status {
                card_id,
                op: Some(op),
                ..
            } => {
                let 受け付けた = self
                    .ops
                    .lock()
                    .expect("ロックが壊れていない")
                    .accepted(account_id, card_id, op);
                if !受け付けた && self.owned(account_id, card_id).is_none() {
                    return;
                }
                self.publish_local(account_id, message);
            }

            ServerMessage::Status {
                card_id,
                status,
                subagent_active,
                last_activity_at,
                op: None,
            } => {
                let Some(record) = self.owned(account_id, card_id) else {
                    return;
                };
                {
                    let mut meta = record.meta.lock().expect("ロックが壊れていない");
                    meta.status = status;
                    meta.subagent_active = subagent_active;
                    meta.last_activity_at = last_activity_at;
                }
                // 状態が届くということは、向こうで報告が続いている
                record.live.store(true, Ordering::Relaxed);
                self.publish_local(
                    account_id,
                    ServerMessage::Status {
                        card_id,
                        status,
                        subagent_active,
                        last_activity_at,
                        op: None,
                    },
                );
            }

            ServerMessage::TranscriptAppend { card_id, nodes } => {
                let Some(record) = self.owned(account_id, card_id) else {
                    return;
                };
                record
                    .window
                    .lock()
                    .expect("ロックが壊れていない")
                    .append(&nodes);
                record.fanout(&ServerMessage::TranscriptAppend { card_id, nodes });
            }

            ServerMessage::TranscriptReset { card_id } => {
                let Some(record) = self.owned(account_id, card_id) else {
                    return;
                };
                record.window.lock().expect("ロックが壊れていない").clear();
                record.fanout(&ServerMessage::TranscriptReset { card_id });
            }

            // **こちらにも明示の腕が要る。** バスから来た残量を素通しにすると、
            // **PC を抱えていないインスタンスに繋いだブラウザ**が初期スナップショットで
            // 値を得られない（サーバを2台以上並べたときだけ出る欠落）
            ServerMessage::ContextUsage { card_id, usage } => {
                let Some(record) = self.owned(account_id, card_id) else {
                    return;
                };
                {
                    let mut meta = record.meta.lock().expect("ロックが壊れていない");
                    meta.context_usage = usage;
                }
                record.live.store(true, Ordering::Relaxed);
                self.publish_local(account_id, ServerMessage::ContextUsage { card_id, usage });
            }

            // **こちらにも明示の腕が要る**（上と同じ理由）。バスから来た使用上限を
            // 素通しにすると、**PC を抱えていないインスタンスに繋いだブラウザ**が
            // REST で空を受け取る（サーバを2台以上並べたときだけ出る欠落）。
            //
            // **ここでは `agent_id` を便から採る。** `apply` が既に `origin` から
            // 詰めたものがバスに乗っているので、こちら側では信頼してよい
            ServerMessage::RateLimits {
                agent_id,
                limits,
                login,
            } => {
                {
                    let mut store = self.rate_limits.lock().expect("ロックが壊れていない");
                    let key = (account_id, agent_id);
                    let (前の指紋, 前の値) = match store.get(&key) {
                        Some(stored) => (stored.login.clone(), Some(stored.limits.clone())),
                        None => (None, None),
                    };
                    // **こちらでも入れ替えを見る。** 便を出した側で入れ替え済みでも、
                    // こちらの保管には前のアカウントの値が残っているので、合流させると
                    // また混ざる（サーバが2台以上のときだけ出る）
                    let merged = if login_changed(前の指紋.as_ref(), login.as_ref()) {
                        limits.clone()
                    } else {
                        merge_rate_limits(前の値.as_ref(), &limits)
                    };
                    store.insert(
                        key,
                        StoredRateLimits {
                            login: login.clone().or(前の指紋),
                            limits: merged,
                        },
                    );
                }
                // **`publish_local` を使う。** `publish` だと受け取ったものを配り直し、
                // それがまた返ってきて止まらなくなる
                self.publish_local(
                    account_id,
                    ServerMessage::RateLimits {
                        agent_id,
                        limits,
                        login,
                    },
                );
            }

            ServerMessage::SessionCost { card_id, cost } => {
                let Some(record) = self.owned(account_id, card_id) else {
                    return;
                };
                {
                    let mut meta = record.meta.lock().expect("ロックが壊れていない");
                    meta.cost = Some(cost);
                }
                record.live.store(true, Ordering::Relaxed);
                self.publish_local(account_id, ServerMessage::SessionCost { card_id, cost });
            }

            // **明示の腕にする。** 素通しの腕（下）へ落としても振る舞いは同じだが、
            // 落としたままにすると**次に誰かが宛先の扱いを変えたとき、コンパイラが
            // 何も言わない**。メモは宛先が2つ（全体・セッション）あり、取り違えると
            // 別の宛先の一覧を上書きする——気づけない壊れ方なので、腕を据えておく。
            //
            // 配る先は `account_id` の手元だけでよい（バス経由で来たものなので、
            // 跨いで配り直すと輪になる）。
            ServerMessage::Memos { target, memos } => {
                self.publish_local(account_id, ServerMessage::Memos { target, memos });
            }

            // 揮発の知らせはそのまま流す
            other => self.publish_local(account_id, other),
        }
    }

    /// ブラウザが1つ繋がった。**最初の1人でそのアカウントの知らせを購読する**（設計§9-2）。
    ///
    /// 購読を開けた瞬間より前に流れたものは届かない（pub/sub は at-most-once）。
    /// だから開けた直後に DB を読み直して埋める——**真実は DB にある**ので、
    /// 取りこぼしはこれで必ず追いつく（§9-1）。
    pub async fn attach_browser(&self, account_id: Uuid) {
        let first = {
            let mut browsers = self.browsers.lock().expect("ロックが壊れていない");
            let count = browsers.entry(account_id).or_insert(0);
            *count += 1;
            *count == 1
        };
        if !first {
            return;
        }
        let Some(bus) = &self.bus else {
            return;
        };
        bus.subscribe(&bus::account_events(account_id));
        if let Err(err) = self.reload_account(account_id).await {
            tracing::warn!(%account_id, "記録を読み直せません: {err}");
        }
        // DB からは「どのカードが生きているか」が分からない。PC を持っている
        // インスタンスに名乗り直してもらう（設計§6-4 のサーバ版）
        self.request_resync(account_id);
    }

    /// ブラウザが1つ去った。**最後の1人で購読を閉じる。**
    pub fn detach_browser(&self, account_id: Uuid) {
        let last = {
            let mut browsers = self.browsers.lock().expect("ロックが壊れていない");
            match browsers.get_mut(&account_id) {
                Some(count) => {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        browsers.remove(&account_id);
                        true
                    } else {
                        false
                    }
                }
                None => false,
            }
        };
        if last && let Some(bus) = &self.bus {
            bus.unsubscribe(&bus::account_events(account_id));
        }
    }

    /// 連絡係が戻ってきたので、見ているアカウントを全部読み直す（設計§9-1 の規約）。
    ///
    /// 読み直しに続けて名乗り直しも頼む。切れている間に生き死にが変わっていても、
    /// DB にはその区別が書いていない。
    ///
    /// 自動再購読は**取りこぼしを埋めない**——切れている間に流れたものは消えている。
    /// 購読が戻ったことと、中身が揃っていることは別の話になる。
    pub async fn resnapshot(&self) {
        let accounts: Vec<Uuid> = self
            .browsers
            .lock()
            .expect("ロックが壊れていない")
            .keys()
            .copied()
            .collect();
        for account_id in accounts {
            if let Err(err) = self.reload_account(account_id).await {
                tracing::warn!(%account_id, "記録を読み直せません: {err}");
            }
            self.request_resync(account_id);
        }
    }

    /// そのアカウントの記録を DB と突き合わせ直す。
    ///
    /// 消えたものは外し、知らないものは足し、あるものは DB の中身で上書きする。
    /// **鮮度の印（`agent_connected`）だけは手元の値を残す**——接続はこのインスタンスと
    /// 他インスタンスの見立てであって、DB には書いていない（設計§20 読み替え4）。
    pub async fn reload_account(&self, account_id: Uuid) -> Result<(), DbErr> {
        let rows = entity::sessions::Entity::find()
            .filter(entity::sessions::Column::AccountId.eq(account_id))
            .filter(entity::sessions::Column::Archived.eq(false))
            .order_by_asc(entity::sessions::Column::CreatedAt)
            .all(&self.db)
            .await?;
        let account_name = entity::accounts::Entity::find_by_id(account_id)
            .one(&self.db)
            .await?
            .map(|row| row.name);

        let alive: std::collections::HashSet<CardId> =
            rows.iter().map(|row| CardId(row.card_id)).collect();

        // DB に無いものは外れている。**手元にだけ残っていると、外したカードが
        // このインスタンスのブラウザにだけ出続ける**
        let stale: Vec<CardId> = self
            .records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .filter(|record| record.account_id == account_id && !alive.contains(&record.card_id))
            .map(|record| record.card_id)
            .collect();
        // **外した印は立てない**（実装レビュー第5回 Astra 1 の [`Self::drop_record`] を使わない）。
        // 読んだ後に生まれたカードも「読みに無い」に入るので、外した証拠にならない。印を立てると、
        // DB では生きているのにこのインスタンスの一覧へ二度と戻らない
        for card_id in stale {
            self.records
                .lock()
                .expect("ロックが壊れていない")
                .remove(&card_id);
            self.publish_local(account_id, ServerMessage::SessionRemoved { card_id });
        }

        for row in rows {
            let card_id = CardId(row.card_id);
            let mut meta = meta_from_row(row);
            if account_id != db::LOCAL_ACCOUNT_ID {
                meta.account = account_name.clone();
            }
            // **枝の印はここで引き直す**（ブランチ設計§5-2）。`meta_from_row` は必ず
            // `None` を返すので、かぶせないと**読み直しのたびに札が消える**。
            //
            // **名前（`nickname`）にはこの引き直しが無い。** あちらは消えたあと、
            // 名乗り直し（[`Self::request_resync`]）が `upsert` を通ることで戻る——
            // 副作用に頼っている。同じ形にすると、名乗り直しが来ない場面で札だけが
            // 消えたままになるので、こちらは自分で引く
            meta.branched_from = meta
                .claude_session_id
                .and_then(|id| self.branch_of(account_id, id));
            // DB は接続を知らない（`meta_from_row` は必ず false を返す）ので、
            // 手元の見立てを残す。**知らないカードは繋がっていない扱い**で始め、
            // 生きているものは名乗り直し（[`Self::request_resync`]）で印が戻る——
            // **PC が繋がっていることと、そのカードが生きていることは別**。PC ごと
            // 落ちたあとのカードは、PC が戻っても死んだままになる（設計§1-3）
            let known = self.get(card_id);
            meta.agent_connected = known
                .as_ref()
                .is_some_and(|record| record.meta().agent_connected);
            // **コンテキストの使い具合も引き直す**（コンテキスト残量設計§4）。列を持たない
            // と決めた値なので `meta_from_row` は必ず `None` を返す。上の2つと同じ理由で、
            // かぶせないと**読み直しのたびに消える**。
            //
            // **戻る道が細いので、消えると長く空く。** 戻るのは PC が名乗り直すか、
            // 整数パーセントが動いて軽い便が再送されたときだけ——**止まっている
            // セッションはパーセントが動かない**ので、送る側の関門が再送を抑えたまま
            // 空欄が残る。
            //
            // **手元に記録がある場合だけ引き継ぐ。** DB に無い値を捏造しない
            meta.context_usage = known
                .as_ref()
                .and_then(|record| record.meta().context_usage);
            let record = match known {
                Some(record) => record,
                None => match self.record_for(account_id, card_id).await? {
                    Some(record) => record,
                    // 読んだ後に外れた（実装レビュー第5回 Astra 1）
                    None => continue,
                },
            };
            record.store_meta(meta);
            self.publish_record(&record, Reach::ThisInstance);
        }
        Ok(())
    }

    /// その PC が持っているカードの一覧（切断時の掃除と、指示の宛先探しに使う）。
    pub fn cards_of(&self, agent_id: AgentId) -> Vec<CardId> {
        self.records
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .filter(|record| record.meta().agent_id == Some(agent_id))
            .map(|record| record.card_id)
            .collect()
    }

    pub fn get(&self, card_id: CardId) -> Option<Arc<SessionRecord>> {
        self.records
            .lock()
            .expect("ロックが壊れていない")
            .get(&card_id)
            .cloned()
    }

    /// 履歴を1ページ分作る（設計§3-3）。読み先は DB。
    ///
    /// **自分のカードでなければ「無い」と答える**（§8-6）。他人のカードだと分かる
    /// 返し方をすると、IDの総当たりで存在を調べられる。
    pub async fn transcript_page(
        &self,
        account_id: Uuid,
        card_id: CardId,
        before: Option<NodeId>,
        limit: usize,
    ) -> Result<TranscriptPage, PageError> {
        if self.owned(account_id, card_id).is_none() {
            return Err(PageError::NotFound);
        }
        match db_transcript::page(&self.db, card_id, before.as_ref(), limit).await {
            Ok((nodes, has_more)) => Ok(TranscriptPage { nodes, has_more }),
            Err(err) => {
                tracing::error!(%card_id, "履歴を読めません: {err}");
                Err(PageError::Unavailable)
            }
        }
    }

    /// セッションホストからの報告を1件取り込む。**書いてから配る。**
    ///
    /// 戻り値は「**取り込みが終わったか**」で、そのまま ack を返してよいかの判断になる
    /// （設計§6-1）。`false` のときは黙って返さない——ack を返さないこと自体が
    /// 「まだ書けていない」の合図で、セッションホストは持っているぶんを再送する（§12 の DB 断）。
    ///
    /// 取り込む先が無かった場合（外した直後のカード宛て）も `true` を返す。ここで
    /// `false` にすると、**二度と書ける見込みが無いものを永久に再送させる**ことになり、
    /// そのカードのオフセットが止まったままになる。
    pub async fn apply(&self, origin: &ReportOrigin, message: ServerMessage) -> bool {
        let outcome = match message {
            ServerMessage::SessionUpsert { session } => self.upsert(origin, *session).await,
            ServerMessage::SessionRemoved { card_id } => {
                let outcome = self.archive(origin, card_id).await;
                if outcome.is_err() {
                    self.retry_removal(origin, card_id);
                }
                outcome
            }
            // `op`（頼みへの答えの番号）はサーバが付けるもので、PC の報告は付けない。付いていても
            // 記録の書き換えとして扱う（番号は落とす）
            ServerMessage::Status {
                card_id,
                status,
                subagent_active,
                last_activity_at,
                op: _,
            } => {
                self.status(origin, card_id, status, subagent_active, last_activity_at)
                    .await
            }
            ServerMessage::TranscriptAppend { card_id, nodes } => {
                self.append(origin, card_id, nodes).await
            }
            ServerMessage::TranscriptReset { card_id } => self.reset(origin, card_id).await,
            // **素通しの腕へ落とさない。** 落とすと配信だけが起きて手元の記録が
            // 更新されず、**後から繋いだブラウザの初期スナップショットに値が乗らない**
            // （しかも持ち主の検査も抜ける）。包括の腕があるのでコンパイラは拾わない
            ServerMessage::ContextUsage { card_id, usage } => {
                self.context_usage(origin, card_id, usage);
                Ok(())
            }
            // **素通しの腕へ落とさない**（上と同じ理由）。こちらは落とすと
            // **手元の保管が埋まらず、後から開いた画面が REST で空を受け取る**。
            // しかも量子化が効いているので、**窓が切り替わるまで空のまま**になる
            // （5時間窓・7日窓なので、数時間空く）
            ServerMessage::RateLimits { limits, login, .. } => {
                // **便に乗ってきた `agent_id` は使わない。** 帰属を決めるのはサーバの
                // 仕事で（`ReportOrigin` の doc）、**ここが唯一それを詰める場所**である。
                // セッションホストが何を名乗っても、`origin` の値で上書きする。
                //
                // **`login` のほうは名乗りを採る。** あちらは「他人の PC を騙れるか」の
                // 話だが、こちらで決まるのは自分の欄を入れ替えるかどうかだけで、
                // **サーバには知る道が無い**（`AgentMessage::RateLimits` の doc）
                self.rate_limits(origin, limits, login);
                Ok(())
            }
            ServerMessage::SessionCost { card_id, cost } => {
                self.session_cost(origin, card_id, cost);
                Ok(())
            }
            // **セッションホストからメモは来ない**（メモ設計§1-2。記録はサーバだけで
            // 完結し、A2S にも載せていない）。だからここへ来ること自体が異常である。
            //
            // **素通しの腕へ落とすと、そこは `publish` なので手元とバスの両方へ流れる**
            // ——記録に1行も無いメモが、全端末の画面に出る道になる。
            // 捨てて記録に残す。**黙って捨てると、原因を追える手掛かりが消える。**
            ServerMessage::Memos { .. } => {
                tracing::warn!(
                    agent_id = ?origin.agent_id,
                    "セッションホストからメモの便が来ました。捨てます（メモはサーバの記録だけで完結します）"
                );
                Ok(())
            }
            // **アプリ全体の知らせは記録に残す**（トーストとベル設計§4-2）。
            // 7秒で消えるトーストの代わりに、ベルから後で読めるようにするため
            ServerMessage::Error {
                card_id: None,
                ref message,
                kind,
                busy,
                withdrawn,
                ref ops,
            } => {
                self.record_notice(origin, None, "error", kind.as_str(), message)
                    .await;
                self.publish(
                    origin.account_id,
                    ServerMessage::Error {
                        card_id: None,
                        message: message.clone(),
                        kind,
                        busy,
                        withdrawn,
                        ops: ops.clone(),
                    },
                );
                Ok(())
            }
            ServerMessage::Selfheal { phase, ref detail } => {
                let text = protocol::ws::selfheal_label(phase, detail.as_deref());
                self.record_notice(origin, None, "selfheal", phase.as_str(), &text)
                    .await;
                self.publish(
                    origin.account_id,
                    ServerMessage::Selfheal {
                        phase,
                        detail: detail.clone(),
                    },
                );
                Ok(())
            }
            // 揮発の知らせ。真実として残す性質のものではないので素通しする。
            // **配る先は報告してきたアカウントの中だけ**（§8-6 の A2S の行）
            other => {
                self.publish(origin.account_id, other);
                Ok(())
            }
        };

        match outcome {
            Ok(()) => true,
            Err(err) => {
                // 書けなかったものは配らない（画面に出るのに再読み込みで消えるのを防ぐ）。
                // 代わりに理由を出す——黙って落とすと「一覧が更新されない」としか見えない
                tracing::error!("記録を書けませんでした: {err}");
                self.publish(
                    origin.account_id,
                    ServerMessage::Error {
                        card_id: None,
                        message: format!("記録を保存できませんでした: {err}"),
                        kind: ErrorKind::Other,
                        busy: None,
                        withdrawn: None,
                        ops: Vec::new(),
                    },
                );
                false
            }
        }
    }

    async fn upsert(&self, origin: &ReportOrigin, mut meta: SessionMeta) -> Result<(), DbErr> {
        // **外したカードは戻さない。**
        //
        // 外す（`archive`）と記録は落ちるが、**報告の待ち行列にはまだそのカードのぶんが
        // 残っている**（切替の結果配信・見張りの1周・処理中のフック）。それを素直に
        // 取り込むと記録が作り直され、消したはずのカードが一覧へ戻ってくる。
        //
        // 記録が手元に無いときは、ここで DB を見る。手元にあるときは見ないが、書く段で
        // 「外していない行」に限って書くので、他のサーバで外されていれば書けずに止まる
        // （実装レビュー第9回 Astra 2）。問い合わせは増えない。
        // CardId は UUIDv4 なので、外したIDが後から別のセッションに割り当たることもない
        // 既に知っているカードなら、生まれた時刻と名前は**記録の側が正**（下記）
        let mut 記録の生まれた時刻 = None;
        let mut 記録の名前 = None;
        let mut 記録の並び = None;
        let mut 記録の頼んだ会話 = None;
        match self.get(meta.card_id) {
            Some(record) => {
                if self.refuse_crossing(&origin.account_id, record.account_id, meta.card_id) {
                    return Ok(());
                }
                記録の生まれた時刻 = Some(record.meta().created_at);
                記録の名前 = record.meta().session_title;
                記録の並び = Some(record.meta().position);
                記録の頼んだ会話 = record.meta().resumed_from;
            }
            None => match self.stored(meta.card_id).await? {
                Some((owner, _, _, _))
                    if self.refuse_crossing(&origin.account_id, owner, meta.card_id) =>
                {
                    return Ok(());
                }
                Some((_, true, _, _)) => return Ok(()),
                // 記録にはあるが手元に無い（起こし直しの直後・他インスタンス経由）。
                // **並びは記録の側が正**なので、そちらを持ち帰る。
                //
                // **頼んだ会話もここで持ち帰る。** 持ち帰らないと、下の埋め直しが
                // 素通しになり、**空の報告が保存済みの値を NULL で上書きする**
                // ——`ResumedFrom` は更新列に入っているので、そのまま消える。
                // **この変更が防ごうとしているデータ喪失そのもの**が、
                // 「記録が手元に無い」という日常的な経路から起きていた
                Some((_, false, 並び, 頼んだ会話)) => {
                    記録の並び = Some(並び);
                    記録の頼んだ会話 = 頼んだ会話;
                }
                None => {}
            },
        }

        // **帰属を決めるのはサーバの仕事**（設計§5-1 の手順4）。セッションホストが申告した
        // 値は捨て、接続そのものが含意する出どころで上書きする。他アカウントの名前を
        // 名乗られても通らないのは、ここで見ているのが**申告ではなく接続**だから（§8-5）
        meta.agent_id = origin.agent_id;
        meta.account = origin.account.clone();
        // **生まれた時刻もサーバが決める。** これは擬似ターミナルではなく**カードの性質**で、
        // カードは起こし直しをまたいで同じものであり続ける（初期実装§3）。
        //
        // 起こし直し（`revive`）は同じ CardId に別の実体を載せ直すので、セッションホストは
        // **そのとき採った時刻**を申告してくる。
        //
        // **並びの正はもう `created_at` ではない**（並べ替え設計§2-3）。利用者が自分で
        // 並べた順（`position`）が正になり、時刻は順序を決めなくなった。**それでもここは
        // 残す。** 約束そのもの——「一覧の並びは、状態が変わっても動かない」（README。
        // 押そうとした瞬間に的が逃げないため）——は今回いっそう強くなったからで、
        // 時刻が動くこと自体が別の場所（小窓の「N分前」）で嘘になる。
        //
        // 実機で踏んだ（2026-08-23）。復旧した2枚が枠の末尾へ動いた。当時は `created_at` が
        // 並びを決めていたので、「全て復旧」を押すと**群ごと並び替わる**形で表に出た。
        // いま同じことが起きても並びは動かないが、**時刻の表示だけが静かに狂う**——
        // 表に出にくくなったぶん、ここを外すと気づけない。
        if let Some(生まれた時刻) = 記録の生まれた時刻 {
            meta.created_at = 生まれた時刻;
        }
        // **空の報告で名前を消さない**（設計§6-1）。生まれた時刻と同じ性質——名前は
        // 擬似ターミナルではなく**カードに属する**もので、起こし直しをまたいで残る。
        //
        // 名前の行は履歴の途中に1回書かれるだけなので、**カードの報告のほうが先に着く**。
        // 素直に取り込むと、記録に入っていた名前がその1回で消える（パーサが読み直して
        // 報告し直すまでの隙間で消え、題の行がまだ無いセッションでは永久に戻らない）。
        //
        // 逆向き（空でない報告）は素通しでよい。名前が変わるときは**新しい名前が書かれる**
        // ので、空を無視しても更新は届く。
        if meta.session_title.is_none()
            && let Some(名前) = 記録の名前
        {
            meta.session_title = Some(名前);
        }
        // **空の報告で「頼んだ会話」を消さない。** 名前とまったく同じ性質である。
        //
        // 消えると困る度合いはこちらのほうが重い——名前は付け直せるが、**何を
        // `--resume` したかは起こした時点にしか存在しない情報**で、失うと二度と
        // 復元できない。そして失った瞬間に、その会話は呼び戻しの一覧から消える。
        //
        // **空が届く道が2つある。** ①`resumed_from` を持たない古い版の PC（欄が
        // 無いので `None` として受かる）②新規セッションとして起こされたカード。
        // ①で消してはいけないので、**空は常に記録の値で埋め直す**。
        //
        // 逆向き（空でない報告）は素通しでよい。**同じカードを別の会話で起こし直す
        // （`revive`）と新しい値が届く**ので、空を無視しても更新は届く。
        if meta.resumed_from.is_none()
            && let Some(頼んだ会話) = 記録の頼んだ会話
        {
            meta.resumed_from = Some(頼んだ会話);
        }
        // **並びも記録の側が正**（設計§9-2）。セッションホストは並び順を知らないので
        // 0 を名乗ってくる。素直に取り込むと、**報告が届くたびに並べ替えた結果が
        // 先頭へ戻る**——生まれた時刻や名前とまったく同じ性質である。
        //
        // 記録がどこにも無いカード（本当に新しい1枚）だけ、**その枠の先頭**を振る。
        // ここで決めた値を下の `write_session` がそのまま入れるので、採番は1回で済む。
        //
        // **復旧はこの枝を通らない**（記録が残っているので `Some` 側へ行く）。
        // だから起こし直しても位置は動かない
        meta.position = match 記録の並び {
            Some(並び) => 並び,
            None => {
                next_card_position(
                    &self.db,
                    origin.account_id,
                    meta.agent_id.map(|id| id.0),
                    &meta.project.0,
                )
                .await?
            }
        };
        // **利用者が付けた名前も記録の側が正**（設計§4-2）。セッションホストは名前を
        // 知らないので `None` を名乗ってくるが、**素直に取り込むと報告が届くたびに
        // 名前が消える**——生まれた時刻・題・並びとまったく同じ性質である。
        //
        // 引く鍵はカードではなく **CLI セッション**なので、`--resume` で乗り換えた
        // カードには乗り換え先の名前が出る（要件4）。呼び戻し先を持たないカード
        // （起こした直後など）は空のまま。
        meta.nickname = meta
            .claude_session_id
            .and_then(|id| self.nickname_of(origin.account_id, id));
        // **枝の印も記録の側が正**（ブランチ設計§5-1）。セッションホストは印を知らないので
        // `None` を名乗ってくる。名前とまったく同じ扱いで、ここでかぶせる
        meta.branched_from = meta
            .claude_session_id
            .and_then(|id| self.branch_of(origin.account_id, id));
        // 申告が持ち主と食い違ったら**記録には残すが帰属は動かさない**。警告を出すのは、
        // 利用者から見ると「toml に書いたのに効かない」だけに見えるため
        if let (Some(claimed), Some(actual)) = (&meta.toml_account, &origin.account)
            && claimed != actual
        {
            tracing::warn!(
                card_id = %meta.card_id,
                "`.agent-dashboard.toml` は「{claimed}」と名乗りましたが、この接続は「{actual}」のものです。申告は無視します"
            );
        }

        // **DB が外したと言ったら、書かずにやめる**（実装レビュー第9回 Astra 2）。上の確かめは記録が
        // 手元にあれば DB を見ないが、手元の記録は外した知らせを購読していなかった間の古いもので
        // ありうる。書くのを「外していない行」に限り、書けなかったら古い記録を外す
        if !self.write_session(origin, &meta).await? {
            self.drop_stale(origin.account_id, meta.card_id, Reach::AllInstances);
            return Ok(());
        }

        self.止め口(更新の止め所::記録を取る前).await;
        // **外したカードの記録は作り直さない**（実装レビュー第5回 Astra 1）。上の確かめは記録が
        // 手元にあれば DB を引かないので、書くのを待っている間に外れても通ってくる
        let Some(record) = self.record_for(origin.account_id, meta.card_id).await? else {
            tracing::info!(
                card_id = %meta.card_id,
                "一覧から外した後に届いた報告なので、記録を作り直しません"
            );
            return Ok(());
        };
        record.store_meta(meta);
        self.止め口(更新の止め所::配る前).await;
        self.publish_record(&record, Reach::AllInstances);
        Ok(())
    }

    /// 記録のいまの姿を配る。**配った後に外されていたら、外した知らせを配り直す**（実装レビュー
    /// 第5回 Astra 1）。
    ///
    /// 記録を取ってから配るまでの間に外す処理が済むと、ブラウザには「外した」→「更新」の順で
    /// 届き、外したカードが一覧へ戻る。配るのを記録の表のロックの中で行えば順は揃うが、配る口は
    /// 断りを記録へ残すときに同じロックを取る（[`Self::publish_local`]）ので、ロックの外で配って
    /// から見直す。
    fn publish_record(&self, record: &SessionRecord, reach: Reach) {
        let send = |message: ServerMessage| match reach {
            Reach::AllInstances => self.publish(record.account_id, message),
            Reach::ThisInstance => self.publish_local(record.account_id, message),
        };
        send(ServerMessage::SessionUpsert {
            session: Box::new(record.meta()),
        });
        let removed = self
            .removed
            .lock()
            .expect("ロックが壊れていない")
            .contains(record.account_id, record.card_id);
        if removed {
            send(ServerMessage::SessionRemoved {
                card_id: record.card_id,
            });
        }
    }

    /// 手元の記録を外し、外した印を立てる（実装レビュー第5回 Astra 1）。**同じロックの中で行う**
    /// ——分けると、その間に [`Self::record_for`] が記録を作り直せる。知らせは呼んだ側が配る。
    ///
    /// **そのカードが `account_id` のものだと確かめてから呼ぶ**（実装レビュー第9回 Astra 1）。
    /// 印はそのアカウントにだけ立つ。
    fn drop_record(&self, account_id: Uuid, card_id: CardId) {
        let mut records = self.records.lock().expect("ロックが壊れていない");
        records.remove(&card_id);
        self.removed
            .lock()
            .expect("ロックが壊れていない")
            .mark(account_id, card_id);
    }

    /// 他のサーバで外されたカードの、手元に残った古い記録を外す（実装レビュー第9回 Astra 2）。
    ///
    /// 外した知らせはアカウントの知らせに乗って回るが、このサーバにそのアカウントのブラウザが
    /// 居なければ購読しておらず、記録が残る。残ったまま PC の報告を取り込むと、外したカードを
    /// 一覧へ配り直し、照合も「手元にある＝外していない」と読んでいた。**DB が外したと言ったら、
    /// 手元の記録を外して、外した知らせを配り直す**（最後の知らせを「外した」に揃える）。
    fn drop_stale(&self, account_id: Uuid, card_id: CardId, reach: Reach) {
        let had = self.owned(account_id, card_id).is_some();
        self.drop_record(account_id, card_id);
        if had {
            tracing::info!(
                %card_id,
                "他のサーバで一覧から外されたカードの古い記録が残っていたので、外しました"
            );
            let message = ServerMessage::SessionRemoved { card_id };
            match reach {
                Reach::AllInstances => self.publish(account_id, message),
                Reach::ThisInstance => self.publish_local(account_id, message),
            }
        }
    }

    /// 更新を決めた所で1回止める（**テスト専用**）。止めるのは、次にそこへ来た更新1本だけ。
    #[doc(hidden)]
    pub fn 更新を止める(&self, at: 更新の止め所) -> 止めた更新 {
        let (reached_tx, reached_rx) = oneshot::channel();
        let (resume_tx, resume_rx) = oneshot::channel();
        *self.update_pause.lock().expect("ロックが壊れていない") = Some(UpdatePause {
            at,
            reached: reached_tx,
            resume: resume_rx,
        });
        止めた更新 {
            reached: reached_rx,
            resume: resume_tx,
        }
    }

    async fn 止め口(&self, at: 更新の止め所) {
        let pause = {
            let mut slot = self.update_pause.lock().expect("ロックが壊れていない");
            match slot.take() {
                Some(pause) if pause.at == at => Some(pause),
                other => {
                    *slot = other;
                    None
                }
            }
        };
        let Some(pause) = pause else {
            return;
        };
        if pause.reached.send(()).is_err() {
            return;
        }
        // 手綱を捨てられたら（試験が落ちた）、止まったままにせず進める
        if pause.resume.await.is_err() {
            tracing::warn!(?at, "止めた更新の手綱が捨てられたので、そのまま進めます");
        }
    }

    /// 他人のカードへの報告を断るか（設計§8-6 の A2S の行）。
    ///
    /// **`false`（＝取り込まない）でも ack は返す**（呼び出し側が `Ok` にする）。
    /// 返さないと、二度と書ける見込みの無いものをセッションホストが永久に再送する。
    fn refuse_crossing(&self, reporting: &Uuid, owner: Uuid, card_id: CardId) -> bool {
        if *reporting == owner {
            return false;
        }
        tracing::warn!(%card_id, "他のアカウントのカードへの報告を無視しました");
        true
    }

    /// セッションホストが「外した」と報告してきたのに記録を書けなかったカードを、書けるまで
    /// 切り離して取り込み直す（実装レビュー第3回 Astra 1 と同じ種類の穴）。
    ///
    /// # なぜ取り込み直すのか
    ///
    /// **PC の側では外す処理が済んでいて、取り消せない**——実体を畳み、添付を消し、外した印を
    /// 立てている。報告は1回きりで、以前は書けなければ捨てていた。するとカードは一覧に残るのに、
    /// その PC では以後の起こし直しが「一覧から外された」で断られ続けた（プロセスが起き直す
    /// まで）。報告の運び手の約束「遅れは許容し、欠落は許容しない」に、記録の側を合わせる。
    ///
    /// **記録だけを外す口（[`Self::archive_owned`]）は取り込み直さない。** あちらは記録の側が
    /// 外す主なので、外せなければ利用者へ断り、PC には外した印を立てさせない（`ws.rs`）。
    /// ここを [`Self::archive`] の中へ入れると、断ったはずの外す操作が後から効いてしまう。
    ///
    /// # いつやめるか
    ///
    /// 書けたら終わる。**手元の記録からカードが消えていても終わる**——ほかの道で外れた
    /// （記録は書けたときにだけ手元から消える）ので、もう要らない。
    ///
    /// # 残り
    ///
    /// 取り込み直している間にこのサーバが落ちると、取り込み直しも消える。セルフホストでは
    /// カードが一覧に戻り、PC の印は PC が起き直すまで残る。ローカルは記録と印が同じ
    /// プロセスにあるので、起き直せば両方が揃って消える。
    fn retry_removal(&self, origin: &ReportOrigin, card_id: CardId) {
        let Some(me) = self.me.upgrade() else {
            return;
        };
        let origin = origin.clone();
        // **切り離す前に購読する。** 切り離した後だと、その間に急かされても取りこぼす
        let mut kicks = self.removal_retry_kick.subscribe();
        let mut wait = *self
            .removal_retry_first
            .lock()
            .expect("ロックが壊れていない");
        tracing::warn!(
            %card_id,
            "外したと報告されたカードの記録を書けませんでした。書けるまで取り込み直します"
        );
        tokio::spawn(async move {
            let mut attempt: u32 = 1;
            loop {
                tokio::select! {
                    () = tokio::time::sleep(wait) => {}
                    // 送り手は自分（`me`）が持っているので閉じない
                    _ = kicks.changed() => {}
                }
                if me.get(card_id).is_none() {
                    return;
                }
                attempt += 1;
                match me.archive(&origin, card_id).await {
                    Ok(()) => {
                        tracing::info!(
                            %card_id,
                            attempt,
                            "外したと報告されたカードを、取り込み直して記録から外しました"
                        );
                        return;
                    }
                    Err(err) => {
                        wait = (wait * 2).min(REMOVAL_RETRY_MAX);
                        tracing::warn!(
                            %card_id,
                            attempt,
                            "外したと報告されたカードの記録をまだ書けません。{wait:?} 後にもう一度試します: {err}"
                        );
                    }
                }
            }
        });
    }

    /// 取り込み直しの間隔の初めを変える（**テスト専用**）。長くしておけば、急かす口
    /// （[`Self::外した報告の取り込み直しを急かす`]）でだけ進む——時計に頼らずに確かめられる。
    #[doc(hidden)]
    pub fn 外した報告の取り込み直しの間隔(&self, first: Duration) {
        *self
            .removal_retry_first
            .lock()
            .expect("ロックが壊れていない") = first;
    }

    /// 待っている取り込み直しを、待たずに1回進める（**テスト専用**）。
    #[doc(hidden)]
    pub fn 外した報告の取り込み直しを急かす(&self) {
        self.removal_retry_kick.send_modify(|count| *count += 1);
    }

    /// ブラウザからの指示でカードを外す（実体がもう居ない場合）。
    ///
    /// # 実体が死んでいるカードも外せないといけない
    ///
    /// 通常はセッションホストへ頼み、向こうが片付けてから `SessionRemoved` を報告してくる。
    /// だが**前回の起動が残したカード**や、PC ごと落ちたあとのカードには頼む相手が
    /// 居ない。そのままだと一覧から二度と消せず、履歴を残すために行を消さない設計
    /// （下の [`Self::archive`]）と噛み合って**永久に残る**。
    ///
    /// 持ち主は必ず確かめる。他人のカードのIDを名指しして消せてはいけない（§8-6）。
    pub async fn archive_owned(&self, account_id: Uuid, card_id: CardId) -> Result<(), DbErr> {
        self.archive(
            &ReportOrigin {
                account_id,
                agent_id: None,
                account: None,
            },
            card_id,
        )
        .await
    }

    async fn archive(&self, origin: &ReportOrigin, card_id: CardId) -> Result<(), DbErr> {
        if let Some(record) = self.get(card_id)
            && self.refuse_crossing(&origin.account_id, record.account_id, card_id)
        {
            return Ok(());
        }
        // 行は消さない。**履歴を残すため**——カードを一覧から外しても、
        // 何をしたセッションだったかは辿れる。**持ち主も条件に入れる**ので、
        // 他人のカードのIDを名指しして消すことはできない
        let updated = entity::sessions::Entity::update_many()
            .col_expr(
                entity::sessions::Column::Archived,
                sea_orm::sea_query::Expr::value(true),
            )
            .filter(entity::sessions::Column::CardId.eq(card_id.0))
            .filter(entity::sessions::Column::AccountId.eq(origin.account_id))
            .exec(&self.db)
            .await?;
        // **書けなかったなら、誰のカードかを DB で確かめる**（実装レビュー第9回 Astra 1）。手元に
        // 記録の無い他のアカウントのカードを名指しされると、上の条件で1行も書けないのに、以前は
        // 印を立てて外した知らせまで配っていた——正当な持ち主の報告が、以後記録を作り直せなく
        // なった。他のアカウントの行なら、記録にも印にも触らない。行がどこにも無ければ
        // （記録に書かれる前のカード）、以前どおりこのアカウントのものとして外す
        if updated.rows_affected == 0
            && let Some((owner, _, _, _)) = self.stored(card_id).await?
            && self.refuse_crossing(&origin.account_id, owner, card_id)
        {
            return Ok(());
        }
        self.drop_record(origin.account_id, card_id);
        self.publish(origin.account_id, ServerMessage::SessionRemoved { card_id });
        Ok(())
    }

    async fn status(
        &self,
        origin: &ReportOrigin,
        card_id: CardId,
        status: SessionStatus,
        subagent_active: u32,
        last_activity_at: i64,
    ) -> Result<(), DbErr> {
        let Some(record) = self.owned(origin.account_id, card_id) else {
            return Ok(());
        };
        entity::sessions::Entity::update_many()
            .col_expr(
                entity::sessions::Column::Status,
                sea_orm::sea_query::Expr::value(
                    serde_json::to_value(status).unwrap_or(serde_json::Value::Null),
                ),
            )
            .col_expr(
                entity::sessions::Column::SubagentActive,
                sea_orm::sea_query::Expr::value(subagent_active as i32),
            )
            .col_expr(
                entity::sessions::Column::LastActivityAt,
                sea_orm::sea_query::Expr::value(last_activity_at),
            )
            .filter(entity::sessions::Column::CardId.eq(card_id.0))
            .exec(&self.db)
            .await?;

        {
            let mut meta = record.meta.lock().expect("ロックが壊れていない");
            meta.status = status;
            meta.subagent_active = subagent_active;
            meta.last_activity_at = last_activity_at;
        }
        record.live.store(true, Ordering::Relaxed);
        self.publish(
            record.account_id,
            ServerMessage::Status {
                card_id,
                status,
                subagent_active,
                last_activity_at,
                op: None,
            },
        );
        Ok(())
    }

    /// コンテキスト残量の軽い便。**記録（DB）を触らない**（コンテキスト残量設計§4）。
    ///
    /// # なぜ `async` でも `Result` でもないのか
    ///
    /// **DB を触らないから待つものも失敗するものも無い**、というだけではない。
    /// **この署名が「触らない」という決定を守る仕掛けである**——戻り値を `Result` に
    /// しておくと、後から `UPDATE` を1行足しても署名が変わらず、**レビューで気づけない**。
    /// 同期・戻り値なしにしてあれば、書こうとした瞬間に署名を変える必要が生じ、
    /// **そこが目に入る**。
    ///
    /// # 保存しない理由
    ///
    /// 値は会話が進むたびに動く。保存すると**落ちた瞬間の値が残り**、起こし直した
    /// 直後の空のセッションに前回の使用率が出る。「まだ分からない」と 0% を区別せよ、
    /// という要件と正面からぶつかる（`agent_connected` と同じ性質）。
    ///
    /// 書き込みの**回数**を抑えるのは送る側の関門（`store_context_usage`）の仕事で、
    /// **こちらとは別の理由による**。混ぜて読むと、片方を外してよいと誤解する。
    fn context_usage(&self, origin: &ReportOrigin, card_id: CardId, usage: Option<ContextUsage>) {
        // **持ち主の検査をここで通す**（設計§8-6「絞り込みは記録層の入口1箇所」）。
        // 素通しの腕へ落とすとこの門だけが抜ける
        let Some(record) = self.owned(origin.account_id, card_id) else {
            return;
        };
        {
            let mut meta = record.meta.lock().expect("ロックが壊れていない");
            meta.context_usage = usage;
        }
        // 残量が届くということは、報告が続いている
        record.live.store(true, Ordering::Relaxed);
        self.publish(
            record.account_id,
            ServerMessage::ContextUsage { card_id, usage },
        );
    }

    /// 使用上限の軽い便。**記録（DB）を触らない**（status設計「保管」）。
    ///
    /// # 署名は [`SessionRegistry::context_usage`] と同じ理由で `async` でも `Result` でもない
    ///
    /// **「DB を触らない」という決定を、署名そのもので守る仕掛け**である。あちらの
    /// doc を参照。
    ///
    /// # ★ 送る側にも関門があるのに、ここでも表示形を見る理由
    ///
    /// [`SessionRegistry::context_usage`] の doc は「**書き込みの回数を抑えるのは
    /// 送る側の関門の仕事で、こちらとは別の理由による。混ぜて読むと、片方を外して
    /// よいと誤解する**」と書いている。**その約束は、こちらには当てはまらない。**
    ///
    /// | | コンテキスト残量 | 使用上限 |
    /// |---|---|---|
    /// | 値の持ち主 | カード | **PC** |
    /// | 届く経路の本数 | 1枚のカードにつき1本 | **セッションが N 本なら N 本** |
    ///
    /// `statusLine` も受け口も送る側の関門も、**すべてセッションごと**に在る。
    /// つまり**関門はセッションごとにしか効かない**——別のセッションから同じ値が
    /// 届くと、そちらの関門は「初めて見た値」として通す。**セッションを N 本
    /// 走らせていれば、同じ値が N 回ここへ来る。**
    ///
    /// **だから外さないこと。** 「送る側にあるのだから要らない」と読むと、
    /// セッションの本数だけ配信が増える。
    fn rate_limits(
        &self,
        origin: &ReportOrigin,
        limits: RateLimits,
        login: Option<ClaudeLoginFingerprint>,
    ) {
        let key = (origin.account_id, origin.agent_id);
        let merged = {
            let mut store = self.rate_limits.lock().expect("ロックが壊れていない");
            let (前の指紋, 前の値) = match store.get(&key) {
                Some(stored) => (stored.login.clone(), Some(stored.limits.clone())),
                None => (None, None),
            };

            // **別のログインから届いたら、合流させずに入れ替える。** 合流は
            // 「リセット時刻は前へ戻らない」を頼りにしているが、**その約束は1つの
            // ログインの中でしか成り立たない**（[`StoredRateLimits`]）
            let merged = if login_changed(前の指紋.as_ref(), login.as_ref()) {
                limits
            } else {
                merge_rate_limits(前の値.as_ref(), &limits)
            };

            // **読めなかった報告で控えを消さない。** `None` は「変わった」ではなく
            // 「分からない」なので、いま知っていることを残す
            let 次の指紋 = login.or_else(|| 前の指紋.clone());

            // **同じ表示形なら配らない**（上記）。`==` で見るので、窓の並び順が
            // 変わっただけでも配ってしまう——`merge_rate_limits` が**既存の並びを
            // 保つ**ことでそこを防いでいる
            if 前の値.as_ref() == Some(&merged) {
                // 指紋だけが動いたときは、**控えだけ直して配らない**。画面に出る
                // ものが1文字も変わらないのに配ると、関門を置いた意味が無くなる
                if 次の指紋 != 前の指紋 {
                    store.insert(
                        key,
                        StoredRateLimits {
                            login: 次の指紋,
                            limits: merged,
                        },
                    );
                }
                return;
            }
            store.insert(
                key,
                StoredRateLimits {
                    login: 次の指紋.clone(),
                    limits: merged.clone(),
                },
            );
            (merged, 次の指紋)
        };
        // **配り先はアカウント内の全ブラウザ**（カード宛ではない）。この値は PC の
        // 状態なので、どのカードを見ている人にも同じものが要る
        //
        // **指紋も一緒に配る。** この便はバス（サーバが2台以上のとき）にも乗るので、
        // ここで落とすと**もう1台の保管が切り替えを取り逃がす**——そちらへ繋いだ
        // ブラウザにだけ前のアカウントの数字が残る。画面はこの欄を読まない
        self.publish(
            origin.account_id,
            ServerMessage::RateLimits {
                agent_id: origin.agent_id,
                limits: merged.0,
                login: merged.1,
            },
        );
    }

    /// そのセッションが使った費用と手間。**記録（DB）を触らない**（status設計「保管」）。
    ///
    /// # ここではサーバ側の関門を置かない
    ///
    /// 上の [`SessionRegistry::rate_limits`] と違い、**費用はカードに属する**ので
    /// 経路が1枚につき1本しかない。**送る側の関門で足りる**——
    /// [`SessionRegistry::context_usage`] と同じ形である。
    fn session_cost(&self, origin: &ReportOrigin, card_id: CardId, cost: SessionCost) {
        // **持ち主の検査をここで通す**（設計§8-6）。こちらは `card_id` を運ぶので
        // `owned()` が引ける（使用上限のほうは運ばないので、鍵の `account_id` で絞る）
        let Some(record) = self.owned(origin.account_id, card_id) else {
            return;
        };
        {
            let mut meta = record.meta.lock().expect("ロックが壊れていない");
            meta.cost = Some(cost);
        }
        // 費用が届くということは、報告が続いている
        record.live.store(true, Ordering::Relaxed);
        self.publish(
            record.account_id,
            ServerMessage::SessionCost { card_id, cost },
        );
    }

    /// その PC の使用上限を読む。**初期スナップショット（REST）のための口**。
    ///
    /// カードの記録ではないので `SessionUpsert` に乗らない。**乗せる先が REST しか
    /// 無い**ので、`account::agents_of` がここから引いてかぶせる。
    pub fn rate_limits_of(
        &self,
        account_id: Uuid,
        agent_id: Option<AgentId>,
    ) -> Option<RateLimits> {
        self.rate_limits
            .lock()
            .expect("ロックが壊れていない")
            .get(&(account_id, agent_id))
            // **指紋は返さない。** これは REST の初期値を作る口で、行き先はブラウザ
            // である。画面はこの値を読まないので、渡す理由が無い
            .map(|stored| stored.limits.clone())
    }

    async fn append(
        &self,
        origin: &ReportOrigin,
        card_id: CardId,
        nodes: Vec<TreeNode>,
    ) -> Result<(), DbErr> {
        let Some(record) = self.owned(origin.account_id, card_id) else {
            // 知らないカードの履歴は捨てる。外した直後に届いたぶんで一覧を汚さない
            return Ok(());
        };
        {
            let mut next = record.next_seq.lock().await;
            db_transcript::append(&self.db, card_id, &nodes, &mut next).await?;
        }
        record
            .window
            .lock()
            .expect("ロックが壊れていない")
            .append(&nodes);
        // 履歴は一覧の口（`events`）ではなく、そのカードを見ている人だけへ流す。
        // **跨ぎのぶんは連絡係へ別に流す**——向こうのインスタンスで見ている人が
        // 居るかどうかは、こちらからは分からない
        let message = ServerMessage::TranscriptAppend { card_id, nodes };
        self.publish_bus(record.account_id, &message);
        record.fanout(&message);
        Ok(())
    }

    async fn reset(&self, origin: &ReportOrigin, card_id: CardId) -> Result<(), DbErr> {
        let Some(record) = self.owned(origin.account_id, card_id) else {
            return Ok(());
        };
        {
            let mut next = record.next_seq.lock().await;
            db_transcript::reset(&self.db, card_id).await?;
            // 全部消したので番号も最初から。残すと、次のノードが遠い番号から始まる
            *next = 0;
        }
        record.window.lock().expect("ロックが壊れていない").clear();
        // 作り直しと追記は**同じ列**を通る（連絡係が順序を守る）。逆になると、
        // 消したはずの履歴が残ったまま続きが積まれる（設計§6-2）
        let message = ServerMessage::TranscriptReset { card_id };
        self.publish_bus(record.account_id, &message);
        record.fanout(&message);
        Ok(())
    }

    /// 記録を DB へ書く（無ければ作る）。
    /// カードの行を書く。**外した行には書かず `false`**（実装レビュー第9回 Astra 2）。
    async fn write_session(
        &self,
        origin: &ReportOrigin,
        meta: &SessionMeta,
    ) -> Result<bool, DbErr> {
        let row = entity::sessions::ActiveModel {
            card_id: Set(meta.card_id.0),
            agent_id: Set(meta.agent_id.map(|id| id.0)),
            account_id: Set(origin.account_id),
            project: Set(meta.project.0.clone()),
            claude_session_id: Set(meta.claude_session_id.map(|id| id.0)),
            resumed_from: Set(meta.resumed_from.map(|id| id.0)),
            permission_mode: Set(meta
                .permission_mode
                .as_ref()
                .map(|mode| mode.as_str().to_string())),
            model: Set(meta.model.as_ref().map(|id| id.as_str().to_string())),
            model_label: Set(meta.model_label.clone()),
            model_requested: Set(meta
                .model_requested
                .as_ref()
                .map(|id| id.as_str().to_string())),
            status: Set(serde_json::to_value(meta.status).unwrap_or(serde_json::Value::Null)),
            subagent_active: Set(meta.subagent_active as i32),
            last_activity_at: Set(meta.last_activity_at),
            last_assistant_message: Set(meta.last_assistant_message.clone()),
            created_at: Set(meta.created_at),
            hooks_seen: Set(meta.hooks_seen),
            archived: Set(false),
            toml_account: Set(meta.toml_account.clone()),
            session_title: Set(meta.session_title.clone()),
            // **この値が効くのは行が無いときだけ。** 下の `on_conflict` は `Position` を
            // 更新列に入れていないので、既にあるカードの並びは報告のたびに動かない。
            // 値そのものは `upsert` が決めている（記録の側が正・新しい1枚だけ末尾）
            position: Set(meta.position),
        };
        let written = entity::sessions::Entity::insert(row)
            .on_conflict(
                OnConflict::column(entity::sessions::Column::CardId)
                    .update_columns([
                        entity::sessions::Column::AgentId,
                        entity::sessions::Column::Project,
                        entity::sessions::Column::ClaudeSessionId,
                        entity::sessions::Column::PermissionMode,
                        entity::sessions::Column::Model,
                        entity::sessions::Column::ModelLabel,
                        entity::sessions::Column::ModelRequested,
                        entity::sessions::Column::Status,
                        entity::sessions::Column::SubagentActive,
                        entity::sessions::Column::LastActivityAt,
                        entity::sessions::Column::LastAssistantMessage,
                        entity::sessions::Column::HooksSeen,
                        entity::sessions::Column::TomlAccount,
                        // `SessionTitle` は更新する。**渡す値のほうを正しくしてある**ので
                        // （空の報告は `upsert` が記録の名前で埋め直す。§6-1）、
                        // ここで例外を作らない
                        entity::sessions::Column::SessionTitle,
                        // `ResumedFrom` も更新する。**外すと復旧が書けない**——
                        // `revive` は新しいカードを採番せず**既にあるカードを使い回す**
                        // ので、行は必ず既にある。更新列から外すと、復旧で頼んだIDが
                        // 永久に書かれない。空の報告で消さない扱いは `SessionTitle` と
                        // 同じく `upsert` 側で行う
                        entity::sessions::Column::ResumedFrom,
                        // `Archived` は**更新しない**。外したことは後から届く報告で
                        // 取り消されてはいけない（上の `upsert` の門と対になっている）。
                        // `AccountId` も**更新しない**。帰属は最初の報告で決まり、
                        // 後から別のアカウントの PC が同じIDを名乗っても動かない（§8-6）
                    ])
                    // **外した行には書かない**（実装レビュー第9回 Astra 2）。表の名前付きで書く
                    // ——ぶつかった既存の行を指す
                    .action_and_where(sea_orm::sea_query::ExprTrait::eq(
                        sea_orm::sea_query::Expr::col((
                            entity::sessions::Entity,
                            entity::sessions::Column::Archived,
                        )),
                        false,
                    ))
                    .to_owned(),
            )
            .exec_without_returning(&self.db)
            .await?;
        Ok(written > 0)
    }

    /// そのアカウントのカードとして、一覧から外し終えているか（寝ているカードばかりなのに、
    /// メモリ不足でセッションを起こせない 実装レビュー第7回 Astra 1）。
    ///
    /// PC が外したカードの実体をまだ持っていないかを照合する口（`gateway.rs` の
    /// `SessionUpsert`）。**他のアカウントのカードには偽を返す**（他人のカードの ID で PC を
    /// 片付けさせない）。
    ///
    /// **手元の記録の有無で省かず、いつも DB を見る**（実装レビュー第9回 Astra 2）。手元の記録は、
    /// 外した知らせを購読していなかった間の古いものでありうる。記録を外すのは DB に書けたとき
    /// だけなので、DB が正。名乗りのたびに1回引くことになる。
    ///
    /// **確かめられなければ `Err`**（実装レビュー第9回 Astra 3）。以前は「外していない」と同じ
    /// 偽にしていたので、入力待ちで以後名乗らないカードは、DB が戻っても二度と照合されなかった。
    /// 呼ぶ側が持ち続けて確かめ直す。
    pub async fn removed_card(&self, account_id: Uuid, card_id: CardId) -> Result<bool, DbErr> {
        if self.reconcile_fail_once.swap(false, Ordering::SeqCst) {
            return Err(DbErr::Custom("試験で差し込んだ読み取りの失敗".to_string()));
        }
        let hold = self
            .reconcile_hold
            .lock()
            .expect("ロックが壊れていない")
            .clone();
        if let Some(hold) = hold {
            hold.reached.fetch_add(1, Ordering::SeqCst);
            if hold.gate.acquire().await.is_err() {
                tracing::warn!(%card_id, "照合の読み取りを止める門が閉じられました（試験の作り）");
            }
        }
        Ok(matches!(
            self.stored(card_id).await?,
            Some((owner, true, _, _)) if owner == account_id
        ))
    }

    /// 次の照合（[`Self::removed_card`]）の DB の読み取りを1回だけ失敗させる（**テスト専用**）。
    /// 照合だけに効く——更新が DB を読むところには効かない。
    #[doc(hidden)]
    pub fn 照合の読みを1回失敗させる(&self) {
        self.reconcile_fail_once.store(true, Ordering::SeqCst);
    }

    /// 照合（[`Self::removed_card`]）の DB の読み取りを、開けるまで止める（**テスト専用**。実装
    /// レビュー第10回 Astra 1）。「DB の答えが遅い」形を作る。
    #[doc(hidden)]
    pub fn 照合の読みを止める(&self) -> 照合の止め所 {
        let hold = 照合の止め所 {
            gate: Arc::new(tokio::sync::Semaphore::new(0)),
            reached: Arc::default(),
        };
        *self.reconcile_hold.lock().expect("ロックが壊れていない") = Some(hold.clone());
        hold
    }

    /// 差し込んだ失敗が、もう使われたか（**テスト専用**。形を作れたかを確かめる）。
    #[doc(hidden)]
    pub fn 照合の読みの失敗が使われた(&self) -> bool {
        !self.reconcile_fail_once.load(Ordering::SeqCst)
    }

    /// DB に残っているそのカードの `(持ち主, 外したか)`。行が無ければ `None`。
    ///
    /// 記録が手元に無いときだけ引く。**持ち主と外した印を一度に取る**のは、
    /// 別々に引くと2回問い合わせることになり、しかも間に状態が変わりうるため。
    async fn stored(
        &self,
        card_id: CardId,
    ) -> Result<Option<(Uuid, bool, i32, Option<ClaudeSessionId>)>, DbErr> {
        Ok(entity::sessions::Entity::find_by_id(card_id.0)
            .one(&self.db)
            .await?
            .map(|row| {
                (
                    row.account_id,
                    row.archived,
                    row.position,
                    row.resumed_from.map(ClaudeSessionId),
                )
            }))
    }

    /// そのカードの記録を取り出す。無ければ作る。**一覧から外したカードは作らず `None` を返す**
    /// （実装レビュー第5回 Astra 1。[`RemovedCards`]）。
    async fn record_for(
        &self,
        account_id: Uuid,
        card_id: CardId,
    ) -> Result<Option<Arc<SessionRecord>>, DbErr> {
        if let Some(record) = self.get(card_id) {
            return Ok(Some(record));
        }
        // 作るには DB を読むので、ロックの外で用意してから入れ直す
        let next_seq = db_transcript::next_seq(&self.db, card_id).await?;
        let latest = db_transcript::latest(&self.db, card_id, self.window_nodes).await?;

        let mut records = self.records.lock().expect("ロックが壊れていない");
        // 待っている間に別の報告が作っていることがある
        if let Some(record) = records.get(&card_id) {
            return Ok(Some(Arc::clone(record)));
        }
        // **外した印は記録の表のロックを握ったまま見る**（[`Self::drop_record`] と対）
        if self
            .removed
            .lock()
            .expect("ロックが壊れていない")
            .contains(account_id, card_id)
        {
            return Ok(None);
        }
        let record = Arc::new(SessionRecord::new(
            placeholder_meta(card_id),
            account_id,
            self.window_nodes,
            next_seq,
            true,
        ));
        record
            .window
            .lock()
            .expect("ロックが壊れていない")
            .fill(latest);
        records.insert(card_id, Arc::clone(&record));
        Ok(Some(record))
    }
}

/// その枠に振る、次のカードの並び順（並べ替え設計§2-4）。**先頭へ足す。**
///
/// **起こしたばかりのセッションは、いちばん見たいもの**なので目の前に出す。末尾へ
/// 足すと、枠が横に伸びるほど新しい1枚が画面の外へ出ていく。
///
/// カードの `position` は**枠の中で閉じている**ので、絞りは枠の同一性
/// `(account_id, agent_id, project)` と同じ3つで掛ける。**`agent_id` は
/// ローカルモードで `NULL` になる**ので、`eq(None)` ではなく `is_null()` を使う——
/// SQL の `= NULL` はどの行にも当たらず、ローカルのカードが毎回 0 から振り直される。
///
/// 枠にカードが1枚も無ければ 0。**いちばん小さい値から1を引く**ので負になるが、
/// 読み出しは昇順なので自然に先頭へ来る。**空きは詰め直さない**（並べ替えの口が
/// 丸ごと受け取って 0 から振り直すので、穴はそこで消える）。
///
/// **`order_by_asc` と `saturating_sub` は対である。** 片方だけ直すと「いちばん
/// 大きい値から1を引く」になり、2枚目以降が既にあるカードと同じ位置へ入る。
async fn next_card_position(
    db: &DatabaseConnection,
    account_id: Uuid,
    agent_id: Option<Uuid>,
    project: &str,
) -> Result<i32, DbErr> {
    let found = entity::sessions::Entity::find()
        .filter(entity::sessions::Column::AccountId.eq(account_id))
        .filter(entity::sessions::Column::Project.eq(project));
    let found = match agent_id {
        Some(id) => found.filter(entity::sessions::Column::AgentId.eq(id)),
        None => found.filter(entity::sessions::Column::AgentId.is_null()),
    };
    let first = found
        .order_by_asc(entity::sessions::Column::Position)
        .one(db)
        .await?;
    Ok(first.map_or(0, |row| row.position.saturating_sub(1)))
}

/// 利用者が付けた名前を DB からまとめて読む（名前付け設計§4-1）。
///
/// `account` を渡せばそのアカウントのぶんだけ、渡さなければ全アカウントぶん。
/// **1回の問い合わせで済ませる**——カードごとに引くと、一覧の復元だけで枚数ぶんの
/// 往復が出る。
async fn load_nicknames(
    db: &DatabaseConnection,
    account: Option<Uuid>,
) -> Result<HashMap<(Uuid, ClaudeSessionId), String>, anyhow::Error> {
    let mut query = entity::session_nicknames::Entity::find();
    if let Some(account_id) = account {
        query = query.filter(entity::session_nicknames::Column::AccountId.eq(account_id));
    }
    Ok(query
        .all(db)
        .await?
        .into_iter()
        .map(|row| {
            (
                (row.account_id, ClaudeSessionId(row.claude_session_id)),
                row.nickname,
            )
        })
        .collect())
}

/// 枝分かれの印を DB からまとめて読む（ブランチ設計§5-2）。
///
/// `account` を渡せばそのアカウントのぶんだけ、渡さなければ全アカウントぶん。
/// **1回の問い合わせで済ませる**——名前と同じ理由で、カードごとに引くと一覧の復元
/// だけで枚数ぶんの往復が出る。
async fn load_branches(
    db: &DatabaseConnection,
    account: Option<Uuid>,
) -> Result<HashMap<(Uuid, ClaudeSessionId), ClaudeSessionId>, anyhow::Error> {
    let mut query = entity::session_branches::Entity::find();
    if let Some(account_id) = account {
        query = query.filter(entity::session_branches::Column::AccountId.eq(account_id));
    }
    Ok(query
        .all(db)
        .await?
        .into_iter()
        .map(|row| {
            (
                (row.account_id, ClaudeSessionId(row.claude_session_id)),
                ClaudeSessionId(row.branched_from),
            )
        })
        .collect())
}

/// [`SessionRecord`] を作る瞬間だけ使う仮の中身。
///
/// 直後に本物の [`SessionMeta`] で上書きされる。空の入れ物を作らないのは、
/// 「まだ埋まっていない meta」を型で表すと、読む側が毎回 `Option` を剥がすことになるため。
/// 届いた使用上限を、手元の値へ窓ごとに畳み込む（status設計「手当ては2つ」）。
///
/// # なぜ上書きではなく畳み込みなのか
///
/// **セッションが N 本走っていれば、同じ PC の値が N 本の経路から届く**。どれも
/// その瞬間の真実だが、**届く順は保証されない**——あとから来たものが古いことがある。
/// 素直に上書きすると、**使用率が行ったり来たりする画面**になる。
///
/// # 窓ごとの規則は3つ
///
/// | 届いた `resets_at` | どうするか | なぜ |
/// |---|---|---|
/// | 手元より**新しい** | **そのまま採る** | **窓が切り替わった。** パーセントは当然下がる |
/// | 手元と**同じ** | **大きいほうを採る** | 同じ窓の中では減らない。小さい値は古い報告 |
/// | 手元より**古い** | **捨てる** | 遅れて届いた報告 |
///
/// **`resets_at` を鍵に入れないと、窓が切り替わってパーセントが偶然同じだったときに
/// 切替を配り落とす**（[`protocol::RateLimitWindow::resets_at`] の doc）。
///
/// # 並びは手元のものを保つ
///
/// 呼び手が `==` で「配るかどうか」を決めるので、**並び順が変わると中身が同じでも
/// 配ってしまう**。だから手元の並びを崩さず、知らない窓だけを末尾へ足す。
/// **claude のログインが別のものへ変わったと言い切れるか。**
///
/// # 「分からない」を「変わった」と読まない
///
/// 指紋は読めないことがある（ログインしていない・ファイルが無い・API キー利用・
/// 欄を持たない古い PC）。**`None` は「変わった」ではなく「分からない」**なので、
/// 片方でも `None` なら**変わっていない扱い**にする。
///
/// 逆にすると壊れ方がひどい。読めない環境では**3秒ごとに `None` が届く**ので、
/// 毎回「切り替わった」と判定して合流が丸ごと効かなくなり、**セッションを N 本
/// 走らせているときに数字が跳ね回る**（合流はそれを防ぐために在る）。
///
/// # 知らなかった相手を初めて知ったときも、変わっていない
///
/// `None` → `Some` は「切り替わった」ではなく「読めるようになった」である。
/// **古い PC が新しい版へ上がった直後がこれに当たる**——ここで入れ替えると、
/// 版を上げるたびに数字が1回飛ぶ。
fn login_changed(
    stored: Option<&ClaudeLoginFingerprint>,
    incoming: Option<&ClaudeLoginFingerprint>,
) -> bool {
    matches!((stored, incoming), (Some(前), Some(いま)) if 前 != いま)
}

fn merge_rate_limits(current: Option<&RateLimits>, incoming: &RateLimits) -> RateLimits {
    let Some(current) = current else {
        return incoming.clone();
    };
    let mut windows = current.windows.clone();
    for fresh in &incoming.windows {
        match windows.iter_mut().find(|known| known.name == fresh.name) {
            Some(known) if fresh.resets_at > known.resets_at => *known = fresh.clone(),
            Some(known) if fresh.resets_at == known.resets_at => {
                known.used_percentage = known.used_percentage.max(fresh.used_percentage);
            }
            // 古い `resets_at` は捨てる
            Some(_) => {}
            None => windows.push(fresh.clone()),
        }
    }
    RateLimits { windows }
}

fn placeholder_meta(card_id: CardId) -> SessionMeta {
    SessionMeta {
        card_id,
        project: ProjectId(String::new()),
        claude_session_id: None,
        resumed_from: None,
        permission_mode: None,
        model: None,
        model_label: None,
        model_requested: None,
        status: SessionStatus::Unknown,
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

fn meta_from_row(row: entity::sessions::Model) -> SessionMeta {
    SessionMeta {
        card_id: CardId(row.card_id),
        project: ProjectId(row.project),
        claude_session_id: row.claude_session_id.map(ClaudeSessionId),
        resumed_from: row.resumed_from.map(ClaudeSessionId),
        permission_mode: row.permission_mode.map(PermissionMode::new),
        model: row.model.map(ModelId::new),
        model_label: row.model_label,
        model_requested: row.model_requested.map(ModelId::new),
        // 読めない状態は「不明」に落とす。**捨てずに、分からないと言う**
        status: serde_json::from_value(row.status).unwrap_or(SessionStatus::Unknown),
        subagent_active: row.subagent_active as u32,
        last_activity_at: row.last_activity_at,
        last_assistant_message: row.last_assistant_message,
        created_at: row.created_at,
        hooks_seen: row.hooks_seen,
        agent_id: row.agent_id.map(protocol::AgentId),
        // 読み出した時点では「繋がっていない」。報告が来たら立つ
        agent_connected: false,
        account: None,
        toml_account: row.toml_account,
        session_title: row.session_title,
        position: row.position,
        nickname: None,
        branched_from: None,
        context_usage: None,
        rate_limits: None,
        cost: None,
    }
}
