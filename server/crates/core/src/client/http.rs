//! HTTP の1往復（CLI設計§6）。
//!
//! # なぜ手書き（`logs.rs` の `fetch`）を育てずに hyper を借りるか
//!
//! 前段（リバースプロキシ）は応答を chunked へ組み替え**うる**——同梱の設定では起きないが、
//! 利用者が Caddy へ `encode gzip` を1行足すだけで現れる（CLI設計§15-1 の実測）。
//! `Content-Length` 必須の手書きは、その利用者の環境でだけ全滅し、手元の検証では
//! 一度も出ない。hyper は chunked も自分で扱うので、書く量が減るうえに踏まない穴が増える。
//!
//! # 接続の形
//!
//! 接続プールは持たない。CLI は1回の呼び出しで「繋ぐ → 送る → 切る」を閉じる
//! （CLI設計§1-2）ので、毎回 `Connection: close` で新しく繋ぐ。

use super::{ClientError, Target};
use http_body_util::BodyExt as _;
use hyper_util::rt::TokioIo;
use serde::de::DeserializeOwned;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;

/// 1往復ぶんの上限。読む系は一覧でも数百 KB なので、これを超えるのは
/// 「相手が固まっている」か「相手を取り違えている」のどちらか
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 1往復する。成功なら（状態コード・本文）を返す。
///
/// - 送るヘッダは `Host` / `Accept` / `Connection: close`（＋本文があるときだけ
///   `Content-Type: application/json`）
/// - **`Accept-Encoding` は送らない**（CLI設計§15-1）。送らなければ前段は圧縮しないので、
///   gzip の解凍器を持たずに済む。将来送るなら解凍とセットで入れること
pub async fn request(
    target: &Target,
    method: &str,
    path: &str,
    body: Option<String>,
) -> Result<(u16, String), ClientError> {
    let outcome = tokio::time::timeout(REQUEST_TIMEOUT, exchange(target, method, path, body)).await;
    match outcome {
        Ok(result) => result,
        Err(_) => Err(ClientError::Timeout {
            what: format!("{method} {path} の応答"),
            secs: REQUEST_TIMEOUT.as_secs(),
        }),
    }
}

/// 200 番台だけを成功として本文を返す。それ以外は言葉へ直して断る（CLI設計§6-4）。
pub async fn fetch_ok(target: &Target, path: &str) -> Result<String, ClientError> {
    let (status, body) = request(target, "GET", path, None).await?;
    if (200..300).contains(&status) {
        Ok(body)
    } else {
        Err(ClientError::from_status(status, body))
    }
}

/// バイト列のまま取る（`ファイル閲覧で画像とHTMLも表示する` 設計§9）。
///
/// **文字列を経由しない。** 画像は UTF-8 として解けないので、途中で `String` にすると
/// 置き換え文字（`U+FFFD`）が混ざって**壊れたファイルを書き出す**ことになる。
pub async fn fetch_bytes(target: &Target, path: &str) -> Result<Vec<u8>, ClientError> {
    let outcome =
        tokio::time::timeout(REQUEST_TIMEOUT, exchange_bytes(target, "GET", path, None)).await;
    let (status, body) = match outcome {
        Ok(result) => result?,
        Err(_) => {
            return Err(ClientError::Timeout {
                what: format!("GET {path} の応答"),
                secs: REQUEST_TIMEOUT.as_secs(),
            });
        }
    };
    if (200..300).contains(&status) {
        Ok(body)
    } else {
        // 断り文は本文に入っている（`hosts.rs` の `refuse`）。**そのまま持ち上げる**
        Err(ClientError::from_status(
            status,
            String::from_utf8_lossy(&body).into_owned(),
        ))
    }
}

/// 型付きで取る。**生の本文も一緒に返す**——`--json` はこの生をそのまま出す
/// （CLI 側で作り直すと、サーバの型が変わったときに黙って古い形を出し続ける。CLI設計§10-2）。
pub async fn fetch_as<T: DeserializeOwned>(
    target: &Target,
    path: &str,
) -> Result<(T, String), ClientError> {
    let raw = fetch_ok(target, path).await?;
    let typed = serde_json::from_str(&raw).map_err(|err| ClientError::Refused {
        status: 200,
        message: format!("応答の形を読めません（{err}）。相手は本当にダッシュボードですか"),
    })?;
    Ok((typed, raw))
}

async fn exchange(
    target: &Target,
    method: &str,
    path: &str,
    body: Option<String>,
) -> Result<(u16, String), ClientError> {
    let (status, bytes) = exchange_bytes(target, method, path, body).await?;
    Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
}

/// 1往復して**バイト列のまま**返す。
///
/// 文字列にするのは呼ぶ側の都合であって、線の上を流れるのはバイト列である。
/// 画像は UTF-8 として解けないので、ここで `String` にすると置き換え文字が混ざる。
async fn exchange_bytes(
    target: &Target,
    method: &str,
    path: &str,
    body: Option<String>,
) -> Result<(u16, Vec<u8>), ClientError> {
    let address = (target.host().to_string(), target.port());
    let stream = TcpStream::connect(address)
        .await
        .map_err(|err| ClientError::Unreachable {
            target: target.http_url(),
            detail: err.to_string(),
        })?;
    if target.tls() {
        let stream = tls_wrap(target, stream).await?;
        drive(target, TokioIo::new(stream), method, path, body).await
    } else {
        drive(target, TokioIo::new(stream), method, path, body).await
    }
}

/// `https://` のときだけ通す TLS（CLI設計§6-1）。信頼の根は webpki（Mozilla のルート）で、
/// **検証を切る口は持たない**——`--insecure` の類を引数に持たせないことは
/// テスト計画F4 が機械で見る。
async fn tls_wrap(
    target: &Target,
    stream: TcpStream,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, ClientError> {
    use tokio_rustls::rustls;

    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let name =
        rustls::pki_types::ServerName::try_from(target.host().to_string()).map_err(|_| {
            ClientError::BadUrl(format!(
                "`{}` は TLS の相手として名乗れない形です",
                target.host()
            ))
        })?;
    connector
        .connect(name, stream)
        .await
        .map_err(|err| ClientError::Unreachable {
            target: target.http_url(),
            detail: format!("TLS で合意できませんでした: {err}"),
        })
}

async fn drive<T>(
    target: &Target,
    io: TokioIo<T>,
    method: &str,
    path: &str,
    body: Option<String>,
) -> Result<(u16, Vec<u8>), ClientError>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let cannot = |detail: String| ClientError::Unreachable {
        target: target.http_url(),
        detail,
    };
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|err| cannot(err.to_string()))?;
    // 接続の面倒（読み書きの多重化）は別タスクが見る。hyper の作法どおり
    tokio::spawn(async move {
        // `Connection: close` を頼んでいる1回きりの接続なので、応答を読み切ったあとの
        // 切断がどう終わったかは情報を持たない。応答そのものの失敗は本文の収集側で捕まえる
        let _ = conn.await;
    });

    let mut builder = hyper::Request::builder()
        .method(method)
        .uri(target.request_path(path))
        .header(hyper::header::HOST, target.authority())
        .header(hyper::header::ACCEPT, "application/json")
        .header(hyper::header::CONNECTION, "close");
    if let Some(token) = target.token() {
        // 札（CLI設計§5-4）。サーバは Cookie より先にこれで判定する（§5-2）
        builder = builder.header(hyper::header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if body.is_some() {
        builder = builder.header(hyper::header::CONTENT_TYPE, "application/json");
    }
    let request = builder
        .body(http_body_util::Full::new(bytes::Bytes::from(
            body.unwrap_or_default(),
        )))
        .map_err(|err| ClientError::BadUrl(format!("要求を組み立てられません: {err}")))?;

    let response = sender
        .send_request(request)
        .await
        .map_err(|err| cannot(err.to_string()))?;
    let status = response.status().as_u16();
    let collected = response
        .into_body()
        .collect()
        .await
        .map_err(|err| cannot(format!("本文を読み切れませんでした: {err}")))?;
    Ok((status, collected.to_bytes().to_vec()))
}

/// クエリの値を URL に載せられる形へ（予約文字だけを逃がす）。
///
/// `host dir` のパスには日本語がそのまま来る。`logs.rs` の私有 `escape` と同じ規則だが、
/// crate が違うのでここにも置く（公開すると内部の道具が口になるため共有しない）。
pub fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 日本語のパスはクエリに載る形へ逃がされる() {
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("計画"), "%E8%A8%88%E7%94%BB");
        assert_eq!(percent_encode("safe-._~09Az"), "safe-._~09Az");
    }
}
