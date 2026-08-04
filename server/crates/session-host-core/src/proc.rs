//! 外部コマンドを1回起こして、打ち切り付きで結果を受け取る。
//!
//! 自己修復（`git` / `scripts/cargo` / 本物の claude）と版の取得（`curl` / インストーラ）が
//! 同じ物を要る。**2つ持つと片方だけ打ち切りを忘れる**ので、ここへ集めてある。
//!
//! 打ち切りが要るのは、返らないコマンドが1つあるだけで「作業中のまま永久に終わらない」
//! 状態になるため。標準入力を塞ぐのは、入力を待つ相手に当たったときに同じ形で固まるのを
//! 防ぐため。

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 様子を見に行く間隔。細かくしても待ち時間は縮まらない（相手の実行時間で決まる）。
const POLL: Duration = Duration::from_millis(200);

/// コマンド1回の結果。
///
/// **標準出力と標準エラーを両方持つ。** 片方を捨てると、失敗したときに理由が消える。
#[derive(Debug, Clone)]
pub struct Outcome {
    pub success: bool,
    pub output: String,
}

impl Outcome {
    pub fn failed(output: String) -> Self {
        Self {
            success: false,
            output,
        }
    }

    pub fn into_result(self, what: &str) -> anyhow::Result<String> {
        if self.success {
            Ok(self.output)
        } else {
            anyhow::bail!("{what} に失敗しました: {}", self.output)
        }
    }
}

/// 標準出力と標準エラーをまとめて受け取り、上限時間で打ち切る。
pub fn run(command: &mut Command, timeout: Duration) -> Outcome {
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => return Outcome::failed(format!("起動できません: {error}")),
    };

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().map(collect).unwrap_or_default();
                return Outcome {
                    success: status.success(),
                    output,
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Outcome::failed(format!("{timeout:?} を過ぎても終わりませんでした"));
                }
                std::thread::sleep(POLL);
            }
            Err(error) => return Outcome::failed(format!("待ち受けに失敗しました: {error}")),
        }
    }
}

fn collect(output: std::process::Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 標準出力と標準エラーを両方受け取る() {
        let outcome = run(
            Command::new("sh").arg("-c").arg("echo あ; echo い >&2"),
            Duration::from_secs(10),
        );
        assert!(outcome.success);
        assert!(outcome.output.contains('あ'), "{}", outcome.output);
        assert!(outcome.output.contains('い'), "{}", outcome.output);
    }

    #[test]
    fn 返らないコマンドは打ち切られる() {
        let outcome = run(
            Command::new("sh").arg("-c").arg("sleep 30"),
            Duration::from_millis(300),
        );
        assert!(!outcome.success);
        assert!(
            outcome.output.contains("過ぎても終わりませんでした"),
            "{}",
            outcome.output
        );
    }

    #[test]
    fn 起動できない相手は失敗として返る() {
        let outcome = run(
            &mut Command::new("この名前の実行ファイルは無い"),
            Duration::from_secs(10),
        );
        assert!(!outcome.success);
        assert!(
            outcome.output.contains("起動できません"),
            "{}",
            outcome.output
        );
    }

    #[test]
    fn 標準入力は塞がれている() {
        // 入力を待つ相手に当たっても固まらない。塞いでいなければ打ち切りまで待つことになる
        let outcome = run(
            Command::new("sh").arg("-c").arg("cat; echo 終わり"),
            Duration::from_secs(10),
        );
        assert!(outcome.success);
        assert!(outcome.output.contains("終わり"), "{}", outcome.output);
    }
}
