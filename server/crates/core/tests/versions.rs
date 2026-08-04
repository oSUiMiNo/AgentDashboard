//! 版を見る口と消す口（CICD設計§12・§13・§14、テスト計画フェーズ2・3）。
//!
//! 一覧の中身そのもの（3本の版が揃うか・並び順）は `agent-core` の単体で固めてある。
//! ここで見るのは**口としての振る舞い**——使えない構成では出さないこと、錠が効くこと、
//! 消した結果が次の一覧へ反映されること。
//!
//! # 使える構成の道を通すには上書きが要る
//!
//! テストは箱の中で走る（`scripts/cargo` は docker の中で cargo を動かす）ので、
//! 自動判定は必ず「使えない」に倒れる。上書き口が無いと有効側の道を一度も通せない
//! （設計§21-4）。
//!
//! # 置き場所は共通の土台が使い捨てへ向けている
//!
//! 既定の `state_dir` は**利用者の本物の状態ディレクトリ**なので、素直に立てると
//! テストが実環境の保管庫を読み書きする。個々のテストの心がけに頼らないよう、
//! `common::TestServer` 側で使い捨てへ倒してある（`database_url` と同じ扱い）。

#![allow(non_snake_case)]

mod common;

use agent_core::version::{self, VERSION_SUPPORTED_ENV};
use protocol::VersionId;
use std::path::Path;

/// 版を名乗るだけの一式を保管庫へ置く。
fn write_stored_version(state_dir: &Path, version: &str) {
    let dir = version::versions_dir(state_dir).join(version);
    std::fs::create_dir_all(&dir).expect("保管庫を作れること");
    for name in version::BINARIES {
        let path = dir.join(name);
        let body = if name == "transcript-parser" {
            format!(
                "#!/bin/sh\nprintf '{{\"ev\":\"hello\",\"parser_version\":\"{version}\"}}\\n'\n"
            )
        } else {
            format!("#!/bin/sh\necho '{name} {version}'\n")
        };
        std::fs::write(&path, body).expect("書けること");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("実行できる形にできること");
        }
    }
}

/// 門の3つの問いに答えられる一式を保管庫へ置く。
///
/// [`write_stored_version`] の一式は版を名乗るだけなので、門からは**形を答えられない
/// 版**——つまりこの機能より前の版と同じ——に見える。選べるところまで通したいときは
/// こちらを使う。
fn write_gate_ready_version(state_dir: &Path, version: &str) {
    write_stored_version(state_dir, version);

    // いま適用されている形をそのまま名乗らせる。**知らない形が1つでもあれば断られる**
    // ので、ここが食い違うとテストの狙いから外れる
    let names = server_core::db::migration_names()
        .into_iter()
        .map(|name| format!("    echo '{name}'"))
        .collect::<Vec<_>>()
        .join("\n");
    let marker = agentdashboard_core::cli::SCHEMA_NAMES_MARKER;
    let path = version::versions_dir(state_dir)
        .join(version)
        .join("agentdashboard");
    // 実行できる形は `write_stored_version` が付けている（書き直しても残る）
    std::fs::write(
        &path,
        format!(
            "#!/bin/sh\n\
             case \"$1\" in\n\
             \x20 --version) echo 'agentdashboard {version}' ;;\n\
             \x20 migrations)\n\
             \x20   echo '{marker}'\n{names} ;;\n\
             \x20 *) exit 0 ;;\n\
             esac\n"
        ),
    )
    .expect("書けること");
}

/// 使える構成のふりをする。
///
/// nextest はテストごとに別プロセスなので、ここで立てても他のテストへは漏れない。
fn pretend_supported() {
    unsafe { std::env::set_var(VERSION_SUPPORTED_ENV, "1") };
}

async fn view(server: &common::TestServer) -> serde_json::Value {
    let (status, body) = server.get("/api/versions").await;
    assert_eq!(status, 200, "一覧を読めない: {body}");
    serde_json::from_str(&body).expect("VersionsView として読めること")
}

#[tokio::test]
async fn 使えない構成では機能ごと出さない() {
    // できないことをボタンにしない（設計§14）。走査そのものを省く
    unsafe { std::env::set_var(VERSION_SUPPORTED_ENV, "0") };
    let server = common::TestServer::start().await;

    let view = view(&server).await;
    assert_eq!(view["supported"], false);
    assert_eq!(
        view["entries"].as_array().map(Vec::len),
        Some(0),
        "出さないと決めた構成で中身を返している"
    );
}

#[tokio::test]
async fn 手で戻す出口はこの機械の実際の置き場所を指す() {
    // 戻した先には版を選ぶ画面が無いので、**ここが袋小路からの唯一の出口**（設計§9）。
    // 既定を決め打ちで書くと、置き場所を移している利用者に存在しないパスを案内して
    // しまい、出口が塞がる
    pretend_supported();
    let server = common::TestServer::start().await;

    let expected = version::pointer_path(&server.config.agent().resolved_state_dir());
    let view = view(&server).await;

    assert_eq!(
        view["pointer_path"].as_str(),
        Some(expected.display().to_string().as_str()),
        "出口が実際の置き場所を指していない: {view}"
    );
    assert!(
        !view["pointer_path"]
            .as_str()
            .unwrap_or_default()
            .starts_with("~/"),
        "展開していない書き方を返している（そのまま貼っても効かない）: {view}"
    );
}

#[tokio::test]
async fn 保管庫の版が一覧に並ぶ() {
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_stored_version(&state_dir, "0.1.1");

    let view = view(&server).await;
    assert_eq!(view["supported"], true);
    let entries = view["entries"].as_array().expect("一覧があること");
    let found = entries
        .iter()
        .find(|entry| entry["version"] == "0.1.1")
        .unwrap_or_else(|| panic!("置いた版が並んでいない: {entries:?}"));
    assert_eq!(found["origin"], "stored");
    assert_eq!(found["usable"], true, "3本とも同じ版を名乗っている");
    assert_eq!(found["selected"], false, "まだ選んでいない");
    assert_eq!(view["selected"], serde_json::Value::Null);
}

#[tokio::test]
async fn 選んでいる版は一覧の外にも出る() {
    // 「いま走っている版」と「次に起こす版」は別物なので、選択中の印だけでは
    // 「押しても何も起きない」ように見える（設計§14）
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_stored_version(&state_dir, "0.1.1");
    version::write_pointer(
        &state_dir,
        Some(
            &version::versions_dir(&state_dir)
                .join("0.1.1")
                .join("agentdashboard"),
        ),
    );

    let view = view(&server).await;
    assert_eq!(view["selected"], "0.1.1");
}

#[tokio::test]
async fn 消すと一覧から消えてポインタも外れる() {
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_stored_version(&state_dir, "0.1.1");
    version::write_pointer(
        &state_dir,
        Some(
            &version::versions_dir(&state_dir)
                .join("0.1.1")
                .join("agentdashboard"),
        ),
    );

    let (status, body) = server.request("DELETE", "/api/versions/0.1.1", None).await;
    assert_eq!(status, 200, "消せない: {body}");

    let view: serde_json::Value = serde_json::from_str(&body).expect("応答が一覧であること");
    assert!(
        !view["entries"]
            .as_array()
            .expect("一覧があること")
            .iter()
            .any(|entry| entry["version"] == "0.1.1"),
        "消したのに並んでいる: {view}"
    );
    assert_eq!(view["selected"], serde_json::Value::Null, "予約も外れる");
    assert_eq!(
        version::read_pointer(&state_dir),
        None,
        "既定へ落ちていない"
    );
}

#[tokio::test]
async fn 保管庫にない版は無いと言う() {
    // 「消せない」と「そもそも無い」を呼び分ける
    let server = common::TestServer::start().await;
    let (status, body) = server.request("DELETE", "/api/versions/9.9.9", None).await;
    assert_eq!(status, 404, "実際: {body}");
}

#[tokio::test]
async fn 錠を取っている間の操作は断られる() {
    // 錠は**プロセスをまたぐ**（落として、新しいプロセスが立ち上がってくる）ので、
    // プロセスの中の錠では足りない
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_stored_version(&state_dir, "0.1.1");

    version::acquire_lock(&state_dir).expect("先に取れること");

    let (status, body) = server.request("DELETE", "/api/versions/0.1.1", None).await;
    assert_eq!(status, 409, "二重の操作が通ってしまった: {body}");
    assert!(body.contains("動いています"), "理由を書く: {body}");

    // 返せば通る
    version::release_lock(&state_dir);
    let (status, body) = server.request("DELETE", "/api/versions/0.1.1", None).await;
    assert_eq!(status, 200, "返したのに断られた: {body}");
}

#[tokio::test]
async fn 前回の結末は繋いだ瞬間に読める() {
    // **知らせではなく状態として持つ**（設計§11）。新しい版が起動できなかったことは
    // ブラウザが繋がる前に決まるので、流すだけでは誰にも届かない
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    version::write_outcome(
        &state_dir,
        &version::Outcome {
            attempted: Some(VersionId::new("0.2.0")),
            attempted_path: "/どこか/agentdashboard".to_string(),
            running: VersionId::new("0.1.1"),
            failed_reason: Some("起動できませんでした".to_string()),
            at: 1,
        },
    );

    let view = view(&server).await;
    assert_eq!(view["outcome"]["attempted"], "0.2.0");
    assert_eq!(view["outcome"]["failed_reason"], "起動できませんでした");
}

#[tokio::test]
async fn 最後に読めた最新版が一覧に載る() {
    // **この口は見に行かない**（設計§8）。外へ出るのは背景の周期だけで、ここは
    // 最後に読めた値を返すだけ——さもないと画面を開くたびにネットワークが要る
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();

    // 一度も見に行けていなければ載らない
    assert!(view(&server).await["latest"].is_null());

    agent_core::version_ops::record_latest(
        &state_dir,
        &agent_core::version_ops::Latest {
            version: VersionId::new("0.9.0"),
            prerelease: false,
            has_artifact: true,
        },
        1_234,
    );

    let view = view(&server).await;
    assert_eq!(view["latest"]["version"], "0.9.0");
    assert_eq!(view["latest"]["has_artifact"], true);
    assert_eq!(view["latest"]["checked_at"], 1_234);
    // **新着かどうかはサーバが決めない。** 画面が「走っている版より新しいか」で決める
    assert!(
        view["latest"].get("is_new").is_none(),
        "サーバが新着かどうかを決めてしまっている"
    );
}

#[tokio::test]
async fn 入れ替えで抜け殻になる枚数が押す前に分かる() {
    // 押す前に**数で**見せる（設計§10）。「セッションが死にます」ではなく
    // 「N 枚が抜け殻になります」——戻ってきた画面は空ではなく、履歴だけが読める
    // カードが N 枚並んだ状態になるため
    pretend_supported();
    let server = common::TestServer::start().await;

    // 何も起こしていなければ失うものが無い
    assert_eq!(
        view(&server).await["stranded_cards"],
        0,
        "起こしていないのに数えている"
    );

    let (_session, _watcher) = common::start_session(&server.manager).await;
    server
        .wait_for_listed("1枚が繋がっている", |listed| {
            listed.iter().filter(|meta| meta.agent_connected).count() == 1
        })
        .await;

    assert_eq!(
        view(&server).await["stranded_cards"],
        1,
        "落とすと道連れになるカードを数えていない"
    );
}

#[tokio::test]
async fn 版を選んでもプロセスは落ちない() {
    // **要件が名指しで恐れている点**（設計§10）。選ぶのはポインタを書くところまでで、
    // 効くのは次に起こしたとき——「選んだ瞬間に全部入れ替わる」を構造で外している
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_gate_ready_version(&state_dir, "0.1.1");

    let (status, body) = server
        .put("/api/versions/selected", r#"{"version":"0.1.1"}"#)
        .await;
    assert_eq!(status, 200, "選べない: {body}");

    let picked: serde_json::Value = serde_json::from_str(&body).expect("応答を読めること");
    assert_eq!(picked["selected"], "0.1.1", "予約になっていない");
    assert_eq!(
        version::read_pointer(&state_dir),
        Some(
            version::versions_dir(&state_dir)
                .join("0.1.1")
                .join("agentdashboard")
        ),
        "ポインタが書かれていない"
    );
    assert!(
        !server.stopped.load(std::sync::atomic::Ordering::SeqCst),
        "選んだだけで落とそうとしている"
    );
}

#[tokio::test]
async fn 選んだだけの状態は取り消せる() {
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_gate_ready_version(&state_dir, "0.1.1");

    let (status, _) = server
        .put("/api/versions/selected", r#"{"version":"0.1.1"}"#)
        .await;
    assert_eq!(status, 200);

    let (status, body) = server
        .request("DELETE", "/api/versions/selected", None)
        .await;
    assert_eq!(status, 200, "取り消せない: {body}");
    let view: serde_json::Value = serde_json::from_str(&body).expect("応答を読めること");
    assert_eq!(
        view["selected"],
        serde_json::Value::Null,
        "予約が残っている"
    );
    assert_eq!(
        version::read_pointer(&state_dir),
        None,
        "ポインタが外れていない"
    );
}

#[tokio::test]
async fn 揃っていない版は選べない() {
    // 3本揃っていない版を選ばせると、パーサだけ食い違った状態で動き出す（設計§6）
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_stored_version(&state_dir, "0.1.1");
    std::fs::remove_file(
        version::versions_dir(&state_dir)
            .join("0.1.1")
            .join("transcript-parser"),
    )
    .expect("1本だけ消せること");

    let (status, body) = server
        .put("/api/versions/selected", r#"{"version":"0.1.1"}"#)
        .await;
    assert_eq!(status, 409, "揃っていないのに選べてしまった: {body}");
    assert_eq!(
        version::read_pointer(&state_dir),
        None,
        "断ったのにポインタを書いている"
    );
}

#[tokio::test]
async fn 形を答えられない行き先は同意を求めてから通す() {
    // この機能より前の版は記録の形を答えられない。**断るといちばん戻りたい先へ
    // 永久に戻れなくなる**ので、そう言って同意を取ってから通す（設計§9）
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_stored_version(&state_dir, "0.1.1");

    let (status, body) = server
        .put("/api/versions/selected", r#"{"version":"0.1.1"}"#)
        .await;
    assert_eq!(
        status, 428,
        "確かめられないことを、断ったのと同じ返し方にしている: {body}"
    );
    assert!(
        body.contains("答えられません"),
        "理由を書いていない: {body}"
    );
    assert_eq!(
        version::read_pointer(&state_dir),
        None,
        "同意していないのに書いている"
    );

    let (status, body) = server
        .put(
            "/api/versions/selected",
            r#"{"version":"0.1.1","confirm_unverified":true}"#,
        )
        .await;
    assert_eq!(status, 200, "同意しても通らない: {body}");
    assert!(
        version::read_pointer(&state_dir).is_some(),
        "同意したのに書いていない"
    );
}

#[tokio::test]
async fn 入れ替えは返してから落とす() {
    // **返してから落とす**（設計§24）。ハンドラの中で落とすと応答が届かず、
    // ブラウザからは「押したのに失敗した」と見分けが付かない
    pretend_supported();
    let server = common::TestServer::start().await;

    let (status, body) = server.request("POST", "/api/versions/restart", None).await;
    assert_eq!(status, 200, "入れ替えを頼めない: {body}");
    let view: serde_json::Value = serde_json::from_str(&body).expect("応答を読めること");
    assert!(
        view["stranded_cards"].is_number(),
        "何枚が抜け殻になるかを返していない: {body}"
    );

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !server.stopped.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(std::time::Instant::now() < deadline, "落とそうとしていない");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn 取ってくる道具が無ければ断る() {
    // **`supported` と混ぜない**（設計§23-6）。版を選ぶことはできるが取ってくることは
    // できない、という組み合わせが普通にある
    pretend_supported();
    unsafe { std::env::set_var("PATH", "/どこにもない") };
    let server = common::TestServer::start().await;

    let view = view(&server).await;
    assert_eq!(view["supported"], true, "選ぶことまでできなくなっている");
    assert!(
        view["install_unavailable"].is_string(),
        "取ってこられない理由を出していない: {view}"
    );

    let (status, body) = server
        .request("POST", "/api/versions/0.9.9/install", None)
        .await;
    assert_eq!(status, 409, "道具が無いのに受け付けた: {body}");
}

/// 取ってくる先を手元へ向ける。**外へは出ない。**
///
/// `curl` は `file` を通す（`curl_args` が `--proto "=https,file"` を渡している）ので、
/// 本物の窓口のまま手元のインストーラを走らせられる。差し替えた窓口で通したことに
/// すると、**引数の組み立ても環境の掃除も一度も踏まないまま緑になる**。
fn serve_installer_locally(version: &str) -> tempdir::Guard {
    let dir = tempdir::make("agentdashboard-release");
    let tag = dir.path().join("download").join(format!("v{version}"));
    std::fs::create_dir_all(&tag).expect("置き場所を作れること");

    let script = r#"#!/bin/sh
set -e
d="$AGENTDASHBOARD_UNMANAGED_INSTALL"
mkdir -p "$d"
printf '#!/bin/sh\necho "agentdashboard __V__"\n' > "$d/agentdashboard"
printf '#!/bin/sh\necho "agentdashboard-agent __V__"\n' > "$d/agentdashboard-agent"
printf '#!/bin/sh\nprintf %s "{\"ev\":\"hello\",\"parser_version\":\"__V__\"}\n"\n' > "$d/transcript-parser"
chmod 755 "$d/agentdashboard" "$d/agentdashboard-agent" "$d/transcript-parser"
"#
    .replace("__V__", version);
    std::fs::write(tag.join("agentdashboard-installer.sh"), script).expect("書けること");

    unsafe {
        std::env::set_var(
            agent_core::version_ops::RELEASE_BASE_ENV,
            format!("file://{}", dir.path().display()),
        )
    };
    dir
}

/// 使い捨ての置き場所。**畳むときに消す。**
mod tempdir {
    pub struct Guard(std::path::PathBuf);

    impl Guard {
        pub fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub fn make(label: &str) -> Guard {
        let dir = std::env::temp_dir().join(format!("{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("使い捨ての置き場所を作れること");
        Guard(dir)
    }
}

#[tokio::test]
async fn 取ってきても選ばれない() {
    // **「勝手に更新されない」の最後の砦**（設計§7）。取ってくることと、次に起こす版を
    // 決めることは別の操作でなければならない
    pretend_supported();
    let _release = serve_installer_locally("0.9.9");
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();

    let (status, body) = server
        .request("POST", "/api/versions/0.9.9/install", None)
        .await;
    assert_eq!(status, 202, "取ってくる仕事を受け付けない: {body}");

    // 背景で走るので、様子が変わるまで待つ（設計§15）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let done = loop {
        let view = view(&server).await;
        match view["install"]["phase"].as_str() {
            Some("done") => break view,
            Some("failed") => panic!("取ってこられなかった: {}", view["install"]),
            _ => {}
        }
        assert!(std::time::Instant::now() < deadline, "終わらない: {view}");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };

    assert!(
        done["entries"]
            .as_array()
            .expect("一覧があること")
            .iter()
            .any(|entry| entry["version"] == "0.9.9" && entry["usable"] == true),
        "取ってきた版が並んでいない: {done}"
    );
    assert_eq!(
        done["selected"],
        serde_json::Value::Null,
        "取ってきただけで選ばれている"
    );
    assert_eq!(
        version::read_pointer(&state_dir),
        None,
        "取ってきただけでポインタが書かれている"
    );
}
