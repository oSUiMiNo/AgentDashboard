/**
 * PC のフォルダを1階層ずつ辿る（イシューグループ_2026_0805_0514 設計§13）。
 *
 * # 1画面に1階層
 *
 * 木を展開していく形は、狭い画面では現在地を見失う。**いま居る階層だけ**を出し、
 * 上へはパンくずで戻る——ブラウザの「戻る」を階層の移動に使うと意味が衝突する。
 *
 * # 開くと選ぶを分ける
 *
 * 行全体が「入る」で、確定は別のボタン（呼び出し側が置く）。同じ場所に2つの意味を
 * 持たせると、押す対象が小さい狭い画面で取り違えが起きる。
 *
 * # 打ち切りと読めない理由は隠さない
 *
 * 黙って切ると「あるはずのフォルダが無い」に見え、原因まで辿れない（設計§8）。
 * 断られた理由もそのまま出す——権限・不在・版が古い、はどれも利用者が直せる（§17）。
 *
 * この部品は**PJT を足すときのフォルダ選び（追加シート）用**である。サイドバーは、その場で
 * 展開・畳むツリー（`FolderTree`）を使う。行・メニュー・コピーは `parts.tsx` を共有するので、
 * 片方だけ直したときに食い違う形は作れない。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { ArrowUpGlyph } from '@/components/ui/glyphs'
import {
  childOf,
  crumbsOf,
  isUnder,
  listDir,
  sameListing,
  type DirListing,
} from '@/lib/hostfs'
import { usePoll, 一覧を引き直す間隔 } from '@/lib/poll'
import { useCopyAnswer } from '@/components/FolderBrowser/useCopyAnswer'
import {
  AboveRootCrumb,
  CopyFallback,
  CrumbCopyState,
  FolderRow,
  PathMenu,
} from '@/components/FolderBrowser/parts'

export { コピー表示を畳むまで } from '@/components/FolderBrowser/useCopyAnswer'

interface Props {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /**
   * 最初に見せる場所。**省略するとその PC のホーム**（設計§26-2）。
   *
   * 変わると辿り直す。呼び出し側が「最近使った場所」を押したときの移動もこれで起きる。
   */
  start?: string
  /**
   * ここより上へは辿らせない（設計§15）。**追加シートは渡さない。** 残してあるのは、
   * 試験の大半が `root` 付きで組まれていて、外すとコピーの値とパンくずの期待値が変わるため
   */
  root?: string
  /** いま見ている場所が変わるたびに呼ばれる。確定ボタンの相手を呼び出し側が持つため */
  onPathChange?: (path: string) => void
}

/**
 * 辿った結果。**`stale` を `failed` に混ぜない**——追い越された失敗で起点へ行き直すと、
 * **利用者が新しく開いた場所を上書きする**。
 */
type Arrival = "ok" | "failed" | "stale"

export function FolderBrowser({
  host,
  start,
  root,
  onPathChange,
}: Props) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // `undefined` は「まだ聞いていない」＝ホームから始める（設計§26-2）
  const [path, setPath] = useState<string | undefined>(start)
  /**
   * 何番目の問いか。**最後に投げたものの答えだけを採る**（設計§29）。
   *
   * 速く辿ると、先に投げた場所の答えが後から届くことがある。跨いだ配置では
   * 1回に最大5秒かかりうるので、押した順と返る順は簡単に入れ替わる。
   * 番号を見ないと、**新しい場所を出したあとに古い場所へ戻る**。
   *
   * `useRef` で持つのは、これが描画に出ない値だから——`useState` にすると
   * `go` が作り直され、それを見ている効果まで走り直す。
   */
  const asked = useRef(0)

  const { copied, copy, dismiss } = useCopyAnswer()

  const go = useCallback(
    async (next: string | undefined): Promise<Arrival> => {
      const mine = ++asked.current
      setLoading(true)
      setError(null)
      try {
        const result = await listDir(host, next)
        if (mine !== asked.current) {
          return "stale"
        }
        setListing(result)
        // **着いた先はサーバが返す値を正とする。** 省略して問うたときは
        // ここで初めてホームのパスが分かる
        setPath(result.path)
        onPathChange?.(result.path)
        return "ok"
      } catch (err) {
        // 古い問いの失敗も捨てる。拾うと、**新しい場所の正しい一覧が消える**
        if (mine !== asked.current) {
          return "stale"
        }
        setError(err instanceof Error ? err.message : "読めませんでした")
        setListing(null)
        return "failed"
      } finally {
        if (mine === asked.current) {
          setLoading(false)
        }
      }
    },
    [host, onPathChange],
  )

  /**
   * **いま見ている1階層を、黙って引き直す**（`サイドバーの一覧を、リロードせずに
   * 新しくする`）。[`go`] とは3つ違う。
   *
   * | | [`go`]（人が押した） | これ（時報） |
   * |---|---|---|
   * | 「読み込み中…」 | 出す | **出さない**——10秒おきに一覧が点滅する |
   * | 読めなかったとき | 一覧を消して理由を出す | **前の一覧を残し、黙る** |
   * | `asked` | **増やす** | **増やさない**（下記） |
   *
   * # なぜ `asked` を増やさないのか
   *
   * 増やすと**利用者の操作を追い越す**。押した直後に時報が来た場合、時報が番号を
   * 進めてしまい、**押した先の答えが「古い」と判定されて捨てられる**——押しても
   * 開かない、という壊れ方になる。
   *
   * 代わりに**始めた時点の番号を覚え、返ったときに変わっていなければ採る**。
   * これで両方向とも正しくなる。
   *
   * - 引き直しの最中に人が動いた → 番号が変わる → **引き直しの結果を捨てる**
   * - 人の操作の最中に時報が来た → 番号は動かない → **操作の結果は無傷**
   *
   * # 変わっていなければ差し替えない
   *
   * 行の同一性は `key={entry.name}` が保っているので DOM は作り直されないが、
   * **10秒おきに全行を描き直す理由も無い**（[`sameListing`]）。
   *
   * **まだ場所が決まっていないときは何もしない。** 初回の [`go`] が走っている
   * 最中なので、ここで割り込む意味が無い。
   */
  const refresh = useCallback(async (): Promise<void> => {
    if (path === undefined) {
      return
    }
    /*
      **断り文が出ている間は引き直さない。**

      [`go`] は失敗すると理由を出して一覧を空にする。そこへ時報が成功を持ち込むと、
      **断り文の下に一覧が生える**——押した操作が失敗したことは画面に残ったまま、
      中身だけが埋まる、という読めない状態になる。

      **消して回るのも違う。** 断り文は「あなたがいま押したものが駄目だった」という
      知らせなので、時報が黙って消すと**押した結果が画面から消える**。

      だから触らない。**次に人が動いて成功すれば、そこで断り文は消える。**
      なお `error` が出ているとき一覧は必ず空なので、引き直す中身もそもそも無い。
    */
    if (error !== null) {
      return
    }
    /*
      **人の操作が飛んでいる間は、そもそも始めない。**

      ここが無いと、番号だけでは守れない順序がある——利用者が押して [`go`] が
      番号を上げた**直後**に時報が来ると、引き直しは「上がったあとの番号」を
      覚えてしまう。押した先が先に返って画面が変わり、**遅れて返った古い階層の
      一覧が「新しい」と判定されて上書きする**。行の中身とパンくずが食い違い、
      行を押すと別の階層へ飛ぶ（次の時報まで直らない）。

      **飛んでいる間に始めなければ、この順序は作れない。** 逆向き——引き直しが
      先に始まってから人が動いた場合——は、番号が変わるので捨てられる。
      2つ合わせて、どちらが先でも正しくなる。
    */
    if (loading) {
      return
    }
    const mine = asked.current
    try {
      const result = await listDir(host, path)
      if (mine !== asked.current) {
        return
      }
      /*
        **比べるのは、ここ（`try` の中）。** 更新関数の中で比べると
        **描画の最中に走る**ので、この `try` の外になる。`listDir` は応答を
        検査せずに写しているだけなので、`entries` を欠いた 200 が返ると
        [`sameListing`] が投げ、**黙るはずの引き直しがサイドバーごと落とす**。
      */
      const 同じ = sameListing(listing, result)
      if (!同じ) {
        setListing(result)
      }
    } catch {
      // **黙る。** これは利用者が押した操作ではないので、押したときと同じ強さで
      // 理由を出してはいけない（要件5）。10秒おきに赤い行が明滅するのは、
      // 古いままより悪い。前の一覧はそのまま残す
    }
  }, [host, path, error, loading, listing])

  // **10秒おきに引き直す。** 裏にいる間は引かず、表へ戻った瞬間に引き直す。
  // 畳んだときはこの部品ごと消えるので、後片付けがそのまま効く
  usePoll(refresh, 一覧を引き直す間隔)

  useEffect(() => {
    // **辿り直す先は `start`。`path` を渡してはいけない。**
    // `start` が変わった描画では `path` はまだ古く、渡すと「古い場所を引き直して
    // 上書きする」ことになる。症状は**一瞬だけ新しい場所が見えて元へ戻る**で、
    // 状態の更新が非同期であることに由来するので、目で追っても原因が見えない。
    void go(start)
  }, [host, start, go])

  // ルートより上は出さない（`root` を渡したとき）。現在地までの道筋は見せて、外側だけを塞ぐ。
  // **内側かどうかの判定は `isUnder` に寄せる**——区切りを見ない前方一致で書くと、
  // `app` の内側に `app-old` が通り、起点の外へ抜ける段ができる
  const 全部 = crumbsOf(path ?? "/")
  const crumbs = 全部.filter(
    (crumb) =>
      root === undefined ||
      isUnder(root, crumb.path) ||
      isUnder(crumb.path, root),
  )

  /*
    **「1つ上」は、パンくずの末尾から2番目**（細かい修正 設計§8-2）。新しい関数を
    足さずに済むうえ、**上のフィルタと同じ材料**から引くので、押した先が必ず
    パンくずのどれかになる。

    **ルートでは押せなくする。** `ファイル設計§15` は「左パネルはその枠のパスから
    始まり、**上へは出られない**——相対パスの基準が壊れるため」と決めている。
    出られなくすれば基準は壊れないので、**設計を覆さずに要件3を満たせる**。
    判定は既存のパンくずと同じ `isUnder` に寄せる——別の書き方をすると挙動がずれる。
  */
  const 外側 = root === undefined ? undefined : crumbs.filter((crumb) => !isUnder(root, crumb.path)).at(-1)
  const 内側 = root === undefined ? crumbs : crumbs.filter((crumb) => isUnder(root, crumb.path))
  const ひとつ上 = 全部.length >= 2 ? 全部[全部.length - 2] : undefined
  const 上へ行ける =
    ひとつ上 !== undefined &&
    (root === undefined || isUnder(root, ひとつ上.path))
  const いまの段 = path === undefined ? undefined : 内側.at(-1)
  const 余白 = <li aria-hidden data-testid="folder-blank" className="min-h-8 flex-1" />
  const パンくずの答え = (at: string) => (
    <CrumbCopyState show={copied?.場所 === "パンくず" && copied.path === at && copied.state === "done"} />
  )

  // `folder-crumbs` の testid と中の並びは既存のテストと E2E が読んでいる
  const パンくず = (
    <nav
      data-testid="folder-crumbs"
      aria-label="いまの場所"
      className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs"
    >
      {/*
        **パンくずの左に置く**（要件3）。行き先はパンくずの中にあるが、**押す場所が
        パンくずの中だと、深い階層では横に流れて見つからない**——位置が固定の的を1つ
        置くことで、どこに居ても同じ場所を押せば1つ上へ行ける。
      */}
      <Button
        type="button"
        /*
          **枠と地を持たせて、押せるものだと分かるようにする**（2026-09-05 の指定）。
          `ghost` の細い山形は**パスの区切りや文字に紛れて、UI だと読めなかった**——
          ここはパンくずという**文字が並ぶ場所**なので、他所より器の助けが要る。
        */
        variant="outline"
        size="icon-xs"
        data-testid="folder-up"
        aria-label="1つ上のフォルダへ"
        title={
          上へ行ける
            ? `1つ上のフォルダへ：${ひとつ上?.path ?? ""}`
            : "ここが起点なので、これより上へは出られません"
        }
        disabled={!上へ行ける}
        className="shrink-0"
        onClick={() => {
          if (ひとつ上 !== undefined) {
            void go(ひとつ上.path)
          }
        }}
      >
        {/* 器（24px）に対して 14px。`icon-xs` の既定（12px）だと器の中で泳ぐ */}
        <ArrowUpGlyph className="size-3.5" />
      </Button>

      {外側 !== undefined && (
        <AboveRootCrumb
          crumb={外側}
          onCopy={(value) => copy(外側.path, value, "パンくず")}
          answer={パンくずの答え(外側.path)}
        />
      )}
      {内側.map((crumb, at) => (
        <span key={crumb.path} className="relative flex items-center gap-1">
          {(at > 0 ? 内側[at - 1]?.label !== '/' : 外側 !== undefined) && <span className="text-muted-foreground">/</span>}
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                data-testid="folder-crumb"
                className="hover:text-primary rounded px-1 py-0.5 underline"
                onClick={() => void go(crumb.path)}
              >
                {crumb.label}
              </button>
            </ContextMenuTrigger>
            <PathMenu
              name={crumb.label}
              path={crumb.path}
              kind="dir"
              onCopy={(value) => copy(crumb.path, value, "パンくず")}
            />
          </ContextMenu>
          {パンくずの答え(crumb.path)}
        </span>
      ))}
    </nav>
  )

  return (
    <div
      data-testid="folder-browser"
      data-path={path ?? ""}
      // **入れ物の高さいっぱいに広がる。** これが無いと一覧が伸び放題になり、
      // `ul` の `overflow-y-auto` が効かずに親ごとはみ出す
      className="flex h-full min-h-0 flex-col gap-2"
    >
      {パンくず}

      {error !== null && (
        <p data-testid="folder-error" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {listing?.truncated === true && (
        <p data-testid="folder-truncated" className="text-xs text-amber-300">
          多すぎるので途中までしか出していません。目的のフォルダが見当たらないときは、
          パスを直に打ち込んでください。
        </p>
      )}

      {/* **写せなかったときの逃げ道**（設計§5）。行の中は「アイコン＋名前＋コピー」で
          横1列に詰まっていて値を差し込む余地が無いので、**パネルの上に1箇所だけ**出す。

          アンバーなのは上の `folder-truncated` と同じ意味だから——「動くが、この環境では
          最後の一歩だけ自分でやってほしい」。赤（`folder-error`）は読めないときのもので、
          ここは読めている。

          **かつては `FileView` の `file-copy-fallback` と文言も形も揃えてあった**が、
          あちらの「パスをコピー」は要件24 で無くなったので、**逃げ道はここ1箇所だけ**に
          なった。揃える相手が居なくなっただけで、出す理由は変わっていない。 */}
      {copied?.state === "failed" && (
        <CopyFallback value={copied.value} onDismiss={dismiss} />
      )}

      <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto text-sm">
        {loading && (
          <li className="text-muted-foreground px-2 py-1.5 text-xs">
            読み込み中…
          </li>
        )}
        {!loading && listing?.entries.length === 0 && (
          <li className="text-muted-foreground px-2 py-1.5 text-xs">
            このフォルダは空です
          </li>
        )}
        {!loading &&
          listing?.entries.map((entry) => {
            const full = childOf(listing.path, entry.name)
            return (
              <FolderRow
                key={entry.name}
                entry={entry}
                full={full}
                host={host}
                root={root}
                onOpen={() => void go(full)}
                // **答えを持っているのは1行だけ。** 他の行は常に手つかずへ戻る
                copyState={copied?.場所 === "行" && copied.path === full ? copied.state : "idle"}
                onCopy={(value) => copy(full, value)}
              />
            )
          })}
        {いまの段 === undefined ? (
          余白
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>{余白}</ContextMenuTrigger>
            <PathMenu
              name={いまの段.label}
              path={いまの段.path}
              kind="dir"
              onCopy={(value) => copy(いまの段.path, value, "パンくず")}
            />
          </ContextMenu>
        )}
      </ul>
    </div>
  )
}
