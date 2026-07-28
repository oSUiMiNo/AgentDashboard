/**
 * セッションへ指示を送る入力欄（要件「専用画面から指示を送れる」／設計§4・§6）。
 *
 * # タブの外側に常設する
 *
 * 構造化ビューとターミナルのどちらを見ていても送れるように、タブの切り替えとは
 * 独立した位置に置く。要件が言う使い方は「普段は構造化ビューを見ていて、そこから
 * 指示を出す」なので、指示を出すたびにターミナルへ切り替えさせるのは筋が悪い。
 *
 * # Enter で送る
 *
 * Enter＝送信、Shift+Enter＝改行。チャット欄の一般的な作法に合わせている。
 * 改行を含む指示は、サーバ側が bracketed paste で包んでから PTY へ書く
 * （`crates/core/src/session/input.rs`）。ブラウザ側では加工しない。
 * 加工を両側でやると、どちらが正なのか分からなくなる。
 */

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { isEnded, type SessionStatus } from '@/lib/protocol'
import type { CardId } from '@/lib/protocol'
import { useWsStore } from '@/stores/ws'

interface Props {
  cardId: CardId
  status: SessionStatus
}

export function Composer({ cardId, status }: Props) {
  const sendInput = useWsStore((state) => state.sendInput)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const ended = isEnded(status)

  const submit = () => {
    if (ended) {
      return
    }
    sendInput(cardId, text)
    setText('')
    inputRef.current?.focus()
  }

  return (
    <form
      data-testid="composer"
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <Textarea
        ref={inputRef}
        data-testid="composer-input"
        value={text}
        disabled={ended}
        rows={2}
        placeholder={
          ended
            ? 'このセッションは終了しています'
            : '指示やスラッシュコマンドを入力（Enter で送信 / Shift+Enter で改行）'
        }
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // 変換確定の Enter を送信と取り違えないよう、IME の変換中は素通しする
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
            return
          }
          event.preventDefault()
          submit()
        }}
        className="min-h-0 flex-1 resize-none"
      />
      <Button type="submit" size="sm" disabled={ended}>
        送信
      </Button>
    </form>
  )
}
