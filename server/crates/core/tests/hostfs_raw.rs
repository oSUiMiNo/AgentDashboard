//! 生で返す口（`ファイル閲覧で画像とHTMLも表示する` 設計§5。テスト計画フェーズ3）。
//!
//! # なぜ REST まで通して見るのか
//!
//! `session-host-core/tests/hostfs.rs` が確かめているのは**読み方の決まり**（種別・上限・
//! 断り方）で、ここが確かめるのは**口が何を返すか**である。この工事のいちばん危ない部分
//! （script を止める・外へ出さない）は**ヘッダに乗っている**ので、ヘッダが実際に付いて
//! いることは口を叩かないと言えない。
//!
//! # ここで言えないこと
//!
//! **本当に script が止まるか**は、ブラウザでしか言えない（テスト計画フェーズ5）。
//! ここで言えるのは「付いている」までである。層ごとに言えることが違う。

#![allow(non_snake_case)]

mod common;

/// 1x1 の GIF89a。**43バイトの実物**（設計§15 の5 で描けることを測ってある）。
const 小さなGIF: &[u8] = &[
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x44, 0x00, 0x3b,
];

/// 使い捨ての作業場所。**実運用の場所を触らない。**
struct Sandbox(std::path::PathBuf);

impl Sandbox {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "agentdashboard-raw-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("作業場所を作れること");
        Self(path)
    }

    fn file(&self, name: &str, body: &[u8]) -> String {
        let path = self.0.join(name);
        std::fs::write(&path, body).expect("置けること");
        path.display().to_string()
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn config_for(label: &str) -> agentdashboard_core::config::Config {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-raw-state-{label}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");

    agentdashboard_core::config::Config {
        state_dir: Some(dir.clone()),
        claude_settings_path: Some(dir.join("claude-settings.json")),
        database_url: Some(format!("sqlite://{}", dir.join("dashboard.db").display())),
        selfheal_enabled: false,
        ..agentdashboard_core::config::Config::default()
    }
}

/// `?path=` に載せる形へ。日本語のパスがそのまま来る。
fn escape(text: &str) -> String {
    let mut out = String::new();
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[tokio::test]
async fn 画像は四つのヘッダを付けてバイト列で返る() {
    let sandbox = Sandbox::new("image");
    let path = sandbox.file("撮った.gif", 小さなGIF);
    let server = common::TestServer::start_with(config_for("image")).await;

    let response = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=raw",
            escape(&path)
        ))
        .await;

    assert_eq!(response.status, 200);
    assert_eq!(response.body, 小さなGIF, "中身がそのまま返ること");
    assert_eq!(
        response.header("content-type").as_deref(),
        Some("image/gif")
    );
    assert_eq!(
        response.header("x-content-type-options").as_deref(),
        Some("nosniff")
    );
    assert_eq!(
        response.header("cache-control").as_deref(),
        Some("no-store")
    );
    // **中身を字で照合する。** ここが崩れても画面は普通に動くので、他に気づく手段が無い
    assert_eq!(
        response.header("content-security-policy").as_deref(),
        Some(
            "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; img-src data:; style-src 'unsafe-inline'; font-src data:"
        )
    );
}

#[tokio::test]
async fn htmlはテキストの道から作られて同じヘッダが付く() {
    let sandbox = Sandbox::new("html");
    let body = "<!doctype html><p>理解</p>";
    let path = sandbox.file("理解.html", body.as_bytes());
    let server = common::TestServer::start_with(config_for("html")).await;

    let response = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=raw",
            escape(&path)
        ))
        .await;

    assert_eq!(response.status, 200);
    assert_eq!(String::from_utf8_lossy(&response.body), body);
    assert_eq!(
        response.header("content-type").as_deref(),
        Some("text/html; charset=utf-8")
    );
    // **HTML にも同じ鍵をかける。** ここが抜けると、直リンクで開いた人の画面で
    // 他人の HTML がダッシュボードと同じ出自で動く
    assert!(
        response
            .header("content-security-policy")
            .is_some_and(|value| value.contains("sandbox")),
        "sandbox 指令が付くこと"
    );
}

#[tokio::test]
async fn svgも同じ道を通る() {
    let sandbox = Sandbox::new("svg");
    let body = r#"<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>"#;
    let path = sandbox.file("図.svg", body.as_bytes());
    let server = common::TestServer::start_with(config_for("svg")).await;

    let response = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=raw",
            escape(&path)
        ))
        .await;

    assert_eq!(response.status, 200);
    assert_eq!(
        response.header("content-type").as_deref(),
        Some("image/svg+xml")
    );
}

#[tokio::test]
async fn 表の外は素のテキストとして返る() {
    // **415 を見せない**（`ファイルの中身に掛けた隔離を、script の1段だけ解く` 設計§5-1）。
    // 画面に「ブラウザで開く」を置いた以上、押しても意味の無い相手にエラー画面を
    // 出すことになる。字で出して、読む人に判断させる
    let sandbox = Sandbox::new("outside");
    let server = common::TestServer::start_with(config_for("outside")).await;

    for (name, body) in [("組み込み.js", "alert(1)"), ("計画.md", "# a")] {
        let path = sandbox.file(name, body.as_bytes());
        let response = server
            .get_raw(&format!(
                "/api/hosts/local/file?path={}&as=raw",
                escape(&path)
            ))
            .await;
        assert_eq!(response.status, 200, "{name} は字で返ること");
        assert_eq!(String::from_utf8_lossy(&response.body), body, "{name}");
        assert_eq!(
            response.header("content-type").as_deref(),
            Some("text/plain; charset=utf-8"),
            "{name}"
        );
        // **`text/javascript` で返さないことが、この工事の唯一の守り**（設計§5-3）。
        // `nosniff` と組んで `<script src>` から実行できない。**両方見る**
        assert_eq!(
            response.header("x-content-type-options").as_deref(),
            Some("nosniff"),
            "{name}"
        );
    }
}

#[tokio::test]
async fn バイナリは読めない理由で断られ続ける() {
    // **口を広げても、読めないものは読めない。** 「生で返せる種別ではありません」は
    // 消えたが、**「読めなかった理由」を言う断りは残る**（設計§5-4）——押した人に
    // 必要なのは後者である
    let sandbox = Sandbox::new("binary");
    let path = sandbox.file("書類.pdf", &[0x25, 0x50, 0x44, 0x46, 0x00, 0x01]);
    let server = common::TestServer::start_with(config_for("binary")).await;

    let response = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=raw",
            escape(&path)
        ))
        .await;

    assert_eq!(response.status, 415);
    assert!(
        String::from_utf8_lossy(&response.body).contains("テキストではありません"),
        "何が駄目なのか分かる説明であること（{}）",
        String::from_utf8_lossy(&response.body)
    );
}

#[tokio::test]
async fn 読めない指定はこちらの落ち度として断る() {
    // **PC のせいに見えるコードへ寄せない**（`hosts.rs` が `LogsQuery` で同じことをしている）
    let sandbox = Sandbox::new("badas");
    let path = sandbox.file("撮った.gif", 小さなGIF);
    let server = common::TestServer::start_with(config_for("badas")).await;

    let response = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=binary",
            escape(&path)
        ))
        .await;

    assert_eq!(response.status, 400);
    assert!(String::from_utf8_lossy(&response.body).contains("`as` を読めません"));
}

#[tokio::test]
async fn 指定が無ければ今までどおりjsonが返る() {
    // **壊していないこと**（設計§13）。`as` を足したことで既定の形が変わっていない
    let sandbox = Sandbox::new("json");
    let path = sandbox.file("計画.md", "# 計画\n- [x] 済み\n".as_bytes());
    let server = common::TestServer::start_with(config_for("json")).await;

    let (status, body) = server
        .get(&format!("/api/hosts/local/file?path={}", escape(&path)))
        .await;

    assert_eq!(status, 200);
    let content: protocol::fs::FileContent = serde_json::from_str(&body).expect("JSON であること");
    assert!(content.text.contains("- [x] 済み"));
    assert!(!content.truncated);
}

#[tokio::test]
async fn 画像の上限は生の口でも効く() {
    let sandbox = Sandbox::new("toolarge");
    let size = protocol::fs::MAX_BLOB_BYTES as usize + 1;
    let path = sandbox.file("大きい.png", &vec![0u8; size]);
    let server = common::TestServer::start_with(config_for("toolarge")).await;

    let response = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=raw",
            escape(&path)
        ))
        .await;

    assert_eq!(response.status, 413);
    assert!(
        String::from_utf8_lossy(&response.body).contains(&size.to_string()),
        "大きさが読めること"
    );
}

#[tokio::test]
async fn htmlにはテキストの上限が効く() {
    // **種別ごとに別の道を通っている**ことの裏取り（設計§5-2）。
    // 画像の上限（8 MiB）で判定していたら、この大きさは通ってしまう
    let sandbox = Sandbox::new("htmllarge");
    let size = protocol::fs::MAX_FILE_BYTES as usize + 1;
    let path = sandbox.file("大きい.html", &vec![b'a'; size]);
    let server = common::TestServer::start_with(config_for("htmllarge")).await;

    let response = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=raw",
            escape(&path)
        ))
        .await;

    assert_eq!(response.status, 413);
}

#[tokio::test]
async fn 知らないpcは生の口でも同じ言葉で断る() {
    // 他人の PC と知らない PC を言い分けない（`イシューグループ_2026_0805_0514 設計§18`）
    let sandbox = Sandbox::new("unknown");
    let path = sandbox.file("撮った.gif", 小さなGIF);
    let server = common::TestServer::start_with(config_for("unknown")).await;

    let response = server
        .get_raw(&format!(
            "/api/hosts/{}/file?path={}&as=raw",
            uuid::Uuid::new_v4(),
            escape(&path)
        ))
        .await;

    assert_eq!(response.status, 404);
}
