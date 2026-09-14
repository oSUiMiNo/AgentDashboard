//! **いまどの claude ログインで動いているか**を読む（`~/.claude.json`）。
//!
//! # なぜ要るのか
//!
//! 使用上限（[`protocol::RateLimits`]）は受け口で合流させている。その合流は
//! 「リセット時刻は前へ戻らない」を頼りに遅れて届いた報告を捨てるが、**その約束は
//! 1つのログインの中でしか成り立たない**。利用者が別のアカウントへログインし直すと
//! 新しい側の窓が手前で戻ることがあり、**新しい値が「遅れて届いたもの」として捨てられる**
//! ——画面に前のアカウントの数字が残り続ける（2026-09-14 申告）。
//!
//! **値だけを見ても、切り替わったのか遅れて届いたのかは見分けられない。** だから
//! 「誰の上限か」を添える。ここはその「誰か」を読む唯一の場所である。
//!
//! # 名乗れるのは PC だけである
//!
//! `~/.claude.json` は**利用者の PC にしか無い**。サーバは読めないので、
//! セルフホスト構成では PC が指紋を名乗って線に載せる（`a2s::AgentMessage::RateLimits`）。
//!
//! # 元の値は持ち出さない
//!
//! このファイルには利用者のメールアドレスと氏名が入っている。**要るのは「前と同じか」
//! だけ**なので、[`FINGERPRINT_HEX`] 文字の hex に潰したものだけを外へ出す。
//! **画面にもログにも出さない。**
//!
//! # 毎回は読まない
//!
//! `.claude.json` は claude が常時書き換えており、開発機の実測で **577KB**（2026-09-14）
//! ある。使用上限は**セッション1本につき3秒ごと**に届くので、素直に読むと N 本ぶんの
//! 全文解析が3秒ごとに走る。
//!
//! だから2段で抑える。**更新時刻と大きさが動いていなければ読まない**、動いていても
//! [`最短の読み直し間隔`] 以内なら前の答えを使う。ログインは日に何度も変わるものでは
//! ないので、遅れて困るものではない。

use protocol::ClaudeLoginFingerprint;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// 指紋の長さ（hex の文字数）。
///
/// **突き合わせにしか使わない**ので、全長は要らない。64bit ぶんあれば、この機械が
/// 使うアカウントの数で偶然ぶつかることはない。
const FINGERPRINT_HEX: usize = 16;

/// 読み直しの最短間隔。**更新時刻が動いていても、これ以内なら前の答えを使う。**
const 最短の読み直し間隔: Duration = Duration::from_secs(30);

/// 前に読んだ答えと、その根拠。
struct Cached {
    /// 読んだときのファイルの更新時刻と大きさ。**どちらかが動いたら読み直す。**
    stamp: Option<(SystemTime, u64)>,
    /// 最後に読み直した時刻。
    at: Instant,
    /// 読めた指紋。**読めなかったときは `None`**（それも答えとして控える——
    /// 存在しないファイルを3秒ごとに開きに行かないため）。
    fingerprint: Option<ClaudeLoginFingerprint>,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// CLI が設定を置くファイル（`<ホーム>/.claude.json`）。
///
/// ホームの決め方は [`crate::claude_home`] と同じ（テストが差し替えられるように、
/// `AGENTDASHBOARD_CLAUDE_HOME` を先に見る）。**`.claude/` の中ではなく、その隣**である。
pub fn config_path() -> Option<PathBuf> {
    let home = std::env::var(crate::claude_home::CLAUDE_HOME_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("HOME").ok())?;
    Some(PathBuf::from(home).join(".claude.json"))
}

/// いまのログインの指紋。**読めなければ `None`。**
///
/// `None` は「ログインしていない」ではなく「**分からない**」である。受け取る側は
/// これを「切り替わった」と読んではいけない（`server-core` の `login_changed`）。
pub fn fingerprint() -> Option<ClaudeLoginFingerprint> {
    let path = config_path()?;
    let stamp = std::fs::metadata(&path)
        .ok()
        .and_then(|meta| Some((meta.modified().ok()?, meta.len())));

    let mut cache = CACHE.lock().expect("ロックが壊れていない");
    if let Some(前) = cache.as_ref() {
        // 動いていなければ読まない。動いていても、間隔を空ける
        if 前.stamp == stamp || 前.at.elapsed() < 最短の読み直し間隔 {
            return 前.fingerprint.clone();
        }
    }

    let fingerprint = read_fingerprint(&path);
    *cache = Some(Cached {
        stamp,
        at: Instant::now(),
        fingerprint: fingerprint.clone(),
    });
    fingerprint
}

/// テストのために控えを捨てる。
///
/// **控えはプロセスに1つ**なので、置き場所を差し替えるテストが前のテストの答えを
/// 拾ってしまう。`#[cfg(test)]` にしないのは、**別 crate の結合テストからも要る**ため。
pub fn forget() {
    *CACHE.lock().expect("ロックが壊れていない") = None;
}

/// ファイルを1回読んで指紋を作る。
fn read_fingerprint(path: &std::path::Path) -> Option<ClaudeLoginFingerprint> {
    let text = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let account = value.get("oauthAccount")?.get("accountUuid")?.as_str()?;
    if account.is_empty() {
        return None;
    }
    Some(digest(account))
}

/// 指紋にする。**元に戻せない形で、突き合わせに足りる長さだけ。**
fn digest(account: &str) -> ClaudeLoginFingerprint {
    let mut hasher = Sha256::new();
    // **用途を混ぜないための前置き。** 同じ値をどこか別の場所でも潰したくなったとき、
    // 前置きが違えば別の指紋になる
    hasher.update(b"agentdashboard/claude-login/v1\0");
    hasher.update(account.as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    ClaudeLoginFingerprint(hex[..FINGERPRINT_HEX].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一時の置き場所を1つ作る。**`claude_settings` のテストと同じ作法**（依存を増やさない）。
    ///
    /// **本物の `~/.claude.json` は絶対に対象にしない。** テストが壊れたときに
    /// 利用者の設定が巻き添えになる経路を、そもそも作らない。
    fn 偽のホーム(label: &str, body: Option<&str>) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-claude-login-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("作れること");
        let path = dir.join(".claude.json");
        if let Some(body) = body {
            std::fs::write(&path, body).expect("書けること");
        }
        path
    }

    /// ログイン済みの `.claude.json` の形（要る欄だけ）。
    const ログイン済み: &str = r#"{"numStartups":3,"oauthAccount":{"accountUuid":"11111111-2222-3333-4444-555555555555","emailAddress":"someone@example.test"}}"#;

    #[test]
    fn 同じアカウントなら同じ指紋になる() {
        assert_eq!(
            digest("11111111-2222-3333-4444-555555555555"),
            digest("11111111-2222-3333-4444-555555555555")
        );
    }

    #[test]
    fn 違うアカウントなら違う指紋になる() {
        assert_ne!(
            digest("11111111-2222-3333-4444-555555555555"),
            digest("66666666-7777-8888-9999-000000000000")
        );
    }

    /// **元の値が指紋の中に残っていないこと。** 残っていれば、運ぶ先すべてが
    /// 利用者の識別子を持つことになる
    #[test]
    fn 指紋から元の値を読み取れない() {
        let uuid = "11111111-2222-3333-4444-555555555555";
        let ClaudeLoginFingerprint(hex) = digest(uuid);
        assert!(!hex.contains(uuid), "指紋に元の値がそのまま入っている");
        assert!(!hex.contains("1111"), "指紋に元の値の断片が入っている");
        assert_eq!(hex.len(), FINGERPRINT_HEX);
        assert!(
            hex.chars().all(|c| c.is_ascii_hexdigit()),
            "hex 以外の字が混ざっている：{hex}"
        );
    }

    #[test]
    fn ファイルが無ければ読めないと答える() {
        let path = 偽のホーム("absent", None);
        assert_eq!(read_fingerprint(&path), None);
    }

    /// **壊れた JSON でも落ちない。** claude が書いている最中を掴むことがある
    #[test]
    fn 壊れた記述でも読めないと答えるだけ() {
        let path = 偽のホーム("broken", Some("{ oauthAccount: "));
        assert_eq!(read_fingerprint(&path), None);
    }

    /// **欄が無いときも同じ。** API キー利用者にはこの欄が無い
    #[test]
    fn ログインの欄が無ければ読めないと答える() {
        let path = 偽のホーム("nologin", Some(r#"{"numStartups":3}"#));
        assert_eq!(read_fingerprint(&path), None);
    }

    #[test]
    fn 置き場所を差し替えれば読める() {
        let path = 偽のホーム("present", Some(ログイン済み));
        assert_eq!(
            read_fingerprint(&path),
            Some(digest("11111111-2222-3333-4444-555555555555"))
        );
    }

    /// **別のアカウントへ書き換われば、指紋も変わる。** ここが変わらないと、
    /// 受け口は切り替えに気づけない（この修正の目的そのもの）
    #[test]
    fn 別のアカウントへ書き換わったら指紋も変わる() {
        let path = 偽のホーム("switch", Some(ログイン済み));
        let 前 = read_fingerprint(&path).expect("読めること");
        std::fs::write(
            &path,
            r#"{"oauthAccount":{"accountUuid":"66666666-7777-8888-9999-000000000000"}}"#,
        )
        .expect("書けること");
        let いま = read_fingerprint(&path).expect("読めること");
        assert_ne!(前, いま, "書き換えたのに指紋が同じ");
    }
}
