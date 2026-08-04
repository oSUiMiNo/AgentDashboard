//! 正式名と通称の対応表を、起動している CLI 自身から取り出す（設計§13）。
//!
//! # なぜバイナリを読むのか
//!
//! 画面に `Opus 5` のような**版番号つきの名前**を出したいが、`claude-opus-5` から
//! `Opus 5` を作るのは**こちらでやってはいけない**。版番号の付け方は CLI 側の都合で、
//! 実際 `claude-haiku-4-5-20251001` のように日付が付くものもあれば付かないものもある。
//!
//! 取得の経路を3つ比べた。
//!
//! | 経路 | 可否 |
//! |---|---|
//! | `claude --help` の choices | **無い。** `--model` は自由文字列で、権限モードとはここが違う |
//! | 公式ドキュメント | ネットワークとセッションホストが要る。別名の**意味**を追うにはこちらだが、対応表には重い |
//! | **CLI バイナリの中の表** | 起動している CLI 自身が持っている。実測で17件・0.2秒・無料 |
//!
//! 3つ目を採る。**いま動いている CLI の真実**なので、ドキュメントより確かでもある。
//!
//! # 公式の入口ではない、という前提で書く
//!
//! バンドルされた JS の中の文字列を拾っているだけなので、**書き方が変われば取れなくなる**。
//! だから次の2つを守る。
//!
//! - **取れなくても何も壊れない。** 空の対応表として扱い、画面は別名のラベル
//!   （`Opus`）を出す。切り替えて実測すればそちらが優先される（設計§12）
//! - **推測を実測より優先しない。** ここから引いた名前は「たぶんこれ」でしかない
//!
//! # いつ取り直すか
//!
//! **CLI のバージョンが変わったとき。** ラインナップが変わるのはそのときだけで、
//! 逆に言えばそれ以外では変わらない。取った結果は状態ディレクトリへ残し、
//! 同じバージョンなら読むだけで済ませる。

use crate::jsonfile;
use serde::{Deserialize, Serialize};
use std::io::Read as _;
use std::path::{Path, PathBuf};

/// 状態ディレクトリに置くファイル名。
const FILE_NAME: &str = "model-catalog.json";

/// 一度に読むバイト数。275MB を丸ごとメモリへ載せないための分割。
const CHUNK: usize = 4 * 1024 * 1024;

/// 分割の境目で目印が割れないように重ねる長さ。
///
/// 拾う1件は長くても200バイト程度なので、これだけ重ねれば跨いでも拾える。
const OVERLAP: usize = 512;

/// 対応表1件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogEntry {
    /// CLI が名乗る正式名（`claude-opus-5`）
    pub id: String,
    /// 系統（`opus`）。別名からいちばん新しいものを引くのに使う
    pub family: String,
    /// 画面に出す通称（`Opus 5`）
    pub display_name: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    /// 取ったときの CLI のバージョン。変わったら取り直す
    cli_version: String,
    models: Vec<CatalogEntry>,
}

/// 取り出した対応表。
#[derive(Debug, Default)]
pub struct ModelCatalog {
    models: Vec<CatalogEntry>,
    /// 取り出したときの CLI の版。**読めなければ空**。
    ///
    /// ここで持って回るのは、**同じプロセスで版を2回読む意味が無い**から。
    /// 自己修復は「CLI が上がったか」を見るのに同じ値を要るが、別々に読むと
    /// CLI をもう1回起こすことになる（設計§14 の契機はバージョン変化）。
    cli_version: String,
}

impl ModelCatalog {
    /// 何も分からない状態。
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn models(&self) -> &[CatalogEntry] {
        &self.models
    }

    pub fn is_empty(&self) -> bool {
        self.models.is_empty()
    }

    /// 対応表を取り出したときの CLI の版。読めなければ空文字。
    pub fn cli_version(&self) -> &str {
        &self.cli_version
    }

    /// 状態ディレクトリのキャッシュを使いつつ、必要なら CLI から取り直す。
    ///
    /// **失敗しても空で返る。** 対応表が無くても切替も表示も動く（別名のラベルが
    /// 出るだけ）ので、ここで起動を止める理由が無い。
    ///
    /// 版を読むのはここだけ。取れた値は [`Self::cli_version`] から配る。
    pub fn resolve(program: &str, state_dir: Option<PathBuf>) -> Self {
        let cli_version = cli_version(program).unwrap_or_default();
        let models = load_models(program, state_dir, &cli_version);
        Self {
            models,
            cli_version,
        }
    }
}

/// 保存してある対応表をそのまま使ってよいか。
///
/// | 保存した版 | いま読めた版 | 判断 |
/// |---|---|---|
/// | 同じ | — | 使う |
/// | 違う | 読めた | 取り直す（ラインナップが変わったかもしれない） |
/// | 何でも | **読めない（空）** | **使う** |
///
/// 最後の行が要点。ラッパースクリプト越しに起動している等で `--version` が読めないと、
/// 版を比べようがない。**比べられないことを理由に毎回275MBを読み直すより、前回の結果を
/// 使うほうがよい** — 表が古くて困るのは画面のラベルだけで、実際に切り替えれば実測が
/// 上書きする（設計§12）。
fn cache_is_usable(cached: &Stored, version: &str) -> bool {
    if cached.models.is_empty() {
        return false;
    }
    version.is_empty() || cached.cli_version == version
}

/// キャッシュか CLI のバイナリから対応表を決める。
fn load_models(program: &str, state_dir: Option<PathBuf>, version: &str) -> Vec<CatalogEntry> {
    let path = state_dir.map(|dir| dir.join(FILE_NAME));

    if let Some(path) = path.as_deref() {
        let cached = jsonfile::load_or_default::<Stored>(path);
        if cache_is_usable(&cached, version) {
            if version.is_empty() {
                // 黙って使うと「なぜ古い表が出るのか」を追えなくなる
                tracing::info!(
                    "CLI の版を読めないので、保存してあるモデル対応表をそのまま使います（{} 件・保存時 CLI {}）",
                    cached.models.len(),
                    cached.cli_version,
                );
            } else {
                tracing::debug!(
                    "モデル対応表をキャッシュから読みました（{} 件・CLI {version}）",
                    cached.models.len()
                );
            }
            return cached.models;
        }
    }

    let Some(binary) = locate(program) else {
        tracing::debug!("CLI の実体を見つけられないので、モデル対応表は空のままにします");
        return Vec::new();
    };
    let models = extract(&binary);
    if models.is_empty() {
        tracing::info!(
            path = %binary.display(),
            "CLI からモデル対応表を取り出せませんでした。別名のラベルで表示します"
        );
        return Vec::new();
    }

    tracing::info!(
        "モデル対応表を {} 件取り出しました（CLI {version}）",
        models.len()
    );
    if let Some(path) = path.as_deref() {
        jsonfile::save(
            path,
            &Stored {
                cli_version: version.to_string(),
                models: models.clone(),
            },
        );
    }
    models
}

/// `<program> --version` を1回だけ叩いて版を読む。
///
/// `--help` から権限モードを読んでいるのと同じ作法で、**モデルへ問い合わせないので
/// クォータを使わない**。
pub fn cli_version(program: &str) -> Option<String> {
    let output = std::process::Command::new(program)
        .arg("--version")
        // **標準入力を塞ぐ。** `--version` を知らない CLI は対話ループへ落ちるので、
        // 開けたままだと出力を待ち続けて起動が止まる
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // `2.1.220 (Claude Code)` の形。数字の並びだけを取る
    let version: String = text
        .chars()
        .skip_while(|ch| !ch.is_ascii_digit())
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
        .collect();
    (!version.is_empty()).then_some(version)
}

/// 実行ファイルの実体を探す。シンボリックリンクは辿る。
fn locate(program: &str) -> Option<PathBuf> {
    let direct = Path::new(program);
    if direct.is_absolute() || program.contains('/') {
        return std::fs::canonicalize(direct).ok();
    }
    // PATH を順に見る。`which` を呼ぶより依存が少ない
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
        .and_then(|found| std::fs::canonicalize(found).ok())
}

/// 実行ファイルを分割して読みながら、対応表を拾う。
fn extract(binary: &Path) -> Vec<CatalogEntry> {
    let Ok(mut file) = std::fs::File::open(binary) else {
        return Vec::new();
    };
    let mut found: Vec<CatalogEntry> = Vec::new();
    let mut buffer = vec![0u8; CHUNK];
    let mut carry: Vec<u8> = Vec::new();

    loop {
        let read = match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };
        let mut window = std::mem::take(&mut carry);
        window.extend_from_slice(&buffer[..read]);

        for entry in scan(&window) {
            if !found.iter().any(|known| known.id == entry.id) {
                found.push(entry);
            }
        }

        // 次の塊との境目で割れないよう、末尾を持ち越す
        let keep = window.len().min(OVERLAP);
        carry = window[window.len() - keep..].to_vec();
    }
    found
}

/// バイト列から `{id:"…",family:"…",display_name:"…"}` を拾う。
///
/// **並び順に依存している。** 崩れたら1件も拾えないが、それは「取れなかった」として
/// 扱えばよく、誤った対応を作るよりずっとよい。
fn scan(window: &[u8]) -> Vec<CatalogEntry> {
    const HEAD: &[u8] = br#"{id:"claude-"#;
    const FAMILY: &[u8] = br#"",family:""#;
    const NAME: &[u8] = br#"",display_name:""#;

    let mut out = Vec::new();
    let mut at = 0usize;
    while let Some(offset) = find(&window[at..], HEAD) {
        let start = at + offset + HEAD.len() - "claude-".len();
        at = start;

        let Some((id, rest)) = take_until(window, start, FAMILY) else {
            continue;
        };
        let Some((family, rest)) = take_until(window, rest, NAME) else {
            continue;
        };
        let Some((display_name, rest)) = take_until_quote(window, rest) else {
            continue;
        };
        at = rest;

        // 拾えたものが文字列として妥当かだけ確かめる。中身の意味は問わない
        if !id.is_empty() && !family.is_empty() && !display_name.is_empty() {
            out.push(CatalogEntry {
                id,
                family,
                display_name,
            });
        }
    }
    out
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// `from` から `marker` の手前までを文字列として取り出し、marker の直後の位置を返す。
fn take_until(window: &[u8], from: usize, marker: &[u8]) -> Option<(String, usize)> {
    let offset = find(&window[from..], marker)?;
    // 目印が遠すぎるなら、別のレコードを跨いで拾っている
    if offset > 64 {
        return None;
    }
    let text = std::str::from_utf8(&window[from..from + offset]).ok()?;
    Some((text.to_string(), from + offset + marker.len()))
}

/// `from` から次の `"` までを取り出す。
fn take_until_quote(window: &[u8], from: usize) -> Option<(String, usize)> {
    take_until(window, from, b"\"")
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    /// 実物のバンドルから採った並び（設計§13）。前後に無関係なコードが続く。
    const SAMPLE: &str = concat!(
        r#"cache_read:0.1}},models:[{id:"claude-3-5-haiku",family:"haiku",display_name:"Haiku 3.5","#,
        r#"provider_ids:{first_party:"claude-3-5-haiku-20241022"}},"#,
        r#"{id:"claude-haiku-4-5",family:"haiku",display_name:"Haiku 4.5",knowledge_cutoff:"February 2025"},"#,
        r#"{id:"claude-opus-5",family:"opus",display_name:"Opus 5",capabilities:[]},"#,
        r#"{id:"claude-fable-5",family:"fable",display_name:"Fable 5"}]"#,
    );

    #[test]
    fn 実物の並びから対応表を拾える() {
        let found = scan(SAMPLE.as_bytes());
        assert_eq!(found.len(), 4, "実際: {found:?}");
        assert_eq!(
            found[3],
            CatalogEntry {
                id: "claude-fable-5".to_string(),
                family: "fable".to_string(),
                display_name: "Fable 5".to_string(),
            }
        );
    }

    #[test]
    fn 日付つきのidも通称も欠けずに拾える() {
        // `claude-haiku-4-5-20251001` のように日付が付くものがある。
        // **id から版番号を作ってはいけない**ことの根拠でもある
        let text = r#"{id:"claude-haiku-4-5-20251001",family:"haiku",display_name:"Haiku 4.5"}"#;
        let found = scan(text.as_bytes());
        assert_eq!(found[0].id, "claude-haiku-4-5-20251001");
        assert_eq!(found[0].display_name, "Haiku 4.5");
    }

    #[test]
    fn 並びが崩れていたら1件も拾わない() {
        // 誤った対応を作るくらいなら、何も拾わないほうがよい
        let text = r#"{id:"claude-opus-5",display_name:"Opus 5",family:"opus"}"#;
        assert!(scan(text.as_bytes()).is_empty());
    }

    #[test]
    fn 関係のないバイト列からは何も拾わない() {
        assert!(scan(b"").is_empty());
        assert!(scan(b"claude-opus-5 is a model").is_empty());
        // 目印だけあって中身が続かない
        assert!(scan(br#"{id:"claude-"#).is_empty());
    }

    #[test]
    fn 同じidは重複させない() {
        let text = format!("{SAMPLE}{SAMPLE}");
        let mut found: Vec<CatalogEntry> = Vec::new();
        for entry in scan(text.as_bytes()) {
            if !found.iter().any(|known| known.id == entry.id) {
                found.push(entry);
            }
        }
        assert_eq!(found.len(), 4);
    }

    #[test]
    fn 実体を見つけられなければ空で返る() {
        // 擬似 claude を相手にしたテストでも、ここで落ちてはいけない
        let catalog = ModelCatalog::resolve("この名前の実行ファイルは無い", None);
        assert!(catalog.is_empty());
    }

    #[test]
    fn 対応表を持たない実行ファイルからは空で返る() {
        // 擬似 claude がまさにこれ。空でも切替と表示は動く
        let catalog = ModelCatalog::resolve("sh", None);
        assert!(catalog.is_empty());
    }

    // ---- キャッシュを使ってよいかの判断 -----------------------------------------

    fn stored(version: &str, count: usize) -> Stored {
        Stored {
            cli_version: version.to_string(),
            models: (0..count)
                .map(|index| CatalogEntry {
                    id: format!("claude-model-{index}"),
                    family: "model".to_string(),
                    display_name: format!("Model {index}"),
                })
                .collect(),
        }
    }

    #[test]
    fn 版が同じならキャッシュを使う() {
        assert!(cache_is_usable(&stored("2.1.220", 3), "2.1.220"));
    }

    #[test]
    fn 版が違えば取り直す() {
        // ラインナップが変わるのはバージョンが上がったときだけ（設計§13）
        assert!(!cache_is_usable(&stored("2.1.220", 3), "2.2.0"));
    }

    #[test]
    fn 版が読めないときはキャッシュを使う() {
        // **比べられないことを理由に毎回275MBを読み直さない。**
        // ラッパースクリプト越しだと `--version` が読めず、以前はここで必ず走査していた
        assert!(cache_is_usable(&stored("2.1.220", 3), ""));
        assert!(cache_is_usable(&stored("", 3), ""));
    }

    #[test]
    fn 表が空ならキャッシュを使わない() {
        // 「取れなかった」を覚え込んで永久に空を返し続けてはいけない
        assert!(!cache_is_usable(&stored("2.1.220", 0), "2.1.220"));
        assert!(!cache_is_usable(&stored("", 0), ""));
    }

    #[test]
    fn 版が読めなくてもキャッシュがあれば走査せずに返る() {
        // 実体を見つけられない実行ファイル＝走査は絶対にできない。それでも表が返るなら、
        // キャッシュだけで済ませたことになる
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-catalog-cache-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");
        crate::jsonfile::save(&dir.join(FILE_NAME), &stored("2.1.220", 2));

        let catalog = ModelCatalog::resolve("この名前の実行ファイルは無い", Some(dir.clone()));

        assert_eq!(catalog.models().len(), 2, "実際: {:?}", catalog.models());
        assert_eq!(catalog.cli_version(), "", "版は読めていないこと");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
