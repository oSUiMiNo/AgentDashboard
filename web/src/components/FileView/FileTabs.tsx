/**
 * 開いているファイルのタブ帯（`サイドバーで開いたファイルを、タブで並べて切り替える` 要件）。
 *
 * # 段を足さず、相対パスの表示を置き換える
 *
 * `DESIGN.md` §39.4 が「**空の段を作らない**」と定めており、`FileView` はレールの中の列の
 * 中にある。ここへ段を足すと、**外→内で余白を半分以下にする規則が通しで成立しなくなる。**
 *
 * 置き換えられるのは、**もとの chip と役目が同じ**だからである。あれは「いま何を見て
 * いるか」を示すもので、タブ帯は同じ役目を開いている枚数ぶん果たす。**`title` は
 * 引き継ぐ**——「基準の分からない相対パスは貼られた側で解釈できない」という要求
 * （要件26・設計§8-6）は消えていない。
 *
 * # 折り返さない
 *
 * ヘッダは1行に保つ（3つの要件がどれも完了条件に挙げている）。**`flex-nowrap` ＋
 * 自前の横スクロール**にして、右のボタン群は `shrink-0` のまま残す。折り返しを許すと、
 * タブが増えるたびにヘッダが2行3行に伸びて中身が下へ押し出される。
 *
 * # ✕ は常に出す
 *
 * `:hover` に隠さない。**指で触る画面には `:hover` が無い**ので、隠すとスマホから
 * 1枚も閉じられなくなる（`DESIGN.md` §42.6 が同じ理由を別の場所で書いている）。
 *
 * # ✕ はタブの中に入れない
 *
 * 入れ子のボタンは HTML として成立しない。**兄弟として並べ、囲みだけを共有する**
 * （`FolderBrowser` の行が同じ理由で的を2つに割っている）。
 *
 * # 矢印キーで行き来できる
 *
 * **`role="tablist"` を名乗る以上、← → で移れないと約束と実装が食い違う。** 読み上げを
 * 使う人はその割り当てを前提に押すので、**何も起きないと壊れていると読まれる**
 * （この PJT が画面の行き来で踏んだのと同じ形）。
 *
 * **選択と焦点を一緒に動かす**（自動活性化）。タブの数はせいぜい十数枚で、切り替えの
 * 代金が軽い——重い相手なら「焦点だけ動かして Enter で決める」ほうが正しいが、
 * ここは**押した瞬間に中身が変わるほうが速い。**
 *
 * # 並べ替えは、指とキーボードの両方で
 *
 * **要件では「採らない」と決めていたものを、利用者が覆した**（2026-09-08）。
 * 断った理由は3つあったが、**消えたのは2つだけ**である。
 *
 * | 断った理由 | いま |
 * |---|---|
 * | 要望に含まれていない | **含まれた** |
 * | `lib/reorder.ts` は2次元用で1次元の帯に合わない | **流用していない。** 1本の帯に合う形を素直に書いた |
 * | **WCAG 2.5.7（ポインタ以外の手段）が要る** | **消えていない。** だから ← → だけでなく、**Ctrl+Shift+← → でタブそのものを動かせる** |
 *
 * **ドラッグだけで入れると、キーボードで並べ替えられないものが1つ増える。**
 * この帯については満たす、というのが利用者との約束である。
 *
 * # 掴むのはマウスの主ボタンだけ
 *
 * 中ボタンと右ボタンで掴めると、**中クリックで新しいタブに開こうとしただけで並びが
 * 変わる**（隣の工事が同じ穴を踏んで直している）。指とペンは今までどおり。
 *
 * # 動きは `reorder.css` が持つ。ここは動かす量だけを渡す
 *
 * **カードと同じ手触りにする**（利用者の指摘・2026-09-08）。瞬間で入れ替わると、
 * 何が起きたのか目で追えない。
 *
 * **落とし先を決める側は流用していないが、動き方は流用する。** `reorder.css` は
 * `data-reorder-item` と CSS 変数だけで書かれていて**次元を持たない**ので、1本の帯にも
 * そのまま効く——**別々の動きが2つ生まれるのを防げる**（時間・曲線・止める段が1箇所）。
 *
 * # 運んでいる間は並びを変えない
 *
 * **既存の作法**（並べ替え設計§15-11）。React に並べ替えさせると**掴んでいる本人の
 * ノードが差し直され、掴みが解ける**。矩形は掴んだ瞬間の1回だけ測り、見た目は
 * `translate` で作る。
 *
 * **離した瞬間に飛ばないのは、この作りの副産物である**——運んでいる間の見た目が
 * 既に「並べ替えたあとの姿」なので、本当に並べ替えて `translate` を外すと差し引き 0 になる。
 *
 * # 少し動くまでは掴まない
 *
 * 押した指がわずかに動くのは普通なので、**閾値を越えるまではただの押下として扱う**。
 * 越えなければ「選ぶ」、越えたら「並べ替え」——`README.md` が「開く操作と選ぶ操作は、
 * 押し方で分けてある」と書いているのと同じ理由で、**並べ替えが押下を食わない**。
 *
 * # 「タブ」はアプリの中の話である
 *
 * この帯の隣には**ブラウザのタブ**を開くボタン（`file-open-tab`）が既に住んでいる。
 * **同じ帯に2つの意味の「タブ」が並ぶ**ので、コードでも文書でもどちらの話かを書く。
 */

import type { CSSProperties } from 'react'
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { CloseGlyph } from '@/components/ui/glyphs'
import { dropIndexFor, moveTab, stripScrollFor, tabLabels } from '@/lib/fileTabs'
import { useSettingsStore } from '@/stores/settings'

/**
 * 滑り終わるのを待つ時間。**`reorder.css` の `--reorder-ms` と同じ 200ms。**
 *
 * 値を2箇所に持つのは避けたいが、**CSS の変数は JavaScript から読むと解決済みの
 * 文字列になり、掴んでいない間は `0ms`** なので、待つ側からは使えない。
 */
const 滑り = 200

interface Props {
  /** 開いているタブの絶対パス（左から右の順） */
  tabs: string[]
  /** いま見ている1枚の絶対パス */
  current: string
  /** 相対パスの基準（その枠のパス）。`title` に出す */
  root: string
  onSelect: (path: string) => void
  onClose: (path: string) => void
  /**
   * 並べ替え。**動かすものは位置ではなくパスで渡す。**
   *
   * 位置で渡すと、**こちらが見ている並び（前の描画）と、親が持っている最新の並びが
   * ずれる**——ポインタの動きは束ねて届くので、1回のコミットの前に2発来ると
   * **同じ位置の指定が最新の並びへ2回当たって、タブが2つ飛ぶ**。パスで渡せば
   * 親が自分の最新から位置を引き直すので、**同じ指定を何回当てても同じ結果**になる。
   */
  onReorder: (path: string, to: number) => void
  /**
   * 並べ替えを確定した（指を離した・キーで1回動かした）。**ここでだけ覚える。**
   *
   * 運んでいる最中に覚えると、**ポインタが動くたびに `localStorage` を同期で
   * 読み書きする**ことになり、タブが多いほど運びがカクつく。
   */
  onReorderCommit: () => void
}

export function FileTabs({
  tabs,
  current,
  root,
  onSelect,
  onClose,
  onReorder,
  onReorderCommit,
}: Props) {
  const labels = tabLabels(tabs)
  const stripRef = useRef<HTMLDivElement>(null)
  /**
   * 掴んでいるもの。**閾値を越えるまでは「押下かもしれない」ままにしておく。**
   *
   * `枠` は**掴んだ瞬間に1回だけ測った矩形**（設計§15-11）。運んでいる間は並びを
   * 変えないので、これが動くことはない。
   */
  const 掴み = useRef<{
    path: string
    x: number
     越えた: boolean
    枠: { path: string; left: number; width: number }[]
    間: number
    仮: number
  } | null>(null)
  /** 直前の押下が並べ替えだったか。**そのあとの `click` を食わせないため** */
  const 運んだ = useRef(false)
  /**
   * 運んでいる最中の見た目。**動かす量（`--reorder-dx`）を各タブへ渡すためだけ**で、
   * 判断は `掴み` が持つ。
   */
  const [運び, set運び] = useState<{
    /** 掴んでいる1枚。**離して滑らせている間は `null`**（浮きを落とすため） */
    path: string | null
    dx: Record<string, number>
  } | null>(null)
  const 運び中 = 運び?.path ?? null
  /** 滑り終わるのを待っている印。**外れたら止める**（`setTimeout` を残さない） */
  const 落ち着き待ち = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (落ち着き待ち.current !== null) {
        globalThis.clearTimeout(落ち着き待ち.current)
      }
    },
    [],
  )
  const quiet = useSettingsStore((state) => state.settings.motion_quiet)

  /*
    **選ばれているタブを、見えるところまで送る**（`stripScrollFor`）。

    **覚えていた並びを復元した直後の送り位置は必ず 0** なので、タブが8枚もあると
    選ばれている1枚が画面の外に居る——**帯に見えているどのタブとも一致しない中身が
    出ている**ことになり、壊れて見える。**長い並びの復元は、この機能の主役の場面**である。

    `scrollIntoView` を使わない。**あれは祖先を全部送る**ので、レール（横に流れる面）
    ごと動いて**押した的が逃げる**。`scrollLeft` への代入なら帯の中だけで閉じる
    （`lib/snapToFile.ts` が同じ理由で `scrollTo` を避けている）。
  */
  useEffect(() => {
    const 帯 = stripRef.current
    /*
      **運んでいる間は動かさない。** 帯が横に流れると全タブの位置が変わり、
      **次のポインタの動きが別の場所を落とし先と判定する**——しかも帯が流れるほど
      枚数がある状況は、まさに並べ替えたい状況そのものである。
    */
    /*
      **落ち着いている最中も動かさない。** 離した瞬間に `運び中` は null になるが、
      **`translate` はまだ乗ったまま**滑っている——`getBoundingClientRect` は変形後を
      返すので、ここで測ると**通り過ぎの位置**で送り先を決めることになる。
      確定すると `tabs` が変わって、この効果はもう一度ちゃんと走る。
    */
    if (帯 === null || 運び中 !== null || 落ち着き待ち.current !== null) {
      return
    }
    const タブ = 帯.querySelector<HTMLElement>(
      `[data-testid="file-tab"][data-path="${CSS.escape(current)}"]`,
    )
    if (タブ === null) {
      return
    }
    const 帯の矩形 = 帯.getBoundingClientRect()
    const タブの矩形 = タブ.getBoundingClientRect()
    帯.scrollLeft = stripScrollFor(
      { 幅: 帯.clientWidth, いまの位置: 帯.scrollLeft },
      {
        左: 帯.scrollLeft + (タブの矩形.left - 帯の矩形.left),
        幅: タブの矩形.width,
      },
    )
  }, [current, tabs, 運び中])

  /**
   * ← → Home End で移る。**選択と焦点を一緒に動かす。**
   *
   * **端で止めずに回す**——タブ帯は横スクロールするので、端がどこかは目で見えない
   * ことがある。止めると「効かなくなった」と読まれる。
   */
  const 矢印 = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const 今 = tabs.indexOf(current)
    if (今 < 0 || tabs.length === 0) {
      return
    }
    /*
      **Ctrl+Shift+← → は、選択ではなくタブそのものを動かす**（WCAG 2.5.7）。
      **端では回さない**——移る（← →）は端で回すのが自然だが、**運ぶのは端で
      止まるほうが自然**である。回すと、右端で1回押しただけで左端へ飛ぶ。
    */
    if (event.ctrlKey && event.shiftKey) {
      /*
        **動かすのは「焦点のあるタブ」であって、選ばれているタブではない。**
        運んだあとは焦点と選択がずれていることがあるので、`current` を使うと
        **見た目に焦点のあるタブではない別のタブが動く**。
      */
      const 的 = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        '[data-path]',
      )
      const 動かすもの = 的?.dataset.path ?? current
      const 元 = tabs.indexOf(動かすもの)
      const 行き先 =
        event.key === 'ArrowLeft'
          ? 元 - 1
          : event.key === 'ArrowRight'
            ? 元 + 1
            : -1
      if (元 < 0 || 行き先 < 0 || 行き先 >= tabs.length) {
        return
      }
      event.preventDefault()
      onReorder(動かすもの, 行き先)
      onReorderCommit()
      // 運んだ先で押し続けられるように、焦点を連れていく
      requestAnimationFrame(() => 焦点を移す(動かすもの))
      return
    }
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) {
      return
    }
    const 先 =
      event.key === 'ArrowLeft'
        ? (今 - 1 + tabs.length) % tabs.length
        : event.key === 'ArrowRight'
          ? (今 + 1) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : -1
    if (先 < 0) {
      return
    }
    // **既定を止める。** ← → は箱の横スクロールも動かすので、両方効くと二重に飛ぶ
    event.preventDefault()
    const path = tabs[先]
    if (path === undefined) {
      return
    }
    onSelect(path)
    // 焦点も連れていく。**選択だけ動かすと、次の ← → が古い位置から始まる**
    焦点を移す(path)
  }

  /** そのタブへ焦点を移す。**運んだあとも押し続けられるように要る** */
  function 焦点を移す(path: string) {
    stripRef.current
      ?.querySelector<HTMLElement>(
        `[data-testid="file-tab"][data-path="${CSS.escape(path)}"]`,
      )
      ?.focus()
  }

  /** 掴んだ瞬間の矩形。**運んでいる間はこれしか見ない**（並びを変えないので動かない） */
  function 枠を測る(): { path: string; left: number; width: number }[] {
    const 帯 = stripRef.current
    if (帯 === null) {
      return []
    }
    return tabs.map((path) => {
      const el = 帯.querySelector<HTMLElement>(
        `[data-tab-slot][data-path="${CSS.escape(path)}"]`,
      )
      const r = el?.getBoundingClientRect()
      /*
        **引けなかったものは、落とし先に選ばれない値にする。** 0 にすると
        「画面のいちばん左に居るタブ」として選ばれうる——`dropIndexFor` は
        中心までの距離で決めるので、0 は強い候補になってしまう。
      */
      return r === undefined
        ? { path, left: Number.POSITIVE_INFINITY, width: 0 }
        : { path, left: r.left, width: r.width }
    })
  }

  /**
   * 仮の並びに置いたときの、各タブの動かす量。
   *
   * **本人は指に 1:1 で追従する**ので別に渡す（`reorder.css` は本人の `translate` に
   * `transition` を掛けない）。押しのけられる側だけが滑る。
   */
  function ずれを出す(
    枠: { path: string; left: number; width: number }[],
    間: number,
    元: number,
    仮: number,
    指: number,
  ): Record<string, number> {
    const 並び = moveTab(
      枠.map((w) => w.path),
      元,
      仮,
    )
    const 行き先: Record<string, number> = {}
    let x = 枠[0]?.left ?? 0
    for (const path of 並び) {
      const w = 枠.find((v) => v.path === path)
      if (w === undefined) {
        continue
      }
      行き先[path] = x - w.left
      x += w.width + 間
    }
    // **本人だけは指に付いていく**（仮の位置ではなく、動かした距離そのもの）
    const 本人 = 枠[元]?.path
    if (本人 !== undefined) {
      行き先[本人] = 指
    }
    return 行き先
  }

  const 押した = (event: ReactPointerEvent<HTMLElement>, path: string) => {
    // **掴むのはマウスの主ボタンだけ。** 指とペンは今までどおり
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }
    const 枠 = 枠を測る()
    const 間 =
      枠.length > 1
        ? Math.max(0, (枠[1]?.left ?? 0) - ((枠[0]?.left ?? 0) + (枠[0]?.width ?? 0)))
        : 0
    掴み.current = {
      path,
      x: event.clientX,
      越えた: false,
      枠,
      間,
      仮: tabs.indexOf(path),
    }
    /*
      **文字選択を始めさせない。** 掴んで横へ運ぶと、通り過ぎたタブの名前が
      軒並みハイライトされて、運搬の見た目と混ざる。
    */
    event.preventDefault()
  }

  const 動かした = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = 掴み.current
    if (g === null) {
      return
    }
    /*
      **押していないなら掴みを捨てる。**

      閾値を越える前に帯の外で離すと、キャプチャを取っていないので帯の `pointerup` が
      来ない——`掴み` が残ったまま、**あとで帯の上をただ通っただけで並びが変わる**。
      薄い帯（h-7）なので、押してすぐ下へ抜けるのは普通に起きる。
    */
    if (event.buttons === 0) {
      掴み.current = null
      set運び(null)
      return
    }
    // **少し動くまでは掴まない。** 押した指はわずかに動くのが普通
    if (!g.越えた && Math.abs(event.clientX - g.x) < 4) {
      return
    }
    if (!g.越えた) {
      g.越えた = true
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    /*
      **並びは変えない**（設計§15-11）。掴んだ瞬間の矩形から仮の位置を決め、
      **動かす量だけ**を各タブへ渡す——動き方（時間・曲線・止める段）は `reorder.css`。
    */
    const 元 = g.枠.findIndex((w) => w.path === g.path)
    const 中心 = g.枠.map((w) => w.left + w.width / 2)
    const 仮 = dropIndexFor(中心, event.clientX)
    if (仮 >= 0) {
      g.仮 = 仮
    }
    set運び({
      path: g.path,
      dx: ずれを出す(g.枠, g.間, 元, g.仮, event.clientX - g.x),
    })
  }

  const 離した = () => {
    const g = 掴み.current
    // **運んだ直後の `click` を食わせない。** 押した場所と離した場所が違うので、
    // そのまま通すと「運んだ先のタブを選んだ」ことになる
    const 運んでいた = g?.越えた === true
    運んだ.current = 運んでいた
    掴み.current = null
    if (g === null || !運んでいた) {
      set運び(null)
      return
    }

    /*
      **本人だけは、指の位置から落とし先へ滑らせてから確定する。**

      押しのけられる側は運んでいる間から既に「並べ替えたあとの位置」に居るので、
      本当に並べ替えて `translate` を外すと差し引き 0 になる。**本人だけは違う**
      ——あちらは指に 1:1 で追従しているので、離した時点の見た目は「指の位置」、
      並べ替えたあとの位置は「落とし先」で、**最大でタブ半分ぶん飛ぶ**。

      `data-dragging` を落とすと `reorder.css` の基の規則（`translate` に 200ms の
      滑り）が効くので、**落とし先へ滑ってから**入れ替える。
    */
    const 元 = g.枠.findIndex((w) => w.path === g.path)
    const 落ち着き = ずれを出す(g.枠, g.間, 元, g.仮, 0)
    const 仮 = g.仮
    const path = g.path
    落ち着き[path] =
      (g.枠.find((w) => w.path === g.枠[仮]?.path)?.left ?? 0) -
      (g.枠[元]?.left ?? 0)
    // **持ち上げは落とす**（`data-dragging` を外す）ので、滑りの規則が効く
    set運び({ path: null, dx: 落ち着き })

    const 確定する = () => {
      /*
        **ここで初めて並びを変える。** 滑り終わった見た目が「並べ替えたあとの姿」
        なので、入れ替えて `translate` を外すと差し引き 0——飛ばない。

        **覚えるのもここだけ。** 運んでいる最中に覚えると、動くたびに `localStorage`
        を同期で読み書きすることになる。
      */
      落ち着き待ち.current = null
      set運び(null)
      onReorder(path, 仮)
      onReorderCommit()
    }
    // **「静止」なら待たない。** 滑らない設定で待つと、ただ遅れるだけになる
    if (quiet === 'still') {
      確定する()
      return
    }
    落ち着き待ち.current = globalThis.setTimeout(確定する, 滑り)
  }

  return (
    <div
      ref={stripRef}
      data-testid="file-tabs"
      role="tablist"
      aria-label="開いているファイル"
      onKeyDown={矢印}
      onPointerMove={動かした}
      onPointerUp={離した}
      onPointerCancel={離した}
      /*
        **運んだ印を、ここで落とす。**

        実ブラウザでは、運んだあとの `click` は**押した相手（タブ）ではなく共通の親
        （この帯）へ届く**——キャプチャ先が帯だからである。タブ側だけで落としていると
        印が残り、**次にキーボードで選ぼうとした1回目が黙って無視される。**
        タブの `onClick` は先に走る（内側から外側へ上がる）ので、ここで落として安全。
      */
      onClick={() => {
        運んだ.current = false
      }}
      /*
        **`min-w-0` が要る。** flex の子は既定で中身より小さくならないので、これが無いと
        タブ帯が縮まず、右のボタン群を画面の外へ押し出す。

        `overscroll-x-contain` は、端まで送ったときに**ブラウザの「戻る」へ漏れる**のを
        断つ（レールが同じ理由で持っている）。**レールへの連鎖そのものは残す**——
        入れ子の内側が先に消費し、端まで行ったら外へ渡るのが既定の振る舞いで、
        ここでは正しい。
      */
      /* **`select-none`。** 掴んで運ぶ間、名前が選択されるのを止める */
      /*
        **切る器の内側に、掴んだ1枚が入るだけの余地を作る**（`DESIGN.md` §48.18）。

        `overflow-x` を非 `visible` にすると **`overflow-y` も `auto` へ計算される**ので、
        この帯は**上下も切る**。中のタブと帯の高さはどちらも 28px なので、**箱の外へ
        描くもの（`ring-2`・傾いた角）は 1px も入らない**——掴むと角が平らに落ち、
        ring が消える。

        **縮めても直らない。** 切っているのは倍率ではなく帯の高さで、`ring-2` は
        等倍・傾き 0 でも 2px 外へ出る。**動き（`reorder.css`）はカードと共通なので、
        あちらを触ると一覧の手触りまで変わる**——直すのは器の側だけにする。

        **6px は逆算した値**（`FileTabs.test.tsx` が同じ式で数え直す）。いちばん広い
        スロット（ラベル 192 ＋ ✕ 24 ＋ 2）に `ring-2` を足して `--reorder-lift` 倍し、
        `--reorder-tilt` だけ傾けると、片側へ **4.29px** はみ出す。

        **`-my-1.5` で外形は 28px のまま。** 上下の 6px は `FileView` の `pt-2` と
        `gap-2`（どちらも 8px）へ逃げるので、**帯は 1px も高くならない**。

        **横には作らない。** 傾きが動かすのは縦で、横は倍率ぶんしか出ない。しかも
        **横の余地は端のタブにしか効かない**のに、代償として**帯だけが 4px 内側から
        始まる**（下の本文は端に届いている）。端のタブを運ぶ向きは必ず内側なので、
        指を動かした最初の数 px で切られなくなる——**永続する食い違いのほうが高くつく。**
      */
      className="flex min-w-0 flex-1 select-none items-center gap-1 overflow-x-auto overscroll-x-contain py-1.5 -my-1.5"
    >
      {tabs.map((path, i) => {
        const selected = path === current
        const label = labels[i] ?? path
        return (
          <div
            key={path}
            /*
              **選ばれている1枚は Primary Accent を面で出す**（`DESIGN.md` §8 の床）。
              線や字の色だけで示すと、流し見で「どれが出ているか」が読めない。
            */
            /*
              **沈めるのに透明度を使わない**（PJT ガイドライン）。選ばれていない
              タブの hover は**薄くするのではなく、別の不透明な地へ移す**——薄くすると
              裏の地が透け、しかも「裏に何が来るか」で見え方が変わる。
            */
            data-tab-slot=""
            data-path={path}
            /*
              動きは `reorder.css` が持つ。印は2つ要る——**並び全員が滑る**
              （`data-reorder-item` ＋ `data-reordering`）のと、**持っているものだけが
              浮く**（`data-dragging`）。
            */
            data-reorder-item=""
            data-reorder-kind="tab"
            data-reordering={運び !== null ? 'true' : 'false'}
            data-dragging={path === 運び中 ? 'true' : undefined}
            // **賑やかのときは属性ごと出さない。**「静止」なら滑らせない
            data-quiet={quiet === 'lively' ? undefined : quiet}
            style={
              運び === null
                ? undefined
                : ({ '--reorder-dx': `${運び.dx[path] ?? 0}px` } as CSSProperties)
            }
            className={`flex h-7 shrink-0 items-center rounded-md transition-colors data-[dragging=true]:ring-2 data-[dragging=true]:ring-ring/60 ${
              selected
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-secondary hover:text-foreground'
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid="file-tab"
              data-path={path}
              // **基準は画面に出さず `title` へ**（もとの chip から引き継ぐ）
              /* **ポインタ以外の道を、押す本人が見つけられるようにする**（WCAG 2.5.7）。
                 並べ替えは掴んで運べるが、それだけだとキーボードの人に道が無い */
              title={`${path}（${root} からの相対パス）\n並べ替え：Ctrl+Shift+← →`}
              onPointerDown={(event) => 押した(event, path)}
              onClick={() => {
                // **運んだあとの押下は、選び直しではない**
                if (運んだ.current) {
                  運んだ.current = false
                  return
                }
                onSelect(path)
              }}
              className="h-full max-w-[12rem] cursor-pointer truncate rounded-l-md pr-1 pl-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {label}
            </button>
            <button
              type="button"
              data-testid="file-tab-close"
              data-path={path}
              aria-label={`${label} を閉じる`}
              title={`${label} を閉じる`}
              /*
                **親へ伝わらせない。** 伝わると、閉じたのに同じタブを選び直したことに
                なり、`useFilesParts` 側の並びと選択が食い違う。
              */
              onClick={(event) => {
                event.stopPropagation()
                onClose(path)
              }}
              className="mr-0.5 grid size-6 shrink-0 cursor-pointer place-items-center rounded outline-none hover:bg-black/20 focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <CloseGlyph className="size-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
