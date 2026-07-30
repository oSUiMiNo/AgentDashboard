import { NEWLINE, SUBMIT, terminalKeyOverride } from './keys'

/**
 * 端末のキー読み替え。
 *
 * Enter・Shift+Enter は改行、Ctrl+Enter は送信（利用者の指定）。ここが崩れると
 * **改行したいのに送信される**、あるいは**送りたいのに送れない**という形で出る。
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

describe('terminalKeyOverride', () => {
  it('Enter は改行として送る', () => {
    // 既定では送信になってしまう。ここが本題
    expect(terminalKeyOverride(key())).toBe(NEWLINE)
  })

  it('Shift+Enter も改行として送る', () => {
    // xterm は Shift を見ておらず、素の Enter と同じ CR を送る
    expect(terminalKeyOverride(key({ shiftKey: true }))).toBe(NEWLINE)
  })

  it('Ctrl+Enter は送信する', () => {
    expect(terminalKeyOverride(key({ ctrlKey: true }))).toBe(SUBMIT)
    // Shift が一緒でも、押し分けているのは Ctrl のほう
    expect(terminalKeyOverride(key({ ctrlKey: true, shiftKey: true }))).toBe(
      SUBMIT,
    )
  })

  it('改行は ESC+CR、送信は CR', () => {
    // 本物の `/terminal-setup` が VS Code へ書き込む並びと同じ（バイナリから実測）
    expect(NEWLINE).toBe('\x1b\r')
    expect(SUBMIT).toBe('\r')
  })

  it('Alt や Meta が一緒なら読み替えない', () => {
    // Alt+Enter は端末の作法で既に ESC 前置になる。奪うと二重に前置する
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
    expect(
      terminalKeyOverride(key({ isComposing: true, ctrlKey: true })),
    ).toBeNull()
  })

  it('Enter 以外のキーは読み替えない', () => {
    expect(terminalKeyOverride(key({ key: 'Tab' }))).toBeNull()
    expect(terminalKeyOverride(key({ key: 'a' }))).toBeNull()
  })
})
