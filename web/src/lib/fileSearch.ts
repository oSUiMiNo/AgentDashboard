/**
 * 開いているファイルの中だけを探す
 * （`ファイルビュアの中を Ctrl+F で探せるようにする` 要件）。
 *
 * # DOM を書き換えずに印を付ける
 *
 * `<mark>` を差し込む形にしない。整形した Markdown は `react-markdown` が組み立てた木
 * なので、そこへ要素を差し込むと**整形と取り合いになる**（次の再描画で消える・木の形が
 * 変わる）。
 *
 * 代わりに **CSS Custom Highlight API** を使う。`Range`（文字の範囲）に名前を付けて
 * 色を当てる仕組みで、**DOM を1つも変えない**。
 *
 * **無い環境では黙って何もしない。** jsdom には `CSS.highlights` が無いので、
 * ここが例外を投げると単体テストが1本残らず落ちる。**印が出ないだけで、件数と送りは
 * そのまま動く。**
 *
 * # 要素をまたいだ語にも当たる
 *
 * テキストノードを1つずつ探すと、`**太**字` のように整形で割れた語に当たらない。
 * **全部のテキストノードを1本に繋いでから探し、当たった位置を `(ノード, 何文字目)` へ
 * 戻す。** 戻すための表を持つのはそのためである。
 *
 * # 大文字小文字を畳むとき、長さを変えない
 *
 * `String.toLowerCase()` は**文字によって長さが変わる**（`İ` は2文字になる）。
 * 丸ごと畳むと**位置がずれて、当たりが1文字ぶん横へ動く**。だから1文字ずつ畳み、
 * **長さが変わる文字は畳まずに残す**——探せない文字が数個できるほうが、全部の位置が
 * ずれるより軽い。
 *
 * # 測る側と混ぜない
 *
 * 送り先の位置を出す [`scrollOffsetFor`] は、**矩形の数値だけを受け取る純関数**である。
 * `getBoundingClientRect` をこの中で呼ぶと、jsdom が矩形を固定で返すので**何も
 * 確かめないまま緑になる**（`lib/reorder.ts` と `lib/useReorder.ts` が同じ理由で
 * 分かれている）。
 */

/** 全部の当たりに付ける印の名前。 */
const ALL = 'file-find'
/** いま見ている1つに付ける印の名前。**上の印と重ねて出す。** */
const CURRENT = 'file-find-current'

/** 長さを変えずに大文字小文字を畳む。**位置がずれないことが唯一の条件。** */
function 畳む(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    const low = ch.toLowerCase()
    // 畳んだ結果が1文字でなければ、畳まずに残す（位置を守る）
    out += low.length === 1 ? low : ch
  }
  return out
}

/** 繋いだ本文の中の位置 → `(テキストノード, 何文字目)` へ戻すための表。 */
interface 索引 {
  nodes: Text[]
  /** `nodes[i]` が繋いだ本文の何文字目から始まるか */
  starts: number[]
  text: string
}

function 索引を作る(root: Node): 索引 {
  const doc = root.ownerDocument ?? globalThis.document
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const t = node as Text
    if (t.data === '') {
      continue
    }
    starts.push(text.length)
    nodes.push(t)
    text += t.data
  }
  return { nodes, starts, text }
}

/**
 * 繋いだ本文の `index` 文字目が、どのノードの何文字目かを引く。
 *
 * **末尾を引くときは1文字戻して探す。** 境目そのものを引くと「次のノードの0文字目」に
 * なり、当たりの終わりが**次の要素の頭**へ回り込む。
 */
function 引く(
  索引: 索引,
  index: number,
  端: 'start' | 'end',
): { node: Text; offset: number } | null {
  const 探す位置 = 端 === 'end' ? index - 1 : index
  let lo = 0
  let hi = 索引.nodes.length - 1
  let hit = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const start = 索引.starts[mid]!
    const end = start + 索引.nodes[mid]!.data.length
    if (探す位置 < start) {
      hi = mid - 1
    } else if (探す位置 >= end) {
      lo = mid + 1
    } else {
      hit = mid
      break
    }
  }
  if (hit < 0) {
    return null
  }
  return { node: 索引.nodes[hit]!, offset: index - 索引.starts[hit]! }
}

/**
 * 当たりを全部返す。**大文字小文字は区別しない**（要件で決着済み）。
 *
 * 空の語では**1つも返さない**——全文が当たりになると、打っている途中で毎打鍵ごとに
 * 画面じゅうへ印が付く。
 */
export function findMatches(root: Node, query: string): Range[] {
  if (query === '') {
    return []
  }
  const 索引 = 索引を作る(root)
  const hay = 畳む(索引.text)
  const needle = 畳む(query)
  if (needle === '') {
    return []
  }
  const doc = root.ownerDocument ?? globalThis.document
  const out: Range[] = []
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at < 0) {
      break
    }
    const s = 引く(索引, at, 'start')
    const e = 引く(索引, at + needle.length, 'end')
    if (s !== null && e !== null) {
      const range = doc.createRange()
      range.setStart(s.node, s.offset)
      range.setEnd(e.node, e.offset)
      out.push(range)
    }
    from = at + needle.length
  }
  return out
}

/** この環境で印を描けるか。**jsdom と古いブラウザでは偽。** */
export function supportsHighlight(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    CSS.highlights !== undefined &&
    typeof Highlight === 'function'
  )
}

/**
 * 印を塗り直す。**いま見ている1つだけを別の名前で塗る**ので、CSS 側で濃さを分けられる。
 *
 * `new Highlight(...ranges)` と展開しない——当たりが数千あるとそのまま引数の数になり、
 * **多いときだけ落ちる**形になる。
 */
export function paintMatches(ranges: Range[], current: number): void {
  if (!supportsHighlight()) {
    return
  }
  const 全部 = new Highlight()
  ranges.forEach((range, i) => {
    if (i !== current) {
      全部.add(range)
    }
  })
  CSS.highlights.set(ALL, 全部)

  const いま = ranges[current]
  if (いま === undefined) {
    CSS.highlights.delete(CURRENT)
  } else {
    CSS.highlights.set(CURRENT, new Highlight(いま))
  }
}

/** 印を消す。**窓を閉じたときとファイルを切り替えたときに必ず呼ぶ。** */
export function clearMatches(): void {
  if (!supportsHighlight()) {
    return
  }
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

/** [`scrollOffsetFor`] が要る矩形。`getBoundingClientRect` の一部だけを写す。 */
export interface 矩形 {
  top: number
  height: number
}

/**
 * 当たりを見せるための、遡る箱の新しい位置。**画面全体は動かさない**（要件）。
 *
 * **既に見えているなら動かさない。** 送るたびに真ん中へ寄せると、隣り合った当たりを
 * 行き来しただけで文章が上下に跳ねる。
 *
 * @param 箱 遡る箱（`file-body`）の矩形
 * @param 当たり いま見ている当たりの矩形
 * @param いまの位置 箱の `scrollTop`
 */
export function scrollOffsetFor(
  箱: 矩形,
  当たり: 矩形,
  いまの位置: number,
): number {
  const 上 = 当たり.top
  const 下 = 当たり.top + 当たり.height
  if (上 >= 箱.top && 下 <= 箱.top + 箱.height) {
    return いまの位置
  }
  // 箱の中での位置（＝いまの送り量 ＋ 画面上の差）
  const 箱の中 = いまの位置 + (上 - 箱.top)
  return Math.max(0, 箱の中 - (箱.height - 当たり.height) / 2)
}
