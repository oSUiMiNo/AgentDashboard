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
    /// 送った画像（画像添付 設計§10-2）。
    ///
    /// **base64 は運ばない。** この段では媒体型しか分からず、**置き場所は相棒レコード
    /// が持っている**（§21 読み替え1）。結びつけるのはスレッディング層の仕事。
    Image {
        media_type: Option<String>,
    },
    /// スラッシュコマンドとして打たれた発言
    /// （`人が打っていないものを、人の発言として出さない` 設計§3）。
    ///
    /// **[`Block::UserText`] と分けてある。** `Image` / `ImageSource` の対と同じ形に
    /// することで、スレッディング層の `match` に**網羅を強制させる**——ここを増やしたら
    /// あちらが必ずコンパイルエラーになる。
    SlashCommand {
        /// 打ったままの形（`/名前` または `/名前 引数`）
        typed: String,
    },
    /// 相棒レコードが運ぶ置き場所（画像添付 設計§21 読み替え1）。
    ///
    /// 中身は `[Image: source: <絶対パス>]` の**パスだけ**を抜いたもの。
    /// **それ自体はノードにならず**、同じ `promptId` の本体の [`Block::Image`] へ合流する。
    ImageSource {
        path: String,
    },
}

/// 相棒レコードの text ブロックから、置き場所だけを抜く。
///
/// 綴りは `[Image: source: <絶対パス>]`（実測・claude 2.1.252）。**当たらなければ
/// `None`**——形が変わったときに、パスでない文字列を置き場所として拾わないため。
fn image_source(text: &str) -> Option<String> {
    let inner = text.trim().strip_prefix("[Image:")?.strip_suffix(']')?;
    let path = inner.trim().strip_prefix("source:")?.trim();
    if path.is_empty() {
        return None;
    }
    Some(path.to_string())
}

/// タグの中身を取り出す。無ければ `None`。
fn tag_body<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

/// タグを中身ごと取り除く（最初の1つだけ）。
fn strip_tag(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let Some(start) = text.find(&open) else {
        return text.to_string();
    };
    let Some(end) = text[start..].find(&close).map(|at| at + start + close.len()) else {
        return text.to_string();
    };
    format!("{}{}", &text[..start], &text[end..])
}

/// スラッシュコマンドの本体から、**打ったままの形**を組み立てる
/// （`人が打っていないものを、人の発言として出さない` 設計§4）。
///
/// 綴りは `<command-message>` ＋ `<command-name>` ＋（あれば）`<command-args>`。
/// 返すのは `/名前` または `/名前 引数` で、**生のタグは1文字も混ざらない**。
///
/// # 当たらなければ `None`
///
/// [`image_source`] と同じ倒れ方にしてある。**3つのタグ以外の字が残っていたら触らない**
/// ——CLI が綴りを変えたときに、コマンドでない文をコマンドとして出さないため。
/// 外れたときは生のテキストのまま出るので、**壊れるのではなく元に戻る**。
pub fn slash_command(text: &str) -> Option<String> {
    let name = tag_body(text, "command-name")?.trim();
    if !name.starts_with('/') || name.len() < 2 {
        return None;
    }
    // 知っているタグを全部落として、何も残らないときにだけ当てる
    let mut rest = text.to_string();
    for tag in ["command-message", "command-name", "command-args"] {
        rest = strip_tag(&rest, tag);
    }
    if !rest.trim().is_empty() {
        return None;
    }
    let args = tag_body(text, "command-args")
        .map(str::trim)
        .filter(|args| !args.is_empty());
    Some(match args {
        Some(args) => format!("{name} {args}"),
        None => name.to_string(),
    })
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
    let companion = record.is_turn_companion();

    match message.get("content") {
        // 最初のプロンプトは content が素の文字列で入る（実データで確認）。
        //
        // **相棒はここも通りうる。** 実測では相棒は配列で来るが、本体が文字列で来る形が
        // 現に在る以上、相棒だけは必ず配列だと決めてかかれない。ここで見分けを外すと
        // `[Image: source: /…]` が**利用者の発言として履歴に出る**——`is_turn_companion`
        // を足した理由そのものが破れる
        Some(Value::String(text)) if companion => image_source(text)
            .map(|path| vec![Block::ImageSource { path }])
            .unwrap_or_default(),
        Some(Value::String(text)) => vec![text_block(assistant, text)],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| block(assistant, companion, item))
            .collect(),
        _ => Vec::new(),
    }
}

fn text_block(assistant: bool, text: &str) -> Block {
    if assistant {
        return Block::AssistantText(text.to_string());
    }
    // **打った形が分かるなら、そちらを運ぶ。** 当たらなければ生のテキストのまま
    match slash_command(text) {
        Some(typed) => Block::SlashCommand { typed },
        None => Block::UserText(text.to_string()),
    }
}

fn block(assistant: bool, companion: bool, item: &Value) -> Option<Block> {
    let block_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    match block_type {
        "text" => {
            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
            // 相棒レコードの text は**発言ではなく置き場所**（§21 読み替え1）。
            // ここで見分けないと `[Image: source: …]` が発言として履歴に並ぶ
            if companion {
                return image_source(text).map(|path| Block::ImageSource { path });
            }
            Some(text_block(assistant, text))
        }
        // 送った画像。**中身（base64）は捨てる**——置き場所は相棒が持っている
        "image" => Some(Block::Image {
            media_type: item
                .get("source")
                .and_then(|source| source.get("media_type"))
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
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
