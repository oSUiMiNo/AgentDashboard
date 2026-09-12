/**
 * メモの宛先を、文字列の鍵へ写す（メモ設計§3-1・§8-1）。
 *
 * # なぜ1本に寄せるのか
 *
 * 宛先を文字列にする必要が**2箇所**ある——**手元の一覧を宛先ごとに持つ鍵**
 * （`stores/memos.ts`）と、**書きかけの予約鍵**（`lib/drafts.ts`）である。
 *
 * **綴りが割れると、同じ宛先が2つの箱に入る。** 一覧は `session:<id>` に積んだのに
 * 書きかけは `<id>` に置いた、という形になっても**何も落ちない**——どちらも文字列の
 * 鍵なので、型でも実行時でも気づけない。だから**綴りを決める場所を1つにする。**
 *
 * # ここが「落ちない場所」を「`make ci` が拾う場所」へ移している
 *
 * 宛先で分かれる箇所は、いまは**この関数だけ**である（口5つのうち宛先を運ぶのは
 * `memo_list` と `memo_add` の2つで、面の中は宛先を1度も見ない）。
 *
 * 二択の式（`t === 'global' ? A : B`）で書くと、**宛先が3つ目になった日に黙って
 * `B` へ落ちる**。`switch` ＋ [`assertNever`] にすると **`tsc` が落とす**ので、
 * 分類が「誰も捕まえない」から「`make ci` が拾う」へ移る——**この移動そのものが
 * 狙い**である（`lib/markdown.ts` の `foldKindOf` が同じ理由で二択の式から
 * `switch` へ直されており、その doc に経緯が残っている）。
 *
 * 要件は「宛先は後から足せる形にする」と言っている（全体とセッションの中間の粒度は
 * 今回作らないが、記録は列で持つので足せる）。**足した日に落ちる形にしておく価値が
 * ここにある。**
 *
 * # 効かない相手が1つある
 *
 * **`lib/drafts.ts` の鍵は素の `string`** である（`CardId = string` は branded では
 * ない）。したがって `readDraft('global', …)` は**型が通ってしまう**——この関数を
 * 通さずに綴りを直接書いても `tsc` は何も言わない。**あちらはテストで守る。**
 */

import { assertNever } from '@/lib/never'
import type { AnnotationTarget } from '@/lib/protocol'

/**
 * 宛先を鍵の文字列にする。
 *
 * | 宛先 | 鍵 |
 * |---|---|
 * | 全体 | `global` |
 * | セッション | `session:<claude_session_id>` |
 *
 * **`global` が既存のカードのID と衝突しないこと**が前提になっている（カードのIDは
 * UUID なので衝突しない）。書きかけの表はこの鍵をカードのIDと同じ空間で使うので、
 * **衝突しないことは `drafts` 側のテストで固定してある。**
 */
export function targetKey(target: AnnotationTarget): string {
  switch (target.t) {
    case 'global':
      return 'global'
    case 'session':
      return `session:${target.claude_session_id}`
    default:
      // **宛先が増えると、ここで `tsc` が落ちる。** 落ちたら「その宛先の鍵は何か」を
      // 決めて上へ1行足すこと。
      assertNever(target)
      // 倒れ方は残す（`lib/never.ts` の作法）。**知らない宛先を全体に混ぜない**——
      // 混ぜると、別の宛先のメモが全体メモに出る
      return 'unknown'
  }
}

/** 全体宛て。**どの画面から開いても同じ1つ**なので、値を使い回してよい。 */
export const GLOBAL_TARGET: AnnotationTarget = { t: 'global' }

/** そのセッション宛て。 */
export function sessionTarget(claudeSessionId: string): AnnotationTarget {
  return { t: 'session', claude_session_id: claudeSessionId }
}
