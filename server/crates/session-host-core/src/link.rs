//! ダッシュボードサーバへの常時接続（セルフホスト化設計§4・§6）。
//!
//! ローカルモードで「同じプロセスの記録層へ渡す」だったところが、セルフホストモードでは
//! ここになる。**報告する口（[`EventSink`]）としては同じ顔**をしているので、
//! [`crate::session::SessionManager`] から見た使い方は変わらない。
//!
//! # 切断はデータを失わせない。遅らせるだけ
//!
//! 繋がっていない間も PTY・フック受信・パースは通常どおり動く（全部 PC の中で完結して
//! いる）。履歴は手元に溜め、繋がったら送り直す。**位置を進めるのは ack が返ってから**
//! なので、途中で落ちても同じところから読み直せる（§6-1）。
//!
//! 状態の知らせ（`Status` など）は切断中に捨てる。復帰したときに全セッションの
//! `SessionUpsert` を送り直すので、**中間の遷移を再生する意味が無い**（§6-4）。
//! ダッシュボードが必要とするのは「最新の状態」と「完全な履歴」で、その2つは
//! 別の方法で守られている。
//!
//! # 溜めるほうにも上限を置く（2026-08-16 に改めた）
//!
//! 以前ここには「上限を置かない」と書いてあった。捨てると「欠落なし」（要件の非機能）が
//! 壊れる、という理由である。**畳み先を変えたので、その理由は当たらなくなった**——捨てるのは
//! 送る予定だった写しだけで、履歴そのものは利用者の機械の JSONL に残っている。位置を忘れて
//! 頭から読み直せば、同じものが揃う（イシュー「溜まった履歴の ack が詰まって線が切れ続ける」
//! 設計§4-5）。
//!
//! したがっていまは3つの上限を持つ。**どれも「滅多に発動しない保険」**として置いてある。
//!
//! - **窓**……同時に未 ack にしてよいバッチの数（§3）
//! - **溜まりの上限**……カードごと／全カードの合計のノード数（§4-1）
//! - **1通の上限**……1つのバッチに入れるノード数（§4-6）。**これを超えると受け取る側が
//!   無言で接続をリセットする**（実測：21MB でリセット・15MB は通る）

use crate::{
    events::{EventSink, LocalEventBus, TranscriptReport},
    offsets::OffsetStore,
    session::{ALREADY_REVIVING, SessionManager},
};
use futures_util::{SinkExt as _, StreamExt as _};
use protocol::{
    CardId, TreeNode,
    a2s::{
        A2S_PROTOCOL, A2S_VERSION, AgentMessage, BatchId, HostReply, Intervals, RequestId,
        ServerToAgent,
    },
    frame::{self, FrameKind},
    ws::ServerMessage,
};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite;

/// 再接続の待ち時間（設計§6-3）。上限まで伸ばして、落ちているサーバを叩き続けない。
const BACKOFF_MS: [u64; 7] = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/// 生存確認を送る間隔（設計§4-1）。
const PING_INTERVAL: Duration = Duration::from_secs(10);

/// 何も届かないまま切断とみなすまで（設計§4-1）。
const SILENCE_TIMEOUT: Duration = Duration::from_secs(30);

/// 名乗りの応答を待つ上限。
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// 送る側が守る量の上限（設計§3-1・§4-1・§4-6）。
///
/// **1つの構造体にまとめてあるのは、テストから小さく差し替えるため**である。既定値のままだと
/// テストが実運用の量（3万ノード規模）を作ることになり、確かめたい性質より先に時間が尽きる。
/// **既定は本物の値**である（[`Limits::default`]）。小さくできる口は
/// [`SessionHostLink::set_limits`] にあるが、指定しなければ実運用の量へ落ちる——
/// 差し替え口を作るだけで既定を緩めると、本番だけが守られない形になる。
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// 同時に未 ack にしてよいバッチの数（設計§3-1）。
    ///
    /// 実測で決めた（2026-08-16）。1バッチの記録に 10.8ms・エッジまでの往復が 87〜101ms
    /// なので下限は約 8.3。上は 64 にしても追いつきが縮まらない。**32 は下限の約4倍で、
    /// 頭打ちの手前**にあたる。
    pub window: usize,
    /// 1枚のカードに溜めてよいノード数（設計§4-1）。
    ///
    /// 手元でいちばん大きいカードが 15,978 ノード。**読み直しが必ず収まるよう**その2倍。
    /// 収まらない値を置くと、そのカードは畳むたびに輪へ入る（設計§4-2）。
    pub card_nodes: usize,
    /// 全カードの合計（設計§4-1 の backstop）。1枚ずつは上限内でも全体が育つため。
    pub total_nodes: usize,
    /// **1通に入れるノード数**（設計§4-6）。
    ///
    /// 1フレームの上限は 16 MiB で、超えると受け取る側が**無言で接続をリセットする**。
    /// 1ノード平均 2.4 KB なので 1,500 ノード ≈ 3.6 MB、上限の4分の1以下に収まる。
    ///
    /// **ノード数だけでは上限を保証できない。** 1ノードが 200.7 KB に達した実測があり、
    /// 極端な並びなら 1,500 ノードでも 16 MiB を超えうる。保証が要るなら直列化した
    /// バイトで切ることになるが、数えるのに直列化が要る（設計§4-1）ので、まずは数で置く。
    pub batch_nodes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            window: 32,
            card_nodes: 32_768,
            total_nodes: 65_536,
            batch_nodes: 1_500,
        }
    }
}

/// 接続先と身分証。
#[derive(Debug, Clone)]
pub struct LinkConfig {
    /// ダッシュボードサーバ（`http://host:port` でも `ws://host:port` でもよい）
    pub server_url: String,
    pub pairing_token: String,
    /// この PC の名前。**アカウントの中でこの名前が PC の同一性**になる（§8-4）
    pub agent_name: String,
    /// 起動している CLI が受け付ける権限モード（名乗りで渡す）
    pub available_modes: Vec<protocol::PermissionMode>,
    /// セッションホスト側の toml のトグル（名乗りで渡す）
    pub always_bypass_permissions: bool,
}

impl LinkConfig {
    /// この PC の CLI が受け付ける権限モードを添える（§21 読み替え1）。
    ///
    /// サーバモードにはローカルの CLI が居ないので、名乗りで渡さないと**起動ボタンと
    /// 権限モードの選択肢が空になる**。起動時に `claude --help` から読んだものをそのまま運ぶ。
    pub fn with_capabilities(
        mut self,
        available_modes: Vec<protocol::PermissionMode>,
        always_bypass_permissions: bool,
    ) -> Self {
        self.available_modes = available_modes;
        self.always_bypass_permissions = always_bypass_permissions;
        self
    }
}

/// 報告の運び手（サーバへ繋ぐ側）。
pub struct SessionHostLink {
    config: LinkConfig,
    /// 同じプロセス内の購読者（自己修復）向け
    bus: LocalEventBus,
    outgoing: mpsc::UnboundedSender<Outgoing>,
    /// モデルの表（§13-4）。接続直後と変化時に送る。
    ///
    /// **部品のまま持つ。** 変わるのは別名の側だけ（実測の学習）なので、
    /// 差し替えてから組み立て直す
    model_table: Mutex<Option<ModelTable>>,
    /// 送る側が守る量の上限。**既定は本物の値**で、[`SessionHostLink::set_limits`] で
    /// だけ小さくできる（設計§8-1）
    limits: Mutex<Limits>,
    /// 常駐タスクへ渡す受け口。[`SessionHostLink::attach`] で取り出す
    inbox: Mutex<Option<mpsc::UnboundedReceiver<Outgoing>>>,
}

/// セッションホストが名乗るモデルの表（§13-4）。
#[derive(Clone)]
struct ModelTable {
    cli_version: String,
    catalog: serde_json::Value,
    aliases: serde_json::Value,
}

impl ModelTable {
    fn message(&self) -> AgentMessage {
        AgentMessage::ModelTable {
            cli_version: self.cli_version.clone(),
            catalog: self.catalog.clone(),
            aliases: self.aliases.clone(),
        }
    }
}

/// 上へ運ぶもの1件。
enum Outgoing {
    /// 状態の知らせ。**切断中は捨ててよい**（復帰時に送り直す）
    Volatile(AgentMessage),
    /// 履歴。ack が返るまで持ち続ける
    Transcript(TranscriptReport),
    Reset(CardId),
    /// モデルの表（接続していなければ、次に繋がったときに送る）
    ModelTable(AgentMessage),
    /// 画面のフレーム（0x04 / 0x05）。**切断中は捨てる**。
    ///
    /// 履歴と違って画面は「いま」しか意味を持たない。溜めて後から送ると、繋がった
    /// 瞬間に古い差分が順に流れて画面が踊る。繋ぎ直したら全画面から送り直す（§6-4）
    Screen(Vec<u8>),
}

impl SessionHostLink {
    /// 口だけ作る。**繋ぎ始めるのは [`SessionHostLink::attach`] を呼んでから。**
    ///
    /// 2段に分かれているのは、**セッションの持ち主（マネージャ）がこの口を受け取って
    /// から作られる**ため（パーサの世話役と同じ形）。順序は
    /// 「口を作る → マネージャを作る → 繋ぎ始める」。
    ///
    /// 繋ぎ始める前に報告されたものは溜まったままになる（捨てない）。
    pub fn new(config: LinkConfig) -> Arc<Self> {
        let (outgoing, inbox) = mpsc::unbounded_channel();
        Arc::new(Self {
            config,
            bus: LocalEventBus::new(),
            outgoing,
            model_table: Mutex::new(None),
            limits: Mutex::new(Limits::default()),
            inbox: Mutex::new(Some(inbox)),
        })
    }

    /// 送る側が守る量の上限を差し替える（設計§8-1 の「テストから小さく差し替える」）。
    ///
    /// **[`SessionHostLink::attach`] より前に呼ぶこと。** 常駐タスクは起きるときに
    /// 1度だけ読む。
    ///
    /// # なぜ製品の口として在るのか
    ///
    /// 既定のカードごとの上限は 32,768 ノードで、**統合テストからは現実的な時間で
    /// 踏めない**。差し替えられないと、畳みを確かめるテストは**一度も畳まないまま
    /// 緑になる**（ガイドライン「差し替え口を作るだけでは足りない」の裏返しで、
    /// ここでは口が無いこと自体が空振りを生む）。
    ///
    /// 指定しなければ [`Limits::default`]（実運用の値）のままである。
    pub fn set_limits(&self, limits: Limits) {
        *self.limits.lock().expect("ロックが壊れていない") = limits;
    }

    /// 常駐タスクを立てて繋ぎ始める。2度目以降は何もしない。
    pub fn attach(self: &Arc<Self>, manager: Arc<SessionManager>, offsets: Arc<OffsetStore>) {
        let Some(inbox) = self.inbox.lock().expect("ロックが壊れていない").take() else {
            return;
        };
        tokio::spawn(run(
            self.config.clone(),
            manager,
            offsets,
            Arc::clone(self),
            inbox,
        ));
    }

    /// モデルの表を差し込む（§13-4）。接続していれば即送り、していなければ次の接続で送る。
    pub fn set_model_table(
        &self,
        cli_version: String,
        catalog: serde_json::Value,
        aliases: serde_json::Value,
    ) {
        let table = ModelTable {
            cli_version,
            catalog,
            aliases,
        };
        let message = table.message();
        *self.model_table.lock().expect("ロックが壊れていない") = Some(table);
        let _ = self.outgoing.send(Outgoing::ModelTable(message));
    }
}

impl EventSink for SessionHostLink {
    fn emit(&self, event: ServerMessage) {
        if let Some(message) = to_agent_message(&event) {
            let _ = self.outgoing.send(Outgoing::Volatile(message));
        }
        // 手元の購読者（自己修復）にも配る。セルフホストでも修復は PC の中で完結する
        self.bus.emit(event);
    }

    fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
        self.bus.subscribe()
    }

    fn report_transcript(&self, report: TranscriptReport) {
        let _ = self.outgoing.send(Outgoing::Transcript(report));
    }

    fn reset_transcript(&self, card_id: CardId) {
        let _ = self.outgoing.send(Outgoing::Reset(card_id));
    }

    fn model_aliases_changed(&self, aliases: serde_json::Value) {
        let message = {
            let mut table = self.model_table.lock().expect("ロックが壊れていない");
            // まだ表を持っていないなら、送る形にできない（起動直後の一瞬だけ）。
            // 次の接続で改めて全部送るので、ここで作りかけを送る必要は無い
            let Some(table) = table.as_mut() else {
                return;
            };
            table.aliases = aliases;
            table.message()
        };
        let _ = self.outgoing.send(Outgoing::ModelTable(message));
    }

    /// **この報告先が居ることが、セルフホストモードであることの定義**（設計§7-2・§22 読み替え2）。
    fn screens_enabled(&self) -> bool {
        true
    }

    fn screen_frame(&self, frame: Vec<u8>) {
        let _ = self.outgoing.send(Outgoing::Screen(frame));
    }
}

/// ブラウザ向けの知らせを、サーバへの報告へ移す。
///
/// 履歴（`TranscriptAppend` / `TranscriptReset`）はここを通らない——**ack の要る経路**は
/// [`EventSink::report_transcript`] で受けるため。`Hello` はブラウザ専用なので運ばない。
fn to_agent_message(event: &ServerMessage) -> Option<AgentMessage> {
    Some(match event {
        ServerMessage::SessionUpsert { session } => AgentMessage::SessionUpsert {
            session: session.clone(),
        },
        ServerMessage::SessionRemoved { card_id } => {
            AgentMessage::SessionRemoved { card_id: *card_id }
        }
        ServerMessage::Status {
            card_id,
            status,
            subagent_active,
            last_activity_at,
        } => AgentMessage::Status {
            card_id: *card_id,
            status: *status,
            subagent_active: *subagent_active,
            last_activity_at: *last_activity_at,
        },
        ServerMessage::ParserStatus { state, detail } => AgentMessage::ParserStatus {
            state: *state,
            detail: detail.clone(),
        },
        ServerMessage::Selfheal { phase, detail } => AgentMessage::Selfheal {
            phase: *phase,
            detail: detail.clone(),
        },
        ServerMessage::Error { card_id, message } => AgentMessage::Error {
            card_id: *card_id,
            message: message.clone(),
        },
        // `BusStatus` はサーバ同士の話（インスタンスの間の連絡係。設計§12）。
        // **PC は自分が繋いだ1台としか話さない**ので、運ぶ意味も運ぶ手段も無い。
        //
        // PJT 枠（`ProjectUpsert` / `ProjectRemoved`）は**サーバの記録**で、PC は
        // 持っていない（イシューグループ_2026_0805_0514 設計§2）。足すのも消すのも
        // ブラウザ → サーバの REST で完結するので、こちらへ運ぶ経路は要らない
        ServerMessage::Hello { .. }
        | ServerMessage::TranscriptAppend { .. }
        | ServerMessage::TranscriptReset { .. }
        | ServerMessage::BusStatus { .. }
        | ServerMessage::ProjectUpsert { .. }
        | ServerMessage::ProjectRemoved { .. } => return None,
    })
}

/// ack を待っている、または待たせている履歴1件。**1件がそのまま1通になる。**
struct Pending {
    batch_id: BatchId,
    card_id: CardId,
    /// **この接続で送り出したか**（設計§3-2）。
    ///
    /// `inflight` に居ることと、いまの接続で出したことは別である。切れたら全部 `false` へ
    /// 戻すので、この印が「窓を何件ぶん埋めているか」の唯一の根拠になる。
    sent: bool,
    kind: PendingKind,
}

enum PendingKind {
    /// 送るノードと、**入ったら進めてよい位置**
    Nodes {
        nodes: Vec<TreeNode>,
        commits: Vec<Commit>,
    },
    /// 巻き戻し。入ったら位置を忘れる
    Reset,
}

struct Commit {
    transcript_path: String,
    source: String,
    next_offset: u64,
}

impl Pending {
    fn message(&self) -> AgentMessage {
        match &self.kind {
            PendingKind::Nodes { nodes, .. } => AgentMessage::TranscriptBatch {
                batch_id: self.batch_id,
                card_id: self.card_id,
                nodes: nodes.clone(),
            },
            PendingKind::Reset => AgentMessage::TranscriptReset {
                batch_id: self.batch_id,
                card_id: self.card_id,
            },
        }
    }

    fn node_count(&self) -> usize {
        match &self.kind {
            PendingKind::Nodes { nodes, .. } => nodes.len(),
            PendingKind::Reset => 0,
        }
    }
}

/// 1枚のカードを畳んだ履歴（設計§4-2 の歯止め2つ）。
#[derive(Debug, Default)]
struct FoldState {
    /// 畳んで積んだ `Reset` の ack をまだ待っている。**この間は二度畳まない**
    waiting_reset: bool,
    /// 一度畳んで、読み直しまで済んだ
    folded_once: bool,
    /// 読み直した結果がまた上限を超えた。**畳んでも小さくならないので、もう畳まない**
    gave_up: bool,
}

/// 履歴の送り出し（セルフホスト化設計§6-1・§6-2 と、イシュー設計§3・§4）。
struct Outbox {
    offsets: Arc<OffsetStore>,
    next_id: u64,
    /// まだ束ねている途中のぶん。**到着順を保つ**（巻き戻しが追い越さないため）
    buffered: Vec<Pending>,
    /// 送ったが ack が返っていないぶん
    inflight: Vec<Pending>,
    limits: Limits,
    /// 畳んだので**監視を止めてほしい**カード（設計§4-3）
    needs_unwatch: Vec<CardId>,
    /// `Reset` が入ったので**読み直しを頼んでほしい**カード（設計§4-3）
    needs_rewatch: Vec<CardId>,
    /// 畳んだカードの履歴。**輪に入らないための歯止め**（設計§4-2）
    fold: HashMap<CardId, FoldState>,
}

impl Outbox {
    fn new(offsets: Arc<OffsetStore>) -> Self {
        Self {
            offsets,
            next_id: 1,
            buffered: Vec::new(),
            inflight: Vec::new(),
            limits: Limits::default(),
            needs_unwatch: Vec::new(),
            needs_rewatch: Vec::new(),
            fold: HashMap::new(),
        }
    }

    fn take_id(&mut self) -> BatchId {
        let id = BatchId(self.next_id);
        self.next_id += 1;
        id
    }

    /// 読んだぶんを積む。**同じカードの続きなら1つのバッチにまとめる**。
    ///
    /// まとめてよいのは、間に巻き戻しが挟まっていないときだけ（§6-2）。挟まっていたら
    /// 別のバッチになり、順序どおりに送られる。
    fn push(&mut self, report: TranscriptReport) {
        let TranscriptReport {
            card_id,
            transcript_path,
            source,
            next_offset,
            nodes,
        } = report;
        let commit = Commit {
            transcript_path,
            source,
            next_offset,
        };

        // **1通の上限は、出すときではなく積むときに効かせる**（設計§4-6）。ここで
        // 割っておけば「1つの Pending ＝ 1通」が保たれ、ack との対応が 1:1 のまま崩れない
        let cap = self.limits.batch_nodes.max(1);
        let mut rest: VecDeque<TreeNode> = nodes.into();

        loop {
            let index = match Self::mergeable_index(&self.buffered, card_id) {
                // 空きがあるか、載せるものがもう無い（＝位置だけ付ける）なら、その相手でよい
                Some(index) if self.buffered[index].node_count() < cap || rest.is_empty() => index,
                _ => {
                    let batch_id = self.take_id();
                    self.buffered.push(Pending {
                        batch_id,
                        card_id,
                        sent: false,
                        kind: PendingKind::Nodes {
                            nodes: Vec::new(),
                            commits: Vec::new(),
                        },
                    });
                    self.buffered.len() - 1
                }
            };

            let PendingKind::Nodes {
                nodes: acc,
                commits,
            } = &mut self.buffered[index].kind
            else {
                unreachable!("載せ先は必ず Nodes（探す側も積む側も Nodes しか返さない）");
            };

            let take = cap.saturating_sub(acc.len()).min(rest.len());
            acc.extend(rest.drain(..take));
            if rest.is_empty() {
                // **位置を進めてよいのは、その報告を載せ終えた断片だけ。** 手前の断片に
                // 付けると、そちらだけ ack が返った時点で**まだ入っていないノードの先まで
                // 位置が進む**——読み直しても戻れないので、そのまま欠落になる
                commits.push(commit);
                break;
            }
        }

        self.enforce_limits(card_id);
    }

    /// 同じカードの、**巻き戻しを挟まない**最後のバッチ（セルフホスト化設計§6-2）。
    fn mergeable_index(buffered: &[Pending], card_id: CardId) -> Option<usize> {
        buffered
            .iter()
            .enumerate()
            .rev()
            .take_while(|(_, pending)| {
                pending.card_id != card_id || matches!(pending.kind, PendingKind::Nodes { .. })
            })
            .find(|(_, pending)| pending.card_id == card_id)
            .map(|(index, _)| index)
    }

    fn push_reset(&mut self, card_id: CardId) {
        let batch_id = self.take_id();
        self.buffered.push(Pending {
            batch_id,
            card_id,
            sent: false,
            kind: PendingKind::Reset,
        });
        self.enforce_limits(card_id);
    }

    /// 送れるぶんだけ出す（設計§3-2）。**`flush()` と `resend()` を一本化したもの。**
    ///
    /// 返すのは `窓 − 送出済みで未 ack の数` 件まで。順は
    ///
    /// 1. `inflight` のうち、**この接続でまだ出していない**もの（＝復帰時の送り直し）
    /// 2. `buffered` の先頭から、窓が空いているぶん
    ///
    /// **並べ替えない**（設計§3-4）。窓が絞るのは先頭から何件出すかだけで、
    /// セルフホスト化設計§6-2 の送信順序は崩さない。
    fn pump(&mut self) -> Vec<AgentMessage> {
        let window = self.limits.window.max(1);
        let sent = self.inflight.iter().filter(|pending| pending.sent).count();
        let mut room = window.saturating_sub(sent);
        let mut messages = Vec::new();

        for pending in self.inflight.iter_mut() {
            if room == 0 {
                return messages;
            }
            if pending.sent {
                continue;
            }
            pending.sent = true;
            messages.push(pending.message());
            room -= 1;
        }

        let take = room.min(self.buffered.len());
        for mut pending in self.buffered.drain(..take).collect::<Vec<_>>() {
            pending.sent = true;
            messages.push(pending.message());
            self.inflight.push(pending);
        }
        messages
    }

    /// 切れたので、送出済みの印を**全部下ろす**（設計§3-2）。
    ///
    /// 次の接続では、この印が下りているぶんが送り直しの対象になる。
    fn unmark_sent(&mut self) {
        for pending in self.inflight.iter_mut() {
            pending.sent = false;
        }
    }

    /// **記録に入った**ので位置を進める。
    fn ack(&mut self, batch_id: BatchId) {
        let Some(at) = self
            .inflight
            .iter()
            .position(|pending| pending.batch_id == batch_id)
        else {
            // 二重の ack（再送が両方届いた等）。位置は既に進んでいるので何もしない
            return;
        };
        let pending = self.inflight.remove(at);
        match pending.kind {
            PendingKind::Nodes { commits, .. } => {
                for commit in commits {
                    self.offsets.commit(
                        pending.card_id,
                        &commit.transcript_path,
                        &commit.source,
                        commit.next_offset,
                    );
                }
            }
            PendingKind::Reset => {
                self.offsets.forget(pending.card_id);
                // 畳んで積んだ `Reset` なら、**ここが読み直しを頼む時機**（設計§4-2 の5）。
                // 位置を忘れただけでは何も起きない——頼み直して初めて頭から読まれる
                if let Some(state) = self.fold.get_mut(&pending.card_id) {
                    if state.waiting_reset {
                        state.waiting_reset = false;
                        state.folded_once = true;
                        self.needs_rewatch.push(pending.card_id);
                    }
                }
            }
        }
    }

    fn pending_count(&self) -> usize {
        self.buffered.len() + self.inflight.len()
    }

    fn card_nodes(&self, card_id: CardId) -> usize {
        self.buffered
            .iter()
            .chain(self.inflight.iter())
            .filter(|pending| pending.card_id == card_id)
            .map(Pending::node_count)
            .sum()
    }

    fn total_nodes(&self) -> usize {
        self.buffered
            .iter()
            .chain(self.inflight.iter())
            .map(Pending::node_count)
            .sum()
    }

    /// 上限を超えていたら畳む（設計§4-1・§4-2）。
    ///
    /// **呼ぶのは積むとき（`push` ／ `push_reset`）であって、出すとき（`pump`）ではない。**
    /// `pump()` は繋がっているときしか呼ばれないので、そこに置くと**切断中はいくらでも
    /// 育つ**——いちばん抑えたい場合がちょうど抜ける。
    fn enforce_limits(&mut self, card_id: CardId) {
        if self.card_nodes(card_id) > self.limits.card_nodes {
            self.fold(card_id);
        }
        if self.total_nodes() <= self.limits.total_nodes {
            return;
        }
        // 全体の backstop（設計§4-1）。1枚ずつは上限内でも、枚数が多いと育つ。
        // **大きいカードから**畳んで、合計が下回ったらそこで止める
        let mut cards: Vec<CardId> = self
            .buffered
            .iter()
            .chain(self.inflight.iter())
            .map(|pending| pending.card_id)
            .collect();
        cards.sort_unstable();
        cards.dedup();
        cards.sort_by_key(|card| std::cmp::Reverse(self.card_nodes(*card)));
        for card in cards {
            if self.total_nodes() <= self.limits.total_nodes {
                break;
            }
            self.fold(card);
        }
    }

    /// 1枚のカードを畳む（設計§4-2）。畳んだら `true`。
    ///
    /// 捨てるのは**送る予定だった写し**だけで、履歴そのものは利用者の機械の JSONL に残って
    /// いる。位置を忘れて頭から読み直せば同じものが揃う（設計§4-5）。
    fn fold(&mut self, card_id: CardId) -> bool {
        enum Decision {
            Fold,
            GiveUp,
            Skip,
        }
        let decision = {
            let state = self.fold.entry(card_id).or_default();
            if state.gave_up || state.waiting_reset {
                // **二度畳まない。** 畳んだ結果が入る前にもう一度畳むと、
                // 畳んでは読み直す輪になる
                Decision::Skip
            } else if state.folded_once {
                state.gave_up = true;
                Decision::GiveUp
            } else {
                state.waiting_reset = true;
                Decision::Fold
            }
        };

        match decision {
            Decision::Skip => false,
            Decision::GiveUp => {
                // 読み直した結果がまた超えた＝**このカードは畳んでも小さくならない**。
                // 輪になるほうが害が大きいので、やめて1行残す（設計§4-2）
                tracing::warn!(
                    %card_id,
                    nodes = self.card_nodes(card_id),
                    "読み直しても上限を超えるので、これ以上畳みません"
                );
                false
            }
            Decision::Fold => {
                let dropped = self.card_nodes(card_id);
                self.buffered.retain(|pending| pending.card_id != card_id);
                self.inflight.retain(|pending| pending.card_id != card_id);
                self.needs_unwatch.push(card_id);
                let batch_id = self.take_id();
                self.buffered.push(Pending {
                    batch_id,
                    card_id,
                    sent: false,
                    kind: PendingKind::Reset,
                });
                tracing::warn!(
                    %card_id,
                    nodes = dropped,
                    "溜まりが上限を超えたので畳みました。読み直して送り直します"
                );
                true
            }
        }
    }

    /// 監視を止めてほしいカードを取り出す。**取り出したら消える**（設計§4-3）。
    ///
    /// 適用するのは `manager` を持っている側（[`apply_marks`]）。`Outbox` から
    /// `SessionManager` を呼ぶと参照が輪になる（manager → events → link → outbox → manager）。
    fn take_unwatch(&mut self) -> Vec<CardId> {
        std::mem::take(&mut self.needs_unwatch)
    }

    /// 読み直しを頼んでほしいカードを取り出す。**取り出したら消える**（設計§4-3）。
    fn take_rewatch(&mut self) -> Vec<CardId> {
        std::mem::take(&mut self.needs_rewatch)
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 常駐タスク。繋がるまで待ち、繋がっている間は運び、切れたらまた待つ。
async fn run(
    config: LinkConfig,
    manager: Arc<SessionManager>,
    offsets: Arc<OffsetStore>,
    link: Arc<SessionHostLink>,
    mut inbox: mpsc::UnboundedReceiver<Outgoing>,
) {
    let mut outbox = Outbox::new(offsets);
    outbox.limits = *link.limits.lock().expect("ロックが壊れていない");
    let mut attempt = 0usize;

    loop {
        // **繋がるのを待っている間も報告は受け取る。** 待ち行列を止めると、報告を出す側
        // （フックの処理・パーサの読み取り）が詰まる
        let socket =
            match connect_waiting(&config, &manager, &mut inbox, &mut outbox, attempt).await {
                Some(socket) => socket,
                // 送り口が全部落ちた＝プロセスが畳まれている
                None => return,
            };

        match handshake(socket, &config).await {
            Ok((socket, mut intervals)) => {
                attempt = 0;
                tracing::info!("ダッシュボードサーバへ接続しました: {}", config.server_url);
                connected(
                    socket,
                    &manager,
                    &link,
                    &mut inbox,
                    &mut outbox,
                    &mut intervals,
                )
                .await;
                // 送出済みの印を全部下ろす（設計§3-2）。**`connected()` は `return` が
                // 多いので、書き分けずにここ1箇所で戻す**——1つ漏らすと、その接続で
                // 出したぶんが次の接続で送り直されないまま窓を埋め続ける
                outbox.unmark_sent();
                // 見ている相手が居るかどうかを知っているのはサーバ側なので、切れたら
                // 一旦全部止める。作り続けても行き先が無い（§7-4）
                manager.unsubscribe_all_screens();
                tracing::warn!(
                    "ダッシュボードサーバとの接続が切れました（未送信 {} 件）",
                    outbox.pending_count()
                );
            }
            Err(err) => {
                attempt += 1;
                tracing::warn!("名乗りに失敗しました: {err}");
            }
        }
    }
}

/// 待ち時間を置いてから繋ぐ。待っている間に届いた報告は溜める。
async fn connect_waiting(
    config: &LinkConfig,
    manager: &Arc<SessionManager>,
    inbox: &mut mpsc::UnboundedReceiver<Outgoing>,
    outbox: &mut Outbox,
    attempt: usize,
) -> Option<Socket> {
    let mut attempt = attempt;
    loop {
        if attempt > 0 {
            let wait = Duration::from_millis(BACKOFF_MS[(attempt - 1).min(BACKOFF_MS.len() - 1)]);
            let deadline = tokio::time::Instant::now() + wait;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline) => break,
                    received = inbox.recv() => match received {
                        Some(outgoing) => absorb(outbox, outgoing, manager.as_ref()),
                        None => return None,
                    },
                }
            }
        }

        match dial(config).await {
            Ok(socket) => return Some(socket),
            Err(err) => {
                attempt += 1;
                tracing::warn!("ダッシュボードサーバへ繋げません（{err}）。待って試し直します");
            }
        }
    }
}

/// 溜める側（送らない）。
///
/// **`manager` を受け取るのは、畳んだ印をその場で適用するため**である（設計§4-3）。
/// 繋がるまで溜めておくと、その間パーサは走り続け、畳んだそばからまた溜まる——
/// いちばん抑えたい切断中がちょうど抜ける。
fn absorb(outbox: &mut Outbox, outgoing: Outgoing, watch: &dyn TranscriptWatch) {
    match outgoing {
        // 切断中の状態の知らせは捨てる。復帰したら全部送り直す（§6-4）
        Outgoing::Volatile(_) | Outgoing::ModelTable(_) | Outgoing::Screen(_) => {}
        Outgoing::Transcript(report) => outbox.push(report),
        Outgoing::Reset(card_id) => outbox.push_reset(card_id),
    }
    apply_marks(outbox, watch);
}

/// 畳んだ印の適用先（設計§4-3）。
///
/// 本番の相手は [`SessionManager`] ただ1つで、**切ってあるのはテストのため**である。
/// 適用と一緒に出す3種類のログ（設計§7）を、`SessionManager` を組み立てずに
/// 機械で確かめられるようにしている——組み立てには本物の設定・フックの受信口・
/// 擬似 claude が要り、**ログ1行を見るための土台としては重すぎる**。
trait TranscriptWatch {
    /// そのカードの監視を止める（位置も捨てる）。
    fn stop_watching(&self, card_id: CardId);
    /// 頭から読み直してもらう。**実際に頼めた場所**を返す（頼めなければ `None`）。
    fn rewatch(&self, card_id: CardId) -> Option<String>;
}

impl TranscriptWatch for SessionManager {
    fn stop_watching(&self, card_id: CardId) {
        self.stop_watching_transcript(card_id);
    }

    fn rewatch(&self, card_id: CardId) -> Option<String> {
        self.rewatch_transcript(card_id)
    }
}

/// 畳んだ印をパーサへの操作に変える（設計§4-3）。
///
/// `Outbox` は大きさを知っているが `SessionManager` を知らない（知らせると
/// manager → events → link → outbox → manager で参照が輪になる）。そこで
/// `Outbox` は印を溜めるだけにし、**`manager` を持っている側がここで適用する**。
///
/// # 3箇所から呼ぶ。書き分けない
///
/// 積む経路（`absorb()` ／ `connected()` の `inbox.recv()`）と、ack の経路
/// （`apply_command()`）の3つ。**1つ漏らすと、その経路で畳んだカードだけが
/// 読み直されないまま消える。** 関数1つに寄せてあるのは `unmark_sent()` と同じ理由で、
/// 呼び忘れは起きても、書き分けによる食い違いは起きない形にするため。
///
/// # 切断中に読み直しは始まらない（設計§4-4）
///
/// `needs_rewatch` が積まれるのは **`Reset` の ack が返ったとき**だけで、ack は
/// 繋がっていなければ届かない。したがって切断中にこの関数を呼んでも、動くのは
/// 監視を止める側だけになる。**この性質に寄りかかっている**ので、`needs_rewatch` を
/// 積む場所を増やすなら、切断中でないことをここで見る必要がある。
fn apply_marks(outbox: &mut Outbox, watch: &dyn TranscriptWatch) {
    for card_id in outbox.take_unwatch() {
        watch.stop_watching(card_id);
    }
    for card_id in outbox.take_rewatch() {
        // **頼めたときだけ1行残す**（設計§7）。頼めなかった理由は相手が言う——
        // ここで一律に出すと、頼めていないのに「頼みました」が残る
        if let Some(path) = watch.rewatch(card_id) {
            tracing::info!(%card_id, %path, "畳んだ履歴の読み直しを頼みました");
        }
    }
}

async fn dial(config: &LinkConfig) -> anyhow::Result<Socket> {
    use tungstenite::client::IntoClientRequest as _;

    let mut request = agent_ws_url(&config.server_url).into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", config.pairing_token).parse()?,
    );
    // **版はここで名乗る。** 噛み合わなければサーバは upgrade を断る（§4-1）
    request
        .headers_mut()
        .insert("sec-websocket-protocol", A2S_PROTOCOL.parse()?);

    let (socket, _response) = tokio_tungstenite::connect_async(request).await?;
    Ok(socket)
}

/// `http://host:port` の形も受けて、A2S の口を指す URL にする。
fn agent_ws_url(server_url: &str) -> String {
    let trimmed = server_url.trim_end_matches('/');
    let base = match trimmed.split_once("://") {
        Some(("http", rest)) => format!("ws://{rest}"),
        Some(("https", rest)) => format!("wss://{rest}"),
        // ws:// / wss:// はそのまま。それ以外は書かれたとおりに使う（打ち間違いを
        // こちらで直すと、繋がらない理由が見えなくなる）
        _ => trimmed.to_string(),
    };
    format!("{base}/agent/ws")
}

/// 名乗りを交わす（§4-2）。
async fn handshake(mut socket: Socket, config: &LinkConfig) -> anyhow::Result<(Socket, Intervals)> {
    let hello = AgentMessage::Hello {
        protocol_version: A2S_VERSION,
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        agent_name: config.agent_name.clone(),
        // この PC の CLI が受け付けるモードは、名乗りと一緒に渡す（§21 読み替え1）。
        // サーバにはローカルの CLI が居ないので、ここで渡さないと選択肢が空になる
        available_modes: config.available_modes.clone(),
        always_bypass_permissions: config.always_bypass_permissions,
        // フォルダを覗ける版であることを名乗る（イシューグループ_2026_0805_0514 設計§4）。
        // **この実行ファイルは実装を持っている**ので、常に真。名乗らない古いホストと
        // 区別が付くことが、画面に正しい理由を出せる唯一の材料になる
        supports_host_fs: true,
        // ログを引ける版であることを名乗る（ログ設計§13-1）。`supports_host_fs` と
        // 同じで、**この実行ファイルは実装を持っている**ので常に真
        supports_log_read: true,
        // この実行ファイルは資源を答える実装を持っている（起こし直し設計§18-4）
        supports_resources: true,
        // 抜け殻のカードを起こし直せる版であることを名乗る
        // （接続断のカードを復旧ボタンで戻す 設計§5-2）。上2つと同じで、
        // **この実行ファイルは `apply_command` に腕を持っている**ので常に真
        supports_revive: true,
    };
    socket
        .send(tungstenite::Message::text(serde_json::to_string(&hello)?))
        .await?;

    let reply = tokio::time::timeout(HELLO_TIMEOUT, socket.next())
        .await
        .map_err(|_| anyhow::anyhow!("名乗りの応答がありません"))?
        .ok_or_else(|| anyhow::anyhow!("名乗りの途中で切れました"))??;

    let tungstenite::Message::Text(text) = reply else {
        anyhow::bail!("名乗りの応答が文字ではありません");
    };
    match serde_json::from_str::<ServerToAgent>(&text)? {
        ServerToAgent::Hello {
            protocol_version,
            agent_id,
            intervals,
            ..
        } => {
            if protocol_version != A2S_VERSION {
                anyhow::bail!(
                    "版が噛み合いません（agent={A2S_VERSION} / server={protocol_version}）"
                );
            }
            tracing::info!(%agent_id, "この PC として登録されました");
            Ok((socket, intervals))
        }
        other => anyhow::bail!("名乗りの応答ではありません: {other:?}"),
    }
}

/// 繋がっている間の本体。切れたら戻る。
async fn connected(
    socket: Socket,
    manager: &Arc<SessionManager>,
    link: &Arc<SessionHostLink>,
    inbox: &mut mpsc::UnboundedReceiver<Outgoing>,
    outbox: &mut Outbox,
    intervals: &mut Intervals,
) {
    let (mut sink, mut stream) = socket.split();

    // 名乗りの応答が持ってきた設定を先に効かせる（§6-4）。切れていた間に変わっていても、
    // ここで揃う——**繋がっていなかった PC のぶんは、この経路でしか届かない**
    manager.set_screen_settings((*intervals).into());

    // 復帰手順（§6-4）：全セッションを送り直す → 未 ack を送り直す。
    //
    // **積むだけにする**（設計§2-2）。以前はここで送り切っていたので、その間ずっと
    // 相手の ack も指示も読まなかった——1055件を抱えていると、読む番が永久に回ってこない
    let mut waiting: VecDeque<AgentMessage> = manager
        .list()
        .into_iter()
        .map(|meta| AgentMessage::SessionUpsert {
            session: Box::new(meta),
        })
        .collect();
    if let Some(table) = link
        .model_table
        .lock()
        .expect("ロックが壊れていない")
        .as_ref()
    {
        waiting.push_back(table.message());
    }
    waiting.extend(outbox.pump());

    let mut flush = tokio::time::interval(Duration::from_secs(intervals.sync_secs.max(1)));
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_seen = tokio::time::Instant::now();

    loop {
        tokio::select! {
            // 未送出があるときだけ、**1回に1通**出す（設計§2-2）。
            //
            // `select!` は準備できている枝から無作為に1つ選ぶので、列が空でない間も
            // 受信の枝が選ばれうる。**これが「送りながら読む」の実体**である
            _ = std::future::ready(()), if !waiting.is_empty() => {
                let message = waiting.pop_front().expect("空でないことを見てから取り出している");
                if send(&mut sink, &message).await.is_err() {
                    return;
                }
            },

            received = inbox.recv() => match received {
                Some(Outgoing::Volatile(message)) | Some(Outgoing::ModelTable(message)) => {
                    if send(&mut sink, &message).await.is_err() {
                        return;
                    }
                }
                Some(Outgoing::Transcript(report)) => {
                    outbox.push(report);
                    apply_marks(outbox, manager.as_ref());
                }
                Some(Outgoing::Reset(card_id)) => {
                    outbox.push_reset(card_id);
                    apply_marks(outbox, manager.as_ref());
                }
                // 画面はバイナリのまま運ぶ（設計§4-3）。JSON に包むと base64 で 4/3 に膨らむ
                Some(Outgoing::Screen(bytes)) => {
                    if sink.send(tungstenite::Message::Binary(bytes.into())).await.is_err() {
                        return;
                    }
                }
                // 送り口が全部落ちた＝プロセスが畳まれている
                None => return,
            },

            _ = flush.tick() => {
                waiting.extend(outbox.pump());
            }

            incoming = stream.next() => match incoming {
                Some(Ok(message)) => {
                    last_seen = tokio::time::Instant::now();
                    if !handle_incoming(message, manager, &link.outgoing, outbox, intervals, &mut flush, &mut waiting) {
                        return;
                    }
                }
                _ => return,
            },

            _ = ping.tick() => {
                if last_seen.elapsed() > SILENCE_TIMEOUT {
                    // TCP の静かな死（スリープ・電波断）。**能動的に切って繋ぎ直す**
                    tracing::warn!("{SILENCE_TIMEOUT:?} 何も届かないので繋ぎ直します");
                    return;
                }
                if sink.send(tungstenite::Message::Ping(Default::default())).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// サーバからの1通を処理する。`false` を返したら繋ぎ直す。
fn handle_incoming(
    message: tungstenite::Message,
    manager: &Arc<SessionManager>,
    outgoing: &mpsc::UnboundedSender<Outgoing>,
    outbox: &mut Outbox,
    intervals: &mut Intervals,
    flush: &mut tokio::time::Interval,
    waiting: &mut VecDeque<AgentMessage>,
) -> bool {
    match message {
        tungstenite::Message::Text(text) => {
            match serde_json::from_str::<ServerToAgent>(&text) {
                Ok(command) => apply_command(
                    command, manager, outgoing, outbox, intervals, flush, waiting,
                ),
                // 知らない指示で接続ごと落とさない。新しいサーバが増やしたものでありうる
                Err(err) => tracing::warn!("サーバの指示を解釈できません: {err}"),
            }
            true
        }
        // ブラウザからの生入力（0x02）。**PTY へ届くまでの作法は変えない**（§5-5）
        tungstenite::Message::Binary(bytes) => {
            write_pty_input(manager, &bytes);
            true
        }
        tungstenite::Message::Close(_) => false,
        // Ping への応答は tungstenite が返す。Pong は生存の証拠として時刻の更新だけに使う
        _ => true,
    }
}

/// どちらを聞かれたか。
///
/// **解決する前の値を持つ。** 起点の読み替え（`hostfs::resolve_start`）も
/// ファイルシステムに触るので、逃がした先で行う（下記）。
#[derive(Debug, Clone)]
enum Ask {
    /// 一覧。`None` はその PC のホーム（設計§26-2）
    Dir(Option<String>),
    File(String),
    /// この PC のログ（ログ設計§13-1）。**置き場所を知るのに設定が要る**
    Log(
        Box<protocol::logs::LogQuery>,
        Arc<crate::config::SessionHostConfig>,
    ),
    /// この PC の資源（起こし直し設計§18-4）。**読む口と数字2つだけを持ち出す**
    /// ——器ごと入れると `Debug` を器の全体へ強いることになる。数える規則は
    /// `resources::snapshot` の1箇所のまま
    Resources(Arc<dyn crate::resources::Probe>, u64, u64),
}

/// 答えの要る問いに、**別のスレッドで**答える（設計§4・§8・§9、ログ設計§13-1）。
///
/// # 必ず答える
///
/// 読めなかった場合も `HostReply::Failed` を返す。黙ると、聞いた側は時間切れを待つ
/// しかなくなり、**フォルダが無いことと区別が付かない**（設計§7）。
///
/// # 送り口が閉じているときは捨ててよい
///
/// 切断中の答えは行き先が無い。聞いた側は時間切れで畳むので、溜めても意味が無い
/// （`Outgoing::Volatile` の扱いと同じ）。
///
/// # 起点の解決もここで行う
///
/// 呼ぶ側（`apply_command`）は接続の `select!` ループの上に居る。読み取りだけを
/// 逃がして解決をあちらへ残すと、**候補ごとの `is_dir()` でループが止まる**。
fn answer_ask(outgoing: mpsc::UnboundedSender<Outgoing>, request_id: RequestId, ask: Ask) {
    tokio::task::spawn_blocking(move || {
        let failed = |err: crate::hostfs::HostFsError| HostReply::Failed {
            reason: err.reason,
            detail: err.detail,
        };
        let reply = match ask {
            Ask::Dir(start) => match crate::hostfs::list_dir_from(start.as_deref()) {
                Ok(listing) => HostReply::Dir(listing),
                Err(err) => failed(err),
            },
            Ask::File(path) => match crate::hostfs::read_file(Path::new(&path)) {
                Ok(content) => HostReply::File(content),
                Err(err) => failed(err),
            },
            Ask::Log(query, config) => match crate::logs::collect(&config, &query) {
                Ok(chunk) => HostReply::Log(chunk),
                Err(err) => HostReply::Failed {
                    reason: err.reason,
                    detail: err.detail,
                },
            },
            // **読めないことは異常ではない**（Linux 以外）。そう言えば、聞いた側は
            // 歯止め無しで進む——分からないことを理由に止めない（設計§18-4）
            Ask::Resources(probe, estimate_mb, headroom_mb) => {
                match crate::resources::snapshot(probe.as_ref(), estimate_mb, headroom_mb) {
                    Some(resources) => HostReply::Resources(resources),
                    None => HostReply::Failed {
                        reason: protocol::a2s::HostFailure::Unsupported,
                        detail: "この PC ではメモリの空きを読めません".to_string(),
                    },
                }
            }
        };
        let _ = outgoing.send(Outgoing::Volatile(AgentMessage::HostReply {
            request_id,
            reply,
        }));
    });
}

fn apply_command(
    command: ServerToAgent,
    manager: &Arc<SessionManager>,
    outgoing: &mpsc::UnboundedSender<Outgoing>,
    outbox: &mut Outbox,
    intervals: &mut Intervals,
    flush: &mut tokio::time::Interval,
    waiting: &mut VecDeque<AgentMessage>,
) {
    match command {
        // 2度目の名乗りは実装の食い違い。無視して続ける
        ServerToAgent::Hello { .. } => {}

        ServerToAgent::BatchAck { batch_id } => {
            outbox.ack(batch_id);
            // 畳んだカードの `Reset` が入った合図でもある。**読み直しを頼むのはここだけ**
            // （設計§4-2 の5）——ack は繋がっていなければ届かないので、切断中に
            // 読み直しが始まることが原理的に無い（設計§4-4）
            apply_marks(outbox, manager.as_ref());
            // **その場でまた出す**（設計§3-3）。ack を待って次を出す形にすると、
            // 窓は自然に回り続ける——次の `flush.tick()` まで待つ理由が無い
            waiting.extend(outbox.pump());
        }

        ServerToAgent::SetIntervals {
            intervals: updated, ..
        } => {
            *intervals = updated;
            *flush = tokio::time::interval(Duration::from_secs(updated.sync_secs.max(1)));
            flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // 画面のほうは動いているセッションへその場で配る（§13-3）
            manager.set_screen_settings(updated.into());
            tracing::info!(
                "同期間隔が変わりました（履歴 {} 秒 / 画面 {} ミリ秒 / 遡り {} 行）",
                updated.sync_secs,
                updated.screen_ms,
                updated.scrollback_lines
            );
        }

        ServerToAgent::Spawn {
            cwd,
            permission_mode,
        } => {
            // 採番はこちら（§5-2）。結果は SessionUpsert で返る
            if let Err(err) = manager.spawn_with_mode(&cwd, permission_mode) {
                manager.broadcast(ServerMessage::Error {
                    card_id: None,
                    message: err.to_string(),
                });
            }
        }
        // 抜け殻のカードを起こし直す（接続断のカードを復旧ボタンで戻す 設計§7・§8）。
        //
        // **印を立てるのは切り離す前**（設計§8-3）。後にすると、切り離した2つが
        // 同時に印を見て両方通る。この関数が同期の `fn` であること自体が、
        // 「席を待つのはここではない」ことの担保にもなっている
        ServerToAgent::ReviveSession {
            card_id,
            cwd,
            permission_mode,
            claude_session_id,
        } => {
            let Some(in_flight) = manager.begin_revive(card_id) else {
                // 待ち行列に並ばせない。同じカードが2つ並ぶと、席が空いたとき
                // 両方とも通る（設計§8-1）
                report_error(manager, card_id, ALREADY_REVIVING.to_string());
                return;
            };
            let manager = Arc::clone(manager);
            tokio::spawn(async move {
                if let Err(err) = manager
                    .revive(in_flight, &cwd, permission_mode, claude_session_id)
                    .await
                {
                    // **カードを名指しする**（設計§7-5）。`Spawn` が名指ししないのは
                    // 採番前に失敗しうるからで、復旧はIDが最初から確定している
                    report_error(&manager, card_id, err.to_string());
                }
            });
        }
        ServerToAgent::Kill { card_id } => {
            if let Err(err) = manager.kill(card_id) {
                report_error(manager, card_id, err.to_string());
            }
        }
        ServerToAgent::Archive { card_id } => {
            if let Err(err) = manager.archive(card_id) {
                report_error(manager, card_id, err.to_string());
            }
        }
        ServerToAgent::Resize {
            card_id,
            cols,
            rows,
        } => {
            if let Some(session) = manager.get(card_id) {
                let _ = session.resize(cols, rows);
            }
        }

        // 時間のかかるものは別のタスクへ逃がす。**ここで待つと、その間ほかの指示も
        // 履歴の送り出しも全部止まる**（ブラウザ側の client_loop と同じ判断）
        ServerToAgent::SendInput { card_id, text } => {
            let manager = Arc::clone(manager);
            tokio::spawn(async move {
                let Some(session) = manager.get(card_id) else {
                    report_error(&manager, card_id, NOT_FOUND.to_string());
                    return;
                };
                if let Err(err) = session.send_instruction(&text).await {
                    report_error(
                        &manager,
                        card_id,
                        format!("指示を送れませんでした: {err:#}"),
                    );
                }
            });
        }
        ServerToAgent::SetPermissionMode { card_id, mode } => {
            let manager = Arc::clone(manager);
            tokio::spawn(async move {
                let Some(session) = manager.get(card_id) else {
                    report_error(&manager, card_id, NOT_FOUND.to_string());
                    return;
                };
                let outcome = session.switch_permission_mode(&mode).await;
                // 着いても着かなくても、いまどこに居るのかは配る
                manager.broadcast_session(&session);
                if let Err(err) = outcome {
                    report_error(&manager, card_id, err.to_string());
                }
            });
        }
        ServerToAgent::SetModel { card_id, model } => {
            let manager = Arc::clone(manager);
            tokio::spawn(async move {
                let Some(session) = manager.get(card_id) else {
                    report_error(&manager, card_id, NOT_FOUND.to_string());
                    return;
                };
                if let Err(err) = manager.switch_model(&session, &model).await {
                    // 途中まで動いた結果も配る（楽観更新が立っていれば、それも伝わる）
                    manager.broadcast_session(&session);
                    report_error(&manager, card_id, err.to_string());
                }
            });
        }

        // 画面の配信（§7-4）。視聴者が現れた・居なくなった、の2つしか来ない
        ServerToAgent::SubScreen {
            card_id,
            cols,
            rows,
        } => manager.subscribe_screen(card_id, cols, rows),
        ServerToAgent::UnsubScreen { card_id } => manager.unsubscribe_screen(card_id),

        // フォルダとファイルの問い（イシューグループ_2026_0805_0514 設計§4）。
        //
        // **ここで直接読まない。** この関数は接続の `select!` ループの中から同期で
        // 呼ばれているので、大きなフォルダを読むと ping まで止まり、サーバから見ると
        // 「静かな死」に見えて切られる
        ServerToAgent::ListDir { request_id, path } => {
            // 省略ならホーム、貼られた形なら読み替える（設計§26-2・§13）。
            // どちらも解決できるのはこちら側だけ——**解決そのものは逃がした先で行う**
            answer_ask(outgoing.clone(), request_id, Ask::Dir(path));
        }
        ServerToAgent::ReadFile { request_id, path } => {
            answer_ask(outgoing.clone(), request_id, Ask::File(path));
        }

        // ログの問い（ログ設計§13-1）。**フォルダと同じ1本の問答の道に乗る。**
        //
        // 置き場所を知るのに設定が要るので、`SessionManager` から借りる——
        // ここで別の経路から配ると、片方だけ差し替えたときに食い違う
        ServerToAgent::ReadLog { request_id, query } => {
            answer_ask(
                outgoing.clone(),
                request_id,
                Ask::Log(Box::new(query), manager.config().clone()),
            );
        }

        // 資源の問い（起こし直し設計§18-4）。**同じ1本の問答の道に乗る。**
        ServerToAgent::HostResources { request_id } => {
            answer_ask(
                outgoing.clone(),
                request_id,
                Ask::Resources(
                    manager.memory_probe(),
                    manager.config().revive_estimate_mb,
                    manager.config().revive_headroom_mb,
                ),
            );
        }
    }
}

/// 見つからないカードを指されたときの説明。
const NOT_FOUND: &str = "セッションが見つかりません";

/// 操作の失敗を上へ返す（§5-6）。サーバが `ServerMessage::Error` として配る。
fn report_error(manager: &Arc<SessionManager>, card_id: CardId, message: String) {
    manager.broadcast(ServerMessage::Error {
        card_id: Some(card_id),
        message,
    });
}

fn write_pty_input(manager: &Arc<SessionManager>, bytes: &[u8]) {
    let frame = match frame::decode(bytes) {
        Ok(frame) => frame,
        Err(err) => {
            tracing::warn!("壊れたフレームを受け取りました: {err}");
            return;
        }
    };
    if frame.kind != FrameKind::PtyInput {
        tracing::warn!(
            card_id = %frame.card_id,
            "サーバから送られてよい種別ではありません: {:?}",
            frame.kind
        );
        return;
    }
    // 居ないカードへの入力は黙って捨てる（閉じた直後に届いたぶんで画面を汚さない）
    let Some(session) = manager.get(frame.card_id) else {
        return;
    };
    if let Err(err) = session.write_input(frame.payload) {
        tracing::warn!(
            card_id = %frame.card_id,
            "端末へ書き込めませんでした: {err:#}"
        );
    }
}

async fn send(
    sink: &mut futures_util::stream::SplitSink<Socket, tungstenite::Message>,
    message: &AgentMessage,
) -> anyhow::Result<()> {
    let text = serde_json::to_string(message)?;
    sink.send(tungstenite::Message::text(text)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use protocol::{Node, NodeId};

    fn node(id: &str) -> TreeNode {
        TreeNode {
            id: NodeId(id.to_string()),
            parent: None,
            node: Node::AssistantText {
                text: id.to_string(),
            },
            ts: 0,
            branch: 0,
        }
    }

    fn report(card_id: CardId, id: &str, next_offset: u64) -> TranscriptReport {
        TranscriptReport {
            card_id,
            transcript_path: "/p/s.jsonl".to_string(),
            source: "/p/s.jsonl".to_string(),
            next_offset,
            nodes: vec![node(id)],
        }
    }

    /// ノードを `count` 個持つ報告。
    fn report_nodes(
        card_id: CardId,
        prefix: &str,
        count: usize,
        next_offset: u64,
    ) -> TranscriptReport {
        TranscriptReport {
            card_id,
            transcript_path: "/p/s.jsonl".to_string(),
            source: "/p/s.jsonl".to_string(),
            next_offset,
            nodes: (0..count).map(|i| node(&format!("{prefix}{i}"))).collect(),
        }
    }

    fn outbox(label: &str) -> (Outbox, Arc<OffsetStore>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-outbox-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");
        let offsets = OffsetStore::open(dir.clone());
        (Outbox::new(Arc::clone(&offsets)), offsets, dir)
    }

    /// **窓と上限を小さくして作る。** 既定のままだと、テストが実運用の量（3万ノード規模）を
    /// 作ることになり、確かめたい性質より先に時間が尽きる（テスト計画フェーズ2）。
    fn outbox_with(label: &str, limits: Limits) -> (Outbox, Arc<OffsetStore>, std::path::PathBuf) {
        let (mut outbox, offsets, dir) = outbox(label);
        outbox.limits = limits;
        (outbox, offsets, dir)
    }

    fn batch_id_of(message: &AgentMessage) -> BatchId {
        match message {
            AgentMessage::TranscriptBatch { batch_id, .. }
            | AgentMessage::TranscriptReset { batch_id, .. } => *batch_id,
            other => panic!("履歴の通ではない: {other:?}"),
        }
    }

    fn card_of(message: &AgentMessage) -> CardId {
        match message {
            AgentMessage::TranscriptBatch { card_id, .. }
            | AgentMessage::TranscriptReset { card_id, .. } => *card_id,
            other => panic!("履歴の通ではない: {other:?}"),
        }
    }

    fn nodes_of(message: &AgentMessage) -> usize {
        match message {
            AgentMessage::TranscriptBatch { nodes, .. } => nodes.len(),
            other => panic!("バッチではない: {other:?}"),
        }
    }

    fn node_ids(message: &AgentMessage) -> Vec<String> {
        match message {
            AgentMessage::TranscriptBatch { nodes, .. } => {
                nodes.iter().map(|node| node.id.0.clone()).collect()
            }
            other => panic!("バッチではない: {other:?}"),
        }
    }

    fn resets_in(messages: &[AgentMessage]) -> usize {
        messages
            .iter()
            .filter(|message| matches!(message, AgentMessage::TranscriptReset { .. }))
            .count()
    }

    #[test]
    fn 同じカードの続きは1つのバッチにまとまる() {
        // 同期間隔（既定20秒）のあいだに読んだぶんを1通にする。1イベント1通だと、
        // 回線の細い環境で往復ばかりが増える
        let (mut outbox, _offsets, dir) = outbox("merge");
        let card_id = CardId::new();
        outbox.push(report(card_id, "n1", 10));
        outbox.push(report(card_id, "n2", 20));

        let messages = outbox.pump();
        assert_eq!(messages.len(), 1, "実際: {messages:?}");
        assert_eq!(nodes_of(&messages[0]), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 巻き戻しは履歴を追い越さない() {
        // 追い越すと、消えたはずの枝がブラウザに残る（設計§6-2）
        let (mut outbox, _offsets, dir) = outbox("order");
        let card_id = CardId::new();
        outbox.push(report(card_id, "n1", 10));
        outbox.push_reset(card_id);
        outbox.push(report(card_id, "n2", 20));

        let messages = outbox.pump();
        assert_eq!(messages.len(), 3, "実際: {messages:?}");
        // **どのノードが前後どちらに居るか**まで見る。種別だけを見ていると、
        // 並べ替えが起きても「バッチ・巻き戻し・バッチ」の形は保たれるので通ってしまう
        // （壊し方6「pump() で並べ替える」を当てたときに、実際に素通しした）
        assert_eq!(node_ids(&messages[0]), vec!["n1"], "実際: {messages:?}");
        assert!(
            matches!(messages[1], AgentMessage::TranscriptReset { .. }),
            "実際: {:?}",
            messages[1]
        );
        assert_eq!(
            node_ids(&messages[2]),
            vec!["n2"],
            "巻き戻しの後のぶんが前へ回っている: {messages:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ackが返るまで位置は進まず_未ackは送り直される() {
        let (mut outbox, offsets, dir) = outbox("ack");
        let card_id = CardId::new();
        outbox.push(report(card_id, "n1", 10));
        let messages = outbox.pump();
        let batch_id = batch_id_of(&messages[0]);

        assert!(
            offsets.resume(card_id, "/p/s.jsonl").is_empty(),
            "送っただけで位置が進んでいる"
        );
        // 切れた形にすると、未 ack は送り直しの対象へ戻る（設計§3-2）
        outbox.unmark_sent();
        assert_eq!(outbox.pump().len(), 1, "未 ack が送り直しの対象に無い");

        outbox.ack(batch_id);

        assert_eq!(offsets.resume(card_id, "/p/s.jsonl")["/p/s.jsonl"], 10);
        outbox.unmark_sent();
        assert!(outbox.pump().is_empty(), "ack 済みが残っている");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 巻き戻しのackで位置を忘れる() {
        let (mut outbox, offsets, dir) = outbox("reset-ack");
        let card_id = CardId::new();
        outbox.push(report(card_id, "n1", 10));
        let first = outbox.pump();
        outbox.ack(batch_id_of(&first[0]));
        assert!(!offsets.resume(card_id, "/p/s.jsonl").is_empty());

        // パーサが申告した巻き戻し。**監視は止めていない**ので、読み直しは頼まない
        outbox.push_reset(card_id);
        let second = outbox.pump();
        assert!(
            matches!(second[0], AgentMessage::TranscriptReset { .. }),
            "巻き戻しではない: {:?}",
            second[0]
        );
        outbox.ack(batch_id_of(&second[0]));

        assert!(
            offsets.resume(card_id, "/p/s.jsonl").is_empty(),
            "巻き戻したのに位置が残っている（先のやりとりが二度と読まれない）"
        );
        assert!(
            outbox.take_rewatch().is_empty(),
            "止めていない監視を頼み直そうとしている"
        );

        // **忘れるだけでは終わらない。** 畳んで積んだ巻き戻しは監視を止めてあるので、
        // ack のここで頼み直さないと、そのカードの履歴が二度と出てこない（設計§4-2 の5）
        outbox.limits.card_nodes = 2;
        outbox.push(report_nodes(card_id, "m", 3, 20));
        let folded = outbox.pump();
        outbox.ack(batch_id_of(&folded[0]));
        assert_eq!(
            outbox.take_rewatch(),
            vec![card_id],
            "畳んだのに読み直しが頼まれない"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 二重のackは何も壊さない() {
        // 再送が両方届くことがある。2回目は既に位置が進んでいるので何もしない
        let (mut outbox, _offsets, dir) = outbox("double");
        let card_id = CardId::new();
        outbox.push(report(card_id, "n1", 10));
        let messages = outbox.pump();
        let batch_id = batch_id_of(&messages[0]);
        outbox.ack(batch_id);
        outbox.ack(batch_id);

        // 畳んだ巻き戻しの ack が2度届いても、**読み直しは1回しか頼まない**。
        // 2回立つと、そのカードを2度読み直して同じものを二重に送ることになる
        outbox.limits.card_nodes = 1;
        outbox.push(report_nodes(card_id, "m", 2, 20));
        let folded = outbox.pump();
        let reset_id = batch_id_of(&folded[0]);
        outbox.ack(reset_id);
        outbox.ack(reset_id);
        assert_eq!(
            outbox.take_rewatch().len(),
            1,
            "二重の ack で読み直しが2回立っている"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    // ------------------------------------------------------------------
    // 窓（設計§3）
    // ------------------------------------------------------------------

    #[test]
    fn 窓を超えて出さない() {
        // 出しっぱなしにすると、受ける側が返す ack が同時にその数だけ生まれる。
        // 溜まりが1000件を超えた実機では、それが約束のレーンを溢れさせた（設計§3-1）
        let (mut outbox, _offsets, dir) = outbox_with(
            "window",
            Limits {
                window: 2,
                ..Limits::default()
            },
        );
        let cards: Vec<CardId> = (0..5).map(|_| CardId::new()).collect();
        for (index, card) in cards.iter().enumerate() {
            outbox.push(report(*card, &format!("n{index}"), 10 + index as u64));
        }

        assert_eq!(outbox.pump().len(), 2, "窓を超えて出している");
        assert!(
            outbox.pump().is_empty(),
            "窓が埋まっているのに、更に出している"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ackが返ったぶんだけ次が出る() {
        // 窓が空かないと、溜まりは永久に減らない（実機で239回の再接続を通じて1件も
        // 減らなかったのがこの形）
        let (mut outbox, _offsets, dir) = outbox_with(
            "window-refill",
            Limits {
                window: 2,
                ..Limits::default()
            },
        );
        let cards: Vec<CardId> = (0..5).map(|_| CardId::new()).collect();
        for (index, card) in cards.iter().enumerate() {
            outbox.push(report(*card, &format!("n{index}"), 10 + index as u64));
        }

        let first = outbox.pump();
        outbox.ack(batch_id_of(&first[0]));
        assert_eq!(outbox.pump().len(), 1, "ack で空いたぶんが出ていない");
        outbox.ack(batch_id_of(&first[1]));
        assert_eq!(
            outbox.pump().len(),
            1,
            "2つ目の ack で空いたぶんが出ていない"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 切れたら送出済みは出していないへ戻る() {
        // 戻さないと、その接続で出したぶんが**次の接続でも窓を埋めたまま**になり、
        // 誰も ack を返せないので二度と出せなくなる（設計§3-2）
        let (mut outbox, _offsets, dir) = outbox_with(
            "unsend",
            Limits {
                window: 2,
                ..Limits::default()
            },
        );
        let cards: Vec<CardId> = (0..3).map(|_| CardId::new()).collect();
        for (index, card) in cards.iter().enumerate() {
            outbox.push(report(*card, &format!("n{index}"), 10 + index as u64));
        }
        let first = outbox.pump();
        assert!(outbox.pump().is_empty());

        outbox.unmark_sent();
        let again = outbox.pump();

        assert_eq!(again.len(), 2, "送り直しの対象に戻っていない");
        assert_eq!(
            batch_id_of(&again[0]),
            batch_id_of(&first[0]),
            "送り直しで別のものが出ている"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 窓は先頭から絞るだけで並べ替えない() {
        // 並べ替えると、巻き戻しがバッチを追い越して消えたはずの枝が残る
        // （セルフホスト化設計§6-2）。窓が絞るのは**先頭から何件出すか**だけ
        let (mut outbox, _offsets, dir) = outbox_with(
            "order-window",
            Limits {
                window: 1,
                ..Limits::default()
            },
        );
        let cards: Vec<CardId> = (0..4).map(|_| CardId::new()).collect();
        for (index, card) in cards.iter().enumerate() {
            outbox.push(report(*card, &format!("n{index}"), 10 + index as u64));
        }

        let mut order = Vec::new();
        for _ in 0..cards.len() {
            let out = outbox.pump();
            assert_eq!(out.len(), 1, "窓1 なのに複数出ている: {out:?}");
            order.push(card_of(&out[0]));
            outbox.ack(batch_id_of(&out[0]));
        }

        assert_eq!(order, cards, "到着順が崩れている");
        let _ = std::fs::remove_dir_all(dir);
    }

    // ------------------------------------------------------------------
    // 1通の上限（設計§4-6）——この不具合の本命
    // ------------------------------------------------------------------

    #[test]
    fn 一通のノード数は上限で割れる() {
        // 1通が 16MiB を超えると、受け取る側が**無言で接続をリセットする**
        // （実測：21MB でリセット・15MB は通る）。実機で線を殺していたのはこれ
        let (mut outbox, _offsets, dir) = outbox_with(
            "split",
            Limits {
                batch_nodes: 2,
                ..Limits::default()
            },
        );
        let card_id = CardId::new();
        outbox.push(report_nodes(card_id, "a", 3, 10));
        // 続きは、空きのある最後のバッチへ載る。**上限に達したら併合しない**
        outbox.push(report_nodes(card_id, "b", 2, 20));

        let messages = outbox.pump();
        assert_eq!(messages.len(), 3, "1通のまま出している: {messages:?}");
        assert_eq!(nodes_of(&messages[0]), 2);
        assert_eq!(nodes_of(&messages[1]), 2);
        assert_eq!(nodes_of(&messages[2]), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 割れた断片は最後だけが位置を進める() {
        // 手前の断片に位置を付けると、そちらだけ ack が返った時点で
        // **まだ入っていないノードの先まで位置が進む**——読み直しても戻れない
        let (mut outbox, offsets, dir) = outbox_with(
            "split-commit",
            Limits {
                batch_nodes: 2,
                ..Limits::default()
            },
        );
        let card_id = CardId::new();
        outbox.push(report_nodes(card_id, "a", 5, 40));
        let messages = outbox.pump();
        assert_eq!(messages.len(), 3);

        outbox.ack(batch_id_of(&messages[0]));
        outbox.ack(batch_id_of(&messages[1]));
        assert!(
            offsets.resume(card_id, "/p/s.jsonl").is_empty(),
            "まだ入っていないノードの先まで位置が進んでいる"
        );

        outbox.ack(batch_id_of(&messages[2]));
        assert_eq!(offsets.resume(card_id, "/p/s.jsonl")["/p/s.jsonl"], 40);
        let _ = std::fs::remove_dir_all(dir);
    }

    // ------------------------------------------------------------------
    // 溜まりの上限と、畳み方（設計§4）
    // ------------------------------------------------------------------

    #[test]
    fn カードごとの上限を超えたら畳む() {
        let (mut outbox, _offsets, dir) = outbox_with(
            "fold-card",
            Limits {
                card_nodes: 4,
                ..Limits::default()
            },
        );
        let card_id = CardId::new();
        outbox.push(report_nodes(card_id, "a", 5, 10));

        assert_eq!(outbox.card_nodes(card_id), 0, "畳まれていない");
        let messages = outbox.pump();
        assert_eq!(messages.len(), 1, "実際: {messages:?}");
        assert_eq!(resets_in(&messages), 1, "巻き戻しが積まれていない");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 全カードの合計でも畳む() {
        // 1枚ずつは上限内でも、枚数が多いと全体が育つ（設計§4-1 の backstop）
        let (mut outbox, _offsets, dir) = outbox_with(
            "fold-total",
            Limits {
                card_nodes: 1_000,
                total_nodes: 5,
                ..Limits::default()
            },
        );
        for index in 0..3 {
            outbox.push(report_nodes(CardId::new(), &format!("c{index}"), 3, 10));
        }

        assert!(
            outbox.total_nodes() <= 5,
            "全体の上限を超えたまま: {}",
            outbox.total_nodes()
        );
        assert!(
            !outbox.needs_unwatch.is_empty(),
            "全体の上限では畳まれていない"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 畳んだカードは束ねている途中も送出済みも捨てる() {
        // 片方だけ捨てると、そのカードは上限を超えたまま残る
        let (mut outbox, _offsets, dir) = outbox_with(
            "fold-both",
            Limits {
                card_nodes: 4,
                ..Limits::default()
            },
        );
        let card_id = CardId::new();
        outbox.push(report_nodes(card_id, "a", 3, 10));
        assert_eq!(outbox.pump().len(), 1, "送出済みを作れていない");
        outbox.push(report_nodes(card_id, "b", 3, 20));

        assert_eq!(outbox.card_nodes(card_id), 0, "捨て残しがある");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 巻き戻しは一通だけで_ackが返るまで二度畳まない() {
        // 畳んだ結果が入る前にもう一度畳むと、**畳んでは読み直す輪**になる（設計§4-2）
        let (mut outbox, _offsets, dir) = outbox_with(
            "fold-once",
            Limits {
                card_nodes: 2,
                ..Limits::default()
            },
        );
        let card_id = CardId::new();
        outbox.push(report_nodes(card_id, "a", 3, 10));
        outbox.push(report_nodes(card_id, "b", 3, 20));

        let messages = outbox.pump();
        assert_eq!(
            resets_in(&messages),
            1,
            "巻き戻しが1通ではない: {messages:?}"
        );
        assert!(
            messages
                .iter()
                .any(|message| matches!(message, AgentMessage::TranscriptBatch { .. })),
            "二度畳んで、ack を待っている間のぶんまで捨てている: {messages:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 監視を止める印と読み直しの印は別の時機に立つ() {
        // 止めるのは畳んだ時点、読み直しは **Reset の ack が返った時点**（設計§4-2）。
        // 取り違えると、切断中に読み直しが始まって輪になる（設計§4-4）
        let (mut outbox, _offsets, dir) = outbox_with(
            "fold-marks",
            Limits {
                card_nodes: 2,
                ..Limits::default()
            },
        );
        let card_id = CardId::new();
        outbox.push(report_nodes(card_id, "a", 3, 10));

        assert_eq!(
            outbox.needs_unwatch,
            vec![card_id],
            "畳んだ時点で監視を止める印が立っていない"
        );
        assert!(
            outbox.needs_rewatch.is_empty(),
            "ack より先に読み直しが立っている"
        );

        let messages = outbox.pump();
        outbox.ack(batch_id_of(&messages[0]));
        assert_eq!(
            outbox.needs_rewatch,
            vec![card_id],
            "巻き戻しの ack で読み直しが立っていない"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 畳んでいないカードは巻き込まれない() {
        let (mut outbox, _offsets, dir) = outbox_with(
            "fold-scope",
            Limits {
                card_nodes: 2,
                ..Limits::default()
            },
        );
        let small = CardId::new();
        let big = CardId::new();
        outbox.push(report_nodes(small, "s", 1, 10));
        outbox.push(report_nodes(big, "b", 3, 20));

        assert_eq!(
            outbox.card_nodes(small),
            1,
            "畳んでいないカードを捨てている"
        );
        assert_eq!(outbox.card_nodes(big), 0);
        assert_eq!(outbox.needs_unwatch, vec![big], "止める相手を間違えている");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 印は取り出したら消える() {
        // 2回取ると2回適用される。監視を2回止め、読み直しを2回頼むことになる
        let (mut outbox, _offsets, dir) = outbox_with(
            "marks-taken",
            Limits {
                card_nodes: 2,
                ..Limits::default()
            },
        );
        let card_id = CardId::new();
        outbox.push(report_nodes(card_id, "a", 3, 10));

        assert_eq!(outbox.take_unwatch(), vec![card_id]);
        assert!(outbox.take_unwatch().is_empty(), "止める印が消えていない");

        let messages = outbox.pump();
        outbox.ack(batch_id_of(&messages[0]));
        assert_eq!(outbox.take_rewatch(), vec![card_id]);
        assert!(
            outbox.take_rewatch().is_empty(),
            "読み直しの印が消えていない"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 読み直しても超えるカードは畳むのをやめる() {
        // 畳んでも同じ大きさに戻るだけのカードは、畳み続けると輪になる（設計§4-2）
        let (mut outbox, _offsets, dir) = outbox_with(
            "fold-giveup",
            Limits {
                card_nodes: 2,
                ..Limits::default()
            },
        );
        let card_id = CardId::new();

        // 1度目：畳む → 巻き戻しの ack まで進めて、読み直しが済んだ形にする。
        // **立った印はここで回収しておく**（残っていると、2度目に立ったのか
        // 1度目のぶんが残っているのかを見分けられない）
        outbox.push(report_nodes(card_id, "a", 3, 10));
        let first = outbox.pump();
        outbox.ack(batch_id_of(&first[0]));
        assert_eq!(outbox.take_unwatch(), vec![card_id]);
        assert_eq!(outbox.take_rewatch(), vec![card_id]);

        // 2度目：読み直した結果がまた超えた。**ここで畳むのをやめる**
        outbox.push(report_nodes(card_id, "b", 3, 20));

        assert_eq!(
            outbox.card_nodes(card_id),
            3,
            "やめずに畳んでいる（読み直しては畳む輪になる）"
        );
        assert!(
            outbox.take_unwatch().is_empty(),
            "やめたのに監視を止めようとしている"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 接続先はhttpの書き方でも受ける() {
        assert_eq!(
            agent_ws_url("http://dash.example:8787"),
            "ws://dash.example:8787/agent/ws"
        );
        assert_eq!(
            agent_ws_url("https://dash.example/"),
            "wss://dash.example/agent/ws"
        );
        assert_eq!(
            agent_ws_url("ws://127.0.0.1:8787"),
            "ws://127.0.0.1:8787/agent/ws"
        );
    }

    /// 畳んだ印の適用先の代役。**本物は `SessionManager` だけ**（[`TranscriptWatch`]）。
    #[derive(Default)]
    struct FakeWatch {
        stopped: std::sync::Mutex<Vec<CardId>>,
        rewatched: std::sync::Mutex<Vec<CardId>>,
        /// 読み直しを頼める場所。`None` にすると「頼めなかった」を作れる
        path: Option<String>,
    }

    impl FakeWatch {
        fn with_path() -> Self {
            Self {
                path: Some("/p/s.jsonl".to_string()),
                ..Self::default()
            }
        }

        fn stopped(&self) -> Vec<CardId> {
            self.stopped.lock().expect("ロックが壊れていない").clone()
        }

        fn rewatched(&self) -> Vec<CardId> {
            self.rewatched.lock().expect("ロックが壊れていない").clone()
        }
    }

    impl TranscriptWatch for FakeWatch {
        fn stop_watching(&self, card_id: CardId) {
            self.stopped
                .lock()
                .expect("ロックが壊れていない")
                .push(card_id);
        }

        fn rewatch(&self, card_id: CardId) -> Option<String> {
            self.rewatched
                .lock()
                .expect("ロックが壊れていない")
                .push(card_id);
            self.path.clone()
        }
    }

    /// ログの行を集める。**遷移だけが出ていること**を数で見るために使う（設計§7）。
    #[derive(Clone, Default)]
    struct LogSink(Arc<std::sync::Mutex<Vec<u8>>>);

    impl LogSink {
        fn lines(&self) -> Vec<String> {
            String::from_utf8(self.0.lock().expect("ロックが壊れていない").clone())
                .expect("UTF-8 であること")
                .lines()
                .map(str::to_string)
                .collect()
        }
    }

    impl std::io::Write for LogSink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("ロックが壊れていない")
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogSink {
        type Writer = Self;

        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// 集めながら走らせる。
    fn 集める(body: impl FnOnce()) -> Vec<String> {
        let sink = LogSink::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(sink.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .finish();
        tracing::subscriber::with_default(subscriber, body);
        sink.lines()
    }

    #[test]
    fn 出るのは畳みの遷移3種類だけでバッチ1件ごとには出ない() {
        // 設計§7。**1件ごとに回る場所に行を置かない**——置くと、いちばん読みたい行が
        // そこで埋まる。出てよいのは「畳んだ」「読み直しを頼んだ」「畳むのをやめた」の3つ
        let (mut outbox, _offsets, dir) = outbox_with(
            "fold-logs",
            Limits {
                card_nodes: 2,
                ..Limits::default()
            },
        );
        let watch = FakeWatch::with_path();
        let 大きいカード = CardId::new();
        let 普通のカード = CardId::new();

        let lines = 集める(|| {
            // 1本目：上限を超えて畳む
            outbox.push(report_nodes(大きいカード, "a", 3, 10));
            apply_marks(&mut outbox, &watch);

            // 2本目：巻き戻しの ack が返って読み直しを頼む
            let first = outbox.pump();
            outbox.ack(batch_id_of(&first[0]));
            apply_marks(&mut outbox, &watch);

            // 3本目：読み直した結果がまた超えたので、畳むのをやめる
            outbox.push(report_nodes(大きいカード, "b", 3, 20));
            apply_marks(&mut outbox, &watch);

            // **ここから下は1行も出てはいけない。** 上限に触れないカードを何度も
            // 積んで出して ack する、いちばん普通の流れ
            for i in 0..5 {
                outbox.push(report_nodes(
                    普通のカード,
                    &format!("n{i}"),
                    1,
                    100 + i as u64,
                ));
                let messages = outbox.pump();
                for message in &messages {
                    outbox.ack(batch_id_of(message));
                }
                apply_marks(&mut outbox, &watch);
            }
        });

        let 本文 = lines.join("\n");
        assert_eq!(
            lines.len(),
            3,
            "遷移以外の行が出ている（1件ごとに回る場所へ置いていないか）:\n{本文}"
        );
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("畳みました"))
                .count(),
            1,
            "畳んだ1行が無い:\n{本文}"
        );
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("読み直しを頼みました"))
                .count(),
            1,
            "読み直しを頼んだ1行が無い:\n{本文}"
        );
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("これ以上畳みません"))
                .count(),
            1,
            "畳むのをやめた1行が無い:\n{本文}"
        );
        // 相関キー（設計§7）。無いと、出ていても後から辿れない
        for line in &lines {
            assert!(line.contains("card_id"), "card_id が載っていない: {line}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 頼めなかった読み直しは頼んだことにしない() {
        // 頼めない相手（パーサが繋がっていない・カードが外された）に対して
        // 「頼みました」と残すと、ログを読む人が原因を1つ取り違える
        let (mut outbox, _offsets, dir) = outbox_with(
            "rewatch-failed",
            Limits {
                card_nodes: 2,
                ..Limits::default()
            },
        );
        let watch = FakeWatch::default(); // path が無い＝頼めない
        let card_id = CardId::new();

        let lines = 集める(|| {
            outbox.push(report_nodes(card_id, "a", 3, 10));
            apply_marks(&mut outbox, &watch);
            let first = outbox.pump();
            outbox.ack(batch_id_of(&first[0]));
            apply_marks(&mut outbox, &watch);
        });

        assert_eq!(
            watch.rewatched(),
            vec![card_id],
            "頼みにすら行っていない（相手が答えられるかは相手が決める）"
        );
        assert!(
            !lines
                .iter()
                .any(|line| line.contains("読み直しを頼みました")),
            "頼めていないのに頼んだと残っている:\n{}",
            lines.join("\n")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 適用した印は消えて二度は効かない() {
        // 印が残ると、次に適用したとき同じカードをもう一度止めて読み直させる。
        // **読み直しが二重に走ると、その間に届いたぶんの並びが崩れる**
        let (mut outbox, _offsets, dir) = outbox_with(
            "apply-once",
            Limits {
                card_nodes: 2,
                ..Limits::default()
            },
        );
        let watch = FakeWatch::with_path();
        let card_id = CardId::new();

        outbox.push(report_nodes(card_id, "a", 3, 10));
        apply_marks(&mut outbox, &watch);
        let first = outbox.pump();
        outbox.ack(batch_id_of(&first[0]));
        apply_marks(&mut outbox, &watch);
        // 何も足さずにもう一度適用する
        apply_marks(&mut outbox, &watch);

        assert_eq!(watch.stopped(), vec![card_id], "監視を二度止めている");
        assert_eq!(watch.rewatched(), vec![card_id], "読み直しを二度頼んでいる");
        let _ = std::fs::remove_dir_all(dir);
    }
}
