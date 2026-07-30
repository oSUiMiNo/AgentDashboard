import {
  isComposerSubmit,
  NEWLINE,
  SUBMIT,
  terminalKeyOverride,
  type EnterKeyState,
} from './keys'

/**
 * Enter まわりの押し分け。**端末と入力欄で同じ割り当てであること**を両方ここで固定する。
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
    // ここが本題。従来は Enter で送信していたので、隣の端末と押し分けが逆になっていた
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
