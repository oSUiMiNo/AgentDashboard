//! 結果を捨てている箇所の台帳（ログ設計§10-5）。
//!
//! ここが在る理由はひとつ。**「見ていない」と「見て捨ててよいと判断した」を分けるため**である。
//! 一部だけ載せると分けられなくなるので、製品コードの `let _ =` を**全部**載せる。
//!
//! # なぜ `let _ =` だけを数えるのか
//!
//! 実測すると、製品コードで結果を握り潰しているのは事実上この綴りだけだった——
//! 文の位置の `.ok();` は 0 件、空の `Err(_) => {}` も 0 件、`Result` を捨てる裸の
//! `drop(..)` も 0 件。一方 `unwrap_or` 系まで広げると母集合が3倍近くになり、
//! §10-5 の「すべて載せる」と両立しなくなる。**綴りを1つに決めて、他の綴りが
//! 出てきたら落ちる**形にしてある（`別の綴りで捨てていない`）。
//!
//! # この検査は自己修復の門には入っていない
//!
//! 修復セッションが書き換えてよいのは `transcript-parser` と `fixtures` だけで、
//! 門はそこのテストしか走らせない。**無人の claude がパーサへ `let _ =` を1件足しても
//! 門は緑**で、次の `make ci` まで気づけない。台帳を門へ足すこともできるが、台帳
//! （`crates/core/tests`）は許可範囲の外なので、そうすると修復が自力で直せなくなる。

#![allow(non_snake_case)]

use std::collections::BTreeMap;

/// 走査から外す crate。
///
/// `testkit` は**試験の道具**であって製品ではない。片付けの `let _ =` を多く持つが、
/// 配られる実行ファイルには入らない。
const SKIP_CRATES: &[&str] = &["testkit"];

/// 想定している crate の顔ぶれ。**増減したら走査の対象を決め直す。**
const CRATES: &[&str] = &[
    "core",
    "dist",
    "protocol",
    "server-core",
    "session-host",
    "session-host-core",
    "testkit",
    "transcript-parser",
];

/// 分類。**返り値の型で決める**（迷いを残さないため）。
const CLASSES: &[&str] = &["send", "by-design", "unused-value", "warn"];

/// 理由として認めない逃げ文句。
const 逃げ文句: &[&str] = &[
    "不要",
    "問題ない",
    "問題なし",
    "TODO",
    "とくに無し",
    "特に無し",
];

/// 理由の最低の長さ（文字）。1語で済ませられないようにする。
const REASON_MIN_CHARS: usize = 12;

// ---------------------------------------------------------------------------
// 走査
// ---------------------------------------------------------------------------

/// 1件の破棄。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Key {
    path: String,
    func: String,
    expr: String,
}

/// コード位置かどうかの面。
///
/// **正規表現では足りない。** 実在の理由が3つある。
///
/// 1. **複数行にまたがる式がある**。1行の正規表現だと式が `self` になる
/// 2. **コメントの中に `let _ =` がある**（`logging.rs` の「そう書くな」という注意書き
///    そのもの）。載せると台帳が嘘をつく
/// 3. **素朴な `"` のトグルは文字リテラル `'"'` から先を丸ごと読み飛ばす**。今日は
///    たまたま影響が無いが、その上に `let _ =` を書いた瞬間、**落ちずに件数だけ減る**
fn code_mask(source: &str) -> (Vec<char>, Vec<bool>) {
    let chars: Vec<char> = source.chars().collect();
    let mut code = vec![true; chars.len()];
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];
        // 行コメント
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                code[i] = false;
                i += 1;
            }
            continue;
        }
        // ブロックコメント（入れ子）
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            let mut depth = 0usize;
            while i < chars.len() {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    code[i] = false;
                    code[i + 1] = false;
                    i += 2;
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    code[i] = false;
                    code[i + 1] = false;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    code[i] = false;
                    i += 1;
                }
            }
            continue;
        }
        // 生文字列 r"..." / r#"..."# / br#"..."#
        if c == 'r' || (c == 'b' && chars.get(i + 1) == Some(&'r')) {
            let mut j = if c == 'b' { i + 2 } else { i + 1 };
            let hashes_start = j;
            while chars.get(j) == Some(&'#') {
                j += 1;
            }
            let hashes = j - hashes_start;
            if chars.get(j) == Some(&'"') {
                j += 1;
                // 閉じは `"` ＋ 同じ数の `#`
                while j < chars.len() {
                    if chars[j] == '"' && chars[j + 1..].iter().take(hashes).all(|c| *c == '#') {
                        j += 1 + hashes;
                        break;
                    }
                    j += 1;
                }
                for slot in code.iter_mut().take(j.min(chars.len())).skip(i) {
                    *slot = false;
                }
                i = j;
                continue;
            }
        }
        // 文字列 "..." / b"..."
        if c == '"' || (c == 'b' && chars.get(i + 1) == Some(&'"')) {
            let mut j = if c == 'b' { i + 2 } else { i + 1 };
            while j < chars.len() {
                if chars[j] == '\\' {
                    j += 2;
                    continue;
                }
                if chars[j] == '"' {
                    j += 1;
                    break;
                }
                j += 1;
            }
            for slot in code.iter_mut().take(j.min(chars.len())).skip(i) {
                *slot = false;
            }
            i = j;
            continue;
        }
        // 文字リテラル '.' / '\n' / b'.'。**ライフタイム `'a` と見分ける**
        if c == '\'' || (c == 'b' && chars.get(i + 1) == Some(&'\'')) {
            let start = i;
            let q = if c == 'b' { i + 1 } else { i };
            let body = q + 1;
            let end = if chars.get(body) == Some(&'\\') {
                // エスケープ。閉じ引用符まで（最大でも数文字）
                let mut j = body + 1;
                while j < chars.len() && chars[j] != '\'' && j - body < 8 {
                    j += 1;
                }
                (chars.get(j) == Some(&'\'')).then_some(j + 1)
            } else if chars.get(body + 1) == Some(&'\'') {
                Some(body + 2)
            } else {
                None // ライフタイム
            };
            if let Some(end) = end {
                for slot in code.iter_mut().take(end.min(chars.len())).skip(start) {
                    *slot = false;
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    (chars, code)
}

/// コード位置だけを見て、その位置より前で最後に現れた `fn NAME` を引く表。
fn function_at(chars: &[char], code: &[bool]) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 3 < chars.len() {
        if code[i]
            && chars[i] == 'f'
            && chars[i + 1] == 'n'
            && chars[i + 2].is_whitespace()
            && (i == 0 || !(chars[i - 1].is_alphanumeric() || chars[i - 1] == '_'))
        {
            let mut j = i + 2;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let start = j;
            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            if j > start {
                out.push((i, chars[start..j].iter().collect()));
            }
            i = j;
            continue;
        }
        i += 1;
    }
    out
}

/// 1ファイルを走査して、捨てている式を拾う。
fn scan(source: &str) -> Vec<(String, String)> {
    let (chars, code) = code_mask(source);

    // **試験の側は数えない。** 最初の `#[cfg(test)]` から下を落とす
    let cut = find_code(&chars, &code, "#[cfg(test)]").unwrap_or(chars.len());
    let funcs = function_at(&chars[..cut], &code[..cut]);

    let needle: Vec<char> = "let _ = ".chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + needle.len() <= cut {
        if code[i] && chars[i..i + needle.len()] == needle[..] {
            let start = i + needle.len();
            // 深さ0の `;` まで
            let mut depth = 0i32;
            let mut j = start;
            while j < cut {
                if code[j] {
                    match chars[j] {
                        '(' | '[' | '{' => depth += 1,
                        ')' | ']' | '}' => depth -= 1,
                        ';' if depth == 0 => break,
                        _ => {}
                    }
                }
                j += 1;
            }
            assert!(j < cut, "式の終わりを見つけられません（`;` が無い）");

            let func = funcs
                .iter()
                .rev()
                .find(|(pos, _)| *pos < i)
                .map_or_else(|| "(自由な位置)".to_string(), |(_, name)| name.clone());
            out.push((func, normalize(&chars[start..j], &code[start..j])));
            i = j;
            continue;
        }
        i += 1;
    }
    out
}

fn find_code(chars: &[char], code: &[bool], needle: &str) -> Option<usize> {
    let needle: Vec<char> = needle.chars().collect();
    (0..chars.len().saturating_sub(needle.len()))
        .find(|&i| code[i] && chars[i..i + needle.len()] == needle[..])
}

/// 式の綴りを揃える。**コード位置の空白だけを畳む**（文字列の中はそのまま）。
fn normalize(chars: &[char], code: &[bool]) -> String {
    let mut out = String::new();
    let mut pending_space = false;
    for (i, c) in chars.iter().enumerate() {
        if code[i] && c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            // rustfmt がメソッドチェーンを折り返した跡は詰める
            if !(code[i] && *c == '.') {
                out.push(' ');
            }
            pending_space = false;
        }
        out.push(*c);
    }
    out.trim().to_string()
}

// ---------------------------------------------------------------------------
// ファイルの集め方
// ---------------------------------------------------------------------------

/// cargo workspace の根（`server/`）。`crates/core` から2つ上。
fn server_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("server の下")
        .to_path_buf()
}

/// `crates/*/src/**/*.rs` を集める。`walkdir` は足さず、手書きの再帰で歩く
/// （`server-core/tests/db.rs` の `番兵の綴りは1箇所にしか無い` と同じ型紙）。
fn sources() -> Vec<(String, std::path::PathBuf)> {
    let crates = server_root().join("crates");
    let crates = crates.canonicalize().expect("crates を辿れること");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&crates).expect("crates を読めること") {
        let dir = entry.expect("項目を読めること").path();
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !dir.is_dir() || SKIP_CRATES.contains(&name.as_str()) {
            continue;
        }
        let src = dir.join("src");
        if !src.is_dir() {
            continue;
        }
        let mut stack = vec![src.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("ソースを読めること") {
                let path = entry.expect("項目を読めること").path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    let rel = path
                        .strip_prefix(&crates)
                        .expect("crates の下")
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.push((format!("server/crates/{rel}"), path));
                }
            }
        }
    }
    out.sort();
    out
}

/// 実コードから集めた集合。
fn discovered() -> BTreeMap<Key, usize> {
    let mut found: BTreeMap<Key, usize> = BTreeMap::new();
    for (rel, path) in sources() {
        let source = std::fs::read_to_string(&path).expect("ソースを読めること");
        for (func, expr) in scan(&source) {
            *found
                .entry(Key {
                    path: rel.clone(),
                    func,
                    expr,
                })
                .or_default() += 1;
        }
    }
    found
}

// ---------------------------------------------------------------------------
// 台帳
// ---------------------------------------------------------------------------

struct Entry {
    key: Key,
    count: usize,
    class: String,
    reason: String,
}

fn ledger() -> Vec<Entry> {
    let text = include_str!("swallowed.toml");
    let table: toml::Table = text.parse().expect("台帳が TOML として妥当なこと");
    // 初版を起こすときは空でよい。**そのときは `一致` の失敗が骨組みを吐く**
    let empty = Vec::new();
    let entries = table
        .get("entry")
        .and_then(toml::Value::as_array)
        .unwrap_or(&empty);

    entries
        .iter()
        .map(|value| {
            let table = value.as_table().expect("entry は表であること");
            for key in table.keys() {
                assert!(
                    ["path", "fn", "expr", "class", "reason", "count"].contains(&key.as_str()),
                    "台帳に知らないキー {key} があります。打ち間違いなら直し、\
                     増やすなら台帳の先頭の説明にも書くこと"
                );
            }
            let get = |name: &str| -> String {
                table
                    .get(name)
                    .and_then(toml::Value::as_str)
                    .unwrap_or_else(|| panic!("{name} が無い項目があります: {table:?}"))
                    .to_string()
            };
            Entry {
                key: Key {
                    path: get("path"),
                    func: get("fn"),
                    expr: get("expr"),
                },
                count: table
                    .get("count")
                    .and_then(toml::Value::as_integer)
                    .unwrap_or(1) as usize,
                class: get("class"),
                reason: get("reason"),
            }
        })
        .collect()
}

/// 失敗の出力に貼れる形。**理由と分類は空**にして出す——空のままでは次の検査で落ちる。
fn 貼れる形(key: &Key, count: usize) -> String {
    let mut out = format!(
        "\n[[entry]]\npath = \"{}\"\nfn = \"{}\"\nexpr = '''{}'''\n",
        key.path, key.func, key.expr
    );
    if count > 1 {
        out.push_str(&format!("count = {count}\n"));
    }
    out.push_str("class = \"\"    # send / by-design / unused-value / warn\n");
    out.push_str("reason = \"\"   # なぜ捨ててよいのか。書けないなら、捨てるのをやめる\n");
    out
}

// ---------------------------------------------------------------------------
// 検査
// ---------------------------------------------------------------------------

#[test]
fn 台帳と実際に捨てている箇所が一致する() {
    let found = discovered();
    let ledger = ledger();
    let mut listed: BTreeMap<&Key, usize> = BTreeMap::new();
    for entry in &ledger {
        assert!(
            listed.insert(&entry.key, entry.count).is_none(),
            "台帳に同じ鍵が2度出ています（{}::{}::{}）。1件1エントリにして count でまとめること",
            entry.key.path,
            entry.key.func,
            entry.key.expr
        );
    }

    let 足りない: Vec<String> = found
        .iter()
        .filter(|(key, _)| !listed.contains_key(key))
        .map(|(key, count)| 貼れる形(key, *count))
        .collect();
    assert!(
        足りない.is_empty(),
        "台帳に無い破棄が {} 件あります。捨てるのをやめるか、理由を書いて \
         server/crates/core/tests/swallowed.toml へ足すこと:\n{}",
        足りない.len(),
        足りない.join("")
    );

    let 余り: Vec<String> = listed
        .keys()
        .filter(|key| !found.contains_key(**key))
        .map(|key| format!("{}::{}::{}", key.path, key.func, key.expr))
        .collect();
    assert!(
        余り.is_empty(),
        "台帳にあるのにコードに無い項目が {} 件あります。声を与えた（設計§10-3）／\
         直した／関数の名前が変わったなら、台帳からも消すか直すこと:\n{}",
        余り.len(),
        余り.join("\n")
    );

    let 件数違い: Vec<String> = found
        .iter()
        .filter_map(|(key, count)| {
            let listed = listed.get(key)?;
            (listed != count).then(|| {
                format!(
                    "{}::{}::{}  台帳 {listed} / 実際 {count}",
                    key.path, key.func, key.expr
                )
            })
        })
        .collect();
    assert!(
        件数違い.is_empty(),
        "同じ鍵の件数が台帳と違います。増えたぶんの理由が同じなら count を直し、\
         違うなら**式か関数のほうを分ける**こと（変数名を変える・関数を切る）:\n{}",
        件数違い.join("\n")
    );
}

#[test]
fn 台帳のすべての項目が理由と分類を持っている() {
    let ledger = ledger();
    assert!(!ledger.is_empty(), "台帳が空です");

    for entry in &ledger {
        let 名 = format!("{}::{}", entry.key.path, entry.key.func);
        assert!(
            CLASSES.contains(&entry.class.as_str()),
            "{名} の class が「{}」です。{CLASSES:?} のどれかにすること",
            entry.class
        );
        assert!(
            entry.reason.chars().count() >= REASON_MIN_CHARS,
            "{名} に理由がありません。捨ててよい理由を1文で書くこと。\
             書けないなら捨てるのをやめる（実際: 「{}」）",
            entry.reason
        );
        assert!(
            !逃げ文句.iter().any(|word| entry.reason.trim() == *word),
            "{名} の理由が中身を持っていません。「何が起きても構わないのはなぜか」を書くこと"
        );
        assert!(
            entry.reason != entry.key.expr,
            "{名} の理由が式の写しになっています"
        );
        assert!(
            entry.count >= 1,
            "{名} の count は 2 以上のときだけ書くこと（1 は既定）"
        );
        for field in [&entry.reason, &entry.key.expr] {
            assert!(
                !field.contains(".rs:"),
                "{名} に行番号が入りました。**行は動く**ので、鍵にも理由にも使わないこと"
            );
        }
    }

    let mut sorted: Vec<&Key> = ledger.iter().map(|entry| &entry.key).collect();
    let original = sorted.clone();
    sorted.sort();
    assert_eq!(
        sorted, original,
        "台帳の並びが崩れています。path → fn → expr の昇順に並べること\
         （**位置ではなく名前で並べる**ので、行が動いても並びは変わらない）"
    );
}

#[test]
fn 走査規則そのものが生きている() {
    // 「見つけられなかったのに緑」を防ぐ番人
    // （`transcript-parser/tests/fixtures.rs` の `discover` と同じ作法）
    let files = sources();
    assert!(
        files.len() >= 90,
        "ソースを見つけられていません（探した場所: {}、見つけた数: {}）",
        server_root().display(),
        files.len()
    );

    let mut crates: Vec<String> = std::fs::read_dir(
        server_root()
            .join("crates")
            .canonicalize()
            .expect("crates を辿れること"),
    )
    .expect("crates を読めること")
    .filter_map(|entry| {
        let path = entry.ok()?.path();
        if !path.is_dir() {
            return None;
        }
        Some(path.file_name()?.to_string_lossy().into_owned())
    })
    .collect();
    crates.sort();
    assert_eq!(
        crates, CRATES,
        "crate が増減しています。台帳の走査対象に入れるか、testkit と同じ理由で\
         外すかを決めること"
    );

    assert!(
        discovered().len() >= 40,
        "捨てている箇所を {} 件しか見つけられませんでした。**走査器が壊れています。**\
         台帳を削って揃えてはいけません",
        discovered().len()
    );

    // `#[cfg(test)]` の直後が `mod tests` であること。ここが崩れると、製品コードが
    // 黙って走査から外れる
    for (rel, path) in files {
        let source = std::fs::read_to_string(&path).expect("読めること");
        let (chars, code) = code_mask(&source);
        let Some(cut) = find_code(&chars, &code, "#[cfg(test)]") else {
            continue;
        };
        let rest: String = chars[cut..].iter().collect();
        let next = rest
            .lines()
            .nth(1)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        assert!(
            next.starts_with("mod tests"),
            "{rel} の #[cfg(test)] の直後が `mod tests` ではありません（{next}）。\
             走査は最初の #[cfg(test)] から下を試験用として切り捨てるので、\
             ここが製品コードなら**黙って台帳から漏れます**"
        );
        // **割合では見ない。** 小さいモジュールは製品コードより試験のほうが長いことが
        // 普通にある（`jsonfile.rs` は諦め口5つに対してテストが7本）。見たいのは
        // 「切り口が壊れていないか」なので、**製品側に中身が残っていること**を見る
        let 製品: String = chars[..cut].iter().collect();
        assert!(
            製品.contains("fn ") || 製品.contains("struct ") || 製品.contains("enum "),
            "{rel} の製品側が空です。#[cfg(test)] の見つけ方が壊れていて、\
             **製品コードが丸ごと走査から漏れています**"
        );
    }
}

#[test]
fn 別の綴りで捨てていない() {
    // 走査は `let _ = ` という綴りしか見ない。**別の綴りで捨てられると台帳から漏れる。**
    let mut 揺れ = Vec::new();
    for (rel, path) in sources() {
        let source = std::fs::read_to_string(&path).expect("読めること");
        let (chars, code) = code_mask(&source);
        let cut = find_code(&chars, &code, "#[cfg(test)]").unwrap_or(chars.len());
        let 製品: String = (0..cut)
            .map(|i| if code[i] { chars[i] } else { ' ' })
            .collect();
        // **文の位置の `.ok();` だけを見る。** `let x = f().ok();` や
        // `return f().ok();` は値として使っているので握り潰しではない
        for line in 製品.lines() {
            let line = line.trim();
            if line.ends_with(".ok();") && !line.contains('=') && !line.starts_with("return") {
                揺れ.push(format!("{rel}: 文の位置の `.ok();` — {line}"));
            }
        }
        for (綴り, 説明) in [
            ("Err(_) => {}", "空の `Err(_) => {}`"),
            ("let _=", "空白の抜けた `let _=`"),
        ] {
            if 製品.contains(綴り) {
                揺れ.push(format!("{rel}: {説明}"));
            }
        }
    }
    assert!(
        揺れ.is_empty(),
        "`let _ = ` 以外の綴りで結果を捨てています:\n{}\n\
         走査器はこの綴りしか見ないので**台帳へ載りません**。綴りを揃えるか、受けて処理すること",
        揺れ.join("\n")
    );
}

#[test]
fn 走査器は紛らわしい書き方に騙されない() {
    // §走査 の3つの理由を機械にしたもの。**ここが崩れると、台帳は落ちずに件数だけ減る。**
    const 標本: &str = r##"
/// **返り値を落としてはいけない。** `let _ = install(..)` と書くと即座にドロップされる
fn 説明だけ() {}

fn 引用符を含む文字リテラル() {
    let text = input.trim().trim_matches('"').trim();
    let _ = std::fs::remove_file(&path);
}

fn 生文字列() {
    let key = r#""tool_use""#;
    let _ = out.flush();
}

fn 折り返し() {
    let _ = self
        .requests
        .try_send(ParserRequest::Watch { card_id, path });
}

fn 文字列の中のセミコロン() {
    let _ = writeln!(stdout, "a; b // c");
}

fn ライフタイム<'a>(x: &'a str) {
    let _ = x.len();
}

#[cfg(test)]
mod tests {
    fn ここは数えない() {
        let _ = 見えてはいけない();
    }
}
"##;

    let found = scan(標本);
    let expected: Vec<(String, String)> = [
        ("引用符を含む文字リテラル", "std::fs::remove_file(&path)"),
        ("生文字列", "out.flush()"),
        (
            "折り返し",
            "self.requests.try_send(ParserRequest::Watch { card_id, path })",
        ),
        ("文字列の中のセミコロン", r#"writeln!(stdout, "a; b // c")"#),
        ("ライフタイム", "x.len()"),
    ]
    .into_iter()
    .map(|(f, e)| (f.to_string(), e.to_string()))
    .collect();

    assert_eq!(
        found, expected,
        "走査器が紛らわしい書き方に騙されています。**これが崩れると、台帳は落ちずに\
         件数だけ減る**"
    );
}
