//! この機械がクラウドの上で動いているかの判定（`ファイル閲覧の上限を設定から変え、大きいものは流し読みする` 設計§7-2）。
//!
//! 判定の結果は、ファイル閲覧の上限を上げるときの**2段目の警告**（従量課金なら転送量が
//! 請求に乗る）に使う。起動時に1回だけ読み、[`FileViewPolicy`] にまとめて差し込む。
//!
//! # なぜ `core` に置くのか
//! | 置き場所 | 使えない理由 |
//! |---|---|
//! | `server-core` | `/sys` を読まない（PTY に触らない・機械の素性を持たない作り）。決まり（[`server_core::file_view`]）だけを持つ |
//! | `session-host-core` | PC の側。サーバモードでサーバが動いている機械の判定には使えない |
//! | **`core`** | ローカルでもサーバモードでも起動の道を持っている。判定したいのは**サーバが動いている機械** |
//!
//! # メタデータサービスへは問い合わせない
//! クラウドごとの問い合わせ先（リンクローカルのアドレス）へ聞けば確実だが、**判定そのものが
//! 外向きの通信という副作用を持ち**、クラウドでない機械では時間切れまで起動を遅らせる
//! （方針§5）。誰でも読める DMI の欄だけで決め、外れたときは設定（`metered_cloud`）で上書きする。
//!
//! # 読む欄と出典
//! 表（[`TABLE`]）は次の原文から写した（どれも 2026-11-23 に `main` の版を取得）。**記憶で書かない**。
//! - cloud-init `tools/ds-identify`：<https://raw.githubusercontent.com/canonical/cloud-init/main/tools/ds-identify>
//! - systemd `src/basic/virt.c` の `dmi_vendor_table`：<https://raw.githubusercontent.com/systemd/systemd/main/src/basic/virt.c>
//! - 欄の読める権限：Linux `drivers/firmware/dmi-id.c`：<https://raw.githubusercontent.com/torvalds/linux/master/drivers/firmware/dmi-id.c>
//!
//! **読むのは誰でも読める欄（`0444`）だけ**：`sys_vendor`・`product_name`・`board_vendor`・
//! `chassis_asset_tag` と `/sys/hypervisor/uuid`。`product_uuid`・`product_serial` は root しか
//! 読めない（`0400`）ので読まない。そのため **AWS の Nitro 世代は ds-identify ではなく systemd の
//! 判定から写した**——ds-identify は AWS を `product_uuid` で見分けており、一般の利用者では読めない。
//!
//! **箱（コンテナ）の中でも DMI を見る。** ds-identify は箱の中では DMI を見ないが、判定したいのは
//! 「料金を払う機械か」で、箱の中から見える DMI は外の機械のものだからである。
//!
//! **`sys_vendor = "Microsoft Corporation"` と `product_name = "Virtual Machine"` だけでは Azure に
//! しない。** 手元の Hyper-V（Windows の上の仮想機械）と同じ値なので、Azure は `chassis_asset_tag`
//! で見分ける。

use server_core::file_view::{CloudGuess, CloudSource, Deployment, FileViewPolicy};
use std::path::Path;

/// 設定ファイルの `metered_cloud`。この機械をクラウドの上とみなすか。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MeteredCloud {
    /// 起動時に DMI を読んで判定する。
    #[default]
    Auto,
    /// クラウドとして扱う（箱の中で DMI が読めない構成で確実に効かせたいとき）。
    Yes,
    /// クラウドとして扱わない。
    No,
}

impl MeteredCloud {
    /// `auto`・`yes`・`no` だけを読む。**大小文字も区別する**（`Yes` は読まない）。
    ///
    /// 読み違えると費用の警告が黙って消えるので、ゆるく読まない。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "auto" => Some(Self::Auto),
            "yes" => Some(Self::Yes),
            "no" => Some(Self::No),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Yes => "yes",
            Self::No => "no",
        }
    }
}

/// 読んだ DMI の欄（前後の空白を落とした値。読めない・無いは空）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Dmi {
    pub sys_vendor: String,
    pub product_name: String,
    pub board_vendor: String,
    pub chassis_asset_tag: String,
    /// `/sys/hypervisor/uuid`（Xen 世代の AWS が `ec2` で始まる値を持つ）。
    pub hypervisor_uuid: String,
}

impl Dmi {
    /// 空でない欄の数。起動のログの `dmi_fields` に出す（判定のログには結果ではなく材料の量を残す）。
    ///
    /// **0 なら判定の材料が1つも無かった**（WSL・DMI を見せない箱）ので、「クラウドでない」と
    /// 「見えなかった」を後から見分けられる。
    pub fn fields_read(&self) -> usize {
        [
            &self.sys_vendor,
            &self.product_name,
            &self.board_vendor,
            &self.chassis_asset_tag,
            &self.hypervisor_uuid,
        ]
        .iter()
        .filter(|value| !value.is_empty())
        .count()
    }
}

/// どの欄をどう照合するか。
#[derive(Debug, Clone, Copy)]
enum Field {
    SysVendor,
    ProductName,
    BoardVendor,
    ChassisAssetTag,
    HypervisorUuid,
}

#[derive(Debug, Clone, Copy)]
enum Match {
    /// 完全一致。
    Exact(&'static str),
    /// 先頭が一致。
    Prefix(&'static str),
}

/// 判定の表の1行。
#[derive(Debug, Clone, Copy)]
struct Rule {
    /// 画面と警告に出す名前。
    name: &'static str,
    field: Field,
    matches: Match,
}

/// 判定の表。**上から順に見て、最初に合った行の名前を返す。**
///
/// 1行足したら、試験の `表の陽性を全部見分ける` にも1行足すこと（行の数と陽性の数を比べている）。
const TABLE: &[Rule] = &[
    // ds-identify：Xen 世代の AWS は `/sys/hypervisor/uuid` が `ec2` で始まる
    // （`[ "${uuid#ec2}" != "$uuid" ]`、2026-11-23 の l.1424〜1427）
    Rule {
        name: "Amazon EC2",
        field: Field::HypervisorUuid,
        matches: Match::Prefix("ec2"),
    },
    // systemd virt.c：Nitro 世代の AWS は `sys_vendor`／`board_vendor` が `Amazon EC2` で始まる
    // （`{ "Amazon EC2", VIRTUALIZATION_AMAZON }` を `startswith` で照合、2026-11-23 の l.184・l.207〜212）
    Rule {
        name: "Amazon EC2",
        field: Field::SysVendor,
        matches: Match::Prefix("Amazon EC2"),
    },
    Rule {
        name: "Amazon EC2",
        field: Field::BoardVendor,
        matches: Match::Prefix("Amazon EC2"),
    },
    // ds-identify `dscheck_GCE`（l.1494）
    Rule {
        name: "Google Compute Engine",
        field: Field::ProductName,
        matches: Match::Exact("Google Compute Engine"),
    },
    // ds-identify `is_azure_chassis`（l.1317〜1319）
    Rule {
        name: "Microsoft Azure",
        field: Field::ChassisAssetTag,
        matches: Match::Exact("7783-7084-3265-9085-8269-3286-77"),
    },
    // ds-identify `dscheck_Oracle`（l.1647〜1649）
    Rule {
        name: "Oracle Cloud",
        field: Field::ChassisAssetTag,
        matches: Match::Exact("OracleCloud.com"),
    },
    // ds-identify `dscheck_AliYun`（l.1561）
    Rule {
        name: "Alibaba Cloud ECS",
        field: Field::ProductName,
        matches: Match::Exact("Alibaba Cloud ECS"),
    },
    // ds-identify `dscheck_DigitalOcean`（l.1096）
    Rule {
        name: "DigitalOcean",
        field: Field::SysVendor,
        matches: Match::Exact("DigitalOcean"),
    },
    // ds-identify `dscheck_Hetzner`（l.1638）
    Rule {
        name: "Hetzner",
        field: Field::SysVendor,
        matches: Match::Exact("Hetzner"),
    },
    // ds-identify `dscheck_Vultr`（l.1703）
    Rule {
        name: "Vultr",
        field: Field::SysVendor,
        matches: Match::Exact("Vultr"),
    },
    // ds-identify `dscheck_Akamai`（l.847〜848）。旧名 Linode と新名 Akamai の両方
    Rule {
        name: "Akamai（Linode）",
        field: Field::SysVendor,
        matches: Match::Exact("Linode"),
    },
    Rule {
        name: "Akamai（Linode）",
        field: Field::SysVendor,
        matches: Match::Exact("Akamai"),
    },
    // ds-identify `dscheck_Scaleway`（l.1622）
    Rule {
        name: "Scaleway",
        field: Field::SysVendor,
        matches: Match::Exact("Scaleway"),
    },
    // ds-identify `dscheck_UpCloud`（l.1112）
    Rule {
        name: "UpCloud",
        field: Field::SysVendor,
        matches: Match::Exact("UpCloud"),
    },
];

/// `<sys_root>/sys/class/dmi/id/…` と `<sys_root>/sys/hypervisor/uuid` を読む。
///
/// **本番は `Path::new("/")`。** 引数にしてあるのは、試験で一時フォルダに偽の `/sys` を組んで、
/// 陽性・陰性・Hyper-V の取り違えを通すため（試験で本物の `/` を読むと、試す機械によって答えが変わる）。
pub fn read_dmi(sys_root: &Path) -> Dmi {
    let dmi = sys_root.join("sys/class/dmi/id");
    let read = |path: &Path| {
        std::fs::read_to_string(path)
            .map(|text| text.trim().to_string())
            .unwrap_or_default()
    };
    Dmi {
        sys_vendor: read(&dmi.join("sys_vendor")),
        product_name: read(&dmi.join("product_name")),
        board_vendor: read(&dmi.join("board_vendor")),
        chassis_asset_tag: read(&dmi.join("chassis_asset_tag")),
        hypervisor_uuid: read(&sys_root.join("sys/hypervisor/uuid")),
    }
}

/// 表に照らして、クラウドの名前を返す。合わなければ `None`。
pub fn identify(dmi: &Dmi) -> Option<&'static str> {
    TABLE.iter().find_map(|rule| {
        let value = match rule.field {
            Field::SysVendor => &dmi.sys_vendor,
            Field::ProductName => &dmi.product_name,
            Field::BoardVendor => &dmi.board_vendor,
            Field::ChassisAssetTag => &dmi.chassis_asset_tag,
            Field::HypervisorUuid => &dmi.hypervisor_uuid,
        };
        let hit = match rule.matches {
            Match::Exact(expected) => value == expected,
            Match::Prefix(prefix) => value.starts_with(prefix),
        };
        hit.then_some(rule.name)
    })
}

/// `sys_root` の DMI を読んで、クラウドの名前を返す。
pub fn detect(sys_root: &Path) -> Option<String> {
    identify(&read_dmi(sys_root)).map(str::to_string)
}

/// 設定と読んだ DMI から、クラウドの判定を決める。
///
/// | 設定 | DMI で見分けられた | 見分けられない |
/// |---|---|---|
/// | `auto` | その名前（出どころ DMI） | `None` |
/// | `yes` | その名前（出どころ 設定） | 「設定で指定」（出どころ 設定） |
/// | `no` | `None` | `None` |
///
/// 設計§7-2 の `resolve(setting, sys_root)` から、**読んだ DMI を受ける形**にした——起動時に
/// DMI を1回だけ読み、ログの材料（`dmi_fields`）にも同じものを使うため。
pub fn resolve(setting: MeteredCloud, dmi: &Dmi) -> Option<CloudGuess> {
    match setting {
        MeteredCloud::Auto => identify(dmi).map(|name| CloudGuess {
            name: name.to_string(),
            source: CloudSource::Dmi,
        }),
        MeteredCloud::Yes => Some(CloudGuess {
            name: identify(dmi).unwrap_or("設定で指定").to_string(),
            source: CloudSource::Config,
        }),
        MeteredCloud::No => None,
    }
}

/// 起動の形と設定から、差し込む決まりを組む（起動の道が1回だけ呼ぶ）。
///
/// DMI を1回読み、判定の結果と**材料の量**を `kind=metered_cloud` の1行に残す。
pub fn policy(deployment: Deployment, setting: MeteredCloud, sys_root: &Path) -> FileViewPolicy {
    let dmi = read_dmi(sys_root);
    let cloud = resolve(setting, &dmi);
    let policy = FileViewPolicy { deployment, cloud };
    let (name, source) = match &policy.cloud {
        Some(guess) => (
            guess.name.as_str(),
            match guess.source {
                CloudSource::Dmi => "dmi",
                CloudSource::Config => "config",
            },
        ),
        None => ("", ""),
    };
    tracing::info!(
        kind = "metered_cloud",
        deployment = crate::settings_api::deployment_name(&policy),
        setting = setting.as_str(),
        name,
        source,
        dmi_fields = dmi.fields_read(),
        "クラウドの判定"
    );
    policy
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 偽の `/sys` を組む一時フォルダ。落ちたら消す。
    struct FakeRoot(PathBuf);

    impl FakeRoot {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "agentdashboard-cloud-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(root.join("sys/class/dmi/id")).unwrap();
            std::fs::create_dir_all(root.join("sys/hypervisor")).unwrap();
            Self(root)
        }

        fn dmi(self, field: &str, value: &str) -> Self {
            std::fs::write(self.0.join("sys/class/dmi/id").join(field), value).unwrap();
            self
        }

        fn hypervisor_uuid(self, value: &str) -> Self {
            std::fs::write(self.0.join("sys/hypervisor/uuid"), value).unwrap();
            self
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for FakeRoot {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn 表の陽性を全部見分ける() {
        // (偽の /sys の組み方, 期待する名前)。DMI の値の末尾には実物と同じく改行を付ける
        let cases: Vec<(FakeRoot, &str)> = vec![
            (
                FakeRoot::new().hypervisor_uuid("ec2e1916-9099-7caf-fd21-012345abcdef\n"),
                "Amazon EC2",
            ),
            (
                FakeRoot::new().dmi("sys_vendor", "Amazon EC2\n"),
                "Amazon EC2",
            ),
            (
                FakeRoot::new().dmi("board_vendor", "Amazon EC2\n"),
                "Amazon EC2",
            ),
            (
                FakeRoot::new().dmi("product_name", "Google Compute Engine\n"),
                "Google Compute Engine",
            ),
            (
                FakeRoot::new()
                    .dmi("sys_vendor", "Microsoft Corporation\n")
                    .dmi("product_name", "Virtual Machine\n")
                    .dmi("chassis_asset_tag", "7783-7084-3265-9085-8269-3286-77\n"),
                "Microsoft Azure",
            ),
            (
                FakeRoot::new().dmi("chassis_asset_tag", "OracleCloud.com\n"),
                "Oracle Cloud",
            ),
            (
                FakeRoot::new().dmi("product_name", "Alibaba Cloud ECS\n"),
                "Alibaba Cloud ECS",
            ),
            (
                FakeRoot::new().dmi("sys_vendor", "DigitalOcean\n"),
                "DigitalOcean",
            ),
            (FakeRoot::new().dmi("sys_vendor", "Hetzner\n"), "Hetzner"),
            (FakeRoot::new().dmi("sys_vendor", "Vultr\n"), "Vultr"),
            (
                FakeRoot::new().dmi("sys_vendor", "Linode\n"),
                "Akamai（Linode）",
            ),
            (
                FakeRoot::new().dmi("sys_vendor", "Akamai\n"),
                "Akamai（Linode）",
            ),
            (FakeRoot::new().dmi("sys_vendor", "Scaleway\n"), "Scaleway"),
            (FakeRoot::new().dmi("sys_vendor", "UpCloud\n"), "UpCloud"),
        ];
        // 表を1行足したら、ここにも陽性を1つ足させる
        assert_eq!(
            cases.len(),
            TABLE.len(),
            "表の行の数と陽性の試験の数が合うこと（表に足したら試験にも足す）"
        );
        for (root, expected) in &cases {
            assert_eq!(
                detect(root.path()).as_deref(),
                Some(*expected),
                "{:?} を {expected} と見分けること",
                read_dmi(root.path())
            );
        }
    }

    #[test]
    fn 欄が無い機械と_hyper_vと似た綴りはクラウドにしない() {
        // WSL：DMI が1つも無い
        let empty = FakeRoot::new();
        assert_eq!(detect(empty.path()), None);
        assert_eq!(read_dmi(empty.path()).fields_read(), 0);

        // 手元の Hyper-V：Azure と同じ sys_vendor・product_name で、asset tag だけ違う
        let hyper_v = FakeRoot::new()
            .dmi("sys_vendor", "Microsoft Corporation\n")
            .dmi("product_name", "Virtual Machine\n")
            .dmi("chassis_asset_tag", "None\n");
        assert_eq!(
            detect(hyper_v.path()),
            None,
            "Hyper-V を Azure と取り違えないこと"
        );
        assert_eq!(read_dmi(hyper_v.path()).fields_read(), 3);

        // 似た綴り：完全一致の行は前後が足されたら合わない・先頭一致の行は途中にあっても合わない
        let similar_vendor = FakeRoot::new().dmi("sys_vendor", "DigitalOcean Inc\n");
        assert_eq!(detect(similar_vendor.path()), None);
        let similar_uuid = FakeRoot::new().hypervisor_uuid("xen-ec2\n");
        assert_eq!(detect(similar_uuid.path()), None);
    }

    #[test]
    fn 改行と前後の空白を落としてから照合する() {
        let root = FakeRoot::new().dmi("sys_vendor", "  Hetzner \n");
        assert_eq!(detect(root.path()).as_deref(), Some("Hetzner"));
        assert_eq!(read_dmi(root.path()).sys_vendor, "Hetzner");
    }

    #[test]
    fn 設定と判定から出どころつきの答えを決める() {
        let negative = Dmi::default();
        let positive = Dmi {
            sys_vendor: "Hetzner".into(),
            ..Dmi::default()
        };
        assert_eq!(resolve(MeteredCloud::Auto, &negative), None);
        assert_eq!(
            resolve(MeteredCloud::Auto, &positive),
            Some(CloudGuess {
                name: "Hetzner".into(),
                source: CloudSource::Dmi
            })
        );
        assert_eq!(
            resolve(MeteredCloud::Yes, &negative),
            Some(CloudGuess {
                name: "設定で指定".into(),
                source: CloudSource::Config
            })
        );
        assert_eq!(
            resolve(MeteredCloud::Yes, &positive),
            Some(CloudGuess {
                name: "Hetzner".into(),
                source: CloudSource::Config
            })
        );
        assert_eq!(resolve(MeteredCloud::No, &positive), None);
    }

    #[test]
    fn 設定の綴りは3つだけを読む() {
        assert_eq!(MeteredCloud::parse("auto"), Some(MeteredCloud::Auto));
        assert_eq!(MeteredCloud::parse("yes"), Some(MeteredCloud::Yes));
        assert_eq!(MeteredCloud::parse("no"), Some(MeteredCloud::No));
        for bad in ["", "Yes", "true", "maybe", " auto"] {
            assert_eq!(MeteredCloud::parse(bad), None, "{bad:?} は読まないこと");
        }
        for setting in [MeteredCloud::Auto, MeteredCloud::Yes, MeteredCloud::No] {
            assert_eq!(MeteredCloud::parse(setting.as_str()), Some(setting));
        }
        assert_eq!(MeteredCloud::default(), MeteredCloud::Auto);
    }

    #[test]
    fn 起動の形と判定を決まりにまとめる() {
        let root = FakeRoot::new().dmi("product_name", "Google Compute Engine\n");
        let local = policy(Deployment::Local, MeteredCloud::Auto, root.path());
        assert_eq!(local.deployment, Deployment::Local);
        assert_eq!(
            local.cloud,
            resolve(MeteredCloud::Auto, &read_dmi(root.path()))
        );
        let server = policy(Deployment::Server, MeteredCloud::No, root.path());
        assert_eq!(server.deployment, Deployment::Server);
        assert_eq!(server.cloud, None);
    }

    /// 起動の道に判定が差し込まれていることを、`src/lib.rs` の本文で数える。
    ///
    /// **ローカルの起動の道は実バイナリで起こす試験が無い**（サーバモードは `tests/two_process.rs`
    /// が本物を起こして `GET /api/settings` で見る）。差し込みを忘れると、ローカルモードの
    /// クラウドの判定が黙って `None` のままになるので、呼び出しが両方の道にあること自体を見る
    /// （`tests/cli_ops.rs` の `起き直りの拾い上げは両方のモードから呼ばれる` と同じ形）。
    ///
    /// **関数の名前や綴りを変えたら、この検査も直すこと**（名前を変えると本文を読む検査は黙って
    /// 外れる。数が0になって落ちるので気づける）。
    #[test]
    fn 起動の両方の道に判定が差し込まれている() {
        let lib = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
        let text = std::fs::read_to_string(&lib).expect("lib.rs が読めること");
        let local = text.matches("cloud::policy(Deployment::Local,").count();
        let server = text.matches("cloud::policy(Deployment::Server,").count();
        assert_eq!(
            (local, server),
            (1, 1),
            "ローカルの道（serve）とサーバの道（serve_server）にそれぞれ1回ずつ差し込むこと。\
             いまの回数: ローカル {local}・サーバ {server}"
        );
    }
}
