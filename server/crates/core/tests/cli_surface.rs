//! 画面と CLI の口の対応台帳の見張り（CLI設計§11）。
//!
//! 要件「以降の開発で画面に口を足したら CLI も追従する」を、文書ではなく**実コードと
//! 食い違うと落ちる台帳**として持つ。`swallowed.toml` と同じ手口である（文書だけでは
//! 腐る。§11-1）。ブラウザが叩ける口——WebSocket の `ClientMessage` と REST——を
//! ソースから数え上げ、`cli_surface.toml` の行と突き合わせる。
//!
//! # なぜ正規表現ではなく文字単位の走査か
//!
//! `.route("/api/projects", get(api_list).post(api_add))` のように**1つのパスに動詞が
//! 2つ**付く形があり、行単位の正規表現は片方を取りこぼす（§11-3）。`swallowed.rs` が
//! 同じ理由で文字単位の走査にしているので、括弧の対応を数える書き方に揃えた。
//! ただしコードは共有しない——あちらの `code_mask` は式の綴りが欲しくて**文字列を
//! 潰す**が、こちらはパスが文字列の中に居るので**文字列を残してコメントだけ潰す**。
//! 目的が逆である。

#![allow(non_snake_case)]

use std::collections::BTreeSet;

/// 台帳の本体。コンパイル時に埋め込む（実行時にパスを探して読み損ねる形を作らない）。
const LEDGER: &str = include_str!("cli_surface.toml");

/// 鍵の内側のルータを持つファイル（§11-3）。`require_identity` を通る口はこの4つの
/// 外には無い。増えたら「口の数が設計から動いていない」が先に落ちて気づける。
const 鍵の内側: &[&str] = &[
    "crates/server-core/src/lib.rs",
    "crates/core/src/settings_api.rs",
    "crates/core/src/versions_api.rs",
    "crates/server-core/src/account.rs",
];

/// 鍵の外側の口を持つファイル（§3-2）。**載せない判断ごと台帳に残す**ための対象。
/// `/agent/ws`（gateway）と `/hook/…`（hooks.rs）は PC 側の受け口であって
/// 画面の口ではないので、範囲外（§11-3）。
const 鍵の外側: &[&str] = &[
    "crates/server-core/src/auth.rs",
    "crates/server-core/src/client_logs.rs",
];

/// REST として数えない口。`/ws` は WebSocket の入口そのもので、そこを流れる操作は
/// kind = "ws" の13行が数える。
const REST以外: &[&str] = &["/ws"];

/// `ClientMessage` の置き場所。
const WS_SOURCE: &str = "crates/protocol/src/ws.rs";

/// アカウント分離の総当たりの置き場所。
const TENANCY_SOURCE: &str = "crates/server-core/tests/tenancy.rs";

/// 口の数の固定（設計§1-1「新しい口を1つも作らない」）。CLI はブラウザの席に
/// 座るだけなので、この作業列で口は1つも増えない。**口を増やす設計判断をしたとき
/// だけ**、意識してこの数字を上げる。
const WS_VARIANTS: usize = 15;
const INSIDE_DOORS: usize = 27;
const OUTSIDE_DOORS: usize = 5;

/// tenancy.rs の総当たりの本数。口が増えないなら総当たりも増えない（§1-1）。
/// enforcement を足したときだけ意識して上げる。
const TENANCY_TESTS: usize = 26;

/// `command` に書ける群の先頭語。誤記（存在しない群）を機械で捕まえる。
const 群: &[&str] = &[
    "session", "project", "host", "settings", "version", "account", "logs",
];

/// 理由として認めない逃げ文句（`swallowed.rs` と同じ一覧）。
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

/// ルータの動詞。`axum::routing::delete(..)` の完全修飾は最後の語で見る
/// （account.rs が実際にこの綴りで書いている）。
const 動詞: &[&str] = &["get", "post", "put", "delete", "patch", "head"];

// ---------------------------------------------------------------------------
// 走査
// ---------------------------------------------------------------------------

/// コメントを空白へ潰す。**文字列リテラルは残す**——route のパスは文字列の中に居る。
/// 文字列の中の `//` をコメントと読まないために、状態を持って歩く。
fn strip_comments(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                out.push(' ');
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            let mut depth = 1;
            out.push_str("  ");
            i += 2;
            while i < chars.len() && depth > 0 {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    out.push_str("  ");
                    i += 2;
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    out.push_str("  ");
                    i += 2;
                } else {
                    out.push(if chars[i] == '\n' { '\n' } else { ' ' });
                    i += 1;
                }
            }
        } else if c == '"' {
            out.push(c);
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' {
                    out.push('\\');
                    if let Some(&escaped) = chars.get(i + 1) {
                        out.push(escaped);
                    }
                    i += 2;
                    continue;
                }
                out.push(chars[i]);
                if chars[i] == '"' {
                    i += 1;
                    break;
                }
                i += 1;
            }
        } else if c == '\'' {
            // 文字リテラルだけ消費し、ライフタイムの ' はそのまま流す
            let next = chars.get(i + 1).copied();
            if next == Some('\\') {
                out.push(c);
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\\' {
                        out.push('\\');
                        if let Some(&escaped) = chars.get(i + 1) {
                            out.push(escaped);
                        }
                        i += 2;
                        continue;
                    }
                    out.push(chars[i]);
                    if chars[i] == '\'' {
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            } else if chars.get(i + 2) == Some(&'\'') {
                out.push(c);
                out.push(next.unwrap_or(' '));
                out.push('\'');
                i += 3;
            } else {
                out.push(c);
                i += 1;
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// 最初の `#[cfg(test)]` から下を切り捨てる（`swallowed.rs` と同じ作法）。
fn 製品側(clean: &str) -> &str {
    match clean.find("#[cfg(test)]") {
        Some(pos) => &clean[..pos],
        None => clean,
    }
}

/// `from` 以降で `needle` が最初に現れる位置。
fn find_from(hay: &[char], from: usize, needle: &str) -> Option<usize> {
    let needle: Vec<char> = needle.chars().collect();
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == needle[..])
}

/// `at` の開き `"` から文字列を読み、（中身, 閉じの次の位置）を返す。
fn 文字列(chars: &[char], at: usize) -> (String, usize) {
    let mut out = String::new();
    let mut i = at + 1;
    while i < chars.len() {
        match chars[i] {
            '\\' => {
                if let Some(&escaped) = chars.get(i + 1) {
                    out.push(escaped);
                }
                i += 2;
            }
            '"' => return (out, i + 1),
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    panic!("閉じられていない文字列（走査器が読めない書き方が入った）");
}

/// `at` の開き括弧から対応する閉じまで飛ばし、閉じの次の位置を返す。
fn 対応を飛ばす(chars: &[char], at: usize, open: char, close: char) -> usize {
    assert_eq!(
        chars.get(at),
        Some(&open),
        "開き {open:?} の位置から呼ぶこと"
    );
    let mut depth = 0usize;
    let mut i = at;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            i = 文字列(chars, i).1;
            continue;
        }
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
        }
        i += 1;
    }
    panic!("対応する {close:?} が見つからない（走査器が読めない書き方が入った）");
}

/// `.route(...)` から（動詞, パス）の組を全部拾う。
///
/// 呼び出しの括弧を深さで辿り、**深さ1**に現れた `get(`／`post(`／… だけを動詞と
/// 数える——`get(a).post(b)` の2動詞1パスを取りこぼさず、ハンドラ名の中の `get` は
/// 深さ2に居るので数えない。パスは深さ1の最初の文字列リテラル。
fn scan_routes(source: &str) -> Vec<(String, String)> {
    let clean = strip_comments(source);
    let clean = 製品側(&clean);
    let chars: Vec<char> = clean.chars().collect();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(pos) = find_from(&chars, from, ".route(") {
        let mut i = pos + ".route(".len();
        from = i;
        let mut depth = 1usize;
        let mut path: Option<String> = None;
        let mut ident = String::new();
        let mut methods: Vec<String> = Vec::new();
        while i < chars.len() && depth > 0 {
            let c = chars[i];
            match c {
                '"' => {
                    let (text, next) = 文字列(&chars, i);
                    if depth == 1 && path.is_none() {
                        path = Some(text);
                    }
                    ident.clear();
                    i = next;
                    continue;
                }
                '(' => {
                    let last = ident.rsplit("::").next().unwrap_or("");
                    if depth == 1 && 動詞.contains(&last) {
                        methods.push(last.to_uppercase());
                    }
                    depth += 1;
                    ident.clear();
                }
                ')' => {
                    depth -= 1;
                    ident.clear();
                }
                c if c.is_alphanumeric() || c == '_' || c == ':' => ident.push(c),
                _ => ident.clear(),
            }
            i += 1;
        }
        let Some(path) = path else {
            panic!(
                ".route の第1引数に文字列のパスが見つからない（走査器が読めない書き方が入った）"
            );
        };
        for method in methods {
            out.push((method, path.clone()));
        }
    }
    out
}

/// `pub enum ClientMessage { … }` の variant 名を拾う。doc コメントは
/// `strip_comments` が消し、属性と variant の本文は括弧の対応で飛ばす。
fn scan_variants(source: &str) -> Vec<String> {
    let clean = strip_comments(source);
    let clean = 製品側(&clean);
    let chars: Vec<char> = clean.chars().collect();
    let start =
        find_from(&chars, 0, "pub enum ClientMessage").expect("pub enum ClientMessage が居ること");
    let mut i = start;
    while chars.get(i) != Some(&'{') {
        i += 1;
    }
    i += 1;
    let mut out = Vec::new();
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        match chars.get(i) {
            Some('}') | None => break,
            Some(',') => i += 1,
            Some('#') => {
                let mut j = i + 1;
                while chars.get(j) != Some(&'[') {
                    j += 1;
                }
                i = 対応を飛ばす(&chars, j, '[', ']');
            }
            Some(&c) if c.is_alphanumeric() || c == '_' => {
                let mut name = String::new();
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    name.push(chars[i]);
                    i += 1;
                }
                out.push(name);
                while i < chars.len() && chars[i].is_whitespace() {
                    i += 1;
                }
                match chars.get(i) {
                    Some('{') => i = 対応を飛ばす(&chars, i, '{', '}'),
                    Some('(') => i = 対応を飛ばす(&chars, i, '(', ')'),
                    _ => {}
                }
            }
            Some(&other) => {
                panic!("variant の並びに知らない字 {other:?}（走査器が読めない書き方が入った）")
            }
        }
    }
    out
}

/// variant 名を serde の札（snake_case）にする。`rename_all = "snake_case"` の写し。
fn snake_case(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// ファイルの集め方
// ---------------------------------------------------------------------------

/// cargo workspace の根（`server/`）。`crates/core` から2つ上（`swallowed.rs` と同じ）。
fn server_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("server の下")
        .to_path_buf()
}

/// リポジトリの根。`web/` はワークスペースの外に居る。
fn repo_root() -> std::path::PathBuf {
    server_root()
        .parent()
        .expect("リポジトリの根")
        .to_path_buf()
}

fn 読む(rel: &str) -> String {
    let path = server_root().join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} を読めること: {e}", path.display()))
}

/// 鍵の内側の（動詞, パス）。ローカルとサーバで同じ口を二重に定義している箇所
/// （settings_api の `routes` と `server_routes`）は、集合にして1口へ畳む——台帳が
/// 数えるのは**口**であって、定義の箇所ではない。
fn 内側の口() -> BTreeSet<(String, String)> {
    let mut out = BTreeSet::new();
    for file in 鍵の内側 {
        for (method, path) in scan_routes(&読む(file)) {
            if REST以外.contains(&path.as_str()) {
                continue;
            }
            out.insert((method, path));
        }
    }
    out
}

/// 鍵の外側の（動詞, パス）。
fn 外側の口() -> BTreeSet<(String, String)> {
    let mut out = BTreeSet::new();
    for file in 鍵の外側 {
        for pair in scan_routes(&読む(file)) {
            out.insert(pair);
        }
    }
    out
}

/// 画面（ブラウザ）が叩ける口の全体。台帳と突き合わせる（kind, target）の形。
fn 画面の口() -> BTreeSet<(String, String)> {
    let mut out = BTreeSet::new();
    for variant in scan_variants(&読む(WS_SOURCE)) {
        out.insert(("ws".to_string(), format!("ClientMessage::{variant}")));
    }
    for (method, path) in 内側の口().into_iter().chain(外側の口()) {
        out.insert(("rest".to_string(), format!("{method} {path}")));
    }
    out
}

// ---------------------------------------------------------------------------
// 台帳
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Entry {
    kind: String,
    target: String,
    command: Option<String>,
    skip: bool,
    reason: Option<String>,
}

fn 台帳(text: &str) -> Vec<Entry> {
    let table: toml::Table = text
        .parse()
        .expect("cli_surface.toml が TOML として読めること");
    assert_eq!(
        table.len(),
        1,
        "台帳のトップレベルは [[entry]] だけにする（見つかったキー: {:?}）",
        table.keys().collect::<Vec<_>>()
    );
    let list = table
        .get("entry")
        .and_then(toml::Value::as_array)
        .expect("[[entry]] の並びであること");
    list.iter()
        .map(|value| {
            let item = value.as_table().expect("entry はテーブルであること");
            for key in item.keys() {
                assert!(
                    ["kind", "target", "command", "skip", "reason"].contains(&key.as_str()),
                    "知らないキー {key:?}。台帳の形は cli_surface.toml の頭のコメントを見る"
                );
            }
            Entry {
                kind: item
                    .get("kind")
                    .and_then(toml::Value::as_str)
                    .expect("kind は文字列であること")
                    .to_string(),
                target: item
                    .get("target")
                    .and_then(toml::Value::as_str)
                    .expect("target は文字列であること")
                    .to_string(),
                command: item
                    .get("command")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string),
                skip: item
                    .get("skip")
                    .and_then(toml::Value::as_bool)
                    .unwrap_or(false),
                reason: item
                    .get("reason")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string),
            }
        })
        .collect()
}

/// 台帳の約束（§11-4）を破っている行の一覧。空なら約束どおり。
fn 約束破り(entries: &[Entry]) -> Vec<String> {
    let mut out = Vec::new();
    for entry in entries {
        let 誰 = format!("{} {}", entry.kind, entry.target);
        if !["ws", "rest"].contains(&entry.kind.as_str()) {
            out.push(format!("{誰}: kind は ws か rest のどちらか"));
        }
        match (&entry.command, entry.skip) {
            (Some(_), true) => out.push(format!(
                "{誰}: command と skip は排他。CLI へ写したなら command、載せない判断なら skip"
            )),
            (None, false) => out.push(format!(
                "{誰}: command も skip も無い。写したか、載せない判断をしたか、どちらかを書く"
            )),
            (Some(command), false) => {
                if entry.reason.is_some() {
                    out.push(format!(
                        "{誰}: command の行に reason は書かない。説明が要るのは載せない判断のほうだけ"
                    ));
                }
                for piece in command.split(" / ") {
                    let head = piece.split_whitespace().next().unwrap_or("");
                    if !群.contains(&head) {
                        out.push(format!(
                            "{誰}: command の先頭語 {head:?} は実在の群ではない（{群:?}）"
                        ));
                    }
                }
            }
            (None, true) => match &entry.reason {
                None => out.push(format!(
                    "{誰}: skip には reason が要る。書けないなら、載せない判断を考え直す"
                )),
                Some(reason) => {
                    if reason.chars().count() < REASON_MIN_CHARS {
                        out.push(format!(
                            "{誰}: reason が短すぎる（{REASON_MIN_CHARS}文字以上で、なぜ載せないのかを書く）"
                        ));
                    }
                    if let Some(hit) = 逃げ文句.iter().find(|word| reason.contains(*(*word))) {
                        out.push(format!(
                            "{誰}: reason に逃げ文句 {hit:?} が居る。なぜ載せないのかを書く"
                        ));
                    }
                }
            },
        }
    }
    for pair in entries.windows(2) {
        let a = (&pair[0].kind, &pair[0].target);
        let b = (&pair[1].kind, &pair[1].target);
        if a >= b {
            out.push(format!(
                "並び順: {} {} の次に {} {} が来ている。kind → target の昇順に並べ直す（swallowed.toml と同じ約束）",
                a.0, a.1, b.0, b.1
            ));
        }
    }
    out
}

/// 失敗の出力に貼れる形（`swallowed.rs` と同じ作法）。**command は空**にして出す——
/// 空のままでは約束の検査で落ちるので、書き手が判断を書き込むまで緑にならない。
fn 貼れる形(kind: &str, target: &str) -> String {
    format!(
        "\n[[entry]]\nkind = \"{kind}\"\ntarget = \"{target}\"\ncommand = \"\"   # CLI での叩き方。載せない判断なら command を消して skip = true と reason を書く\n"
    )
}

// ---------------------------------------------------------------------------
// 検査
// ---------------------------------------------------------------------------

#[test]
fn 台帳と画面の口が一致する() {
    let entries = 台帳(LEDGER);
    let mut 台帳側 = BTreeSet::new();
    for entry in &entries {
        assert!(
            台帳側.insert((entry.kind.clone(), entry.target.clone())),
            "台帳に {} {} が2回居る",
            entry.kind,
            entry.target
        );
    }
    let 実物 = 画面の口();
    let 台帳に無い: Vec<_> = 実物.difference(&台帳側).collect();
    let 実物に無い: Vec<_> = 台帳側.difference(&実物).collect();
    if !台帳に無い.is_empty() {
        let 骨組み: String = 台帳に無い
            .iter()
            .map(|(kind, target)| 貼れる形(kind, target))
            .collect();
        panic!(
            "画面の口が {} 件、台帳に載っていない。CLI で叩けるようにして command を書くか、\
             載せない判断なら skip = true と reason を書いて \
             server/crates/core/tests/cli_surface.toml へ足すこと:\n{骨組み}",
            台帳に無い.len()
        );
    }
    assert!(
        実物に無い.is_empty(),
        "台帳に載っているが実物に見つからない口: {実物に無い:?}。口を消したのなら台帳からも消す\
         ——「載せない判断」とは違い、無い口は書かない。口は在るのに見つからないなら走査器が壊れている"
    );
}

#[test]
fn 台帳のすべての行が約束を守っている() {
    let broken = 約束破り(&台帳(LEDGER));
    assert!(
        broken.is_empty(),
        "台帳が約束（設計§11-4）を破っている:\n{}",
        broken.join("\n")
    );
}

#[test]
fn 口の数が設計から動いていない() {
    let variants = scan_variants(&読む(WS_SOURCE));
    assert_eq!(
        variants.len(),
        WS_VARIANTS,
        "ClientMessage が {WS_VARIANTS} 種から動いている。口を増やす設計判断をしたのなら、\
         この数字・台帳・4箇所同期（ガイドライン）をまとめて動かすこと。いまの顔ぶれ: {variants:?}"
    );
    let inside = 内側の口();
    assert_eq!(
        inside.len(),
        INSIDE_DOORS,
        "鍵の内側の REST が {INSIDE_DOORS} 口から動いている。口を増やす設計判断をしたのなら、\
         この数字と台帳をまとめて動かすこと。いまの顔ぶれ: {inside:?}"
    );
    let outside = 外側の口();
    assert_eq!(
        outside.len(),
        OUTSIDE_DOORS,
        "鍵の外側の口が {OUTSIDE_DOORS} から動いている。素通しの口は増やさないのが原則\
         （サーバ設計§8-2）。いまの顔ぶれ: {outside:?}"
    );
    let tenancy = strip_comments(&読む(TENANCY_SOURCE));
    let count = tenancy.matches("#[tokio::test]").count();
    assert_eq!(
        count, TENANCY_TESTS,
        "tenancy.rs の総当たりが {TENANCY_TESTS} 本から動いている。CLI はブラウザと同じ席に\
         座るので、CLI の作業でこの数が増える理由は無い（設計§1-1）。enforcement を足した\
         のなら、この数字を意識して上げること"
    );
}

#[test]
fn wsの15種はブラウザ側の型にも全部ある() {
    let path = repo_root().join("web/src/lib/protocol.ts");
    let ts = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} を読めること: {e}", path.display()));
    for variant in scan_variants(&読む(WS_SOURCE)) {
        let tag = format!("t: '{}'", snake_case(&variant));
        assert!(
            ts.contains(&tag),
            "ClientMessage::{variant} の札 {tag:?} が web/src/lib/protocol.ts に見当たらない。\
             Rust 側だけ増やすと4箇所同期（ガイドライン「サーバ⇔ブラウザのメッセージを\
             増減するとき」）が破れる"
        );
    }
}

// ---------------------------------------------------------------------------
// 番人（走査器と約束の検査そのものの単体）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 一つのパスに動詞が2つ付いても両方数える() {
        let src = r#"fn r() { Router::new().route("/x", get(a).post(b)); }"#;
        assert_eq!(
            scan_routes(src),
            vec![
                ("GET".to_string(), "/x".to_string()),
                ("POST".to_string(), "/x".to_string())
            ]
        );
    }

    #[test]
    fn コメントの中のrouteは拾わない() {
        let src = r#"
            // .route("/y", get(c))
            /* .route("/z", post(d)) */
            fn r() { Router::new().route("/x", get(a)); }
        "#;
        assert_eq!(
            scan_routes(src),
            vec![("GET".to_string(), "/x".to_string())]
        );
    }

    #[test]
    fn テストモジュールの中のrouteは数えない() {
        let src = "fn r() { Router::new().route(\"/x\", get(a)); }\n\
                   #[cfg(test)]\nmod tests { fn f() { Router::new().route(\"/y\", get(b)); } }";
        assert_eq!(
            scan_routes(src),
            vec![("GET".to_string(), "/x".to_string())]
        );
    }

    #[test]
    fn 完全修飾の動詞も最後の語で見る() {
        let src = r#"fn r() { Router::new().route("/y", axum::routing::delete(f)); }"#;
        assert_eq!(
            scan_routes(src),
            vec![("DELETE".to_string(), "/y".to_string())]
        );
    }

    #[test]
    fn ハンドラ名に動詞が入っていても深さで弾く() {
        let src = r#"fn r() { Router::new().route("/x", post(get_all)); }"#;
        assert_eq!(
            scan_routes(src),
            vec![("POST".to_string(), "/x".to_string())]
        );
    }

    #[test]
    fn variantは属性と本文を飛ばして名前だけ拾う() {
        let src = r#"
            /// 説明
            pub enum ClientMessage {
                /// doc コメントは消える
                Alpha { x: u32 },
                #[serde(default, skip_serializing_if = "Option::is_none")]
                Beta,
                Gamma(String),
            }
        "#;
        assert_eq!(scan_variants(src), vec!["Alpha", "Beta", "Gamma"]);
    }

    #[test]
    fn 名前はスネークケースの札になる() {
        assert_eq!(snake_case("SubPty"), "sub_pty");
        assert_eq!(snake_case("SetPermissionMode"), "set_permission_mode");
        assert_eq!(snake_case("Kill"), "kill");
    }

    fn 行(
        kind: &str,
        target: &str,
        command: Option<&str>,
        skip: bool,
        reason: Option<&str>,
    ) -> Entry {
        Entry {
            kind: kind.to_string(),
            target: target.to_string(),
            command: command.map(str::to_string),
            skip,
            reason: reason.map(str::to_string),
        }
    }

    #[test]
    fn 約束_commandとskipは排他() {
        let 両方 = 行(
            "ws",
            "ClientMessage::A",
            Some("session ls"),
            true,
            Some("十二文字以上ある理由の文章がここに居る"),
        );
        let どちらも無い = 行("ws", "ClientMessage::B", None, false, None);
        assert_eq!(約束破り(&[両方]).len(), 1);
        assert_eq!(約束破り(&[どちらも無い]).len(), 1);
    }

    #[test]
    fn 約束_skipのreasonは長さと逃げ文句を見る() {
        let 短い = 行("ws", "ClientMessage::A", None, true, Some("短い"));
        let 逃げ = 行(
            "ws",
            "ClientMessage::B",
            None,
            true,
            Some("この口はとくに無しでよいはずだから"),
        );
        let 無い = 行("ws", "ClientMessage::C", None, true, None);
        let 良い = 行(
            "ws",
            "ClientMessage::D",
            None,
            true,
            Some("CLI は1回の呼び出しで切断して終わるので、切断がそのまま解除になる"),
        );
        assert_eq!(約束破り(&[短い]).len(), 1);
        assert_eq!(約束破り(&[逃げ]).len(), 1);
        assert_eq!(約束破り(&[無い]).len(), 1);
        assert!(約束破り(&[良い]).is_empty());
    }

    #[test]
    fn 約束_並びはkindからtargetの辞書順() {
        let a = 行("rest", "GET /api/sessions", Some("session ls"), false, None);
        let b = 行(
            "ws",
            "ClientMessage::Kill",
            Some("session kill"),
            false,
            None,
        );
        assert!(約束破り(&[a.clone(), b.clone()]).is_empty());
        assert_eq!(約束破り(&[b, a]).len(), 1);
    }

    #[test]
    fn 約束_知らない群の誤記を捕まえる() {
        let 誤記 = 行(
            "rest",
            "GET /api/sessions",
            Some("sessions ls"),
            false,
            None,
        );
        assert_eq!(約束破り(&[誤記]).len(), 1);
    }
}
