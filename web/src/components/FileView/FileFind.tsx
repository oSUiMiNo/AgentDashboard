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

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { ChevronGlyph, CloseGlyph } from '@/components/ui/glyphs'
import {
  clearMatches,
  findMatches,
  findTextMatches,
  paintMatches,
  scrollOffsetFor,
  type FileSearchAdapter,
} from '@/lib/fileSearch'
import { findKeyAction } from '@/lib/keys'

/** 打ってから探すまでの待ち（ミリ秒）。**打鍵の追従を止めない程度に短く。** */
const 待ち = 150

interface Props {
  /** 遡る箱（`file-body`）。**探す相手であり、送る相手でもある** */
  bodyRef: RefObject<HTMLDivElement | null>
  searchRef?: RefObject<HTMLElement | null>
  searchApiRef?: RefObject<FileSearchAdapter | null>
  /**
   * プレビューの箱。**渡されたときは、こちらが探すのではなく箱の中の係へ頼む。**
   *
   * # なぜ2通りあるのか
   *
   * 箱（`iframe`）は `allow-same-origin` を持たないので**別の出自を名乗る**——
   * 親からは中の文書に1バイトも触れない。**これは隔離が効いている証拠**であって、
   * 直すべき不具合ではない。だから**中に置いた係へ便りで頼み、数だけ受け取る**。
   *
   * 整形 Markdown と生テキストは同じ画面の中なので、いままでどおり直に探す。
   */
  frameRef?: RefObject<HTMLIFrameElement | null>
  /**
   * 打つ層（`<textarea>`）。**渡されたときは、DOM を遡らずに値の中を探す。**
   *
   * # なぜ3通り目が要るのか
   *
   * 打つ層の中身は**値**であって文字節点ではないので、`bodyRef` を遡っても当たらない。
   * 遡ると代わりに**行番号**と**色付きの `<pre>`** に当たってしまう——番号は探す相手
   * ではないし、`<pre>` は色付けのたびに作り直されるので**張った `Range` がすぐ無効
   * になる**。
   *
   * **値の中の位置で持ち、`setSelectionRange` で示す**と、どちらも起きない。
   */
  editorRef?: RefObject<HTMLTextAreaElement | null>
  /**
   * 打つ層に出ている字。**`editorRef` と対で渡す。**
   *
   * 値は打鍵のたびに変わるが、`editorRef.current.value` を見るだけでは**変わったこと
   * に気づけない**（参照は同じままなので、効果が動かない）。だから字そのものを受け取る。
   */
  本文?: string
  /**
   * 中身が変わったことを示す字。**変わったら探し直す。**
   *
   * パスと**どちらのモードで見ているか**を混ぜたもの。見る姿と編集する姿では木の形が
   * 違うので、同じファイルでも当たりの位置が変わる。
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

export function FileFind({
  bodyRef,
  searchRef,
  searchApiRef,
  frameRef,
  editorRef,
  本文,
  contentKey,
  合図,
  onClose,
}: Props) {
  const adapterで探す = searchApiRef !== undefined
  /** 箱の中の係へ頼む形か。**渡された時点で決まる** */
  const 箱に頼む = !adapterで探す && frameRef !== undefined
  /** 打つ層の値を探して選択で示す形か。**`frameRef` と同じく渡された時点で決まる** */
  const 打つ層で示す = !adapterで探す && editorRef !== undefined
  const [query, setQuery] = useState('')
  /** 待ってから写した語。**探すのはこちら** */
  const [探す語, set探す語] = useState('')
  const [matches, setMatches] = useState<Range[]>([])
  /**
   * 打つ層のときの当たり。**位置の対で持つ**（`Range` ではない）。
   *
   * **型をどちらか一方に畳まなかった。** `Range` と位置の対は別の種類のもので、
   * union にすると受け取る側が毎回ふるい分けることになる——`paintMatches` は
   * `Range[]` しか受け取らないので、畳んでも結局そこで割れる。**道ごとに別の状態を
   * 持つほうが、どちらの筋も真っ直ぐ読める。**
   */
  const [文字の当たり, set文字の当たり] = useState<[number, number][]>([])
  const [adapterResult, setAdapterResult] = useState<{ adapter: FileSearchAdapter | null; total: number }>({ adapter: null, total: 0 })
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

  /**
   * 待ってから写した本文。**探す相手はこちら。**
   *
   * **打つたびに探し直さない。** 色付けと同じ理由で、打鍵のたびに全文を走査すると
   * 長い文書で打鍵が重くなる。**打っている間は件数が古くてよく、止まったら正しい
   * 件数へ落ち着く**（テスト計画 7-3）。
   */
  const [待った本文, set待った本文] = useState(本文 ?? '')
  useEffect(() => {
    const id = setTimeout(() => set待った本文(本文 ?? ''), 待ち)
    return () => clearTimeout(id)
  }, [本文])

  /** 箱の中の係が答えた当たりの数。**箱に頼む形のときだけ意味を持つ** */
  const [箱の総数, set箱の総数] = useState(0)
  /**
   * 最後に頼んだ内容。**係が起きたと言ってきたら、これをもう一度撃つ。**
   *
   * **撃ちっぱなしにできない。** 箱は作り直されることがあり（生テキストと行き来した
   * とき）、**係が起きる前に撃った便りはどこにも届かず消える**——以後は答えが来ない
   * ので、語が確実に在る文書でも「見つかりません」が出続ける。
   */
  const 最後の依頼 = useRef<{ query: string; index: number }>({
    query: '',
    index: 0,
  })

  /** 箱の中の係へ頼む。**答えは便りで返る** */
  const 箱へ頼む = useCallback((query: string, index: number) => {
    最後の依頼.current = { query, index }
    frameRef?.current?.contentWindow?.postMessage(
      { __fileFind: 'search', query, index },
      '*',
    )
  }, [frameRef])

  /*
    **箱からの便りを受ける。**

    **窓の中の文書は利用者の手元の任意の HTML** なので、そこの script も同じ窓から
    便りを送れる。**こちらは数しか読まない**（当たりの数と何番目か）ので、嘘の便りで
    起こせるのは「件数の表示が狂う」までである——**中身を実行する道は1つも開けていない。**
  */
  useEffect(() => {
    if (!箱に頼む) {
      return
    }
    const 受ける = (event: MessageEvent) => {
      if (event.source !== frameRef?.current?.contentWindow) {
        return
      }
      const 便り: unknown = event.data
      if (便り === null || typeof 便り !== 'object') {
        return
      }
      const 種 = (便り as { __fileFind?: unknown }).__fileFind
      if (種 === 'ready') {
        // **係が起きた。** 起きる前に撃ったぶんが消えているので、撃ち直す
        const 依頼 = 最後の依頼.current
        if (依頼.query !== '') {
          箱へ頼む(依頼.query, 依頼.index)
        }
        return
      }
      if (種 !== 'result') {
        return
      }
      const 数 = (便り as { total?: unknown }).total
      const 何番目 = (便り as { index?: unknown }).index
      set箱の総数(typeof 数 === 'number' && Number.isFinite(数) ? Math.max(0, 数) : 0)
      if (typeof 何番目 === 'number' && Number.isFinite(何番目)) {
        setIndex(Math.max(0, 何番目))
      }
    }
    globalThis.addEventListener('message', 受ける)
    return () => globalThis.removeEventListener('message', 受ける)
  }, [箱に頼む, frameRef, 箱へ頼む])

  // 探す。**中身が変わったときも探し直す**
  useEffect(() => {
    if (searchApiRef !== undefined) {
      const adapter = searchApiRef.current
      setAdapterResult({ adapter, total: adapter?.search(探す語) ?? 0 })
      setIndex(0)
      return () => adapter?.clear()
    }
    if (箱に頼む) {
      箱へ頼む(探す語, 0)
      return
    }
    if (打つ層で示す) {
      // **値の中を探す。** DOM を遡ると行番号と色の層に当たる
      set文字の当たり(findTextMatches(待った本文, 探す語))
      setIndex(0)
      return
    }
    const box = searchRef === undefined ? bodyRef.current : searchRef.current
    setMatches(box === null ? [] : findMatches(box, 探す語))
    setIndex(0)
  }, [箱に頼む, 打つ層で示す, frameRef, bodyRef, searchRef, searchApiRef, 探す語, 待った本文, contentKey, 箱へ頼む])

  useEffect(() => {
    if (adapterで探す && adapterResult.total > 0) adapterResult.adapter?.show(index)
  }, [adapterで探す, adapterResult, index])

  /*
    **打つ層では、選択で示して打つ層を送る。**

    **印（CSS の Highlight）は使わない。** 当たりを持っているのは値の中の位置であって
    DOM の範囲ではないし、下に敷いた色の層は**色付けのたびに作り直される**——塗っても
    次の色付けで消える。**選択なら、色付けが何度走っても残る**（この道を選んだ理由）。

    **送るのは打つ層だけ。** 色の層は `transform` で追いかけているので、そちらを直接
    動かすと次の送りで上書きされ、**一瞬だけ合ってすぐずれる**。
  */
  useEffect(() => {
    if (!打つ層で示す) {
      return
    }
    // **見る姿の印が残らないように消す**（モードを行き来したときの取り残し）
    clearMatches()
    const 打つ = editorRef?.current
    const 当たり = 文字の当たり[index]
    if (打つ == null || 当たり === undefined) {
      return
    }
    打つ.focus()
    打つ.setSelectionRange(当たり[0], 当たり[1])
    // **行の高さは実測から割り出す。** 器から取った字の大きさに追随させるため
    const 全行 = 待った本文.split('\n').length
    const 行の高さ = 打つ.scrollHeight / Math.max(1, 全行)
    const 行 = 待った本文.slice(0, 当たり[0]).split('\n').length - 1
    打つ.scrollTop = scrollOffsetFor(
      { top: 0, height: 打つ.clientHeight },
      { top: 行 * 行の高さ - 打つ.scrollTop, height: 行の高さ },
      打つ.scrollTop,
    )
  }, [打つ層で示す, editorRef, 文字の当たり, index, 待った本文])

  // 印を塗り、いま見ている当たりまで箱を送る。**箱に頼む形では係がやる**
  useEffect(() => {
    if (adapterで探す || 箱に頼む || 打つ層で示す) {
      return
    }
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
  }, [adapterで探す, 箱に頼む, 打つ層で示す, bodyRef, matches, index])

  /*
    **閉じたら必ず消す。** 残すと、次に開いたファイルへ古い印が乗ったままになる。

    **箱に頼む形では、印を持っているのは箱の中の係である**——こちら側だけを消すと、
    窓を閉じてもプレビューに印が乗ったままになる。**空の語を1通送って消させる。**
  */
  useEffect(() => {
    if (adapterで探す) return
    const frame = frameRef?.current?.contentWindow
    return () => {
      clearMatches()
      frame?.postMessage(
        { __fileFind: 'search', query: '', index: 0 },
        '*',
      )
    }
  }, [adapterで探す, frameRef])

  /** いま何件当たっているか。**3通りのどの形でも同じ言い方にする** */
  const 総数 = adapterで探す
    ? adapterResult.total
    : 箱に頼む
      ? 箱の総数
      : 打つ層で示す
        ? 文字の当たり.length
        : matches.length

  const 送る = (向き: 1 | -1) => {
    if (総数 === 0) {
      return
    }
    // **端で止めずに回す。** 探す操作の慣例どおり、末尾の次は先頭
    const 先 = (index + 向き + 総数) % 総数
    if (箱に頼む) {
      // **番号はこちらが決め、塗るのは係。** 答えの便りで `index` が確定する
      箱へ頼む(探す語, 先)
      return
    }
    setIndex(先)
  }

  const 見つからない = 探す語 !== '' && 総数 === 0

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
          : 総数 === 0
            ? ''
            : `${index + 1} / ${総数}`}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid="file-find-prev"
        aria-label="前の当たりへ"
        title="前の当たりへ（Shift+Enter）"
        disabled={総数 === 0}
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
        disabled={総数 === 0}
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
