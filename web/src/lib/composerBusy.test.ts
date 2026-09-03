import { afterEach, describe, expect, it } from 'vitest'
import { anyComposerBusy, markComposerBusy } from './composerBusy'

/**
 * 読み直すと消えるものを抱えた入力欄の台帳（テスト計画フェーズ1）。
 *
 * # 取り下げは必ず走らせる
 *
 * 台帳は**モジュールに状態を持つ**（`lib/terminalBridge.ts` と同じ形）。取り下げ忘れが
 * 1つでも残ると、以降のテストが「誰かが抱えている」状態から始まって通ってしまう。
 * `terminalBridge.test.ts` は鍵をテストごとに変えて避けているが、こちらは鍵が札なので
 * **取り下げを控えて `afterEach` で流す**形にする。
 */

const 控え: (() => void)[] = []

/** 取り下げを控えながら申告する。テストの中ではこちらを使う。 */
function 申告する(): () => void {
  const 取り下げ = markComposerBusy()
  控え.push(取り下げ)
  return 取り下げ
}

afterEach(() => {
  for (const 取り下げ of 控え) {
    取り下げ()
  }
  控え.length = 0
})

describe('抱えているかどうか', () => {
  it('何も申告していなければ、抱えていない', () => {
    expect(anyComposerBusy()).toBe(false)
  })

  it('申告すると、抱えていることになる', () => {
    申告する()

    expect(anyComposerBusy()).toBe(true)
  })

  it('取り下げると、抱えていないことに戻る', () => {
    const 取り下げ = 申告する()

    取り下げ()

    expect(anyComposerBusy()).toBe(false)
  })
})

describe('複数の入力欄', () => {
  /**
   * 横並びの画面ではカードの数だけ入力欄が並ぶ（`GroupView`。上限なし）。
   * **1つでも抱えていれば読み直さない**が要件なので、片方を取り下げても残る。
   */
  it('2つ申告して片方だけ取り下げても、まだ抱えている', () => {
    const 取り下げA = 申告する()
    申告する()

    取り下げA()

    expect(anyComposerBusy()).toBe(true)
  })

  /**
   * **札は登録ごとに別物**なので、古い取り下げが新しい登録を巻き添えにしない
   * （`terminalBridge` が `=== ` で本人確認しているのと同じ事故を、鍵の作りで防いでいる）。
   * 二度呼んでも無害であることも、ここで固定する。
   */
  it('同じ取り下げを二度呼んでも、もう一方を巻き添えにしない', () => {
    const 取り下げA = 申告する()
    申告する()

    取り下げA()
    取り下げA()

    expect(anyComposerBusy()).toBe(true)
  })
})
