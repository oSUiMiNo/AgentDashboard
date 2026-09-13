import { describe, expect, it } from 'vitest'

import { 字下げする, 字下げを戻す } from './fileIndent'

const 空白2つ = '  '

describe('字下げする', () => {
  it('選択が無ければ、カーソル位置へ差し込んでカーソルを後ろへ置く', () => {
    const 結果 = 字下げする('abc', 1, 1, 空白2つ)
    expect(結果.text).toBe('a  bc')
    expect(結果.start).toBe(3)
    expect(結果.end).toBe(3)
  })

  it('選択があれば、掛かっている全行の行頭へ足す', () => {
    // 「あ」の途中から「い」の途中まで選ぶ
    const 結果 = 字下げする('あ\nい\nう', 0, 3, 空白2つ)
    expect(結果.text).toBe('  あ\n  い\nう')
  })

  it('選択の終端がちょうど行頭なら、その行は含めない', () => {
    // 含めると、1行選んだつもりが次の行まで動く
    const 結果 = 字下げする('あ\nい', 0, 2, 空白2つ)
    expect(結果.text).toBe('  あ\nい')
  })

  it('足したぶんだけ選択を送るので、選んだ範囲が保たれる', () => {
    const 元 = 'あ\nい'
    const 結果 = 字下げする(元, 0, 3, 空白2つ)
    // 2行に足したので、終端は 2×2 ぶん後ろへ
    expect(結果.start).toBe(2)
    expect(結果.end).toBe(3 + 4)
    expect(結果.text.slice(結果.start, 結果.end)).toBe('あ\n  い')
  })

  it('後ろの行から足すので、前の行の長さに影響されない', () => {
    const 結果 = 字下げする('ああああ\nい', 0, 6, 空白2つ)
    expect(結果.text).toBe('  ああああ\n  い')
  })
})

describe('字下げを戻す', () => {
  it('行頭の字下げを1つぶん落とす', () => {
    const 結果 = 字下げを戻す('  abc', 2, 2, 空白2つ)
    expect(結果.text).toBe('abc')
  })

  it('字下げが無い行は変えない', () => {
    // 揃っていない塊を選んだとき、一部だけ左へ寄るとかえって崩れる
    const 結果 = 字下げを戻す('  あ\nい', 0, 4, 空白2つ)
    expect(結果.text).toBe('あ\nい')
  })

  it('1つぶんだけ落とす。深い字下げを全部は消さない', () => {
    const 結果 = 字下げを戻す('      あ', 6, 6, 空白2つ)
    expect(結果.text).toBe('    あ')
  })

  it('落としても選択が行頭より前へ行かない', () => {
    const 結果 = 字下げを戻す('  あ', 0, 0, 空白2つ)
    expect(結果.start).toBeGreaterThanOrEqual(0)
    expect(結果.end).toBeGreaterThanOrEqual(結果.start)
  })

  it('複数行のうち、字下げが在る行だけが動く', () => {
    const 結果 = 字下げを戻す('  あ\nい\n  う', 0, 8, 空白2つ)
    expect(結果.text).toBe('あ\nい\nう')
  })
})
