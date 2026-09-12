import { describe, expect, it } from 'vitest'

import { readContextReport } from './contextReport'

/**
 * `/context` の報告の読み取り（コンテキストの残量 設計§8）。
 *
 * **読み取りは純関数で落とす。** 描画と混ぜると jsdom が矩形を固定で返すので、
 * **何も確かめないまま緑になる**（この PJT が4箇所で採っている型）。
 */
describe('/context の報告を読み取る', () => {
  /** 実物の骨格。**末尾の表は合成**（公開リポジトリへ実名を持ち込まない）。 */
  const 使い具合 = [
    '## Context Usage',
    '',
    '**Model:** claude-opus-5',
    '**Tokens:** 241.5k / 1m (24%)',
    '',
    '### Estimated usage by category',
    '',
    '| Category | Tokens | Percentage |',
    '|----------|--------|------------|',
    '| System prompt | 4.3k | 0.4% |',
    '| System tools | 20.8k | 2.1% |',
    '| Free space | 758.5k | 75.9% |',
  ].join('\n')

  it('合計と使用率が読める', () => {
    const 報告 = readContextReport(使い具合)
    expect(報告?.percent).toBe(24)
    expect(報告?.tokens).toBe('241.5k / 1m')
    expect(報告?.model).toBe('claude-opus-5')
  })

  it('内訳が読める', () => {
    const 報告 = readContextReport(使い具合)
    expect(報告?.categories).toEqual([
      { name: 'System prompt', tokens: '4.3k', percent: 0.4 },
      { name: 'System tools', tokens: '20.8k', percent: 2.1 },
      { name: 'Free space', tokens: '758.5k', percent: 75.9 },
    ])
  })

  it('見出しの行と区切りの行を内訳に混ぜない', () => {
    // `| Category | Tokens | Percentage |` と `|----|----|----|` は数字にならないので落ちる
    const 報告 = readContextReport(使い具合)
    expect(報告?.categories.map((c) => c.name)).not.toContain('Category')
    expect(報告?.categories.every((c) => Number.isFinite(c.percent))).toBe(true)
  })

  it('表が無くても、合計が読めれば出す', () => {
    // **版が変わって表の形が変わっても、いちばん見たい数字は残す**
    const 報告 = readContextReport('## Context Usage\n\n**Tokens:** 12k / 200k (6%)')
    expect(報告?.percent).toBe(6)
    expect(報告?.categories).toEqual([])
  })

  it('モデルの行が無くても読める', () => {
    // 欄が欠けても報告そのものは成り立つ
    expect(readContextReport('**Tokens:** 12k / 200k (6%)')?.model).toBeNull()
  })

  it('合計が読めなければ null（絵を出さず原文だけにする）', () => {
    // **分類が当たっても中身が読めないこと**はある（claude の版で見出しの字が変わる等）。
    // そのときは絵を出さない——「中身が消えるほうが、生のタグが出るより悪い」の逆で、
    // ここは**絵が出ないだけで原文は全部残る**
    expect(readContextReport('## Context Usage\n\n中身の形が変わりました')).toBeNull()
    expect(readContextReport('')).toBeNull()
  })
})
