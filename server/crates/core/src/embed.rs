//! フロントエンドのビルド成果物をバイナリへ同梱する（設計§1 StaticServer）。
//!
//! rust-embed は「コンパイル時に」フォルダの実体を読むため、`web/dist` は常に存在させる。
//! cargo の唯一の入口である `scripts/cargo` がこのフォルダの作成を保証している。

use rust_embed::Embed;

/// `web/dist` 配下の同梱アセット。
///
/// 相対パスはこのクレートの Cargo.toml から解決される（crates/core → リポジトリルート）。
#[derive(Embed)]
#[folder = "../../../web/dist"]
pub struct WebAssets;

/// 同梱されているファイルのパス一覧を返す。
pub fn list() -> Vec<String> {
    let mut paths: Vec<String> = WebAssets::iter().map(|p| p.to_string()).collect();
    paths.sort();
    paths
}

/// 同梱ファイルの中身を取り出す。
pub fn get(path: &str) -> Option<Vec<u8>> {
    WebAssets::get(path).map(|file| file.data.into_owned())
}

/// 配信時に付ける Content-Type を拡張子から決める。
///
/// vite が吐くのは数種類だけなので、外部クレートを足さずに自前で対応表を持つ。
/// 判別できないものは「ブラウザに解釈させない」既定値にする（誤って HTML や
/// スクリプトとして実行されるのを防ぐため）。
pub fn content_type(path: &str) -> &'static str {
    let extension = path.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    match extension {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "map" => "application/json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 拡張子からcontent_typeが決まる() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(
            content_type("assets/index-abc123.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            content_type("assets/index-abc123.css"),
            "text/css; charset=utf-8"
        );
        assert_eq!(content_type("favicon.svg"), "image/svg+xml");
    }

    #[test]
    fn 判別できない拡張子はブラウザに解釈させない() {
        assert_eq!(content_type("README"), "application/octet-stream");
        assert_eq!(content_type("archive.tar.zst"), "application/octet-stream");
    }
}
