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
   * 横並び表示（グループビュー）で使うときは**十字を出さない**。
   *
   * 理由は「12個は多い」ではなく、**宛先が1つに定まらない**から。決定を離した瞬間に
   * 発火させるのと同じ論理で、宛先が曖昧なまま方向キーを撃つのは誤爆のコストが
   * 非対称すぎる。**Esc は出す**（宛先が一意で、取り消しは安全側の操作）。
   */
  compact?: boolean
}

export function InputDock({ cardId, status, compact = false }: Props) {
  const ended = isEnded(status)
  const coarse = useCoarsePointer()
  const landscape = useLandscape()
  const escRef = useRef<HTMLButtonElement>(null)

  // **ここが「見ている人」の正体。** 偽のあいだは購読そのものが起きない
  const watching = coarse && !compact
  const selecting = useSelecting(cardId, watching)
  const show = watching && (status.kind === 'waiting_permission' || selecting)

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

      <div className="flex items-center gap-2">
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
      </div>

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
            // バネは duration 系で書く。物理系を1つでも混ぜると duration 系が無効になる
            transition={{ type: 'spring', visualDuration: 0.22, bounce: 0.35 }}
            className={
              landscape
                ? 'absolute top-1/2 right-6 z-20 -translate-y-1/2'
                : 'flex justify-center'
            }
            /*
              **横向きは端末の脇へ重ねる**（設計§10）。下端にだけは重ねない——
              選択肢は必ず末尾5行に出るので、下端に重ねると選ぼうとしている対象を覆う。
              層は素通しにして、押せるのはボタンだけにする
            */
            style={landscape ? { pointerEvents: 'none' } : undefined}
          >
            <Dpad onKey={(key) => sendTerminalKey(cardId, key)} />
          </motion.div>
        )}
      </AnimatePresence>

      <Composer cardId={cardId} status={status} collapsed={show} />
    </div>
  )
}
