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
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITerminalOptions } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { createFlowController } from '@/lib/flow'
import { KIND_PTY_SNAPSHOT } from '@/lib/frame'
import { terminalKeyOverride } from '@/lib/keys'
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
  fontSize: 13,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
  theme: { background: '#0b0f14' },
  // xterm 自身のスクロールバックはサーバのリングバッファとは別物。
  // 画面内の遡り用に控えめに確保する
  scrollback: 5000,
}

export function TerminalPane({ cardId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // E2E から観測するための値。React の再レンダリングとは無関係に更新する
  const statusRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const store = useWsStore.getState()
    const term = new Terminal(TERMINAL_OPTIONS)

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)

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

    fit.fit()

    // --- フロー制御 -------------------------------------------------------
    const flow = createFlowController({
      thresholds: () => {
        const store = useWsStore.getState()
        return { high: store.flowHigh, low: store.flowLow }
      },
      onPause: () => useWsStore.getState().setFlow(cardId, 'pause'),
      onResume: () => useWsStore.getState().setFlow(cardId, 'resume'),
    })

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
    }

    const write = (payload: Uint8Array) => {
      const size = payload.length
      flow.begin(size)
      term.write(payload, () => {
        flow.done(size)
        updateFlowIndicator()
      })
      updateFlowIndicator()
    }

    // --- サーバとの接続 ---------------------------------------------------
    const unsubscribe = store.subscribeTerminal(
      cardId,
      term.cols,
      term.rows,
      (kind, payload) => {
        if (kind === KIND_PTY_SNAPSHOT) {
          // 「ここまでの画面はこれで正しい」という指示。作り直してから書く
          term.reset()
        }
        write(payload)
      },
    )

    // Enter まわりを読み替える（[`terminalKeyOverride`]）。
    // Enter と Shift+Enter は改行、Ctrl+Enter が送信になる。
    //
    // **`term.input` を通すのが要点。** ここで `sendPtyInput` を直に呼ぶと送信口が
    // 2つになり、片方だけ直して片方が取り残される形の不具合を作る
    term.attachCustomKeyEventHandler((event) => {
      const override = terminalKeyOverride(event)
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

    const encoder = new TextEncoder()
    const dataSubscription = term.onData((data) => {
      useWsStore.getState().sendPtyInput(cardId, encoder.encode(data))
    })
    const resizeSubscription = term.onResize(({ cols, rows }) => {
      useWsStore.getState().resize(cardId, cols, rows)
    })

    const observer = new ResizeObserver(() => {
      // 要素の大きさが 0 のときに fit すると例外になることがある
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        fit.fit()
      }
    })
    observer.observe(container)

    // E2E から端末の内容を読むための取り出し口。
    //
    // WebGL や canvas で描いていると画面の文字は DOM に存在しないため、
    // 「ブラウザで実際に何が見えているか」をテストから確かめる手段が他に無い。
    // グローバルを汚さないよう、この要素にだけ生やしている（読み取り専用の用途）。
    ;(container as TerminalContainer).__terminal = term

    term.focus()

    return () => {
      observer.disconnect()
      dataSubscription.dispose()
      resizeSubscription.dispose()
      unsubscribe()
      webgl?.dispose()
      term.dispose()
      delete (container as TerminalContainer).__terminal
    }
  }, [cardId])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={statusRef}
        data-testid="terminal-status"
        data-flow="running"
        data-pending="0"
        className="sr-only"
      />
      <div
        ref={containerRef}
        data-testid="terminal"
        className="min-h-0 flex-1 overflow-hidden rounded-md bg-[#0b0f14] p-2"
      />
    </div>
  )
}
