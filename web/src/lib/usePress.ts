/**
 * 「選ぶ」と「開く」の押し分けを、1箇所で配線する（並べ替え設計§4）。
 *
 * # コンポーネントごとに `if (coarse)` を書かない
 *
 * 2箇所に散った瞬間、片方だけ直されて画面が食い違う（設計§4-1）。割り当てそのものは
 * `lib/press.ts` の純関数が持ち、ここは**それを DOM の合図へ配線するだけ**。
 *
 * # キーボードは Space で選び、Enter で開く（並べ替え設計§15-6）
 *
 * `<button>` は Enter と Space の両方で `click`（`detail === 0`）を出す。どちらも「開く」に
 * 倒すと**キーボードでは選べず、帯（前へ／後ろへ）へ辿り着けない**。`keydown` で Space を
 * 先に捌いて選び、続く `click` は捨てる。Enter は `<button>` なら `click` に任せ、
 * `<section>`（枠）は自分で開く。
 *
 * # ダブルクリックの1打目を打ち消す
 *
 * **`dblclick` は `click` を打ち消さない。** 素朴に作ると、ダブルクリックのたびに
 * 選択の中身が変わる——選んでいないものを開くと選ばれたまま残り、選んでいるものを
 * 開くと選択が外れる。**成立したら1打目の選択変更を取り消す**（利用者判断・2026-09-02）。
 * 選択の印が一瞬光ってから開く見え方になるが、**押した回数としては正直**である。
 */

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useCoarsePointer } from './pointer'
import { LONG_PRESS_MS, movedTooFar, pressMapping } from './press'
import {
  clearSelection,
  getSelection,
  restoreSelection,
  select,
  toggleSelect,
  useSelection,
  type Selection,
  type SelectionKind,
} from '@/stores/selection'

interface Options {
  kind: SelectionKind
  id: string
  /** 開く（専用画面へ移る） */
  onOpen: () => void
  /**
   * 選べるか。**記録を持たない箱は選べない**（既定は選べる）。
   *
   * カードから逆算しただけの枠には ID が無く、選んでも消す相手が見つからない
   * ——**押しても何も起きないので、壊れているのと見分けが付かない**。
   * 偽のときは長押しの計測そのものを始めない。**成立だけして何も選ばないと、
   * 直後の `click` が捨てられて「開く」まで死ぬ。**
   */
  selectable?: boolean
  /**
   * **長押しが成立した。**
   *
   * 指の画面では、長押しで選んだうえで**そのまま掴んで運べる**（利用者の指定・
   * 2026-09-03。スマホのホーム画面と同じ形）。掴む側（`useGrip`）へ渡す唯一の口で、
   * **依存は一方向**——`usePress` は掴みのことを何も知らない。
   */
  onLongPress?: () => void
}

export interface PressBinding {
  onClick: (event: { stopPropagation: () => void; detail?: number }) => void
  onKeyDown: (event: {
    key: string
    target: EventTarget | null
    currentTarget: EventTarget | null
    preventDefault: () => void
  }) => void
  onDoubleClick: (event: { stopPropagation: () => void }) => void
  onPointerDown: (event: ReactPointerEvent) => void
  onPointerMove: (event: ReactPointerEvent) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  /** 選ばれているか。見た目に使う */
  selected: boolean
}

export function usePress({
  kind,
  id,
  onOpen,
  selectable = true,
  onLongPress,
}: Options): PressBinding {
  const coarse = useCoarsePointer()
  const selection = useSelection()
  /*
    **選ばれている種類を、そのまま渡す**（`press.ts` が3通りへ振り分ける）。以前はここで
    「選べない箱には `null` を渡す」という細工をしていた——その箱から見れば常に「1つも
    選んでいない」ことになり、選択モード中でもタップで開いた。**いまは細工しない。**
    選べないことは `selectable` として渡し、**選択中は種類によらず「解くだけ」**に倒す
    （2026-09-07・利用者の指定）。細工を残すと、選べない箱だけが遷移して**同じに見える
    ものが、あるときは飛び、あるときは飛ばない**。

    PC は `selecting` にも `selectable` にも依らないので変わらず、下の
    `!selectable → return` が「シングルは何もしない」を保つ。
  */
  const mapping = pressMapping(coarse, selection.kind, kind, selectable)
  const selected = selection.kind === kind && selection.ids.includes(id)

  // 長押しの計測。**押した場所からどれだけ動いたか**を見て、動いたらやめる
  const 長押し = useRef<{
    timer: ReturnType<typeof setTimeout>
    origin: { x: number; y: number }
    成立: boolean
  } | null>(null)

  const やめる = useCallback(() => {
    if (長押し.current !== null) {
      clearTimeout(長押し.current.timer)
    }
  }, [])

  /** Space で選んだ直後の `click`（`detail === 0`）を捨てるための印 */
  const 空白で選んだ = useRef(false)

  /**
   * **1打目を押す前の選択。** ダブルクリックが成立したら、ここへ戻す。
   *
   * `click` は1打目が `detail === 1`、2打目が `2` で来るので、**1打目でだけ覚える**。
   */
  const 押す前の選択 = useRef<Selection>(getSelection())

  const onKeyDown = useCallback(
    (event: {
      key: string
      target: EventTarget | null
      currentTarget: EventTarget | null
      preventDefault: () => void
    }) => {
      // **内側の部品（＋・×・カードのボタン・入力欄）から泡立ってきたキーは、この器のものではない。**
      // `stopPropagation` は使わない——`TileGrid` の Esc は `globalThis` で受けている
      if (event.target !== event.currentTarget) {
        return
      }
      // **キーボードは、指が残した印と関係が無い。** 掴んで運んだあと（`click` が
      // 握り潰されて印が残っている状態）に Tab で来て Enter を押しても開くように、
      // ここで捨てる。**計測も必ず止める**——止めずに捨てると、待っているタイマーが
      // 次の押しに乗って**押していない時間で長押しが成立する**
      やめる()
      長押し.current = null
      if (event.key === ' ') {
        // 器が `<section>` のときページが流れるのを止める
        event.preventDefault()
        if (!selectable) {
          return
        }
        // `preventDefault` で `click` が来ないこともあるが、来たときは捨てる
        空白で選んだ.current = true
        /*
          **Space はシングルクリックと同じ答えに従う**（`pressMapping` の `'clear'`）。

          ここだけ「別の種類も選ぶ」を続けると、**同じ PC でマウスとキーボードの結果が
          食い違う**。しかも帯は Tab の通り道なので、**向かっていたボタンが別のボタンに
          なる**のはむしろキーボードのほうが当たりやすい。
        */
        if (mapping.single === 'clear') {
          clearSelection()
          return
        }
        toggleSelect(kind, id)
        return
      }
      // Space 以外が来たら印は古い（`preventDefault` で `click` が来ない環境への保険）
      空白で選んだ.current = false
      if (event.key === 'Enter' && !(event.currentTarget instanceof HTMLButtonElement)) {
        // `<button>` は自分で `click`（`detail === 0`）を出すので二重に開かない
        event.preventDefault()
        onOpen()
      }
    },
    [mapping.single, selectable, kind, id, onOpen, やめる],
  )

  // 外れるときに計測を残さない（押したまま画面が消えることがある）
  useEffect(() => やめる, [やめる])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      /*
        **前の押しの印を、まず捨てる。**

        長押しで掴んで運ぶと、`useGrip` が `onClickCapture` で `click` を握り潰すので
        **`onClick` が走らない**——印を降ろすのはそこだけなので、`成立: true` が残ったまま
        次の押しへ持ち越される。持ち越すと、次に同じカードを押しても「長押しの直後の
        `click`」と誤って捨てられ、**開かなくなる**。

        ここは早い戻りより手前に置く。マウスや選べない箱は下で戻ってしまうので、
        戻る前に捨てないと**マウスで押しても開かない**形が残る。
      */
      やめる()
      長押し.current = null
      // **Space の印も捨てる。** `preventDefault` で `click` が来なかった回の印が
      // 残っていると、次の押しが「Space の直後」と誤って捨てられる
      空白で選んだ.current = false
      if (!mapping.longPressSelects || event.pointerType === 'mouse') {
        return
      }
      const origin = { x: event.clientX, y: event.clientY }
      長押し.current = {
        origin,
        成立: false,
        timer: setTimeout(() => {
          if (長押し.current === null) {
            return
          }
          長押し.current.成立 = true
          // **必ず選ぶ**（`toggleSelect` ではない）。既に選ばれているカードを長押しして
          // 掴んだ瞬間に選択が外れる穴を塞ぐ（並べ替え設計§15-5）
          select(kind, id)
          // **選んだうえで、そのまま掴める。** 指を離せば選ばれただけ
          onLongPress?.()
        }, LONG_PRESS_MS),
      }
    },
    [mapping.longPressSelects, kind, id, onLongPress, やめる],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const held = 長押し.current
      if (held === null || held.成立) {
        return
      }
      // **動いたらスクロールと見なして計測をやめる。** 一覧は縦に流れるので、
      // 指を置いたまま流すたびに選ばれると使い物にならない
      if (movedTooFar(event.clientX - held.origin.x, event.clientY - held.origin.y)) {
        やめる()
        長押し.current = null
      }
    },
    [やめる],
  )

  const 離す = useCallback(() => {
    やめる()
    // **成立したことは、次の `click` まで残す。** 長押しで選んだ直後に
    // `click` が飛んでくるので、そこで開いてしまわないようにする
    if (長押し.current !== null && !長押し.current.成立) {
      長押し.current = null
    }
  }, [やめる])

  const onClick = useCallback(
    (event: { stopPropagation: () => void; detail?: number }) => {
      event.stopPropagation()
      // **1打目だけ覚える**（2打目は `detail === 2`）。ダブルクリックが成立したときに戻す
      if ((event.detail ?? 1) === 1) {
        押す前の選択.current = getSelection()
      }
      const 長押しで選んだ = 長押し.current?.成立 === true
      長押し.current = null
      if (長押しで選んだ) {
        // 長押しが成立した直後の `click` は捨てる（選んだうえに開いてしまう）
        return
      }
      /*
        **キーボードからの `click` は「開く」に倒す**（`detail === 0`）。

        `<button>` は Enter と Space で `click` を発火する。PC の割り当てでは
        シングルが「選ぶ」なので、素直に通すと**キーボードでは二度と開けなくなる**
        ——ダブルクリックはキーボードで表せない。押した回数で区別できない以上、
        **開く道を残すほうを採る**。選ぶほうは Space の `keydown` が持つ（上）。

        マウスの `click` は `detail` が1以上なので、ここを通らない。

        **支援技術からの起動もここを通る**（読み上げソフトが出す `click` も `detail` は 0）。
        **それでよい**——指で押し間違えたのではなく、その要素を名指しで起動しているので、
        「開く」が意図に合う。解きたいときは `Esc` がある。
      */
      if (event.detail === 0) {
        if (空白で選んだ.current) {
          // Space は `keydown` で選んだ。続く `click` で開いてはいけない
          空白で選んだ.current = false
          return
        }
        onOpen()
        return
      }
      if (mapping.single === 'open') {
        onOpen()
        return
      }
      /*
        **何か選んでいる間に、同格でないものを押した。** 選択を解くだけで、押した相手は
        選ばない——**遷移させないことが目的**なので、ここで `onOpen()` を呼ばない
        （並べ替え設計 読み替え7）。開きたければもう一度押す（そのときは「1つも選んで
        いない」ので `'open'` になる）。
      */
      if (mapping.single === 'clear') {
        clearSelection()
        return
      }
      /*
        **選べない箱では、何も起きないのが正しい。** ここで「開く」に倒すと、
        PC のシングルで枠が開いてしまう——**ダブルで開く**という割り当てが崩れ、
        並べ替えようとして画面が飛ぶ。
      */
      if (!selectable) {
        return
      }
      toggleSelect(kind, id)
    },
    [mapping.single, selectable, kind, id, onOpen],
  )

  const onDoubleClick = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation()
      if (!mapping.doubleOpens) {
        return
      }
      /*
        **押す前の選択へ戻してから開く**（設計§4-1「1打目の選択変更を取り消す」）。

        ブラウザは `dblclick` の前に `click` を2回発火する（`click` → `click` →
        `dblclick`）。**シングルが「選ぶ」だけだった頃は、2回で打ち消し合って元へ
        戻っていた**ので、ここでは何もしなくてよかった。

        **「解くだけ」が入って打ち消し合わなくなった**——別の種類を選んでいるときは、
        1打目で解け、2打目で**押した相手が選ばれる**。開いた先へ頼んでいない選択を
        持ち込むうえ、一覧へ戻ると身に覚えのない帯が出ている。**まとめて選んでいた
        ものも失う**ので、覚えておいて戻す。
      */
      restoreSelection(押す前の選択.current)
      onOpen()
    },
    [mapping.doubleOpens, onOpen],
  )

  return {
    onClick,
    onKeyDown,
    onDoubleClick,
    onPointerDown,
    onPointerMove,
    onPointerUp: 離す,
    onPointerCancel: 離す,
    selected,
  }
}
