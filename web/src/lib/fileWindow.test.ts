/**
 * 窓で読む面の決める側（設計§10-3。テスト計画 フェーズ7「決める側の純関数の全部の枝」）。
 *
 * 測る側（スクロール・要素の高さ）は jsdom では測れないので、ここで見るのは
 * 「何を頼むか」と「届いた窓をどう並べるか」だけ。実際の寸法で読み足しが起きることは E2E が見る。
 */

import { describe, expect, it } from 'vitest'
import type { FileChunk } from '@/lib/hostfs'
import {
  MAX_WINDOWS,
  append,
  isChanged,
  jumpRange,
  nextRange,
  position,
  prepend,
  prevRange,
} from '@/lib/fileWindow'

const KiB = 1024
const 窓幅 = 256 * KiB

/** `start`〜`end` の窓。中身は試験では見ないので空白で埋める。 */
function 窓(start: number, end: number, stamp = 's1'): FileChunk {
  return {
    path: '/w/big.log',
    start,
    end,
    bytes: 10 * 1024 * 1024,
    text: ' '.repeat(Math.max(0, Math.min(end - start, 8))),
    stamp,
    at_line_start: true,
  }
}

describe('後ろへ読み足す頼み（nextRange）', () => {
  it('窓が無ければ頼まない', () => {
    expect(nextRange([], 1000, 窓幅)).toBeNull()
  })

  it('最後の窓の終わりから、窓の大きさぶん頼む（寄せない）', () => {
    expect(nextRange([窓(0, 100), 窓(100, 250)], 1000, 窓幅)).toEqual({
      offset: 250,
      length: 窓幅,
      alignLine: false,
    })
  })

  it('末尾に届いていれば頼まない', () => {
    expect(nextRange([窓(0, 1000)], 1000, 窓幅)).toBeNull()
  })
})

describe('前へ読み足す頼み（prevRange）', () => {
  it('窓が無ければ頼まない', () => {
    expect(prevRange([], 窓幅)).toBeNull()
  })

  it('先頭がファイルの頭なら頼まない', () => {
    expect(prevRange([窓(0, 100)], 窓幅)).toBeNull()
  })

  it('今の先頭の手前を、先頭でぴったり終わる長さで頼み、行頭へ寄せる', () => {
    const start = 1024 * KiB
    expect(prevRange([窓(start, start + 100)], 窓幅)).toEqual({
      offset: start - 窓幅,
      length: 窓幅,
      alignLine: true,
    })
  })

  it('頭（0）まで届くときは、頭から先頭までを寄せずに頼む', () => {
    expect(prevRange([窓(100, 200)], 窓幅)).toEqual({ offset: 0, length: 100, alignLine: false })
  })

  it('寄せない指定なら寄せない（空の窓が返ったときの頼み直し）', () => {
    const start = 1024 * KiB
    expect(prevRange([窓(start, start + 100)], 窓幅, false)?.alignLine).toBe(false)
  })
})

describe('位置へ飛ぶ頼み（jumpRange）', () => {
  it('末尾へ：最後の窓の大きさぶん手前から、行頭へ寄せて', () => {
    expect(jumpRange('end', 10 * 窓幅, 窓幅)).toEqual({
      offset: 9 * 窓幅,
      length: 窓幅,
      alignLine: true,
    })
  })

  it('窓より小さいファイルの末尾へは、頭から寄せずに', () => {
    expect(jumpRange('end', 100, 窓幅)).toEqual({ offset: 0, length: 窓幅, alignLine: false })
  })

  it('途中の位置へは、その位置から行頭へ寄せて', () => {
    expect(jumpRange(5000.7, 10 * 窓幅, 窓幅)).toEqual({
      offset: 5000,
      length: 窓幅,
      alignLine: true,
    })
  })

  it('負の位置は頭へ、末尾を越える位置は最後の1バイトへ丸める', () => {
    expect(jumpRange(-10, 1000, 窓幅)).toEqual({ offset: 0, length: 窓幅, alignLine: false })
    expect(jumpRange(5000, 1000, 窓幅).offset).toBe(999)
  })
})

describe('後ろへ並べる（append）', () => {
  it('空の並びには、そのまま1枚目として入る', () => {
    expect(append([], 窓(500, 600))).toEqual({ windows: [窓(500, 600)], dropped: null })
  })

  it('継ぎ目が合えば並べる', () => {
    expect(append([窓(0, 100)], 窓(100, 200))?.windows.map((w) => w.start)).toEqual([0, 100])
  })

  it('継ぎ目が合わない窓（遅れて届いた古い答え）は捨てる', () => {
    expect(append([窓(0, 100)], 窓(150, 200))).toBeNull()
  })

  it('空の窓（末尾）は捨てる', () => {
    expect(append([窓(0, 100)], 窓(100, 100))).toBeNull()
  })

  it(`${MAX_WINDOWS} 枚までは落とさず、超えたら先頭を1枚落とす`, () => {
    let windows: FileChunk[] = []
    for (let i = 0; i < MAX_WINDOWS; i++) {
      const got = append(windows, 窓(i * 100, (i + 1) * 100))
      expect(got?.dropped).toBeNull()
      windows = got?.windows ?? []
    }
    const got = append(windows, 窓(MAX_WINDOWS * 100, (MAX_WINDOWS + 1) * 100))
    expect(got?.dropped).toBe('head')
    expect(got?.windows).toHaveLength(MAX_WINDOWS)
    expect(got?.windows[0].start).toBe(100)
  })

  it('元の配列を書き換えない', () => {
    const windows = Object.freeze([窓(0, 100)])
    expect(() => append(windows, 窓(100, 200))).not.toThrow()
    expect(windows).toHaveLength(1)
  })
})

describe('前へ並べる（prepend）', () => {
  it('空の並びには、そのまま1枚目として入る', () => {
    expect(prepend([], 窓(500, 600))).toEqual({ windows: [窓(500, 600)], dropped: null })
  })

  it('継ぎ目が合えば前に並べる', () => {
    expect(prepend([窓(100, 200)], 窓(0, 100))?.windows.map((w) => w.start)).toEqual([0, 100])
  })

  it('継ぎ目が合わない窓は捨てる', () => {
    expect(prepend([窓(100, 200)], 窓(0, 90))).toBeNull()
  })

  it('空の窓は捨てる（行頭へ寄せた先が今の先頭だったとき。同じ頼みを繰り返さない）', () => {
    expect(prepend([窓(100, 200)], 窓(100, 100))).toBeNull()
  })

  it(`${MAX_WINDOWS} 枚を超えたら末尾を1枚落とす`, () => {
    const windows = [窓(100, 200), 窓(200, 300), 窓(300, 400), 窓(400, 500)]
    const got = prepend(windows, 窓(0, 100))
    expect(got?.dropped).toBe('tail')
    expect(got?.windows.map((w) => w.start)).toEqual([0, 100, 200, 300])
  })

  it('元の配列を書き換えない', () => {
    const windows = Object.freeze([窓(100, 200)])
    expect(() => prepend(windows, 窓(0, 100))).not.toThrow()
    expect(windows).toHaveLength(1)
  })
})

describe('見ている位置（position）', () => {
  const windows = [窓(1000, 2000), 窓(2000, 3000)]

  it('窓が無ければ 0', () => {
    expect(position([], 0.5)).toBe(0)
  })

  it('読み込んだ範囲の割合を、その範囲のバイト位置へ写す', () => {
    expect(position(windows, 0)).toBe(1000)
    expect(position(windows, 1)).toBe(3000)
    expect(position(windows, 0.25)).toBe(1500)
  })

  it('範囲外の割合は端へ丸める', () => {
    expect(position(windows, -1)).toBe(1000)
    expect(position(windows, 2)).toBe(3000)
    expect(position(windows, Number.NaN)).toBe(1000)
  })
})

describe('ファイルが変わったか（isChanged）', () => {
  it('印が同じなら変わっていない', () => {
    expect(isChanged('s1', 窓(0, 100, 's1'))).toBe(false)
  })

  it('印が違えば変わった', () => {
    expect(isChanged('s1', 窓(0, 100, 's2'))).toBe(true)
  })
})
