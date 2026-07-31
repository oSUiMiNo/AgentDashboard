//! ブラウザの入口にかける鍵（セルフホスト化設計§8-1〜§8-3）。
//!
//! # 3通りの鍵を1つの型で表す
//!
//! 設計§8-1 は経路ごとに表で書いているが、実装では [`AuthMode`] 1つに畳んである。
//!
//! | 動かし方 | モード | 誰として通るか |
//! |---|---|---|
//! | ローカル・127.0.0.1 だけ | [`AuthMode::Open`] | いつでも「ローカル」アカウント |
//! | ローカル・LAN 開放 | [`AuthMode::LanPassword`] | 共有パスワードを通った人（127.0.0.1 は免除） |
//! | セルフホスト | [`AuthMode::Account`] | ログインしたアカウント |
//!
//! 判定を1箇所に集めるのは、**enforcement が「漏れなく総当たり」を要求している**ため
//! （§8-6）。経路ごとに条件を書くと、REST・WS・アカウント画面の3箇所で必ず食い違う。
//! ここを通らずに答えを出す道を作らないこと自体が担保になっている。
//!
//! # 免除は接続そのもので決める
//!
//! 127.0.0.1 からのアクセスを常に通すのは、ローカルモードが直結を前提にしているから
//! （§8-3）。判定材料は**ピアアドレス**で、`X-Forwarded-For` は読まない——読むと
//! 偽装ヘッダ1行で LAN の鍵が無効になる。
//!
//! # 通っていないことは 401 で返す
//!
//! 画面（web アセット）は誰にでも返す。中身のある口だけを 401 で断り、
//! `/login` へ誘導するのはブラウザ側の仕事にしてある。HTML を差し替えて返すと、
//! 「ログイン画面が出た」と「API が失敗した」を利用者が区別できなくなる。

use crate::{
    config::ServerConfig,
    db::{self, entity, web_session_store::DbSessionStore},
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter,
};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc};
use tower_sessions::{Expiry, Session, SessionManagerLayer, cookie::SameSite};
use uuid::Uuid;

/// ログイン中のアカウントを覚えておくキー。
const SESSION_ACCOUNT_KEY: &str = "account_id";
/// LAN のパスワードを通ったことを覚えておくキー。
const SESSION_LAN_KEY: &str = "lan";

/// 入口の鍵のかけ方（設計§8-1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    /// 鍵なし。ローカルモードで 127.0.0.1 だけを待ち受けている状態
    Open,
    /// LAN 開放時の共有パスワード1本（§8-3）
    LanPassword,
    /// アカウントログイン（§8-2）
    Account,
}

/// 通った相手。**ここから先の絞り込みはすべてこの `account_id` で行う**（§8-6）。
#[derive(Debug, Clone)]
pub struct Identity {
    pub account_id: Uuid,
    pub name: String,
    pub is_admin: bool,
    /// 接続元が 127.0.0.1 か。
    ///
    /// LAN パスワードの登録欄を出してよいか（§8-3「127.0.0.1 からアクセスした設定画面で
    /// 登録する」）の判断に使う。**免除の判断とは別に、画面の出し分けにも要る。**
    pub from_loopback: bool,
}

/// 鍵の持ち主。ルータと middleware が共有する。
pub struct AuthContext {
    pub mode: AuthMode,
    db: DatabaseConnection,
    lan_session_ttl_hours: u64,
    /// Cookie セッションの層。**ここで1つだけ作る**——組み立てのたびに作ると、
    /// 期限切れの掃除タスクがルータの数だけ立つ
    sessions: SessionManagerLayer<DbSessionStore>,
}

impl AuthContext {
    /// ローカルモードの鍵。**待ち受けの広さでモードが決まる**（§8-3）。
    pub fn local(db: DatabaseConnection, config: &ServerConfig) -> Arc<Self> {
        let mode = if config.reachable_from_lan() {
            AuthMode::LanPassword
        } else {
            AuthMode::Open
        };
        Self::build(mode, db, config)
    }

    /// セルフホストの鍵。**待ち受けの広さでは変わらない**——0.0.0.0 が正常形で、
    /// 鍵はアカウントのほうが持つ（§8-3 が LAN の検査から除外している理由）。
    pub fn server(db: DatabaseConnection, config: &ServerConfig) -> Arc<Self> {
        Self::build(AuthMode::Account, db, config)
    }

    fn build(mode: AuthMode, db: DatabaseConnection, config: &ServerConfig) -> Arc<Self> {
        Arc::new(Self {
            mode,
            sessions: session_layer(db.clone(), config),
            db,
            lan_session_ttl_hours: config.lan_session_ttl_hours,
        })
    }

    pub fn db(&self) -> &DatabaseConnection {
        &self.db
    }

    /// この接続を誰として扱うか。通っていなければ `None`。
    async fn identify(&self, session: &Session, from_loopback: bool) -> Option<Identity> {
        match self.mode {
            AuthMode::Open => Some(self.local_identity(from_loopback)),
            AuthMode::LanPassword => {
                // **127.0.0.1 は常に免除**（§8-3）。直結で使っている本人を締め出さない
                if from_loopback || session.get::<bool>(SESSION_LAN_KEY).await.ok()? == Some(true) {
                    Some(self.local_identity(from_loopback))
                } else {
                    None
                }
            }
            AuthMode::Account => {
                let account_id = session.get::<Uuid>(SESSION_ACCOUNT_KEY).await.ok()??;
                // **毎回 DB を引く。** 消された・パスワードを外されたアカウントの
                // 入館証が、Cookie の期限まで生き残ってはいけない
                let row = entity::accounts::Entity::find_by_id(account_id)
                    .one(&self.db)
                    .await
                    .ok()??;
                row.password_hash.as_ref()?;
                Some(Identity {
                    account_id: row.id,
                    name: row.name,
                    is_admin: row.is_admin,
                    from_loopback,
                })
            }
        }
    }

    /// ローカルモードで通った相手。アカウントという単位が無いので、常に同じ1つ。
    fn local_identity(&self, from_loopback: bool) -> Identity {
        Identity {
            account_id: db::LOCAL_ACCOUNT_ID,
            name: db::LOCAL_ACCOUNT_NAME.to_string(),
            is_admin: false,
            from_loopback,
        }
    }

    /// `/setup` がまだ開いているか（§21 読み替え6）。
    ///
    /// 「accounts が空」ではなく「**パスワードを持つアカウントが無い**」で判定する。
    /// トークン発行の CLI がアカウント行を作るので、空で判定すると `/setup` が
    /// 永久に閉じる（`password_hash` が `None` ＝ログインできない、が §20 読み替え3）。
    async fn setup_open(&self) -> bool {
        entity::accounts::Entity::find()
            .filter(entity::accounts::Column::PasswordHash.is_not_null())
            .count(&self.db)
            .await
            .map(|count| count == 0)
            // 読めないときは閉じておく。開く側に倒すと、DB が不調なだけで
            // 誰でも管理者を作れることになる
            .unwrap_or(false)
    }
}

/// Cookie の読み書きを**全部の口の外側**にかける。
///
/// 内側に置くと、鍵の判定（[`require_identity`]）が Cookie を読む前に走ることになる。
/// 呼ぶ側が層を持ち回らずに済むよう、鍵と一緒に取り出せる形にしてある。
pub fn with_sessions(router: Router, auth: &Arc<AuthContext>) -> Router {
    router.layer(auth.sessions.clone())
}

/// Cookie セッションの層（設計§8-2）。
///
/// `SameSite=Lax` と `HttpOnly` は固定。`Secure` だけ設定にしてあるのは、平文で動かす
/// 手元と LAN では**付けた瞬間に Cookie が送られなくなる**ため（§13-2 の `cookie_secure`）。
fn session_layer(
    db: DatabaseConnection,
    config: &ServerConfig,
) -> SessionManagerLayer<DbSessionStore> {
    let store = DbSessionStore::new(db);
    // 期限切れの掃除（フェーズ2 で作って呼び出していなかったもの）。ログインを
    // 結線するここが呼び出し場所になる——掃除しないと行が増え続ける
    store.start_sweeper();
    SessionManagerLayer::new(store)
        .with_name("agentdashboard.sid")
        .with_http_only(true)
        .with_same_site(SameSite::Lax)
        .with_secure(config.cookie_secure)
        .with_expiry(Expiry::OnInactivity(time::Duration::hours(
            config.lan_session_ttl_hours as i64,
        )))
}

/// 鍵のかかっていない口（設計§8-2）。**ここだけは通らずに叩ける。**
///
/// `/api/me` を開けておくのは、ブラウザが「何を出すべきか」を知る手段がこれしか無いため
/// （ログイン画面か、セットアップ画面か、そのまま一覧か）。認証の要否を知るのに
/// 認証が要る、という循環を作らない。
pub fn routes(auth: Arc<AuthContext>) -> Router {
    Router::new()
        .route("/api/me", get(api_me))
        .route("/api/login", post(api_login))
        .route("/api/logout", post(api_logout))
        .route("/api/setup", post(api_setup))
        .with_state(auth)
}

/// 通っていなければ 401 で断り、通っていれば [`Identity`] を持たせて先へ渡す。
pub async fn require_identity(
    State(auth): State<Arc<AuthContext>>,
    session: Session,
    mut request: Request,
    next: Next,
) -> Response {
    let from_loopback = peer_is_loopback(&request);
    let Some(identity) = auth.identify(&session, from_loopback).await else {
        return (StatusCode::UNAUTHORIZED, "ログインが必要です").into_response();
    };
    request.extensions_mut().insert(identity);
    next.run(request).await
}

/// 接続元が 127.0.0.1 か（§8-3）。
///
/// 見るのは**接続そのもの**で、ヘッダは一切読まない。`ConnectInfo` が入っていない
/// （＝接続元を渡さない形で待ち受けている）ときは `false` に倒す——分からないものを
/// 免除すると、免除の条件を満たせない環境でだけ鍵が外れることになる。
fn peer_is_loopback(request: &Request) -> bool {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|ConnectInfo(addr)| addr.ip().is_loopback())
}

/// `GET /api/me` の応答。画面はこれを見て出すものを決める。
#[derive(Debug, Serialize)]
pub struct AuthView {
    pub mode: AuthMode,
    pub authenticated: bool,
    /// 通っている相手の名前。ローカルモードでは出さない（アカウントを表に出さない）
    pub account: Option<String>,
    pub is_admin: bool,
    /// `/setup` がまだ開いているか
    pub setup_open: bool,
    /// 接続元が 127.0.0.1 か（LAN パスワードの登録欄を出すかの判断）
    pub from_loopback: bool,
}

async fn api_me(
    State(auth): State<Arc<AuthContext>>,
    session: Session,
    request: Request,
) -> Json<AuthView> {
    let from_loopback = peer_is_loopback(&request);
    let identity = auth.identify(&session, from_loopback).await;
    Json(AuthView {
        mode: auth.mode,
        authenticated: identity.is_some(),
        account: identity
            .as_ref()
            .filter(|_| auth.mode == AuthMode::Account)
            .map(|identity| identity.name.clone()),
        is_admin: identity.as_ref().is_some_and(|identity| identity.is_admin),
        setup_open: auth.mode == AuthMode::Account && auth.setup_open().await,
        from_loopback,
    })
}

/// `POST /api/login` の本文。
///
/// LAN 開放は共有パスワード1本なので `name` を持たない（§8-1 の表）。
#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    #[serde(default)]
    pub name: Option<String>,
    pub password: String,
}

async fn api_login(
    State(auth): State<Arc<AuthContext>>,
    session: Session,
    Json(request): Json<LoginRequest>,
) -> Result<Json<AuthView>, (StatusCode, String)> {
    match auth.mode {
        // 鍵が無いのだから、開ける必要も無い。「成功した」と嘘をつくより、
        // ログインという概念が無いことを言う
        AuthMode::Open => Err((
            StatusCode::BAD_REQUEST,
            "この構成にログインはありません".to_string(),
        )),
        AuthMode::LanPassword => login_lan(&auth, &session, &request.password).await,
        AuthMode::Account => {
            let name = request.name.unwrap_or_default();
            login_account(&auth, &session, &name, &request.password).await
        }
    }
}

async fn login_lan(
    auth: &Arc<AuthContext>,
    session: &Session,
    password: &str,
) -> Result<Json<AuthView>, (StatusCode, String)> {
    let Some(hash) = db::settings::lan_password_hash(&auth.db)
        .await
        .map_err(backend_error)?
    else {
        // 起動時検査（[`ensure_lan_password`]）を通っていればここへは来ない
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "LAN のパスワードが設定されていません".to_string(),
        ));
    };
    if !verify(password.to_string(), hash).await {
        return Err(wrong_credentials());
    }

    // **通ったら ID を振り直す。** 入る前に持たされた Cookie をそのまま使い続けると、
    // 先に ID を仕込んでおいた相手がログイン後の入館証を手に入れられる
    session.cycle_id().await.map_err(session_error)?;
    session
        .insert(SESSION_LAN_KEY, true)
        .await
        .map_err(session_error)?;
    // LAN の入館証だけは短い（既定5時間。§8-3）。共有の1本なので、
    // 入りっぱなしにできると端末を持っている限り誰でも入れる
    session.set_expiry(Some(Expiry::OnInactivity(time::Duration::hours(
        auth.lan_session_ttl_hours as i64,
    ))));

    Ok(Json(AuthView {
        mode: auth.mode,
        authenticated: true,
        account: None,
        is_admin: false,
        setup_open: false,
        from_loopback: false,
    }))
}

async fn login_account(
    auth: &Arc<AuthContext>,
    session: &Session,
    name: &str,
    password: &str,
) -> Result<Json<AuthView>, (StatusCode, String)> {
    let row = entity::accounts::Entity::find()
        .filter(entity::accounts::Column::Name.eq(name))
        .one(&auth.db)
        .await
        .map_err(backend_error)?;

    // **名前が無い場合とパスワードが違う場合を呼び分けない。** 分けると、どの名前が
    // 実在するかを総当たりで調べられる
    let Some(row) = row else {
        return Err(wrong_credentials());
    };
    let Some(hash) = row.password_hash.clone() else {
        // トークン発行の CLI が作った、パスワードを持たないアカウント（§20 読み替え3）
        return Err(wrong_credentials());
    };
    if !verify(password.to_string(), hash).await {
        return Err(wrong_credentials());
    }

    session.cycle_id().await.map_err(session_error)?;
    session
        .insert(SESSION_ACCOUNT_KEY, row.id)
        .await
        .map_err(session_error)?;

    Ok(Json(AuthView {
        mode: auth.mode,
        authenticated: true,
        account: Some(row.name),
        is_admin: row.is_admin,
        setup_open: false,
        from_loopback: false,
    }))
}

async fn api_logout(
    State(auth): State<Arc<AuthContext>>,
    session: Session,
) -> Result<Json<AuthView>, (StatusCode, String)> {
    // 印を消すのではなく**行ごと捨てる**。消し忘れたキーが残ると、
    // 「ログアウトしたのに何かの権利だけ残る」という追いにくい状態になる
    session.flush().await.map_err(session_error)?;
    Ok(Json(AuthView {
        mode: auth.mode,
        authenticated: false,
        account: None,
        is_admin: false,
        setup_open: auth.mode == AuthMode::Account && auth.setup_open().await,
        from_loopback: false,
    }))
}

/// `POST /api/setup` の本文。
#[derive(Debug, Deserialize)]
pub struct SetupRequest {
    pub name: String,
    pub password: String,
}

/// 最初の管理者を作る（設計§8-2）。
///
/// 環境変数で注入させないのは「compose up → ブラウザを開く」の動線を短くするため
/// （要件6-2 の5分目標）。**1件でも作られたら閉じる**ので、開いている窓は最初の一度きり。
async fn api_setup(
    State(auth): State<Arc<AuthContext>>,
    session: Session,
    Json(request): Json<SetupRequest>,
) -> Result<Json<AuthView>, (StatusCode, String)> {
    if auth.mode != AuthMode::Account {
        return Err((
            StatusCode::BAD_REQUEST,
            "この構成にアカウントはありません".to_string(),
        ));
    }
    if !auth.setup_open().await {
        // 閉じたことを隠さない。閉じているのに 404 を返すと、URL を間違えたのかと
        // 探し回ることになる
        return Err((
            StatusCode::CONFLICT,
            "管理者は既に作られています".to_string(),
        ));
    }
    let name = request.name.trim();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "名前を入れてください".to_string()));
    }
    check_password_strength(&request.password)?;

    let hash = generate(request.password).await;
    // **既にある名前ならパスワードを付けるだけ。** トークン発行の CLI が先に作った
    // 行（`password_hash` が `None`）を、後からログインできるようにする経路がこれ。
    // 別の行を作ると、そのトークンで繋いだ PC のカードが管理者から見えなくなる
    let existing = entity::accounts::Entity::find()
        .filter(entity::accounts::Column::Name.eq(name))
        .one(&auth.db)
        .await
        .map_err(backend_error)?;

    let account_id = match existing {
        Some(row) => {
            entity::accounts::Entity::update_many()
                .col_expr(
                    entity::accounts::Column::PasswordHash,
                    sea_orm::sea_query::Expr::value(hash),
                )
                .col_expr(
                    entity::accounts::Column::IsAdmin,
                    sea_orm::sea_query::Expr::value(true),
                )
                .filter(entity::accounts::Column::Id.eq(row.id))
                .exec(&auth.db)
                .await
                .map_err(backend_error)?;
            row.id
        }
        None => {
            let id = Uuid::new_v4();
            entity::accounts::Entity::insert(entity::accounts::ActiveModel {
                id: Set(id),
                name: Set(name.to_string()),
                password_hash: Set(Some(hash)),
                is_admin: Set(true),
                created_at: Set(db::now_ms()),
            })
            .exec(&auth.db)
            .await
            .map_err(backend_error)?;
            id
        }
    };

    // 作った本人はそのまま入れる。ここでログイン画面へ送り返すと、
    // 決めたばかりのパスワードを打ち直させることになる
    session.cycle_id().await.map_err(session_error)?;
    session
        .insert(SESSION_ACCOUNT_KEY, account_id)
        .await
        .map_err(session_error)?;

    Ok(Json(AuthView {
        mode: auth.mode,
        authenticated: true,
        account: Some(name.to_string()),
        is_admin: true,
        setup_open: false,
        from_loopback: false,
    }))
}

/// LAN のパスワードを登録する（設計§8-3）。設定画面から呼ばれる。
///
/// 入館証を全部捨てるのは利用者判断。変える動機はたいてい「漏れたかもしれない」なので、
/// 変えても居座られては意味が無い。
pub async fn set_lan_password(
    db: &DatabaseConnection,
    password: &str,
) -> Result<(), (StatusCode, String)> {
    check_password_strength(password)?;
    let hash = generate(password.to_string()).await;
    db::settings::put(
        db,
        db::SERVER_SCOPE_ID,
        db::settings::LAN_PASSWORD_HASH,
        serde_json::json!(hash),
    )
    .await
    .map_err(backend_error)?;
    DbSessionStore::delete_all(db)
        .await
        .map_err(backend_error)?;
    Ok(())
}

/// LAN のパスワードが登録されているか。
pub async fn lan_password_set(db: &DatabaseConnection) -> bool {
    db::settings::lan_password_hash(db)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// 起動してよいかを確かめる（設計§8-3）。
///
/// **ローカルモードで待ち受けを広げるなら、先に鍵が要る。** 「鍵なしで開ける事故を
/// 仕組みで防ぐ」（要件1-1）の実装点がここで、警告ではなく起動そのものを止める——
/// 警告は読まれないことがあるし、読まれたときには既に開いている。
///
/// セルフホストは対象外。0.0.0.0 が正常形で、鍵はアカウントのほうが持つ。
pub async fn ensure_lan_password(
    db: &DatabaseConnection,
    config: &ServerConfig,
) -> anyhow::Result<()> {
    if !config.reachable_from_lan() || lan_password_set(db).await {
        return Ok(());
    }
    anyhow::bail!(
        "{} で待ち受ける設定ですが、LAN のパスワードが登録されていません。\n\
         鍵の無いまま開けると、同じネットワークの誰でもセッションを操作できます。\n\
         いったん bind_addr を 127.0.0.1 に戻して起動し、設定画面（http://127.0.0.1:{}/settings）で\n\
         LAN パスワードを登録してから開き直してください。",
        config.bind_addr,
        config.port
    );
}

/// パスワードとして受け付ける最小の長さ（文字数）。
///
/// 桁数以外の条件（記号を混ぜる等）を課さないのは、**課すと使い回しを誘発する**ため。
/// 長さだけを求めるのが現在の推奨（OWASP）で、強度は `password-auth` の argon2id が担う。
const MIN_PASSWORD_CHARS: usize = 8;

fn check_password_strength(password: &str) -> Result<(), (StatusCode, String)> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("パスワードは{MIN_PASSWORD_CHARS}文字以上にしてください"),
        ));
    }
    Ok(())
}

/// argon2id のハッシュを作る。**専用のスレッドへ逃がす。**
///
/// 意図的に遅い処理（100ms 前後）なので、async の上で直接回すと、その間このワーカーの
/// 上にある全部——端末の配信も履歴の書き込みも——が止まる。
async fn generate(password: String) -> String {
    tokio::task::spawn_blocking(move || password_auth::generate_hash(password))
        .await
        .expect("ハッシュ計算のスレッドが落ちないこと")
}

async fn verify(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || password_auth::verify_password(password, &hash).is_ok())
        .await
        .unwrap_or(false)
}

/// 認証の失敗は**理由を分けない**（総当たりに手掛かりを与えない）。
fn wrong_credentials() -> (StatusCode, String) {
    (
        StatusCode::UNAUTHORIZED,
        "名前かパスワードが違います".to_string(),
    )
}

fn backend_error(err: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!("認証のために記録を読めません: {err}");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "記録を読めません".to_string(),
    )
}

fn session_error(err: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!("ログインセッションを書けません: {err}");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "ログインの状態を保存できません".to_string(),
    )
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 短すぎるパスワードは断る() {
        assert!(check_password_strength("1234567").is_err());
        assert!(check_password_strength("12345678").is_ok());
        // 文字数で数える。日本語8文字は 24 バイトだが、利用者から見れば8文字
        assert!(check_password_strength("あいうえおかきく").is_ok());
        assert!(check_password_strength("あいうえおかき").is_err());
    }

    #[tokio::test]
    async fn 作ったハッシュは同じパスワードだけを通す() {
        let hash = generate("ただしいあいことば".to_string()).await;
        assert!(verify("ただしいあいことば".to_string(), hash.clone()).await);
        assert!(!verify("ちがうあいことば".to_string(), hash.clone()).await);
        // 平文がそのまま入っていないこと（ログや DB を覗かれても読めない）
        assert!(!hash.contains("ただしいあいことば"), "実際: {hash}");
        assert!(hash.starts_with("$argon2"), "実際: {hash}");
    }

    #[tokio::test]
    async fn 同じパスワードでもハッシュは毎回違う() {
        // ソルトが効いていること。同じなら、1つ割れた瞬間に同じパスワードの
        // 利用者が全員割れる
        let first = generate("おなじあいことば".to_string()).await;
        let second = generate("おなじあいことば".to_string()).await;
        assert_ne!(first, second);
        assert!(verify("おなじあいことば".to_string(), first).await);
        assert!(verify("おなじあいことば".to_string(), second).await);
    }
}
