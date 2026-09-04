/**
 * フォルダを辿る側の区画——**サイドバー**（設計§2・§3）。
 *
 * # 広い窓では被せない。狭い窓でだけ被せる
 *
 * 当初は「広い画面と狭い画面で作りを分けない（どちらも被せる）」で作って配ったが、
 * **2026-08-27 に覆った**（`計画.md` フェーズ7）。サイドバーは**開いたまま読む時間が
 * 長い**（ファイルを選んでも畳まない）ので、被さっている限りその裏は読めない。
 * 広い窓には押しのけるだけの余地があるので、そちらでは隠さない。
 *
 * | 窓の幅 | サイドバー | 右にあるもの |
 * |---|---|---|
 * | 広い | 被さらない | **右へずれる** |
 * | 狭い | 被さる（全幅の層） | 動かない（下に隠れる） |
 *
 * # 押しのけ方——**隣に「場所取り」を置く**
 *
 * パネル自身をフローへ入れて幅を動かす道は、**既に潰れている**。
 *
 * **`style={{ width }}` を直に当ててはいけない。** 狭い窓の `fixed inset-0` は `left` と
 * `right` の両方が 0 で、そこへ `width` が加わると過剰指定になり `right` が捨てられる
 * ——**全幅のドロワーが 320px の帯に化ける**（フェーズ1 の実測）。動きを付ける以上、
 * `width` はインラインで当たるので、**`md:` の外で効いてしまうものは使えない。**
 *
 * かといって「開いた瞬間に場所ができて、パネルが後から滑り込む」形も採らない。
 * **右が先にずれ、サイドバーが遅れて追いつく**、いちばん見苦しい形になる。
 *
 * そこで**パネルの隣に、同じ幅の空きだけを作る要素を置く**。場所取りは
 * `hidden md:block` なので、**狭い窓では `display:none`**——framer が当てるインラインの
 * `width` は1ピクセルも効かず、上の罠を踏まない。
 *
 * **これで「スライドインするのに合わせて右へ寄る」が、字の上で保証される。**
 * `translateX(-100%)` はパネル自身の幅ぶん左へ寄せることなので、**パネルの右端は常に
 * 「場所取りの幅」と一致する**——半分まで進んだ時点で、パネルの右端も場所取りの幅も
 * ちょうど半分になる。同じ `transition` を使う限り、隙間は原理的に開かない。
 *
 * **掴んでいる間は動きを消す。** ドラッグ中は幅が毎フレーム変わるので、tween を挟むと
 * 場所取りだけがパネルから遅れる。パネルの側は CSS 変数で即座に変わるため、
 * **合わせるには場所取りの動きを止めるしかない**。
 *
 * # 狭い窓は「左端の帯」。全画面にしない
 *
 * **2026-08-28 に直した。** それまでは `fixed inset-0` で**画面全体を覆っていた**が、
 * 実機で触って3つの不具合になった——裏が何も見えない・アプリのヘッダごと覆うので
 * 切り替えボタンへ届かない・被さっているのか画面が切り替わったのか分からない。
 *
 * **利用者が示した参考は ChatGPT のウェブアプリ**（`参考/` の画面録画）。狭い窓での
 * 振る舞いはこうなっている。
 *
 * | 何 | どう |
 * |---|---|
 * | 幅 | **約 320px の帯**（窓 740px に対して 43%）。全画面にはしない |
 * | 裏の本文 | **その場に残って見えている**（押しのけない） |
 * | 膜（暗くする覆い） | **在る。** 画面全体が**約半分の明るさ**になる |
 * | 閉じ方 | **サイドバーの中の閉じるボタン** |
 *
 * そのまま写した——`w-[min(85vw,20rem)]` は、ふだんは 320px で、**画面が 376px より
 * 狭いときだけ 85% に縮む**。どれだけ狭い機械でも**裏が15%は見えている**ので、
 * 「画面が切り替わった」と読み違えることがない。
 *
 * # 膜は、目で見ずに測って決めた
 *
 * **最初は「膜は無い」と読み違えた。** 地が黒い画面なので、目で見ても差が分からない。
 * フレームの画素を測って初めて分かった——**同じ場所の明るさが 255→131・32→17 と、
 * 3箇所とも同じ比で落ちている**（ヘッダも本文も入力欄も）。つまり**画面全体を覆う
 * 約半分の黒**である。`bg-black/50` がそのままこの数字になる。
 *
 * **膜を押したら閉じる。** 参考の動画では閉じるボタンしか押されておらず**確かめられて
 * いない**が、膜は裏への操作を塞ぐので、**押しても何も起きない膜は行き止まりになる**。
 * 閉じるボタンと合わせて2通りの出口を持たせた。
 *
 * **広い窓のほうは1バイトも変えていない**（下記の場所取り）。
 *
 * # 幅は CSS 変数で運ぶ
 *
 * Tailwind のクラスは静的なので、動く値は変数で渡して `md:` の側で受ける。こうすると
 * **幅が当たるのは広い窓だけ**になり、`md` を JS から読まずに済む（web/src には
 * JS から読んでいる箇所が1件も無い）。
 *
 * # 出入りに動きを付ける
 *
 * 左からスライド（設計§6・`DESIGN.md` §28.2 の Panel 段）。OS の「動きを減らす」は
 * `App.tsx` の `<MotionConfig reducedMotion="user">` が引き受けるので、ここでは見ない。
 */

import { motion } from 'motion/react'
import type { CSSProperties } from 'react'
import { FolderBrowser } from '@/components/FolderBrowser/FolderBrowser'
import { FilesResizer } from '@/components/ProjectFiles/FilesResizer'
import { Button } from '@/components/ui/button'
import { CloseGlyph } from '@/components/ui/glyphs'
import type { PanelEdge } from '@/lib/panelWidth'

/**
 * 滑る速さ。180〜300ms の中（設計§6）——速すぎると出たことに気づかず、遅いと待たされる。
 *
 * **パネルと場所取りが同じものを使う。** 別々に書くと、片方だけ直したときに
 * 隙間が開くようになる。
 */
const スライド = { duration: 0.22, ease: [0.22, 1, 0.36, 1] } as const

/** 掴んでいる間の「動かさない」。**0秒の tween であって、無効化ではない。** */
const 即時 = { duration: 0 } as const

interface Props {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /** その枠のパス。起点であり、相対パスの基準でもある */
  project: string
  /**
   * 最初に見せる場所。**覚えていた場所がここへ来る**（`イシューグループ_2026-0813-1804` 設計§5-1）。
   *
   * `project` と分けてあるのが要点で、**辿らせる範囲（`root`）は起点のままに、
   * 始める場所だけを動かす**。同じ値を両方へ渡していた頃は、覚えた場所を渡すと
   * 辿れる範囲まで動いてしまう形だった。
   */
  start: string
  /** いま見ている場所が変わるたびに呼ばれる。**覚えるのは受け取った側**（設計§4） */
  onPathChange: (path: string) => void
  /** 幅（px）。**利用者が縁で決める**ので動的 */
  width: number
  /** 縁を掴んでいるか。**場所取りの動きを止めるためだけに使う** */
  dragging: boolean
  onPickFile: (path: string) => void
  /** 切り替えボタンと同じ手。狭い窓ではあちらが隠れる位置に来るので、ここにも出す */
  onClose: () => void
  onGrab: () => void
  onMove: (edge: PanelEdge, width: number) => void
  onDrop: () => void
}

export function Sidebar({
  host,
  project,
  start,
  onPathChange,
  width,
  dragging,
  onPickFile,
  onClose,
  onGrab,
  onMove,
  onDrop,
}: Props) {
  return (
    <>
      {/*
        **膜。** 狭い窓でだけ敷く（`md:hidden`）。裏が見えたままだと、被さっているのか
        画面が切り替わったのか分からない——**暗くすることで「奥にある」と読める**
      */}
      <motion.div
        aria-hidden
        data-testid="sidebar-scrim"
        className="fixed inset-0 z-30 bg-black/50 md:hidden"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={スライド}
        onClick={onClose}
      />

      {/*
        **場所取り。** 見せるものは何も無く、広い窓で幅を作ることだけが仕事なので
        `aria-hidden`。`hidden md:block` が狭い窓での安全弁になっている（上の JSDoc）
      */}
      <motion.div
        aria-hidden
        data-testid="sidebar-space"
        initial={{ width: 0 }}
        animate={{ width }}
        exit={{ width: 0 }}
        transition={dragging ? 即時 : スライド}
        className="hidden md:block md:shrink-0"
      />

      <motion.aside
        data-testid="project-files-panel"
        initial={{ x: '-100%' }}
        animate={{ x: 0 }}
        exit={{ x: '-100%' }}
        transition={スライド}
        style={{ '--files-folder-w': `${width}px` } as CSSProperties}
        className="bg-background fixed inset-y-0 left-0 z-40 flex w-[min(85vw,20rem)] min-h-0 flex-col gap-2 p-3 md:absolute md:w-[var(--files-folder-w,20rem)] md:p-0 md:pr-3"
      >
        <div className="flex items-center gap-2 md:hidden">
          <span className="text-sm font-semibold">ファイル</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="project-files-close"
            aria-label="閉じる"
            title="閉じる"
            className="ml-auto"
            onClick={onClose}
          >
            <CloseGlyph />
          </Button>
        </div>

        {/*
          **高さの鎖の最後の輪**（設計§7）。`FolderBrowser` の `h-full` はこの段に対して
          解決される。一覧のスクロールは `FolderBrowser` の中が持つので、ここでは二重に
          持たない（移設前の `ProjectFiles` の1段目をそのまま運んできたもの）
        */}
        <div data-testid="project-files" className="min-h-0 flex-1 overflow-hidden">
          <FolderBrowser
            host={host}
            start={start}
            root={project}
            /*
              **起点を「黙って行き直す先」として渡す。** `start` は覚えていた場所で、
              利用者がいま押したものではない——着けなかったときに赤い1行で出迎えない
              ようにする（設計§6-2）。追加シートはこれを渡さないので、あちらは
              いままでどおり理由を出す
            */
            fallback={project}
            onPathChange={onPathChange}
            onPickFile={onPickFile}
          />
        </div>

        <FilesResizer
          edge="folder"
          width={width}
          label="フォルダの幅"
          onGrab={onGrab}
          onMove={onMove}
          onDrop={onDrop}
        />
      </motion.aside>
    </>
  )
}
