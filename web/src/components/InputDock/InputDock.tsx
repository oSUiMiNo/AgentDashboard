/**
 * 入力欄まわりの帯（十字ボタン設計§6・§10・§13）。
 *
 * `SessionView` のいままで `Composer` が居た位置に置き、**Esc ボタン ＋ 十字ボタン ＋
 * 入力欄**をまとめて持つ。
 *
 * # 購読をここに閉じる
 *
 * 「いま選択待ちか」を購読するのはこの部品だけにする。`SessionView` が購読すると、
 * 選択待ちの出入りのたびに帯もタブも両ビューも巻き込んで再描画される。
 *
 * # 印とテキストの結論を、ここで合わせる
 *
 * 権限確認は**アプリ自身が申告している**（`status.kind === 'waiting_permission'`）ので、
 * テキストで当てにいく必要がない。橋（`lib/terminalBridge.ts`）が運ぶのは**画面テキスト
 * から導いた結論だけ**で、出どころの違う2つの値はここで初めて合流する。
 *
 * # 見ている人が居なければ、端末は画面を組み立てない
 *
 * `useSelecting` の第2引数へ `coarse && !compact` を渡すことで、PC と横並びでは
 * **購読者が0のまま**になる。端末側（`TerminalPane`）はフレームごとに `hasWatcher` を
 * 見ているので、そこで止まる——**PC では解析コストが丸ごとゼロ**になる。渡し忘れると
 * PC でも毎フレーム画面を組み立てることになる。
 *
 * # Esc は入力方式によらず常に出す
 *
 * 要件が「常に出す」と決めているのに加え、**構造化ビューを見ているあいだは端末に
 * フォーカスが無く、物理の Esc も届かない**。PC でも押せる必要がある。
 *
 * これは別イシュー `スマホから作業を停止できない` が求めているボタンそのもので、
 * 同じものを2度作らないためにここで作る。
 */

import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Composer } from '@/components/Composer/Composer'
import { Dpad } from '@/components/Dpad/Dpad'
import { isEnded, type SessionStatus } from '@/lib/protocol'
import type { CardId } from '@/lib/protocol'
import { useCoarsePointer, useLandscape } from '@/lib/pointer'
import { sendTerminalKey, useSelecting } from '@/lib/terminalBridge'

interface Props {
  cardId: CardId
  status: SessionStatus
  /**
   * このカードを抱えている PC。**素通しするだけ**で、ここでは使わない
   * （画像添付 設計§9-2——添付の口を出すかどうかを `Composer` が決める）。
   */
  host?: string | null
  /**
   * 横並び表示（グループビュー）で使うときは**十字を出さない**。
   *
   * 理由は「12個は多い」ではなく、**宛先が1つに定まらない**から。決定を離した瞬間に
   * 発火させるのと同じ論理で、宛先が曖昧なまま方向キーを撃つのは誤爆のコストが
   * 非対称すぎる。**Esc は出す**（宛先が一意で、取り消しは安全側の操作）。
   */
  compact?: boolean
  /**
   * ターミナルのタブを見ているか。**十字はこれが真のときだけ出す。**
   *
   * 設計§6 は「タブによらず出す」と決めたが、あれは **Esc の話**だった。方向キーは
   * **見えている端末を操作する道具**なので、構造化ビューを見ているあいだに出しても
   * 意味が無いどころか、押すと**見えていない端末へキーが飛ぶ**。
   *
   * **Esc はこれまでどおりタブによらず出す**（止めるのは、見ていなくてもしたい）。
   */
  terminalShown?: boolean
}

export function InputDock({
  cardId,
  status,
  host = null,
  compact = false,
  terminalShown = true,
}: Props) {
  const ended = isEnded(status)
  const coarse = useCoarsePointer()
  const landscape = useLandscape()
  const escRef = useRef<HTMLButtonElement>(null)

  // **ここが「見ている人」の正体。** 偽のあいだは購読そのものが起きない。
  // 端末を見ていないときも偽にする——出せない場面で画面を読む理由が無い
  const watching = coarse && !compact && terminalShown
  const selecting = useSelecting(cardId, watching)
  // **終了したカードでは出さない。** 層のほうは `!ended` を見ていたのに、こちらが
  // 見ていなかったので、**十字が無いのに「表示しました」と読み上げていた**
  const show =
    watching && !ended && (status.kind === 'waiting_permission' || selecting)

  // 消える要素にフォーカスがあるなら、消える前に常在の Esc へ移す（設計§12）
  useEffect(() => {
    if (show) {
      return
    }
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('[data-testid="dpad"]')) {
      escRef.current?.focus()
    }
  }, [show])

  return (
    <div data-testid="input-dock" className="flex shrink-0 flex-col gap-2">
      {/*
        出入りを支援技術へ伝える。**空のまま先に DOM へ置く**——支援技術は
        動的な変化しか読まないので、あとから領域ごと現れても読まれない。
        `assertive` は使わない（頻繁な出入りで読み上げを潰し続ける）
      */}
      <div
        role="status"
        aria-live="polite"
        data-testid="dpad-live"
        className="sr-only"
      >
        {show ? '方向キーを表示しました' : ''}
      </div>

      {/*
        **Esc は入力欄と同じ行に置く。** 別の行にすると、それだけで端末が1行ぶん
        短くなる——スマホでは端末の高さがそのまま読める量なので、帯は1行でも惜しい
        （利用者の要望・2026-08-15）
      */}
      <div className="flex items-end gap-2">
        <Button
          ref={escRef}
          type="button"
          variant="outline"
          size="sm"
          data-testid="esc-key"
          aria-label="中断"
          title="走っている作業を止める（Esc を送ります）"
          disabled={ended}
          /*
            **端末からフォーカスを奪わない。** `term.input()` はフォーカスと無関係に
            届くので、戻す必要は無い——奪わなければよい
          */
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => sendTerminalKey(cardId, 'esc')}
        >
          Esc
        </Button>

      {/*
        **縦でも端末へ重ねる**（設計§10 の訂正。実機で3度踏んだ輪の対処 ＋ 利用者判断）。

        十字が出入りするたびに帯の高さが変われば、端末が縮み／伸びし、
        `ResizeObserver → fit.fit() → resize` が PTY まで飛んでいた（**この経路は
        桁行を固定した工事で無くなった**。`TerminalPane` の `TERMINAL_GRID`）。すると
        TUI が描き直し、その画面がまた判定へ戻ってくる——**出す条件が、出したことで
        変わる輪**になる。

        待たせて damping しようとしたが、**周期が伸びるだけで止まらなかった**（0.1.22）。
        測る契機を足すと**また回り出した**（0.1.23）。原因は damping の不足ではなく、
        **出入りと端末の大きさが結ばれていること**そのものにある。

        **結び目を切る。** 縦でも**端末へ重ねる**（`absolute`）ことで、出入りしても
        レイアウトが1ピクセルも動かない——**リサイズが飛ばない＝輪が原理的に成立しない**。

        一度は「場所を常に空けておく」形にしたが、**端末が短くなりすぎた**（利用者判断・
        2026-08-15）。重ねれば端末の長さを保ったまま輪も消える。

        **置くのは右下。** 選択肢は必ず末尾5行に出るが、**行の左側から書かれる**ので
        右側は空いていることが多い。親指も届く。下端そのものには重ねない（`bottom-28`
        ぶん浮かせて、Esc と入力欄の帯の上に置く）。
      */}
      {watching && !ended && (
        <div
          data-testid="dpad-slot"
          data-shown={show ? 'true' : 'false'}
          // **どちらの向きでも `absolute`。** 縦だけ流れに入れると、そこだけ
          // 出入りで高さが動いて輪が戻る
          className={
            landscape
              ? 'pointer-events-none absolute top-1/2 right-6 z-20 -translate-y-1/2'
              : 'pointer-events-none absolute right-4 bottom-28 z-20'
          }
        >
          <AnimatePresence initial={false}>
            {show && (
              <motion.div
                data-testid="dpad-layer"
                data-place={landscape ? 'overlay' : 'stacked'}
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{
                  opacity: 0,
                  scale: 0.85,
                  transition: { duration: 0.15, ease: [0.3, 0, 1, 1] },
                }}
                // バネは duration 系で書く。物理系を混ぜると duration 系が無効になる
                transition={{ type: 'spring', visualDuration: 0.22, bounce: 0.35 }}
                className="pointer-events-auto"
              >
                <Dpad onKey={(key) => sendTerminalKey(cardId, key)} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

        <Composer
          cardId={cardId}
          status={status}
          host={host}
          className="min-w-0 flex-1"
        />
      </div>
    </div>
  )
}
