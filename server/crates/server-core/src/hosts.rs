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
};
use protocol::{
    AgentId,
    a2s::HostFailure,
    fs::{DirListing, FileContent},
};

/// ローカルモードの `{host}`。
///
/// `SettingsView.model_tables` のキーが既にこの綴りを使っているので揃える（設計§10）。
pub const LOCAL_HOST: &str = "local";

/// `?path=…`。**フォルダの一覧では省略できる**（省略＝その PC のホーム。設計§26-2）。
#[derive(Debug, serde::Deserialize)]
pub struct DirQuery {
    pub path: Option<String>,
}

/// `?path=…`。中身の読み取りには「始まり」が無いので**必須**。
#[derive(Debug, serde::Deserialize)]
pub struct PathQuery {
    pub path: String,
}

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

/// `GET /api/hosts/{host}/file?path=…`
pub async fn api_file(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(host): Path<String>,
    Query(query): Query<PathQuery>,
) -> Result<Json<FileContent>, (StatusCode, String)> {
    let target = parse_host(&host)?;
    state
        .agent
        .read_file(
            HostAskRequest {
                account_id: identity.account_id,
                target,
            },
            &query.path,
        )
        .await
        .map(Json)
        .map_err(refuse)
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
        },
        // 頼み方が読めない。**PC は無関係**なので、相手のせいに見える 404 / 409 へ寄せない
        HostAskError::BadRequest(_) => StatusCode::BAD_REQUEST,
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

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
