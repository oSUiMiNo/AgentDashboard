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

import { formatMachineBody } from './machineMessage'
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
 * スラッシュコマンドは**打った形を本文に含めない**（設計§11-4）。あれは
 * [`SlashCommandLine`] が**押せる部品として別に描く**ので、本文にも入れると
 * 同じ字が2つ並ぶ。
 *
 * **これは §6-8 を覆した結果である。** かつては「打った形のうしろに展開を継ぐ」
 * ことで、畳んだ頭が打った形になり**既にある「続きを読む」にそのまま乗る**という
 * 利点があった。ところが利用者が**打った形を押せるようにしてほしい**と言ったので、
 * 本文の中の字を押させることになり——**行のどこを押しても本文が開く**この画面では、
 * 押し分けが成り立たない。**打った形を本文の外へ出すほうが先に立つ。**
 *
 * 失うのは「畳んだ頭に打った形が出る」ことだが、**打った形は常に見えるようになる**
 * ので、読む側の損は無い。
 *
 * **展開が無いほうが多数派**（実測67%。設計§3-4）なので、そのときは空になる。
 *
 * # 機械が入れたものは、包みを剥がしてから返す（設計§12）
 *
 * 剥がすのは [`formatMachineBody`] で、**ここが唯一の呼び口**である。畳む判断
 * （`foldDecision`）も残り行数の勘定も描く部品も、みなこの関数を通るので、
 * **剥がした後の字で揃う**——別々に剥がすと、畳む位置と見えている字がずれる。
 *
 * **人が打ったものには触らない。** 包みは機械が付けるものなので、人の側で
 * 剥がす相手が出てくることは無い。
 */
export function bodyTextOf(node: Node): string {
  if (node.kind !== 'user_message') {
    return 'text' in node ? node.text : ''
  }
  if (node.command) {
    return node.command.expansion ?? ''
  }
  return isMachine(node) ? formatMachineBody(node.text) : node.text
}
