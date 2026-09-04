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

/// `uuid` を持たず鎖にも参加しないが、**待ち行列の出入りとして行を作る**種別
/// （作業中に送った追加メッセージ 設計§2）。
///
/// 他の4本と違い、この種別は**あとから自分の行を書き換える**（読まれたら畳む）。
/// 単一ノードを消す経路は経路上のどこにも無いので、消すのではなく
/// 「行にしない」で畳む（設計§4）。
///
/// **捨てる側に置いてはいけない。** 送った追加メッセージが読まれるまでのあいだ、
/// 送った本人に手応えを返す経路がこの1行しか無い。
const QUEUE_TYPES: &[&str] = &["queue-operation"];

/// `uuid` を持たず、ツリーに置き場所が無い種別。
///
/// 履歴表示には寄与しないので数えるだけにする。root に積むと画面がノイズで埋まる。
const NOISE_TYPES: &[&str] = &[
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
    /// 鎖には参加しないが、**待ち行列の出入りとして行を作る**（設計§2-1）
    Queue,
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
    } else if QUEUE_TYPES.contains(&record_type) {
        Kind::Queue
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

    /// この行が**相棒レコード**か（画像添付 設計§21 読み替え1）。
    ///
    /// claude は画像付きのターンで `user` レコードを**2つ**書く。本体が
    /// `imagePasteIds` と `image` ブロックを持ち、相棒が `isMeta` ＋ `turnCompanion` で
    /// **画像1枚につき1ブロック**の `[Image: source: <絶対パス>]` を持つ。
    ///
    /// **相棒は履歴に出さない。** そのまま通すと `[Image: source: …]` という発言が
    /// 混ざって見える——あれは claude の内部の覚え書きであって、利用者が書いた文ではない。
    pub fn is_turn_companion(&self) -> bool {
        self.flag("isMeta") && self.flag("turnCompanion")
    }

    /// 本体と相棒を結ぶ鍵（画像添付 設計§21 読み替え1）。
    ///
    /// **`imagePasteIds` は鍵にしない。** あれは `[Image #N]` の表示番号で、
    /// **セッションを跨いで通し番号が続く**（実測：`[1]` / `[2]` / `[3..7]` / `[8..27]`）。
    /// 対応は本体と相棒の**並び**で取る。
    pub fn prompt_id(&self) -> Option<&str> {
        self.raw.get("promptId")?.as_str()
    }

    /// 真偽の欄を読む。**欄ごと無ければ `false`**。
    pub(crate) fn flag(&self, key: &str) -> bool {
        self.raw.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    /// 記録が名乗った出どころの種別（`origin.kind`）。
    ///
    /// **ここでは選り分けない。** 知っている値かどうかを判断するのは
    /// [`crate::origin`] の仕事で、この層は「その行に何と書いてあるか」だけを返す
    /// （`人が打っていないものを、人の発言として出さない` 設計§1-5）。
    pub fn origin_kind(&self) -> Option<&str> {
        self.raw.get("origin")?.get("kind")?.as_str()
    }

    /// 他セッションからの連絡に付く、送り主のセッション名（`origin.name`）。
    pub fn origin_name(&self) -> Option<&str> {
        self.raw.get("origin")?.get("name")?.as_str()
    }

    /// その指示がどこから来たか（`promptSource`）。実測で `typed` / `queued` /
    /// `system` / `sdk` の4つがある。
    ///
    /// **`origin` とは独立に入る。** スラッシュコマンドの本体は `origin.kind` を
    /// 持つがこちらを持たず、SDK 起動の指示文はこちらだけを持つ（設計§0-1）。
    pub fn prompt_source(&self) -> Option<&str> {
        self.raw.get("promptSource")?.as_str()
    }

    /// 差し込まれた文の印（`isMeta`）。
    ///
    /// **[`Record::is_turn_companion`] とは別物。** あちらは画像の相棒だけを指す
    /// 狭い判定（`isMeta` ＋ `turnCompanion`）で、こちらは印そのものを読む。
    pub fn is_meta(&self) -> bool {
        self.flag("isMeta")
    }

    /// 圧縮された要約の印（`isCompactSummary`）。
    pub fn is_compact_summary(&self) -> bool {
        self.flag("isCompactSummary")
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

    /// 待ち行列の出入りの種類（`enqueue` / `dequeue` / `remove` / `popAll`）。
    ///
    /// **知らない値もそのまま返す。** 選り分けるのは呼ぶ側の仕事で、ここでは判定しない
    /// ——`popAll` が分類表にもコメントにも無いまま実在していた（実測36件）ので、
    /// **5つ目は必ず来る**（設計§10）。
    pub fn queue_operation(&self) -> Option<&str> {
        self.raw.get("operation")?.as_str()
    }

    /// 待ち行列へ入った指示の本文。
    ///
    /// **`message` の中ではなくトップレベルにある。** `queue-operation` は `message` を
    /// 持たないので [`crate::normalize::blocks`] は通らない（あちらは `message` が無ければ
    /// 空を返す）。だからここで直に読む。
    ///
    /// 中身が無いときは `None`。`dequeue` は本文を持たない（実測 32,022件）。
    pub fn queue_content(&self) -> Option<&str> {
        let content = self.raw.get("content")?.as_str()?;
        (!content.is_empty()).then_some(content)
    }

    /// そのレコードが属するセッション。ノードIDの素材に使う（設計§3-2）。
    pub fn session_id(&self) -> Option<&str> {
        self.raw.get("sessionId")?.as_str()
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
        // 捨てる側から**行を作る側**へ移した。送った追加メッセージが読まれるまでの
        // あいだ、送った本人に手応えを返す経路がこの1行しか無い（設計§2-1）
        assert_eq!(classify("queue-operation"), Kind::Queue);
        // 捨てる側から**属性**へ移した。名前を運ぶ経路がこの1行しか無い
        assert_eq!(classify("ai-title"), Kind::Attribute);
        assert_eq!(classify("last-prompt"), Kind::Noise);
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
