/**
 * 発言を**誰が入れたか**で読み分けるための純関数
 * （`人が打っていないものを、人の発言として出さない` 設計§1・§6）。
 *
 * # ここに閉じる理由
 *
 * **既定への倒し込みを1箇所にする**（設計§2-5）。欄が来ないことがありうる
 * （古いサーバに新しい画面が繋がる形が `version restart` で実在する）ので、
 * `?? 'unmarked'` を部品の側に書き始めると**判断の在り処が2つになる**。
 *
 * `markdown.ts` の [`foldLinesFor`] が「対応表をここ1箇所に置くために、呼ぶ側は
 * しきい値ではなく種別を渡す」としているのと同じ作法である。
 */

import type { MessageOrigin, Node } from './protocol'

/**
 * 機械が入れたものを畳む行数（設計§6-6）。
 *
 * **利用者の指定は10行。** 根拠のある数ではないので、**実物を見て決め直せるよう
 * ここに置いてある**。
 */
export const MACHINE_FOLD_LINES = 10

/**
 * その発言の名乗り。**欄が無ければ「名乗り無し」**（設計§2-2）。
 *
 * `user_message` 以外は名乗りを持たないので、いつも「名乗り無し」を返す。
 */
export function originOf(node: Node): MessageOrigin {
  if (node.kind !== 'user_message') {
    return { kind: 'unmarked' }
  }
  return node.origin ?? { kind: 'unmarked' }
}

/**
 * 人が打っていないものか（設計§1-3）。
 *
 * **`unmarked` は人の側である。** 印が無いものを機械と読むことは要件が明示的に
 * 禁じている——ここを反転させると、人が打った `/clear` が琥珀になる。
 */
export function isMachine(node: Node): boolean {
  const origin = originOf(node)
  return origin.kind !== 'unmarked' && origin.kind !== 'human'
}

/**
 * 畳んだ見出しに出す名乗り（設計§1-1）。
 *
 * **種類ごとに名乗らせる**（利用者の指定）。1つに束ねると、開かないと出どころが
 * 分からない。
 *
 * 知らない名前は**その名前のまま出す**——丸めると記録が名乗ったことを捨てる（設計§2-3）。
 */
export function originLabel(origin: MessageOrigin): string {
  switch (origin.kind) {
    case 'peer':
      return origin.name ? `他セッションから（${origin.name}）` : '他セッションから'
    case 'task_notification':
      return 'サブエージェントの報告'
    case 'injected':
      return '差し込まれた文'
    case 'compact_summary':
      return '圧縮された要約'
    case 'sdk':
      return '起動時に渡された指示'
    case 'subagent_prompt':
      return 'サブエージェントへの指示'
    case 'interrupted':
      return '中断（人が止めた印）'
    case 'other':
      return origin.name
    default:
      return ''
  }
}

/**
 * 画面に出す本文。
 *
 * スラッシュコマンドは**打った形のうしろに展開後の中身を継ぐ**。こうすると
 * 「畳んだ頭＝打った形／開くと展開」が**既にある「続きを読む」の仕組みにそのまま乗る**
 * ——新しいトグルを作らない（設計§6-8）。
 *
 * **展開が無いほうが多数派**なので、そのときは打った形だけを返す（設計§3-4）。
 */
export function bodyTextOf(node: Node): string {
  if (node.kind !== 'user_message') {
    return 'text' in node ? node.text : ''
  }
  const expansion = node.command?.expansion
  return expansion ? `${node.text}\n\n${expansion}` : node.text
}
