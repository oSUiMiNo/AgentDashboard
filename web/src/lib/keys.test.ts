import { SHIFT_ENTER, terminalKeyOverride } from './keys'

/**
 * 端末のキー読み替え。
 *
 * xterm は Shift+Enter を素の Enter と区別せず、どちらも CR を送る。ここが崩れると
 * **改行したいのに送信される**（利用者から見える症状はそれだけなので、押した本人には
 * 原因が分からない）。
 */

/** `KeyboardEvent` のうち、読み替えの判断に使う分だけを組み立てる。 */
function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: 'keydown',
    key: 'Enter',
    shiftKey: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  } as KeyboardEvent
}

describe('terminalKeyOverride', () => {
  it('Shift+Enter は ESC+CR に読み替える', () => {
    // 本物の `/terminal-setup` が VS Code へ書き込む並びと同じ（バイナリから実測）
    expect(terminalKeyOverride(key())).toBe(SHIFT_ENTER)
    expect(SHIFT_ENTER).toBe('\x1b\r')
  })

  it('素の Enter は読み替えない', () => {
    // 送信はそのまま送信のままにする
    expect(terminalKeyOverride(key({ shiftKey: false }))).toBeNull()
  })

  it('他の修飾キーが一緒なら読み替えない', () => {
    // Ctrl+Shift+Enter などは別の意味を持ちうる。奪わない
    expect(terminalKeyOverride(key({ ctrlKey: true }))).toBeNull()
    expect(terminalKeyOverride(key({ altKey: true }))).toBeNull()
    expect(terminalKeyOverride(key({ metaKey: true }))).toBeNull()
  })

  it('keydown 以外は読み替えない', () => {
    // 横取りの口は keypress でも呼ばれる。絞らないと二重に送ってしまう
    expect(terminalKeyOverride(key({ type: 'keypress' }))).toBeNull()
    expect(terminalKeyOverride(key({ type: 'keyup' }))).toBeNull()
  })

  it('IME の変換中は読み替えない', () => {
    // 変換確定の Enter を改行と取り違えない（Composer が見ているのと同じ理由）
    expect(terminalKeyOverride(key({ isComposing: true }))).toBeNull()
  })

  it('Enter 以外のキーは読み替えない', () => {
    expect(terminalKeyOverride(key({ key: 'Tab' }))).toBeNull()
    expect(terminalKeyOverride(key({ key: 'a' }))).toBeNull()
  })
})
