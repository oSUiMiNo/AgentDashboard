/**
 * ホイールと中ドラッグを、PJT 画面のレール（横並びの入れ物）の横送りへ渡す
 * （設計「ホイールをレールへ手渡す」「中ボタンのドラッグ」）。
 *
 * # なぜ手渡しが要るのか
 *
 * 端末を包む箱は `overflowX: auto` を持つ（`components/TerminalPane`）。桁行を 120×40 に
 * 固定してあるので、42rem の札では**必ず横にはみ出す**。したがって端末の上にカーソルを
 * 置いたまま横へ回すと、**レールではなく端末の中身が動く**——これが「カーソルを余白へ
 * 逃がさないと横スクロールできない」の正体だった。
 *
 * **CSS は消さない。** 消せばブラウザのスクロール連鎖が自然に届くが、**指で払う道と
 * スクロールバーも一緒に消える**。あの2つは「端末の横をホイールでは読めなくする」と
 * 決めたときの代償の担保そのものなので、ここは JS で横取りするほうを選んだ。
 *
 * # 張るのは画面ぜんぶ、動かすのはレール
 *
 * **購読はレールではなく、画面の外枠（`App.tsx` の `<main>`）に張る。**
 * レールに張っていた間は、**その外側にあるもの——タイトルの帯と、レールより下の余白——の
 * 上でホイールを回しても何も起きなかった**（利用者の報告）。要件は「**PJT 専用画面の中
 * なら、カーソルがどこに置いてあっても**」なので、帯と余白は範囲の中である。
 *
 * **【2026-09-14・訂正】ここには一度「画面の外枠（`data-testid="group-view"`）」と
 * 書いてあったが、`group-view` は画面の外枠ではなかった。** 同じ画面に帯が2つあり
 * （`App.tsx` のアプリ共通の帯と、`GroupView` の PJT 名の帯）、**利用者が指していたのは
 * 前者**である。`group-view` へ張った版を配ったが、**帯も下の余白もその外側**なので
 * 何も変わらなかった。**実装はこのコメントに忠実で、コメントの前提のほうが誤っていた。**
 *
 * **「どこに張ったか」を読むだけでは足りない。「張った先が、意図した範囲を覆っているか」
 * は別の問いである。** いまは `Shell` が `<main>` の ref を持ち、`lib/screenRoot.tsx` の
 * Context で配っている。
 *
 * **動かす先はレールのまま。** 張る場所を広げても、送る相手を変えてはいけない
 * （並べ替えが見ている箱と別のものを動かすと、運んでいる最中の補正がずれる）。
 *
 * そのうえで、カーソルの居場所で3つに分かれる。
 *
 * | どこ | どうする | なぜ |
 * |---|---|---|
 * | **端末の中** | 横取りしてレールを送る | 端末が自前の `overflowX: auto` で食うため |
 * | **レールの中（端末以外）** | **何もしない** | レール自身が `overflow-x-auto` なので、**ブラウザの連鎖がそのまま動かす**。ここで足すと二重に動く |
 * | **レールの外**（帯・下の余白・サイドバー） | **横へ動ける内側が無ければ**レールを送る | 連鎖の届かない場所なので、手で渡すしかない |
 *
 * **3つめで「横へ動ける内側が無ければ」と条件を付けるのが要点である。** 付けないと、
 * **自分の中を横へ動かすのが正しいもの**——ファイルのタブ帯や生テキスト——まで奪う。
 * **名指しで除外を書かない**のは、名指しは増えるたびに書き足しが要るのに対し、
 * 「横へ動けるか」は**その性質を持つものすべてに自動で当たる**ためである。
 *
 * # 測るのはここ、決めるのは `lib/railPan.ts`
 *
 * このファイルが持つのは4つだけ——**購読の張り／外し**、**実測**（見え幅と行の高さ）、
 * **相手の名指し**、**`scrollLeft` の読み書き**。どのホイールをどれだけ送るかの判定は
 * `railPan.ts` の純関数が持つ。ここに `if (shiftKey)` を書いたら二重実装である。
 *
 * # 端末のホイール購読は2つあり、止め方が違う
 *
 * **ここで止まるのは片方だけである。** もう片方は `TerminalPane` 側の
 * `attachCustomWheelEventHandler` でしか止まらない（あちらのコメントに対で書いてある）。
 * **重複して見えるが重複していない。**
 *
 * | 購読 | 何をする | 止め方 |
 * |---|---|---|
 * | 内部スクロール | 端末の箱を横へ動かす | 入口で `defaultPrevented` を見るので、**ここの `preventDefault()` で止まる** |
 * | 矢印キー送出 | スクロールバックが無い間、縦回しを ↑/↓ として claude へ送る | `defaultPrevented` を**見ない**ので、**あちらの口でしか止まらない** |
 *
 * # 中ドラッグは二段構え。`mouse` と `pointer` の族をまたぐ
 *
 * **押した瞬間には掴まない。** 中ボタンには既に意味がある——Linux では「選んだ文字を
 * 貼り付ける」、ブラウザでは「丸いアイコンを出して勝手にスクロールする」。**動かして
 * しきい値に届いてから**掴むことにすれば、**押して離すだけ（＝貼り付けのつもり）は
 * 今までどおり素通りする。**
 *
 * **族をまたぐのは、止められる場所が違うからである。** 片方へ揃えようとした人が壊すので
 * 対で書いておく。
 *
 * | 何 | どの族 | なぜその族でなければならないか |
 * |---|---|---|
 * | 自動スクロールの抑止 | `mousedown` | **`mousedown` の `preventDefault()` でしか止まらない**（`lib/openInNewTab.ts` の `suppressesAutoscroll`） |
 * | 掴み・送り・止め | `pointer` | 止める契機の `lostpointercapture` は `pointer` 族にしか無い |
 *
 * # 並べ替え中でも、こちらは止めない
 *
 * 隣の `useSnapToFile(railRef, 選んだ回数, reordering)` は第3引数に「いま並べ替え中か」を
 * 取って止まるが、**こちらは取らない。** あちらは**自分から**レールを動かす（選んだ
 * ファイルの位置まで送る）ので、運んでいる最中に動くと**掴んでいる本人の足元が勝手に
 * ずれる**。こちらが動かすのは**利用者が自分の手で送っているぶん**なので、止める理由が
 * 無い。並べ替え側は `lib/useReorder.ts` がレールの移動量を自分で取り込む（掴んだ瞬間の
 * 座標系へ写す）ので、送っても落とし先の判定はずれない。**上のホイールも同じ理由で
 * 取っていない。**
 */

import { useEffect, type RefObject } from 'react'
import { fromInnerControl, isTextEntry, suppressesAutoscroll } from '@/lib/openInNewTab'
import { panScrollDelta, passedPanThreshold, wheelPanDelta } from '@/lib/railPan'

/**
 * 端末（`components/TerminalPane`）。**ホイールを横取りしてよい唯一の相手。**
 */
const 端末 = '[data-testid="terminal"]'

/**
 * 区画（セッション1枚の入れ物・`components/SessionView`）。
 *
 * **中ドラッグが効く範囲はここだけ。** この名指し1つで「**区画の外（レールの余白）では
 * 効かない**」が満たされる。
 */
const 区画 = '[data-testid="session-view"]'

/** マウスの中ボタン（`PointerEvent.button` の 1）。 */
const 中ボタン = 1

/**
 * `deltaMode` が「行」で届いたときの換算に使う、1行ぶんの高さ（px）。
 *
 * **`railPan.ts` へ持ち込まない。** あちらは測らない側なので、既定値も測る側が持つ。
 */
const 行の高さの既定 = 16

/** 実測できないときに使う見え幅（px）。jsdom は幅を 0 で返すことがある。 */
const 見え幅の既定 = 672

/**
 * 1行ぶんの高さを読む。**`normal` は数にならない**ので既定へ落とす。
 */
function 行の高さ(element: Element): number {
  const 値 = Number.parseFloat(getComputedStyle(element).lineHeight)
  return Number.isFinite(値) && 値 > 0 ? 値 : 行の高さの既定
}

/**
 * `target` から `境界` までの祖先に、**自分の中を横へ動かせるもの**があるか。
 *
 * # なぜ名指しではなく性質で見るのか
 *
 * レールの外から渡すとき、**内側で消費されるべきものまで奪ってはいけない**——
 * ファイルのタブ帯（`components/ProjectFiles/FileTabs`）と生テキストがそれである。
 *
 * **名指し（`closest('[data-testid=...]')`）で除外を並べる形にはしない。** 名指しは
 * **増えるたびに書き足しが要る**うえ、**足し忘れても静かに壊れる**（奪われた側は
 * 「なぜか動かない」としか見えない）。**「横へ動けるか」という性質で見れば、その性質を
 * 持つものすべてに自動で当たる。**
 *
 * # 溢れているかまで見る
 *
 * `overflow-x` の指定だけでは足りない。**溢れていない箱は `auto` を持っていても動かない**
 * ので、そこで譲ると**誰も動かさないまま終わる**。`scrollWidth > clientWidth` を対で見る。
 */
function 横へ動ける内側があるか(target: Element, 境界: Element): boolean {
  let node: Element | null = target
  while (node !== null && node !== 境界) {
    if (node.scrollWidth > node.clientWidth) {
      const 横の溢れ方 = getComputedStyle(node).overflowX
      if (横の溢れ方 === 'auto' || 横の溢れ方 === 'scroll') {
        return true
      }
    }
    node = node.parentElement
  }
  return false
}

/**
 * その合図で、レールを掴んでよいか。**ホイールとは別の判定である**（あちらは端末だけ、
 * こちらは区画の中ぜんぶ）。
 *
 * # 端末は、入力欄より**先に**見る
 *
 * xterm は自分の中に `<textarea class="xterm-helper-textarea">` を作る。素直に
 * `isTextEntry` を先に見ると**端末の上で自動スクロールを止められない**——要件は逆に
 * 「**端末の上で中クリックしても、意図しない貼り付けが起きないこと**」を求めている。
 *
 * **これは `isTextEntry` の判断を覆すものではなく、適用範囲を決めているだけである。**
 * あれが守っているのは**利用者が字を打つ入力欄**（`components/Composer`）であって、
 * xterm が実装の都合で持つ隠しの `<textarea>` ではない。**Composer では今までどおり
 * 中クリックの貼り付けが効く**ので、両立する。
 */
function 掴んでよい相手か(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  // **区画の中だけ。** レールの余白や、区画の外に居るものからは効かせない
  if (!target.closest(区画)) {
    return false
  }
  // 鉛筆・ゴミ箱・電源・＋・×。**押せるものの上で、器の操作を発火させない**
  if (fromInnerControl(target)) {
    return false
  }
  if (target.closest(端末)) {
    return true
  }
  return !isTextEntry(target)
}

/** 中ドラッグで押している間、覚えておくもの。 */
interface 掴みの状態 {
  pointerId: number
  /** 押した瞬間のポインタの位置（px）。 */
  押したX: number
  /**
   * 押した瞬間のレールの位置。**ここへ送り量を当てる。**
   *
   * 毎回の差分を足し込まないのは、端で止まったぶんがずれとして溜まるため
   * （`lib/railPan.ts` の `panScrollDelta`）。
   */
  押した位置: number
  /**
   * しきい値に届いて、実際に掴んだか。
   *
   * **「押してはいるが、まだ動かしていない」状態と分けるために要る。** 分けないと、
   * 押して離すだけの中クリック（＝貼り付けのつもり）まで掴んだことになる。
   */
  掴んだ: boolean
}

/**
 * 画面の上のホイールと中ドラッグを、レールの横送りへ渡す。
 *
 * **第1引数は購読を張る先**（画面の外枠）、**第2引数は動かす先**（レール）。
 * **2つに分けてあるのは、張る場所と送る相手が違うからである**——`closest` で親を
 * 辿って外枠を探す形にすると、**どこに張っているかがコードから読めなくなる。**
 *
 * **購読はキャプチャ段で張る。** 端末の中の購読より**先に**走らないと、あちらが
 * 自分で横へ動かしたあとになり、レールと端末が二重に動く。
 *
 * **`stopPropagation()` は呼ばない。** 伝播ごと断つと、**内側で消費されるべきもの**
 * （生テキストの `<pre>` が自分の中を横へ動かすなど）まで奪ってしまう。止めたいのは
 * 既定動作だけなので `preventDefault()` で足りる。
 */
export function useRailPan(
  rootRef: RefObject<HTMLElement | null>,
  railRef: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    const root = rootRef.current
    const rail = railRef.current
    if (!root || !rail) {
      return
    }

    const 横へ渡す = (event: WheelEvent) => {
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }

      /*
        **カーソルの居場所で3つに分かれる**（見出しの表）。分岐の順序に意味がある——
        端末はレールの中に居るので、**先に端末を見ないとレールの中として素通りする**
      */
      if (!target.closest(端末)) {
        if (rail.contains(target)) {
          /*
            **レールの中は、ブラウザの連鎖に任せる。** レール自身が `overflow-x-auto`
            を持つので放っておいても動く。ここで足すと**二重に動く**
          */
          return
        }
        /*
          **レールの外**（タイトルの帯・下の余白・サイドバー）。連鎖が届かないので
          手で渡す。ただし**自分の中を横へ動かせるものが途中に居るなら、そちらが先**
        */
        if (横へ動ける内側があるか(target, root)) {
          return
        }
      }

      const 送り量 = wheelPanDelta(
        {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          shiftKey: event.shiftKey,
        },
        {
          lineHeight: 行の高さ(target),
          pageWidth: rail.clientWidth || 見え幅の既定,
        },
      )

      /*
        **0 のときは何もしない**（`preventDefault()` も呼ばない）。修飾なしの縦回しが
        ここで抜ける——あれは端末の遡りに残す
      */
      if (送り量 === 0) {
        return
      }

      rail.scrollLeft += 送り量
      event.preventDefault()
    }

    // **`passive: false` でないと `preventDefault()` が効かない。**
    // 効かないと端末の箱が自分でも横へ動き、二重になる
    root.addEventListener('wheel', 横へ渡す, { passive: false, capture: true })
    return () => {
      // **外すときにも `capture` を渡す。** 渡さないと別の購読とみなされて外れない
      root.removeEventListener('wheel', 横へ渡す, { capture: true })
    }
  }, [rootRef, railRef])

  useEffect(() => {
    const rail = railRef.current
    if (!rail) {
      return
    }

    let 掴み: 掴みの状態 | null = null

    /*
      **`mousedown` でやるのは抑止だけ。ここでは掴まない。**

      掴んでしまうと、押して離すだけの中クリック（＝貼り付けのつもり）まで横へ動く。
      それでも `mousedown` を使うのは、**丸いアイコンを止める道がこれしか無い**ため
    */
    const 丸いアイコンを止める = (event: MouseEvent) => {
      if (!suppressesAutoscroll(event)) {
        return
      }
      if (!掴んでよい相手か(event.target)) {
        return
      }
      event.preventDefault()
    }

    const 押した = (event: PointerEvent) => {
      if (掴み !== null) {
        // 既に別のポインタが押している。**二本目で乗っ取らない**
        return
      }
      if (event.button !== 中ボタン) {
        return
      }
      if (!掴んでよい相手か(event.target)) {
        return
      }
      // **まだ掴んでいない。** 捕捉もカーソルも、しきい値に届いてから
      掴み = {
        pointerId: event.pointerId,
        押したX: event.clientX,
        押した位置: rail.scrollLeft,
        掴んだ: false,
      }
    }

    const 動いた = (event: PointerEvent) => {
      const いま = 掴み
      if (いま === null || いま.pointerId !== event.pointerId) {
        return
      }

      // **決めるのは純関数。** ここに `Math.abs(...) >= 3` を書いたら二重実装である
      const 送り量 = panScrollDelta(いま.押したX, event.clientX)

      if (!いま.掴んだ) {
        if (!passedPanThreshold(送り量)) {
          // 押してはいるが、まだ動かさない。**押して離すだけを素通りさせる**
          return
        }
        いま.掴んだ = true
        /*
          **捕捉はレール自身に取る。区画に取ってはいけない。**

          区画は並べ替えで外して差し直される側なので、そこに取ると**差し直された
          瞬間に捕捉が落ちて掴みが解ける**（`lib/useReorder.ts` の冒頭にある
          「右へ1回動かすと掴みが解ける」の正体がこれ）。

          **しきい値に届いてから取るのも、意図があってのことである。**
          `components/ProjectFiles/FilesResizer` は `pointerdown` で取るが、あれは
          取らないと `lostpointercapture` が一度も飛ばないため。こちらは掴んでいる
          間だけ止める契機が要るので、掴んだ時点で取れば足りる——早く取ると、
          **素通りさせたい「押して離すだけ」に手を触れる**ことになる。

          jsdom に `setPointerCapture` は無いので `?.()` で呼ぶ
        */
        rail.setPointerCapture?.(event.pointerId)
        rail.style.cursor = 'grabbing'
      }

      // **掴んだ瞬間の位置へ当てる**（差分を足し込まない）
      rail.scrollLeft = いま.押した位置 + 送り量
    }

    const 止める = (event: PointerEvent) => {
      const いま = 掴み
      if (いま === null || いま.pointerId !== event.pointerId) {
        return
      }
      掴み = null
      rail.style.cursor = ''
    }

    rail.addEventListener('mousedown', 丸いアイコンを止める)
    rail.addEventListener('pointerdown', 押した)
    rail.addEventListener('pointermove', 動いた)
    /*
      **契機は1つずつ別の行に書く。** まとめると、1通り壊しただけで全部落ちて、
      テストが何本ぶんの働きをしているのか分からなくなる（`FilesResizer` と同じ理由）。

      **`pointerleave` は使わない。** 指は `pointerdown` の時点で暗黙の捕捉が効いて
      おり、発火しない
    */
    rail.addEventListener('pointerup', 止める)
    rail.addEventListener('pointercancel', 止める)
    rail.addEventListener('lostpointercapture', 止める)
    return () => {
      rail.removeEventListener('mousedown', 丸いアイコンを止める)
      rail.removeEventListener('pointerdown', 押した)
      rail.removeEventListener('pointermove', 動いた)
      rail.removeEventListener('pointerup', 止める)
      rail.removeEventListener('pointercancel', 止める)
      rail.removeEventListener('lostpointercapture', 止める)
    }
  }, [railRef])
}
