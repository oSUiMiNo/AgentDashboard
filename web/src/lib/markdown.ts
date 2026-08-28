/**
 * 構造化ビューの本文を、マークダウンとして出すための道具（イシューグループ_2026-0813-2208 設計§3・§4）。
 *
 * ここが持つのは**判断だけ**で、描くのは [`TranscriptRow`]。画面を描かずに機械で
 * 確かめられる形にしてあるのは、`lib/keys.ts` や `lib/diff.ts` と同じ理由による。
 *
 * # 1. 長い本文を畳む
 *
 * 実物の履歴を数えると、アシスタントの本文は**中央値 107文字・p99 が 1,461文字**で、
 * 長いものだけが極端に長い。全部を出すと、その1件で画面が埋まる。
 *
 * 畳むときに見せるのは「先頭 N 文字を**整形したもの**」になるので、**切る位置が
 * マークダウンを壊す**のがいちばんの問題になる。素朴に `slice(0, 1000)` すると、
 * 閉じていない囲みコードブロックが後ろを全部飲む・表が表にならない、が起きる
 * ——そして**長い応答こそ畳まれる側**である。
 *
 * # 2. `<br/>` を改行として出す
 *
 * 生の HTML は**字面として出す**方針にしてある（設計§4-1）。`FileView`（ファイル閲覧）は
 * `skipHtml` で消しているが、あちらには「生テキストで見る」という**確かめる先がある**。
 * 履歴には無いので、消すと利用者は消えたことに気づけない。
 *
 * そのうえで `<br/>` だけは「1行空ける」という**意味を持って書かれている**ので、
 * その意味どおりに改行として出す。
 *
 * # 3. 素の改行を改行として出す
 *
 * マークダウンの決まりでは、行の途中の改行（softbreak）は改行にならず、前後が空白1つで
 * 繋がる。**壊れているのではなく、マークダウンとして正しく出た結果**である。それでも
 * 打った側は「打ったとおりに見える」ことを期待するので、**期待のほうを採る**。
 *
 * # 改行の決まりは、2つある
 *
 * **名前が近いので取り違えやすい。** どちらも「改行を出す」だが、見る木も、変える相手も
 * 違う。**両方ともこのファイルに置いてある**ので、突き合わせるのに別の場所を開かなくてよい。
 *
 * | 何 | どの木を見るか | 何を変えるか |
 * |---|---|---|
 * | [`rehypeLineBreaks`] | **hast** の `raw` ノード | **`<br/>` というタグの字** |
 * | [`remarkSoftBreaks`] | **mdast** の `text` ノード | **素の改行（`\n`）** |
 *
 * 接頭辞（`rehype` ／ `remark`）が既に層の違いを示しているので、名前は変えない。
 */

import type { Element, Root, RootContent } from 'hast'
import type { Root as MdastRoot, RootContent as MdastContent } from 'mdast'
import remarkGfm from 'remark-gfm'

/**
 * ここを超えたら本文を畳む、という文字数。
 *
 * **文字数は目安でしかない。** 表や囲みコードは少ない文字数で高さを食い、長い散文は
 * 文字数のわりに読みやすい。高さで測る形は**整形してみないと高さが分からない**ので、
 * 描く前には決まらない。
 *
 * 画面の幅で変えないのは、**同じ履歴が端末によって違う畳まれ方をする**のを避けるため
 * （PC で読んだところまでが、スマホで一致しなくなる）。設定キーにしないのは、利用者が
 * 触る理由がまだ観測されていないため。
 */
export const BODY_FOLD_LIMIT = 1000

/** 畳んだ結果。 */
export interface FoldedBody {
  /** 実際に出す本文。畳んでいなければ元のまま */
  head: string
  /** 畳んだか（＝「続きを読む」を出すか） */
  folded: boolean
}

/** 囲みコードブロックの開始行（`` ``` `` ／ `~~~`。3連以上・字下げ3まで）。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * 本文を `limit` 文字までに畳む。
 *
 * 切る位置は**行の切れ目へ寄せる**。段落の切れ目まで戻すと、`limit` を超える段落が
 * 1つあるだけで**何も出せなくなる**。行で切れば、強調（`**`）や行内コード（`` ` ``）は
 * 行の中で閉じているので壊れない。
 *
 * **表の区切り行の直前で切れると表にならない**（`|` の行が字面で並ぶ）。これは許容する
 * ——戻す先をもう1つ増やすと切る位置の規則が2つになり、どちらが効いたのかを読む側が
 * 追えなくなる。そうなることは単体テストで固定してあるので、**知らずに壊れた状態とは
 * 区別できる**。
 *
 * **畳んだ印（`…`）は足さない。** 足すと整形の対象になり、記法の途中に入って崩れる。
 * 畳んでいることは「続きを読む」の操作そのものが示す。
 */
export function foldMarkdown(text: string, limit: number = BODY_FOLD_LIMIT): FoldedBody {
  if (text.length <= limit) {
    return { head: text, folded: false }
  }

  const cut = cutAtCodePoint(text, limit)
  const lastBreak = cut.lastIndexOf('\n')
  const backed = lastBreak >= 0 ? cut.slice(0, lastBreak) : ''
  // 戻した先が空＝1行目が limit より長い。戻す先が無いので、そのまま切る
  const head = backed.trim() === '' ? cut : backed

  return { head: closeFence(head), folded: true }
}

/**
 * `limit` 個ぶんの位置で切る。**符号位置の境目で切る**ので、絵文字を割らない。
 *
 * `String` の長さは UTF-16 の単位で数えるので、素の `slice(0, limit)` は
 * **サロゲートペアの途中で切れる**ことがある。切れると末尾に `�` が出る——
 * しかも**1行目がしきい値より長いときだけ**通る道なので、普通の本文では出ない。
 *
 * 境目まで戻すので、返る長さは `limit` 以下になる（最大1つぶん短い）。
 */
function cutAtCodePoint(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  // 切り口が下位サロゲートなら、その手前まで戻す
  const code = text.charCodeAt(limit)
  const 下位サロゲート = code >= 0xdc00 && code <= 0xdfff
  return text.slice(0, 下位サロゲート ? limit - 1 : limit)
}

/**
 * 開いたままの囲みコードブロックを閉じる。
 *
 * 開いた綴りをそのまま末尾へ足す。**綴りを固定しない**のは、`` ``` `` で開いたものを
 * `~~~` では閉じられず、4連で開いたものは3連では閉じられないため。数を数えて偶数奇数で
 * 決める形にしないのも同じ理由で、**`` ``` `` の中に現れる `~~~` は閉じ記号ではない**。
 */
function closeFence(text: string): string {
  let open: string | null = null

  for (const line of text.split('\n')) {
    const match = FENCE.exec(line)
    if (open === null) {
      if (match) {
        open = match[1]
      }
      continue
    }
    // 閉じられるのは、同じ文字で・開いたときと同じ長さ以上で・後ろに何も無い行だけ
    if (match && match[1][0] === open[0] && match[1].length >= open.length) {
      const rest = line.slice(line.indexOf(match[1]) + match[1].length)
      if (rest.trim() === '') {
        open = null
      }
    }
  }

  if (open === null) {
    return text
  }
  return text.endsWith('\n') ? `${text}${open}` : `${text}\n${open}`
}

/** [`splitLineBreaks`] が返す断片。 */
export type RawPiece =
  /** `<br>` 系のタグ。`br` 要素へ変える */
  | { kind: 'break' }
  /** それ以外。生のまま残す（あとで字面のテキストになる） */
  | { kind: 'raw'; value: string }

/** `<br>` ／ `<br/>` ／ `<br />`。大文字小文字は問わない。 */
const BREAK_TAG = /<br\s*\/?>/gi

/**
 * 生の HTML の断片を、`<br>` 系とそれ以外へ分ける。
 *
 * **1つの断片にタグと地の文が混ざる。** 段落の中の `<br/>` は「タグだけ」で届くが、
 * **行頭から始まる HTML は塊で1つ**になる（実測）。このリポジトリのドキュメントの作法
 * （`---` の下に `<br/>` を2行）はまさにその形で、`<br/>\n<br/>` が1つの断片で届く。
 *
 * したがって「断片がタグと一致するか」で判定してはいけない。**中を分ける。**
 */
export function splitLineBreaks(value: string): RawPiece[] {
  const pieces: RawPiece[] = []
  let index = 0

  BREAK_TAG.lastIndex = 0
  for (let match = BREAK_TAG.exec(value); match; match = BREAK_TAG.exec(value)) {
    if (match.index > index) {
      pieces.push({ kind: 'raw', value: value.slice(index, match.index) })
    }
    pieces.push({ kind: 'break' })
    index = match.index + match[0].length
  }
  if (index < value.length) {
    pieces.push({ kind: 'raw', value: value.slice(index) })
  }
  return pieces
}

/** hast の生 HTML ノード。`@types/hast` の本体には無く、`mdast-util-to-hast` が足す種別。 */
interface RawNode {
  type: 'raw'
  value: string
}

function isRaw(node: RootContent): node is RootContent & RawNode {
  return (node as { type: string }).type === 'raw'
}

function breakElement(): Element {
  return { type: 'element', tagName: 'br', properties: {}, children: [] }
}

/**
 * 生の HTML のうち、`<br>` 系だけを `br` 要素へ変える rehype プラグイン。
 *
 * `react-markdown` は `remark-rehype` を `allowDangerousHtml: true` で通し、**そのあとに**
 * `rehypePlugins` を適用する（実測）。だから生の HTML は `raw` としてここへ届く。
 *
 * 残した `raw` は `react-markdown` が**テキストノードへ落とす**ので、HTML が実行される道は
 * どこにも無い。**`rehype-raw` は入れない**——入れないこと自体が「任意の HTML を描く道が
 * 無い」の実体になっている。
 *
 * 依存を増やさないため `unist-util-visit` も使わず、素の再帰で歩く。
 */
export function rehypeLineBreaks() {
  return (tree: Root): void => {
    walk(tree)
  }
}

function walk(node: Root | Element): void {
  // 根と要素で children の型が違う（根だけ doctype を持てる）。歩き方は同じなので、
  // 広いほうへ寄せて扱う
  const children = node.children as RootContent[]
  const next: RootContent[] = []

  for (const child of children) {
    if (isRaw(child)) {
      for (const piece of splitLineBreaks(child.value)) {
        next.push(
          piece.kind === 'break' ? breakElement() : ({ ...child, value: piece.value } as RootContent),
        )
      }
      continue
    }
    if (child.type === 'element') {
      walk(child)
    }
    next.push(child)
  }

  ;(node as { children: RootContent[] }).children = next
}

/** [`splitSoftBreaks`] が返す断片。 */
export type SoftPiece =
  /** 素の改行。`break` ノードへ変える */
  | { kind: 'break' }
  /** それ以外。本文の字としてそのまま残す */
  | { kind: 'text'; value: string }

/**
 * 素の改行。**`\r` を落とすところまでを1つの綴りでやる。**
 *
 * `\n` だけで割ると、CRLF で書かれた本文では**割った断片の先頭に `\r` が残る**（実測。
 * 読んだ時点の `text` は `"あいう\r\nかきく"` のまま）。Windows で書かれた `.md` や
 * Windows から貼り付けた本文が普通に通る道なので、ここは端の話ではない。
 */
const SOFT_BREAK = /\r?\n/

/**
 * 本文の字を、改行のところで割る。
 *
 * **前後の空白は落とさない。** 続きの行の字下げは読んだ時点で既に落ちているので
 * （実測。`"あいう\n    かきく"` → `text("あいう\nかきく")`）、こちらで落とす仕事は無い。
 * 落とす処理を足すと、**意図して置いた空白まで消える**側の危険だけが残る。
 *
 * **空の断片はノードにしない。** 先頭や末尾が改行だと空文字列の断片ができるが、値の無い
 * `text` ノードは木のノイズにしかならない（描いた結果は同じ）。
 */
export function splitSoftBreaks(value: string): SoftPiece[] {
  const pieces: SoftPiece[] = []

  const lines = value.split(SOFT_BREAK)
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      pieces.push({ kind: 'break' })
    }
    if (line !== '') {
      pieces.push({ kind: 'text', value: line })
    }
  }
  return pieces
}

/**
 * 素の改行を `break` ノードへ変える remark プラグイン。
 *
 * **見るのは `text` ノードだけでよい。** mdast では、囲みコードは `code` ノードの値、生の
 * HTML は `html` ノードの値として**そもそも別の場所に居る**ので、`text` を歩いている限り
 * 触りようがない（実測。設計§4）。hast まで下りると `\n` はブロックの隙間にも `pre` の中の
 * コードそのものにも現れ、**木の形からは本文かどうかを区別できない**——[`rehypeLineBreaks`]
 * と層を分けているのはそのためである。
 *
 * 依存を増やさないため `unist-util-visit` も使わず、素の再帰で歩く（既存側と同じ）。
 */
export function remarkSoftBreaks() {
  return (tree: MdastRoot): void => {
    splitText(tree)
  }
}

function splitText(node: MdastRoot | MdastContent): void {
  // 子を持たないノード（`code` ／ `html` ／ `inlineCode` など）はここで終わる。
  // 歩き方は親の種別によらず同じなので、構造で見る
  const parent = node as { children?: MdastContent[] }
  if (parent.children === undefined) {
    return
  }

  const next: MdastContent[] = []
  for (const child of parent.children) {
    if (child.type === 'text') {
      for (const piece of splitSoftBreaks(child.value)) {
        next.push(piece.kind === 'break' ? { type: 'break' } : { ...child, value: piece.value })
      }
      continue
    }
    splitText(child)
    next.push(child)
  }

  parent.children = next
}

/**
 * マークダウンのプラグイン。**モジュールの定数として1度だけ作る。**
 *
 * `ReactMarkdown` はプラグインの配列の**同一性**を見て処理系を組み直すので、呼ぶたびに
 * `[remarkGfm]` と書くと、**中身が同じでも毎回作り直す**。履歴は流れている間フレームごとに
 * 通知が来るので、可視の行数ぶんの解析がそのまま乗る。
 *
 * **本文を出すところは、全部この2つを使う**（[`TranscriptRow`] の `MarkdownBody` と
 * [`FileView`]）。改行の見え方が場所によって違うと、同じ字を貼ったのに片方でだけ繋がる、
 * という説明のつかない差になる。
 *
 * [`remarkSoftBreaks`] を**いちばん後ろ**に置くのは、他のプラグインが組み立て終わった木に
 * 対して働かせるため。途中に挟むと「誰が作ったノードを見ているのか」が並びに依存して
 * 読めなくなる。
 */
export const REMARK_PLUGINS = [remarkGfm, remarkSoftBreaks]

/** 上と対。生の HTML の `<br/>` を `br` 要素へ変える段。 */
export const REHYPE_PLUGINS = [rehypeLineBreaks]
