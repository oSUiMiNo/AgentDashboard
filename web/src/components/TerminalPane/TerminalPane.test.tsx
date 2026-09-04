import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { IBufferLine, Terminal } from '@xterm/xterm'
import { TERMINAL_GRID, TERMINAL_OPTIONS, TerminalPane } from './TerminalPane'
import { KIND_PTY_OUTPUT, KIND_PTY_SNAPSHOT } from '@/lib/frame'
import { hasKeyboard, openKeyboard } from '@/lib/terminalBridge'
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

/**
 * 描き終わった端末を返す。**待つものは、待つたびに読み直す。**
 *
 * `const term = …__terminal` を先に読んでから `waitFor(() => expect(term)…)` と書くと、
 * **閉じ込めた値は二度と変わらない**ので、待ち合わせではなく「同じ断言を5秒繰り返して
 * 落ちる」だけになる。いま通っているのは `render` が `act` の中で効果を流し切っている
 * からで、**その見張りは何も見ていない**。
 */
async function 描かれた端末(box: HTMLElement): Promise<Terminal> {
  await waitFor(() =>
    expect((box as HTMLElement & { __terminal?: Terminal }).__terminal).toBeDefined(),
  )
  return (box as HTMLElement & { __terminal?: Terminal }).__terminal as Terminal
}

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

  // 遡りはサーバのリングバッファとは別物。画面内で遡るぶんを控えめに確保している
  it('xterm 側の遡りは持ったままにする', () => {
    expect(TERMINAL_OPTIONS.scrollback).toBe(5000)
  })
})

/**
 * 格子の固定（設計§2・§4-1）。
 *
 * **入れ物の寸法から桁行を決めるのをやめた**ので、見ている端末によって形が変わらない。
 * jsdom はレイアウトを持たず要素の大きさが常に 0 なので、**入れ物から決めていれば
 * この値にはならない**——ここが「決めていない」ことの担保になる。
 */
describe('TerminalPane の格子', () => {
  it('文字を 0.8倍（10px）にすること', () => {
    // 実機で読めなければ戻す。**動かすのはこの数字1つ**（設定にはしない）
    expect(TERMINAL_OPTIONS.fontSize).toBe(10)
  })

  it('格子は 120桁×40行に固定すること', () => {
    // 録画・画面のゴールデン・CLI の `session screen` の既定と同じ大きさ
    expect(TERMINAL_GRID).toEqual({ cols: 120, rows: 40 })
  })

  it('描いた端末が 120桁×40行であること', async () => {
    const { container } = render(<TerminalPane cardId={CARD} />)
    const pane = container.querySelector('[data-testid="terminal"]') as HTMLElement
    // **待つものはコールバックの中で読む。** 外で `const` に閉じ込めると、値は
    // 二度と変わらないので「同じ断言を5秒繰り返して落ちる」だけになる
    const 端末 = await 描かれた端末(pane)

    expect({ cols: 端末.cols, rows: 端末.rows }).toEqual({ cols: 120, rows: 40 })
  })

  it('購読の1通目から 120桁×40行で頼むこと', async () => {
    // **ここが 80×24 だと、開いた瞬間に CLI がその大きさで描く。** 実測でそうなっていた
    // （タブを切り替えるまで 80桁のままだった）
    let asked: { cols: number; rows: number } | undefined
    const original = useWsStore.getState().subscribeTerminal
    // **戻すのは `finally` で。** 描く途中で落ちると偽物が残り、以後のテストが
    // **何も届かない購読**を掴んだまま走る——1件の失敗が連鎖に化ける
    try {
      useWsStore.setState({
        subscribeTerminal: (_cardId, cols, rows) => {
          asked = { cols, rows }
          return () => {}
        },
      })
      render(<TerminalPane cardId={CARD} />)
    } finally {
      useWsStore.setState({ subscribeTerminal: original })
    }

    await waitFor(() => expect(asked).toBeDefined())
    expect(asked).toEqual({ cols: 120, rows: 40 })
  })

  it('入れ物の大きさを見張らないこと', async () => {
    // 見張ると、そこから桁行を決め直す道が戻る。**張っていないことで見る**
    const observed: unknown[] = []
    const original = globalThis.ResizeObserver
    // **戻すのは `finally` で**（上と同じ理由）。無効化された見張りが残ると、
    // 以後のテストは大きさの変化を一度も受け取らないまま走る
    try {
      globalThis.ResizeObserver = class {
        constructor(callback: ResizeObserverCallback) {
          observed.push(callback)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver

      const { container } = render(<TerminalPane cardId={CARD} />)
      const pane = container.querySelector('[data-testid="terminal"]') as HTMLElement
      await 描かれた端末(pane)
    } finally {
      globalThis.ResizeObserver = original
    }

    expect(observed).toEqual([])
  })
})

/**
 * 入れ物を「窓」にする（設計§3）。
 *
 * 桁行を固定したので、入れ物のほうが狭ければはみ出す。**横はスクロールで読み、
 * 縦は切り落とす。切り落とすのは常に上側**（読みたいものは必ず下にある）。
 *
 * jsdom は CSS を読まないので、Tailwind のクラス名では効き目も綴り違いも捕まえられない。
 * だから指定は素のスタイルで書いてあり、ここではその値を直接読む。
 */
describe('TerminalPane の窓', () => {
  function pane() {
    const { container } = render(<TerminalPane cardId={CARD} />)
    return container.querySelector('[data-testid="terminal"]') as HTMLElement
  }

  it('横へはみ出したぶんはスクロールで読ませること', () => {
    expect(pane().style.overflowX).toBe('auto')
  })

  it('縦へはみ出したぶんは切り落とすこと', () => {
    expect(pane().style.overflowY).toBe('hidden')
  })

  it('格子を下端へ貼り付けること', () => {
    // 上下が逆だと、読みたい末尾（選択肢・プロンプト）のほうが切り落とされる
    const box = pane()
    expect(box.style.display).toBe('grid')
    expect(box.style.alignContent).toBe('end')
  })

  it('格子が縮まないことを指定で言い切ること', async () => {
    // 縮んだときの症状は「右端が消える」ではなく**「行が折り返す」**なので、
    // TUI の描画が壊れたように見える。原因が CSS だと気づくまでが遠い
    const box = pane()
    await waitFor(() =>
      expect((box as HTMLElement & { __terminal?: Terminal }).__terminal).toBeDefined(),
    )
    const grid = box.querySelector('.xterm') as HTMLElement
    expect(grid.style.minWidth).toBe('max-content')
  })

})

/**
 * 指の出来事を1つ起こす。**焦点の検査（上の describe）からも使う**ので、
 * どちらか一方の中に閉じ込めない。
 */
function touch(target: HTMLElement, type: string, points: { x: number; y: number }[]) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: points.map((point) => ({ clientX: point.x, clientY: point.y })),
  })
  target.dispatchEvent(event)
  return event
}

/**
 * 焦点をいつ渡すか（設計§14-3・§14-9）。
 *
 * 格子より入れ物が大きいと、上に地の色の余白ができる（設計§3-4）。**見た目は端末の
 * 一部**なので普通に押されるが、そこは `.xterm` の外なので xterm は拾わない——
 * だから入れ物の側で渡している。
 *
 * **ただしタッチは別。** `pointerdown` はタップとなぞりを区別しないので、そのまま
 * 渡すと**遡ろうとなぞるたびにソフトキーボードが出る**（実測で再現した回帰）。
 * タッチは離すまで待ち、**触った場所を見てから**決める（設計§13。担保は
 * 「TerminalPane の触った場所」）。
 */
describe('TerminalPane の焦点', () => {
  async function 端末(container: HTMLElement) {
    const box = container.querySelector('[data-testid="terminal"]') as HTMLElement
    const term = await 描かれた端末(box)
    return { box, term, focus: vi.spyOn(term, 'focus') }
  }

  it('マウスで押したときは焦点を渡すこと', async () => {
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, focus } = await 端末(container)

    fireEvent.pointerDown(box, { pointerType: 'mouse', button: 0 })

    expect(focus).toHaveBeenCalled()
  })

  it('主ボタン以外では渡さないこと', async () => {
    // 右クリックで焦点が動くと、打ちかけの文がある入力欄から奪うことになる
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, focus } = await 端末(container)

    fireEvent.pointerDown(box, { pointerType: 'mouse', button: 2 })

    expect(focus).not.toHaveBeenCalled()
  })

  it('指でなぞったときは渡さないこと', async () => {
    // **これが回帰の本体。** 渡すとスマホでソフトキーボードが出て、画面が半分隠れる
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, term, focus } = await 端末(container)
    // 過去へ遡る余地がある＝握れる状態にする
    vi.spyOn(term.buffer.active, 'viewportY', 'get').mockReturnValue(50)
    vi.spyOn(term.buffer.active, 'baseY', 'get').mockReturnValue(100)

    fireEvent.pointerDown(box, { pointerType: 'touch', button: 0 })
    touch(box, 'touchstart', [{ x: 0, y: 0 }])
    touch(box, 'touchmove', [{ x: 0, y: 60 }])
    touch(box, 'touchend', [])

    expect(focus).not.toHaveBeenCalled()
  })

  it('入力欄の外をタップしても渡さないこと', async () => {
    // ログの部分を押しただけで焦点が来ると、**カーソルが出てキーボードも開く**
    // ——読んでいるだけのときに画面が半分隠れる（設計§13）。
    // **入力欄を押したときに渡ること**は「TerminalPane の触った場所」が見張る
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, term } = await 端末(container)
    // マウント時の初期フォーカスは数えない。**タップのぶんだけを見る**
    const focus = vi.spyOn(term, 'focus')

    fireEvent.pointerDown(box, { pointerType: 'touch', button: 0 })
    touch(box, 'touchstart', [{ x: 0, y: 0 }])
    touch(box, 'touchend', [])

    expect(focus).not.toHaveBeenCalled()
  })
})

describe('TerminalPane のタッチ', () => {
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
    // `.xterm` や外側の入れ物を使うと、**格子より入れ物が大きいぶんの余白**が混ざる
    // （設計§3-4。窓は格子より広くなりうる）
    const { container } = render(<TerminalPane cardId={CARD} />)
    const pane = container.querySelector('[data-testid="terminal"]') as HTMLElement
    const term = await 描かれた端末(pane)

    const screen = pane.querySelector('.xterm-screen') as HTMLElement
    expect(screen).not.toBeNull()
    // jsdom は寸法を持たないので、実際の値を差し込んでから遡らせる
    Object.defineProperty(screen, 'clientHeight', { value: 15 * term.rows })
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
    const term = await 描かれた端末(pane)

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
    // **戻すのは `finally` で。** 描く途中で落ちると偽物が残り、以後のテストが
    // 本物の購読を通らなくなる
    let container: HTMLElement
    try {
      useWsStore.setState({
        subscribeTerminal: (_cardId, _cols, _rows, listener) => {
          deliver = listener
          return () => {}
        },
      })
      container = render(<TerminalPane cardId={CARD} />).container
    } finally {
      useWsStore.setState({ subscribeTerminal: original })
    }

    const pane = container.querySelector('[data-testid="terminal"]') as HTMLElement
    const term = await 描かれた端末(pane)
    expect(deliver).toBeDefined()
    return { term, deliver: deliver as NonNullable<typeof deliver> }
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

/**
 * 触った場所で入力可能を入り／抜けする（設計§13）。
 *
 * **ここは測る側の担保である。** 「入力欄が何行目にあるか」を決めるのは純関数
 * （`lib/keys.ts` の `inputBoxRows`）で、そちらは実物のゴールデン15枚で見張ってある。
 * こちらが確かめるのは、**触った高さを行に直す計算と、その行をどう使うか**の2つ。
 *
 * # jsdom は寸法を持たない
 *
 * だから `.xterm-screen` の高さと位置を差し込んでから触らせる。差し込まずに書くと
 * 行はいつも `null` になり、**何を壊しても緑のまま**になる（`lib/reorder.ts` と
 * `lib/useReorder.ts` を分けてあるのと同じ理由）。
 */
describe('TerminalPane の触った場所', () => {
  /** 1行の高さ（px）。差し込む値で、実測値ではない。 */
  const CELL = 15
  /** 枠を 30〜32 行目に置いた画面。31行目が打つところ。 */
  const 枠のある画面 = [
    ...Array.from({ length: 30 }, (_, i) => `ログ${i}`),
    '─'.repeat(60),
    '❯ ',
    '─'.repeat(60),
  ]

  /** その行の真ん中の高さ。 */
  function 行の高さ(row: number, 上端 = 0): number {
    return 上端 + row * CELL + CELL / 2
  }

  async function 端末と隠し欄(container: HTMLElement) {
    const box = container.querySelector('[data-testid="terminal"]') as HTMLElement
    const term = await 描かれた端末(box)
    return { box, term, helper: term.textarea as HTMLTextAreaElement }
  }

  /** 可視領域を、この行の並びに見せかける。 */
  function 画面を(term: Terminal, rows: string[]) {
    vi.spyOn(term.buffer.active, 'getLine').mockImplementation(
      (y: number) =>
        ({
          translateToString: () => rows[y] ?? '',
          isWrapped: false,
        }) as unknown as IBufferLine,
    )
  }

  /** `.xterm-screen` の高さと位置を差し込む。**jsdom はどちらも 0 を返す。** */
  function 寸法を(box: HTMLElement, term: Terminal, 上端 = 0) {
    const screen = box.querySelector('.xterm-screen') as HTMLElement
    Object.defineProperty(screen, 'clientHeight', {
      value: CELL * term.rows,
      configurable: true,
    })
    vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue({
      top: 上端,
    } as DOMRect)
    return screen
  }

  /** 打てる状態から始める（外れたことを見たいので、先に入れておく）。 */
  function 入力可能にしておく(helper: HTMLTextAreaElement) {
    helper.focus()
    helper.inputMode = 'text'
  }

  it('入力欄の枠をタップしたら、入力可能にすること', async () => {
    // **これが問題1の受け皿。** 入力欄そのものを押しても何も起きなかった
    // （利用者の観測・2026-09-05）
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, term, helper } = await 端末と隠し欄(container)
    画面を(term, 枠のある画面)
    寸法を(box, term)
    const focus = vi.spyOn(helper, 'focus')

    touch(box, 'touchstart', [{ x: 0, y: 行の高さ(31) }])
    touch(box, 'touchend', [])

    expect(helper.inputMode).toBe('text')
    expect(focus).toHaveBeenCalled()
  })

  it('枠の罫線そのものを押しても入れること', async () => {
    // 中身だけを的にすると**1行（10px 前後）しか無く、指では狙えない**。
    // 範囲の端を切り詰める壊し方は、ここでだけ落ちる
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, term, helper } = await 端末と隠し欄(container)
    画面を(term, 枠のある画面)
    寸法を(box, term)

    touch(box, 'touchstart', [{ x: 0, y: 行の高さ(30) }])
    touch(box, 'touchend', [])

    expect(helper.inputMode).toBe('text')
  })

  it('入るときは、既定の動きを止めないこと', async () => {
    // **ここが問題2の本体。** 止めると**焦点の移し替えごと止まる**ので、本アプリの
    // 入力欄が焦点を持ったままになり、ブラウザがそれを画面内へ引き戻す。
    // 加えて、iOS が「利用者の操作の中の focus」と認めるかに余計な変数を持ち込まない
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, term } = await 端末と隠し欄(container)
    画面を(term, 枠のある画面)
    寸法を(box, term)

    touch(box, 'touchstart', [{ x: 0, y: 行の高さ(31) }])
    const end = touch(box, 'touchend', [])

    expect(end.defaultPrevented).toBe(false)
  })

  it('枠の外をタップしたら、入力可能を抜けること', async () => {
    // **常に入る実装でも上のテストは通る。** 否定側を対で置く
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, term, helper } = await 端末と隠し欄(container)
    画面を(term, 枠のある画面)
    寸法を(box, term)
    入力可能にしておく(helper)
    const blur = vi.spyOn(helper, 'blur')

    touch(box, 'touchstart', [{ x: 0, y: 行の高さ(5) }])
    const end = touch(box, 'touchend', [])

    expect(blur).toHaveBeenCalled()
    expect(helper.inputMode).toBe('none')
    // 抜けるときは止める。**止めないと互換マウスイベントが焦点を渡し直す**
    expect(end.defaultPrevented).toBe(true)
  })

  it('本アプリの入力欄に焦点があっても、外すこと', async () => {
    // **これが利用者の言う「関係ない所をタップして入力欄に飛ぶのはおかしい」。**
    // 端末の隠し欄を塞ぐだけでは、焦点は入力欄に残ったままで画面が引き戻される
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, term } = await 端末と隠し欄(container)
    画面を(term, 枠のある画面)
    寸法を(box, term)
    const 入力欄 = document.createElement('textarea')
    document.body.appendChild(入力欄)
    入力欄.focus()
    expect(document.activeElement).toBe(入力欄)

    touch(box, 'touchstart', [{ x: 0, y: 行の高さ(5) }])
    touch(box, 'touchend', [])

    expect(document.activeElement).not.toBe(入力欄)
    入力欄.remove()
  })

  it('なぞったときは、焦点を動かさないこと', async () => {
    // 利用者が求めたのは「**タップ**したら抜ける」であって、遡って読む操作で
    // 打ちかけの文から焦点を奪う話ではない
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, term, helper } = await 端末と隠し欄(container)
    画面を(term, 枠のある画面)
    寸法を(box, term)
    // 過去へ遡る余地がある＝握れる状態にする
    vi.spyOn(term.buffer.active, 'viewportY', 'get').mockReturnValue(50)
    vi.spyOn(term.buffer.active, 'baseY', 'get').mockReturnValue(100)
    入力可能にしておく(helper)
    const blur = vi.spyOn(helper, 'blur')

    touch(box, 'touchstart', [{ x: 0, y: 行の高さ(31) }])
    touch(box, 'touchmove', [{ x: 0, y: 行の高さ(31) + 60 }])
    const end = touch(box, 'touchend', [])

    expect(blur).not.toHaveBeenCalled()
    expect(helper.inputMode).toBe('text')
    expect(end.defaultPrevented).toBe(true)
  })

  it('行は .xterm-screen の上端から数えること', async () => {
    // 格子は下端へ貼り付けてあり、**上が切り落とされる**（設計§3-4）ので、上端は
    // 負になりうる。0 と決め打つと、切り落とされている日だけ何行もずれる
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, term, helper } = await 端末と隠し欄(container)
    画面を(term, 枠のある画面)
    寸法を(box, term, -100)

    touch(box, 'touchstart', [{ x: 0, y: 行の高さ(31, -100) }])
    touch(box, 'touchend', [])

    expect(helper.inputMode).toBe('text')
  })

  it('枠の無い画面では、カーソルの行だけが入口になること', async () => {
    // 枠を出さない画面（起動直後・全画面の TUI）でも、打つ道を失わせない
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, term, helper } = await 端末と隠し欄(container)
    画面を(term, ['ログ', 'ログ', 'ログ'])
    寸法を(box, term)
    vi.spyOn(term.buffer.active, 'cursorY', 'get').mockReturnValue(7)

    touch(box, 'touchstart', [{ x: 0, y: 行の高さ(8) }])
    touch(box, 'touchend', [])
    expect(helper.inputMode).toBe('none')

    touch(box, 'touchstart', [{ x: 0, y: 行の高さ(7) }])
    touch(box, 'touchend', [])
    expect(helper.inputMode).toBe('text')
  })

  it('格子の外を触っても、入力可能にしないこと', async () => {
    // 格子より入れ物が大きいと、**上下に地の色の余白ができる**（設計§3-4）。見た目は
    // 端末の一部なので普通に押されるが、そこはどの行でもない。1行の高さが読めない間
    // （隠れている・描き終わる前）も同じ扱いで、**迷ったら入らない**——入力可能を
    // 余計に与えるのが、直そうとしている症状そのものだった
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, term, helper } = await 端末と隠し欄(container)
    画面を(term, 枠のある画面)
    寸法を(box, term)

    for (const y of [-20, 行の高さ(term.rows + 1)]) {
      touch(box, 'touchstart', [{ x: 0, y }])
      touch(box, 'touchend', [])
      expect(helper.inputMode).toBe('none')
    }

    // 高さが読めない間（`clientHeight` が 0）も同じ
    Object.defineProperty(box.querySelector('.xterm-screen') as HTMLElement, 'clientHeight', {
      value: 0,
      configurable: true,
    })
    touch(box, 'touchstart', [{ x: 0, y: 行の高さ(31) }])
    touch(box, 'touchend', [])

    expect(helper.inputMode).toBe('none')
  })
})

/**
 * ソフトキーボードを出す道（設計§12・§13）。
 *
 * 道は2つある——**入力欄の枠をタップする**（上の describe が見張る）のと、
 * **「キーボード」ボタンを押す**（こちら）。押した道は橋（`lib/terminalBridge.ts`）を
 * 通って端末へ届く。**入力欄が見えていない場面の逃げ道**として残してある。
 *
 * **「キーボードが実際に出るか」はここでは見られない。** 決めているのはブラウザなので、
 * 確かめられるのは**隠しテキストエリアの指定**までである。
 */
describe('TerminalPane のキーボード', () => {
  async function 端末と隠し欄(container: HTMLElement) {
    const box = container.querySelector('[data-testid="terminal"]') as HTMLElement
    const term = await 描かれた端末(box)
    return { box, term, helper: term.textarea as HTMLTextAreaElement }
  }

  it('既定では塞いでいること', async () => {
    // **これが要件そのもの。** 起こした直後にキーボードは出ない
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { helper } = await 端末と隠し欄(container)

    expect(helper.inputMode).toBe('none')
  })

  it('入力欄の外をタップしたら、互換マウスイベントを止めること', async () => {
    // **止めないと、`touchend` のあとにブラウザが `pointerdown`（mouse）を撃ち、
    // マウスの経路から焦点が渡ってしまう**——タッチで渡さないようにした意味が消える。
    // **E2E が実際にこれを捕まえた**（実装したつもりで、回り込まれていた）
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box } = await 端末と隠し欄(container)

    touch(box, 'touchstart', [{ x: 0, y: 0 }])
    const end = touch(box, 'touchend', [])

    expect(end.defaultPrevented).toBe(true)
  })

  it('入力欄の外をタップしたら塞いだままであること', async () => {
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { box, helper } = await 端末と隠し欄(container)

    fireEvent.pointerDown(box, { pointerType: 'touch', button: 0 })
    touch(box, 'touchstart', [{ x: 0, y: 0 }])
    touch(box, 'touchend', [])

    expect(helper.inputMode).toBe('none')
  })

  it('頼まれたら開くこと', async () => {
    // 押した操作の中から呼ばれる道。**外して・当てて・戻す**で1組
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { helper } = await 端末と隠し欄(container)
    const blur = vi.spyOn(helper, 'blur')
    const focus = vi.spyOn(helper, 'focus')

    openKeyboard(CARD)

    expect(helper.inputMode).toBe('text')
    // **iOS は焦点が当たったままの変更を読まない。** 入れ直しが要る
    expect(blur).toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
  })

  it('焦点が外れたら塞ぎ直すこと', async () => {
    // 戻さないと、次に端末をタップしただけで開いてしまい**元の問題に戻る**
    const { container } = render(<TerminalPane cardId={CARD} />)
    const { helper } = await 端末と隠し欄(container)
    openKeyboard(CARD)
    expect(helper.inputMode).toBe('text')

    fireEvent.blur(helper)

    expect(helper.inputMode).toBe('none')
  })

  it('端末を捨てたら、開く手も片付くこと', async () => {
    // 残すと、消えた端末を触り続ける
    const { unmount } = render(<TerminalPane cardId={CARD} />)
    await waitFor(() => expect(hasKeyboard(CARD)).toBe(true))

    unmount()

    expect(hasKeyboard(CARD)).toBe(false)
  })
})
