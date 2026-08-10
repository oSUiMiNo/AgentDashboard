//! 画面のエスケープ列をテキストへ（CLI設計§9-1）。
//!
//! `session screen` が受け取る `0x03` の payload はエスケープ列で、そのままでは
//! エージェントに読めない。ブラウザが xterm.js でやっていることを、CLI は vt100 でやる
//! ——この形は元からテストのブラウザ役（`tests/a2s.rs`・`tests/real_cli.rs`）に在ったもので、
//! その役がそのまま製品になった。

/// エスケープ列を、いま見えている画面のテキストにする。
///
/// パーサは**購読と同じ大きさ**で作る（CLI設計§15-3）。食わせるサイズと購読したサイズが
/// 違うと折り返しがずれる——リングの中身は生バイトの再生なので、折り返しはこちらの幅で
/// 決まる。スクロールバックは持たない（§9-1。1枚の「いま」だけが要る）。
pub fn render_screen(payload: &[u8], rows: u16, cols: u16) -> String {
    let mut parser = vt100::Parser::new(rows, cols, 0);
    parser.process(payload);
    parser.screen().contents()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn エスケープ列が読めるテキストになる() {
        // 色とカーソル移動を含む列。contents() は装飾を落として文字だけを返す
        let payload = b"\x1b[2J\x1b[H\x1b[31mhello\x1b[0m\r\nworld";
        let text = render_screen(payload, 24, 80);
        assert!(text.contains("hello"), "1行目が読めること: {text}");
        assert!(text.contains("world"), "2行目が読めること: {text}");
        assert!(!text.contains('\x1b'), "エスケープが残らないこと");
    }

    #[test]
    fn 折り返しはこちらの幅で決まる() {
        // 幅10のパーサへ 15文字を食わせると、11文字目は2行目の先頭セルに落ちる。
        // contents() はソフト折り返しを結合して返すので、位置はセルで確かめる
        let payload = b"abcdefghijklmno";
        let mut parser = vt100::Parser::new(5, 10, 0);
        parser.process(payload);
        let screen = parser.screen();
        assert_eq!(screen.cell(0, 0).map(|cell| cell.contents()), Some("a"));
        assert_eq!(
            screen.cell(1, 0).map(|cell| cell.contents()),
            Some("k"),
            "幅10で折り返されて2行目の先頭が k になること"
        );
    }
}
