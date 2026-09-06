import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/clipboard'

/**
 * 端末の中身を、**本物の文字**として並べる面（コピー設計§8）。
 *
 * # なぜ面を出すのか。端末そのものを選べるようにしないのか
 *
 * **できないから**である。端末は WebGL レンダラで canvas に描いており、DOM に文字が
 * 1つも無い。スマホの選択ハンドルもコピーのメニューも**OS が DOM の文字に対して出す
 * もの**なので、絵の上には出せない（コピー設計§2）。
 *
 * 前の版は xterm 自身の選択（`selectLines`）を長押しから動かした。**動いてはいたが、
 * 利用者には壊れて見えた**——1行に灰色の帯が付くだけで、範囲は伸ばせず、OS のメニューも
 * 出ない。**見た目だけ選択に似ていて中身が無い**ものは、無いより悪い。
 *
 * ここへ文字を出せば、長押しもハンドルも範囲選択もコピーのメニューも、**いつもどおり
 * 全部そのまま効く**。こちらが選択を作る必要すらない。
 *
 * # 画面いっぱいに出す。隅に置かない
 *
 * 前の版のコピーボタンは端末の右上に固定していた。**実測では 390×844 の窓に確かに
 * 出ており、覆われてもいなかった**（x=309・y=166）。それでも利用者は見ていない。
 *
 * 理由は**端末が 120 桁で、狭い画面では一文字が 6px にしかならない**こと。読むには
 * 必ず拡大する。3倍に拡大すると見えている範囲は 130×281 まで狭まり、**右上の的は
 * その外へ出る**（実測）。**拡大しなければ読めない面の隅に操作を置くと、読んでいる人には
 * 決して届かない。**
 *
 * だから面は画面いっぱいに出し、**操作は面の中に置く**。選ぶ操作そのものは OS が
 * 指の位置に出すので、そもそも固定された的を押しに行かなくてよい。
 */
interface Props {
  /** 並べる行。折り返しは繋いだあとのもの。 */
  lines: string[]
  /** 最初に見せる行（`lines` の添字）。長押しした行がここに来る。 */
  at: number
  onClose: () => void
}

export function TextSheet({ lines, at, onClose }: Props) {
  const 注目 = useRef<HTMLParagraphElement>(null)
  const [写し, set写し] = useState<'ok' | 'ng' | null>(null)

  // **開いた行を見せる。** 遡ったぶんも並ぶので、先頭のままだと押した場所が
  // 画面の外に居る。`block: 'center'` にするのは、前後の文脈ごと読めるようにするため
  useEffect(() => {
    注目.current?.scrollIntoView({ block: 'center' })
  }, [])

  // **Esc で閉じる。** 画面いっぱいを覆うので、閉じる道が押しにくいと閉じ込められる
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const 全部写す = async () => {
    set写し((await copyToClipboard(lines.join('\n'))) ? 'ok' : 'ng')
  }

  return (
    <>
      {/* 暗い幕。**押しても閉じない**——選ぼうとした指が幕に当たって消えるのは驚きになる */}
      <div aria-hidden className="fixed inset-0 z-40 bg-black/60" />
      <div
        data-testid="terminal-text-sheet"
        role="dialog"
        aria-label="端末の文字"
        className="bg-background fixed inset-0 z-50 flex flex-col sm:inset-x-auto sm:inset-y-8 sm:left-1/2 sm:w-[min(52rem,92vw)] sm:-translate-x-1/2 sm:rounded-xl sm:border sm:shadow-xl"
      >
        <header className="flex shrink-0 items-center gap-2 border-b p-3">
          <h2 className="flex-1 text-sm font-semibold">端末の文字</h2>
          {写し !== null && (
            <span
              role="status"
              aria-live="polite"
              data-testid="terminal-text-copy-result"
              className={写し === 'ok' ? 'text-xs' : 'text-destructive text-xs'}
            >
              {/*
                **写せなかったときの逃げ道は、この面そのものである。**
                `lib/clipboard.ts` は「偽を返したら呼ぶ側が逃げ道を必ず持つ」と定めて
                いるが、ここは**文字が既に選べる形で出ている**ので、別の入れ物へ
                出し直す必要が無い。**やり方を教えるだけでよい。**
              */}
              {写し === 'ok' ? '写しました' : '写せません。長押しで選んでください'}
            </span>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="terminal-text-copy"
            aria-label="端末の文字をすべてコピー"
            onClick={() => {
              void 全部写す()
            }}
          >
            全部コピー
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="terminal-text-close"
            aria-label="閉じる"
            onClick={onClose}
          >
            閉じる
          </Button>
        </header>
        {/*
          **ここが要件そのもの。** `select-text` を素のスタイルでも書いてあるのは、
          綴りを間違えても黙って効かなくなる指定だからで、こうしておけば単体テストから
          実際の値を読める（jsdom は CSS を読まないので、クラス名では効き目を測れない）。

          `touch-action` を絞らない。**端末の入れ物は `pan-x` で縦を握っているが、
          ここは普通の文章として繰りたい**ので、ブラウザに全部渡す。
        */}
        <div
          data-testid="terminal-text-body"
          style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
          className="flex-1 overflow-auto p-3 font-mono text-sm break-words whitespace-pre-wrap select-text"
        >
          {lines.map((line, i) => (
            <p
              // 同じ文字列の行はいくらでも出るので、位置を鍵にする
              key={i}
              ref={i === at ? 注目 : undefined}
              data-focused={i === at ? 'true' : undefined}
              className={i === at ? 'bg-muted rounded-sm' : undefined}
            >
              {/* 空行も高さを持たせる。潰れると段落の切れ目が消える */}
              {line === '' ? ' ' : line}
            </p>
          ))}
        </div>
      </div>
    </>
  )
}
