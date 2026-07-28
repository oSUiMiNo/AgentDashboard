//! core ⇔ transcript-parser のプロセス間通信（設計§8）。
//!
//! パーサは core の子プロセスとして動き、**stdin/stdout の JSON Lines** でやりとりする。
//! 1行1メッセージで、パーサのログは stderr にしか出さない。stdout に他のものが混ざると
//! core 側の行パースが壊れ、原因の分かりにくい沈黙になるため、この約束は守ること。
//!
//! # なぜ共有境界（このクレート）に置くのか
//!
//! 設計§2 が `crates/protocol` を「サーバ⇔フロント⇔**パーサ**共有のイベント型定義」と
//! 定めている。core 側に置くとパーサが core の依存を丸ごと引くことになり（依存の向きが逆）、
//! 「パーサだけを差し替える」という自己修復（設計§9）の前提が崩れる。
//!
//! この配置には「自己修復エージェントが IPC を変更できない」という帰結が伴うが、それは
//! **意図した制約**である。IPC は core と取り決めた契約であり、片側だけが勝手に変えたら
//! 噛み合わない相手と会話することになる。契約の変更は人間の作業（設計§14 引き継ぎ事項1）。
//!
//! # オフセットは core が持つ
//!
//! `watch` に再開位置を載せているのはそのため。パーサを再起動しても続きから読み直せるので、
//! 自己修復でパーサを差し替えてもイベントが欠落しない。
//!
//! # 1セッションは1ファイルではない
//!
//! 本体の `<sid>.jsonl` に加えて `<sid>/subagents/agent-*.jsonl` があり、しかも
//! どのサブエージェントが現れるかは読んでみるまで分からない。そのため再開位置は
//! **ファイルごとの表**（[`ParserCommand::Watch::from_offsets`]）で受け渡す。
//! 単一のオフセットにすると、再起動のたびにサブエージェントのファイルを先頭から
//! 読み直して同じノードが二重に届く。

use crate::{CardId, TreeNode};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// IPC の版。噛み合わないパーサを黙って使わないための照合値。
///
/// 自己修復（設計§9）が差し替えたバイナリが古い/新しい契約で喋っていた場合、
/// core はこれを見て縮退（`ParserStatus::Degraded`）に落とす。照合が無いと、
/// 噛み合わないバイナリが**静かに間違ったツリー**を作る — 目に見える縮退より悪い。
pub const PROTOCOL_VERSION: u32 = 1;

/// core → parser の指示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum ParserCommand {
    /// このセッションのトランスクリプト一式の監視を始める。
    ///
    /// ファイルがまだ存在しなくてもエラーにしない。JSONL はフックより遅れて現れる
    /// 結果整合のチャネルであり、「無い＝異常」ではない（フェーズ2で実測済み）。
    Watch {
        card_id: CardId,
        /// 本体トランスクリプト（`<sid>.jsonl`）の絶対パス。
        /// サブエージェントのファイルはここから導けるので、core は列挙しなくてよい
        path: String,
        /// ファイルの絶対パス → 次に読む位置。空なら全ファイルを先頭から
        from_offsets: BTreeMap<String, u64>,
    },
    /// 監視をやめる（カードを消したとき・セッションが終わったとき）。
    Unwatch { card_id: CardId },
    /// 過去の範囲をその場で読み直す（REST のページングの裏側）。
    ///
    /// core が持つ履歴は直近ウィンドウだけなので、それより古い範囲を要求されたら
    /// ここでオンデマンドに再パースする。巨大セッションでもメモリが破綻しない。
    ReadRange {
        /// 応答（[`ParserEvent::Range`]）と突き合わせるための番号。
        ///
        /// タブを2枚開いて両方が過去へ遡ると応答が交錯するので、番号が無いと
        /// どちらの要求に紐づくか決められない
        req_id: u64,
        card_id: CardId,
        /// 読む対象のファイルの絶対パス
        source: String,
        from_offset: u64,
        to_offset: u64,
    },
    /// 終了要求。読みかけを畳んでから終わる。
    Shutdown,
}

/// ノード1件と、それを生んだ JSONL 行の位置。
///
/// オフセットを添えるのは、`before=<node_id>` というページング要求を
/// 「ファイルのどこから読むか」へ変換できるようにするため。これが無いと
/// core は過去範囲の起点を決められない。
///
/// ブラウザへ送る [`TreeNode`] にはオフセットを載せない（表示に不要な内部事情のため）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedNode {
    pub node: TreeNode,
    /// このノードの由来となった行の開始バイト位置
    pub offset: u64,
}

/// parser → core の報告。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum ParserEvent {
    /// 起動が済み、指示を受け付けられる状態になった。
    ///
    /// 設計§8 の一覧には無いが、これが無いと「起動直後に落ちたパーサ」へ指示を
    /// 書き続けても気づけない。フェーズ1で `hello` を足したのと同じ理由。
    Hello {
        protocol_version: u32,
        /// パーサ自身の版（`CARGO_PKG_VERSION`）。縮退時の原因表示に使う
        parser_version: String,
    },
    /// 読んで組み立てたノード。
    ///
    /// **同じ [`crate::NodeId`] のノードは上書き（upsert）として扱う。**
    /// ツールコールは結果が届く前に発行され、後から結果入りで送り直されるため。
    /// 「結果が揃うまで出さない」方式にすると、長いコマンドの実行中はそのツールコールが
    /// 画面に一切出ず、「いま何をしているか分かる」という本ツールの目的を損なう。
    Nodes {
        card_id: CardId,
        /// このノード群を生んだファイルの絶対パス
        source: String,
        nodes: Vec<ParsedNode>,
        /// `source` を次に読むべき位置。core はこれを永続化して再開に使う
        next_offset: u64,
    },
    /// ファイルが巻き戻った（縮んだ・先頭が変わった）。
    ///
    /// 受け取った core は、そのカードの履歴を捨てて読み直す。`/rewind` 対策。
    Reset { card_id: CardId },
    /// [`ParserCommand::ReadRange`] への応答。
    Range { req_id: u64, nodes: Vec<ParsedNode> },
    /// パースの健康状態。自己修復（設計§9）の検知の入力になる。
    ///
    /// パーサは**観測値を単調増加のカウンタで返すだけ**にし、「率が閾値を超えたか」の
    /// 判定は core が行う。判定をパーサに持たせると、修復対象のコードが自分の
    /// 故障判定を持つことになる。
    Stats {
        card_id: CardId,
        /// 率の分母。設計§9 は率で判定するので必須
        records_total: u64,
        parse_errors: u64,
        /// 未知の type とその出現数。何に対応すべきかが修復セッションへの手掛かりになる
        unknown_types: BTreeMap<String, u64>,
        orphans: u64,
        /// 観測した `version` フィールドの集合。
        ///
        /// 1ファイル内に複数バージョンが混在しうる（compact / resume を跨ぐため）ので、
        /// 「ファイルの版が変わった」ではなく「新しい版を初観測した」がイベントになる
        versions: BTreeSet<String>,
    },
    /// 指示を処理できなかった。パーサは落ちずに報告だけする。
    Error {
        req_id: Option<u64>,
        card_id: Option<CardId>,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    // テスト名は日本語で書いている。英大文字が混ざると snake_case 判定に引っかかる
    // だけで実害はないため、このモジュールに限って許可する。
    #![allow(non_snake_case)]

    use super::*;
    use crate::{Node, NodeId};

    fn roundtrip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let text = serde_json::to_string(value).expect("シリアライズできること");
        serde_json::from_str(&text).expect("デシリアライズできること")
    }

    fn sample_node() -> ParsedNode {
        ParsedNode {
            node: TreeNode {
                id: NodeId("11111111-2222-3333-4444-555555555555".to_string()),
                parent: None,
                node: Node::UserMessage {
                    text: "テストを流して".to_string(),
                },
                ts: 1_700_000_000_000,
            },
            offset: 4096,
        }
    }

    #[test]
    fn parser_commandは全バリアントが往復する() {
        let card_id = CardId::new();
        let path = "/home/example/.claude/projects/p/s.jsonl".to_string();
        let all = vec![
            ParserCommand::Watch {
                card_id,
                path: path.clone(),
                from_offsets: BTreeMap::from([
                    (path.clone(), 1024),
                    (
                        "/home/example/.claude/projects/p/s/subagents/agent-a1.jsonl".to_string(),
                        512,
                    ),
                ]),
            },
            ParserCommand::Unwatch { card_id },
            ParserCommand::ReadRange {
                req_id: 7,
                card_id,
                source: path,
                from_offset: 0,
                to_offset: 4096,
            },
            ParserCommand::Shutdown,
        ];
        for command in &all {
            assert_eq!(&roundtrip(command), command);
        }
    }

    #[test]
    fn parser_eventは全バリアントが往復する() {
        let card_id = CardId::new();
        let all = vec![
            ParserEvent::Hello {
                protocol_version: PROTOCOL_VERSION,
                parser_version: "0.1.0".to_string(),
            },
            ParserEvent::Nodes {
                card_id,
                source: "/home/example/.claude/projects/p/s.jsonl".to_string(),
                nodes: vec![sample_node()],
                next_offset: 8192,
            },
            ParserEvent::Reset { card_id },
            ParserEvent::Range {
                req_id: 7,
                nodes: vec![sample_node()],
            },
            ParserEvent::Stats {
                card_id,
                records_total: 100,
                parse_errors: 1,
                unknown_types: BTreeMap::from([("brand-new-type".to_string(), 2)]),
                orphans: 3,
                versions: BTreeSet::from(["2.1.220".to_string()]),
            },
            ParserEvent::Error {
                req_id: Some(7),
                card_id: Some(card_id),
                message: "読めませんでした".to_string(),
            },
        ];
        for event in &all {
            assert_eq!(&roundtrip(event), event);
        }
    }

    #[test]
    fn 再開位置はファイルごとに持てる() {
        // 1セッション＝本体1本＋サブエージェントN本。単一のオフセットでは足りず、
        // 足りないまま再起動するとサブエージェント側が丸ごと二重に届く
        let main = "/p/s.jsonl".to_string();
        let sub = "/p/s/subagents/agent-a1.jsonl".to_string();
        let command = ParserCommand::Watch {
            card_id: CardId::new(),
            path: main.clone(),
            from_offsets: BTreeMap::from([(main.clone(), 10), (sub.clone(), 20)]),
        };
        match roundtrip(&command) {
            ParserCommand::Watch { from_offsets, .. } => {
                assert_eq!(from_offsets.get(&main), Some(&10));
                assert_eq!(from_offsets.get(&sub), Some(&20));
            }
            other => panic!("Watch 以外になった: {other:?}"),
        }
    }

    #[test]
    fn メッセージ1件は改行を含まない1行になる() {
        // JSON Lines なので、1メッセージが複数行になると受け手の行パースが壊れる
        let text = serde_json::to_string(&ParserEvent::Nodes {
            card_id: CardId::new(),
            source: "/p/s.jsonl".to_string(),
            nodes: vec![sample_node()],
            next_offset: 8192,
        })
        .unwrap();
        assert!(!text.contains('\n'), "改行が混ざっている: {text}");
    }

    #[test]
    fn 判別タグはcmdとevで分かれている() {
        // 同じ行フォーマットを双方向で使うため、取り違えたら型エラーになるように
        // タグ名自体を変えてある
        let command = serde_json::to_string(&ParserCommand::Shutdown).unwrap();
        assert_eq!(command, r#"{"cmd":"shutdown"}"#);

        let event = serde_json::to_string(&ParserEvent::Hello {
            protocol_version: 1,
            parser_version: "0.1.0".to_string(),
        })
        .unwrap();
        assert_eq!(
            event,
            r#"{"ev":"hello","protocol_version":1,"parser_version":"0.1.0"}"#
        );
    }
}
