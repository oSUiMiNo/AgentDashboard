/**
 * 入力欄の書きかけ（下書き）を覚える（設計§11）。
 *
 * 十字ボタンが出ている間、入力欄は**畳むだけで消さない**。それでも画面を移ったり
 * 読み込み直したりすれば React の状態は消えるので、打ちかけの文がそこで失われる。
 * 手本は `lib/filesPanel.ts`（`globalThis.localStorage?.` ＋ try/catch で必ず既定へ落とす）。
 *
 * # 1つの鍵に表として持つ
 *
 * カードごとに鍵を作ると、**開いたカードの数だけ鍵が増える**。利用者から見えない場所
 * なので消す機会も無い。表にして上限（[`MAX_DRAFTS`]）を置けば、両方まとめて片付く。
 *
 * 書くたびに**鍵を置き直して末尾へ送る**ので、落ちるのは「最後に書いてから最も古いもの」に
 * なる（JavaScript の object は、同じ鍵へ書き直しても並びが変わらないため、一度消してから
 * 入れ直す必要がある）。
 *
 * # ログアウトでは消さない（**利用者判断・2026-08-14**）
 *
 * 何を守り、何と引き換えたかを書き残す。
 *
 * - **別のアカウントの人の画面に、前の人の書きかけが出てくる形は、もともと起きない。**
 *   鍵はカードIDで、カードはアカウントに紐づいており、別アカウントの人はそのカードを
 *   開けない（サーバが帰属で弾く）
 * - **残るのは「置きっぱなしのデータ」のほう。** 共有の機械では、利用者が打った生の文が
 *   `localStorage` に残り続け、開発者ツールから読める
 * - アカウントを鍵に混ぜても**この残り方は変わらない**。混ぜているのは表を分けるためで
 *   あって、守るためではない
 *
 * 利用者の判断で、便利さを採ってこれを受け入れた。**「守られている」と誤解しないこと。**
 *
 * # アカウントは引数で受け取る（**設計§11 からの訂正**）
 *
 * 設計は `useDraft(cardId)` と書いており、アカウントは中で `useAuthStore` から読む
 * つもりだった。**`lib/` から `stores/` を読むと依存の向きが逆流する**（このリポジトリは
 * `stores/` → `lib/` の一方向で、逆は1件も無い）。呼ぶ側は既にアカウントを持っているので、
 * 渡してもらう。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CardId } from '@/lib/protocol'

const PREFIX = 'agentdashboard.drafts.'

/** ローカルモードにはアカウントが無い。**番兵を置く**（鍵が `…drafts.` で終わらないように）。 */
const NO_ACCOUNT = 'local'

/** 覚えておく件数。超えたら、最後に書いてから最も古いものから落とす。 */
export const MAX_DRAFTS = 20

/** 書き出しをまとめる窓（ミリ秒）。1文字ごとに書かない。 */
export const WRITE_DEBOUNCE_MS = 300

type Table = Record<string, string>

function keyFor(account: string | null): string {
  return PREFIX + (account ?? NO_ACCOUNT)
}

/**
 * 直前に解析した結果。**鍵は「読んだ生の文字列」そのもの。**
 *
 * 表は打鍵のデバウンスごとにも読まれるので、毎回 `JSON.parse` すると
 * カードの数だけ積み上がる。かといって表を持ち回すと、**別のタブの書き換えや
 * `localStorage.clear()` に気づけない**——`storage` は自分の窓では飛ばない。
 *
 * **`getItem` は毎回する（安い）。重い解析だけを省く。** 生の文字列が同じなら
 * 中身も同じなので、古いものを返す道が原理的に無い。
 */
let 控え: { raw: string; table: Table } | null = null

/** 表を読む。**壊れていても落ちない**——読めなければ空として扱う。 */
function readTable(account: string | null): Table {
  let raw: string | null = null
  try {
    raw = globalThis.localStorage?.getItem(keyFor(account)) ?? null
  } catch {
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
      return {}
    }
    const table: Table = {}
    for (const [card, text] of Object.entries(parsed)) {
      if (typeof text === 'string') {
        table[card] = text
      }
    }
    控え = { raw, table }
    return table
  } catch {
    // 誰かが手で壊した／別の版が別の形で書いた。既定へ落とす
    return {}
  }
}

function writeTable(account: string | null, table: Table): void {
  try {
    globalThis.localStorage?.setItem(keyFor(account), JSON.stringify(table))
  } catch {
    // 置けない設定のブラウザ。**覚えられないだけで、その回の入力は成立する**
  }
}

/** そのカードの書きかけ。無ければ空。 */
export function readDraft(cardId: CardId, account: string | null): string {
  return readTable(account)[cardId] ?? ''
}

/** 書きかけを覚える。**空を渡したら忘れる**（送信に成功したときがこれ）。 */
export function putDraft(
  cardId: CardId,
  account: string | null,
  text: string,
): void {
  // **控えを直接いじらない。** `readTable` は控えた表をそのまま返すことがあるので、
  // ここで書き換えると「まだ書いていない中身」を控えが持つことになる
  const table = { ...readTable(account) }
  // 末尾へ送るために、一度消してから入れ直す
  delete table[cardId]
  if (text !== '') {
    table[cardId] = text
  }
  const cards = Object.keys(table)
  for (const old of cards.slice(0, Math.max(0, cards.length - MAX_DRAFTS))) {
    delete table[old]
  }
  writeTable(account, table)
}

/** そのカードの書きかけを忘れる（カードを外したとき）。 */
export function dropDraft(cardId: CardId, account: string | null): void {
  putDraft(cardId, account, '')
}

/**
 * 入力欄の書きかけ。**読み込み直しても、画面を移っても残る。**
 *
 * 書き出しは窓でまとめ、`pagehide` と片付けのときに必ず確定させる。`beforeunload` では
 * なく `pagehide` なのは、前者がモバイルで発火しないことがあるため（`lib/clientLogs.ts`
 * と同じ判断）。
 */
export function useDraft(
  cardId: CardId,
  account: string | null,
): [string, (text: string) => void] {
  const [text, setText] = useState(() => readDraft(cardId, account))
  /** まだ書き出していない値。`null` は「書くものが無い」 */
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 最後に読んだ相手。**初回は `useState` が読んでいる**ので、効果では読み直さない */
  const 読んだ相手 = useRef(`${cardId}::${account ?? ''}`)

  // 相手が変わったら読み直す。**入れ物を使い回すと、前のカードの文が出る**
  useEffect(() => {
    const 相手 = `${cardId}::${account ?? ''}`
    if (読んだ相手.current === 相手) {
      // 初回。**ここで読み直すと、開くたびに表を2回読むことになる**——横並びの
      // 画面ではカードの数だけ倍になる（12枚なら24回。コードレビュー対応14）
      return
    }
    読んだ相手.current = 相手
    setText(readDraft(cardId, account))
  }, [cardId, account])

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (pending.current === null) {
      return
    }
    putDraft(cardId, account, pending.current)
    pending.current = null
  }, [cardId, account])

  useEffect(() => {
    const onLeave = () => flush()
    globalThis.addEventListener('pagehide', onLeave)
    return () => {
      globalThis.removeEventListener('pagehide', onLeave)
      // 消えるときも書き切る。画面を移っただけで失われないため
      flush()
    }
  }, [flush])

  const update = useCallback(
    (next: string) => {
      setText(next)
      pending.current = next
      if (timer.current !== null) {
        clearTimeout(timer.current)
      }
      timer.current = setTimeout(() => {
        timer.current = null
        flush()
      }, WRITE_DEBOUNCE_MS)
    },
    [flush],
  )

  return [text, update]
}
