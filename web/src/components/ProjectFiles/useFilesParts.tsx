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
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { FileColumn } from '@/components/ProjectFiles/FileColumn'
import { Sidebar } from '@/components/ProjectFiles/Sidebar'
import { usePanelWidths } from '@/lib/filesPanel'
import { moveTab } from '@/lib/fileTabs'
import { putDir, putPicks, readPlace } from '@/lib/filesPlace'

/**
 * 開いているタブ1枚。**押した1枚と、覚えていて戻した1枚を1つの型で持つ。**
 *
 * 2つに分けない——分けると「どちらが正か」を読む側が毎回決めることになる。
 * `復元` が立っているときだけ、読めなかったら黙って畳む（設計§6-5）。
 * **印はタブごとに持つ**——復元した1枚と、そのあと人が押した1枚が同時に並ぶため。
 */
interface Tab {
  path: string
  復元: boolean
  /**
   * **畳んだが、覚えには残す**（設計§6-5）。
   *
   * 復元したタブが「読めない」（`404` 以外）で落ちたときに立つ。**帯には出さないが、
   * 覚えの並びからは外さない**——外すと、寝ている PC が起きたときに戻る先が消える。
   *
   * **印として持つ理由。** 状態から消して「書くときだけ足す」形にすると、**次に何か
   * 押した瞬間に、そのとき生きている並びで上書きされて消える**（実際にその作りにして
   * いた）。並びに残しておけば、どの手が書いても一緒に運ばれる。
   */
  隠す?: boolean
}

/**
 * 開いているタブの並びと、いま見ている1枚。
 *
 * **2つの状態に分けない。** 分けると「並びに無いものが選ばれている」という、
 * どちらを直せばよいか決まらない形が作れてしまう。**1つの塊で置き換える。**
 */
interface 開いているもの {
  tabs: Tab[]
  選択: string | null
}

/** 覚えていた並びを、復元の印つきで取り出す。覚えが無ければ空 */
function 覚えた並び(host: string, project: string): 開いているもの {
  const place = readPlace(host, project)
  return {
    tabs: place.picks.map((path) => ({ path, 復元: true })),
    選択: place.pick,
  }
}

/** 帯に出るタブだけ。**畳んだものは覚えにだけ残る** */
function 見えているもの(tabs: Tab[]): Tab[] {
  return tabs.filter((tab) => tab.隠す !== true)
}

/**
 * 1枚外したあと、どれを選ぶか。**右隣。無ければ左隣。**（要件の完了条件3）
 *
 * **畳んだものは飛ばす。** 選ぶと、帯に出ていないタブの中身が出ることになる。
 *
 * @param 残り 外したあとの並び（畳んだものを含む）
 * @param 外した位置 外す前の並びでの位置
 */
function 次に選ぶ(残り: Tab[], 外した位置: number): string | null {
  const 右 = 残り.slice(外した位置).find((tab) => tab.隠す !== true)
  if (右 !== undefined) {
    return 右.path
  }
  const 左 = 残り.slice(0, 外した位置).findLast((tab) => tab.隠す !== true)
  return 左?.path ?? null
}

interface Args {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /** その枠のパス。起点であり、相対パスの基準でもある */
  project: string
  /** サイドバーが開いているか。**記憶は `useFilesPanel` が持つ**ので、受け取るだけ */
  open: boolean
  onToggle: () => void
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
  const [開いている, set開いている] = useState<開いているもの>(() =>
    覚えた並び(host, project),
  )
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
    set開いている(覚えた並び(host, project))
    set起点(readPlace(host, project).dir ?? project)
  }

  /*
    **書くときに要る「いまの並び」を控える。**

    `useState` の更新関数の中で `localStorage` を書かない——更新関数は純粋であることが
    求められており、開発時の二重呼び出しでそのまま二重に書くことになる。控えを1つ置いて
    **決めるのを外側で済ませる**（`usePanelWidths` の `latest` と同じ作り）。
  */
  const 最新 = useRef(開いている)
  最新.current = 開いている

  /**
   * 並びと選択を覚える。**書く口をここ1つにする。**
   *
   * **`pick` は、選んでいるものが無くても覚えの1枚を指す。** 畳んだタブ
   * （`404` 以外で読めなかったもの）しか残っていない場面がこれにあたる——
   * `null` を書くと、**`picks` を知らない古い版へ戻したときに戻る先が消える**。
   * 覚えているのに指していない、という形を外へ出さない。
   */
  const 覚える = useCallback(
    (tabs: Tab[], 選択: string | null) => {
      const paths = tabs.map((tab) => tab.path)
      putPicks(host, project, paths, 選択 ?? paths[0] ?? null)
    },
    [host, project],
  )

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

  /**
   * サイドバーで押された。**既に開いていれば増やさず、そのタブへ移る。**
   *
   * **枚数が増えるかどうかと、レールを寄せるかどうかは別の話である。** 同じ1枚を
   * 押し直したときもレールは寄せる——押すのは「見たい」という意思表示で、いま開いて
   * いるものと同じかどうかは関係ない（設計§5）。**ここを「増えないなら何もしない」に
   * すると、セッション側へ払ったまま押した人が、何も起きないのを見る。**
   */
  const ファイルを選ぶ = useCallback(
    (path: string) => {
      const now = 最新.current
      const ある = now.tabs.some((tab) => tab.path === path)
      // **押した1枚は「復元ではない」。** 読めなかったときに畳まず、理由を見せる。
      // 復元で戻したタブを人が押した場合も、この時点で押した1枚に変わる
      // **畳んでいたものを押したら、表へ戻す。** 人が「見たい」と言っているので、
      // 読めなかった過去より新しい意思表示のほうが強い
      const tabs = ある
        ? now.tabs.map((tab) =>
            tab.path === path ? { path, 復元: false } : tab,
          )
        : [...now.tabs, { path, 復元: false }]
      set開いている({ tabs, 選択: path })
      set選んだ回数((n) => n + 1)
      覚える(tabs, path)
    },
    [覚える],
  )

  /** タブを押した。**並びは動かさず、選び直すだけ。** */
  const タブを選ぶ = useCallback(
    (path: string) => {
      const now = 最新.current
      if (!now.tabs.some((tab) => tab.path === path)) {
        return
      }
      set開いている({ tabs: now.tabs, 選択: path })
      覚える(now.tabs, path)
    },
    /*
      **レールを寄せない。** タブが押せているということは、既にファイルの面を見て
      いるということである。ここで寄せると、**押した本人の目の前で面が動く。**
    */
    [覚える],
  )

  /** ✕ で1枚だけ閉じる。**最後の1枚を閉じたら並びが空になり、列ごと消える。** */
  const タブを閉じる = useCallback(
    (path: string) => {
      const now = 最新.current
      const 位置 = now.tabs.findIndex((tab) => tab.path === path)
      if (位置 < 0) {
        return
      }
      const tabs = now.tabs.filter((tab) => tab.path !== path)
      // **選ばれていないタブを閉じても、選択は動かさない**
      const 選択 = now.選択 === path ? 次に選ぶ(tabs, 位置) : now.選択
      set開いている({ tabs, 選択 })
      覚える(tabs, 選択)
    },
    [覚える],
  )

  /**
   * タブを並べ替えた（利用者の指定・2026-09-08）。
   *
   * **位置は「帯に見えている並び」で来る。** 畳んだタブ（読めなくて隠しているもの）は
   * 帯に出ていないので、**そのまま全体の並びへ当てると1つずれる**。見えているぶんを
   * 動かしてから、畳んだものを元の位置へ戻す形で組み直す。
   *
   * **選択は動かさない。** 動かしたのは並びであって、見ているものではない。
   */
  const タブを並べ替える = useCallback(
    (from: number, to: number) => {
      const now = 最新.current
      const 見える = now.tabs.filter((tab) => tab.隠す !== true)
      const 元の並び = 見える.map((tab) => tab.path)
      const 並べ替えた = moveTab(元の並び, from, to)
      if (並べ替えた === 元の並び) {
        return
      }
      /*
        **畳んだものは、いまの位置に居させる。** 帯に出ていないものが勝手に動くと、
        起きたときに戻る並びが押した覚えの無い形になる。

        **`find` の述語の中で添字を進めないこと。** 述語は要素ごとに呼ばれるので、
        1回の取り出しで添字がいくつも進んで並びが壊れる（実際に踏んだ）。
      */
      let 次 = 0
      const tabs = now.tabs.map((tab) => {
        if (tab.隠す === true) {
          return tab
        }
        const path = 並べ替えた[次]
        次 += 1
        return 見える.find((t) => t.path === path) ?? tab
      })
      set開いている({ tabs, 選択: now.選択 })
      覚える(tabs, now.選択)
    },
    [覚える],
  )

  /** ヘッダの「ファイルの列を閉じる」。**タブの ✕ と違い、全部畳む。** */
  const 列を閉じる = useCallback(() => {
    set開いている({ tabs: [], 選択: null })
    覚える([], null)
  }, [覚える])

  /*
    **畳むのは全部の失敗で、忘れるのは「無い」ときだけ**（設計§6-5）。

    畳むのに往復は要らないので、時間切れが並ぶ心配が無い。逆に寝ている PC で
    忘れてしまうと、**起きたときに戻る先が消えている**。
  */
  const 読めなかった = useCallback(
    (status: number | null) => {
      const now = 最新.current
      const path = now.選択
      if (path === null) {
        return
      }
      const 位置 = now.tabs.findIndex((tab) => tab.path === path)
      /*
        **そのタブだけ畳む。** 他のタブは読めているので巻き添えにしない。

        **「無い」（404）のときだけ並びから外し、それ以外は畳んで残す**（設計§6-5）。
        残す先を状態の外（書くときだけ足す控え）にすると、**次に何か押した瞬間に、
        そのとき生きている並びで上書きされて消える**——寝ている PC が起きたときに
        戻る先が消えるので、`404` 以外を残す意味が無くなる。
      */
      const tabs =
        status === 404
          ? now.tabs.filter((tab) => tab.path !== path)
          : now.tabs.map((tab) =>
              tab.path === path ? { ...tab, 隠す: true } : tab,
            )
      const 選択 = 次に選ぶ(tabs, 位置)
      set開いている({ tabs, 選択 })
      覚える(tabs, 選択)
    },
    // **書く口は `覚える` に畳んだ**ので、`host` と `project` は直接は要らない
    [覚える],
  )

  /*
    いま見ている1枚。**並びと選択から引く**——選択が並びの外を指すことは
    `readPlace` と上の手が両方で塞いでいるが、**引けなかったら列を出さない**の
    ほうが、存在しないパスを読みに行くより安全である。
  */
  const 現在 = 開いている.tabs.find(
    (tab) => tab.path === 開いている.選択 && tab.隠す !== true,
  )
  /** 帯に出すぶん。**畳んだものは覚えにだけ残る** */
  const 見えている = 見えているもの(開いている.tabs)

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
      現在 === undefined ? null : (
        <FileColumn
          host={host}
          project={project}
          path={現在.path}
          tabs={見えている.map((tab) => tab.path)}
          onSelectTab={タブを選ぶ}
          onCloseTab={タブを閉じる}
          onReorderTab={タブを並べ替える}
          width={widths.file}
          onClose={列を閉じる}
          /*
            **押した1枚には渡さない。** 渡さないことがそのまま「押した人には理由を
            見せる」の実体になる（設計§6-5）。**判断はタブごと**——復元した1枚と、
            人が押した1枚が同じ並びに同居する
          */
          onUnreadable={現在.復元 ? 読めなかった : undefined}
          {...grip}
        />
      ),
    選んだ回数,
  }
}
