//! ダッシュボード自身の版の保管庫と、次に起こす版を指すポインタ（CICD設計§3・§4・§11）。
//!
//! [`crate::parser`] が自己修復済みのパーサに対してやっていること——**上書きしない・
//! 版ごとに残す・1行のポインタで指す・指す先が消えていたら既定へ落ちる**——を、
//! ダッシュボード本体の3本へそのまま広げたもの。
//!
//! ```text
//! ~/.local/bin/                    ← 入れる側（配布インストーラ）の持ち物。**書き換えない**
//!   agentdashboard / agentdashboard-agent / transcript-parser
//!
//! <state_dir>/versions/            ← ここだけがダッシュボードの持ち物
//!   0.1.0/{3本}
//!   .staging-0.2.0/                ← 置いている途中（揃ったらフォルダごと rename）
//! <state_dir>/version-current      ← 1行。次に起こすときの実行ファイルの絶対パス
//! <state_dir>/version-attempt      ← 乗り換えを試みた印（待ち受けを確保したら消す）
//! <state_dir>/version-state.json   ← 前回の結末
//! ```
//!
//! # 実行ファイルを一度も書き換えないのが要点
//!
//! 素朴には `~/.local/bin` の3本を新しい版で上書きすることになるが、そうすると
//! (1) 走っている自分自身は上書きできない (2) 3本を同時に置き換えられないので
//! **1本だけ入れ替わった瞬間**が必ず生まれる (3) パーサは「実行ファイルの隣」を探すので、
//! その瞬間に**落としてもいないのに食い違ったパーサが起動する**。
//!
//! 代わりに、起動時にポインタを読んで**自分がその実行ファイルへ乗り換える**。親は要らない
//! ——自分が自分の親になればよい。乗り換えると `current_exe()` ごと移るので、隣の3本が
//! 構造的に同じ版になる。
//!
//! # ログではなく `eprintln!` を使う
//!
//! 乗り換えの判定は**ログの初期化より前**に走る（設計§4）。`tracing` はまだ生きていないので、
//! この経路の知らせは標準エラーへ直接書く。「なぜ別の版で立ち上がったのか」は
//! `RUST_LOG` の設定に関わらず必ず見えてほしい情報でもある。

use crate::session::now_ms;
use protocol::{Timestamp, VersionId};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 配る実行ファイル3本。**増減させたらここも直す**
/// （`crates/dist/tests/uninstall.rs` が消す道と突き合わせて見張る）。
pub const BINARIES: [&str; 3] = [
    "agentdashboard",
    "agentdashboard-agent",
    "transcript-parser",
];

/// 版ごとの実行ファイルを置くフォルダの名前（[`crate::config::AgentConfig::resolved_state_dir`] 配下）。
pub const VERSIONS_DIR_NAME: &str = "versions";

/// 次に起こすときの実行ファイルを指すポインタの名前。
///
/// 中身は絶対パス1行。`parser-current` と同じ形にしてあるのは、人が開いたときに
/// 読み方を覚え直さなくてよいようにするため。**消せば入れる側が置いた版へ戻る。**
pub const VERSION_POINTER: &str = "version-current";

/// 乗り換えを試みた印の名前。乗り換える直前に書き、待ち受けを確保した時点で消す。
pub const VERSION_ATTEMPT: &str = "version-attempt";

/// 前回の乗り換えの結末の名前。
pub const VERSION_STATE: &str = "version-state.json";

/// 置いている途中のフォルダに付ける接頭辞。**走査はこれを拾わない。**
///
/// 走査する側で名前を判定するより、置く側が「まだ見せない印」を持つほうが取りこぼしが無い。
pub const STAGING_PREFIX: &str = ".staging-";

/// 乗り換え先を名指しする環境変数。
///
/// 探索順の先頭に置くのは [`crate::parser::PARSER_BIN_ENV`] と同じ理由で、テストが
/// 行き先を名指しできるようにするため。**`scripts/cargo` はこれをコンテナへ転送しない**
/// （ホストのパスは箱の中に存在しない）。
pub const VERSION_BIN_ENV: &str = "AGENTDASHBOARD_VERSION_BIN";

/// 乗り換え済みの印。**立っていたら判定ごと飛ばす。**
///
/// ポインタが自分自身を指していても、行き先がさらに別の版を指していても、乗り換えは
/// 1回で止まる。テストが本物のバイナリを起こすときも、これを立てておけば
/// 開発者の実環境のポインタに引きずられない。
pub const VERSION_HANDOVER_ENV: &str = "AGENTDASHBOARD_VERSION_HANDED_OVER";

/// 初回退避の元を差し替える環境変数。
///
/// 既定は `current_exe()` の親（＝入れる側が置いた場所）。差し替え口が無いと、
/// **テストのたびに利用者の実インストールから数十MB がコピーされる。**
pub const VERSION_SOURCE_ENV: &str = "AGENTDASHBOARD_VERSION_SOURCE_DIR";

/// 版の切替が使える構成かを上書きする環境変数（`1` で有効、`0` で無効）。
///
/// 自動判定は「乗り換えの手段があるか」と「箱の中か」で決まるが、**テストは箱の中で走る**
/// （`scripts/cargo` は docker の中で cargo を動かす）ので、上書きが無いと有効側の道を
/// 一度も通せない。
pub const VERSION_SUPPORTED_ENV: &str = "AGENTDASHBOARD_VERSION_SUPPORTED";

/// この構成で版の切替が使えるか（設計§14 の `supported`）。
///
/// **判定の材料と判定そのものを分けてある。** まるごと `cfg` で囲むと Windows 側の
/// 振る舞い（切り替えない）を Linux の CI で確かめられなくなる——
/// [`crate::config::AgentConfig::resolved_state_dir`] が同じ轍を踏んで直した経緯がある。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capability {
    /// 乗り換えの手段（自己 exec）があるか。Windows には無い（設計§20-5）。
    pub can_hand_over: bool,
    /// 箱の中か。書いても次に起こし直すと消えるので、保管庫を持つ意味が無い。
    pub in_container: bool,
    /// 設定による上書き。
    pub forced: Option<bool>,
}

impl Capability {
    /// いまの環境から材料を集める。
    pub fn detect() -> Self {
        Self {
            can_hand_over: cfg!(unix),
            in_container: Path::new("/.dockerenv").exists(),
            forced: match std::env::var(VERSION_SUPPORTED_ENV).ok().as_deref() {
                Some("1") | Some("true") => Some(true),
                Some("0") | Some("false") => Some(false),
                _ => None,
            },
        }
    }

    /// 材料から結論を出す。**純粋関数なので、テストは材料を直に組んで両方の道を通せる。**
    pub fn supported(&self) -> bool {
        if let Some(forced) = self.forced {
            return forced;
        }
        self.can_hand_over && !self.in_container
    }
}

/// 乗り換えを試みた印の中身。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Attempt {
    /// 乗り換えようとした実行ファイル。
    pub target: String,
    /// 書いた時刻（エポックミリ秒）。
    pub at: Timestamp,
}

/// 前回の乗り換えの結末（設計§11）。
///
/// **知らせではなく状態として持つ。** 「新しい版が起動できなかったので前の版で
/// 立ち上げました」が出るのは新しいプロセスの起動直後——ブラウザがまだ繋がっていない
/// 瞬間なので、流すだけでは誰にも届かない。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Outcome {
    /// 起こそうとした版（保管庫のフォルダ名から引く。引けなければ `None`）。
    pub attempted: Option<VersionId>,
    /// 起こそうとした実行ファイルの絶対パス。
    pub attempted_path: String,
    /// 実際に走っている版。
    pub running: VersionId,
    /// 起動できなかったときの理由。
    pub failed_reason: Option<String>,
    pub at: Timestamp,
}

/// 「まだ何も起きていない」を表す既定値。
///
/// [`VersionId`] に `Default` を生やさないのは、**空の版をうっかり作れる形にしないため**
/// （[`protocol::ModelId`] や [`protocol::PermissionMode`] も持っていない）。読めなかった
/// ときに既定値へ落ちるのは [`crate::jsonfile`] の約束なので、ここだけ手で書く。
impl Default for Outcome {
    fn default() -> Self {
        Self {
            attempted: None,
            attempted_path: String::new(),
            running: VersionId::new(""),
            failed_reason: None,
            at: 0,
        }
    }
}

/// ポインタファイルの場所。
pub fn pointer_path(state_dir: &Path) -> PathBuf {
    state_dir.join(VERSION_POINTER)
}

/// 保管庫の場所。
pub fn versions_dir(state_dir: &Path) -> PathBuf {
    state_dir.join(VERSIONS_DIR_NAME)
}

/// 使う版を指すポインタを書く（消したいときは `None`）。
pub fn write_pointer(state_dir: &Path, path: Option<&Path>) {
    let pointer = pointer_path(state_dir);
    match path {
        Some(path) => {
            let _ = std::fs::create_dir_all(state_dir);
            let _ = std::fs::write(&pointer, path.to_string_lossy().as_bytes());
        }
        None => {
            let _ = std::fs::remove_file(&pointer);
        }
    }
}

/// ポインタを読む。指す先が実行ファイルとして在るときだけ返す。
pub fn read_pointer(state_dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(pointer_path(state_dir)).ok()?;
    let path = PathBuf::from(text.trim());
    path.is_file().then_some(path)
}

/// 乗り換え先を決める。
///
/// 探索順は **環境変数 → ポインタ → 乗り換えない**（[`crate::parser::parser_program`] と同じ形）。
/// 指す先が消えていたら知らせたうえで既定へ落ちる——**起動できなくなるほうが困る。**
pub fn resolve_target(state_dir: &Path) -> Option<PathBuf> {
    if let Ok(raw) = std::env::var(VERSION_BIN_ENV) {
        let path = PathBuf::from(raw);
        if path.is_file() {
            return Some(path);
        }
        eprintln!(
            "AgentDashboard: {VERSION_BIN_ENV} が指す実行ファイルが見つかりません（無視します）: {}",
            path.display()
        );
        return None;
    }
    if let Ok(text) = std::fs::read_to_string(pointer_path(state_dir)) {
        let path = PathBuf::from(text.trim());
        if path.is_file() {
            return Some(path);
        }
        eprintln!(
            "AgentDashboard: 選ばれている版が見つかりません（入れる側が置いた版で続けます）: {}",
            path.display()
        );
    }
    None
}

/// 行き先が「いまの自分」と違うか。
///
/// **版名ではなく実パスで比べる。** 手元でビルドした版と配った同じ番号の版は同じ名前を
/// 名乗る（ワークスペースの版は1箇所にしか無い）ので、名前で比べると乗り換えが起きない。
/// 解決に失敗したときは**乗り換えないほうへ倒す**——分からないまま乗り換えるより安全。
pub fn is_other_binary(target: &Path) -> bool {
    let Ok(current) = std::env::current_exe() else {
        return false;
    };
    let real = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    real(target) != real(&current)
}

/// もう乗り換えたか（二度乗り換えないための印）。
pub fn already_handed_over() -> bool {
    std::env::var(VERSION_HANDOVER_ENV).is_ok_and(|value| !value.is_empty())
}

/// 印の場所。
pub fn attempt_path(state_dir: &Path) -> PathBuf {
    state_dir.join(VERSION_ATTEMPT)
}

/// 乗り換えを試みた印を書く。
pub fn write_attempt(state_dir: &Path, target: &Path) {
    crate::jsonfile::save(
        &attempt_path(state_dir),
        &Attempt {
            target: target.to_string_lossy().into_owned(),
            at: now_ms(),
        },
    );
}

/// 印が残っていれば取り出して消す。**残っていたら前回の起動が待ち受けまで届かなかった。**
pub fn take_attempt(state_dir: &Path) -> Option<Attempt> {
    let path = attempt_path(state_dir);
    if !path.is_file() {
        return None;
    }
    let attempt: Attempt = crate::jsonfile::load_or_default(&path);
    let _ = std::fs::remove_file(&path);
    (!attempt.target.is_empty()).then_some(attempt)
}

/// 待ち受けを確保できたので印を消す。
pub fn clear_attempt(state_dir: &Path) {
    let _ = std::fs::remove_file(attempt_path(state_dir));
}

/// 待ち受けまで届いたことを記録する（設計§11）。
///
/// **印が残っていること自体が「乗り換えの途中である」印。** 待ち受けを確保した時点で
/// 消し、同時に結末を「成功」で置き換える。こうしておくと、前回の失敗の記録が
/// いつまでも残って古い知らせを出し続けることがない。
///
/// # 乗り換えていない起動では何もしない
///
/// 印を消す前に「自分が乗り換えた側か」を確かめる。統合テストの多くは core を
/// **ライブラリとして**動かすので、確かめずに消すと**開発者の実環境の印**を
/// 消しにいく（`state_dir` を指定し忘れたテストが1本あれば足りる）。印を書くのは
/// 乗り換える側だけなので、この印が立っていない起動は必ず無関係である。
pub fn confirm_started(state_dir: &Path) {
    if !already_handed_over() {
        return;
    }
    let Some(attempt) = take_attempt(state_dir) else {
        return;
    };
    let target = PathBuf::from(&attempt.target);
    write_outcome(
        state_dir,
        &Outcome {
            attempted: version_of_stored(&target),
            attempted_path: attempt.target,
            running: running_version(),
            failed_reason: None,
            at: now_ms(),
        },
    );
}

/// いま走っている版。
///
/// ワークスペースの版は1箇所にしか無いので、どのクレートから読んでも実行ファイルの版と
/// 一致する。
pub fn running_version() -> VersionId {
    VersionId::new(env!("CARGO_PKG_VERSION"))
}

/// 結末の場所。
pub fn outcome_path(state_dir: &Path) -> PathBuf {
    state_dir.join(VERSION_STATE)
}

/// 結末を残す。
pub fn write_outcome(state_dir: &Path, outcome: &Outcome) {
    crate::jsonfile::save(&outcome_path(state_dir), outcome);
}

/// 結末を読む。
pub fn read_outcome(state_dir: &Path) -> Option<Outcome> {
    let path = outcome_path(state_dir);
    path.is_file()
        .then(|| crate::jsonfile::load_or_default::<Outcome>(&path))
        .filter(|outcome| outcome.at != 0)
}

/// 保管庫の版のフォルダを並べる。**置いている途中（`.staging-`）は拾わない。**
pub fn stored_versions(state_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(versions_dir(state_dir)) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !name.starts_with(STAGING_PREFIX))
        })
        .collect();
    dirs.sort();
    dirs
}

/// そのフォルダに3本が揃っているか。
///
/// 揃っていない版を選ばせると、パーサだけ食い違った状態で動き出す。置く途中は
/// [`STAGING_PREFIX`] で防げるが、**人が手で触った場合まで防げるのは検査だけ。**
pub fn is_complete(version_dir: &Path) -> bool {
    BINARIES.iter().all(|name| version_dir.join(name).is_file())
}

/// 保管庫の実行ファイルから版を引く（`<versions>/<版>/agentdashboard` のフォルダ名）。
pub fn version_of_stored(binary: &Path) -> Option<VersionId> {
    let name = binary.parent()?.file_name()?.to_str()?;
    (!name.starts_with(STAGING_PREFIX)).then(|| VersionId::new(name))
}

/// `--version` を叩いて版を聞く。
///
/// 標準入力を塞ぐのは [`crate::model_catalog`] と同じ理由——`--version` を知らない
/// 実行ファイルが対話ループへ落ちて、待ち続けるのを避けるため。
pub fn version_of_cli(binary: &Path) -> Option<VersionId> {
    let output = std::process::Command::new(binary)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // `agentdashboard 0.1.0` の形。数字の並びだけを取る
    let version: String = text
        .chars()
        .skip_while(|ch| !ch.is_ascii_digit())
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
        .collect();
    (!version.is_empty()).then(|| VersionId::new(version))
}

/// パーサの版を聞く。
///
/// **`transcript-parser` は `--version` を持たない**（引数を読まずに IPC のループへ入る）。
/// 代わりに起こすと1行目に名乗りが出るので、それを読む（設計§20-2）。`--version` を
/// 足す道は採らない——あのファイルは自己修復が書き換えてよい範囲なので、版を確かめる
/// 手段をそこへ置くと、確かめる側が書き換えられる側に依存してしまう。
pub fn version_of_parser(binary: &Path) -> Option<VersionId> {
    let output = std::process::Command::new(binary)
        // 標準入力を閉じれば、名乗りを出したあと EOF で終わる
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?;
    let hello: serde_json::Value = serde_json::from_str(line).ok()?;
    let version = hello.get("parser_version")?.as_str()?;
    (!version.is_empty()).then(|| VersionId::new(version))
}

/// 3本のうち、その名前のものの版を聞く。
pub fn version_of(binary: &Path) -> Option<VersionId> {
    match binary.file_name().and_then(|name| name.to_str()) {
        Some("transcript-parser") => version_of_parser(binary),
        _ => version_of_cli(binary),
    }
}

/// 初回退避の元を決める。既定は `current_exe()` の親（＝入れる側が置いた場所）。
pub fn source_dir() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var(VERSION_SOURCE_ENV) {
        return Some(PathBuf::from(raw));
    }
    std::env::current_exe()
        .ok()?
        .parent()
        .map(Path::to_path_buf)
}

/// 入れる側が置いた3本を保管庫へ控える（設計§6）。
///
/// これが無いと、機能を入れた瞬間の選択肢は1つしか無い。「戻せます」と書いてあるのに
/// **いちばん戻りたい先（この機能を入れる直前の版）へ戻れない。**
///
/// **ポインタは書かない。** 書いた瞬間に以後の起動が全部保管庫へ乗り換える——利用者が
/// 何も選んでいないのに、走る実行ファイルが変わることになる。退避は「選べる先を1つ
/// 増やす」だけの操作である。
///
/// 既に同じ版が在れば何もしない（`Ok(None)`）。上書きしないのは設計§3 の約束であり、
/// ソースから建てている機械で作り直すたびに数十MB を書き直さないためでもある。
pub fn snapshot(state_dir: &Path, source: &Path) -> anyhow::Result<Option<VersionId>> {
    for name in BINARIES {
        let path = source.join(name);
        if !path.is_file() {
            // 箱の中には1本しか入っていない。3本揃っていない場所は退避元ではない
            return Ok(None);
        }
    }

    let Some(version) = version_of(&source.join(BINARIES[0])) else {
        anyhow::bail!("退避元の版を聞けません: {}", source.display());
    };

    let destination = versions_dir(state_dir).join(version.as_str());
    if destination.is_dir() {
        return Ok(None);
    }

    // 揃えてからフォルダごと rename する。同じ置き場所の中の rename は途中で切れないので、
    // `versions/<版>/` が在るなら中身は必ず揃っている
    let staging = versions_dir(state_dir).join(format!("{STAGING_PREFIX}{version}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    for name in BINARIES {
        std::fs::copy(source.join(name), staging.join(name))?;
    }
    std::fs::rename(&staging, &destination)?;
    Ok(Some(version))
}

/// 自己修復が差し替えたパーサのポインタを外す（設計§17・§20-4）。
///
/// 差し替え済みのパーサは古いソースからビルドされているので、新しい本体と IPC の形が
/// 噛み合う保証が無い。「戻す先」も落とすのは、版をまたいで生き残ると**新しい版で
/// 自己修復が巻き戻したときに前の版が作ったパーサへ戻してしまう**ため。
///
/// **どの版が書いたポインタかは判定しない。** 乗り換えが起きたということは走る版が
/// 変わったということで、どの版が書いたものであれ噛み合う保証が無い。
pub fn drop_selfheal_parser(state_dir: &Path) {
    let pointer = state_dir.join(crate::parser::PARSER_POINTER);
    if pointer.exists() {
        let _ = std::fs::remove_file(&pointer);
    }
    let mut state = crate::selfheal::state::SelfhealState::load(state_dir);
    if state.previous_parser.is_some() {
        state.previous_parser = None;
        state.save(state_dir);
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-version-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn ポインタは書いて読んで消せる() {
        let dir = temp_dir("pointer-roundtrip");
        let binary = dir.join("agentdashboard");
        touch(&binary);

        write_pointer(&dir, Some(&binary));
        assert_eq!(read_pointer(&dir), Some(binary));

        write_pointer(&dir, None);
        assert_eq!(read_pointer(&dir), None, "消せば入れる側の版へ戻る");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 指す先が消えていたら既定へ落ちる() {
        // 選んだ版を誰かが消しても、起動できなくなるほうが困る
        let dir = temp_dir("pointer-dangling");
        write_pointer(&dir, Some(&dir.join("居ない")));

        assert_eq!(read_pointer(&dir), None);
        assert_eq!(resolve_target(&dir), None, "乗り換えずに自分で続ける");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 置いている途中のフォルダは走査に拾われない() {
        let dir = temp_dir("scan-staging");
        touch(&versions_dir(&dir).join("0.1.0").join("agentdashboard"));
        touch(
            &versions_dir(&dir)
                .join(".staging-0.2.0")
                .join("agentdashboard"),
        );

        let found: Vec<String> = stored_versions(&dir)
            .iter()
            .filter_map(|path| path.file_name()?.to_str().map(str::to_string))
            .collect();

        assert_eq!(found, vec!["0.1.0".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 三本揃っていない版は不完全として扱う() {
        let dir = temp_dir("complete");
        let full = versions_dir(&dir).join("0.1.0");
        for name in BINARIES {
            touch(&full.join(name));
        }
        let partial = versions_dir(&dir).join("0.2.0");
        touch(&partial.join("agentdashboard"));

        assert!(is_complete(&full));
        assert!(!is_complete(&partial), "隣が別の版だとパーサが食い違う");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 保管庫の実行ファイルからは版がフォルダ名で引ける() {
        let stored = versions_dir(Path::new("/state"))
            .join("0.1.1")
            .join("agentdashboard");
        assert_eq!(version_of_stored(&stored), Some(VersionId::new("0.1.1")));

        let staging = versions_dir(Path::new("/state"))
            .join(".staging-0.2.0")
            .join("agentdashboard");
        assert_eq!(
            version_of_stored(&staging),
            None,
            "置いている途中は数えない"
        );
    }

    #[test]
    fn 印は書いて取り出すと消える() {
        let dir = temp_dir("attempt");
        let target = dir.join("versions").join("0.2.0").join("agentdashboard");

        write_attempt(&dir, &target);
        assert!(attempt_path(&dir).is_file());

        let attempt = take_attempt(&dir).expect("印があること");
        assert_eq!(attempt.target, target.to_string_lossy());
        assert!(attempt.at > 0);
        assert!(!attempt_path(&dir).is_file(), "取り出したら消える");
        assert_eq!(take_attempt(&dir), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 結末は書いて読み直せる() {
        let dir = temp_dir("outcome");
        assert_eq!(read_outcome(&dir), None, "まだ何も起きていない");

        let outcome = Outcome {
            attempted: Some(VersionId::new("0.2.0")),
            attempted_path: "/state/versions/0.2.0/agentdashboard".to_string(),
            running: VersionId::new("0.1.1"),
            failed_reason: Some("待ち受けまで届きませんでした".to_string()),
            at: now_ms(),
        };
        write_outcome(&dir, &outcome);

        assert_eq!(read_outcome(&dir), Some(outcome));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 使える構成かは材料から決まる() {
        let unix = Capability {
            can_hand_over: true,
            in_container: false,
            forced: None,
        };
        assert!(unix.supported());

        // 箱の中で入れ替えても、次に起こし直すと消える
        assert!(
            !Capability {
                in_container: true,
                ..unix
            }
            .supported()
        );
        // Windows には乗り換えの手段が無い（設計§20-5）
        assert!(
            !Capability {
                can_hand_over: false,
                ..unix
            }
            .supported()
        );
        // 上書きはどちらの向きにも効く。**テストは箱の中で走る**ので、これが無いと
        // 有効側の道を一度も通せない
        assert!(
            Capability {
                in_container: true,
                forced: Some(true),
                ..unix
            }
            .supported()
        );
        assert!(
            !Capability {
                forced: Some(false),
                ..unix
            }
            .supported()
        );
    }

    #[test]
    fn 自己修復のポインタと戻す先を落とせる() {
        let dir = temp_dir("drop-selfheal");
        let parser = dir.join("差し替えたパーサ");
        touch(&parser);
        std::fs::write(
            dir.join(crate::parser::PARSER_POINTER),
            parser.to_string_lossy().as_bytes(),
        )
        .unwrap();
        let mut state = crate::selfheal::state::SelfhealState::load(&dir);
        state.previous_parser = Some(parser.clone());
        state.save(&dir);

        drop_selfheal_parser(&dir);

        assert!(
            !dir.join(crate::parser::PARSER_POINTER).exists(),
            "版が変われば噛み合う保証が無い"
        );
        assert_eq!(
            crate::selfheal::state::SelfhealState::load(&dir).previous_parser,
            None,
            "版をまたいで生き残ると、前の版が作ったパーサへ戻してしまう"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
