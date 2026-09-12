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

import { formatMachineBody, peerNameOf, wholeMachineShapeOf } from './machineMessage'
import { assertNever } from './never'
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
 * # 待ちの行は、本文から名乗りを起こす（設計§17）
 *
 * **設計§2-4 は「待ちの記録には名乗る材料が無い」として欄を足さなかった。**
 * 欄については正しい——`queue-operation` のレコードが持つのは `content` /
 * `operation` / `type` だけで、`origin` も `promptSource` も `isMeta` も無い。
 *
 * **だが本文そのものが名乗っていた。** 機械が積むものは常に包みだけで構成され、
 * 人が打つものは包みを含まない（実測：混在0件）。だから[丸ごと包みか]
 * (`wholeMachineShapeOf`)で切れる。
 *
 * **ここを直すと、左寄せ・色・畳み・包み剥がしが全部ついてくる**——下流はどれも
 * [`isMachine`] を見ているので、**待ちだけ別の道を作らずに済む**。
 */
export function originOf(node: Node): MessageOrigin {
  if (node.kind === 'queued_message') {
    return queuedOrigin(node.text)
  }
  if (node.kind !== 'user_message') {
    return { kind: 'unmarked' }
  }
  return node.origin ?? { kind: 'unmarked' }
}

/**
 * 待ちの行の名乗りを、本文の包みから起こす。
 *
 * **包みで構成されていなければ「名乗り無し」＝人の側へ倒す**（要件の最優先事項）。
 * 人が待ち行列へ積んだ文は包みを持たないので、必ずこちらへ落ちる。
 */
function queuedOrigin(text: string): MessageOrigin {
  const shape = wholeMachineShapeOf(text)
  switch (shape) {
    case 'task_notification':
      return { kind: 'task_notification' }
    case 'cross_session':
      return { kind: 'peer', name: peerNameOf(text) }
    // 写し・フックの通知・断り書き・`/context` の報告は、どれも
    // **機械が文脈のために差し込んだもの**
    case 'history':
    case 'stop_hook':
    case 'local_command_caveat':
    case 'local_command_stdout':
    case 'context_usage':
      return { kind: 'injected' }
    // **人の側へ倒すもの。** `null` は「包みで構成されていない」＝人が打った文、
    // `plain` は整形しないと決めたもの。**どちらも印が無いので人である**
    case null:
    case 'plain':
      return { kind: 'unmarked' }
    default:
      // **型を足したら、ここで `tsc` が落ちる。** 落ちたら「機械が差し込んだものか」を
      // 決めて上へ1行足すこと——**落とすと待ちの行だけ人の側へ倒れる**（実際に踏んだ）。
      // 印が無いものを機械と読むことは要件が禁じているので、既定は人の側のままにする
      assertNever(shape)
      return { kind: 'unmarked' }
  }
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
  // **待ちも同じ道を通す**（設計§17）。機械が積んだものは包みを剥がしてから返す
  if (node.kind !== 'user_message' && node.kind !== 'queued_message') {
    return 'text' in node ? node.text : ''
  }
  if (node.kind === 'user_message' && node.command) {
    return node.command.expansion ?? ''
  }
  return isMachine(node) ? formatMachineBody(node.text) : node.text
}

/**
 * この本文が **API のエラーとして書かれたものか**（設計§14）。
 *
 * # 字面で見分けない
 *
 * 実測で `Request timed out`（印あり）と `No response requested.`（印なし・ただの
 * 短い返事）は、**画面上まったく同じ姿**で並ぶ。**違うのは欄だけ**なので、本文の
 * 見た目で判定すると必ず後者を巻き込む。**記録が名乗った印だけを見る**——
 * これは §1（誰が入れたか）と同じ考え方である。
 *
 * # 欄が無ければエラーでない側へ倒す
 *
 * この欄を知らない版のサーバへ繋ぐ形が実在する（版を戻したとき）。**倒し込みは
 * ここ1か所に閉じ、部品の側で `??` を書かない**（§2-5 と同じ作法）。
 */
export function isApiError(node: Node): boolean {
  return node.kind === 'assistant_text' && node.error === true
}

/**
 * **読まれる前に取り消された発言か**（設計§15）。
 *
 * 送ったが、アシスタントが返し始める前に人が止めたもの。**判定はパーサ側で済んでいる**
 * ——合図（`interruptedMessageId` の有無）はレコードにしか無く、画面の木からは辿れない。
 *
 * **欄が来なければ「取り消されていない」へ倒す**（[`isApiError`] と同じ理由）。
 */
export function isCancelled(node: Node): boolean {
  return node.kind === 'user_message' && node.cancelled === true
}
