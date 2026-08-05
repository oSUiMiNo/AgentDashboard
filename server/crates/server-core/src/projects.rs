//! 追加した PJT 枠の REST の口（イシューグループ_2026_0805_0514 設計§10・§11・§13）。
//!
//! # 断り方は借りてくる
//!
//! 状態コードの写しは [`crate::hosts::status_of`] だけが持つ。枠の口が自前で書くと、
//! **同じ失敗が口によって違うコードになる**。ここで新しく決めるのは「セッションが
//! 居るので消せない」の1つだけで、それ以外は借りる。
//!
//! # 帰属は記録で見る。接続では見ない
//!
//! 「その PC が自分のものか」は `agents` の行で確かめる。**繋がっているかどうかでは
//! 判定しない**——枠は PC が寝ていても足せる必要がある（設計§17「枠そのものは必ず出す」）。
//! 接続を見る `gateway::SessionHostHub::mine` を使うと、**電源を切っている PC の枠を
//! 足せなくなる**。
//!
//! # 書けてから配る
//!
//! 記録へ入ってから `ServerMessage` を配る（設計§11）。順序が逆だと、画面には出て
//! いるのに読み込み直すと消える——嘘をつくことになる。

use crate::{
    auth::Identity,
    db::{self, entity},
    hosts::{LOCAL_HOST, status_of},
    registry::SessionRegistry,
    session_host::HostFsError,
    ws::AppState,
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use protocol::{AgentId, ws::ProjectView, ws::ServerMessage};
use sea_orm::{ColumnTrait as _, DatabaseConnection, EntityTrait as _, QueryFilter as _};
use uuid::Uuid;

/// `POST /api/projects` の中身。
#[derive(Debug, serde::Deserialize)]
pub struct AddRequest {
    /// `agent_id` か、ローカルを表す `"local"`
    pub host: String,
    pub path: String,
}

/// `POST /api/projects` の応答。
#[derive(Debug, serde::Serialize)]
pub struct AddResponse {
    pub project: ProjectView,
    /// 追加と同時にセッションを起こしたか（設計§10）。
    ///
    /// **起こすかどうかを決めるのは設定**（§12）で、実装はフェーズ4。この段では
    /// 常に `false` になるが、**欄は先に置く**——後から足すと、画面が「起きたのか
    /// どうか」を知る手段の無い版が一度出回ることになる。
    pub spawned: bool,
}

/// `GET /api/projects` — このアカウントの枠。
pub async fn api_list(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
) -> Result<Json<Vec<ProjectView>>, (StatusCode, String)> {
    let rows = db::projects::list(state.registry.db(), identity.account_id)
        .await
        .map_err(unavailable)?;
    Ok(Json(rows.iter().map(to_view).collect()))
}

/// `POST /api/projects` — 枠を足す。
///
/// **同じ（アカウント・PC・パス）を2回足しても増えない**（ユニーク索引で担保）。
/// 2回目は既にある行がそのまま返るので、画面は押した結果を同じように扱える。
pub async fn api_add(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Json(request): Json<AddRequest>,
) -> Result<Json<AddResponse>, (StatusCode, String)> {
    let target = parse_host(&request.host)?;
    let db = state.registry.db();

    // **他人の PC と知らない PC を言い分けない**（設計§18）。言い分けると、IDを
    // 総当たりして他人の PC の存在を調べられる
    if let Some(agent) = target
        && !owns_agent(db, identity.account_id, agent)
            .await
            .map_err(unavailable)?
    {
        return Err(refuse(HostFsError::UnknownHost));
    }

    let row = db::projects::add(db, identity.account_id, target, &request.path, db::now_ms())
        .await
        .map_err(unavailable)?;

    let project = to_view(&row);
    // 書けてから配る（設計§11）
    state.registry.announce_account(
        identity.account_id,
        ServerMessage::ProjectUpsert {
            project: project.clone(),
        },
    );

    Ok(Json(AddResponse {
        project,
        // 起こす実装はフェーズ4（設計§12）
        spawned: false,
    }))
}

/// `DELETE /api/projects/{id}` — 枠を消す。
///
/// 消えるのは「この PJT を追加した」という記録だけで、カードでも履歴でもない。
/// **セッションが1本でも居るあいだは消せない**（設計§13）——走っている作業を
/// 巻き添えにしないため。
pub async fn api_remove(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<Identity>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let db = state.registry.db();

    // 他人の枠は `get` の時点で `None` になる（`db::projects::get` が絞る）
    let Some(row) = db::projects::get(db, identity.account_id, id)
        .await
        .map_err(unavailable)?
    else {
        return Err(refuse(HostFsError::UnknownHost));
    };

    if has_sessions(&state.registry, identity.account_id, &row) {
        return Err((
            StatusCode::CONFLICT,
            "セッションが動いているので、この PJT は消せません（先にセッションを終了してください）"
                .to_string(),
        ));
    }

    if db::projects::remove(db, identity.account_id, id)
        .await
        .map_err(unavailable)?
    {
        state.registry.announce_account(
            identity.account_id,
            ServerMessage::ProjectRemoved { project_id: id },
        );
    }
    Ok(StatusCode::NO_CONTENT)
}

/// その枠にカードが1枚でも居るか。
///
/// **記録の列ではなくカードから数える**（設計§2）。枠のほうに本数を持たせると、
/// カードが増減するたびに書き換えが要り、片方だけ古くなったときに直しようが無い。
fn has_sessions(
    registry: &SessionRegistry,
    account_id: Uuid,
    row: &entity::projects::Model,
) -> bool {
    let agent = db::projects::from_column(row.agent_id);
    registry
        .list(account_id)
        .iter()
        .any(|meta| meta.project.0 == row.path && meta.agent_id == agent)
}

/// その PC がこのアカウントのものか。**繋がっているかは見ない。**
async fn owns_agent(
    db: &DatabaseConnection,
    account_id: Uuid,
    agent: AgentId,
) -> Result<bool, sea_orm::DbErr> {
    Ok(entity::agents::Entity::find_by_id(agent.0)
        .filter(entity::agents::Column::AccountId.eq(account_id))
        .one(db)
        .await?
        .is_some())
}

fn to_view(row: &entity::projects::Model) -> ProjectView {
    ProjectView {
        id: row.id,
        host: match db::projects::from_column(row.agent_id) {
            Some(agent) => agent.0.to_string(),
            None => LOCAL_HOST.to_string(),
        },
        path: row.path.clone(),
        created_at: row.created_at,
    }
}

/// `{host}` を宛先へ。**読めない綴りは「知らない PC」と同じ扱い**（設計§18）。
fn parse_host(host: &str) -> Result<Option<AgentId>, (StatusCode, String)> {
    if host == LOCAL_HOST {
        return Ok(None);
    }
    match host.parse::<Uuid>() {
        Ok(id) => Ok(Some(AgentId(id))),
        Err(_) => Err(refuse(HostFsError::UnknownHost)),
    }
}

fn refuse(err: HostFsError) -> (StatusCode, String) {
    (status_of(&err), err.message())
}

fn unavailable(err: sea_orm::DbErr) -> (StatusCode, String) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        format!("記録に繋がりません: {err}"),
    )
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 読めない宛先は知らないpcと同じ言葉で断る() {
        let (code, message) = parse_host("これはUUIDではない").expect_err("断ること");
        assert_eq!(code, StatusCode::NOT_FOUND);
        assert_eq!(message, HostFsError::UnknownHost.message());
    }

    #[test]
    fn localは宛先なしとして読む() {
        assert_eq!(parse_host(LOCAL_HOST).expect("通ること"), None);
    }

    #[test]
    fn 枠の表示は宛先の綴りをそのまま持つ() {
        // 画面はこの `host` をそのまま REST のパスへ載せる。DB の番兵が漏れると
        // `/api/hosts/00000000-…/dir` を叩いてしまい、知らない PC として断られる
        let agent = Uuid::new_v4();
        let remote = entity::projects::Model {
            id: Uuid::new_v4(),
            account_id: Uuid::new_v4(),
            agent_id: agent,
            path: "/home/example/dev/app".to_string(),
            created_at: 1,
        };
        assert_eq!(to_view(&remote).host, agent.to_string());

        let local = entity::projects::Model {
            agent_id: db::projects::LOCAL_AGENT,
            ..remote
        };
        assert_eq!(to_view(&local).host, LOCAL_HOST);
    }
}
