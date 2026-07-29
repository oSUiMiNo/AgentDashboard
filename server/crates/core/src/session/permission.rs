//! 権限モードの表と、端末フッタからの読み取り（設計§3・§5・§11）。
//!
//! # モードは3つの供給元から来る
//!
//! | 供給元 | いつ効くか |
//! |---|---|
//! | 起動引数（`--permission-mode`） | 起動した瞬間の初期値。**当てにはしない** |
//! | フックの `permission_mode` | 1ターン目以降。CLI 側の申告なので最も確か |
//! | 端末フッタ（`⏵⏵ accept edits on` 等） | 常時。起動直後と切替直後を埋める |
//!
//! フッタの読み取りが要るのは、実測で次の2つが分かったため（設計§11）。
//!
//! - **`SessionStart` フックは `permission_mode` を運ばない**ので、起動直後は分からない
//! - **モードを切り替えてもフックは1件も発火しない**ので、Shift+Tab の結果を確かめられない
//!
//! # 綴りが2つある
//!
//! 「毎回確認する」モードは、CLI の `--permission-mode` では `manual`、フックと設定では
//! `default`。**運ぶ値は正規値（`default`）へ寄せ、CLI へ渡すときだけ表で引き直す。**
//! 混ざると「起動したモードと違うモードへ変わった」ように見える。

use protocol::PermissionMode;
use std::process::Command;

/// 既知のモード1件。
///
/// **表に無い値でも動く**ことが前提なので、この表は「知っていれば便利なこと」だけを持つ。
/// 知らないモードは正規値をそのまま CLI へ渡し、フッタからは読み取れないだけで済む。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModeInfo {
    /// フックと設定ファイルが使う正規の綴り
    pub canonical: &'static str,
    /// CLI の `--permission-mode` へ渡す綴り
    pub cli: &'static str,
    /// 端末フッタに現れる語句。
    ///
    /// 記号（`⏸` / `⏵⏵`）を含めないのは、装飾として別々に色付けされうるため。
    /// 語句のほうが安定して拾える。
    pub footer: &'static str,
}

/// Claude Code のモード表（`claude --help` の choices と実測のフッタ。設計§11）。
///
/// **サービスごとの表**という形にしてある。codex 等を対象に足すときは同じ形の表を
/// もう1つ持てばよく、この表には手を入れない。
pub const CLAUDE_MODES: &[ModeInfo] = &[
    ModeInfo {
        canonical: "default",
        cli: "manual",
        footer: "manual mode on",
    },
    ModeInfo {
        canonical: "acceptEdits",
        cli: "acceptEdits",
        footer: "accept edits on",
    },
    ModeInfo {
        canonical: "plan",
        cli: "plan",
        footer: "plan mode on",
    },
    ModeInfo {
        canonical: "auto",
        cli: "auto",
        footer: "auto mode on",
    },
    ModeInfo {
        canonical: "dontAsk",
        cli: "dontAsk",
        footer: "don't ask on",
    },
    ModeInfo {
        canonical: "bypassPermissions",
        cli: "bypassPermissions",
        footer: "bypass permissions on",
    },
];

/// 正規値から表を引く。
pub fn info(mode: &PermissionMode) -> Option<&'static ModeInfo> {
    CLAUDE_MODES
        .iter()
        .find(|entry| entry.canonical == mode.as_str())
}

/// CLI の `--permission-mode` へ渡す綴りにする。
///
/// 表に無いモードはそのまま渡す。**知らないモードを弾かない**のは、CLI が先に新しい
/// モードを覚えた場合に、ダッシュボードを直さなくても使えるようにするため。
pub fn cli_argument(mode: &PermissionMode) -> String {
    match info(mode) {
        Some(entry) => entry.cli.to_string(),
        None => mode.as_str().to_string(),
    }
}

/// 端末に出ている内容から、いまのモードを読む。
///
/// # 最後に現れたものが勝つ
///
/// フッタは画面が更新されるたびに書き直されるので、スクロールバックには古いフッタが
/// 何度も残っている。**いちばん後ろに現れた目印**が現在のモードにあたる。
///
/// # 先に ANSI を落とす
///
/// 読む対象は端末の生のバイト列で、語句の途中に色の指定が挟まりうる。そのまま
/// 文字列一致を掛けると、見えている文字は同じなのに一致しない、という追いにくい
/// 失敗になる。
pub fn parse_footer(text: &str) -> Option<PermissionMode> {
    let plain = strip_ansi(text);
    CLAUDE_MODES
        .iter()
        .filter_map(|entry| plain.rfind(entry.footer).map(|at| (at, entry)))
        .max_by_key(|(at, _)| *at)
        .map(|(_, entry)| PermissionMode::new(entry.canonical))
}

/// 端末の制御シーケンスを落として、見えている文字だけを残す。
///
/// 完全な端末エミュレーションはしない（それが要るなら構造化ビューの側でやる話になる）。
/// ここで欲しいのは「フッタの語句が入っているか」だけなので、色や移動の指定を
/// 取り除ければ足りる。
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            // CSI … 英字で終わる
            Some('[') => {
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            // OSC … BEL か ESC \ で終わる
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            // ESC + 1文字の短いシーケンス。落とすのは続く1文字だけ
            Some(_) => {}
            None => break,
        }
    }
    out
}

/// 全承認をスキップで起動したときに出る、責任の受諾を尋ねる画面の目印。
///
/// 一度受け入れると以後は出ないため、実測（設計§11）では**出せなかった**。文言は
/// 公式ドキュメントの説明に基づく推定なので、**目印は複数持ち、どれか1つでも当たれば
/// その画面とみなす**。外れても害は無い（後述のとおり、選択肢が読めなければ何も送らない）。
pub const BYPASS_NOTICE_MARKERS: &[&str] = &[
    "bypass permissions mode",
    "bypassing permissions",
    "accept all responsibility",
    "responsibility for actions",
];

/// 責任の受諾を尋ねる画面から、「受け入れる」選択肢の番号キーを探す。
///
/// # 決め打ちで Enter を送らない
///
/// この画面の**既定の選択肢は「いいえ（終了する）」**とされている。確かめずに確定を
/// 送ると、起動したはずのセッションが黙って終了する。そこで画面に並んでいる選択肢を
/// 読み、「はい」と書かれた行の番号を見つけたときだけ、その数字を送る。
///
/// 見つからなければ `None`。**何も送らない**のが正しい（利用者がターミナルビューで
/// 答えられる）。初期実装フェーズ3で、画面を見ずに送ったキーが別の相手に吸われる
/// 事故を実測しているので、ここは保守的に倒す。
pub fn accept_option_key(screen: &str) -> Option<char> {
    for line in strip_ansi(screen).lines() {
        let trimmed = line.trim_start_matches([' ', '\t', '❯', '>', '*', '│']);
        let trimmed = trimmed.trim_start();
        let mut chars = trimmed.chars();
        let Some(digit) = chars.next().filter(char::is_ascii_digit) else {
            continue;
        };
        if chars.next() != Some('.') {
            continue;
        }
        let rest = chars.as_str().trim().to_lowercase();
        // 「No, exit」を「yes」と取り違えないよう、否定の側を先に弾く
        if rest.starts_with("no") {
            continue;
        }
        if rest.starts_with("yes") {
            return Some(digit);
        }
    }
    None
}

/// `claude --help` の出力から `--permission-mode` の選択肢を取り出す。
///
/// 出力は端末幅で折り返されるので、`(choices: …)` は複数行にまたがる。閉じ括弧までを
/// ひとまとまりとして読み、引用符で囲まれた語を拾う。
///
/// **解析できなければ空を返す。** 呼び出し側は静的な表へ落ちる（設計§3）。ここが
/// 壊れても「いま何のモードか」の表示は死なない。
pub fn parse_help_choices(help: &str) -> Vec<PermissionMode> {
    let Some(at) = help.find("--permission-mode") else {
        return Vec::new();
    };
    let rest = &help[at..];
    let Some(start) = rest.find("(choices:") else {
        return Vec::new();
    };
    let tail = &rest[start..];
    let Some(end) = tail.find(')') else {
        return Vec::new();
    };

    let mut modes = Vec::new();
    let mut inside = false;
    let mut current = String::new();
    for ch in tail[..end].chars() {
        if ch == '"' {
            if inside {
                // 綴りが違うだけの別名（manual）も、運ぶ値は正規値へ寄せる
                let mode = PermissionMode::new(std::mem::take(&mut current));
                if !modes.contains(&mode) {
                    modes.push(mode);
                }
            }
            inside = !inside;
            continue;
        }
        if inside {
            current.push(ch);
        }
    }
    modes
}

/// その CLI が受け付けるモードを求める。
///
/// `--help` を1回だけ起動して読む。**読めなければ静的な表**（[`CLAUDE_MODES`]）へ落ちる。
/// `--help` はモデルへ問い合わせないので、クォータは消費しない。
pub fn supported_modes(program: &str) -> Vec<PermissionMode> {
    let parsed = Command::new(program)
        .arg("--help")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            parse_help_choices(&text)
        })
        .unwrap_or_default();

    if parsed.is_empty() {
        tracing::info!("--help から権限モードを読めませんでした。既知の表を使います");
        return fallback_modes();
    }
    parsed
}

/// 静的な表から作る、既知のモード一覧。
pub fn fallback_modes() -> Vec<PermissionMode> {
    CLAUDE_MODES
        .iter()
        .map(|entry| PermissionMode::new(entry.canonical))
        .collect()
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 正規値から表を引ける() {
        let manual = PermissionMode::new("manual");
        assert_eq!(manual.as_str(), "default", "先に正規値へ寄る");
        assert_eq!(
            info(&manual).unwrap().cli,
            "manual",
            "CLI へは manual で渡す"
        );
        assert_eq!(
            cli_argument(&PermissionMode::new("bypassPermissions")),
            "bypassPermissions"
        );
    }

    #[test]
    fn 表に無いモードもそのままCLIへ渡す() {
        // CLI が先に新しいモードを覚えた場合に、ダッシュボードを直さなくても使えること
        let unknown = PermissionMode::new("まだ知らないモード");
        assert!(info(&unknown).is_none());
        assert_eq!(cli_argument(&unknown), "まだ知らないモード");
    }

    #[test]
    fn フッタから全モードを読める() {
        // 実測した文字列そのまま（設計§11）
        let table = [
            ("  ⏸ manual mode on · ? for shortcuts", "default"),
            ("  ⏵⏵ accept edits on (shift+tab to cycle)", "acceptEdits"),
            ("  ⏸ plan mode on (shift+tab to cycle)", "plan"),
            ("  ⏵⏵ auto mode on · ← for agents", "auto"),
            ("  ⏵⏵ don't ask on (shift+tab to cycle)", "dontAsk"),
            (
                "  ⏵⏵ bypass permissions on · ← for agents",
                "bypassPermissions",
            ),
        ];
        for (line, expected) in table {
            assert_eq!(
                parse_footer(line),
                Some(PermissionMode::new(expected)),
                "{line}"
            );
        }
    }

    #[test]
    fn フッタは最後に現れたものが勝つ() {
        // 画面が更新されるたびにフッタは書き直される。古いものがスクロールバックに
        // 残っているので、いちばん後ろを見ないと切替が反映されない
        let scrollback = "⏸ manual mode on\n出力\n⏵⏵ accept edits on\n出力\n⏸ plan mode on\n";
        assert_eq!(parse_footer(scrollback), Some(PermissionMode::new("plan")));
    }

    #[test]
    fn 色の指定が語句に挟まっても読める() {
        // 生のバイト列には色の指定が混ざる。見えている文字が同じなら読めること
        let colored = "\u{1b}[2m⏵⏵ \u{1b}[0maccept\u{1b}[1m edits on\u{1b}[0m";
        assert_eq!(
            parse_footer(colored),
            Some(PermissionMode::new("acceptEdits"))
        );
    }

    #[test]
    fn フッタが無ければ読めない() {
        assert_eq!(parse_footer("ただの出力\n"), None);
        assert_eq!(parse_footer(""), None);
    }

    #[test]
    fn 受諾の選択肢だけを見つけて番号を返す() {
        // 既定の選択肢は「いいえ（終了する）」とされている。決め打ちで確定を送ると
        // 起動したはずのセッションが黙って終わるので、番号を読んでから送る
        let screen = "\
 WARNING: Claude Code running in Bypass Permissions mode
 By proceeding, you accept all responsibility for actions taken
 ❯ 1. No, exit
   2. Yes, I accept
";
        assert!(
            BYPASS_NOTICE_MARKERS
                .iter()
                .any(|marker| strip_ansi(screen).to_lowercase().contains(marker))
        );
        assert_eq!(accept_option_key(screen), Some('2'));
    }

    #[test]
    fn 選択肢が読めなければ何も送らない() {
        // 分からないときに送らないのが正しい。利用者がターミナルで答えられる
        assert_eq!(accept_option_key("ただの画面"), None);
        assert_eq!(accept_option_key(" 1. No, exit\n 2. Nope"), None);
        assert_eq!(accept_option_key(""), None);
    }

    #[test]
    fn helpの選択肢を折り返しをまたいで読める() {
        // 実際の `claude --help` は端末幅で折り返す
        let help = "\
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: \"acceptEdits\", \"auto\",
                                        \"bypassPermissions\", \"manual\",
                                        \"dontAsk\", \"plan\")
  --plugin-dir <path>                   Load a plugin
";
        let modes: Vec<String> = parse_help_choices(help)
            .into_iter()
            .map(|mode| mode.as_str().to_string())
            .collect();
        assert_eq!(
            modes,
            [
                "acceptEdits",
                "auto",
                "bypassPermissions",
                // manual は正規値へ寄る
                "default",
                "dontAsk",
                "plan"
            ]
        );
    }

    #[test]
    fn 解析できない出力では空を返して静的な表へ落ちる() {
        // ここが壊れても機能は死なない（表示は解析結果に依存しない）
        assert!(parse_help_choices("").is_empty());
        assert!(parse_help_choices("--permission-mode <mode>  説明だけ").is_empty());
        assert!(parse_help_choices("--permission-mode (choices: 閉じ括弧が無い").is_empty());
        assert_eq!(fallback_modes().len(), CLAUDE_MODES.len());
    }
}
