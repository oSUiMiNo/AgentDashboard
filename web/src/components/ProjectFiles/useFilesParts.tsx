/**
 * ファイルの区画を組み立てて、**置き場所だけ画面に決めさせる**（設計§3・§8）。
 *
 * # なぜ器ではなくフックなのか
 *
 * もとは `FilesLayout` という部品で、サイドバーと中身の列を**並べて**返していた。
 * 2026-08-27 に「**中身の列を、セッションの札と同じようにレールの中へ入れる**」と
 * 決まった（`計画.md` フェーズ8）ので、**2つの子が別々の親へ行く**ことになった
 * ——並べて返す形のままでは置けない。
 *
 * | 案 | 採らなかった理由 |
 * |---|---|
 * | ポータルでレールの中へ差す | React の木と DOM がずれ、次に読む人が置き場所を追えない |
 * | render prop で置き場所を受け取る | 呼び元の見た目が読みにくくなる |
 *
 * **組み立て済みの2つを返し、画面はそれを置くだけにした。** 状態（選んでいるファイル・
 * 幅・掴み）は**ここ1箇所**に残る——これが `イシューグループ_2026-0813-2125` 設計§8
 * の「器を1つにする」で守りたかったことの本体で、**器が1つの `<div>` であることでは
 * なかった。**
 *
 * # 選んでいるファイルを1箇所に持つ
 *
 * サイドバーが選び、中身の列が映す。**2箇所に持つと、選んでも映らない／閉じても残る**
 * 形になる。
 *
 * # サイドバーの開閉は受け取る。持たない
 *
 * 開閉の記憶は [`useFilesPanel`] のままで、**呼ぶのは画面側**。切り替えボタンはヘッダの
 * 中に居て（PJT 専用画面とセッション専用画面でヘッダの作りが違う）、こことは別の枝に
 * ある。同じタブの中で `storage` の合図は飛ばないので、**両方が別々に
 * `useFilesPanel()` を呼ぶと、押しても片方しか変わらない。**
 */

import { AnimatePresence } from 'motion/react'
import { useCallback, useState, type ReactNode } from 'react'
import { FileColumn } from '@/components/ProjectFiles/FileColumn'
import { Sidebar } from '@/components/ProjectFiles/Sidebar'
import { usePanelWidths } from '@/lib/filesPanel'
import { putDir, putPick, readPlace } from '@/lib/filesPlace'

/**
 * いま出しているファイル。**押した1枚と、覚えていて戻した1枚を1つの状態で持つ。**
 *
 * 2つに分けない——分けると「どちらが正か」を読む側が毎回決めることになる。
 * `復元` が立っているときだけ、読めなかったら黙って畳む（設計§6-5）。
 */
type Picked = { path: string; 復元: boolean } | null

/** 覚えていたファイルを、復元の印つきで取り出す。覚えが無ければ出さない */
function 覚えた一枚(host: string, project: string): Picked {
  const pick = readPlace(host, project).pick
  return pick === null ? null : { path: pick, 復元: true }
}

interface Args {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /** その枠のパス。起点であり、相対パスの基準でもある */
  project: string
  /** サイドバーが開いているか。**記憶は `useFilesPanel` が持つ**ので、受け取るだけ */
  open: boolean
  onToggle: () => void
  /**
   * 狭い窓での中身の列の幅。**素通しするだけ**——決めるのは置く側で、
   * 意味は `FileColumn` の Props にある（`スマホでファイルビュアを開くと画面が崩れる`
   * 設計§3-2）。
   */
  狭い窓の幅?: '札' | '画面'
}

export interface FilesParts {
  /**
   * **レールの外に置く。** サイドバー本体と、その場所取り。
   *
   * レールと一緒に流れてはいけない——流れると、横へスクロールしたときに
   * 左から出ているものが画面から消える。
   */
  sidebar: ReactNode
  /**
   * **レールの中の、いちばん左に置く**（どちらの画面でも）。一緒に横へ流れる。
   * ファイルを開いていなければ `null`。
   *
   * **2026-09-04 まで、セッション専用画面にレールは無かった**（`スマホでファイルビュアを
   * 開くと画面が崩れる` 設計§2）。**それまでは「揃える先が存在しない」として
   * 取り合いの器の兄弟に置いていたが、そのせいで狭い窓ではセッションの面が 0px まで
   * 潰れていた**——672px という寸法が「レールが受け止める」前提で選ばれていたのに、
   * 前提のほうを持って来ていなかった。**いまは両方ともレールの中に居る。**
   */
  column: ReactNode
  /**
   * **人がファイルを選んだ回数。**「選んだらファイル側へ寄せる」（設計§5）に使う。
   *
   * **開いている1枚のパスではなく、回数を出す。** パスで数えると、**同じ1枚をもう一度
   * 選んだときに増えない**——セッション側へ払ったまま同じファイルを押した人が、何も
   * 起きないのを見ることになる。押すのは「見たい」という意思表示なので、いま開いて
   * いるものと同じかどうかは関係ない。
   *
   * 覚えていた1枚を復元したときと、閉じたときは**増えない**（どちらも人が押した瞬間
   * ではない）。
   */
  選んだ回数: number
}

export function useFilesParts({
  host,
  project,
  open,
  onToggle,
  狭い窓の幅,
}: Args): FilesParts {
  /*
    いま出しているファイル。**覚える**——読み込み直すと戻る
    （`イシューグループ_2026-0813-1804` 設計§5-1）。鍵は PC と PJT の組で、
    同じパスが別の PC にもありうるため両方を混ぜる。

    **押した1枚と、覚えていて戻した1枚は落とし方が違う。** 読めなかったとき、
    前者は理由を見せ、後者は黙って畳む（設計§6-5）。

    ここに持つことで、**サイドバーを畳んでも中身の列が残る**
    （`イシューグループ_2026-0826-1146` 設計§2）
  */
  const [picked, setPicked] = useState<Picked>(() => 覚えた一枚(host, project))
  // **人が押した回数**（設計§5）。復元と閉じるでは増やさない
  const [選んだ回数, set選んだ回数] = useState(0)
  const [起点, set起点] = useState(() => readPlace(host, project).dir ?? project)
  const [widths, grip, dragging] = usePanelWidths()

  /*
    **相手が変わったら、描画中に直す。**

    効果で拾うと「新しい PJT ＋ 古い開いていたファイル」の描画が1回コミットされ、
    中身の列が**前の PJT のファイルを実際に読みに行く**。セッション専用画面は
    セッションが届くまで `project` が空文字なので、この一瞬が必ず起きる。
  */
  const 相手 = `${host}\u0000${project}`
  const [前の相手, set前の相手] = useState(相手)
  if (前の相手 !== 相手) {
    set前の相手(相手)
    setPicked(覚えた一枚(host, project))
    set起点(readPlace(host, project).dir ?? project)
  }

  /*
    **畳んだサイドバーを開き直したときも読み直す。**

    `start` を固定するだけだと、畳んで開き直したときに起点へ戻る。「リロードでは
    覚えているのに畳むと戻る」は、利用者から見て同じ不満になる（設計§5-5）。

    開いていない間サイドバーは木から消えているので、`false → true` の描画は
    辿る側がマウントする描画そのもの——**余計な問い合わせは1回も増えない**。
  */
  const [前の開閉, set前の開閉] = useState(open)
  if (前の開閉 !== open) {
    set前の開閉(open)
    if (open) {
      set起点(readPlace(host, project).dir ?? project)
    }
  }

  /*
    **`useCallback` を外さないこと。** 辿る側の `go` はこれを依存に持ち、辿り直しの
    効果が `go` を依存に持つ。渡すたびに新しい関数だと、効果が走る → 状態が変わる →
    また新しい関数、と**問い合わせが回り続ける**（設計§5-3）。
  */
  const 掘った先を覚える = useCallback(
    (path: string) => {
      putDir(host, project, path)
    },
    [host, project],
  )

  const ファイルを選ぶ = useCallback(
    (path: string) => {
      // **押した1枚は「復元ではない」。** 読めなかったときに畳まず、理由を見せる
      setPicked({ path, 復元: false })
      // **同じ1枚を押し直したときも増やす。** 押すのは「見たい」という意思表示で、
      // いま開いているものと同じかどうかは関係ない（設計§5）
      set選んだ回数((n) => n + 1)
      putPick(host, project, path)
    },
    [host, project],
  )

  const 列を閉じる = useCallback(() => {
    setPicked(null)
    putPick(host, project, null)
  }, [host, project])

  /*
    **畳むのは全部の失敗で、忘れるのは「無い」ときだけ**（設計§6-5）。

    畳むのに往復は要らないので、時間切れが並ぶ心配が無い。逆に寝ている PC で
    忘れてしまうと、**起きたときに戻る先が消えている**。
  */
  const 読めなかった = useCallback(
    (status: number | null) => {
      setPicked(null)
      if (status === 404) {
        putPick(host, project, null)
      }
    },
    [host, project],
  )

  return {
    sidebar: (
      // `initial={false}` で、開いた状態で読み込み直したときに滑らせない
      <AnimatePresence initial={false}>
        {open && (
          <Sidebar
            key="folder"
            host={host}
            project={project}
            start={起点}
            onPathChange={掘った先を覚える}
            width={widths.folder}
            /*
              **掴んでいる間だけ、場所取りの動きを止める**（`Sidebar.tsx`）。
              渡さないと、幅を引っぱるたびに場所取りがパネルから遅れる
            */
            dragging={dragging}
            /*
              **ファイルを選んでも畳まない**（利用者の判断・2026-08-24）。続けて別の
              ファイルを開けるようにするため（設計§2）
            */
            onPickFile={ファイルを選ぶ}
            onClose={onToggle}
            {...grip}
          />
        )}
      </AnimatePresence>
    ),
    column:
      picked === null ? null : (
        <FileColumn
          host={host}
          project={project}
          path={picked.path}
          width={widths.file}
          狭い窓の幅={狭い窓の幅}
          onClose={列を閉じる}
          /*
            **押した1枚には渡さない。** 渡さないことがそのまま「押した人には理由を
            見せる」の実体になる（設計§6-5）
          */
          onUnreadable={picked.復元 ? 読めなかった : undefined}
          {...grip}
        />
      ),
    選んだ回数,
  }
}
