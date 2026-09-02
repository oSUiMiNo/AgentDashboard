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
 *
 * # 断られたら戻す（設計§7-2）
 *
 * **`sendInput` が `true` を返しても、届いたとは限らない。** 言えるのは WebSocket が
 * フレームを受け取ったことだけで、指示そのものは**印を待って断られる**ことがある
 * （`Session::send_instruction_with`）。断りは遅れて届くので、そのときには本文も添付も
 * 消えている——設計§7-2 が「もう一度押せる」と約束しているのに、打ち直しと画像の
 * 選び直しが要る形になっていた。
 *
 * そこで**送ったものを控えておき、断りが届いたら戻す**。相関IDが線に無いので、
 * 「直後に届いた同じカードの断り」が本当にこの送信への返事かは**推測でしかない**——
 * だから [`RESTORE_WINDOW_MS`] の窓で区切る。
 *
 * **文言はここに出さない。** `SessionView` が `card-error` として既に出しているので、
 * 再掲すると同じ文が上下に2つ並ぶ。
 */

import { useEffect, useRef, useState } from 'react'
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
import { clearCardError, useCardError } from '@/stores/sessions'
import { useWsStore } from '@/stores/ws'

/**
 * 送ったものを控えておく長さ（ミリ秒）。
 *
 * 断りは**印の待ちの上限**（`attachment_mark_wait_ms`・既定5000）を待ってから返るので、
 * 既定の4倍の余裕を取る。**上限をこれより厚く設定した機械では戻らなくなる**が、それは
 * 「控えを取る前と同じ振る舞い」に落ちるだけで、新しい害は出ない。
 *
 * 窓で区切るのは、`ServerMessage::Error` に**相関IDが無い**ため。窓を外すと、
 * ずっと後で来た無関係な断り（権限モードの切替が断られた等）で古い本文が戻ってしまう。
 */
const RESTORE_WINDOW_MS = 20_000

/** 送ったものの控え。断りが届いたらこれを画面へ戻す。 */
interface 控え {
  text: string
  attachments: Attachment[]
  /** 窓を閉じるための時計。差し替え・解決・畳みのときに止める */
  timer: ReturnType<typeof setTimeout>
}

interface Props {
  /** 外から寸法を決める（帯へ横並びに置くため） */
  className?: string
  cardId: CardId
  status: SessionStatus
  /**
   * このカードを抱えている PC（画像添付 設計§9-2）。
   *
   * **必ず在る。** `hostOf()` は `agentId ?? LOCAL_HOST` を返すので、ローカルモードでも
   * 文字列（`"local"`）になる。**「宛先が分からないから口を出さない」という分岐は
   * 作らない**——`null` になる経路が無いので、書いても一度も通らない死んだ枝になる。
   *
   * **古い PC のカードでも口は出る。** 設計§4-1 は「名乗らない PC には出さない」と
   * 書いているが、そうは作っていない（ブラウザは `supports_blob_write` を読まない）。
   * 置く側が **409 で断る**ので、押した人には「いまのこの相手ではできない」が届く——
   * **同じ仕組みを使うファイル閲覧も口を隠していない**ので、そちらへ揃えてある。
   */
  host: string
  /**
   * 十字ボタンが出ている間は高さを詰める（十字ボタン設計§11）。
   *
   * **消さない。** 要素が消えると日本語の変換中の文字が復元できない——変換途中の
   * 文字は入力欄の値としてまだ確定していないため、消えた瞬間に取り戻す先が無くなる。
   * この判断が、判定を「迷ったら出す」側へ倒せる根拠になっている。
   */
}

export function Composer({ cardId, status, host, className = '' }: Props) {
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
  // 断りの並び。**文字列そのものを React の鍵にしない**——同じ名前のファイルを
  // 2つ落とすと鍵がぶつかって、片方しか出ない
  const [trouble, setTrouble] = useState<{ id: string; text: string }[]>([])
  // 送ったものの控え。**断られたら戻す**（設計§7-2）
  const 控え中 = useRef<控え | null>(null)
  const cardError = useCardError(cardId)
  const ended = isEnded(status)
  // 添付の口を出すかどうかは**終わっているか**だけで決まる。`host` は必ず在るので
  // 「宛先が分からない」という枝は作らない（作っても一度も通らない）
  const 添付できる = !ended

  /** 控えを畳む。**絵もここで捨てる**——捨てる場所を散らすと必ず取り残しが出る */
  const 控えを捨てる = () => {
    const held = 控え中.current
    if (held === null) {
      return
    }
    控え中.current = null
    clearTimeout(held.timer)
    for (const one of held.attachments) {
      releasePreview(one)
    }
  }

  // 断りが届いたら、送ったものを戻す（設計§7-2）。**文言は出さない**——
  // `SessionView` が `card-error` として既に出しているので、再掲すると2つ並ぶ
  useEffect(() => {
    const held = 控え中.current
    if (cardError === null || held === null) {
      return
    }
    控え中.current = null
    clearTimeout(held.timer)
    // **打ち直しの途中なら邪魔しない。** 押したあとに書き始めた文のほうが新しい
    if (text !== '' || attachments.length > 0) {
      for (const one of held.attachments) {
        releasePreview(one)
      }
      return
    }
    setText(held.text)
    setAttachments(held.attachments)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 断りが届いた瞬間だけ動かす
  }, [cardError])

  // 畳まれるときも控えを捨てる。**残すと `blob:` がブラウザの中に溜まる**
  useEffect(() => 控えを捨てる, [])

  // 置いたままの添付も、畳まれるときに捨てる。
  //
  // **控えとは別の集合である。** 控えは「送ったが断られるかもしれないぶん」で、こちらは
  // 「まだ送っていないぶん」——付けたまま別の画面へ移ると、こちらだけが残る。
  // 送った時点で `attachments` は空になり中身は控えへ移るので、**二重に捨てることは無い**。
  //
  // ref を経由するのは、後始末が**畳まれた瞬間の中身**を要るため。依存に
  // `attachments` を置くと、付け外しのたびに後始末が走って捨ててはいけないものまで捨てる
  const 置いたまま = useRef<Attachment[]>([])
  置いたまま.current = attachments
  useEffect(
    () => () => {
      for (const one of 置いたまま.current) {
        releasePreview(one)
      }
    },
    [],
  )

  /** 3経路の共通の入口。**判定は `pickImages` の1つを通る**（設計§9） */
  const 受け取る = (files: readonly File[]) => {
    if (!添付できる || files.length === 0) {
      return
    }
    const { accepted, rejected } = pickImages(files)
    setAttachments((now) => [...now, ...accepted])
    setTrouble(rejected.map((text) => ({ id: crypto.randomUUID(), text })))
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
          {
            id: crypto.randomUUID(),
            text: err instanceof Error ? err.message : '画像を置けませんでした',
          },
        ])
        return
      } finally {
        setSending(false)
      }
    }

    // **前の断りを消してから送る。** 残したままだと、同じ文言の断りが2回続いたときに
    // `useCardError` の値が変わらず、React から「届いた」ことが見えない
    // （`useSyncExternalStore` が `Object.is` で弾く）
    clearCardError(cardId)

    // **送れたときだけ消す。** 送れていない文が消えるのが、いちばん困る形
    if (!sendInput(cardId, text, paths)) {
      return
    }

    // **控えを取る。絵はまだ捨てない**（設計§7-2——断られたらそのまま戻せること）。
    // 前の控えが残っていれば、そちらはもう戻す相手が居ないので畳む
    控えを捨てる()
    控え中.current = {
      text,
      attachments,
      timer: setTimeout(控えを捨てる, RESTORE_WINDOW_MS),
    }

    setText('')
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
          {trouble.map((断り) => (
            <li key={断り.id}>{断り.text}</li>
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
