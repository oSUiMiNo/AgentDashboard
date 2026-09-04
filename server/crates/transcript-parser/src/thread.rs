//! スレッディング層 — レコードの列を、画面で掘れるツリーに組み立てる（設計§8 のパーサ中核）。
//!
//! # 表示のツリーは `parentUuid` の鎖そのものではない
//!
//! 設計§8-1 は「`uuid`/`parentUuid` でツリー連結」と書いているが、実データの `parentUuid` は
//! **会話の直線的な鎖**である（各レコードの親が直前のレコード）。これをそのまま表示の親子に
//! すると、レコード数ぶんの深さを持つ階段になり、数百レコードで完全に読めなくなる。
//! 要件が求めているのは「サブエージェント → ツールコール → 編集差分 と掘れる」表示であって、
//! 会話順の入れ子ではない。
//!
//! そこで表示の親子は**意味で決める**：
//!
//! ```text
//! 👤 ユーザのメッセージ            ← 根
//! 🤖 アシスタントの本文            ← 根（ここが「そのターンの見出し」になる）
//!   🔧 ツールコール                ← 直前のアシスタント本文の子
//!     🧩 サブエージェント          ← 起動したツールコールの子
//!       🔧 サブエージェント内のツールコール
//! ```
//!
//! `parentUuid` を捨てるわけではない。**未知種別のレコードを「どのあたりで起きたか」に
//! 置く**ために使う（[`SessionThreader::resolve`]）。ここで「表示しないが鎖には参加する」
//! 種別（`attachment` / `system`）を透過させないと、未知レコードの置き場所がずれる。
//!
//! # サブエージェントのマウントは2系統
//!
//! `subagents/` はフラットに並ぶだけで、木構造はファイル配置からは分からない。
//! `meta.json` のリンクだけが頼りで、しかも**深さによって鍵が違う**（実データで確認）。
//!
//! | 深さ | 鍵 |
//! |---|---|
//! | 1 | `toolUseId` → 親セッションの当該ツールコール |
//! | 2以上 | `parentAgentId` → 親エージェントのルートノード |
//!
//! どちらも解けないもの（`spawnDepth` すら無い meta も実在する）は**捨てずに根へ吊るす**。
//! 消すと「サブエージェントが走ったのに画面に何も出ない」という、いちばん困る形になる。

use crate::normalize::{self, Block};
use crate::parse::{Kind, Record, truncate_text};
use crate::stats::Stats;
use protocol::{Node, NodeId, SubagentRef, ToolStatus, TreeNode};
use serde_json::Value;
use std::collections::HashMap;

/// `agent-*.meta.json` から読んだ、サブエージェントの素性。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMeta {
    pub agent_id: String,
    pub agent_type: String,
    /// 深さ1のときの鍵。親セッションのツールコールIDを指す
    pub tool_use_id: Option<String>,
    /// 深さ2以上のときの鍵。親エージェントの識別子を指す
    pub parent_agent_id: Option<String>,
    /// 欠けている meta が実在するので `Option`
    pub spawn_depth: Option<u32>,
    pub transcript_path: String,
}

/// ツールコール1件の、結果が届くまでの状態。
#[derive(Debug, Clone)]
struct ToolCallState {
    node_id: NodeId,
    parent: Option<NodeId>,
    name: String,
    input: Value,
    result: Option<Value>,
    status: ToolStatus,
    subagent: Option<SubagentRef>,
    ts: i64,
    /// 発行した時点の会話の枝。サブエージェントはこれを引き継ぐ
    branch: u32,
}

impl ToolCallState {
    fn to_tree_node(&self) -> TreeNode {
        TreeNode {
            id: self.node_id.clone(),
            parent: self.parent.clone(),
            node: Node::ToolCall {
                name: self.name.clone(),
                input: self.input.clone(),
                result: self.result.clone(),
                status: self.status,
                subagent: self.subagent.clone(),
            },
            ts: self.ts,
            branch: self.branch,
        }
    }
}

/// 1ファイル分の読み進み状態。
#[derive(Debug, Default)]
struct FileState {
    /// このファイルのノードがぶら下がる根。サブエージェントのファイルなら
    /// そのエージェントのルートノード、本体なら `None`（＝画面の最上位）
    root: Option<NodeId>,
    /// 直近のアシスタント本文。ツールコールはここにぶら下がる
    turn_anchor: Option<NodeId>,
    /// レコードの `uuid` → 実際に発行したノード。未知レコードの置き場所の解決に使う
    resolved: HashMap<String, Option<NodeId>>,
    /// このファイルのノードが属する会話の枝。
    ///
    /// 本体ファイルでは根が切り替わるたびに進み、サブエージェントのファイルでは
    /// 起動元のツールコールの枝で固定される。
    branch: u32,
    /// 本体ファイルで観測した「根になるユーザ発言」の数。2件目以降が巻き戻しの跡
    roots_seen: u32,
    /// 画像を出したが**置き場所がまだ届いていない**ノード（画像添付 設計§21 読み替え1）。
    ///
    /// claude は本体レコード（`image` ブロック）を先に書き、置き場所は
    /// **相棒レコード**（`isMeta` ＋ `turnCompanion`）で後から書く。だから本体を
    /// 読んだ時点では絵の在り処が分からない。**同じ `promptId` の相棒が来たら、
    /// 並び順で結びつける**（`imagePasteIds` は通し番号なので鍵にしない）。
    ///
    /// # 表ではなく枠を1つだけ持つ
    ///
    /// **育たないことを型で言うため。** 表にすると、相棒が来なかったぶんの鍵とノードが
    /// [`SessionThreader`] の寿命ぶん居座る——相棒が来ない道は実在する
    /// （クリップボードから直に貼った画像）ので、放っておくと画像を含むプロンプトの数だけ
    /// 増え続ける。**このクレートは、差し替えたパーサが 8GB まで育って機械を落としかけた
    /// 歴史を持つ。**
    ///
    /// 1つで足りるのは、**レコードを1つのファイルから順に読む**ためである。claude は
    /// 本体 → 相棒 → 本体 → 相棒 と書くので、**同時に2つのプロンプトが待つ形にならない。**
    /// 新しい本体が来たら、前のぶんは相棒が来なかったものとして捨てる。
    ///
    /// **代償。** 本体（p1）→ 本体（p2）→ 相棒（p1）の順で来たら p1 は置き場所を持てない。
    /// 実測でこの順は起きないが、起きても**絵が出ないだけ**で落ちはしない
    /// （`path` が `None` の [`Node::Image`] は「手元に残っていません」と出る）。
    pending_images: Option<(String, std::collections::VecDeque<TreeNode>)>,
    /// スラッシュコマンドの本体を1つだけ覚えておく枠
    /// （`人が打っていないものを、人の発言として出さない` 設計§3-3）。
    ///
    /// `(本体レコードの uuid, 発行したノードそのもの)` を持つ。展開後の中身は
    /// **別のレコード**で来るので、届いたら**同じ ID のまま**送り直す。
    ///
    /// ノードを丸ごと覚えるのは、**名乗り・親・時刻を展開で上書きしないため**である
    /// （持ち主は本体のほうで、展開は中身を足すだけ）。
    ///
    /// # [`FileState::pending_images`] を汎用化しなかった理由
    ///
    /// **鍵が違う。** 画像は「同じ `promptId` の中での並び順」で対応を取るが、
    /// こちらは **`展開.parentUuid == 本体.uuid`** のレコード対レコードである。
    /// 1つの仕組みに載せて `promptId` を鍵にすると、**1つのプロンプトに2つコマンドを
    /// 打った形（実測131件）でフックの注入をコマンドの展開として吸い込む**（設計§3-2）。
    ///
    /// # 枠1つで足りる根拠は、画像より強い
    ///
    /// あちらは「実測でこの順序は起きない」という経験則だったが、こちらは**因果**である
    /// ——**存在しない `uuid` は参照できないので、展開が本体より先に来ることは原理的に無い。**
    /// `[本体1][展開1][本体2][展開2]` の並びも、枠1つで正しく捌ける。
    pending_command: Option<(String, TreeNode)>,
    /// まだ読まれていない追加メッセージ（設計§4）。`(ノードID, 本文)` を入った順に持つ。
    ///
    /// # 育たないことを、型ではなく数で言う
    ///
    /// [`FileState::pending_images`] は枠を1つに絞ることで育たなさを型で言えたが、
    /// **こちらは行列そのものが対象**なので絞れない。代わりに [`MAX_QUEUED`] で頭打ちに
    /// する——実測の最大は8前後（アンダーフロー0件・ほぼ全セッションが深さ0で終わる）
    /// なので通常は効かず、**模型が破綻したときに画面が埋まるのを止める歯止め**である。
    ///
    /// **このクレートは、差し替えたパーサが 8GB まで育って機械を落としかけた歴史を持つ。**
    queued: std::collections::VecDeque<(NodeId, String)>,
    /// このファイルで何件目の `enqueue` か。ノードIDの通し番号（設計§3-2）。
    ///
    /// **[`SessionThreader::synthetic_id`] を使わない。** あちらは本体とサブエージェントの
    /// 全ファイルで1本の連番を共有するので、**サブエージェントのファイルが見つかる時機で
    /// 番号がずれる**。こちらはファイル内に閉じており、読む経路3つ（通常の追尾・再開時の
    /// `catch_up`・`read_range`）が**すべて先頭から食わせる**ので、読み直しても同じ ID になる。
    queue_seq: u64,
}

/// 待ち行列に同時に並べる上限（設計§4-2）。
const MAX_QUEUED: usize = 64;

/// 待ち行列の本文の上限（設計§4-2）。
///
/// 実データの `enqueue` には `<task-notification>` を丸ごと抱えたものがある
/// （フィクスチャにも実在）。畳まれるまでのあいだ抱え続けるので、ここで切る。
const MAX_QUEUED_TEXT: usize = 64 * 1024;

/// 1セッション（本体＋サブエージェント群）ぶんのスレッディング。
///
/// ツールコールとエージェントの索引は**ファイルをまたぐ**ので、ここが持つ。
/// ファイルごとに分けると、深さ1のマウント（子ファイルの meta が親ファイルの
/// ツールコールを指す）が成立しない。
#[derive(Debug, Default)]
pub struct SessionThreader {
    files: HashMap<String, FileState>,
    /// tool_use_id → ツールコールの状態
    tool_calls: HashMap<String, ToolCallState>,
    /// agentId → そのエージェントを起動したツールコールの tool_use_id
    ///
    /// 親の `toolUseResult.agentId` から作る。meta に `toolUseId` が無い場合の代替経路
    agent_to_tool_use: HashMap<String, String>,
    /// agentId → そのエージェントのルートノード
    agent_roots: HashMap<String, NodeId>,
    /// agentId → そのエージェントが属する会話の枝（深さ2以上の引き継ぎに使う）
    agent_branches: HashMap<String, u32>,
    /// マウント先がまだ決まらない meta。新しい索引が増えるたびに再挑戦する
    pending_metas: Vec<AgentMeta>,
    /// `uuid` を持たない未知レコードに振る通し番号
    synthetic_seq: u64,
    /// タイムスタンプが読めなかったときの代わり（0 にすると全部がエポックへ飛ぶ）
    last_ts: i64,
    /// CLI が付けたセッションの名前（本体ファイルの `ai-title` から。設計§2-2）。
    ///
    /// **最後に読んだものが勝つ。** 同じ題は履歴に何度も書かれる（実測で1ファイルに2件）。
    session_title: Option<String>,
    /// 上の題を、前回渡してから読み直したか。
    ///
    /// **これが無いと、読むたびに報告が出る。** 報告1件はカード1枚の配り直しになり、
    /// 記録層と全ブラウザまで波及するので、変わっていないものは流さない。
    title_unreported: bool,
    stats: Stats,
}

impl SessionThreader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn stats(&self) -> &Stats {
        &self.stats
    }

    /// そのサブエージェントのマウント先が確定しているか。
    ///
    /// 確定する前に子ファイルを読むと、中身が根へ散らばったまま固定されてしまう
    /// （親が後から決まっても、発行済みノードの親は変えられない）。読み手はこれを見て
    /// 「まだ読まない」と判断する。
    pub fn has_agent_root(&self, agent_id: &str) -> bool {
        self.agent_roots.contains_key(agent_id)
    }

    /// 前回渡してから変わったセッションの名前を取り出す。**取り出したら印が下りる。**
    ///
    /// 変わっていなければ `None`。読み手はこれを1巡に1回だけ見て、`Some` のときだけ
    /// 報告を1件出す（設計§2-2）。
    pub fn take_session_title(&mut self) -> Option<String> {
        if !self.title_unreported {
            return None;
        }
        self.title_unreported = false;
        self.session_title.clone()
    }

    /// レコード1件を取り込み、発行・更新されたノードを返す。
    ///
    /// 同じ [`NodeId`] のノードが再び返ることがある（ツールコールに結果が付いたとき）。
    /// 受け手は**上書き（upsert）**として扱うこと。
    pub fn feed_record(
        &mut self,
        source: &str,
        agent_id: Option<&str>,
        record: &Record,
    ) -> Vec<TreeNode> {
        self.stats.record();
        if record.broken {
            self.stats.parse_error();
        }
        if let Some(version) = &record.version {
            self.stats.version(version);
        }
        let ts = record.ts.unwrap_or(self.last_ts);
        self.last_ts = ts;

        // サブエージェントのファイルは、そのエージェントのルートの下に生える。
        // 一度 None で覚えてしまわないよう、根が判明した時点で必ず書き直す
        let agent_id = agent_id.or(record.agent_id.as_deref());
        if let Some(agent_id) = agent_id {
            if let Some(root) = self.agent_roots.get(agent_id).cloned() {
                self.files.entry(source.to_string()).or_default().root = Some(root);
            }
        }

        match record.kind() {
            Kind::Message => self.feed_message(source, record, ts),
            Kind::Transparent => {
                // 表示はしないが、鎖は繋いでおく。ここで切ると、後続の未知レコードが
                // 「どのあたりで起きたか」を見失って根に散らばる
                let parent = self.resolve(source, record.parent_uuid.as_deref());
                if let Some(uuid) = &record.uuid {
                    self.file(source).resolved.insert(uuid.clone(), parent);
                }
                Vec::new()
            }
            Kind::Attribute => {
                // ツリーへの影響は Noise と同じ。違うのは**値を控えること**だけ。
                //
                // **本体のファイルだけから拾う。** 判定に使うのは引数ではなく
                // 上で合成したほう——行そのものが `agentId` を名乗ることがあるので、
                // 本体のファイルに子の行が混ざっていても弾ける（設計§2-2）
                if agent_id.is_none() {
                    if let Some(title) = record.ai_title() {
                        if self.session_title.as_deref() != Some(title) {
                            self.session_title = Some(title.to_string());
                            self.title_unreported = true;
                        }
                    }
                }
                Vec::new()
            }
            Kind::Queue => self.feed_queue(source, record, ts),
            Kind::Noise => Vec::new(),
            Kind::Unknown => self.feed_unknown(source, record, ts),
        }
    }

    /// `agent-*.meta.json` を1件取り込む。
    pub fn feed_meta(&mut self, meta: AgentMeta) -> Vec<TreeNode> {
        let mut emitted = Vec::new();
        self.mount_agent(&meta, &mut emitted);
        emitted
    }

    // --- 内部 ---------------------------------------------------------------

    fn file(&mut self, source: &str) -> &mut FileState {
        self.files.entry(source.to_string()).or_default()
    }

    /// そのファイルのノードが属する会話の枝。
    fn branch_of(&self, source: &str) -> u32 {
        self.files.get(source).map_or(0, |file| file.branch)
    }

    /// レコードの `parentUuid` から、実際に発行済みのノードを引く。
    ///
    /// 透過種別を挟んでいても [`Self::feed_record`] が解決済みの値を入れているので、
    /// ここで鎖を辿る必要はない。辿らないので循環で固まる余地も無い。
    fn resolve(&mut self, source: &str, parent_uuid: Option<&str>) -> Option<NodeId> {
        let root = self.files.get(source).and_then(|file| file.root.clone());
        let Some(parent_uuid) = parent_uuid else {
            return root;
        };
        match self
            .files
            .get(source)
            .and_then(|f| f.resolved.get(parent_uuid))
        {
            Some(resolved) => resolved.clone(),
            None => {
                // 親を指しているのに親を知らない。捨てずに根へ置き、数えておく
                self.stats.orphan();
                root
            }
        }
    }

    /// スラッシュコマンドの展開後の中身なら、本体の吹き出しへ入れて送り直す
    /// （`人が打っていないものを、人の発言として出さない` 設計§3-1）。
    ///
    /// 見分ける鍵は **`展開.parentUuid == 本体.uuid`** ただ1つ。`promptId` は使わない
    /// ——1つのプロンプトにコマンドを2つ打てるので**一対多**になり、どちらの展開が
    /// どちらの本体のものか決まらない（設計§3-1）。
    ///
    /// **返したノードは、呼ぶ側が `last_emitted` に据えること。** そうすると
    /// [`Self::feed_message`] 末尾の解決で**展開の `uuid` が本体のノードを指す**ので、
    /// 展開にぶら下がる子（`attachment` など）が置き場所を見失わない（設計§5-1）。
    fn absorb_expansion(
        &mut self,
        source: &str,
        record: &Record,
        text: &str,
    ) -> Option<TreeNode> {
        // 画像の相棒はここへ来ない（あちらは `ImageSource` になる）が、念のため外す
        if !record.is_meta() || record.is_turn_companion() {
            return None;
        }
        let parent = record.parent_uuid.clone()?;
        let file = self.file(source);
        let (uuid, node) = file.pending_command.as_ref()?;
        if *uuid != parent {
            return None;
        }
        let mut node = node.clone();
        if let Node::UserMessage {
            command: Some(command),
            ..
        } = &mut node.node
        {
            command.expansion = Some(text.to_string());
        }
        // 展開は本体1つにつき1回。**受け取ったら手放す**
        file.pending_command = None;
        Some(node)
    }

    fn feed_message(&mut self, source: &str, record: &Record, ts: i64) -> Vec<TreeNode> {
        let root = self.files.get(source).and_then(|file| file.root.clone());
        let blocks = normalize::blocks(record);
        // 誰が入れたか（`人が打っていないものを、人の発言として出さない` 設計§1）。
        // **レコードにつき1回だけ決める**——1レコードの中の複数ブロックは同じ出どころ
        let origin = crate::origin::message_origin(record);
        let uuid = record.uuid.clone().unwrap_or_else(|| self.synthetic_id());
        let mut emitted = Vec::new();
        let mut last_emitted: Option<NodeId> = None;

        // 本体ファイルに `parentUuid` を持たないユーザ発言が現れたら、そこが会話の根。
        // 2件目以降は `/rewind` で分岐した跡なので、枝の番号を進める（設計§16）。
        // サブエージェントのファイル（root あり）と sidechain は会話の根ではない
        if root.is_none()
            && record.parent_uuid.is_none()
            && !record.is_sidechain
            && blocks
                .iter()
                .any(|block| matches!(block, Block::UserText(_)))
        {
            let file = self.file(source);
            file.roots_seen += 1;
            file.branch = file.roots_seen.saturating_sub(1);
        }
        let branch = self.branch_of(source);

        for (index, block) in blocks.into_iter().enumerate() {
            // 区切りに `#` を使わない。ノードIDは履歴の遡り（`?before=<id>`）で URL に
            // 載るため、`#` だとフラグメント扱いになって値が途中で切れる
            let node_id = NodeId(format!("{uuid}.{index}"));
            match block {
                // スラッシュコマンド。**打った形をそのまま出し、展開を待つ枠を張る**
                Block::SlashCommand { typed } => {
                    self.file(source).turn_anchor = None;
                    let retired = self.retire_matching(source, &typed, root.clone(), ts, branch);
                    emitted.extend(retired);
                    let node = TreeNode {
                        id: node_id.clone(),
                        parent: root.clone(),
                        node: Node::UserMessage {
                            text: typed.clone(),
                            origin: origin.clone(),
                            command: Some(protocol::SlashCommand {
                                typed,
                                expansion: None,
                            }),
                        },
                        ts,
                        branch,
                    };
                    // 前の本体が展開を持たなかったぶんは、ここで手放す。**抱えたままにしない**
                    // ——展開が来ないほうが多数派である（実測で34%にしか展開が無い。設計§3-4）
                    self.file(source).pending_command = record
                        .uuid
                        .clone()
                        .map(|uuid| (uuid, node.clone()));
                    emitted.push(node);
                    last_emitted = Some(node_id);
                }
                Block::UserText(text) => {
                    // 展開後の中身なら、**新しい行にせず本体の吹き出しへ入れる**（設計§3-1）
                    if let Some(node) = self.absorb_expansion(source, record, &text) {
                        last_emitted = Some(node.id.clone());
                        emitted.push(node);
                        continue;
                    }
                    // 新しい指示が来たらターンが変わる。以後のツールコールは
                    // 次のアシスタント本文にぶら下がる
                    self.file(source).turn_anchor = None;
                    // **合図(a)**：待っていた同じ本文を畳む（設計§4-1）。**行列の出入り
                    // だけを見ていると足りない**——本物の `user` レコードが `dequeue` より
                    // 先に書かれる場面があり、その間ずっと同じ本文が2つ並ぶ
                    let retired = self.retire_matching(source, &text, root.clone(), ts, branch);
                    emitted.extend(retired);
                    emitted.push(TreeNode {
                        id: node_id.clone(),
                        parent: root.clone(),
                        node: Node::UserMessage {
                            text,
                            origin: origin.clone(),
                            command: None,
                        },
                        ts,
                        branch,
                    });
                    last_emitted = Some(node_id);
                }
                Block::AssistantText(text) => {
                    self.file(source).turn_anchor = Some(node_id.clone());
                    emitted.push(TreeNode {
                        id: node_id.clone(),
                        parent: root.clone(),
                        node: Node::AssistantText { text },
                        ts,
                        branch,
                    });
                    last_emitted = Some(node_id);
                }
                // 送った画像。**この時点では置き場所が分からない**——相棒レコードが
                // 後から運んでくる（§21 読み替え1）。先に出しておいて、届いたら
                // 同じ ID で送り直す（ツールコールに結果が付くのと同じ形）
                Block::Image { media_type } => {
                    let node = TreeNode {
                        id: node_id.clone(),
                        parent: root.clone(),
                        node: Node::Image {
                            path: None,
                            media_type,
                            file_name: None,
                        },
                        ts,
                        branch,
                    };
                    if let Some(prompt) = record.prompt_id() {
                        let waiting = &mut self.file(source).pending_images;
                        // 別のプロンプトが待っていたなら、それは相棒が来なかったぶん。捨てる
                        match waiting {
                            Some((holding, queue)) if holding == prompt => {
                                queue.push_back(node.clone())
                            }
                            _ => {
                                let mut queue = std::collections::VecDeque::new();
                                queue.push_back(node.clone());
                                *waiting = Some((prompt.to_string(), queue));
                            }
                        }
                    }
                    emitted.push(node);
                    last_emitted = Some(node_id);
                }
                // 相棒が運んできた置き場所。**それ自体はノードにならない**——
                // 待っている画像へ合流させ、同じ ID で送り直す
                Block::ImageSource { path } => {
                    let waiting = record.prompt_id().and_then(|prompt| {
                        let slot = &mut self.file(source).pending_images;
                        // 枠が別のプロンプトを抱えていれば、この相棒の相手は居ない
                        let (_, queue) = slot.as_mut().filter(|(held, _)| held == prompt)?;
                        let node = queue.pop_front();
                        // 出し切ったら枠ごと空ける。**抱えたままにしない**
                        if queue.is_empty() {
                            *slot = None;
                        }
                        node
                    });
                    if let Some(mut node) = waiting {
                        if let Node::Image { path: slot, .. } = &mut node.node {
                            *slot = Some(path);
                        }
                        emitted.push(node);
                    }
                    // 待っている画像が無ければ**黙って捨てる**。相棒だけが届く形
                    // （本体を読み飛ばした・順序が入れ替わった）で、出せる絵は無い
                }
                Block::Thinking(text) => {
                    emitted.push(TreeNode {
                        id: node_id.clone(),
                        parent: root.clone(),
                        node: Node::Thinking { text },
                        ts,
                        branch,
                    });
                    last_emitted = Some(node_id);
                }
                Block::ToolUse { id, name, input } => {
                    let parent = self
                        .files
                        .get(source)
                        .and_then(|file| file.turn_anchor.clone())
                        .or_else(|| root.clone());
                    let state = ToolCallState {
                        node_id: node_id.clone(),
                        parent,
                        name,
                        input,
                        result: None,
                        status: ToolStatus::Pending,
                        subagent: None,
                        ts,
                        branch,
                    };
                    emitted.push(state.to_tree_node());
                    if !id.is_empty() {
                        self.tool_calls.insert(id, state);
                        // 新しいツールコールが増えたので、待たせている meta を再挑戦
                        self.retry_pending(&mut emitted);
                    }
                    last_emitted = Some(node_id);
                }
                Block::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => {
                    // 結果は自分ではノードにならず、対応するツールコールへ合流する。
                    // 同じIDのノードを結果入りで送り直す（upsert 契約）
                    if let Some(state) = self.tool_calls.get_mut(&tool_use_id) {
                        // top-level の toolUseResult があればそちらを使う。Edit の
                        // structuredPatch のような差分表示に必要な情報はこちらにしかない
                        state.result = Some(match record.tool_use_result() {
                            Some(value) => normalize::truncate_value(value),
                            None => content,
                        });
                        state.status = if is_error {
                            ToolStatus::Error
                        } else {
                            ToolStatus::Ok
                        };
                        emitted.push(state.to_tree_node());
                    }
                    self.index_agent_from_result(record, &tool_use_id, &mut emitted);
                }
            }
        }

        if let Some(uuid) = &record.uuid {
            let resolved = last_emitted.or(root);
            self.file(source).resolved.insert(uuid.clone(), resolved);
        }
        emitted
    }

    fn feed_unknown(&mut self, source: &str, record: &Record, ts: i64) -> Vec<TreeNode> {
        let record_type = if record.record_type.is_empty() {
            "<壊れた行>"
        } else {
            &record.record_type
        };
        self.stats.unknown_type(record_type);

        let branch = self.branch_of(source);
        let parent = self.resolve(source, record.parent_uuid.as_deref());
        let node_id = match &record.uuid {
            Some(uuid) => NodeId(uuid.clone()),
            None => NodeId(self.synthetic_id()),
        };
        if let Some(uuid) = &record.uuid {
            self.file(source)
                .resolved
                .insert(uuid.clone(), Some(node_id.clone()));
        }
        vec![TreeNode {
            id: node_id,
            parent,
            node: Node::Unknown {
                record_type: record_type.to_string(),
                raw: record.raw.clone(),
            },
            ts,
            branch,
        }]
    }

    /// 待ち行列の出入りを行にする（設計§4・§10）。
    ///
    /// **`enqueue` だけがノードを作る。** 他は既にあるノードを `taken: true` で送り直す
    /// ——単一ノードを消す経路が経路上のどこにも無いので、消す代わりに「行にしない」で畳む。
    ///
    /// # 出しているのは「送った」ではない
    ///
    /// **`enqueue` の行が実際に JSONL へ書かれ、パーサがそれを読んだ**ことである。
    /// **送信が失敗すればこの行は書かれないので、画面が嘘をつく余地が無い。**
    ///
    /// 姉妹イシュー `送信した指示が構造化ビューにすぐ出ない` は**楽観表示**（押した瞬間に、
    /// まだ書かれていないものを出す）を「送ったと届いたは別だから」と名指しで不採用に
    /// している。**こちらはその楽観表示ではない**（設計§8）。
    fn feed_queue(&mut self, source: &str, record: &Record, ts: i64) -> Vec<TreeNode> {
        let branch = self.branch_of(source);
        let root = self.files.get(source).and_then(|file| file.root.clone());

        match record.queue_operation().unwrap_or_default() {
            "enqueue" => {
                let Some(content) = record.queue_content() else {
                    return Vec::new();
                };
                let text = truncate_text(content, MAX_QUEUED_TEXT);
                let session = record.session_id().unwrap_or_default().to_string();
                let file = self.file(source);
                let ordinal = file.queue_seq;
                file.queue_seq += 1;
                // 区切りに `#` を使わない。ノードIDは履歴の遡り（`?before=<id>`）で
                // URL に載るため、`#` だとフラグメント扱いになって値が途中で切れる
                let node_id = NodeId(format!("queue:{session}:{ordinal}"));
                file.queued.push_back((node_id.clone(), text.clone()));
                // 溢れたぶんは畳んで手放す。**抱えたままにしない**
                let mut overflow = Vec::new();
                while file.queued.len() > MAX_QUEUED {
                    if let Some(old) = file.queued.pop_front() {
                        overflow.push(old);
                    }
                }
                let mut emitted: Vec<TreeNode> = overflow
                    .into_iter()
                    .map(|(id, held)| taken_node(id, held, root.clone(), ts, branch))
                    .collect();
                emitted.push(TreeNode {
                    id: node_id,
                    parent: root,
                    node: Node::QueuedMessage { text, taken: false },
                    ts,
                    branch,
                });
                emitted
            }
            // 本文を持たないので**位置で決める**。実データでアンダーフローは0件だった
            "dequeue" => self.retire_front(source, root, ts, branch),
            // 本文の一致で抜く（**先頭とは限らない**）。一致が無ければ最も古いものを落とす
            "remove" => match record.queue_content() {
                Some(content) => self.retire_text(source, content, root, ts, branch),
                None => self.retire_front(source, root, ts, branch),
            },
            "popAll" => {
                let drained: Vec<_> = self.file(source).queued.drain(..).collect();
                drained
                    .into_iter()
                    .map(|(id, held)| taken_node(id, held, root.clone(), ts, branch))
                    .collect()
            }
            // 知らない値は**何もしない**（設計§10）。`popAll` は分類表にもコメントにも
            // 設計文書にも無いまま実在していた（実測36件）ので、**5つ目は必ず来る**。
            // 来たときに壊れるより、無視して合図(a) に拾わせるほうがよい
            _ => Vec::new(),
        }
    }

    /// 行列の先頭を1つ畳む。
    fn retire_front(
        &mut self,
        source: &str,
        root: Option<NodeId>,
        ts: i64,
        branch: u32,
    ) -> Vec<TreeNode> {
        match self.file(source).queued.pop_front() {
            Some((id, held)) => vec![taken_node(id, held, root, ts, branch)],
            None => Vec::new(),
        }
    }

    /// 本文の一致で1つ畳む。一致が無ければ先頭を落とす。
    fn retire_text(
        &mut self,
        source: &str,
        content: &str,
        root: Option<NodeId>,
        ts: i64,
        branch: u32,
    ) -> Vec<TreeNode> {
        let needle = truncate_text(content, MAX_QUEUED_TEXT);
        let hit = {
            let queued = &mut self.file(source).queued;
            queued
                .iter()
                .position(|(_, held)| *held == needle)
                .and_then(|at| queued.remove(at))
        };
        match hit {
            Some((id, held)) => vec![taken_node(id, held, root, ts, branch)],
            None => self.retire_front(source, root, ts, branch),
        }
    }

    /// **合図(a)**：同じ本文の発言が出たので、待っている行を畳む（設計§4-1）。
    ///
    /// **これが「二重に並ばない」の主保証である。** 本物の `user` レコードが
    /// `dequeue` より先に書かれる場面があるので、行列の出入りだけを見ていると
    /// **その間ずっと同じ本文が2つ並ぶ**。
    ///
    /// 本文の一致に頼るが、それでよい——**一致するのは「画面に出したら見分けが
    /// 付かない2つ」だけ**なので、どちらを畳んでも読む人には同じものが1つ残る。
    fn retire_matching(
        &mut self,
        source: &str,
        text: &str,
        root: Option<NodeId>,
        ts: i64,
        branch: u32,
    ) -> Vec<TreeNode> {
        let needle = truncate_text(text, MAX_QUEUED_TEXT);
        let hit = {
            let queued = &mut self.file(source).queued;
            queued
                .iter()
                .position(|(_, held)| *held == needle)
                .and_then(|at| queued.remove(at))
        };
        match hit {
            Some((id, held)) => vec![taken_node(id, held, root, ts, branch)],
            None => Vec::new(),
        }
    }

    fn synthetic_id(&mut self) -> String {
        self.synthetic_seq += 1;
        format!("synthetic:{}", self.synthetic_seq)
    }

    /// 親のツール結果に載っている `agentId` から、エージェント→ツールコールの索引を作る。
    ///
    /// meta.json に `toolUseId` が無い場合の代替経路になる。
    fn index_agent_from_result(
        &mut self,
        record: &Record,
        tool_use_id: &str,
        emitted: &mut Vec<TreeNode>,
    ) {
        let Some(agent_id) = record
            .tool_use_result()
            .and_then(|value| value.get("agentId"))
            .and_then(Value::as_str)
        else {
            return;
        };
        self.agent_to_tool_use
            .insert(agent_id.to_string(), tool_use_id.to_string());
        self.retry_pending(emitted);
    }

    /// マウント待ちの meta を、増えた索引で再挑戦する。
    ///
    /// meta.json と本体 JSONL の書き込み順は保証されないので、片方向だけの解決だと
    /// 「meta が先に来た」ケースで永久に根へ取り残される。
    fn retry_pending(&mut self, emitted: &mut Vec<TreeNode>) {
        if self.pending_metas.is_empty() {
            return;
        }
        let pending = std::mem::take(&mut self.pending_metas);
        for meta in pending {
            self.mount_agent(&meta, emitted);
        }
    }

    fn mount_agent(&mut self, meta: &AgentMeta, emitted: &mut Vec<TreeNode>) {
        let node_id = NodeId(format!("agent:{}", meta.agent_id));

        // 経路1: meta の toolUseId（深さ1）／経路2: 親の結果に載っていた agentId
        let tool_use_id = meta
            .tool_use_id
            .clone()
            .or_else(|| self.agent_to_tool_use.get(&meta.agent_id).cloned());

        // 枝は起動元から引き継ぐ。サブエージェントのファイルはあとから読まれることが
        // あり、そのときの本体の枝（巻き戻し後かもしれない）を拾うと嘘になる
        let (parent, depth_hint, branch) = if let Some(tool_use_id) = tool_use_id.as_ref() {
            match self.tool_calls.get(tool_use_id) {
                Some(state) => (Some(state.node_id.clone()), Some(1), state.branch),
                None => {
                    // ツールコールがまだ読めていない。捨てずに待たせる
                    self.pending_metas.push(meta.clone());
                    return;
                }
            }
        } else if let Some(parent_agent_id) = &meta.parent_agent_id {
            // 経路3: 深さ2以上。親エージェントのルートへぶら下げる
            match self.agent_roots.get(parent_agent_id).cloned() {
                Some(parent) => (
                    Some(parent),
                    None,
                    self.agent_branches
                        .get(parent_agent_id)
                        .copied()
                        .unwrap_or_default(),
                ),
                None => {
                    self.pending_metas.push(meta.clone());
                    return;
                }
            }
        } else {
            // 手掛かりが何も無い。根へ吊るす（消さないことが大事）
            (None, None, 0)
        };

        let spawn_depth = meta.spawn_depth.or(depth_hint).unwrap_or(1);
        self.agent_roots
            .insert(meta.agent_id.clone(), node_id.clone());
        self.agent_branches.insert(meta.agent_id.clone(), branch);

        emitted.push(TreeNode {
            id: node_id.clone(),
            parent: parent.clone(),
            node: Node::Subagent {
                agent_type: meta.agent_type.clone(),
                spawn_depth,
            },
            ts: self.last_ts,
            branch,
        });

        // 親のツールコールに「ここに子ツリーがある」ことを書き戻す（upsert）
        if let Some(tool_use_id) = tool_use_id {
            if let Some(state) = self.tool_calls.get_mut(&tool_use_id) {
                state.subagent = Some(SubagentRef {
                    agent_type: meta.agent_type.clone(),
                    transcript_path: meta.transcript_path.clone(),
                    spawn_depth,
                });
                emitted.push(state.to_tree_node());
            }
        }

        // 既に読み込み済みのサブエージェントのファイルへ、根と枝を教え直す
        let file = self.files.entry(meta.transcript_path.clone()).or_default();
        file.root = Some(node_id);
        file.branch = branch;
    }
}

/// 畳んだ待ちの行。**同じ ID で送り直す**ので、受け手は upsert で置き換える。
///
/// 本文を残したまま `taken` だけを立てるのは、**行にしない判断を画面側が持つ**ため
/// （設計§4）。ここで本文を空にすると、落とす条件を「本文が空か」で書けなくなる。
fn taken_node(id: NodeId, text: String, parent: Option<NodeId>, ts: i64, branch: u32) -> TreeNode {
    TreeNode {
        id,
        parent,
        node: Node::QueuedMessage { text, taken: true },
        ts,
        branch,
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use crate::parse::parse_line;

    const MAIN: &str = "/p/s.jsonl";

    fn feed(threader: &mut SessionThreader, line: &str) -> Vec<TreeNode> {
        let record = parse_line(line);
        threader.feed_record(MAIN, None, &record)
    }

    fn kinds(nodes: &[TreeNode]) -> Vec<&'static str> {
        nodes
            .iter()
            .map(|node| match node.node {
                Node::UserMessage { .. } => "user",
                Node::AssistantText { .. } => "assistant",
                Node::Thinking { .. } => "thinking",
                Node::ToolCall { .. } => "tool",
                Node::Subagent { .. } => "subagent",
                Node::Image { .. } => "image",
                Node::QueuedMessage { taken, .. } => {
                    if taken {
                        "queued-taken"
                    } else {
                        "queued"
                    }
                }
                Node::Unknown { .. } => "unknown",
            })
            .collect()
    }

    #[test]
    fn ツールコールは直前のアシスタント本文にぶら下がる() {
        // 会話の鎖をそのまま親子にすると階段になるので、意味で親を決めている
        let mut threader = SessionThreader::new();
        feed(
            &mut threader,
            r#"{"type":"user","uuid":"u1","message":{"content":"テストを直して"}}"#,
        );
        let assistant = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","message":{"content":[
                {"type":"text","text":"確認します"}]}}"#,
        );
        let tool = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u3","parentUuid":"u2","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}"#,
        );

        assert_eq!(tool[0].parent.as_ref(), Some(&assistant[0].id));
        // ユーザとアシスタントは根に並ぶ（深さが会話の長さに比例しない）
        assert!(assistant[0].parent.is_none());
    }

    #[test]
    fn 巻き戻しで2つ目の根が生えると枝の番号が進む() {
        // `/rewind` は JSONL を物理的に巻き戻さず、同じファイルの末尾に
        // `parentUuid: null` のユーザ発言を追記する（設計§16 の実測）
        let mut threader = SessionThreader::new();
        let first = feed(
            &mut threader,
            r#"{"type":"user","uuid":"u1","message":{"content":"最初の指示"}}"#,
        );
        let reply = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","message":{"content":[
                {"type":"text","text":"やりました"}]}}"#,
        );
        assert_eq!(first[0].branch, 0);
        assert_eq!(reply[0].branch, 0, "同じ枝の続きは番号が変わらない");

        // 巻き戻して言い直した
        let second = feed(
            &mut threader,
            r#"{"type":"user","uuid":"u3","message":{"content":"やり直しの指示"}}"#,
        );
        let after = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u4","parentUuid":"u3","message":{"content":[
                {"type":"text","text":"了解"}]}}"#,
        );
        assert_eq!(second[0].branch, 1, "2つ目の根から新しい枝");
        assert_eq!(after[0].branch, 1);
    }

    #[test]
    fn サブエージェントは起動元の枝を引き継ぐ() {
        // 子ファイルは後から読まれる。そのときの本体の枝（巻き戻し後かもしれない）を
        // 拾うと、古い枝の作業が最新の枝に属していることになってしまう
        let mut threader = SessionThreader::new();
        feed(
            &mut threader,
            r#"{"type":"user","uuid":"u1","message":{"content":"最初の指示"}}"#,
        );
        let call = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Agent","input":{}}]}}"#,
        );
        assert_eq!(call[0].branch, 0);

        // 巻き戻して枝が進んだあとに、古い枝のサブエージェントを読み込む
        feed(
            &mut threader,
            r#"{"type":"user","uuid":"u3","message":{"content":"やり直しの指示"}}"#,
        );
        let mounted = threader.feed_meta(AgentMeta {
            agent_id: "agent-1".to_string(),
            agent_type: "Explore".to_string(),
            tool_use_id: Some("toolu_1".to_string()),
            parent_agent_id: None,
            spawn_depth: Some(1),
            transcript_path: "/p/s/subagents/agent-1.jsonl".to_string(),
        });
        let subagent = mounted
            .iter()
            .find(|node| matches!(node.node, Node::Subagent { .. }))
            .expect("サブエージェントのノードが出ること");
        assert_eq!(subagent.branch, 0, "起動元の枝のまま");

        // 子ファイルの中身も同じ枝になる
        let inside = threader.feed_record(
            "/p/s/subagents/agent-1.jsonl",
            Some("agent-1"),
            &parse_line(
                r#"{"type":"assistant","uuid":"a1","message":{"content":[
                {"type":"text","text":"調べました"}]}}"#,
            ),
        );
        assert_eq!(inside[0].branch, 0);
    }

    #[test]
    fn ツール結果は同じIDのノードを更新して届く() {
        let mut threader = SessionThreader::new();
        let call = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}]}}"#,
        );
        assert!(matches!(
            call[0].node,
            Node::ToolCall {
                status: ToolStatus::Pending,
                ..
            }
        ));

        let result = feed(
            &mut threader,
            r#"{"type":"user","uuid":"u2","parentUuid":"u1","toolUseResult":{"stdout":"ok"},
                "message":{"content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"ok"}]}}"#,
        );
        assert_eq!(result[0].id, call[0].id, "同じノードIDで送り直される");
        match &result[0].node {
            Node::ToolCall { status, result, .. } => {
                assert_eq!(*status, ToolStatus::Ok);
                // 差分表示に要る情報は top-level の toolUseResult 側にしかない
                assert_eq!(result.as_ref().unwrap().get("stdout").unwrap(), "ok");
            }
            other => panic!("ToolCall ではない: {other:?}"),
        }
    }

    #[test]
    fn 拒否された結果は文字列でも落ちずにエラーになる() {
        let mut threader = SessionThreader::new();
        feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Skill","input":{}}]}}"#,
        );
        let result = feed(
            &mut threader,
            r#"{"type":"user","uuid":"u2","toolUseResult":"Error: rejected","message":{"content":[
                {"tool_use_id":"toolu_1","type":"tool_result","content":"Error","is_error":true}]}}"#,
        );
        match &result[0].node {
            Node::ToolCall { status, .. } => assert_eq!(*status, ToolStatus::Error),
            other => panic!("ToolCall ではない: {other:?}"),
        }
    }

    #[test]
    fn 並列ツールコールは1レコードから別々のノードになる() {
        let mut threader = SessionThreader::new();
        let nodes = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"a","name":"Read","input":{}},
                {"type":"tool_use","id":"b","name":"Read","input":{}}]}}"#,
        );
        assert_eq!(kinds(&nodes), vec!["tool", "tool"]);
        assert_ne!(nodes[0].id, nodes[1].id, "1レコードでもIDが衝突しない");
    }

    #[test]
    fn 透過種別を挟んでも未知レコードの置き場所が繋がる() {
        // attachment を素通しで捨てると、その先の未知レコードが根へ散らばる
        let mut threader = SessionThreader::new();
        let assistant = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[{"type":"text","text":"本文"}]}}"#,
        );
        feed(
            &mut threader,
            r#"{"type":"attachment","uuid":"u2","parentUuid":"u1"}"#,
        );
        let unknown = feed(
            &mut threader,
            r#"{"type":"brand-new","uuid":"u3","parentUuid":"u2"}"#,
        );
        assert_eq!(kinds(&unknown), vec!["unknown"]);
        assert_eq!(unknown[0].parent.as_ref(), Some(&assistant[0].id));
    }

    #[test]
    fn ノイズ種別はノードにならない() {
        let mut threader = SessionThreader::new();
        // `queue-operation` はここから外した。**捨てる側から行を作る側へ移した**ので、
        // 残しておくと通ったまま意味が反対になる（設計§2-1）
        assert!(feed(&mut threader, r#"{"type":"last-prompt","prompt":"x"}"#).is_empty());
        assert!(feed(&mut threader, r#"{"type":"mode","mode":"default"}"#).is_empty());
        assert!(feed(&mut threader, r#"{"type":"ai-title","aiTitle":"題"}"#).is_empty());
    }

    /// 待ち行列の1件を組み立てる。`content` を省くと本文を持たない形になる。
    fn queue(operation: &str, content: Option<&str>) -> String {
        let body = match content {
            Some(text) => format!(
                r#","content":{}"#,
                serde_json::Value::String(text.to_string())
            ),
            None => String::new(),
        };
        format!(r#"{{"type":"queue-operation","operation":"{operation}","sessionId":"s1"{body}}}"#)
    }

    fn 発言(text: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"u1","message":{{"content":{}}}}}"#,
            serde_json::Value::String(text.to_string())
        )
    }

    #[test]
    fn 待ち行列に入った指示が行になる() {
        let mut threader = SessionThreader::new();
        let nodes = feed(&mut threader, &queue("enqueue", Some("あとで直して")));
        assert_eq!(kinds(&nodes), ["queued"]);
        assert_eq!(nodes[0].id, NodeId("queue:s1:0".into()));
        // 根へ置く。読まれた本物も根へ出るので、待ちも根が正しい位置（設計§5-1）
        assert!(nodes[0].parent.is_none());
    }

    #[test]
    fn 読まれた待ちは同じIDで畳まれる() {
        let mut threader = SessionThreader::new();
        feed(&mut threader, &queue("enqueue", Some("あとで直して")));
        let nodes = feed(&mut threader, &queue("dequeue", None));
        // **行は増えない。** 同じ ID を `taken` で送り直す（upsert 契約）
        assert_eq!(kinds(&nodes), ["queued-taken"]);
        assert_eq!(nodes[0].id, NodeId("queue:s1:0".into()));
    }

    #[test]
    fn removeは本文の一致で抜く_先頭とは限らない() {
        let mut threader = SessionThreader::new();
        feed(&mut threader, &queue("enqueue", Some("A")));
        feed(&mut threader, &queue("enqueue", Some("B")));
        let nodes = feed(&mut threader, &queue("remove", Some("B")));
        assert_eq!(nodes.len(), 1);
        // B を抜く。先頭固定だと A が消えてしまう
        assert_eq!(nodes[0].id, NodeId("queue:s1:1".into()));
    }

    #[test]
    fn popAllは全部畳む() {
        let mut threader = SessionThreader::new();
        feed(&mut threader, &queue("enqueue", Some("A")));
        feed(&mut threader, &queue("enqueue", Some("B")));
        let nodes = feed(&mut threader, &queue("popAll", None));
        assert_eq!(kinds(&nodes), ["queued-taken", "queued-taken"]);
    }

    #[test]
    fn 同じ本文の発言が先に来ても畳まれる() {
        // **合図(a)**（設計§4-1）。本物が `dequeue` より先に書かれる場面があるので、
        // ここが無いとその間ずっと同じ本文が2つ並ぶ
        let mut threader = SessionThreader::new();
        feed(&mut threader, &queue("enqueue", Some("あとで直して")));
        let nodes = feed(&mut threader, &発言("あとで直して"));
        assert_eq!(kinds(&nodes), ["queued-taken", "user"]);
    }

    #[test]
    fn 空の行列から取り出しても壊れない() {
        let mut threader = SessionThreader::new();
        assert!(feed(&mut threader, &queue("dequeue", None)).is_empty());
        assert!(feed(&mut threader, &queue("popAll", None)).is_empty());
    }

    #[test]
    fn 知らない出入りは何もしない() {
        // `popAll` が分類表にも設計文書にも無いまま実在していた。**5つ目は必ず来る**
        let mut threader = SessionThreader::new();
        feed(&mut threader, &queue("enqueue", Some("A")));
        assert!(feed(&mut threader, &queue("shuffle", None)).is_empty());
        // 行列は触られていないので、あとから畳める
        let nodes = feed(&mut threader, &queue("dequeue", None));
        assert_eq!(kinds(&nodes), ["queued-taken"]);
    }

    #[test]
    fn 待ち行列は上限で頭打ちになる() {
        // **育たないことを数で言う**（設計§4-2）。差し替えたパーサが 8GB まで育った
        // 歴史があるので、模型が破綻しても画面が埋まらないことを確かめる
        let mut threader = SessionThreader::new();
        for n in 0..(MAX_QUEUED + 2) {
            feed(&mut threader, &queue("enqueue", Some(&format!("指示{n}"))));
        }
        let file = threader.files.get(MAIN).expect("ファイルの状態がある");
        assert_eq!(file.queued.len(), MAX_QUEUED);
    }

    #[test]
    fn 長すぎる本文は切られる() {
        let mut threader = SessionThreader::new();
        let 長文 = "あ".repeat(MAX_QUEUED_TEXT);
        let nodes = feed(&mut threader, &queue("enqueue", Some(&長文)));
        let Node::QueuedMessage { text, .. } = &nodes[0].node else {
            panic!("待ちの行であること");
        };
        assert!(text.len() <= MAX_QUEUED_TEXT + 64, "切られていること");
        assert!(text.contains("省略"));
    }

    #[test]
    fn 同じファイルを2回読むと同じIDになる() {
        // ID が内容から決まること。**`synthetic_id` はファイルをまたぐ連番なので使えない**
        let ids = |()| {
            let mut threader = SessionThreader::new();
            let mut out = Vec::new();
            out.extend(feed(&mut threader, &queue("enqueue", Some("A"))));
            out.extend(feed(&mut threader, &queue("enqueue", Some("B"))));
            out.into_iter().map(|node| node.id).collect::<Vec<_>>()
        };
        assert_eq!(ids(()), ids(()));
    }

    #[test]
    fn 属性種別はノードにも鎖にもならない() {
        // ノードを作らないのは上のテストが見ている。こちらは**鎖に参加しない**ほう——
        // 属性の行を挟んでも、後続のレコードの親が動かないこと
        let mut threader = SessionThreader::new();
        let assistant = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[{"type":"text","text":"本文"}]}}"#,
        );
        feed(
            &mut threader,
            r#"{"type":"ai-title","uuid":"u2","parentUuid":"u1","aiTitle":"題"}"#,
        );
        let unknown = feed(
            &mut threader,
            r#"{"type":"brand-new","uuid":"u3","parentUuid":"u2"}"#,
        );
        // 鎖に参加していれば u1 へ繋がるが、属性は参加しないので親を解決できない
        assert_eq!(kinds(&unknown), vec!["unknown"]);
        assert_ne!(unknown[0].parent.as_ref(), Some(&assistant[0].id));
    }

    #[test]
    fn 本体の題を拾い取り出したら印が下りる() {
        let mut threader = SessionThreader::new();
        assert_eq!(threader.take_session_title(), None, "読む前は何も無い");

        feed(&mut threader, r#"{"type":"ai-title","aiTitle":"最初の題"}"#);
        assert_eq!(threader.take_session_title().as_deref(), Some("最初の題"));
        // **取り出したら印が下りる。** 次の巡回でまた出てきてはいけない
        assert_eq!(threader.take_session_title(), None);
    }

    #[test]
    fn 同じ題を何度読んでも報告は1回だけで最後の題が勝つ() {
        // 実測では1ファイルに同じ題が2件書かれている。読むたびに報告すると、
        // カード1枚の配り直しが記録層と全ブラウザまで波及し続ける
        let mut threader = SessionThreader::new();
        feed(&mut threader, r#"{"type":"ai-title","aiTitle":"同じ題"}"#);
        feed(&mut threader, r#"{"type":"ai-title","aiTitle":"同じ題"}"#);
        assert_eq!(threader.take_session_title().as_deref(), Some("同じ題"));
        assert_eq!(threader.take_session_title(), None);

        // 変わったら、また出る（最後に読んだものが勝つ）
        feed(&mut threader, r#"{"type":"ai-title","aiTitle":"後の題"}"#);
        assert_eq!(threader.take_session_title().as_deref(), Some("後の題"));
    }

    #[test]
    fn 中身の無い題は控えている名前を消さない() {
        let mut threader = SessionThreader::new();
        feed(&mut threader, r#"{"type":"ai-title","aiTitle":"題"}"#);
        assert_eq!(threader.take_session_title().as_deref(), Some("題"));

        feed(&mut threader, r#"{"type":"ai-title","aiTitle":""}"#);
        feed(&mut threader, r#"{"type":"ai-title"}"#);
        assert_eq!(
            threader.take_session_title(),
            None,
            "中身の無い題で報告が起きている"
        );
    }

    #[test]
    fn サブエージェントのファイルからは題を拾わない() {
        // 実測ではサブエージェントのファイルに `ai-title` は無いが、**無いことに
        // 頼らない**（設計§2-2）。判定は引数ではなく、行の `agentId` を合成した後で行う
        let mut threader = SessionThreader::new();
        let record = parse_line(r#"{"type":"ai-title","aiTitle":"子の題"}"#);
        threader.feed_record("/p/s/subagents/agent-a1.jsonl", Some("a1"), &record);
        assert_eq!(
            threader.take_session_title(),
            None,
            "引数で子だと分かる場合"
        );

        // 本体のファイルに、行そのものが子だと名乗るものが混ざった場合
        let 名乗る行 = parse_line(r#"{"type":"ai-title","aiTitle":"子の題","agentId":"a1"}"#);
        threader.feed_record(MAIN, None, &名乗る行);
        assert_eq!(
            threader.take_session_title(),
            None,
            "行が子だと名乗っているのに拾っている"
        );

        // 本体の行は拾う
        feed(&mut threader, r#"{"type":"ai-title","aiTitle":"親の題"}"#);
        assert_eq!(threader.take_session_title().as_deref(), Some("親の題"));
    }

    #[test]
    fn 壊れた行は未知ノードとして残り数えられる() {
        let mut threader = SessionThreader::new();
        let nodes = feed(&mut threader, "{壊れている");
        assert_eq!(kinds(&nodes), vec!["unknown"]);
        assert_eq!(threader.stats().parse_errors, 1);
    }

    #[test]
    fn 親が見つからないレコードは根に置いて数える() {
        let mut threader = SessionThreader::new();
        let nodes = feed(
            &mut threader,
            r#"{"type":"brand-new","uuid":"u9","parentUuid":"居ない"}"#,
        );
        assert!(nodes[0].parent.is_none());
        assert_eq!(threader.stats().orphans, 1);
    }

    #[test]
    fn 深さ1のサブエージェントはtool_use_idでマウントされる() {
        let mut threader = SessionThreader::new();
        let call = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Agent","input":{"prompt":"調べて"}}]}}"#,
        );
        let mounted = threader.feed_meta(AgentMeta {
            agent_id: "a1".to_string(),
            agent_type: "Explore".to_string(),
            tool_use_id: Some("toolu_1".to_string()),
            parent_agent_id: None,
            spawn_depth: Some(1),
            transcript_path: "/p/s/subagents/agent-a1.jsonl".to_string(),
        });

        assert_eq!(kinds(&mounted), vec!["subagent", "tool"]);
        assert_eq!(mounted[0].parent.as_ref(), Some(&call[0].id));
        // 親のツールコールにも子ツリーの在処が書き戻される
        match &mounted[1].node {
            Node::ToolCall { subagent, .. } => {
                assert_eq!(subagent.as_ref().unwrap().agent_type, "Explore");
            }
            other => panic!("ToolCall ではない: {other:?}"),
        }
    }

    #[test]
    fn 深さ2のサブエージェントはparentAgentIdでマウントされる() {
        // 実データでは深さ2以上の meta は toolUseId を持たない
        let mut threader = SessionThreader::new();
        feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Agent","input":{}}]}}"#,
        );
        let parent = threader.feed_meta(AgentMeta {
            agent_id: "a1".to_string(),
            agent_type: "general-purpose".to_string(),
            tool_use_id: Some("toolu_1".to_string()),
            parent_agent_id: None,
            spawn_depth: Some(1),
            transcript_path: "/p/s/subagents/agent-a1.jsonl".to_string(),
        });
        let child = threader.feed_meta(AgentMeta {
            agent_id: "a2".to_string(),
            agent_type: "general-purpose".to_string(),
            tool_use_id: None,
            parent_agent_id: Some("a1".to_string()),
            spawn_depth: Some(2),
            transcript_path: "/p/s/subagents/agent-a2.jsonl".to_string(),
        });

        assert_eq!(child[0].parent.as_ref(), Some(&parent[0].id));
        match &child[0].node {
            Node::Subagent { spawn_depth, .. } => assert_eq!(*spawn_depth, 2),
            other => panic!("Subagent ではない: {other:?}"),
        }
    }

    #[test]
    fn metaが先に来ても後からマウントされる() {
        // meta.json と本体 JSONL の書き込み順は保証されない
        let mut threader = SessionThreader::new();
        let early = threader.feed_meta(AgentMeta {
            agent_id: "a1".to_string(),
            agent_type: "Explore".to_string(),
            tool_use_id: Some("toolu_1".to_string()),
            parent_agent_id: None,
            spawn_depth: Some(1),
            transcript_path: "/p/s/subagents/agent-a1.jsonl".to_string(),
        });
        assert!(early.is_empty(), "まだマウント先が無いので発行しない");

        let late = feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Agent","input":{}}]}}"#,
        );
        assert_eq!(kinds(&late), vec!["tool", "subagent", "tool"]);
    }

    #[test]
    fn 手掛かりの無いmetaも捨てずに根へ吊るす() {
        // spawnDepth も toolUseId も無い meta が実在する
        let mut threader = SessionThreader::new();
        let mounted = threader.feed_meta(AgentMeta {
            agent_id: "a1".to_string(),
            agent_type: "Explore".to_string(),
            tool_use_id: None,
            parent_agent_id: None,
            spawn_depth: None,
            transcript_path: "/p/s/subagents/agent-a1.jsonl".to_string(),
        });
        assert_eq!(kinds(&mounted), vec!["subagent"]);
        assert!(mounted[0].parent.is_none());
    }

    #[test]
    fn サブエージェントのファイルはそのルートの下に生える() {
        let mut threader = SessionThreader::new();
        feed(
            &mut threader,
            r#"{"type":"assistant","uuid":"u1","message":{"content":[
                {"type":"tool_use","id":"toolu_1","name":"Agent","input":{}}]}}"#,
        );
        let mounted = threader.feed_meta(AgentMeta {
            agent_id: "a1".to_string(),
            agent_type: "Explore".to_string(),
            tool_use_id: Some("toolu_1".to_string()),
            parent_agent_id: None,
            spawn_depth: Some(1),
            transcript_path: "/p/s/subagents/agent-a1.jsonl".to_string(),
        });

        let record = parse_line(
            r#"{"type":"assistant","uuid":"c1","isSidechain":true,"agentId":"a1",
                "message":{"content":[{"type":"text","text":"子の応答"}]}}"#,
        );
        let child = threader.feed_record("/p/s/subagents/agent-a1.jsonl", Some("a1"), &record);
        assert_eq!(child[0].parent.as_ref(), Some(&mounted[0].id));
    }

    #[test]
    fn バージョンは行ごとに集めて集合になる() {
        let mut threader = SessionThreader::new();
        feed(
            &mut threader,
            r#"{"type":"user","uuid":"u1","version":"2.1.196"}"#,
        );
        feed(
            &mut threader,
            r#"{"type":"user","uuid":"u2","version":"2.1.220"}"#,
        );
        assert_eq!(threader.stats().versions.len(), 2);
    }

    /// 本体レコードの中身（画像1枚）。**置き場所は入っていない**。
    fn 本体(prompt: &str, 枚数: usize) -> String {
        let images: Vec<String> = (0..枚数)
            .map(|_| {
                r#"{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}"#
                    .to_string()
            })
            .collect();
        let ids: Vec<String> = (1..=枚数).map(|n| n.to_string()).collect();
        format!(
            r#"{{"type":"user","uuid":"b-{prompt}","promptId":"{prompt}","imagePasteIds":[{}],
               "message":{{"content":[{{"type":"text","text":"これを見て"}},{}]}}}}"#,
            ids.join(","),
            images.join(",")
        )
    }

    /// 相棒レコード。**置き場所だけ**を1枚につき1ブロックで運ぶ。
    fn 相棒(prompt: &str, paths: &[&str]) -> String {
        let blocks: Vec<String> = paths
            .iter()
            .map(|path| format!(r#"{{"type":"text","text":"[Image: source: {path}]"}}"#))
            .collect();
        format!(
            r#"{{"type":"user","uuid":"c-{prompt}","promptId":"{prompt}","isMeta":true,
               "turnCompanion":true,"message":{{"content":[{}]}}}}"#,
            blocks.join(",")
        )
    }

    fn 置き場所(node: &TreeNode) -> Option<&str> {
        match &node.node {
            Node::Image { path, .. } => path.as_deref(),
            _ => None,
        }
    }

    #[test]
    fn 画像は相棒レコードの置き場所と結びつく() {
        // claude は本体（`image` ブロック）を先に書き、置き場所は相棒
        // （`isMeta` ＋ `turnCompanion`）で後から書く（設計§21 読み替え1）
        let mut threader = SessionThreader::new();
        let body = feed(&mut threader, &本体("p1", 1));
        assert_eq!(kinds(&body), ["user", "image"]);
        // この時点では在り処が分からない
        assert_eq!(置き場所(&body[1]), None);

        let companion = feed(&mut threader, &相棒("p1", &["/state/a.png"]));
        // **相棒そのものは発言にならない。** 出るのは画像の送り直し1件だけ
        assert_eq!(kinds(&companion), ["image"]);
        assert_eq!(置き場所(&companion[0]), Some("/state/a.png"));
        // **同じ ID で送り直す**（ツールコールに結果が付くのと同じ形）
        assert_eq!(companion[0].id, body[1].id);
    }

    #[test]
    fn 複数枚は並びで対応を取る() {
        // **`imagePasteIds` を鍵にしない。** あれはセッションを跨いで続く通し番号で、
        // 1枚目が `#8` から始まることがある。対応は並びで取る
        let mut threader = SessionThreader::new();
        let body = feed(&mut threader, &本体("p2", 3));
        assert_eq!(kinds(&body), ["user", "image", "image", "image"]);

        let companion = feed(
            &mut threader,
            &相棒("p2", &["/state/a.png", "/state/b.png", "/state/c.png"]),
        );
        let paths: Vec<Option<&str>> = companion.iter().map(置き場所).collect();
        assert_eq!(
            paths,
            [
                Some("/state/a.png"),
                Some("/state/b.png"),
                Some("/state/c.png")
            ]
        );
        // 送り直しの ID が、本体で出した画像の並びと一致すること
        let 本体のID: Vec<&NodeId> = body[1..].iter().map(|n| &n.id).collect();
        let 相棒のID: Vec<&NodeId> = companion.iter().map(|n| &n.id).collect();
        assert_eq!(本体のID, 相棒のID);
    }

    #[test]
    fn 相棒が来なければ置き場所は無いまま残る() {
        // クリップボードから直に貼った画像には置き場所が無い（§21 読み替え1）。
        // **絵は出せないが「画像があった」ことは出せる**
        let mut threader = SessionThreader::new();
        let body = feed(&mut threader, &本体("p3", 1));
        assert_eq!(置き場所(&body[1]), None);
        // 別の promptId の相棒が来ても、こちらは埋まらない
        let 他人 = feed(&mut threader, &相棒("p9", &["/state/z.png"]));
        assert!(他人.is_empty(), "覚えのない相棒から画像が生えた: {他人:?}");
    }

    #[test]
    fn 文字列で来た相棒も発言として出ない() {
        // 実測では相棒は配列で来るが、**本体が文字列で来る形が現に在る**（最初の
        // プロンプト）ので、相棒だけは必ず配列だと決めてかかれない
        let mut threader = SessionThreader::new();
        let body = feed(&mut threader, &本体("p6", 1));
        let companion = feed(
            &mut threader,
            r#"{"type":"user","uuid":"c-p6","promptId":"p6","isMeta":true,
               "turnCompanion":true,"message":{"content":"[Image: source: /state/s.png]"}}"#,
        );
        assert_eq!(kinds(&companion), ["image"], "相棒が発言として出ている");
        assert_eq!(置き場所(&companion[0]), Some("/state/s.png"));
        assert_eq!(companion[0].id, body[1].id, "同じ ID で送り直していない");
    }

    #[test]
    fn 相棒でない文字列は従来どおり発言になる() {
        // 最初のプロンプトはこの形で来る。**相棒の見分けを広げすぎて、ここを
        // 巻き込まないこと**
        let mut threader = SessionThreader::new();
        let 発言 = feed(
            &mut threader,
            r#"{"type":"user","uuid":"u1","message":{"content":"テストを直して"}}"#,
        );
        assert_eq!(kinds(&発言), ["user"]);
    }

    #[test]
    fn 相棒の文は発言として履歴に出ない() {
        // そのまま通すと `[Image: source: …]` が発言に見える。あれは claude の
        // 内部の覚え書きであって、利用者が書いた文ではない
        let mut threader = SessionThreader::new();
        feed(&mut threader, &本体("p4", 1));
        let companion = feed(&mut threader, &相棒("p4", &["/state/a.png"]));
        assert!(
            !kinds(&companion).contains(&"user"),
            "相棒が発言として出ている: {:?}",
            kinds(&companion)
        );
    }

    /// その源のファイルが抱えている、置き場所待ちの画像の数。
    fn 待っている数(threader: &SessionThreader) -> usize {
        threader
            .files
            .get(MAIN)
            .and_then(|file| file.pending_images.as_ref())
            .map_or(0, |(_, queue)| queue.len())
    }

    #[test]
    fn 相棒が揃ったら待ちの枠が空く() {
        // **抱えたままにしない。** このクレートは、差し替えたパーサが 8GB まで育って
        // 機械を落としかけた歴史を持つ——際限が無いことそのものを残さない
        let mut threader = SessionThreader::new();
        feed(&mut threader, &本体("p6", 2));
        assert_eq!(待っている数(&threader), 2, "本体を読んだら待ちに入ること");

        feed(
            &mut threader,
            &相棒("p6", &["/state/a.png", "/state/b.png"]),
        );
        assert_eq!(待っている数(&threader), 0, "揃ったのに枠が残っている");
        assert!(
            threader.files[MAIN].pending_images.is_none(),
            "中身は出たのに枠だけ残っている"
        );
    }

    #[test]
    fn 相棒が来ないまま次の本体が来たら前のぶんは捨てる() {
        // 相棒が来ない道は実在する（クリップボードから直に貼った画像）。放っておくと
        // **画像を含むプロンプトの数だけ増え続ける**
        let mut threader = SessionThreader::new();
        feed(&mut threader, &本体("p7", 3));
        assert_eq!(待っている数(&threader), 3);

        // 相棒を挟まずに次の本体。前の3枚は置き場所を持てないまま捨てられる
        feed(&mut threader, &本体("p8", 1));
        assert_eq!(
            待っている数(&threader),
            1,
            "前のプロンプトのぶんが残っている"
        );

        // 新しいほうの相棒はちゃんと結びつく
        let companion = feed(&mut threader, &相棒("p8", &["/state/z.png"]));
        assert_eq!(置き場所(&companion[0]), Some("/state/z.png"));
        assert_eq!(待っている数(&threader), 0);
    }

    #[test]
    fn 画像のbase64は運ばない() {
        // 20枚のターン1本が 854,952 バイトになった実測がある（§19 前提2）。
        // **載せるのは置き場所と媒体型だけ**
        let mut threader = SessionThreader::new();
        let body = feed(&mut threader, &本体("p5", 1));
        let 中身 = serde_json::to_string(&body[1].node).expect("書けること");
        assert!(!中身.contains("AAAA"), "base64 が載っている: {中身}");
        assert!(中身.contains("image/png"), "媒体型が落ちている: {中身}");
    }
}

/// スラッシュコマンドの解析と結合
/// （`人が打っていないものを、人の発言として出さない` 設計§3・§4・§5）。
#[cfg(test)]
mod スラッシュコマンド {
    #![allow(non_snake_case)]

    use super::*;
    use crate::normalize::slash_command;
    use crate::parse::parse_line;

    const MAIN: &str = "/p/s.jsonl";

    fn feed(threader: &mut SessionThreader, line: &str) -> Vec<TreeNode> {
        threader.feed_record(MAIN, None, &parse_line(line))
    }

    /// 本体レコード（`origin.kind == "human"`。`promptSource` は持たない）
    fn 本体(uuid: &str, tags: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"{uuid}","parentUuid":null,"origin":{{"kind":"human"}},"message":{{"role":"user","content":{}}}}}"#,
            serde_json::to_string(tags).unwrap()
        )
    }

    /// 展開レコード（`isMeta` ＋ `parentUuid` が本体を指す）
    fn 展開(uuid: &str, parent: &str, body: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"{uuid}","parentUuid":"{parent}","isMeta":true,"message":{{"role":"user","content":{}}}}}"#,
            serde_json::to_string(body).unwrap()
        )
    }

    fn 発言(node: &TreeNode) -> (&str, Option<&protocol::SlashCommand>) {
        match &node.node {
            Node::UserMessage { text, command, .. } => (text.as_str(), command.as_ref()),
            other => panic!("user_message ではない: {other:?}"),
        }
    }

    #[test]
    fn 引数の無いコマンドは名前だけになる() {
        let typed = slash_command(
            "<command-message>pjt_read</command-message>\n<command-name>/pjt_read</command-name>",
        );
        assert_eq!(typed.as_deref(), Some("/pjt_read"));
    }

    #[test]
    fn 引数があれば名前の後ろに付く() {
        // `<command-args>` は要件に無かったが実在する（設計§0-2）
        let typed = slash_command(
            "<command-message>issue_doc_design</command-message>\n<command-name>/issue_doc_design</command-name>\n<command-args>設計を書いて</command-args>",
        );
        assert_eq!(typed.as_deref(), Some("/issue_doc_design 設計を書いて"));
    }

    #[test]
    fn タグ以外の字が混ざっていたら触らない() {
        // 当たらなければ生のテキストのまま出る。**壊れるのではなく元に戻る**（設計§4）
        assert_eq!(
            slash_command("これを見て <command-name>/pjt_read</command-name>"),
            None
        );
        assert_eq!(slash_command("<command-name>pjt_read</command-name>"), None, "/ が無い");
        assert_eq!(slash_command("ただの発言"), None);
    }

    #[test]
    fn 展開は同じ吹き出しの中身になる() {
        let mut threader = SessionThreader::new();
        let out = feed(
            &mut threader,
            &本体("u1", "<command-message>x</command-message>\n<command-name>/x</command-name>"),
        );
        assert_eq!(out.len(), 1);
        let (text, command) = 発言(&out[0]);
        assert_eq!(text, "/x", "**生のタグが1文字も残らない**");
        assert_eq!(command.unwrap().expansion, None, "この時点では展開が無い");
        let 本体のid = out[0].id.clone();

        let out = feed(&mut threader, &展開("u2", "u1", "コマンドの中身"));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, 本体のid, "**同じ ID で送り直す**（新しい行にしない）");
        let (text, command) = 発言(&out[0]);
        assert_eq!(text, "/x", "打った形は変わらない");
        assert_eq!(command.unwrap().expansion.as_deref(), Some("コマンドの中身"));
    }

    #[test]
    fn 展開が無い本体はそのまま出る() {
        // **展開が無いほうが多数派である**（実測でコマンド本体の34%にしか展開が無い）
        let mut threader = SessionThreader::new();
        let out = feed(&mut threader, &本体("u1", "<command-message>clear</command-message>\n<command-name>/clear</command-name>"));
        let (text, command) = 発言(&out[0]);
        assert_eq!(text, "/clear");
        assert_eq!(command.unwrap().expansion, None, "トグルを出さないための印");
    }

    #[test]
    fn 二つ打ったコマンドはそれぞれの展開を持つ() {
        // `[本体1][展開1][本体2][展開2]` の並び。**枠1つで捌ける**（設計§3-3）
        let mut threader = SessionThreader::new();
        let a = feed(&mut threader, &本体("u1", "<command-message>a</command-message>\n<command-name>/a</command-name>"));
        let ea = feed(&mut threader, &展開("u2", "u1", "Aの中身"));
        let b = feed(&mut threader, &本体("u3", "<command-message>b</command-message>\n<command-name>/b</command-name>"));
        let eb = feed(&mut threader, &展開("u4", "u3", "Bの中身"));

        assert_eq!(ea[0].id, a[0].id);
        assert_eq!(eb[0].id, b[0].id);
        assert_ne!(a[0].id, b[0].id);
        assert_eq!(発言(&ea[0]).1.unwrap().expansion.as_deref(), Some("Aの中身"));
        assert_eq!(発言(&eb[0]).1.unwrap().expansion.as_deref(), Some("Bの中身"));
    }

    #[test]
    fn 展開を待たずに次の本体が来たら枠を手放す() {
        // **展開が来ない本体のほうが多数派である**（実測66%）。抱えたままにすると、
        // 次のコマンドの展開が前の本体を指していないせいで**行として溢れる**（設計§3-4）
        let mut threader = SessionThreader::new();
        feed(&mut threader, &本体("u1", "<command-message>clear</command-message>\n<command-name>/clear</command-name>"));
        let 次 = feed(&mut threader, &本体("u3", "<command-message>b</command-message>\n<command-name>/b</command-name>"));
        let 展 = feed(&mut threader, &展開("u4", "u3", "Bの中身"));

        assert_eq!(展.len(), 1);
        assert_eq!(展[0].id, 次[0].id, "**新しいほうの本体が展開を受け取る**");
        assert_eq!(発言(&展[0]).1.unwrap().expansion.as_deref(), Some("Bの中身"));
    }

    #[test]
    fn 親が違う差し込みは吸い込まれない() {
        // **フックの注入をコマンドの展開として吸わない。** `promptId` を鍵にすると
        // ここが壊れる（設計§3-2）
        let mut threader = SessionThreader::new();
        let 本 = feed(&mut threader, &本体("u1", "<command-message>x</command-message>\n<command-name>/x</command-name>"));
        let 注入 = feed(&mut threader, &展開("u9", "別のレコード", "フックが差し込んだ文"));

        assert_eq!(注入.len(), 1, "独立した行として出る");
        assert_ne!(注入[0].id, 本[0].id, "本体へ吸い込まれていない");
        assert_eq!(発言(&本[0]).1.unwrap().expansion, None, "本体は空のまま");
        assert!(
            matches!(
                &注入[0].node,
                Node::UserMessage { origin: protocol::MessageOrigin::Injected, .. }
            ),
            "差し込まれた文として名乗る"
        );
    }

    #[test]
    fn 展開にぶら下がる子は吹き出しへ繋がる() {
        // 吸収してノードを出さないと、**展開の uuid が根へ解決される**（設計§5-1）。
        // その先の未知レコードが置き場所を見失うことを、ここで止める
        let mut threader = SessionThreader::new();
        let 本 = feed(&mut threader, &本体("u1", "<command-message>x</command-message>\n<command-name>/x</command-name>"));
        feed(&mut threader, &展開("u2", "u1", "中身"));
        // 置き場所の解決を実際に使うのは未知レコードのほう（`feed_unknown`）
        let 子 = feed(
            &mut threader,
            r#"{"type":"知らない種別","uuid":"u3","parentUuid":"u2"}"#,
        );
        assert_eq!(
            子[0].parent.as_ref(),
            Some(&本[0].id),
            "展開の子が、本体の吹き出しにぶら下がる"
        );
    }

    #[test]
    fn 生のタグはノードに残らない() {
        let mut threader = SessionThreader::new();
        let out = feed(&mut threader, &本体("u1", "<command-message>x</command-message>\n<command-name>/x</command-name>\n<command-args>引数</command-args>"));
        let text = serde_json::to_string(&out[0].node).unwrap();
        assert!(!text.contains("command-name"), "生のタグが残っている: {text}");
        assert!(!text.contains("command-message"), "生のタグが残っている: {text}");
        assert!(!text.contains("command-args"), "生のタグが残っている: {text}");
    }
}
