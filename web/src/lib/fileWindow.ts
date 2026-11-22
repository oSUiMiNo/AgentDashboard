/**
 * 大きいファイルを窓で読む面の「次に何を頼むか・届いた窓をどう並べるか」を決める規則
 * （`ファイル閲覧の上限を設定から変え、大きいものは流し読みする` 設計§10-3）。
 *
 * # 決める側と測る側を分ける
 *
 * **ここは `window` も `document` も読まない純関数だけを置く。** スクロールの位置や
 * 要素の高さを測るのは面（`components/FileView/FileWindowView.tsx`）で、ここは測った
 * 結果や届いた窓を引数で受け取って答えを返す。jsdom は寸法を測れないので、測る側と
 * 決める側が同じ関数に居ると、試験を書いても何も確かめないまま緑になる
 * （`lib/reorder.ts`／`useReorder.ts` と同じ作り）。
 *
 * # 窓は継ぎ目に欠けも重なりも無く並ぶ
 *
 * サーバ（PC）は窓の始まりと終わりを UTF-8 の文字の境目へ寄せ、実際に読んだ位置を
 * `start`・`end` で返す。**次の窓は前の窓の `end` から頼み、前の窓は今の先頭の
 * `start` で終わるように頼む。** 並びは常に `windows[i].end === windows[i + 1].start`
 * を保ち、合わない窓（遅れて届いた古い答え）は捨てる。
 *
 * # 数の値
 *
 * 持つ窓の数（[`MAX_WINDOWS`]）は【エージェントの仮置き（利用者未承認）】（設計§10-3）。
 * 窓の大きさはサーバの設定の答え（`file_view.window_bytes`）から受け取り、ここに写しを持たない。
 */

import type { FileChunk } from '@/lib/hostfs'

/**
 * 持つ窓の数。窓 256 KiB なら 4 枚で 1 MiB。**離れた窓は捨てる**——下端で読み足すだけの
 * 形にすると、最後まで見たときにブラウザへ全部積み上がる（方針§2）。
 * 【エージェントの仮置き（利用者未承認）】設計§10-3
 */
export const MAX_WINDOWS = 4

/** 頼み方（`readFileRange` の引数と同じ形）。 */
export interface WindowRequest {
  offset: number
  length: number
  alignLine: boolean
}

/** 並べた窓。先頭から順に、隙間なく継がっている。 */
export type Windows = readonly FileChunk[]

/** 後ろへ読み足す頼み。最後の窓が末尾に届いていれば `null`。 */
export function nextRange(
  windows: Windows,
  bytes: number,
  windowBytes: number,
): WindowRequest | null {
  const last = windows[windows.length - 1]
  if (last === undefined || last.end >= bytes) {
    return null
  }
  return { offset: last.end, length: windowBytes, alignLine: false }
}

/**
 * 前へ読み足す頼み。先頭の窓がファイルの頭（0）なら `null`。
 *
 * 長さは今の先頭の `start` までに切るので、返る窓の `end` は `start` にぴったり継がる
 * （`start` 自体が文字の境目なので、サーバの終わりの寄せで縮まない）。行頭への寄せは、
 * 頭（0）から読むときは要らない。
 */
export function prevRange(
  windows: Windows,
  windowBytes: number,
  alignLine = true,
): WindowRequest | null {
  const first = windows[0]
  if (first === undefined || first.start === 0) {
    return null
  }
  const offset = Math.max(0, first.start - windowBytes)
  return { offset, length: first.start - offset, alignLine: alignLine && offset > 0 }
}

/**
 * 位置へ飛ぶ頼み。`'end'` は末尾の窓、数はそのバイト位置から。
 *
 * 途中から読むときは行頭へ寄せる（行の途中から見せない）。頭（0）から読むなら寄せない。
 */
export function jumpRange(
  target: 'end' | number,
  bytes: number,
  windowBytes: number,
): WindowRequest {
  const offset =
    target === 'end'
      ? Math.max(0, bytes - windowBytes)
      : Math.min(Math.max(0, Math.floor(target)), Math.max(0, bytes - 1))
  return { offset, length: windowBytes, alignLine: offset > 0 }
}

/**
 * 届いた窓を後ろへ並べる。継ぎ目が合わない窓（遅れて届いた古い答え）と空の窓（末尾）は
 * 捨てて `null`。持つ数を超えたら先頭を1枚落とし、`dropped: 'head'` を返す。
 *
 * **元の配列は書き換えない。**
 */
export function append(
  windows: Windows,
  chunk: FileChunk,
): { windows: FileChunk[]; dropped: 'head' | null } | null {
  if (chunk.start === chunk.end) {
    return null
  }
  const last = windows[windows.length - 1]
  if (last !== undefined && chunk.start !== last.end) {
    return null
  }
  const next = [...windows, chunk]
  if (next.length > MAX_WINDOWS) {
    return { windows: next.slice(1), dropped: 'head' }
  }
  return { windows: next, dropped: null }
}

/**
 * 届いた窓を前へ並べる。継ぎ目が合わない窓と空の窓は捨てて `null`。持つ数を超えたら
 * 末尾を1枚落とし、`dropped: 'tail'` を返す。
 *
 * **空の窓を捨てる理由**：行頭へ寄せたとき、範囲の中の最初の改行が範囲の最後の
 * 1バイトだと、寄せた先が今の先頭の `start` になって空の窓が返る。並べると先頭が
 * 変わらず、同じ頼みを繰り返す。面は `null` を受けたら、同じ範囲を寄せずに1回だけ
 * 頼み直す。
 *
 * **元の配列は書き換えない。**
 */
export function prepend(
  windows: Windows,
  chunk: FileChunk,
): { windows: FileChunk[]; dropped: 'tail' | null } | null {
  if (chunk.start === chunk.end) {
    return null
  }
  const first = windows[0]
  if (first !== undefined && chunk.end !== first.start) {
    return null
  }
  const next = [chunk, ...windows]
  if (next.length > MAX_WINDOWS) {
    return { windows: next.slice(0, -1), dropped: 'tail' }
  }
  return { windows: next, dropped: null }
}

/**
 * 見ている位置のバイト（表示用の近似）。読み込んだ範囲の中の割合（0〜1。スクロールの
 * 位置から面が測る）を、範囲のバイト位置へ写す。
 */
export function position(windows: Windows, ratioInLoaded: number): number {
  const first = windows[0]
  const last = windows[windows.length - 1]
  if (first === undefined || last === undefined) {
    return 0
  }
  const ratio = Number.isFinite(ratioInLoaded) ? Math.min(1, Math.max(0, ratioInLoaded)) : 0
  return Math.round(first.start + ratio * (last.end - first.start))
}

/** 窓を読んでいる間にファイルが変わったか（印が最初の窓と違うか）。 */
export function isChanged(base: string, chunk: FileChunk): boolean {
  return chunk.stamp !== base
}
