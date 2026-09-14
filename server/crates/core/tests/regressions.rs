//! 直した振る舞いを守る台帳（設計§1〜§6）。
//!
//! ここが在る理由はひとつ。**一度直した振る舞いが、意図した仕様変更以外で戻らない**
//! ようにするためである。`実行レポート.md` はテストを名指ししているが散文なので機械は
//! 読まない。**あるテストが消えても・skip されても、どのイシューが守られなくなったかを
//! 誰も知らない。**
//!
//! `swallowed.toml`（結果を捨てている箇所）と `cli_surface.toml`（画面と CLI の口）が
//! 既にこの型でできている。**3つ目の台帳**として、閉じたイシューごとに
//! 「どの振る舞いを、どのテストが守っているか」を載せる。
//!
//! # なぜ走査器を自前で書くのか
//!
//! 台帳は「このテストが守っている」と書く道具なので、**そのテストが実在するかを見る目**
//! が要る。その目が雑だと、台帳ごと信用できなくなる。
//!
//! **正規表現では足りない。** 実在の理由が3つある（設計§3）。
//!
//! 1. **コメントの中にテスト名が書かれている**（実行レポートを引用した注釈など）
//! 2. **文字列の中にテスト名が現れる**（別のテストの期待値として）
//! 3. **素朴な引用符トグルは `it("…'…")` のような混在で破綻する**
//!
//! # 測り間違えた記録（設計§3）
//!
//! この走査器の要件は、実際に外した2件がそのまま決めている。
//!
//! 1. **ASCII 前提の正規表現**で Rust のテスト名を数え、**2,014 を 158** と出した。
//!    日本語の名前がほぼ全部落ちた。→ **UTF-8 前提で書く**（`char` 単位で読む）
//! 2. **`grep -F "it('"`**（語境界なし）で数え、**`submit('` を拾って 2,867** と出した。
//!    → **語境界を必ず見る**
//!
//! # 正規表現リテラルを畳むのは、実際に踏んだからである
//!
//! 最初は正規表現を解釈せず、「引用符が行をまたいだら落とす」だけにしていた。
//! **走らせたら8件落ちた。** どれも実在する書き方で、引用符が**奇数個**入っている。
//!
//! ```text
//! /aria-label="[^"]*閉じる"/      ← " が3個
//! /accent:\s*'([^']+)'/            ← ' が3個
//! ```
//!
//! 素直に引用符を数えると、ここで面が崩れて**崩れた行から先のテストが静かに数から
//! 漏れる**。だから `/` が正規表現か除算かを直前の字句から見分けて畳む。
//!
//! **行またぎの検査は残してある**（`引用符が行をまたいでいない`）。見分け方が破れた
//! ときに、黙って数が減るのではなく落ちるようにするため。

#![allow(non_snake_case)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// 置き場所

fn server_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("server の下")
        .to_path_buf()
}

/// リポジトリの根。**`web/` はワークスペースの外に居る**ので、ここから辿る
/// （`cli_surface.rs` が `web/src/lib/protocol.ts` を読むのと同じ作法）。
fn repo_root() -> PathBuf {
    server_root()
        .parent()
        .expect("リポジトリの根")
        .to_path_buf()
}

// ---------------------------------------------------------------------------
// 走査の対象
//
// **顔ぶれを定数で持つ。** 増減したら `テストの置き場所が増減していない` が落ちて、
// 走査対象に入れるかどうかを決め直させる。

/// web の単体テスト（Vitest）。`web/vite.config.ts` が `e2e/**` を除いている。
const WEB単体: (&str, &[&str]) = ("web/src", &[".test.ts", ".test.tsx"]);
/// ブラウザを通す E2E（Playwright）。**`make ci` には入っていない。**
const E2E: (&str, &[&str]) = ("web/e2e", &[".spec.ts"]);
/// Rust。`#[test]` ／ `#[tokio::test]` が付いた関数を数える。
const RUST: (&str, &[&str]) = ("server/crates", &[".rs"]);

/// 走査器が壊れたときに気づくための下限。**台帳を削って揃えてはいけない。**
const 下限_WEB単体: usize = 2500;
const 下限_E2E: usize = 300;
const 下限_RUST: usize = 1800;

/// 門（`gate`）の取りうる値。
const GATES: &[&str] = &["unit", "e2e", "manual"];

/// 理由として認めない逃げ文句（`swallowed.rs` から踏襲）。
const 逃げ文句: &[&str] = &[
    "不要",
    "問題ない",
    "問題なし",
    "TODO",
    "とくに無し",
    "特に無し",
    "なし",
];

/// 理由の最低の長さ（文字）。1語で済ませられないようにする。
const 理由の最低文字数: usize = 12;

/// `behavior` に1つは要る「どの条件で」を表す語（設計§4 の約束3）。
///
/// **増やすときは理由を書くこと。** 緩めれば緩めるほど、条件を書かない1文が通る。
const 条件語: &[&str] = &[
    "とき",
    "たあと",
    "した後",
    "最中",
    "でも",
    "ながら",
    "場合",
    "まで",
    "ても",
    "ずに",
    "あとで",
    "間に",
];

// ---------------------------------------------------------------------------
// 走査（TypeScript）

/// 文字列リテラル1つ。`quote_at` は開き引用符の位置。
#[derive(Debug, Clone)]
struct 文字列 {
    quote_at: usize,
    content: String,
    /// 書かれた字句が、そのまま実際のテスト名になるか。
    ///
    /// **`${…}` を含むテンプレートリテラルは `false`。** 差し込みが入るので、
    /// 書かれた字句と走るときの名前が一致しない（`it.each(` と同じ立場）。
    字句で決まる: bool,
}

/// 1ファイルの走査結果。
#[derive(Debug, Default)]
struct 走査 {
    /// テスト名（`it(` ／ `test(` の直後の文字列）。
    names: Vec<String>,
    /// `.skip` ／ `.todo` ／ `.fixme` ／ `#[ignore]` が付いているもの。
    飛ばしている: BTreeSet<String>,
    /// `it(` ／ `test(` と書いてあるのに名前を取れなかった場所（行番号）。
    /// **新しい綴りが入った合図。**
    名前を取れない場所: Vec<usize>,
    /// テスト名が字句で決まらない場所（行番号）。
    ///
    /// `${…}` を含むテンプレートリテラル。**壊れてはいないが台帳には載せられない**
    /// （`it.each(` と同じ立場。設計§3）。
    字句で決まらない場所: Vec<usize>,
    /// 引用符が閉じないまま行が終わった場所（行番号）。面が崩れた合図。
    引用符が行をまたいだ場所: Vec<usize>,
}

/// コード位置かどうかの面と、文字列リテラルの一覧を作る。
///
/// **テンプレートリテラルの `${…}` は中がコードなので潰さない**（再帰で処理する）。
fn ts_mask(source: &str) -> (Vec<char>, Vec<bool>, Vec<文字列>, Vec<usize>) {
    let chars: Vec<char> = source.chars().collect();
    let mut code = vec![true; chars.len()];
    let mut spans = Vec::new();
    let mut 行またぎ = Vec::new();
    let len = chars.len();
    mask_range(&chars, &mut code, &mut spans, &mut 行またぎ, 0, len);
    (chars, code, spans, 行またぎ)
}

/// `[start, end)` を潰す。`${…}` の中身でも同じ関数を呼ぶので範囲を取る。
fn mask_range(
    chars: &[char],
    code: &mut [bool],
    spans: &mut Vec<文字列>,
    行またぎ: &mut Vec<usize>,
    start: usize,
    end: usize,
) {
    let mut i = start;
    while i < end {
        let c = chars[i];

        // 行コメント
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < end && chars[i] != '\n' {
                code[i] = false;
                i += 1;
            }
            continue;
        }
        // ブロックコメント（TypeScript は入れ子にしない）
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            code[i] = false;
            code[i + 1] = false;
            i += 2;
            while i < end {
                if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    code[i] = false;
                    code[i + 1] = false;
                    i += 2;
                    break;
                }
                code[i] = false;
                i += 1;
            }
            continue;
        }
        // 正規表現リテラル。**引用符を含むものが実在する**ので、文字列より先に畳む
        //
        // 例：`/aria-label="[^"]*閉じる"/` は `"` を3個持つ。素直に引用符を数えると
        // ここで面が崩れ、**崩れた行から先のテストが静かに数から漏れる**
        if c == '/' && 正規表現の開始か(chars, code, i) {
            code[i] = false;
            let mut j = i + 1;
            let mut 文字クラスの中 = false;
            while j < end {
                let d = chars[j];
                if d == '\\' {
                    code[j] = false;
                    if j + 1 < end {
                        code[j + 1] = false;
                    }
                    j += 2;
                    continue;
                }
                // **正規表現は行をまたがない。** またいだなら、それは除算だった
                if d == '\n' {
                    break;
                }
                code[j] = false;
                j += 1;
                match d {
                    '[' => 文字クラスの中 = true,
                    ']' => 文字クラスの中 = false,
                    // 閉じ。**文字クラスの中の `/` は区切りではない**
                    '/' if !文字クラスの中 => break,
                    _ => {}
                }
            }
            // フラグ（g・i・m・s・u・y）
            while j < end && chars[j].is_alphabetic() {
                code[j] = false;
                j += 1;
            }
            i = j;
            continue;
        }
        // 素直な文字列。**改行で打ち切る**——面が崩れたときに被害をその行へ閉じ込めるため
        if c == '\'' || c == '"' {
            let quote = c;
            let mut j = i + 1;
            let mut content = String::new();
            let mut 閉じた = false;
            code[i] = false;
            while j < end {
                if chars[j] == '\\' {
                    code[j] = false;
                    if let Some(next) = chars.get(j + 1) {
                        code[j + 1] = false;
                        content.push(展開(*next));
                    }
                    j += 2;
                    continue;
                }
                if chars[j] == quote {
                    code[j] = false;
                    j += 1;
                    閉じた = true;
                    break;
                }
                if chars[j] == '\n' {
                    break;
                }
                code[j] = false;
                content.push(chars[j]);
                j += 1;
            }
            if 閉じた {
                spans.push(文字列 {
                    quote_at: i,
                    content,
                    字句で決まる: true,
                });
            } else {
                行またぎ.push(行番号(chars, i));
            }
            i = j;
            continue;
        }
        // テンプレートリテラル。`${…}` はコードなので再帰して潰し直す
        if c == '`' {
            let mut j = i + 1;
            let mut content = String::new();
            let mut 式を含む = false;
            code[i] = false;
            while j < end {
                if chars[j] == '\\' {
                    code[j] = false;
                    if let Some(next) = chars.get(j + 1) {
                        code[j + 1] = false;
                        content.push(展開(*next));
                    }
                    j += 2;
                    continue;
                }
                if chars[j] == '`' {
                    code[j] = false;
                    j += 1;
                    break;
                }
                if chars[j] == '$' && chars.get(j + 1) == Some(&'{') {
                    式を含む = true;
                    let mut depth = 1i32;
                    let mut k = j + 2;
                    while k < end && depth > 0 {
                        match chars[k] {
                            '{' => depth += 1,
                            '}' => depth -= 1,
                            _ => {}
                        }
                        k += 1;
                    }
                    // 中はコードなので、同じ規則でもう一度潰す
                    mask_range(chars, code, spans, 行またぎ, j + 2, k.saturating_sub(1));
                    j = k;
                    continue;
                }
                code[j] = false;
                content.push(chars[j]);
                j += 1;
            }
            // **式を含むものも span としては積む。** 積まないと「`it(` と書いてあるのに
            // 名前が取れない」と見分けが付かず、新しい綴りの合図を鈍らせる
            spans.push(文字列 {
                quote_at: i,
                content,
                字句で決まる: !式を含む,
            });
            i = j;
            continue;
        }
        i += 1;
    }
}

fn 展開(c: char) -> char {
    match c {
        'n' => '\n',
        't' => '\t',
        other => other,
    }
}

fn 行番号(chars: &[char], at: usize) -> usize {
    chars[..at.min(chars.len())]
        .iter()
        .filter(|c| **c == '\n')
        .count()
        + 1
}

/// その `/` が正規表現リテラルの始まりか、除算か。
///
/// **TypeScript はここを字句だけでは決められない。** 直前の意味のある字句を見て、
/// 「値が来ていない位置」なら正規表現と読む——JavaScript の字句解析器が昔から
/// 使っている見分け方で、実測した書き方（`toMatch(/…/)`・`const x = /…/`・
/// `[...s.matchAll(/…/g)]`）はすべてこれで拾える。
fn 正規表現の開始か(chars: &[char], code: &[bool], i: usize) -> bool {
    let mut j = i;
    // 既に潰した位置（コメント）と空白を読み飛ばす
    while j > 0 && (!code[j - 1] || chars[j - 1].is_whitespace()) {
        j -= 1;
    }
    if j == 0 {
        return true;
    }
    let c = chars[j - 1];
    if "(,=:[!&|?{};+-*%^<>~".contains(c) {
        return true;
    }
    if c.is_alphanumeric() || c == '_' || c == '$' {
        // `return /…/` のような、値を待っているキーワードの直後
        if let Some((ident, _)) = 手前の識別子(chars, code, j) {
            return [
                "return",
                "typeof",
                "case",
                "in",
                "of",
                "new",
                "delete",
                "void",
                "do",
                "else",
                "yield",
                "await",
                "instanceof",
            ]
            .contains(&ident.as_str());
        }
    }
    false
}

/// 識別子を後ろ向きに読む。`i` の**手前**で終わっている識別子を返す。
fn 手前の識別子(chars: &[char], code: &[bool], i: usize) -> Option<(String, usize)> {
    let mut j = i;
    while j > 0
        && code[j - 1]
        && (chars[j - 1].is_alphanumeric() || chars[j - 1] == '_' || chars[j - 1] == '$')
    {
        j -= 1;
    }
    if j == i {
        return None;
    }
    Some((chars[j..i].iter().collect(), j))
}

fn 空白を飛ばして戻る(chars: &[char], code: &[bool], mut i: usize) -> usize {
    while i > 0 && code[i - 1] && chars[i - 1].is_whitespace() {
        i -= 1;
    }
    i
}

/// TypeScript を1ファイル走査する。
///
/// **テスト名は「潰した文字列のうち、直前が `it(` または `test(` であるもの」**として
/// 取る。引用符の種類ごとに書き分けない——文字列を潰す段で中身を控えてあるので、
/// 3種は同じ扱いになる。
fn scan_ts(source: &str) -> 走査 {
    let (chars, code, spans, 行またぎ) = ts_mask(source);
    let mut out = 走査 {
        引用符が行をまたいだ場所: 行またぎ,
        ..Default::default()
    };

    // 名前が取れた場所を控える。**「書いてあるのに取れない」を後で数えるため**
    let mut 取れた: BTreeSet<usize> = BTreeSet::new();

    for span in &spans {
        // 開き引用符の手前は `(` か
        let p = 空白を飛ばして戻る(&chars, &code, span.quote_at);
        if p == 0 || !code[p - 1] || chars[p - 1] != '(' {
            continue;
        }
        // `(` の手前の識別子
        let q = 空白を飛ばして戻る(&chars, &code, p - 1);
        let Some((ident, ident_start)) = 手前の識別子(&chars, &code, q) else {
            continue;
        };

        // `it.skip(` ／ `test.todo(` などは、識別子が `skip` になる。
        // **`.` が手前にあるかで、素の宣言と修飾つきを分ける**
        let 修飾 = ident_start > 0 && code[ident_start - 1] && chars[ident_start - 1] == '.';

        if 修飾 {
            if ["skip", "todo", "fixme", "failing"].contains(&ident.as_str()) {
                out.飛ばしている.insert(span.content.clone());
            }
            continue;
        }

        if ident == "it" || ident == "test" {
            if span.字句で決まる {
                out.names.push(span.content.clone());
            } else {
                out.字句で決まらない場所.push(行番号(&chars, span.quote_at));
            }
            // **どちらでも「見つけた場所」ではある。** ここで印を付けておかないと、
            // 差し込みつきの名前が「新しい綴り」として毎回落ちる
            取れた.insert(ident_start);
        }
    }

    // **書いてあるのに取れなかった場所**を数える。新しい綴りが入った合図になる
    let mut i = 0usize;
    while i < chars.len() {
        if !code[i] {
            i += 1;
            continue;
        }
        let 語頭 = i == 0
            || !(code[i - 1]
                && (chars[i - 1].is_alphanumeric()
                    || chars[i - 1] == '_'
                    || chars[i - 1] == '$'
                    || chars[i - 1] == '.'));
        if 語頭 {
            let mut j = i;
            while j < chars.len()
                && code[j]
                && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '$')
            {
                j += 1;
            }
            let ident: String = chars[i..j].iter().collect();
            if (ident == "it" || ident == "test")
                && chars.get(j) == Some(&'(')
                && !取れた.contains(&i)
            {
                out.名前を取れない場所.push(行番号(&chars, i));
            }
            if j > i {
                i = j;
                continue;
            }
        }
        i += 1;
    }

    out
}

// ---------------------------------------------------------------------------
// 走査（Rust）

/// Rust のコード位置の面。`swallowed.rs` の `code_mask` を要るぶんだけ写したもの。
fn rs_mask(source: &str) -> (Vec<char>, Vec<bool>) {
    let chars: Vec<char> = source.chars().collect();
    let mut code = vec![true; chars.len()];
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                code[i] = false;
                i += 1;
            }
            continue;
        }
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
        // 生文字列
        if c == 'r' || (c == 'b' && chars.get(i + 1) == Some(&'r')) {
            let mut j = if c == 'b' { i + 2 } else { i + 1 };
            let hashes_start = j;
            while chars.get(j) == Some(&'#') {
                j += 1;
            }
            let hashes = j - hashes_start;
            if chars.get(j) == Some(&'"') {
                j += 1;
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
        if c == '"' {
            let mut j = i + 1;
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
        // 文字リテラル `'.'` ／ `'\n'` ／ `b'.'`。**ライフタイム `'a` と見分ける**
        //
        // ここを省くと `trim_matches('"')` の `"` が文字列の始まりに見え、**そこから
        // 次の `"` までを丸ごと読み飛ばす**。実際に踏んだ——12ファイルが巻き込まれ、
        // Rust のテストを 2,013 本のうち 71 本取りこぼした
        if c == '\'' || (c == 'b' && chars.get(i + 1) == Some(&'\'')) {
            let start = i;
            let q = if c == 'b' { i + 1 } else { i };
            let body = q + 1;
            let end = if chars.get(body) == Some(&'\\') {
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

fn 次の語(chars: &[char], code: &[bool], from: usize) -> Option<(String, usize)> {
    let mut i = from;
    while i < chars.len() && !(code[i] && (chars[i].is_alphanumeric() || chars[i] == '_')) {
        i += 1;
    }
    let start = i;
    while i < chars.len() && code[i] && (chars[i].is_alphanumeric() || chars[i] == '_') {
        i += 1;
    }
    (i > start).then(|| (chars[start..i].iter().collect(), i))
}

/// Rust を1ファイル走査する。
///
/// **テスト名は日本語**（実測 2,014本すべて。ASCII のみは0本）なので、
/// `is_alphanumeric()` で読む——Rust の `char::is_alphanumeric` は Unicode を見る。
fn scan_rs(source: &str) -> 走査 {
    let (chars, code) = rs_mask(source);
    let mut out = 走査::default();
    let n = chars.len();
    let mut i = 0usize;

    while i < n {
        if !(code[i] && chars[i] == '#' && chars.get(i + 1) == Some(&'[')) {
            i += 1;
            continue;
        }
        // 属性の中身
        let mut depth = 0i32;
        let mut j = i;
        while j < n {
            match chars[j] {
                '[' => depth += 1,
                ']' => {
                    depth -= 1;
                    if depth == 0 {
                        j += 1;
                        break;
                    }
                }
                _ => {}
            }
            j += 1;
        }
        let 中身: String = chars[i + 2..j.saturating_sub(1).max(i + 2)]
            .iter()
            .collect();
        let 中身 = 中身.trim().to_string();
        let テスト属性 = 中身 == "test" || 中身 == "tokio::test";
        if !テスト属性 {
            i = j;
            continue;
        }
        // **属性を見つけた場所を控える。** 名前まで辿り着けなければ、下で数える
        let 属性の行 = 行番号(&chars, i);

        // ここから `fn` までの間に並ぶ属性を読む。**`#[ignore]` は2つの綴りがある**
        let mut 飛ばす = false;
        let mut k = j;
        loop {
            // **空白だけでなくコメントも飛ばす。** 属性と属性のあいだに注釈が挟まる
            // 書き方が実在する（`perf.rs` の `#[tokio::test]` と `#[ignore]` の間）
            while k < n && (chars[k].is_whitespace() || !code[k]) {
                k += 1;
            }
            if k < n && code[k] && chars[k] == '#' && chars.get(k + 1) == Some(&'[') {
                let mut d = 0i32;
                let mut m = k;
                while m < n {
                    match chars[m] {
                        '[' => d += 1,
                        ']' => {
                            d -= 1;
                            if d == 0 {
                                m += 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                    m += 1;
                }
                let 属性: String = chars[k + 2..m.saturating_sub(1).max(k + 2)]
                    .iter()
                    .collect();
                let 属性 = 属性.trim();
                // 素の `#[ignore]` と `#[ignore = "…"]` の両方
                if 属性 == "ignore" || 属性.starts_with("ignore") {
                    飛ばす = true;
                }
                k = m;
                continue;
            }
            break;
        }

        // `fn` の次の語が名前
        let Some((word, after)) = 次の語(&chars, &code, k) else {
            out.名前を取れない場所.push(属性の行);
            i = j;
            continue;
        };
        let (name, _) = if word == "fn" {
            match 次の語(&chars, &code, after) {
                Some(v) => v,
                None => {
                    out.名前を取れない場所.push(属性の行);
                    i = j;
                    continue;
                }
            }
        } else if word == "async" || word == "pub" {
            // `async fn` ／ `pub fn` ／ `pub async fn`
            let mut cur = after;
            let mut 名前 = None;
            for _ in 0..3 {
                let Some((w, next)) = 次の語(&chars, &code, cur) else {
                    break;
                };
                if w == "fn" {
                    名前 = 次の語(&chars, &code, next);
                    break;
                }
                if w != "async" && w != "pub" {
                    break;
                }
                cur = next;
            }
            match 名前 {
                Some(v) => v,
                None => {
                    out.名前を取れない場所.push(属性の行);
                    i = j;
                    continue;
                }
            }
        } else {
            out.名前を取れない場所.push(属性の行);
            i = j;
            continue;
        };

        if 飛ばす {
            out.飛ばしている.insert(name.clone());
        }
        out.names.push(name);
        i = j;
    }

    out
}

// ---------------------------------------------------------------------------
// ファイル探索

fn walk(dir: &Path, exts: &[&str], out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // **依存は数えない。** 走査対象は自分たちの書いたものだけ
            if path
                .file_name()
                .is_some_and(|n| n == "node_modules" || n == "target")
            {
                continue;
            }
            walk(&path, exts, out);
            continue;
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        if exts.iter().any(|ext| name.ends_with(ext)) {
            out.push(path);
        }
    }
}

fn files(spec: (&str, &[&str])) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(&repo_root().join(spec.0), spec.1, &mut out);
    out.sort();
    out
}

fn 相対(path: &Path) -> String {
    path.strip_prefix(repo_root())
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// ファイル（リポジトリ根からの相対パス）→ 走査結果。
fn 全走査() -> BTreeMap<String, 走査> {
    let mut out = BTreeMap::new();
    for spec in [WEB単体, E2E] {
        for path in files(spec) {
            let source = std::fs::read_to_string(&path).expect("読めること");
            out.insert(相対(&path), scan_ts(&source));
        }
    }
    for path in files(RUST) {
        let source = std::fs::read_to_string(&path).expect("読めること");
        let scan = scan_rs(&source);
        if !scan.names.is_empty() {
            out.insert(相対(&path), scan);
        }
    }
    out
}

fn 本数(spec: (&str, &[&str])) -> usize {
    files(spec)
        .iter()
        .map(|path| {
            let source = std::fs::read_to_string(path).expect("読めること");
            if spec.0 == RUST.0 {
                scan_rs(&source).names.len()
            } else {
                scan_ts(&source).names.len()
            }
        })
        .sum()
}

// ---------------------------------------------------------------------------
// 台帳

#[derive(Debug, Clone)]
struct テスト {
    file: String,
    name: String,
}

#[derive(Debug, Clone)]
struct Entry {
    issue: String,
    behavior: String,
    gate: String,
    tests: Vec<テスト>,
    manual_check: Option<String>,
    breaks_when: String,
    /// **`breaks_when` を実際に壊して、落ちるのを見たか。**
    ///
    /// 変異検査はやらないので、`breaks_when` に書いてあることを機械は確かめていない。
    /// 確かめたのは**閉じるときの人（エージェント）の1回だけ**である。
    ///
    /// **その1回すら無い行がある。** 2026-09-14 に70件を遡って載せたぶんは、
    /// 実装を読んで「ここを戻せば落ちるはず」と書いたもので、**当てていない**。
    /// 両者が同じ見た目だと、**読む人は全部が確かめ済みだと思う**——それがいちばん困る。
    ///
    /// だから欄で分ける。閉じるときに壊した行だけが `true` を名乗れる。
    verified: bool,
    retired_by: Option<String>,
}

const 台帳の中身: &str = include_str!("regressions.toml");

fn 台帳() -> (usize, Vec<Entry>) {
    let table: toml::Table = 台帳の中身.parse().expect("台帳が TOML として妥当なこと");

    for key in table.keys() {
        assert!(
            ["min_entries", "entry"].contains(&key.as_str()),
            "知らないトップレベルの鍵 {key:?}。台帳の形は regressions.toml の頭のコメントを見る"
        );
    }

    let min_entries = table
        .get("min_entries")
        .and_then(toml::Value::as_integer)
        .expect("min_entries（行数の下限）を書くこと") as usize;

    let list = match table.get("entry") {
        Some(value) => value
            .as_array()
            .expect("[[entry]] の並びであること")
            .clone(),
        None => Vec::new(),
    };

    let entries = list
        .iter()
        .map(|value| {
            let item = value.as_table().expect("entry はテーブルであること");
            for key in item.keys() {
                assert!(
                    [
                        "issue",
                        "behavior",
                        "gate",
                        "tests",
                        "manual_check",
                        "breaks_when",
                        "verified",
                        "retired",
                    ]
                    .contains(&key.as_str()),
                    "知らないキー {key:?}。台帳の形は regressions.toml の頭のコメントを見る"
                );
            }
            let 文字列 = |key: &str| {
                item.get(key)
                    .and_then(toml::Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            let tests = item
                .get("tests")
                .and_then(toml::Value::as_array)
                .map(|list| {
                    list.iter()
                        .map(|value| {
                            let t = value.as_table().expect("tests の要素はテーブルであること");
                            for key in t.keys() {
                                assert!(
                                    ["file", "name"].contains(&key.as_str()),
                                    "tests の知らないキー {key:?}"
                                );
                            }
                            テスト {
                                file: t
                                    .get("file")
                                    .and_then(toml::Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                name: t
                                    .get("name")
                                    .and_then(toml::Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            let retired_by = item
                .get("retired")
                .and_then(toml::Value::as_table)
                .and_then(|t| t.get("by"))
                .and_then(toml::Value::as_str)
                .map(str::to_string);
            Entry {
                issue: 文字列("issue"),
                behavior: 文字列("behavior"),
                gate: 文字列("gate"),
                tests,
                manual_check: item
                    .get("manual_check")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string),
                breaks_when: 文字列("breaks_when"),
                // **既定値を置かない。** 書き忘れを `false` で受けると、
                // 「確かめていない」と「書き忘れた」が同じ顔になる
                verified: item
                    .get("verified")
                    .and_then(toml::Value::as_bool)
                    .unwrap_or_else(|| {
                        panic!(
                            "{}: verified（breaks_when を実際に壊して落ちるのを見たか）を \
                             true か false で書くこと",
                            文字列("issue")
                        )
                    }),
                retired_by,
            }
        })
        .collect();

    (min_entries, entries)
}

/// `tests[].file` のパスから、そのテストがどの門で走るかを引く。
///
/// **書かれた `gate` と突き合わせる**ので、テストが `web/src` から `web/e2e` へ
/// 移ったのに台帳が `unit` のまま、を捕まえられる。
fn パスから引いた門(file: &str) -> Option<&'static str> {
    if file.starts_with("web/e2e/") && file.ends_with(".spec.ts") {
        return Some("e2e");
    }
    if file.starts_with("web/src/") && (file.ends_with(".test.ts") || file.ends_with(".test.tsx")) {
        return Some("unit");
    }
    if file.starts_with("server/crates/") && file.ends_with(".rs") {
        return Some("unit");
    }
    None
}

fn MyDocsがある() -> bool {
    repo_root().join("MyDocs/イシュー/クローズ").is_dir()
}

fn イシューが実在する(issue: &str) -> bool {
    repo_root()
        .join("MyDocs/イシュー")
        .join(issue)
        .join("要件.md")
        .is_file()
}

fn 中身が薄い(text: &str) -> bool {
    let t = text.trim();
    t.is_empty() || t.chars().count() < 理由の最低文字数 || 逃げ文句.contains(&t)
}

/// 台帳の約束（設計§4）を破っている行の一覧。空なら約束どおり。
///
/// **1件目で止めない。** 止めると、直しては走らせるを11回繰り返すことになる
/// （`cli_surface.rs` の `約束破り()` と同じ形）。
fn 約束破り(entries: &[Entry], 走査結果: &BTreeMap<String, 走査>) -> Vec<String> {
    let mut out = Vec::new();
    let myDocs = MyDocsがある();

    for entry in entries {
        let 誰 = format!("{} / {}", entry.issue, entry.behavior);

        // 約束2：空欄と逃げ文句
        //
        // **`issue` はここで見ない。** あれは理由を書く欄ではなく**パス**なので、
        // 最低文字数も逃げ文句の判定も当たらない——`クローズ/CICD`（7文字）や
        // `クローズ/初期実装`（9文字）は実在する正しいパスである。
        // 空でないことだけを見て、実在するかは MyDocs があるときに別途見る。
        if entry.issue.trim().is_empty() {
            out.push(format!("{誰}: issue が空です"));
        }
        for (label, text) in [
            ("behavior", &entry.behavior),
            ("breaks_when", &entry.breaks_when),
        ] {
            if 中身が薄い(text) {
                out.push(format!(
                    "{誰}: {label} が中身を持っていません（{理由の最低文字数}文字以上・逃げ文句は不可）"
                ));
            }
        }

        // 約束3：条件を表す語
        if !条件語.iter().any(|w| entry.behavior.contains(w)) {
            out.push(format!(
                "{誰}: behavior に「どの条件で」が書かれていません。\
                 条件の無い1文は問いを立てられません——\
                 「購読を出し直す」ではなく「**断られたあとでも**出し直す」と書くこと"
            ));
        }

        // 約束4：門
        if !GATES.contains(&entry.gate.as_str()) {
            out.push(format!(
                "{誰}: gate は {GATES:?} のどれか（いまは {:?}）",
                entry.gate
            ));
        }

        // 約束8：manual と tests の対
        if entry.gate == "manual" {
            if entry
                .manual_check
                .as_deref()
                .map(中身が薄い)
                .unwrap_or(true)
            {
                out.push(format!(
                    "{誰}: gate = \"manual\" には manual_check が要ります。\
                     「人が見る」だけで通せる抜け道を塞ぐため、確かめ方を書くこと"
                ));
            }
        } else {
            if entry.manual_check.is_some() {
                out.push(format!(
                    "{誰}: manual_check は gate = \"manual\" の行にだけ書くこと"
                ));
            }
            if entry.tests.is_empty() {
                out.push(format!("{誰}: tests が空です（manual 以外は名指しが要る）"));
            }
        }

        // 約束5・6・7・9：テストの実在
        for t in &entry.tests {
            match パスから引いた門(&t.file) {
                None => out.push(format!(
                    "{誰}: tests[].file のパスから門を引けません（{}）。\
                     走査対象の置き場所に在るか確かめること",
                    t.file
                )),
                Some(門) => {
                    if 門 != entry.gate {
                        out.push(format!(
                            "{誰}: gate = {:?} と書いてありますが、{} は {門} で走ります",
                            entry.gate, t.file
                        ));
                    }
                }
            }

            if !repo_root().join(&t.file).is_file() {
                out.push(format!("{誰}: {} が在りません", t.file));
                continue;
            }
            let Some(scan) = 走査結果.get(&t.file) else {
                out.push(format!(
                    "{誰}: {} を走査できていません（走査対象の置き場所の外か、テストが1本も無い）",
                    t.file
                ));
                continue;
            };
            if scan.飛ばしている.contains(&t.name) {
                out.push(format!(
                    "{誰}: {} の「{}」は飛ばされています（.skip ／ .todo ／ #[ignore]）。\
                     **飛ばしているテストは守っていません**",
                    t.file, t.name
                ));
                continue;
            }
            let 本数 = scan.names.iter().filter(|n| *n == &t.name).count();
            if 本数 == 0 {
                // 約束9：消えているなら、覆した側を名指しできているか
                if entry.retired_by.is_none() {
                    out.push(format!(
                        "{誰}: {} に「{}」が在りません。\
                         **意図して覆したのなら retired.by に覆した側のイシューを書くこと**——\
                         名指しできないなら、それは仕様変更ではありません",
                        t.file, t.name
                    ));
                }
            } else if 本数 > 1 {
                // 約束12：名前で指す以上、その名前はファイルの中で一意であること。
                //
                // **重複していると、片方を消しても検査は緑のまま**になる——残ったほうが
                // 名前の集合を満たしてしまうので、台帳は黙って守るのをやめる。
                // 「在るだけで効かない見張り」の一種で、いちばん気づけない形である。
                //
                // 実測（2026-09-14）：同じファイルの中で名前が重複しているテストが14箇所あった。
                // 台帳がそれを指した瞬間に穴が開くので、**指す前に落とす**。
                out.push(format!(
                    "{誰}: {} に「{}」が {本数} 本あります。\
                     **同じ名前が複数あると、片方を消しても検査は緑のまま**——\
                     どちらを指しているのか決まらないので、台帳は黙って守るのをやめます。\
                     テストの名前を分けてから載せること",
                    t.file, t.name
                ));
            }
        }

        // 約束10：覆した側のイシューが実在するか（MyDocs があるときだけ）
        if myDocs {
            if let Some(by) = &entry.retired_by {
                if !イシューが実在する(by) {
                    out.push(format!("{誰}: retired.by のイシューが在りません（{by}）"));
                }
            }
            if !イシューが実在する(&entry.issue) {
                out.push(format!(
                    "{誰}: issue のイシューが在りません（{}）",
                    entry.issue
                ));
            }
        }
    }

    // 約束11：並び順
    let 並び: Vec<(String, String)> = entries
        .iter()
        .map(|e| (e.issue.clone(), e.behavior.clone()))
        .collect();
    let mut 揃えた = 並び.clone();
    揃えた.sort();
    if 並び != 揃えた {
        out.push(
            "台帳の並びが崩れています。issue → behavior の昇順に並べること\
             （**位置ではなく名前で並べる**ので、行が動いても並びは変わらない）"
                .to_string(),
        );
    }

    out
}

// ---------------------------------------------------------------------------
// 走査器を守る4本
//
// **走査器は台帳より先に壊れる。** 壊れたことに気づく仕掛けを置く。

/// 手書きの標本。**紛らわしい書き方を全部入れてある。**
const 標本: &str = r#"
// it('コメントの中の偽物')
import { submit } from './x'

const ラベル = "it('文字列の中の偽物')"

describe('外側の名前は拾わない', () => {
  it('素直なシングルクォート', () => {})
  it("ダブルクォートでも拾う", () => {})
  it(`バッククォートでも拾う`, () => {})
  it("引用符が混ざっても壊れない ' のような字", () => {})
  it(
    '開き括弧の次で改行しても拾う',
    () => {},
  )
  it.each([1, 2])('プレースホルダ %i は拾わない', () => {})
  it.skip('飛ばしているものは名前として拾わない', () => {})
  test('vitest の test でも拾う', () => {})
  submit('これは呼び出しであってテストではない')
  const 題 = `式を含むテンプレート ${ラベル} は名前にできない`
  /* it('ブロックコメントの中の偽物') */
})
"#;

#[test]
fn 走査器は紛らわしい書き方に騙されない() {
    let scan = scan_ts(標本);
    assert_eq!(
        scan.names,
        vec![
            "素直なシングルクォート",
            "ダブルクォートでも拾う",
            "バッククォートでも拾う",
            "引用符が混ざっても壊れない ' のような字",
            "開き括弧の次で改行しても拾う",
            "vitest の test でも拾う",
        ],
        "走査器が拾う名前が変わりました。**台帳を削って揃えてはいけません**——\
         まず走査器のほうを疑うこと"
    );
    assert!(
        scan.飛ばしている
            .contains("飛ばしているものは名前として拾わない"),
        "`.skip` の付いたテストを「飛ばしている」と見分けられていません"
    );
    assert!(
        scan.名前を取れない場所.is_empty(),
        "標本の中に、名前を取れない `it(` ／ `test(` があります（行 {:?}）",
        scan.名前を取れない場所
    );
    assert!(
        scan.引用符が行をまたいだ場所.is_empty(),
        "標本の中で引用符の面が崩れました（行 {:?}）",
        scan.引用符が行をまたいだ場所
    );
}

#[test]
fn 別の綴りでテストを書いていない() {
    let mut 取れない: Vec<String> = Vec::new();
    for spec in [WEB単体, E2E] {
        for path in files(spec) {
            let source = std::fs::read_to_string(&path).expect("読めること");
            let scan = scan_ts(&source);
            for line in scan.名前を取れない場所 {
                取れない.push(format!("{}:{line}", 相対(&path)));
            }
        }
    }
    // **Rust 側も同じ問いを立てる。** `#[test]` が在るのに名前まで辿り着けないなら、
    // 面が崩れているか、知らない書き方が入っている
    for path in files(RUST) {
        let source = std::fs::read_to_string(&path).expect("読めること");
        for line in scan_rs(&source).名前を取れない場所 {
            取れない.push(format!("{}:{line}", 相対(&path)));
        }
    }
    assert!(
        取れない.is_empty(),
        "`it(` ／ `test(` と書いてあるのに名前を取れない場所があります。\
         **新しい綴りが入った合図**なので、走査器に受け付けさせるか、\
         その書き方をやめるかを決めること:\n{}",
        取れない.join("\n")
    );
}

#[test]
fn 引用符が行をまたいでいない() {
    let mut またぎ: Vec<String> = Vec::new();
    for spec in [WEB単体, E2E] {
        for path in files(spec) {
            let source = std::fs::read_to_string(&path).expect("読めること");
            for line in scan_ts(&source).引用符が行をまたいだ場所 {
                またぎ.push(format!("{}:{line}", 相対(&path)));
            }
        }
    }
    assert!(
        またぎ.is_empty(),
        "引用符が閉じないまま行が終わっています。**正規表現リテラルに奇数個の引用符が\
         入ると、この形でコード位置の面が崩れます**——崩れた行から先のテストが\
         静かに数から漏れるので、書き方を変えるか走査器に手当てすること:\n{}",
        またぎ.join("\n")
    );
}

#[test]
fn 走査器が見つけたテストが十分に多い() {
    let web = 本数(WEB単体);
    let e2e = 本数(E2E);
    let rust = 本数(RUST);
    // **数を出す。** 下限を跨がない程度に減っていても、ここを読めば気づける
    println!("--- 走査器が見つけたテスト ---");
    println!("  web 単体: {web}（下限 {下限_WEB単体}）");
    println!("  E2E     : {e2e}（下限 {下限_E2E}）");
    println!("  Rust    : {rust}（下限 {下限_RUST}）");
    assert!(
        web >= 下限_WEB単体,
        "web の単体テストを {web} 本しか見つけられませんでした（下限 {下限_WEB単体}）。\
         **走査器が壊れています。台帳を削って揃えてはいけません**"
    );
    assert!(
        e2e >= 下限_E2E,
        "E2E を {e2e} 本しか見つけられませんでした（下限 {下限_E2E}）。\
         **走査器が壊れています。台帳を削って揃えてはいけません**"
    );
    assert!(
        rust >= 下限_RUST,
        "Rust のテストを {rust} 本しか見つけられませんでした（下限 {下限_RUST}）。\
         **走査器が壊れています。台帳を削って揃えてはいけません**"
    );
}

#[test]
fn テストの置き場所が増減していない() {
    assert!(
        files(WEB単体).len() >= 130,
        "web の単体テストのファイルを見つけられていません（探した場所: {}）",
        repo_root().join(WEB単体.0).display()
    );
    assert!(
        files(E2E).len() >= 35,
        "E2E のファイルを見つけられていません（探した場所: {}）",
        repo_root().join(E2E.0).display()
    );

    // **走査対象の外にテストが置かれていないか。** 置かれたら、そのぶんは
    // 台帳から名指しできない＝黙って守りの外へ出る
    let mut はみ出し = Vec::new();
    walk(
        &repo_root().join("web"),
        &[".test.ts", ".test.tsx", ".spec.ts"],
        &mut はみ出し,
    );
    let はみ出し: Vec<String> = はみ出し
        .iter()
        .map(|p| 相対(p))
        .filter(|rel| !rel.starts_with("web/src/") && !rel.starts_with("web/e2e/"))
        .collect();
    assert!(
        はみ出し.is_empty(),
        "走査対象の外にテストがあります。台帳から名指しできないので、\
         置き場所を決め直すか走査対象を増やすこと:\n{}",
        はみ出し.join("\n")
    );
}

// ---------------------------------------------------------------------------
// 台帳の検査

#[test]
fn 台帳は約束どおり() {
    let (min_entries, entries) = 台帳();
    let 走査結果 = 全走査();

    // **行を黙って消せないようにする**（設計§6）。
    // 行を消すなら min_entries を下げるしかなく、**その差分はレビューで見える**
    assert!(
        entries.len() >= min_entries,
        "台帳の行が {} 件しかありません（下限 {min_entries}）。\
         **意図して覆したのなら行を消さず retired で畳むこと**——畳めば行は残るので\
         下限は下がりません。本当に減らすなら min_entries も下げること",
        entries.len()
    );

    let 破り = 約束破り(&entries, &走査結果);
    assert!(
        破り.is_empty(),
        "台帳の約束を破っている行があります（{} 件）:\n{}",
        破り.len(),
        破り.join("\n")
    );
}

/// 約束が**本当に発火するか**を、1つずつわざと破って確かめる。
///
/// # なぜ要るのか
///
/// 台帳の行が全部正しければ [`約束破り`] は空を返す。**つまり緑は「約束が効いている」を
/// 意味しない**——約束を1本まるごと消しても、台帳が正しい限り緑のままである。
///
/// これはこのイシューグループが問題にしている形そのもの（在るだけで効かない見張り）
/// なので、**見張りの側にも見張りを置く**。
///
/// # 土台が正しいことを先に主張する
///
/// 合成した見本が最初から違反していると、**どの変異も「落ちた」になって何も確かめない。**
/// だから見本そのものが0件であることを先に assert する。
#[test]
fn 約束はわざと破ると落ちる() {
    let 走査結果 = 全走査();

    // 実在する行を見本にする。**作り話の行だと、実在しないファイルを指した時点で
    // 別の約束が先に鳴ってしまい、狙った約束を確かめられない。**
    let 見本 = || Entry {
        issue: "クローズ/電源ボタンで起こし直すと、ターミナルがリロードするまで描かれない"
            .to_string(),
        behavior: "起こし直しの最中に購読を断られたあとでも、次に状態が動いたときに出し直す"
            .to_string(),
        gate: "unit".to_string(),
        tests: vec![テスト {
            file: "web/src/stores/ws.test.ts".to_string(),
            name: "起こし直しで購読を断られたら、次の状態変化でもう一度出す".to_string(),
        }],
        manual_check: None,
        breaks_when: "ws.ts の noteRefusal から 断られた への登録を外す".to_string(),
        verified: true,
        retired_by: None,
    };

    assert!(
        約束破り(&[見本()], &走査結果).is_empty(),
        "見本そのものが約束を破っています。これでは、どの変異も落ちてしまい何も確かめられません"
    );

    // (名前, その行をどう壊すか, 出てほしいメッセージの断片)
    let 変異: Vec<(&str, Box<dyn Fn(&mut Entry)>, &str)> = vec![
        (
            "約束2：breaks_when が逃げ文句",
            Box::new(|e: &mut Entry| e.breaks_when = "不要".to_string()),
            "breaks_when が中身を持っていません",
        ),
        (
            "約束2：behavior が短すぎる",
            Box::new(|e: &mut Entry| e.behavior = "短い".to_string()),
            "behavior が中身を持っていません",
        ),
        (
            "約束3：条件語が無い",
            Box::new(|e: &mut Entry| e.behavior = "購読を出し直すようにする".to_string()),
            "「どの条件で」が書かれていません",
        ),
        (
            "約束4：知らない門",
            Box::new(|e: &mut Entry| e.gate = "なにか".to_string()),
            "gate は",
        ),
        (
            "約束4：門がパスと食い違う",
            Box::new(|e: &mut Entry| e.gate = "e2e".to_string()),
            "で走ります",
        ),
        (
            "約束5：ファイルが無い",
            Box::new(|e: &mut Entry| {
                e.tests[0].file = "web/src/stores/ありえない.test.ts".to_string()
            }),
            "が在りません",
        ),
        (
            "約束6と9：名前が無く、覆した側も名指ししていない",
            Box::new(|e: &mut Entry| {
                e.tests[0].name = "ぜったいに存在しないテストの名前".to_string()
            }),
            "retired.by に覆した側のイシューを書くこと",
        ),
        (
            "約束7：飛ばしているテストを指している",
            Box::new(|e: &mut Entry| {
                e.tests[0] = テスト {
                    file: "server/crates/core/tests/real_cli.rs".to_string(),
                    name: "ヘッドレスで起動するとフックが届き必須フィールドが揃う".to_string(),
                }
            }),
            "飛ばしているテストは守っていません",
        ),
        (
            "約束8：manual なのに確かめ方が無い",
            Box::new(|e: &mut Entry| {
                e.gate = "manual".to_string();
                e.tests.clear();
            }),
            "manual_check",
        ),
        (
            "約束8：manual でないのにテストが1本も無い",
            Box::new(|e: &mut Entry| e.tests.clear()),
            "tests",
        ),
        (
            "約束12：同じ名前が2本あるテストを指している",
            Box::new(|e: &mut Entry| {
                e.tests[0] = テスト {
                    file: "web/src/lib/press.test.ts".to_string(),
                    name: "選べない箱も、選択中は解くだけ".to_string(),
                }
            }),
            "本あります",
        ),
    ];

    for (名前, 壊す, 断片) in 変異 {
        let mut e = 見本();
        壊す(&mut e);
        let 破り = 約束破り(&[e], &走査結果);
        assert!(
            破り.iter().any(|m| m.contains(断片)),
            "{名前} を破ったのに、その約束が鳴りませんでした。\
             **約束が効いていません。** 出たのは: {破り:?}"
        );
    }

    // 並び順は1行では破れないので、2行にして入れ替える
    let mut 上 = 見本();
    上.behavior = "あ".repeat(20);
    let mut 下 = 見本();
    下.behavior = "ん".repeat(20);
    assert!(
        約束破り(&[下, 上], &走査結果)
            .iter()
            .any(|m| m.contains("並びが崩れています")),
        "約束11：並び順を崩したのに鳴りませんでした"
    );
}

#[test]
fn 守られている数を数える() {
    let (_, entries) = 台帳();
    let 生きている: Vec<&Entry> = entries.iter().filter(|e| e.retired_by.is_none()).collect();

    let unit = 生きている.iter().filter(|e| e.gate == "unit").count();
    let e2e = 生きている.iter().filter(|e| e.gate == "e2e").count();
    let manual = 生きている.iter().filter(|e| e.gate == "manual").count();

    println!("--- 直した振る舞いの台帳 ---");
    println!("  門の中で守られている（unit）: {unit}");
    println!("  E2E だけが守っている        : {e2e}  ← make ci に E2E は入っていない");
    println!("  人でしか確かめられない      : {manual}");
    println!(
        "  畳んだ（retired）           : {}",
        entries.len() - 生きている.len()
    );

    // **「載っている」と「確かめてある」を同じ数で語らない。**
    //
    // `breaks_when` は記録であって検査ではない（台帳の頭に書いてある）。そのうえ
    // **遡って載せたぶんは、その1回の記録すら無い**——実装を読んで「ここを戻せば
    // 落ちるはず」と書いただけで、当てていない。
    //
    // 分けて出すのは、**この数が減っていくことを次に読む人へ渡すため**である。
    // 1つの数にまとめると、台帳が育つほど「守られている」に見えて、確かめていない
    // 行が埋もれる。
    // **`false` は「誰も確かめていない」ではない。**
    //
    // 遡って載せた行の `breaks_when` には、**閉じた当人が実際に壊して実行レポートへ
    // 残した記録を写したもの**が混ざっている（8通りの表を持つイシューすらある）。
    // それと「実装を読んで推定しただけのもの」は、いまの欄では区別できていない。
    //
    // それでも `false` にしているのは、**`verified` が問うているのが
    // 「いまのコードに対して当てたか」**だからである。閉じた当時に落ちたことは、
    // 今日も落ちることを意味しない——テストもコードもそれから動いている。
    //
    // **数え方を誤魔化さないために、残りを「推定」と言い切らない。**
    let 確かめた = 生きている.iter().filter(|e| e.verified).count();
    println!(
        "  うち、いまのコードに当てた  : {確かめた} / {}",
        生きている.len()
    );
    println!(
        "  ※ 残り {} 行は当てていない。閉じた当人の記録を写したものと、実装から書いた推定が混ざっている",
        生きている.len() - 確かめた
    );

    if MyDocsがある() {
        let mut 載っている: BTreeSet<String> = BTreeSet::new();
        for entry in &entries {
            載っている.insert(entry.issue.clone());
        }
        let mut 未掲載 = 0usize;
        let クローズ = repo_root().join("MyDocs/イシュー/クローズ");
        let mut 要件 = Vec::new();
        walk(&クローズ, &["要件.md"], &mut 要件);
        for path in &要件 {
            let rel = 相対(path);
            let folder = rel
                .trim_start_matches("MyDocs/イシュー/")
                .trim_end_matches("/要件.md")
                .to_string();
            if !載っている.contains(&folder) {
                未掲載 += 1;
            }
        }
        println!(
            "  台帳に1行も無いクローズ済みイシュー: {未掲載} / {}",
            要件.len()
        );
        println!(
            "  ※ ここでは落とさない。落とすと遡りが終わるまで恒常的に赤になり、やがて誰も読まなくなる"
        );
    } else {
        // **畳んだことを黙らない。** 黙って通すと、CI が緑でも何を確かめたのか
        // 誰も知らない状態になる
        println!("  MyDocs/ が無いので、イシューの実在に関する検査2件を畳みました");
        println!("  （retired.by と issue の実在／台帳に無いクローズ済みイシューの数）");
    }
}
