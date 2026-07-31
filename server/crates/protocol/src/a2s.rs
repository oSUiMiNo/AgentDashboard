//! エージェント ⇄ ダッシュボードサーバのメッセージ（セルフホスト化設計§4）。
//!
//! ブラウザ向けの [`crate::ws`] とは**別のプロトコル**にしてある。同じ列挙を使い回すと
//! 方向の意味論が濁り（`Spawn` は誰から誰へ？）、エージェント固有の知らせ（Hello・ack・
//! 画面の購読制御）がブラウザ向けの型に混ざる。**ブラウザ向けの型は不変**というのが
//! セルフホスト化の前提なので、線を分ける。
//!
//! # 運ぶのは構造化されたものだけ
//!
//! JSONL の生の行も、フックの生ペイロードも、ここには載らない（§5-3）。載るのは
//! パーサが解釈し終えた [`TreeNode`] と、状態機械が導出し終えた [`SessionStatus`] だけ。
//! 検収条件「生 JSONL が流れない」は、この型に載せる口が無いことで機構的に満たす。
//!
//! # 版はハンドシェイクで交渉する
//!
//! エージェントは利用者の PC にあり、サーバより更新が遅れがちになる。噛み合わない版で
//! 動き出してから気づくより、**接続の最初に断る**ほうがよい。WebSocket のサブプロトコル
//! （[`A2S_PROTOCOL`]）で交渉するので、upgrade の段階で拒否できる。

use crate::{
    AgentId, CardId, ModelId, PermissionMode, SessionMeta, SessionStatus, Timestamp, TreeNode,
};
use serde::{Deserialize, Serialize};

/// WebSocket のサブプロトコル名。**版番号を名前に含める**（§4-1）。
///
/// サーバが知らない版はハンドシェイクで拒否できる。ヘッダに載る文字列なので、
/// 増やすときは新しい定数を足して両方を受け付ける期間を作る。
pub const A2S_PROTOCOL: &str = "adash-a2s-v1";

/// [`A2S_PROTOCOL`] に対応するプロトコル版。Hello で突き合わせる。
pub const A2S_VERSION: u32 = 1;

/// 履歴のバッチにつける通し番号（§6-1）。
///
/// エージェントのプロセス内で単調に増える。**サーバは順序を仮定しない**——ack は
/// 「この番号は書けた」だけを意味し、抜けや追い越しの管理はエージェント側の責任。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BatchId(pub u64);

impl std::fmt::Display for BatchId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// 画面と履歴の更新間隔（§13-3）。DB settings の値をエージェントへ運ぶ。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Intervals {
    /// 履歴のバッチを送る周期（秒）
    pub sync_secs: u64,
    /// 画面の差分を送る周期（ミリ秒。フェーズ4）
    pub screen_ms: u64,
    /// 画面のスクロールバック行数（フェーズ4）
    pub scrollback_lines: usize,
}

/// エージェント → サーバ。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum AgentMessage {
    /// 接続の1通目（§4-2）。復帰時もここから始める。
    ///
    /// # PC の能力もここで名乗る
    ///
    /// `available_modes` と `always_bypass_permissions` は、`GET /api/settings` が
    /// 返す内容のうち **PC 側にしか無いもの**（起動している CLI が受け付ける権限モードと、
    /// エージェントの toml のトグル）。サーバモードにはローカルの CLI が居ないので、
    /// ここで受け取らないと起動ボタンと権限モードの選択肢が空になる。
    /// モデルの表は量が違う（数KB）ので [`AgentMessage::ModelTable`] に分けてある。
    Hello {
        protocol_version: u32,
        agent_version: String,
        agent_name: String,
        available_modes: Vec<PermissionMode>,
        always_bypass_permissions: bool,
    },
    /// カード1枚の最新（意味は [`crate::ws::ServerMessage::SessionUpsert`] と同じ）。
    ///
    /// 復帰したときは、全セッションぶんをここで送り直して再同期する（§6-4）。
    SessionUpsert {
        session: Box<SessionMeta>,
    },
    SessionRemoved {
        card_id: CardId,
    },
    Status {
        card_id: CardId,
        status: SessionStatus,
        subagent_active: u32,
        last_activity_at: Timestamp,
    },
    /// 履歴のバッチ（§6-1）。**ack が返るまで再送責任はエージェント側**。
    ///
    /// どのファイルのどこまで読んだか（オフセット）は載せない。サーバに使い道が無く、
    /// 利用者の PC のパスをネットワークへ出す理由も無い。位置の管理はエージェントが持つ。
    TranscriptBatch {
        batch_id: BatchId,
        card_id: CardId,
        nodes: Vec<TreeNode>,
    },
    /// 巻き戻り（`/rewind`）。**バッチ列の順序の中で送る**（§6-2）。
    ///
    /// これにも番号を付けるのは、ack を待つ列が1本だからである。番号が無いと
    /// 「巻き戻しは書けたのか」を確かめる手段が無く、後続のバッチだけが先に確定しうる。
    TranscriptReset {
        batch_id: BatchId,
        card_id: CardId,
    },
    ParserStatus {
        state: crate::ws::ParserState,
        detail: Option<String>,
    },
    Selfheal {
        phase: crate::ws::SelfhealPhase,
        detail: Option<String>,
    },
    /// 操作の失敗（モデル切替の連打拒否など。§5-6）。サーバは `ServerMessage::Error` へ移す。
    Error {
        card_id: Option<CardId>,
        message: String,
    },
    /// モデルの表（§13-4）。接続直後と、変化した時だけ送る。定期送信はしない。
    ///
    /// 中身をこのクレートの型にしないのは、**サーバが解釈しないため**。受け取った形の
    /// まま `agents.model_table` へ保存し、`GET /api/settings` で配り直すだけなので、
    /// 表の形が変わってもサーバとスキーマは無傷でいられる（`sessions.status` と同じ判断）。
    ModelTable {
        cli_version: String,
        catalog: serde_json::Value,
        aliases: serde_json::Value,
    },
}

/// サーバ → エージェント。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerToAgent {
    /// 接続の1通目の応答。確定した設定値を初期値として含める（§4-2・§6-4）。
    Hello {
        protocol_version: u32,
        server_version: String,
        /// このエージェントに割り当てられた ID。カードの帰属はサーバが決める（§5-1）
        agent_id: AgentId,
        intervals: Intervals,
    },
    /// 履歴が **DB へ入った**ことの応答（§6-1）。
    ///
    /// エージェントはこれを見てから JSONL のオフセットを進める。返さないことが
    /// そのまま「まだ書けていない」を意味するので、DB 断のときは黙って返さない（§12）。
    BatchAck {
        batch_id: BatchId,
    },
    /// 新しいセッションを起こす。**CardId はエージェントが採番する**（§5-2）ので、
    /// ここでは指定しない。結果は `SessionUpsert` で返る。
    Spawn {
        cwd: String,
        permission_mode: Option<PermissionMode>,
    },
    Kill {
        card_id: CardId,
    },
    Archive {
        card_id: CardId,
    },
    /// Composer からの指示。PTY へ届くまでの作法（初期実装§18）はエージェント側の責任（§5-5）
    SendInput {
        card_id: CardId,
        text: String,
    },
    SetPermissionMode {
        card_id: CardId,
        mode: PermissionMode,
    },
    SetModel {
        card_id: CardId,
        model: ModelId,
    },
    Resize {
        card_id: CardId,
        cols: u16,
        rows: u16,
    },
    /// 画面の配信を始める（§7-4）。**中身の実装はフェーズ4**。
    SubScreen {
        card_id: CardId,
        cols: u16,
        rows: u16,
    },
    /// 画面の配信を止める。視聴者が居なくなったときだけ飛ぶ（§7-4）
    UnsubScreen {
        card_id: CardId,
    },
    /// 設定変更の即時反映（§13-3）。次の接続を待たせない
    SetIntervals {
        intervals: Intervals,
    },
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use crate::{Node, NodeId, ProjectId, ws::ParserState, ws::SelfhealPhase};

    fn roundtrip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let text = serde_json::to_string(value).expect("シリアライズできること");
        serde_json::from_str(&text).expect("デシリアライズできること")
    }

    fn sample_meta() -> SessionMeta {
        SessionMeta {
            card_id: CardId::new(),
            project: ProjectId("/home/example/dev/app".to_string()),
            claude_session_id: None,
            permission_mode: Some(PermissionMode::new("acceptEdits")),
            model: Some(ModelId::new("claude-opus-5")),
            model_label: Some("Opus 5".to_string()),
            model_requested: None,
            status: SessionStatus::Working,
            subagent_active: 0,
            last_activity_at: 1_700_000_000_000,
            last_assistant_message: None,
            created_at: 1_699_999_000_000,
            hooks_seen: true,
            agent_id: None,
            agent_connected: true,
            account: None,
            toml_account: None,
        }
    }

    #[test]
    fn agent_messageは全種が往復する() {
        let card_id = CardId::new();
        let all = vec![
            AgentMessage::Hello {
                protocol_version: A2S_VERSION,
                agent_version: "0.1.0".to_string(),
                agent_name: "仕事用ノート".to_string(),
                available_modes: vec![
                    PermissionMode::new("default"),
                    PermissionMode::new("acceptEdits"),
                ],
                always_bypass_permissions: false,
            },
            AgentMessage::SessionUpsert {
                session: Box::new(sample_meta()),
            },
            AgentMessage::SessionRemoved { card_id },
            AgentMessage::Status {
                card_id,
                status: SessionStatus::Ended { ok: true },
                subagent_active: 0,
                last_activity_at: 1_700_000_000_000,
            },
            AgentMessage::TranscriptBatch {
                batch_id: BatchId(7),
                card_id,
                nodes: vec![TreeNode {
                    id: NodeId("node-1".to_string()),
                    parent: None,
                    node: Node::AssistantText {
                        text: "了解しました".to_string(),
                    },
                    ts: 1_700_000_000_000,
                    branch: 0,
                }],
            },
            AgentMessage::TranscriptReset {
                batch_id: BatchId(8),
                card_id,
            },
            AgentMessage::ParserStatus {
                state: ParserState::Degraded,
                detail: Some("パーサが応答しません".to_string()),
            },
            AgentMessage::Selfheal {
                phase: SelfhealPhase::Swapped,
                detail: None,
            },
            AgentMessage::Error {
                card_id: Some(card_id),
                message: "切替中です".to_string(),
            },
            AgentMessage::ModelTable {
                cli_version: "2.1.220".to_string(),
                catalog: serde_json::json!([{ "id": "claude-opus-5", "label": "Opus 5" }]),
                aliases: serde_json::json!([{ "alias": "opus", "resolved": "claude-opus-5" }]),
            },
        ];
        for message in &all {
            assert_eq!(&roundtrip(message), message);
        }
    }

    #[test]
    fn server_to_agentは全種が往復する() {
        let card_id = CardId::new();
        let intervals = Intervals {
            sync_secs: 20,
            screen_ms: 20_000,
            scrollback_lines: 1000,
        };
        let all = vec![
            ServerToAgent::Hello {
                protocol_version: A2S_VERSION,
                server_version: "0.1.0".to_string(),
                agent_id: AgentId::new(),
                intervals,
            },
            ServerToAgent::BatchAck {
                batch_id: BatchId(7),
            },
            ServerToAgent::Spawn {
                cwd: "/home/example/dev/app".to_string(),
                permission_mode: None,
            },
            ServerToAgent::Kill { card_id },
            ServerToAgent::Archive { card_id },
            ServerToAgent::SendInput {
                card_id,
                text: "/rewind".to_string(),
            },
            ServerToAgent::SetPermissionMode {
                card_id,
                mode: PermissionMode::new("acceptEdits"),
            },
            ServerToAgent::SetModel {
                card_id,
                model: ModelId::new("opus"),
            },
            ServerToAgent::Resize {
                card_id,
                cols: 120,
                rows: 40,
            },
            ServerToAgent::SubScreen {
                card_id,
                cols: 120,
                rows: 40,
            },
            ServerToAgent::UnsubScreen { card_id },
            ServerToAgent::SetIntervals { intervals },
        ];
        for message in &all {
            assert_eq!(&roundtrip(message), message);
        }
    }

    #[test]
    fn 種別名はスネークケースのtフィールドで表現される() {
        // ブラウザ向け（`ws.rs`）と同じ作りにしてある。**同じ名前の別物**が両方に
        // 存在するので、線の上の形をここで固定しておかないと取り違えに気づけない
        let card_id = CardId::new();
        let text = serde_json::to_string(&AgentMessage::TranscriptReset {
            batch_id: BatchId(3),
            card_id,
        })
        .unwrap();
        assert_eq!(
            text,
            format!(r#"{{"t":"transcript_reset","batch_id":3,"card_id":"{card_id}"}}"#)
        );

        let text = serde_json::to_string(&ServerToAgent::BatchAck {
            batch_id: BatchId(3),
        })
        .unwrap();
        assert_eq!(text, r#"{"t":"batch_ack","batch_id":3}"#);
    }

    #[test]
    fn 知らない種別は受け取りを拒否する() {
        // 版交渉を通ったのに解釈できないものが来たなら、それは実装の食い違い。
        // 黙って無視すると「繋がっているのに何も起きない」になる
        assert!(serde_json::from_str::<AgentMessage>(r#"{"t":"未来の種別"}"#).is_err());
        assert!(serde_json::from_str::<ServerToAgent>(r#"{"t":"未来の種別"}"#).is_err());
    }

    #[test]
    fn モデルの表は解釈せずそのまま運ぶ() {
        // サーバが表の形を知らないままで済むことが、この設計の狙い（§13-4）。
        // 知らないキーが増えても落ちないことを固定する
        let message = AgentMessage::ModelTable {
            cli_version: "9.9.9".to_string(),
            catalog: serde_json::json!([{ "まだ無いキー": { "深い": [1, null] } }]),
            aliases: serde_json::json!({}),
        };
        assert_eq!(roundtrip(&message), message);
    }
}
