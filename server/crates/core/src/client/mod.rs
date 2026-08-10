//! ダッシュボードを外から叩く側（CLI のクライアント層。CLI設計§1）。
//!
//! CLI は**ブラウザと同じ席に座る**——読むのは既にある REST、操作するのは既にある
//! WebSocket で、サーバ側に新しい口を1つも作らない（CLI設計§1-1）。このモジュールは
//! その「席」の実装で、接続先の解決（§4）・HTTP の1往復（§6）・出力の整形（§10）を持つ。
//!
//! # なぜサーバ側でも PC 側でもなくここか
//!
//! CLI はどちらでもなく、**外から叩く側**だから（CLI設計§2-1）。`settings_api.rs` と
//! `versions_api.rs` が同じ理屈でこの crate に居る。

pub mod http;
pub mod output;

use std::fmt;

/// 接続先の環境変数。`--server` と同じ意味で、引数が勝つ（CLI設計§4-1）。
///
/// **`AGENTDASHBOARD_` で始めない。** その接頭辞は `scripts/cargo` が丸ごと箱へ転送する
/// ので、開発者が手元で export した値がテストにも製品の経路にも混ざる（CLI設計§5-4 が
/// 札（`ADASH_TOKEN`）に対して名指ししている罠と同じ）。
pub const SERVER_ENV: &str = "ADASH_SERVER";

/// 接続先（CLI設計§4）。
///
/// `resolve` で作る。WebSocket の URL は HTTP の URL から**導く**（§4-2）——別々に
/// 指定させると、片方だけ直したときに「読めるのに操作できない」という切り分けの
/// 難しい状態になる。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// TLS で話すか（`https://` なら真）
    tls: bool,
    host: String,
    port: u16,
    /// 前段がパスの下へ載せている場合の接頭辞。無ければ空。末尾に `/` は持たない
    prefix: String,
}

impl Target {
    /// 接続先を決める（CLI設計§4-1）。優先は **引数 > 環境変数 > config.toml の port**。
    ///
    /// `--server`（または環境変数）があるときは `load_port` を**呼ばない**——設定ファイルが
    /// 壊れていても外のサーバは叩けるべきなので、読みに行かないことが仕様になっている。
    pub fn resolve(
        arg: Option<&str>,
        env: Option<&str>,
        load_port: impl FnOnce() -> Result<u16, String>,
    ) -> Result<Self, ClientError> {
        match arg.or(env) {
            Some(url) => Self::from_url(url),
            None => {
                let port = load_port().map_err(ClientError::Config)?;
                Ok(Self {
                    tls: false,
                    host: "127.0.0.1".to_string(),
                    port,
                    prefix: String::new(),
                })
            }
        }
    }

    /// `http://…` / `https://…` を読む。それ以外の形は引数の誤りとして断る。
    pub fn from_url(url: &str) -> Result<Self, ClientError> {
        let (tls, rest) = if let Some(rest) = url.strip_prefix("https://") {
            (true, rest)
        } else if let Some(rest) = url.strip_prefix("http://") {
            (false, rest)
        } else {
            return Err(ClientError::BadUrl(format!(
                "`{url}` を接続先として読めません。`http://…` か `https://…` で指定してください"
            )));
        };
        let (authority, path) = match rest.find('/') {
            Some(at) => (&rest[..at], &rest[at..]),
            None => (rest, ""),
        };
        if authority.is_empty() {
            return Err(ClientError::BadUrl(format!(
                "`{url}` にホスト名がありません"
            )));
        }
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port_text)) => {
                let port = port_text.parse::<u16>().map_err(|_| {
                    ClientError::BadUrl(format!("`{authority}` のポート番号を読めません"))
                })?;
                (host.to_string(), port)
            }
            // ポートを省いたら、その約束事のとおりへ（https は 443・http は 80）
            None => (authority.to_string(), if tls { 443 } else { 80 }),
        };
        // 末尾の `/` は畳む。畳まないと `/ws` を足したときにパスが二重になる（§4-2）
        let prefix = path.trim_end_matches('/').to_string();
        Ok(Self {
            tls,
            host,
            port,
            prefix,
        })
    }

    pub fn tls(&self) -> bool {
        self.tls
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// `Host` ヘッダに入れる形。既定のポート（443 / 80）は書かない
    pub fn authority(&self) -> String {
        let default = if self.tls { 443 } else { 80 };
        if self.port == default {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    /// 表示用の HTTP の URL（エラーメッセージで「相手」を名指しするのに使う）
    pub fn http_url(&self) -> String {
        let scheme = if self.tls { "https" } else { "http" };
        format!("{scheme}://{}{}", self.authority(), self.prefix)
    }

    /// WebSocket の URL。HTTP の URL から導く（CLI設計§4-2）
    pub fn ws_url(&self) -> String {
        let scheme = if self.tls { "wss" } else { "ws" };
        format!("{scheme}://{}{}/ws", self.authority(), self.prefix)
    }

    /// リクエスト行に書くパス（前段の接頭辞を被せる）。`path` は `/` で始まること
    pub fn request_path(&self, path: &str) -> String {
        format!("{}{path}", self.prefix)
    }
}

/// クライアント層の失敗（CLI設計§6-4・§10-3）。
///
/// **1（断られた）と 3（時間切れ）を分けるのが要点**——同じにすると、エージェントが
/// 「確かめられなかっただけ」の操作を送り直してよいのか判断できず、二重に指示を送る
/// 経路ができる。
#[derive(Debug)]
pub enum ClientError {
    /// `--server` の形が読めない（引数の誤り。clap の 2 と同じ扱い）
    BadUrl(String),
    /// 設定ファイルを読めなかった（`--server` 無しのときだけ起きる）
    Config(String),
    /// サーバに断られた（見つからない・権限・不正な値）。**送り直しても同じ**
    Refused { status: u16, message: String },
    /// 時間切れ。**投げたが確かめられなかった**——送り直す前に状態を見ること
    Timeout { what: String, secs: u64 },
    /// 相手が居ない（繋げない）
    Unreachable { target: String, detail: String },
    /// サーバは動いているが記録（DB）が応じていない（503）
    Unavailable { message: String },
}

impl ClientError {
    /// 終了コードへの写像（CLI設計§10-3 の表そのもの）。
    pub fn exit_code(&self) -> i32 {
        match self {
            // 断られた＝中身を直す。送り直さない
            Self::Refused { .. } | Self::Config(_) => 1,
            // 引数の誤り。clap が自分で断るときの既定（2）に揃える
            Self::BadUrl(_) => 2,
            // 時間切れ＝確かめられなかった。送り直す前に状態を見る
            Self::Timeout { .. } => 3,
            // 繋げない・DB が応じない＝待って再試行
            Self::Unreachable { .. } | Self::Unavailable { .. } => 4,
        }
    }

    /// 状態コードを**次の一手が分かる言い方**へ直す（CLI設計§6-4）。
    ///
    /// 403 と 404 は**同じ言葉**にする——言い分けると、ID を総当たりして「存在する」
    /// ことだけを調べられる（サーバ側の断り方の作法に揃える）。
    pub fn from_status(status: u16, body: String) -> Self {
        match status {
            401 => Self::Refused {
                status,
                message: "札が要ります（`--token` か環境変数 ADASH_TOKEN）。渡しているのに断られるなら、失効しているかもしれません".to_string(),
            },
            403 | 404 => Self::Refused {
                status,
                message: "見つかりません。ID やパスを確かめてください".to_string(),
            },
            503 => Self::Unavailable {
                message: "いま記録を読めません。サーバは動いていますが、記録の置き場所（DB）が応じていません".to_string(),
            },
            other => Self::Refused {
                status: other,
                message: if body.trim().is_empty() {
                    format!("ダッシュボードが {other} を返しました")
                } else {
                    format!("ダッシュボードが {other} を返しました：{}", body.trim())
                },
            },
        }
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadUrl(message) | Self::Config(message) => write!(f, "{message}"),
            Self::Refused { message, .. } | Self::Unavailable { message } => {
                write!(f, "{message}")
            }
            Self::Timeout { what, secs } => {
                write!(f, "{what}が {secs} 秒以内に終わりませんでした")
            }
            Self::Unreachable { target, detail } => {
                write!(
                    f,
                    "相手が居ません（{target}）。ダッシュボードは起きていますか（{detail}）"
                )
            }
        }
    }
}

impl std::error::Error for ClientError {}

// ---------------------------------------------------------------------------
// 読む系の取得（CLI設計§3-2 の表の左側を、そのまま関数にしたもの）
//
// どれも「REST を1回叩いて、型と生の本文の両方を返す」だけ。生も返すのは
// `--json` がサーバの応答をそのまま出す約束（CLI設計§10-2）のため。
// 統合テスト（tests/cli_client.rs）はこの層を直に呼ぶ。
// ---------------------------------------------------------------------------

use protocol::SessionMeta;

/// `GET /api/sessions`（一覧）。
pub async fn sessions(target: &Target) -> Result<(Vec<SessionMeta>, String), ClientError> {
    http::fetch_as(target, "/api/sessions").await
}

/// 一覧から前方一致で1件に絞る（`session show`）。
///
/// 返す生の JSON は**配列の該当要素を生から切り出したもの**——`SessionMeta` を経由して
/// 作り直すと、サーバだけが知っているフィールドが黙って落ちる。
pub async fn session_show(
    target: &Target,
    prefix: &str,
) -> Result<(SessionMeta, String), ClientError> {
    let raw = http::fetch_ok(target, "/api/sessions").await?;
    let values: Vec<serde_json::Value> =
        serde_json::from_str(&raw).map_err(|err| ClientError::Refused {
            status: 200,
            message: format!("一覧の形を読めません（{err}）"),
        })?;
    let ids: Vec<String> = values
        .iter()
        .map(|value| value["card_id"].as_str().unwrap_or_default().to_string())
        .collect();
    let id = resolve_card(prefix, &ids)?;
    let element = values
        .iter()
        .find(|value| value["card_id"].as_str() == Some(id.as_str()))
        .expect("解決した ID は一覧から選んだものなので必ず居る");
    let meta: SessionMeta =
        serde_json::from_value(element.clone()).map_err(|err| ClientError::Refused {
            status: 200,
            message: format!("カードの形を読めません（{err}）"),
        })?;
    let raw_element =
        serde_json::to_string_pretty(element).expect("JSON から読んだ値は必ず JSON へ戻せる");
    Ok((meta, raw_element))
}

/// `GET /api/sessions/{card}/transcript`（履歴。`--before` で遡る）。
pub async fn transcript(
    target: &Target,
    prefix: &str,
    before: Option<&str>,
    limit: Option<usize>,
) -> Result<(server_core::registry::TranscriptPage, String), ClientError> {
    // ID は前方一致で受けるので、まず一覧から解決する（1往復増えるが、
    // 打ち間違いへ「見つかりません」を返せる場所がここしか無い）
    let (list, _) = sessions(target).await?;
    let ids: Vec<String> = list.iter().map(|meta| meta.card_id.to_string()).collect();
    let id = resolve_card(prefix, &ids)?;
    let mut path = format!("/api/sessions/{id}/transcript");
    let mut query = Vec::new();
    if let Some(before) = before {
        query.push(format!("before={}", http::percent_encode(before)));
    }
    if let Some(limit) = limit {
        query.push(format!("limit={limit}"));
    }
    if !query.is_empty() {
        path = format!("{path}?{}", query.join("&"));
    }
    http::fetch_as(target, &path).await
}

/// `GET /api/projects`（PJT 枠の一覧）。
pub async fn projects(
    target: &Target,
) -> Result<(Vec<protocol::ws::ProjectView>, String), ClientError> {
    http::fetch_as(target, "/api/projects").await
}

/// `GET /api/hosts/{host}/dir`（フォルダを覗く。path 省略＝ホーム）。
pub async fn host_dir(
    target: &Target,
    host: &str,
    path: Option<&str>,
) -> Result<(protocol::fs::DirListing, String), ClientError> {
    let mut url = format!("/api/hosts/{}/dir", http::percent_encode(host));
    if let Some(path) = path {
        url = format!("{url}?path={}", http::percent_encode(path));
    }
    http::fetch_as(target, &url).await
}

/// `GET /api/hosts/{host}/file`（ファイルを読む）。
pub async fn host_file(
    target: &Target,
    host: &str,
    path: &str,
) -> Result<(protocol::fs::FileContent, String), ClientError> {
    let url = format!(
        "/api/hosts/{}/file?path={}",
        http::percent_encode(host),
        http::percent_encode(path)
    );
    http::fetch_as(target, &url).await
}

/// `GET /api/settings`。**解釈しない**（CLI設計§12-1）ので生の本文だけを返す。
pub async fn settings_raw(target: &Target) -> Result<String, ClientError> {
    http::fetch_ok(target, "/api/settings").await
}

/// `GET /api/versions`（版の一覧）。
pub async fn versions(
    target: &Target,
) -> Result<(crate::versions_api::VersionsView, String), ClientError> {
    http::fetch_as(target, "/api/versions").await
}

/// 前方一致の解決を、CLI の断り方（終了コード1・候補つき）へ写す。
fn resolve_card(prefix: &str, ids: &[String]) -> Result<String, ClientError> {
    let borrowed: Vec<&str> = ids.iter().map(String::as_str).collect();
    match output::resolve_prefix(prefix, &borrowed) {
        Ok(id) => Ok(id.to_string()),
        Err(output::PrefixError::NotFound) => Err(ClientError::Refused {
            status: 404,
            message: format!(
                "`{prefix}` に当たるカードは見つかりません。一覧は `agentdashboard session ls`"
            ),
        }),
        Err(output::PrefixError::Ambiguous(hits)) => Err(ClientError::Refused {
            status: 409,
            message: format!(
                "`{prefix}` は複数のカードに当たります。どれかまで打ってください：\n  {}",
                hits.join("\n  ")
            ),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- 接続先の解決（テスト計画F2「接続先の解決」） ---

    #[test]
    fn 平文の接続先からは素のwebsocketが導かれる() {
        let target = Target::from_url("http://127.0.0.1:8787").expect("読めること");
        assert_eq!(target.ws_url(), "ws://127.0.0.1:8787/ws");
        assert!(!target.tls());
    }

    #[test]
    fn 暗号化の接続先からは暗号化のwebsocketが導かれる() {
        let target = Target::from_url("https://dash.example.com").expect("読めること");
        assert_eq!(target.ws_url(), "wss://dash.example.com/ws");
        assert!(target.tls());
    }

    #[test]
    fn 末尾の区切りが付いていてもパスは二重にならない() {
        let target = Target::from_url("https://dash.example.com/").expect("読めること");
        assert_eq!(target.ws_url(), "wss://dash.example.com/ws");
        assert_eq!(target.request_path("/api/sessions"), "/api/sessions");
    }

    #[test]
    fn ポートを省いた暗号化の接続先は既定の四四三として扱われる() {
        let target = Target::from_url("https://dash.example.com").expect("読めること");
        assert_eq!(target.port(), 443);
        // 既定のポートは Host ヘッダにも URL にも書かない
        assert_eq!(target.authority(), "dash.example.com");
    }

    #[test]
    fn 接続先を指定したときは設定ファイルを読みに行かない() {
        // 設定が壊れていても外のサーバは叩ける、が仕様（CLI設計§4-1）。
        // 読みに行ったらここで落ちる閉包を渡して、呼ばれないことを確かめる
        let target = Target::resolve(Some("http://10.0.0.5:9000"), None, || {
            panic!("設定ファイルを読みに行ってはいけない")
        })
        .expect("解決できること");
        assert_eq!(target.http_url(), "http://10.0.0.5:9000");
    }

    #[test]
    fn 引数と環境変数の両方があるときは引数が勝つ() {
        let target = Target::resolve(
            Some("http://from-arg:1111"),
            Some("http://from-env:2222"),
            || panic!("設定ファイルを読みに行ってはいけない"),
        )
        .expect("解決できること");
        assert_eq!(target.host(), "from-arg");
        assert_eq!(target.port(), 1111);
    }

    #[test]
    fn 指定が無ければ設定のポートでループバックへ向かう() {
        let target = Target::resolve(None, None, || Ok(8787)).expect("解決できること");
        assert_eq!(target.http_url(), "http://127.0.0.1:8787");
    }

    #[test]
    fn 知らない形の接続先は引数の誤りとして断られる() {
        let err = Target::from_url("ftp://example.com").expect_err("断られること");
        assert_eq!(err.exit_code(), 2);
    }

    // --- 終了コード（テスト計画F2「終了コード」） ---

    #[test]
    fn 断られたときの終了コードは一になる() {
        let err = ClientError::from_status(400, "駄目".to_string());
        assert_eq!(err.exit_code(), 1);
    }

    #[test]
    fn 引数の誤りの終了コードは二になる() {
        // clap が自分で断るときの既定も 2。こちらで作る引数エラーをそれに揃える
        assert_eq!(ClientError::BadUrl("駄目".to_string()).exit_code(), 2);
    }

    #[test]
    fn 時間切れの終了コードは三になり断られたと区別される() {
        let timeout = ClientError::Timeout {
            what: "応答の待ち".to_string(),
            secs: 30,
        };
        let refused = ClientError::from_status(404, String::new());
        assert_eq!(timeout.exit_code(), 3);
        // **1 と 3 が別**であることがこの表の要点（CLI設計§10-3）。同じにすると
        // 「確かめられなかっただけ」の操作をエージェントが送り直す経路ができる
        assert_ne!(timeout.exit_code(), refused.exit_code());
    }

    #[test]
    fn 繋げないときの終了コードは四になる() {
        let unreachable = ClientError::Unreachable {
            target: "http://127.0.0.1:8787".to_string(),
            detail: "connection refused".to_string(),
        };
        assert_eq!(unreachable.exit_code(), 4);
        // DB が応じない（503）も「待って再試行」の族なので同じ 4
        assert_eq!(ClientError::from_status(503, String::new()).exit_code(), 4);
    }

    // --- 状態コードから言葉へ（テスト計画F2「状態コードから言葉へ」） ---

    #[test]
    fn 認証切れは札が要ると案内される() {
        let err = ClientError::from_status(401, String::new());
        let text = err.to_string();
        assert!(text.contains("札"), "札の案内が無い: {text}");
        assert!(text.contains("ADASH_TOKEN"), "渡し方の案内が無い: {text}");
    }

    #[test]
    fn 権限なしと存在なしは同じ言葉になる() {
        // 言い分けると ID の総当たりで「存在する」ことだけを調べられる（CLI設計§6-4）
        let forbidden = ClientError::from_status(403, "何か".to_string()).to_string();
        let missing = ClientError::from_status(404, "別の何か".to_string()).to_string();
        assert_eq!(forbidden, missing);
    }

    #[test]
    fn 記録が応じないときはその旨が言葉になる() {
        let text = ClientError::from_status(503, String::new()).to_string();
        assert!(text.contains("いま記録を読めません"), "言葉が違う: {text}");
    }
}
