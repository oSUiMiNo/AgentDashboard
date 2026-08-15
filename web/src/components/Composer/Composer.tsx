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

import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useDraft } from '@/lib/drafts'
import { isComposerSubmit } from '@/lib/keys'
import { isEnded, type SessionStatus } from '@/lib/protocol'
import type { CardId } from '@/lib/protocol'
import { useAuthStore } from '@/stores/auth'
import { useWsStore } from '@/stores/ws'

interface Props {
  /** 外から寸法を決める（帯へ横並びに置くため） */
  className?: string
  cardId: CardId
  status: SessionStatus
  /**
   * 十字ボタンが出ている間は高さを詰める（十字ボタン設計§11）。
   *
   * **消さない。** 要素が消えると日本語の変換中の文字が復元できない——変換途中の
   * 文字は入力欄の値としてまだ確定していないため、消えた瞬間に取り戻す先が無くなる。
   * この判断が、判定を「迷ったら出す」側へ倒せる根拠になっている。
   */
  collapsed?: boolean
}

export function Composer({ cardId, status, collapsed = false, className = '' }: Props) {
  const sendInput = useWsStore((state) => state.sendInput)
  // 下書きの鍵を分けるためのアカウント。**`lib/` から `stores/` は読まない**ので、
  // 読むのはこちら側（十字ボタン設計§11 のフェーズ3 の訂正）
  const account = useAuthStore((state) => state.auth.account)
  const [text, setText] = useDraft(cardId, account)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const ended = isEnded(status)

  const submit = () => {
    if (ended) {
      return
    }
    // **送れたときだけ消す。** 送れていない文が消えるのが、いちばん困る形
    if (!sendInput(cardId, text)) {
      return
    }
    setText('')
    inputRef.current?.focus()
  }

  return (
    <form
      data-testid="composer"
      className={`flex items-end gap-2 ${className}`}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <Textarea
        ref={inputRef}
        data-testid="composer-input"
        data-collapsed={collapsed ? 'true' : 'false'}
        value={text}
        disabled={ended}
        // 畳んでも消さない。**行数を詰めるだけ**
        rows={1}
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
