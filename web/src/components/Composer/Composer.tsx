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
 *
 * # 画像の添付（画像添付 設計§9）
 *
 * 付ける道は3つ（ドラッグ＆ドロップ・貼り付け・「＋」）だが、**拾う口は2つで足りる**
 * ——`onPaste` と `<input type="file">` である。スマホの3通り（長押し貼り付け・
 * キーボード上部の候補・OS の画像選択）も、この2つに落ちる。**経路ごとに書き分けない。**
 *
 * **`compact` で分岐しない。** `compact` は `InputDock` が消費してここへは渡らないので、
 * ここへ足すだけで単独画面と横並びの両方に出る（§9-2）。分岐を書くと片側に出なくなる。
 *
 * **送信を押すまで、画像はブラウザの外へ出ない**（§2）。押してから運び、
 * 置き終わってから本文を組み立てる。運びに失敗したら送らない——添付も本文も残す。
 */

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  ACCEPT_ATTRIBUTE,
  pickImages,
  releasePreview,
  type Attachment,
} from '@/lib/attachments'
import { useDraft } from '@/lib/drafts'
import { uploadAttachment } from '@/lib/hostfs'
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
   * このカードを抱えている PC（画像添付 設計§9-2）。
   *
   * **`null` のときは添付の口を出さない。** 宛先が決まらないと画像を置けないので、
   * できないことをボタンにしない（`README.md`「版を切り替えられない構成がある」と
   * 同じ扱い）。
   */
  host?: string | null
  /**
   * 十字ボタンが出ている間は高さを詰める（十字ボタン設計§11）。
   *
   * **消さない。** 要素が消えると日本語の変換中の文字が復元できない——変換途中の
   * 文字は入力欄の値としてまだ確定していないため、消えた瞬間に取り戻す先が無くなる。
   * この判断が、判定を「迷ったら出す」側へ倒せる根拠になっている。
   */
}

export function Composer({
  cardId,
  status,
  host = null,
  className = '',
}: Props) {
  const sendInput = useWsStore((state) => state.sendInput)
  // 下書きの鍵を分けるためのアカウント。**`lib/` から `stores/` は読まない**ので、
  // 読むのはこちら側（十字ボタン設計§11 のフェーズ3 の訂正）
  const account = useAuthStore((state) => state.auth.account)
  const [text, setText] = useDraft(cardId, account)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // 付いている添付。**下書きと違って覚えない**——`File` はページを跨いで持てないし、
  // 「前に開いたときの画像がまだ付いている」のは押す人の意図と食い違う
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // 運んでいる最中。二度押しで同じ画像を2回置かせない
  const [sending, setSending] = useState(false)
  // 断られた理由と、運びに失敗した理由。**画面にそのまま出す**
  const [trouble, setTrouble] = useState<string[]>([])
  const ended = isEnded(status)
  const 添付できる = host !== null && !ended

  /** 3経路の共通の入口。**判定は `pickImages` の1つを通る**（設計§9） */
  const 受け取る = (files: readonly File[]) => {
    if (!添付できる || files.length === 0) {
      return
    }
    const { accepted, rejected } = pickImages(files)
    setAttachments((now) => [...now, ...accepted])
    setTrouble(rejected)
  }

  const 外す = (id: string) => {
    setAttachments((now) => {
      const 出す = now.find((one) => one.id === id)
      if (出す) {
        releasePreview(出す)
      }
      return now.filter((one) => one.id !== id)
    })
  }

  const submit = async () => {
    if (ended || sending) {
      return
    }

    // **押してから運ぶ。** 先に運んでおくと、外したときに置いたものが残る（§2）
    let paths: string[] = []
    if (attachments.length > 0) {
      if (host === null) {
        setTrouble(['この PC には画像を置けません'])
        return
      }
      setSending(true)
      try {
        paths = []
        for (const one of attachments) {
          const written = await uploadAttachment(host, cardId, one.file)
          paths.push(written.path)
        }
      } catch (err) {
        // **運びに失敗したら送らない。** 添付も入力欄の中身も残す（§9-1）——
        // ここで消すと、押し直すために画像を選び直すことになる
        setTrouble([
          err instanceof Error ? err.message : '画像を置けませんでした',
        ])
        return
      } finally {
        setSending(false)
      }
    }

    // **送れたときだけ消す。** 送れていない文が消えるのが、いちばん困る形
    if (!sendInput(cardId, text, paths)) {
      return
    }
    setText('')
    for (const one of attachments) {
      releasePreview(one)
    }
    setAttachments([])
    setTrouble([])
    inputRef.current?.focus()
  }

  return (
    <form
      data-testid="composer"
      // 縦に積む。**添付は入力欄の「上」**（§9-1）——下に置くと、送信ボタンとの間に
      // 押し間違えやすい列ができる
      className={`flex flex-col gap-1 ${className}`}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      // ドラッグ＆ドロップ。**`onDragOver` で既定を止めないと、ブラウザが
      // その画像を開いてしまい画面ごと入れ替わる**
      onDragOver={(event) => {
        if (添付できる) {
          event.preventDefault()
        }
      }}
      onDrop={(event) => {
        if (!添付できる) {
          return
        }
        event.preventDefault()
        受け取る([...event.dataTransfer.files])
      }}
    >
      {attachments.length > 0 && (
        <ul
          data-testid="composer-attachments"
          className="flex flex-wrap items-center gap-2"
        >
          {attachments.map((one) => (
            <li key={one.id} className="relative">
              <img
                src={one.preview}
                alt={one.file.name}
                title={one.file.name}
                className="size-14 rounded border border-border object-cover"
              />
              <button
                type="button"
                data-testid="composer-attachment-remove"
                aria-label={`${one.file.name} を外す`}
                onClick={() => 外す(one.id)}
                // **当たり判定を 48px 取る**（DESIGN.md §24.3）。見た目は小さくてよいが、
                // 指で外せないと「付けたら取れない」になる
                className="absolute -right-2 -top-2 flex size-12 items-center justify-center
                  text-muted-foreground transition-colors
                  hover:text-foreground active:text-foreground"
              >
                {/* 絵文字を使わない（DESIGN.md §33）。線で描く */}
                <span
                  aria-hidden
                  className="flex size-5 items-center justify-center rounded-full
                    border border-border bg-background text-xs leading-none"
                >
                  ×
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {trouble.length > 0 && (
        <ul data-testid="composer-trouble" className="text-xs text-destructive">
          {trouble.map((文) => (
            <li key={文}>{文}</li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        {添付できる && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={ACCEPT_ATTRIBUTE}
              data-testid="composer-file"
              className="sr-only"
              onChange={(event) => {
                受け取る([...(event.target.files ?? [])])
                // 同じファイルを続けて選べるようにする（値が残ると change が出ない）
                event.target.value = ''
              }}
            />
            <Button
              type="button"
              // **塗らない。** 塗るのは送信だけ（DESIGN.md §5）——同じ濃さで並べると、
              // どちらが「実行」なのかが読めなくなる
              variant="outline"
              size="sm"
              data-testid="composer-attach"
              aria-label="画像を添付"
              disabled={sending}
              onClick={() => fileRef.current?.click()}
            >
              ＋
            </Button>
          </>
        )}
        <Textarea
          ref={inputRef}
          data-testid="composer-input"
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
          // 貼り付け。**PC の Ctrl+V もスマホの長押し貼り付けも、ここへ来る**（§9）
          onPaste={(event) => {
            const files = [...event.clipboardData.files]
            if (files.length === 0) {
              return
            }
            // 画像が来たときだけ既定を止める。字を貼る動きは邪魔しない
            event.preventDefault()
            受け取る(files)
          }}
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
            void submit()
          }}
          className="min-h-0 flex-1 resize-none"
        />
        <Button type="submit" size="sm" disabled={ended || sending}>
          {sending ? '送信中' : '送信'}
        </Button>
      </div>
    </form>
  )
}
