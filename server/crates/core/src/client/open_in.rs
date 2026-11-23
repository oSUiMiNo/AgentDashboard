//! `host open`・`host opened`（エクスプローラ・VSCode で開く口。`サイドバーにエクスプローラで
//! 開くボタンが欲しい` 設計§6-1）。
//!
//! **画面のサイドバーのボタンと同じ口を叩く。** CLI は親PC の上で `127.0.0.1` に繋ぐので、
//! 口の「親PC か」の判定を通る。

use super::{ClientError, Target, http, output};
use crate::open_api::{OpenInView, OpenResult, Outcome};
use session_host_core::open_in::{App, TargetKind};
use std::path::{Component, Path, PathBuf};

/// `--app` に渡す道具。
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum OpenApp {
    Explorer,
    Vscode,
}

impl From<OpenApp> for App {
    fn from(app: OpenApp) -> Self {
        match app {
            OpenApp::Explorer => App::Explorer,
            OpenApp::Vscode => App::Vscode,
        }
    }
}

fn url(host: &str) -> String {
    format!("/api/hosts/{}/open", http::percent_encode(host))
}

/// `GET /api/hosts/{host}/open`（開けるか・いま VSCode で開いているもの）。
pub async fn status(target: &Target, host: &str) -> Result<(OpenInView, String), ClientError> {
    http::fetch_as(target, &url(host)).await
}

/// `POST /api/hosts/{host}/open`。`path` は `cwd` からの絶対パスへ直してから送る。
///
/// **503 は本文の理由をそのまま出す。** [`ClientError::from_status`] は 503 を「記録（DB）が
/// 応じていない」という決まった文へ置き換えるが、この口の 503 は「道具が使えない」理由
/// （塞いである・VSCode が見つからない）で、置き換えると利用者は DB の故障と読み違える。
pub async fn open(
    target: &Target,
    host: &str,
    path: &str,
    app: App,
    cwd: &Path,
) -> Result<(OpenResult, String), ClientError> {
    let abs = absolutize(path, cwd);
    let body = serde_json::json!({ "app": app, "path": abs }).to_string();
    let (status, text) =
        http::request(target, "POST", &url(host), Some(http::Payload::json(body))).await?;
    match status {
        200..=299 => {
            let typed = serde_json::from_str(&text).map_err(|err| ClientError::Refused {
                status,
                message: format!("応答の形を読めません（{err}）。相手は本当にダッシュボードですか"),
            })?;
            Ok((typed, text))
        }
        503 => Err(ClientError::Refused {
            status,
            message: text.trim().to_string(),
        }),
        other => Err(ClientError::from_status(other, text)),
    }
}

/// 相対パスを `cwd` からの絶対パスへ直す。
///
/// **字面だけ整える**（`.` を落とし、`..` で1つ戻り、末尾の `/` を落とす）。絶対パスにも当てる——
/// 整えないと、画面の印（整った形）と突き合わない。シンボリックリンクは辿らない（辿ると画面の印と
/// 突き合わせるパスがずれる）。在るかはサーバが確かめる。
pub fn absolutize(path: &str, cwd: &Path) -> String {
    let path = Path::new(path);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    lexical(&joined).to_string_lossy().into_owned()
}

/// パスの字面だけを整える。`/` より上へは出ない。
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::RootDir => out.push("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                if out.parent().is_some() {
                    out.pop();
                }
            }
            Component::Normal(name) => out.push(name),
            Component::Prefix(_) => {}
        }
    }
    out
}

fn tool_line(name: &str, available: bool, reason: Option<&str>) -> String {
    if available {
        format!("{name}：使えます")
    } else {
        format!(
            "{name}：使えません（{}）",
            reason.unwrap_or("理由は分かりません")
        )
    }
}

/// `host opened` の人の読む形。
pub fn render_opened(view: &OpenInView, now_ms: i64) -> String {
    let mut lines = Vec::new();
    lines.push(if view.same_machine {
        "この端末：親PC（ボタンが出ます）".to_string()
    } else {
        format!(
            "この端末：親PC ではありません（{}）",
            view.same_machine_reason
                .as_deref()
                .unwrap_or("理由は分かりません")
        )
    });
    lines.push(tool_line(
        "エクスプローラ",
        view.explorer.available,
        view.explorer.reason.as_deref(),
    ));
    lines.push(tool_line(
        "VSCode",
        view.vscode.available,
        view.vscode.reason.as_deref(),
    ));
    if view.opened.is_empty() {
        lines.push("VSCode で開いているもの：なし".to_string());
    } else {
        lines.push("VSCode で開いているもの：".to_string());
        for entry in &view.opened {
            let kind = match entry.kind {
                TargetKind::Dir => "フォルダ",
                TargetKind::File => "ファイル",
            };
            lines.push(format!(
                "- {}（{kind}）{}から",
                entry.path,
                output::format_ago(now_ms, entry.since_ms as i64)
            ));
        }
    }
    lines.join("\n")
}

/// `host open` の人の読む形。
pub fn render_open_result(result: &OpenResult) -> String {
    match result.outcome {
        Outcome::Launched => "エクスプローラで開きました",
        Outcome::Opened => "VSCode で開きました。閉じるまで印が付きます",
        Outcome::Fronted => "もう VSCode で開いていたので、窓を前に出しました",
        Outcome::Starting => "VSCode を起こしている最中です。少し待つと窓が開きます",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use crate::open_api::{OpenedView, ToolView};

    fn view(same_machine: bool) -> OpenInView {
        OpenInView {
            same_machine,
            same_machine_reason: (!same_machine).then(|| "別の端末から開かれています".to_string()),
            explorer: ToolView {
                available: true,
                reason: None,
            },
            vscode: ToolView {
                available: false,
                reason: Some("VSCode が見つかりません".to_string()),
            },
            opened: vec![OpenedView {
                path: "/home/u/pjt".to_string(),
                kind: TargetKind::Dir,
                since_ms: 10_000,
            }],
        }
    }

    #[test]
    fn 相対パスは作業フォルダからの絶対パスにする() {
        assert_eq!(absolutize("child", Path::new("/base")), "/base/child");
        assert_eq!(absolutize("a/b.txt", Path::new("/base")), "/base/a/b.txt");
    }

    #[test]
    fn 相対パスは字面を整えて絶対パスにする() {
        let cwd = Path::new("/home/u/pjt");
        assert_eq!(absolutize(".", cwd), "/home/u/pjt");
        assert_eq!(absolutize("./sub/", cwd), "/home/u/pjt/sub");
        assert_eq!(absolutize("../x", cwd), "/home/u/x");
    }

    #[test]
    fn 絶対パスはそのまま送る() {
        assert_eq!(absolutize("/x/y", Path::new("/base")), "/x/y");
        assert_eq!(absolutize("/x/y/", Path::new("/base")), "/x/y");
        assert_eq!(absolutize("/../x", Path::new("/base")), "/x");
    }

    #[test]
    fn 親PCの様子を人の読む形にする() {
        let text = render_opened(&view(true), 70_000);
        assert!(text.contains("この端末：親PC（ボタンが出ます）"), "{text}");
        assert!(text.contains("エクスプローラ：使えます"), "{text}");
        assert!(
            text.contains("VSCode：使えません（VSCode が見つかりません）"),
            "{text}"
        );
        assert!(
            text.contains("- /home/u/pjt（フォルダ）1分前から"),
            "{text}"
        );
    }

    #[test]
    fn 親PCでない様子は理由を添える() {
        let mut view = view(false);
        view.opened.clear();
        let text = render_opened(&view, 0);
        assert!(
            text.contains("この端末：親PC ではありません（別の端末から開かれています）"),
            "{text}"
        );
        assert!(text.contains("VSCode で開いているもの：なし"), "{text}");
    }

    #[test]
    fn 開いた結果を4つの文で言う() {
        let result = |outcome| OpenResult {
            outcome,
            view: view(true),
        };
        assert_eq!(
            render_open_result(&result(Outcome::Launched)),
            "エクスプローラで開きました"
        );
        assert_eq!(
            render_open_result(&result(Outcome::Opened)),
            "VSCode で開きました。閉じるまで印が付きます"
        );
        assert_eq!(
            render_open_result(&result(Outcome::Fronted)),
            "もう VSCode で開いていたので、窓を前に出しました"
        );
        assert_eq!(
            render_open_result(&result(Outcome::Starting)),
            "VSCode を起こしている最中です。少し待つと窓が開きます"
        );
    }
}
