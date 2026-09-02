/**
 * サイドバーで**どこを見ていたか**を覚える（設計§3）。
 *
 * 覚えるのは2つ——**掘っていたフォルダ**と、**開いていたファイル**。どちらも React の
 * 状態にしかなく、読み込み直すと起点へ戻って中身の列が畳まれていた。
 * 手本は `lib/drafts.ts`（1つの鍵に表として持ち、上限を置く）と `lib/filesPanel.ts`
 * （`globalThis.localStorage?.` ＋ try/catch で必ず既定へ落とす）。
 *
 * # なぜ `lib/filesPanel.ts` へ足さないのか
 *
 * あちらは「**アプリ全体で1つ**」の族の置き場所として完結している。開閉と幅は
 * 「ファイルを見ながら作業する人かどうか」という**その人の癖**なので、どの枠を見ていても
 * 同じでよい。
 *
 * **場所はそうではない。** `/home/me/appA/src` という位置は別の PJT では意味を持たないし、
 * **同じパスが別の PC にもありうる**。粒度が違うものを同じファイルへ混ぜると、
 * どちらの族なのかが中で分からなくなる。
 *
 * # 行の鍵に `JSON.stringify([host, project])` を採る
 *
 * 今日は `host` に `/` も `:` も入りようが無い（`'local'` か UUID）。それでも
 * **区切り文字を選ばない形**にしておく——JSON が転義するので何が入っても衝突せず、
 * **読み戻せる**ので後から「消えた PJT の行だけ落とす」ができる。
 *
 * # 別のタブとは同期しない（**利用者判断・2026-09-03**）
 *
 * 幅と開閉は `storage` の合図を拾うが、**場所は拾わない**。あちらが「その人の癖」で
 * どのタブでも同じであるべきなのに対し、場所は**その窓でいま何をしているか**なので、
 * 窓ごとに違ってよい。別のタブで辿った先へ勝手に飛ぶと、**読んでいる最中に画面が動く**。
 *
 * したがって `storage` の購読はこのファイルに1つも無い。復元は**マウント時に読むだけ**で、
 * 書き込みは最後の1つが残る。
 *
 * # まとめて書かない
 *
 * `lib/drafts.ts` は打鍵をデバウンスして `pagehide` で吐き出すが、**こちらは写さない**。
 * 書くのは往復のあった移動と、ファイルを押した／閉じたときだけで、まとめる相手がいない。
 * 即時に書くので**書き残しが原理的に無い**。
 *
 * # `stores/` を読まない
 *
 * このリポジトリは `stores/` → `lib/` の一方向で、逆は1件も無い（`lib/drafts.ts` が
 * 同じことに気づいて訂正した経緯を残している）。`host` と `project` は**引数で受け取る**。
 */

import { isUnder } from '@/lib/hostfs'

const PLACE_KEY = 'agentdashboard.project-files-place'

/**
 * 覚えておく PJT の数。超えたら、**最後に触ってから最も古いもの**から落とす。
 *
 * `lib/drafts.ts` の `MAX_DRAFTS` に揃えてある。**揃える理由は「見えない場所に溜まる
 * ものの線を2つ持たない」こと**で、値そのものに強い根拠は無い（20〜50 はどれも成立する）。
 * 溢れて落ちた PJT は**今日の振る舞い（起点から始まる）に戻るだけ**で、壊れない。
 */
export const MAX_PLACES = 20

/**
 * 1つの PJT について覚えていること。
 *
 * **綴りを `folder` / `file` にしない。** `agentdashboard.project-files-width` が
 * 同じ形の表を持っており（あちらは**幅の数値**）、開発者ツールで並べたときに
 * 見分けが付かなくなる。`dir` / `pick` はコード側の名前（`path` と `picked`）に対応する。
 */
export interface Place {
  /** 掘っていたフォルダの絶対パス */
  dir: string | null
  /** 開いていたファイルの絶対パス */
  pick: string | null
}

/** 行の中身。読むときに1件ずつ確かめるので、置くときは緩く持つ */
type Row = { dir?: unknown; pick?: unknown }
type Table = Record<string, Row>

function 既定(): Place {
  return { dir: null, pick: null }
}

function 行の鍵(host: string, project: string): string {
  return JSON.stringify([host, project])
}

/**
 * 直前に解析した結果。**鍵は「読んだ生の文字列」そのもの。**
 *
 * PJT 専用画面は横並びのセッションを**カードの数だけ**描き、その全部が束ね役を呼ぶ。
 * マウント時の読みがカードの数だけ並ぶので、毎回 `JSON.parse` すると効いてくる。
 *
 * **`getItem` は毎回する（安い）。重い解析だけを省く。** 生の文字列が同じなら中身も
 * 同じなので、古いものを返す道が原理的に無い——表を持ち回すと、別のタブの書き換えや
 * `localStorage.clear()` に気づけなくなる（`storage` は自分の窓では飛ばない）。
 */
let 控え: { raw: string; table: Table } | null = null

/** 表を読む。**壊れていても落ちない**——読めなければ空として扱う。 */
function readTable(): Table {
  let raw: string | null = null
  try {
    raw = globalThis.localStorage?.getItem(PLACE_KEY) ?? null
  } catch {
    // 置けない設定のブラウザでも画面は動くべきなので、既定へ落とす
    return {}
  }
  if (raw === null) {
    return {}
  }
  if (控え !== null && 控え.raw === raw) {
    return 控え.table
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      // 1段目：**表ごと**捨てる
      return {}
    }
    const table: Table = {}
    for (const [key, row] of Object.entries(parsed)) {
      if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
        table[key] = row as Row
      }
      // 2段目：行が表でなければ**その行だけ**捨てる
    }
    控え = { raw, table }
    return table
  } catch {
    // 誰かが手で壊した／別の版が別の形で書いた。既定へ落とす
    return {}
  }
}

function writeTable(table: Table): void {
  try {
    globalThis.localStorage?.setItem(PLACE_KEY, JSON.stringify(table))
  } catch {
    // 置けない設定のブラウザ。**覚えられないだけで、その回の移動は成立している**
  }
}

/**
 * 覚えている値を1つ確かめる。**通らなければ `null`。**
 *
 * 往復の要らない門は、ここで全部通す。落とす理由は2つとも実害がある。
 *
 * - **起点の外**：外を復元するとパンくずが全段 `disabled` になり、**上へ戻れなくなる**
 * - **`..` を含む段**：`isUnder` は区切りこそ見るが**入力を正規化しない**。書く側が入れる
 *   値はサーバが解決した `result.path` なので正規化済みが保証されており、`..` が入りうるのは
 *   手で書き換えた場合だけ。だから**正規化は実装せず、段の一致だけで塞ぐ**
 */
function 通す(project: string, value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  if (value.split('/').includes('..')) {
    return null
  }
  if (!isUnder(project, value)) {
    return null
  }
  return value
}

/** その PJT について覚えていること。**確かめてから返す**ので、そのまま使ってよい。 */
export function readPlace(host: string, project: string): Place {
  const row = readTable()[行の鍵(host, project)]
  if (row === undefined) {
    return 既定()
  }
  // **1件ずつ確かめる。** 片方が壊れていても、もう片方は生かす
  return { dir: 通す(project, row.dir), pick: 通す(project, row.pick) }
}

/**
 * 行を書き換える。**行を消してから入れ直す**ので、触った PJT が末尾へ動く。
 *
 * JavaScript の object は同じ鍵へ書き直しても並びが変わらないため、末尾へ送るには
 * 一度消す必要がある。おかげで落ちるのは「最後に触ってから最も古い PJT」になる。
 */
function 書き換える(host: string, project: string, 差分: Row): void {
  const key = 行の鍵(host, project)
  // **控えを直接いじらない。** `readTable` は控えた表をそのまま返すことがある
  const table: Table = { ...readTable() }
  const 前 = table[key] ?? {}
  delete table[key]
  table[key] = { ...前, ...差分 }

  const keys = Object.keys(table)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PLACES))) {
    delete table[old]
  }
  writeTable(table)
}

/** 掘っていたフォルダを覚える。**`null` を渡したら忘れる。** */
export function putDir(host: string, project: string, dir: string | null): void {
  書き換える(host, project, { dir })
}

/** 開いていたファイルを覚える。**`null` を渡したら忘れる**（列を閉じたときがこれ）。 */
export function putPick(
  host: string,
  project: string,
  pick: string | null,
): void {
  書き換える(host, project, { pick })
}
