//! 擬似 claude（`fake-claude` バイナリ）との取り決め。
//!
//! バイナリ本体と、それを起動するテストの両方から参照する定数と補助関数を置く。
//! マーカー文字列を1箇所にまとめておかないと、片方だけ変えたときに「出力を待ち続けて
//! タイムアウトする」という原因の分かりにくい失敗になる。

use std::path::PathBuf;

/// 起動完了を示すマーカー。テスト側はこれを待ってから入力を送る。
pub const READY_MARKER: &str = "[fake-claude] ready";
/// 1行処理したことを示す行頭。
pub const RECEIVED_PREFIX: &str = "[fake-claude] received: ";
/// `dump` が書き出す起動引数の行頭。
pub const ARGV_PREFIX: &str = "[fake-claude] argv: ";
/// `dump` が書き出す環境変数の行頭。
pub const ENV_PREFIX: &str = "[fake-claude] env: ";
/// `dump` の出力が終わったことを示すマーカー。ここまで読めば全件揃っている。
pub const DUMP_END_MARKER: &str = "[fake-claude] dump-end";
/// `flood` の出力が終わったことを示すマーカー。
pub const FLOOD_END_MARKER: &str = "[fake-claude] flood-end";
/// 終了時のマーカー。
pub const BYE_MARKER: &str = "[fake-claude] bye";
/// `flood` が繰り返し吐くパターン。ASCII のみで、端末の制御シーケンスを含まない。
///
/// 64バイトごとに改行を入れているのは、実際の CLI 出力に近づけるため。改行の無い
/// 数MBの1行はブラウザ側の折り返し処理だけが重くなり、測りたいもの（配信とフロー制御）が
/// 見えにくくなる。
pub const FLOOD_PATTERN: &[u8] = b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abc\n";

/// `fake-claude` 実行ファイルの場所を、いま動いているテストバイナリから割り出す。
///
/// `CARGO_BIN_EXE_*` はバイナリを定義したパッケージの統合テストにしか渡らないため、
/// 別クレート（core）のテストからは使えない。cargo はテストバイナリを
/// `target/<profile>/deps/` に置き、実行ファイルを `target/<profile>/` に置くので、
/// テストバイナリの位置から辿るのが移植性のある方法になる。
pub fn path() -> PathBuf {
    let mut dir = std::env::current_exe().expect("テストバイナリの場所を取得できること");
    dir.pop(); // 実行ファイル名を落とす
    if dir.ends_with("deps") {
        dir.pop();
    }
    let binary = dir.join("fake-claude");
    assert!(
        binary.is_file(),
        "fake-claude が見つかりません: {}。testkit をビルドしてから実行してください",
        binary.display()
    );
    binary
}
