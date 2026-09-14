import { createContext, useContext, type ReactNode, type RefObject } from 'react'

/**
 * 画面の外枠（`<main>`）を、深いところに居る画面へ配る。
 *
 * # なぜ Context を1つ増やしたか
 *
 * ホイールを拾う購読は**画面ぜんぶ**へ張る必要がある（要件1「**カーソルがどこに置いて
 * あっても**」）。ところが張りたいのは `GroupView` で、`Shell` → `Routes` → `GroupPage`
 * → `GroupView` と深く、**prop で降ろすと途中の段が「ただ渡すだけ」の引数を持つ。**
 *
 * 他の案を採らなかった理由（`DESIGN.md` §50.4）：
 *
 * | 案 | なぜ採らないか |
 * |---|---|
 * | `closest('main')` で親を辿る | **どこに張っているかがコードから読めなくなる** |
 * | `document` を購読する | **ポータル**（トースト・ダイアログ）は `document.body` 直下に出るので、その上でもレールが動く |
 * | `<main>` のパディングを画面側へ移す | **横スクロールと無関係な画面まで巻き込む** |
 *
 * # 広げないこと
 *
 * **このリポジトリで Context を使うのはここが最初である。** 増やす価値があると判断したのは、
 * **張る先が1つに決まっていることをコードで示せる**からで、運ぶのは ref 1つだけである。
 *
 * **状態を配る用途へ広げないこと。** 状態は `stores/` の仕事で、あちらは購読の粒度を
 * 選べる。Context は値が変わるたびに下を丸ごと描き直すので、状態置き場には向かない。
 */
const ScreenRootContext = createContext<RefObject<HTMLElement | null> | null>(null)

export function ScreenRootProvider({
  value,
  children,
}: {
  value: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  return <ScreenRootContext.Provider value={value}>{children}</ScreenRootContext.Provider>
}

/**
 * 画面の外枠を受け取る。**Provider の外では `null` を返す。**
 *
 * 呼ぶ側は**自分の持っている枠へ落とす**こと（`useScreenRoot() ?? 自分の ref`）。
 * ここで例外を投げると、**枠を持たない単体テストが軒並み落ちる**——そして落ちた側は
 * 「Provider を足す」ではなく「この hook を呼ばない」で回避してしまい、**本番だけが
 * 効かない状態に戻る。**
 */
export function useScreenRoot(): RefObject<HTMLElement | null> | null {
  return useContext(ScreenRootContext)
}
