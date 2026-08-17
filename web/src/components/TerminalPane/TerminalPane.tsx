/**
 * ブラウザ内のターミナル（設計§10）。
 *
 * xterm.js に WebGL レンダラを載せて GPU で描く。設計が「Ghostty / WezTerm 級の軽快さ」を
 * 目標にしている以上、描画は CPU で回さない。
 *
 * # ウォーターマーク式のフロー制御
 *
 * `term.write(data, callback)` のコールバックは、そのデータを**実際に処理し終えたとき**に
 * 呼ばれる。その数を数えて止める・再開するの判定を [`createFlowController`] に任せる。
 * しきい値をサーバから受け取っているのは、`config.toml` の設定を実際に効かせるため。
 */

import { useEffect, useRef } from 'react'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITerminalInitOnlyOptions, type ITerminalOptions } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { createFlowController } from '@/lib/flow'
import { KIND_PTY_SNAPSHOT } from '@/lib/frame'
import { looksSelecting, sequenceFor, terminalKeyOverride } from '@/lib/keys'
import { visibleLines, visibleScreen } from '@/lib/screen'
import {
  hasWatcher,
  measure,
  registerProbe,
  registerTerminal,
  setSelecting,
} from '@/lib/terminalBridge'
import { createTouchScroller } from '@/lib/touch'
import type { CardId } from '@/lib/protocol'
import { useWsStore } from '@/stores/ws'

interface Props {
  cardId: CardId
}

/** E2E が端末の内容を読むための取り出し口を持った要素。 */
type TerminalContainer = HTMLDivElement & { __terminal?: Terminal }

/**
 * 端末の見た目。単体テストから見えるように外へ出してある。
 *
 * カーソルはブロックにしない。xterm の既定はブロックで、カーソル位置の文字を塗り潰すため
 * **上書きモードで打っているように見える**（実際の行編集は CLI 側の責務で挿入モードのまま）。
 * 非フォーカス時の `cursorInactiveStyle` は既定の枠線のままにする。ここまでバーにすると、
 * どの端末に入力が届くのかが見分けられなくなる。
 */
export const TERMINAL_OPTIONS: ITerminalOptions = {
  convertEol: false,
  cursorBlink: true,
  cursorStyle: 'bar',
  cursorWidth: 2,
  fontSize: 10,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
  theme: { background: '#0b0f14' },
  // xterm 自身のスクロールバックはサーバのリングバッファとは別物。
  // 画面内の遡り用に控えめに確保する
  scrollback: 5000,
}

/**
 * 端末の格子（設計§2）。**見ている入れ物の寸法からは決めない。**
 *
 * # なぜ固定するのか
 *
 * 桁行は「最後に届いた `resize` が勝つ」（初期実装§10）。入れ物から決めていると、
 * PC とスマホで同じセッションを開いたときに**後から開いたほうが相手の表示を作り替える**。
 * どのブラウザも同じ値を送るようにすれば、規則を変えずに引っ張り合いだけが消える。
 *
 * # なぜ 120×40 か
 *
 * 端末の録画（`fixtures/*​/terminal/*.cast`）も、画面のゴールデンの採取も、CLI の
 * `session screen` の既定も、すべてこの大きさである。**出荷される見え方と、テストが
 * 見ている見え方が揃う。**
 *
 * # 初期オプションとして渡す（`resize()` で当て直さない）
 *
 * `cols` / `rows` は `ITerminalInitOnlyOptions` なので、**生まれたときから 120×40** に
 * できる。あとから `resize()` する形にすると、xterm の既定（80×24）で1回できてから
 * 直すことになり、**購読の1通目とサーバへのリサイズが余計に1往復増える**。
 */
export const TERMINAL_GRID: ITerminalInitOnlyOptions = { cols: 120, rows: 40 }

export function TerminalPane({ cardId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // E2E から観測するための値。React の再レンダリングとは無関係に更新する
  const statusRef = useRef<HTMLDivElement>(null)
  // 実機からタッチの数字を読むための置き場所（`?touchdebug=1` のときだけ中身が入る）
  const debugRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const store = useWsStore.getState()
    const term = new Terminal({ ...TERMINAL_OPTIONS, ...TERMINAL_GRID })

    term.open(container)

    // **格子が縮まないことを、指定で言い切る**（設計§3-3）。
    //
    // xterm は `.xterm-screen` に桁行から計算した実寸を書き込み、`.xterm` 自身には
    // 寸法を持たない。したがって `.xterm` の幅は中身から決まる——のだが、その決まり方は
    // 暗黙の規則（grid の子の自動最小サイズ）に乗っている。そこへ寄りかからない。
    //
    // 縮んだときの症状は「右端が消える」ではなく**「行が折り返す」**——つまり TUI の
    // 描画が崩れた形に見えるので、原因が CSS 側にあると気づくまでが遠い。
    const grid = container.querySelector('.xterm')
    if (grid instanceof HTMLElement) {
      grid.style.minWidth = 'max-content'
    }

    const setRendererLabel = (renderer: 'webgl' | 'dom') => {
      statusRef.current?.setAttribute('data-renderer', renderer)
    }

    // WebGL は環境によっては使えない（ヘッドレスや古いGPU）。使えなければ既定の
    // DOM レンダラのまま動くので、失敗しても止めない
    let webgl: WebglAddon | null = null
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // コンテキストを失ったまま放置すると描画が止まる。捨てて DOM レンダラへ戻す
        addon.dispose()
        webgl = null
        setRendererLabel('dom')
      })
      term.loadAddon(addon)
      webgl = addon
      setRendererLabel('webgl')
    } catch {
      webgl = null
      setRendererLabel('dom')
    }

    // --- フロー制御 -------------------------------------------------------
    const flow = createFlowController({
      thresholds: () => {
        const store = useWsStore.getState()
        return { high: store.flowHigh, low: store.flowLow }
      },
      onPause: () => useWsStore.getState().setFlow(cardId, 'pause'),
      onResume: () => useWsStore.getState().setFlow(cardId, 'resume'),
    })

    /**
     * 全画面フレームを**書き終えた**数。
     *
     * リモートの画面が作り直された瞬間を、外から観測できるようにするために持つ。
     * これが無いと、テストは「作り直しが済んだか」を待てず、**届く前の値を見て
     * 通ってしまう**（実際にそういうテストを書いて空振りさせた）。
     *
     * 数えるのは書き終えてからで、遡り位置を戻したあとにあたる。
     */
    let snapshots = 0

    const updateFlowIndicator = () => {
      const status = statusRef.current
      if (!status) {
        return
      }
      status.setAttribute('data-pending', String(flow.pending()))
      status.setAttribute('data-flow', flow.paused() ? 'paused' : 'running')
      // 一度でも止めたかは、瞬間の値を見張るより累計で見るほうが取りこぼさない
      status.setAttribute('data-pause-count', String(flow.pauseCount()))
      status.setAttribute('data-total-bytes', String(flow.totalBytes()))
      status.setAttribute('data-snapshots', String(snapshots))
    }

    const write = (payload: Uint8Array, afterWritten: (() => void) | null = null) => {
      const size = payload.length
      flow.begin(size)
      term.write(payload, () => {
        flow.done(size)
        // **書き終えてから呼ぶ。** `term.write` は非同期で、呼んだ直後には
        // まだバッファが作り直されていない（設計§9）
        afterWritten?.()
        updateFlowIndicator()
      })
      updateFlowIndicator()
    }

    /**
     * 作り直しの前に、いま遡っている位置を控える（設計§9）。
     *
     * リモートの全画面フレームは `term.reset()` を伴うので、遡って読んでいる最中に
     * 来ると**下端へ飛ぶ**。スマホではソフトキーボードの開閉や向きの変更で画面の
     * 大きさが変わり、そのたびに全画面フレームが届くので実際に踏む。
     *
     * **下端に居たなら何も返さない。** 遡っていた人だけを助ける形にしておけば、
     * ふだんの見え方は1バイトも変わらない。
     *
     * 戻した先が同じ内容とは限らない（作り直された画面は中身が違う）。ここは
     * **近くへ戻すことが目的**で、同じ行を指すことは狙わない。
     */
    const keepScrollback = (): (() => void) | null => {
      const buffer = term.buffer.active
      const distance = buffer.baseY - buffer.viewportY
      if (distance <= 0) {
        return null
      }
      return () => term.scrollLines(-distance)
    }

    // --- サーバとの接続 ---------------------------------------------------
    const unsubscribe = store.subscribeTerminal(
      cardId,
      term.cols,
      term.rows,
      (kind, payload) => {
        const snapshot = kind === KIND_PTY_SNAPSHOT
        let restore: (() => void) | null = null
        if (snapshot) {
          // 「ここまでの画面はこれで正しい」という指示。作り直してから書く。
          // **控えるのは作り直しの前**——あとから読むと、遡っていた距離が消えている
          restore = keepScrollback()
          term.reset()
        }
        write(payload, () => {
          restore?.()
          if (snapshot) {
            snapshots += 1
          }
        })
      },
    )

    // Enter まわりを読み替える（[`terminalKeyOverride`]）。
    // Shift+Enter は改行、Ctrl+Enter が送信。素の Enter は**画面次第**で、
    // 選択ダイアログが出ていれば確定、そうでなければ改行になる。
    //
    // **`term.input` を通すのが要点。** ここで `sendPtyInput` を直に呼ぶと送信口が
    // 2つになり、片方だけ直して片方が取り残される形の不具合を作る
    //
    // 画面は**関数で渡す**。この横取りの口はすべてのキーで呼ばれるので、素の Enter の
    // ときにしか読まれない形にしておく（[`visibleScreen`]）
    term.attachCustomKeyEventHandler((event) => {
      const override = terminalKeyOverride(event, () => visibleScreen(term))
      if (override === null) {
        return true
      }
      term.input(override)
      // **ブラウザの既定も止める。** xterm は隠しテキストエリアで入力を受けており、
      // 止めないと Shift+Enter がそこへ改行を入れ、それが別の入力として送られる
      // （こちらの ESC+CR の直後に改行が届き、結局そこで確定してしまう）
      event.preventDefault()
      // xterm の既定（Shift を無視して CR を送る）も止める。止めないと二重に届く
      return false
    })

    // --- 橋（十字ボタン設計§2・§4・§5）----------------------------------
    //
    // 端末の中に閉じている「いま選択待ちか」を外へ出し、外から「意味」でキーを
    // 頼めるようにする2車線。**寿命も鍵も同じ**なので、同じ `useEffect` で登録し
    // 同じ `return` で解除する（片方だけ解除されると、消えた端末へ送り続ける）。
    //
    // 上り：フレームごとに判定して外へ出す。**見ている人が居るときだけ**画面を
    // 組み立てる——`keys.ts` の「打鍵ごとに全画面を組み立てない」という約束を、
    // フレームごとの経路にも通す。PC では購読者が0なので、ここは即座に戻る
    // **測り方は1つにまとめる。** フレームで測るのも、見ている人が現れて測るのも、
    // 大きさが変わって測るのも、同じ関数を通す
    const 測る = () => looksSelecting(visibleScreen(term))
    const unprobe = registerProbe(cardId, 測る)

    const parsed = term.onWriteParsed(() => {
      if (!hasWatcher(cardId)) {
        return
      }
      setSelecting(cardId, 測る())
    })

    // 下り：頼まれた「意味」をバイト列へ直して流す。**`term` そのものは渡さない**
    // （渡すと `reset` や `dispose` を外から呼べてしまい、`keepScrollback` と
    // `flow.begin`/`done` の対が壊せる）
    //
    // **第2引数の `false` が要点。** 型定義が「エスケープシーケンスには false を」と
    // 名指ししているのに加え、`true` にすると xterm が下端へ飛ばす——選択肢を読む
    // ために遡っていた位置が、キーを送るたびに消える
    const unregisterKeys = registerTerminal(cardId, (key) => {
      term.input(sequenceFor(key, term.modes.applicationCursorKeysMode), false)
    })

    // --- タッチで遡る（設計§3・§4・§7）---------------------------------
    //
    // xterm 6 にタッチの口は無い（同梱の `Gesture` は呼び出し0件・非公開、`scroll` の
    // 購読も0件）。**判断は [`createTouchScroller`] が持ち、ここは配線だけ**にする。
    // レンダラが実寸を書き込んでいる唯一の場所から引く。外側の入れ物を使うと、
    // **格子より入れ物が大きいぶんの余白**（設計§3-4）が混ざって遡る量がずれる
    const cellHeightOf = () => {
      const screen = container.querySelector('.xterm-screen')
      if (!(screen instanceof HTMLElement) || term.rows === 0) {
        return 0
      }
      return screen.clientHeight / term.rows
    }

    const scroller = createTouchScroller({
      cellHeight: cellHeightOf,
      scrollLines: (lines) => term.scrollLines(lines),
      canScroll: (direction) => {
        const buffer = term.buffer.active
        return direction < 0 ? buffer.viewportY > 0 : buffer.viewportY < buffer.baseY
      },
      now: () => performance.now(),
      raf: (callback) => requestAnimationFrame(callback),
      cancelRaf: (handle) => cancelAnimationFrame(handle),
    })

    const points = (event: TouchEvent) =>
      Array.from(event.touches, (touch) => ({ x: touch.clientX, y: touch.clientY }))

    // --- 実機から読むための数字（`?touchdebug=1` のときだけ）-----------------
    //
    // **合成タッチで通ることと、指で動くことは別**だった（フェーズ7）。実機で何が
    // 起きているかは実機でしか読めないので、読む口をここに置く。**既定では何も出さない**
    // ので、普段の画面は1ピクセルも変わらない。
    const debugOn =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('touchdebug')
    const tally = { start: 0, move: 0, end: 0, cancel: 0, grabbed: 0, uncancelable: 0 }
    const showDebug = (last: string) => {
      const node = debugRef.current
      if (!node) {
        return
      }
      const buffer = term.buffer.active
      const action =
        typeof getComputedStyle === 'function'
          ? getComputedStyle(container).touchAction
          : '?'
      // **1回だけ組み立てて使い回す。** ここは `touchmove` ごとに呼ばれるので、
      // 呼ぶたびに画面を作り直すと**なぞる速度で毎秒60〜120回 × 回数**になる——
      // **遅さを測るための口が、自分で遅くしていた**（コードレビュー対応13）
      const lines = visibleLines(term)
      node.textContent = [
        `${last} start=${tally.start} move=${tally.move} end=${tally.end} cancel=${tally.cancel}`,
        `握った=${tally.grabbed} 握れない回=${tally.uncancelable}`,
        `viewportY=${buffer.viewportY} baseY=${buffer.baseY} rows=${term.rows}`,
        `touch-action=${action} cell=${cellHeightOf().toFixed(1)}`,
        // **判定の材料をそのまま出す。** 「十字が出ない」を実機で踏んだとき、
        // 何を読んで偽になったのかは**その画面を見ないと分からない**。推測で直すと
        // 往復が増えるので、読む口をここに置く（既定では何も出ない）
        `選択待ち=${測る()} 論理行=${lines.length}`,
        '--- 末尾8行（判定はここを見る） ---',
        ...lines.slice(-8).map((l, i) => `${i}| ${l}`),
      ].join('\n')
    }

    const onTouchStart = (event: TouchEvent) => {
      scroller.start(points(event))
      if (debugOn) {
        tally.start += 1
        showDebug('start')
      }
    }
    // **握ったかどうかだけを見て `preventDefault()` を決める。** 判断を2箇所に
    // 分けると、片方だけ直して片方が取り残される
    const onTouchMove = (event: TouchEvent) => {
      const grabbed = scroller.move(points(event))
      if (grabbed && event.cancelable) {
        event.preventDefault()
      }
      if (debugOn) {
        tally.move += 1
        if (grabbed) {
          tally.grabbed += 1
        }
        if (grabbed && !event.cancelable) {
          // **ここが正なら、原因は判断ではなくブラウザ側**（握ろうとしたのに握れない）
          tally.uncancelable += 1
        }
        showDebug('move')
      }
    }
    const onTouchEnd = () => {
      scroller.end()
      if (debugOn) {
        tally.end += 1
        showDebug('end')
      }
    }
    const onTouchCancel = () => {
      scroller.cancel()
      if (debugOn) {
        tally.cancel += 1
        showDebug('cancel')
      }
    }
    // **`{ passive: false }` でなければ `preventDefault()` は効かない。**
    container.addEventListener('touchstart', onTouchStart, { passive: false })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    container.addEventListener('touchend', onTouchEnd, { passive: false })
    container.addEventListener('touchcancel', onTouchCancel, { passive: false })

    const encoder = new TextEncoder()
    const dataSubscription = term.onData((data) => {
      useWsStore.getState().sendPtyInput(cardId, encoder.encode(data))
    })
    // **格子を固定したので、いまここは鳴らない。** 桁行を変えるものが1つも無くなった
    // ため（設計§14-1）。外さずに残してあるのは、これが**十字の測る契機3つのうちの
    // 1つ**だからで、外すとあちらの設計に手を入れる判断になる。残りの2つ——フレームが
    // 届いたとき・見ている人が現れたとき——は生きている。
    const resizeSubscription = term.onResize(({ cols, rows }) => {
      useWsStore.getState().resize(cardId, cols, rows)
      // **大きさが変わったら測り直す。** 画面の中身は変わっているのに、こちらへ
      // フレームが来るとは限らない（相手が描き直さない場合がある）
      if (hasWatcher(cardId)) {
        measure(cardId)
      }
    })

    // **窓の空き地を押しても、端末へ焦点を渡す**（設計§3-4 の余白への手当て）。
    //
    // 格子が入れ物より小さいとき、上に地の色の余白ができる。見た目は端末の一部
    // なので普通に押されるが、そこは `.xterm` の外なので xterm は拾わない——
    // **押しても打てない**という、原因のいちばん見えにくい形になる。
    //
    // `Terminal.focus()` は `preventScroll` 付きで textarea を掴むので、**窓は動かない**。
    const onPointerDown = () => term.focus()
    container.addEventListener('pointerdown', onPointerDown)

    // E2E から端末の内容を読むための取り出し口。
    //
    // WebGL や canvas で描いていると画面の文字は DOM に存在しないため、
    // 「ブラウザで実際に何が見えているか」をテストから確かめる手段が他に無い。
    // グローバルを汚さないよう、この要素にだけ生やしている（読み取り専用の用途）。
    ;(container as TerminalContainer).__terminal = term

    term.focus()

    return () => {
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchCancel)
      // 滑っている最中に捨てられることがある。止めないと、消えた端末を触り続ける
      scroller.stop()
      parsed.dispose()
      // 受け口・送信待ちの列・選択待ちの値の3つとも片付く
      unregisterKeys()
      dataSubscription.dispose()
      resizeSubscription.dispose()
      unprobe()
      unsubscribe()
      webgl?.dispose()
      term.dispose()
      delete (container as TerminalContainer).__terminal
    }
  }, [cardId])

  return (
    /*
      **`min-w-0` が要る。** flex の子は既定で「中身より小さくならない」ので、
      これが無いと**格子の幅（720px）が入れ物の下限になり、入れ物が縮まない**。
      すると窓の中でスクロールする代わりに**ページ全体が横へ広がる**——狭い画面では
      帯も入力欄も一緒に流れることになり、窓にした意味が消える（実測で踏んだ）。
    */
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={statusRef}
        data-testid="terminal-status"
        data-flow="running"
        data-pending="0"
        className="sr-only"
      />
      {/*
        **入れ物は「格子を覗く窓」である**（設計§3）。桁行を 120×40 に固定したので、
        入れ物のほうが狭ければはみ出す。見せ方は横と縦で違う。

        | 指定 | 何のためか |
        |---|---|
        | `overflowX: auto` | 横にはみ出したぶんは**スクロールで読む** |
        | `overflowY: hidden` | 縦にはみ出したぶんは**切り落とす** |
        | `display: grid` ＋ `alignContent: end` | 格子を**下端へ貼り付ける**。切り落とすのは常に上側 |

        下端に貼り付けてよいのは、**読みたいものが必ず下にある**ため——選択肢は末尾5行に
        出るし、プロンプトも権限モードのフッタも下端にある。上へ押し出された行は、
        指でなぞる遡り（`lib/touch.ts`）でそのまま視界に入る。

        **`touchAction` は見た目ではなく、握れるかどうかを決める指定である。**
        未指定のままだと、1回目の `touchmove` で握っても3回目から `cancelable` が
        落ちて遡れなくなる（十字ボタン設計フェーズ1 の実測）。`none` ではなく `pan-x`
        にして、**横へ払う操作はブラウザに残す**——その払いが、そのまま窓の横スクロールになる。

        Tailwind のクラスではなく**素のスタイル**で書いてあるのは、綴りを間違えても
        黙って効かなくなる指定だからで、こうしておけば単体テストから実際の値を読める
        （jsdom は CSS を読まないので、クラス名の一致では綴り違いも効き目も捕まえられない）。
      */}
      <div
        ref={containerRef}
        data-testid="terminal"
        style={{
          touchAction: 'pan-x',
          display: 'grid',
          alignContent: 'end',
          overflowX: 'auto',
          overflowY: 'hidden',
        }}
        className="min-h-0 min-w-0 flex-1 rounded-md bg-[#0b0f14] p-2"
      />
      {/*
        実機からタッチの数字を読む口（`?touchdebug=1` のときだけ中身が入る）。

        **合成タッチで通ることと、指で動くことは別**だった（フェーズ7）。実機で何が
        起きているかは実機でしか読めないので、URL を1つ変えるだけで読めるようにしてある。
        **既定では空**なので普段の画面には出ない——空の入れ物を常に置いているのは、
        条件付きで描くと React の再描画が要り、1本指の経路に手数が乗るため。
      */}
      <div
        ref={debugRef}
        data-testid="terminal-touch-debug"
        className="text-muted-foreground shrink-0 font-mono text-[10px] leading-tight whitespace-pre-wrap empty:hidden"
      />
    </div>
  )
}
