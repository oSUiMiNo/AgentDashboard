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

import { useEffect, useRef, useState } from 'react'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITerminalInitOnlyOptions, type ITerminalOptions } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/clipboard'
import { createFlowController } from '@/lib/flow'
import { KIND_PTY_SNAPSHOT } from '@/lib/frame'
import {
  inputBoxRows,
  looksSelecting,
  rowInRange,
  sequenceFor,
  terminalKeyOverride,
} from '@/lib/keys'
import { visibleLines, visibleRows, visibleScreen } from '@/lib/screen'
import {
  hasWatcher,
  registerKeyboard,
  registerProbe,
  registerTerminal,
  setSelecting,
} from '@/lib/terminalBridge'
import { createTouchScroller, DEFAULT_TUNING } from '@/lib/touch'
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
  /*
    **アプリの地と同じ値で塗る**（細かい修正 設計§5-4・要件6）。要件は「透明にする」だが、
    **透明にはしない**——端末の描画層を透かすと裏の要素が透けて文字が読めなくなる。
    地と同じ色で塗るほうが結果が安定する。

    **`--background`（`oklch(0.145 0 0)`）と同じ**。xterm は CSS 変数を読めないので
    ここだけは字で持つが、**入れ物の側は `bg-background` で変数から取っている**ので
    リテラルはこの1つだけである。以前は `#0b0f14` が2箇所に別々に書かれていて、
    **片方だけ直すと端末の外周にだけ古い色が残る**形になっていた。
  */
  theme: { background: '#0a0a0a' },
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

/**
 * 長押しと呼ぶまでの時間（ms）。**コピーのイシュー設計§3。**
 *
 * スマホの文字選択が出る間合いに合わせてある。短くすると、ゆっくりしたタップが
 * 選択に化ける——**入力欄の枠の上では計時そのものをしない**ので実害は枠の外に
 * 限られるが、それでも「押しただけで選ばれた」は驚きになる。
 */
export const LONG_PRESS_MS = 500

export function TerminalPane({ cardId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // E2E から観測するための値。React の再レンダリングとは無関係に更新する
  const statusRef = useRef<HTMLDivElement>(null)
  // 実機からタッチの数字を読むための置き場所（`?touchdebug=1` のときだけ中身が入る）
  const debugRef = useRef<HTMLDivElement>(null)
  /**
   * いま選んでいる文字があるか。**コピーの的を出すかどうかだけに使う。**
   *
   * 選択そのものは xterm が持っており、これはその写しにすぎない——真偽が食い違っても
   * 写す中身は `getSelection()` から取り直すので、古い値で違うものを写すことはない。
   */
  const [選択あり, set選択あり] = useState(false)
  /** 押した結果。**押すまでは `null`。** */
  const [写し, set写し] = useState<'ok' | 'ng' | null>(null)
  /**
   * 選んだものを取り出す手。**端末そのものは外へ出さない**——出すと `reset` や
   * `dispose` を効果の外から呼べてしまい、遡り位置の復元とフロー制御の対が壊せる。
   */
  const 選択の手 = useRef<{ 取り出す: () => string; 捨てる: () => void } | null>(null)

  /**
   * 選んだものをクリップボードへ写す。**押した操作の中から、その場で呼ぶこと。**
   *
   * 中身は真偽を持っている `選択あり` からではなく、**そのつど `getSelection()` から
   * 取り直す**。写しの真偽が古くなっても、写るものが食い違うことはない。
   */
  const 写す = async () => {
    const 文字 = 選択の手.current?.取り出す() ?? ''
    if (文字 === '') {
      return
    }
    set写し((await copyToClipboard(文字)) ? 'ok' : 'ng')
  }

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

    // スマホでソフトキーボードを出す道（設計§12・§13）。
    //
    // xterm はキーを**不可視の textarea**（`term.textarea`）で受け取る。そこへ焦点が
    // 入るとブラウザが「文字を打つ場所に入った」と判断してキーボードを出す——端末は
    // 1枚の面なので、**面のどこを触っても同じテキストエリアが掴まれる**。だから
    // 「入力欄でない場所」を押しても出ていた。
    //
    // # 状態で決めるのはやめ、場所で決める
    //
    // 「いま打てる状態か」を画面から判定する形にしていたが、**プロンプトが出ている
    // 通常状態では真になる**ので、ログの部分を押してもキーボードが出る（設計§12）。
    // いまは**入力欄が画面のどの行にあるか**を出し、触った行と突き合わせる（設計§13）。
    //
    // # 既定で塞ぎ、押されたときだけ開く
    //
    // **iOS は、信頼されたユーザ操作の中の `focus()` でしかキーボードを開かない。**
    // Android はもっと緩く「一度操作があれば以降は許可」なので、**焦点を遅らせるだけ
    // では漏れる**——だから塞ぐ側を既定にし、開けるのは押した操作の中だけにする。
    //
    // # タッチは、触った場所で入り／抜けする（設計§13）
    //
    // 「タッチでは焦点を一切渡さない」形にした時期があったが、**入力欄そのものを押しても
    // 何も起きない**——打つ道がボタン1つしか無くなった（利用者の観測・2026-09-05）。
    // いまは触った場所で分ける。
    //
    // ```
    // 入力欄の枠の中   → 入力可能にする（[`開く`]。焦点もキーボードも来る）
    // それ以外をタップ → 入力可能を抜ける（[`入力可能を抜ける`]。カーソルもキーボードも消える）
    // なぞり           → 焦点は動かさない（読んでいるだけなので、奪う理由が無い）
    // ```
    //
    // **マウスの経路は変えない。** PC はタップと違って、押した場所で打ち始めるのが自然。
    const helper = term.textarea

    /** ソフトキーボードを塞ぐ。**既定はこちら。** */
    const 塞ぐ = () => {
      if (helper) {
        helper.inputMode = 'none'
      }
    }

    /**
     * ソフトキーボードを開く。**押した操作の中から呼ぶこと。**
     *
     * iOS は**焦点が当たったままの `inputmode` の変更を読まない**ので、入れ直す。
     * 外して・当てて・戻す、の3つで1組になる。
     */
    const 開く = () => {
      if (!helper) {
        return
      }
      helper.blur()
      helper.inputMode = 'text'
      helper.focus()
    }

    /**
     * 入力可能を抜ける。**焦点そのものを外す**ので、カーソルもキーボードも消える。
     *
     * # 端末の隠し欄を塞ぐだけでは足りない
     *
     * **焦点は、本アプリの入力欄（`Composer`）にあることがある。** その状態で端末を
     * タップすると、外さないかぎり入力欄は焦点を持ったままで、**ブラウザがそれを画面内へ
     * 引き戻す**——関係ない所を押したのに入力欄へ飛び、キーボードも開いたままになる
     * （利用者の観測・2026-09-05）。だから、いま焦点を持っているものを名指しせずに外す。
     */
    const 入力可能を抜ける = () => {
      塞ぐ()
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== document.body) {
        active.blur()
      }
    }

    // **閉じたら塞ぎ直す。** 戻さないと、次に端末をタップしただけで開いてしまい、
    // 直したはずの問題がそのまま戻る
    helper?.addEventListener('blur', 塞ぐ)
    塞ぐ()

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

    // 3つ目の車線。**キーボードを開く手**を外へ出す（設計§12）。押すボタンは
    // 入力欄の帯に居る兄弟なので、直接は触れない
    const unregisterKeyboard = registerKeyboard(cardId, 開く)

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

    /**
     * 触った高さが、いま画面の何行目に当たるか（可視領域の 0 起点）。読めなければ `null`。
     *
     * **基準は `.xterm-screen` の上端**で、`cellHeightOf` と同じ場所から引く。外側の
     * 入れ物を使うと、格子より入れ物が大きいぶんの余白（設計§3-4）が混ざって1行ずれる。
     * 格子は下端へ貼り付けてあり上が切り落とされる（`alignContent: end`）ので、**上端は
     * 画面の外＝負の値になりうる**——`getBoundingClientRect()` はそれをそのまま返すので、
     * 触った点（同じく窓の座標）と引き算するだけで正しく揃う。
     *
     * **格子の外（上下の余白。設計§3-4）なら、範囲の外の数がそのまま返る。** ここで
     * 丸めたり弾いたりしない——**外かどうかを決める場所は [`rowInRange`] 1箇所**に
     * しておく。2箇所で弾くと、片方を壊しても落ちないぶんだけ見張りが緩む。
     */
    const rowAt = (clientY: number): number | null => {
      const screen = container.querySelector('.xterm-screen')
      const cell = cellHeightOf()
      if (!(screen instanceof HTMLElement) || cell <= 0) {
        // 高さが読めない間（隠れている・描き終わる前）。**割ると NaN か ±Infinity に
        // なる**ので、比較へ流さずここで諦める。流しても範囲の判定は偽と答えるため
        // 振る舞いは変わらない——**この番兵だけを外しても1本も落ちない**（フェーズ8 の実測）
        return null
      }
      return Math.floor((clientY - screen.getBoundingClientRect().top) / cell)
    }

    /**
     * その行は入力欄の中か。**決めるのは [`inputBoxRows`]、測るのはここ**（設計§13-2）。
     *
     * **カーソルの位置は基準（`baseY`）からの数**なので、遡っているぶんを足して画面の
     * 行へ直す。遡って画面の外に居るときは範囲の外の値になり、どの行とも一致しない
     * ——ログを読んでいる最中のタップで打ち始めることにはならない。
     */
    const 入力欄の行か = (row: number): boolean => {
      const buffer = term.buffer.active
      const cursorRow = buffer.cursorY + buffer.baseY - buffer.viewportY
      return rowInRange(inputBoxRows(visibleRows(term), cursorRow), row)
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
        // **場所で決める判定の材料も出す。** 「入力欄を押したのに入らない」を実機で
        // 踏んだとき、枠が何行目に見つかったのかは**その画面を見ないと分からない**
        `入力欄=${JSON.stringify(inputBoxRows(visibleRows(term), buffer.cursorY + buffer.baseY - buffer.viewportY))}`,
        '--- 末尾8行（判定はここを見る） ---',
        ...lines.slice(-8).map((l, i) => `${i}| ${l}`),
      ].join('\n')
    }

    /**
     * 触った点。**タップとなぞりを見分けるのと、当たった行を出すのに使う。**
     *
     * 見分ける必要が戻ってきたのは、行き先が3つに分かれたため（入る／抜ける／何もしない）。
     * 指が2本以上なら `null` のまま——ピンチはタップではない。
     */
    let 触れた: { x: number; y: number } | null = null
    /** 置いた点から離れた最大の距離（px）。これが小さいものだけをタップと呼ぶ。 */
    let 離れた = 0
    /**
     * タップと呼べる動きの幅（px）。
     *
     * **遡り始めるしきい値と同じ値を使う。** 別に持つと、「遡ってはいないがタップでもない」
     * という、どちらの道にも入らない動きが生まれる。
     */
    const TAP_SLOP = DEFAULT_TUNING.threshold

    // --- 長押しで選ぶ（コピーの設計§3・§4）--------------------------------
    //
    // **ブラウザの文字選択は使えない。** WebGL レンダラは canvas に描くので DOM に
    // 文字が1行も無く、`user-select` を戻しても選ぶ対象が存在しない（コピー設計§2）。
    // 代わりに **xterm 自身の選択**を動かす——あれはモデル側に在るので、どちらの
    // レンダラでも効く。
    //
    // # 既定の経路には1行も入らない（コピー設計§4）
    //
    // 1. **枠の中では計時を始めない。** 枠の上のゆっくりしたタップが選択に化けない
    // 2. **発火したら焦点も外す。** 枠の外を触ったという約束は、長押しでも守られる
    // 3. **モードを作らない。** 残る状態は「発火したか」の1つで、指を離せば必ず落ちる
    //
    /** 計時中のタイマー。**発火・指の移動・離す・破棄のどれでも必ず止める。** */
    let 長押し: ReturnType<typeof setTimeout> | null = null
    /**
     * 長押しが発火したか。**指を離せば必ず偽へ戻る**ので、消え残る状態が無い。
     *
     * **落とすのは `touchend` と `touchcancel` の2箇所だけ**——「指が離れた」という
     * 1つの意味を2つの入口で書いているので、これで1箇所と数える。**`touchstart` でも
     * 落としてはいけない。** 落とすと、離すときに落とし忘れても次の指が拾ってしまい、
     * **落とし忘れを壊し方で見つけられなくなる**（フェーズ2の実測。壊しても1本も
     * 落ちなかった）。
     */
    let 選んでいる = false
    /** 長押しが始まった行（可視領域の 0 起点）。ここから指の居る行までを選ぶ。 */
    let 起点 = 0

    const 計時をやめる = () => {
      if (長押し !== null) {
        clearTimeout(長押し)
        長押し = null
      }
    }

    /**
     * 可視領域の行を、バッファの行へ直す。
     *
     * `selectLines` が受け取るのは**遡りも含めた通し番号**で、画面を読む側
     * （[`visibleRows`]）が `viewportY` から数えているのと同じ起点である。
     */
    const バッファの行 = (row: number) => term.buffer.active.viewportY + row

    const 選ぶ = (from: number, to: number) => {
      term.selectLines(バッファの行(Math.min(from, to)), バッファの行(Math.max(from, to)))
      set選択あり(term.hasSelection())
    }

    const 選択を捨てる = () => {
      term.clearSelection()
      set選択あり(false)
      set写し(null)
    }

    const 選び始める = (row: number) => {
      長押し = null
      選んでいる = true
      // **遡りは取りやめる。** 同じ指で範囲を伸ばすので、両方が動くと画面が滑る
      scroller.cancel()
      // 枠の外を触ったのだから、焦点は外す（コピー設計§4-2）。**ここを消すと、
      // 前のイシューで直した「枠の外なのに焦点が残る」が長押しの経路だけ戻る**
      入力可能を抜ける()
      set写し(null)
      選ぶ(row, row)
    }

    選択の手.current = { 取り出す: () => term.getSelection(), 捨てる: 選択を捨てる }

    const onTouchStart = (event: TouchEvent) => {
      const 指 = points(event)
      触れた = 指.length === 1 ? 指[0] : null
      離れた = 0
      計時をやめる()
      scroller.start(指)
      // **枠の中では計時を始めない**（コピー設計§4-1）。始めてから場所を見る形に
      // すると、**枠の上のゆっくりしたタップが選択に化けてキーボードが開かなくなる**
      if (触れた) {
        const 行 = rowAt(触れた.y)
        if (行 !== null && !入力欄の行か(行)) {
          起点 = 行
          長押し = setTimeout(() => 選び始める(行), LONG_PRESS_MS)
        }
      }
      if (debugOn) {
        tally.start += 1
        showDebug('start')
      }
    }
    // **握ったかどうかだけを見て `preventDefault()` を決める。** 判断を2箇所に
    // 分けると、片方だけ直して片方が取り残される
    const onTouchMove = (event: TouchEvent) => {
      const 指 = points(event)
      if (触れた && 指.length === 1) {
        離れた = Math.max(離れた, Math.hypot(指[0].x - 触れた.x, 指[0].y - 触れた.y))
      }
      // **発火したあとの指は、なぞりではなく範囲を伸ばす操作**（コピー設計§6-1）
      if (選んでいる) {
        const 行 = 指.length === 1 ? rowAt(指[0].y) : null
        if (行 !== null) {
          選ぶ(起点, 行)
        }
        if (event.cancelable) {
          event.preventDefault()
        }
        if (debugOn) {
          tally.move += 1
          showDebug('move 選択中')
        }
        return
      }
      // **動いたら長押しではない。** タップと呼べる幅を超えた時点で計時をやめる
      if (離れた > TAP_SLOP) {
        計時をやめる()
      }
      const grabbed = scroller.move(指)
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
    /**
     * 指が離れた。**行き先を決めるのはここ1箇所**（設計§13-1）。
     *
     * | 何が起きたか | 焦点 | `preventDefault()` |
     * |---|---|---|
     * | 入力欄の枠をタップ | [`開く`]（焦点＋キーボード） | **呼ばない** |
     * | それ以外をタップ | [`入力可能を抜ける`]（カーソルも消える） | 呼ぶ |
     * | なぞり | 動かさない（読んでいるだけ） | 呼ぶ |
     *
     * # 入るときに `preventDefault()` を呼ばない理由
     *
     * 呼ぶと**ブラウザ既定の「焦点の移し替え」まで止まる**。以前ここで無条件に
     * 呼んでいたせいで、本アプリの入力欄に焦点があるまま端末をタップすると、
     * **画面が入力欄へ引き戻されキーボードが開いた**（利用者の観測・2026-09-05）。
     * 止めたかったのは互換マウスイベントだけだったのに、道連れにしていた。
     *
     * 加えて、**iOS が「利用者の操作の中の `focus()`」と認めるかどうかに余計な変数を
     * 持ち込まない**。開けてよい唯一の場面なので、既定の邪魔をしない。
     *
     * # 抜けるとき・なぞりでは呼ぶ
     *
     * 止めないと `touchend` のあとにブラウザが `pointerdown`（`pointerType: 'mouse'`）を
     * 撃ち、**下の `onPointerDown` が焦点を渡してしまう**——タッチの経路で渡さなくても、
     * マウスの経路から回り込まれる。**E2E が実際にこれを捕まえた。**
     *
     * # なぞりでは焦点を動かさない
     *
     * 利用者が求めたのは「**タップ**したら抜ける」であって、遡って読む操作で打ちかけの
     * 文から焦点を奪う話ではない。
     */
    const onTouchEnd = (event: TouchEvent) => {
      計時をやめる()
      // **選び終えた指は、行き先の判断へ入らない。** 焦点は発火のときに外してあり、
      // ここで `入力可能を抜ける()` を呼び直す理由も、`開く()` へ着く理由も無い
      if (選んでいる) {
        選んでいる = false
        触れた = null
        // 滑らせない。**選ぶために動かした指の勢いで画面が流れる**のは驚きになる
        scroller.cancel()
        if (event.cancelable) {
          event.preventDefault()
        }
        if (debugOn) {
          tally.end += 1
          showDebug('end 選択')
        }
        return
      }
      // **決めるのは `scroller.end()` より先。** あちらは勢いが残っていれば滑り始め、
      // 滑れば `viewportY` が動く＝行の対応が変わる
      const 点 = 触れた
      const タップ = 点 !== null && 離れた <= TAP_SLOP
      const 行 = タップ && 点 ? rowAt(点.y) : null
      const 入る = 行 !== null && 入力欄の行か(行)
      scroller.end()
      触れた = null
      // **タップしたら選択は捨てる。** 残り続けると、次に押したときに古い範囲が
      // 混ざる——「いま見えている選択」と「写るもの」が食い違う形を作らない
      if (タップ) {
        選択を捨てる()
      }
      if (入る) {
        開く()
      } else {
        if (event.cancelable) {
          event.preventDefault()
        }
        if (タップ) {
          入力可能を抜ける()
        }
      }
      if (debugOn) {
        tally.end += 1
        showDebug(`end 行=${行 ?? '-'} 入る=${入る}`)
      }
    }
    const onTouchCancel = () => {
      計時をやめる()
      選んでいる = false
      触れた = null
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
    // **格子を固定したので、いまここは鳴らない**（桁行を変えるものが1つも無い。設計§14-1）。
    //
    // それでも**送る側は残す**。これは `ClientMessage::Resize` をブラウザから送る
    // 唯一の実装で、消すと**型はあるのに送り手が居ない**状態になる（台帳
    // `cli_surface.toml` は Rust の enum から導くので落ちないが、「ブラウザが叩ける口」
    // という台帳の前提のほうが嘘になる）。
    //
    // **一方、十字の測り直しはここから外した**（設計§14-11）。鳴らないものを契機として
    // 残すと「契機は3つ」と読む人が出る。**生きている契機は2つ**——フレームが届いたときと、
    // 見ている人が現れたとき。
    const resizeSubscription = term.onResize(({ cols, rows }) => {
      useWsStore.getState().resize(cardId, cols, rows)
    })

    // **窓の空き地を押しても、端末へ焦点を渡す**（設計§3-4 の余白への手当て）。
    //
    // 格子が入れ物より小さいとき、上に地の色の余白ができる。見た目は端末の一部
    // なので普通に押されるが、そこは `.xterm` の外なので xterm は拾わない——
    // **押しても打てない**という、原因のいちばん見えにくい形になる。
    //
    // `Terminal.focus()` は `preventScroll` 付きで textarea を掴むので、**窓は動かない**。
    //
    // # タッチはここで決めない（設計§14-9）
    //
    // `pointerdown` は**タップとなぞりを区別しない**。指を置いた瞬間に焦点を移すと、
    // **遡ろうとなぞるたびにソフトキーボードが出て**画面が半分隠れるうえ、入力欄に
    // 打ちかけの文があっても焦点を奪う。タッチは `touchend` まで待ち、**触った場所を
    // 見てから**決める（[`onTouchEnd`]）。
    //
    // 主ボタン以外（右クリック）でも移さない。
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.button !== 0) {
        return
      }
      term.focus()
    }
    container.addEventListener('pointerdown', onPointerDown)

    // E2E から端末の内容を読むための取り出し口。
    //
    // WebGL や canvas で描いていると画面の文字は DOM に存在しないため、
    // 「ブラウザで実際に何が見えているか」をテストから確かめる手段が他に無い。
    // グローバルを汚さないよう、この要素にだけ生やしている（読み取り専用の用途）。
    ;(container as TerminalContainer).__terminal = term

    // マウント時の初期フォーカス。**塞いであるので、起こした直後にキーボードは出ない**
    term.focus()

    return () => {
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchCancel)
      // 計時の途中で捨てられることがある。止めないと、消えた端末を選びにいく
      計時をやめる()
      選択の手.current = null
      // 滑っている最中に捨てられることがある。止めないと、消えた端末を触り続ける
      scroller.stop()
      parsed.dispose()
      // 受け口・送信待ちの列・選択待ちの値の3つとも片付く
      unregisterKeys()
      unregisterKeyboard()
      helper?.removeEventListener('blur', 塞ぐ)
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
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
      {/*
        **選んだものを写す的**（コピー設計§3・§5）。

        長押しで選んだあとにだけ現れる。**端末へ重ねる**——帯へ足すと、押す機会の
        少ないものが常に1つぶんの幅を取り、狭い画面で入力欄が縮む。

        **置くのは右上。** 十字は右下に居るので、重ならない場所がここしか無い。
        読みたい行は下端に集まるので、上を塞ぐほうが害が小さい。

        # 写す手は書かない

        `lib/clipboard.ts` を呼ぶだけにする。あちらは**素の HTTP で開いたスマホ**
        （`navigator.clipboard` が居ない）を前提に書かれており、`await` を1つも
        跨がずに古い方法へ着く。ここで書き直すと、その前提ごと落とすことになる。

        # 写せなかったときの逃げ道を必ず持つ

        あちらの注釈が「偽を返したときの逃げ道を呼ぶ側が必ず持つ」と定めている。
        **端末の文字は canvas に在って選べない**ので、逃げ道は**選べる入れ物に
        出し直すこと**になる——素の `textarea` なら、そこだけは指で選べる。
      */}
      {選択あり && (
        <div
          data-testid="terminal-copy-bar"
          className="absolute top-2 right-2 z-20 flex max-w-[80%] flex-col items-end gap-1"
        >
          <div className="flex items-center gap-2">
            {写し !== null && (
              <span
                role="status"
                aria-live="polite"
                data-testid="terminal-copy-result"
                className={
                  写し === 'ok'
                    ? 'bg-background/90 rounded-md px-2 py-1 text-xs'
                    : 'bg-background/90 text-destructive rounded-md px-2 py-1 text-xs'
                }
              >
                {写し === 'ok' ? '写しました' : '写せません'}
              </span>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="terminal-copy"
              aria-label="選んだ文字をコピー"
              title="選んでいる行をコピーします"
              /*
                **端末から焦点を奪う操作にはしない。** 写す側が押す前の居場所を
                覚えて返すので、ここで既定を止めると返す先が変わる
              */
              onClick={() => {
                void 写す()
              }}
            >
              コピー
            </Button>
          </div>
          {写し === 'ng' && (
            <textarea
              readOnly
              data-testid="terminal-copy-fallback"
              aria-label="コピーできなかった文字"
              className="bg-background w-full rounded-md border p-2 font-mono text-xs"
              rows={4}
              value={選択の手.current?.取り出す() ?? ''}
            />
          )}
        </div>
      )}
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
        className="bg-background min-h-0 min-w-0 flex-1 rounded-md p-2"
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
