//! 外へ貼るときに伏せる（設計§14）。
//!
//! **書くときには伏せない。** 手元の道具として、原因究明に要る情報が既定で落ちるのは
//! 本末転倒なので、伏せるのは読む側の `--sanitize` を通したときだけにする（設計§14-1）。
//!
//! # 規則をここに書き並べない
//!
//! 伏せたい文字列（利用者名・メール・所属）を定数として持つと、**それ自体が公開情報に
//! なる**。本リポジトリは公開なので、規則は実行時に環境から組み立てる。同じ理由で
//! `scripts/sanitize-fixtures.py` も `~/.claude.json` から読む形になっている。
//!
//! # 名前について
//!
//! フラグは設計どおり `--sanitize` だが、このモジュールは `redact` と呼ぶ。この
//! リポジトリの `sanitize` は既に2つの別の意味で使われているため——
//! `session/lifecycle.rs` の環境変数の許可リストと、`session/input.rs` の ESC 除去。
//! 3つ目の意味を足すと、読む人がどれの話か分からなくなる。

use std::cmp::Reverse;
use std::collections::HashSet;
use std::path::Path;

use regex::Regex;

/// 置き換え後の文字列。`scripts/sanitize-fixtures.py` と揃えてある。
///
/// 揃えるのは、フィクスチャとログが同じ場所（イシューや不具合報告）へ貼られるため。
/// 別の伏せ字を使うと、読む側が「これは伏せたものか、元からこう書いてあるのか」を
/// 判断できなくなる。
const HOME_PLACEHOLDER: &str = "/home/dashboard-user";
const USER_PLACEHOLDER: &str = "dashboard-user";
const HOST_PLACEHOLDER: &str = "dashboard-host";
const ORG_PLACEHOLDER: &str = "dashboard-org";
const EMAIL_PLACEHOLDER: &str = "redacted@example.invalid";
const ACCOUNT_UUID_PLACEHOLDER: &str = "00000000-0000-0000-0000-0000000000ac";
const ORG_UUID_PLACEHOLDER: &str = "00000000-0000-0000-0000-000000000009";
const TOKEN_PLACEHOLDER: &str = "adp_redacted";

/// 伏せる規則として採らない短さ。**バイトではなく文字で数える。**
///
/// **短い語を伏せると、無関係な場所が壊れる。** `HOME` が読めないとき
/// [`crate::hostfs::home`] は `/` を返すので、その1文字を規則にすると**行のすべての
/// 区切りが伏せ字になる**。利用者名が2文字のときも同じ性質を持つ。
///
/// バイトで数えると、この歯止めが**非 ASCII の名前に対してだけ効かなくなる**。
/// 表示名が漢字2文字なら UTF-8 で6バイトあるので素通りし、本文が日本語のこの
/// リポジトリでは無関係な行が伏せ字で割れる。実機のアカウントが実際にその形だった。
const MIN_RULE_LEN: usize = 3;

/// 伏せない宛先。ここを潰すと、説明用の例まで書き換わってしまう。
const EXAMPLE_DOMAINS: &[&str] = &[
    "example.com",
    "example.org",
    "example.net",
    "example.invalid",
];

/// `~/.claude.json` の `oauthAccount` から読める値。
///
/// **すべて任意。** ログインしていない・ファイルが無い・形が変わった、のどれでも
/// 空のまま進む（設計§14-2 の「機械で判定できるものだけを既定にする」）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Account {
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub organization: Option<String>,
    pub account_uuid: Option<String>,
    pub organization_uuid: Option<String>,
}

/// 伏せる規則の一式。
pub struct Rules {
    /// `(伏せたい文字列, 置き換え後)`。**長い順**に並べてある。
    pairs: Vec<(String, String)>,
    /// アカウント由来の値。**報告に実値を出さない**ための印（設計§14-3）。
    secrets: HashSet<String>,
    email: Regex,
    token: Regex,
    url_host: Regex,
}

impl Rules {
    /// 環境から組み立てる。
    ///
    /// 読むのは4つ——ホーム（[`crate::hostfs::home`]。**新しい決め方を作らない**）、
    /// 利用者名、ホスト名、`~/.claude.json` の `oauthAccount`。
    pub fn from_env() -> Self {
        let home = crate::hostfs::home();
        let user = env_user(&home);
        let host = env_hostname();
        let account = read_account(&home.join(".claude.json"));
        Self::from_parts(
            home.to_string_lossy().as_ref(),
            user.as_deref(),
            host.as_deref(),
            &account,
        )
    }

    /// 値を直に渡して組み立てる。
    ///
    /// **単体テストはこちらを使う。** 環境変数を書き換えるテストは、並行して走る
    /// 他のテストを巻き込む（PJTガイドライン「環境変数を読む関数を、テストから呼ぶとき」）。
    pub fn from_parts(
        home: &str,
        user: Option<&str>,
        host: Option<&str>,
        account: &Account,
    ) -> Self {
        let mut pairs: Vec<(String, String)> = Vec::new();
        let mut secrets: HashSet<String> = HashSet::new();

        push_rule(&mut pairs, home, HOME_PLACEHOLDER);
        if let Some(user) = user {
            push_rule(&mut pairs, user, USER_PLACEHOLDER);
        }
        if let Some(host) = host {
            // `localhost` はどの機械にもあるので、伏せても何も守らないまま読みにくくなる
            if host != "localhost" {
                push_rule(&mut pairs, host, HOST_PLACEHOLDER);
            }
        }

        let account_rules: [(&Option<String>, &str); 5] = [
            (&account.display_name, USER_PLACEHOLDER),
            (&account.email, EMAIL_PLACEHOLDER),
            (&account.organization, ORG_PLACEHOLDER),
            (&account.account_uuid, ACCOUNT_UUID_PLACEHOLDER),
            (&account.organization_uuid, ORG_UUID_PLACEHOLDER),
        ];
        for (value, placeholder) in account_rules {
            let Some(value) = value else { continue };
            if push_rule(&mut pairs, value, placeholder) {
                secrets.insert(value.clone());
            }
        }

        // **長い順に当てる。** 短い規則が先に当たると、それを含む長い規則が
        // 二度と一致しなくなる（利用者名がホームのパスの一部になっている、が典型）
        pairs.sort_by_key(|(old, _)| Reverse(old.len()));
        pairs.dedup_by(|left, right| left.0 == right.0);

        Self {
            pairs,
            secrets,
            email: email_pattern(),
            token: token_pattern(),
            url_host: url_host_pattern(),
        }
    }

    /// 伏せた文字列を返す。
    pub fn apply(&self, text: &str) -> String {
        let mut out = self.replace_once(text);
        // 名指しでは拾えないものを**形**で捕まえる（規則をソースに書き並べないため）
        out = self
            .email
            .replace_all(&out, |caps: &regex::Captures| {
                let whole = &caps[0];
                if is_example_address(whole) {
                    whole.to_string()
                } else {
                    EMAIL_PLACEHOLDER.to_string()
                }
            })
            .into_owned();
        out = self.token.replace_all(&out, TOKEN_PLACEHOLDER).into_owned();
        self.url_host
            .replace_all(&out, |caps: &regex::Captures| {
                let host = &caps[2];
                if is_kept_host(host) {
                    caps[0].to_string()
                } else {
                    format!("{}://{HOST_PLACEHOLDER}", &caps[1])
                }
            })
            .into_owned()
    }

    /// 1回の走査で、当たった一番長い規則を当てる。
    ///
    /// **規則を順に [`str::replace`] してはいけない。** 先に書いた伏せ字を後の規則が
    /// もう一度打つ——利用者名が `user` だと `/home/dashboard-user` の中の `user` に
    /// 当たって `/home/dashboard-dashboard-user` になる。長い順に並べてあるので、
    /// 先頭から試して最初に当たったものがその位置での最長一致になる。
    fn replace_once(&self, text: &str) -> String {
        if self.pairs.is_empty() {
            return text.to_string();
        }
        let mut out = String::with_capacity(text.len() + 16);
        let mut rest = text;
        'scan: while !rest.is_empty() {
            for (old, new) in &self.pairs {
                if let Some(tail) = rest.strip_prefix(old.as_str()) {
                    out.push_str(new);
                    rest = tail;
                    continue 'scan;
                }
            }
            let ch = rest.chars().next().expect("空でないこと");
            out.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
        out
    }

    /// 伏せ切れなかったものを述べる（設計§14-3 の残存検査）。
    ///
    /// **報告にアカウント由来の実値を載せない。** ここは「外へ貼るための口」なので、
    /// 残存を知らせる文そのものから漏れては本末転倒になる。
    pub fn residue(&self, text: &str) -> Vec<String> {
        // **数える前に伏せ字そのものを外す。** 伏せ字は規則の語を含みうる——利用者名が
        // `user` なら `/home/dashboard-user` が当たり、伏せ終わった行が毎回「残っている」
        // と報告される。長いものから外さないと、短い伏せ字が長い伏せ字を割ってしまう
        let mut probe = text.to_string();
        let mut placeholders = [
            HOME_PLACEHOLDER,
            USER_PLACEHOLDER,
            HOST_PLACEHOLDER,
            ORG_PLACEHOLDER,
            EMAIL_PLACEHOLDER,
            ACCOUNT_UUID_PLACEHOLDER,
            ORG_UUID_PLACEHOLDER,
            TOKEN_PLACEHOLDER,
        ];
        placeholders.sort_by_key(|text| Reverse(text.len()));
        for placeholder in placeholders {
            probe = probe.replace(placeholder, "");
        }

        let mut found = Vec::new();
        for (old, _) in &self.pairs {
            if probe.contains(old.as_str()) {
                found.push(self.describe(old));
            }
        }
        if self
            .email
            .find_iter(&probe)
            .any(|hit| !is_example_address(hit.as_str()))
        {
            found.push("メールアドレスの形が残っています".to_string());
        }
        if self.token.is_match(&probe) {
            found.push("ペアリングトークンの形が残っています".to_string());
        }
        if self
            .url_host
            .captures_iter(&probe)
            .any(|caps| !is_kept_host(&caps[2]))
        {
            found.push("接続先のホスト名が残っています".to_string());
        }
        found
    }

    fn describe(&self, old: &str) -> String {
        if self.secrets.contains(old) {
            // 実値の代わりに長さだけを言う
            format!(
                "伏せるはずの値が残っています（{} 文字）",
                old.chars().count()
            )
        } else {
            format!("{old:?} が残っています")
        }
    }

    /// 規則を1つも持たないか。`--sanitize` を付けたのに何も伏せられない状況を知らせる用。
    pub fn is_empty(&self) -> bool {
        self.pairs.is_empty()
    }
}

/// 使える規則なら積んで `true`。短すぎるもの・空のものは採らない。
///
/// # `\` を含むものは、JSON で書かれた形も積む
///
/// Windows のホームは `C:\Users\taro` だが、`--json` や別の PC から引いた行の中では
/// `C:\\Users\\taro` と書かれている（`serde_json` が `\` を重ねる）。積むのが
/// ファイルシステムの形だけだと**一致せず素通しになる**。
///
/// しかも [`Rules::residue`] は同じ規則で残存を数えるので、**警告も出ない**——
/// 利用者は「安全に貼れる」と言われたまま、ホームパスと利用者名を外へ出すことになる。
/// Unix は区切りが `/` なので、この道は通らない。
fn push_rule(pairs: &mut Vec<(String, String)>, old: &str, new: &str) -> bool {
    let old = old.trim();
    if old.chars().count() < MIN_RULE_LEN || old == "/" {
        return false;
    }
    if old.contains('\\') {
        // **長いほうを先に積む。** `Rules::from_parts` は長い順へ並べ替えるが、
        // 同じ長さのときの順序に頼らないよう、ここでも重ねた形を先に置く
        pairs.push((old.replace('\\', "\\\\"), new.to_string()));
    }
    pairs.push((old.to_string(), new.to_string()));
    true
}

fn is_example_address(address: &str) -> bool {
    let Some((_, domain)) = address.rsplit_once('@') else {
        return false;
    };
    let domain = domain.to_ascii_lowercase();
    EXAMPLE_DOMAINS
        .iter()
        .any(|allowed| domain == *allowed || domain.ends_with(&format!(".{allowed}")))
}

fn email_pattern() -> Regex {
    Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}").expect("定数の正規表現")
}

/// ペアリングトークンの形。接頭辞は `db/pairing.rs` が
/// 「**ログや設定ファイルの中で『これは鍵だ』と分かるように**」付けているもの。
fn token_pattern() -> Regex {
    Regex::new(r"adp_[A-Za-z0-9_\-]{16,}").expect("定数の正規表現")
}

/// URL のホスト部。
///
/// **接続先の FQDN は、名指しでも形でも拾えない。** 利用者が自前で立てたサーバの名前は
/// こちらの環境のどこにも書いていないので、[`env_hostname`] にも `~/.claude.json` にも
/// 現れない。実機のログでは `session_host_core::link` の「ダッシュボードサーバへ
/// 接続しました: …」に素で出ていた。
///
/// 拾えるのは**位置**だけなので、URL の形で捕まえてホスト部だけを伏せる。
///
/// **大文字小文字を無視する指定は `(?i-u)` と書く。** `regex` は
/// `default-features = false` で入れてある（配布物を軽く保つため。`server/Cargo.toml`）
/// ので、`unicode-case` を持っていない。素の `(?i)` は
/// 「Unicode-aware case insensitivity matching is not available」で**組み立てに失敗する**
/// ——定数の正規表現なので、落ちるのは実行時（`expect` で panic）になる。
/// `-u` を添えて ASCII の畳み込みに落とせば、機能を足さずに済む。
fn url_host_pattern() -> Regex {
    Regex::new(r"(?i-u)\b(https?|wss?)://([A-Za-z0-9._\-]+)").expect("定数の正規表現")
}

/// そのまま残してよいホストか。
///
/// **ループバックは伏せない。** 切り分けに要るのは「焼き込んだ先と受けている場所が
/// 一致するか」で、`127.0.0.1:4173` の番号を潰すと材料としての価値が落ちる（§22-8 が
/// 宛先の URL について同じ判断をしている）。説明用の例と、伏せ字そのものも残す。
fn is_kept_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == HOST_PLACEHOLDER || host == "localhost" || host == "0.0.0.0" {
        return true;
    }
    // IPv4 の素の並び。私設アドレスかどうかは見ない——LAN の番号は名前ではないので、
    // 伏せても守るものが無く、待ち受けの切り分けだけが難しくなる
    if host
        .split('.')
        .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
    {
        return true;
    }
    EXAMPLE_DOMAINS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

fn env_user(home: &Path) -> Option<String> {
    for key in ["USER", "LOGNAME", "USERNAME"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    // 最後の手段。ホームの末尾は利用者名であることが多い
    home.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
}

/// ホスト名。`config.rs` の `resolved_agent_name` と同じ順で探す。
fn env_hostname() -> Option<String> {
    for key in ["HOSTNAME", "COMPUTERNAME"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|name| !name.is_empty())
}

/// `~/.claude.json` の `oauthAccount` を読む。**読むだけ。決して書かない。**
///
/// あれは CLI の持ち物で、キーは向こうの都合で増える。`deny_unknown_fields` を持ち込むと
/// CLI が更新されるたびに壊れるので、[`serde_json::Value`] で開いて要る鍵だけを引く。
/// 無い・壊れている・`oauthAccount` が無い、のどれでも**空のまま進む**——ログインして
/// いない利用者が `--sanitize` を一切使えなくなるのを避ける。
fn read_account(path: &Path) -> Account {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Account::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Account::default();
    };
    let Some(account) = value.get("oauthAccount") else {
        return Account::default();
    };
    let pick = |key: &str| -> Option<String> {
        account
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    Account {
        display_name: pick("displayName"),
        email: pick("emailAddress"),
        organization: pick("organizationName"),
        account_uuid: pick("accountUuid"),
        organization_uuid: pick("organizationUuid"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows 形のホームで組んだ規則。**重ねて書かれた形にも当たること**を見る。
    #[test]
    fn バックスラッシュのホームは重ねて書かれた形でも伏せる() {
        let rules = Rules::from_parts(r"C:\Users\taro", Some("taro"), None, &Account::default());

        // `--json` や引いた行が持つ生の1行では、`\` が重ねて書かれている
        let raw = r#"{"msg":"C:\\Users\\taro\\Dev で落ちました"}"#;
        let 伏せた = rules.apply(raw);
        // **利用者名ではなくパスそのものを見る。** 利用者名は別の規則でも消えるので、
        // `taro` が無いことだけを見ると、ホームの規則が当たっていなくても通ってしまう
        assert!(
            !伏せた.contains(r"C:\\Users"),
            "重ねて書かれたホームが素通ししている：{伏せた}"
        );
        assert!(
            伏せた.contains(HOME_PLACEHOLDER),
            "ホームの伏せ字に置き換わること：{伏せた}"
        );
        // 素通しに気づけない、がいちばん悪い。**残存として数えられること**
        assert!(
            rules.residue(&伏せた).is_empty(),
            "伏せ切れたのに残存と言っている：{:?}",
            rules.residue(&伏せた)
        );

        // ファイルシステムの形（人が読む1行のほう）も従来どおり
        let 人が読む形 = rules.apply(r"C:\Users\taro\Dev で落ちました");
        assert!(!人が読む形.contains("taro"), "実際：{人が読む形}");
    }

    fn account() -> Account {
        Account {
            display_name: Some("Taro Yamada".to_string()),
            email: Some("taro@corp.example-real.jp".to_string()),
            organization: Some("Corp Inc".to_string()),
            account_uuid: Some("11111111-2222-3333-4444-555555555555".to_string()),
            organization_uuid: Some("66666666-7777-8888-9999-000000000000".to_string()),
        }
    }

    fn rules() -> Rules {
        Rules::from_parts("/home/taro", Some("taro"), Some("OMEN-DESKTOP"), &account())
    }

    #[test]
    fn ホームと利用者名とホスト名を伏せる() {
        let out = rules().apply("/home/taro/Dev で taro が OMEN-DESKTOP から起こした");
        assert!(out.contains(HOME_PLACEHOLDER), "{out}");
        assert!(!out.contains("/home/taro"), "{out}");
        assert!(!out.contains("OMEN-DESKTOP"), "{out}");
    }

    #[test]
    fn 長い規則から当てるのでホームのパスが壊れない() {
        // 利用者名（taro）を先に当てると `/home/dashboard-user/…` にならない
        let out = rules().apply("/home/taro/Dev/App");
        assert_eq!(out, "/home/dashboard-user/Dev/App");
    }

    #[test]
    fn アカウント由来の値を伏せる() {
        let out = rules().apply(
            "Taro Yamada / Corp Inc / 11111111-2222-3333-4444-555555555555 / 66666666-7777-8888-9999-000000000000",
        );
        assert!(!out.contains("Taro Yamada"), "{out}");
        assert!(!out.contains("Corp Inc"), "{out}");
        assert!(!out.contains("11111111-2222"), "{out}");
        assert!(!out.contains("66666666-7777"), "{out}");
    }

    #[test]
    fn 名指しに無いメールも形で捕まえる() {
        let out = rules().apply("宛先は someone-else@unknown-domain.co.jp です");
        assert!(out.contains(EMAIL_PLACEHOLDER), "{out}");
        assert!(!out.contains("unknown-domain"), "{out}");
    }

    #[test]
    fn 説明用のドメインは残す() {
        let out = rules().apply("例：user@example.com");
        assert!(out.contains("user@example.com"), "{out}");
    }

    #[test]
    fn ペアリングトークンの形を伏せる() {
        let out = rules().apply("token=adp_abcdefghijklmnopqrstuvwxyz012345 を渡した");
        assert!(out.contains(TOKEN_PLACEHOLDER), "{out}");
        assert!(!out.contains("abcdefghijklmnop"), "{out}");
    }

    #[test]
    fn 短すぎる語は規則にしない() {
        // HOME が読めないと hostfs::home() は "/" を返す。これを規則にすると
        // 行の区切りがすべて伏せ字になる
        let rules = Rules::from_parts("/", Some("ab"), None, &Account::default());
        assert!(rules.is_empty());
        assert_eq!(rules.apply("/a/b/c"), "/a/b/c");
    }

    #[test]
    fn 短さは文字で数える() {
        // **バイトで数えると、この歯止めが非 ASCII にだけ効かない。** 漢字2文字は
        // UTF-8 で6バイトあるので素通りし、日本語の本文が伏せ字で割れる。
        // 実機のアカウントの表示名が実際にこの形だった
        let account = Account {
            display_name: Some("太郎".to_string()),
            ..Account::default()
        };
        let rules = Rules::from_parts("/", None, None, &account);
        assert!(rules.is_empty(), "2文字の表示名が規則になっている");
        assert_eq!(
            rules.apply("太郎さんが起こしました"),
            "太郎さんが起こしました"
        );
    }

    #[test]
    fn 接続先のホスト名を伏せる() {
        // 自前で立てたサーバの名前は、こちらの環境のどこにも書いていない。
        // 名指しでも形（メール・トークン）でも拾えないので、URL の位置で捕まえる
        let out = rules().apply("ダッシュボードサーバへ接続しました: https://dash.example-real.jp");
        assert!(out.contains(HOST_PLACEHOLDER), "{out}");
        assert!(!out.contains("dash.example-real.jp"), "{out}");
        assert!(
            out.starts_with("ダッシュボードサーバへ接続しました: https://"),
            "{out}"
        );
    }

    #[test]
    fn ループバックと番号は残す() {
        // **切り分けに要るのはポート番号。** 焼き込んだ先と受けている場所が
        // 一致するかを見るので、ここを潰すと材料としての価値が落ちる（§22-8）
        let rules = rules();
        for text in [
            "http://127.0.0.1:8787",
            "ws://localhost:4173/ws",
            "http://192.168.1.20:8788",
        ] {
            assert_eq!(rules.apply(text), text, "{text}");
        }
    }

    #[test]
    fn 大文字の綴りでも伏せる() {
        // `(?i-u)` が効いていることを見る。ここが `(?i)` だと**組み立ての時点で
        // panic する**ので、このテストは「大文字も拾える」と「そもそも組める」の
        // 両方を押さえている
        let out = rules().apply("HTTPS://Dash.Example-Real.JP へ繋いだ");
        assert!(out.contains(HOST_PLACEHOLDER), "{out}");
        assert!(!out.contains("Example-Real"), "{out}");
    }

    #[test]
    fn 残存検査は接続先のホスト名も見る() {
        let leaks = rules().residue("接続先: https://dash.example-real.jp");
        assert!(
            leaks.iter().any(|leak| leak.contains("ホスト名")),
            "{leaks:?}"
        );
    }

    #[test]
    fn 残存検査は伏せ切れなかったものを述べる() {
        let rules = rules();
        let text = "/home/taro と someone@unknown-domain.co.jp";
        let leaks = rules.residue(text);
        assert!(
            leaks.iter().any(|leak| leak.contains("/home/taro")),
            "{leaks:?}"
        );
        assert!(
            leaks.iter().any(|leak| leak.contains("メールアドレス")),
            "{leaks:?}"
        );
        // 伏せたあとは何も残らない
        assert!(rules.residue(&rules.apply(text)).is_empty());
    }

    #[test]
    fn 伏せ字そのものを残存として数えない() {
        // 利用者名が伏せ字の一部と同じ綴りだと、伏せ終わった行が毎回
        // 「残っている」と報告される。**警告が毎行出ると誰も読まなくなる**
        let rules = Rules::from_parts("/home/user", Some("user"), None, &Account::default());
        let redacted = rules.apply("/home/user/Dev");
        assert_eq!(redacted, "/home/dashboard-user/Dev");
        assert!(
            rules.residue(&redacted).is_empty(),
            "{:?}",
            rules.residue(&redacted)
        );
    }

    #[test]
    fn 残存の報告にアカウント由来の実値を出さない() {
        let rules = rules();
        let leaks = rules.residue("Taro Yamada が残っている");
        assert_eq!(leaks.len(), 1, "{leaks:?}");
        assert!(!leaks[0].contains("Taro Yamada"), "{leaks:?}");
        assert!(leaks[0].contains("11 文字"), "{leaks:?}");
    }

    #[test]
    fn 環境由来の値は実値を伏せずに述べる() {
        // ホームのパスや利用者名は、この機械を触っている人には既知のもの。
        // 伏せると「何が残っているのか」が分からず直しようが無くなる
        let leaks = rules().residue("/home/taro");
        assert!(leaks[0].contains("/home/taro"), "{leaks:?}");
    }

    #[test]
    fn 規則が1つも無ければ何も変えない() {
        let rules = Rules::from_parts("", None, None, &Account::default());
        assert!(rules.is_empty());
        assert_eq!(rules.apply("そのまま"), "そのまま");
    }

    #[test]
    fn 読めないファイルからは空のアカウントを返す() {
        let missing = std::env::temp_dir().join("agentdashboard-redact-なにもない.json");
        let _ = std::fs::remove_file(&missing);
        assert_eq!(read_account(&missing), Account::default());
    }
}
