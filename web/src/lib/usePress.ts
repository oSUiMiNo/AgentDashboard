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
 * # 「新しいタブで開く」もここが持つ（イシュー `カードと枠を、中クリックで新しいタブに開く`）
 *
 * 規則そのものは `lib/openInNewTab.ts` の純関数にあるが、**配線はここ1箇所**である。
 * 最初は別のフックに分けていたが、**同じ要素に付いた兄弟のハンドラは
 * `stopPropagation()` では止まらない**ので、`click` だけを重ねる形になり——
 * `dblclick`・`keydown`・「押す前の選択」の3つが**手で思い出すしかない穴**になった
 * （レビューで3件とも実害として挙がった）。設計§4-1 が「押し分けは1箇所で決める」と
 * 言っているのは、まさにこの形を避けるためである。
 *
 * 行き先（`newTabPath`）を渡されたときだけ効く。渡されなければ何も足さない。
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
import {
  fromInnerControl,
  isTextEntry,
  openNewTab,
  suppressesAutoscroll,
  wantsNewTab,
  wantsNewTabByKey,
  type PressLike,
} from './openInNewTab'
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
  /**
   * **新しいタブで開くときの行き先。**
   *
   * 渡すと、中クリック・Ctrl／Cmd＋クリック・Ctrl／Cmd＋Enter が「新しいタブ」に
   * なる。**渡さなければ何も起きない**——押し分けは今までどおり。
   *
   * 組み立ては呼び元（`lib/routes.ts`）。**ここで文字列を組まない。**
   */
  newTabPath?: string
}

/** 押したときに来るもの。**`PressLike` に、DOM を触るぶんを足しただけ** */
interface ClickLike extends PressLike {
  detail?: number
  target: EventTarget | null
  preventDefault: () => void
  stopPropagation: () => void
}

interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  target: EventTarget | null
  currentTarget: EventTarget | null
  preventDefault: () => void
}

export interface PressBinding {
  onClick: (event: ClickLike) => void
  onKeyDown: (event: KeyLike) => void
  onDoubleClick: (event: ClickLike) => void
  /** 中クリック。**新しいタブで開く** */
  onAuxClick: (event: ClickLike) => void
  /** ブラウザの自動スクロール（丸いアイコン）を止める */
  onMouseDown: (event: ClickLike) => void
  onPointerDown: (event: ReactPointerEvent) => void
  onPointerMove: (event: ReactPointerEvent) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  /**
   * **見えている面のうち、押し分けの器そのものではないところ**へ付ける一式。
   *
   * カードの押し分けは `<button>`（`tile-body`）が持つが、**見えているカードは
   * その 5px 外側の枠（`tile-frame`）まで**である。その帯を押しても `<button>` には
   * 届かず、**枠（PJT）まで泡立って「PJT を新しいタブで開く」になってしまう**
   * ——カードを狙って PJT が開く。
   *
   * ここが受けるのは**新しいタブの3つだけ**で、素の押しは今までどおり泡立たせる
   * （帯を押したときの既存の振る舞いを変えない）。
   */
  skin: {
    onClick: (event: ClickLike) => void
    onAuxClick: (event: ClickLike) => void
    onMouseDown: (event: ClickLike) => void
  }
  /** 選ばれているか。見た目に使う */
  selected: boolean
}

export function usePress({
  kind,
  id,
  onOpen,
  selectable = true,
  onLongPress,
  newTabPath,
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

  /**
   * **新しいタブで開いたか。** 開いたら真——呼び元はそこで打ち切る。
   *
   * 器の中の押せるもの（鉛筆・ゴミ箱・電源・＋・×）から出た合図は受けない。
   * あれは別の意味を持つ。
   */
  const 新しいタブで開いた = useCallback(
    (event: ClickLike): boolean => {
      if (newTabPath === undefined || fromInnerControl(event.target)) {
        return false
      }
      if (!wantsNewTab(event)) {
        return false
      }
      openNewTab(newTabPath)
      /*
        **開いたときだけ止める。** 枠の中のカードを中クリックしたとき、枠まで泡立つと
        **カードと PJT の2枚が開く**。既定の動作も止める——中クリックには
        ブラウザ側の意味（貼り付け）が残っている。
      */
      event.preventDefault()
      event.stopPropagation()
      return true
    },
    [newTabPath],
  )

  const onAuxClick = useCallback(
    (event: ClickLike) => {
      新しいタブで開いた(event)
    },
    [新しいタブで開いた],
  )

  const onMouseDown = useCallback((event: ClickLike) => {
    if (!suppressesAutoscroll(event)) {
      return
    }
    /*
      **字を打ち込むところでは止めない。** Linux（X11）では中クリックが
      「選んだ文字の貼り付け」という OS の作法なので、そこを止めると
      **このアプリの中でだけ貼り付けが効かない**という形になる。
    */
    if (isTextEntry(event.target)) {
      return
    }
    // **丸いアイコン（自動スクロール）を出させない。** 止める道はここしか無い
    event.preventDefault()
  }, [])

  /**
   * 見えている面の外側（カードの 5px の帯）用。**新しいタブの3つだけを受ける。**
   *
   * 素の押しは何もしない——**泡立たせる**ので、帯を押したときの既存の振る舞いが変わらない。
   */
  const skin = {
    onClick: (event: ClickLike) => {
      新しいタブで開いた(event)
    },
    onAuxClick,
    onMouseDown,
  }

  const onKeyDown = useCallback(
    (event: KeyLike) => {
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
      /*
        **Ctrl／Cmd＋Enter は新しいタブ**（ブラウザがリンクに対してそうしているのに揃える）。

        **`<button>` だけなら、ここは要らない**——`click`（`ctrlKey` 付き）が出るので
        下の `onClick` が拾う。**要るのは `<section>`（枠）のため**で、あちらは `click` を
        出さないので、ここが無いと**同じキーでカードは新しいタブ・枠はいまのタブ**という
        食い違いが残る（レビューで実害として挙がった）。

        `<button>` でも先にここで捌いて `preventDefault()` する。**`click` が出なくなる**
        ので、2枚開くことはない。
      */
      if (newTabPath !== undefined && wantsNewTabByKey(event)) {
        event.preventDefault()
        openNewTab(newTabPath)
        return
      }
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
    [mapping.single, selectable, kind, id, onOpen, やめる, newTabPath],
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
    (event: ClickLike) => {
      /*
        **新しいタブが先。** ここで止めないと、開いたうえに押し分けが走って
        **カードが選ばれる**（同じ要素に付いた兄弟は `stopPropagation()` では
        止まらないので、外から重ねる形では防げなかった）。
      */
      if (新しいタブで開いた(event)) {
        return
      }
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
    [mapping.single, selectable, kind, id, onOpen, 新しいタブで開いた],
  )

  const onDoubleClick = useCallback(
    (event: ClickLike) => {
      event.stopPropagation()
      /*
        **Ctrl／Cmd を押したままの2打は、いまのタブを動かさない。**

        1打ずつが既に新しいタブを開いているので、`dblclick` まで「開く」に通すと
        **タブが2枚増えたうえ、いま見ている一覧まで飛ぶ**。README が「いま見ている
        画面も動かない」と約束しているのはこの押し方なので、ここで打ち切る。

        **`押す前の選択` へ戻す処理も飛ばす。** Ctrl＋クリックは `onClick` の頭で
        打ち切られており**控えを取り直していない**ので、ここで戻すと
        **とっくに解いたはずの選択が蘇る**（レビューで実害として挙がった）。
      */
      if (newTabPath !== undefined && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        return
      }
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
    [mapping.doubleOpens, onOpen, newTabPath],
  )

  return {
    onClick,
    onKeyDown,
    onDoubleClick,
    onAuxClick,
    onMouseDown,
    skin,
    onPointerDown,
    onPointerMove,
    onPointerUp: 離す,
    onPointerCancel: 離す,
    selected,
  }
}
