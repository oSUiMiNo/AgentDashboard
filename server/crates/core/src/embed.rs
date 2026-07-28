//! フロントエンドのビルド成果物をバイナリへ同梱する（設計§1 StaticServer）。
//!
//! rust-embed は「コンパイル時に」フォルダの実体を読むため、`web/dist` は常に存在させる。
//! そのため空でも `.gitkeep` を追跡し、`make build` は必ず web ビルドを先行させる。

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
