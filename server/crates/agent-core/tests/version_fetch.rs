//! 本物の配布インストーラで版を取ってくる（CICD設計§7、テスト計画フェーズ3）。
//!
//! # なぜこの1本が要るのか
//!
//! 窓口（`VersionOps`）を差し替えたテストは、**実物を一度も走らせずに全部満たせる**。
//! 差し替えた側が「置き場所へ3本置く」という約束を勝手に守ってくれるからで、
//! 本物の配布インストーラが同じ約束を守るかは何も確かめていない。これが無いと
//! 門が名ばかりになる。
//!
//! # なぜ `#[ignore]` なのか
//!
//! ネットワークへ出て実物のリリースを取ってくる。毎回走らせるものではないので、
//! `--ignored` を明示したときだけ走る。
//!
//! ```text
//! ./scripts/cargo nextest run -p agent-core --test version_fetch --run-ignored all
//! ```
//!
//! # なぜ `0.1.0` を取ってくるのか
//!
//! **`latest` を取ってくると自分自身を取ってくることになる。** ワークスペースの版と
//! 同じものが保管庫に既にあれば断られる（設計§7 の「同じ版は取り直さない」）ので、
//! 取ってこられたことを数えられない。`0.1.0` は実在する別の版で、受け入れ（6-B）の
//! 「0.1.0 へ戻す」でも要る。

#![allow(non_snake_case)]

use agent_core::{version, version_ops};
use protocol::VersionId;

/// 取ってくる相手。**実在する別の版**であること。
const TARGET: &str = "0.1.0";

#[test]
#[ignore = "本物のリリースを取ってくる（ネットワークが要る）"]
fn 本物のインストーラで保管庫へ三本揃う() {
    let root = std::env::temp_dir().join(format!("agentdashboard-fetch-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let state_dir = root.join("state");
    let home = root.join("home");
    std::fs::create_dir_all(&state_dir).expect("置き場所を作れること");
    std::fs::create_dir_all(&home).expect("偽の HOME を作れること");

    // **利用者の本物の HOME を触らせない。** インストーラは置き場所の解決に HOME を見る。
    // nextest はテストごとに別プロセスなので、ここで差し替えても他へは漏れない
    unsafe { std::env::set_var("HOME", &home) };

    let ops = version_ops::detect();
    assert!(
        ops.unavailable_reason().is_none(),
        "取ってくる道具がありません: {:?}",
        ops.unavailable_reason()
    );

    let version = VersionId::new(TARGET);
    let placed = version::install_version(&state_dir, ops.as_ref(), &version)
        .unwrap_or_else(|reason| panic!("取ってこられません: {reason}"));

    assert_eq!(placed, version, "頼んだ版と違うものが入った");

    // 3本揃って、3本とも同じ版を名乗ること（後条件そのもの）
    let dir = version::stored_version_dir(&state_dir, &version).expect("保管庫に無い");
    assert_eq!(version::versions_agree(&dir), Ok(version.clone()));

    // **置いている途中の印も、インストーラの落とし物も残っていないこと**
    let versions = version::versions_dir(&state_dir);
    let leftovers: Vec<String> = std::fs::read_dir(&versions)
        .expect("保管庫を読めること")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name != TARGET)
        .collect();
    assert!(leftovers.is_empty(), "残骸がある: {leftovers:?}");

    // **共有の場所を汚していないこと。** インストーラは既定では rcfile と控えを書くので、
    // 渡す環境を取り違えると利用者の設定が書き換わる（設計§7）
    assert!(
        !home.join(".profile").exists() && !home.join(".bashrc").exists(),
        "共有の設定ファイルが生まれている"
    );
    assert!(
        !home.join(".config").join("agentdashboard").exists(),
        "控え（receipt）が生まれている"
    );
    assert!(
        !home.join(".local").join("bin").exists(),
        "入れる側の場所へ置いている"
    );

    // **取ってきただけではポインタを書かない**（要件が名指しで恐れている点）
    assert!(
        version::read_pointer(&state_dir).is_none(),
        "取ってきただけでポインタが書かれている"
    );

    let _ = std::fs::remove_dir_all(&root);
}
