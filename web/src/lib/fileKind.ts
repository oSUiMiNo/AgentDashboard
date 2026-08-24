/**
 * ファイルをどう見せるかの種別（`ファイル閲覧で画像とHTMLも表示する` 設計§2）。
 *
 * # 拡張子だけで決める
 *
 * 中身は推測しない。推定を始めると、外したときに**嘘を表示する**ことになる
 * （文字コードを推定しないと決めてあるのと同じ理由）。
 *
 * # ここは写しである
 *
 * 正は `server/crates/protocol/src/fs.rs` の `TABLE`。PC 側・サーバ・画面の3者が
 * 同じ判断をするので、**片方だけ直すと食い違う**。`fileKind.test.ts` が
 * **Rust のソースを読んで突き合わせる**ので、どちらを直しても落ちる。
 */

/** 5種。Rust 側の `FileKind`（スネークケース）と同じ綴り。 */
export type FileKind = 'markdown' | 'html' | 'svg' | 'image' | 'text'

/**
 * 拡張子 → 種別。
 *
 * **`svg` は `image` ではない。** 中に script を書けるので、危なさは HTML と同じ側に
 * ある。script を書ける形式を1つの箱にまとめておけば、隔離の理屈が1本で済む（設計§6-4）。
 */
const TABLE: Record<string, FileKind> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  svg: 'svg',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
}

/**
 * このファイルをどう見せるか。表に無いものは `text`（既定へ落ちる）。
 *
 * **大文字小文字は区別しない**（設計§2-3）。Windows 側から持ち込まれたファイルで
 * 普通に起こる。
 */
export function fileKind(path: string): FileKind {
  const name = path.split(/[/\\]/).pop() ?? path
  const at = name.lastIndexOf('.')
  // 先頭のドットは拡張子ではない（`.bashrc`）
  if (at <= 0) {
    return 'text'
  }
  return TABLE[name.slice(at + 1).toLowerCase()] ?? 'text'
}

/** 隔離した箱（`iframe`）で描く相手か（設計§6）。 */
export function needsSandbox(kind: FileKind): boolean {
  return kind === 'html' || kind === 'svg'
}
