//! 利用者の PC のフォルダとファイルを引く REST の口（イシューグループ_2026_0805_0514 設計§10）。
//!
//! # なぜ WebSocket ではないのか
//!
//! あちらは「起きたことを配る線」で、これは「聞いて答える線」である。性質の違うものを
//! 1本に混ぜると、片方の遅れがもう片方を引きずる（セルフホスト化フェーズ6 で実際に踏んだ）。
//! 履歴のページングが既に REST なので、並びも揃う。
//!
//! # 断り方を1か所に集める
//!
//! 状態コードの写しは [`status_of`] だけが持つ。経路ごとに書くと、**同じ失敗が口に
//! よって違うコードになる**——利用者から見ると「たまに動く」になり、原因へ辿れない。

use crate::{
    auth::Identity,
    session_host::{HostAskError, HostAskRequest},
    ws::AppState,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse as _,
};
use protocol::{AgentId, a2s::HostFailure, fs::DirListing};

/// ローカルモードの `{host}`。
///
/// `SettingsView.model_tables` のキーが既にこの綴りを使っているので揃える（設計§10）。
pub const LOCAL_HOST: &str = "local";

/// `?path=…`。**フォルダの一覧では省略できる**（省略＝その PC のホーム。設計§26-2）。
#[derive(Debug, serde::Deserialize)]
pub struct DirQuery {
    pub path: Option<String>,
}

/// `?path=…&as=…`。中身の読み取りには「始まり」が無いので `path` は**必須**。
///
/// `as` を `Option<String>` で受けるのは [`LogsQuery`] と同じ理由である。列挙で受けると
/// 読めない綴りで **axum 自身の 400** が出て、[`refuse`] を通らない——同じ失敗が口に
/// よって違う言葉になり、「断り方を1か所に集める」が破れる。
#[derive(Debug, serde::Deserialize)]
pub struct PathQuery {
    pub path: String,
    #[serde(rename = "as")]
    pub shape: Option<String>,
}

/// `?path=…&stamp=…`。**印は問い合わせ引数で渡す**——本文はファイルの中身そのものなので
/// 混ぜられない（`ファイルビュアにエディタ機能を追加` 設計§8-3）。
#[derive(Debug, serde::Deserialize)]
pub struct WriteQuery {
    pub path: String,
    pub stamp: String,
}

/// `?card=<カードID>`。**どのカードへの添付か**を決める（設計§3）。
#[derive(Debug, serde::Deserialize)]
pub struct CardQuery {
    pub card: String,
}

/// 生で返すときに必ず付ける CSP（`ファイル閲覧で画像とHTMLも表示する` 設計§5-3、
/// および `ファイルの中身に掛けた隔離を、script の1段だけ解く` 設計§3）。
///
/// # なぜヘッダで出すのか
///
/// **`sandbox` 指令は、URL を直接開かれたときにも効く唯一の鍵である。** `iframe` の
/// `sandbox` 属性は埋め込む側にしか付けられないので、これが無いと、この URL を直接
/// 開いた人の画面で他人の HTML が**ダッシュボードと同じ出自**で動く。
///
/// # script を1段だけ通してある
///
/// 許したのは `allow-scripts` と `script-src 'unsafe-inline'` の2段だけである。**理解
/// ドキュメントの作法が、文書内で完結するインライン script を許しているため**——落として
/// いることを誰にも知らせないので、読者は文書が壊れたと受け取る（設計§1-2）。
///
/// **`allow-same-origin` は書かない。** 両方付くと箱がダッシュボードと同じ出自を名乗れ、
/// script が自分で `sandbox` を外せる——鍵を渡したうえで「外してよい」と言うのと同じに
/// なる（設計§4-2）。`allow-popups` ／ `allow-modals` ／ `allow-forms` ／
/// `allow-top-navigation` も書かない。**要る文書が現れたときに、そのとき理由を添えて足す。**
///
/// **`default-src 'none'` は据え置く。** 取ってくる方向は1つも開いていない（設計§3-3）。
/// 緩めるときは**1つずつ**足して、理由を設計§3 へ書く。
pub const RAW_CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/// プレビューの中を探すための、箱へ入れる係（`finder.js`）。
///
/// # なぜ中へ入れるのか
///
/// 箱は `allow-same-origin` を持たないので**別の出自を名乗る**——親の画面からは中の
/// 文書に1バイトも触れない。これは隔離が効いている証拠であって、直すべき不具合では
/// ない。**だから親が中を探すのではなく、中に探す係を置いて指示だけを渡す。**
///
/// **隔離は1段も緩めていない。** 増えたのは「親と便りをやり取りする」道だけで、
/// `postMessage` は隔離された箱にも元から許されている。**`allow-same-origin` を
/// 足す案は採らなかった**——あれは `allow-scripts` と並ぶと、箱がダッシュボードと
/// 同じ出自を名乗れて script が自分で `sandbox` を外せる（下記 [`RAW_CSP`]）。
///
/// # 足すのは `as=preview` のときだけ
///
/// **「ブラウザで開く」（`as=raw`）には1バイトも足さない。** あちらは利用者が
/// ファイルそのものを見に行く道なので、こちらの都合で中身を変えない。
const FINDER_JS: &str = include_str!("finder.js");

/// `GET /api/hosts/{host}/dir?path=…`
pub async fn api_dir(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(host): Path<String>,
    Query(query): Query<DirQuery>,
) -> Result<Json<DirListing>, (StatusCode, String)> {
    let target = parse_host(&host)?;
    state
        .agent
        .list_dir(
            HostAskRequest {
                account_id: identity.account_id,
                target,
            },
            query.path.as_deref(),
        )
        .await
        .map(Json)
        .map_err(refuse)
}

/// `GET /api/hosts/{host}/file?path=…[&as=raw]`
///
/// # 1つの口が2つの形を返す
///
/// **新しいルートを立てない**（設計§5-1）。台帳（`core/tests/cli_surface.toml`）は
/// ルート単位で数えており、鍵も `guard` の内側にある——口を増やすと、台帳・CLI・
/// アカウント分離の総当たりが芋づるで増える。
///
/// | `as` | 返すもの |
/// |---|---|
/// | 省略 | JSON の [`protocol::fs::FileContent`]（**いままでどおり**） |
/// | `raw` | 生のバイト列 ＋ 4つのヘッダ。`<img>` と**「ブラウザで開く」**の宛先になる |
/// | `preview` | `raw` と同じ。**ただし HTML には探す係（[`FINDER_JS`]）を末尾へ足す** |
///
/// **`preview` を分けたのは、足す相手を1つに絞るためである。** 「ブラウザで開く」は
/// 利用者がファイルそのものを見に行く道なので、こちらの都合で中身を変えない。
pub async fn api_file(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(host): Path<String>,
    Query(query): Query<PathQuery>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let target = parse_host(&host)?;
    let ask = || HostAskRequest {
        account_id: identity.account_id,
        target,
    };

    match query.shape.as_deref() {
        None => {
            let content = state
                .agent
                .read_file(ask(), &query.path)
                .await
                .map_err(refuse)?;
            Ok(Json(content).into_response())
        }
        Some("raw") => raw_file(&state, ask(), &query.path, false).await,
        Some("preview") => raw_file(&state, ask(), &query.path, true).await,
        Some(other) => Err(refuse(HostAskError::BadRequest(format!(
            "`as` を読めません：{other}\n合うのは raw と preview です。"
        )))),
    }
}

/// `PUT /api/hosts/{host}/file?path=…&stamp=…` — ファイル1つを書き戻す
/// （`ファイルビュアにエディタ機能を追加` 設計§2-1）。
///
/// # なぜ新しい口なのか
///
/// [`api_file`] が `as=raw` で済ませたのは**同じ資源を別の形で返すだけ**だったからで、
/// こちらは**向きが逆**である。読む口に書く動作を足すと、
/// [`crate::session_host::SessionHost::read_file`] の doc が書いている「読むだけ」が
/// 嘘になる（[`api_attachment`] を別に作ったときと同じ作法）。
///
/// # 本文はファイルの中身そのもの
///
/// だから**印は問い合わせ引数で渡す**（設計§8-3）。本文へ混ぜられない。引数なら
/// CLI からも同じ形で渡せるので、台帳の1行に収まる。
///
/// # 入口で字句の照合をする
///
/// **画面だけで弾いても意味が無い**——同じ口は CLI と REST から直接叩ける。ここでは
/// `..` を畳んだ**字句**で確かめ、PC 側が `canonicalize` した**実体**でもう一度確かめる
/// （設計§3-1）。**規則は1つ（[`protocol::path::is_writable`]）で、確かめる場所が2つ**
/// あるだけである。**判定をここへ直接書かないこと。**
pub async fn api_write_file(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(host): Path<String>,
    Query(query): Query<WriteQuery>,
    text: String,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let target = parse_host(&host)?;

    let roots = writable_roots_for(&state, &identity, &host).await?;
    入口を通すか(&query.stamp, &query.path, &roots)
        .map_err(|断り| 断り.応答(&query.path, &roots))?;

    let written = state
        .agent
        .write_file(
            HostAskRequest {
                account_id: identity.account_id,
                target,
            },
            &query.path,
            &text,
            &query.stamp,
            &roots,
        )
        .await
        .map_err(refuse)?;
    Ok(Json(written).into_response())
}

/// 入口で断る理由（`ファイルビュアにエディタ機能を追加` 設計§8-1・§8-2）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum 入口の断り {
    /// 印が付いていない（設計§8-3）
    印が無い,
    /// 許可された場所の外（設計§8-2）
    許可の外,
}

impl 入口の断り {
    /// 断り文を組み立てる。**画面へそのまま出る**ので、直せる相手には直し方を添える。
    fn 応答(&self, path: &str, roots: &[String]) -> (StatusCode, String) {
        match self {
            Self::印が無い => (
                StatusCode::BAD_REQUEST,
                "`stamp` が要ります（読んだときの印をそのまま渡してください）".to_string(),
            ),
            // **どこなら書けるかを添える**（設計§8-2）。利用者が設定で直せる相手なので、
            // 「できません」で終わらせず足し方へ導く
            Self::許可の外 => {
                let allowed = if roots.is_empty() {
                    "いまは1つもありません".to_string()
                } else {
                    roots.join("\n  ")
                };
                (
                    StatusCode::FORBIDDEN,
                    format!(
                        "{path} は、保存を許可した場所の外です。\n\nいま許可されている場所：\n  {allowed}\n\n設定の writable_roots へ足すと書けるようになります。"
                    ),
                )
            }
        }
    }
}

/// 入口の判定（設計§3-1 の**字句**の段）。**純関数にしてある。**
///
/// # なぜ切り出すのか
///
/// この判定は**画面・REST・CLI の3経路すべてが通る唯一の門**である。ハンドラの中へ
/// 書くと、**確かめるにはサーバを丸ごと起こす**ことになり、実際には誰も確かめない。
/// 決める側を分けておけば、表を並べるだけで全経路ぶんの約束を固定できる
/// （この PJT が並べ替えや効果線で採っているのと同じ型）。
///
/// # ここで見るのは字句だけである
///
/// `..` を畳んでから照合する。**リンクは辿らない**——実体の解決はファイルシステムに
/// 触るので PC 側にしかできない（設計§3-1）。**規則そのもの
/// （[`protocol::path::is_writable`]）は両方から呼ぶ1つだけ**で、ここは材料を用意する
/// 側である。
pub(crate) fn 入口を通すか(
    stamp: &str,
    path: &str,
    roots: &[String],
) -> Result<(), 入口の断り> {
    // **印が付いていない要求は断る**（設計§8-3）。省けば上書きできる道を残すと、
    // 競合の検知は「印を付けた人だけが守られる」ものになる
    if stamp.trim().is_empty() {
        return Err(入口の断り::印が無い);
    }
    if !protocol::path::is_writable(roots, &fold_parents(path)) {
        return Err(入口の断り::許可の外);
    }
    Ok(())
}

/// 書いてよい場所の一覧を組み立てる（設計§3-5）。
///
/// **設定の根に、その利用者のプロジェクトの配下を足す。** プロジェクトを足すのは
/// **コードの側**で、`writable_roots` の既定は空のまま。
///
/// **「いま開いているプロジェクト」を画面に申告させない**——サーバはその文脈を持って
/// おらず、申告させると**客体が申告した値で照合の範囲が決まる**ことになる。一覧は
/// 既にアカウントと PC で絞られているので、そこから引けば勝手には広がらない。
async fn writable_roots_for(
    state: &AppState,
    identity: &Identity,
    host: &str,
) -> Result<Vec<String>, (StatusCode, String)> {
    let db = state.registry.db();
    let configured = crate::db::settings::writable_roots(db, identity.account_id).await;
    let rows = crate::db::projects::list(db, identity.account_id)
        .await
        .map_err(|err| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("記録を読めません: {err}"),
            )
        })?;
    let projects: Vec<String> = rows
        .iter()
        .filter(|row| {
            match crate::db::projects::from_column(row.agent_id) {
                Some(agent) => agent.0.to_string() == host,
                // ローカルモードの行。`local` を指しているときだけ効かせる
                None => host == LOCAL_HOST,
            }
        })
        .map(|row| row.path.clone())
        .collect();
    Ok(protocol::path::effective_roots(&configured, &projects))
}

/// `..` を畳む（**字句だけ。リンクは辿らない**）。実体の解決は PC 側の仕事である
/// （設計§3-1）。
///
/// **畳むのは呼ぶ側の仕事**で、規則そのもの（`protocol::path`）は文字列しか見ない。
fn fold_parents(path: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    if path.starts_with('/') {
        format!("/{}", stack.join("/"))
    } else {
        stack.join("/")
    }
}

/// 添付を1枚置く（`メッセージに画像を添付できるようにする` 設計§3）。
///
/// # なぜ新しい口を作るのか
///
/// [`api_file`] が `as=raw` で済ませたのは、**同じ資源を別の形で返すだけ**だったからである。
/// こちらは**向きが逆で、資源も別**——「PC のファイルを見せる」ではなく「ブラウザの画像を
/// PC のディスクへ置く」。読む口に書く動作を足すと、[`crate::session_host::SessionHost`]
/// の doc が書いている「読むだけ。書く口は持たない」が嘘になる。
///
/// # 断り方
///
/// 媒体型は `Content-Type` から取る。表に無いものは **415**、大きすぎるものは **413**、
/// 他人のカードは **403**——[`status_of`] の写し表に従う。
pub async fn api_attachment(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(host): Path<String>,
    Query(query): Query<CardQuery>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let target = parse_host(&host)?;
    let ask = HostAskRequest {
        account_id: identity.account_id,
        target,
    };

    let card_id = protocol::CardId(query.card.parse().map_err(|_| {
        refuse(HostAskError::BadRequest(
            "card はカードIDである必要があります".to_string(),
        ))
    })?);

    // **媒体型はヘッダから取る。** 中身から推測すると、外したときに嘘の拡張子で置くことになる
    let media_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let written = state
        .agent
        .write_blob(ask, card_id, &media_type, body.to_vec())
        .await
        .map_err(refuse)?;

    Ok(Json(written).into_response())
}

/// 生のバイト列で返す（設計§5-2・§5-3、および `ファイルの中身に掛けた隔離を、
/// script の1段だけ解く` 設計§5）。
///
/// # 種別で断らない
///
/// **どの拡張子も返す。** かつては媒体型を持たない種別を 415 で断っていたが、画面に
/// 「ブラウザで開く」を置いた以上、**押しても意味の無い相手にエラー画面を見せることに
/// なる**。表に無いものは `text/plain` で字として出す（設計§5-1）。
///
/// **`.js` を `text/javascript` で返さないことは変わっていない。** 危なさは種別の門では
/// なく型のほうで抑えており、`nosniff` と組んで `<script src>` から実行できない
/// （設計§5-3。2026-09-04 に実ブラウザで実測）。
///
/// **読めないものは、読めない理由で断られる。** バイナリ（NUL を含む）と非 UTF-8 は
/// この下の `read_file` が落とすので、素のエラー画面にはならない（設計§5-4）。
async fn raw_file(
    state: &AppState,
    ask: HostAskRequest,
    path: &str,
    探せるように: bool,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let media_type = protocol::fs::media_type_of(path);

    // **作り方は種別で分かれる。** HTML と SVG はテキストなので既存の道から作れる
    // （それぞれの上限がそのまま効く）。画像だけが新設のバイト列の道を通る（設計§5-2）
    let body = if protocol::fs::kind_of(path) == protocol::fs::FileKind::Image {
        state.agent.read_blob(ask, path).await.map_err(refuse)?.data
    } else {
        state
            .agent
            .read_file(ask, path)
            .await
            .map_err(refuse)?
            .text
            .into_bytes()
    };

    /*
        **探す係を足すのは HTML のときだけ。**

        `<script>` を本文の末尾へ継ぐので、**先頭には1バイトも触らない**——`DOCTYPE` の
        前に何かを差すと、ブラウザが互換モードへ落ちて**描き方そのものが変わる**。
        プレビューは見た目を写す面なので、そこを動かしてはいけない。

        **SVG には足さない。** あちらは `</svg>` の外に要素を置けないので、同じ手が
        使えない（無理に中へ差すと、文書の構造をこちらが書き換えることになる）。
    */
    let body = if 探せるように && protocol::fs::kind_of(path) == protocol::fs::FileKind::Html
    {
        let mut 継いだ = body;
        継いだ.extend_from_slice(b"\n<script>");
        継いだ.extend_from_slice(FINDER_JS.as_bytes());
        継いだ.extend_from_slice(b"</script>\n");
        継いだ
    } else {
        body
    };

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, media_type),
            // 宣言した型と違うものとして解釈させない。壊れた `.png` を HTML として
            // 読みに行かせないための1行
            (axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (axum::http::header::CONTENT_SECURITY_POLICY, RAW_CSP),
            // 鍵の内側の中身を、ブラウザの控えに残さない
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response())
}

/// `GET /api/hosts/{host}/logs?since=…&level=…&card=…&proc=…&grep=…&raw=…&sanitize=…`
///
/// **全欄を省略できる形にしてある**（ログ設計§25-8）。抽出子に必須の欄を持たせると、
/// 欠けたときに **axum 自身の 400** が [`refuse`] を通らずに出る——同じ失敗が口によって
/// 違う言葉になり、「断り方を1か所に集める」が破れる。欠けているかどうかはここで見て、
/// [`HostAskError::BadRequest`] へ寄せる。
pub async fn api_logs(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(host): Path<String>,
    Query(query): Query<LogsQuery>,
) -> Result<Json<protocol::logs::LogChunk>, (StatusCode, String)> {
    let target = parse_host(&host)?;
    let wire = query.into_wire().map_err(refuse)?;
    let mut chunk = state
        .agent
        .read_log(
            HostAskRequest {
                account_id: identity.account_id,
                target,
            },
            &wire,
        )
        .await
        .map_err(refuse)?;
    // **どの PC のものかを埋めるのはここ。** PC は自分がどの綴りで呼ばれたかを
    // 知らない（自分の名前は名乗れるが、アカウントを跨ぐと一意でない）
    chunk.host = host;
    Ok(Json(chunk))
}

/// ログの絞り込み。**全欄が省略可**（上の理由）。
#[derive(Debug, Default, serde::Deserialize)]
pub struct LogsQuery {
    pub since: Option<String>,
    pub level: Option<String>,
    pub card: Option<String>,
    pub proc: Option<String>,
    pub grep: Option<String>,
    /// `--json` 相当。`grep` を当てる先を生の行にするか
    pub raw: Option<bool>,
    pub sanitize: Option<bool>,
}

impl LogsQuery {
    /// 線に載せる形へ。**読めない値はここで断る**（PC へは投げない）。
    fn into_wire(self) -> Result<protocol::logs::LogQuery, HostAskError> {
        let Some(since) = self.since else {
            // 既定を勝手に決めない。**どこからかを言わずにログを引くと、量が構成で変わる**
            return Err(HostAskError::BadRequest(
                "`since` は必須です（RFC3339・ミリ秒・UTC）".to_string(),
            ));
        };
        // 形だけ見る。**中身の意味（未来かどうか等）は見ない**——書き手の時計と
        // 読み手の時計はずれうるので、ここで弾くと正しい問いまで断ることになる
        if time::OffsetDateTime::parse(&since, &time::format_description::well_known::Rfc3339)
            .is_err()
        {
            return Err(HostAskError::BadRequest(format!(
                "`since` を RFC3339 として読めません：{since}"
            )));
        }
        let level = self.level.unwrap_or_else(|| "INFO".to_string());
        // **ここで断らないと、打ち間違いが相手の PC の落ち度になる。** 素通しすると
        // PC 側の切り出しが落ちて `Unsupported`（415）になり、読み手には
        // 「その PC は応じられません」としか見えない——直すべき場所を指していない
        if !protocol::logs::LEVELS.contains(&level.to_ascii_uppercase().as_str()) {
            return Err(HostAskError::BadRequest(format!(
                "`level` を読めません：{level}\n合うのは {} です。",
                protocol::logs::LEVELS.join(" / ").to_lowercase()
            )));
        }
        if let Some(pattern) = &self.grep {
            regex::Regex::new(pattern).map_err(|err| {
                HostAskError::BadRequest(format!("`grep` の正規表現が読めません：{err}"))
            })?;
        }
        Ok(protocol::logs::LogQuery {
            since,
            level,
            card: self.card,
            proc: self.proc,
            grep: self.grep,
            grep_on_raw: self.raw.unwrap_or(false),
            sanitize: self.sanitize.unwrap_or(false),
        })
    }
}

/// `GET /api/hosts/{host}/resources`
///
/// その PC の空きメモリと、**いま何枚起こし直せるか**（起こし直し設計§18-4）。
///
/// **押した瞬間にだけ聞く口である。** 定期的に運ばないのは、メモリが秒単位で動くので
/// **古い値を配るだけ**になり、経路と嵩だけが増えるため。「入るか」を知りたいのは
/// 押した瞬間の1回きりで、そのとき新しい値が要る。
pub async fn api_resources(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(host): Path<String>,
) -> Result<Json<protocol::HostResources>, (StatusCode, String)> {
    let target = parse_host(&host)?;
    state
        .agent
        .host_resources(HostAskRequest {
            account_id: identity.account_id,
            target,
        })
        .await
        .map(Json)
        .map_err(refuse)
}

/// `POST /api/hosts/{host}/attachments/sweep` — 添付を掃く／下見する（メモ設計§10-2）。
///
/// # なぜ下見と本番が同じ口なのか
///
/// 要件10 は「1GB を超えたら**利用者に同意のダイアログを出してから**消す」と定めて
/// いる。**同意の画面に出した数のとおりに消えること**が同意の意味なので、口を分けると
/// 片方だけ直せてしまう。`apply` の真偽1つで分ける。
///
/// # 上限はアカウントの設定から読む
///
/// **PC 側の toml ではない**（§11-2 の追記）。`memo_max_bytes` は画面から変えられる
/// 設定で、**セルフホスト構成では toml に手が届かない**。
///
/// **起動時の掃除（`sweep_on_start`）はこの口を通らない**ので、**既存の振る舞いは
/// 1バイトも変わっていない。**
pub async fn api_attachment_sweep(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(host): Path<String>,
    Query(query): Query<SweepQuery>,
) -> Result<Json<protocol::AttachmentSweep>, (StatusCode, String)> {
    let target = parse_host(&host)?;
    let limits = crate::db::settings::memo_limits(state.registry.db(), identity.account_id)
        .await
        .unwrap_or_default();
    state
        .agent
        .sweep_attachments(
            HostAskRequest {
                account_id: identity.account_id,
                target,
            },
            crate::session_host::AttachmentSweepLimits {
                retention_days: limits.retention_days,
                // **DB の値を渡す**（§11-2 の追記）。toml の `attachment_max_bytes` は
                // 起動時の掃除が読んだまま——こちらは通らない
                max_bytes: limits.max_bytes,
                sweep_bytes: SWEEP_BYTES,
                apply: query.apply,
            },
        )
        .await
        .map(Json)
        .map_err(refuse)
}

/// 一度に掃く量（要件10 の 200MB）。
///
/// **「上限を下回るまで」ではない**——ここがログの掃除と違う（利用者の指定・2026-09-01）。
const SWEEP_BYTES: u64 = 200 * 1024 * 1024;

/// 掃除の下見か本番か。
#[derive(serde::Deserialize)]
pub struct SweepQuery {
    /// **既定は下見**（`false`）。**消すほうを既定にしない**——問い合わせのつもりで
    /// 叩いた口が消してしまう形は、同意を取る仕組みと矛盾する
    #[serde(default)]
    pub apply: bool,
}

/// `{host}` を宛先へ。**読めない綴りは「知らない PC」と同じ扱い**（設計§18）。
///
/// 言い分けると、綴りを変えながら叩いて何かを探れる余地ができる。
///
/// 枠の口（[`crate::projects`]）も同じ綴りを受けるので、**ここから借りる**。
/// 写しを持たせると、`LOCAL_HOST` の綴りを変えたときに片方だけ直る。
pub(crate) fn parse_host(host: &str) -> Result<Option<AgentId>, (StatusCode, String)> {
    if host == LOCAL_HOST {
        return Ok(None);
    }
    match host.parse::<uuid::Uuid>() {
        Ok(id) => Ok(Some(AgentId(id))),
        Err(_) => Err(refuse(HostAskError::UnknownHost)),
    }
}

pub(crate) fn refuse(err: HostAskError) -> (StatusCode, String) {
    (status_of(&err), err.message())
}

/// 断る理由を状態コードへ写す（設計§10）。
///
/// **ローカルとリモートで同じ写し方になる。** 境界が返すのは同じ型なので、
/// 構成によってコードが変わることがない（フェーズ1 の引き継ぎで心配していた点）。
pub fn status_of(err: &HostAskError) -> StatusCode {
    match err {
        // 他人の PC・知らない PC・繋がっていない PC を**言い分けない**
        HostAskError::UnknownHost => StatusCode::NOT_FOUND,
        // 「できない」ではなく「いまのこの相手ではできない」——更新すれば変わる
        HostAskError::Unsupported => StatusCode::CONFLICT,
        HostAskError::Timeout => StatusCode::GATEWAY_TIMEOUT,
        HostAskError::Unreachable(_) => StatusCode::SERVICE_UNAVAILABLE,
        HostAskError::Failed { reason, .. } => match reason {
            HostFailure::NotFound => StatusCode::NOT_FOUND,
            HostFailure::Denied => StatusCode::FORBIDDEN,
            // 「フォルダを頼んだらファイルだった」も、その名前では見つからないのと同じ
            HostFailure::NotDirectory => StatusCode::NOT_FOUND,
            HostFailure::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            // 設計§10 の表には無い5つ目。テキストとして扱えない、が最も近い
            HostFailure::Unsupported => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            // **その機械にその口が無い**（Linux 以外へメモリの空きを聞いた等）。
            // 415 へ寄せると「メディア型が非対応」という無関係な理由になり、
            // 押した人が何を直せばよいか分からない（コードレビュー対応8）
            HostFailure::Unavailable => StatusCode::NOT_IMPLEMENTED,
            // **読んだあとに他所で書き換えられていた**（設計§8-3）。403 へ寄せると
            // 権限の話に見えて、画面が「読み直す／上書きする」を出す手掛かりを失う
            HostFailure::Conflict => StatusCode::CONFLICT,
        },
        // 頼み方が読めない。**PC は無関係**なので、相手のせいに見える 404 / 409 へ寄せない
        HostAskError::BadRequest(_) => StatusCode::BAD_REQUEST,
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    /// 許可された根の一覧を作る
    fn 根(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn 入口は許可された場所への書き込みを通す() {
        // **断る検査しか無いと、照合が常に false を返すよう壊れていても緑になる。**
        // 通る側を必ず1本置く
        assert_eq!(
            入口を通すか("24-17", "/dev/app/src/main.rs", &根(&["/dev/app"])),
            Ok(())
        );
    }

    #[test]
    fn 入口は許可された場所の外を断る() {
        assert_eq!(
            入口を通すか("24-17", "/etc/passwd", &根(&["/dev/app"])),
            Err(入口の断り::許可の外)
        );
    }

    #[test]
    fn 入口は畳んでから照合する() {
        // **畳まずに素で照合すると、この綴りが前置きに一致して通ってしまう**
        assert_eq!(
            入口を通すか("24-17", "/dev/app/../../etc/passwd", &根(&["/dev/app"])),
            Err(入口の断り::許可の外)
        );
        // 内側で行き来するだけなら通る
        assert_eq!(
            入口を通すか("24-17", "/dev/app/src/../README.md", &根(&["/dev/app"])),
            Ok(())
        );
    }

    #[test]
    fn 入口は頭が同じ兄弟フォルダを断る() {
        // **素の前方一致で書くと、ここが通ってしまう**（設計§3-2）
        for 外 in ["/dev/app-old/x.md", "/dev/app2/x.md"] {
            assert_eq!(
                入口を通すか("24-17", 外, &根(&["/dev/app"])),
                Err(入口の断り::許可の外),
                "{外} は根の外である"
            );
        }
    }

    #[test]
    fn 入口は印の無い要求を断る() {
        // **省けば上書きできる道を残さない**（設計§8-3）
        for 印 in ["", "   "] {
            assert_eq!(
                入口を通すか(印, "/dev/app/src/main.rs", &根(&["/dev/app"])),
                Err(入口の断り::印が無い)
            );
        }
    }

    #[test]
    fn 設定が空でもプロジェクトの根は効く() {
        // **プロジェクトを足すのはコードの側である**（設計§3-5）。
        // `writable_roots` の既定は空のまま
        let roots = protocol::path::effective_roots(&[], &根(&["/dev/app"]));
        assert_eq!(入口を通すか("24-17", "/dev/app/計画.md", &roots), Ok(()));
        assert_eq!(
            入口を通すか("24-17", "/dev/other/計画.md", &roots),
            Err(入口の断り::許可の外)
        );
    }

    #[test]
    fn 根が1つも無ければどこへも書けない() {
        // **既定を「空＝全部許可」にしてはいけない**（設計§3-5）
        assert_eq!(
            入口を通すか("24-17", "/dev/app/x.md", &[]),
            Err(入口の断り::許可の外)
        );
    }

    #[test]
    fn 断り文は許可されている場所を添える() {
        // 利用者が設定で直せる相手なので、「できません」で終わらせない（設計§8-2）
        let (status, body) = 入口の断り::許可の外.応答("/etc/passwd", &根(&["/dev/app"]));
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(
            body.contains("/dev/app"),
            "どこなら書けるかを出すこと: {body}"
        );
        assert!(body.contains("writable_roots"), "足し方へ導くこと: {body}");
    }

    #[test]
    fn 生で返すときのcspは字で固定する() {
        // **綴りを1つ字で書く。** 定数から組み立てると、崩れたときに一緒に動いて通る。
        // ここが崩れても画面は普通に動くので、気づく手段が他に無い（設計§3-1）
        assert_eq!(
            RAW_CSP,
            "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; img-src data:; style-src 'unsafe-inline'; font-src data:"
        );
        // 部品を名指しでも見る。並べ替えただけの崩れを、上の1本と別に捕まえる
        for piece in [
            "sandbox allow-scripts",
            "default-src 'none'",
            "script-src 'unsafe-inline'",
            "img-src data:",
            "style-src 'unsafe-inline'",
        ] {
            assert!(RAW_CSP.contains(piece), "{piece} が要る");
        }
        assert!(!RAW_CSP.contains("unsafe-eval"));
    }

    #[test]
    fn 緩めたのはscriptの1段だけである() {
        // **`allow-same-origin` を書かない。** `allow-scripts` と両方付くと、箱が
        // ダッシュボードと同じ出自を名乗れて自分で `sandbox` を外せる——隔離が実質
        // 消える（設計§4-2）。**ここが崩れても画面は普通に動く**ので、字で見る
        assert!(
            !RAW_CSP.contains("allow-same-origin"),
            "出自を名乗らせないこと"
        );
        // 足していない許可を1つずつ名指しする。**黙って増えないこと**が要点で、
        // 要る文書が現れたときに理由を添えて足す（設計§4-3）
        for 足していない in [
            "allow-popups",
            "allow-modals",
            "allow-forms",
            "allow-top-navigation",
            "allow-downloads",
            "allow-pointer-lock",
        ] {
            assert!(
                !RAW_CSP.contains(足していない),
                "{足していない} は足していないこと"
            );
        }
        // **取ってくる方向は閉じたまま。** ここが緩むと、開いただけで外部へ痕跡が残る
        // （`ファイル閲覧で画像とHTMLも表示する` 設計§6-3）
        assert!(
            RAW_CSP.contains("default-src 'none'"),
            "外は閉じたままのこと"
        );
        assert!(
            !RAW_CSP.contains("connect-src"),
            "通信を開く指定を持たないこと"
        );
    }

    #[test]
    fn 断る理由はすべて別の状態コードへ写る() {
        // **まとめて500にしない。** 利用者が直せるもの（権限・パス・版）が、
        // 直せないもの（サーバの不調）と同じ顔になると、直しようが無くなる
        assert_eq!(status_of(&HostAskError::UnknownHost), StatusCode::NOT_FOUND);
        assert_eq!(status_of(&HostAskError::Unsupported), StatusCode::CONFLICT);
        assert_eq!(
            status_of(&HostAskError::Timeout),
            StatusCode::GATEWAY_TIMEOUT
        );
        assert_eq!(
            status_of(&HostAskError::Unreachable("届きません".to_string())),
            StatusCode::SERVICE_UNAVAILABLE
        );

        let failed = |reason| HostAskError::Failed {
            reason,
            detail: String::new(),
        };
        assert_eq!(
            status_of(&failed(HostFailure::Denied)),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status_of(&failed(HostFailure::TooLarge)),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            status_of(&failed(HostFailure::NotFound)),
            StatusCode::NOT_FOUND
        );
        // **「テキストではない」と「その機械にその口が無い」を言い分ける**
        // （コードレビュー対応8）。同じ 415 に畳むと、Linux 以外へメモリの空きを
        // 聞いた人に「メディア型が非対応」という無関係な理由が出る
        assert_eq!(
            status_of(&failed(HostFailure::Unsupported)),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            status_of(&failed(HostFailure::Unavailable)),
            StatusCode::NOT_IMPLEMENTED
        );
        // 頼み方の誤りは**こちら側の話**。PC のせいに見えるコードへ寄せない
        assert_eq!(
            status_of(&HostAskError::BadRequest("読めません".to_string())),
            StatusCode::BAD_REQUEST
        );
    }

    /// ログの絞り込みは、**PC へ投げる前に**この場で検める（ログ設計§25-8）。
    mod ログの頼み {
        use super::*;

        fn asked(since: &str) -> LogsQuery {
            LogsQuery {
                since: Some(since.to_string()),
                ..Default::default()
            }
        }

        #[test]
        fn いつからを言わない頼みは断る() {
            // 既定を勝手に決めると、**同じ URL が構成によって違う量を返す**
            let err = LogsQuery::default().into_wire().expect_err("断ること");
            assert_eq!(status_of(&err), StatusCode::BAD_REQUEST);
            assert!(err.message().contains("since"), "{}", err.message());
        }

        #[test]
        fn 読めない時刻は投げる前に断る() {
            let err = asked("きのう").into_wire().expect_err("断ること");
            assert_eq!(status_of(&err), StatusCode::BAD_REQUEST);
        }

        #[test]
        fn 壊れた正規表現は投げる前に断る() {
            // 投げてから相手に断らせると、往復1回ぶんを捨てたうえに
            // **頼み方の誤りが「PC が応じない」側のコードで返る**
            let err = LogsQuery {
                grep: Some("[".to_string()),
                ..asked("2026-08-08T00:00:00.000Z")
            }
            .into_wire()
            .expect_err("断ること");
            assert_eq!(status_of(&err), StatusCode::BAD_REQUEST);
        }

        #[test]
        fn 読めない水位は投げる前に断る() {
            // 素通しすると PC 側の切り出しが落ちて 415 になり、読み手には
            // 「その PC は応じられません」としか見えない。**打ち間違いが相手の
            // 落ち度として報告される**ので、直すべき場所を指していない
            let err = LogsQuery {
                level: Some("しずか".to_string()),
                ..asked("2026-08-08T00:00:00.000Z")
            }
            .into_wire()
            .expect_err("断ること");
            assert_eq!(status_of(&err), StatusCode::BAD_REQUEST);
            // 読めなかった値と、合う値の一覧を出す
            assert!(err.message().contains("しずか"), "{}", err.message());
            assert!(err.message().contains("warn"), "{}", err.message());
        }

        #[test]
        fn 水位は大小文字を問わない() {
            for level in ["warn", "WARN", "Warn"] {
                let wire = LogsQuery {
                    level: Some(level.to_string()),
                    ..asked("2026-08-08T00:00:00.000Z")
                }
                .into_wire()
                .expect("通ること");
                assert_eq!(wire.level, level, "綴りはそのまま運ぶこと");
            }
        }

        #[test]
        fn 省略できる欄には既定が入る() {
            let wire = asked("2026-08-08T00:00:00.000Z")
                .into_wire()
                .expect("通ること");
            assert_eq!(wire.level, "INFO");
            assert!(!wire.grep_on_raw);
            assert!(!wire.sanitize);
            assert_eq!(wire.card, None);
        }

        #[test]
        fn 未来の時刻でも断らない() {
            // 書き手と読み手の時計はずれうる（設計§25-4）。**形だけ見て、意味は見ない**
            // ——ここで弾くと、ずれている PC への正しい問いまで断ることになる
            let wire = asked("2099-01-01T00:00:00.000Z")
                .into_wire()
                .expect("通ること");
            assert_eq!(wire.since, "2099-01-01T00:00:00.000Z");
        }
    }

    #[test]
    fn 読めない宛先は知らないpcと同じ言葉で断る() {
        // 綴りを変えながら叩いて存在を探れないこと（設計§18）
        let (code, message) = parse_host("これはUUIDではない").expect_err("断ること");
        assert_eq!(code, StatusCode::NOT_FOUND);
        assert_eq!(message, HostAskError::UnknownHost.message());
    }

    #[test]
    fn localは宛先なしとして読む() {
        assert_eq!(parse_host(LOCAL_HOST).expect("通ること"), None);
    }
}
