/**
 * Claude Code が書き出す差分（`structuredPatch`）を、差分表示ライブラリが読める形へ直す。
 *
 * トランスクリプトの Edit/Write の結果には `structuredPatch` という**構造化された差分**が
 * 入っている。unified diff の文字列ではないので、そのままでは `parseDiff` に渡せない。
 * 変換をこの1ファイルに閉じておけば、表示ライブラリを差し替えても影響が広がらない。
 *
 * 元の形（実データ）：
 * ```json
 * {"oldStart":1,"oldLines":4,"newStart":1,"newLines":4,
 *  "lines":[" 変わらない行","-消えた行","+増えた行"]}
 * ```
 * 行頭の1文字が種別で、残りが本文。
 */

import type { ChangeData, HunkData } from 'react-diff-view'

/** `toolUseResult` に入っている差分のかたまり。 */
interface StructuredHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** ツールの結果から差分表示に必要なものだけ取り出したもの。 */
export interface DiffSource {
  filePath: string
  hunks: HunkData[]
  /** 新規作成なら `add`、既存の書き換えなら `modify` */
  diffType: 'add' | 'modify'
}

/** 差分を出せるツールか（名前ではなく結果の中身で判断する）。 */
export function toDiffSource(result: unknown): DiffSource | null {
  if (typeof result !== 'object' || result === null) {
    return null
  }
  const record = result as Record<string, unknown>
  const patch = record.structuredPatch
  if (!Array.isArray(patch) || patch.length === 0) {
    return null
  }

  const hunks = patch
    .filter(isStructuredHunk)
    .map(toHunk)
    .filter((hunk): hunk is HunkData => hunk !== null)
  if (hunks.length === 0) {
    return null
  }

  return {
    filePath: typeof record.filePath === 'string' ? record.filePath : '',
    hunks,
    // originalFile が空なら新規作成。表示の見出しを変えるためだけに使う
    diffType: record.originalFile ? 'modify' : 'add',
  }
}

function isStructuredHunk(value: unknown): value is StructuredHunk {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const hunk = value as Record<string, unknown>
  return (
    typeof hunk.oldStart === 'number' &&
    typeof hunk.newStart === 'number' &&
    Array.isArray(hunk.lines)
  )
}

function toHunk(source: StructuredHunk): HunkData | null {
  const changes: ChangeData[] = []
  let oldLineNumber = source.oldStart
  let newLineNumber = source.newStart

  for (const line of source.lines) {
    // 「\ No newline at end of file」は差分の注記であって行ではない
    if (line.startsWith('\\')) {
      continue
    }
    const marker = line.slice(0, 1)
    const content = line.slice(1)

    if (marker === '+') {
      changes.push({
        type: 'insert',
        content,
        isInsert: true,
        lineNumber: newLineNumber,
      })
      newLineNumber += 1
    } else if (marker === '-') {
      changes.push({
        type: 'delete',
        content,
        isDelete: true,
        lineNumber: oldLineNumber,
      })
      oldLineNumber += 1
    } else {
      changes.push({
        type: 'normal',
        content,
        isNormal: true,
        oldLineNumber,
        newLineNumber,
      })
      oldLineNumber += 1
      newLineNumber += 1
    }
  }

  if (changes.length === 0) {
    return null
  }

  return {
    // ライブラリが見出しに使うヘッダ。unified diff と同じ書式で組み立てる
    content: `@@ -${source.oldStart},${source.oldLines} +${source.newStart},${source.newLines} @@`,
    oldStart: source.oldStart,
    oldLines: source.oldLines,
    newStart: source.newStart,
    newLines: source.newLines,
    changes,
  }
}

/** 差分の増減行数（折り畳んだままでも規模が分かるように出す）。 */
export function countChanges(hunks: HunkData[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type === 'insert') {
        added += 1
      } else if (change.type === 'delete') {
        removed += 1
      }
    }
  }
  return { added, removed }
}
