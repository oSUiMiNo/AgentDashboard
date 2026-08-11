//! 出力の整形（CLI設計§10）。**ここは全部、純関数**。
//!
//! 標準出力に書くのは呼び手（cli.rs）の仕事で、ここは文字列を組み立てるだけにする。
//! 印字とテストを分けるのは `transcript-parser` の `format_note` と同じ作法——
//! `println!` 自体はテストから捕まえられない。
//!
//! # 列揃えについて
//!
//! 表クレートは入れない（`logs.rs` の `{:<5}` と同じ流儀）。`format!` の幅指定は
//! 文字数で数えるので全角が混ざると少しずれるが、読めなくなるほどではなく、
//! 依存を増やす理由にならない。

use protocol::{SessionMeta, SessionStatus, TreeNode};

/// `--json` のときはサーバの応答を**そのまま**出す（CLI設計§10-2）。
///
/// CLI 側で作り直さない——整形したものを出すと、サーバの型が変わったときに
/// CLI が黙って古い形を出し続ける。
pub fn pick<'a>(json: bool, raw: &'a str, human: &'a str) -> &'a str {
    if json { raw } else { human }
}

/// ホームディレクトリを `~` へ畳む（CLI設計§10-1）。
pub fn fold_home(path: &str, home: Option<&str>) -> String {
    match home {
        Some(home) if !home.is_empty() => {
            if path == home {
                "~".to_string()
            } else if let Some(rest) = path.strip_prefix(home) {
                if rest.starts_with('/') {
                    format!("~{rest}")
                } else {
                    // `/home/user2` を `/home/user` の続きと読まないため、
                    // 区切りで切れていないものは畳まない
                    path.to_string()
                }
            } else {
                path.to_string()
            }
        }
        _ => path.to_string(),
    }
}

/// カードIDの表示は先頭8文字（CLI設計§10-1）。UUID はハイフン区切りの先頭ブロックが
/// ちょうど8文字なので、見た目も引きやすさも揃う
pub fn short_id(id: &str) -> &str {
    if id.len() > 8 { &id[..8] } else { id }
}

/// 前方一致の解決（CLI設計§10-1）。
///
/// 一意なら通し、複数に当たったら**候補を並べて断る**——黙って1つ目を選ぶと、
/// 消すつもりのなかったカードを操作する経路になる。
///
/// **空文字は候補が1件でも断る。** 空の前方一致は全部に当たるので、候補がたまたま
/// 1件のときだけ「一意に決まった」ことになってしまう——`session rm "$CARD"` の
/// 変数が空だったときに、唯一のカードが消える経路になる。
pub fn resolve_prefix<'a>(input: &str, ids: &[&'a str]) -> Result<&'a str, PrefixError> {
    if input.is_empty() {
        return Err(PrefixError::Empty);
    }
    // 完全一致が1件あるなら、それが答え（別のIDの接頭辞と重なっていても迷わない）
    if let Some(exact) = ids.iter().find(|id| **id == input) {
        return Ok(exact);
    }
    let hits: Vec<&str> = ids
        .iter()
        .copied()
        .filter(|id| id.starts_with(input))
        .collect();
    match hits.len() {
        0 => Err(PrefixError::NotFound),
        1 => Ok(hits[0]),
        _ => Err(PrefixError::Ambiguous(
            hits.into_iter().map(str::to_string).collect(),
        )),
    }
}

/// 前方一致が解けなかった理由。
#[derive(Debug, PartialEq, Eq)]
pub enum PrefixError {
    /// 空の ID を渡された。**引数の誤り**であって「見つからない」ではない
    Empty,
    NotFound,
    /// 複数に当たった。中身は当たった ID の全部
    Ambiguous(Vec<String>),
}

/// 状態の日本語ラベル。README の一覧画面の表と同じ語を使う——CLI にだけ別の言い方が
/// あると、画面と突き合わせて読む人が同じものを別物と受け取る。
pub fn status_label(status: &SessionStatus) -> &'static str {
    match status {
        SessionStatus::Starting => "起動中",
        SessionStatus::Working => "作業中",
        SessionStatus::WaitingPermission => "権限確認待ち",
        SessionStatus::WaitingInput => "入力待ち",
        SessionStatus::Stalled => "停滞",
        SessionStatus::Ended { ok: true } => "終了",
        SessionStatus::Ended { ok: false } => "異常終了",
        SessionStatus::Unknown => "不明",
    }
}

/// 「12秒前」の形（CLI設計§10-1）。一覧は現在との差しか使わないので、単位は粗くてよい。
pub fn format_ago(now_ms: i64, ts_ms: i64) -> String {
    let secs = (now_ms - ts_ms).max(0) / 1000;
    if secs < 60 {
        format!("{secs}秒前")
    } else if secs < 60 * 60 {
        format!("{}分前", secs / 60)
    } else if secs < 24 * 60 * 60 {
        format!("{}時間前", secs / 3600)
    } else {
        format!("{}日前", secs / 86_400)
    }
}

/// `session ls` の表。
pub fn render_sessions(sessions: &[SessionMeta], now_ms: i64, home: Option<&str>) -> String {
    if sessions.is_empty() {
        return "セッションはありません".to_string();
    }
    let mut out = String::new();
    out.push_str(&format!(
        "{:<9} {:<13} {:<9} {:<9} {:<7} {}\n",
        "CARD", "状態", "モデル", "最終活動", "PC", "PJT"
    ));
    for meta in sessions {
        let card = meta.card_id.to_string();
        let host = meta
            .agent_id
            .map(|id| short_id(&id.to_string()).to_string())
            .unwrap_or_else(|| "-".to_string());
        out.push_str(&format!(
            "{:<9} {:<13} {:<9} {:<9} {:<7} {}\n",
            short_id(&card),
            status_label(&meta.status),
            meta.model_label.as_deref().unwrap_or("-"),
            format_ago(now_ms, meta.last_activity_at),
            host,
            fold_home(&meta.project.0, home),
        ));
    }
    out.pop();
    out
}

/// `session show` の1件表示。表ではなく「欄: 値」の縦並び（欄が多いので）。
pub fn render_session_detail(meta: &SessionMeta, now_ms: i64, home: Option<&str>) -> String {
    let mut lines = vec![
        format!("カードID     : {}", meta.card_id),
        format!("PJT          : {}", fold_home(&meta.project.0, home)),
        format!("状態         : {}", status_label(&meta.status)),
        format!(
            "権限モード   : {}",
            meta.permission_mode
                .as_ref()
                .map(|mode| mode.0.as_str())
                .unwrap_or("-")
        ),
        format!(
            "モデル       : {}",
            meta.model_label.as_deref().unwrap_or("-")
        ),
        format!(
            "最終活動     : {}",
            format_ago(now_ms, meta.last_activity_at)
        ),
        format!("サブエージェント稼働: {}", meta.subagent_active),
        format!(
            "PC           : {}",
            meta.agent_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "-（この機械）".to_string())
        ),
    ];
    if let Some(message) = &meta.last_assistant_message {
        lines.push(format!("直前の応答   : {}", first_line(message, 120)));
    }
    lines.join("\n")
}

/// `session transcript` の1ノード1行。
pub fn render_transcript(nodes: &[TreeNode], has_more: bool) -> String {
    use protocol::Node;
    let mut out = String::new();
    if has_more {
        out.push_str("（この前にも履歴があります。--before <先頭のID> で遡れます）\n");
    }
    for node in nodes {
        let line = match &node.node {
            Node::UserMessage { text } => format!("👤 {}", first_line(text, 100)),
            Node::AssistantText { text } => format!("🤖 {}", first_line(text, 100)),
            Node::Thinking { text } => format!("💭 {}", first_line(text, 100)),
            Node::ToolCall { name, status, .. } => {
                format!("🔧 {name} [{status:?}]")
            }
            Node::Subagent { agent_type, .. } => format!("🧑‍🔧 サブエージェント: {agent_type}"),
            Node::Unknown { record_type, .. } => format!("？ 不明なイベント（{record_type}）"),
        };
        out.push_str(&format!("{}  {line}\n", node.id.0));
    }
    if out.is_empty() {
        return "履歴はまだありません".to_string();
    }
    out.pop();
    out
}

/// `project ls` の表。
pub fn render_projects(projects: &[protocol::ws::ProjectView], home: Option<&str>) -> String {
    if projects.is_empty() {
        return "PJT 枠はありません".to_string();
    }
    let mut out = String::new();
    out.push_str(&format!("{:<9} {:<7} {}\n", "ID", "PC", "パス"));
    for view in projects {
        let id = view.id.to_string();
        out.push_str(&format!(
            "{:<9} {:<7} {}\n",
            short_id(&id),
            view.host,
            fold_home(&view.path, home),
        ));
    }
    out.pop();
    out
}

/// `host dir` の一覧。フォルダが先・ファイルが後という並べ替えはしない——
/// サーバが返した順（読み比べる相手はブラウザの画面）をそのまま出す。
pub fn render_dir(listing: &protocol::fs::DirListing) -> String {
    use protocol::fs::EntryKind;
    let mut out = format!("{}\n", listing.path);
    for entry in &listing.entries {
        let kind = match entry.kind {
            EntryKind::Dir => "d",
            EntryKind::File => "-",
            EntryKind::Symlink => "l",
        };
        let mark = if entry.is_project { "  [PJT]" } else { "" };
        out.push_str(&format!("{kind} {}{mark}\n", entry.name));
    }
    if listing.truncated {
        out.push_str("（多すぎるので途中まで）\n");
    }
    out.pop();
    out
}

/// `version ls` の要約と表。
pub fn render_versions(view: &crate::versions_api::VersionsView) -> String {
    if !view.supported {
        return "この構成では版の保管庫を持てません（箱の中で動いている等。版は取ってきた側で決まります）"
            .to_string();
    }
    let mut out = String::new();
    out.push_str(&format!("稼働中の版 : {}\n", view.running.0));
    match &view.selected {
        Some(version) => out.push_str(&format!(
            "予約       : {}（次に起こしたときから効く）\n",
            version.0
        )),
        None => out.push_str("予約       : なし\n"),
    }
    if let Some(latest) = &view.latest {
        out.push_str(&format!("知っている最新: {}\n", latest.version.0));
    }
    if view.entries.is_empty() {
        out.push_str("手元に置いてある版はありません");
        return out;
    }
    out.push('\n');
    out.push_str(&format!(
        "{:<10} {:<6} {:<8} {:>8} {}\n",
        "VERSION", "印", "出どころ", "大きさ", "備考"
    ));
    for entry in &view.entries {
        let mark = if entry.running {
            "稼働中"
        } else if entry.selected {
            "予約"
        } else {
            ""
        };
        let origin = match entry.origin {
            protocol::VersionOrigin::Installed => "導入時",
            protocol::VersionOrigin::Stored => "保管庫",
        };
        let size = format!("{:.1}MB", entry.size_bytes as f64 / 1_048_576.0);
        let note = entry.reason.as_deref().unwrap_or("");
        out.push_str(&format!(
            "{:<10} {:<6} {:<8} {:>8} {}\n",
            entry.version.0, mark, origin, size, note
        ));
    }
    out.pop();
    out
}

/// 札の用途の日本語ラベル（CLI設計§5-3）。画面と同じ言い分けを使う。
pub fn kind_label(kind: &str) -> &str {
    match kind {
        "agent" => "PC",
        "cli" => "CLI",
        // 知らない用途は綴りのまま出す（将来の値を隠さない）
        other => other,
    }
}

/// `account tokens` の表。
pub fn render_tokens(tokens: &[server_core::account::TokenView], now_ms: i64) -> String {
    if tokens.is_empty() {
        return "札はありません".to_string();
    }
    let mut out = String::new();
    out.push_str(&format!(
        "{:<9} {:<5} {:<7} {:<12} {}\n",
        "TOKEN", "用途", "状態", "最終使用", "札"
    ));
    for view in tokens {
        let id = view.id.to_string();
        let state = if view.revoked_at.is_some() {
            "失効"
        } else {
            "有効"
        };
        let last_used = match view.last_used_at {
            Some(ts) => format_ago(now_ms, ts),
            None => "まだ".to_string(),
        };
        out.push_str(&format!(
            "{:<9} {:<5} {:<7} {:<12} {}\n",
            short_id(&id),
            kind_label(&view.kind),
            state,
            last_used,
            view.label,
        ));
    }
    out.pop();
    out
}

/// `account hosts` の表。
pub fn render_hosts(hosts: &[server_core::account::SessionHostView], now_ms: i64) -> String {
    if hosts.is_empty() {
        return "登録済みの PC はありません".to_string();
    }
    let mut out = String::new();
    out.push_str(&format!(
        "{:<9} {:<7} {:<12} {:<10} {}\n",
        "HOST", "接続", "最終確認", "版", "名前"
    ));
    for view in hosts {
        let id = view.id.to_string();
        let connected = if view.connected {
            "接続中"
        } else {
            "切断"
        };
        let last_seen = match view.last_seen_at {
            Some(ts) => format_ago(now_ms, ts),
            None => "-".to_string(),
        };
        out.push_str(&format!(
            "{:<9} {:<7} {:<12} {:<10} {}\n",
            short_id(&id),
            connected,
            last_seen,
            view.version.as_deref().unwrap_or("-"),
            view.name,
        ));
    }
    out.pop();
    out
}

/// 本文の1行目だけを、長すぎない形で。
fn first_line(text: &str, max_chars: usize) -> String {
    let line = text.lines().next().unwrap_or("");
    let mut taken: String = line.chars().take(max_chars).collect();
    if line.chars().count() > max_chars || text.lines().count() > 1 {
        taken.push('…');
    }
    taken
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- 出力の整形（テスト計画F2「出力の整形」） ---

    #[test]
    fn ホームディレクトリは波印へ畳まれる() {
        assert_eq!(
            fold_home("/home/user/Dev/App", Some("/home/user")),
            "~/Dev/App"
        );
        assert_eq!(fold_home("/home/user", Some("/home/user")), "~");
        // 区切りで切れていないものは別人のホームなので畳まない
        assert_eq!(
            fold_home("/home/user2/Dev", Some("/home/user")),
            "/home/user2/Dev"
        );
        assert_eq!(fold_home("/tmp/x", None), "/tmp/x");
    }

    #[test]
    fn カードの表示は先頭八文字になる() {
        assert_eq!(short_id("0198c0de-1111-2222-3333-444455556666"), "0198c0de");
        assert_eq!(short_id("abc"), "abc");
    }

    #[test]
    fn 前方一致が一意なら短い指定でも引ける() {
        let ids = ["0198c0de-1111", "77aa1122-2222"];
        assert_eq!(resolve_prefix("0198", &ids), Ok("0198c0de-1111"));
        assert_eq!(resolve_prefix("77aa1122-2222", &ids), Ok("77aa1122-2222"));
        assert_eq!(resolve_prefix("ffff", &ids), Err(PrefixError::NotFound));
    }

    #[test]
    fn 空の識別子は候補が1件でも断られる() {
        // 空の前方一致は全部に当たるので、候補が1件のときだけ「一意に決まった」形に
        // なってしまう——`session rm "$CARD"` の変数が空だと唯一のカードが消える
        let ids = ["0198c0de-1111"];
        assert_eq!(resolve_prefix("", &ids), Err(PrefixError::Empty));
        // 候補が複数でも「曖昧」ではなく「空」として断る（直し方が違う）
        let ids = ["0198c0de-1111", "77aa1122-2222"];
        assert_eq!(resolve_prefix("", &ids), Err(PrefixError::Empty));
    }

    #[test]
    fn 前方一致が複数に当たるときは候補を並べて断る() {
        // 黙って1つ目を選ぶと、消すつもりのなかったカードを操作する経路になる
        let ids = ["0198c0de-1111", "0198ffff-2222"];
        match resolve_prefix("0198", &ids) {
            Err(PrefixError::Ambiguous(hits)) => {
                assert_eq!(hits.len(), 2, "当たった全員が候補に載ること");
            }
            other => panic!("複数一致は断られるべき: {other:?}"),
        }
    }

    #[test]
    fn 機械向けの出力はサーバの応答そのままになる() {
        // CLI 側で作り直さない（CLI設計§10-2）。1バイトも変えないことが約束
        let raw = r#"[{"card_id":"x","unknown_field":1}]"#;
        assert_eq!(pick(true, raw, "整形済み"), raw);
        assert_eq!(pick(false, raw, "整形済み"), "整形済み");
    }

    #[test]
    fn 経過時間は単位を繰り上げて出る() {
        let now = 1_000_000_000;
        assert_eq!(format_ago(now, now - 12_000), "12秒前");
        assert_eq!(format_ago(now, now - 3 * 60_000), "3分前");
        assert_eq!(format_ago(now, now - 2 * 3_600_000), "2時間前");
        assert_eq!(format_ago(now, now - 30 * 86_400_000), "30日前");
        // 時計が僅かに前後しても負の値は出さない
        assert_eq!(format_ago(now, now + 5_000), "0秒前");
    }
}
