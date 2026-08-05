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

/** 1つ上の階層。ルートまで来たら `null`（**そこで止める**）。 */
export function parentOf(path: string): string | null {
  if (path === '/' || path === '') {
    return null
  }
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const cut = trimmed.lastIndexOf('/')
  if (cut < 0) {
    return null
  }
  return cut === 0 ? '/' : trimmed.slice(0, cut)
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
