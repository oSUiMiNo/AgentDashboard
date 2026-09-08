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

/**
 * 待ち行列の行の読み分け（設計§16）。
 *
 * **待ちのレコードには名乗る欄が1つも無い**（`content` / `operation` / `type` だけ）。
 * それでも**本文そのものが名乗っている**——機械が積むものは常に包みだけで構成され、
 * 人が打つものは包みを含まない。全 PJT の `enqueue` 36,619件で**混在は0件**だった。
 */
describe('待ちの行の名乗り', () => {
  const 待ち = (text: string): Node => ({ kind: 'queued_message', text, taken: false })

  it('【落とせない】人が積んだ素の文は、人の側に残る', () => {
    // **要件の最優先事項**。ここが反転すると、作業中に送った指示が機械の色になる
    const node = 待ち('notes.md を Read で読み、Edit ツールで1行書き換えてください。')
    expect(originOf(node)).toEqual({ kind: 'unmarked' })
    expect(isMachine(node)).toBe(false)
  })

  it('【落とせない】包みを引用しただけの文は、人の側に残る', () => {
    // 前後に地の文が付くので「丸ごと包み」の線を越えない（設計§4 と同じ規律）
    const node = 待ち(
      'これって何？ <task-notification><status>completed</status></task-notification> と出ています',
    )
    expect(isMachine(node)).toBe(false)
  })

  it('丸ごと包みなら、その種別で名乗る', () => {
    expect(
      originOf(待ち('<task-notification><status>completed</status></task-notification>')),
    ).toEqual({ kind: 'task_notification' })
    expect(originOf(待ち('## 直近の会話履歴（文脈把握用）\n[assistant] やります'))).toEqual({
      kind: 'injected',
    })
    expect(originOf(待ち('Stop hook feedback:\n後処理を行ってください。'))).toEqual({
      kind: 'injected',
    })
    // コマンドの実行結果（`/login` など）。**待ちの器でも同じ側へ落ちる**（設計§18-2）
    expect(
      originOf(待ち('<local-command-stdout>Login successful</local-command-stdout>')),
    ).toEqual({ kind: 'injected' })
  })

  it('他セッションからの連絡は、送り主の名前まで取る', () => {
    const node = 待ち(
      '<cross-session-message from="uds:/tmp/x.sock" from-name="a-54" from-mode="bypass">連絡です</cross-session-message>',
    )
    expect(originOf(node)).toEqual({ kind: 'peer', name: 'a-54' })
    expect(originLabel(originOf(node))).toBe('他セッションから（a-54）')
  })

  it('閉じていない包みは、人の側へ倒れる', () => {
    // **開いた本人で閉じていること**まで見る。壊れた字で機械側へ落とさない
    expect(isMachine(待ち('<task-notification><status>completed</status>'))).toBe(false)
  })

  it('機械と読んだ待ちは、包みを剥がしてから本文にする', () => {
    // **下流は `bodyTextOf` を通る**ので、畳む位置と見えている字がここで揃う
    const node = 待ち('<task-notification><status>completed</status></task-notification>')
    expect(bodyTextOf(node)).not.toContain('<task-notification>')
  })

  it('人と読んだ待ちの本文には、1文字も触らない', () => {
    const 原文 = 'notes.md を読んでください。'
    expect(bodyTextOf(待ち(原文))).toBe(原文)
  })

  it('空の待ちは人の側（判定の材料が無い）', () => {
    expect(isMachine(待ち(''))).toBe(false)
  })
})

/**
 * 切り詰められた待ちが、どちらへ倒れるか（設計§17-5）。
 *
 * **「安全側へ倒れる」と書くなら、実物で通す。** 前提が崩れると主張ごと黙って裏返り、
 * **設計に「安全」と書いてあるぶん次の人はそこを疑わない**（PJT ガイドライン）。
 *
 * パーサは待ちの本文を **64 KiB** で切り詰め、末尾に `…（Nバイトを省略）` を足す
 * （`transcript-parser` の `truncate_text`）。**閉じタグを見る型は、ここで閉じタグを失う。**
 */
describe('切り詰められた待ちの倒れ方（設計§17-5）', () => {
  const 待ち = (text: string): Node => ({ kind: 'queued_message', text, taken: false })
  /** パーサと同じ形に切る——**末尾の付け足しまで真似る**（そこが判定に効く） */
  const 切る = (text: string, max = 64 * 1024): string =>
    text.length <= max ? text : `${text.slice(0, max)}…（${text.length - max}バイトを省略）`

  const 長い通知 = `<task-notification><result>${'あ'.repeat(70 * 1024)}</result></task-notification>`

  it('切る前は機械と読む', () => {
    expect(isMachine(待ち(長い通知))).toBe(true)
  })

  it('切ると閉じタグが落ち、人の側へ倒れる', () => {
    const 切れた = 切る(長い通知)
    expect(切れた.length, '実際に切れていること').toBeLessThan(長い通知.length)
    expect(切れた.endsWith('</task-notification>'), '閉じタグが落ちていること').toBe(false)
    // **ここが「安全側」の実体**——機械が人に見えるだけで、人が機械側へ落ちはしない
    expect(isMachine(待ち(切れた))).toBe(false)
    expect(originOf(待ち(切れた))).toEqual({ kind: 'unmarked' })
  })

  it('切られても本文には触らない（剥がしそこねて中身が消えたりしない）', () => {
    const 切れた = 切る(長い通知)
    expect(bodyTextOf(待ち(切れた))).toBe(切れた)
  })

  it('写しは切られても機械のまま（先頭だけで見分けるため）', () => {
    // **同じ切り詰めでも、型によって効き方が違う**。写しは末尾を見ていない
    const 長い写し = `## 会話履歴\n${'[user] 行\n'.repeat(9000)}`
    const 切れた = 切る(長い写し)
    expect(切れた.length).toBeLessThan(長い写し.length)
    expect(isMachine(待ち(切れた))).toBe(true)
    expect(originOf(待ち(切れた))).toEqual({ kind: 'injected' })
  })
})
