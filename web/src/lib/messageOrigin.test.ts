import { describe, expect, it } from 'vitest'
import type { Node } from '@/lib/protocol'
import {
  bodyTextOf,
  isApiError,
  isCancelled,
  isMachine,
  originLabel,
  originOf,
} from '@/lib/messageOrigin'

/**
 * 誰が入れたかの読み分け
 * （`人が打っていないものを、人の発言として出さない` 設計§1・§6）。
 *
 * **判断はここで、描くのは部品。** 文言と倒れ方をこちらで固定しておくと、
 * 画面側は「配線されているか」だけを見れば済む。
 */
describe('名乗り', () => {
  it('欄が来なくても落ちず、名乗り無しとして受ける', () => {
    // **古いサーバに新しい画面が繋がる形が実在する**（`version restart` で版を戻したとき）
    const 欄が無い = { kind: 'user_message', text: '前の版の発言' } as Node
    expect(originOf(欄が無い)).toEqual({ kind: 'unmarked' })
    expect(isMachine(欄が無い)).toBe(false)
  })

  it('印が無いものと人は、どちらも人の側', () => {
    // **ここを反転させると、人が打った `/clear` が琥珀になる**（設計§1-3）
    expect(isMachine({ kind: 'user_message', text: 'x', origin: { kind: 'unmarked' } })).toBe(false)
    expect(isMachine({ kind: 'user_message', text: 'x', origin: { kind: 'human' } })).toBe(false)
  })

  it('名乗ったものは機械の側', () => {
    const 機械: Node[] = [
      { kind: 'user_message', text: 'x', origin: { kind: 'peer', name: null } },
      { kind: 'user_message', text: 'x', origin: { kind: 'task_notification' } },
      { kind: 'user_message', text: 'x', origin: { kind: 'injected' } },
      { kind: 'user_message', text: 'x', origin: { kind: 'compact_summary' } },
      { kind: 'user_message', text: 'x', origin: { kind: 'sdk' } },
      { kind: 'user_message', text: 'x', origin: { kind: 'subagent_prompt' } },
      { kind: 'user_message', text: 'x', origin: { kind: 'interrupted' } },
      { kind: 'user_message', text: 'x', origin: { kind: 'other', name: 'coordinator' } },
    ]
    for (const node of 機械) {
      expect(isMachine(node)).toBe(true)
    }
  })

  it('種類ごとに違う言葉で名乗る', () => {
    // **1つに束ねない**（利用者の指定）。開かないと出どころが分からない状態にしない
    expect(originLabel({ kind: 'peer', name: 'sample-peer-session' })).toBe(
      '他セッションから（sample-peer-session）',
    )
    expect(originLabel({ kind: 'peer', name: null })).toBe('他セッションから')
    expect(originLabel({ kind: 'task_notification' })).toBe('サブエージェントの報告')
    expect(originLabel({ kind: 'injected' })).toBe('差し込まれた文')
    expect(originLabel({ kind: 'compact_summary' })).toBe('圧縮された要約')
    expect(originLabel({ kind: 'sdk' })).toBe('起動時に渡された指示')
    expect(originLabel({ kind: 'subagent_prompt' })).toBe('サブエージェントへの指示')
    expect(originLabel({ kind: 'interrupted' })).toBe('中断（人が止めた印）')
  })

  it('知らない名乗りは、名前をそのまま出す', () => {
    // 丸めると**記録が名乗ったことを捨てる**ことになる（設計§2-3）
    expect(originLabel({ kind: 'other', name: 'coordinator' })).toBe('coordinator')
  })

  it('人と名乗り無しは、名乗りを出さない', () => {
    expect(originLabel({ kind: 'human' })).toBe('')
    expect(originLabel({ kind: 'unmarked' })).toBe('')
  })
})

describe('本文の組み立て', () => {
  it('打った形は本文に入らない——展開だけが本文になる', () => {
    // **§6-8 を覆した**（設計§11-4）。打った形は押せる部品として別に描くので、
    // 本文にも入れると同じ字が2つ並ぶ
    const node: Node = {
      kind: 'user_message',
      text: '/x 引数',
      origin: { kind: 'human' },
      command: { typed: '/x 引数', expansion: '中身' },
    }
    expect(bodyTextOf(node)).toBe('中身')
  })

  it('展開が無ければ本文は空になる', () => {
    // **展開が無いほうが多数派である**（実測67%。設計§3-4）。打った形は
    // `SlashCommandLine` が描くので、本文が空でも画面から消えない
    const node: Node = {
      kind: 'user_message',
      text: '/clear',
      origin: { kind: 'human' },
      command: { typed: '/clear', expansion: null },
    }
    expect(bodyTextOf(node)).toBe('')
  })

  it('コマンドでない発言は、本文がそのまま出る', () => {
    // **`command` が無い側を巻き込まない**（この直しで壊しやすいのはこちら）
    const node: Node = { kind: 'user_message', text: 'ただの指示', origin: { kind: 'human' } }
    expect(bodyTextOf(node)).toBe('ただの指示')
  })
})

/**
 * API のエラーの見分け（設計§14-1）。
 *
 * **この組でいちばん大事なのは2本目**——`No response requested.` は印を持たない
 * ただの短い返事で、`Request timed out` と**画面上まったく同じ姿**で並ぶ。
 * 字面で見分ける実装に変えると、ここだけが落ちる。
 */
describe('APIのエラーの見分け', () => {
  it('記録が名乗ったものはエラーになる', () => {
    const node: Node = { kind: 'assistant_text', text: 'Request timed out', error: true }
    expect(isApiError(node)).toBe(true)
  })

  it('印を持たない短い返事はエラーにしない', () => {
    // **落とせない1本。** 見た目が同じで、違うのは欄だけである
    const node: Node = { kind: 'assistant_text', text: 'No response requested.', error: false }
    expect(isApiError(node)).toBe(false)
  })

  it('エラーらしい字でも、印が無ければエラーにしない', () => {
    // 利用者が同じ字を引用しただけのものを赤くしないための門（設計§1-4 と同じ形）
    const node: Node = { kind: 'assistant_text', text: 'API Error: 529 Overloaded' }
    expect(isApiError(node)).toBe(false)
  })

  it('欄が来ない古いサーバでもエラーでない側へ倒れる', () => {
    // 版を戻すと、この欄を知らないサーバに新しい画面が繋がる（設計§2-5）
    const node = { kind: 'assistant_text', text: 'Request timed out' } as Node
    expect(isApiError(node)).toBe(false)
  })

  it('アシスタント以外の行はエラーにならない', () => {
    // 印は `assistant_text` にしか付かない（実測で `type` は全部 assistant）
    const node: Node = { kind: 'user_message', text: 'Request timed out', origin: { kind: 'human' } }
    expect(isApiError(node)).toBe(false)
  })
})

/** 読まれる前の取り消し（設計§15）。判定はパーサ側で済んでおり、ここは印を読むだけ。 */
describe('読まれる前の取り消し', () => {
  it('印が立っていれば取り消しとして読む', () => {
    const node: Node = {
      kind: 'user_message',
      text: 'やっぱりやめる',
      origin: { kind: 'human' },
      cancelled: true,
    }
    expect(isCancelled(node)).toBe(true)
  })

  it('印が無ければ取り消しではない', () => {
    const node: Node = { kind: 'user_message', text: 'やって', origin: { kind: 'human' } }
    expect(isCancelled(node)).toBe(false)
  })

  it('アシスタントの本文は取り消しにならない', () => {
    const node: Node = { kind: 'assistant_text', text: 'やります' }
    expect(isCancelled(node)).toBe(false)
  })
})
