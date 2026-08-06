/**
 * 利用者の PC のフォルダを引く（イシューグループ_2026_0805_0514 設計§8・§10）。
 *
 * # なぜ REST なのか
 *
 * WebSocket は「起きたことを配る線」で、これは「聞いて答える線」である。性質の違う
 * ものを1本に混ぜると、片方の遅れがもう片方を引きずる（設計§10）。
 *
 * # 断られた理由をそのまま持ち上げる
 *
 * サーバは状態コードを言い分けている（権限・不在・版が古い・応じない）。ここで
 * まとめて「読めません」にすると、**利用者が直せるものまで直せなくなる**（§17）。
 * 本文がそのまま画面に出る文になっているので、素通しする。
 */

/** 一覧の1行。Rust 側の `protocol::fs::DirEntry` と同じ綴り。 */
export interface DirEntry {
  name: string
  kind: 'dir' | 'file' | 'symlink'
  /** `.git` を持つフォルダ。**深い階層で目的地を1階層ぶん先に教える**（設計§8） */
  is_project: boolean
}

/** フォルダ1つの中身。 */
export interface DirListing {
  /** 着いた先の絶対パス。**省略して問うたときはここでホームが分かる**（設計§26-2） */
  path: string
  entries: DirEntry[]
  /** 上限で打ち切ったか。**隠さない**（設計§8） */
  truncated: boolean
}

/**
 * ファイル1つの中身。Rust 側の `protocol::fs::FileContent` と同じ綴り。
 *
 * 読めるのは**テキストだけ**で、上限を超えたものは中身ごと断られる（設計§9）。
 * したがってここへ届いた時点で「読めた」ことは確定しており、`truncated` は
 * **上限の内側で切った**ことだけを意味する。
 */
export interface FileContent {
  path: string
  text: string
  /** 上限の内側で切ったか。**隠さない**（設計§9・§15） */
  truncated: boolean
  /** 元のファイルの大きさ */
  bytes: number
}

/** 引けなかったときに投げるもの。`message` はそのまま画面へ出す。 */
export class HostFsError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HostFsError'
    this.status = status
  }
}

/**
 * フォルダの中身を引く。
 *
 * `path` を省略すると**その PC のホーム**へ着く（設計§26-2）。ホームを知っているのは
 * PC 側だけなので、画面が `~` を組み立てて送ることはできない。
 */
export async function listDir(
  host: string,
  path?: string,
): Promise<DirListing> {
  const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`
  const response = await fetch(
    `/api/hosts/${encodeURIComponent(host)}/dir${query}`,
  )
  if (!response.ok) {
    throw new HostFsError(response.status, await reason(response))
  }
  return (await response.json()) as DirListing
}

/**
 * ファイルの中身を引く（設計§9・§10）。
 *
 * 一覧と違い `path` は省略できない。**どこから読むかは呼ぶ側にしか分からない**ので、
 * 省いた形にサーバ側の既定を持たせると「押した相手と読まれた相手がずれる」余地ができる。
 */
export async function readFile(
  host: string,
  path: string,
): Promise<FileContent> {
  const response = await fetch(
    `/api/hosts/${encodeURIComponent(host)}/file?path=${encodeURIComponent(path)}`,
  )
  if (!response.ok) {
    throw new HostFsError(response.status, await reason(response))
  }
  return (await response.json()) as FileContent
}

/**
 * `root` から見た相対パス。**基準を組み立てる場所をここ1つに閉じる**（設計§15）。
 *
 * 基準が分からない相対パスは、貼られた側で解釈できない。だから画面には必ず
 * 「何からの相対パスか」を添えるが、**組み立て自体を各所で書くと区切りの扱いが割れる**
 * （`childOf` を1箇所に置いてあるのと同じ理由）。
 *
 * `root` の外を渡された場合は**絶対パスのまま返す**。相対にできないものを無理に
 * `../` で表すと、貼られた側が別の場所を指す。
 */
export function relativeOf(root: string, path: string): string {
  if (!isUnder(root, path)) {
    return path
  }
  return path === trimEnd(root) ? '.' : path.slice(prefixOf(root).length)
}

/**
 * `path` が `root` そのものか、その内側にあるか（設計§15）。
 *
 * **区切りまで見る。** 素の前方一致で書くと、`/dev/app` の内側の判定に
 * `/dev/app-old` や `/dev/app2` が通ってしまう。名前の頭が同じ兄弟フォルダは
 * 珍しくないので、**起点の外へ抜ける道**がそこに残る。
 *
 * 同じ規則が2通りあると、片方を直したときにもう片方が取り残される。
 * 内側かどうかを見るのは全部ここを通す。
 */
export function isUnder(root: string, path: string): boolean {
  return path === trimEnd(root) || path.startsWith(prefixOf(root))
}

/** 末尾の区切りを落とす。ルート（`/`）だけは落とさない。 */
function trimEnd(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/** 内側を表す前置き。**ルートは `//` にしない**（そこだけ区切りが元から在る）。 */
function prefixOf(root: string): string {
  const base = trimEnd(root)
  return base.endsWith('/') ? base : `${base}/`
}

/** 断りの本文。空なら状態コードから当たり障りのない文を作る。 */
async function reason(response: Response): Promise<string> {
  const text = (await response.text()).trim()
  if (text !== '') {
    return text
  }
  return response.status === 404
    ? 'その場所は見つかりません'
    : 'フォルダを読めませんでした'
}

/** 子のパス。**画面で文字列を継ぎ足さない**（区切りの重なりがここに閉じる）。 */
export function childOf(path: string, name: string): string {
  return path.endsWith('/') ? `${path}${name}` : `${path}/${name}`
}

/**
 * パンくずの各段（**根から順**）。
 *
 * 段ごとに「押したらそこへ移る」ためのパスを持たせる。ブラウザの「戻る」を階層の
 * 移動に使わないのは、意味が衝突するため（設計§13）。
 */
export function crumbsOf(path: string): { label: string; path: string }[] {
  const crumbs = [{ label: '/', path: '/' }]
  let walked = ''
  for (const part of path.split('/')) {
    if (part === '') {
      continue
    }
    walked = `${walked}/${part}`
    crumbs.push({ label: part, path: walked })
  }
  return crumbs
}
