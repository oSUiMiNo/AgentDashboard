import { countChanges, toDiffSource } from './diff'

/**
 * Claude Code の `structuredPatch` から差分表示用の形へ直す変換（テスト計画フェーズ5「diff表示」）。
 *
 * 実データの形をそのまま入力にしている。ここがずれると、差分が1行ずれて表示される
 * （行番号は自分で数え直しているため、ずれても例外にならず静かに間違う）。
 */
describe('structuredPatch の変換', () => {
  const patch = {
    filePath: '/work/sample/notes.md',
    originalFile: '# サンプルメモ\n',
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 4,
        lines: [
          ' # サンプルメモ',
          ' ',
          '-- [ ] TODO: 集計処理のテストを書く',
          '+- [x] DONE: 集計処理のテストを書く',
          ' - [ ] TODO: README を更新する',
        ],
      },
    ],
  }

  it('行の種別と行番号を復元できる', () => {
    const diff = toDiffSource(patch)
    expect(diff).not.toBeNull()
    const changes = diff!.hunks[0].changes
    expect(changes.map((change) => change.type)).toEqual([
      'normal',
      'normal',
      'delete',
      'insert',
      'normal',
    ])

    // 変更前・変更後で行番号の進み方が違う。ここを間違えると差分が1行ずれる
    expect(changes[2]).toMatchObject({ type: 'delete', lineNumber: 3 })
    expect(changes[3]).toMatchObject({ type: 'insert', lineNumber: 3 })
    expect(changes[4]).toMatchObject({
      type: 'normal',
      oldLineNumber: 4,
      newLineNumber: 4,
    })
  })

  it('行頭のマーカーは本文から取り除く', () => {
    const diff = toDiffSource(patch)
    expect(diff!.hunks[0].changes[3].content).toBe('- [x] DONE: 集計処理のテストを書く')
  })

  it('ヘッダを unified diff と同じ書式で組み立てる', () => {
    const diff = toDiffSource(patch)
    expect(diff!.hunks[0].content).toBe('@@ -1,4 +1,4 @@')
  })

  it('増減の行数を数えられる', () => {
    const diff = toDiffSource(patch)
    expect(countChanges(diff!.hunks)).toEqual({ added: 1, removed: 1 })
  })

  it('originalFile が無ければ新規作成として扱う', () => {
    const created = toDiffSource({
      filePath: '/work/sample/summary.txt',
      structuredPatch: [
        { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+作りました'] },
      ],
    })
    expect(created!.diffType).toBe('add')
  })

  it('差分を持たない結果は null になる', () => {
    // Bash や Read の結果。差分表示ではなく生の結果として出す
    expect(toDiffSource({ stdout: 'ok' })).toBeNull()
    expect(toDiffSource('Error: rejected')).toBeNull()
    expect(toDiffSource(null)).toBeNull()
  })

  it('改行の注記は行として数えない', () => {
    // `\ No newline at end of file` は差分の注記であって内容ではない
    const diff = toDiffSource({
      filePath: 'a.txt',
      originalFile: 'x',
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-x', '\\ No newline at end of file', '+y'],
        },
      ],
    })
    expect(diff!.hunks[0].changes).toHaveLength(2)
  })
})
