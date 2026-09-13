import { readFile } from '@/lib/hostfs'

/**
 * `~/.claude/stats-cache.json` を読んで画面に出せる形へ直す
 * （`statusコマンド相当の情報を画面から見えるようにする` 設計「引きの経路（Stats）」）。
 *
 * # 解析をブラウザ側に置く理由
 *
 * **「読めなければ黙って諦める」と決めている**ので、形が変わっても害は「画面が空になる」
 * だけである。閉じ込める必要が薄いぶん、出す側の近くに置いたほうが読みやすい。
 *
 * # これは非公開の内部ファイルである
 *
 * 公式ドキュメントに記載が無く、**版が上がると形が変わりうる**。だから
 * **知っているキーだけを取り出し、それ以外は見ない**——固定の並びで読むと、
 * キーが1つ増えただけで落ちる。【実測 2026-09-13】トップレベルは11キーで、
 * 調査の時点の記載は5つだった。**数は外れる前提で組む。**
 */

/** 1日ぶんの活動。**日付は文字列のまま持つ**——並べ替えと表示しかしないので。 */
export type DailyActivity = {
  date: string
  messageCount: number
  sessionCount: number
  toolCallCount: number
}

/**
 * モデル1つぶんの累計。
 *
 * **費用を持たない。** 【実測 2026-09-13】`costUSD` は **12モデルすべて `0`** で、
 * 埋まる条件が分からない。0 を出すと「使っていない」と読まれるので、
 * **欄ごと作らない**（設計「モデル別の価格表を持たない」）。
 */
export type ModelTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/** 画面に出すぶんだけ。**元の JSON をそのまま持ち回らない。** */
export type Stats = {
  /**
   * claude が数え直した日。
   *
   * **必ず画面へ併記する。** 【実測 2026-09-13】これが5日古かった。
   * 併記しないと、**古い数字が今の数字に見える。**
   */
  lastComputedDate: string
  totalSessions: number
  totalMessages: number
  /** 新しい日が先。 */
  dailyActivity: DailyActivity[]
  /** 使ったトークンが多い順。 */
  modelUsage: { model: string; totals: ModelTotals }[]
}

/**
 * 読む場所。
 *
 * **`~` のまま渡す。** ホームを知っているのは PC 側だけなので、ブラウザが絶対パスを
 * 組む道は無い（PC 側の `hostfs::read_file_from` が起点を組み立てる）。
 */
const STATS_PATH = '~/.claude/stats-cache.json'

/** 画面に出す日数。**全部出すと158日ぶん並ぶ**（実測）。 */
const DAYS_SHOWN = 14

function numberAt(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringAt(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 文字列を `Stats` へ直す。**解けなければ `null`。**
 *
 * **投げない。** 呼ぶ側は「出す／出さない」の2択しか持たないので、
 * 失敗の種類を伝えても使い道が無い（設計「読めなかったときは、面ごと出さない」）。
 *
 * **取得と分けてあるのは、壊れた中身を渡して確かめられるようにするため。**
 */
export function parseStats(text: string): Stats | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null

  const daily = Array.isArray(raw.dailyActivity) ? raw.dailyActivity : []
  const dailyActivity = daily
    .filter(isRecord)
    .map((entry) => ({
      date: stringAt(entry, 'date'),
      messageCount: numberAt(entry, 'messageCount'),
      sessionCount: numberAt(entry, 'sessionCount'),
      toolCallCount: numberAt(entry, 'toolCallCount'),
    }))
    .filter((entry) => entry.date !== '')
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, DAYS_SHOWN)

  const usage = isRecord(raw.modelUsage) ? raw.modelUsage : {}
  const modelUsage = Object.entries(usage)
    .filter((pair): pair is [string, Record<string, unknown>] => isRecord(pair[1]))
    .map(([model, totals]) => ({
      model,
      totals: {
        inputTokens: numberAt(totals, 'inputTokens'),
        outputTokens: numberAt(totals, 'outputTokens'),
        cacheReadInputTokens: numberAt(totals, 'cacheReadInputTokens'),
        cacheCreationInputTokens: numberAt(totals, 'cacheCreationInputTokens'),
      },
    }))
    .sort(
      (a, b) =>
        b.totals.inputTokens +
        b.totals.outputTokens -
        (a.totals.inputTokens + a.totals.outputTokens),
    )

  // **中身が1つも無いなら、解けたことにしない。** 形が変わって別の名前になった場合、
  // 空の面を出すより出さないほうがよい（設計「無いのが普通の環境がある」）
  if (dailyActivity.length === 0 && modelUsage.length === 0) return null

  return {
    lastComputedDate: stringAt(raw, 'lastComputedDate'),
    totalSessions: numberAt(raw, 'totalSessions'),
    totalMessages: numberAt(raw, 'totalMessages'),
    dailyActivity,
    modelUsage,
  }
}

/**
 * PC から読んで解析する。**読めなければ `null`。**
 *
 * **エラーを投げない。** 非公開の内部ファイルなので**「無いのが普通」の環境がある**
 * （`inject_status_line = false` の利用者、claude を入れ直した直後など）。
 * 投げると呼ぶ側が毎回 catch することになり、**無い環境で赤い知らせが出る。**
 */
export async function loadStats(host: string): Promise<Stats | null> {
  try {
    const content = await readFile(host, STATS_PATH)
    return parseStats(content.text)
  } catch {
    return null
  }
}
