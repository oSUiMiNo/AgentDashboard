//! レコードの中身を、表示に使う単位（[`Block`]）へ砕く層（設計§3/§8）。
//!
//! JSONL の1レコードは必ずしも1つの表示要素ではない。assistant のレコードは
//! `message.content[]` に「思考・本文・ツールコール」を並べて持つことがあり、
//! 並列ツールコールでは1レコードに複数の `tool_use` が入る。ここで砕いておくと、
//! スレッディング層は「ノードを並べる」ことだけに集中できる。

use crate::parse::{Record, truncate_text};
use serde_json::{Value, json};

/// 表示単位。
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    UserText(String),
    AssistantText(String),
    Thinking(String),
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    /// ツールの結果。それ自体はノードにならず、対応する [`Block::ToolUse`] へ合流する。
    ToolResult {
        tool_use_id: String,
        content: Value,
        is_error: bool,
    },
}

/// ブラウザへ運ぶ値の上限。
///
/// Edit の `originalFile` は数MBになりうるが、それを画面まで運ぶ意味は無い。
/// WebSocket の送信キューはクライアントあたり64本しかないので、巨大な値を1つ流すだけで
/// 詰まる。切るのは**パーサ側**が正しい（core も web も、来なかったものは扱わずに済む）。
pub const MAX_VALUE_BYTES: usize = 256 * 1024;

/// レコードを表示単位へ砕く。
pub fn blocks(record: &Record) -> Vec<Block> {
    let Some(message) = record.message() else {
        return Vec::new();
    };
    let assistant = record.record_type == "assistant";

    match message.get("content") {
        // 最初のプロンプトは content が素の文字列で入る（実データで確認）
        Some(Value::String(text)) => vec![text_block(assistant, text)],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| block(assistant, item))
            .collect(),
        _ => Vec::new(),
    }
}

fn text_block(assistant: bool, text: &str) -> Block {
    if assistant {
        Block::AssistantText(text.to_string())
    } else {
        Block::UserText(text.to_string())
    }
}

fn block(assistant: bool, item: &Value) -> Option<Block> {
    let block_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    match block_type {
        "text" => {
            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
            Some(text_block(assistant, text))
        }
        "thinking" => {
            let text = item
                .get("thinking")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some(Block::Thinking(text.to_string()))
        }
        "tool_use" => Some(Block::ToolUse {
            id: item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            name: item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            input: truncate_value(item.get("input").unwrap_or(&Value::Null)),
        }),
        "tool_result" => Some(Block::ToolResult {
            tool_use_id: item
                .get("tool_use_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            content: truncate_value(item.get("content").unwrap_or(&Value::Null)),
            is_error: item
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        // 知らないブロック種別は落とす。レコード自体は残るので情報は消えない
        _ => None,
    }
}

/// 大きすぎる値を、形だけ残して畳む。
pub fn truncate_value(value: &Value) -> Value {
    let text = value.to_string();
    if text.len() <= MAX_VALUE_BYTES {
        return value.clone();
    }
    json!({
        "__truncated": true,
        "bytes": text.len(),
        "preview": truncate_text(&text, 1024),
    })
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use crate::parse::parse_line;

    #[test]
    fn 最初のプロンプトはcontentが素の文字列で入る() {
        let record =
            parse_line(r#"{"type":"user","message":{"role":"user","content":"テストを流して"}}"#);
        assert_eq!(
            blocks(&record),
            vec![Block::UserText("テストを流して".to_string())]
        );
    }

    #[test]
    fn assistantの思考と本文とツールコールを砕ける() {
        let record = parse_line(
            r#"{"type":"assistant","message":{"role":"assistant","content":[
                {"type":"thinking","thinking":"まず失敗を見る","signature":"x"},
                {"type":"text","text":"確認します"},
                {"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}
            ]}}"#,
        );
        assert_eq!(
            blocks(&record),
            vec![
                Block::Thinking("まず失敗を見る".to_string()),
                Block::AssistantText("確認します".to_string()),
                Block::ToolUse {
                    id: "toolu_1".to_string(),
                    name: "Bash".to_string(),
                    input: serde_json::json!({"command": "ls"}),
                },
            ]
        );
    }

    #[test]
    fn 並列ツールコールは1レコードから複数のブロックになる() {
        // ここを1レコード＝1ノードで実装すると、並列実行が片方しか見えなくなる
        let record = parse_line(
            r#"{"type":"assistant","message":{"content":[
                {"type":"tool_use","id":"a","name":"Read","input":{}},
                {"type":"tool_use","id":"b","name":"Read","input":{}}
            ]}}"#,
        );
        assert_eq!(blocks(&record).len(), 2);
    }

    #[test]
    fn tool_resultを取り出せる() {
        let record = parse_line(
            r#"{"type":"user","message":{"content":[
                {"tool_use_id":"toolu_1","type":"tool_result","content":"ok","is_error":false}
            ]}}"#,
        );
        assert_eq!(
            blocks(&record),
            vec![Block::ToolResult {
                tool_use_id: "toolu_1".to_string(),
                content: Value::String("ok".to_string()),
                is_error: false,
            }]
        );
    }

    #[test]
    fn 知らないブロック種別は落とすがレコードは壊れない() {
        let record = parse_line(
            r#"{"type":"assistant","message":{"content":[
                {"type":"brand_new_block","payload":1},
                {"type":"text","text":"生き残る"}
            ]}}"#,
        );
        assert_eq!(
            blocks(&record),
            vec![Block::AssistantText("生き残る".to_string())]
        );
    }

    #[test]
    fn 巨大な値は形だけ残して畳む() {
        let big = Value::String("x".repeat(MAX_VALUE_BYTES + 1));
        let cut = truncate_value(&big);
        assert_eq!(cut.get("__truncated"), Some(&Value::Bool(true)));
        assert!(cut.get("bytes").unwrap().as_u64().unwrap() > MAX_VALUE_BYTES as u64);
        assert!(cut.to_string().len() < 4096);

        let small = serde_json::json!({"command": "ls"});
        assert_eq!(truncate_value(&small), small);
    }

    #[test]
    fn messageが無いレコードはブロックを持たない() {
        let record = parse_line(r#"{"type":"attachment","uuid":"u1"}"#);
        assert!(blocks(&record).is_empty());
    }
}
