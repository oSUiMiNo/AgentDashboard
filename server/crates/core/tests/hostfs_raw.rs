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
async fn プレビューにだけ探す係が足される() {
    // **プレビューの中をそのまま探せるようにするための係**（利用者の指定・2026-09-08）。
    //
    // 箱は `allow-same-origin` を持たないので、**親の画面からは中に1バイトも触れない**。
    // 探すには**中へ係を置いて指示だけを渡す**しかない——`postMessage` は隔離された箱にも
    // 元から許されているので、**隔離は1段も緩めていない。**
    let sandbox = Sandbox::new("preview");
    let body = "<!doctype html><p>理解</p>";
    let path = sandbox.file("理解.html", body.as_bytes());
    let server = common::TestServer::start_with(config_for("preview")).await;

    let 素 = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=raw",
            escape(&path)
        ))
        .await;
    let 係つき = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=preview",
            escape(&path)
        ))
        .await;

    assert_eq!(素.status, 200);
    assert_eq!(係つき.status, 200);

    // **「ブラウザで開く」（`as=raw`）には1バイトも足さない**
    assert_eq!(String::from_utf8_lossy(&素.body), body);

    let 中身 = String::from_utf8_lossy(&係つき.body).to_string();
    // **先頭には触らない。** `DOCTYPE` の前に何かを差すと互換モードへ落ち、
    // 描き方そのものが変わる——プレビューは見た目を写す面なので、そこを動かさない
    assert!(中身.starts_with(body), "本文はそのまま先頭に残ること");
    assert!(中身.contains("__fileFind"), "探す係が足されていること");
    assert!(中身.contains("<script>"), "係は本文の末尾へ継ぐこと");

    // 鍵は `as=raw` と同じものが付く（緩めていないことの担保）
    for r in [&素, &係つき] {
        assert!(
            r.header("content-security-policy")
                .is_some_and(|value| value.contains("sandbox allow-scripts")),
            "sandbox 指令が付くこと"
        );
        assert!(
            r.header("content-security-policy")
                .is_some_and(|value| !value.contains("allow-same-origin")),
            "`allow-same-origin` は決して足さない"
        );
    }
}

#[tokio::test]
async fn svgには係を足さない() {
    // **`</svg>` の外に要素を置けない**ので、同じ手が使えない。無理に中へ差すと、
    // 文書の構造をこちらが書き換えることになる
    let sandbox = Sandbox::new("preview-svg");
    let body = r#"<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>"#;
    let path = sandbox.file("図.svg", body.as_bytes());
    let server = common::TestServer::start_with(config_for("preview-svg")).await;

    let response = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=preview",
            escape(&path)
        ))
        .await;

    assert_eq!(response.status, 200);
    assert_eq!(String::from_utf8_lossy(&response.body), body);
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

    // **JSON でも開けない**。2026-11-23（`ファイル閲覧の上限を設定から変え、大きいものは
    // 流し読みする`）から、一括で読む線を超えたものは先頭の窓を読むので、中身0の画像は
    // 413 ではなく「テキストではない」（415）で断られる。画面は画像を生の口で読むので、
    // 利用者に見える振る舞いは変わらない
    let (status, _) = server
        .get(&format!("/api/hosts/local/file?path={}", escape(&path)))
        .await;
    assert_eq!(status, 415, "画像は JSON の道でも開けないこと");
}

const MIB: u64 = 1024 * 1024;

/// 窓の継ぎ目が字の途中に当たるよう、**多バイト字・改行・数字を混ぜた**本文を作る。
///
/// 同じ字の繰り返しにすると、窓の境目が必ず字の境目に当たり、終わりの寄せを外しても
/// 気づけない。`<script>` は含めない（探す係が1つだけ付くことを数えるため）。
fn 混ぜた本文(at_least: usize) -> String {
    let mut text = String::with_capacity(at_least + 128);
    let mut n = 0u64;
    while text.len() < at_least {
        text.push_str(&format!("{n:08} 理解ドキュメントの行。表と図🧭 abc\n"));
        n += 1;
    }
    text
}

/// 先頭に字を書き、残りを**中身を書かずに**伸ばしたファイル（疎なファイル）。
///
/// 一括で読む線を超えたファイルは先頭の窓（256 KiB）を読むので、先頭まで NUL だと
/// 「テキストではない」（415）で断られ、確かめたい判定まで届かない（テスト計画の前提）。
fn 先頭だけ字のファイル(
    sandbox: &Sandbox,
    name: &str,
    head_bytes: usize,
    size: u64,
) -> String {
    let path = sandbox.0.join(name);
    std::fs::write(&path, 混ぜた本文(head_bytes)).expect("置けること");
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .and_then(|file| file.set_len(size))
        .expect("伸ばせること");
    path.display().to_string()
}

#[tokio::test]
async fn 窓読みの頼み方の誤りはこちらの落ち度として断る() {
    // `ファイル閲覧の上限を設定から変え、大きいものは流し読みする` 設計§5-1。
    // **PC のせいに見えるコードへ寄せない**（400）。文は画面がそのまま出す
    let sandbox = Sandbox::new("rangebad");
    let path = sandbox.file("小さい.txt", "あいう\n".as_bytes());
    let server = common::TestServer::start_with(config_for("rangebad")).await;
    let base = format!("/api/hosts/local/file?path={}", escape(&path));

    for (query, expect) in [
        ("&as=range", "`as=range` には `offset` が要ります"),
        ("&as=range&offset=x", "`offset` を数として読めません：x"),
        (
            "&as=range&offset=0&length=0",
            "`length` に 0 は指定できません",
        ),
        (
            "&as=range&offset=0&align=word",
            "`align` を読めません：word",
        ),
        // 窓の引数は窓読みのときだけ。**受けたふりをしない**
        ("&offset=0", "`as=range` のときだけ使えます"),
        ("&as=raw&length=10", "`as=range` のときだけ使えます"),
        ("&as=binary", "合うのは raw と preview と range です"),
    ] {
        let response = server.get_raw(&format!("{base}{query}")).await;
        assert_eq!(response.status, 400, "{query} は 400 で断ること");
        let body = String::from_utf8_lossy(&response.body);
        assert!(body.contains(expect), "{query} の断り文：{body}");
    }
}

#[tokio::test]
async fn 窓の長さは切り詰め_上限は設定で決まりブラウザの言い値では動かない() {
    // 設計§5-1（長さはサーバが切り詰める）・§5-2（上限はサーバが設定から決めて PC へ運ぶ）
    let sandbox = Sandbox::new("rangeclip");
    let text = 混ぜた本文((2 * MIB + MIB / 2) as usize);
    let path = sandbox.file("育つ記録.log", text.as_bytes());
    let server = common::TestServer::start_with(config_for("rangeclip")).await;
    let file = format!("/api/hosts/local/file?path={}", escape(&path));

    let (status, body) = server
        .get(&format!("{file}&as=range&offset=0&length=2097152"))
        .await;
    assert_eq!(status, 200, "{body}");
    let chunk: protocol::fs::FileChunk = serde_json::from_str(&body).expect("窓の JSON であること");
    assert_eq!(chunk.start, 0);
    assert!(
        chunk.end - chunk.start <= protocol::fs::RANGE_MAX_BYTES,
        "2 MiB を頼んでも1回の最大（1 MiB）までしか運ばないこと：{}",
        chunk.end - chunk.start
    );
    assert!(chunk.end > 0, "空の窓ではないこと");
    assert_eq!(
        chunk.text.as_bytes(),
        &text.as_bytes()[..chunk.end as usize]
    );

    // **設定を変えると次の読みから効く**（REST の PUT はフェーズ4。ここでは DB を直に書く）
    server_core::db::settings::set_file_view_max_bytes(server.registry.db(), Some(MIB))
        .await
        .expect("書けること");
    let (status, body) = server.get(&file).await;
    assert_eq!(status, 413, "上限 1 MB なら 2.5 MB は断ること：{body}");
    // ブラウザが上限らしき引数を付けても、1バイトも効かない
    let (status, _) = server
        .get(&format!("{file}&limit=21474836480&max_bytes=21474836480"))
        .await;
    assert_eq!(status, 413, "ブラウザの言い値で上限が決まらないこと");
    // 窓読みでも設定の上限を越えさせない
    let (status, _) = server.get(&format!("{file}&as=range&offset=0")).await;
    assert_eq!(status, 413, "窓読みでも上限を越えさせないこと");

    server_core::db::settings::set_file_view_max_bytes(server.registry.db(), None)
        .await
        .expect("消せること");
    let (status, body) = server.get(&file).await;
    assert_eq!(status, 200, "既定（ローカルの 5 GB）へ戻ること：{body}");
}

#[tokio::test]
async fn 上限は設定の口から変えると次の読みから効く() {
    // 設計§6-3。上の試験は DB を直に書いていた（フェーズ3 にはまだ PUT が無かった）。
    // ここは画面と同じ道（`PUT /api/settings`）で変えて、次の読みから効くことを見る。
    // **この器は設定の持ち主を立てない**（`start_with`）ので、持ち主の居ない変える口が
    // 返す答えにも `file_view` が入っていることを同時に見る
    let sandbox = Sandbox::new("limitput");
    let text = 混ぜた本文((2 * MIB + MIB / 2) as usize);
    let path = sandbox.file("育つ記録.log", text.as_bytes());
    let server = common::TestServer::start_with(config_for("limitput")).await;
    let file = format!("/api/hosts/local/file?path={}", escape(&path));

    let (status, body) = server.get(&file).await;
    assert_eq!(status, 200, "既定（ローカルの 5 GB）なら開けること：{body}");

    let (status, body) = server
        .put("/api/settings", r#"{"file_view_max_bytes":1048576}"#)
        .await;
    assert_eq!(status, 200, "{body}");
    let answer: serde_json::Value = serde_json::from_str(&body).expect("JSON であること");
    assert_eq!(
        answer["file_view"]["max_bytes"], MIB,
        "持ち主の居ない変える口の答えにも上限が入ること：{body}"
    );
    let (status, body) = server.get(&file).await;
    assert_eq!(status, 413, "上限 1 MB なら 2.5 MB は断ること：{body}");

    let (status, body) = server
        .put("/api/settings", r#"{"file_view_max_bytes":"default"}"#)
        .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = server.get(&file).await;
    assert_eq!(status, 200, "既定へ戻せば開けること：{body}");
}

#[tokio::test]
async fn 大きいファイルのjsonは先頭の窓だけを運び書き戻せない() {
    // 設計§5-3。一括で読む線（3 MiB）を超えたら、先頭の窓だけ＋`truncated`
    let sandbox = Sandbox::new("jsonwindow");
    let small = sandbox.file("小さい.md", "# 見出し\n".as_bytes());
    let text = 混ぜた本文((4 * MIB) as usize);
    let large = sandbox.file("大きい.md", text.as_bytes());
    let server = common::TestServer::start_with(config_for("jsonwindow")).await;
    server_core::db::settings::set_writable_roots(
        server.registry.db(),
        server_core::db::LOCAL_ACCOUNT_ID,
        &[sandbox.0.display().to_string()],
    )
    .await
    .expect("書ける場所を入れられること");

    // **対照**：根の内側の小さいファイルは書ける。これが無いと、下の「書けない」が
    // 根が無いせいで元から偽なのか、大きいせいなのかを言えない
    let (status, body) = server
        .get(&format!("/api/hosts/local/file?path={}", escape(&small)))
        .await;
    assert_eq!(status, 200, "{body}");
    let content: protocol::fs::FileContent = serde_json::from_str(&body).expect("JSON");
    assert!(content.writable, "根の内側の小さいファイルは書けること");

    let (status, body) = server
        .get(&format!("/api/hosts/local/file?path={}", escape(&large)))
        .await;
    assert_eq!(status, 200);
    let content: protocol::fs::FileContent = serde_json::from_str(&body).expect("JSON");
    assert!(content.truncated, "先頭の窓だけであること");
    assert!(content.text.len() as u64 <= protocol::fs::WINDOW_BYTES);
    assert!(text.starts_with(&content.text), "先頭がそのまま来ること");
    assert_eq!(content.bytes, text.len() as u64, "全体の大きさを添えること");
    assert!(!content.writable, "先頭の窓だけのものは書き戻せないこと");
}

#[tokio::test]
async fn htmlは画像の上限ではなくテキストの道を通る() {
    // **種別ごとに別の道を通っている**ことの裏取り（`ファイル閲覧で画像とHTMLも表示する`
    // 設計§5-2）。画像の上限（8 MiB）で判定していたら、この大きさは断られる。
    //
    // 2026-11-23 の仕様変更（`ファイル閲覧の上限を設定から変え、大きいものは流し読みする`
    // 方針§2）で、3 MiB を超える HTML も**窓を繰り返し読んで流して返す**ようになった。
    // 以前の `htmlにはテキストの上限が効く`（3 MiB＋1 で 413）をこれと
    // `htmlにはプレビューの天井が効く` の2本に分けた
    let sandbox = Sandbox::new("htmlstream");
    let mut text = String::from("<!doctype html><pre>\n");
    text.push_str(&混ぜた本文(protocol::fs::MAX_BLOB_BYTES as usize + 1));
    text.push_str("</pre>\n");
    assert!(text.len() as u64 > protocol::fs::MAX_BLOB_BYTES);
    let path = sandbox.file("大きい.html", text.as_bytes());
    let server = common::TestServer::start_with(config_for("htmlstream")).await;

    let response = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=raw",
            escape(&path)
        ))
        .await;
    assert_eq!(response.status, 200, "画像の上限で断らないこと");
    assert!(response.complete, "終わりまで流れ切ること");
    assert_eq!(response.body.len(), text.len(), "長さが元と同じであること");
    assert!(
        response.body == text.as_bytes(),
        "中身が元と全部一致すること"
    );
    assert_eq!(
        response.header("content-length"),
        None,
        "流して返すので長さを先に約束しない"
    );
    assert_eq!(
        response.header("content-type").as_deref(),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(
        response.header("x-content-type-options").as_deref(),
        Some("nosniff")
    );
    assert_eq!(
        response.header("cache-control").as_deref(),
        Some("no-store")
    );
    assert!(
        response
            .header("content-security-policy")
            .is_some_and(|csp| csp.starts_with("sandbox allow-scripts;")),
        "流す道でも同じ隔離のヘッダが付くこと"
    );

    // プレビューは、**先頭を1バイトも変えずに**末尾へ探す係を1つだけ継ぐ
    let response = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=preview",
            escape(&path)
        ))
        .await;
    assert_eq!(response.status, 200);
    assert!(response.complete);
    assert!(
        response.body.starts_with(text.as_bytes()),
        "先頭が元のままであること"
    );
    let rest = &response.body[text.len()..];
    assert!(rest.starts_with(b"\n<script>"), "末尾に探す係が継がること");
    assert!(rest.ends_with(b"</script>\n"));
    // **丸ごと返す道と同じ係が、ちょうど1つ**継がっていること。小さい HTML の
    // プレビューで付く末尾と、バイト単位で一致することで見る（係の本文自体が
    // `<script>` の字を含むので、字を数える形では言えない）
    let 小さい本文 = "<!doctype html><p>小</p>";
    let small = sandbox.file("小さい.html", 小さい本文.as_bytes());
    let 小さい係つき = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=preview",
            escape(&small)
        ))
        .await;
    assert_eq!(小さい係つき.status, 200);
    assert!(
        rest == &小さい係つき.body[小さい本文.len()..],
        "流す道と丸ごと返す道で、継ぐ係が同じ1つであること"
    );
}

#[tokio::test]
async fn htmlにはプレビューの天井が効く() {
    // 丸ごと送る口（raw／preview）は、ブラウザのタブが落ちる大きさを送らない（設計§5-4）
    let sandbox = Sandbox::new("htmlceiling");
    let size = server_core::file_view::PREVIEW_MAX_BYTES + 1;
    let path = 先頭だけ字のファイル(&sandbox, "天井越え.html", 300 * 1024, size);
    let server = common::TestServer::start_with(config_for("htmlceiling")).await;

    let response = server
        .get_raw(&format!(
            "/api/hosts/local/file?path={}&as=raw",
            escape(&path)
        ))
        .await;
    assert_eq!(response.status, 413);
    let body = String::from_utf8_lossy(&response.body);
    assert!(body.contains("ブラウザへ丸ごと送れる大きさ"), "{body}");
    assert!(
        body.contains(&size.to_string()),
        "実際の大きさが読めること：{body}"
    );

    // **対照**：天井は丸ごと送る口だけの線。JSON は先頭の窓を返す
    let (status, body) = server
        .get(&format!("/api/hosts/local/file?path={}", escape(&path)))
        .await;
    assert_eq!(status, 200, "{body}");
    let content: protocol::fs::FileContent = serde_json::from_str(&body).expect("JSON");
    assert!(content.truncated);
    assert_eq!(content.bytes, size);
}

#[tokio::test]
async fn 流す途中でファイルが変わったら打ち切る() {
    // 設計§5-4。読んでいる間にファイルが変わったら、**成功の顔で全文と偽らない**。
    //
    // 製品コードに試験のための待ちを作らず、**受け手がわざと読むのを止める**。その間に
    // 送り手が先へ進めるのは「送り手の送信の箱（`tcp_wmem` の最大まで育つ）＋受け手の受信の
    // 箱＋送り手の手元の窓（読んだ1窓と、書き込みを待つ1窓）」だけ。受信の箱は既定では
    // `tcp_rmem` の最大（この PC で 6 MiB）まで育つので、**接続の前に小さく決めて**育たない
    // ようにする（`testkit::connect_with_recv_buffer`）。その量を大きさが十分に超えるなら、
    // 止まっている間に書き換えた後の窓を、送り手は必ず読む
    let size = (server_core::file_view::PREVIEW_MAX_BYTES - MIB) as usize;
    let sandbox = Sandbox::new("htmlabort");
    let text = 混ぜた本文(size);
    let path = sandbox.file("育つ.html", text.as_bytes());
    let server = common::TestServer::start_with(config_for("htmlabort")).await;

    let (addr, cookie) = (server.addr, server.cookie.clone());
    let (stream, recv_buffer) = testkit::connect_with_recv_buffer(addr, 64 * 1024)
        .await
        .expect("受信の箱を小さくして繋がること");
    // 送り手の箱の最大は機械の設定で決まる（読めない機械では Linux の既定の 4 MiB とみる）
    let send_buffer_max = std::fs::read_to_string("/proc/sys/net/ipv4/tcp_wmem")
        .ok()
        .and_then(|line| line.split_whitespace().nth(2)?.parse::<u64>().ok())
        .unwrap_or(4 * MIB);
    let ahead =
        send_buffer_max + u64::from(recv_buffer) + 2 * protocol::fs::RANGE_MAX_BYTES + 2 * MIB;
    assert!(
        size as u64 >= ahead,
        "前提が崩れた：止めている間に送り手が進める量（送り手の箱 {send_buffer_max}＋受け手の箱 {recv_buffer}＋手元の2窓＋余白 2 MiB＝{ahead} バイト）を、大きさ（{size} バイト＝プレビューの天井 {} − 1 MiB）が超えないと、書き換える前に読み終わりうる。天井を下げたか、この機械の `tcp_wmem` が大きいならこの試験の作りを見直すこと",
        server_core::file_view::PREVIEW_MAX_BYTES
    );
    let url = format!("/api/hosts/local/file?path={}&as=raw", escape(&path));
    let file = std::path::PathBuf::from(&path);
    let received = tokio::task::spawn_blocking(move || {
        use std::io::{Read as _, Write as _};
        let mut stream = stream;
        let cookie_line = cookie
            .map(|value| format!("Cookie: {value}\r\n"))
            .unwrap_or_default();
        write!(
            stream,
            "GET {url} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n{cookie_line}\r\n"
        )
        .expect("頼めること");

        // 先頭の 512 KiB ほどを受け取ったところで止まる
        let mut received = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        while received.len() < 512 * 1024 {
            let n = stream.read(&mut buf).expect("読めること");
            assert!(n > 0, "先頭の 512 KiB を受け取る前に切れないこと");
            received.extend_from_slice(&buf[..n]);
        }
        // **その間にファイルの末尾へ1行足す**（大きさと更新時刻が変わる＝印が変わる）
        std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .and_then(|mut handle| handle.write_all(b"\n<!-- added -->\n"))
            .expect("書き足せること");
        // 残りを読み切る（打ち切られると `ConnectionReset` で届くことがある）
        loop {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => received.extend_from_slice(&buf[..n]),
                Err(err) if err.kind() == std::io::ErrorKind::ConnectionReset => break,
                Err(err) => panic!("読めること：{err}"),
            }
        }
        received
    })
    .await
    .expect("受け手のスレッドが落ちないこと");

    let response = testkit::parse_raw_response(&received).expect("応答として読めること");
    assert_eq!(response.status, 200, "流し始めてから切れること");
    assert!(
        !response.complete,
        "終わりの塊が来ない＝途中で切れたと分かること"
    );
    assert!(
        response.body.len() < text.len(),
        "全文が来ていないこと：{} / {}",
        response.body.len(),
        text.len()
    );
    assert!(
        text.as_bytes().starts_with(&response.body),
        "切れたところまでは元と同じであること"
    );
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
