//! JSONL の1行を、絶対に失敗しない形で受け取る寛容パース（設計§8）。
//!
//! ここでの約束は1つだけ：**どんな入力でも [`Record`] を返し、行を捨てない**。
//! Claude Code のトランスクリプト形式は「バージョン間で変わりうる内部形式」とされており、
//! 知らない構造に出会うたびに止まる作りにすると、CLI が更新された翌日に構造化ビューが
//! 丸ごと死ぬ。知らないものは知らないまま運び、[`protocol::Node::Unknown`] へ落とす。

use serde_json::Value;

/// 表示対象のメッセージ種別。
const MESSAGE_TYPES: &[&str] = &["user", "assistant"];

/// 表示しないが、`uuid` を持つのでツリーの鎖に参加する種別。
///
/// **捨ててはいけない。** 実データでは `assistant` の `parentUuid` が `attachment` を
/// 指す例が多数あり（実測96件）、素通しで破棄すると以降の応答が丸ごと画面から消える。
const TRANSPARENT_TYPES: &[&str] = &["attachment", "system"];

/// `uuid` を持たず、ツリーにも置かないが、**読んだ値をセッションの属性として渡す**種別。
///
/// ツリーへの影響は [`Kind::Noise`] と同じで、違うのは「値をどこかへ渡すかどうか」だけ。
/// `ai-title` は CLI が付けたセッションの名前で、`--resume` の一覧に出るものにあたる。
///
/// **捨てる側に置いてはいけない。** 名前を運ぶ経路がこの1行しか無く、捨てると
/// 画面のいちばん下に出すものが無くなる（`一覧のカードのレイアウトを変える` 設計§2-1）。
const ATTRIBUTE_TYPES: &[&str] = &["ai-title"];

/// `uuid` を持たず、ツリーに置き場所が無い種別。
///
/// 履歴表示には寄与しないので数えるだけにする。root に積むと画面がノイズで埋まる。
const NOISE_TYPES: &[&str] = &[
    "queue-operation",
    "last-prompt",
    "mode",
    "permission-mode",
    "file-history-snapshot",
    // `file-history-snapshot` と対になる差分側。ファイルを1つ編集するたびに1件出る。
    // 対話モードでしか現れないため、ヘッドレスで採ったフィクスチャには入っていない
    "file-history-delta",
    "summary",
];

/// レコードの扱い方。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 表示するメッセージ
    Message,
    /// 表示しないが鎖には参加する（子の親を繋ぎ替える）
    Transparent,
    /// ノードは作らず鎖にも参加しないが、**値をセッションの属性として拾う**
    Attribute,
    /// 捨てる（数えるだけ）
    Noise,
    /// 知らない種別。`uuid` があればツリーに置き、無ければ合成IDで root へ
    Unknown,
}

pub fn classify(record_type: &str) -> Kind {
    if MESSAGE_TYPES.contains(&record_type) {
        Kind::Message
    } else if TRANSPARENT_TYPES.contains(&record_type) {
        Kind::Transparent
    } else if ATTRIBUTE_TYPES.contains(&record_type) {
        Kind::Attribute
    } else if NOISE_TYPES.contains(&record_type) {
        Kind::Noise
    } else {
        Kind::Unknown
    }
}

/// 1行から取り出した、スレッディングに必要な情報。
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    /// 元の行（JSON として読めなかった場合は文字列として保持する）
    pub raw: Value,
    pub record_type: String,
    pub uuid: Option<String>,
    pub parent_uuid: Option<String>,
    /// epoch ミリ秒。読めなければ `None`（呼び出し側が直前の値で補う）
    pub ts: Option<i64>,
    pub version: Option<String>,
    pub is_sidechain: bool,
    /// サブエージェントのファイルに入っている、そのエージェントの識別子
    pub agent_id: Option<String>,
    /// JSON として読めなかった
    pub broken: bool,
}

impl Record {
    pub fn kind(&self) -> Kind {
        if self.broken {
            Kind::Unknown
        } else {
            classify(&self.record_type)
        }
    }

    /// `message` オブジェクト（無ければ `None`）。
    pub fn message(&self) -> Option<&Value> {
        self.raw.get("message")
    }

    /// tool_result レコードが持つ、構造化された結果。
    ///
    /// **オブジェクトとは限らない。** ユーザがツールを拒否した場合は文字列になる実例がある。
    /// 型を仮定して取り出すとそこでパースが落ちるので、`Value` のまま扱う。
    pub fn tool_use_result(&self) -> Option<&Value> {
        self.raw.get("toolUseResult")
    }

    /// CLI が付けたセッションの名前（`ai-title` の行が持つ `aiTitle`）。
    ///
    /// **中身が無いときは `None` を返す。** 欄ごと無い・文字列でない・空白しか無い、の
    /// どれも「まだ名前が無い」と同じ扱いにする——**空の名前で上書きすると、いちど
    /// 付いた名前が消える**。値そのものは削らずに返す（切るのは画面の仕事）。
    pub fn ai_title(&self) -> Option<&str> {
        let title = self.raw.get("aiTitle")?.as_str()?;
        (!title.trim().is_empty()).then_some(title)
    }
}

/// 1行を [`Record`] にする。**失敗しない。**
pub fn parse_line(line: &str) -> Record {
    let Ok(raw) = serde_json::from_str::<Value>(line) else {
        return Record {
            raw: Value::String(truncate_text(line, MAX_RAW_TEXT)),
            record_type: String::new(),
            uuid: None,
            parent_uuid: None,
            ts: None,
            version: None,
            is_sidechain: false,
            agent_id: None,
            broken: true,
        };
    };

    let text = |key: &str| -> Option<String> {
        raw.get(key)
            .and_then(Value::as_str)
            .map(ToString::to_string)
    };

    Record {
        record_type: text("type").unwrap_or_default(),
        uuid: text("uuid"),
        parent_uuid: text("parentUuid"),
        ts: raw
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp),
        version: text("version"),
        is_sidechain: raw
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        agent_id: text("agentId"),
        broken: false,
        raw,
    }
}

/// 保持する生テキストの上限。1行で数MBのものが実在するため、壊れた行をそのまま
/// 抱え込まないようにする。
const MAX_RAW_TEXT: usize = 4096;

/// ISO8601（`2026-07-28T11:19:27.359Z`）を epoch ミリ秒へ。
pub fn parse_timestamp(text: &str) -> Option<i64> {
    time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|value| {
            let nanos = value.unix_timestamp_nanos();
            (nanos / 1_000_000) as i64
        })
}

/// 文字数ではなく**文字境界**で切る。UTF-8 の途中で切ると文字列が壊れる。
pub fn truncate_text(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…（{}バイトを省略）", &text[..end], text.len() - end)
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 表示種別と透過種別とノイズ種別を見分ける() {
        assert_eq!(classify("user"), Kind::Message);
        assert_eq!(classify("assistant"), Kind::Message);
        // 実データで親子の鎖に挟まることを確認済み。捨てるとツリーが切れる
        assert_eq!(classify("attachment"), Kind::Transparent);
        assert_eq!(classify("system"), Kind::Transparent);
        assert_eq!(classify("queue-operation"), Kind::Noise);
        // 捨てる側から**属性**へ移した。名前を運ぶ経路がこの1行しか無い
        assert_eq!(classify("ai-title"), Kind::Attribute);
        assert_eq!(classify("brand-new-type"), Kind::Unknown);
    }

    #[test]
    fn 題は中身が無ければ拾わない() {
        // **空の名前で上書きすると、いちど付いた名前が消える**（設計§2-1）
        let 題あり = parse_line(r#"{"type":"ai-title","aiTitle":"題"}"#);
        assert_eq!(題あり.ai_title(), Some("題"));

        for 中身が無い行 in [
            r#"{"type":"ai-title"}"#,
            r#"{"type":"ai-title","aiTitle":""}"#,
            r#"{"type":"ai-title","aiTitle":"   "}"#,
            r#"{"type":"ai-title","aiTitle":123}"#,
            r#"{"type":"ai-title","aiTitle":null}"#,
        ] {
            assert_eq!(
                parse_line(中身が無い行).ai_title(),
                None,
                "中身の無い題を拾っている: {中身が無い行}"
            );
        }
    }

    #[test]
    fn ファイル履歴の記録はノイズとして捨てる() {
        // 対話モードで実測したところ、ファイルを1つ編集するたびに delta が1件出る。
        // 取りこぼすと `uuid` を持たないので合成IDで root に積まれ、編集のたびに
        // 「不明なイベント」が履歴へ混ざる
        assert_eq!(classify("file-history-snapshot"), Kind::Noise);
        assert_eq!(classify("file-history-delta"), Kind::Noise);
    }

    #[test]
    fn 実データの外殻フィールドを取り出せる() {
        let line = r#"{"parentUuid":"p1","isSidechain":true,"type":"assistant",
            "uuid":"u1","timestamp":"2026-07-28T11:19:27.359Z","version":"2.1.220",
            "agentId":"a7b850ae4a93aeccd","message":{"role":"assistant"}}"#;
        let record = parse_line(&line.replace('\n', ""));
        assert!(!record.broken);
        assert_eq!(record.record_type, "assistant");
        assert_eq!(record.uuid.as_deref(), Some("u1"));
        assert_eq!(record.parent_uuid.as_deref(), Some("p1"));
        assert_eq!(record.version.as_deref(), Some("2.1.220"));
        assert_eq!(record.agent_id.as_deref(), Some("a7b850ae4a93aeccd"));
        assert!(record.is_sidechain);
        assert!(record.message().is_some());
    }

    #[test]
    fn 壊れた行でも落ちずに未知として扱う() {
        // フィクスチャには壊れた行がわざと残してある（そこで死なないことが検証対象）
        let record = parse_line("{壊れている");
        assert!(record.broken);
        assert_eq!(record.kind(), Kind::Unknown);
        assert!(record.uuid.is_none());
    }

    #[test]
    fn 空行もレコードとして返る() {
        let record = parse_line("");
        assert!(record.broken);
    }

    #[test]
    fn tool_use_resultは文字列でも取り出せる() {
        // 拒否されたツールは toolUseResult が文字列になる（実データで確認）
        let record = parse_line(r#"{"type":"user","toolUseResult":"Error: rejected"}"#);
        assert_eq!(
            record.tool_use_result().and_then(Value::as_str),
            Some("Error: rejected")
        );

        let record = parse_line(r#"{"type":"user","toolUseResult":{"stdout":"ok"}}"#);
        assert!(record.tool_use_result().unwrap().is_object());
    }

    #[test]
    fn タイムスタンプをエポックミリ秒に直す() {
        assert_eq!(parse_timestamp("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_timestamp("1970-01-01T00:00:01.500Z"), Some(1500));
        // 閏年をまたぐ日付（自前実装で間違えやすい箇所）
        assert_eq!(
            parse_timestamp("2024-03-01T00:00:00Z"),
            Some(1_709_251_200_000)
        );
        assert_eq!(parse_timestamp("だめな値"), None);
    }

    #[test]
    fn 切り詰めは文字境界を壊さない() {
        let text = "あいうえお".repeat(10);
        let cut = truncate_text(&text, 10);
        // 途中で切っても、結果が正しい UTF-8 であること（panic しないこと）が要点
        assert!(cut.starts_with("あいう"));
        assert!(cut.len() < text.len() + 64);

        let short = "短い";
        assert_eq!(truncate_text(short, 100), short);
    }
}
