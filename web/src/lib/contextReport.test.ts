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

  it('末尾の3表が3列でも、内訳に混ぜない（レビュー対応 対応9）', () => {
    /*
      **ここが本命。** 文書全体を走査していたので、末尾の表が3列（割合つき）だと
      **MCP ツール78個・カスタムエージェント9個・スキル138個が内訳の絵に並ぶ**——
      畳むどころか、絵のほうが原文より長くなる。要件はあの3表を「既定で畳む」と
      定めているので、絵へ出すのは筋が通らない。

      **これまでの材料の末尾表は2列**（`| Tool | Tokens |`）だったので、
      3列だったら何が起きるかを1度も踏んでいなかった。**実物が何列なのかは、
      まだ誰も確かめていない**（実名を公開リポジトリへ持ち込まない判断のため）。
    */
    const 三列の末尾 = [
      使い具合,
      '',
      '### MCP tools',
      '',
      '| Tool | Tokens | Percentage |',
      '|------|--------|------------|',
      '| example__alpha | 1.2k | 0.1% |',
      '| example__beta | 3.4k | 0.3% |',
      '',
      '### Skills',
      '',
      '| Skill | Tokens | Percentage |',
      '|-------|--------|------------|',
      '| example-skill | 0.5k | 0.1% |',
    ].join('\n')

    const 報告 = readContextReport(三列の末尾)

    expect(報告?.categories.map((c) => c.name)).toEqual([
      'System prompt',
      'System tools',
      'Free space',
    ])
    // **末尾の表の行が1つも混ざっていないこと**
    expect(報告?.categories.some((c) => c.name.startsWith('example'))).toBe(false)
  })

  it('末尾が2列のときは、これまでどおり内訳が読める', () => {
    // 範囲を絞ったせいで、これまで読めていたものが読めなくなっていないこと
    const 二列の末尾 = [使い具合, '', '### MCP tools', '', '| Tool | Tokens |', '|---|---|'].join(
      '\n',
    )
    expect(readContextReport(二列の末尾)?.categories).toHaveLength(3)
  })

  it('内訳の節が無い版でも、合計は出る', () => {
    // **倒れ方は変えていない**——「内訳が無くても合計が読めれば出す」
    const 節が無い = ['## Context Usage', '', '**Tokens:** 241.5k / 1m (24%)'].join('\n')
    const 報告 = readContextReport(節が無い)
    expect(報告?.percent).toBe(24)
    expect(報告?.categories).toEqual([])
  })

  it('分類名が重複していても、鍵が衝突しない材料になっている', () => {
    /*
      範囲を絞ったので、`key={category.name}` の衝突懸念は同時に消えている
      （内訳の節の中で分類名は重複しない）。**節の外に同名の行があっても
      拾わないこと**を、ここで固定する。
    */
    const 同名が外にある = [
      使い具合,
      '',
      '### MCP tools',
      '',
      '| Category | Tokens | Percentage |',
      '|----------|--------|------------|',
      '| System prompt | 9.9k | 9.9% |',
    ].join('\n')

    const 名前 = readContextReport(同名が外にある)?.categories.map((c) => c.name) ?? []
    expect(名前.filter((n) => n === 'System prompt')).toHaveLength(1)
  })

  it('合計が読めなければ null（絵を出さず原文だけにする）', () => {
    // **分類が当たっても中身が読めないこと**はある（claude の版で見出しの字が変わる等）。
    // そのときは絵を出さない——「中身が消えるほうが、生のタグが出るより悪い」の逆で、
    // ここは**絵が出ないだけで原文は全部残る**
    expect(readContextReport('## Context Usage\n\n中身の形が変わりました')).toBeNull()
    expect(readContextReport('')).toBeNull()
  })
})
