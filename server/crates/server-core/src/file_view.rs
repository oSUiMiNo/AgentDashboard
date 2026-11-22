//! ファイル閲覧の上限の決まり（`ファイル閲覧の上限を設定から変え、大きいものは流し読みする` 設計§7-1）。
//!
//! **判定の材料は持たない**——PC にも `/sys` にも触らない。起動の形とクラウドの判定は、
//! 起動の道（`core`）が決めて差し込む。ここが持つのは「材料が分かったら、上限と警告を
//! どう決めるか」の規則だけである。
//!
//! # なぜ `protocol` に置かないのか
//! 既定・警告の線・プレビューの天井・起動の形は**サーバだけが使う**。PC（セッションホスト）は
//! 渡された上限で断るだけなので、知らなくてよいものを共有境界へ持ち込まない（設計§1）。

use protocol::fs::FILE_VIEW_LIMIT_CHOICES;
use sea_orm::DatabaseConnection;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

/// サーバを介さない（ローカルモード）ときの既定。要件の「ローカル 5GB」。
pub const DEFAULT_LOCAL_BYTES: u64 = 5 * GIB;

/// サーバを介す（サーバモード）ときの既定。要件の「サーバ 3MB」。いままでの上限と同じ値なので、
/// 何も選んでいないセルフホストの振る舞いは変わらない。
pub const DEFAULT_SERVER_BYTES: u64 = 3 * MIB;

/// 警告を出し始める値。要件の「5MB 以上で警告」。
pub const WARN_FROM_BYTES: u64 = 5 * MIB;

/// HTML・SVG を描いた形（箱）で見せてよい大きさ。これを超えたら生テキストの窓だけになる。
///
/// 【エージェントの仮置き（利用者未承認）】32 MiB。設計§13-2 の実測（ブラウザが描き終わる
/// までの時間と、描画のメモリの増え方）で決め直す。
pub const PREVIEW_MAX_BYTES: u64 = 32 * MIB;

// 天井は一括で読む線より大きくないと意味が無い（線の内側はいまどおり全文で返るので、
// 天井が線以下だと「流して返す」道が1度も通らない）。値を決め直すときに崩さないよう固定する
const _: () = assert!(PREVIEW_MAX_BYTES > protocol::fs::WHOLE_TEXT_BYTES);

/// 起動の形。
///
/// **既定は `Server`＝安全側（3 MiB）。** 起動の道が差し込み忘れたとき、大きい既定で
/// 黙って開くより、小さい既定で断るほうが取り返しがつく。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Deployment {
    /// ローカルモード（ブラウザ ↔ この機械。サーバを1バイトも経由しない）。
    Local,
    /// サーバモード（ブラウザ ↔ サーバ ↔ PC）。
    #[default]
    Server,
}

/// クラウドの判定の出どころ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudSource {
    /// `/sys/class/dmi/id` の値から判定した。
    Dmi,
    /// 設定ファイル（`metered_cloud = "yes"`）で指定された。
    Config,
}

/// クラウドの上で動いていると判定したときの中身。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudGuess {
    /// 画面と警告に出す名前（例：「Amazon EC2」）。
    pub name: String,
    pub source: CloudSource,
}

/// 起動の形とクラウドの判定の束。起動の道が1回だけ組んで差し込む。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileViewPolicy {
    pub deployment: Deployment,
    pub cloud: Option<CloudGuess>,
}

impl FileViewPolicy {
    pub fn local(cloud: Option<CloudGuess>) -> Self {
        Self {
            deployment: Deployment::Local,
            cloud,
        }
    }

    pub fn server(cloud: Option<CloudGuess>) -> Self {
        Self {
            deployment: Deployment::Server,
            cloud,
        }
    }

    /// 値を入れていないときの上限。**起動の形だけで決める**（方針§4。クラウドかどうかでは
    /// 変えない——ローカルモードをクラウドで動かす場合の扱いは、利用者に確かめる項目）。
    pub fn default_limit(&self) -> u64 {
        match self.deployment {
            Deployment::Local => DEFAULT_LOCAL_BYTES,
            Deployment::Server => DEFAULT_SERVER_BYTES,
        }
    }

    /// サーバを介すか。
    pub fn via_server(&self) -> bool {
        self.deployment == Deployment::Server
    }

    /// 警告を出し始める値。サーバを介すか、クラウドと判定されているときだけ。
    pub fn warn_from(&self) -> Option<u64> {
        (self.via_server() || self.cloud.is_some()).then_some(WARN_FROM_BYTES)
    }
}

/// 設定を変える瞬間に出す警告の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Warning {
    /// サーバを介すので、転送量が増える。
    ViaServer,
    /// クラウドの上なので、従量課金なら請求に乗る。
    MeteredCloud,
}

/// 上限を `current` から `value` へ変えるときに出す警告を、出す順に返す。
///
/// 【エージェントの仮置き（利用者未承認）】**上げるときだけ**出す（下げる操作に費用の警告を
/// 出しても意味が無い）。順はサーバ → クラウド（設計§7-1）。
///
/// **画面（TS の `warningsFor`）は同じ規則を写す。** 下の試験の見本の表を、フェーズ6 で TS の
/// 試験にも同じ値で置く——両側の表が食い違うと片方が落ちる。
pub fn warnings_for(
    value: u64,
    current: u64,
    via_server: bool,
    metered_cloud: bool,
) -> Vec<Warning> {
    if value < WARN_FROM_BYTES || value <= current {
        return Vec::new();
    }
    let mut warnings = Vec::new();
    if via_server {
        warnings.push(Warning::ViaServer);
    }
    if metered_cloud {
        warnings.push(Warning::MeteredCloud);
    }
    warnings
}

/// いま効いている上限（設計§5-2）。
///
/// 行が無ければ起動の形の既定。**選択肢に無い値と、DB が読めないときも既定へ倒す**——
/// 読めないことを理由にファイルを開けなくしない。ただし**黙っては倒さない**：
/// `kind=file_view_limit_unreadable` を1行残す（後から「なぜ設定が効かないのか」を追えるように）。
pub async fn effective_limit(db: &DatabaseConnection, policy: &FileViewPolicy) -> u64 {
    let fallback = policy.default_limit();
    match crate::db::settings::file_view_max_bytes(db).await {
        Ok(None) => fallback,
        Ok(Some(value)) if FILE_VIEW_LIMIT_CHOICES.contains(&value) => value,
        Ok(Some(value)) => {
            tracing::warn!(
                kind = "file_view_limit_unreadable",
                reason = "not_a_choice",
                value,
                fallback,
                "ファイル閲覧の上限に選択肢に無い値が入っているので、既定で開きます"
            );
            fallback
        }
        Err(err) => {
            tracing::warn!(
                kind = "file_view_limit_unreadable",
                reason = "db",
                error = %err,
                fallback,
                "ファイル閲覧の上限を読めないので、既定で開きます"
            );
            fallback
        }
    }
}

/// 設定の口が画面へ返す、上限のいまの姿（設計§6-2 の `max_bytes`・`configured`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LimitState {
    /// いま効いている上限（[`effective_limit`]）
    pub max_bytes: u64,
    /// 選択肢の値が入っているか（`false`＝起動の形の既定のまま。選択肢に無い値が入っていても
    /// 効いているのは既定なので `false`）
    pub configured: bool,
}

/// 上限のいまの姿を読む。**設定の口（`crates/core`）はここを呼ぶ**——あちらは sea-orm を
/// 通常依存に持たないので、DB の型を引数に書く関数を置けない。
pub async fn limit_state(db: &DatabaseConnection, policy: &FileViewPolicy) -> LimitState {
    let configured = matches!(
        crate::db::settings::file_view_max_bytes(db).await,
        Ok(Some(value)) if FILE_VIEW_LIMIT_CHOICES.contains(&value)
    );
    LimitState {
        max_bytes: effective_limit(db, policy).await,
        configured,
    }
}

/// 上限を変えた前後の効いている値（ログの `from`・`to`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LimitChange {
    pub before: u64,
    pub after: u64,
}

/// 上限を保存し、前後の効いている値を返す。`None` は行を消す＝起動の形の既定へ戻す。
///
/// **呼ぶ前に [`crate::db::settings::check`] を通すこと。** ここは書くだけで、選択肢かどうかを
/// 見ない。変えてよい人かも見ない（設定の口が、ほかの項目を保存する前に見る）。
pub async fn change_limit(
    db: &DatabaseConnection,
    policy: &FileViewPolicy,
    value: Option<u64>,
) -> Result<LimitChange, sea_orm::DbErr> {
    let before = effective_limit(db, policy).await;
    crate::db::settings::set_file_view_max_bytes(db, value).await?;
    let after = effective_limit(db, policy).await;
    Ok(LimitChange { before, after })
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn cloud() -> Option<CloudGuess> {
        Some(CloudGuess {
            name: "Amazon EC2".to_string(),
            source: CloudSource::Dmi,
        })
    }

    #[test]
    fn 既定は起動の形で決まる() {
        assert_eq!(FileViewPolicy::local(None).default_limit(), 5 * GIB);
        assert_eq!(FileViewPolicy::server(None).default_limit(), 3 * MIB);
        // クラウドでも既定は変えない（方針§4）
        assert_eq!(FileViewPolicy::local(cloud()).default_limit(), 5 * GIB);
        // 差し込み忘れは安全側（サーバの既定）
        assert_eq!(FileViewPolicy::default(), FileViewPolicy::server(None));
        assert!(FileViewPolicy::server(None).via_server());
        assert!(!FileViewPolicy::local(None).via_server());
    }

    #[test]
    fn 既定と警告の値は選択肢の中にある() {
        for value in [DEFAULT_LOCAL_BYTES, DEFAULT_SERVER_BYTES, WARN_FROM_BYTES] {
            assert!(
                FILE_VIEW_LIMIT_CHOICES.contains(&value),
                "{value} が選択肢に無い"
            );
        }
    }

    #[test]
    fn 警告を出し始める値はサーバかクラウドのときだけ() {
        assert_eq!(FileViewPolicy::local(None).warn_from(), None);
        assert_eq!(FileViewPolicy::local(cloud()).warn_from(), Some(5 * MIB));
        assert_eq!(FileViewPolicy::server(None).warn_from(), Some(5 * MIB));
        assert_eq!(FileViewPolicy::server(cloud()).warn_from(), Some(5 * MIB));
    }

    /// **この表はフェーズ6 で TS の `warningsFor` の試験にも同じ値で置く。**
    #[test]
    fn 警告の規則の見本の表() {
        use Warning::{MeteredCloud, ViaServer};
        let table: [(u64, u64, bool, bool, &[Warning]); 9] = [
            (5 * MIB, 3 * MIB, true, false, &[ViaServer]),
            (5 * MIB, 3 * MIB, true, true, &[ViaServer, MeteredCloud]),
            (5 * MIB, 3 * MIB, false, true, &[MeteredCloud]),
            (5 * MIB, 3 * MIB, false, false, &[]),
            // 5 MiB 未満は出さない
            (3 * MIB, MIB, true, true, &[]),
            // 下げるときは出さない
            (10 * MIB, 20 * MIB, true, true, &[]),
            // 同じ値＝上げていない
            (5 * MIB, 5 * MIB, true, true, &[]),
            (20 * GIB, 3 * MIB, true, true, &[ViaServer, MeteredCloud]),
            // ローカル・クラウド無し
            (5 * GIB, 3 * MIB, false, false, &[]),
        ];
        for (value, current, via_server, metered, expected) in table {
            assert_eq!(
                warnings_for(value, current, via_server, metered),
                expected,
                "value={value} current={current} via_server={via_server} metered={metered}"
            );
        }
    }
}
