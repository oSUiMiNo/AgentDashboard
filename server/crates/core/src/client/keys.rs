//! キーの名前とバイト列（CLI設計§9-3）。
//!
//! 権限確認や `/rewind` のメニューは**文章ではなくキーで答えるもの**なので、`send` とは
//! 別に、キーを1つずつ送る口が要る。名前は**線の上を流れるバイト列**で決める——確定は
//! `CR` なので `enter`、改行は `ESC CR` なので `newline`。画面の「確定が Ctrl+Enter」は
//! ブラウザ側の事情（textarea が Enter を食べる）への対処であって、CLI に持ち込まない
//! （§9-3。持ち込むと、CLI にしか無い決まりを覚える必要が生まれる）。
//!
//! **生バイトを直に送る口は持たせない**（§9-4）。任意のバイト列を許すと、入力の作法
//! （初期実装§18 の3つの約束）を迂回できてしまう。名前が足りなくなったら表へ足す。

use std::time::Duration;

use super::ClientError;

/// キーとキーの間に置く待ち（§9-3）。
///
/// 2つの書き込みが1回の読み取りにまとまると、TUI の受け取り方が変わる（初期実装§18 の
/// 「本文と確定の CR を別の書き込みにする」で実測した性質と同じ）。30ms は本文と確定の
/// 間に置いている値（`session/input.rs`）に揃えた。
pub const KEY_GAP: Duration = Duration::from_millis(30);

/// 受け付ける名前とバイト列の表（CLI設計§9-3）。
const TABLE: &[(&str, &[u8])] = &[
    ("up", b"\x1b[A"),
    ("down", b"\x1b[B"),
    ("right", b"\x1b[C"),
    ("left", b"\x1b[D"),
    // 確定。ESC CR ではない——それは newline（ブラウザの読み替えを持ち込まない証拠）
    ("enter", b"\r"),
    ("newline", b"\x1b\r"),
    ("esc", b"\x1b"),
    ("tab", b"\t"),
    ("shift-tab", b"\x1b[Z"),
    ("space", b" "),
    ("ctrl-c", b"\x03"),
    ("ctrl-u", b"\x15"),
];

/// 名前をバイト列へ。知らない名前は `None`。
pub fn encode(name: &str) -> Option<&'static [u8]> {
    TABLE
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, bytes)| *bytes)
}

/// 受け付ける名前の一覧（断りの言葉に添える）。
pub fn names() -> String {
    TABLE
        .iter()
        .map(|(key, _)| *key)
        .collect::<Vec<_>>()
        .join(" / ")
}

/// 並べた名前をその順のバイト列へ。**1つでも知らない名前があれば、何も送らずに断る**
/// ——途中まで送ってから断ると、TUI が中途半端なキーを受けた状態で残る。
pub fn encode_all(names: &[String]) -> Result<Vec<&'static [u8]>, ClientError> {
    names
        .iter()
        .map(|name| {
            encode(name).ok_or_else(|| ClientError::Refused {
                status: 400,
                message: format!(
                    "`{name}` というキーは知りません。受け付けるのは: {}",
                    self::names()
                ),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 矢印はカーソルキーの符号になる() {
        assert_eq!(encode("up"), Some(b"\x1b[A".as_slice()));
        assert_eq!(encode("down"), Some(b"\x1b[B".as_slice()));
        assert_eq!(encode("right"), Some(b"\x1b[C".as_slice()));
        assert_eq!(encode("left"), Some(b"\x1b[D".as_slice()));
    }

    #[test]
    fn 確定はcrであってesccrではない() {
        // ブラウザの「確定は Ctrl+Enter」という読み替えを持ち込まない証拠（CLI設計§9-3）。
        // ESC CR は改行（newline）のほう
        assert_eq!(encode("enter"), Some(b"\r".as_slice()));
        assert_ne!(encode("enter"), Some(b"\x1b\r".as_slice()));
    }

    #[test]
    fn 改行はesccrになる() {
        assert_eq!(encode("newline"), Some(b"\x1b\r".as_slice()));
    }

    #[test]
    fn 残りの名前も正しいバイト列になる() {
        assert_eq!(encode("esc"), Some(b"\x1b".as_slice()));
        assert_eq!(encode("tab"), Some(b"\t".as_slice()));
        assert_eq!(encode("shift-tab"), Some(b"\x1b[Z".as_slice()));
        assert_eq!(encode("space"), Some(b" ".as_slice()));
        assert_eq!(encode("ctrl-c"), Some(b"\x03".as_slice()));
        assert_eq!(encode("ctrl-u"), Some(b"\x15".as_slice()));
    }

    #[test]
    fn 知らない名前は一覧を添えて断る() {
        let error = encode_all(&["down".to_string(), "meta-x".to_string()])
            .expect_err("知らない名前で断ること");
        let text = error.to_string();
        assert!(
            text.contains("meta-x"),
            "どの名前が駄目かを言うこと: {text}"
        );
        assert!(
            text.contains("enter") && text.contains("shift-tab"),
            "受け付ける一覧を添えること: {text}"
        );
    }

    #[test]
    fn 並べた順がそのまま保たれる() {
        let sequence = encode_all(&["down".to_string(), "down".to_string(), "enter".to_string()])
            .expect("全部知っている名前");
        assert_eq!(
            sequence,
            vec![b"\x1b[B".as_slice(), b"\x1b[B".as_slice(), b"\r".as_slice()]
        );
    }
}
