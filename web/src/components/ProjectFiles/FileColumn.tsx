/**
 * ファイルの中身を見せる側を包む、**独立した列**（設計§2・§3）。
 *
 * # 動きを付けない
 *
 * 列が現れるとセッションが右へずれる。一覧で禁じている「**押す的が逃げる**」と同じ
 * 考え方をここにも持ち込む（設計§6）。
 *
 * # どの幅でも、セッションの札と同じ扱い
 *
 * **2026-08-28 に直した。** それまでは狭い窓で `fixed inset-0` の**全画面の層**に
 * なっていたが、これは「中身の列はセッションの札と同じ扱いにする」という決め
 * （2026-08-27）と食い違っていた——**列だけが全画面になり、アプリのヘッダごと覆って
 * いた。**
 *
 * **セッションの札は、狭い窓でも 672px 固定のまま横スクロールする**
 * （`SessionView` の `compact` は `w-[42rem] shrink-0`）。同じ扱いにするとは、
 * **窓の幅で作りを分けない**ということなので、`md:` の出し分けを丸ごと落とした。
 *
 * `relative` にしてあるのは、縁を自分の右端へ絶対配置するため——自分が位置の基準に
 * なっている必要がある。位置は指定していないので、**見た目は `static` と1ピクセルも
 * 変わらない。**
 *
 * # 幅の変数は、広い窓にだけ当てる
 *
 * **狭い窓では 42rem を直に当てる。** 幅の規則（`panelWidth.ts`）は「画面幅の 50% を
 * 超えない」という上限を持っており、これは**広い窓で中身がセッションを潰さないため**に
 * 置いたものである。390px の窓へそのまま当てると **195px まで縮む**——札と同じ扱いに
 * したいのに、札（672px 固定）の3割以下になってしまう（実測で踏んだ）。
 *
 * **変数が要るのは縁がある場所だけ**で、縁は `md` 未満では出ない。だから
 * `md:` の側にだけ変数を置けば、両方が成立する。
 *
 * # 横ホイールは、自分で運ばない
 *
 * **2026-08-27 まではレールへ手渡していた**（`onWheelX`）。列がレールの**兄弟**だった
 * ので、ブラウザのスクロール連鎖（祖先だけを辿る）では届かなかったためである。
 *
 * **列をレールの中へ入れたので、その必要が消えた。** 連鎖がそのまま届き、列の中の
 * 生テキスト（`<pre>` の `overflow-x-auto`）は**入れ子の内側が先に消費する**という
 * 既定の振る舞いで足りる——手で真似していたことが、そのまま素で成り立つ。
 *
 * # 幅の上限を CSS で持たない
 *
 * `md:max-w-[50%]` のような保険を足したくなるが、**足してはいけない。** 足すと
 * 「clamp を外す」壊し方を当てても画面がはみ出さなくなり、テスト計画フェーズ4
 * 「幅の上限を外す → はみ出さないことだけが落ちる」が**狙った1本を落とせなくなる**。
 * 上限は `panelWidth.ts` の1箇所だけが持つ。
 */

import type { CSSProperties } from 'react'
import { FileView } from '@/components/FileView/FileView'
import { FilesResizer } from '@/components/ProjectFiles/FilesResizer'
import type { PanelEdge } from '@/lib/panelWidth'

interface Props {
  host: string
  /** 相対パスの基準（その枠のパス） */
  project: string
  /** 読むファイルの絶対パス */
  path: string
  width: number
  /** 閉じる。**列ごと消え、セッションが左へ寄る**（設計§2） */
  onClose: () => void
  /**
   * 読めなかったことを親へ知らせる（`イシューグループ_2026-0813-1804` 設計§6-5）。
   * **ここは素通しするだけ**——畳むか忘れるかを決めるのは束ね役の仕事。
   */
  onUnreadable?: (status: number | null) => void
  onGrab: () => void
  onMove: (edge: PanelEdge, width: number) => void
  onDrop: () => void
}

export function FileColumn({
  host,
  project,
  path,
  width,
  onClose,
  onUnreadable,
  onGrab,
  onMove,
  onDrop,
}: Props) {
  return (
    <div
      data-testid="file-column"
      style={{ '--files-file-w': `${width}px` } as CSSProperties}
      /*
        **`snap-start snap-always` は、レールの中に居るときだけ効く**（設計§4）。
        PJT 専用画面のレールにスナップは無いので、あちらでは**字が在るだけで何も
        起きない**。置き場所で分岐させるより、札に付けて回るほうが穴が無い。

        # 狭い窓では、どちらの画面でも画面幅ぴったり（設計§12）

        **2026-09-04 まで、置いた画面が `'札' | '画面'` で選んでいた**——PJT 専用画面は
        札と同じ 672px、セッション専用画面だけ1画面ぶん、という分け方だった。
        **利用者の指定で、PJT 専用画面も1画面ぶんへ揃えた**ので、**選ぶ相手が居なくなり
        受け口ごと消した**。読む面の幅は「並びの都合」ではなく「読みやすさ」で決まる。

        # 右の余白は `md` 以上だけ

        `pr-3` は**縁（`FilesResizer`）の場所取り**で、縁は `md` 未満では出ない
        （`hidden md:block`）。狭い窓に残すと、**中身の右端に 12px の地が見える**
        （追加要望2）。だから `md:pr-3` にしてある。
      */
      className="relative flex w-full min-h-0 shrink-0 snap-start snap-always flex-col gap-2 md:w-[var(--files-file-w,42rem)] md:pr-3"
    >
      {/*
        **高さの鎖の最後の輪**（設計§7）。`FileView` の `h-full` はこの段に対して
        解決される。移設前の `flex-[1.4]`（縦の取り合い）がここに置き換わる——
        縦に積むのをやめたので、配分そのものが消える
      */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <FileView
          host={host}
          root={project}
          path={path}
          onClose={onClose}
          onUnreadable={onUnreadable}
        />
      </div>

      <FilesResizer
        edge="file"
        width={width}
        label="ファイルの中身の幅"
        onGrab={onGrab}
        onMove={onMove}
        onDrop={onDrop}
      />
    </div>
  )
}
