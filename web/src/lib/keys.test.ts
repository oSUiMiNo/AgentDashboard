/// <reference types="node" />
// `src/` は**ブラウザ向けの型だけ**で検査する（`tsconfig.app.json` の `types` に `node` は
// 入れていない）。入れるとアプリのソースに `fs` を書けてしまうので、緩めずにこのファイル
// だけへ型を足す。**実物の画面を読むのはテストの中だけ**という線を、型でも保つ。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isComposerSubmit,
  isSelectionPrompt,
  NEWLINE,
  SUBMIT,
  terminalKeyOverride,
  type EnterKeyState,
} from './keys'

/**
 * Enter まわりの押し分け。**端末と入力欄で同じ割り当てであること**を両方ここで固定する。
 *
 * Shift+Enter は改行、Ctrl+Enter は送信（利用者の指定）。素の Enter は**画面次第**で、
 * 選択ダイアログが出ていれば確定、そうでなければ改行になる。ここが崩れると
 * **改行したいのに送信される**、あるいは**選択肢を決定できない**という形で出る。
 * どちらも押した本人には原因が分からない。
 */

/** `KeyboardEvent` のうち、読み替えの判断に使う分だけを組み立てる。 */
function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: 'keydown',
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  } as KeyboardEvent
}

/** 画面を渡して読み替える。既定は「選択待ちではない画面」。 */
function override(
  overrides: Partial<KeyboardEvent> = {},
  screen = '',
): string | null {
  return terminalKeyOverride(key(overrides), () => screen)
}

/**
 * フェーズ1 で本物の TUI から採った画面（`make capture-screens`）。
 *
 * **作った文字列だけで固めない。** 手で書いた入力だけでテストすると、実装とテストが
 * 同じ思い込みを共有したまま緑になる（PJTガイドライン）。実物を1回通しておけば、
 * 目印が実際の画面に当たることまで固定できる。
 */
function 実物の画面(name: string): string {
  // **`new URL(…, import.meta.url)` は使えない。** Vite がアセットとして解決しようとし、
  // `fixtures/` は `web/` の外なので `Denied ID` で弾かれる。パスを文字列として
  // 組み立てれば、Vite は介入しない
  const ここ = dirname(fileURLToPath(import.meta.url))
  const path = resolve(ここ, '../../../fixtures/v2.1.228/screens', `${name}.txt`)
  return readFileSync(path, 'utf8')
}

describe('isSelectionPrompt', () => {
  it('本物の選択ダイアログを選択待ちと判定する', () => {
    // 実測（v2.1.228）で採った3種。ここが落ちたら、TUI の見た目が変わっている
    expect(isSelectionPrompt(実物の画面('trust'))).toBe(true)
    expect(isSelectionPrompt(実物の画面('permission'))).toBe(true)
    expect(isSelectionPrompt(実物の画面('rewind'))).toBe(true)
  })

  it('選択待ちでない本物の画面には反応しない', () => {
    // 否定側。**肯定側と対で置く**——判定が丸ごと動いていなくても、否定だけなら通る
    expect(isSelectionPrompt(実物の画面('welcome'))).toBe(false)
    expect(isSelectionPrompt(実物の画面('after-turn'))).toBe(false)
  })

  it('番号つきの選択肢があれば選択待ちと判定する', () => {
    expect(isSelectionPrompt('Do you want to?\n❯ 1. Yes\n  2. No')).toBe(true)
  })

  it('番号を持たないメニューは案内文で拾う', () => {
    // `/rewind` は選択肢に番号を持たない（実測：`❯ (current)`）。形の目印だけでは
    // 取りこぼすので、案内文の目印が要る
    const rewind = '  Rewind\n❯ (current)\n\n  Enter to continue · Esc to cancel'
    expect(rewind).not.toMatch(/\d\./)
    expect(isSelectionPrompt(rewind)).toBe(true)
  })

  it('❯ を含むだけでは選択待ちにしない', () => {
    // 入力欄そのものが `❯ ` で始まり、過去の発言も履歴として `❯ …` で残る（実測）
    expect(isSelectionPrompt('❯ ')).toBe(false)
    expect(isSelectionPrompt('❯ こんにちは')).toBe(false)
    expect(isSelectionPrompt('❯ /exit')).toBe(false)
  })

  it('❯ と番号の間の空白は種類を問わない', () => {
    // 入力欄では NBSP、選択肢では半角空白だった（実測）。どちらでも読めること。
    // **NBSP はエスケープで書く**——生のまま置くと半角空白と見分けが付かず、
    // 「なぜこの2行が別のことを見ているのか」が読めなくなる
    expect(isSelectionPrompt('❯\u00a01. Yes')).toBe(true)
    expect(isSelectionPrompt('❯ 1. Yes')).toBe(true)
    expect(isSelectionPrompt('  ❯   1. Yes')).toBe(true)
  })

  it('案内文は大文字小文字を問わない', () => {
    expect(isSelectionPrompt('Enter to confirm · Esc to cancel')).toBe(true)
    expect(isSelectionPrompt('esc to cancel')).toBe(true)
  })

  it('作業中の esc to interrupt には反応しない', () => {
    // 綴りが違うので当たらない。**当たると打ちかけの文が送信される**側の誤判定になる
    expect(isSelectionPrompt('✻ Churned for 7s (esc to interrupt)')).toBe(false)
  })

  it('空の画面は選択待ちにしない', () => {
    // 購読の直後など、まだ何も描かれていない状態
    expect(isSelectionPrompt('')).toBe(false)
    expect(isSelectionPrompt('\n\n\n')).toBe(false)
  })
})

describe('terminalKeyOverride', () => {
  it('選択待ちでない画面では Enter は改行として送る', () => {
    // 従来の振る舞い。ここが変わると、複数行の指示が打てなくなる
    expect(override()).toBe(NEWLINE)
    expect(override({}, 実物の画面('after-turn'))).toBe(NEWLINE)
  })

  it('選択待ちの画面では Enter は確定として送る', () => {
    // このイシューの主題
    expect(override({}, 実物の画面('permission'))).toBe(SUBMIT)
    expect(override({}, 実物の画面('trust'))).toBe(SUBMIT)
    expect(override({}, 実物の画面('rewind'))).toBe(SUBMIT)
  })

  it('Shift+Enter は素の Enter と同じ扱いになる', () => {
    // xterm は Shift を見ておらず、素の Enter と**同じ CR** を送る。こちらも `shiftKey` を
    // 判断材料に入れていない（見えないものは効かない）ので、意味は画面で決まる。
    //
    // 選択待ちで確定になるのは害にならない——**あの画面には入力欄が無い**ので、
    // そこで改行したい場面が存在しない
    expect(override({ shiftKey: true })).toBe(NEWLINE)
    expect(override({ shiftKey: true }, 実物の画面('permission'))).toBe(SUBMIT)
  })

  it('Ctrl+Enter は画面によらず送信する', () => {
    // 判定が外れたときの逃げ道。ここを画面に依存させてはいけない
    expect(override({ ctrlKey: true })).toBe(SUBMIT)
    expect(override({ ctrlKey: true }, 実物の画面('permission'))).toBe(SUBMIT)
    // Shift が一緒でも、押し分けているのは Ctrl のほう
    expect(override({ ctrlKey: true, shiftKey: true })).toBe(SUBMIT)
  })

  it('改行は ESC+CR、送信は CR', () => {
    // 本物の `/terminal-setup` が VS Code へ書き込む並びと同じ（バイナリから実測）
    expect(NEWLINE).toBe('\x1b\r')
    expect(SUBMIT).toBe('\r')
  })

  it('Alt や Meta が一緒なら読み替えない', () => {
    // Alt+Enter は端末の作法で既に ESC 前置になる。奪うと二重に前置する
    expect(override({ altKey: true })).toBeNull()
    expect(override({ metaKey: true })).toBeNull()
  })

  it('keydown 以外は読み替えない', () => {
    // 横取りの口は keypress でも呼ばれる。絞らないと二重に送ってしまう
    expect(override({ type: 'keypress' })).toBeNull()
    expect(override({ type: 'keyup' })).toBeNull()
  })

  it('IME の変換中は読み替えない', () => {
    // 変換確定の Enter を改行と取り違えない（Composer が見ているのと同じ理由）
    expect(override({ isComposing: true })).toBeNull()
    expect(override({ isComposing: true, ctrlKey: true })).toBeNull()
  })

  it('Enter 以外のキーは読み替えない', () => {
    expect(override({ key: 'Tab' })).toBeNull()
    expect(override({ key: 'a' })).toBeNull()
  })

  it('画面を読むのは素の Enter のときだけ', () => {
    // 横取りの口は**すべてのキー**で呼ばれる。画面（40行×120桁）を毎打鍵で組み立てると
    // 打つたびに無駄が乗るので、答えが画面によらないときは読ませない
    let 読んだ回数 = 0
    const 数える = () => {
      読んだ回数 += 1
      return ''
    }

    terminalKeyOverride(key({ key: 'a' }), 数える)
    terminalKeyOverride(key({ type: 'keyup' }), 数える)
    terminalKeyOverride(key({ isComposing: true }), 数える)
    terminalKeyOverride(key({ altKey: true }), 数える)
    terminalKeyOverride(key({ ctrlKey: true }), 数える)
    expect(読んだ回数).toBe(0)

    terminalKeyOverride(key(), 数える)
    expect(読んだ回数).toBe(1)
  })
})

/** 入力欄が見る分だけを組み立てる。 */
function composerKey(overrides: Partial<EnterKeyState> = {}): EnterKeyState {
  return {
    key: 'Enter',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  }
}

describe('isComposerSubmit', () => {
  it('Ctrl+Enter だけが送信になる', () => {
    expect(isComposerSubmit(composerKey({ ctrlKey: true }))).toBe(true)
  })

  it('素の Enter は送信しない', () => {
    // 入力欄には「選択して決める」場面が無いので、こちらは画面を見ない。
    // 送信の割り当て（Ctrl+Enter）が端末と揃っていることが要点
    expect(isComposerSubmit(composerKey())).toBe(false)
  })

  it('Shift+Enter は判断材料に入っていない（＝送信になりようがない）', () => {
    // Shift の有無は [`EnterKeyState`] に含めていない。見えないものは効かない
    expect(Object.keys(composerKey())).not.toContain('shiftKey')
    expect(isComposerSubmit(composerKey())).toBe(false)
  })

  it('Alt や Meta が一緒なら送信しない', () => {
    // 端末側が読み替えを避ける組み合わせと揃える。片方だけ通ると意味が画面で変わる
    expect(isComposerSubmit(composerKey({ ctrlKey: true, altKey: true }))).toBe(
      false,
    )
    expect(isComposerSubmit(composerKey({ ctrlKey: true, metaKey: true }))).toBe(
      false,
    )
  })

  it('IME の変換中は送信しない', () => {
    // 変換確定の Enter を送信と取り違えない
    expect(
      isComposerSubmit(composerKey({ ctrlKey: true, isComposing: true })),
    ).toBe(false)
  })

  it('Enter 以外のキーは送信しない', () => {
    expect(isComposerSubmit(composerKey({ key: 'Tab', ctrlKey: true }))).toBe(
      false,
    )
    expect(isComposerSubmit(composerKey({ key: 's', ctrlKey: true }))).toBe(
      false,
    )
  })
})
