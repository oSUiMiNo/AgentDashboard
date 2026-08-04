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

    let error = exec_into(target);

    // ここへ来た＝乗り換えられなかった。印を消して自分で続ける
    version::clear_attempt(state_dir);
    eprintln!(
        "AgentDashboard: 選ばれている版を起こせません（入れる側が置いた版で続けます）: {error}"
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
    if std::env::var_os(HOOK_BIN_ENV).is_none() {
        if let Ok(current) = std::env::current_exe() {
            command.env(HOOK_BIN_ENV, current);
        }
    }
    command
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

        // 焼き込み先は保管庫ではなく、乗り換える前の自分（＝入れる側が置いた入口）
        let hook = envs.iter().find(|(key, _)| key == HOOK_BIN_ENV);
        let expected = std::env::var(HOOK_BIN_ENV)
            .ok()
            .or_else(|| Some(std::env::current_exe().ok()?.to_string_lossy().into_owned()));
        assert_eq!(
            hook.and_then(|(_, value)| value.clone()),
            expected,
            "版を消した瞬間にフックが全滅しないよう、消えない入口を渡す"
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
