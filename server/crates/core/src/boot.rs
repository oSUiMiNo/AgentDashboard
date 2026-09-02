//! 起動の最初にやること——選ばれている版への乗り換えと、入れる側が置いた版の退避
//! （CICD設計§4・§5・§6・§11）。
//!
//! # なぜ両側を知っているこの層に置くのか
//!
//! 保管庫とポインタの読み書きは [`session_host_core::version`] が持っている（記録の置き場所を
//! 決めるのはあちらなので）。一方「乗り換えるかどうか」は**コマンドラインの形**と
//! `config.toml` の射影で決まる。どちらか片方の crate へ置くと、もう片方を参照させる
//! ことになる（`settings_api` と同じ理由）。
//!
//! # ログではなく `eprintln!` を使う
//!
//! ここは**ログの初期化より前**に走る。`tracing` はまだ生きていないので標準エラーへ
//! 直接書く。「なぜ別の版で立ち上がったのか」は `RUST_LOG` の設定に関わらず必ず
//! 見えてほしい情報でもある。

use crate::config::Config;
use session_host_core::config::SessionHostConfig;
use session_host_core::session::hooks_settings::HOOK_BIN_ENV;
use session_host_core::session::now_ms;
use session_host_core::version::{self, Attempt, Capability, Outcome};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 選ばれている版があれば、そちらへ乗り換える。
///
/// **成功すればこの関数からは返らない**（プロセスがそのまま置き換わる）。返ってきた
/// ときは「乗り換えなかった」か「乗り換えられなかった」のどちらか。
///
/// 呼んでよいのは**サブコマンドが無いとき**だけ。門（CICD設計§9）が叩く `config` /
/// `state-dir` / `pair-token` が乗り換えると、聞いた相手と答えた相手が変わる。
pub fn hand_over_if_selected(config: Option<&Config>) {
    if version::already_handed_over() {
        return;
    }
    let state_dir = state_dir_for_boot(config);

    // 印が残っている＝前回の起動が待ち受けまで届かなかった。**ポインタを毒と見なす**
    if let Some(attempt) = version::take_attempt(&state_dir) {
        refuse_poisoned(&state_dir, attempt);
        return;
    }

    match version::resolve_target(&state_dir) {
        Some(target) if version::is_other_binary(&target) => hand_over(&state_dir, &target),
        _ => snapshot_installed(&state_dir),
    }
}

/// 乗り換え判定に使う記録の置き場所。
///
/// **設定が読めなくても決める。** 素直に書くと設定の読み込みが判定より前に来るが、
/// そうすると袋小路ができる——新しい版が設定キーを増やし、それを書いた利用者が古い版を
/// 選ぶと、古い版は知らないキーで起動を拒む。拒む場所が判定より前だと、**新しい版へ
/// 戻ることもできない**（画面が出ないのでポインタも直せない）。
///
/// 読めないときは既定へ落とす。`state_dir` を移している利用者は設定が壊れている間だけ
/// 既定の場所を見ることになるが、取り違えは**乗り換えないほうへ倒れる**（既定の場所に
/// ポインタが無ければそのまま続行し、従来どおり設定エラーで終わる）ので壊れない。
fn state_dir_for_boot(config: Option<&Config>) -> PathBuf {
    if let Some(config) = config {
        return config.agent().resolved_state_dir();
    }
    // 環境変数は効かせる（`AGENTDASHBOARD_STATE_DIR` で置き場所を移している利用者を
    // 取り違えないため）。`Config::from_toml_str` を使わないのは、あちらが値の検査を
    // 通るから——検査で落ちると、また判定へ辿り着けなくなる
    SessionHostConfig::from_toml_str("")
        .unwrap_or_default()
        .resolved_state_dir()
}

/// 前回の起動が待ち受けまで届かなかったので、ポインタを無視して自分で続ける。
fn refuse_poisoned(state_dir: &Path, attempt: Attempt) {
    let target = PathBuf::from(&attempt.target);
    eprintln!(
        "AgentDashboard: 前回選んだ版は待ち受けまで届きませんでした。\
         入れる側が置いた版で起動します: {}",
        target.display()
    );
    version::write_outcome(
        state_dir,
        &Outcome {
            attempted: version::version_of_stored(&target),
            attempted_path: attempt.target,
            running: version::running_version(),
            failed_reason: Some("待ち受けを確保する前に終わりました".to_string()),
            at: now_ms(),
        },
    );
}

/// **走行中に、行き先の版へ入れ替える**（`手元の新しい版をGUIだけで効かせる` 設計§7）。
///
/// 起動時の乗り換えと**同じ手順を通す**。新しく書かない——毒印の置き方・消し方が
/// 2箇所に散ると、片方だけ直したときに静かに食い違う。
///
/// # 落とすのではなく、入れ替える
///
/// これまでは応答を返してから `exit(0)` していた。起こし直しは常駐の設定に任せる
/// 設計だったが、**ソースビルドの機械は常駐に載っていない**ので誰も起こさず、
/// 画面ごと消えて戻ってこなかった。
///
/// `exec` は**プロセスを離さない**（同じ PID のまま中身だけ入れ替わる）ので、
/// CICD設計§10 が退けた「見届け役を離す形」——離したプロセスが孤児として生き残った
/// 事故——には当たらない。
///
/// # 抱えている記述子
///
/// 実測で、**PTY の親側にも待ち受けの socket にも `CLOEXEC` が付いている**
/// （28本すべて／待ち受け1本）。したがって `exec` すると全部閉じる——claude は
/// 道連れで落ち（`exit(0)` と結末が同じ）、新しい中身は同じポートへ bind できる。
/// **付いていなければ二度と戻ってこない**ので、崩れたら落ちる検査を置いてある。
///
/// **成功すればこの関数からは返らない。**
pub fn hand_over_now(state_dir: &Path, target: &Path) {
    hand_over(state_dir, target);
}

/// 実際に乗り換える。
fn hand_over(state_dir: &Path, target: &Path) {
    // 差し替え済みのパーサは古いソースからビルドされているので、新しい本体と IPC の形が
    // 噛み合う保証が無い（CICD設計§17・§20-4）
    version::drop_selfheal_parser(state_dir);
    version::write_attempt(state_dir, target);
    eprintln!(
        "AgentDashboard: 選ばれている版で起動します: {}",
        target.display()
    );

    // **`exec` の手前で、抱えている子を引き取る**（ゾンビ設計§6-2）。ここを飛ばすと、
    // `exec` でプロセスの中身が消えたあと、閉じた PTY で死んだ子を引き取る者が
    // 1人も居なくなる（実機で78体溜まった原因）
    reap_before_handover();

    let error = exec_into(target);

    // ここへ来た＝乗り換えられなかった。印を消して自分で続ける
    version::clear_attempt(state_dir);
    eprintln!(
        "AgentDashboard: 選ばれている版を起こせません（入れる側が置いた版で続けます）: {error}"
    );
}

/// 乗り換える前に、抱えている子を畳んで引き取る（ゾンビ設計§6-2）。
///
/// # 経路ごとに分岐しなくてよい
///
/// [`hand_over_if_selected`]（起動直後・まだ子が1本も居ない）からも通るが、そのときは
/// 数えて0体と分かって即座に返る。**「走っている最中の入れ替えか」を判定する必要が無い。**
///
/// # ここだけは `eprintln!` ではなく `tracing`
///
/// このモジュールは普段ログの初期化より前に走るので標準エラーへ直接書いている。
/// **ただしこの1件は、あとから `agentdashboard logs` で辿れないと意味が無い**——
/// 引き取れたかどうかは、その場で読む情報ではなく、後日ゾンビを数えたときに
/// 突き合わせる情報だからである。起動直後の経路では `tracing` がまだ生きていないため
/// この行は落ちるが、そちらは常に0体なので失うものが無い。
fn reap_before_handover() {
    /// 穏やかに頼んでから待つ時間。
    const GRACE: Duration = Duration::from_millis(500);
    /// 強く止めたあと、引き取りきるまで待つ上限。
    ///
    /// **ここを長くすると入れ替えがそのぶん遅くなる。** 入れ替えの売りは「落ちないこと」
    /// なので、引き取れなくても先へ進む（ゾンビ設計§6-3）。
    const DEADLINE: Duration = Duration::from_secs(2);

    let Some(result) = crate::children::reap(GRACE, DEADLINE) else {
        return;
    };
    if result.left.is_empty() {
        if result.reaped > 0 {
            tracing::info!(
                reaped = result.reaped,
                "入れ替える前に、抱えていた子を引き取りました"
            );
        }
        return;
    }
    let left_pids = result
        .left
        .iter()
        .map(|pid| pid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    tracing::warn!(
        reaped = result.reaped,
        left = result.left.len(),
        left_pids,
        "引き取れないまま入れ替えます。この子はゾンビとして残ります"
    );
}

/// 入れる側が置いた3本を保管庫へ控える（CICD設計§6）。
fn snapshot_installed(state_dir: &Path) {
    if !Capability::detect().supported() {
        return;
    }
    let Some(source) = version::source_dir() else {
        return;
    };
    match version::snapshot(state_dir, &source) {
        Ok(Some(version)) => {
            eprintln!("AgentDashboard: いま入っている版を控えました: {version}");
        }
        // 既に控えてある。**上書きしない**（CICD設計§3）
        Ok(None) => {}
        Err(error) => {
            eprintln!("AgentDashboard: いま入っている版を控えられません（続行します）: {error}");
        }
    }
}

/// 乗り換えの命令を組み立てる。
///
/// `cfg(unix)` の内側に置いているのは、**Windows では乗り換えそのものを行わない**と
/// 決めてあるため（CICD設計§20-5）。「どの OS でも走らせたい道を cfg で切ると Linux の
/// CI から片方が消える」という戒めはここには当たらない——Windows 側に走らせたい道が
/// そもそも無く、その判断は [`Capability::supported`] が OS 非依存の形で持っている。
#[cfg(unix)]
fn handover_command(target: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(target);
    command.args(std::env::args_os().skip(1));
    // 二度乗り換えないための印（CICD設計§4）
    command.env(version::VERSION_HANDOVER_ENV, "1");
    // **フックの呼び出し先は、入れる側が置いた入口にする**（CICD設計§5）。乗り換えると
    // `current_exe()` が保管庫の版フォルダを指すので、そのまま焼き込むと**版を消した
    // 瞬間に生きているセッションのフックが全滅する**。しかもフックは返事を待たない
    // 呼び方なので claude は止まらず、症状は「作業中のまま固まる」になる
    if let Some(hook_bin) = handover_hook_bin(
        std::env::var(HOOK_BIN_ENV).ok(),
        version::installed_binary(),
    ) {
        command.env(HOOK_BIN_ENV, hook_bin);
    }
    command
}

/// 渡すフックの入口を決める（材料を受け取る純粋関数）。
///
/// # なぜ「立っていれば何もしない」では駄目なのか
///
/// **`make build` は走っているプロセスの実体を消す。** そのあと `current_exe()` を読むと
/// カーネルは行き先に `(deleted)` を付けて答える——**存在しないパス**である。それを
/// そのまま渡すと、次のプロセスは**フックを1件も起動できない**まま生き続ける。
/// フックは返事を待たない呼び方（`"async": true`）なので claude は止まらず、症状は
/// 「状態が不明のまま・構造化ビューに何も出ない・ターミナルだけ動く」になる。
///
/// そして**入れ替えを重ねても消えない**。以前は「既に立っていれば何もしない」だったので、
/// 一度焼き込まれた値がその機械に居座り続けた（実機で2回の入れ替えを跨いで残った）。
///
/// **だから「実在しないときだけ入れ替える」。**
///
/// | いまの値 | どうするか |
/// |---|---|
/// | 立っていない | [`version::installed_binary`] を渡す |
/// | 立っていて、**実在する** | **そのまま**（利用者が指定した道を塞がない） |
/// | 立っていて、**実在しない** | 入れ替える（毒が自分で治る） |
/// | 実在せず、入れる側の実行ファイルも無い | **そのまま渡す**（下記） |
///
/// # 最後の行で「渡さない」を選ばない理由
///
/// 渡さないと、次のプロセスは自分の `current_exe()`＝**乗り換え先＝保管庫**を使う。
/// すると**版を消した瞬間に、生きているセッションのフックが全滅する**——このコードが
/// もともと最も恐れていた状態へ戻る。**壊れた値を渡し続けるほうが、まだ被害が小さい。**
///
/// # 文字列から `(deleted)` を剥がさない
///
/// [`version::installed_binary`] は `source_dir()` の下を `is_file()` で確かめてから
/// 答えるので、**実在しない答えを返さない**。「在るときだけ答える」はこのリポジトリの
/// 既存の作法（`resolve_target` ／ `read_pointer` も同じ）で、文字列を加工する道を
/// 1つ増やすより、そちらへ乗せる。
#[cfg(unix)]
fn handover_hook_bin(current: Option<String>, installed: Option<PathBuf>) -> Option<String> {
    let entry = installed.map(|path| path.to_string_lossy().into_owned());
    match current.filter(|raw| !raw.is_empty()) {
        Some(raw) if Path::new(&raw).is_file() => Some(raw),
        Some(raw) => Some(entry.unwrap_or(raw)),
        None => entry,
    }
}

/// 乗り換える。成功すればこの関数からは返らない。
#[cfg(unix)]
fn exec_into(target: &Path) -> std::io::Error {
    use std::os::unix::process::CommandExt as _;
    handover_command(target).exec()
}

/// Windows には乗り換えの手段が無い（CICD設計§20-5）。
///
/// 殻を作れば「いま走っている版」が殻と中身の2つになり、Ctrl+C で殻が先に死ぬと子が
/// 孤児になる。**どちらも殻を作るから起きる**ので、作らない。
#[cfg(not(unix))]
fn exec_into(_target: &Path) -> std::io::Error {
    std::io::Error::other("この OS では版を切り替えられません")
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[cfg(unix)]
    #[test]
    fn 乗り換えの命令は印とフックの入口を運ぶ() {
        let target = Path::new("/state/versions/0.2.0/agentdashboard");
        let command = handover_command(target);

        let envs: Vec<(String, Option<String>)> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();

        let handover = envs
            .iter()
            .find(|(key, _)| key == version::VERSION_HANDOVER_ENV);
        assert_eq!(
            handover.and_then(|(_, value)| value.clone()),
            Some("1".to_string()),
            "印が無いと乗り換えが止まらない"
        );

        // 焼き込み先は保管庫ではなく、乗り換える前の自分（＝入れる側が置いた入口）。
        //
        // **期待値を `current_exe()` から組み立て直してはいけない。** 以前のこのテストは
        // 実装と同じ式で期待値を作っていたので、実装が何を渡しても一致した——`(deleted)`
        // 付きの存在しないパスを渡していた不具合を、**このテスト自身が素通しした**。
        // 決め方そのものは [`handover_hook_bin`] が持ち、そちらは下の表で固めてある。
        // ここが見るのは**繋ぎ込み**（決めた値がそのまま命令へ載ること）である。
        let hook = envs
            .iter()
            .find(|(key, _)| key == HOOK_BIN_ENV)
            .and_then(|(_, value)| value.clone());
        assert_eq!(
            hook,
            handover_hook_bin(
                std::env::var(HOOK_BIN_ENV).ok(),
                version::installed_binary()
            ),
            "決めた値がそのまま乗ること"
        );

        // 性質そのものも見る。**渡す値が保管庫を指したら、版を消した瞬間に
        // 生きているセッションのフックが全滅する**
        if let Some(hook) = hook {
            assert!(
                !hook.starts_with("/state/versions"),
                "保管庫を指していないこと: {hook}"
            );
            assert!(
                !hook.contains(" (deleted)"),
                "消えたパスを渡していないこと: {hook}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn 渡すフックの入口は実在しないときだけ入れ替える() {
        let installed = std::env::current_exe().expect("テスト自身は実在する");
        let entry = installed.to_string_lossy().into_owned();
        let 消えた = "/home/x/.local/bin/agentdashboard (deleted)".to_string();

        // 立っていない → 入れる側が置いたものを渡す
        assert_eq!(
            handover_hook_bin(None, Some(installed.clone())),
            Some(entry.clone()),
            "立っていなければ入れる側の入口を渡す"
        );

        // 立っていて実在する → そのまま（利用者が指定した道を塞がない）
        //
        // **入れる側の答えを「別の実在するもの」にしておく。** ここを `None` にすると、
        // 「据え置く」と「入れ替える」がどちらも同じ答えになり、**取り違えを見逃す**
        let 別の実在するもの =
            std::env::temp_dir().join(format!("agentdashboard-handover-{}", std::process::id()));
        std::fs::write(&別の実在するもの, b"").expect("使い捨ての印を置けること");
        assert_eq!(
            handover_hook_bin(Some(entry.clone()), Some(別の実在するもの.clone())),
            Some(entry.clone()),
            "実在する指定は据え置く（入れる側の答えで上書きしない）"
        );
        std::fs::remove_file(&別の実在するもの).expect("使い捨ての印を片付けられること");

        // 立っていて実在しない → 入れ替える（毒が自分で治る）
        assert_eq!(
            handover_hook_bin(Some(消えた.clone()), Some(installed)),
            Some(entry),
            "消えたパスは入れ替える"
        );

        // 実在せず、入れる側の実行ファイルも無い → そのまま渡す
        //
        // ここで `None` を返すと、次のプロセスは自分の `current_exe()`＝保管庫を使う。
        // **版を消した瞬間に全滅する**ほうが、壊れた値を渡し続けるより悪い
        assert_eq!(
            handover_hook_bin(Some(消えた.clone()), None),
            Some(消えた),
            "打つ手が無いときは、壊れていても渡す"
        );

        // 空は未指定と同じ（`hook_program_from` ／ `source_dir_from` と揃える）
        assert_eq!(
            handover_hook_bin(Some(String::new()), None),
            None,
            "空は未指定"
        );
        assert_eq!(handover_hook_bin(None, None), None);
    }

    #[cfg(unix)]
    #[test]
    fn 渡すフックの入口は保管庫を指さない() {
        // 乗り換え先（保管庫）が実在していても、そちらを渡してはいけない。
        // **版を消した瞬間に、生きているセッションのフックが全滅する**
        let 保管庫 = std::env::current_exe().expect("テスト自身は実在する");
        let 入口 = "/home/x/.local/bin/agentdashboard (deleted)".to_string();

        // 実在しない指定に対して渡すのは `installed_binary()` の答えだけで、
        // あちらは定義上 `source_dir()` の下＝保管庫の外にある
        let 答え = handover_hook_bin(Some(入口.clone()), None);
        assert_eq!(答え, Some(入口), "保管庫を掴みに行かない");
        assert_ne!(
            答え,
            Some(保管庫.to_string_lossy().into_owned()),
            "乗り換え先を焼き込まない"
        );
    }

    #[test]
    fn 設定が読めなくても記録の置き場所は決まる() {
        // 設定の失敗で判定へ辿り着けないと、新しい版へ戻ることもできなくなる
        let fallback = state_dir_for_boot(None);
        assert!(
            fallback.ends_with(session_host_core::config::STATE_DIR_NAME),
            "既定の置き場所へ落ちること: {}",
            fallback.display()
        );
    }
}
