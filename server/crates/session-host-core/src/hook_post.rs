//! フックから起動される `hook-post` サブコマンド（設計§7）。
//!
//! セッションに注入する settings（[`crate::session::hooks_settings`]）は、フックの
//! `command` として **core バイナリ自身**のこのサブコマンドを指定する。専用のスクリプトを
//! 置かないので、配布物は単一バイナリのままで済む。
//!
//! # 守らなければならない2つの作法
//!
//! - **stdout に何も書かない**。UserPromptSubmit / SessionStart 系のフックは「終了コード 0 の
//!   ときの stdout を Claude へのコンテキストとして注入する」仕様のため、`{}` すら返しては
//!   いけない。観測だけが目的のフックは無言で終わるのが正しい
//! - **どんな失敗でも終了コード 0 で終わる**。ダッシュボードが落ちていることが、CLI 側の
//!   動作を妨げてはならない
//!
//! HTTP クライアントは `std::net::TcpStream` の最小実装にしている。宛先は必ず
//! `127.0.0.1` のダッシュボード自身なので、外部クレートを足す理由がない。

use std::{
    io::{Read as _, Write as _},
    net::{TcpStream, ToSocketAddrs as _},
    time::Duration,
};

/// 接続・送信・受信それぞれに許す時間。
///
/// SessionEnd フックだけは Claude Code 側のタイムアウトが 1.5 秒なので、それより短くする。
const TIMEOUT: Duration = Duration::from_millis(1000);

/// stdin のJSONをそのまま POST する。失敗しても黙って戻る。
pub fn run(url: &str) {
    let mut body = String::new();
    if std::io::stdin().read_to_string(&mut body).is_err() {
        return;
    }
    // 送れなくても CLI の邪魔をしないのが最優先。理由は握り潰す
    let _ = post(url, &body);
}

/// 宛先URLを「接続先」と「パス」に分けたもの。
///
/// ログを引く口（[`crate::logs`]）も同じ形の URL を組むので、**割り方だけを借りる**。
/// [`post`] そのものは流用しない——あちらは「失敗しても黙る」ことと「応答を読み捨てる」
/// ことが契約なので、声を持つ処理を混ぜるとその契約が濁る
pub(crate) struct Target {
    pub(crate) authority: String,
    pub(crate) path: String,
}

pub(crate) fn parse_url(url: &str) -> anyhow::Result<Target> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| anyhow::anyhow!("http:// で始まるURLのみ扱えます: {url}"))?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        anyhow::bail!("接続先がありません: {url}");
    }
    Ok(Target {
        authority: authority.to_string(),
        path: path.to_string(),
    })
}

/// 127.0.0.1 のダッシュボードへ1本 POST する。
///
/// [`crate::model_post`] も同じ宛先・同じ制約（失敗しても黙る）なので共用する。
pub(crate) fn post(url: &str, body: &str) -> anyhow::Result<()> {
    let target = parse_url(url)?;
    let address = target
        .authority
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow::anyhow!("接続先を解決できません: {}", target.authority))?;

    let mut stream = TcpStream::connect_timeout(&address, TIMEOUT)?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    stream.set_read_timeout(Some(TIMEOUT))?;

    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        target.path,
        target.authority,
        body.len(),
        body,
    );
    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    // 応答を読み切ってから終わる。読まずに抜けると、サーバが処理し終える前にこちらの
    // プロセスが消えることがあり、「フックを送ったのに状態が変わらない」という
    // 再現しにくい取りこぼしになる
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn urlは接続先とパスに分かれる() {
        let target = parse_url("http://127.0.0.1:8787/hook/abc123/PreToolUse").unwrap();
        assert_eq!(target.authority, "127.0.0.1:8787");
        assert_eq!(target.path, "/hook/abc123/PreToolUse");
    }

    #[test]
    fn パスが無いurlはルート扱いになる() {
        let target = parse_url("http://127.0.0.1:8787").unwrap();
        assert_eq!(target.path, "/");
    }

    #[test]
    fn httpsや不正な形式は拒否する() {
        assert!(parse_url("https://127.0.0.1:8787/hook").is_err());
        assert!(parse_url("http:///hook").is_err());
        assert!(parse_url("127.0.0.1:8787/hook").is_err());
    }
}
