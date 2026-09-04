import { Terminal } from '@xterm/xterm'
import { isSelectionPrompt } from './keys'
import { joinWrapped, liveScreen, visibleScreen, type ScreenRow } from './screen'

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

  it('遡っていても、生きている側は端末のいまの姿を返す', async () => {
    // **`visibleScreen` と問いが違う。** あちらは「利用者にいま見えているもの」、
    // こちらは「端末がいまどうなっているか」。**ソフトキーボードを出してよいかは後者で決める**
    // ——遡って過去を読んでいる最中にタップしたとき、前者で判定すると
    // **過去の画面で「打てない」と答え、何度タップしても同じ答えが返って詰む**
    const term = new Terminal({ rows: 5, cols: 20, scrollback: 100 })
    await write(term, Array.from({ length: 10 }, (_, i) => `行${i}`).join('\r\n'))
    term.scrollLines(-5)

    // 見えているのは遡った先。生きているのは末尾
    expect(visibleScreen(term)).toContain('行0')
    expect(visibleScreen(term)).not.toContain('行9')
    expect(liveScreen(term)).toContain('行9')
    expect(liveScreen(term)).not.toContain('行0')
    term.dispose()
  })

  it('遡っていなければ、見えている側と生きている側は同じ', async () => {
    // **常に片方だけを返す実装でも、上の1本だけなら通る。** 対で置く
    const term = new Terminal({ rows: 5, cols: 20, scrollback: 100 })
    await write(term, Array.from({ length: 10 }, (_, i) => `行${i}`).join('\r\n'))

    expect(liveScreen(term)).toBe(visibleScreen(term))
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

  it('折り返した行は1つに繋がって届く', async () => {
    // 幅より長い1行を書くと、xterm は物理行を2つに割って `isWrapped` を立てる。
    // **繋がずに渡すと、案内文が2行に割れて目印に当たらない**
    const term = new Terminal({ rows: 5, cols: 10, scrollback: 0 })
    await write(term, 'あいうえおかきくけこさしすせそ')

    expect(visibleScreen(term).split('\n')[0]).toBe('あいうえおかきくけこさしすせそ')
    term.dispose()
  })
})

/**
 * 繋ぐ判断そのもの（設計§4）。
 *
 * **`visibleScreen` ではなくこちらを試す。** あちらは `Terminal` を要求するので、
 * 幅と折り返しを狙って作るのが難しい。判断だけを純関数へ切り出してあるので、
 * **どこで割れた場合も直接駆動できる**。
 */

/** 物理行を組み立てる。`wrapped` を書かなければ「前の行の続きではない」。 */
function rows(...items: (string | ScreenRow)[]): ScreenRow[] {
  return items.map((item) =>
    typeof item === 'string' ? { text: item, wrapped: false } : item,
  )
}

/** 前の行の続きとして折り返された物理行。 */
function 続き(text: string): ScreenRow {
  return { text, wrapped: true }
}

describe('joinWrapped', () => {
  it('折り返した物理行を1つの論理行へ繋ぐ', () => {
    expect(joinWrapped(rows('  Esc to can', 続き('cel · Tab to amend')))).toEqual([
      '  Esc to cancel · Tab to amend',
    ])
  })

  it('折り返していない行は別の行のまま', () => {
    expect(joinWrapped(rows('一行目', '二行目'))).toEqual(['一行目', '二行目'])
  })

  it('3行以上にまたがる折り返しも1つに繋ぐ', () => {
    expect(joinWrapped(rows('あ', 続き('い'), 続き('う')))).toEqual(['あいう'])
  })

  it('先頭が続きでも、それ自身の行になる', () => {
    // 見えている範囲の上から折り返してきた場合。繋ぐ相手が手元に無いので、
    // **落とさずにそのまま置く**（落とすと、その行の目印が消える）
    expect(joinWrapped(rows(続き('上から続いている'), '次'))).toEqual([
      '上から続いている',
      '次',
    ])
  })

  it('末尾の空行は落とさない', () => {
    // **落とすのは判定の側**（`lib/keys.ts` が窓を切る手前）。ここで落とすと、
    // 「空行も含めて画面の行数ぶん返る」という上の契約が壊れる
    expect(joinWrapped(rows('本文', '', ''))).toEqual(['本文', '', ''])
  })

  it('繋いでから数えるので、折り返した案内文でも判定に当たる', () => {
    // **この1本が、繋ぐ理由そのもの。**
    //
    // **割る位置に意味がある。** `Esc to can` ／ `cel` のように語の途中で割れた場合は、
    // 繋がなくても「`Esc` に続く語がある」ように見えてしまう（`can` を語と読む）。
    // 判定が本当に取りこぼすのは、**キー名と語の間で割れたとき**である
    const 割れた = rows('  本文', '  Esc', 続き(' to cancel'))
    expect(joinWrapped(割れた).join('\n')).toContain('Esc to cancel')
    expect(isSelectionPrompt(joinWrapped(割れた).join('\n'))).toBe(true)

    // 繋がずに並べると当たらない（＝この処理が効いていることの裏返し）
    expect(isSelectionPrompt(割れた.map((row) => row.text).join('\n'))).toBe(false)
  })

  it('繋いだ結果で窓を数える', () => {
    // 物理行で数えると、折り返しで増えたぶん窓が浅くなって取りこぼす。
    // 下の画面は**論理行では3行**なので案内が窓に入るが、物理行では5行ある
    const 折り返しだらけ = rows(
      '  上のほう',
      '  なが',
      続き('い本文'),
      '  Esc to can',
      続き('cel'),
    )
    expect(joinWrapped(折り返しだらけ)).toHaveLength(3)
    expect(isSelectionPrompt(joinWrapped(折り返しだらけ).join('\n'))).toBe(true)
  })
})
