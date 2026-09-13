import type { fileKind } from '@/lib/fileKind'

/**
 * 開いているファイルを、**見ているのか編集しているのか**（`ファイルビュアにエディタ
 * 機能を追加` 設計§5-1）。
 *
 * **名前を `raw` にしない。** 意味が反転している——もとの `raw=true`（生テキスト）が、
 * 置き換え後は**エディタ**である。
 */
export type FileMode = 'viewer' | 'editor'

/**
 * 設定を引くための拡張子（小文字・先頭の `.` を含まない）。
 *
 * **点を持たない名前と、`.bashrc` のような点で始まる名前は空を返す**——
 * どちらも「拡張子が無い」ので、**設定の行と当ててはいけない**。
 */
export function 拡張子(path: string): string {
  const 名前 = path.split('/').pop() ?? ''
  const 位置 = 名前.lastIndexOf('.')
  return 位置 > 0 ? 名前.slice(位置 + 1).toLowerCase() : ''
}

/** その種別がビュアーを持つか。**`image` はどちらも持たない**ので、ここには入らない。 */
export function ビュアーがある(kind: ReturnType<typeof fileKind>): boolean {
  return kind === 'markdown' || kind === 'html' || kind === 'svg'
}

/**
 * 開いたときにどちらで始めるか（設計§5-1・§10-2、要件③）。
 *
 * **まず設定を見て、載っていなければ種別から導く。**
 *
 * - **ビュアーを持たない種別はエディタで始める。** `text` は表に無い拡張子すべての
 *   落ちどころなので、**既定がエディタ**になる（要件「設定無しの拡張子はエディタ」）
 * - `markdown` ／ `html` ／ `svg` はビュアーを持つので、**見たいものをまず見せる**
 * - **`image` はどちらも持たない**（描画の手前で分かれるので、ここの値は使われない）
 *
 * **決める側は純関数にしてある**——この PJT が並べ替えや効果線で採っている型と同じで、
 * DOM を読む側と混ぜると、jsdom が矩形を固定で返すので**何も確かめないまま緑になる**。
 */
export function 既定のモード(
  kind: ReturnType<typeof fileKind>,
  path: string,
  設定: Record<string, FileMode>,
): FileMode {
  const 選ばれたもの = 設定[拡張子(path)]
  // **ビュアーを持たない種別に「見る」を選ばれても、行き先が無い。** 押せて何も
  // 起きないものを出さないのと同じ理由で、**受けたふりをせず既定へ落とす**
  if (選ばれたもの && !(選ばれたもの === 'viewer' && !ビュアーがある(kind))) {
    return 選ばれたもの
  }
  return kind === 'text' ? 'editor' : 'viewer'
}
