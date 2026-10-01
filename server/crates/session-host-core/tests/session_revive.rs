//! 抜け殻のカードを起こし直す（接続断のカードを復旧ボタンで戻す テスト計画フェーズ2）。
//!
//! 確かめるのは**セッションホスト側だけ**。接続断という状態そのものはサーバが立てる旗
//! （`SessionMeta::agent_connected`）なので、この層は知らない——ここで押さえるのは
//! 「渡された CardId で起こす」「古い実体を先に畳む」「呼び戻し先を先に入れる」
//! 「同時に起きる本数を絞る」の4つである。
//!
//! # 押す道はまだ無い
//!
//! ブラウザ向けの口とサーバのトレイトはフェーズ3 なので、この段では画面から何も起きない。
//! **だからこそ壊し方を単体で当てられる唯一の段**であり、設計がひっくり返した3点のうち
//! 2点（§7-1 の孤児・§7-3 の戻す先）はここでしか落ちない。

mod common;

use protocol::{CardId, ClaudeSessionId, SessionStatus, ws::ServerMessage};
use session_host_core::{
    config::SessionHostConfig,
    session::{Session, SessionManager},
    state::{HookEvent, HookInput},
};
use std::{sync::Arc, time::Duration};
use tokio::time::{Instant, timeout};

/// 「起きていない」ことを確かめるために待つ長さ。
///
/// 席が空かないかぎり3枚目は [`REVIVE_SETTLE`] ぶん（60秒）待ち続けるので、ここは
/// 短くてよい。**長さで担保しているのではなく、待ち行列が塞がっていることで担保している。**
const QUIET: Duration = Duration::from_millis(300);

/// 頼んで、起き上がるまで待つ。
async fn revive(
    manager: &Arc<SessionManager>,
    card_id: CardId,
    claude_session_id: ClaudeSessionId,
) -> Arc<Session> {
    let in_flight = manager.begin_revive(card_id).expect("印が立つこと");
    manager
        .revive(in_flight, &common::work_dir(), None, claude_session_id)
        .await
        .expect("起こし直せること")
}

/// フック1件を、状態機械へ直に食わせる。
///
/// **この層のテストは受信口を持たない。** フックの受信口を開くのは実行ファイル側
/// （`crates/session-host`）で、`SessionManager` 単体では誰も待ち受けていない。
/// 擬似 claude の `hook` 命令は POST 先が居なくても終了コード 0 で終わる（設計§7）ので、
/// **撃ったつもりで何も起きない**——`fire_hook` はこの crate では使えない。
///
/// 確かめたいのは「立ち上がりきったら席が返る」ことであって、フックが線を通ることでは
/// ないので、状態機械の入口（[`SessionManager::handle_hook`]）を直に叩く。
fn 立ち上がりきらせる(manager: &Arc<SessionManager>, session: &Arc<Session>) {
    manager.handle_hook(
        session,
        &HookInput::new(HookEvent::SessionStart, serde_json::json!({})),
    );
}

/// 条件が満たされるまで巡回する。満たされなければ落とす。
async fn wait_until(label: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + common::TIMEOUT;
    while !check() {
        assert!(
            Instant::now() < deadline,
            "{:?} 以内に「{label}」になりませんでした",
            common::TIMEOUT
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// ---------------------------------------------------------------------------
// 渡した CardId で起こす（設計§7-2）
// ---------------------------------------------------------------------------

#[tokio::test]
async fn 渡したカードidでそのまま起きる() {
    // ここが採番へ戻ると、**抜け殻の隣に新しいカードが1枚増える**だけで、
    // 「戻す」にならない
    let manager = common::manager();
    let card_id = CardId::new();

    let session = revive(&manager, card_id, ClaudeSessionId::new()).await;

    assert_eq!(session.card_id, card_id, "頼んだIDのまま起きること");
    assert!(
        manager.get(card_id).is_some(),
        "そのIDで表から引けること。実際の一覧: {:?}",
        manager.list().iter().map(|m| m.card_id).collect::<Vec<_>>()
    );
    assert_eq!(manager.list().len(), 1, "カードが増えていないこと");
}

#[tokio::test]
async fn 既存の4入口はいままでどおり採番する() {
    // 採番の1行を分けただけで、**公開の4入口の見た目は変えていない**ことの担保。
    // ここが崩れると、ふつうの起動が既存のカードを乗っ取るようになる
    let manager = common::manager();
    let cwd = common::work_dir();

    let 一 = manager.spawn(&cwd).expect("spawn");
    let 二 = manager
        .spawn_with_mode(&cwd, Some(protocol::PermissionMode::new("acceptEdits")))
        .expect("spawn_with_mode");
    let 三 = manager.spawn_with_args(&cwd, &[]).expect("spawn_with_args");
    let 四 = manager
        .resume(&cwd, ClaudeSessionId::new())
        .expect("resume");

    let ids = [一.card_id, 二.card_id, 三.card_id, 四.card_id];
    let 重複無し: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(重複無し.len(), 4, "4入口とも別のカードを作ること: {ids:?}");
    assert_eq!(manager.list().len(), 4);
}

#[tokio::test]
async fn resumeは同じ呼び戻し先でも新しいカードを作る() {
    // 隣のイシュー（過去のセッションを名前で選んで起こす）が使う側なので**消さない**。
    // 復旧とは意味が違う——あちらは新しいカードで過去を開く（設計§7-2）
    let manager = common::manager();
    let cwd = common::work_dir();
    let claude_session_id = ClaudeSessionId::new();

    let 一 = manager.resume(&cwd, claude_session_id).expect("1本目");
    let 二 = manager.resume(&cwd, claude_session_id).expect("2本目");

    assert_ne!(一.card_id, 二.card_id, "同じ呼び戻し先でもカードは別");
    assert_eq!(manager.list().len(), 2, "2枚とも残ること");
}

// ---------------------------------------------------------------------------
// 先に畳む（設計§7-1）
// ---------------------------------------------------------------------------

#[tokio::test]
async fn 同じカードを起こし直すと古い実体は先に畳まれる() {
    let manager = common::manager();
    let (古い, _watcher) = common::start_session(&manager).await;
    let card_id = 古い.card_id;

    let 新しい = revive(&manager, card_id, ClaudeSessionId::new()).await;

    assert_eq!(新しい.card_id, card_id);
    assert!(
        !Arc::ptr_eq(&古い, &新しい),
        "作り直されていること（同じ実体を使い回していない）"
    );
    assert_eq!(manager.list().len(), 1, "カードは1枚のまま");
}

#[tokio::test]
async fn 畳んだあと古い合言葉ではもう引けない() {
    // **設計§7-1 のいちばん悪い形。** `resolve_token` は token → card_id → `get()` なので、
    // 畳まないと古い合言葉が**新しい**セッションを引く。古い claude のフックと
    // `statusLine` が、復旧したカードの状態とモデルを書き換えることになる
    let manager = common::manager();
    let (古い, _watcher) = common::start_session(&manager).await;
    let card_id = 古い.card_id;
    let 古い合言葉 = 古い.token().to_string();

    let 新しい = revive(&manager, card_id, ClaudeSessionId::new()).await;

    assert_ne!(
        古い合言葉,
        新しい.token(),
        "起こし直すと合言葉は振り直される（前提）"
    );
    assert!(
        manager.resolve_token(&古い合言葉).is_none(),
        "古い合言葉が新しいセッションを引いています"
    );
    assert!(
        manager
            .resolve_token(新しい.token())
            .is_some_and(|s| Arc::ptr_eq(&s, &新しい)),
        "新しい合言葉は引けること"
    );
}

#[tokio::test]
async fn 畳んだあと古い擬似ターミナルは終わっている() {
    // `sessions` から外すだけでは死なない。`coalesce_loop` が同じ `Arc` を握ったままで
    // 参照数が 0 にならず、`PtyProcess` の `Drop`（＝kill）が走らないため
    let manager = common::manager();
    let (古い, _watcher) = common::start_session(&manager).await;

    let _新しい = revive(&manager, 古い.card_id, ClaudeSessionId::new()).await;

    common::wait_for_status(&古い, SessionStatus::Ended { ok: true }).await;
}

#[tokio::test]
async fn 起こし直しではカードが消えたことを配らない() {
    // 配るとカードが画面から消える。`archive` と本体を共有しているので、
    // **配信を外し忘れると起こし直すつもりのカードが一覧から居なくなる**
    let manager = common::manager();
    let (古い, _watcher) = common::start_session(&manager).await;
    let card_id = 古い.card_id;
    let mut events = manager.subscribe_events();

    let _新しい = revive(&manager, card_id, ClaudeSessionId::new()).await;

    let mut 消えた = false;
    while let Ok(event) = events.try_recv() {
        if matches!(event, ServerMessage::SessionRemoved { card_id: 対象 } if 対象 == card_id) {
            消えた = true;
        }
    }
    assert!(!消えた, "起こし直しで SessionRemoved を配っています");
    assert!(manager.get(card_id).is_some(), "カードは残っていること");
}

#[tokio::test]
async fn 畳む相手が居なければ何もしない() {
    // PC が起き直して記録を失った場合はこちらが普通（サーバの記録にはカードが残って
    // いるが、この PC の表には無い）
    let manager = common::manager();
    let card_id = CardId::new();
    let mut events = manager.subscribe_events();

    let session = revive(&manager, card_id, ClaudeSessionId::new()).await;

    assert_eq!(session.card_id, card_id);
    let mut 消えた = false;
    while let Ok(event) = events.try_recv() {
        if matches!(event, ServerMessage::SessionRemoved { .. }) {
            消えた = true;
        }
    }
    assert!(!消えた, "居ない相手を畳んで、消えたと配っています");
}

#[tokio::test]
async fn 起こし直したセッションのフック設定は残っている() {
    // **設計に無かった落とし穴。** フック設定の置き場所は
    // `<一時領域>/agentdashboard/<card_id>/` で**カードIDが鍵**なので、畳むほうが後に
    // なると `hooks_settings::cleanup` が**書いたばかりの settings をディレクトリごと
    // 消す**。畳む → 起こす の順序は設計どおりだが、理由がもう1つある
    let manager = common::manager();
    let (古い, _watcher) = common::start_session(&manager).await;

    let 新しい = revive(&manager, 古い.card_id, ClaudeSessionId::new()).await;

    let path = 新しい.settings_path();
    assert!(
        path.is_file(),
        "起こし直したセッションの settings が消えています: {}",
        path.display()
    );
}

#[tokio::test]
async fn 畳んだことはログに1行残る() {
    // 黙って畳まない（設計§11）。相関キー（`card_id`）で絞れることまで見る
    let manager = common::manager();
    let (古い, _watcher) = common::start_session(&manager).await;
    let card_id = 古い.card_id;

    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();
    let _新しい = revive(&manager, card_id, ClaudeSessionId::new()).await;

    let 行 = sink.matching(mark, "card_id", &card_id.to_string());
    assert!(
        行.iter().any(|line| line["msg"]
            .as_str()
            .is_some_and(|msg| msg.contains("畳みました"))),
        "畳んだ1行が出ていません。そのカードの行: {行:?}"
    );
}

#[test]
fn 畳む本体は1つにまとまっている() {
    // `archive` と復旧が別々に畳むと、片方だけ直したときに
    // 「画面からは畳めるのに復旧では畳めない」が起きる。**綴りを数えて1箇所に縛る**
    // （前例：`端末への書き込みは声を持つ口だけを通る`）
    let source = include_str!("../src/session/mod.rs");
    let 製品 = source
        .find("\n#[cfg(test)]")
        .map_or(source, |cut| &source[..cut]);

    for 綴り in [
        "hooks_settings::cleanup(",
        "self.stop_watching_transcript(card_id)",
    ] {
        let 回数 = 製品
            .lines()
            .map(str::trim)
            .filter(|line| !line.starts_with("//"))
            .filter(|line| line.contains(綴り))
            .count();
        assert_eq!(
            回数, 1,
            "{綴り} が製品側に {回数} 箇所あります。畳む本体は `fold` の1つにまとめ、\
             `archive` も復旧もそこを呼ぶこと"
        );
    }
}

// ---------------------------------------------------------------------------
// 呼び戻し先を先に入れる（設計§7-3）
// ---------------------------------------------------------------------------

#[tokio::test]
async fn 復旧したカードは頼んだ呼び戻し先を最初から持つ() {
    let manager = common::manager();
    let claude_session_id = ClaudeSessionId::new();

    let session = revive(&manager, CardId::new(), claude_session_id).await;

    assert_eq!(
        session.meta().claude_session_id,
        Some(claude_session_id),
        "素の引き継ぎと違い、こちらはどのセッションを指定したかを知っている"
    );
    // **頼んだ会話も同時に入る。こちらは張り替えで失われない側である。**
    //
    // 上の `claude_session_id` はフックが別のIDを名乗った瞬間に張り替わる。
    // **復旧はそれがいちばん悪い形で効く**——`recall` と違って**新しいカードを
    // 採番せず既にあるカードを使い回す**ので、上書きされるのが**その会話が持つ
    // 唯一の行**になる。つまり「**復旧ボタンを押した結果、復旧しようとしていた
    // 会話が呼び戻しの一覧から消える**」。
    assert_eq!(
        session.meta().resumed_from,
        Some(claude_session_id),
        "頼んだ会話が入っていない（張り替えで復旧対象そのものを失う）"
    );
}

#[tokio::test]
async fn 起動に失敗しても呼び戻し先は残る() {
    // **ここが `None` へ戻ると、二度と復旧できないカードになる**（「戻す先が無い」に
    // 落ちるため）。素直に擬似 claude で書くと**最初のフックが埋めてしまい落ちない**ので、
    // 起動を失敗させてから判定する（テスト計画フェーズ2 の注意）
    let manager = common::build_manager(
        Arc::new(SessionHostConfig::default()),
        "/bin/false".to_string(),
    );
    let card_id = CardId::new();
    let claude_session_id = ClaudeSessionId::new();

    let session = revive(&manager, card_id, claude_session_id).await;

    common::wait_for_status(&session, SessionStatus::Ended { ok: false }).await;
    assert!(
        !session.meta().hooks_seen,
        "フックが1件も届いていないこと（この前提が崩れると何も確かめていない）"
    );
    assert_eq!(
        session.meta().claude_session_id,
        Some(claude_session_id),
        "起動に失敗しても戻す先を失わないこと"
    );
}

#[tokio::test]
async fn フックが別のidを名乗れば張り替わる() {
    // 受け口を残してあることの担保（設計§7-3）。実測では `--fork-session` を付けない
    // かぎり CLI は元のIDを再利用する（設計§15-1）が、**保険を外す理由が無い**
    let manager = common::manager();
    let card_id = CardId::new();
    let 頼んだ = ClaudeSessionId::new();

    let session = revive(&manager, card_id, 頼んだ).await;
    assert_eq!(session.meta().claude_session_id, Some(頼んだ));

    let 名乗った = ClaudeSessionId::new();
    manager.handle_hook(
        &session,
        &HookInput::new(
            HookEvent::SessionStart,
            serde_json::json!({ "session_id": 名乗った.to_string() }),
        ),
    );

    assert_eq!(
        session.meta().claude_session_id,
        Some(名乗った),
        "CLI が別のIDを名乗ったら、そちらへ張り替わること"
    );
}

// ---------------------------------------------------------------------------
// 上限と連打（設計§8）
// ---------------------------------------------------------------------------

/// 3枚を同時に頼み、起き上がった枚数が数えられる状態にする。
///
/// 擬似 claude は `ready` を出しても**フックを撃つまで `Starting` のまま**なので
/// （`session_lifecycle.rs` が固定している）、席は返らない。
async fn 三枚を同時に頼む(
    manager: &Arc<SessionManager>,
) -> (Vec<CardId>, Vec<tokio::task::JoinHandle<()>>) {
    let ids: Vec<CardId> = (0..3).map(|_| CardId::new()).collect();
    let mut handles = Vec::new();
    for card_id in &ids {
        let in_flight = manager.begin_revive(*card_id).expect("印が立つこと");
        let manager = Arc::clone(manager);
        let cwd = common::work_dir();
        handles.push(tokio::spawn(async move {
            let _ = manager
                .revive(in_flight, &cwd, None, ClaudeSessionId::new())
                .await;
        }));
    }
    (ids, handles)
}

fn 起きた枚数(manager: &Arc<SessionManager>, ids: &[CardId]) -> usize {
    ids.iter().filter(|id| manager.get(**id).is_some()).count()
}

#[tokio::test]
async fn 同時に起きる本数は上限を超えない() {
    let manager = common::manager();
    let (ids, handles) = 三枚を同時に頼む(&manager).await;

    wait_until("2枚が起きる", || 起きた枚数(&manager, &ids) == 2).await;
    // 上限が外れていれば、ここで3枚目も起きてしまう
    tokio::time::sleep(QUIET).await;
    assert_eq!(
        起きた枚数(&manager, &ids),
        2,
        "上限（2）を超えて起きています"
    );

    for handle in handles {
        handle.abort();
    }
}

#[tokio::test]
async fn 上限を超えたぶんは断られずに待って順に起きる() {
    // **断る形にすると、「全て復旧」で6枚のうち4枚が落ちる。** 押した人は
    // 拾い直せないので、ここだけは待たせる（設計§8-1）
    let manager = common::manager();
    let (ids, handles) = 三枚を同時に頼む(&manager).await;
    wait_until("2枚が起きる", || 起きた枚数(&manager, &ids) == 2).await;

    // 起きている1枚を立ち上がりきらせて、席を1つ返させる
    let 起きている = ids
        .iter()
        .find_map(|id| manager.get(*id))
        .expect("起きているカードがあること");
    立ち上がりきらせる(&manager, &起きている);

    wait_until("3枚目が起きる", || 起きた枚数(&manager, &ids) == 3).await;

    for handle in handles {
        handle.abort();
    }
}

#[tokio::test]
async fn 同じカードへ二度頼むと二度目は断られる() {
    // 待ち行列に同じカードが2つ並ぶと、席が空いたとき**両方とも通る**。
    // 実体の有無を見るだけでは防げない——抜け殻には実体が無いので、2つ目も
    // 「居ないから作ってよい」を通ってしまう
    let manager = common::manager();
    let card_id = CardId::new();

    let 一枚目 = manager.begin_revive(card_id).expect("1回目は取れること");
    assert!(
        manager.begin_revive(card_id).is_none(),
        "同じカードへの2回目が通っています"
    );
    // 別のカードは影響を受けない
    assert!(manager.begin_revive(CardId::new()).is_some());

    drop(一枚目);
}

#[tokio::test]
async fn 終わったら印は外れる() {
    // 外れないと、そのカードは二度と復旧できなくなる。
    //
    // **立ち上がりきるまでは外れないのが正しい**（席と一緒に持っている）ので、
    // 起こしただけの状態でも押さえておく——ここが緩むと、立ち上がり中のカードへ
    // 2回目の頼みが通る
    let manager = common::manager();
    let card_id = CardId::new();

    let session = revive(&manager, card_id, ClaudeSessionId::new()).await;
    assert!(
        manager.begin_revive(card_id).is_none(),
        "立ち上がりきる前に印が外れています"
    );

    立ち上がりきらせる(&manager, &session);

    wait_until("印が外れる", || {
        manager.begin_revive(card_id).is_some()
    })
    .await;
}

#[tokio::test]
async fn 席を待っている間も他のカードは動く() {
    // 席待ちを命令の列の中でやると、他のカードへの指示も履歴の送り出しも止まり、
    // 無通信でサーバから切られる（設計§8-3）
    let manager = common::manager();
    let (ids, handles) = 三枚を同時に頼む(&manager).await;
    wait_until("2枚が起きる", || 起きた枚数(&manager, &ids) == 2).await;

    // 3枚目が席を待っている最中に、ふつうの起動が通ること
    let 別のカード = timeout(QUIET, async { manager.spawn(&common::work_dir()) })
        .await
        .expect("席待ちに巻き込まれず、すぐ返ること")
        .expect("起動できること");
    assert!(manager.get(別のカード.card_id).is_some());
    assert_eq!(起きた枚数(&manager, &ids), 2, "3枚目はまだ待っていること");

    for handle in handles {
        handle.abort();
    }
}

#[test]
fn 印は仕事を切り離す前に立てる() {
    // 後に立てると、切り離した2つが同時に印を見て**両方通る**（設計§8-3）。
    // 型の側でも `revive` が印（`ReviveInFlight`）を引数に要求しているので、
    // 印を通らずに起こす道は無い——ここで見るのは**順序**のほう
    let source = include_str!("../src/link.rs");
    let 腕 = source
        .find("ServerToAgent::ReviveSession {")
        .map(|start| &source[start..])
        .expect("復旧の腕があること");
    let 腕 = &腕[..腕.find("ServerToAgent::Kill").expect("次の腕があること")];

    let 印 = 腕.find("begin_revive(").expect("印を立てていること");
    let 切り離し = 腕.find("tokio::spawn(").expect("仕事を切り離していること");
    assert!(
        印 < 切り離し,
        "印を立てるのが切り離しの後になっています。\
         同時に来た2つが両方とも印を見て通ります"
    );
}

// ---------------------------------------------------------------------------
// メモリの床（設計§18-3）
// ---------------------------------------------------------------------------

/// 好きな空きを名乗るメモリ。**呼ばれるたびに次の値を返す**ので、
/// 「列の途中で足りなくなる」まで作れる。
#[derive(Debug)]
struct 名乗るメモリ {
    残り: std::sync::Mutex<std::collections::VecDeque<u64>>,
    最後: u64,
}

impl 名乗るメモリ {
    fn 一定(available_mb: u64) -> Arc<Self> {
        Arc::new(Self {
            残り: std::sync::Mutex::new(std::collections::VecDeque::new()),
            最後: available_mb,
        })
    }

    /// 前から順に名乗り、尽きたら最後の値を言い続ける。
    fn 順に(values: &[u64], 尽きたら: u64) -> Arc<Self> {
        Arc::new(Self {
            残り: std::sync::Mutex::new(values.iter().copied().collect()),
            最後: 尽きたら,
        })
    }
}

impl session_host_core::resources::Probe for 名乗るメモリ {
    fn read(&self) -> Option<session_host_core::resources::Memory> {
        let available_mb = self
            .残り
            .lock()
            .expect("ロックが壊れていない")
            .pop_front()
            .unwrap_or(self.最後);
        Some(session_host_core::resources::Memory {
            total_mb: 16_000,
            available_mb,
            swap_free_mb: 0,
            // **外側を聞けたときは使われない値。** 揃えておけば、WSL でない機械の
            // 答えと1ビットも変わらない
            free_mb: available_mb,
        })
    }
}

/// 読めない機械（Linux 以外）。
#[derive(Debug)]
struct 読めないメモリ;

impl session_host_core::resources::Probe for 読めないメモリ {
    fn read(&self) -> Option<session_host_core::resources::Memory> {
        None
    }
}

/// `MemAvailable` と `MemFree` が食い違う機械。**外側を聞けないときの抑えを試す**ため。
#[derive(Debug)]
struct 空きとフリーが違うメモリ(u64, u64);

impl session_host_core::resources::Probe for 空きとフリーが違うメモリ {
    fn read(&self) -> Option<session_host_core::resources::Memory> {
        Some(session_host_core::resources::Memory {
            total_mb: 16_000,
            available_mb: self.0,
            swap_free_mb: 0,
            free_mb: self.1,
        })
    }
}

/// 外側を聞けない（WSL だが interop が届かない等）。
#[derive(Debug)]
struct 聞けない外側;

impl session_host_core::resources::HostFreeProbe for 聞けない外側 {
    fn read(&self) -> Result<u64, String> {
        Err("起動できません: テストの口".to_string())
    }
}

/// 床を試すための設定。1枚 1,000MB・余白 2,000MB。
fn 床の設定() -> SessionHostConfig {
    SessionHostConfig {
        revive_estimate_mb: 1_000,
        revive_headroom_mb: 2_000,
        ..SessionHostConfig::default()
    }
}

async fn 頼む(manager: &Arc<SessionManager>, card_id: CardId) -> Result<Arc<Session>, String> {
    let in_flight = manager.begin_revive(card_id).expect("印が立つこと");
    manager
        .revive(
            in_flight,
            &common::work_dir(),
            None,
            ClaudeSessionId(uuid::Uuid::new_v4()),
        )
        .await
        .map_err(|err| err.to_string())
}

#[tokio::test]
async fn 空きが床を切っていたら起こし直しを断る() {
    // 余白 2,000 + 1枚 1,000 = 3,000MB 要るところへ 2,500MB しかない
    let manager = common::manager_with(床の設定());
    manager.set_memory_probe(名乗るメモリ::一定(2_500));

    let card_id = CardId::new();
    let refusal = 頼む(&manager, card_id).await.expect_err("断られること");

    assert!(
        refusal.contains("メモリが足りない"),
        "理由がメモリだと分かること: {refusal}"
    );
    assert!(
        refusal.contains("2500") && refusal.contains("1000") && refusal.contains("2000"),
        "空き・1枚あたり・余白の3つが数で出ること（あと何をすればよいか決められる）: {refusal}"
    );
    assert!(
        manager.get(card_id).is_none(),
        "断ったのだから実体は作られていないこと"
    );
}

#[tokio::test]
async fn 空きが足りていれば起こし直せる() {
    // 3,000MB あれば 1 枚は入る（余白 2,000 + 1枚 1,000）
    let manager = common::manager_with(床の設定());
    manager.set_memory_probe(名乗るメモリ::一定(3_000));

    let card_id = CardId::new();
    let session = 頼む(&manager, card_id).await.expect("起こせること");
    assert_eq!(session.card_id, card_id);
}

#[tokio::test]
async fn 読めない機械では床が効かない() {
    // Linux 以外では `/proc/meminfo` が無い。**分からないことを理由に止めない**
    //
    // **これは「メモリそのものを読めない」ときの話である。** 「WSL の外側
    // （Windows）を読めない」は**別物**で、そちらは床が効いたまま**少なく言う側へ
    // 倒れる**——[`wslで外側を読めなくても床は効く`] が見ている。
    // **2つを1つに畳まないこと。** 畳むと、外側を聞けないだけの機械で歯止めが
    // 丸ごと外れる（＝いちばん危ない側へ静かに倒れる）。
    let manager = common::manager_with(床の設定());
    manager.set_memory_probe(Arc::new(読めないメモリ));

    let card_id = CardId::new();
    頼む(&manager, card_id).await.expect("通ること");
    assert!(manager.host_resources().is_none(), "資源も答えられないこと");
}

/// **外側だけ読めない**ときは、床が効いたまま少なく言う側へ倒れる（設計§10-2）。
///
/// 上の [`読めない機械では床が効かない`] と**対になっている。** あちらは
/// `Probe` が `None`（＝資源そのものを答えられない）、こちらは `Probe` は読めるが
/// **外側だけ聞けていない**状態である。**答えの形が違う**ことを、ここで固定する。
#[tokio::test]
async fn wslで外側を読めなくても床は効く() {
    let manager = common::manager_with(床の設定());
    // 空き 12,000（＝抑えなければ 10 枚）だが、`MemFree` は 2,500 しかない
    manager.set_memory_probe(Arc::new(空きとフリーが違うメモリ(
        12_000, 2_500,
    )));
    manager.set_host_free(session_host_core::resources::HostFree::new(
        true,
        Arc::new(聞けない外側),
        std::time::Duration::from_secs(60),
    ));

    let resources = manager
        .host_resources()
        .expect("★資源そのものは答えられること（読めない機械とは別の答えになる）");
    // (2,500 − 2,000) / 1,000 = 0 枚。**抑えなければ 10 枚**
    assert_eq!(
        resources.fits_now,
        Some(0),
        "外側を聞けないぶん、少なく言う側へ倒れること"
    );
    assert_eq!(resources.host_free_mb, None, "まだ聞けていないこと");
    assert_eq!(resources.counted_mb, Some(2_500), "MemFree で抑えたこと");
}

#[tokio::test]
async fn 列の途中で足りなくなったらそこから断られる() {
    // **これが「26枚投げても入るぶんだけ起きる」の中身。** 受付の時点で見ていると、
    // 列に並んだ瞬間はまだ空いているので**全員が「入る」と答えてしまう**
    let manager = common::manager_with(床の設定());
    // 1枚目・2枚目は足りる。3枚目からは足りない
    manager.set_memory_probe(名乗るメモリ::順に(&[5_000, 4_000], 2_500));

    let mut 起きた = 0;
    let mut 断られた = 0;
    for _ in 0..4 {
        let card_id = CardId::new();
        match 頼む(&manager, card_id).await {
            Ok(session) => {
                起きた += 1;
                立ち上がりきらせる(&manager, &session);
            }
            Err(refusal) => {
                断られた += 1;
                assert!(refusal.contains("メモリが足りない"), "理由: {refusal}");
            }
        }
    }
    assert_eq!(起きた, 2, "足りていたぶんだけ起きること");
    assert_eq!(断られた, 2, "足りなくなってからは断られること");
}

#[tokio::test]
async fn いま何枚入るかを答えられる() {
    let manager = common::manager_with(床の設定());
    manager.set_memory_probe(名乗るメモリ::一定(12_000));

    let resources = manager.host_resources().expect("答えられること");
    // (12,000 − 2,000) / 1,000 = 10
    assert_eq!(resources.fits_now, Some(10));
    assert_eq!(resources.available_mb, 12_000);
    assert_eq!(resources.estimate_mb, 1_000);
    assert_eq!(resources.headroom_mb, 2_000);
}

/// 空きが**いま生きているカードの数で決まる**メモリ。
///
/// 「席を取る前に見るか、取った後に見るか」を判別できる唯一の形。固定の値や
/// 決め打ちの並びでは、**同時に頼んだ3枚が全員同じ値を読む**ので区別が付かない。
#[derive(Debug)]
struct 生きている数で決まるメモリ {
    manager: std::sync::Mutex<Option<std::sync::Weak<SessionManager>>>,
    base_mb: u64,
    per_mb: u64,
}

impl 生きている数で決まるメモリ {
    fn 作る(base_mb: u64, per_mb: u64) -> Arc<Self> {
        Arc::new(Self {
            manager: std::sync::Mutex::new(None),
            base_mb,
            per_mb,
        })
    }

    /// 輪にしないよう `Weak` で持つ（`SessionManager` がこの口を握っている）。
    fn 繋ぐ(&self, manager: &Arc<SessionManager>) {
        *self.manager.lock().expect("ロックが壊れていない") = Some(Arc::downgrade(manager));
    }
}

impl session_host_core::resources::Probe for 生きている数で決まるメモリ {
    fn read(&self) -> Option<session_host_core::resources::Memory> {
        let live = self
            .manager
            .lock()
            .expect("ロックが壊れていない")
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
            .map_or(0, |manager| manager.list().len() as u64);
        let available_mb = self.base_mb.saturating_sub(live * self.per_mb);
        Some(session_host_core::resources::Memory {
            total_mb: 16_000,
            available_mb,
            swap_free_mb: 0,
            free_mb: available_mb,
        })
    }
}

#[tokio::test]
async fn 席を待ったカードにも床が効く() {
    // **これが「26枚投げても入るぶんだけ起きる」の観測できる部分。**
    // 席を待たされたカードも、自分の番で改めて空きを見て断られる。
    //
    // 空き 4,500 → 1枚起きるごとに 1,000 減る。余白 2,000・1枚 1,000 なので
    // 2枚目までは入り、**3枚目の番が来た時点では入らない**。
    //
    // **「席より前で見ていないこと」は、このテストでは確かめられない。** 3枚を同時に
    // 頼んでも実際にはタスクが順に走るので、受付時に見る実装でも3枚目は既に2枚起きた
    // 後の空きを読む——壊し方を当てても落ちなかった（当てて確かめた）。
    // **そちらはコンパイラが見張っている**（`reserve_memory` が席を引数に取る）。
    let manager = common::manager_with(床の設定());
    let probe = 生きている数で決まるメモリ::作る(4_500, 1_000);
    probe.繋ぐ(&manager);
    manager.set_memory_probe(Arc::clone(&probe) as Arc<dyn session_host_core::resources::Probe>);

    let ids: Vec<CardId> = (0..3).map(|_| CardId::new()).collect();
    let mut handles = Vec::new();
    for card_id in &ids {
        let in_flight = manager.begin_revive(*card_id).expect("印が立つこと");
        let manager = Arc::clone(&manager);
        let cwd = common::work_dir();
        handles.push(tokio::spawn(async move {
            manager
                .revive(in_flight, &cwd, None, ClaudeSessionId::new())
                .await
                .map(|_| ())
                .map_err(|err| err.to_string())
        }));
    }

    wait_until("2枚が起きる", || 起きた枚数(&manager, &ids) == 2).await;

    // 席を1つ返させる。**ここで3枚目の番が来る**
    let 起きている = ids
        .iter()
        .find_map(|id| manager.get(*id))
        .expect("起きているカードがあること");
    立ち上がりきらせる(&manager, &起きている);

    let mut 断られた = 0;
    for handle in handles {
        if let Ok(Err(refusal)) = handle.await {
            assert!(refusal.contains("メモリが足りない"), "理由: {refusal}");
            断られた += 1;
        }
    }

    assert_eq!(断られた, 1, "席を待った3枚目も、自分の番で断られること");
    assert_eq!(
        起きた枚数(&manager, &ids),
        2,
        "席が空いても、空きが無ければ起きないこと"
    );
}

// ---------------------------------------------------------------------------
// 予約——載る前のぶんも容量として数える（設計§19）
// ---------------------------------------------------------------------------
//
// **ここまでの床は、実は効いていなかった。** `MemAvailable` は実際に確保された
// ぶんしか減らないので、通してから claude が約 780MB を確保し終えるまでの間、
// 空きは「まだ空いている」と言い続ける。席は2つあり、しかも最初のフックで返るので、
// 席の数では容量を守れない。
//
// 下のテストが**空きの動かない**プローブを使うのは、そのためである。空きが動かない
// ＝「メモリがまだ載っていない」を、そのまま作れる。**予約を引いていなければ、
// 何枚でも通る。**

/// 予約を試すための設定。1枚 1,000MB・余白 2,000MB（[`床の設定`] と同じ）。
///
/// **空きは固定**なので、通した枚数を数えていなければ `fits_now` は下がらない。
fn 予約の設定() -> SessionHostConfig {
    床の設定()
}

/// 同時に頼んで、結果を集める。
async fn 同時に頼む(manager: &Arc<SessionManager>, ids: &[CardId]) -> (usize, Vec<String>) {
    let mut handles = Vec::new();
    for card_id in ids {
        let in_flight = manager.begin_revive(*card_id).expect("印が立つこと");
        let manager = Arc::clone(manager);
        let cwd = common::work_dir();
        handles.push(tokio::spawn(async move {
            manager
                .revive(in_flight, &cwd, None, ClaudeSessionId::new())
                .await
                .map(|_| ())
                .map_err(|err| err.to_string())
        }));
    }
    let (mut 起きた, mut 断り) = (0, Vec::new());
    for handle in handles {
        match handle.await.expect("タスクが落ちていないこと") {
            Ok(()) => 起きた += 1,
            Err(refusal) => 断り.push(refusal),
        }
    }
    (起きた, 断り)
}

#[tokio::test]
async fn 同時に席を取った二本は互いを数える() {
    // 空きは 3,000MB のまま動かない＝**1枚ぶんしかない**（余白 2,000 + 1枚 1,000）。
    // 席は2つあるので、2本が同時に床を見る。**読んだ値が同じでも、通るのは1本。**
    let manager = common::manager_with(予約の設定());
    manager.set_memory_probe(名乗るメモリ::一定(3_000));

    let ids: Vec<CardId> = (0..2).map(|_| CardId::new()).collect();
    let (起きた, 断り) = 同時に頼む(&manager, &ids).await;

    assert_eq!(起きた, 1, "1枚ぶんしか無いのだから1枚だけ通ること");
    assert_eq!(断り.len(), 1);
    assert!(
        断り[0].contains("メモリが足りない"),
        "理由がメモリだと分かること: {}",
        断り[0]
    );
}

#[tokio::test]
async fn 席が返っても予約は残る() {
    // 空きは 4,000MB のまま動かない＝**2枚ぶん**。3枚頼む。
    //
    // 2枚を立ち上がりきらせると**席は返る**が、その2枚のメモリはプローブに現れて
    // いない（＝実機で claude が確保し終える前と同じ）。**予約が残っていなければ、
    // 3枚目は「まだ2枚入る」と読んで通ってしまう。**
    let manager = common::manager_with(予約の設定());
    manager.set_memory_probe(名乗るメモリ::一定(4_000));

    let ids: Vec<CardId> = (0..2).map(|_| CardId::new()).collect();
    let (起きた, _) = 同時に頼む(&manager, &ids).await;
    assert_eq!(起きた, 2, "2枚ぶんあるので2枚は通ること");

    // 席を両方返させる。**予約はまだ返らない**
    for card_id in &ids {
        let session = manager.get(*card_id).expect("起きていること");
        立ち上がりきらせる(&manager, &session);
    }
    wait_until("席が2つとも返る", || {
        ids.iter().all(|id| {
            manager
                .get(*id)
                .is_some_and(|s| s.status() != SessionStatus::Starting)
        })
    })
    .await;

    let 三枚目 = CardId::new();
    let refusal = 頼む(&manager, 三枚目).await.expect_err("断られること");
    assert!(
        refusal.contains("メモリが足りない"),
        "席が返っても、載りきるまでは通さないこと: {refusal}"
    );
    assert!(manager.get(三枚目).is_none(), "実体が作られていないこと");
}

#[tokio::test]
async fn まとめて投げても入る枚数を超えない() {
    // **これが「26枚投げても機械が固まらない」の中身。** 空きは動かないので、
    // 予約を数えていなければ26枚とも通る。
    //
    // **席を回しながら投げる。** 起きた2枚を立ち上がりきらせないと席が返らず、
    // 残り24枚は席待ちで [`REVIVE_SETTLE`]（60秒）ぶん止まる——**確かめたいのは
    // 席ではなく床**なので、席は詰まらせない。
    let manager = common::manager_with(予約の設定());
    manager.set_memory_probe(名乗るメモリ::一定(4_000));

    let ids: Vec<CardId> = (0..26).map(|_| CardId::new()).collect();
    let 回す = {
        let manager = Arc::clone(&manager);
        let ids = ids.clone();
        tokio::spawn(async move {
            loop {
                for card_id in &ids {
                    if let Some(session) = manager.get(*card_id)
                        && session.status() == SessionStatus::Starting
                    {
                        立ち上がりきらせる(&manager, &session);
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
    };

    let (起きた, 断り) = 同時に頼む(&manager, &ids).await;
    回す.abort();

    assert_eq!(起きた, 2, "(4,000 − 2,000) / 1,000 = 2 枚を超えないこと");
    assert_eq!(断り.len(), 24, "残りは断られること");
    assert_eq!(起きた枚数(&manager, &ids), 2, "実体も2枚だけであること");
}

#[tokio::test]
async fn 終わったセッションは予約を返す() {
    // 死んだプロセスはメモリを持っていない。**枠を握り続ける理由が無い**
    // ——起こし直しに失敗して即座に落ちた場合が、まさにこれに当たる。
    let manager = common::manager_with(予約の設定());
    manager.set_memory_probe(名乗るメモリ::一定(3_000));

    let card_id = CardId::new();
    頼む(&manager, card_id).await.expect("1枚は通ること");
    wait_until("予約が立つ", || manager.reserved_revives() == 1).await;
    assert_eq!(
        manager.host_resources().expect("読めること").fits_now,
        Some(0),
        "予約中は「もう入らない」と答えること"
    );

    manager.kill(card_id).expect("落とせること");

    wait_until("予約が返る", || manager.reserved_revives() == 0).await;
    assert_eq!(
        manager.host_resources().expect("読めること").fits_now,
        Some(1),
        "終わったぶんは、また入ると答えること"
    );
}

#[tokio::test]
async fn 画面へ答える枚数にも予約が乗る() {
    // 床の判定と**同じ数**を答えること。片方だけ引くと、画面が「入る」と言ったものを
    // PC が断ることになる（`resources.rs` の冒頭が戒めていること）
    let manager = common::manager_with(予約の設定());
    manager.set_memory_probe(名乗るメモリ::一定(5_000));

    assert_eq!(
        manager.host_resources().expect("読めること").fits_now,
        Some(3),
        "(5,000 − 2,000) / 1,000 = 3"
    );

    let card_id = CardId::new();
    頼む(&manager, card_id).await.expect("通ること");
    wait_until("予約が立つ", || manager.reserved_revives() == 1).await;

    let resources = manager.host_resources().expect("読めること");
    assert_eq!(
        resources.fits_now,
        Some(2),
        "通した1枚ぶんが引かれていること"
    );
    assert_eq!(
        resources.available_mb, 5_000,
        "空きそのものは書き換えないこと（機械が報告した値である）"
    );
}

// ---------------------------------------------------------------------------
// WSL の外側の空きで判定する（寝ているカードばかりなのに、メモリ不足でセッションを
// 起こせない 設計§8-1）
// ---------------------------------------------------------------------------
//
// **期限切れの値を捨てて `MemFree` で数えていた**ので、60 秒空けた後の1回目は
// 暖まった WSL では必ず 0 枚で断られていた。判定は新しい値を待ってから数える。

/// 好きな外側を名乗る口。**呼ばれるたびに1つ数える**（取りに行った本数を確かめるため）。
#[derive(Debug)]
struct 名乗る外側 {
    mb: u64,
    回数: std::sync::atomic::AtomicUsize,
}

impl 名乗る外側 {
    fn 作る(mb: u64) -> Arc<Self> {
        Arc::new(Self {
            mb,
            回数: std::sync::atomic::AtomicUsize::new(0),
        })
    }
}

impl session_host_core::resources::HostFreeProbe for 名乗る外側 {
    fn read(&self) -> Result<u64, String> {
        self.回数.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(self.mb)
    }
}

/// 暖まった WSL の姿。`MemAvailable` 20,000・`MemFree` 400（原因調査の実測に近い値）。
fn 暖まったwsl(manager: &Arc<SessionManager>) {
    manager.set_memory_probe(Arc::new(空きとフリーが違うメモリ(20_000, 400)));
}

/// 実機の既定（1枚 780MB・余白 2,048MB）。
fn 実機の設定() -> SessionHostConfig {
    SessionHostConfig {
        revive_estimate_mb: 780,
        revive_headroom_mb: 2_048,
        ..SessionHostConfig::default()
    }
}

#[tokio::test]
async fn 期限切れのあとの1回目でも聞けた外側で数えて起こせる() {
    // 利用者が踏んだ形そのもの。**1時間前に聞けた値は期限（60 秒）を過ぎている**が、
    // 外側の口は聞けば 6,000MB を返す。(6,000 − 2,048) / 780 = 5 枚入る
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    let 外 = 名乗る外側::作る(6_000);
    let host_free = session_host_core::resources::HostFree::new(
        true,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
        Duration::from_secs(60),
    );
    host_free.覚えさせる(
        6_000,
        std::time::Instant::now() - Duration::from_secs(3_600),
    );
    manager.set_host_free(host_free);

    let card_id = CardId::new();
    let session = 頼む(&manager, card_id)
        .await
        .expect("★期限切れの直後でも、取り直した外側の空きで数えて起こせること");
    assert_eq!(session.card_id, card_id);
    assert_eq!(
        外.回数.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "古い値をそのまま使ったのではなく、取り直してから数えたこと"
    );
}

#[tokio::test]
async fn 一度も聞けていない起動直後でも取り直しを待って起こせる() {
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    let 外 = 名乗る外側::作る(6_000);
    manager.set_host_free(session_host_core::resources::HostFree::new(
        true,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
        Duration::from_secs(60),
    ));

    let card_id = CardId::new();
    頼む(&manager, card_id)
        .await
        .expect("★一度も聞けていなくても、取り直しを待ってから数えて起こせること");
    assert_eq!(外.回数.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn wslでまとめて投げても外側で数えた枚数を超えない() {
    // 外側 4,000（期限内）・`MemAvailable` 20,000・余白 2,000・1枚 1,000。
    // **正しくは (4,000 − 2,000) / 1,000 = 2 枚。** 見込みの起点が `MemAvailable` だと
    // 20,000 から引いていくので、外側の 4,000 で抑えたまま 18 枚通る（設計§1-2）
    let manager = common::manager_with(予約の設定());
    manager.set_memory_probe(名乗るメモリ::一定(20_000));
    let host_free = session_host_core::resources::HostFree::new(
        true,
        名乗る外側::作る(4_000),
        Duration::from_secs(60),
    );
    host_free.覚えさせる(4_000, std::time::Instant::now());
    manager.set_host_free(host_free);

    let ids: Vec<CardId> = (0..26).map(|_| CardId::new()).collect();
    let 回す = {
        let manager = Arc::clone(&manager);
        let ids = ids.clone();
        tokio::spawn(async move {
            loop {
                for card_id in &ids {
                    if let Some(session) = manager.get(*card_id)
                        && session.status() == SessionStatus::Starting
                    {
                        立ち上がりきらせる(&manager, &session);
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
    };

    let (起きた, 断り) = 同時に頼む(&manager, &ids).await;
    回す.abort();

    assert_eq!(
        起きた, 2,
        "★外側で数えた (4,000 − 2,000) / 1,000 = 2 枚を超えないこと"
    );
    assert_eq!(断り.len(), 24, "残りは断られること");
}

#[tokio::test]
async fn wslでも画面へ答える枚数に予約が乗る() {
    let manager = common::manager_with(予約の設定());
    manager.set_memory_probe(名乗るメモリ::一定(20_000));
    let host_free = session_host_core::resources::HostFree::new(
        true,
        名乗る外側::作る(5_000),
        Duration::from_secs(60),
    );
    host_free.覚えさせる(5_000, std::time::Instant::now());
    manager.set_host_free(host_free);

    assert_eq!(
        manager.host_resources().expect("読めること").fits_now,
        Some(3),
        "(5,000 − 2,000) / 1,000 = 3"
    );

    頼む(&manager, CardId::new()).await.expect("通ること");
    wait_until("予約が立つ", || manager.reserved_revives() == 1).await;

    assert_eq!(
        manager.host_resources().expect("読めること").fits_now,
        Some(2),
        "★外側で抑えていても、通した1枚ぶんが引かれていること"
    );
}

// ---------------------------------------------------------------------------
// 確かめてから数える（寝ているカードばかりなのに、メモリ不足でセッションを
// 起こせない 設計§8-3）
// ---------------------------------------------------------------------------

/// 前から順に名乗り、尽きたら最後の値を言い続ける外側。**呼ばれた回数も数える。**
#[derive(Debug)]
struct 順に名乗る外側 {
    残り: std::sync::Mutex<std::collections::VecDeque<u64>>,
    最後: u64,
    回数: std::sync::atomic::AtomicUsize,
}

impl 順に名乗る外側 {
    fn 作る(values: &[u64], 尽きたら: u64) -> Arc<Self> {
        Arc::new(Self {
            残り: std::sync::Mutex::new(values.iter().copied().collect()),
            最後: 尽きたら,
            回数: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    fn 回数(&self) -> usize {
        self.回数.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl session_host_core::resources::HostFreeProbe for 順に名乗る外側 {
    fn read(&self) -> Result<u64, String> {
        self.回数.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(self
            .残り
            .lock()
            .expect("ロックが壊れていない")
            .pop_front()
            .unwrap_or(self.最後))
    }
}

/// WSL の一式を差し込む。
fn 外側を差す(
    manager: &Arc<SessionManager>,
    probe: Arc<dyn session_host_core::resources::HostFreeProbe>,
) -> Arc<session_host_core::resources::HostFree> {
    let host_free =
        session_host_core::resources::HostFree::new(true, probe, Duration::from_secs(60));
    manager.set_host_free(Arc::clone(&host_free));
    host_free
}

#[tokio::test]
async fn 確認できなければ確かめられなかったと断りメモリ不足とは言わない() {
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    外側を差す(&manager, Arc::new(聞けない外側));

    let card_id = CardId::new();
    let refusal = 頼む(&manager, card_id).await.expect_err("断られること");
    assert!(
        refusal.contains("確かめられなかった"),
        "確かめられなかったと言うこと: {refusal}"
    );
    assert!(
        !refusal.contains("メモリが足りない"),
        "★足りないと判定したわけではないのだから、メモリ不足と言わないこと: {refusal}"
    );
    assert!(
        refusal.contains("起動できません"),
        "聞けなかった理由を運ぶこと: {refusal}"
    );
    assert!(manager.get(card_id).is_none(), "実体を作らないこと");
}

#[tokio::test]
async fn memfreeが大きくても確認できなければ通さない() {
    // **床で通す道が無いこと。** キャッシュを手放した直後は MemFree が跳ね上がるが、
    // Windows 側の空きとは無関係である
    let manager = common::manager_with(実機の設定());
    manager.set_memory_probe(Arc::new(空きとフリーが違うメモリ(
        20_000, 15_000,
    )));
    外側を差す(&manager, Arc::new(聞けない外側));

    let refusal = 頼む(&manager, CardId::new())
        .await
        .expect_err("★MemFree が大きくても、確かめられなければ通さないこと");
    assert!(refusal.contains("確かめられなかった"), "{refusal}");
}

#[tokio::test]
async fn windows側が本当に逼迫していればその値を添えて断る() {
    // 2026-09-13 22:07:11 の実測。Windows の物理空きは 1,792MB しかない
    let manager = common::manager_with(実機の設定());
    manager.set_memory_probe(Arc::new(空きとフリーが違うメモリ(18_983, 465)));
    外側を差す(&manager, 名乗る外側::作る(1_792));

    let refusal = 頼む(&manager, CardId::new())
        .await
        .expect_err("断られること");
    assert!(refusal.contains("メモリが足りない"), "{refusal}");
    assert!(
        refusal.contains("使える空き 1792 MB＝Windows 側の空き"),
        "判定に使った Windows 側の値を添えること: {refusal}"
    );
    assert!(
        refusal.contains("秒前に確認"),
        "値の古さを添えること: {refusal}"
    );
}

#[tokio::test]
async fn メモリ不足の断りは判定に使った空きを出しmemavailableを出さない() {
    let manager = common::manager_with(実機の設定());
    manager.set_memory_probe(Arc::new(空きとフリーが違うメモリ(18_983, 465)));
    外側を差す(&manager, 名乗る外側::作る(1_792));

    let refusal = 頼む(&manager, CardId::new())
        .await
        .expect_err("断られること");
    assert!(
        !refusal.contains("18983"),
        "★判定に使っていない MemAvailable を空きとして出さないこと: {refusal}"
    );
    assert!(refusal.contains("1792"), "{refusal}");
}

#[tokio::test]
async fn 予約が0件になった後それより前に始めた観測で次を通さない() {
    // 設計§12-8 の時刻の順をそのまま再現する。
    //
    // | 時刻 | 出来事 |
    // |---|---|
    // | 0 | A を通す（5,000 で聞けた。予約1本） |
    // | 30 | 表示が取り直す（A は確保の途中。観測は 5,000 のまま） |
    // | 70 | A の予約が落ちる（見込みを捨てる） |
    // | 75 | B を頼む。**30 の観測は期限内だが、予約が0件になる前に始めたので使わない** |
    //
    // 取り直すと 2,500 しか無いので断る。失効が無ければ 30 の 5,000 を見込み無しで数えて
    // 通してしまう（設計§4-3）
    let manager = common::manager_with(予約の設定());
    manager.set_memory_probe(名乗るメモリ::一定(20_000));
    let 外 = 順に名乗る外側::作る(&[5_000, 5_000], 2_500);
    let host_free = 外側を差す(
        &manager,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );

    // 0：A を通す
    let 一枚目 = CardId::new();
    頼む(&manager, 一枚目).await.expect("1枚目は通ること");
    assert_eq!(外.回数(), 1);
    wait_until("予約が立つ", || manager.reserved_revives() == 1).await;

    // 30：A の予約が残っている間に、表示が取り直す（A の観測を古くして、表示に取り直させる）
    host_free.覚えさせる(
        5_000,
        std::time::Instant::now() - Duration::from_secs(3_600),
    );
    let 表示 = manager.host_resources().expect("読めること");
    assert_eq!(
        表示.host_free_state,
        Some(protocol::HostFreeState::Stale),
        "古い値を見て取り直すこと"
    );
    wait_until("表示の取り直しが終わる", || {
        host_free.聞き終えた回数() >= 2
    })
    .await;
    assert_eq!(外.回数(), 2);
    assert_eq!(
        manager
            .host_resources()
            .expect("読めること")
            .host_free_state,
        Some(protocol::HostFreeState::Fresh),
        "予約の間に取り直した観測は、まだ新しいこと"
    );

    // 70：A の予約が落ちる
    manager.kill(一枚目).expect("落とせること");
    wait_until("予約が0件になる", || manager.reserved_revives() == 0).await;

    // 75：B を頼む
    let refusal = 頼む(&manager, CardId::new())
        .await
        .expect_err("★0件になる前に始めた観測を使い回さず、取り直した値で断ること");
    assert_eq!(外.回数(), 3, "取り直したこと");
    assert!(
        refusal.contains("2500"),
        "取り直した値で数えたこと: {refusal}"
    );
}

#[tokio::test]
async fn 確かめた観測がロックまでに使えなくなったら1周だけやり直す() {
    let manager = common::manager_with(予約の設定());
    manager.set_memory_probe(名乗るメモリ::一定(20_000));
    let 外 = 順に名乗る外側::作る(&[5_000, 6_000], 6_000);
    外側を差す(
        &manager,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    // 1回目に確かめた直後だけ、予約が0件になったときと同じ失効を立てる
    let 呼ばれた = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    {
        let manager_weak = Arc::downgrade(&manager);
        let 呼ばれた = Arc::clone(&呼ばれた);
        manager.確認の後に差し込む(Arc::new(move || {
            if 呼ばれた.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0
                && let Some(manager) = manager_weak.upgrade()
            {
                manager.観測を失効させる();
            }
        }));
    }

    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();
    let card_id = CardId::new();
    頼む(&manager, card_id)
        .await
        .expect("2周目で確かめ直して通ること");
    assert_eq!(
        呼ばれた.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "2周したこと"
    );
    assert_eq!(外.回数(), 2, "2周目は取り直したこと");
    let 行 = sink.matching(mark, "card_id", &card_id.to_string());
    let 判定 = 行
        .iter()
        .find(|line| line["kind"] == "revive_memory")
        .expect("判定の1行が残ること");
    assert_eq!(判定["host_free_mb"], 6_000, "2周目の値で数えたこと: {判定}");
}

#[tokio::test]
async fn 確かめ直しても使えなければ締切で諦める() {
    // **やり直しは回数ではなく締切で打ち切る**（設計§12-3）。確認段階の上限を 1 秒に縮める
    let manager = common::manager_with(予約の設定());
    manager.set_memory_probe(名乗るメモリ::一定(20_000));
    let 外 = 順に名乗る外側::作る(&[], 6_000);
    manager.set_host_free(session_host_core::resources::HostFree::with_wait(
        true,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
        Duration::from_secs(60),
        Duration::from_secs(1),
    ));
    {
        let manager_weak = Arc::downgrade(&manager);
        manager.確認の後に差し込む(Arc::new(move || {
            if let Some(manager) = manager_weak.upgrade() {
                manager.観測を失効させる();
            }
        }));
    }

    let card_id = CardId::new();
    let refusal = 頼む(&manager, card_id)
        .await
        .expect_err("締切までに使える観測が得られなければ断ること");
    assert!(refusal.contains("確かめられなかった"), "{refusal}");
    assert!(
        refusal.contains("予約が入れ替わり続けました"),
        "★取得の失敗とは言い分けること: {refusal}"
    );
    assert!(外.回数() >= 2, "締切まではやり直すこと");
    assert!(manager.get(card_id).is_none());
}

/// 眠ってから答える外側。**待ったかどうか**を時間で見るため。
#[derive(Debug)]
struct 遅い外側(std::sync::atomic::AtomicUsize);

impl session_host_core::resources::HostFreeProbe for 遅い外側 {
    fn read(&self) -> Result<u64, String> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(1_500));
        Ok(6_000)
    }
}

#[tokio::test]
async fn 見積もり0の設定では外側を確かめずに通す() {
    // **歯止めを外す設定。** 使わない値のために待たない
    let manager = common::manager_with(SessionHostConfig {
        revive_estimate_mb: 0,
        ..SessionHostConfig::default()
    });
    暖まったwsl(&manager);
    let 外 = Arc::new(遅い外側(std::sync::atomic::AtomicUsize::new(0)));
    外側を差す(
        &manager,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );

    // **待たないことは回数で確かめる**（口は 1.5 秒眠るので、呼ばれていれば待っている）。
    // 時間の上限で縛ると、擬似 claude の起動を含むので負荷で赤になる
    頼む(&manager, CardId::new()).await.expect("通ること");
    assert_eq!(
        外.0.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "外側を聞きに行かないこと"
    );
}

#[tokio::test]
async fn 判定の1行がログに残る() {
    // **通したときも残す**（設計§6-6）。断られた瞬間だけでなく、通した瞬間の
    // Windows 側の値も後から読めるように
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    外側を差す(&manager, 名乗る外側::作る(6_000));

    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();
    let 通る = CardId::new();
    頼む(&manager, 通る).await.expect("通ること");
    let 行 = sink.matching(mark, "card_id", &通る.to_string());
    let 判定 = 行
        .iter()
        .find(|line| line["kind"] == "revive_memory")
        .unwrap_or_else(|| panic!("通した判定の1行が残ること: {行:?}"));
    assert_eq!(判定["decision"], "pass", "{判定}");
    assert_eq!(判定["limit"], "windows", "{判定}");
    assert_eq!(判定["host_free_mb"], 6_000, "{判定}");
    assert_eq!(判定["effective_mb"], 6_000, "{判定}");
    assert_eq!(判定["available_mb"], 20_000, "{判定}");
    assert_eq!(判定["free_mb"], 400, "{判定}");
    assert!(
        判定.get("waited_ms").is_some(),
        "待った時間が載ること: {判定}"
    );

    // 断ったときも残す
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    外側を差す(&manager, Arc::new(聞けない外側));
    let mark = sink.mark();
    let 断られる = CardId::new();
    頼む(&manager, 断られる).await.expect_err("断られること");
    let 行 = sink.matching(mark, "card_id", &断られる.to_string());
    assert!(
        行.iter()
            .any(|line| line["kind"] == "revive_memory" && line["decision"] == "unconfirmed"),
        "確かめられなかった判定の1行が残ること: {行:?}"
    );
}

/// 読んだ回数を数えるメモリ（設計§12-4）。
#[derive(Debug)]
struct 数えるメモリ {
    available_mb: u64,
    回数: std::sync::atomic::AtomicUsize,
}

impl session_host_core::resources::Probe for 数えるメモリ {
    fn read(&self) -> Option<session_host_core::resources::Memory> {
        self.回数.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Some(session_host_core::resources::Memory {
            total_mb: 24_000,
            available_mb: self.available_mb,
            swap_free_mb: 0,
            free_mb: 400,
        })
    }
}

#[tokio::test]
async fn meminfoは判定ごとに1回だけ読む() {
    // **確かめるのを待った後、ロックの中で読む**（設計§12-4）。待つ前にも読むと、
    // 読むたびに値の変わる口で1枚の判定が2つの値を消費し、最大 65 秒前の値で判定する
    let manager = common::manager_with(実機の設定());
    let メモリ = Arc::new(数えるメモリ {
        available_mb: 20_000,
        回数: std::sync::atomic::AtomicUsize::new(0),
    });
    manager.set_memory_probe(Arc::clone(&メモリ) as Arc<dyn session_host_core::resources::Probe>);
    外側を差す(&manager, 名乗る外側::作る(6_000));

    頼む(&manager, CardId::new()).await.expect("通ること");
    assert_eq!(
        メモリ.回数.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "★1回の判定で読むのは1回だけであること"
    );

    // やり直しが1回入れば、判定も2回なので2回
    let manager = common::manager_with(実機の設定());
    let メモリ = Arc::new(数えるメモリ {
        available_mb: 20_000,
        回数: std::sync::atomic::AtomicUsize::new(0),
    });
    manager.set_memory_probe(Arc::clone(&メモリ) as Arc<dyn session_host_core::resources::Probe>);
    外側を差す(&manager, 名乗る外側::作る(6_000));
    let 呼ばれた = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    {
        let manager_weak = Arc::downgrade(&manager);
        let 呼ばれた = Arc::clone(&呼ばれた);
        manager.確認の後に差し込む(Arc::new(move || {
            if 呼ばれた.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0
                && let Some(manager) = manager_weak.upgrade()
            {
                manager.観測を失効させる();
            }
        }));
    }
    頼む(&manager, CardId::new()).await.expect("通ること");
    assert_eq!(メモリ.回数.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[tokio::test]
async fn 予約が0件になった直後表示が境界より前の観測でfreshと答えない() {
    // 設計§12-1。**判定はその観測を使わないので、表示が fresh と言うと食い違う**
    let manager = common::manager_with(予約の設定());
    manager.set_memory_probe(名乗るメモリ::一定(20_000));
    let 外 = 順に名乗る外側::作る(&[5_000], 2_500);
    外側を差す(
        &manager,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );

    let card_id = CardId::new();
    頼む(&manager, card_id).await.expect("通ること");
    wait_until("予約が立つ", || manager.reserved_revives() == 1).await;
    assert_eq!(
        manager
            .host_resources()
            .expect("読めること")
            .host_free_state,
        Some(protocol::HostFreeState::Fresh),
        "予約の間は、その観測を新しいと言ってよい"
    );

    manager.kill(card_id).expect("落とせること");
    wait_until("予約が0件になる", || manager.reserved_revives() == 0).await;
    let 表示 = manager.host_resources().expect("読めること");
    assert_eq!(
        表示.host_free_state,
        Some(protocol::HostFreeState::Stale),
        "★境界より前の観測を fresh と言わないこと: {表示:?}"
    );
    wait_until("表示が取り直す", || 外.回数() == 2).await;
}
