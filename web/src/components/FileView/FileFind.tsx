/**
 * 開いているファイルの中を探す窓
 * （`ファイルビュアの中を Ctrl+F で探せるようにする` 要件）。
 *
 * # 段を足さず、中身の上へ浮かせる
 *
 * `DESIGN.md` §39.4 が「**空の段を作らない**」と定めており、`FileView` はレールの中の
 * 列の中にある。**ヘッダの下に行を1本足すと、閉じている間ずっと空の段が残る。**
 *
 * ブラウザと VSCode がどちらも「中身の右上に浮かせる」形を採っているので、**利用者は
 * 既にこの置き場所を知っている**——説明が要らない。
 *
 * # 打鍵ごとには探さない
 *
 * 3 MiB まで開ける面なので、**1打鍵ごとに全文を走らせると打っている間に固まる**
 * （要件の完了条件）。少し待ってから探す。**待つのは探す側だけ**で、打った字は
 * すぐ出る。
 *
 * # 印は `lib/fileSearch.ts` が持つ
 *
 * ここは「何番目を見ているか」だけを持ち、**DOM は1つも書き換えない。**
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { ChevronGlyph, CloseGlyph } from '@/components/ui/glyphs'
import {
  clearMatches,
  findMatches,
  paintMatches,
  scrollOffsetFor,
} from '@/lib/fileSearch'
import { findKeyAction } from '@/lib/keys'

/** 打ってから探すまでの待ち（ミリ秒）。**打鍵の追従を止めない程度に短く。** */
const 待ち = 150

interface Props {
  /** 遡る箱（`file-body`）。**探す相手であり、送る相手でもある** */
  bodyRef: RefObject<HTMLDivElement | null>
  /**
   * 中身が変わったことを示す字。**変わったら探し直す。**
   *
   * パスと「生テキストかどうか」を混ぜたもの。整形と生テキストでは木の形が違うので、
   * 同じファイルでも当たりの位置が変わる。
   */
  contentKey: string
  /**
   * 探す合図の回数。**増えたら、入力を選び直して打ち直せる状態にする。**
   *
   * 窓が既に開いているときにもう一度 Ctrl+F を押したら打ち直せる、という探す窓の
   * 作法（要件の表）。**開いた回数ではなく合図の回数**なので、開いたままでも効く。
   */
  合図: number
  onClose: () => void
}

export function FileFind({ bodyRef, contentKey, 合図, onClose }: Props) {
  const [query, setQuery] = useState('')
  /** 待ってから写した語。**探すのはこちら** */
  const [探す語, set探す語] = useState('')
  const [matches, setMatches] = useState<Range[]>([])
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // 開いたときと、もう一度押されたとき。**選び直して打ち直せる状態にする**
  useEffect(() => {
    const 入力 = inputRef.current
    入力?.focus()
    入力?.select()
  }, [合図])

  // 打鍵から少し待って写す（上の「打鍵ごとには探さない」）
  useEffect(() => {
    const id = setTimeout(() => set探す語(query), 待ち)
    return () => clearTimeout(id)
  }, [query])

  // 探す。**中身が変わったときも探し直す**
  useEffect(() => {
    const box = bodyRef.current
    setMatches(box === null ? [] : findMatches(box, 探す語))
    setIndex(0)
  }, [bodyRef, 探す語, contentKey])

  // 印を塗り、いま見ている当たりまで箱を送る
  useEffect(() => {
    paintMatches(matches, index)
    const box = bodyRef.current
    const range = matches[index]
    if (box === null || range === undefined) {
      return
    }
    const 箱 = box.getBoundingClientRect()
    const 当たり = range.getBoundingClientRect()
    box.scrollTop = scrollOffsetFor(
      { top: 箱.top, height: 箱.height },
      { top: 当たり.top, height: 当たり.height },
      box.scrollTop,
    )
  }, [bodyRef, matches, index])

  // **閉じたら必ず消す。** 残すと、次に開いたファイルへ古い印が乗ったままになる
  useEffect(() => clearMatches, [])

  const 送る = (向き: 1 | -1) => {
    if (matches.length === 0) {
      return
    }
    // **端で止めずに回す。** 探す操作の慣例どおり、末尾の次は先頭
    setIndex((now) => (now + 向き + matches.length) % matches.length)
  }

  const 見つからない = 探す語 !== '' && matches.length === 0

  return (
    <div
      data-testid="file-find"
      /*
        **中身の右上へ浮かせる**（上の「段を足さず…」）。`z-10` は箱の中の中身より
        前に出るためで、外の層とは取り合わない。
      */
      /*
        **地は透かさない**（PJT ガイドライン「沈めるときに `opacity` を使わない」）。
        窓は**本文の上に浮く**ので、透かすと裏の字が透けて**窓の中の字と混ざる**。
        しかも混ざり方は「たまたま裏に何が来たか」で決まるので、**直した本人には
        再現しない形で読めなくなる。**
      */
      className="border-border bg-popover absolute top-2 right-3 z-10 flex items-center gap-1 rounded-lg border px-1.5 py-1 shadow-lg"
      onKeyDown={(event) => {
        const 手 = findKeyAction({
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          isComposing: event.nativeEvent.isComposing,
        })
        if (手 === null) {
          return
        }
        /*
          **外へ渡さない。** 一覧の `TileGrid` が画面全体の keydown で Esc を拾って
          選択を外している（いまは別の道なので同時には出ないが、**同じ画面へ来たときに
          「閉じたつもりで選択まで外れる」**）。窓の中の Enter も、指示の送信ではない
        */
        event.preventDefault()
        event.stopPropagation()
        if (手 === 'close') {
          onClose()
        } else {
          送る(手 === 'next' ? 1 : -1)
        }
      }}
    >
      <input
        ref={inputRef}
        data-testid="file-find-input"
        type="search"
        aria-label="このファイルの中を探す"
        placeholder="探す"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="text-foreground placeholder:text-muted-foreground h-6 w-32 min-w-0 bg-transparent px-1 text-xs outline-none"
      />
      <span
        data-testid="file-find-count"
        className={`shrink-0 px-1 text-[11px] tabular-nums ${
          見つからない ? 'text-amber-300' : 'text-muted-foreground'
        }`}
      >
        {見つからない
          ? '見つかりません'
          : matches.length === 0
            ? ''
            : `${index + 1} / ${matches.length}`}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid="file-find-prev"
        aria-label="前の当たりへ"
        title="前の当たりへ（Shift+Enter）"
        disabled={matches.length === 0}
        onClick={() => 送る(-1)}
      >
        <ChevronGlyph direction="up" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid="file-find-next"
        aria-label="次の当たりへ"
        title="次の当たりへ（Enter）"
        disabled={matches.length === 0}
        onClick={() => 送る(1)}
      >
        <ChevronGlyph direction="down" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid="file-find-close"
        aria-label="探すのをやめる"
        title="探すのをやめる（Esc）"
        onClick={onClose}
      >
        <CloseGlyph />
      </Button>
    </div>
  )
}
