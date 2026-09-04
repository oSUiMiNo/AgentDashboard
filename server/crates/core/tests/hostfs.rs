//! ローカルモードでフォルダとファイルが取れること（テスト計画 フェーズ3「往復の成立」）。
//!
//! # なぜ `session-host-core` の単体テストだけでは足りないのか
//!
//! あちらが確かめているのは**読み方の決まり**（並び・上限・断り方）で、ここが確かめるのは
//! **境界を通ること**である。`SessionHost` は「サーバ側から見た PC 側」の口で、
//! ローカルモードではその実装が同じプロセスの中を向く（設計§5・§19）。
//!
//! ここが通らないと、サーバ側で「ローカルなら自分で読む」という近道を書きたくなる——
//! それをやると「ローカルでは動くのにセルフホストで欠ける」という、経路の違いが原因で
//! テストを増やしても見つからない壊れ方が残る。

#![allow(non_snake_case)]

use agentdashboard_core::local::LocalSessionHost;
use server_core::session_host::{HostAskRequest, SessionHost};
use session_host_core::{config::SessionHostConfig, session::SessionManager};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 使い捨ての作業場所。
///
/// **名前は1件ごとに変える。** 以前はプロセスIDだけで作っていたが、**同じ実行ファイルの
/// 中の別のテストとぶつかる**——テストは既定で並列に走るので、片方が使っている最中に
/// もう片方の `Sandbox::new()`（と `Drop`）が**同じパスを消す**。
///
/// 症状は2通りに出て、どちらも自分の変更のせいに見える。
///
/// | 何が見えるか | いつ消されたか |
/// |---|---|
/// | 一覧に `src` が無い | 中身を作っている途中で消された |
/// | フォルダごと「開けません」 | 作り終えてから読むまでの間に消された |
///
/// **`--test-threads=1` にすると通ってしまう**ので、負荷や実行順のせいだと読み違えやすい。
/// プロセスIDに連番を足して、**そもそもぶつからない**ようにする。
struct Sandbox(PathBuf);

/// [`Sandbox`] の名前を1件ごとに分けるための連番。
static SANDBOX_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

impl Sandbox {
    fn new() -> Self {
        let seq = SANDBOX_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "agentdashboard-local-fs-{}-{seq}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("作業場所を作れること");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// PTY を1つも起こさずに口だけ作る。**このテストはセッションを必要としない。**
fn host() -> LocalSessionHost {
    let config = SessionHostConfig::default();
    LocalSessionHost::new(SessionManager::new(Arc::new(config)))
}

fn ask() -> HostAskRequest {
    HostAskRequest {
        account_id: uuid::Uuid::new_v4(),
        // ローカルモードには PC という単位が無い（設計§19）
        target: None,
    }
}

#[tokio::test]
async fn ローカルモードでも境界を通って一覧と中身が取れる() {
    let sandbox = Sandbox::new();
    std::fs::create_dir_all(sandbox.path().join("src")).expect("フォルダを作れること");
    let body = "# 計画\n- [x] 済み\n";
    std::fs::write(sandbox.path().join("計画.md"), body).expect("ファイルを作れること");

    let host = host();

    // ① 一覧
    let listing = host
        .list_dir(ask(), Some(&sandbox.path().display().to_string()))
        .await
        .expect("一覧が取れること");
    let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["src", "計画.md"],
        "ディレクトリが先で返ること（読み方の決まりが境界の向こうから届いている）"
    );

    // ② 中身
    let content = host
        .read_file(ask(), &sandbox.path().join("計画.md").display().to_string())
        .await
        .expect("中身が取れること");
    assert_eq!(content.text, body);
    assert_eq!(content.bytes, body.len() as u64);
}

#[tokio::test]
async fn 読めないときは理由が説明として返る() {
    let host = host();

    let err = host
        .list_dir(ask(), Some("/居ないフォルダ/居ない"))
        .await
        .expect_err("断ること");

    // **ローカルが作るのは `Failed` だけ。** 線を跨がないので、届かなかったことを表す
    // 残りの理由（宛先不明・時間切れ・連絡係の断）は起こりえない（設計§19）
    assert!(
        matches!(
            err,
            server_core::session_host::HostAskError::Failed {
                reason: protocol::a2s::HostFailure::NotFound,
                ..
            }
        ),
        "読めない理由がそのまま写ること（{err:?}）"
    );
    assert!(
        err.message().contains("居ないフォルダ"),
        "何を開けなかったのかが説明に残ること（{}）",
        err.message()
    );
}

#[tokio::test]
async fn ローカルモードで宛先を指名されたら断る() {
    // ローカルには PC という単位が無い（設計§19）。黙って無視すると
    // `/api/hosts/<でたらめ>/dir` が手元のファイルを返し、**口の意味が構成で変わる**
    let sandbox = Sandbox::new();
    let host = host();

    let err = host
        .list_dir(
            HostAskRequest {
                account_id: uuid::Uuid::new_v4(),
                target: Some(protocol::AgentId(uuid::Uuid::new_v4())),
            },
            Some(&sandbox.path().display().to_string()),
        )
        .await
        .expect_err("断ること");

    // 知らない PC と同じ言葉。綴りを変えて探る余地を残さない
    assert_eq!(err, server_core::session_host::HostAskError::UnknownHost);
}

/// `path` を省略すると、その PC の**ホームへ着く**（設計§26-2）。
///
/// 設計§13 は始まりの場所の1つをホームと決めているが、当初の「能力の名乗りで運ぶ」道は
/// **ローカルモードでは成立しない**（あちらは PC の一覧そのものを持たない）。省略できる
/// 形にしてあるので、ここが通ることがローカル側の担保になる。
///
/// 着いた先は応答の `path` に載る——**画面はここを見てパンくずを組み立てる**ので、
/// 空だと現在地を出せない。
#[tokio::test]
async fn 一覧はパスを省略するとホームから始まる() {
    let listing = host()
        .list_dir(ask(), None)
        .await
        .expect("ホームを引けること");

    // 起点はカードと同じ規則で正規化される（設計§13）ので、期待値も同じ規則で作る
    let home = session_host_core::hostfs::home();
    assert_eq!(
        listing.path,
        home.canonicalize().unwrap_or(home).display().to_string(),
        "省略したのにホーム以外へ着いた"
    );
    assert!(!listing.path.is_empty(), "着いた先が応答に載っていない");
}

// 「中身の読み取りはパスの省略を断る」は**書けなくなったので消した**。
//
// あれは `HostAskRequest.path` が `Option` で、型が許してしまう状態を実行時に
// 塞いでいることを固定するテストだった。`read_file` がパスを必須で受ける形に
// なった以上、省略した呼び出しはコンパイルが通らない——**同じことを型が
// 言っているので、実行して確かめる意味が無い**（設計§29）。

// ---------------------------------------------------------------------------
// 資源（起こし直し設計§18-4）
// ---------------------------------------------------------------------------

/// 見積もりと余白を決めた口を作る。
fn host_with(estimate_mb: u64, headroom_mb: u64) -> LocalSessionHost {
    host_and_manager(estimate_mb, headroom_mb).0
}

/// 読む口を差し替えたいときは、器のほうも受け取る。
///
/// **`LocalSessionHost` に取り出す口を足さない。** 製品には要らないものなので、
/// テストのために公開する面を増やさない。
fn host_and_manager(estimate_mb: u64, headroom_mb: u64) -> (LocalSessionHost, Arc<SessionManager>) {
    let config = SessionHostConfig {
        revive_estimate_mb: estimate_mb,
        revive_headroom_mb: headroom_mb,
        ..SessionHostConfig::default()
    };
    let manager = SessionManager::new(Arc::new(config));
    (LocalSessionHost::new(Arc::clone(&manager)), manager)
}

#[tokio::test]
async fn ローカルモードでも境界を通って資源が取れる() {
    // **ここが通らないと、サーバ側で「ローカルなら自分の `/proc/meminfo` を読む」という
    // 近道を書きたくなる。** それをやると、セルフホストで**別の機械のメモリ**を答える
    // ことになる——セッションを抱えているのはサーバではなく PC である
    let host = host_with(1_000, 2_000);

    let resources = host.host_resources(ask()).await.expect("答えが返ること");

    assert!(resources.total_mb > 0, "積んでいる量が読めること");
    assert_eq!(resources.estimate_mb, 1_000, "設定がそのまま載ること");
    assert_eq!(resources.headroom_mb, 2_000);
    // 数えた結果が設定と辻褄が合っていること（規則は PC 側の1箇所。§18-2）
    let 期待 = resources.available_mb.saturating_sub(2_000) / 1_000;
    let 数えた = resources.fits_now.expect("見積もりがあるので数えること");
    assert_eq!(u64::from(数えた), 期待);
}

#[tokio::test]
async fn 資源もローカルモードで宛先を指名されたら断る() {
    // フォルダと同じ扱い。**口の意味が構成で変わらないこと**
    let host = host_with(780, 2_048);

    let err = host
        .host_resources(HostAskRequest {
            account_id: uuid::Uuid::new_v4(),
            target: Some(protocol::AgentId(uuid::Uuid::new_v4())),
        })
        .await
        .expect_err("断ること");

    assert_eq!(err, server_core::session_host::HostAskError::UnknownHost);
}

/// 読めない機械（Linux 以外）を演じる口。
#[derive(Debug)]
struct 読めない;

impl session_host_core::resources::Probe for 読めない {
    fn read(&self) -> Option<session_host_core::resources::Memory> {
        None
    }
}

/// 逃がした先が落ちる口。**実装の誤りを演じる。**
#[derive(Debug)]
struct 落ちる;

impl session_host_core::resources::Probe for 落ちる {
    fn read(&self) -> Option<session_host_core::resources::Memory> {
        panic!("読み取りの途中で落ちた");
    }
}

/// **「読めない」と「逃がした先が落ちた」は別の答えになること**（コードレビュー対応4）。
///
/// 以前は `.await.ok().flatten()` で受けており、`JoinError` が「Linux 以外なので
/// 読めません」と**同じ答えへ潰れていた**。実装の誤りが、正常な構成の話に化ける。
///
/// **壊し方**：`blocking_ask` をやめて `.ok().flatten()` へ戻すと、この1本が落ちる。
#[tokio::test]
async fn 逃がした先が落ちたことは読めないことと言い分ける() {
    let (読めない側, 器1) = host_and_manager(1_000, 2_000);
    器1.set_memory_probe(Arc::new(読めない));
    let 読めない答え = 読めない側
        .host_resources(ask())
        .await
        .expect_err("読めないと言うこと");

    let (落ちる側, 器2) = host_and_manager(1_000, 2_000);
    器2.set_memory_probe(Arc::new(落ちる));
    let 落ちた答え = 落ちる側
        .host_resources(ask())
        .await
        .expect_err("落ちたと言うこと");

    assert_ne!(
        読めない答え, 落ちた答え,
        "実装の誤りを、正常な構成（Linux 以外）と同じ答えにしないこと"
    );

    let 説明 = |err: &server_core::session_host::HostAskError| match err {
        server_core::session_host::HostAskError::Failed { detail, .. } => detail.clone(),
        other => panic!("Failed で返ること: {other:?}"),
    };
    assert!(
        説明(&読めない答え).contains("読めません"),
        "読めない側: {}",
        説明(&読めない答え)
    );
    assert!(
        説明(&落ちた答え).contains("完了できませんでした"),
        "落ちた側: {}",
        説明(&落ちた答え)
    );
}

#[tokio::test]
async fn 見積もりを0にすると数えない() {
    // 歯止めを外したい人のための逃げ道（設計§18-2）。0 除算の防御も兼ねている
    let host = host_with(0, 2_048);

    let resources = host.host_resources(ask()).await.expect("答えが返ること");
    // **番兵ではなく「数えない」を型で言う**（コードレビュー対応2）。以前は
    // `u32::MAX` を数として運んでおり、CLI が「4294967295 枚」と出していた
    assert_eq!(resources.fits_now, None, "数えないこと");
}
