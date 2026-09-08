import { describe, expect, it } from 'vitest'
import { stripScrollFor, tabLabels } from '@/lib/fileTabs'

/**
 * タブに出す名前（`サイドバーで開いたファイルを、タブで並べて切り替える` 要件）。
 *
 * **このリポジトリの文書は、同じ名前が別のフォルダに何十枚もある**（`要件.md`・`計画.md`）。
 * ファイル名だけを出すと、`要件.md` が3枚並んでどれがどれか分からなくなる——ここで
 * 守っているのはその1点である。
 */
describe('lib/fileTabs', () => {
  it('衝突していなければ、ファイル名だけ', () => {
    // **全部に親を付けない。** 衝突していない1枚まで長くなり、他のタブを画面の外へ押し出す
    expect(tabLabels(['/a/x/計画.md', '/a/y/設計.md'])).toEqual([
      '計画.md',
      '設計.md',
    ])
  })

  it('衝突したものだけ、親のフォルダが付く', () => {
    expect(
      tabLabels(['/a/x/要件.md', '/a/y/要件.md', '/a/z/計画.md']),
    ).toEqual(['x/要件.md', 'y/要件.md', '計画.md'])
  })

  it('親まで同じなら、区別が付くまで遡る', () => {
    expect(
      tabLabels(['/a/p/doc/要件.md', '/a/q/doc/要件.md']),
    ).toEqual(['p/doc/要件.md', 'q/doc/要件.md'])
  })

  it('渡した並びと同じ長さ・同じ順で返る', () => {
    const paths = ['/a/1.md', '/b/2.md', '/c/3.md']
    const labels = tabLabels(paths)
    expect(labels).toHaveLength(paths.length)
    expect(labels[0]).toContain('1.md')
    expect(labels[2]).toContain('3.md')
  })

  it('同じパスが2つ渡されても終わらなくならない', () => {
    /*
      **伸ばせないものが混ざった組は、そこで止める。** 止めないと伸ばせるものだけが
      伸び続けて**終わらない**——ここは呼ぶ側が重複を作らない約束だが、
      **タブ帯が描けなくなるほうが困る**ので例外にしない
    */
    expect(tabLabels(['/a/要件.md', '/a/要件.md'])).toEqual([
      '要件.md',
      '要件.md',
    ])
  })

  it('1枚だけなら、そのままファイル名', () => {
    expect(tabLabels(['/a/b/c/実行レポート.md'])).toEqual(['実行レポート.md'])
  })

  it('空の並びは空', () => {
    expect(tabLabels([])).toEqual([])
  })
})

/**
 * 選ばれているタブを見えるところまで送る（レビューで見つかった穴・2026-09-08）。
 *
 * **覚えていた並びを復元した直後の送り位置は必ず 0。** タブが8枚もあると選ばれている
 * 1枚が画面の外に居て、**帯に見えているどのタブとも一致しない中身が出ている**ことに
 * なる。**長い並びの復元は、この機能の主役の場面**である。
 */
describe('lib/fileTabs stripScrollFor', () => {
  const 帯 = { 幅: 300, いまの位置: 0 }

  it('既に見えていれば動かさない', () => {
    // 隣のタブへ移るたびに帯が動くと、押した的が毎回ずれる
    expect(stripScrollFor(帯, { 左: 20, 幅: 100 })).toBe(0)
  })

  it('右へはみ出していたら、右端が見えるところまで送る', () => {
    // 復元の主役の場面。選ばれた1枚が右の外に居る
    expect(stripScrollFor(帯, { 左: 500, 幅: 120 })).toBe(500 + 120 - 300)
  })

  it('左へはみ出していたら、左端が見えるところまで戻す', () => {
    expect(stripScrollFor({ 幅: 300, いまの位置: 400 }, { 左: 120, 幅: 100 })).toBe(
      120,
    )
  })

  it('負の位置へは送らない', () => {
    expect(
      stripScrollFor({ 幅: 300, いまの位置: 0 }, { 左: 0, 幅: 1000 }),
    ).toBeGreaterThanOrEqual(0)
  })
})
