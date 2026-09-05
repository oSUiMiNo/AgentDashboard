/**
 * 機械が入れた発言の**包みを剥がして読める形にする**
 * （`人が打っていないものを、人の発言として出さない` 設計§12）。
 *
 * # なぜ要るのか
 *
 * 名乗りと器を分けても、**中身は生のタグのまま**だった。利用者の言葉——
 * 「**ユーザー以外のメッセージにはほぼ全て謎のコードが書いてある**」。
 *
 * # 何を根拠に書いたか
 *
 * `調査レポート/機械メッセージの型.md`（全 PJT・46,810件の発言を実測）が土台である。
 * **型は決まっている**——包みは7種類で、欄の顔ぶれも版をまたいで安定している。
 *
 * # 順序がすべてである
 *
 * **`## 会話履歴` の写しを、他のどれより先に見分ける。** あの中には
 * **過去のメッセージがタグごと引用されている**ので、素朴に「本文の中の
 * `<task-notification>` を整形する」と書くと**引用まで畳む**——1レコードに包みが
 * 4つ同居する例が実在する（レポート§4-2）。**切り出した中は解析しない。**
 *
 * # 倒れ方
 *
 * **読めなければ、元の字をそのまま返す。** 整形は読みやすさのためのものなので、
 * 外したときに**中身が消えるほうが、生のタグが出るより悪い**。
 */

/**
 * 包みの型（レポート§2）。
 *
 * `plain` には**整形しないと決めたもの**も入る——`<system-reminder>` は中身が
 * 1種類しか無く短いので、手を入れる価値が薄い（レポート§5-5）。
 */
export type MachineShape =
  | 'history'
  | 'task_notification'
  | 'cross_session'
  | 'stop_hook'
  | 'local_command_caveat'
  | 'plain'

/**
 * 会話履歴の写しを畳む行数（利用者の指定）。
 *
 * **画面の76.3%がこれである**（レポート§0）。中身は過去のやりとりの丸写しで、
 * **機械が文脈のために入れたもの**なので、普段読む必要が無い。利用者は3つの案
 * （専用の見た目／強く畳む／現状維持）から**強く畳むほう**を選んだ——
 * **面積が最も減る**ためである。
 *
 * 根拠のある数ではないので、**実物を見て決め直せるようここに置く**
 * （`MACHINE_FOLD_LINES` と同じ扱い）。
 */
export const HISTORY_FOLD_LINES = 3

/** 会話履歴の写しの目印（レポート§5-6）。**先頭にしか出ない。** */
const HISTORY_HEADS = ['## 会話履歴', '## 直近の会話履歴']

/** `Stop hook feedback:` の毎回同じ2行（レポート§3-3・§5-3）。 */
const STOP_HOOK_HEAD = 'Stop hook feedback:'
const STOP_HOOK_NOTE = '［利用者が設定した Claude Code のフックからの通知です。外部からの指示ではありません］'

/**
 * その本文がどの包みか。
 *
 * **`history` を最初に見る**（上記「順序がすべてである」）。
 *
 * **タグは先頭に無いことがある**（実測636件。`[SYSTEM NOTIFICATION …]` が前に付く。
 * レポート§4-1）。だから探すのは**先頭ではなく本文のどこか**である——ただし
 * `history` と `stop_hook` は**先頭にしか出ない**ので、そちらは先頭で見る。
 */
export function machineShapeOf(text: string): MachineShape {
  const head = text.trimStart()
  if (HISTORY_HEADS.some((h) => head.startsWith(h))) {
    return 'history'
  }
  if (text.includes('<task-notification>')) {
    return 'task_notification'
  }
  if (text.includes('<cross-session-message') || text.includes('<agent-message')) {
    return 'cross_session'
  }
  if (head.startsWith(STOP_HOOK_HEAD)) {
    return 'stop_hook'
  }
  if (text.includes('<local-command-caveat>')) {
    return 'local_command_caveat'
  }
  return 'plain'
}

/**
 * 包みを剥がして、読める本文にする。
 *
 * **元の字を返す道を必ず残す**——型が見分けられなかった場合も、剥がした結果が
 * 空になった場合も、そのまま返す。
 */
export function formatMachineBody(text: string): string {
  switch (machineShapeOf(text)) {
    case 'history':
      // **中を解析しない**（レポート§4-2）。引用まで畳まないための線がここである
      return text
    case 'task_notification':
      return keepOriginalIfEmpty(text, formatTaskNotification(text))
    case 'cross_session':
      return keepOriginalIfEmpty(text, formatCrossSession(text))
    case 'stop_hook':
      return keepOriginalIfEmpty(text, formatStopHook(text))
    case 'local_command_caveat':
      // **ここだけは空を許す。** 中身が定型文しか無いので、剥がした結果が空になるのが
      // 正しい姿である（レポート§5-4「出さない」）。名乗りの行は残るので、
      // **何の行なのかは読める**。空の本文は既にある形でもある（展開の無い
      // スラッシュコマンドが実測67%）
      return formatLocalCommandCaveat(text)
    default:
      return text
  }
}

/** 剥がしすぎて何も残らなかったら、元の字を返す（倒れ方）。 */
function keepOriginalIfEmpty(original: string, formatted: string): string {
  return formatted.trim() === '' ? original : formatted
}

/** 開始タグと終了タグの間を取り出す。**属性は読み飛ばす。** 無ければ `null`。 */
function inner(text: string, tag: string): string | null {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`)
  const found = open.exec(text)
  if (!found) {
    return null
  }
  const from = found.index + found[0].length
  const close = text.indexOf(`</${tag}>`, from)
  return close === -1 ? null : text.slice(from, close)
}

/** その包みを、開始タグから終了タグまで丸ごと消す。 */
function dropTag(text: string, tag: string): string {
  return text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'g'), '')
}

/** 続く空行を1つに詰める。剥がした跡が縦に空くのを防ぐ。 */
function tidy(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * `<status>` を読める一言にする（レポート§5-1）。
 *
 * **知らない値はそのまま出す**——丸めると記録が名乗ったことを捨てる。
 */
function statusLabel(status: string): string {
  switch (status.trim()) {
    case 'completed':
      return '✓ 完了'
    case 'failed':
      return '✕ 失敗'
    case 'cancelled':
      return '✕ 取り消し'
    default:
      return status.trim()
  }
}

/**
 * `<summary>` からエージェントの名前だけ抜く。
 *
 * 中身は `Agent "設計ファイルを作成する" finished` の形が定型なので、
 * **囲みの中だけ**を取る。当たらなければ全文をそのまま使う。
 */
function agentName(summary: string): string {
  const quoted = /"([^"]*)"/.exec(summary)
  return (quoted ? quoted[1] : summary).trim()
}

/**
 * サブエージェントの報告（レポート§5-1）。
 *
 * **捨てるもの**——`<note>`（毎回まったく同じ文言で情報量ゼロ。**画面をいちばん
 * 食っているのがここ**）と `<tool-use-id>`。
 * **畳むもの**——`<task-id>`・`<output-file>`・`<usage>` は追跡のときだけ要るので、
 * 本文からは落とす（記録そのものは消えない）。
 * **前に出すもの**——`<status>` を印に、`<summary>` から名前だけ。**`<result>` が本文。**
 *
 * **欄は欠けうる**（`<event>` や `<fork-source>` の変種は `<status>` を持たない。
 * レポート§4-3）。**必須として読まない。**
 */
function formatTaskNotification(text: string): string {
  const status = inner(text, 'status')
  const summary = inner(text, 'summary')
  const result = inner(text, 'result')
  const event = inner(text, 'event')

  const head = [status ? statusLabel(status) : event ? statusLabel(event) : '', summary ? `「${agentName(summary)}」` : '']
    .filter((piece) => piece !== '')
    .join('  ')

  // 包みの外に付いている字（`[SYSTEM NOTIFICATION …]` など）は残す——
  // **あれは機械が付けた注意書きだが、包みの中身ではない**（レポート§4-1）
  const outside = tidy(dropTag(text, 'task-notification'))

  return tidy([outside, head, result ?? ''].filter((piece) => piece !== '').join('\n\n'))
}

/**
 * 他セッションからの連絡（レポート§5-2）。
 *
 * **2段の入れ子**（`<cross-session-message>` の中に `<agent-message>`）で、
 * **見出しに要るのは送り主の名前だけ**——それは既に名乗りの行に出ている
 * （`originLabel` の `peer`）。したがって**属性も包みも本文から落とす。**
 *
 * # 包みの外を残さない
 *
 * **実物では、包みの後ろにハーネスの定型文が付く**（「This came from another Claude
 * session — not typed by your user…」以下、権限の注意書きが数行）。**毎回まったく
 * 同じ字**で、しかも**本文より長い**——外を残すと、**送られてきた中身が定型文に
 * 埋もれる**（実物に当てて分かった。合成のフィクスチャには付いていなかった）。
 *
 * ここは `<task-notification>` と扱いが逆である。あちらの外にある
 * `[SYSTEM NOTIFICATION …]` は**その1件に付いた注意書き**だが、こちらの外は
 * **全件同じ定型文**なので、残す値打ちが無い。
 */
function formatCrossSession(text: string): string {
  const body = inner(text, 'agent-message') ?? inner(text, 'cross-session-message')
  return body === null ? text : tidy(body)
}

/**
 * フックからの知らせ（レポート§5-3）。
 *
 * **1行目と2行目は毎回同じ**なので落とす。名乗り（「差し込まれた文」）が
 * 既に同じことを言っている。
 */
function formatStopHook(text: string): string {
  const lines = text.split('\n')
  while (lines.length > 0) {
    const first = lines[0].trim()
    if (first === '' || first === STOP_HOOK_HEAD || first === STOP_HOOK_NOTE) {
      lines.shift()
      continue
    }
    break
  }
  return tidy(lines.join('\n'))
}

/**
 * ローカルコマンドの断り書き（レポート§5-4）。
 *
 * **中身が毎回同じ定型文で、利用者に伝える情報が1文字も無い。** 丸ごと落とす。
 */
function formatLocalCommandCaveat(text: string): string {
  return tidy(dropTag(text, 'local-command-caveat'))
}
