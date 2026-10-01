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
    let in_flight = manager.begin_revive(card_id, None).expect("印が立つこと");
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
        let in_flight = manager.begin_revive(*card_id, None).expect("印が立つこと");
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

    let 一枚目 = manager
        .begin_revive(card_id, None)
        .expect("1回目は取れること");
    assert!(
        manager.begin_revive(card_id, None).is_none(),
        "同じカードへの2回目が通っています"
    );
    // 別のカードは影響を受けない
    assert!(manager.begin_revive(CardId::new(), None).is_some());

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
        manager.begin_revive(card_id, None).is_none(),
        "立ち上がりきる前に印が外れています"
    );

    立ち上がりきらせる(&manager, &session);

    wait_until("印が外れる", || {
        manager.begin_revive(card_id, None).is_some()
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
    let in_flight = manager.begin_revive(card_id, None).expect("印が立つこと");
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
        let in_flight = manager.begin_revive(*card_id, None).expect("印が立つこと");
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
        let in_flight = manager.begin_revive(*card_id, None).expect("印が立つこと");
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

/// 1回目はすぐ答え、2回目からは眠ってから答える外側。
#[derive(Debug)]
struct 二回目から遅い外側(std::sync::atomic::AtomicUsize);

impl session_host_core::resources::HostFreeProbe for 二回目から遅い外側 {
    fn read(&self) -> Result<u64, String> {
        if self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
            std::thread::sleep(Duration::from_millis(2_500));
        }
        Ok(6_000)
    }
}

#[tokio::test]
async fn やり直した後の取得が締切に間に合わなければ入れ替わりのせいにせず時間切れと言う() {
    // 1周目の観測が判定の前に使えなくなり、やり直した取得が遅くて締切（1秒）を越える。
    // **取得が間に合わなかった**のであって、予約が入れ替わり続けたのではない
    let manager = common::manager_with(予約の設定());
    manager.set_memory_probe(名乗るメモリ::一定(20_000));
    let 外 = Arc::new(二回目から遅い外側(
        std::sync::atomic::AtomicUsize::new(0),
    ));
    manager.set_host_free(session_host_core::resources::HostFree::with_wait(
        true,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
        Duration::from_secs(60),
        Duration::from_secs(1),
    ));
    {
        let manager_weak = Arc::downgrade(&manager);
        let 一度だけ = Arc::new(std::sync::atomic::AtomicBool::new(false));
        manager.確認の後に差し込む(Arc::new(move || {
            if 一度だけ.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            if let Some(manager) = manager_weak.upgrade() {
                manager.観測を失効させる();
            }
        }));
    }

    let card_id = CardId::new();
    let refusal = 頼む(&manager, card_id)
        .await
        .expect_err("締切までに取得が終わらなければ断ること");
    assert!(refusal.contains("確かめられなかった"), "{refusal}");
    assert!(
        !refusal.contains("入れ替わり続けました"),
        "★取得の時間切れを、予約の入れ替わりのせいにしないこと: {refusal}"
    );
    assert!(refusal.contains("答えが返りませんでした"), "{refusal}");
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

#[tokio::test]
async fn 予約を引いても枚数が変わらなければwindows側の空きで断り両方の数を出す() {
    // 実装レビュー Fable 1。実機の数（1枚 780・余白 2,048）で、1枚目を 3,480 で通すと
    // 見込みは 2,700 になる。2枚目のときの Windows 側は 2,800——予約が無くても
    // (2,800 − 2,048) ÷ 780 = 0 枚なので、**決めたのは Windows 側**である
    let manager = common::manager_with(実機の設定());
    manager.set_memory_probe(名乗るメモリ::一定(20_000));
    let 外 = 順に名乗る外側::作る(&[3_480], 3_480);
    let host_free = 外側を差す(
        &manager,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );

    頼む(&manager, CardId::new())
        .await
        .expect("1枚目は通ること");
    wait_until("予約が立つ", || manager.reserved_revives() == 1).await;
    host_free.覚えさせる(2_800, std::time::Instant::now());

    let refusal = 頼む(&manager, CardId::new())
        .await
        .expect_err("2枚目は断られること");
    assert!(
        refusal.contains("使える空き 2700 MB＝Windows 側の空き 2800 MB"),
        "★予約を引いた値と Windows 側の空きの両方を出していない: {refusal}"
    );
    assert!(
        !refusal.contains("1分ほど待って"),
        "★予約が枚数を変えていないのに、待てば通ると言っている: {refusal}"
    );
}

// ---------------------------------------------------------------------------
// 確かめを待っている間に外したカードは起こさない（実装レビュー Astra 1）
// ---------------------------------------------------------------------------
//
// 確かめ（最大 65 秒）の間にカードを一覧から外しても取り消されず、確かめが済んだ後に
// **誰にも見えないプロセスを起こしていた**（外したカードの報告はサーバが捨てる）。

/// 切り離して頼む（確かめの途中で外すため、待たずに戻る）。
fn 切り離して頼む(
    manager: &Arc<SessionManager>,
    card_id: CardId,
) -> tokio::task::JoinHandle<Result<(), String>> {
    let in_flight = manager.begin_revive(card_id, None).expect("印が立つこと");
    let manager = Arc::clone(manager);
    tokio::spawn(async move {
        manager
            .revive(
                in_flight,
                &common::work_dir(),
                None,
                ClaudeSessionId(uuid::Uuid::new_v4()),
            )
            .await
            .map(|_| ())
            .map_err(|err| err.to_string())
    })
}

#[tokio::test]
async fn 確かめを待っている間に外したカードは確かめが済んでも起こさない() {
    // 「確かめ待ち → 外す → 取得成功」の順。**実体はまだ無い**（サーバから見て接続断の
    // カードを、PC が起こし直している途中）
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    let 外 = Arc::new(common::止める外側::default());
    let _門 = common::門を開けて去る(Arc::clone(&外));
    let host_free = 外側を差す(
        &manager,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    let card_id = CardId::new();
    let mut 起こし直し = 切り離して頼む(&manager, card_id);
    外.聞かれるまで待つ(0).await;

    manager
        .archive(card_id)
        .expect("★起こし直しを取り下げただけ（実体はまだ無い）なのに、外せないと断っている");

    // **確かめが済むのを待たずにやめる。** 席を握ったまま 65 秒待つと、ほかのカードの
    // 起こし直しまで止まる
    let 結果 = timeout(Duration::from_secs(10), &mut 起こし直し)
        .await
        .expect("★外されたのに、確かめが済むまで席を握って待っている")
        .expect("落ちないこと");
    let 断り = 結果.expect_err("起こさずに断ること");
    assert!(断り.contains("一覧から外された"), "{断り}");

    外.開ける();
    wait_until("取得が済む", || host_free.聞き終えた回数() >= 1).await;
    tokio::time::sleep(QUIET).await;
    assert!(
        manager.get(card_id).is_none(),
        "★外したカードの実体を起こしている（画面に出ないままメモリを食う）"
    );
    assert_eq!(manager.reserved_revives(), 0, "予約を残していない");
    // 外したカードへ後から届いた頼みは、「復旧中」（競合）ではなく外したと断る（実装レビュー
    // 第2回 Astra 1）。外していないカードの印が下りることは `終わったら印は外れる` が見ている
    let in_flight = manager
        .begin_revive(card_id, None)
        .expect("外したカードへの頼みを、競合（復旧中）として断らないこと");
    let 断り = manager
        .revive(
            in_flight,
            &common::work_dir(),
            None,
            ClaudeSessionId(uuid::Uuid::new_v4()),
        )
        .await
        .expect_err("起こさずに断ること")
        .to_string();
    assert!(断り.contains("一覧から外された"), "{断り}");
}

#[tokio::test]
async fn 確かめた直後に外したカードは起こさない() {
    // 確かめが済んでから起こすまでの窓。**見てから起こすまでの間に外されると、外す側の
    // 畳みが空振りした直後に実体が起きる**——起こす側は、見て起こし終えるまで札を握る
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    外側を差す(
        &manager,
        common::止める外側::開いたまま() as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    let card_id = CardId::new();
    {
        let manager_weak = Arc::downgrade(&manager);
        manager.確認の後に差し込む(Arc::new(move || {
            if let Some(manager) = manager_weak.upgrade() {
                manager.forget(card_id);
            }
        }));
    }

    let 結果 = 頼む(&manager, card_id).await;
    assert!(
        manager.get(card_id).is_none(),
        "★確かめた直後に外したカードの実体を起こしている"
    );
    let 断り = 結果.expect_err("起こさずに断ること");
    assert!(断り.contains("一覧から外された"), "{断り}");
    assert_eq!(manager.reserved_revives(), 0, "通した予約を返していること");
}

#[tokio::test]
async fn 抜け殻を確かめの途中で外すと抜け殻も畳み起こし直しも取り下げる() {
    // 実体（抜け殻）がある側。サーバから見て在るカードは `archive` が届く
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    let 外 = common::止める外側::開いたまま();
    let _門 = common::門を開けて去る(Arc::clone(&外));
    let host_free = 外側を差す(
        &manager,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    let card_id = CardId::new();
    頼む(&manager, card_id).await.expect("1回目は起こせること");
    manager.kill(card_id).expect("寝かせられること");
    wait_until("予約が0件になる", || manager.reserved_revives() == 0).await;
    assert!(manager.get(card_id).is_some(), "抜け殻が残っていること");

    // 2回目は取り直させて、確かめの途中で止める
    外.閉める();
    host_free.覚えさせる(
        6_000,
        std::time::Instant::now() - Duration::from_secs(3_600),
    );
    let 聞く前 = 外.聞かれた();
    let mut events = manager.subscribe_events();
    let 起こし直し = 切り離して頼む(&manager, card_id);
    外.聞かれるまで待つ(聞く前).await;

    manager.archive(card_id).expect("外せること");
    let 結果 = timeout(Duration::from_secs(10), 起こし直し)
        .await
        .expect("確かめが済むのを待たずにやめること")
        .expect("落ちないこと");
    assert!(結果.is_err(), "起こさずに断ること");
    外.開ける();
    tokio::time::sleep(QUIET).await;
    assert!(
        manager.get(card_id).is_none(),
        "★外したのに、抜け殻か新しい実体が残っている"
    );
    let mut 消えたと配った = false;
    while let Ok(message) = events.try_recv() {
        消えたと配った |=
            matches!(message, ServerMessage::SessionRemoved { card_id: id } if id == card_id);
    }
    assert!(消えたと配った, "外したことを配っていない");
}

#[tokio::test]
async fn 何も持っていないカードを忘れても断らず外すときだけ見つからないと言う() {
    // サーバは「この PC が持っているか」を知らないまま記録の側だけで外したことを知らせて
    // くる。**無いのは普通のこと**なので黙る。`archive` は従来どおり断る
    let manager = common::manager_with(実機の設定());
    let card_id = CardId::new();
    assert!(
        !manager.forget(card_id),
        "何もしていないのに片付けたと答えている"
    );
    assert!(
        matches!(
            manager.archive(card_id),
            Err(session_host_core::session::SessionError::NotFound(_))
        ),
        "無いカードを外せたことにしている"
    );
}

// ---------------------------------------------------------------------------
// 実装レビュー第2回（Astra 1・Fable 3〜5）
// ---------------------------------------------------------------------------

/// 外す知らせが、起こし直しの頼みより**先に**届く順（実装レビュー第2回 Astra 1）。
///
/// サーバは起こし直しの材料を記録から引いてから頼みを送る。その間に別の画面でカードを
/// 外すと、外した知らせ（`Forget`）が先に PC へ届く。**外す側には下ろす札がまだ無く**、
/// 後から届いた頼みが新しい札を作って、誰にも見えない実体を起こしていた。
#[tokio::test]
async fn 外した知らせが起こし直しの頼みより先に届いても起こさない() {
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    let 外 = common::止める外側::開いたまま();
    外側を差す(
        &manager,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    let card_id = CardId::new();

    assert!(
        !manager.forget(card_id),
        "まだ何も持っていないので、片付けたものは無い"
    );
    let 断り = 頼む(&manager, card_id)
        .await
        .expect_err("★外したカードへ後から届いた頼みで、実体を起こしている");
    assert!(断り.contains("一覧から外された"), "{断り}");
    assert!(
        manager.get(card_id).is_none(),
        "外したカードの実体が無いこと"
    );
    assert_eq!(
        外.聞かれた(),
        0,
        "外したカードのために Windows 側を聞きに行かないこと"
    );
    assert_eq!(manager.reserved_revives(), 0, "予約を取っていないこと");

    // **印は1回で消えない。** 同じ頼みが遅れてもう1通届いても起こさない
    let 断り = 頼む(&manager, card_id).await.expect_err("2通目も断ること");
    assert!(断り.contains("一覧から外された"), "{断り}");
}

#[tokio::test]
async fn 抜け殻を外した後に遅れて届いた起こし直しの頼みも起こさない() {
    // `archive` の側（サーバから見て実体があるカード）。外した後に届く頼みを断る
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    外側を差す(
        &manager,
        common::止める外側::開いたまま() as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    let card_id = CardId::new();
    頼む(&manager, card_id).await.expect("1回目は起こせること");
    manager.kill(card_id).expect("寝かせられること");
    wait_until("予約が0件になる", || manager.reserved_revives() == 0).await;

    manager.archive(card_id).expect("外せること");
    let 断り = 頼む(&manager, card_id)
        .await
        .expect_err("★外したカードへ遅れて届いた頼みで、実体を起こしている");
    assert!(断り.contains("一覧から外された"), "{断り}");
    assert!(
        manager.get(card_id).is_none(),
        "外したカードの実体が無いこと"
    );
}

#[tokio::test]
async fn 外せなかったカードには印を残さず後から起こせる() {
    // `archive` が札も実体も見つけられなければ断り、記録は一覧に残る。**そこで印を立てると、
    // 残ったカードを二度と起こせなくなる**
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    外側を差す(
        &manager,
        common::止める外側::開いたまま() as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    let card_id = CardId::new();
    assert!(
        matches!(
            manager.archive(card_id),
            Err(session_host_core::session::SessionError::NotFound(_))
        ),
        "何も無いカードは外せないと断ること"
    );
    頼む(&manager, card_id)
        .await
        .expect("★外せなかった（一覧に残った）カードを、外したものとして断っている");
}

/// 起こしている最中に外す（実装レビュー第2回 Fable 5）。
///
/// 以前は起こす側が札のロックを握ったまま実体を作り、外す側はそれが済むまで std の
/// `Mutex` で**実行時のワーカーごと止まって**待っていた。いまは外す側は待たずに戻り、
/// 作り終えた直後に起こす側が自分で畳む。
#[tokio::test]
async fn 起こしている最中に外しても外す側は待たされず起こした実体は畳まれる() {
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    外側を差す(
        &manager,
        common::止める外側::開いたまま() as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    let card_id = CardId::new();
    let mut events = manager.subscribe_events();
    // 起こす直前（起こし始めの印を立てた後）に、**別のスレッドで**外す。同じスレッドで外すと、
    // 札のロックを握ったまま作る形では二重に取って固まり、赤ではなく止まって見える
    let 外した結果: Arc<std::sync::Mutex<Option<Result<(), String>>>> = Arc::default();
    {
        let manager_weak = Arc::downgrade(&manager);
        let 外した結果 = Arc::clone(&外した結果);
        manager.起こす直前に差し込む(Arc::new(move || {
            let Some(manager) = manager_weak.upgrade() else {
                return;
            };
            let (送る, 受ける) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = 送る.send(manager.archive(card_id).map_err(|err| err.to_string()));
            });
            // 外す側が戻るのを待つ。**起こし終わるまで待たされていれば、ここで時間切れになる**
            let 結果 = 受ける
                .recv_timeout(Duration::from_secs(2))
                .unwrap_or_else(|_| Err("時間切れ".to_string()));
            *外した結果.lock().expect("ロックが壊れていない") = Some(結果);
        }));
    }

    let 結果 = 頼む(&manager, card_id).await;
    assert_eq!(
        外した結果.lock().expect("ロックが壊れていない").clone(),
        Some(Ok(())),
        "★外す側が、起こし終わるまで待たされている（または外せなかった）"
    );
    let 断り = 結果.expect_err("外されたのだから断ること");
    assert!(断り.contains("一覧から外された"), "{断り}");
    assert!(
        manager.get(card_id).is_none(),
        "★起こしている最中に外したカードの実体が残っている（誰にも見えないままメモリを食う）"
    );
    wait_until("予約が0件になる", || manager.reserved_revives() == 0).await;
    let mut 消えたと配った = 0;
    while let Ok(message) = events.try_recv() {
        if matches!(message, ServerMessage::SessionRemoved { card_id: id } if id == card_id) {
            消えたと配った += 1;
        }
    }
    assert_eq!(消えたと配った, 1, "外したことを1回だけ配ること");
}

/// ログを集める（`tracing` の出力先を差し替える。**同じスレッドで走ったぶんだけ**拾う）。
#[derive(Clone, Default)]
struct 行の溜め(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for 行の溜め {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("ロックが壊れていない")
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for 行の溜め {
    type Writer = Self;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn ログを集める<T>(body: impl FnOnce() -> T) -> (T, String) {
    let 溜め = 行の溜め::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(溜め.clone())
        .with_ansi(false)
        .with_max_level(tracing::Level::INFO)
        .finish();
    let out = tracing::subscriber::with_default(subscriber, body);
    let text = String::from_utf8_lossy(&溜め.0.lock().expect("ロックが壊れていない")).into_owned();
    (out, text)
}

#[tokio::test]
async fn 起こし終えた後に外すと取り下げたとは記録しない() {
    // 実装レビュー第2回 Fable 3。札は立ち上がりきるまで表に残るので、起こし終えた後に外しても
    // 札は下ろせる。それを「進んでいた起こし直しを取り下げます」と書くと、取り下げの行
    // （`revive_withdrawn`）が続かないのに取り下げたと読める。**ログから原因を追う PJT なので、
    // 起きたことと違う行を残さない**
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    外側を差す(
        &manager,
        common::止める外側::開いたまま() as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    let card_id = CardId::new();
    // 擬似 claude はフックを送らないので、起こした後も立ち上がりきらない（札が表に残る）
    頼む(&manager, card_id).await.expect("起こせること");

    let (外した, 行) = ログを集める(|| manager.archive(card_id));
    外した.expect("外せること");
    assert!(
        !行.contains("取り下げます"),
        "★起こし終えていたのに、起こし直しを取り下げたと記録している: {行}"
    );
    assert!(行.contains("起こし直しは済んでいた"), "{行}");
    assert!(
        manager.get(card_id).is_none(),
        "起こした実体を畳んでいること"
    );
}

#[tokio::test]
async fn wslでない機械で予約を引いても枚数が変わらなければ両方の数を出す() {
    // 実装レビュー第2回 Fable 4。1枚目を 3,500 で通すと見込みは 2,500 になる。2枚目のときの
    // 空きは 2,600——予約が無くても (2,600 − 2,000) ÷ 1,000 = 0 枚なので、決めたのは WSL の中の
    // 空きである。**予約を引いた 2,500 を「空き」と呼ぶと、画面の「空き」と数が合わない**
    let manager = common::manager_with(床の設定());
    manager.set_host_free(session_host_core::resources::HostFree::new(
        false,
        common::止める外側::開いたまま(),
        Duration::from_secs(60),
    ));
    manager.set_memory_probe(名乗るメモリ::順に(&[3_500], 2_600));
    頼む(&manager, CardId::new())
        .await
        .expect("1枚目は通ること");
    wait_until("予約が立つ", || manager.reserved_revives() == 1).await;

    let 断り = 頼む(&manager, CardId::new())
        .await
        .expect_err("2枚目は断られること");
    assert!(
        断り.contains(
            "使える空き 2500 MB＝空き 2600 MB から、起こしている途中の 1 枚ぶんを差し引いた値"
        ),
        "★予約を引いた値を、引く前の空きと区別せずに「空き」と呼んでいる: {断り}"
    );
    assert!(
        !断り.contains("1分ほど待って"),
        "予約が枚数を変えていないのに、待てば通ると言っている: {断り}"
    );

    // **予約が無いときの文面と数は以前のまま**
    let manager = common::manager_with(床の設定());
    manager.set_host_free(session_host_core::resources::HostFree::new(
        false,
        common::止める外側::開いたまま(),
        Duration::from_secs(60),
    ));
    manager.set_memory_probe(名乗るメモリ::一定(2_600));
    let 断り = 頼む(&manager, CardId::new())
        .await
        .expect_err("断られること");
    assert!(
        断り.contains("（空き 2600 MB／1枚あたり 1000 MB ＋ 残す余白 2000 MB）"),
        "{断り}"
    );
}

#[tokio::test]
async fn 外す前の起こし直しの札が残っている間に届いた頼みも競合ではなく外したと断る() {
    // 実装レビュー第2回 Astra 1。外す前の起こし直しの札は、立ち上がりきるまで表に残る。
    // **外した印を札より後に見ると、その間に届いた頼みが競合（「復旧中」）に化け**、
    // 待てば起きると読まれる（`busy: Some(true)`）
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    外側を差す(
        &manager,
        common::止める外側::開いたまま() as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    let card_id = CardId::new();
    // 擬似 claude はフックを送らないので、起こした後も札が表に残る
    頼む(&manager, card_id).await.expect("起こせること");
    manager.archive(card_id).expect("外せること");

    let in_flight = manager
        .begin_revive(card_id, None)
        .expect("★外したカードへの頼みを、競合（復旧中）として断っている");
    let 断り = manager
        .revive(
            in_flight,
            &common::work_dir(),
            None,
            ClaudeSessionId(uuid::Uuid::new_v4()),
        )
        .await
        .expect_err("起こさずに断ること")
        .to_string();
    assert!(断り.contains("一覧から外された"), "{断り}");
    assert!(
        manager.get(card_id).is_none(),
        "外したカードの実体が無いこと"
    );
}

// ---------------------------------------------------------------------------
// 実装レビュー第3回（Astra 1・2）
// ---------------------------------------------------------------------------

/// 終了済みの実体が残るカードを、Windows 側の確かめで止めて起こし直させる。返すのは
/// 寝かせた古い実体と、切り離した起こし直しと、落ちたとき門を開ける札。
async fn 寝かせて確かめ中にする(
    manager: &Arc<SessionManager>,
    card_id: CardId,
) -> (
    Arc<common::止める外側>,
    Arc<session_host_core::resources::HostFree>,
    Arc<Session>,
    tokio::task::JoinHandle<Result<(), String>>,
    common::門を開けて去る,
) {
    let 外 = common::止める外側::開いたまま();
    let host_free = 外側を差す(
        manager,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    頼む(manager, card_id).await.expect("1回目は起こせること");
    manager.kill(card_id).expect("寝かせられること");
    wait_until("予約が0件になる", || manager.reserved_revives() == 0).await;
    let 古い実体 = manager.get(card_id).expect("抜け殻が残っていること");
    wait_until("寝る", || {
        matches!(古い実体.status(), SessionStatus::Ended { .. })
    })
    .await;

    // 2回目は取り直させて、確かめの途中で止める
    外.閉める();
    let 門 = common::門を開けて去る(Arc::clone(&外));
    host_free.覚えさせる(
        6_000,
        std::time::Instant::now() - Duration::from_secs(3_600),
    );
    let 聞く前 = 外.聞かれた();
    let 起こし直し = 切り離して頼む(manager, card_id);
    外.聞かれるまで待つ(聞く前).await;
    (外, host_free, 古い実体, 起こし直し, 門)
}

#[tokio::test]
async fn 確かめを待っている間に終了を頼むと確かめが済んでも起こさず後から起こし直せる() {
    // 実装レビュー第3回 Astra 2。「確かめ待ち → 終了の頼み → 取得成功」の順。以前の `kill` は
    // 古い実体（もう止まっている）だけを止めて札を下ろさなかったので、**確かめが済むと新しい
    // プロセスが起きた**——終了を頼んだ後に起動していた
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    let card_id = CardId::new();
    let (外, host_free, 古い実体, 起こし直し, _門) =
        寝かせて確かめ中にする(&manager, card_id).await;

    manager
        .kill(card_id)
        .expect("寝ている実体があるので、終了の頼みは通ること");
    let 結果 = timeout(Duration::from_secs(10), 起こし直し)
        .await
        .expect("★終了を頼まれたのに、確かめが済むまで席を握って待っている")
        .expect("落ちないこと");
    let 断り = 結果.expect_err("★終了を頼まれたのに、起こし直しを続けている");
    assert!(断り.contains("終了を頼まれた"), "{断り}");

    外.開ける();
    wait_until("取得が済む", || host_free.聞き終えた回数() >= 1).await;
    tokio::time::sleep(QUIET).await;
    let いまの実体 = manager.get(card_id).expect("カードの実体は残っていること");
    assert!(
        Arc::ptr_eq(&いまの実体, &古い実体),
        "★終了を頼んだ後に、新しいプロセスを起こしている"
    );
    assert!(
        matches!(いまの実体.status(), SessionStatus::Ended { .. }),
        "寝たままであること"
    );
    assert_eq!(manager.reserved_revives(), 0, "予約を残していない");

    // **外したときと違い、印は残さない。** 後から頼めば起こし直せる
    頼む(&manager, card_id)
        .await
        .expect("★終了を頼んだだけのカードを、外したカードのように断っている");
}

#[tokio::test]
async fn 起こしている最中に終了を頼むと断らずに起こした実体を止めてカードは残る() {
    // 起こしている最中は、古い実体を畳み終え、新しい実体はまだ表に無い。**実体だけを見ると
    // 「見つかりません」と断り**、起こし終えた実体が動き続けていた
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    外側を差す(
        &manager,
        common::止める外側::開いたまま() as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    let card_id = CardId::new();
    let 頼んだ結果: Arc<std::sync::Mutex<Option<Result<(), String>>>> = Arc::default();
    {
        let manager_weak = Arc::downgrade(&manager);
        let 頼んだ結果 = Arc::clone(&頼んだ結果);
        // **1回目の起こし直しにだけ差し込む。** 後で起こし直せることを確かめる2回目まで止める
        let 済んだ = Arc::new(std::sync::atomic::AtomicBool::new(false));
        manager.起こす直前に差し込む(Arc::new(move || {
            if 済んだ.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            let Some(manager) = manager_weak.upgrade() else {
                return;
            };
            let (送る, 受ける) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = 送る.send(manager.kill(card_id).map_err(|err| err.to_string()));
            });
            let 結果 = 受ける
                .recv_timeout(Duration::from_secs(2))
                .unwrap_or_else(|_| Err("時間切れ".to_string()));
            *頼んだ結果.lock().expect("ロックが壊れていない") = Some(結果);
        }));
    }

    let 結果 = 頼む(&manager, card_id).await;
    assert_eq!(
        頼んだ結果.lock().expect("ロックが壊れていない").clone(),
        Some(Ok(())),
        "★起こしている最中の終了の頼みを、見つからないと断っている"
    );
    let 断り = 結果.expect_err("終了を頼まれたのだから断ること");
    assert!(断り.contains("終了を頼まれた"), "{断り}");
    let 実体 = manager
        .get(card_id)
        .expect("★起こした実体を畳んでいる（止めるだけでカードは残す）");
    wait_until("起こした実体が止まる", || {
        matches!(実体.status(), SessionStatus::Ended { .. })
    })
    .await;
    wait_until("予約が0件になる", || manager.reserved_revives() == 0).await;
    頼む(&manager, card_id)
        .await
        .expect("★終了を頼んだだけのカードを、後から起こし直せない");
}

#[tokio::test]
async fn 終了の頼みの後に外されたら外した側の断りになり逆には戻らない() {
    // 2つの理由で札が下ろされたら、強いほう（外した）を残す
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    let card_id = CardId::new();
    let (_外, _host_free, _古い実体, 起こし直し, _門) =
        寝かせて確かめ中にする(&manager, card_id).await;

    // 起こす側がまだ断りを返していないうちに、両方を下ろす
    manager.kill(card_id).expect("終了の頼みは通ること");
    assert!(manager.forget(card_id), "片付けたものがあること");
    manager.stop_for_removal(card_id);
    let 断り = timeout(Duration::from_secs(10), 起こし直し)
        .await
        .expect("待たずにやめること")
        .expect("落ちないこと")
        .expect_err("起こさずに断ること");
    assert!(
        断り.contains("一覧から外された"),
        "★外した後に届いた弱い理由（終了・外し始め）で、外した断りを上書きしている: {断り}"
    );
}

#[tokio::test]
async fn 外し始めの取り下げは印を残さず記録を外せなければ後から起こし直せる() {
    // 実装レビュー第3回 Astra 1。記録の側で外し始めたら、まず起こし直しを止める。**印は
    // 記録を外せた後（`forget`）にしか立てない**——記録を外せなければカードは一覧に残るので、
    // ここで印を立てると二度と起こせなくなる
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    let 外 = Arc::new(common::止める外側::default());
    let _門 = common::門を開けて去る(Arc::clone(&外));
    let host_free = 外側を差す(
        &manager,
        Arc::clone(&外) as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    let card_id = CardId::new();
    let 起こし直し = 切り離して頼む(&manager, card_id);
    外.聞かれるまで待つ(0).await;

    assert!(
        manager.stop_for_removal(card_id),
        "進んでいた起こし直しを止めたこと"
    );
    let 断り = timeout(Duration::from_secs(10), 起こし直し)
        .await
        .expect("確かめが済むのを待たずにやめること")
        .expect("落ちないこと")
        .expect_err("起こさずに断ること");
    外.開ける();
    wait_until("取得が済む", || host_free.聞き終えた回数() >= 1).await;
    tokio::time::sleep(QUIET).await;
    assert!(
        manager.get(card_id).is_none(),
        "★止めた起こし直しを、確かめが済んだ後に起こしている"
    );

    // 記録を外せなかった（`forget` が来ない）。**取り下げた古い頼みは戻らないが、新しい頼みは通る**
    頼む(&manager, card_id)
        .await
        .expect("★外し始めただけのカードを、外したカードとして断っている");
    assert!(
        断り.contains("一覧から外す操作が始まった"),
        "外し終える前の取り下げを、外したと言っていない: {断り}"
    );
    // 外し終えたら（`forget`）、以後の頼みは断る
    manager.forget(card_id);
    let 断り = 頼む(&manager, card_id)
        .await
        .expect_err("外し終えたカードへの頼みは断ること");
    assert!(断り.contains("一覧から外された"), "{断り}");
}

#[tokio::test]
async fn 何も持っていないカードを外し始めても断らない() {
    let manager = common::manager_with(実機の設定());
    assert!(
        !manager.stop_for_removal(CardId::new()),
        "何もしていないのに止めたと答えている"
    );
    assert!(
        matches!(
            manager.kill(CardId::new()),
            Err(session_host_core::session::SessionError::NotFound(_))
        ),
        "終了の頼みは従来どおり、何も無ければ見つからないと断る"
    );
}

#[tokio::test]
async fn 判定の断りと終了の取り下げが同時に用意できたら取り下げを返す() {
    // 実装レビュー第5回 Astra 3。確かめた直後に終了の頼みが届き、その周の判定はメモリ不足で
    // 断る形。**同じ poll の中で判定の失敗と取り下げが揃う**ので、`select!` がどちらの腕から
    // 見ても判定の腕が選ばれる。以前は通常の断りを返し、終了の待ちは取り下げを受け取れなかった
    // （実体の無いカードでは `Ended` も来ないので、CLI は時間切れまで待った）
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    // (1,792 − 2,048) で1枚も入らない
    外側を差す(&manager, 名乗る外側::作る(1_792));
    let card_id = CardId::new();
    {
        let manager_weak = Arc::downgrade(&manager);
        manager.確認の後に差し込む(Arc::new(move || {
            if let Some(manager) = manager_weak.upgrade() {
                manager
                    .kill(card_id)
                    .expect("起こし直しの札があるので、終了の頼みは通ること");
            }
        }));
    }

    let in_flight = manager.begin_revive(card_id, None).expect("印が立つこと");
    let 断り = manager
        .revive(
            in_flight,
            &common::work_dir(),
            None,
            ClaudeSessionId(uuid::Uuid::new_v4()),
        )
        .await
        .expect_err("起こさずに断ること");
    assert_eq!(
        断り.withdrawal(),
        Some(protocol::ws::Withdrawal::Kill),
        "★終了で取り下げたのに、判定の断り（{断り}）を返している"
    );
    assert!(manager.get(card_id).is_none(), "実体を作らないこと");
    assert_eq!(manager.reserved_revives(), 0, "予約を残していない");
}

// ---------------------------------------------------------------------------
// 実装レビュー第6回（Astra 1・2・3）：頼みの番号と、その答え
// ---------------------------------------------------------------------------

use protocol::{a2s::KillOutcome, ws::OpId};
use session_host_core::events::KillAnswered;

/// 番号付きの答えを1件、待たずに取る（答えは頼みの中で同期に出るか、後から出る）。
fn 答えを取る(
    answers: &mut tokio::sync::broadcast::Receiver<KillAnswered>,
) -> Option<KillAnswered> {
    answers.try_recv().ok()
}

/// 番号付きの答えを1件、上限まで待つ。
async fn 答えを待つ(
    answers: &mut tokio::sync::broadcast::Receiver<KillAnswered>,
    what: &str,
) -> KillAnswered {
    timeout(common::TIMEOUT, answers.recv())
        .await
        .unwrap_or_else(|_| panic!("{what}の答えが届かない"))
        .expect("答えの配信が閉じていない")
}

#[tokio::test]
async fn 起こし終えた札が残っている間に実体が終わってから終了を頼んでも答えが返る() {
    // 実装レビュー第6回 Astra 2。起こし終えた札は、見張りが立ち上がりを見届けるまで（最大
    // `REVIVE_STEP`＝100ms ごとに見る）表に残る。その間に実体が終わってから終了を頼むと、以前は
    // **札が在るだけで取り下げたことにして**何も配らなかった——取り下げの断りも `Ended` の配り直しも
    // 来ず、CLI は時間切れになった。
    //
    // **順を固定する。** 試験は current_thread で動くので、終わった知らせを受けてから頼むまでに
    // `await` を挟まなければ、見張りは割り込めない。見張りの方が先に起きて札を下ろしていたら、
    // その回はやり直す（札が在る形を確かめてから頼む）
    let manager = common::manager();
    for _ in 0..10 {
        let card_id = CardId::new();
        let session = revive(&manager, card_id, ClaudeSessionId(uuid::Uuid::new_v4())).await;
        let mut bus = manager.subscribe_events();
        session.kill();
        timeout(common::TIMEOUT, async {
            loop {
                if let Ok(ServerMessage::SessionUpsert { session }) = bus.recv().await
                    && session.card_id == card_id
                    && matches!(session.status, SessionStatus::Ended { .. })
                {
                    return;
                }
            }
        })
        .await
        .expect("実体が終わったことが配られること");

        // **札がまだ残っているか。** 残っていれば競合で断られる（番号を束ねるだけで害は無い）
        if let Some(取れた) = manager.begin_revive(card_id, None) {
            drop(取れた);
            continue;
        }
        let mut answers = manager.subscribe_kill_answers();
        let mut bus = manager.subscribe_events();

        // 番号の無い頼み（画面・古い CLI）：終わっていた実体のいまの姿を配り直す
        manager
            .kill(card_id)
            .expect("終わった実体があるので、終了の頼みは通ること");
        assert!(
            matches!(
                bus.try_recv(),
                Ok(ServerMessage::SessionUpsert { session })
                    if session.card_id == card_id
                        && matches!(session.status, SessionStatus::Ended { .. })
            ),
            "★起こし終えた札が残っている間に、終わっていた実体への終了に何も配っていない"
        );

        // 番号付きの頼み：その場で「既に終わっていた」と答える
        let op = OpId::new();
        manager.kill_answering(card_id, op);
        assert_eq!(
            答えを取る(&mut answers),
            Some(KillAnswered {
                card_id,
                op,
                outcome: KillOutcome::AlreadyEnded,
            }),
            "★起こし終えた札が残っている間に、終わっていた実体への番号付きの終了に答えていない"
        );
        assert_eq!(答えを取る(&mut answers), None, "答えは1回だけ");
        return;
    }
    panic!("10回とも、見張りが札を下ろす前に頼めなかった（形を作れていない）");
}

#[tokio::test]
async fn 番号付きの終了は何をしたかを番号付きで1回だけ答える() {
    // 実装レビュー第6回 Astra 1。待つ側（CLI）は番号でしか満ちないので、PC は頼み1つにつき必ず
    // 1回答える。**何も無かったことも答える**（成否はサーバが記録と合わせて決める）
    let manager = common::manager();
    let mut answers = manager.subscribe_kill_answers();

    // 何も無い
    let 無い = CardId::new();
    let op = OpId::new();
    manager.kill_answering(無い, op);
    assert_eq!(
        答えを取る(&mut answers),
        Some(KillAnswered {
            card_id: 無い,
            op,
            outcome: KillOutcome::Nothing,
        })
    );

    // 生きた実体：**止まるのを見届けてから**答える（頼んだ瞬間には答えない）
    let card_id = CardId::new();
    let session = revive(&manager, card_id, ClaudeSessionId(uuid::Uuid::new_v4())).await;
    立ち上がりきらせる(&manager, &session);
    let op = OpId::new();
    manager.kill_answering(card_id, op);
    assert_eq!(
        答えを取る(&mut answers),
        None,
        "★止まるのを見届ける前に答えている"
    );
    assert_eq!(
        答えを待つ(&mut answers, "生きた実体の終了").await,
        KillAnswered {
            card_id,
            op,
            outcome: KillOutcome::Stopped,
        }
    );
    assert!(matches!(session.status(), SessionStatus::Ended { .. }));

    // 既に終わった実体：その場で答える。2つの頼みには、それぞれの番号で答える
    let (一つ目, 二つ目) = (OpId::new(), OpId::new());
    manager.kill_answering(card_id, 一つ目);
    manager.kill_answering(card_id, 二つ目);
    assert_eq!(
        [答えを取る(&mut answers), 答えを取る(&mut answers)],
        [
            Some(KillAnswered {
                card_id,
                op: 一つ目,
                outcome: KillOutcome::AlreadyEnded,
            }),
            Some(KillAnswered {
                card_id,
                op: 二つ目,
                outcome: KillOutcome::AlreadyEnded,
            }),
        ]
    );
    tokio::time::sleep(QUIET).await;
    assert_eq!(答えを取る(&mut answers), None, "答えは頼み1つにつき1回だけ");
}

#[tokio::test]
async fn 番号付きの終了の直後に外されて実体が解放されても止まったと答える() {
    // 実装レビュー第7回 Astra 2。終了の頼みの番号は実体（`Session`）の中に預けていた。終了を
    // 頼んだ直後に外されると、表も合流タスクも実体を手放す。終わりを見届ける見張りは実体を弱く
    // 握っているので引き直せず、**預かった番号ごと消えて、プロセスは止まったのに誰も答えなかった**。
    //
    // **この試験は実体への強い参照を持たない。** 持つと見張りが引き直せてしまい、壊れ方が隠れる
    // （第6回の試験はどれも実体を握っていた）。順は門で固定する：実体が解放されたのを確かめて
    // から、見張りに終わりを見届けさせる
    let manager = common::manager();
    let 門 = manager.終わりの見届けを止める();
    let mut answers = manager.subscribe_kill_answers();
    let (card_id, 弱い) = {
        let session = manager.spawn(&common::work_dir()).expect("起こせること");
        (session.card_id, Arc::downgrade(&session))
    };
    let op = OpId::new();
    manager.kill_answering(card_id, op);
    manager
        .archive(card_id)
        .expect("生きた実体なので外せること");
    // 表は外した時点で、合流タスクはプロセスが終わって読み口が閉じた時点で手放す
    wait_until("実体への強い参照が全部消える", || {
        弱い.strong_count() == 0
    })
    .await;
    assert_eq!(
        答えを取る(&mut answers),
        None,
        "門を開ける前に答えている（門が見張りを止めていない＝形を作れていない）"
    );

    門.add_permits(1);
    let 答え = timeout(common::TIMEOUT, answers.recv())
        .await
        .expect("★外されて実体が解放された後、止まった実体への終了の頼みに誰も答えない")
        .expect("答えの配信が閉じていない");
    assert_eq!(
        答え,
        KillAnswered {
            card_id,
            op,
            outcome: KillOutcome::Stopped,
        }
    );
    tokio::time::sleep(QUIET).await;
    assert_eq!(答えを取る(&mut answers), None, "答えは1回だけ");
}

#[tokio::test]
async fn 確かめを待っている起こし直しを番号付きで止めるとその場で取り下げたと答える() {
    // 実装レビュー第6回 Astra 1。確かめ・席を待っている起こし直しは、札を見て作る前にやめる
    // ので、もう実体は作られない——その場で答えてよい。**起こし直しの断りは起こし直しの番号を
    // 運び、終了の番号は運ばない**（終了の答えは別に出る）
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    let card_id = CardId::new();
    let (外, host_free, 古い実体, _, _門) = 寝かせて確かめ中にする(&manager, card_id).await;
    let mut answers = manager.subscribe_kill_answers();
    let op = OpId::new();
    manager.kill_answering(card_id, op);
    assert_eq!(
        答えを取る(&mut answers),
        Some(KillAnswered {
            card_id,
            op,
            outcome: KillOutcome::Withdrew,
        }),
        "★確かめ待ちの起こし直しを止めたのに、その場で答えていない"
    );
    外.開ける();
    wait_until("取得が済む", || host_free.聞き終えた回数() >= 1).await;
    tokio::time::sleep(QUIET).await;
    assert!(
        Arc::ptr_eq(&manager.get(card_id).expect("抜け殻は残る"), &古い実体),
        "★止めたのに、確かめが済んだ後に新しいプロセスを起こしている"
    );
    assert_eq!(答えを取る(&mut answers), None, "答えは1回だけ");
}

#[tokio::test]
async fn 起こしている最中に番号付きで止めると作った実体が止まってから答える() {
    // 実装レビュー第6回 Astra 1。起こしている最中は、作り終えた起こす側が作った実体を止める。
    // **答えはその実体が止まってから**——先に答えると、まだ動いているプロセスを「止めた」と言う
    let manager = common::manager_with(実機の設定());
    暖まったwsl(&manager);
    外側を差す(
        &manager,
        common::止める外側::開いたまま() as Arc<dyn session_host_core::resources::HostFreeProbe>,
    );
    let card_id = CardId::new();
    let op = OpId::new();
    let 頼んだ: Arc<std::sync::atomic::AtomicBool> = Arc::default();
    {
        let manager_weak = Arc::downgrade(&manager);
        let 頼んだ = Arc::clone(&頼んだ);
        manager.起こす直前に差し込む(Arc::new(move || {
            if 頼んだ.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            if let Some(manager) = manager_weak.upgrade() {
                manager.kill_answering(card_id, op);
            }
        }));
    }
    let mut answers = manager.subscribe_kill_answers();
    let 断り = 頼む(&manager, card_id)
        .await
        .expect_err("終了を頼まれたのだから断ること");
    assert!(断り.contains("終了を頼まれた"), "{断り}");
    assert!(
        頼んだ.load(std::sync::atomic::Ordering::SeqCst),
        "起こしている最中に頼んだこと"
    );
    let 答え = 答えを待つ(&mut answers, "起こしている最中の終了").await;
    assert_eq!((答え.card_id, 答え.op), (card_id, op));
    assert_eq!(
        答え.outcome,
        KillOutcome::Stopped,
        "作った実体を止めてから答えること"
    );
    let 実体 = manager.get(card_id).expect("カードは残る");
    assert!(
        matches!(実体.status(), SessionStatus::Ended { .. }),
        "★答えた時点で、作った実体がまだ止まっていない"
    );
}

#[tokio::test]
async fn 起こし直しの断りは受け付けた頼みと競合で束ねた頼みの番号を運ぶ() {
    // 実装レビュー第6回 Astra 3。先の起こし直し A が進んでいる間に来た頼み B は競合で断られるが、
    // **番号は A の札へ束ねる**——A が断られれば B も起きないので、B を待つ枝分かれはその理由で
    // すぐ終わってよい。A の札が表から外れた後に受け付けた頼み C は、A の断りに混ざらない
    let manager = common::manager_with(床の設定());
    manager.set_memory_probe(名乗るメモリ::一定(2_500));
    let card_id = CardId::new();
    let (a, b, c) = (OpId::new(), OpId::new(), OpId::new());

    let 先の頼み = manager
        .begin_revive(card_id, Some(a))
        .expect("印が立つこと");
    let 先の答え = 先の頼み.answers();
    assert!(
        manager.begin_revive(card_id, Some(b)).is_none(),
        "進んでいる間の頼みは競合で断ること"
    );
    let 断り = manager
        .revive(
            先の頼み,
            &common::work_dir(),
            None,
            ClaudeSessionId(uuid::Uuid::new_v4()),
        )
        .await
        .expect_err("メモリ不足で断ること");
    assert!(断り.to_string().contains("メモリが足りない"), "{断り}");

    // A の札は表から外れた。C は新しい札で受け付けられる
    let 後の頼み = manager
        .begin_revive(card_id, Some(c))
        .expect("新しい印が立つこと");
    assert_eq!(
        先の答え.ops(),
        vec![a, b],
        "★先の起こし直しの断りが、束ねた頼みの番号を運ばない／後の頼みの番号が混ざった"
    );
    assert_eq!(後の頼み.answers().ops(), vec![c]);

    // 番号を渡さない頼み（画面）でも、受け付けた時点で番号が振られる
    drop(後の頼み);
    let 画面の頼み = manager.begin_revive(card_id, None).expect("印が立つこと");
    assert_eq!(
        画面の頼み.answers().ops().len(),
        1,
        "受付時に番号を振ること"
    );
}

#[tokio::test]
async fn 番号付きの起こし直しは実体を作り終えたら番号付きで1回だけ答え番号の無い頼みには答えない() {
    // 実装レビュー第6回（`session revive` の待ち）。CLI は番号の付いた答えでだけ満ちるので、
    // PC は作り終えたら必ず1回答える。**作った実体の姿を配ってから答える**（サーバは答えを受けた
    // 時点で記録が新しい実体を指している）。画面からの頼み（番号無し）には答えない——待っている
    // 者が居ないので、配りものが増えるだけ
    use session_host_core::events::ReviveAnswered;
    let manager = common::manager();
    let mut answers = manager.subscribe_revive_answers();
    let mut bus = manager.subscribe_events();

    let card_id = CardId::new();
    let op = OpId::new();
    let in_flight = manager
        .begin_revive(card_id, Some(op))
        .expect("印が立つこと");
    manager
        .revive(
            in_flight,
            &common::work_dir(),
            None,
            ClaudeSessionId(uuid::Uuid::new_v4()),
        )
        .await
        .expect("起こし直せること");
    assert_eq!(
        answers.try_recv().ok(),
        Some(ReviveAnswered { card_id, op }),
        "★実体を作り終えたのに、番号付きで答えていない"
    );
    assert!(answers.try_recv().is_err(), "答えは1回だけ");
    let mut 姿を配った = false;
    while let Ok(message) = bus.try_recv() {
        if let ServerMessage::SessionUpsert { session } = message
            && session.card_id == card_id
            && session.agent_connected
        {
            姿を配った = true;
        }
    }
    assert!(姿を配った, "作った実体の姿を、答えより前に配っていること");
    manager.get(card_id).expect("実体があること").kill();

    // 番号の無い頼み（画面）には答えない
    let 画面のカード = CardId::new();
    let in_flight = manager
        .begin_revive(画面のカード, None)
        .expect("印が立つこと");
    manager
        .revive(
            in_flight,
            &common::work_dir(),
            None,
            ClaudeSessionId(uuid::Uuid::new_v4()),
        )
        .await
        .expect("起こし直せること");
    assert!(
        answers.try_recv().is_err(),
        "★番号の無い頼みに、待つ者の居ない答えを配っている"
    );
    manager.get(画面のカード).expect("実体があること").kill();

    // 断ったときは成功を答えない（断りの番号は束が運ぶ）
    let 断るカード = CardId::new();
    let 断る頼み = OpId::new();
    let in_flight = manager
        .begin_revive(断るカード, Some(断る頼み))
        .expect("印が立つこと");
    let 束 = in_flight.answers();
    manager.forget(断るカード);
    manager
        .revive(
            in_flight,
            &common::work_dir(),
            None,
            ClaudeSessionId(uuid::Uuid::new_v4()),
        )
        .await
        .expect_err("外したカードは断ること");
    assert!(
        answers.try_recv().is_err(),
        "★断ったのに、起こせたと答えている"
    );
    assert_eq!(束.ops(), vec![断る頼み], "断りは頼みの番号を運ぶ");
}
