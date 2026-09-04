/**
 * ブラウザのタブに出る名前（設計「決める側と書く側を分ける」）。
 *
 * # なぜ要るのか
 *
 * タブはこの道具にとって **PJT の切替器**として使われている。一覧へ戻ってから入り直す
 * のではなく、タブを押して直接行き来する使い方なので、**4枚とも `AgentDashboard` だと
 * 切替器に目盛りが無いのと同じ**になる。
 *
 * # なぜ PJT 名を先に置くのか
 *
 * タブは枚数が増えるほど1枚が狭くなり、**入りきらない分は後ろから切られる**。
 * `AgentDashboard | <PJT名>` の形にすると、狭まった瞬間に全部が `AgentDashboa…` へ
 * 潰れて**いまと同じ状態へ戻る**。見分けたい語のほうを先頭に置く。
 *
 * # 決める側と書く側を分ける
 *
 * [`documentTitle`] は **DOM を読み書きしない純関数**で、[`useDocumentTitle`] だけが
 * `document.title` へ書く。混ぜると、文字列の正しさを確かめるのに DOM が要るようになる
 * （`reorder.ts` と `useReorder.ts` の割り方と同じ）。
 *
 * # 書き手は1つに保つ
 *
 * **`document.title` へ書いてよいのはこのファイルだけ**で、呼ぶのは `App.tsx` の
 * `GroupPage` と `SessionPage` の2箇所に限る。`SessionView` へ置くと、PJT 専用画面が
 * `compact` で**複数枚**描くぶんだけ書き手が増え、どれが勝つか決まらなくなる。
 * この決まりは `documentTitle.test.ts` が機械で見張っている。
 */

import { useEffect } from 'react'

/**
 * PJT に属さない画面で出る名前。
 *
 * **`web/index.html` の `<title>` と同じ字にしておくこと。** 最初の1描画までは
 * あちらが出ているので、食い違うと開いた瞬間だけ別の名前が見える。揃っていることは
 * テストが見張っている。
 */
export const BASE_TITLE = 'AgentDashboard'

/**
 * 区切り。**縦棒の前後に半角の空白を1つずつ置く**（詰めると1語に見える）。
 *
 * Discord のタブ（`Discord | #絶対見る | ちゃとま`）と同じ形にしてある（利用者の指定）。
 * **記号そのものに意味は無く、字面が細いほうが名前を邪魔しない**——ダッシュは幅を取る
 * うえ、PJT 名に混ざる `-` と紛れる。
 */
const SEPARATOR = ' | '

/**
 * タブに出す名前を決める。**名前が無ければ既定だけ**を返す。
 *
 * 渡す名前は `projectDisplayName()` を通したものに限る。同名の PJT に付く番号
 * （`app (1)`）ごとそのまま乗るので、**帯とタブで違う名前が出ることがない**。
 */
export function documentTitle(名前?: string): string {
  return 名前 ? `${名前}${SEPARATOR}${BASE_TITLE}` : BASE_TITLE
}

/**
 * タブの名前を、この画面に居る間だけ差し替える。
 *
 * **離れたら既定へ戻す。** 戻さないと、一覧へ帰ったタブに前の PJT 名が残る——
 * 「PJT に属さない画面はいままでどおり」は、呼ばないことではなく**戻すこと**で
 * 成り立っている。
 *
 * 名前がまだ分からない間（セッション専用画面で、カードが届くまで）は何も渡さない。
 * **空文字にはしない**——タブの名前を空にすると、ブラウザが URL を代わりに出すので、
 * カードの ID が並んで**いまより読みにくくなる**。
 */
export function useDocumentTitle(名前?: string): void {
  useEffect(() => {
    document.title = documentTitle(名前)
    return () => {
      document.title = BASE_TITLE
    }
  }, [名前])
}
