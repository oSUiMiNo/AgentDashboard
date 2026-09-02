/**
 * 「選ぶ」と「開く」の押し分けを、1箇所で配線する（並べ替え設計§4）。
 *
 * # コンポーネントごとに `if (coarse)` を書かない
 *
 * 2箇所に散った瞬間、片方だけ直されて画面が食い違う（設計§4-1）。割り当てそのものは
 * `lib/press.ts` の純関数が持ち、ここは**それを DOM の合図へ配線するだけ**。
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
import { toggleSelect, useSelection, type SelectionKind } from '@/stores/selection'

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
}

export interface PressBinding {
  onClick: (event: { stopPropagation: () => void; detail?: number }) => void
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
}: Options): PressBinding {
  const coarse = useCoarsePointer()
  const selection = useSelection()
  const mapping = pressMapping(coarse, selection.ids.length > 0)
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

  // 外れるときに計測を残さない（押したまま画面が消えることがある）
  useEffect(() => やめる, [やめる])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (
        !mapping.longPressSelects ||
        !selectable ||
        event.pointerType === 'mouse'
      ) {
        return
      }
      やめる()
      const origin = { x: event.clientX, y: event.clientY }
      長押し.current = {
        origin,
        成立: false,
        timer: setTimeout(() => {
          if (長押し.current === null) {
            return
          }
          長押し.current.成立 = true
          toggleSelect(kind, id)
        }, LONG_PRESS_MS),
      }
    },
    [mapping.longPressSelects, selectable, kind, id, やめる],
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
        **開く道を残すほうを採る**（選ぶのは、まとめて操作のための補助である）。

        マウスの `click` は `detail` が1以上なので、ここを通らない。
      */
      if (event.detail === 0) {
        onOpen()
        return
      }
      if (mapping.single === 'open') {
        onOpen()
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
        **ここで選択を戻さない。**

        設計§4-1 は「ダブルクリックが成立したら1打目の選択変更を取り消す」と書いて
        いるが、**ブラウザは `dblclick` の前に `click` を2回発火する**（`click` →
        `click` → `dblclick`）。シングルが「選ぶ」なら**2回で打ち消し合って元へ戻る**
        ので、ここで更に戻すと**選んだ状態で開く**ことになる。

        実装して初めて分かった（1本目のテストが「選ばれている」で落ちた）。
        設計側には読み替えを積んである。
      */
      onOpen()
    },
    [mapping.doubleOpens, mapping.single, kind, id, onOpen],
  )

  return {
    onClick,
    onDoubleClick,
    onPointerDown,
    onPointerMove,
    onPointerUp: 離す,
    onPointerCancel: 離す,
    selected,
  }
}
