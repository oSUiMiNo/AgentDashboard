import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Terminal } from '@xterm/xterm'
import { TERMINAL_OPTIONS, TerminalPane } from './TerminalPane'
import { KIND_PTY_OUTPUT, KIND_PTY_SNAPSHOT } from '@/lib/frame'
import { useWsStore } from '@/stores/ws'

/**
 * WebGL レンダラの取り扱い（テスト計画フェーズ5「TerminalPane」）。
 *
 * GPU コンテキストは、別のタブが GPU を食い潰したときやドライバの再起動で**普通に失われる**。
 * 失ったまま放置すると端末の描画だけが静かに止まり、利用者からは「固まった」ように見える。
 * 落としたら DOM レンダラへ退避して描画を続けることが、ここで守りたい約束。
 *
 * フロー制御の判定そのものは `src/lib/flow.test.ts`、実ブラウザでの発火は E2E が見る。
 */

/** コンテキストロストをテストから起こせる WebGL アドオン。 */
let loseContext: (() => void) | undefined
let disposed = false

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(handler: () => void) {
      loseContext = handler
    }
    dispose() {
      disposed = true
    }
    // xterm 側から呼ばれる最低限の口
    activate() {}
  },
}))

const CARD = '11111111-2222-3333-4444-555555555555'

beforeEach(() => {
  loseContext = undefined
  disposed = false
})

afterEach(() => {
  useWsStore.getState().disconnect()
})

describe('TerminalPane', () => {
  it('WebGL を失ったら DOM レンダラへ退避する', async () => {
    render(<TerminalPane cardId={CARD} />)

    const status = screen.getByTestId('terminal-status')
    await waitFor(() => expect(status).toHaveAttribute('data-renderer', 'webgl'))
    expect(loseContext).toBeDefined()

    // GPU コンテキストが失われた
    loseContext?.()

    await waitFor(() => expect(status).toHaveAttribute('data-renderer', 'dom'))
    expect(disposed).toBe(true)
  })

  // xterm の既定はブロックで、カーソル位置の文字を塗り潰すため上書きモードに見える。
  // WebGL レンダラのカーソルは canvas 描画なので CSS では戻せない。ここが唯一の指定箇所
  it('カーソルは挿入モードに見えるバーにする', () => {
    expect(TERMINAL_OPTIONS.cursorStyle).toBe('bar')
  })
})

/**
 * タッチの結線（テスト計画フェーズ3「結線」）。
 *
 * 判断そのものは `lib/touch.test.ts` が持つ。ここで見るのは**繋がっているか**だけ。
 */
describe('TerminalPane のタッチ', () => {
  function touch(target: HTMLElement, type: string, points: { x: number; y: number }[]) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', {
      value: points.map((point) => ({ clientX: point.x, clientY: point.y })),
    })
    target.dispatchEvent(event)
    return event
  }

  it('touchmove は passive でない購読にすること', () => {
    // **既定（passive）では `preventDefault()` が効かない**ので、なぞりを握れない。
    // DOM からは読めない指定なので、購読のされ方そのものを覗く。
    //
    // 端末の要素は描いている最中に作られるので、**先に prototype を覗いておく**
    // （出来上がってから張り直させることはできない——`cardId` が同じなら効果は再実行されない）
    const calls: { target: EventTarget; type: string; options: unknown }[] = []
    const original = HTMLElement.prototype.addEventListener
    const spy = vi
      .spyOn(HTMLElement.prototype, 'addEventListener')
      .mockImplementation(function (
        this: HTMLElement,
        type: string,
        listener: never,
        options: never,
      ) {
        calls.push({ target: this, type, options })
        return original.call(this, type, listener, options)
      } as never)

    const { container } = render(<TerminalPane cardId={CARD} />)
    spy.mockRestore()

    const pane = container.querySelector('[data-testid="terminal"]') as HTMLElement
    const move = calls.find((call) => call.target === pane && call.type === 'touchmove')
    expect(move).toBeDefined()
    expect(move?.options).toMatchObject({ passive: false })
  })

  it('縦のパンをブラウザから取り上げること', () => {
    // **見た目ではなく、握れるかどうかを決める指定**（設計§3）。
    // 未指定だと1回目に握っても3回目から `cancelable` が落ちる。
    // 横は残すので `none` ではなく `pan-x`
    const { container } = render(<TerminalPane cardId={CARD} />)
    const pane = container.querySelector('[data-testid="terminal"]') as HTMLElement
    expect(pane.style.touchAction).toBe('pan-x')
  })

  it('セルの高さを .xterm-screen から引くこと', async () => {
    // `.xterm` や外側の入れ物を使うと、`FitAddon` の切り捨てぶんの余白が混ざる
    const { container } = render(<TerminalPane cardId={CARD} />)
    const pane = container.querySelector('[data-testid="terminal"]') as HTMLElement
    const term = (pane as HTMLElement & { __terminal?: Terminal }).__terminal
    await waitFor(() => expect(term).toBeDefined())

    const screen = pane.querySelector('.xterm-screen') as HTMLElement
    expect(screen).not.toBeNull()
    // jsdom は寸法を持たないので、実際の値を差し込んでから遡らせる
    Object.defineProperty(screen, 'clientHeight', { value: 15 * term!.rows })
    const scrolled: number[] = []
    vi.spyOn(term!, 'scrollLines').mockImplementation((lines: number) => {
      scrolled.push(lines)
    })
    vi.spyOn(term!.buffer.active, 'viewportY', 'get').mockReturnValue(50)
    vi.spyOn(term!.buffer.active, 'baseY', 'get').mockReturnValue(100)

    touch(pane, 'touchstart', [{ x: 0, y: 0 }])
    touch(pane, 'touchmove', [{ x: 0, y: 60 }])
    // 60px ÷ 15px = 4行。指を下へ動かしたので過去（負）へ
    expect(scrolled).toEqual([-4])
  })

  it('握ったときだけ既定の動きを止めること', async () => {
    const { container } = render(<TerminalPane cardId={CARD} />)
    const pane = container.querySelector('[data-testid="terminal"]') as HTMLElement
    const term = (pane as HTMLElement & { __terminal?: Terminal }).__terminal
    await waitFor(() => expect(term).toBeDefined())

    // 下端に居るので、未来（上へなぞる）へは行けない
    vi.spyOn(term!.buffer.active, 'viewportY', 'get').mockReturnValue(100)
    vi.spyOn(term!.buffer.active, 'baseY', 'get').mockReturnValue(100)

    touch(pane, 'touchstart', [{ x: 0, y: 100 }])
    const blocked = touch(pane, 'touchmove', [{ x: 0, y: 40 }])
    expect(blocked.defaultPrevented).toBe(false)

    // 過去へは行けるので、そちらは握る
    touch(pane, 'touchend', [])
    touch(pane, 'touchstart', [{ x: 0, y: 0 }])
    const grabbed = touch(pane, 'touchmove', [{ x: 0, y: 60 }])
    expect(grabbed.defaultPrevented).toBe(true)
  })

  it('既定ではタッチの数字を出さないこと', async () => {
    // 実機から読む口（`?touchdebug=1`）は**普段の画面を1ピクセルも変えない**。
    // 入れ物だけは常に置いてあるので、「空であること」で見る（`empty:hidden`）
    render(<TerminalPane cardId={CARD} />)
    const readout = screen.getByTestId('terminal-touch-debug')
    await waitFor(() => expect(screen.getByTestId('terminal')).toBeInTheDocument())
    fireEvent.touchStart(screen.getByTestId('terminal'), {
      touches: [{ clientX: 10, clientY: 10 }],
    })
    expect(readout.textContent).toBe('')
  })

  it('端末を捨てるときに購読を外すこと', async () => {
    const { container, unmount } = render(<TerminalPane cardId={CARD} />)
    const pane = container.querySelector('[data-testid="terminal"]') as HTMLElement
    await waitFor(() =>
      expect((pane as HTMLElement & { __terminal?: Terminal }).__terminal).toBeDefined(),
    )
    const removed: string[] = []
    vi.spyOn(pane, 'removeEventListener').mockImplementation((type: string) => {
      removed.push(type)
    })

    unmount()

    expect(removed).toEqual(
      expect.arrayContaining(['touchstart', 'touchmove', 'touchend', 'touchcancel']),
    )
  })
})

/**
 * 作り直されたときの遡り位置（テスト計画フェーズ3「遡り位置の保持」・設計§9）。
 *
 * リモートの全画面フレームは `term.reset()` を伴うので、遡って読んでいる最中に来ると
 * 下端へ飛ぶ。スマホではソフトキーボードの開閉や向きの変更で画面の大きさが変わり、
 * そのたびに全画面フレームが届くので**実際に踏む**。
 */
describe('TerminalPane の遡り位置', () => {
  const PAYLOAD = new TextEncoder().encode('x')

  /**
   * 端末を描いて、サーバからのフレームを流し込む口を返す。
   *
   * `TerminalPane` は `useWsStore.getState().subscribeTerminal(...)` で受け取り口を
   * 渡すだけなので、ストアを差し替えればその口をこちらで掴める。**描き終えたら
   * すぐ戻す**——偽物を残すと、以後のテストが本物の購読を通らなくなる。
   */
  async function renderPane() {
    let deliver: ((kind: number, payload: Uint8Array) => void) | undefined
    const original = useWsStore.getState().subscribeTerminal
    useWsStore.setState({
      subscribeTerminal: (_cardId, _cols, _rows, listener) => {
        deliver = listener
        return () => {}
      },
    })
    const { container } = render(<TerminalPane cardId={CARD} />)
    useWsStore.setState({ subscribeTerminal: original })

    const pane = container.querySelector('[data-testid="terminal"]') as HTMLElement
    const term = (pane as HTMLElement & { __terminal?: Terminal }).__terminal
    await waitFor(() => expect(term).toBeDefined())
    expect(deliver).toBeDefined()
    return { term: term as Terminal, deliver: deliver as NonNullable<typeof deliver> }
  }

  /**
   * 「いま N 行ぶん遡っている」状態を作る。
   *
   * **作り直しで遡っていた位置が消えることまで真似る。** これが要点で、控えるのが
   * `term.reset()` の**あと**の実装だと、読む値が 0 になって復元しなくなる——
   * つまりこの仕掛けが「前に控えているか」を実際に測っている。
   *
   * 本物の `reset()` は呼ばない。ここで確かめたいのは控える順序であって、
   * バッファが本当に空になることではない（呼ぶと `buffer.active` ごと入れ替わり、
   * 差し込んだ値が効かなくなる）。
   */
  function scrolledBack(term: Terminal, distance: number) {
    const bottom = 200
    let position = { viewportY: bottom - distance, baseY: bottom }
    vi.spyOn(term.buffer.active, 'viewportY', 'get').mockImplementation(
      () => position.viewportY,
    )
    vi.spyOn(term.buffer.active, 'baseY', 'get').mockImplementation(() => position.baseY)
    const reset = vi.spyOn(term, 'reset').mockImplementation(() => {
      position = { viewportY: 0, baseY: 0 }
    })
    const scrolled: number[] = []
    vi.spyOn(term, 'scrollLines').mockImplementation((lines: number) => {
      scrolled.push(lines)
    })
    return { scrolled, reset }
  }

  it('作り直しの前に、遡っていた位置を控えること', async () => {
    const { term, deliver } = await renderPane()
    const { scrolled } = scrolledBack(term, 50)

    deliver(KIND_PTY_SNAPSHOT, PAYLOAD)

    // 50行ぶん遡っていたので、書き直したあと同じだけ戻る
    await waitFor(() => expect(scrolled).toEqual([-50]))
  })

  it('戻すのは書き終えたコールバックの中であること', async () => {
    const { term, deliver } = await renderPane()
    const { scrolled } = scrolledBack(term, 50)

    deliver(KIND_PTY_SNAPSHOT, PAYLOAD)

    // `term.write` は非同期。呼んだ直後にはまだバッファが作り直されていないので、
    // ここで戻すと**作り直される前の画面**を掴んで飛ぶ
    expect(scrolled).toEqual([])
    await waitFor(() => expect(scrolled).toEqual([-50]))
  })

  it('下端に居たときは何もしないこと', async () => {
    const { term, deliver } = await renderPane()
    const { scrolled, reset } = scrolledBack(term, 0)

    deliver(KIND_PTY_SNAPSHOT, PAYLOAD)

    // 作り直し自体は起きる。起きたうえで戻さない、が「ふだんの見え方を変えない」
    await waitFor(() => expect(reset).toHaveBeenCalled())
    expect(scrolled).toEqual([])
  })

  it('差分のフレームでは作り直しも復元もしないこと', async () => {
    const { term, deliver } = await renderPane()
    const { scrolled, reset } = scrolledBack(term, 50)

    deliver(KIND_PTY_OUTPUT, PAYLOAD)

    // 差分は書き足すだけ。ここで戻すと、遡っていない人まで毎フレーム動かすことになる
    await waitFor(() => expect(term.buffer.active).toBeDefined())
    expect(reset).not.toHaveBeenCalled()
    expect(scrolled).toEqual([])
  })
})
