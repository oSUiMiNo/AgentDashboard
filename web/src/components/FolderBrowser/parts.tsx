import type { ReactNode } from "react"
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { ChevronGlyph, CloseGlyph, CopyGlyph } from '@/components/ui/glyphs'
import { OpenInMenuItems } from '@/components/OpenIn/OpenInMenuItems'
import { OpenedMark } from '@/components/OpenIn/OpenedMark'
import { fileIcon } from '@/lib/fileKind'
import { FileTypeIcon } from '@/components/ui/fileTypeIcon'
import { rawUrl, relativeOf, type DirEntry } from '@/lib/hostfs'
import { isOpenedIn, type OpenApp, type OpenInView } from '@/lib/openIn'

/** `openIn` の形。`FolderRow` にも同じものを渡す */
export interface OpenInProp {
  view: OpenInView
  open: (app: OpenApp, path: string) => void
  busy: boolean
}

export function CopyFallback({
  value,
  onDismiss,
}: {
  value: string
  onDismiss: () => void
}) {
  return (
    <p
      data-testid="folder-copy-failed"
      className="flex items-start gap-1 text-xs text-amber-300"
    >
      <span className="min-w-0 flex-1">
        コピーできません。この値を選んで取ってください：{" "}
        <code
          data-testid="folder-copy-fallback"
          className="bg-muted/60 rounded px-1 py-0.5 font-mono select-all"
        >
          {value}
        </code>
      </span>
      {/* **消すのは人の手だけ**（項目5-c）。時間で消すと、値を選んで取る前に
          逃げ道が消える。`DESIGN.md`「知らせの出し方」の**続いている状態**——
          人が片付けるまで残すもの——に当たる */}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="folder-copy-failed-dismiss"
        aria-label="閉じる"
        title="閉じる"
        className="shrink-0"
        onClick={onDismiss}
      >
        <CloseGlyph />
      </Button>
    </p>
  )
}

/**
 * 素の左クリックか。**ここだけが、ブラウザから押し方を奪う。**
 *
 * `react-router` の `<Link>` が中でやっているのと同じ判定である（左ボタン＋修飾キーが
 * どれも立っていない）。**発明しない**——独自の形にすると、`Cmd` で背面のタブ・`Shift`
 * で新しい窓・`Alt` で保存という、押す人が既に知っている作法が場所ごとに変わる。
 *
 * **中クリックはここへ来ない**（`auxclick` になる）ので、本来は要らない。それでも
 * `button === 0` を見るのは、**`click` として中ボタンが届く環境への保険**である。
 */
function 素の左クリックか(event: {
  button: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  return (
    event.button === 0 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey
  )
}

/**
 * 1行。**開く的とコピーの的を分ける**（設計§13）。
 *
 * 行全体を1つのボタンにすると、狭い画面では的が大きくて押しやすい代わりに、
 * **中に別のボタンを置けない**（入れ子のボタンは HTML として成立しない）。
 * コピーは要件が名指ししている用途（エージェントへ渡す値を作る）なので、
 * 的を2つに割って両方を成立させる。
 *
 * リンクは辿らない（設計§8）ので、押しても入らない。在ることだけを示す。
 *
 * # ファイルの行だけ、本物のリンクにする
 *
 * **中クリックと Ctrl／Cmd＋左クリックで、ブラウザの新しいタブに開くため。**
 * `<button>` にはその道がブラウザ側に用意されていないので、いくら押しても何も起きない。
 *
 * **中クリックのためのコードは1行も書いていない。** リンクにすれば、中クリックも修飾
 * キーもキーボード操作もブラウザが最初から持っている——`lib/openInNewTab.ts` が
 * 「**`<a>` にできるものは `<a>` に任せる**」と決めた規則そのままである。だから
 * あの補助はここでは使わない。書くのは**素の左クリックを奪う1箇所**だけで、これは
 * `react-router` の `<Link>` が中でやっているのと同じ形。
 *
 * 行き先は `rawUrl`（`lib/hostfs.ts`）で、**ファイルビュアの「ブラウザで開く」と同じ
 * ものを使う**（`v0.1.82`）。画面で URL を継ぎ足さない。
 *
 * ## `target="_blank"` を付けない
 *
 * 付けると**素の左クリックまで新しいタブになり**、「押したらアプリの中で開く」という
 * いまの意味が変わる。ファイルビュアの「ブラウザで開く」に付いているのは、**あれが
 * 押したら必ず外へ出るもの**だからで、事情が違う。
 *
 * ## `Space` が効かなくなる（承知のうえ）
 *
 * **リンクはキーボードでは `Enter` だけ**で、`Space` では開かない。役割が `button` から
 * `link` へ変わるので、支援技術の案内もそちらへ揃う。**独自に `Space` を足さない**
 * ——役割がリンクなのに `Space` で動く要素は、案内と実際の操作が食い違う。
 *
 * 代わりに、**同じ一覧の中に `Space` が効く行（フォルダ）と効かない行（ファイル）が
 * 混ざる**。望ましくはないが、`Enter` はどちらでも効くので行き止まりにはならず、
 * フォルダをリンクにする道は無い（**行き先の URL が無い**）ので揃えようもない。
 * **覆すなら、覆した理由を要件へ書き足すこと。**
 *
 * ## ボタンのまま据え置くもの
 *
 * | 何 | なぜ |
 * |---|---|
 * | **フォルダ** | 押すのは**この中で辿る**動き（ツリーではその場で展開・畳む、追加シートでは中へ入る）で、外に行き先が無い |
 * | **`symlink`** | 設計§8 で「辿らない」と決めてあり、いまも押せない |
 * | **`onPickFile` が渡らない場面**（PJT の追加シート） | あの画面はファイルを見るためのものではない |
 */
export function FolderRow({
  as: Outer = "li",
  density = "list",
  depth = 0,
  twistie = "none",
  expanded,
  entry,
  full,
  host,
  root,
  onOpen,
  onPickFile,
  current = false,
  copyState,
  onCopy,
  openIn,
  menu = "row",
  opened,
}: {
  as?: "li" | "div"
  density?: "list" | "tree"
  depth?: number
  twistie?: "expanded" | "collapsed" | "none"
  expanded?: boolean
  current?: boolean
  entry: DirEntry
  /** この行が指す絶対パス */
  full: string
  /** `agent_id` かローカルを表す `'local'`。**リンクの行き先を組み立てるのに要る** */
  host: string
  /** 相対パスの基準。無ければ絶対パスをコピーする */
  root?: string
  onOpen: () => void
  onPickFile?: () => void
  /** この行のコピーがどうなったか。**答えを持つのは1行だけ**（親が決める） */
  copyState: "idle" | "done" | "failed"
  onCopy: (value: string) => void
  /** エクスプローラ・VSCode で開く口。**親PC の画面のサイドバーだけ**が渡す（設計§7-1） */
  openIn?: OpenInProp
  menu?: "row" | "outside"
  opened?: boolean
}) {
  const openable = entry.kind === "dir"
  // **`file` に限る。** `symlink` を混ぜると、いままで押せなかった行が押せるようになる
  const linkable = entry.kind === "file" && onPickFile !== undefined
  const pressable = openable || linkable
  // 送ったパスの文字のままと、正規化した実体のパスの両方で突き合わせる（設計§3-6）
  const 開いている = opened ?? (openIn !== undefined && isOpenedIn(openIn.view, full))

  const ツリー = density === "tree"
  // 的はできるだけ大きく取る。高さも狭い画面で押しやすい値にしてある
  const 行のクラス = ツリー
    ? `h-7 min-w-0 flex-1 justify-start gap-2 overflow-clip px-2 py-0 text-left touch:h-auto touch:py-2 aria-expanded:bg-transparent font-normal${current ? " folder-entry-current" : ""}`
    : `h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-2 text-left font-normal${current ? " folder-entry-current" : ""}`
  const 字下げ = ツリー ? { paddingLeft: `${depth * 12 + 8}px` } : undefined

  // 深い階層で「どれが目的地か」を1階層ぶん先に教える（設計§8）。**1つの式から作る**
  // ——開く口の有無で2箇所に書くと、片方だけ直されて札の形が割れる
  const 札 = (寄せ方: string) => (
    <span
      data-testid="folder-project-mark"
      title="このフォルダは .git を持っています"
      className={`border-primary/40 text-primary shrink-0 rounded border px-1 text-[10px]${寄せ方 === "" ? "" : ` ${寄せ方}`}`}
    >
      PJT
    </span>
  )

  const 中身 = (
    <>
      {ツリー && (
        <span aria-hidden data-testid="folder-twistie" className="text-muted-foreground grid size-4 shrink-0 place-items-center">
          {twistie !== "none" && (
            <span className="folder-tree-twistie" data-expanded={twistie === "expanded" ? "true" : "false"}>
              <ChevronGlyph direction="right" className="size-4" />
            </span>
          )}
        </span>
      )}
      {/* **開く前に、何が起きるかが分かる印。** 画像とテキストが同じ印だと、
          押してみるまで箱が出るのか字が出るのか分からない（種別ごとに見せ方が
          違うと決めてあるので、印もそこへ合わせる） */}
      <span aria-hidden data-testid="folder-entry-icon" className="grid shrink-0 place-items-center">
        <FileTypeIcon
          className="size-[18px]"
          type={entry.kind === "dir" ? "folder" : entry.kind === "symlink" ? "link" : fileIcon(entry.name)}
          tone={ツリー && entry.kind === "dir" && twistie === "collapsed" ? "closed" : undefined}
        />
      </span>
      {/*
          **切った先を、乗せれば読める。** 幅が狭いと末尾が見切れるが、切ること自体は
          変えない（要件の指定）。読む手立てだけを足す。

          **出すのは名前だけ。** フルパスは同じ行のコピーの押しボタンが担っており、
          役割が重ならない。

          **切れていないときも出る。** 出し分けるには描いたあとに幅を測ることになり、
          純粋な描画から外れる。既にある6箇所の前例もすべて常に出す形なので揃える。

          **これは指では効かない。** 乗せる操作がスマホに無いので、**同じ名前を
          右クリック（長押し）のメニューにも見出しとして出している**（下記）。
          幅が狭くていちばん見切れるのがスマホなので、片方だけでは主戦場が救われない。
      */}
      <span title={entry.name} className="min-w-0 truncate">
        {entry.name}
      </span>
      {ツリー
        ? 開いている
          ? (
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <OpenedMark />
                {entry.is_project && 札("")}
              </span>
            )
          : entry.is_project && 札("ml-auto")
        : openIn === undefined
          ? entry.is_project && 札("ml-auto")
          : (開いている || entry.is_project) && (
              // **行末へ寄せるのは入れ物の側。** 印だけ・札だけ・両方のどれでも行末に並ぶ
              // （開く口の設計§7-4）
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {開いている && <OpenedMark />}
                {entry.is_project && 札("")}
              </span>
            )}
    </>
  )

  const 行 = (
    <Outer
      className={ツリー ? "folder-tree-row flex items-center gap-1" : "flex items-center gap-1"}
      data-row-path={menu === "outside" ? full : undefined}
    >
      {linkable ? (
        <Button asChild variant="ghost" className={行のクラス}>
          <a
            data-testid="folder-entry"
            aria-current={current ? "page" : undefined}
            data-kind={entry.kind}
            data-name={entry.name}
            data-path={ツリー ? full : undefined}
            style={字下げ}
            href={rawUrl(host, full)}
            // **開いた先から元の窓を触らせない。** `FileView` と揃える
            rel="noopener"
            onClick={(event) => {
              // **修飾キー付きと中ボタンは、止めずにブラウザへ渡す。**
              // ここで `preventDefault` を呼ばないことが、新しいタブが開く条件
              if (!素の左クリックか(event)) return
              event.preventDefault()
              onPickFile()
            }}
          >
            {中身}
          </a>
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          data-testid="folder-entry"
          data-kind={entry.kind}
          data-name={entry.name}
          data-path={ツリー ? full : undefined}
          aria-expanded={ツリー && entry.kind === "dir" ? expanded : undefined}
          style={字下げ}
          disabled={!pressable}
          onClick={openable ? onOpen : undefined}
          className={行のクラス}
        >
          {中身}
        </Button>
      )}
      <CopyPath
        full={full}
        root={root}
        isDir={entry.kind === "dir"}
        state={copyState}
        onCopy={onCopy}
      />
    </Outer>
  )

  if (menu === "outside") {
    return 行
  }

  return (
    /*
      **右クリックでメニューを出す**（要件27・設計§8-4）。`radix-ui` の `ContextMenu` は
      DOM を足さない器なので、`ul` の直下は `li` のままである——**表の構造を崩さずに
      掛けられる**。中身はまず「絶対パスをコピー」だけ（要件の指定）。

      **押した結果は行のコピーと同じ道を通す。** 別の道を作ると、写せない環境の逃げ道
      （`folder-copy-fallback`）が右クリック経由のときだけ出なくなる。

      **リンクにしても、右クリックはブラウザではなくここが取る。** だから「新しいタブで
      開く」も**このメニューが自分で出す**（下記）——出さないと、右クリックからも
      長押しからも道が消える。

      **【2026-09-08 に変わった】** それまでは道が中クリックと Ctrl／Cmd＋左クリックの
      2つだけで、**指で触る画面には1本も無かった**。
    */
    <ContextMenu>
      <ContextMenuTrigger asChild>{行}</ContextMenuTrigger>
      <PathMenu
        name={entry.name}
        path={full}
        kind={entry.kind}
        tabUrl={linkable ? rawUrl(host, full) : undefined}
        openIn={openIn}
        onCopy={onCopy}
      />
    </ContextMenu>
  )
}

export function PathMenu({
  name,
  path,
  kind,
  tabUrl,
  openIn,
  onCopy,
}: {
  name: string
  path: string
  kind: DirEntry["kind"]
  tabUrl?: string
  openIn?: OpenInProp
  onCopy: (value: string) => void
}) {
  return (
    <ContextMenuContent data-testid="folder-menu">
      {/*
        **指で触る画面では、名前の全体を読む唯一の道である。** 乗せたら出す指定は
        マウスのある環境でしか効かず、**幅が狭くていちばん見切れるのはスマホ**——
        つまり困っている側だけが救われない形になる。ここに置いて裏返す。

        **フォルダにもファイルにも出す。** 見切れるのは種別を問わないので、
        下の「新しいタブで開く」（ファイルだけ）とは分け方が違う。

        **押せない部品で出す。** 押せる選択肢に混ぜると、押してみるまで押せないと
        分からない。
      */}
      <ContextMenuLabel data-testid="folder-name-full">
        {name}
      </ContextMenuLabel>
      <ContextMenuSeparator />
      {/*
        **指で触る画面では、これが唯一の道である。** 中クリックも Ctrl＋クリックも
        スマホには無いので、ここに置かないと**ブラウザの新しいタブへ出る道が1本も
        残らない**（右クリックの既定メニューは、このメニュー自身が奪っている）。

        **開くほうを先に置く。** ブラウザの右クリックメニューが「新しいタブで開く」
        →「リンクのアドレスをコピー」の順なので、**押す人が既に持っている並びに
        合わせる**。

        **項目もリンクにする**（`ContextMenuItem asChild`）。`window.open` は
        スマホで抑止されることがあるが、**リンクの既定動作は抑止されない**。
        行のほうと同じ判断（`lib/openInNewTab.ts` の規則4）でもある。

        **ここでは `target="_blank"` を付ける。** 行に付けないのは素の左クリックの
        意味が変わるからで、**こちらは押したら必ず外へ出るもの**だから事情が違う
        （ファイルビュアの「ブラウザで開く」と同じ）。

        **フォルダには出さない。** 行き先の URL が無く、出しても押せないものが
        並ぶだけになる（`linkable` はファイルの行だけで真になる）。
      */}
      {tabUrl !== undefined && (
        <ContextMenuItem asChild data-testid="folder-menu-open-tab">
          <a href={tabUrl} target="_blank" rel="noopener">
            ブラウザの新しいタブで開く
          </a>
        </ContextMenuItem>
      )}
      {/*
        **エクスプローラ・VSCode で開く**（開く口の設計§7-5）。「新しいタブで開く」の後、
        「絶対パスをコピー」の前。フォルダの行は見出しの下の区切り線がそのまま上の区切りに
        なるので、前の区切り線を重ねない
      */}
      {openIn !== undefined && (
        <>
          {tabUrl !== undefined && <ContextMenuSeparator />}
          <OpenInMenuItems path={path} view={openIn.view} open={openIn.open} />
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem
        data-testid="folder-menu-copy-abs"
        onSelect={() => onCopy(path)}
      >
        絶対パスをコピー
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="folder-menu-copy-name"
        onSelect={() => onCopy(name)}
      >
        {kind === "dir" ? "フォルダ名をコピー" : kind === "file" ? "ファイル名をコピー" : "名前をコピー"}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

export function CrumbCopyState({ show }: { show: boolean }) {
  return show ? (
    <span
      data-testid="folder-crumb-copy-state"
      className="bg-popover text-popover-foreground pointer-events-none absolute top-full left-0 z-20 mt-0.5 rounded-md border px-1.5 py-0.5 whitespace-nowrap shadow-md"
    >
      コピーしました
    </span>
  ) : null
}

export function AboveRootCrumb({
  crumb,
  openIn,
  onCopy,
  answer,
}: {
  crumb: { label: string; path: string }
  openIn?: OpenInProp
  onCopy: (value: string) => void
  answer: ReactNode
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span title={`起点より上：${crumb.path}`} className="relative flex items-center gap-1">
          <button
            type="button"
            data-testid="folder-crumb"
            disabled
            title={`起点より上：${crumb.path}`}
            aria-label={`起点より上：${crumb.path}`}
            className="text-muted-foreground pointer-events-none rounded px-1 py-0.5"
          >
            …
          </button>
          {answer}
        </span>
      </ContextMenuTrigger>
      <PathMenu
        name={crumb.label}
        path={crumb.path}
        kind="dir"
        openIn={openIn}
        onCopy={onCopy}
      />
    </ContextMenu>
  )
}

/**
 * その行のパスをコピーする（設計§15。要件「フォルダやファイルのパスを渡す」）。
 *
 * `root` があれば**そこからの相対パス**、無ければ絶対パス。基準が分からない相対パスは
 * 貼られた側で解釈できないので、**何をコピーするのかは `title` に出す**。
 *
 * **自分では状態を持たない**（設計§5）。写せなかったときの逃げ道はパネルの上に1箇所
 * しか出さないので、「どの行がどうなったか」は親が1組だけ持つ。ここは押されたことを
 * 上へ伝え、返ってきた答えを字にするだけである。
 *
 * **`title` と `data-value` はそのまま残す。** マウスのある環境では、いまも役に立つ。
 *
 * # 絵にしたのはボタンだけで、結果ではない（要件23・設計§8-3）
 *
 * **結果まで絵にすると、成功と失敗が見分けられない。** 押したあとに文字が一時的に
 * 出る形は変えていない。
 *
 * **`aria-label` には基準を付ける。** 絵だけになると、読み上げでは「何をコピーするのか」
 * が分からなくなる——`title` は指で触る画面では読めないので、**両方に持たせる**。
 */
function CopyPath({
  full,
  root,
  isDir,
  state,
  onCopy,
}: {
  full: string
  root?: string
  isDir: boolean
  state: "idle" | "done" | "failed"
  onCopy: (value: string) => void
}) {
  const base = root === undefined ? full : relativeOf(root, full)
  // **フォルダは末尾に `/` を付ける。** 貼られた側で「これは入れ物か中身か」が
  // 一目で分かり、続けて名前を書き足すときにも区切りを打ち直さずに済む
  const value = isDir && !base.endsWith("/") ? `${base}/` : base

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid="folder-copy"
      data-value={value}
      title={
        root === undefined
          ? `コピーする値：${value}`
          : `コピーする値：${value}（${root} からの相対パス）`
      }
      aria-label={
        root === undefined
          ? `パスをコピー：${value}`
          : `パスをコピー：${value}（${root} からの相対パス）`
      }
      className="text-muted-foreground shrink-0 gap-1 text-xs"
      onClick={() => onCopy(value)}
    >
      <CopyGlyph className="size-3.5" />
      {state !== "idle" && (
        <span data-testid="folder-copy-state">
          {state === "done" ? "コピーしました" : "コピーできません"}
        </span>
      )}
    </Button>
  )
}
