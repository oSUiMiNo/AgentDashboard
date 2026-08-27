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

/// 版ごとの実行ファイルを置くフォルダの名前（[`crate::config::SessionHostConfig::resolved_state_dir`] 配下）。
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
/// [`crate::config::SessionHostConfig::resolved_state_dir`] が同じ轍を踏んで直した経緯がある。
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
            if let Err(err) = std::fs::create_dir_all(state_dir) {
                tracing::warn!(
                    dir = %state_dir.display(),
                    %err,
                    "版のポインタの置き場所を作れません"
                );
            }
            if let Err(err) = std::fs::write(&pointer, path.to_string_lossy().as_bytes()) {
                tracing::warn!(
                    pointer = %pointer.display(),
                    target = %path.display(),
                    %err,
                    "版のポインタを書けません。次に起こしても切り替わりません"
                );
            }
        }
        None => {
            // **もともと無いのは正常な呼ばれ方**（切り替えていない利用者の解除）なので
            // そこでは黙る。素で言うと、起こすたびに鳴って読まれなくなる
            if let Err(err) = std::fs::remove_file(&pointer)
                && err.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(
                    pointer = %pointer.display(),
                    %err,
                    "版のポインタを消せません。次に起こすと、外したはずの版へ戻ります"
                );
            }
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

/// 入れる側（またはビルド）が置いた実行ファイル。
///
/// **実在するときだけ答える。** [`resolve_target`] がポインタの先を `is_file()` で
/// 確かめているのと同じ理由——**無い場所を「次に起きる版」として返すと、押す前の門が
/// 「起動できません」と断り、入れ替えそのものができなくなる**。行き先が無いなら
/// 「行き先なし」と答えて、今までどおり落ちる道へ倒すのが正しい。
pub fn installed_binary() -> Option<PathBuf> {
    let path = source_dir()?.join(BINARIES[0]);
    path.is_file().then_some(path)
}

/// **いま起こし直したら、どれで立ち上がるか。**
///
/// 画面が知りたいのは「予約があるか」ではなく、この問いの答えである。
///
/// | 構成 | 答え |
/// |---|---|
/// | 予約あり（配った版の標準） | 保管庫のその版（[`resolve_target`]） |
/// | **予約なし（ソースビルドの機械）** | **入れる側／ビルドが置いた版** |
///
/// **起動時の乗り換えと同じ関数を通す。** 別々に組み立てると、**画面が言った版と実際に
/// 立ち上がる版が食い違う**——いちばん信用を失う壊れ方である。起動時はこの答えが
/// 「いまの自分」と同じことが普通なので、[`is_other_binary`] が乗り換えを止める。
pub fn next_binary(state_dir: &Path) -> Option<PathBuf> {
    resolve_target(state_dir).or_else(installed_binary)
}

/// 走っているものと、次に起きるものが**違うか**（設計§5）。
///
/// # 実パスの比較では足りない
///
/// 版番号を上げずに `make build` を繰り返す運用があるので、**パスも版名も同じで中身だけ
/// 新しい**状態になる。実パスで比べても差が出ない。
///
/// # 保管庫を見ない
///
/// [`snapshot`] は `versions/<版>/` が既にあると上書きしないので、**版番号を上げない
/// ビルドは保管庫に一切反映されない**。保管庫から判定を作ると、この運用では永久に
/// 「変わっていない」と答える。**覚えた値と、いまのファイルだけを見る。**
///
/// 材料を受け取る純関数にしてあるのは、3通り（版名違い・中身だけ違い・同じ）を
/// 単体で固めるため。
pub fn differs(
    running_version: &VersionId,
    running: &RunningBinary,
    next_version: Option<&VersionId>,
    next_built_at: Option<Timestamp>,
) -> bool {
    // 行き先の版が読めないなら、違うとは言えない。**分からないまま押させない**
    let Some(next_version) = next_version else {
        return false;
    };
    if next_version != running_version {
        return true;
    }
    // 版名が同じなら、中身が入れ替わったかどうかはビルド時刻でしか分からない。
    // どちらかが読めなければ**違わない側へ倒す**（同上）
    match (running.built_at, next_built_at) {
        (Some(running_at), Some(next_at)) => running_at != next_at,
        _ => false,
    }
}

/// 行き先が「いまの自分」と違うか。
///
/// **版名ではなく実パスで比べる。** 手元でビルドした版と配った同じ番号の版は同じ名前を
/// 名乗る（ワークスペースの版は1箇所にしか無い）ので、名前で比べると乗り換えが起きない。
/// 解決に失敗したときは**乗り換えないほうへ倒す**——分からないまま乗り換えるより安全。
///
/// **これは起動時の判定である。** 走行中の入れ替えは [`differs`] を使う——実機では
/// **同じパスに別の中身が乗る**ので、パスの比較では差が出ない。
pub fn is_other_binary(target: &Path) -> bool {
    let Ok(current) = std::env::current_exe() else {
        return false;
    };
    !same_path(target, &current)
}

/// 2つのパスが同じ実行ファイルを指すか。
///
/// **版名では比べない。** 同じ番号の版が複数の場所に居る（ソースから建てた版と配った版）
/// ので、名前で比べると別物を同じと見なしてしまう。解決に失敗したパスは書かれたまま
/// 比べる——`canonicalize` はハードリンクを解決しないので、テストが版フォルダをリンクで
/// 作っても実パスの比較は成立する（設計§21-7）。
pub fn same_path(left: &Path, right: &Path) -> bool {
    real_path(left) == real_path(right)
}

/// 解決できるところまで解決したパス。解決できなければ書かれたまま。
fn real_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
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

/// 走っている実行ファイルができた時刻（ファイルの更新時刻）。読めなければ `None`。
///
/// # なぜ「リリース日」をこれで答えるのか
///
/// 献立表（`dist-manifest.json`）に日付は入っていない。GitHub の API には
/// `published_at` があるが、あれは ISO8601 なので**暦を解釈する道具**が要る——その依存は
/// 「`transcript-parser` だけが持つ」と決めてあり（`server/Cargo.toml`）、自前で計算すると
/// 閏年の周りで静かに間違える。**ファイルの時刻なら epoch がそのまま取れる。**
///
/// 配った実行ファイルなら、これは CI がその版を作った時刻になる（実測で確認）。
/// ソースからビルドしたものなら、自分がビルドした時刻。どちらも「**この実行ファイルは
/// いつのものか**」に答えている。
pub fn binary_at() -> Option<Timestamp> {
    running_binary().built_at
}

/// 走っている実行ファイルについて、**起動時に一度だけ**解いた答え。
///
/// # なぜ覚えるのか
///
/// **`make build` は走っているプロセスの実体を消す**（同じ名前の新しい実体を作って
/// 差し替える）。そのあと `current_exe()` を読むと、カーネルは行き先に `(deleted)` を
/// 付けて答える——**存在しないパス**なので、そこから先が全部倒れる。
///
/// | 聞き直すと | どうなるか |
/// |---|---|
/// | `canonicalize()` | 失敗し、`(deleted)` 付きの生の文字列が残る。どの版の行とも一致しない |
/// | `metadata()` | 失敗し、ビルド時刻が `null` になる |
///
/// **起動した瞬間はまだ差し替えられていない**ので、そのとき一度だけ聞けば正しい答えが
/// 手に入る。[`started_at`] と同じ性質（起動時に決まって以後動かない）なので、同じ作法で
/// 持つ。
#[derive(Debug, Clone)]
pub struct RunningBinary {
    /// 解決済みの実パス。解決に失敗したときだけ `current_exe()` の生の値。
    pub path: Option<PathBuf>,
    /// ビルド時刻（ファイルの更新時刻）。
    pub built_at: Option<Timestamp>,
}

/// 走っている実行ファイルの素性（起動時に一度だけ決まる）。
pub fn running_binary() -> &'static RunningBinary {
    static RUNNING: std::sync::OnceLock<RunningBinary> = std::sync::OnceLock::new();
    RUNNING.get_or_init(|| {
        let raw = std::env::current_exe().ok();
        RunningBinary {
            built_at: raw.as_deref().and_then(file_time),
            path: raw.map(|path| real_path(&path)),
        }
    })
}

/// **行き先の**実行ファイルができた時刻。読めなければ `None`。
///
/// [`binary_at`] は走っている自分のもので、こちらは**これから起きるほう**。
/// 版名が同じでも中身が入れ替わったかを見分けるのに要る（[`differs`]）。
pub fn built_at_of(path: &Path) -> Option<Timestamp> {
    file_time(path)
}

/// ファイルの更新時刻を epoch ミリ秒で読む。
fn file_time(path: &Path) -> Option<Timestamp> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_millis() as Timestamp)
}

/// このプロセスが起きた時刻。
///
/// **一度決まったら動かない。** 起動のいちばん早いところで一度触ることで、
/// 「プロセスの起動時刻」として確定する（`crates/core/src/cli.rs`）。触られないまま
/// 画面から呼ばれた場合はその時刻になるが、そのときは**起動から間もない**ので実害が無い。
///
/// 実行ファイルの時刻（[`binary_at`]）と対にして出す。箱で動かしていると前者は
/// 「その版が作られた時刻」、こちらは「入れ替えた時刻」になり、**更新したのか
/// 再起動しただけなのか**が区別できる。
pub fn started_at() -> Timestamp {
    static STARTED_AT: std::sync::OnceLock<Timestamp> = std::sync::OnceLock::new();
    *STARTED_AT.get_or_init(crate::session::now_ms)
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

/// そのフォルダの3本が、揃っていて同じ版を名乗るか（設計§6）。
///
/// [`is_complete`] は**在るかどうか**しか見ない。3本が別々の版だと、パーサだけ食い違った
/// 状態で動き出す——落としてもいないのに構造化ビューが壊れる形なので、選ばせる前に断る。
///
/// 断る理由を文字列で返すのは、**選択肢から消さずに理由を添える**ため（設計§14）。
/// 黙って消すと「置いたはずの版が出てこない」になり、利用者が原因まで辿れない。
pub fn versions_agree(version_dir: &Path) -> Result<VersionId, String> {
    let mut named: Vec<(&str, VersionId)> = Vec::new();
    for name in BINARIES {
        let path = version_dir.join(name);
        if !path.is_file() {
            return Err(format!("3本揃っていません（{name} がありません）"));
        }
        let Some(version) = version_of(&path) else {
            return Err(format!("版を聞けません（{name}）"));
        };
        named.push((name, version));
    }

    let (_, first) = &named[0];
    if named.iter().all(|(_, version)| version == first) {
        return Ok(first.clone());
    }

    // どれが何を名乗ったかを全部書く。**片方を代表として選ばない**（設計§6）
    let detail = named
        .iter()
        .map(|(name, version)| format!("{name} {version}"))
        .collect::<Vec<_>>()
        .join(" / ");
    Err(format!("3本の版が食い違っています（{detail}）"))
}

/// 3本の合計の大きさ。**黙って溜まる形にしない**ため、画面へ出す（設計§14）。
fn size_of(version_dir: &Path) -> u64 {
    BINARIES
        .iter()
        .filter_map(|name| std::fs::metadata(version_dir.join(name)).ok())
        .map(|meta| meta.len())
        .sum()
}

/// 一覧の1行を作る。
fn entry_of(
    version_dir: &Path,
    version: VersionId,
    origin: protocol::VersionOrigin,
    reason: Option<String>,
    current_exe: Option<&Path>,
    pointer: Option<&Path>,
) -> protocol::VersionEntry {
    let binary = version_dir.join(BINARIES[0]);
    // **パスが一致しただけでは「走っている」と言わない**（設計§3）。
    //
    // `make build` は**同じパスに別の中身**を置く。パスだけで比べると、ビルドした
    // ばかりの行が「これが走っています」と嘘をつく。版名を足しても足りない——版番号を
    // 上げずに建て直す運用があるので、**中身が変わったかはビルド時刻でしか分からない**。
    //
    // 読めないときは印を付けない側へ倒す。**この印は「消せない」を決める材料ではない**
    // （そちらは `remove_version` が自分で確かめる）ので、外しても安全側に落ちる。
    let running = current_exe.is_some_and(|current| same_path(&binary, current))
        && version == running_version()
        && built_at_of(&binary) == running_binary().built_at;
    protocol::VersionEntry {
        version,
        origin,
        running,
        selected: pointer.is_some_and(|pointer| same_path(&binary, pointer)),
        usable: reason.is_none(),
        size_bytes: size_of(version_dir),
        path: binary.to_string_lossy().into_owned(),
        reason,
    }
}

/// 版の一覧を組み立てる（設計§6）。
///
/// 並ぶのは**出どころの違う3種類**——入れる側が置いた版・保管庫の版・いま走っている版。
/// 後ろ2つは重なりうる（乗り換えていれば走っているのは保管庫の版）ので、行としては
/// 「入れる側」と「保管庫」の2種類を出し、走っているかどうかは印で示す。
///
/// # 3本に版を聞くので、版の数だけプロセスが起きる
///
/// 1つの版あたり3回。保管庫の版数はせいぜい数個なので毎回聞いてよい（実測は設計§22）。
/// 数が増えたら控えを持つことになるが、**先に測ってから決める。**
pub fn list_versions(state_dir: &Path, source: Option<&Path>) -> Vec<protocol::VersionEntry> {
    // **聞き直さない。** 差し替えられていると `(deleted)` 付きの生の文字列が返り、
    // どの行とも一致しなくなる（設計§2）
    let current_exe = running_binary().path.clone();
    let pointer = read_pointer(state_dir);
    let mut entries = Vec::new();

    for dir in stored_versions(state_dir) {
        let Some(named) = version_of_stored(&dir.join(BINARIES[0])) else {
            continue;
        };
        // 名乗りがフォルダ名と違えば、画面の表示が実際に走るものと食い違う。
        // 選ぶのはパスでも、**人が見て選ぶのは名前**なので、ここは断る側へ倒す
        let reason = match versions_agree(&dir) {
            Ok(actual) if actual == named => None,
            Ok(actual) => Some(format!(
                "中身は {actual} です（フォルダ名と食い違っています）"
            )),
            Err(reason) => Some(reason),
        };
        entries.push(entry_of(
            &dir,
            named,
            protocol::VersionOrigin::Stored,
            reason,
            current_exe.as_deref(),
            pointer.as_deref(),
        ));
    }

    if let Some(source) = source {
        // 入れる側が置いた場所は保管庫の外にある。乗り換えた後は `current_exe()` が
        // 保管庫を指すので、同じ行が二度並ばないよう出どころで弾く
        let inside_store = source.starts_with(versions_dir(state_dir));
        if !inside_store {
            let agreed = versions_agree(source);
            // 名乗れる版が1つも無ければ行にできない。**名前の無い行を並べない**
            if let Some(version) = agreed
                .as_ref()
                .ok()
                .cloned()
                .or_else(|| version_of(&source.join(BINARIES[0])))
            {
                entries.push(entry_of(
                    source,
                    version,
                    protocol::VersionOrigin::Installed,
                    agreed.err(),
                    current_exe.as_deref(),
                    pointer.as_deref(),
                ));
            }
        }
    }

    // 3つ組の順に並べる。同じ版名の行が複数並ぶので、出どころとパスで決着させる
    entries.sort_by(|left, right| {
        let key = |entry: &protocol::VersionEntry| {
            (
                matches!(entry.origin, protocol::VersionOrigin::Stored),
                entry.path.clone(),
            )
        };
        left.version
            .cmp(&right.version)
            .then_with(|| key(left).cmp(&key(right)))
    });
    entries
}

/// 初回退避と一覧が使う「入れる側が置いた場所」を決める。
pub fn source_dir() -> Option<PathBuf> {
    source_dir_from(
        std::env::var(VERSION_SOURCE_ENV).ok(),
        already_handed_over()
            .then(|| std::env::var(crate::session::hooks_settings::HOOK_BIN_ENV).ok())
            .flatten(),
        std::env::current_exe().ok(),
    )
}

/// 退避元の決め方（材料を受け取る純粋関数）。
///
/// 環境変数を先に見るのは [`crate::parser::parser_program`] と同じ理由——**差し替え口が
/// 無いと、テストのたびに利用者の実インストールから数十MB がコピーされる。**
/// 判定を分けてあるのは、テストが環境変数を書き換えずに両方の道を通せるようにするため。
///
/// # 乗り換えた後は `current_exe()` を使えない
///
/// 乗り換えると `current_exe()` は保管庫を指す。そのまま退避元にすると、保管庫から
/// 保管庫へ控えることになり、一覧では**同じ行が「入れる側」としても並ぶ**。
/// 乗り換える側は入口を [`crate::session::hooks_settings::HOOK_BIN_ENV`] へ渡している
/// （設計§5）ので、**乗り換え済みのときだけ**そちらを使う。
pub fn source_dir_from(
    configured: Option<String>,
    handover_entry: Option<String>,
    current_exe: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(raw) = configured.filter(|raw| !raw.is_empty()) {
        return Some(PathBuf::from(raw));
    }
    if let Some(entry) = handover_entry.filter(|raw| !raw.is_empty()) {
        if let Some(parent) = PathBuf::from(entry).parent().map(Path::to_path_buf) {
            return Some(parent);
        }
    }
    current_exe?.parent().map(Path::to_path_buf)
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

/// 置いた先に3本以外が残っていないか。
///
/// 配布インストーラは**置き場所の中に一時フォルダを作り、その片付けは失敗を無視する**
/// 作りになっている（実測）。途中で死ぬと残骸が入ったまま公開されてしまい、画面へ出す
/// 使用量も嘘になる。[`versions_agree`] は3本の在・不在しか見ないので、ここで数える。
fn only_binaries(dir: &Path) -> Result<(), String> {
    let entries =
        std::fs::read_dir(dir).map_err(|error| format!("置き場所を読めません: {error}"))?;
    let mut extra: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !BINARIES.contains(&name.as_str()))
        .collect();
    if extra.is_empty() {
        return Ok(());
    }
    extra.sort();
    Err(format!("3本のほかに残っています（{}）", extra.join(" / ")))
}

/// 取ってきて保管庫へ置く（設計§7）。
///
/// **後条件は窓口の向こうへ置かない。** 差し替えたテストでも検査が残るようにするためで、
/// 窓口がやるのは「取ってきて `staging` へ展開する」ところまで。数えてから公開する。
///
/// 見るのは3つ。**3本だけであること**（残骸を公開しない）、**3本が同じ版を名乗ること**
/// （パーサだけ食い違うと落としてもいないのに構造化ビューが壊れる）、そして**頼んだ版と
/// 中身が一致すること**（名前が嘘をつく行を選ばせると「0.2.0 を選んだのに 0.1.1 が動く」
/// になる）。
///
/// **ポインタは書かない。** [`snapshot`] と同じ約束で、取ってきただけで走る実行ファイルが
/// 変わるのは要件が名指しで恐れている「勝手に更新される」そのものである。
///
/// 錠は取らない。[`remove_version`] と同じく**口の側が取る**——操作の直列化は口の仕事で、
/// ここへ持たせると口が2通りの錠の掛け方を持つことになる。
pub fn install_version(
    state_dir: &Path,
    ops: &dyn crate::version_ops::VersionOps,
    version: &VersionId,
) -> Result<VersionId, String> {
    // 既にある版は取り直さない（[`snapshot`] と揃える）。取り直すには先に消す——
    // 上書きの道を作ると「走っている版を置き換える」道が生まれる
    if stored_version_dir(state_dir, version).is_some() {
        return Err(format!(
            "すでに保管庫にあります: {version}。取り直すなら先に消してください"
        ));
    }

    let versions = versions_dir(state_dir);
    std::fs::create_dir_all(&versions).map_err(|error| format!("保管庫を作れません: {error}"))?;
    let staging = versions.join(format!("{STAGING_PREFIX}{version}"));
    let _ = std::fs::remove_dir_all(&staging);

    let outcome = ops.install(version, &staging);
    if !outcome.success {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("取ってこられません: {}", outcome.output));
    }

    let placed = only_binaries(&staging)
        .and_then(|()| versions_agree(&staging))
        .and_then(|placed| {
            if &placed == version {
                Ok(placed)
            } else {
                Err(format!(
                    "頼んだ版と中身が違います（頼んだ {version} / 入っていた {placed}）"
                ))
            }
        });
    let placed = match placed {
        Ok(placed) => placed,
        Err(reason) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(reason);
        }
    };

    // 揃えてからフォルダごと rename する（[`snapshot`] と同じ理由）
    if let Err(error) = std::fs::rename(&staging, versions.join(version.as_str())) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("保管庫へ移せません: {error}"));
    }
    Ok(placed)
}

/// 保管庫のその版のフォルダ。無ければ `None`。
///
/// 「在るかどうか」と「消せるかどうか」を分けてあるのは、**口が断り方を言い分けられる
/// ようにする**ため（無いものは「無い」、走っているものは「いま使っている」）。
pub fn stored_version_dir(state_dir: &Path, version: &VersionId) -> Option<PathBuf> {
    let dir = versions_dir(state_dir).join(version.as_str());
    dir.is_dir().then_some(dir)
}

/// 保管庫から版を消す（設計§12）。
///
/// 断るのは**いま走っている版だけ**。予約されている版は消せるが、その場合は
/// **消す前にポインタを確かめ、消したら外す**——消してからポインタを直すと、
/// その隙に起動した版が理由の分からないまま既定へ落ちる。
///
/// 入れる側が置いた3本は保管庫の外にあるので、**構造的に対象外**（消す道の持ち物であり、
/// この関数はフォルダ名でしか版を受け取らない）。
///
/// 壊れた版（3本揃っていない・版が食い違う）は消せる。むしろ消せないと、置く途中で
/// 切れた残骸を人が手で片付けることになる。
pub fn remove_version(state_dir: &Path, version: &VersionId) -> Result<(), String> {
    let Some(dir) = stored_version_dir(state_dir, version) else {
        return Err(format!("保管庫にありません: {version}"));
    };

    let binary = dir.join(BINARIES[0]);
    // **聞き直さない**（設計§2）。差し替えられていると `(deleted)` 付きの生の文字列が
    // 返り、**守りが静かに外れる**——走っている版を消せてしまう
    if running_binary()
        .path
        .as_deref()
        .is_some_and(|current| same_path(&binary, current))
    {
        return Err("いま走っている版は消せません".to_string());
    }

    let selected = read_pointer(state_dir)
        .is_some_and(|pointer| real_path(&pointer).starts_with(real_path(&dir)));
    if selected {
        write_pointer(state_dir, None);
    }

    std::fs::remove_dir_all(&dir).map_err(|err| format!("消せません: {err}"))
}

/// 版の操作の錠の名前。
pub const VERSION_LOCK: &str = "version-lock.json";

/// 調べる手立てが無いときに錠を見切るまでの時間。
///
/// 取ってくる操作は数十秒かかりうるので、短くしすぎると正常な操作を横取りされる。
const LOCK_STALE_AFTER_MS: Timestamp = 10 * 60 * 1000;

/// 版の操作の錠（設計§13）。
///
/// **プロセスをまたぐ**（落として、新しいプロセスが立ち上がってくる）ので、プロセスの中の
/// 錠では足りない。一方この機能では終了時の後片付けが走らない（シグナルを受け取る仕掛けが
/// 無い）ので、**錠は必ず残る前提で作る**——記録の形を直すときの助言ロックが同じ罠を
/// 書いている。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Lock {
    pub pid: u32,
    /// 取った相手の開始時刻。**PID は使い回されるので、これが無いと別物を
    /// 「まだ居る」と誤判定する。**
    pub started_at: Option<u64>,
    /// 取った時刻（エポックミリ秒）。
    pub at: Timestamp,
}

/// 錠を取った相手の様子（判定の材料）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holder {
    /// その PID が居て、開始時刻も一致する。
    Alive,
    /// もう居ない。
    Gone,
    /// 居るが別物（PID の使い回し）。
    Replaced,
    /// 調べる手立てが無い。
    Unknown,
}

/// 残っている錠を無視してよいか（材料を受け取る純粋関数）。
///
/// 調べられないときに永久に断ると、**一度落ちただけで二度と操作できなくなる**。
/// そこだけ時間で見切る。
pub fn lock_is_stale(holder: Holder, age_ms: Timestamp) -> bool {
    match holder {
        Holder::Alive => false,
        Holder::Gone | Holder::Replaced => true,
        Holder::Unknown => age_ms > LOCK_STALE_AFTER_MS,
    }
}

/// `/proc/<pid>/stat` から開始時刻（22番目の項目）を読む。
///
/// 2番目の項目は括弧で囲まれ、**中に空白や括弧を含みうる**ので、最後の `)` で切ってから
/// 数える。`)` の次は3番目なので、22番目は19個先。
fn start_time_from_stat(text: &str) -> Option<u64> {
    let rest = text.rsplit_once(')')?.1;
    rest.split_whitespace().nth(19)?.parse().ok()
}

/// その PID の開始時刻。読めなければ `None`。
fn start_time_of(pid: u32) -> Option<u64> {
    start_time_from_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// 錠を取った相手の様子を調べる（材料集め）。
pub fn probe_holder(lock: &Lock) -> Holder {
    if lock.pid == 0 {
        return Holder::Gone;
    }
    if !Path::new("/proc/self/stat").is_file() {
        // `/proc` を持たない OS。ここで `Gone` に倒すと、生きている相手の錠を奪う
        return Holder::Unknown;
    }
    match (lock.started_at, start_time_of(lock.pid)) {
        (_, None) => Holder::Gone,
        (Some(recorded), Some(actual)) if recorded != actual => Holder::Replaced,
        _ => Holder::Alive,
    }
}

/// 錠の場所。
pub fn lock_path(state_dir: &Path) -> PathBuf {
    state_dir.join(VERSION_LOCK)
}

fn read_lock(state_dir: &Path) -> Option<Lock> {
    let path = lock_path(state_dir);
    path.is_file()
        .then(|| crate::jsonfile::load_or_default::<Lock>(&path))
        .filter(|lock| lock.pid != 0)
}

/// 版の操作の錠を取る。取れなければ断る理由を返す。
///
/// 順番待ちはしない。**長く持つ錠の手前で待たせない**——押した人には、いま動いている
/// ことをその場で伝えるほうがよい。
pub fn acquire_lock(state_dir: &Path) -> Result<(), String> {
    if let Some(existing) = read_lock(state_dir) {
        if !lock_is_stale(
            probe_holder(&existing),
            now_ms().saturating_sub(existing.at),
        ) {
            return Err("いま別の版の操作が動いています".to_string());
        }
    }
    let pid = std::process::id();
    crate::jsonfile::save(
        &lock_path(state_dir),
        &Lock {
            pid,
            started_at: start_time_of(pid),
            at: now_ms(),
        },
    );
    Ok(())
}

/// 錠を返す。
pub fn release_lock(state_dir: &Path) {
    let _ = std::fs::remove_file(lock_path(state_dir));
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

    /// ポインタの書き込みが声を持つこと（設計§10-3）。
    ///
    /// **無音だと「更新したのに次に起こしても切り替わらない」の理由がどこにも残らない。**
    mod ポインタが声を持つ {
        use super::*;
        use crate::logging::capture;

        fn 行(mark: usize, 含む: &str) -> Vec<serde_json::Value> {
            capture::sink()
                .since(mark)
                .into_iter()
                .filter(|line| {
                    line.get("msg")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|msg| msg.contains(含む))
                })
                .collect()
        }

        #[test]
        fn 書けないときは置き場所と書き込みの両方が残る() {
            // 置き場所の位置にファイルを置く。**読み取り専用ディレクトリは使わない**
            // ——CI が root だと効かない
            let blocked = temp_dir("pointer-blocked").join("塞ぎ");
            std::fs::write(&blocked, "邪魔").unwrap();

            let sink = capture::sink();
            let mark = sink.mark();
            write_pointer(&blocked, Some(Path::new("/bin/true")));

            assert_eq!(行(mark, "版のポインタの置き場所を作れません").len(), 1);
            let 書けない = 行(mark, "版のポインタを書けません");
            assert_eq!(書けない.len(), 1, "{書けない:#?}");
            assert_eq!(書けない[0]["level"], "WARN");
        }

        #[test]
        fn もともと無いときは黙る() {
            // 切り替えていない利用者の解除は正常な道。ここで鳴ると起こすたびに増える
            let dir = temp_dir("pointer-absent");
            let sink = capture::sink();
            let mark = sink.mark();
            write_pointer(&dir, None);
            assert!(
                行(mark, "版のポインタを消せません").is_empty(),
                "初回の解除で鳴ってはいけない"
            );
        }

        #[test]
        fn 消せないときは理由が残る() {
            let dir = temp_dir("pointer-undeletable");
            // ポインタの位置をディレクトリで塞ぐ
            std::fs::create_dir_all(pointer_path(&dir)).unwrap();

            let sink = capture::sink();
            let mark = sink.mark();
            write_pointer(&dir, None);

            assert_eq!(行(mark, "版のポインタを消せません").len(), 1);
        }
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
    fn 三本とも同じ版を名乗れば選べる() {
        let dir = temp_dir("agree-ok");
        write_fake_install(&dir, "0.1.1");
        assert_eq!(versions_agree(&dir), Ok(VersionId::new("0.1.1")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 三本の版が食い違う版は選べない() {
        // 揃っているかだけでは足りない。隣が別の版だと**パーサだけ食い違って動き出す**
        let dir = temp_dir("agree-mixed");
        write_fake_install(&dir, "0.1.1");
        write_fake_install_of(&dir, "transcript-parser", "0.1.0");

        let reason = versions_agree(&dir).expect_err("食い違いを見逃した");
        assert!(
            reason.contains("食い違って") && reason.contains("0.1.0") && reason.contains("0.1.1"),
            "どれが何を名乗ったか全部書く（片方を代表にしない）: {reason}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 三本揃っていない版は理由つきで断られる() {
        let dir = temp_dir("agree-missing");
        write_fake_install(&dir, "0.1.1");
        std::fs::remove_file(dir.join("transcript-parser")).unwrap();

        let reason = versions_agree(&dir).expect_err("欠けを見逃した");
        assert!(
            reason.contains("transcript-parser"),
            "何が足りないかを名指しする: {reason}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 一覧は入れる側と保管庫を並べる() {
        let dir = temp_dir("list-both");
        let installed = dir.join("bin");
        write_fake_install(&installed, "0.1.0");
        let stored = versions_dir(&dir).join("0.1.1");
        write_fake_install(&stored, "0.1.1");
        write_pointer(&dir, Some(&stored.join("agentdashboard")));

        let entries = list_versions(&dir, Some(&installed));

        assert_eq!(entries.len(), 2, "2行並ぶ: {entries:?}");
        // 3つ組の順（0.1.0 → 0.1.1）。文字列順ではない
        assert_eq!(entries[0].version, VersionId::new("0.1.0"));
        assert_eq!(entries[0].origin, protocol::VersionOrigin::Installed);
        assert!(entries[0].usable, "3本とも同じ版なら選べる");
        assert!(!entries[0].selected);
        assert!(entries[0].size_bytes > 0, "溜まる量が黙って隠れない");

        assert_eq!(entries[1].version, VersionId::new("0.1.1"));
        assert_eq!(entries[1].origin, protocol::VersionOrigin::Stored);
        assert!(entries[1].selected, "ポインタが指している行に印が付く");
        // いま走っているのはテストの実行ファイルなので、どの行も走ってはいない
        assert!(entries.iter().all(|entry| !entry.running));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 入れる側の三本の版がずれていたら理由が出る() {
        // **黙って片方の版を代表として出さない**（設計§6）
        let dir = temp_dir("list-installed-mixed");
        let installed = dir.join("bin");
        write_fake_install(&installed, "0.1.1");
        write_fake_install_of(&installed, "agentdashboard-agent", "0.1.0");

        let entries = list_versions(&dir, Some(&installed));

        assert_eq!(entries.len(), 1);
        assert!(!entries[0].usable, "選ばせない");
        let reason = entries[0].reason.as_deref().unwrap_or_default();
        assert!(
            reason.contains("agentdashboard-agent") && reason.contains("0.1.0"),
            "どれが何を名乗ったかが画面へ出る: {reason}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 一覧はフォルダ名と中身の食い違いを断る() {
        // 選ぶのはパスでも、**人が見て選ぶのは名前**。名前が嘘をつく行は選ばせない
        let dir = temp_dir("list-name-lies");
        let stored = versions_dir(&dir).join("0.2.0");
        write_fake_install(&stored, "0.1.1");

        let entries = list_versions(&dir, None);

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].version,
            VersionId::new("0.2.0"),
            "名前は名前のまま"
        );
        assert!(!entries[0].usable);
        assert!(
            entries[0]
                .reason
                .as_deref()
                .unwrap_or_default()
                .contains("0.1.1"),
            "中身が何かを書く: {:?}",
            entries[0].reason
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 乗り換えた後の入れる側は保管庫と二重に並ばない() {
        // 乗り換えると `current_exe()` は保管庫を指す。そのまま退避元にすると
        // 同じ行が「入れる側」としても並ぶ
        let dir = temp_dir("list-no-dup");
        let stored = versions_dir(&dir).join("0.1.1");
        write_fake_install(&stored, "0.1.1");

        let entries = list_versions(&dir, Some(&stored));

        assert_eq!(entries.len(), 1, "保管庫の中を退避元として渡しても増えない");
        assert_eq!(entries[0].origin, protocol::VersionOrigin::Stored);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 壊れた版も保管庫からは消せる() {
        // 消せないと、置く途中で切れた残骸を人が手で片付けることになる
        let dir = temp_dir("remove-broken");
        let broken = versions_dir(&dir).join("0.2.0");
        touch(&broken.join("agentdashboard"));

        assert_eq!(remove_version(&dir, &VersionId::new("0.2.0")), Ok(()));
        assert!(!broken.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 保管庫にない版は消せない() {
        let dir = temp_dir("remove-absent");
        assert!(remove_version(&dir, &VersionId::new("9.9.9")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 予約されている版を消すとポインタも外れる() {
        // 消してからポインタを直すと、その隙に起動した版が理由の分からないまま既定へ落ちる
        let dir = temp_dir("remove-selected");
        let stored = versions_dir(&dir).join("0.1.1");
        write_fake_install(&stored, "0.1.1");
        write_pointer(&dir, Some(&stored.join("agentdashboard")));
        assert!(read_pointer(&dir).is_some(), "前提: 予約されている");

        assert_eq!(remove_version(&dir, &VersionId::new("0.1.1")), Ok(()));
        assert_eq!(read_pointer(&dir), None, "既定へ落ちる");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn いま走っている版は消せない() {
        // `canonicalize` はシンボリックリンクを解決するので、いまの自分を指すリンクを
        // 置けば「走っている版」を作れる
        let dir = temp_dir("remove-running");
        let stored = versions_dir(&dir).join("9.9.9");
        std::fs::create_dir_all(&stored).unwrap();
        std::os::unix::fs::symlink(
            std::env::current_exe().unwrap(),
            stored.join("agentdashboard"),
        )
        .unwrap();

        let refused = remove_version(&dir, &VersionId::new("9.9.9")).expect_err("消せてしまった");
        assert!(refused.contains("走っている"), "理由を書く: {refused}");
        assert!(stored.exists(), "消えていない");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 残った錠は相手の様子で見切る() {
        // この機能では後片付けが走らないので、**錠は必ず残る**
        assert!(!lock_is_stale(Holder::Alive, 0));
        assert!(lock_is_stale(Holder::Gone, 0));
        assert!(lock_is_stale(Holder::Replaced, 0), "PID の使い回し");
        // 調べられないときに永久に断ると、一度落ちただけで二度と操作できなくなる
        assert!(!lock_is_stale(Holder::Unknown, 0));
        assert!(lock_is_stale(Holder::Unknown, LOCK_STALE_AFTER_MS + 1));
    }

    #[test]
    fn 開始時刻は名前に空白や括弧があっても読める() {
        // 2番目の項目は括弧で囲まれ、中に空白や括弧を含みうる。
        // 4番目以降は「値＝項目の番号」にしてあるので、22 が出れば正しく数えている
        let fields: Vec<String> = (4..=52).map(|n| n.to_string()).collect();
        let text = format!("42 (my )weird( prog) S {}", fields.join(" "));
        assert_eq!(start_time_from_stat(&text), Some(22), "22番目を読む");
        assert_eq!(start_time_from_stat("壊れている"), None);

        // 実物とも突き合わせる。作った文字列だけで固めると、数え方の思い込みごと固まる
        let own = std::fs::read_to_string("/proc/self/stat").unwrap();
        assert_eq!(
            start_time_from_stat(&own),
            start_time_of(std::process::id()),
            "実物の /proc からも同じ値が読める"
        );
        assert!(start_time_of(std::process::id()).is_some());
    }

    #[test]
    fn 錠は取っている間だけ断る() {
        let dir = temp_dir("lock-basic");
        assert_eq!(acquire_lock(&dir), Ok(()));
        assert!(acquire_lock(&dir).is_err(), "二重の操作は断る");

        release_lock(&dir);
        assert_eq!(acquire_lock(&dir), Ok(()), "返せばまた取れる");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 取った相手が居なければ錠を無視する() {
        let dir = temp_dir("lock-stale");
        crate::jsonfile::save(
            &lock_path(&dir),
            &Lock {
                pid: u32::MAX,
                started_at: Some(1),
                at: now_ms(),
            },
        );
        assert_eq!(acquire_lock(&dir), Ok(()), "居ない相手の錠は奪ってよい");
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

    /// 版を名乗るだけの偽の一式を置く。
    fn write_fake_install(dir: &Path, version: &str) {
        std::fs::create_dir_all(dir).unwrap();
        for name in BINARIES {
            write_fake_install_of(dir, name, version);
        }
    }

    /// 3本のうち1本だけを置き直す（版がずれた一式を作るため）。
    fn write_fake_install_of(dir: &Path, name: &str, version: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        // パーサだけ `--version` を持たず、起こすと1行目に名乗る（設計§20-2）
        let body = if name == "transcript-parser" {
            format!(
                "#!/bin/sh\nprintf '{{\"ev\":\"hello\",\"parser_version\":\"{version}\"}}\\n'\n"
            )
        } else {
            format!("#!/bin/sh\necho '{name} {version}'\n")
        };
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// 取ってきたことにして、頼まれた場所へ一式を置く偽の窓口。
    ///
    /// **後条件は窓口の向こうに無い**ので、差し替えてもこちらの検査は全部通る。
    struct FakeOps {
        /// 実際に置く版。頼まれた版と違えて、中身が食い違う一式を作れる
        places: Option<String>,
        /// 余計な残骸も置くか（配布インストーラが作る一時フォルダを模す）
        litter: bool,
        /// 取ってくること自体に失敗するか
        fails: bool,
    }

    impl FakeOps {
        fn new() -> Self {
            Self {
                places: None,
                litter: false,
                fails: false,
            }
        }
    }

    impl crate::version_ops::VersionOps for FakeOps {
        fn fetch_manifest(&self) -> anyhow::Result<String> {
            anyhow::bail!("この窓口は献立表を持たない")
        }

        fn install(&self, version: &VersionId, staging: &Path) -> crate::proc::Outcome {
            if self.fails {
                return crate::proc::Outcome::failed("取ってこられません".to_string());
            }
            let placed = self
                .places
                .clone()
                .unwrap_or_else(|| version.as_str().to_string());
            write_fake_install(staging, &placed);
            if self.litter {
                std::fs::create_dir_all(staging.join("tmp.XXXXXXXXXX")).unwrap();
            }
            crate::proc::Outcome {
                success: true,
                output: String::new(),
            }
        }
    }

    #[test]
    fn 取ってきた版が保管庫に並ぶ() {
        let state = temp_dir("install-ok");
        let placed = install_version(&state, &FakeOps::new(), &VersionId::new("0.2.0")).unwrap();
        assert_eq!(placed, VersionId::new("0.2.0"));
        assert_eq!(
            versions_agree(&versions_dir(&state).join("0.2.0")),
            Ok(VersionId::new("0.2.0"))
        );
        // 置いている途中の印は残っていない
        assert!(!versions_dir(&state).join(".staging-0.2.0").exists());
    }

    #[test]
    fn 取ってきてもポインタは書かれない() {
        // **要件が名指しで恐れている「勝手に更新される」の最後の砦。**
        // 取ってきただけで走る実行ファイルが変わってはいけない（snapshot と同じ約束）
        let state = temp_dir("install-no-pointer");
        install_version(&state, &FakeOps::new(), &VersionId::new("0.2.0")).unwrap();
        assert!(
            read_pointer(&state).is_none(),
            "取ってきただけでポインタが書かれている"
        );
    }

    #[test]
    fn 三本のほかに残っていたら片付けて断る() {
        // 配布インストーラは置き場所の中に一時フォルダを作り、その片付けは失敗を無視する
        let state = temp_dir("install-litter");
        let ops = FakeOps {
            litter: true,
            ..FakeOps::new()
        };
        let error = install_version(&state, &ops, &VersionId::new("0.2.0")).unwrap_err();
        assert!(error.contains("3本のほかに残っています"), "{error}");
        assert!(
            error.contains("tmp.XXXXXXXXXX"),
            "残骸を名指ししていない: {error}"
        );
        assert!(!versions_dir(&state).join("0.2.0").exists());
        assert!(!versions_dir(&state).join(".staging-0.2.0").exists());
    }

    #[test]
    fn 頼んだ版と中身が違えば片付けて断る() {
        let state = temp_dir("install-mismatch");
        let ops = FakeOps {
            places: Some("0.1.1".to_string()),
            ..FakeOps::new()
        };
        let error = install_version(&state, &ops, &VersionId::new("0.2.0")).unwrap_err();
        assert!(error.contains("頼んだ版と中身が違います"), "{error}");
        assert!(!versions_dir(&state).join("0.2.0").exists());
        assert!(!versions_dir(&state).join(".staging-0.2.0").exists());
    }

    #[test]
    fn 取ってこられなければ片付けて断る() {
        let state = temp_dir("install-fail");
        let ops = FakeOps {
            fails: true,
            ..FakeOps::new()
        };
        let error = install_version(&state, &ops, &VersionId::new("0.2.0")).unwrap_err();
        assert!(error.contains("取ってこられません"), "{error}");
        assert!(
            !versions_dir(&state).join(".staging-0.2.0").exists(),
            "置いている途中の残骸が残っている"
        );
    }

    #[test]
    fn すでにある版は取り直さない() {
        let state = temp_dir("install-twice");
        install_version(&state, &FakeOps::new(), &VersionId::new("0.2.0")).unwrap();
        let error = install_version(&state, &FakeOps::new(), &VersionId::new("0.2.0")).unwrap_err();
        assert!(error.contains("すでに保管庫にあります"), "{error}");
        assert!(
            error.contains("先に消して"),
            "次の一手を書いていない: {error}"
        );
    }

    #[test]
    fn 退避元は差し替えられる() {
        // 差し替え口が無いと、**テストのたびに利用者の実インストールから数十MB が
        // コピーされる**（PJTガイドライン「新しく外の状態を持ったら同時に差し替え口も作る」）
        assert_eq!(
            source_dir_from(
                Some("/指定した場所".to_string()),
                None,
                Some(PathBuf::from("/bin/x"))
            ),
            Some(PathBuf::from("/指定した場所"))
        );
        // 未指定なら本物へ落ちる（実行ファイルの隣＝入れる側が置いた場所）
        assert_eq!(
            source_dir_from(
                None,
                None,
                Some(PathBuf::from("/home/x/.local/bin/agentdashboard"))
            ),
            Some(PathBuf::from("/home/x/.local/bin"))
        );
        assert_eq!(
            source_dir_from(Some(String::new()), None, None),
            None,
            "空は未指定"
        );
    }

    #[test]
    fn 乗り換えた後の退避元は乗り換え前の入口() {
        // 乗り換えると `current_exe()` は保管庫を指す。そのまま退避元にすると保管庫から
        // 保管庫へ控えることになり、一覧では**同じ行が「入れる側」としても並ぶ**
        assert_eq!(
            source_dir_from(
                None,
                Some("/home/x/.local/bin/agentdashboard".to_string()),
                Some(PathBuf::from(
                    "/home/x/.local/state/agentdashboard/versions/0.2.0/agentdashboard"
                )),
            ),
            Some(PathBuf::from("/home/x/.local/bin")),
            "乗り換え前の入口の隣を見る"
        );
        // 指定があればそちらが勝つ（テストの差し替え口を塞がない）
        assert_eq!(
            source_dir_from(
                Some("/指定した場所".to_string()),
                Some("/home/x/.local/bin/agentdashboard".to_string()),
                None,
            ),
            Some(PathBuf::from("/指定した場所"))
        );
    }

    #[test]
    fn 初回は入れる側が置いた三本を控える() {
        // これが無いと、機能を入れた瞬間の選択肢は1つしか無い。「戻せます」と
        // 書いてあるのに**いちばん戻りたい先へ戻れない**
        let dir = temp_dir("snapshot");
        let source = dir.join("bin");
        write_fake_install(&source, "0.3.0");
        let state = dir.join("state");

        let taken = snapshot(&state, &source).expect("控えられること");

        assert_eq!(taken, Some(VersionId::new("0.3.0")));
        assert!(is_complete(&versions_dir(&state).join("0.3.0")));
        // **ポインタは書かない。** 書くと、利用者が何も選んでいないのに走る実行ファイルが変わる
        assert_eq!(
            read_pointer(&state),
            None,
            "退避は選べる先を増やすだけの操作"
        );
        // 置いている途中の名残が残らない
        assert!(
            stored_versions(&state)
                .iter()
                .all(|path| !path.to_string_lossy().contains(STAGING_PREFIX)),
            "置いている途中のフォルダが残っています"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 同じ版が既にあれば控え直さない() {
        // 上書きしないのは戻す先を残すため（設計§3）。ソースから建てている機械では、
        // 作り直すたびに数十MB を書き直さないためでもある
        let dir = temp_dir("snapshot-twice");
        let source = dir.join("bin");
        write_fake_install(&source, "0.3.0");
        let state = dir.join("state");

        assert_eq!(
            snapshot(&state, &source).unwrap(),
            Some(VersionId::new("0.3.0"))
        );
        assert_eq!(
            snapshot(&state, &source).unwrap(),
            None,
            "二度目は何もしない"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 三本揃っていない場所は退避元にしない() {
        // 箱の中には1本しか入っていない。**そこは入れる側の置き場所ではない**
        let dir = temp_dir("snapshot-partial");
        let source = dir.join("bin");
        std::fs::create_dir_all(&source).unwrap();
        touch(&source.join("agentdashboard"));
        let state = dir.join("state");

        assert_eq!(snapshot(&state, &source).unwrap(), None);
        assert!(stored_versions(&state).is_empty());
        let _ = std::fs::remove_dir_all(dir);
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

    #[test]
    fn 実行ファイルの時刻が読めて_未来ではない() {
        // 「この実行ファイルはいつのものか」を出す材料。テストの実行ファイル自身で見る
        let at = binary_at().expect("走っている実行ファイルの時刻は読めること");
        assert!(at > 0, "epoch ミリ秒として意味のある値であること");
        assert!(
            at <= crate::session::now_ms(),
            "実行ファイルができた時刻が未来になっている: {at}"
        );
    }

    #[test]
    fn 無い場所の時刻は読めなくても落ちない() {
        // **読めないことは異常ではない。** 画面は「不明」と出すだけで、他は動く
        assert_eq!(file_time(Path::new("/nonexistent/agentdashboard")), None);
    }

    #[test]
    fn 起動時刻は一度決まったら動かない() {
        // 呼ぶたびに now を返すと、画面の「いつ起きたか」が毎回いまになる
        let first = started_at();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(started_at(), first);
        assert!(first > 0);
    }

    #[test]
    fn 走っている実行ファイルの素性は一度決まったら動かない() {
        // 差し替えられたあとに聞き直すと `(deleted)` になる。**起動時の答えを持ち続ける**
        let first = running_binary();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let again = running_binary();
        assert_eq!(first.path, again.path);
        assert_eq!(first.built_at, again.built_at);
    }

    /// 走っているものと次に起きるものが違うか（設計§5）。**3通りを固める。**
    mod 変わったかどうか {
        use super::*;

        fn 走っているもの(built_at: Option<Timestamp>) -> RunningBinary {
            RunningBinary {
                path: Some(PathBuf::from("/bin/agentdashboard")),
                built_at,
            }
        }

        #[test]
        fn 版名が違えば違う() {
            assert!(differs(
                &VersionId::new("0.1.41"),
                &走っているもの(Some(100)),
                Some(&VersionId::new("0.1.44")),
                Some(100),
            ));
        }

        #[test]
        fn 版名が同じでもビルド時刻が違えば違う() {
            // **版番号を上げないソースビルドがこれ。** ここを落とすと、実機は
            // 何度建て直しても「変わっていない」と答える
            assert!(differs(
                &VersionId::new("0.1.44"),
                &走っているもの(Some(100)),
                Some(&VersionId::new("0.1.44")),
                Some(200),
            ));
        }

        #[test]
        fn どちらも同じなら違わない() {
            assert!(!differs(
                &VersionId::new("0.1.44"),
                &走っているもの(Some(100)),
                Some(&VersionId::new("0.1.44")),
                Some(100),
            ));
        }

        #[test]
        fn 分からないときは違わない側へ倒す() {
            // 行き先の版が読めない／時刻が読めない。**分からないまま押させない**
            assert!(!differs(
                &VersionId::new("0.1.44"),
                &走っているもの(Some(100)),
                None,
                Some(200),
            ));
            assert!(!differs(
                &VersionId::new("0.1.44"),
                &走っているもの(None),
                Some(&VersionId::new("0.1.44")),
                Some(200),
            ));
        }
    }

    #[test]
    fn 次に起きる版は予約があればそちら_無ければ入れる側() {
        let state = temp_dir("next-binary");
        // 予約が無いとき——入れる側（`current_exe` の隣）を指す
        assert_eq!(next_binary(&state), installed_binary());

        // 予約があるとき——そちらが勝つ
        let target = state.join("agentdashboard");
        std::fs::write(&target, b"x").expect("置けること");
        write_pointer(&state, Some(&target));
        assert_eq!(next_binary(&state), Some(target));
    }
}
