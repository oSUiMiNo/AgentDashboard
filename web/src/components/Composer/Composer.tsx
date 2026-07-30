/**
 * セッションへ指示を送る入力欄（要件「専用画面から指示を送れる」／設計§4・§6）。
 *
 * # タブの外側に常設する
 *
 * 構造化ビューとターミナルのどちらを見ていても送れるように、タブの切り替えとは
 * 独立した位置に置く。要件が言う使い方は「普段は構造化ビューを見ていて、そこから
 * 指示を出す」なので、指示を出すたびにターミナルへ切り替えさせるのは筋が悪い。
 *
 * # Ctrl+Enter で送る
 *
 * Ctrl+Enter＝送信、Enter と Shift+Enter＝改行。チャット欄の一般的な作法（Enter で送信）
 * ではなく、**すぐ隣の端末と同じ割り当て**を採っている。この画面には入力口が2つあり、
 * 押し分けが違うと結果が「いまどちらに焦点があるか」で変わってしまう。判断は
 * [`isComposerSubmit`] が持つ（端末側と同じ `lib/keys.ts`）。
 *
 * 改行を含む指示は、サーバ側が bracketed paste で包んでから PTY へ書く
 * （`crates/core/src/session/input.rs`）。ブラウザ側では加工しない。
 * 加工を両側でやると、どちらが正なのか分からなくなる。
 */

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { isComposerSubmit } from '@/lib/keys'
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
            : '指示やスラッシュコマンドを入力（Ctrl+Enter で送信 / Enter で改行）'
        }
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // 送信でないキーは何もせず通す。素の Enter は textarea の既定が改行にする
          // （`<form>` の中でも textarea の Enter は submit を起こさない）
          if (
            !isComposerSubmit({
              key: event.key,
              ctrlKey: event.ctrlKey,
              altKey: event.altKey,
              metaKey: event.metaKey,
              isComposing: event.nativeEvent.isComposing,
            })
          ) {
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
