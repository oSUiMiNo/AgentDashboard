import { describe, expect, it } from 'vitest'

import { 外の印, 外の文言, 外を取る札, 外で何が起きたか } from './memoOutside'
import type { MemoView } from './protocol'

function memo(over: Partial<MemoView> = {}): MemoView {
  return {
    id: 'm-1',
    body: { blocks: [], markdown: 'もとの字' },
    noted_at: 1_700_000_000_000,
    ...over,
  }
}

describe('直している間に外で起きたこと', () => {
  it('何も変わっていなければ黙る', () => {
    expect(外で何が起きたか(memo(), memo())).toBeNull()
  })

  it('配られた一覧から居なくなっていたら「消された」', () => {
    expect(外で何が起きたか(memo(), undefined)).toBe('消された')
  })

  it('本文が違っていたら「書き換わった」', () => {
    const いま = memo({ body: { blocks: [], markdown: '外で直した字' } })
    expect(外で何が起きたか(memo(), いま)).toBe('書き換わった')
  })

  it('かたづけの有無が変わったら、どちら向きかまで名乗る', () => {
    expect(外で何が起きたか(memo(), memo({ checked_at: 1_700_000_001_000 }))).toBe(
      'かたづけられた',
    )
    expect(外で何が起きたか(memo({ checked_at: 1_700_000_001_000 }), memo())).toBe(
      'かたづけを外された',
    )
  })

  it('本文とかたづけが同時に変わったら、踏み潰す側（本文）を名乗る', () => {
    /*
      **順を守らないと、確定して相手の文を消す側が黙る。** かたづけだけなら確定しても
      失われる文は無いが、本文が変わっていれば後勝ちで相手の文が消える。
    */
    const いま = memo({
      body: { blocks: [], markdown: '外で直した字' },
      checked_at: 1_700_000_001_000,
    })
    expect(外で何が起きたか(memo(), いま)).toBe('書き換わった')
  })

  it('消されたことは、ほかのどの変化よりも先に名乗る', () => {
    expect(外で何が起きたか(memo({ checked_at: 1 }), undefined)).toBe('消された')
  })

  it('`noted_at` だけが違っても、本文が同じなら黙る', () => {
    /*
      **時刻で見分けない。** サーバは内容が変わったときだけ時刻を動かす（§7-3）ので、
      時刻を判定材料にすると**本文の比較をしていない実装でも緑になる**。
    */
    expect(外で何が起きたか(memo(), memo({ noted_at: 1_999_999_999_999 }))).toBeNull()
  })
})

describe('知らせを見送るための印', () => {
  it('本文が変われば印も変わる（＝もう一度知らせる）', () => {
    const 一度目 = 外の印(memo({ body: { blocks: [], markdown: '一度目' } }))
    const 二度目 = 外の印(memo({ body: { blocks: [], markdown: '二度目' } }))
    expect(一度目).not.toBe(二度目)
  })

  it('かたづけが変われば印も変わる', () => {
    expect(外の印(memo())).not.toBe(外の印(memo({ checked_at: 1_700_000_001_000 })))
  })

  it('同じ中身なら同じ印（＝見送ったままにする）', () => {
    expect(外の印(memo())).toBe(外の印(memo()))
  })

  it('同じミリ秒に2度直されても見分ける', () => {
    /*
      **`noted_at` を印に使うと、ここが同じ印になって2度目が黙る。**
      本文そのものを印に採っている理由がこれである。
    */
    const 一度目 = 外の印(memo({ body: { blocks: [], markdown: 'あ' }, noted_at: 5 }))
    const 二度目 = 外の印(memo({ body: { blocks: [], markdown: 'い' }, noted_at: 5 }))
    expect(一度目).not.toBe(二度目)
  })

  it('消されたときの印は、居るときのどれとも重ならない', () => {
    expect(外の印(undefined)).not.toBe(外の印(memo()))
  })
})

describe('出す言葉', () => {
  it('4つの変化それぞれに、何が起きたか分かる一言がある', () => {
    for (const 変化 of ['消された', '書き換わった', 'かたづけられた', 'かたづけを外された'] as const) {
      const 字 = 外の文言(変化)
      expect(字, `${変化} の文言が空`).not.toBe('')
      // **「別の画面で」が要る。** 自分がしたことだと読まれると、押す道を選べない
      expect(字).toContain('別の画面で')
    }
  })

  it('消されたときだけ「外の内容を取る」と言わない', () => {
    /*
      取る中身が無いのに「外の内容を取る」と書いてあると、**元に戻ると読む。**
    */
    expect(外を取る札('消された')).not.toContain('外の内容')
    expect(外を取る札('書き換わった')).toBe('外の内容を取る')
    expect(外を取る札('かたづけられた')).toBe('外の内容を取る')
    expect(外を取る札('かたづけを外された')).toBe('外の内容を取る')
  })
})
