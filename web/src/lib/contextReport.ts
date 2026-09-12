/**
 * `/context` の報告を**読める形へ読み取る**（コンテキストの残量 設計§8）。
 *
 * # なぜ純関数なのか
 *
 * この PJT は「**決める側（純関数）と測る側（DOM を読む）を分ける**」型を採っている
 * （`reorder.ts` ／ `panelWidth.ts` ／ `roam.ts` ／ `fileTabs.ts`、そして
 * `contextUsage.ts`）。理由は実務的で、**jsdom は矩形を固定で返す**ので測る側と
 * 混ぜると**何も確かめないまま緑になる**。
 *
 * ここは `window` も `document` も読まない。**部品側は結果を受け取って描くだけ。**
 *
 * # 倒れ方
 *
 * **読めなければ `null` を返す。** 呼ぶ側は絵を出さず、原文だけを見せる
 * （`machineMessage.ts` の作法「読めなければ、元の字をそのまま返す。外したときに
 * **中身が消えるほうが、生のタグが出るより悪い**」と同じ側へ倒す）。
 *
 * **分類が当たったのに中身が読めない形**は起こりうる——claude の版が変わって
 * 見出しの字が変われば、`## Context Usage` で始まっていても中は読めない。
 */

/** 内訳の1行。 */
export type ContextCategory = {
  /** 分類の名前（例：`System prompt`）。 */
  name: string
  /** 使用量の表示（例：`4.3k`）。**数へ直さない**——単位ごと claude が決めた字を出す。 */
  tokens: string
  /** 全体に占める割合。帯の長さに使う。 */
  percent: number
}

/** `/context` の報告から読み取れたもの。 */
export type ContextReport = {
  /** モデルの名前。無ければ `null`（欄が欠けても報告そのものは成り立つ）。 */
  model: string | null
  /** 合計の表示（例：`241.5k / 1m`）。 */
  tokens: string
  /** 合計の使用率。 */
  percent: number
  /** 内訳。**空でもよい**——表が無い版でも、合計だけは出す値打ちがある。 */
  categories: ContextCategory[]
}

/**
 * 合計の行。実物は `**Tokens:** 241.5k / 1m (24%)`。
 *
 * **括弧の中の数字が主で、手前の実数は従**（要件「出す値は使用率を主、実数を従とする」）。
 */
const TOKENS_LINE = /^\*\*Tokens:\*\*\s*(.+?)\s*\((\d+)%\)\s*$/m

/** モデルの行。実物は `**Model:** claude-opus-5`。 */
const MODEL_LINE = /^\*\*Model:\*\*\s*(.+?)\s*$/m

/**
 * 内訳の表の1行。実物は `| System prompt | 4.3k | 0.4% |`。
 *
 * **区切りの行（`|---|---|---|`）と見出しの行は弾く**——前者は名前が `-` だけになり、
 * 後者は割合が数字にならないので、`Number.isFinite` で落ちる。
 */
const CATEGORY_ROW = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([\d.]+)%\s*\|\s*$/

/**
 * `/context` の報告を読み取る。読めなければ `null`。
 *
 * **合計が読めることを必須にする。** 内訳だけあっても、何に対する割合かが分からない
 * ので絵にならない。逆に**内訳が無くても合計が読めれば出す**——版が変わって表の形が
 * 変わっても、いちばん見たい数字は残る。
 */
export function readContextReport(text: string): ContextReport | null {
  const tokens = TOKENS_LINE.exec(text)
  if (!tokens) {
    return null
  }
  const percent = Number(tokens[2])
  if (!Number.isFinite(percent)) {
    return null
  }
  const model = MODEL_LINE.exec(text)
  return {
    model: model ? model[1] : null,
    tokens: tokens[1],
    percent,
    categories: readCategories(text),
  }
}

/** 内訳の表を読む。**読めた行だけを集める**——1行崩れても残りは出す。 */
function readCategories(text: string): ContextCategory[] {
  const found: ContextCategory[] = []
  for (const line of text.split('\n')) {
    const row = CATEGORY_ROW.exec(line)
    if (!row) {
      continue
    }
    const percent = Number(row[3])
    if (!Number.isFinite(percent)) {
      continue
    }
    found.push({ name: row[1], tokens: row[2], percent })
  }
  return found
}
