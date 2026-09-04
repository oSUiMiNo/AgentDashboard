//! その発言を**誰が入れたか**を決める層
//! （`人が打っていないものを、人の発言として出さない` 設計§1）。
//!
//! # なぜ [`crate::parse`] に置かないのか
//!
//! あちらは「その行に何と書いてあるか」を薄く読み取る層で、既存のメソッドはどれも
//! 1つの欄を返すだけである。**こちらは4つの欄と優先順位と倒れ方を持つ「方針」**で、
//! しかも戻り値が共有境界の型（[`MessageOrigin`]）になる。混ぜると層の役割が2つになる。
//!
//! # 判定の根拠（実測）
//!
//! 利用者の記録（`~/.claude/projects/` 配下）を全件数えた分布。**この表が、下の順序を
//! 決めた根拠そのものである。**
//!
//! | `promptSource` | `origin.kind` | `isMeta` | 中身 | 件数 |
//! |---|---|---|---|---|
//! | `sdk` | — | — | SDK 起動の指示文（中央値5000字・最大11万字） | 最大の塊 |
//! | — | — | — | 中断マーカー・**印の無いコマンド外皮**・古い記録 | 多数 |
//! | — | — | `true` | フック注入・コマンドの展開後 | 多数 |
//! | `typed` | `human` | — | 人が打った | 多数 |
//! | `system` | `task-notification` | — | サブエージェントの完了通知 | 多数 |
//! | `sdk` | `task-notification` | — | **表に無い組み合わせ**（`origin` が勝つ） | 中 |
//! | — | `human` | — | **スラッシュコマンドの本体** | 中 |
//! | `system` | `peer` | `true` | 他セッションからの連絡 | 中 |
//! | `queued` | `human` | — | 順番待ちから読まれた | 中 |
//! | — | — | — | `coordinator` / `unclassified` を名乗るもの | 少 |
//!
//! **`origin` は `promptSource` に優先する。** `sdk` ＋ `task-notification` が実在する
//! ので、`promptSource` を先に見ると完了通知が「起動時の指示」に化ける。

use crate::parse::Record;
use protocol::MessageOrigin;
use serde_json::Value;

/// 人が止めたことを表す定型文（実測で2種類）。
///
/// **完全一致でしか見ない。** 「含む」で判定すると、利用者が同じ文を引用しただけで
/// 機械側へ落ちる（設計§1-4）。**綴りが変わったら人の側へ倒れる**——安全側である。
const INTERRUPTION_MARKERS: &[&str] = &[
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
];

/// この発言を誰が入れたか（設計§1-1）。
///
/// **上から順に見て、最初に当たったところで決まる。** 人の印がいちばん上にあるのが
/// 要点で、**下に何を足しても人の判定は動かない。**
///
/// # 印が1つも無いものを機械にしない
///
/// 最後の [`MessageOrigin::Unmarked`] は**人の側**である（設計§1-3）。要件が
/// 「`origin` を推測で補わない。欄が無ければ人として出す」と明示しているうえ、
/// 機械側へ倒すと**人が打った `/clear` `/model` が琥珀になる**（引数を持たない
/// 組み込みコマンドには印が1つも付かない）。
pub fn message_origin(record: &Record) -> MessageOrigin {
    // #1〜#4：記録が名乗っていれば、それが最優先。`promptSource` は見ない
    // ——スラッシュコマンドの本体は `origin.kind` を持つが `promptSource` を持たない
    if let Some(kind) = record.origin_kind() {
        return match kind {
            "human" => MessageOrigin::Human,
            "peer" => MessageOrigin::Peer {
                name: record.origin_name().map(str::to_string),
            },
            "task-notification" => MessageOrigin::TaskNotification,
            // 知らない名前は**名前のまま運ぶ**（設計§2-3）
            other => MessageOrigin::Other {
                name: other.to_string(),
            },
        };
    }

    // #5〜#7：名乗りが無いときだけ、どこから来たかを見る
    match record.prompt_source() {
        Some("typed" | "queued") => return MessageOrigin::Human,
        Some("sdk") => return MessageOrigin::Sdk,
        Some("system") => return MessageOrigin::Injected,
        _ => {}
    }

    // #8〜#10：印で分かるもの
    if record.is_compact_summary() {
        return MessageOrigin::CompactSummary;
    }
    if record.is_meta() {
        return MessageOrigin::Injected;
    }
    if record.is_sidechain {
        return MessageOrigin::SubagentPrompt;
    }

    // #11：欄を1つも持たないので、本文の定型文で見分けるしかない
    if is_interruption(record) {
        return MessageOrigin::Interrupted;
    }

    // #12：どれにも当たらない。**人として出す**（安全側）
    MessageOrigin::Unmarked
}

/// 本文が中断の定型文そのものか。
///
/// `message.content` は素の文字列と配列の両方の形で来る。**どちらの形でも、
/// 中身が定型文1つだけのときにしか当てない。**
fn is_interruption(record: &Record) -> bool {
    let Some(text) = sole_text(record) else {
        return false;
    };
    INTERRUPTION_MARKERS.contains(&text)
}

/// `message.content` が**ただ1つの文**であるとき、その中身。
///
/// 複数のブロックを持つものは対象外にする——中断の印は単独で書かれるので、
/// 他のものと混ざっている時点で別物である。
fn sole_text(record: &Record) -> Option<&str> {
    let content = record.message()?.get("content")?;
    match content {
        Value::String(text) => Some(text.as_str()),
        Value::Array(items) => match items.as_slice() {
            [only] => only.get("text")?.as_str(),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse_line;

    fn 判定(line: &str) -> MessageOrigin {
        message_origin(&parse_line(line))
    }

    /// 素の発言を1行つくる。`extra` はトップレベルへ足す欄。
    fn 発言(extra: &str, text: &str) -> String {
        let head = if extra.is_empty() {
            String::new()
        } else {
            format!("{extra},")
        };
        format!(
            r#"{{"type":"user","uuid":"u1",{head}"message":{{"role":"user","content":{}}}}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    #[test]
    fn 人の印があるものは人() {
        assert_eq!(判定(&発言(r#""origin":{"kind":"human"}"#, "やって")), MessageOrigin::Human);
    }

    #[test]
    fn 他セッションからの連絡は送り主の名前を持つ() {
        let line = 発言(
            r#""origin":{"kind":"peer","name":"sample-peer-session"},"promptSource":"system","isMeta":true"#,
            "連絡です",
        );
        assert_eq!(
            判定(&line),
            MessageOrigin::Peer {
                name: Some("sample-peer-session".to_string())
            }
        );
    }

    #[test]
    fn サブエージェントの報告は完了通知() {
        let line = 発言(
            r#""origin":{"kind":"task-notification"},"promptSource":"system""#,
            "終わりました",
        );
        assert_eq!(判定(&line), MessageOrigin::TaskNotification);
    }

    #[test]
    fn 知らない名乗りは名前のまま運ぶ() {
        // 実測で `coordinator` と `unclassified` がある。丸めると記録が名乗ったことを捨てる
        assert_eq!(
            判定(&発言(r#""origin":{"kind":"coordinator"}"#, "調整")),
            MessageOrigin::Other {
                name: "coordinator".to_string()
            }
        );
    }

    #[test]
    fn 打った指示は人() {
        assert_eq!(判定(&発言(r#""promptSource":"typed""#, "やって")), MessageOrigin::Human);
        assert_eq!(判定(&発言(r#""promptSource":"queued""#, "やって")), MessageOrigin::Human);
    }

    #[test]
    fn sdkが渡した指示は機械() {
        assert_eq!(判定(&発言(r#""promptSource":"sdk""#, "長い指示")), MessageOrigin::Sdk);
    }

    #[test]
    fn systemが差し込んだ文は機械() {
        assert_eq!(判定(&発言(r#""promptSource":"system""#, "通知")), MessageOrigin::Injected);
    }

    #[test]
    fn 圧縮された要約は機械() {
        assert_eq!(
            判定(&発言(r#""isCompactSummary":true"#, "要約")),
            MessageOrigin::CompactSummary
        );
    }

    #[test]
    fn フックが差し込んだ文は機械() {
        assert_eq!(判定(&発言(r#""isMeta":true"#, "注入")), MessageOrigin::Injected);
    }

    #[test]
    fn サブエージェントへの指示は機械() {
        assert_eq!(
            判定(&発言(r#""isSidechain":true"#, "調べて")),
            MessageOrigin::SubagentPrompt
        );
    }

    #[test]
    fn 中断の定型文は機械() {
        for marker in INTERRUPTION_MARKERS {
            assert_eq!(判定(&発言("", marker)), MessageOrigin::Interrupted, "{marker}");
        }
        // 配列の形でも同じ
        let line = r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#;
        assert_eq!(判定(line), MessageOrigin::Interrupted);
    }

    #[test]
    fn 印が1つも無いものは人() {
        // **ここに人が打った `/clear` `/model` が来る**（設計§1-3）
        assert_eq!(判定(&発言("", "/clear")), MessageOrigin::Unmarked);
        assert!(判定(&発言("", "/clear")).is_human());
    }

    #[test]
    fn 人の印はサイドチェーンより強い() {
        // 順序の門。#1 が #10 より上にあることを固定する
        let line = 発言(r#""origin":{"kind":"human"},"isSidechain":true"#, "やって");
        assert_eq!(判定(&line), MessageOrigin::Human);
    }

    #[test]
    fn 名乗りはpromptsourceより強い() {
        // `sdk` ＋ `task-notification` が実在する。逆にすると完了通知が化ける
        let line = 発言(
            r#""origin":{"kind":"task-notification"},"promptSource":"sdk""#,
            "終わりました",
        );
        assert_eq!(判定(&line), MessageOrigin::TaskNotification);
    }

    // ここから3本は、要件の最優先事項（人を機械側へ落とさない）を直に守る門である

    #[test]
    fn スラッシュコマンドの本体は人側に残る() {
        // **本体は `origin.kind` を持つが `promptSource` を持たない。** AND で書くと
        // 打ったコマンドが1件残らず機械側へ落ちる（設計§1-2）
        let line = 発言(
            r#""origin":{"kind":"human"}"#,
            "<command-message>pjt_read</command-message>\n<command-name>/pjt_read</command-name>",
        );
        assert_eq!(判定(&line), MessageOrigin::Human);
        assert!(判定(&line).is_human());
    }

    #[test]
    fn 印が1つも無い記録は人側に残る() {
        // 印の無いものを機械へ倒すと、既存の合成フィクスチャの発言も全部琥珀になる
        assert!(判定(&発言("", "ふつうの指示")).is_human());
    }

    #[test]
    fn 中断の綴りが変わったら人側へ倒れる() {
        // 文字列で見分ける判定は必ず外れる。**外れたときに安全側であること**を固定する
        assert!(
            判定(&発言("", "[Request interrupted by the user]")).is_human(),
            "知らない綴りは人として出す"
        );
        assert!(
            判定(&発言("", "「[Request interrupted by user]」と出た")).is_human(),
            "引用しただけの文を機械にしない（部分一致にしない）"
        );
    }
}
