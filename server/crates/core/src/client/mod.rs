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
pub mod keys;
pub mod output;
pub mod render;
pub mod wait;
pub mod ws;

use std::fmt;

/// 接続先の環境変数。`--server` と同じ意味で、引数が勝つ（CLI設計§4-1）。
///
/// **`AGENTDASHBOARD_` で始めない。** その接頭辞は `scripts/cargo` が丸ごと箱へ転送する
/// ので、開発者が手元で export した値がテストにも製品の経路にも混ざる（CLI設計§5-4 が
/// 札（`ADASH_TOKEN`）に対して名指ししている罠と同じ）。
pub const SERVER_ENV: &str = "ADASH_SERVER";

/// 札（ペアリングトークン）の環境変数。`--token` と同じ意味で、引数が勝つ（CLI設計§5-4）。
///
/// [`SERVER_ENV`] と同じ理由で **`AGENTDASHBOARD_` で始めない**。ファイルへは保存しない
/// ——秘密の置き場所を増やさないのが既定で、保存したい人は自分の rcfile に書く。
pub const TOKEN_ENV: &str = "ADASH_TOKEN";

/// 接続先（CLI設計§4）。
///
/// `resolve` で作る。WebSocket の URL は HTTP の URL から**導く**（§4-2）——別々に
/// 指定させると、片方だけ直したときに「読めるのに操作できない」という切り分けの
/// 難しい状態になる。
#[derive(Clone, PartialEq, Eq)]
pub struct Target {
    /// TLS で話すか（`https://` なら真）
    tls: bool,
    host: String,
    port: u16,
    /// 前段がパスの下へ載せている場合の接頭辞。無ければ空。末尾に `/` は持たない
    prefix: String,
    /// 札（CLI設計§5-4）。あれば HTTP と WS の両方が `Authorization: Bearer` を添える
    token: Option<String>,
}

/// `Debug` を手で書くのは**札の平文を写さない**ため。`{:?}` はエラーメッセージや
/// ログへそのまま流れうるので、derive のままだと秘密が紛れ込む経路になる。
impl fmt::Debug for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Target")
            .field("tls", &self.tls)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("prefix", &self.prefix)
            .field("token", &self.token.as_ref().map(|_| "＜伏せ字＞"))
            .finish()
    }
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
                    token: None,
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
            token: None,
        })
    }

    /// 札を被せる（CLI設計§5-4）。接続先の決まり方（`resolve`）とは独立に、
    /// 引数 > 環境変数 の優先を呼び出し側で済ませてから渡す。
    pub fn with_token(mut self, token: Option<String>) -> Self {
        self.token = token;
        self
    }

    /// 持っている札。HTTP（[`http`]）と WS（[`ws`]）がヘッダに添えるときだけ読む
    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
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
    /// 403 と 404 へ**こちらから言い添える言葉は1つ**——言い分けると、ID を総当たりして
    /// 「存在する」ことだけを調べられる。ただし**サーバが本文で理由を言っているなら
    /// そのまま通す**：総当たりへの防御はサーバ側の約束（他人のものと知らないものへ
    /// 同じ本文を返す）が担っており、こちらが上書きすると版や設定の 403 の
    /// 「なぜ駄目か」（例：127.0.0.1 からだけ変更できます）まで消えてしまう。
    pub fn from_status(status: u16, body: String) -> Self {
        match status {
            401 => Self::Refused {
                status,
                message: "札が要ります（`--token` か環境変数 ADASH_TOKEN）。渡しているのに断られるなら、失効しているかもしれません".to_string(),
            },
            403 | 404 => {
                let reason = body.trim();
                Self::Refused {
                    status,
                    message: if reason.is_empty() {
                        "見つかりません。ID やパスを確かめてください".to_string()
                    } else {
                        reason.to_string()
                    },
                }
            }
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

// ---------------------------------------------------------------------------
// account 群（CLI設計§12-3。サーバモードにしか無い）
// ---------------------------------------------------------------------------

/// `GET /api/me` を内部で読む（CLI設計§3-4）。
///
/// コマンドとしては出さない（§3-2 の載せない理由）が、`account` 群がモードを
/// 見分けるのに使う——ブラウザが「何を出すべきか」を決めるのと同じ用途。
async fn auth_view(target: &Target) -> Result<server_core::auth::AuthView, ClientError> {
    let (view, _) = http::fetch_as::<server_core::auth::AuthView>(target, "/api/me").await?;
    Ok(view)
}

/// `account` 群の門（CLI設計§3-4）。サーバモード以外では言葉を添えて断る。
///
/// **404 と言い分けるのが要点**——ローカルモードに `account` の口は無いので、黙って
/// 叩くと SPA のフォールバック（HTML）が返ってくる。「口が無い」ことと「繋がって
/// いない・打ち間違えた」ことを、受け取る側が区別できる形にする。
async fn ensure_account_mode(target: &Target) -> Result<(), ClientError> {
    let view = auth_view(target).await?;
    if view.mode != server_core::auth::AuthMode::Account {
        return Err(ClientError::Refused {
            status: 400,
            message: "この構成にアカウントはありません（ローカルモード）。札や PC の一覧はサーバモードのダッシュボードにだけあります".to_string(),
        });
    }
    Ok(())
}

/// `GET /api/account/tokens`（札の一覧。平文は含まれない）。
pub async fn account_tokens(
    target: &Target,
) -> Result<(Vec<server_core::account::TokenView>, String), ClientError> {
    ensure_account_mode(target).await?;
    http::fetch_as(target, "/api/account/tokens").await
}

/// `POST /api/account/tokens`（札の発行）。返りは（平文, 生の応答）。
///
/// **平文が手に入るのはこの1回だけ**（DB にはハッシュしか置かれない。§12-3）。
pub async fn account_issue(
    target: &Target,
    label: &str,
    kind: &str,
) -> Result<(String, String), ClientError> {
    ensure_account_mode(target).await?;
    let body = serde_json::json!({ "label": label, "kind": kind }).to_string();
    let raw = write_ok(target, "POST", "/api/account/tokens", Some(body)).await?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|err| ClientError::Refused {
            status: 200,
            message: format!("発行の応答を読めません（{err}）"),
        })?;
    let token = value["token"].as_str().unwrap_or_default().to_string();
    if token.is_empty() {
        return Err(ClientError::Refused {
            status: 200,
            message: "発行の応答に平文が入っていません".to_string(),
        });
    }
    Ok((token, raw))
}

/// `DELETE /api/account/tokens/{id}`（失効。繋がっている接続はその場で切れる）。
pub async fn account_revoke(target: &Target, prefix: &str) -> Result<String, ClientError> {
    ensure_account_mode(target).await?;
    let (tokens, _) =
        http::fetch_as::<Vec<server_core::account::TokenView>>(target, "/api/account/tokens")
            .await?;
    let ids: Vec<String> = tokens.iter().map(|view| view.id.to_string()).collect();
    let id = resolve_token_prefix(prefix, &ids)?;
    write_ok(target, "DELETE", &format!("/api/account/tokens/{id}"), None).await
}

/// `GET /api/account/agents`（登録済みの PC の一覧）。
pub async fn account_hosts(
    target: &Target,
) -> Result<(Vec<server_core::account::SessionHostView>, String), ClientError> {
    ensure_account_mode(target).await?;
    http::fetch_as(target, "/api/account/agents").await
}

/// 札の前方一致の解決（`resolve_card` と同じ作法。断りの言葉だけ札向け）。
fn resolve_token_prefix(prefix: &str, ids: &[String]) -> Result<String, ClientError> {
    let borrowed: Vec<&str> = ids.iter().map(String::as_str).collect();
    match output::resolve_prefix(prefix, &borrowed) {
        Ok(id) => Ok(id.to_string()),
        Err(output::PrefixError::NotFound) => Err(ClientError::Refused {
            status: 404,
            message: format!(
                "`{prefix}` に当たる札は見つかりません。一覧は `agentdashboard account tokens`"
            ),
        }),
        Err(output::PrefixError::Ambiguous(hits)) => Err(ClientError::Refused {
            status: 409,
            message: format!(
                "`{prefix}` は複数の札に当たります。どれかまで打ってください：\n  {}",
                hits.join("\n  ")
            ),
        }),
    }
}

// ---------------------------------------------------------------------------
// 操作系（CLI設計§3-2 の表の右側。フェーズ2）
//
// WebSocket で `ClientMessage` を1本送り、「何をもって届いたとするか」（wait::Goal）が
// 満ちるまで観測する。REST だけで済むもの（PJT 枠・設定・版）はそのまま REST。
// ---------------------------------------------------------------------------

use protocol::ws::{ClientMessage, ServerMessage};
use protocol::{CardId, ModelId, PermissionMode};
use std::collections::HashSet;
use std::time::Duration;
use wait::{Goal, Outcome};

/// 書く動詞の1往復。2xx 以外は断りの言葉へ写す。
async fn write_ok(
    target: &Target,
    method: &str,
    path: &str,
    body: Option<String>,
) -> Result<String, ClientError> {
    let (status, text) = http::request(target, method, path, body).await?;
    if (200..300).contains(&status) {
        Ok(text)
    } else {
        Err(ClientError::from_status(status, text))
    }
}

/// 前方一致を解決して `CardId` の型に包む。
async fn resolve_card_id(target: &Target, prefix: &str) -> Result<CardId, ClientError> {
    let (list, _) = sessions(target).await?;
    let ids: Vec<String> = list.iter().map(|meta| meta.card_id.to_string()).collect();
    let id = resolve_card(prefix, &ids)?;
    Ok(serde_json::from_value(serde_json::Value::String(id))
        .expect("一覧から取った ID は必ず CardId へ読める"))
}

/// `session spawn`（CLI設計§8-3）。**送る前に控えた集合に無い**カードを新規と見なす。
///
/// `cwd` の一致で待たないのは、同じフォルダで既に走っているカードの更新を
/// 「起きた」と読み違えないため。控えと接続の間に他所から起きた1本を掴む余地は
/// 残る（設計が承知で選んだ形）。
pub async fn spawn(
    target: &Target,
    cwd: &str,
    mode: Option<&str>,
    host: Option<&str>,
) -> Result<Outcome, ClientError> {
    let (list, _) = sessions(target).await?;
    let known: HashSet<String> = list.iter().map(|meta| meta.card_id.to_string()).collect();
    let agent_id = match host {
        Some(text) => Some(
            serde_json::from_value(serde_json::Value::String(text.to_string())).map_err(|_| {
                ClientError::BadUrl(format!(
                    "`{text}` を PC の ID として読めません（`agentdashboard settings show` の agents に載っている ID を渡してください）"
                ))
            })?,
        ),
        None => None,
    };
    let mut ws = ws::Ws::connect(target).await?;
    ws.send(&ClientMessage::Spawn {
        cwd: cwd.to_string(),
        permission_mode: mode.map(PermissionMode::new),
        agent_id,
    })
    .await?;
    let outcome = wait::run(
        &mut ws,
        Goal::NewCard { known },
        "セッションの起動",
        wait::SPAWN_CAP,
    )
    .await;
    ws.close().await;
    outcome
}

/// `session send`。既定は投げて終わり、`--wait` でターンの終わりまで観測する（§8-2）。
pub async fn send_input(
    target: &Target,
    prefix: &str,
    text: &str,
    wait_turn: bool,
    timeout_secs: u64,
) -> Result<Outcome, ClientError> {
    let card = resolve_card_id(target, prefix).await?;
    let mut ws = ws::Ws::connect(target).await?;
    ws.send(&ClientMessage::SendInput {
        card_id: card,
        text: text.to_string(),
    })
    .await?;
    let outcome = if wait_turn {
        wait::run(
            &mut ws,
            Goal::TurnEnded {
                card,
                seen_busy: false,
            },
            "ターンの終わり",
            Duration::from_secs(timeout_secs),
        )
        .await
    } else {
        // 投げっぱなしにはサーバの応答が無い。確認していないことを受け取り証に明記する
        // （黙って「成功」と読ませない。確かめたければ --wait）
        Ok(receipt("send_input", card))
    };
    ws.close().await;
    outcome
}

/// `session kill`。`Ended` まで待つ。
pub async fn kill(target: &Target, prefix: &str) -> Result<Outcome, ClientError> {
    let card = resolve_card_id(target, prefix).await?;
    let mut ws = ws::Ws::connect(target).await?;
    ws.send(&ClientMessage::Kill { card_id: card }).await?;
    let outcome = wait::run(
        &mut ws,
        Goal::Ended { card },
        "セッションの終了",
        wait::KILL_CAP,
    )
    .await;
    ws.close().await;
    outcome
}

/// `session rm`。`SessionRemoved` まで待つ。
pub async fn archive(target: &Target, prefix: &str) -> Result<Outcome, ClientError> {
    let card = resolve_card_id(target, prefix).await?;
    let mut ws = ws::Ws::connect(target).await?;
    ws.send(&ClientMessage::Archive { card_id: card }).await?;
    let outcome = wait::run(
        &mut ws,
        Goal::Removed { card },
        "カードの取り外し",
        wait::REMOVE_CAP,
    )
    .await;
    ws.close().await;
    outcome
}

/// `session model`。切替要求の印が立ってから消えるまで待つ。
pub async fn set_model(target: &Target, prefix: &str, model: &str) -> Result<Outcome, ClientError> {
    let card = resolve_card_id(target, prefix).await?;
    let mut ws = ws::Ws::connect(target).await?;
    ws.send(&ClientMessage::SetModel {
        card_id: card,
        model: ModelId::new(model),
    })
    .await?;
    let outcome = wait::run(
        &mut ws,
        Goal::ModelApplied {
            card,
            seen_requested: false,
        },
        "モデルの切り替え",
        wait::MODEL_CAP,
    )
    .await;
    ws.close().await;
    outcome
}

/// `session mode`。`permission_mode` が要求した値になるまで待つ。
pub async fn set_mode(target: &Target, prefix: &str, mode: &str) -> Result<Outcome, ClientError> {
    let card = resolve_card_id(target, prefix).await?;
    let requested = PermissionMode::new(mode);
    let mut ws = ws::Ws::connect(target).await?;
    ws.send(&ClientMessage::SetPermissionMode {
        card_id: card,
        mode: requested.clone(),
    })
    .await?;
    let outcome = wait::run(
        &mut ws,
        Goal::ModeApplied {
            card,
            mode: requested,
        },
        "権限モードの切り替え",
        wait::MODE_CAP,
    )
    .await;
    ws.close().await;
    outcome
}

/// `session resize`。待たない（§8-2 の表どおり）。
pub async fn resize(
    target: &Target,
    prefix: &str,
    cols: u16,
    rows: u16,
) -> Result<Outcome, ClientError> {
    let card = resolve_card_id(target, prefix).await?;
    let mut ws = ws::Ws::connect(target).await?;
    ws.send(&ClientMessage::Resize {
        card_id: card,
        cols,
        rows,
    })
    .await?;
    ws.close().await;
    Ok(receipt("resize", card))
}

/// 投げっぱなしの操作の受け取り証。**サーバの応答ではない**——確認していないことが
/// そのまま中身になる（`confirmed: false`）。
fn receipt(operation: &str, card: CardId) -> Outcome {
    Outcome {
        human: format!(
            "送りました（届いたかは確かめていません）：{}",
            output::short_id(&card.to_string())
        ),
        raw: serde_json::json!({
            "sent": operation,
            "card_id": card.to_string(),
            "confirmed": false,
        })
        .to_string(),
    }
}

// ---------------------------------------------------------------------------
// 端末系（CLI設計§9。フェーズ3）
//
// 画面を1枚受け取る・キーを1つ送る、の2つで「画面でしか到達できない操作」を無くす。
// 対話 attach は作らない（方針で決定。1回ごとに終わる形がエージェントには扱いやすい）。
// ---------------------------------------------------------------------------

/// `session screen` の待ちの上限（CLI設計§8-2 の表）。
pub const SCREEN_CAP: Duration = Duration::from_secs(15);

/// `session screen` の持ち帰り。`payload` は届いたままのエスケープ列（`--raw` 用）。
pub struct Screenshot {
    pub card: CardId,
    pub cols: u16,
    pub rows: u16,
    pub payload: Vec<u8>,
}

/// `session screen`（CLI設計§9-1）。いまの画面を1枚だけ受け取る。
///
/// **最初の `0x03`（スナップショット）が届くまで、`0x01`（増分）は読み飛ばす**（§15-3）。
/// 購読し直しのとき、前の購読の増分が新しいスナップショットより先に届くことがある
/// （フェーズ0 で実測）。増分は「画面をリセットしてから書け」の前提を持たないので、
/// 先頭に混ぜると壊れた画面を描く。
///
/// なお `SubPty` は購読と同時に PTY をその大きさへリサイズする（§9-2）。**同じセッションを
/// ブラウザで開いている人の表示幅も変わる**——この副作用は隠さず、`--help` にも書いてある。
pub async fn screen(
    target: &Target,
    prefix: &str,
    cols: u16,
    rows: u16,
) -> Result<Screenshot, ClientError> {
    let card = resolve_card_id(target, prefix).await?;
    let mut ws = ws::Ws::connect(target).await?;
    ws.send(&ClientMessage::SubPty {
        card_id: card,
        cols,
        rows,
    })
    .await?;
    let waited = tokio::time::timeout(SCREEN_CAP, snapshot_after(&mut ws, card))
        .await
        .unwrap_or_else(|_| {
            Err(ClientError::Timeout {
                what: "画面のスナップショット".to_string(),
                secs: SCREEN_CAP.as_secs(),
            })
        });
    ws.close().await;
    let payload = waited?;
    Ok(Screenshot {
        card,
        cols,
        rows,
        payload,
    })
}

/// リモートのカードで「空のリセット」の後に全画面を待つ猶予（CLI設計§20-1）。
///
/// PC は購読を受けてから全画面を出し直すので、丸1往復＋描画のぶんだけ遅れて届く。
/// 本当に空の画面（起きた直後で何も描いていない）はこの猶予を待ち切ってから空を返す。
pub const REMOTE_REDRAW_GRACE: Duration = Duration::from_secs(3);

/// 自カード宛ての**最初のスナップショット（`0x03`）**が届くまで待つ（CLI設計§15-3）。
///
/// それまでの増分（`0x01`）は読み飛ばす——購読し直しのとき、前の購読の増分が新しい
/// スナップショットより先に届くことがある（フェーズ0 で実測）。増分は「画面をリセット
/// してから書け」の前提を持たないので、先頭に混ぜると壊れた画面を描く。
///
/// **最初の `0x03` が空だったら、それは答えではなく前触れである**（CLI設計§20-1）。
/// リモートのカードは「空のリセット→PC が出し直した全画面」の順で届く（サーバは
/// 古い全画面を持たない設計。gateway の `subscribe_pty`）。空でない `0x03` が来たら
/// それが画面。来ないまま猶予が切れたら、リセット後に届いた増分を重ねたもの
/// （何も届いていなければ空）が本当の画面。
///
/// `screen` の中身だが、**この順序（増分が先に届く形・空のリセットが先に来る形）は
/// 本物のサーバでは決定的に作れない**ので、スタブを相手にするテストが直に呼べるよう
/// 口を分けてある。
pub async fn snapshot_after(ws: &mut ws::Ws, card: CardId) -> Result<Vec<u8>, ClientError> {
    let first = first_snapshot(ws, card).await?;
    if !first.is_empty() {
        return Ok(first);
    }
    // 空のリセットだった。猶予の間だけ、出し直しの全画面（空でない 0x03）を待つ
    let grace = tokio::time::sleep(REMOTE_REDRAW_GRACE);
    tokio::pin!(grace);
    let mut accumulated: Vec<u8> = Vec::new();
    loop {
        tokio::select! {
            _ = &mut grace => return Ok(accumulated),
            frame = ws.next_frame() => match frame? {
                ws::WsEvent::Frame { kind, card_id, payload } if card_id == card => {
                    match kind {
                        protocol::frame::FrameKind::PtySnapshot if !payload.is_empty() => {
                            return Ok(payload);
                        }
                        // 空のリセットがまた来たら、重ねた増分も無かったことになる
                        protocol::frame::FrameKind::PtySnapshot => accumulated.clear(),
                        protocol::frame::FrameKind::PtyOutput => {
                            accumulated.extend_from_slice(&payload);
                        }
                        _ => {}
                    }
                }
                ws::WsEvent::Frame { .. } => {}
                ws::WsEvent::Message(ServerMessage::Error { card_id, message })
                    if card_id.is_none() || card_id == Some(card) =>
                {
                    return Err(ClientError::Refused { status: 400, message });
                }
                ws::WsEvent::Message(_) => {}
            }
        }
    }
}

/// 自カード宛ての `0x03` が最初に届くまで読み飛ばす（§15-3 の素の形）。
async fn first_snapshot(ws: &mut ws::Ws, card: CardId) -> Result<Vec<u8>, ClientError> {
    loop {
        match ws.next_frame().await? {
            ws::WsEvent::Frame {
                kind,
                card_id,
                payload,
            } => {
                if card_id == card && kind == protocol::frame::FrameKind::PtySnapshot {
                    return Ok(payload);
                }
                // 自カードの 0x01（前の購読の増分）も、他カードのフレームも読み飛ばす
            }
            ws::WsEvent::Message(ServerMessage::Error { card_id, message })
                if card_id.is_none() || card_id == Some(card) =>
            {
                // 開けないカード（リモートの生バイト経路が無い等）はサーバが理由を言う
                return Err(ClientError::Refused {
                    status: 400,
                    message,
                });
            }
            ws::WsEvent::Message(_) => {}
        }
    }
}

/// `session key`（CLI設計§9-3）。名前を並べた順に `0x02` フレームで送る。待たない（§8-2）
/// ので、返るのは受け取り証——効いたかは `session screen` で見る。
pub async fn send_keys(
    target: &Target,
    prefix: &str,
    names: &[String],
) -> Result<Outcome, ClientError> {
    // 1つでも知らない名前があれば、カードの解決より前に（＝何も送らずに）断る
    let sequence = keys::encode_all(names)?;
    let card = resolve_card_id(target, prefix).await?;
    let mut ws = ws::Ws::connect(target).await?;
    for (index, bytes) in sequence.iter().enumerate() {
        if index > 0 {
            // 2つの書き込みが1回の読み取りにまとまると TUI の受け取り方が変わる（§9-3）
            tokio::time::sleep(keys::KEY_GAP).await;
        }
        ws.send_binary(protocol::frame::encode(
            protocol::frame::FrameKind::PtyInput,
            card,
            bytes,
        ))
        .await?;
    }
    ws.close().await;
    Ok(Outcome {
        human: format!(
            "キーを送りました（届いたかは確かめていません）：{} → {}",
            names.join(" "),
            output::short_id(&card.to_string())
        ),
        raw: serde_json::json!({
            "sent": "key",
            "card_id": card.to_string(),
            "keys": names,
            "confirmed": false,
        })
        .to_string(),
    })
}

/// `transcript --follow` の流れ（CLI設計§3-2）。`next` で追記を1つずつ受け取る。
pub struct Follow {
    ws: ws::Ws,
    card: CardId,
}

/// 追いかけている間に届くもの。
pub enum FollowEvent {
    /// 追記。`raw` は届いた知らせそのまま（`--json` 用。CLI設計§10-2）
    Append {
        nodes: Vec<protocol::TreeNode>,
        raw: String,
    },
    /// 履歴の作り直し。購読開始時にも先頭で1回来る（再購読の冪等化）
    Reset,
}

/// 履歴の購読を開く。閉じるのは [`Follow::close`]（unsub を送ってから切る）。
pub async fn follow(target: &Target, prefix: &str) -> Result<Follow, ClientError> {
    let card = resolve_card_id(target, prefix).await?;
    let mut ws = ws::Ws::connect(target).await?;
    ws.send(&ClientMessage::SubTranscript { card_id: card })
        .await?;
    Ok(Follow { ws, card })
}

impl Follow {
    /// 次の追記か作り直しを待つ。**上限は置かない**——開きっぱなしが仕様で、
    /// 止めるのは利用者の Ctrl+C（cli.rs 側が受ける）。
    pub async fn next(&mut self) -> Result<FollowEvent, ClientError> {
        loop {
            let message = self.ws.next_event().await?;
            match &message {
                ServerMessage::TranscriptAppend { card_id, nodes } if *card_id == self.card => {
                    let raw = serde_json::to_string(&message)
                        .expect("受け取れた知らせは必ず JSON へ戻せる");
                    return Ok(FollowEvent::Append {
                        nodes: nodes.clone(),
                        raw,
                    });
                }
                ServerMessage::TranscriptReset { card_id } if *card_id == self.card => {
                    return Ok(FollowEvent::Reset);
                }
                ServerMessage::Error { card_id, message }
                    if card_id.is_none() || *card_id == Some(self.card) =>
                {
                    return Err(ClientError::Refused {
                        status: 400,
                        message: message.clone(),
                    });
                }
                _ => {}
            }
        }
    }

    pub async fn close(self) {
        self.ws.close().await;
    }
}

/// `project add`（`POST /api/projects`）。
pub async fn project_add(
    target: &Target,
    host: &str,
    path: &str,
) -> Result<(server_core::projects::AddResponse, String), ClientError> {
    let body = serde_json::json!({ "host": host, "path": path }).to_string();
    let raw = write_ok(target, "POST", "/api/projects", Some(body)).await?;
    let parsed = serde_json::from_str(&raw).map_err(|err| ClientError::Refused {
        status: 200,
        message: format!("追加の応答を読めません（{err}）"),
    })?;
    Ok((parsed, raw))
}

/// `project rm`（`DELETE /api/projects/{id}`）。ID は枠の一覧から前方一致で解決する。
pub async fn project_remove(target: &Target, prefix: &str) -> Result<String, ClientError> {
    let (list, _) = projects(target).await?;
    let ids: Vec<String> = list.iter().map(|view| view.id.to_string()).collect();
    let borrowed: Vec<&str> = ids.iter().map(String::as_str).collect();
    let id = match output::resolve_prefix(prefix, &borrowed) {
        Ok(id) => id.to_string(),
        Err(output::PrefixError::NotFound) => {
            return Err(ClientError::Refused {
                status: 404,
                message: format!(
                    "`{prefix}` に当たる PJT 枠は見つかりません。一覧は `agentdashboard project ls`"
                ),
            });
        }
        Err(output::PrefixError::Ambiguous(hits)) => {
            return Err(ClientError::Refused {
                status: 409,
                message: format!(
                    "`{prefix}` は複数の枠に当たります。どれかまで打ってください：\n  {}",
                    hits.join("\n  ")
                ),
            });
        }
    };
    write_ok(target, "DELETE", &format!("/api/projects/{id}"), None).await?;
    Ok(id)
}

/// `settings set` の本文を組み立てる（CLI設計§12-1）。**触った1項目だけ**を持つ JSON。
///
/// 純関数にしてあるのは「1項目だけが載っている」ことを机の上で確かめるため。
/// 知らないキー・読めない値は、受け付ける形の一覧を添えて断る（引数の誤り＝exit 2 の族）。
pub fn settings_update_body(key: &str, value: &str) -> Result<String, String> {
    const BOOL_KEYS: [&str; 2] = ["always_bypass_permissions", "project_autostart_session"];
    const NUMBER_KEYS: [&str; 3] = [
        "sync_interval_secs",
        "screen_interval_ms",
        "scrollback_lines",
    ];
    let listing = "受け付けるキー：always_bypass_permissions / project_autostart_session（true・false）、sync_interval_secs / screen_interval_ms / scrollback_lines（数値）、lan_password（文字列）";
    let json_value = if BOOL_KEYS.contains(&key) {
        match value {
            "true" => serde_json::Value::Bool(true),
            "false" => serde_json::Value::Bool(false),
            other => {
                return Err(format!(
                    "`{key}` の値は true か false です（`{other}` は読めません）"
                ));
            }
        }
    } else if NUMBER_KEYS.contains(&key) {
        let number: u64 = value
            .parse()
            .map_err(|_| format!("`{key}` の値は数値です（`{value}` は読めません）"))?;
        serde_json::Value::Number(number.into())
    } else if key == "lan_password" {
        serde_json::Value::String(value.to_string())
    } else {
        return Err(format!("`{key}` というキーは知りません。{listing}"));
    };
    Ok(serde_json::json!({ key: json_value }).to_string())
}

/// `settings set`（`PUT /api/settings`）。応答は更新後の設定（解釈せずそのまま返す）。
pub async fn settings_set(target: &Target, body: String) -> Result<String, ClientError> {
    write_ok(target, "PUT", "/api/settings", Some(body)).await
}

/// `settings export`。サーバが作った持ち出しファイルの中身をそのまま返す。
pub async fn settings_export(target: &Target) -> Result<String, ClientError> {
    http::fetch_ok(target, "/api/settings/export").await
}

/// `settings import`（`POST /api/settings/import`）。本文は生のまま渡す——検査も
/// 「全部通るか、1つも入れないか」もサーバの仕事（持ち出し設計）。
pub async fn settings_import(target: &Target, body: String) -> Result<String, ClientError> {
    write_ok(target, "POST", "/api/settings/import", Some(body)).await
}

/// `version select`（`PUT /api/versions/selected`）。**予約であって、その瞬間には
/// 何も起きない**（CICD設計）。428 は「確かめられないが、明示すれば進める」の合図なので、
/// 進め方（`--confirm-unverified`）を添えて断る。
pub async fn version_select(
    target: &Target,
    version: &str,
    confirm_unverified: bool,
) -> Result<String, ClientError> {
    let body = serde_json::json!({
        "version": version,
        "confirm_unverified": confirm_unverified,
    })
    .to_string();
    let (status, text) = http::request(target, "PUT", "/api/versions/selected", Some(body)).await?;
    if status == 428 {
        return Err(ClientError::Refused {
            status,
            message: format!(
                "{}\n進めてよければ `--confirm-unverified` を付けてください",
                text.trim()
            ),
        });
    }
    if (200..300).contains(&status) {
        Ok(text)
    } else {
        Err(ClientError::from_status(status, text))
    }
}

/// `version unselect`（`DELETE /api/versions/selected`）。
pub async fn version_unselect(target: &Target) -> Result<String, ClientError> {
    write_ok(target, "DELETE", "/api/versions/selected", None).await
}

/// `version install`（`POST /api/versions/{版}/install`）。202＝背景で走る。
pub async fn version_install(target: &Target, version: &str) -> Result<String, ClientError> {
    let path = format!("/api/versions/{}/install", http::percent_encode(version));
    write_ok(target, "POST", &path, None).await
}

/// `version rm`（`DELETE /api/versions/{版}`）。
pub async fn version_remove(target: &Target, version: &str) -> Result<String, ClientError> {
    let path = format!("/api/versions/{}", http::percent_encode(version));
    write_ok(target, "DELETE", &path, None).await
}

/// `version restart` の門：**生きたカード（終了していないもの）の数**。
///
/// 画面が出している `stranded_cards` を使わないのは、あちらが「接続中のカード」を
/// 数えるため——ローカルモードでは**終了済みの抜け殻まで**入ってしまい、守る相手が
/// 居ないのに止まる道具になる。落とすと道連れになるのは走っている claude だけなので、
/// `積み残し_運用` 項目11 の言葉どおり「生きたカード」で数える。
pub async fn alive_cards(target: &Target) -> Result<Vec<String>, ClientError> {
    let (list, _) = sessions(target).await?;
    Ok(list
        .iter()
        .filter(|meta| !matches!(meta.status, protocol::SessionStatus::Ended { .. }))
        .map(|meta| meta.card_id.to_string())
        .collect())
}

/// `version restart`（`POST /api/versions/restart`）。
///
/// **数えた結果で実際に止まる**（PJTガイドライン「現物の状態を数えるとき」）。
/// ローカルモードでは落とすと走っている claude が道連れになるため、生きたカードが
/// 1枚でもあれば件数を言って止まり、`force` のときだけ生きたまま落とす。
/// 判定の実装をここ1箇所に集めるのが `積み残し_運用` 項目11 の求めていた形。
pub async fn version_restart(target: &Target, force: bool) -> Result<String, ClientError> {
    if !force {
        let alive = alive_cards(target).await?;
        if !alive.is_empty() {
            let ids: Vec<&str> = alive
                .iter()
                .map(|id| output::short_id(id.as_str()))
                .collect();
            return Err(ClientError::Refused {
                status: 409,
                message: format!(
                    "生きたセッションが {} 本あります（{}）。落とすと道連れになります。それでも落とすなら --force",
                    alive.len(),
                    ids.join(", ")
                ),
            });
        }
    }
    write_ok(target, "POST", "/api/versions/restart", None).await
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
    fn 札と接続先の環境変数は箱へ転送される接頭辞を避けている() {
        // `scripts/cargo` は `AGENTDASHBOARD_*` を丸ごとビルドの箱へ転送する（CLI設計§5-4）。
        // その名前にすると、開発者が手元で export した札がテストにも製品の経路にも混ざる。
        // 定数を変えた人がこの罠に気づけるよう、名前そのものを機械で見張る
        assert!(
            !SERVER_ENV.starts_with("AGENTDASHBOARD"),
            "実際: {SERVER_ENV}"
        );
        assert!(
            !TOKEN_ENV.starts_with("AGENTDASHBOARD"),
            "実際: {TOKEN_ENV}"
        );
    }

    #[test]
    fn 札は接続先のデバッグ表示に写らない() {
        // `{:?}` はエラーメッセージやログへそのまま流れうる。札の平文が紛れ込む
        // 経路を作らない（CLI設計§5-4「ファイルへは保存しない」と同じ守り）
        let target = Target::from_url("http://127.0.0.1:8787")
            .expect("読めること")
            .with_token(Some("adp_himitsu".to_string()));
        let debug = format!("{target:?}");
        assert!(!debug.contains("adp_himitsu"), "実際: {debug}");
    }

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
        // 言い分けると ID の総当たりで「存在する」ことだけを調べられる（CLI設計§6-4）。
        // **こちらから言い添える言葉が1つ**であることを見る——本文が空なら同じ言葉になる
        let forbidden = ClientError::from_status(403, String::new()).to_string();
        let missing = ClientError::from_status(404, String::new()).to_string();
        assert_eq!(forbidden, missing);
        // サーバが同じ本文を返す組（保護された資源への総当たり）は、通しても同じ言葉のまま
        let with_body_a = ClientError::from_status(403, "見つかりません".to_string()).to_string();
        let with_body_b = ClientError::from_status(404, "見つかりません".to_string()).to_string();
        assert_eq!(with_body_a, with_body_b);
    }

    #[test]
    fn サーバが理由を言っている断りはそのまま通る() {
        // 版や設定の 403 は「なぜ駄目か」を本文で言う（例：127.0.0.1 からだけ）。
        // こちらの一言で上書きすると、次の一手が分からなくなる（フェーズ2 の精緻化）
        let text = ClientError::from_status(
            403,
            "版の切り替えは管理者のアカウントだけができます".to_string(),
        )
        .to_string();
        assert!(
            text.contains("管理者のアカウント"),
            "理由が消えている: {text}"
        );
    }

    #[test]
    fn 記録が応じないときはその旨が言葉になる() {
        let text = ClientError::from_status(503, String::new()).to_string();
        assert!(text.contains("いま記録を読めません"), "言葉が違う: {text}");
    }

    // --- settings set の本文（テスト計画F3「設定・版・アカウント」の単体側） ---

    #[test]
    fn 設定の本文は触った一項目だけを持つ() {
        // **触っていない項目が混ざると、別のタブで変えた値を巻き戻す**（設計§12-1）。
        // 1項目だけであることを、キーの数そのもので確かめる
        let body = settings_update_body("sync_interval_secs", "60").expect("組めること");
        let value: serde_json::Value = serde_json::from_str(&body).expect("JSON であること");
        let object = value.as_object().expect("オブジェクトであること");
        assert_eq!(object.len(), 1, "触っていない項目が混ざっている: {body}");
        assert_eq!(object["sync_interval_secs"], 60);
    }

    #[test]
    fn 知らない設定キーは受け付ける一覧を添えて断られる() {
        let err = settings_update_body("そんなキー", "1").expect_err("断られること");
        assert!(err.contains("受け付けるキー"), "一覧が無い: {err}");
    }

    #[test]
    fn トグルの値が読めなければ直し方つきで断られる() {
        let err =
            settings_update_body("always_bypass_permissions", "yes").expect_err("断られること");
        assert!(err.contains("true か false"), "直し方が無い: {err}");
    }
}
