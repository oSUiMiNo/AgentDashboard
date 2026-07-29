import {
  MODELS,
  modelInfo,
  modelLabel,
  modelOptionLabel,
  type ModelAliasSeen,
} from './models'

describe('モデルの別名表', () => {
  it('表の全別名が値から引ける', () => {
    for (const entry of MODELS) {
      expect(modelInfo(entry.value)).toBe(entry)
    }
  })

  it('表に無いモデルでも落ちずにそのまま表示する', () => {
    // モデルは権限モードよりずっと頻繁に増える。union 型にしなかった理由そのもの。
    // 利用者が端末で直接フルIDを打つ場面も、ここを通る
    const info = modelInfo('claude-opus-4-6')
    expect(info.label).toBe('claude-opus-4-6')
    expect(info.description).not.toBe('')
    expect(modelLabel('claude-opus-4-6')).toBe('claude-opus-4-6')
  })

  it('表に版番号が書かれていない', () => {
    // 別名の解決先はプロバイダで変わるので、1つの表に正しい版番号は書けない
    // （設計§3）。版番号は必ず実測から来る
    // 探すのは「系統名のすぐ後ろに付く数字」＝版番号。`Opus（1M）` の 1M や
    // 「100万トークン」はコンテキスト長の話なので、版番号ではない
    const text = MODELS.map((entry) => `${entry.label} ${entry.description}`).join(' ')
    expect(text).not.toMatch(/(Opus|Sonnet|Haiku|Fable|Mythos)\s*\d/)
  })

  it('default はモデル名ではなく指定を消す値として説明される', () => {
    expect(modelInfo('default').description).toContain('既定')
  })
})

describe('いま動いているモデルの表示', () => {
  it('CLI がくれた表示名を優先する', () => {
    // 版番号を持っているのは表示名だけ。値のほうを出すと「Opus 5」ではなく
    // 「claude-opus-5」になってしまう
    expect(modelLabel('claude-opus-5', 'Opus 5')).toBe('Opus 5')
  })

  it('表示名が無ければ値そのものを出す', () => {
    expect(modelLabel('claude-opus-5', null)).toBe('claude-opus-5')
  })

  it('まだ名乗っていないときは「不明」と出す', () => {
    // 空欄にすると「モデルが無い」と読めてしまう
    expect(modelLabel(null, null)).toBe('不明')
  })
})

describe('選択肢への版番号の併記', () => {
  const seen: ModelAliasSeen[] = [
    { alias: 'opus', id: 'claude-opus-5', display_name: 'Opus 5' },
    { alias: 'fable', id: 'claude-fable-5', display_name: 'Fable 5' },
  ]

  it('一度選んだ別名には実測した版番号が付く', () => {
    expect(modelOptionLabel('opus', seen)).toBe('Opus（Opus 5）')
    expect(modelOptionLabel('fable', seen)).toBe('Fable（Fable 5）')
  })

  it('まだ選んでいない別名には何も付かない', () => {
    // 推測で埋めない。この環境でその別名が何に解決されるかを知らないため
    expect(modelOptionLabel('sonnet', seen)).toBe('Sonnet')
    expect(modelOptionLabel('haiku', [])).toBe('Haiku')
  })

  it('別名と表示名が同じなら括弧を付けない', () => {
    // `Sonnet（Sonnet）` のような無意味な括弧を出さない
    const same: ModelAliasSeen[] = [
      { alias: 'sonnet', id: 'claude-sonnet-5', display_name: 'Sonnet' },
    ]
    expect(modelOptionLabel('sonnet', same)).toBe('Sonnet')
  })
})
