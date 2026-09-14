/**
 * ファイルビュアの書きかけ（未保存の編集）を覚える（`ファイルビュアにエディタ機能を追加` 設計§7）。
 *
 * # なぜ覚えるのか
 *
 * このダッシュボードの流儀は「**確認ダイアログで止める**」ではなく「**消えないように
 * 写しておく**」である。`lib/drafts.ts`（入力欄の文）と `lib/filesPlace.ts`（開いていた
 * タブ）が既に同じ形で解いており、**`beforeunload` は web 全体に1つも無い**
 * （`drafts.ts` と `clientLogs.ts` が**意図して `pagehide` を選んでいる**——
 * `beforeunload` はモバイルで発火しないことがあるため）。
 *
 * 編集中の中身は**文字列なので「写せる側」**である。ここへ写しておけば、
 * **タブを閉じる・別のファイルへ移る・版が切り替わってタブが読み直す**の
 * すべてが無害になり、門も確認も要らない。
 *
 * # ただし「写しておけば」は、呼ぶ側の義務である
 *
 * **この表は、置かれたものを覚えるだけで、置き忘れを埋めない。** 呼ぶ側が打鍵を
 * まとめて書く（窓を置く）なら、**まとめた途中で離れるときに確定させる責任も呼ぶ側にある**。
 *
 * `lib/drafts.ts` の `useDraft` が**3点セット**でその形を示している——**確定させる口**・
 * **`pagehide` で確定**・**片付けで確定**。**窓だけ置いて確定を置かないと、窓の幅ぶんが
 * 黙って消える**（実際にそうなっていた。フェーズ6で直した）。
 *
 * # `lib/filesPlace.ts` と同居させない（設計§7-1）
 *
 * あちらは「開いていたタブの並び」を覚える表で、**上限を超えると古いものから捨てる**。
 * **捨ててよいもの（どのタブを開いていたか）と、捨てると編集が消えるものを、同じ表に
 * 置かない。** 置くと、タブを 20 個開いた人の書きかけが黙って消える。
 *
 * # 鍵に PJT を混ぜない
 *
 * 同じファイルを PJT 専用画面から開いてもセッション専用画面から開いても、**同じ編集**で
 * あるべきである。混ぜると、片方で打った文がもう片方から見えない。
 */

const PREFIX = 'agentdashboard.file-edits.'

/** ローカルモードにはアカウントが無い。**番兵を置く**（鍵が `…file-edits.` で終わらないように）。 */
const NO_ACCOUNT = 'local'

/**
 * 覚えておく件数。超えたら、最後に書いてから最も古いものから落とす。
 *
 * **`drafts.ts` の `MAX_DRAFTS` と同じ数にしてある**が、別の表なので互いに押し出さない。
 */
export const MAX_EDITS = 20

/** 書き出しをまとめる窓（ミリ秒）。**1文字ごとに書かない。** */
export const WRITE_DEBOUNCE_MS = 300

export interface FileEditDetails {
  text: string
  baseStamp: string | null
}

type Table = Record<string, string | FileEditDetails>

function keyFor(account: string | null): string {
  return PREFIX + (account ?? NO_ACCOUNT)
}

/**
 * 表の中の1行を指す鍵。**ホストとパスだけで決まる。**
 *
 * 区切りに改行を使うのは、**どちらにも現れない**ためである（パスに `:` や `|` は入りうる）。
 */
export function editKey(host: string, path: string): string {
  return `${host}\n${path}`
}

/**
 * 直前に解析した結果。**鍵は「読んだ生の文字列」そのもの**（`drafts.ts` と同じ作法）。
 *
 * 生の文字列が同じなら中身も同じなので、**古いものを返す道が原理的に無い。**
 */
let 控え: { raw: string; table: Table } | null = null

/** 表を読む。**壊れていても落ちない**——読めなければ空として扱う。 */
function readTable(account: string | null): Table | null {
  let raw: string | null = null
  try {
    if (!globalThis.localStorage) return null
    raw = globalThis.localStorage.getItem(keyFor(account))
  } catch {
    // private window や設定でブロックされていると throw する。**書き戻しも止める**
    return null
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
      return {}
    }
    const table: Table = {}
    for (const [key, text] of Object.entries(parsed)) {
      if (typeof text === 'string') {
        table[key] = text
      } else if (
        typeof text === 'object' && text !== null && !Array.isArray(text) &&
        'text' in text && typeof text.text === 'string'
      ) {
        table[key] = {
          text: text.text,
          baseStamp: 'baseStamp' in text && typeof text.baseStamp === 'string' && text.baseStamp !== ''
            ? text.baseStamp : null,
        }
      }
    }
    控え = { raw, table }
    return table
  } catch {
    // 誰かが手で壊した／別の版が別の形で書いた。既定へ落とす
    return {}
  }
}

function writeTable(account: string | null, table: Table): boolean {
  try {
    if (!globalThis.localStorage) return false
    globalThis.localStorage.setItem(keyFor(account), JSON.stringify(table))
    return true
  } catch {
    // 置けない設定のブラウザ。**呼ぶ側へ失敗を戻し、その回の編集は保持する**
    return false
  }
}

/** 書きかけを読む。無ければ `null`（**空文字列と区別する**——空にしたのも編集である）。 */
export function readEdit(host: string, path: string, account: string | null): string | null {
  return readEditDetails(host, path, account)?.text ?? null
}

export function readEditDetails(
  host: string,
  path: string,
  account: string | null,
): FileEditDetails | null {
  const value = readTable(account)?.[editKey(host, path)]
  if (value === undefined) return null
  return typeof value === 'string' ? { text: value, baseStamp: null } : { ...value }
}

/**
 * 書きかけを置く。
 *
 * **鍵を置き直して末尾へ送る**ので、落ちるのは「最後に書いてから最も古いもの」になる
 * （JavaScript の object は同じ鍵へ書き直しても並びが変わらないため、**一度消してから
 * 入れ直す**必要がある）。
 */
export function putEdit(
  host: string,
  path: string,
  text: string,
  account: string | null,
  baseStamp?: string | null,
): boolean {
  const key = editKey(host, path)
  const existing = readTable(account)
  if (existing === null) return false
  const table = { ...existing }
  // 並びを更新するため、一度消してから入れ直す
  delete table[key]
  table[key] = { text, baseStamp: baseStamp || null }
  const keys = Object.keys(table)
  for (const 古い of keys.slice(0, Math.max(0, keys.length - MAX_EDITS))) {
    delete table[古い]
  }
  return writeTable(account, table)
}

/**
 * 書きかけを捨てる。
 *
 * **呼ぶのは「保存に成功したとき」と「編集を破棄したとき」だけ。**
 * **保存に失敗したときに呼んではいけない**——失敗した瞬間に編集が消える。
 */
export function dropEdit(host: string, path: string, account: string | null): boolean {
  const key = editKey(host, path)
  const table = readTable(account)
  if (table === null) return false
  if (!(key in table)) {
    return true
  }
  const next = { ...table }
  delete next[key]
  return writeTable(account, next)
}
