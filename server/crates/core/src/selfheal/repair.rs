//! 修復セッションへの指示と、その結果の受け取り方（設計§9-4/§9-5）。
//!
//! ここに置いてあるのは**文字列を組み立てる純粋関数と、変更範囲の検査**だけ。
//! セッションの起動そのものは [`super::run_cycle`] が行う。
//!
//! # 言葉で縛らず、機械で見る
//!
//! プロンプトには「変更してよいのはパーサだけ」と書くが、それだけでは担保にならない。
//! 修復セッションは権限確認を出さない設定で無人実行するので、**触った範囲は
//! こちらで確かめる**（[`scope_violations`]）。書いてある約束と、機械で見る約束の
//! 両方を持つのが要点。

/// 修復セッションが触ってよい範囲（リポジトリ相対の接頭辞）。
///
/// - パーサ本体 … 直す対象そのもの
/// - フィクスチャ … カナリアが採ったサンプルの追加と、再現用データの追加を許す
///
/// `crates/protocol` を含めないのは意図した制約。IPC は core と取り決めた契約で、
/// 片側だけが勝手に変えたら噛み合わない相手と会話することになる（設計§15）。
pub const ALLOWED_PREFIXES: &[&str] = &["server/crates/transcript-parser/", "fixtures/"];

/// 修復セッションへ渡す材料。
pub struct RepairContext<'a> {
    /// なぜ修復が要るのか（検知の理由）
    pub reason: &'a str,
    /// 落ちているゲートの出力
    pub gate_output: &'a str,
    /// 何回目の挑戦か（1から）
    pub attempt: u32,
    pub retry_limit: u32,
}

/// ゲートの出力のうち、プロンプトへ載せる長さ。
///
/// 全部載せると、本題（どこが壊れているか）が流れてしまう。テストの出力は末尾に
/// 失敗の要約が来るので、**末尾側**を残す。
const GATE_EXCERPT: usize = 4_000;

/// 修復セッションへ最初に送る指示を組み立てる。
pub fn repair_prompt(context: &RepairContext) -> String {
    let excerpt = tail(context.gate_output, GATE_EXCERPT);
    let RepairContext {
        reason,
        attempt,
        retry_limit,
        ..
    } = context;

    format!(
        "あなたは AgentDashboard の transcript-parser を修復する担当です。\
        この作業ディレクトリは修復専用の git worktree で、本体の作業ツリーではありません。\n\
        \n\
        ## 何が起きているか\n\
        {reason}\n\
        \n\
        Claude Code のトランスクリプト（JSONL）の形式が変わり、パーサが追随できていません。\n\
        \n\
        ## 落ちているテストの出力（末尾）\n\
        ```\n\
        {excerpt}\n\
        ```\n\
        \n\
        ## やること\n\
        1. `server/crates/transcript-parser` を直し、上のテストを通してください\n\
        2. テストは `./scripts/cargo nextest run -p transcript-parser` で実行します\
        （cargo は Docker の中にあるので、このラッパー以外から呼ばないでください）\n\
        3. 既存のフィクスチャ（過去バージョンの実トランスクリプト）を1つも壊さないこと。\
        新しい形式に対応しつつ、古い形式も読めるようにしてください\n\
        \n\
        ## 守ること\n\
        - **変更してよいのは `server/crates/transcript-parser/` と `fixtures/` だけ**です。\
        ほかを変更した場合、テストの結果によらず不合格になります\n\
        - `server/crates/protocol` は変更禁止です。core との取り決めなので、\
        片側だけ変えると噛み合わなくなります。**知らない構造は Unknown ノードへ写像**してください\n\
        - 完了条件は「テストが全部通ること」です。通ったら、何を直したのかを1〜2行で報告して\
        ターンを終えてください。コミットはこちらで行うので不要です\n\
        \n\
        （挑戦 {attempt}/{retry_limit} 回目）"
    )
}

/// 再試行のときに送る指示。
///
/// 1回目の材料をもう一度送らないのは、同じ会話の続きだから。**今回何が落ちたか**だけを
/// 渡すほうが、直すべき場所に集中できる。
pub fn retry_prompt(gate_output: &str, attempt: u32, retry_limit: u32) -> String {
    format!(
        "テストはまだ通っていません。出力の末尾は次のとおりです。\n\
        ```\n\
        {}\n\
        ```\n\
        変更してよい範囲（`server/crates/transcript-parser/` と `fixtures/`）は同じです。\
        続けて直してください。（挑戦 {attempt}/{retry_limit} 回目）",
        tail(gate_output, GATE_EXCERPT)
    )
}

/// 範囲外を触っていないか確かめる。触っていたらその一覧を返す。
pub fn scope_violations(changed: &[String]) -> Vec<String> {
    changed
        .iter()
        .filter(|path| {
            !ALLOWED_PREFIXES
                .iter()
                .any(|prefix| path.starts_with(prefix))
        })
        .cloned()
        .collect()
}

/// 文字列の末尾を、文字境界を壊さずに切り出す。
fn tail(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut start = text.len() - limit;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn プロンプトに材料と制約が入る() {
        let prompt = repair_prompt(&RepairContext {
            reason: "知らない Claude Code の版を見つけました: 2.1.221",
            gate_output: "test 表示対象外のレコード ... FAILED",
            attempt: 1,
            retry_limit: 3,
        });

        assert!(prompt.contains("2.1.221"), "検知の理由が入っていない");
        assert!(prompt.contains("FAILED"), "テストの出力が入っていない");
        assert!(
            prompt.contains("scripts/cargo"),
            "cargo の呼び方が入っていない"
        );
        assert!(prompt.contains("protocol"), "変更禁止の範囲が入っていない");
        assert!(prompt.contains("Unknown"), "未知構造の扱いが入っていない");
        assert!(prompt.contains("1/3"), "何回目かが入っていない");
    }

    #[test]
    fn 長すぎるテスト出力は末尾だけ載せる() {
        // 先頭を残すと、失敗の要約（末尾にある）が落ちる
        let long = format!("{}最後の失敗", "あ".repeat(10_000));
        let prompt = repair_prompt(&RepairContext {
            reason: "理由",
            gate_output: &long,
            attempt: 1,
            retry_limit: 3,
        });

        assert!(prompt.contains("最後の失敗"));
        assert!(prompt.len() < long.len(), "そのまま全部載せている");
    }

    #[test]
    fn 許された範囲だけなら違反は無い() {
        let changed = vec![
            "server/crates/transcript-parser/src/thread.rs".to_string(),
            "fixtures/v2.1.221/canary/session.jsonl".to_string(),
        ];
        assert!(scope_violations(&changed).is_empty());
    }

    #[test]
    fn 範囲外を触っていたら名指しできる() {
        // 権限確認を出さない設定で無人実行するので、ここは言葉ではなく機械で見る
        let changed = vec![
            "server/crates/transcript-parser/src/parse.rs".to_string(),
            "server/crates/protocol/src/ipc.rs".to_string(),
            "Makefile".to_string(),
        ];

        let violations = scope_violations(&changed);

        assert_eq!(
            violations,
            ["server/crates/protocol/src/ipc.rs", "Makefile"]
        );
    }

    #[test]
    fn 似た名前のディレクトリを通してしまわない() {
        let changed = vec!["server/crates/transcript-parser-extra/src/lib.rs".to_string()];
        assert!(
            !scope_violations(&changed).is_empty(),
            "区切りまで見ないと、隣のクレートまで許してしまう"
        );
    }
}
