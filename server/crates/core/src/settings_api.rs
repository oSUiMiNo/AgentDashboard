//! 画面が起動時に読む設定（設計§7・セルフホスト化設計§13-4・§11-2）。
//!
//! # なぜここが応答の形を持つのか
//!
//! 中身は**両側から集まる**——受け付ける権限モードとモデルの表は PC 側、画面から
//! 変える設定は DB（サーバ側）、PC の一覧は接続（サーバ側）。どちらか片方の
//! crate へ置くと、もう片方を参照させることになる。両者を束ねるこの層に置くのが、
//! 依存の向きを増やさない唯一の場所になる（§18 読み替え2 の続き）。
//!
//! # 権限確認スキップの既定は「記録が正、無ければ PC 側」
//!
//! 保存先は他の3項目と同じ DB（持ち出し設計§2）。ただし**行が無い間だけ PC 側が
//! 持っている値を初期値として使う**（同§3）——ローカルは `config.toml`、サーバモードは
//! 名乗り。こうしないと、既に `true` にして使っている利用者の設定が引っ越しで黙って
//! 戻る。**両側を見られるのはこの層だけ**なので、この判断もここに置く。
//!
//! # 画面が起動時に読む口はここ1つ
//!
//! PC 名バッジ（`agent_id` → 名前）の引き先を別の口にすると、一覧の描画が**2つの
//! 応答の到着順に依存する**（名前が後から来ると、一度バッジ無しで描いてから差し替わる）。
//! 起動時に要るものは1つの応答へまとめてある。
//!
//! # フラットなモデル表は落とした
//!
//! §13-4 のとおり `model_tables`（`agent_id` キー、ローカルは `"local"`）へ一本化した。
//! CLI の版は PC ごとに違うので、ModelPicker は**セッションが属する PC の表**を見る。

use axum::{
    Extension, Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use server_core::{
    account::SessionHostView,
    auth::{AuthContext, AuthMode, Identity},
    db,
    registry::SessionRegistry,
};
use session_host_core::{session::SessionManager, settings::SettingsStore};
use std::{collections::BTreeMap, sync::Arc};

/// `GET /api/settings` の応答。
#[derive(Debug, Serialize)]
pub struct SettingsView {
    /// 起動時の権限モードの既定の選択を「全承認をスキップ」にするか（選択肢は減らない）。
    ///
    /// **どの構成でも画面から変えられる**（持ち出し設計§6）。「変えられるか」を運ぶ欄は
    /// 置かない——区別が無くなったので、真偽を運ぶ意味も無い。
    pub always_bypass_permissions: bool,
    /// PJT の枠を足したら、続けてセッションを1本起こすか（イシューグループ_2026_0805_0514
    /// 設計§12）。
    ///
    /// **PC 側に初期値の出どころが無い**ので、`always_bypass_permissions` と違って
    /// 名乗りを覗きに行かない。行が無ければ既定（`false`）がそのまま出る。
    pub project_autostart_session: bool,
    /// その CLI が受け付ける権限モード（正規値）。繋がっている PC ぶんを合併したもの
    pub available_modes: Vec<protocol::PermissionMode>,
    /// PC ごとのモデル表（設計§13-4）。キーは `agent_id`、ローカルは `"local"`
    pub model_tables: BTreeMap<String, serde_json::Value>,
    /// 登録済みの PC（設計§11-1・§11-2）。**PC 名バッジの引き先**
    pub agents: Vec<SessionHostView>,
    /// 一覧のカードをどこまで静めるか（カード設計§9-5-2）。3段のいずれか。
    ///
    /// **OS の「動きを減らす」設定とは別物**で、あちらが立っている間は段の選択に
    /// よらず止まる。ここが運ぶのは「利用者が画面から選んだ段」だけ。
    pub motion_quiet: String,
    /// 画面から変えられる間隔一式（設計§13-3）
    pub intervals: IntervalsView,
    /// LAN 開放のパスワード（設計§8-3）。**ローカルモードでしか意味を持たない**
    pub lan_password: LanPasswordView,
    /// メモと画像をどれだけ残すか（メモ設計§11-2・§11-3）。
    ///
    /// **画面が文言を出すために要る。** 要件10 は「3か月で消えます」的な説明を
    /// メモの面へ出すことを求めており、設計§11-3 は**設定で変えた値を反映する**ことを
    /// 定めている——**固定文言にすると、設定を変えた人に嘘を言う**。
    ///
    /// 持ち出し（`/api/settings/export`）は前から運んでいたが、**画面が読む口には
    /// 載っていなかった**。値の出どころは同じ `db::settings::memo_limits` である。
    pub memo_limits: MemoLimitsView,
    /// 書き込みを許可する場所（ファイルビュアにエディタ機能を追加 設計§3-5）。
    ///
    /// **既定は空。** 空でも「開いている PJT の配下」はコードの側が常に足すので、
    /// **空＝どこへも書けない、ではない**（[`protocol::path::effective_roots`]）。
    ///
    /// 画面はこれを**「保存ボタンを出すか」の判定にしか使わない。弾く責任はサーバ側**
    /// にある（設計§3-1）。
    pub writable_roots: Vec<String>,
    /// 拡張子ごとに、開いたときどちらで始めるか（ファイルビュアにエディタ機能を追加 要件③）。
    ///
    /// **拡張子（小文字・`.` 無し）→ `"viewer"` か `"editor"`。既定は空。**
    /// 載っていない拡張子は画面が種別から導く——**ここを埋めるのは、利用者が
    /// 既定と違う見せ方を選んだ拡張子だけ**である。
    pub file_modes: std::collections::BTreeMap<String, String>,
    /// **この機械**の使用上限（status設計）。まだ1本も届いていなければ `None`。
    ///
    /// # なぜ `agents` とは別の欄なのか
    ///
    /// セルフホストでは使用上限が [`SessionHostView::rate_limits`] に乗るが、
    /// **ローカルモードには `agents` の行が1つも無い**（[`server_core::account::no_agents`]
    /// が理由つきで禁じている——`"local"` を1台として並べると、他に PC があるように
    /// 見える）。**行に乗せる形だけだと、実機では1つも読めない。**
    ///
    /// **`agents` に1行足す道は採れない。** 画面側に「`agents` が空ならローカルモード」
    /// という判定が既に2箇所あり（`ProjectAdd` の `isLocal`、`SettingsPage` の
    /// `hasRemote`）、1行入れると**別の PC 向けの設定が実機に現れる**。
    ///
    /// # 出し分けは排他である
    ///
    /// ローカルモードは**この欄**、セルフホストは**`agents` の各行**。同じ数字が
    /// 2箇所に並ぶことはない。
    ///
    /// # DB には持たない
    ///
    /// [`SessionHostView::rate_limits`] と同じく、**応答のたびに手元の保管から
    /// かぶせる**（`connected` と同じ性質）。**この欄が初期スナップショットの唯一の
    /// 経路である**——カードの記録ではないので `SessionUpsert` には乗らず、
    /// サーバ側の関門が「同じ表示形なら配らない」ので**次に値が動くまで便が飛ばない**
    /// （5時間窓・7日窓なので数時間空く）。
    pub machine_rate_limits: Option<protocol::RateLimits>,
}

/// メモと画像の保持（メモ設計§11-1）。
#[derive(Debug, Serialize)]
pub struct MemoLimitsView {
    /// 何日残すか。**画面の「N か月で消えます」はこれを日から月へ直して出す**
    pub retention_days: u64,
    /// 画像を含めた合計の上限。**超えたら同意を取ってから古い順に消す**（§10-2）
    pub max_bytes: u64,
}

impl From<db::settings::MemoLimits> for MemoLimitsView {
    fn from(limits: db::settings::MemoLimits) -> Self {
        Self {
            retention_days: limits.retention_days,
            max_bytes: limits.max_bytes,
        }
    }
}

/// 画面から変えられる間隔（設計§13-3）。
#[derive(Debug, Serialize)]
pub struct IntervalsView {
    pub sync_interval_secs: u64,
    pub screen_interval_ms: u64,
    pub scrollback_lines: u64,
}

impl From<db::settings::Intervals> for IntervalsView {
    fn from(intervals: db::settings::Intervals) -> Self {
        Self {
            sync_interval_secs: intervals.sync_interval_secs,
            screen_interval_ms: intervals.screen_interval_ms,
            scrollback_lines: intervals.scrollback_lines,
        }
    }
}

/// LAN 開放のパスワードの状態（設計§8-3）。
#[derive(Debug, Serialize)]
pub struct LanPasswordView {
    /// そもそもこの構成に LAN パスワードがあるか（ローカルモードだけ）
    pub supported: bool,
    /// 登録済みか。**値そのものは返さない**（ハッシュしか持っていない）
    pub configured: bool,
    /// いま変えられるか。**127.0.0.1 からだけ**（§8-3）
    pub editable: bool,
}

#[derive(Clone)]
pub struct SettingsState {
    /// 画面から書き換えられる設定の持ち主。**居なくても動く**ので、統合テストは
    /// 設定画面を立てずにセッションの検証だけができる。
    pub store: Option<Arc<SettingsStore>>,
    /// 別名の実測は [`SessionManager`] が持っているので、応答を作るときに引く。
    pub manager: Arc<SessionManager>,
    /// 入口の鍵（設計§8-1）。LAN パスワードの読み書きと、モードの出し分けに要る
    pub auth: Arc<AuthContext>,
    /// 使用上限の保管（status設計）。**`SettingsView::machine_rate_limits` をかぶせるため
    /// だけに要る**——DB には持たないので、応答を作るたびにここから引く。
    pub registry: Arc<SessionRegistry>,
}

pub fn routes(state: SettingsState) -> Router {
    Router::new()
        // 設定は接続のたびに流すほど変わらないので、WebSocket ではなく REST に置く
        .route("/api/settings", get(api_settings).put(api_update_settings))
        // 持ち出し（持ち出し設計§11）。**両モードで同じ形の口を生やす**
        .route("/api/settings/export", get(api_export))
        .route("/api/settings/import", post(api_import))
        .with_state(state)
}

/// サーバモードの設定（設計§13-4・§21 読み替え1）。
///
/// # 材料が PC 側にしか無い
///
/// 権限モードとトグルは、**起動している CLI がある場所**にしか無い。サーバモードには
/// ローカルの CLI が居ないので、繋がっている PC が名乗ったもの（Hello）と、保存して
/// ある表（`agents.model_table`）から組み立てる。
pub fn server_routes(hub: Arc<server_core::gateway::SessionHostHub>) -> Router {
    Router::new()
        .route(
            "/api/settings",
            get(api_server_settings).put(api_server_update_settings),
        )
        .route("/api/settings/export", get(api_server_export))
        .route("/api/settings/import", post(api_server_import))
        .with_state(hub)
}

async fn api_server_settings(
    State(hub): State<Arc<server_core::gateway::SessionHostHub>>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<SettingsView>, (StatusCode, String)> {
    // 名乗った中身は DB にある（`agents.capabilities`）。**接続表ではなく保存を見る**
    // のは、ブラウザが繋がったインスタンスにその PC が居ないことがあるため（設計§9-2）。
    // 出すのは**いまどこかに繋がっている PC のぶんだけ**——落ちている PC のモードを
    // 出すと、選んでから「繋がっていません」と断られる
    let online = hub.online_of(identity.account_id).await;
    let capabilities: Vec<server_core::gateway::Capabilities> =
        db::pairing::capabilities_of(hub.db(), identity.account_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|(agent_id, _)| online.contains(agent_id))
            .filter_map(|(_, value)| serde_json::from_value(value).ok())
            .collect();

    // **受け付けるモードは合併する。** PC ごとに CLI の版が違えば選択肢も違うので、
    // どれか1台に揃えると他の PC で選べないモードが消える。選んだモードが通るかは
    // 送った先の PC が決める（通らなければ `Error` が返る）
    let mut available_modes: Vec<protocol::PermissionMode> = Vec::new();
    for capability in &capabilities {
        for mode in &capability.available_modes {
            if !available_modes.contains(mode) {
                available_modes.push(mode.clone());
            }
        }
    }

    // **他のアカウントの PC の表は含めない**（§8-6 の REST の行）
    let mut model_tables = BTreeMap::new();
    for (agent_id, table) in db::pairing::model_tables(hub.db(), identity.account_id)
        .await
        .unwrap_or_default()
    {
        model_tables.insert(agent_id.to_string(), table);
    }

    let intervals = db::settings::intervals(hub.db(), identity.account_id)
        .await
        .unwrap_or_default();

    Ok(Json(SettingsView {
        // 記録が正。**まだ画面から触っていなければ、名乗った値を初期値にする**
        // （持ち出し設計§3）。1台でも「既定はスキップ」なら画面もそれに従う
        always_bypass_permissions: db::settings::always_bypass_or(
            hub.db(),
            identity.account_id,
            capabilities
                .iter()
                .any(|capability| capability.always_bypass_permissions),
        )
        .await,
        project_autostart_session: db::settings::project_autostart_session(
            hub.db(),
            identity.account_id,
        )
        .await,
        motion_quiet: db::settings::motion_quiet(hub.db(), identity.account_id).await,
        available_modes,
        model_tables,
        agents: server_core::account::agents_of(&hub, identity.account_id).await?,
        intervals: intervals.into(),
        memo_limits: db::settings::memo_limits(hub.db(), identity.account_id)
            .await
            .unwrap_or_default()
            .into(),
        writable_roots: db::settings::writable_roots(hub.db(), identity.account_id).await,
        file_modes: db::settings::file_modes(hub.db(), identity.account_id).await,
        // **サーバモードに「この機械」は無い。** claude が走るのは繋いできた PC の
        // 側だけなので、使用上限は1つ残らず上の `agents` の各行に乗る（`agents_of`
        // がかぶせている）。**ここを埋めると、同じ数字が2箇所に並ぶ**
        machine_rate_limits: None,
        // セルフホストの鍵はアカウントのほう（§8-3 が LAN の検査から除外している）
        lan_password: LanPasswordView {
            supported: false,
            configured: false,
            editable: false,
        },
    }))
}

/// `PUT /api/settings` の本文。
///
/// **全部が省略できる。** 画面は触った項目だけを送る——1項目のために全部を送り直すと、
/// 別のタブが同時に開いていたときに、そちらの変更を巻き戻すことになる。
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SettingsUpdate {
    pub always_bypass_permissions: Option<bool>,
    pub project_autostart_session: Option<bool>,
    /// LAN 開放の共有パスワード（設計§8-3）。**平文で受けてここでハッシュにする。**
    ///
    /// 受け付けるのは**ローカルモードの 127.0.0.1 から**だけ。LAN の向こうから
    /// 変えられると、いま入っている誰かが鍵を掛け替えられることになる。
    pub lan_password: Option<String>,
    pub sync_interval_secs: Option<u64>,
    pub screen_interval_ms: Option<u64>,
    pub scrollback_lines: Option<u64>,
    /// 静けさの段（カード設計§9-5-2）。3値のいずれか。
    ///
    /// **serde では絞れない**（ただの文字列なので）。`check()` で明示的に見る——
    /// ここを外すと、知らない綴りがそのまま記録へ入る。
    pub motion_quiet: Option<String>,
    /// メモと画像を何日残すか（要件10・メモ設計§11-2）。
    ///
    /// **範囲は `check()` が見る**（1〜365日）。**0 を弾いているのは「無期限」に
    /// あたる値を作らせないため**——要件が「無期限と無制限は必要無い」と明記している。
    pub memo_retention_days: Option<u64>,
    /// メモの画像の合計の上限（要件10・メモ設計§11-2）。
    ///
    /// **範囲は `check()` が見る**（1 MiB〜20 GB）。下限が 0 でないのは、
    /// **書いた先から消える設定を作れると壊れているのと見分けが付かない**ため。
    pub memo_max_bytes: Option<u64>,
    /// 書き込みを許可する場所（設計§3-5）。**一覧ごと差し替える。**
    ///
    /// **1件ずつ足し引きする形にしない。** 同時に2つのタブが開いていると、
    /// **消したはずの場所が相手の送信で戻る**——書ける範囲がそうやって広がるのは、
    /// いちばん気づきにくい広がり方である。
    ///
    /// **中身は `check()` が見る**（絶対パスであること・空でないこと）。
    pub writable_roots: Option<Vec<String>>,
    /// 拡張子ごとの見せ方（要件③）。**対応ごと差し替える。**
    ///
    /// **1件ずつ足し引きする形にしない**のは [`Self::writable_roots`] と同じ理由で、
    /// 2つのタブが開いていると**消したはずの行が相手の送信で戻る**。
    ///
    /// **中身は `check()` が見る**（見せ方が2つのどちらか・拡張子が小文字で `.` 無し）。
    pub file_modes: Option<std::collections::BTreeMap<String, String>>,
}

impl SettingsUpdate {
    /// 入れてよい値かを確かめる。**ファイルからの読み込みと同じ検査を通す**（持ち出し
    /// 設計§9）。
    ///
    /// 画面は選択肢と入力欄で値を絞っているが、REST は直に叩ける。ここを通さないと
    /// `sync_interval_secs = 0` のような値がそのまま入る。
    fn check(&self) -> Result<(), (StatusCode, String)> {
        for (key, value) in [
            (db::settings::SYNC_INTERVAL_SECS, self.sync_interval_secs),
            (db::settings::SCREEN_INTERVAL_MS, self.screen_interval_ms),
            (db::settings::SCROLLBACK_LINES, self.scrollback_lines),
            (db::settings::MEMO_RETENTION_DAYS, self.memo_retention_days),
            (db::settings::MEMO_MAX_BYTES, self.memo_max_bytes),
        ] {
            if let Some(value) = value {
                db::settings::check(key, &serde_json::json!(value))
                    .map_err(|reason| (StatusCode::BAD_REQUEST, reason))?;
            }
        }
        // **文字列は serde が絞ってくれない。** 真偽値と数値は型で弾けるが、3段は
        // ただの文字列なので、ここを通さないと知らない綴りがそのまま記録へ入る
        if let Some(段) = &self.motion_quiet {
            db::settings::check(db::settings::MOTION_QUIET, &serde_json::json!(段))
                .map_err(|reason| (StatusCode::BAD_REQUEST, reason))?;
        }
        // **一覧も serde では絞れない。** 絶対パスかどうかは型に出ないので、ここを
        // 通さないと相対パスがそのまま記録へ入る——**どこからの相対かが決まらない**
        if let Some(roots) = &self.writable_roots {
            db::settings::check(db::settings::WRITABLE_ROOTS, &serde_json::json!(roots))
                .map_err(|reason| (StatusCode::BAD_REQUEST, reason))?;
        }
        // **対応も serde では絞れない。** 見せ方はただの文字列なので、ここを通さないと
        // 知らない綴りが記録へ入る——画面は知らない値を既定へ落として描くので、
        // **「設定したのに効かない」だけに見える**
        if let Some(対応) = &self.file_modes {
            db::settings::check(db::settings::FILE_MODES, &serde_json::json!(対応))
                .map_err(|reason| (StatusCode::BAD_REQUEST, reason))?;
        }
        Ok(())
    }

    /// 間隔の指定が1つでもあるか。
    fn touches_intervals(&self) -> bool {
        self.sync_interval_secs.is_some()
            || self.screen_interval_ms.is_some()
            || self.scrollback_lines.is_some()
    }

    /// メモの保持の指定が1つでもあるか。
    fn touches_memo_limits(&self) -> bool {
        self.memo_retention_days.is_some() || self.memo_max_bytes.is_some()
    }

    /// いまの値へ、指定されたぶんだけ被せる（メモの保持）。
    ///
    /// **`put_memo_limits` は2つまとめて書く形**なので、片方だけ指定されたときに
    /// もう片方を既定へ落とさないよう、いまの値を土台にする。
    fn merged_memo_limits(&self, current: db::settings::MemoLimits) -> db::settings::MemoLimits {
        db::settings::MemoLimits {
            retention_days: self.memo_retention_days.unwrap_or(current.retention_days),
            max_bytes: self.memo_max_bytes.unwrap_or(current.max_bytes),
        }
    }

    /// いまの値へ、指定されたぶんだけ被せる。
    fn merged(&self, current: db::settings::Intervals) -> db::settings::Intervals {
        db::settings::Intervals {
            sync_interval_secs: self
                .sync_interval_secs
                .unwrap_or(current.sync_interval_secs),
            screen_interval_ms: self
                .screen_interval_ms
                .unwrap_or(current.screen_interval_ms),
            scrollback_lines: self.scrollback_lines.unwrap_or(current.scrollback_lines),
        }
    }
}

/// `GET /api/settings` — 画面が読む設定（設計§7・§8）。
///
/// 起動時の既定のモードと切替UIの選択肢がこれで決まる。**保存先がサーバなので、別のタブで
/// 開いても同じ値になる。**
pub async fn api_settings(
    State(state): State<SettingsState>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<SettingsView>, (StatusCode, String)> {
    let store = state
        .store
        .as_ref()
        .ok_or((StatusCode::NOT_FOUND, "設定を扱えません".to_string()))?;
    let intervals = db::settings::intervals(state.auth.db(), identity.account_id)
        .await
        .unwrap_or_default();

    Ok(Json(SettingsView {
        // 記録が正。**まだ画面から触っていなければ `config.toml` の値**（同§3）
        always_bypass_permissions: db::settings::always_bypass_or(
            state.auth.db(),
            identity.account_id,
            store.always_bypass_permissions(),
        )
        .await,
        project_autostart_session: db::settings::project_autostart_session(
            state.auth.db(),
            identity.account_id,
        )
        .await,
        motion_quiet: db::settings::motion_quiet(state.auth.db(), identity.account_id).await,
        available_modes: store.available_modes().to_vec(),
        model_tables: store.local_model_tables(&state.manager.aliases().all()),
        // ローカルモードに PC という単位は無い（`"local"` を1台として並べない）。
        //
        // **したがって使用上限はここから出ない**（status設計）。出し先は下の
        // `machine_rate_limits` である——`account::no_agents` の doc に経緯がある
        agents: server_core::account::no_agents(),
        intervals: intervals.into(),
        lan_password: lan_password_view(&state.auth, &identity).await,
        memo_limits: db::settings::memo_limits(state.auth.db(), identity.account_id)
            .await
            .unwrap_or_default()
            .into(),
        writable_roots: db::settings::writable_roots(state.auth.db(), identity.account_id).await,
        file_modes: db::settings::file_modes(state.auth.db(), identity.account_id).await,
        // **手元の保管からかぶせる**（DB には無い）。`agents_of` が
        // `Some(AgentId(..))` で引くのと対で、ローカルは `None` が鍵である。
        // 届いていなければ `None` のまま——画面は「まだ分からない」と「0%」を
        // 別に描く決まりなので、捏造しない
        machine_rate_limits: state.registry.rate_limits_of(identity.account_id, None),
    }))
}

/// `PUT /api/settings` — 触った項目だけを書き換える（設計§7・§8-3・§13-3）。
pub async fn api_update_settings(
    State(state): State<SettingsState>,
    Extension(identity): Extension<Identity>,
    Json(update): Json<SettingsUpdate>,
) -> Result<Json<SettingsView>, (StatusCode, String)> {
    update.check()?;

    if let Some(password) = &update.lan_password {
        // **登録できるのは 127.0.0.1 からだけ**（設計§8-3）。LAN の向こうから
        // 変えられると、いま入っている誰かが鍵を掛け替えられる
        if !identity.from_loopback {
            return Err((
                StatusCode::FORBIDDEN,
                "LAN のパスワードは、この PC のブラウザ（127.0.0.1）からのみ変更できます"
                    .to_string(),
            ));
        }
        server_core::auth::set_lan_password(state.auth.db(), password).await?;
    }

    if update.touches_intervals() {
        let current = db::settings::intervals(state.auth.db(), identity.account_id)
            .await
            .unwrap_or_default();
        // ローカルモードには配る相手（PC）が居ないので、保存だけで足りる。
        // 履歴の同期間隔はセッションホスト側が起動時に読む（§13-3）
        db::settings::put_intervals(state.auth.db(), identity.account_id, update.merged(current))
            .await
            .map_err(|err| {
                tracing::error!("間隔を保存できません: {err}");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "設定を保存できません".to_string(),
                )
            })?;
    }

    if let Some(value) = update.always_bypass_permissions {
        db::settings::set_always_bypass_permissions(state.auth.db(), identity.account_id, value)
            .await
            .map_err(save_failed)?;
    }

    if let Some(value) = update.project_autostart_session {
        db::settings::set_project_autostart_session(state.auth.db(), identity.account_id, value)
            .await
            .map_err(save_failed)?;
    }

    if let Some(段) = &update.motion_quiet {
        db::settings::set_motion_quiet(state.auth.db(), identity.account_id, 段)
            .await
            .map_err(save_failed)?;
    }

    if let Some(roots) = &update.writable_roots {
        db::settings::set_writable_roots(state.auth.db(), identity.account_id, roots)
            .await
            .map_err(save_failed)?;
    }

    if let Some(対応) = &update.file_modes {
        db::settings::set_file_modes(state.auth.db(), identity.account_id, 対応)
            .await
            .map_err(save_failed)?;
    }

    if update.touches_memo_limits() {
        let current = db::settings::memo_limits(state.auth.db(), identity.account_id)
            .await
            .unwrap_or_default();
        db::settings::put_memo_limits(
            state.auth.db(),
            identity.account_id,
            update.merged_memo_limits(current),
        )
        .await
        .map_err(save_failed)?;
    }

    // **設定の持ち主が居なくても、DB のぶんは保存できている。** 居ないことを理由に
    // 404 を返すと、保存されたのに失敗したように見える（統合テストは画面を立てずに
    // セッションだけを確かめることがある）
    if state.store.is_none() {
        let intervals = db::settings::intervals(state.auth.db(), identity.account_id)
            .await
            .unwrap_or_default();
        return Ok(Json(SettingsView {
            always_bypass_permissions: db::settings::always_bypass_or(
                state.auth.db(),
                identity.account_id,
                false,
            )
            .await,
            project_autostart_session: db::settings::project_autostart_session(
                state.auth.db(),
                identity.account_id,
            )
            .await,
            motion_quiet: db::settings::motion_quiet(state.auth.db(), identity.account_id).await,
            available_modes: Vec::new(),
            model_tables: BTreeMap::new(),
            agents: server_core::account::no_agents(),
            intervals: intervals.into(),
            lan_password: lan_password_view(&state.auth, &identity).await,
            memo_limits: db::settings::memo_limits(state.auth.db(), identity.account_id)
                .await
                .unwrap_or_default()
                .into(),
            writable_roots: db::settings::writable_roots(state.auth.db(), identity.account_id)
                .await,
            file_modes: db::settings::file_modes(state.auth.db(), identity.account_id).await,
            machine_rate_limits: state.registry.rate_limits_of(identity.account_id, None),
        }));
    }
    api_settings(State(state), Extension(identity)).await
}

/// サーバモードの `PUT /api/settings`（LAN パスワード以外を受ける）。
///
/// LAN パスワードはローカル専用（§8-3）。**受けられないものは受けたふりをしない**
/// ——保存されないのに 200 を返すと、画面には反映されたのに次の再読み込みで戻る。
///
/// **トグルはこちらでも受ける**（持ち出し設計§6）。保存先が記録になったので、
/// ローカルと同じ道で書ける。
async fn api_server_update_settings(
    State(hub): State<Arc<server_core::gateway::SessionHostHub>>,
    Extension(identity): Extension<Identity>,
    Json(update): Json<SettingsUpdate>,
) -> Result<Json<SettingsView>, (StatusCode, String)> {
    update.check()?;

    if update.lan_password.is_some() {
        return Err((
            StatusCode::FORBIDDEN,
            "LAN のパスワードはローカルモードだけの設定です".to_string(),
        ));
    }

    if update.touches_intervals() {
        let current = db::settings::intervals(hub.db(), identity.account_id)
            .await
            .unwrap_or_default();
        // **保存して、そのアカウントの PC へ即時に配る**（設計§13-3）。次回接続まで
        // 古い間隔で送り続けさせない
        hub.set_intervals(identity.account_id, update.merged(current))
            .await
            .map_err(|err| {
                tracing::error!("間隔を保存できません: {err}");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "設定を保存できません".to_string(),
                )
            })?;
    }

    if let Some(value) = update.always_bypass_permissions {
        db::settings::set_always_bypass_permissions(hub.db(), identity.account_id, value)
            .await
            .map_err(save_failed)?;
    }

    if let Some(value) = update.project_autostart_session {
        db::settings::set_project_autostart_session(hub.db(), identity.account_id, value)
            .await
            .map_err(save_failed)?;
    }

    if let Some(段) = &update.motion_quiet {
        db::settings::set_motion_quiet(hub.db(), identity.account_id, 段)
            .await
            .map_err(save_failed)?;
    }

    if let Some(roots) = &update.writable_roots {
        db::settings::set_writable_roots(hub.db(), identity.account_id, roots)
            .await
            .map_err(save_failed)?;
    }

    if let Some(対応) = &update.file_modes {
        db::settings::set_file_modes(hub.db(), identity.account_id, 対応)
            .await
            .map_err(save_failed)?;
    }

    if update.touches_memo_limits() {
        let current = db::settings::memo_limits(hub.db(), identity.account_id)
            .await
            .unwrap_or_default();
        db::settings::put_memo_limits(
            hub.db(),
            identity.account_id,
            update.merged_memo_limits(current),
        )
        .await
        .map_err(save_failed)?;
    }

    api_server_settings(State(hub), Extension(identity)).await
}

/// `POST /api/settings/import` の応答（持ち出し設計§9）。
///
/// **無視したものを黙って捨てない。** 反映されない項目があることが伝わらないと、
/// 「読み込んだのに効いていない」が説明の付かない現象になる。
#[derive(Debug, Serialize)]
pub struct ImportOutcome {
    pub applied: Vec<String>,
    pub ignored: Vec<String>,
}

/// 書き出しをダウンロードとして返す（持ち出し設計§13）。
///
/// **サーバ側にファイルを作らない。** 置き場所を決める必要が無く、消す責任も生まれない。
fn download(exported: server_core::portable::Exported) -> Result<Response, (StatusCode, String)> {
    let body = serde_json::to_string_pretty(&exported)
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/json"),
            (
                axum::http::header::CONTENT_DISPOSITION,
                "attachment; filename=\"agentdashboard-settings.json\"",
            ),
        ],
        body,
    )
        .into_response())
}

/// `GET /api/settings/export` — ローカルモード。
async fn api_export(
    State(state): State<SettingsState>,
    Extension(identity): Extension<Identity>,
) -> Result<Response, (StatusCode, String)> {
    let intervals = db::settings::intervals(state.auth.db(), identity.account_id)
        .await
        .unwrap_or_default();
    // **画面に出ている値を書き出す**（同§7）。行が無いものは初期値で埋まる
    let always_bypass = db::settings::always_bypass_or(
        state.auth.db(),
        identity.account_id,
        state
            .store
            .as_ref()
            .is_some_and(|store| store.always_bypass_permissions()),
    )
    .await;
    let memo_limits = db::settings::memo_limits(state.auth.db(), identity.account_id)
        .await
        .unwrap_or_default();
    download(server_core::portable::exported(
        intervals,
        memo_limits,
        always_bypass,
        db::settings::project_autostart_session(state.auth.db(), identity.account_id).await,
        &db::settings::motion_quiet(state.auth.db(), identity.account_id).await,
        env!("CARGO_PKG_VERSION"),
    ))
}

/// `POST /api/settings/import` — ローカルモード。
async fn api_import(
    State(state): State<SettingsState>,
    Extension(identity): Extension<Identity>,
    body: String,
) -> Result<Json<ImportOutcome>, (StatusCode, String)> {
    let parsed =
        server_core::portable::parse(&body).map_err(|reason| (StatusCode::BAD_REQUEST, reason))?;

    if parsed.touches_intervals() {
        let current = db::settings::intervals(state.auth.db(), identity.account_id)
            .await
            .unwrap_or_default();
        // **書くのは既存の道**（同§12）。ローカルには配る相手が居ないので保存だけ
        db::settings::put_intervals(
            state.auth.db(),
            identity.account_id,
            parsed.merged_intervals(current),
        )
        .await
        .map_err(save_failed)?;
    }
    if let Some(value) = parsed.always_bypass_permissions() {
        db::settings::set_always_bypass_permissions(state.auth.db(), identity.account_id, value)
            .await
            .map_err(save_failed)?;
    }
    if let Some(value) = parsed.project_autostart_session() {
        db::settings::set_project_autostart_session(state.auth.db(), identity.account_id, value)
            .await
            .map_err(save_failed)?;
    }
    if let Some(段) = parsed.motion_quiet() {
        db::settings::set_motion_quiet(state.auth.db(), identity.account_id, 段)
            .await
            .map_err(save_failed)?;
    }
    if parsed.touches_memo_limits() {
        // **書き出せるのに読み戻せないのは非対称**（要件10）。同じファイルを往復
        // させただけで、この2つだけ向こうの値が残る
        let current = db::settings::memo_limits(state.auth.db(), identity.account_id)
            .await
            .unwrap_or_default();
        db::settings::put_memo_limits(
            state.auth.db(),
            identity.account_id,
            parsed.merged_memo_limits(current),
        )
        .await
        .map_err(save_failed)?;
    }

    Ok(Json(ImportOutcome {
        applied: parsed.applied(),
        ignored: parsed.ignored().to_vec(),
    }))
}

/// `GET /api/settings/export` — サーバモード。
async fn api_server_export(
    State(hub): State<Arc<server_core::gateway::SessionHostHub>>,
    Extension(identity): Extension<Identity>,
) -> Result<Response, (StatusCode, String)> {
    let intervals = db::settings::intervals(hub.db(), identity.account_id)
        .await
        .unwrap_or_default();
    let always_bypass = db::settings::always_bypass_or(hub.db(), identity.account_id, false).await;
    let memo_limits = db::settings::memo_limits(hub.db(), identity.account_id)
        .await
        .unwrap_or_default();
    download(server_core::portable::exported(
        intervals,
        memo_limits,
        always_bypass,
        db::settings::project_autostart_session(hub.db(), identity.account_id).await,
        &db::settings::motion_quiet(hub.db(), identity.account_id).await,
        env!("CARGO_PKG_VERSION"),
    ))
}

/// `POST /api/settings/import` — サーバモード。
async fn api_server_import(
    State(hub): State<Arc<server_core::gateway::SessionHostHub>>,
    Extension(identity): Extension<Identity>,
    body: String,
) -> Result<Json<ImportOutcome>, (StatusCode, String)> {
    let parsed =
        server_core::portable::parse(&body).map_err(|reason| (StatusCode::BAD_REQUEST, reason))?;

    if parsed.touches_intervals() {
        let current = db::settings::intervals(hub.db(), identity.account_id)
            .await
            .unwrap_or_default();
        // **保存して、そのアカウントの PC へ即時に配る**（同§12）。読み込みだけ
        // 別の道を作ると、配り直しがそちらにだけ無いという食い違いが生まれる
        hub.set_intervals(identity.account_id, parsed.merged_intervals(current))
            .await
            .map_err(save_failed)?;
    }
    if let Some(value) = parsed.always_bypass_permissions() {
        db::settings::set_always_bypass_permissions(hub.db(), identity.account_id, value)
            .await
            .map_err(save_failed)?;
    }
    if let Some(value) = parsed.project_autostart_session() {
        db::settings::set_project_autostart_session(hub.db(), identity.account_id, value)
            .await
            .map_err(save_failed)?;
    }
    if let Some(段) = parsed.motion_quiet() {
        db::settings::set_motion_quiet(hub.db(), identity.account_id, 段)
            .await
            .map_err(save_failed)?;
    }
    if parsed.touches_memo_limits() {
        // ローカルモードと同じ（要件10）。**両モードで同じ答えになる**ことが持ち出しの前提
        let current = db::settings::memo_limits(hub.db(), identity.account_id)
            .await
            .unwrap_or_default();
        db::settings::put_memo_limits(
            hub.db(),
            identity.account_id,
            parsed.merged_memo_limits(current),
        )
        .await
        .map_err(save_failed)?;
    }

    Ok(Json(ImportOutcome {
        applied: parsed.applied(),
        ignored: parsed.ignored().to_vec(),
    }))
}

/// 保存に失敗したときの返し方。
///
/// **黙って失敗すると「変えたのに戻る」**という追いにくい形になるので、必ず断りを返す。
/// 記録の道具の型を書かずに済ませるため、表示できるものなら何でも受ける
/// （`crates/core` は sea-orm を通常依存に持っていない）。
fn save_failed<E: std::fmt::Display>(err: E) -> (StatusCode, String) {
    tracing::error!("設定を保存できません: {err}");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "設定を保存できません".to_string(),
    )
}

async fn lan_password_view(auth: &Arc<AuthContext>, identity: &Identity) -> LanPasswordView {
    // **鍵をかけていない構成にも欄を出す。** ローカルで `bind_addr` を広げるには
    // 先にパスワードが要る（起動時検査。§8-3）ので、広げる前に登録できないと
    // 「広げると起動しない」だけになる
    let supported = matches!(auth.mode, AuthMode::Open | AuthMode::LanPassword);
    LanPasswordView {
        supported,
        configured: supported && server_core::auth::lan_password_set(auth.db()).await,
        editable: supported && identity.from_loopback,
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn 空() -> SettingsUpdate {
        SettingsUpdate {
            always_bypass_permissions: None,
            project_autostart_session: None,
            lan_password: None,
            sync_interval_secs: None,
            screen_interval_ms: None,
            scrollback_lines: None,
            motion_quiet: None,
            memo_retention_days: None,
            memo_max_bytes: None,
            writable_roots: None,
            file_modes: None,
        }
    }

    fn 場所(values: &[&str]) -> Option<Vec<String>> {
        Some(values.iter().map(|value| (*value).to_string()).collect())
    }

    fn 見せ方(values: &[(&str, &str)]) -> Option<std::collections::BTreeMap<String, String>> {
        Some(
            values
                .iter()
                .map(|(拡張子, 見せ方)| ((*拡張子).to_string(), (*見せ方).to_string()))
                .collect(),
        )
    }

    /// **拡張子ごとの見せ方は、2つの綴りだけを受ける**（要件③）。
    ///
    /// 知らない綴りを黙って入れると、**画面は既定へ落として描くので「設定したのに
    /// 効かない」だけに見える**。拡張子の形も揃える——`MD` と `md` が別の行として
    /// 残ると、**どちらが効いているか利用者に分からなくなる**。
    #[test]
    fn 拡張子ごとの見せ方は形の揃ったものだけ受ける() {
        for (なぜ, 対応) in [
            ("知らない見せ方", 見せ方(&[("md", "block")])),
            ("大文字の拡張子", 見せ方(&[("MD", "viewer")])),
            ("先頭の点", 見せ方(&[(".md", "viewer")])),
            ("空の拡張子", 見せ方(&[("", "viewer")])),
        ] {
            let update = SettingsUpdate {
                file_modes: 対応,
                ..空()
            };
            let Err((code, reason)) = update.check() else {
                panic!("{なぜ} が通ってしまった");
            };
            assert_eq!(code, StatusCode::BAD_REQUEST, "{なぜ}");
            assert!(reason.contains("file_modes"), "{なぜ}：{reason}");
        }

        // **通る側も見る。** 断る検査しか無いと、全部断るよう壊れていても緑になる
        let update = SettingsUpdate {
            file_modes: 見せ方(&[("md", "editor"), ("json", "viewer")]),
            ..空()
        };
        assert!(update.check().is_ok());

        // **空の対応も通る**——「設定を全部消す」ができないと、一度入れた行を外せない
        let update = SettingsUpdate {
            file_modes: Some(std::collections::BTreeMap::new()),
            ..空()
        };
        assert!(update.check().is_ok());
    }

    /// **書き込みを許可する場所は、絶対パスだけを受ける**（設計§3-5）。
    ///
    /// # なぜここで見るのか
    ///
    /// **相対パスを受けると「どこからの相対か」が決まらない。** 画面は絶対パスしか
    /// 送らないが、**REST と CLI は直に叩ける**ので、画面が絞っていることは担保に
    /// ならない。しかも**ここは間違えると書ける範囲が広がる側**なので、
    /// 「受けたふりをして効かない」では済まない。
    #[test]
    fn 許可する場所は絶対パスだけを受ける() {
        for (name, roots) in [
            ("相対パス", 場所(&["notes"])),
            ("上へ遡る相対パス", 場所(&["../etc"])),
            ("空の場所", 場所(&[""])),
            (
                "絶対パスに混ざった相対パス",
                場所(&["/home/u/notes", "tmp"]),
            ),
        ] {
            let update = SettingsUpdate {
                writable_roots: roots,
                ..空()
            };
            let (status, reason) = update.check().expect_err(&format!("{name} を通した"));
            assert_eq!(status, StatusCode::BAD_REQUEST, "{name}");
            assert!(
                reason.contains("writable_roots"),
                "{name}: どの設定の話か読めない: {reason}"
            );
        }
    }

    #[test]
    fn 許可する場所は絶対パスなら通り空の一覧も通る() {
        assert!(
            SettingsUpdate {
                writable_roots: 場所(&["/home/u/notes", "/dev/app"]),
                ..空()
            }
            .check()
            .is_ok()
        );
        // **空は「どこへも足さない」であって、誤りではない。** 開いている PJT の
        // 配下はコードの側が足すので、空でも書けなくなるわけではない
        assert!(
            SettingsUpdate {
                writable_roots: Some(Vec::new()),
                ..空()
            }
            .check()
            .is_ok()
        );
    }

    /// **範囲の外を断ること**（要件10）。
    ///
    /// # なぜここで見るのか
    ///
    /// **`check()` から1行外しても、機械は何も言わない**——型は通り、画面も動き、
    /// **範囲外の値が黙って記録へ入る**。要件10 が「無期限・無制限を作らない」と
    /// 定めているので、**入口で断ることそのものが要件の中身**である。
    ///
    /// REST は直に叩けるので、**画面が選択肢で絞っていることは担保にならない。**
    #[test]
    fn メモの保持は範囲の外を断る() {
        for (name, update) in [
            (
                "無期限にあたる 0 日",
                SettingsUpdate {
                    memo_retention_days: Some(0),
                    ..空()
                },
            ),
            (
                "12か月を超える日数",
                SettingsUpdate {
                    memo_retention_days: Some(366),
                    ..空()
                },
            ),
            (
                "無制限にあたる 0 バイト",
                SettingsUpdate {
                    memo_max_bytes: Some(0),
                    ..空()
                },
            ),
            (
                "20GB を超える容量",
                SettingsUpdate {
                    memo_max_bytes: Some(21 * 1024 * 1024 * 1024),
                    ..空()
                },
            ),
        ] {
            let (status, reason) = update.check().expect_err(&format!("{name} を通した"));
            assert_eq!(status, StatusCode::BAD_REQUEST, "{name}");
            // **断り文に範囲が入ること。** 「駄目です」だけでは直しようがない
            assert!(reason.contains('〜'), "{name}: 範囲が読めない: {reason}");
        }
    }

    #[test]
    fn 範囲の中は通る() {
        assert!(
            SettingsUpdate {
                memo_retention_days: Some(360),
                memo_max_bytes: Some(20 * 1024 * 1024 * 1024),
                ..空()
            }
            .check()
            .is_ok()
        );
    }

    /// **触っていない項目を書かないこと。** 片方だけ指定して、もう片方が既定へ
    /// 落ちると、**他のタブの変更を巻き戻す**。
    #[test]
    fn 片方だけ指定してももう片方は残る() {
        let いま = db::settings::MemoLimits {
            retention_days: 30,
            max_bytes: 5 * 1024 * 1024 * 1024,
        };
        let merged = SettingsUpdate {
            memo_retention_days: Some(90),
            ..空()
        }
        .merged_memo_limits(いま);

        assert_eq!(merged.retention_days, 90, "指定したものは反映する");
        assert_eq!(merged.max_bytes, いま.max_bytes, "指定していないものは残す");
    }
}
