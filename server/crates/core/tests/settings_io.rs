//! 設定の入口の検査と、ファイルへの持ち出し（持ち出し設計§7〜§13）。
//!
//! 相手は擬似 claude なので**課金なしで毎回走らせられる**。
//!
//! ここで見るのは「入口が違っても同じ答えになる」こと。画面からの `PUT` も、
//! ファイルからの読み込みも、同じ検査（`db::settings::check`）を通る。

mod common;

use agentdashboard_core::config::Config;
use std::path::PathBuf;

/// 設定画面を立てたサーバを1つ用意する。
async fn server() -> (common::TestServer, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-settings-io-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).expect("置き場所を作れること");
    let path = dir.join("config.toml");
    std::fs::write(&path, "port = 8787\n").expect("書き出せること");
    let server = common::TestServer::start_with_settings(Config::default(), path).await;
    (server, dir)
}

/// 範囲の外は断り、理由にキーの名前が出ること（持ち出し設計§9）。
///
/// **画面は選択肢で値を絞っているが、REST は直に叩ける。** ここが通ると
/// 「休みなく送り続ける」設定が入る。
#[tokio::test]
async fn 範囲の外の値は断られる() {
    let (server, dir) = server().await;

    let (status, body) = server
        .put("/api/settings", r#"{"sync_interval_secs":0}"#)
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(
        body.contains("sync_interval_secs"),
        "どのキーが駄目かが分かる文であること: {body}"
    );

    // 断ったのなら**何も書かれていない**こと
    let (_, body) = server.get("/api/settings").await;
    assert!(
        body.contains("\"sync_interval_secs\":20"),
        "断ったのに書き換わっている: {body}"
    );

    let _ = std::fs::remove_dir_all(dir);
}

/// 型が違うものも断ること。
#[tokio::test]
async fn 型が違う値は断られる() {
    let (server, dir) = server().await;

    let (status, body) = server
        .put("/api/settings", r#"{"scrollback_lines":-1}"#)
        .await;
    // 負数は u64 として読めないので、そもそも本文の解釈で弾かれる
    assert!(status == 400 || status == 422, "status={status} {body}");

    let (status, body) = server
        .put("/api/settings", r#"{"screen_interval_ms":1}"#)
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(body.contains("screen_interval_ms"), "{body}");

    let _ = std::fs::remove_dir_all(dir);
}

/// 範囲の中なら通ること（絞りすぎていないこと）。
#[tokio::test]
async fn 画面の選択肢はすべて通る() {
    let (server, dir) = server().await;

    for seconds in [5, 10, 20, 60] {
        let (status, body) = server
            .put(
                "/api/settings",
                &format!(r#"{{"sync_interval_secs":{seconds}}}"#),
            )
            .await;
        assert_eq!(status, 200, "{seconds} 秒が通らない: {body}");
    }
    for millis in [50, 300, 1000, 5000, 10000, 20000] {
        let (status, body) = server
            .put(
                "/api/settings",
                &format!(r#"{{"screen_interval_ms":{millis}}}"#),
            )
            .await;
        assert_eq!(status, 200, "{millis} ミリ秒が通らない: {body}");
    }

    let _ = std::fs::remove_dir_all(dir);
}

/// 書き出して読み戻すと元の状態へ戻ること（持ち出し設計§7・§8）。
///
/// **持ち出しの目的そのもの。** ここが通らないなら、書き出しか読み込みのどちらかが
/// 揃っていない。**キーを1つ足したら、この本文にも1つ足すこと。**
#[tokio::test]
async fn 書き出して読み戻すと元へ戻る() {
    let (server, dir) = server().await;

    // 元の状態を作る（既定とは違う値にしておかないと、戻ったのか判別できない）
    let (status, _) = server
        .put(
            "/api/settings",
            r#"{"always_bypass_permissions":true,"project_autostart_session":true,
                "sync_interval_secs":5,"motion_quiet":"calm",
                "screen_interval_ms":300,"scrollback_lines":4000}"#,
        )
        .await;
    assert_eq!(status, 200);

    let (status, exported) = server.get("/api/settings/export").await;
    assert_eq!(status, 200, "{exported}");
    assert!(exported.contains("agentdashboard-settings"), "{exported}");

    // 全部を別の値へ変える
    let (status, _) = server
        .put(
            "/api/settings",
            r#"{"always_bypass_permissions":false,"project_autostart_session":false,
                "sync_interval_secs":60,"motion_quiet":"lively",
                "screen_interval_ms":20000,"scrollback_lines":1000}"#,
        )
        .await;
    assert_eq!(status, 200);

    // 読み戻す
    let (status, body) = server
        .request("POST", "/api/settings/import", Some(&exported))
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"applied\""), "{body}");
    assert!(body.contains("\"ignored\":[]"), "{body}");

    let (_, body) = server.get("/api/settings").await;
    assert!(
        body.contains("\"always_bypass_permissions\":true"),
        "{body}"
    );
    assert!(
        body.contains("\"project_autostart_session\":true"),
        "{body}"
    );
    assert!(body.contains("\"sync_interval_secs\":5"), "{body}");
    // 画面の選択肢に足した 0.3秒 が、書き出し→読み込みの往復で戻ってくること
    assert!(body.contains("\"screen_interval_ms\":300"), "{body}");
    assert!(body.contains("\"scrollback_lines\":4000"), "{body}");
    // 3段のうち、既定でない側が往復で戻ってくること（カード設計§9-5-2）
    assert!(body.contains("\"motion_quiet\":\"calm\""), "{body}");

    let _ = std::fs::remove_dir_all(dir);
}

/// 書き出しに入るのはアカウントのものだけで、秘密もサーバ全体のものも入らないこと
/// （持ち出し設計§7）。
#[tokio::test]
async fn 書き出しにはアカウントの設定しか入らない() {
    let (server, dir) = server().await;

    let (_, exported) = server.get("/api/settings/export").await;
    let value: serde_json::Value = serde_json::from_str(&exported).expect("JSON であること");
    let settings = value["settings"].as_object().expect("settings があること");

    let mut keys: Vec<&str> = settings.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "always_bypass_permissions",
            // 拡張子ごとの見せ方は、**どの機械でも同じ意味**なので持ち出しに乗る
            // （ファイルビュアにエディタ機能を追加 要件③）。**同じイシューで足した
            // `writable_roots` は乗らない**——あちらは絶対パスで、別の機械では
            // 別の場所を指すため、持ち出すと**書ける範囲が黙って広がる**
            "file_modes",
            // メモの保持は利用体験の設定なので、持ち出しに乗る（メモ設計§11-2）。
            // **秘密ではない**ので、ここへ足してよい
            "memo_max_bytes",
            "memo_retention_days",
            "motion_quiet",
            "project_autostart_session",
            "screen_interval_ms",
            "scrollback_lines",
            "sync_interval_secs"
        ],
        "持ち出しの顔ぶれが変わっている: {exported}"
    );

    // 秘密は名前すら現れないこと（値だけでなくキーでも）
    for forbidden in ["lan_password", "update_check", "pairing", "token"] {
        assert!(
            !exported.contains(forbidden),
            "{forbidden} が書き出しへ混ざっている: {exported}"
        );
    }

    let _ = std::fs::remove_dir_all(dir);
}

/// 関係ないファイルを選んだら断り、**何も書き換えないこと**（持ち出し設計§9）。
#[tokio::test]
async fn 関係ないファイルは断られ何も変わらない() {
    let (server, dir) = server().await;
    let (_, before) = server.get("/api/settings").await;

    for text in [
        "これは JSON ではない",
        r#"{"port":8787}"#,
        r#"{"kind":"something-else","format":1,"settings":{}}"#,
    ] {
        let (status, body) = server
            .request("POST", "/api/settings/import", Some(text))
            .await;
        assert_eq!(status, 400, "断られること: {body}");
    }

    let (_, after) = server.get("/api/settings").await;
    assert_eq!(after, before, "断ったのに書き換わっている");

    let _ = std::fs::remove_dir_all(dir);
}

/// 1つでも駄目なら何も入らず、理由にキーの名前が出ること（持ち出し設計§9）。
#[tokio::test]
async fn 一部が駄目なファイルは丸ごと断られる() {
    let (server, dir) = server().await;
    let (_, before) = server.get("/api/settings").await;

    let text = r#"{"kind":"agentdashboard-settings","format":1,"settings":{
        "sync_interval_secs": 5,
        "scrollback_lines": 0
    }}"#;
    let (status, body) = server
        .request("POST", "/api/settings/import", Some(text))
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(body.contains("scrollback_lines"), "{body}");

    let (_, after) = server.get("/api/settings").await;
    assert_eq!(after, before, "半分だけ入ってはいけない");

    let _ = std::fs::remove_dir_all(dir);
}

/// 知らないキーは無視して読み込み、**無視したことを伝えること**（持ち出し設計§9）。
#[tokio::test]
async fn 知らないキーは無視して伝える() {
    let (server, dir) = server().await;

    let text = r#"{"kind":"agentdashboard-settings","format":1,"settings":{
        "sync_interval_secs": 10,
        "未来のキー": 1
    }}"#;
    let (status, body) = server
        .request("POST", "/api/settings/import", Some(text))
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(
        body.contains("未来のキー"),
        "無視したことが伝わること: {body}"
    );

    // 入っていないキーは触られないこと（既定で埋めない）
    let (_, body) = server.get("/api/settings").await;
    assert!(body.contains("\"sync_interval_secs\":10"), "{body}");
    assert!(body.contains("\"scrollback_lines\":1000"), "{body}");

    let _ = std::fs::remove_dir_all(dir);
}

/// 静けさは**3段以外を断り、記録を動かさないこと**（カード設計§9-5-2）。
///
/// 真偽値と数値は serde が型で弾いてくれるが、**3段はただの文字列なので serde を
/// すり抜ける**。明示の検査を外すと、知らない綴りがそのまま記録へ入り、画面は
/// 既定へ落として描くので「設定したのに効かない」という追いにくい形になる。
#[tokio::test]
async fn 静けさは3段以外を断り記録を動かさない() {
    let (server, dir) = server().await;

    // まず正しい段を1つ入れておく（断ったときに巻き戻っていないことを見るため）
    let (status, body) = server
        .put("/api/settings", r#"{"motion_quiet":"calm"}"#)
        .await;
    assert_eq!(status, 200, "{body}");

    for wrong in [
        r#"{"motion_quiet":"quiet"}"#,
        r#"{"motion_quiet":"Lively"}"#,
        r#"{"motion_quiet":""}"#,
    ] {
        let (status, body) = server.put("/api/settings", wrong).await;
        assert_eq!(status, 400, "{wrong} が通った: {body}");
        assert!(
            body.contains("motion_quiet"),
            "どのキーが駄目か出ない: {body}"
        );
    }

    // 型が違うものは serde が弾く（400 でも 422 でもよい。**通らないことが要点**）
    let (status, body) = server.put("/api/settings", r#"{"motion_quiet":1}"#).await;
    assert!(status == 400 || status == 422, "status={status} {body}");

    // **断ったぶんで記録が動いていないこと**
    let (_, body) = server.get("/api/settings").await;
    assert!(
        body.contains(r#""motion_quiet":"calm""#),
        "断った側で記録が動いた: {body}"
    );

    // 3段はすべて通ること（絞りすぎていないこと）
    for 段 in ["lively", "calm", "still"] {
        let (status, body) = server
            .put("/api/settings", &format!(r#"{{"motion_quiet":"{段}"}}"#))
            .await;
        assert_eq!(status, 200, "{段}: {body}");
    }

    let _ = std::fs::remove_dir_all(dir);
}

/// 応答の `file_view` を取り出す。
fn file_view(body: &str) -> serde_json::Value {
    let value: serde_json::Value = serde_json::from_str(body).expect("JSON であること");
    value["file_view"].clone()
}

/// ファイル閲覧の上限の一式が返り、変えると残り、`"default"` で既定へ戻ること
/// （イシュー「ファイル閲覧の上限を設定から変え、大きいものは流し読みする」設計§6-2・§6-3）。
///
/// **画面は定数の写しを持たない**ので、選択肢の16個と名前、既定、各線の値がここで
/// 全部そろっていないと、画面が自分で補えない。
#[tokio::test]
async fn ファイル閲覧の上限の一式が返り_変えると残り_defaultで既定へ戻る() {
    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * MIB;
    let (server, dir) = server().await;

    let (status, body) = server.get("/api/settings").await;
    assert_eq!(status, 200, "{body}");
    let view = file_view(&body);
    // ローカルモード（`Open`・127.0.0.1）なので既定は 5 GiB、警告もクラウドも無い
    assert_eq!(view["max_bytes"], 5 * GIB, "{view}");
    assert_eq!(view["configured"], false, "{view}");
    assert_eq!(view["default_bytes"], 5 * GIB, "{view}");
    assert_eq!(view["via_server"], false, "{view}");
    assert!(view["cloud"].is_null(), "{view}");
    assert!(view["warn_from_bytes"].is_null(), "{view}");
    assert_eq!(view["editable"], true, "{view}");
    assert_eq!(view["whole_text_bytes"], 3_145_728, "{view}");
    assert_eq!(view["window_bytes"], 262_144, "{view}");
    assert_eq!(view["preview_max_bytes"], 33_554_432, "{view}");
    assert_eq!(view["image_max_bytes"], 8_388_608, "{view}");

    // 選択肢は16個。値は protocol の表と、名前は要件の16個と1つずつ一致する
    let choices = view["choices"].as_array().expect("配列であること");
    let bytes: Vec<u64> = choices
        .iter()
        .map(|choice| choice["bytes"].as_u64().expect("数であること"))
        .collect();
    assert_eq!(bytes, protocol::fs::FILE_VIEW_LIMIT_CHOICES.to_vec());
    let labels: Vec<&str> = choices
        .iter()
        .map(|choice| choice["label"].as_str().expect("文字列であること"))
        .collect();
    assert_eq!(
        labels,
        [
            "1 MB", "3 MB", "5 MB", "10 MB", "15 MB", "20 MB", "30 MB", "50 MB", "100 MB",
            "300 MB", "500 MB", "1 GB", "3 GB", "5 GB", "10 GB", "20 GB",
        ]
    );

    // 変えると、答えにも次の読みにも残る
    let (status, body) = server
        .put("/api/settings", r#"{"file_view_max_bytes":10485760}"#)
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(file_view(&body)["max_bytes"], 10 * MIB, "{body}");
    assert_eq!(file_view(&body)["configured"], true, "{body}");
    let (_, body) = server.get("/api/settings").await;
    assert_eq!(
        file_view(&body)["max_bytes"],
        10 * MIB,
        "残っていない: {body}"
    );
    assert_eq!(file_view(&body)["configured"], true, "{body}");

    // "default" で起動の形の既定へ戻る
    let (status, body) = server
        .put("/api/settings", r#"{"file_view_max_bytes":"default"}"#)
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(file_view(&body)["configured"], false, "{body}");
    assert_eq!(file_view(&body)["max_bytes"], 5 * GIB, "{body}");

    let _ = std::fs::remove_dir_all(dir);
}

/// 上限は選択肢の16個と `"default"` だけを受け、断ったら何も変えないこと（設計§6-3）。
///
/// **null は「触っていない」**——送っても値は変わらない（null で既定へ戻す形にしていない）。
#[tokio::test]
async fn ファイル閲覧の上限は選択肢とdefaultだけを受け_断ったら何も変えない() {
    const MIB: u64 = 1024 * 1024;
    let (server, dir) = server().await;

    // 選択肢に無い数・読めない文字列は、こちらで断って理由にキーの名前を出す
    for body in [
        r#"{"file_view_max_bytes":2097152}"#,
        r#"{"file_view_max_bytes":0}"#,
        r#"{"file_view_max_bytes":"3MB"}"#,
        r#"{"file_view_max_bytes":"Default"}"#,
    ] {
        let (status, answer) = server.put("/api/settings", body).await;
        assert_eq!(status, 400, "{body} → {answer}");
        assert!(
            answer.contains("file_view_max_bytes"),
            "どのキーが駄目かが分かる文であること: {body} → {answer}"
        );
    }
    // 型が合わないものは本文の解釈で弾かれる（既存の `型が違う値は断られる` と同じ扱い）
    for body in [
        r#"{"file_view_max_bytes":-1}"#,
        r#"{"file_view_max_bytes":true}"#,
    ] {
        let (status, answer) = server.put("/api/settings", body).await;
        assert!(status == 400 || status == 422, "{body} → {status} {answer}");
    }
    let (_, body) = server.get("/api/settings").await;
    assert_eq!(
        file_view(&body)["configured"],
        false,
        "断ったのに書き換わっている: {body}"
    );

    // null は触っていない扱い：入れてある 10 MiB のまま
    let (status, body) = server
        .put("/api/settings", r#"{"file_view_max_bytes":10485760}"#)
        .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = server
        .put("/api/settings", r#"{"file_view_max_bytes":null}"#)
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        file_view(&body)["max_bytes"],
        10 * MIB,
        "null で値が動いた: {body}"
    );
    assert_eq!(file_view(&body)["configured"], true, "{body}");

    let _ = std::fs::remove_dir_all(dir);
}

/// 上限を入れても書き出しに乗らないこと（設計§6-1：サーバ全体の鍵は持ち出しの対象外）。
///
/// 入れる前の顔ぶれは `書き出しにはアカウントの設定しか入らない` が見ている。ここは
/// **値を入れた後でも**乗らないことを足す。
#[tokio::test]
async fn ファイル閲覧の上限を入れても書き出しに乗らない() {
    let (server, dir) = server().await;

    let (status, body) = server
        .put("/api/settings", r#"{"file_view_max_bytes":10485760}"#)
        .await;
    assert_eq!(status, 200, "{body}");

    let (status, exported) = server.get("/api/settings/export").await;
    assert_eq!(status, 200, "{exported}");
    assert!(
        !exported.contains("file_view"),
        "サーバ全体の鍵が書き出しに乗っている: {exported}"
    );

    let _ = std::fs::remove_dir_all(dir);
}
