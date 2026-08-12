import { Terminal } from '@xterm/xterm'
import { visibleScreen } from './screen'

/**
 * 画面の取り出し（テスト計画フェーズ3・設計§5）。
 *
 * Enter を「改行」と「確定」で振り分ける判定は、ここが渡す文字列だけを見る。
 * **スクロールバックを混ぜると、過去のダイアログの残骸に反応してキーを送る**——
 * サーバ側で実測済みの事故で、`Session::scrollback_since` はそれを防ぐために生まれた。
 */
describe('visibleScreen', () => {
  /** 書き込みは非同期なので、処理し終わるまで待つ。 */
  function write(term: Terminal, data: string): Promise<void> {
    return new Promise((resolve) => term.write(data, resolve))
  }

  it('いま見えている行だけを返す（スクロールバックは混ぜない）', async () => {
    const term = new Terminal({ rows: 5, cols: 20, scrollback: 100 })
    // 10行書くと、5行ぶんは画面の外（スクロールバック）へ押し出される
    await write(term, Array.from({ length: 10 }, (_, i) => `行${i}`).join('\r\n'))

    const text = visibleScreen(term)
    const lines = text.split('\n')

    expect(lines).toHaveLength(5)
    // 押し出された古い行は含まない。**ここが混ざると古いダイアログに反応する**
    expect(text).not.toContain('行0')
    expect(text).not.toContain('行4')
    // 見えている側は含む
    expect(text).toContain('行9')
    term.dispose()
  })

  it('行数が画面に満たなくても行が欠けない', async () => {
    const term = new Terminal({ rows: 5, cols: 20, scrollback: 100 })
    await write(term, 'ひとつめ\r\nふたつめ')

    const lines = visibleScreen(term).split('\n')
    // 空行も含めて rows ぶん返る（判定は行頭を見るので、行の位置が動かないほうがよい）
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('ひとつめ')
    expect(lines[1]).toBe('ふたつめ')
    expect(lines[2]).toBe('')
    term.dispose()
  })

  it('右側の余白は落とす', async () => {
    const term = new Terminal({ rows: 3, cols: 20, scrollback: 0 })
    await write(term, '❯ 1. Yes')

    // 判定は行頭を見るので、右の埋めは要らない（あると読みにくいだけ）
    expect(visibleScreen(term).split('\n')[0]).toBe('❯ 1. Yes')
    term.dispose()
  })
})
