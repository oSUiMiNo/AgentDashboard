/**
 * 構造化ビューの本文を、マークダウンとして出すための道具（イシューグループ_2026-0813-2208 設計§3・§4）。
 *
 * ここが持つのは**判断だけ**で、描くのは [`TranscriptRow`]。画面を描かずに機械で
 * 確かめられる形にしてあるのは、`lib/keys.ts` や `lib/diff.ts` と同じ理由による。
 *
 * # 1. 長い本文を畳む
 *
 * 実物の履歴を数えると、アシスタントの本文は**中央値2行・p95 が41行・p99 が364行**で
 * （実効行数・幅80・n=40,177）、長いものだけが極端に長い。全部を出すと、その1件で
 * 画面が埋まる。
 *
 * **測るのは文字数ではなく行数である**（イシューグループ_2026-0820-2129 要望5）。読み手が
 * 受ける「長い」は**縦にどれだけ積まれたか**で決まり、表や囲みコードは少ない文字数で
 * 高さを食う。数え方は [`effectiveLines`]、畳むかどうかは [`foldDecision`] が決める。
 *
 * 畳むときに見せるのは「先頭 N 行を**整形したもの**」になるので、**切る位置が
 * マークダウンを壊す**のがいちばんの問題になる。素朴に切ると、閉じていない囲みコード
 * ブロックが後ろを全部飲む・表が表にならない、が起きる——そして**長い応答こそ
 * 畳まれる側**である。
 *
 * # 1-2. 行の文言も、ここが持つ
 *
 * まとめ行の文言（[`activitySummary`]）と、ツールコールの1行の名前（[`summarizeInput`]）も
 * ここに置いてある。**マークダウンの話ではない**が、どちらも**画面を描かずに機械で
 * 確かめられる判断**なので、部品側ではなくこちら側に居るのが「判断は純関数、描くのは
 * 部品」の分担に合う（設計§4-5）。
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
 * 実効行数を出すときの、1行の代表幅（イシューグループ_2026-0820-2129 設計§4-1）。
 *
 * **実際の画面の幅ではない。** 構造化ビューは単独画面では広く、PJT 専用画面の横並びでは
 * 狭い。どちらかに合わせると、**同じ本文が画面によって違うところで畳まれる**——
 * 「PC で読んだところ」がスマホで一致しなくなる。
 *
 * **この定数は脆くない。** 幅を60から120まで振っても、畳まれる割合はほとんど動かない
 * （実測・assistant 本文 n=40,177。しきい値70行で 3.50% ／ 3.28% ／ 3.17% ／ 3.09%）。
 * 選び方が結果を決めないので、**説明できる丸い数**として散文の1行の目安である 80 を採る。
 */
export const NOMINAL_COLUMNS = 80

/**
 * これを超えたら畳む、という実効行数（設計§4-2）。
 *
 * **要望は「畳まずに見せる量を、いまの2.5倍ほどに」。** 要望5 が「読み手が受ける『長い』は
 * 縦にどれだけ積まれたかで決まる」と言っているので、**2.5倍は高さ（行数）で読む。**
 *
 * いま見えているのは先頭1000文字で、それが占める実効行数は**中央値31行**（実測・
 * 1000文字を超える assistant 本文 n=2,409）。その2.5倍は 77.5行なので、丸めて **75行**
 * （いまの 2.42倍）とする。
 */
export const BODY_FOLD_LINES = 75

/**
 * これを超えたら、逆に少しだけ見せる（設計§4-3）。
 *
 * **長いほど短く畳まれるのは意図である。** 度を超えて長いものは「その長さに意味が無い
 * ことが多い」（利用者の判断）——どこかからコピペしただけで長くなっている可能性が高く、
 * いつもの長さまで出しても読まれない。**知らずに見ると「しきい値の計算が壊れている」に
 * 見えるので、直す前にここを読むこと。**
 *
 * 長さの分布に**明確な谷は無い**（実測。40行以降はなだらかな裾で、二山構造が無い）ので、
 * 谷を探し直さないこと。代わりに**説明できる置き方**をしてある——200行は assistant 本文の
 * **p98（実測 206行）**にあたり、1段目の約2.7倍である。
 */
export const BODY_FOLD_LINES_EXCESSIVE = 200

/** 2段目で見せる実効行数（設計§4-3。要望6 の「10行ほど」）。 */
export const BODY_FOLD_LINES_MINIMAL = 10

/**
 * 超過がこれ以下なら畳まない（設計§4-4）。
 *
 * > **畳んで縮む量が、畳む仕掛けの高さを上回らないなら、畳まない。**
 *
 * 仕掛けの高さは「続きを読む」の1行とフェードの帯で約3行。少し余裕を見て 5行としてある。
 *
 * **暫定。** 帯の高さは §6 を実際に敷いてみないと決まらないので、そこで合わせ直す。
 * **効くのは1段目だけ**で、2段目は定義上そこへ入る時点で超過が130行以上あるため当てない。
 */
export const BODY_FOLD_GRACE_LINES = 5

/**
 * 本文が縦にどれだけ積まれるかを、画面を描かずに数える（設計§4-1）。
 *
 * ```
 * 実効行数 ＝ Σ ceil(各行の文字数 ÷ NOMINAL_COLUMNS)
 * ```
 *
 * **空行も1行と数える**（縦の高さを食うため）。**画面の幅を一切見ない**——見てしまうと
 * 同じ本文が端末によって違うところで畳まれる（[`NOMINAL_COLUMNS`]）。
 *
 * **文字数で測っていたときに拾えなかったのは、改行を打たない長い散文**である。素朴に
 * 数えると1行だが、実際には代表幅で折り返して何行にもなる。
 */
export function effectiveLines(text: string): number {
  let total = 0
  for (const line of text.split('\n')) {
    total += line.length === 0 ? 1 : Math.ceil(line.length / NOMINAL_COLUMNS)
  }
  return total
}

/** [`foldDecision`] の答え。 */
export interface FoldDecision {
  /** 畳むか（＝「続きを読む」を出すか） */
  fold: boolean
  /** 畳むときに見せる実効行数。畳まないときは本文の実効行数がそのまま入る */
  lines: number
}

/**
 * 畳むかどうかと、畳むなら何行見せるかを決める（設計§4-2〜§4-4）。
 *
 * ```
 * 実効行数 →   〜75          76〜80         81〜200        201〜
 * 見せる量 →   全部          全部（猶予）   75行           10行
 * ```
 *
 * **2段目に猶予を当てない**のは、そこへ入る時点で超過が130行以上あるためである。
 */
export function foldDecision(text: string): FoldDecision {
  const total = effectiveLines(text)
  if (total > BODY_FOLD_LINES_EXCESSIVE) {
    return { fold: true, lines: BODY_FOLD_LINES_MINIMAL }
  }
  if (total > BODY_FOLD_LINES + BODY_FOLD_GRACE_LINES) {
    return { fold: true, lines: BODY_FOLD_LINES }
  }
  return { fold: false, lines: total }
}

/**
 * 畳む相手か（設計§4-6）。
 *
 * ストア側が全件に対して呼ぶ。**ここで実際に切らない**——数万件の履歴で全ノードぶんの
 * 文字列を作ることになる。切る仕事は、描くときで間に合う。
 */
export function shouldFoldBody(text: string): boolean {
  return foldDecision(text).fold
}

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
export function foldMarkdown(text: string, limit: number): FoldedBody {
  if (text.length <= limit) {
    return { head: text, folded: false }
  }
  return foldAt(text, limit)
}

/**
 * 本文を `lines` 行までに畳む（設計§4-5）。
 *
 * **切る位置の決め方は [`foldMarkdown`] と同じもの**を通す。変えたのは「何で測るか」だけで、
 * 行の切れ目へ戻すことも、囲みコードを閉じ直すことも、`…` を足さないことも変えていない。
 */
export function foldMarkdownByLines(text: string, lines: number): FoldedBody {
  if (effectiveLines(text) <= lines) {
    return { head: text, folded: false }
  }
  return foldAt(text, cutIndexForLines(text, lines))
}

/** 切る位置を決めて畳む。[`foldMarkdown`] と [`foldMarkdownByLines`] が共有する。 */
function foldAt(text: string, limit: number): FoldedBody {
  const cut = cutAtCodePoint(text, limit)
  const lastBreak = cut.lastIndexOf('\n')
  const backed = lastBreak >= 0 ? cut.slice(0, lastBreak) : ''
  // 戻した先が空＝1行目が limit より長い。戻す先が無いので、そのまま切る
  const head = backed.trim() === '' ? cut : backed

  return { head: closeFence(head), folded: true }
}

/**
 * 実効行数 `lines` ぶんに相当する文字数を返す。
 *
 * **1行が代表幅より長いときは、その行の途中で予算が尽きる。** そのぶんだけ取って返し、
 * 行の切れ目へ戻すのは [`foldAt`] に任せる——戻す規則を2箇所に置かないため。
 */
function cutIndexForLines(text: string, lines: number): number {
  let used = 0
  let index = 0

  for (const line of text.split('\n')) {
    const rows = line.length === 0 ? 1 : Math.ceil(line.length / NOMINAL_COLUMNS)
    if (used + rows > lines) {
      return index + Math.min(line.length, (lines - used) * NOMINAL_COLUMNS)
    }
    used += rows
    index += line.length + 1 // 落とした改行のぶん
  }
  return text.length
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

/**
 * まとめ行の文言を組み立てる材料（イシューグループ_2026-0820-2129 設計§3-1）。
 *
 * **名前を持つものと、持たないものがある。** ファイルには名前があるが、コマンドには
 * 短い名前が無い（コマンドそのものは長い）。だから前者は配列、後者は件数で受ける。
 */
export interface ActivitySummaryInput {
  /** 編集したファイルのパス（`Edit` ／ `Write` ／ `NotebookEdit`） */
  edited: string[]
  /** 実行したコマンドの件数（`Bash`） */
  ran: number
  /** 読み取ったファイルのパス（`Read`） */
  read: string[]
  /** その他のツールの件数 */
  used: number
  /** 未知のレコードの件数 */
  unknown: number
}

/** パスの末尾だけ。区切りは `/` と `\` の両方を見る（設計§3-1）。 */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut >= 0 ? path.slice(cut + 1) : path
}

/**
 * まとめ行の文言を作る（設計§3-1）。
 *
 * **ツール名を出さず、「やったこと」を日本語の過去形で書く。** 1つなら名前、複数なら件数。
 * ファイル名は**末尾だけ**にする（参考画面がそうなっており、行が長くならない）。
 *
 * **並びは固定する**——編集 → 実行 → 読み取り → その他 → 未知。**出た順にすると、同じ
 * 内容でも並びが変わって読み比べられない。**
 *
 * ```
 * 実行済み 5件のコマンド, 編集済み 2個のファイル
 * ```
 */
export function activitySummary(input: ActivitySummaryInput): string {
  const parts: string[] = []

  if (input.edited.length === 1) {
    parts.push(`編集済み ${baseName(input.edited[0])}`)
  } else if (input.edited.length > 1) {
    parts.push(`編集済み ${input.edited.length}個のファイル`)
  }
  // コマンドは1件でも件数で書く。短い名前が無いため（設計§3-1）
  if (input.ran > 0) {
    parts.push(`実行済み ${input.ran}件のコマンド`)
  }
  if (input.read.length === 1) {
    parts.push(`読み取り ${baseName(input.read[0])}`)
  } else if (input.read.length > 1) {
    parts.push(`読み取り ${input.read.length}個のファイル`)
  }
  if (input.used > 0) {
    parts.push(`使用済み ${input.used}個のツール`)
  }
  if (input.unknown > 0) {
    parts.push(`未知のレコード ${input.unknown}件`)
  }

  return parts.join(', ')
}

/**
 * ツールコールの入力から、1行の名前を作る（設計§3-3）。
 *
 * **`description` をいちばん先に見る。** `Bash` と `Agent` はこれを持っており、CLI が書いた
 * 文をそのまま見せるのがいちばん正直である。**訳さない**——参考画面の実物が
 * `Committed stale-name fixes` のように英語のまま出している。
 *
 * それ以外の順（`file_path` → `command` → `pattern` → `path` → `prompt`）は変えていない。
 * **`description` を先頭へ動かしただけ**で、関数を作り直してはいない。
 */
export function summarizeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return ''
  }
  const record = input as Record<string, unknown>
  // よく使うツールは「何に対して何をしたか」が1つの項目に入っている
  for (const key of ['description', 'file_path', 'command', 'pattern', 'path', 'prompt']) {
    const value = record[key]
    if (typeof value === 'string') {
      return value.replace(/\s+/g, ' ').slice(0, 200)
    }
  }
  return JSON.stringify(input).slice(0, 200)
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
