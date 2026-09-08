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

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { CloseGlyph } from '@/components/ui/glyphs'
import { dropIndexFor, stripScrollFor, tabLabels } from '@/lib/fileTabs'

interface Props {
  /** 開いているタブの絶対パス（左から右の順） */
  tabs: string[]
  /** いま見ている1枚の絶対パス */
  current: string
  /** 相対パスの基準（その枠のパス）。`title` に出す */
  root: string
  onSelect: (path: string) => void
  onClose: (path: string) => void
  /** 並べ替え。**抜いて差す**（`lib/fileTabs.ts` の `moveTab`） */
  onReorder: (from: number, to: number) => void
}

export function FileTabs({
  tabs,
  current,
  root,
  onSelect,
  onClose,
  onReorder,
}: Props) {
  const labels = tabLabels(tabs)
  const stripRef = useRef<HTMLDivElement>(null)
  /** 掴んでいるもの。**閾値を越えるまでは「押下かもしれない」ままにしておく** */
  const 掴み = useRef<{ path: string; x: number; 越えた: boolean } | null>(null)
  /** 直前の押下が並べ替えだったか。**そのあとの `click` を食わせないため** */
  const 運んだ = useRef(false)
  /** 運んでいる1枚。**見た目に出すためだけ**（判断は `掴み` が持つ） */
  const [運び中, set運び中] = useState<string | null>(null)

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
    if (帯 === null) {
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
  }, [current, tabs])

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
      const 行き先 =
        event.key === 'ArrowLeft'
          ? 今 - 1
          : event.key === 'ArrowRight'
            ? 今 + 1
            : -1
      if (行き先 < 0 || 行き先 >= tabs.length) {
        return
      }
      event.preventDefault()
      onReorder(今, 行き先)
      // 運んだ先で押し続けられるように、焦点を連れていく
      requestAnimationFrame(() => 焦点を移す(current))
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

  /** 帯の中の、各タブの中心の x（並び順） */
  function 中心を測る(): number[] {
    const 帯 = stripRef.current
    if (帯 === null) {
      return []
    }
    return tabs.map((path) => {
      const el = 帯.querySelector<HTMLElement>(
        `[data-testid="file-tab"][data-path="${CSS.escape(path)}"]`,
      )
      if (el === null) {
        return Number.POSITIVE_INFINITY
      }
      const r = el.getBoundingClientRect()
      return r.left + r.width / 2
    })
  }

  const 押した = (event: ReactPointerEvent<HTMLElement>, path: string) => {
    // **掴むのはマウスの主ボタンだけ。** 指とペンは今までどおり
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }
    掴み.current = { path, x: event.clientX, 越えた: false }
  }

  const 動かした = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = 掴み.current
    if (g === null) {
      return
    }
    // **少し動くまでは掴まない。** 押した指はわずかに動くのが普通
    if (!g.越えた && Math.abs(event.clientX - g.x) < 4) {
      return
    }
    if (!g.越えた) {
      g.越えた = true
      set運び中(g.path)
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    const from = tabs.indexOf(g.path)
    const to = dropIndexFor(中心を測る(), event.clientX)
    if (from >= 0 && to >= 0 && to !== from) {
      onReorder(from, to)
    }
  }

  const 離した = () => {
    // **運んだ直後の `click` を食わせない。** 押した場所と離した場所が違うので、
    // そのまま通すと「運んだ先のタブを選んだ」ことになる
    運んだ.current = 掴み.current?.越えた === true
    掴み.current = null
    set運び中(null)
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
        **`min-w-0` が要る。** flex の子は既定で中身より小さくならないので、これが無いと
        タブ帯が縮まず、右のボタン群を画面の外へ押し出す。

        `overscroll-x-contain` は、端まで送ったときに**ブラウザの「戻る」へ漏れる**のを
        断つ（レールが同じ理由で持っている）。**レールへの連鎖そのものは残す**——
        入れ子の内側が先に消費し、端まで行ったら外へ渡るのが既定の振る舞いで、
        ここでは正しい。
      */
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain"
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
            data-dragging={path === 運び中 ? 'true' : undefined}
            className={`flex h-7 shrink-0 items-center rounded-md transition-colors data-[dragging=true]:shadow-lg data-[dragging=true]:ring-2 data-[dragging=true]:ring-ring/60 ${
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
