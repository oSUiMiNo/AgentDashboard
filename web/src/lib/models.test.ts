import {
  MODELS,
  aliasForCurrent,
  modelInfo,
  modelLabel,
  modelOptionLabel,
  type ModelAliasSeen,
  type ModelCatalogEntry,
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

describe('選択肢に出す名前', () => {
  const seen: ModelAliasSeen[] = [
    { alias: 'opus', id: 'claude-opus-5', display_name: 'Opus 5' },
    {
      alias: 'opus[1m]',
      id: 'claude-opus-5[1m]',
      display_name: 'Opus 5 (1M context)',
    },
  ]
  const catalog: ModelCatalogEntry[] = [
    { id: 'claude-opus-4-6', family: 'opus', display_name: 'Opus 4.6' },
    { id: 'claude-opus-5', family: 'opus', display_name: 'Opus 5' },
    { id: 'claude-sonnet-4-6', family: 'sonnet', display_name: 'Sonnet 4.6' },
    { id: 'claude-sonnet-5', family: 'sonnet', display_name: 'Sonnet 5' },
    { id: 'claude-3-5-haiku', family: 'haiku', display_name: 'Haiku 3.5' },
    { id: 'claude-haiku-4-5', family: 'haiku', display_name: 'Haiku 4.5' },
  ]

  it('実測があればそれをそのまま出す', () => {
    // 括弧で併記せず置き換える。`Opus 5` と `Opus 5 (1M context)` の違いが
    // そのまま見分けになる
    expect(modelOptionLabel('opus', seen, catalog)).toBe('Opus 5')
    expect(modelOptionLabel('opus[1m]', seen, catalog)).toBe('Opus 5 (1M context)')
  })

  it('実測が無くても対応表から版番号を出せる', () => {
    // **一度も選んでいない別名にも版番号が出る**（設計§13）。
    // 対応表は CLI 自身から取り出したもので、こちらの表には版番号を持たない
    expect(modelOptionLabel('sonnet', [], catalog)).toBe('Sonnet 5')
    expect(modelOptionLabel('haiku', [], catalog)).toBe('Haiku 4.5')
  })

  it('系統でいちばん新しいものを選ぶ', () => {
    // 並び順ではなく数字で比べる。`claude-3-5-haiku` と `claude-haiku-4-5` のように
    // 桁の並びが違う古い形式が混ざっている
    expect(modelOptionLabel('opus', [], catalog)).toBe('Opus 5')
    expect(modelOptionLabel('haiku', [], catalog)).toBe('Haiku 4.5')
  })

  it('1M 版は対応表に無いので、系統の最新へこちらの印を足す', () => {
    expect(modelOptionLabel('sonnet[1m]', [], catalog)).toBe('Sonnet 5（1M）')
  })

  it('実測は対応表より優先される', () => {
    // 対応表は「別名＝系統の最新」という推測。組織の設定で候補が絞られていれば外れる
    const measured: ModelAliasSeen[] = [
      { alias: 'opus', id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
    ]
    expect(modelOptionLabel('opus', measured, catalog)).toBe('Opus 4.6')
  })

  it('何も分からなければ表のラベルを出す', () => {
    expect(modelOptionLabel('sonnet', [], [])).toBe('Sonnet')
  })

  it('解決先が状況で変わる別名には版番号を出さない', () => {
    // `最良` を `Fable 5` と出すと `Fable` と見分けが付かなくなる。
    // `opusplan` はモードなので、1つのモデル名にすると誤解される
    const meta: ModelAliasSeen[] = [
      { alias: 'best', id: 'claude-fable-5', display_name: 'Fable 5' },
      { alias: 'opusplan', id: 'claude-sonnet-5', display_name: 'Sonnet 5' },
    ]
    expect(modelOptionLabel('best', meta, catalog)).toBe('最良')
    expect(modelOptionLabel('opusplan', meta, catalog)).toBe(
      'プラン=Opus / 実行=Sonnet',
    )
    expect(modelOptionLabel('default', meta, catalog)).toBe('既定')
  })
})

describe('いま動いているモデルに対応する別名', () => {
  const seen: ModelAliasSeen[] = [
    { alias: 'opus', id: 'claude-opus-5', display_name: 'Opus 5' },
    { alias: 'best', id: 'claude-fable-5', display_name: 'Fable 5' },
  ]

  it('実測から引ける', () => {
    expect(aliasForCurrent('claude-opus-5', seen)).toBe('opus')
  })

  it('覚えていなければ引けない', () => {
    expect(aliasForCurrent('claude-haiku-4-5', seen)).toBeNull()
    expect(aliasForCurrent(null, seen)).toBeNull()
  })

  it('状況で変わる別名は候補にしない', () => {
    // `best` と `fable` は同じモデルへ解決されうるので、どちらを指すのか決められない
    expect(aliasForCurrent('claude-fable-5', seen)).toBeNull()
  })
})
