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
 * この部品は**追加のシートと PJT 専用画面の左パネルで共有する**（設計§13）。
 * 同じ列挙の口を使う部品が2つの作法を持つと、片方だけ直したときに食い違う。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/clipboard'
import { fileIcon } from '@/lib/fileKind'
import {
  childOf,
  crumbsOf,
  HostFsError,
  isUnder,
  listDir,
  relativeOf,
  type DirEntry,
  type DirListing,
} from '@/lib/hostfs'

interface Props {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /**
   * 最初に見せる場所。**省略するとその PC のホーム**（設計§26-2）。
   *
   * 変わると辿り直す。呼び出し側が「最近使った場所」を押したときの移動もこれで起きる。
   */
  start?: string
  /** ここより上へは辿らせない（PJT 専用画面の左パネル用。設計§15） */
  root?: string
  /**
   * `start` が**無かった**ときに、黙って行き直す先（`イシューグループ_2026-0813-1804` 設計§6-2）。
   *
   * **省略すると断り文を出す。追加シートはこちら**——あちらの `start` は利用者が
   * 押した場所なので、着けなかったなら理由を見せるのが正しい。渡すのは左パネルだけで、
   * あちらの `start` は**覚えていた場所**＝利用者がいま押したものではないため、
   * 開いた瞬間に赤い1行が出迎えるのを避ける。
   *
   * **黙るのは「無い」（404）ときだけ。** 権限・未接続・時間切れでは理由を出す。
   */
  fallback?: string
  /** いま見ている場所が変わるたびに呼ばれる。確定ボタンの相手を呼び出し側が持つため */
  onPathChange?: (path: string) => void
  /** ファイルを押したとき。省略するとファイルは押せない（選ぶ対象がフォルダだけの場面） */
  onPickFile?: (path: string) => void
}

/**
 * 辿った結果。**`stale` を `failed` に混ぜない**——追い越された失敗で起点へ行き直すと、
 * **利用者が新しく開いた場所を上書きする**。
 *
 * `gone` と `failed` を分けるのは、**行き直してよいのが「無い」ときだけ**だから
 * （設計§6-3）。寝ている PC で全部の失敗を拾うと、時間切れが2回並んで倍待たされ、
 * しかも起点も同じ理由で失敗するので**見える結果は変わらない**。
 */
type Arrival = 'ok' | 'gone' | 'failed' | 'stale'

export function FolderBrowser({
  host,
  start,
  root,
  fallback,
  onPathChange,
  onPickFile,
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

  /**
   * **コピーの答えは1組しか持たない**（設計§5）。「どの行の、どの値が、どうなったか」
   * を覚え、**別の行を押したら前のぶんは消える**。
   *
   * 複数行ぶんを覚えると、パネルの上に何行も並んで**どれが最後に押したものか
   * 分からなくなる**。最後に押したものだけが答えである。
   *
   * 番号を `useRef` で持つ理由は `asked` と同じ——描画に出ない値なので、
   * `useState` にすると押すたびに関数が作り直される。
   */
  const copyAsked = useRef(0)
  const [copied, setCopied] = useState<{
    path: string
    value: string
    state: 'done' | 'failed'
  } | null>(null)

  /**
   * **`await` を1つも挟まずに [`copyToClipboard`] を呼ぶ**（設計§3）。ここに
   * 待ちを入れると、古い方法が要求する「押した合図」が切れることがある——
   * 切れるかどうかはブラウザ任せなので、**動いたり動かなかったりする**形になる。
   */
  const copy = useCallback((at: string, value: string) => {
    const mine = ++copyAsked.current
    // 押した瞬間に前の答えを消す。**結果を待たない**——待つと、次の行を押しても
    // 前の行の答えが残って見える
    setCopied(null)
    void copyToClipboard(value).then((ok) => {
      // 割り込まれた古い答えは捨てる（`asked` と同じ理由）
      if (mine !== copyAsked.current) {
        return
      }
      setCopied({ path: at, value, state: ok ? 'done' : 'failed' })
    })
  }, [])

  const go = useCallback(
    async (next: string | undefined, 黙る = false): Promise<Arrival> => {
      const mine = ++asked.current
      setLoading(true)
      setError(null)
      try {
        const result = await listDir(host, next)
        if (mine !== asked.current) {
          return 'stale'
        }
        setListing(result)
        // **着いた先はサーバが返す値を正とする。** 省略して問うたときは
        // ここで初めてホームのパスが分かる
        setPath(result.path)
        onPathChange?.(result.path)
        return 'ok'
      } catch (err) {
        // 古い問いの失敗も捨てる。拾うと、**新しい場所の正しい一覧が消える**
        if (mine !== asked.current) {
          return 'stale'
        }
        // **黙るのは「無い」ときだけ。** 権限・未接続・時間切れは理由をそのまま出す
        if (黙る && err instanceof HostFsError && err.status === 404) {
          return 'gone'
        }
        setError(err instanceof Error ? err.message : '読めませんでした')
        setListing(null)
        return 'failed'
      } finally {
        if (mine === asked.current) {
          setLoading(false)
        }
      }
    },
    [host, onPathChange],
  )

  useEffect(() => {
    // **辿り直す先は `start`。`path` を渡してはいけない。**
    // `start` が変わった描画では `path` はまだ古く、渡すと「古い場所を引き直して
    // 上書きする」ことになる。症状は**一瞬だけ新しい場所が見えて元へ戻る**で、
    // 状態の更新が非同期であることに由来するので、目で追っても原因が見えない。
    void (async () => {
      const 着いたか = await go(start, fallback !== undefined)
      // **行き直すのは1度だけ。** `go` の中から自分を呼ぶ形にすると、消えた先が
      // 連なっていたときに止まらなくなる
      if (着いたか === 'gone' && fallback !== undefined) {
        // 着けば `onPathChange` が飛ぶので、**死んだ記憶はその場で上書きされる**
        await go(fallback)
      }
    })()
  }, [host, start, fallback, go])

  // ルートより上は出さない（左パネル用）。現在地までの道筋は見せて、外側だけを塞ぐ。
  // **内側かどうかの判定は `isUnder` に寄せる**——区切りを見ない前方一致で書くと、
  // `app` の内側に `app-old` が通り、起点の外へ抜ける段ができる
  const crumbs = crumbsOf(path ?? '/').filter(
    (crumb) =>
      root === undefined ||
      isUnder(root, crumb.path) ||
      isUnder(crumb.path, root),
  )

  return (
    <div
      data-testid="folder-browser"
      data-path={path ?? ''}
      // **入れ物の高さいっぱいに広がる。** これが無いと一覧が伸び放題になり、
      // `ul` の `overflow-y-auto` が効かずに親ごとはみ出す
      className="flex h-full min-h-0 flex-col gap-2"
    >
      <nav
        data-testid="folder-crumbs"
        aria-label="いまの場所"
        className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs"
      >
        {crumbs.map((crumb, at) => (
          <span key={crumb.path} className="flex items-center gap-1">
            {at > 0 && <span className="text-muted-foreground">/</span>}
            <button
              type="button"
              data-testid="folder-crumb"
              disabled={root !== undefined && !isUnder(root, crumb.path)}
              className="hover:text-primary disabled:text-muted-foreground rounded px-1 py-0.5 underline disabled:no-underline"
              onClick={() => void go(crumb.path)}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>

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

          文言と形は `FileView` の `file-copy-fallback` と揃えてある。**同じことが起きた
          ときに同じものが出る**のが要件の完了条件（設計§10）。 */}
      {copied?.state === 'failed' && (
        <p data-testid="folder-copy-failed" className="text-xs text-amber-300">
          コピーできません。この値を選んで取ってください：{' '}
          <code
            data-testid="folder-copy-fallback"
            className="bg-muted/60 rounded px-1 py-0.5 font-mono select-all"
          >
            {copied.value}
          </code>
        </p>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto text-sm">
        {loading && (
          <li className="text-muted-foreground px-2 py-1.5 text-xs">読み込み中…</li>
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
              <Row
                key={entry.name}
                entry={entry}
                full={full}
                root={root}
                onOpen={() => void go(full)}
                onPickFile={
                  onPickFile === undefined ? undefined : () => onPickFile(full)
                }
                // **答えを持っているのは1行だけ。** 他の行は常に手つかずへ戻る
                copyState={copied?.path === full ? copied.state : 'idle'}
                onCopy={(value) => copy(full, value)}
              />
            )
          })}
      </ul>
    </div>
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
 */
function Row({
  entry,
  full,
  root,
  onOpen,
  onPickFile,
  copyState,
  onCopy,
}: {
  entry: DirEntry
  /** この行が指す絶対パス */
  full: string
  /** 相対パスの基準。無ければ絶対パスをコピーする */
  root?: string
  onOpen: () => void
  onPickFile?: () => void
  /** この行のコピーがどうなったか。**答えを持つのは1行だけ**（親が決める） */
  copyState: 'idle' | 'done' | 'failed'
  onCopy: (value: string) => void
}) {
  const openable = entry.kind === 'dir'
  const pressable = openable || (entry.kind === 'file' && onPickFile !== undefined)

  return (
    <li className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        data-testid="folder-entry"
        data-kind={entry.kind}
        data-name={entry.name}
        disabled={!pressable}
        onClick={openable ? onOpen : onPickFile}
        // 的はできるだけ大きく取る。高さも狭い画面で押しやすい値にしてある
        className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-2 text-left font-normal"
      >
        {/* **開く前に、何が起きるかが分かる印。** 画像とテキストが同じ印だと、
            押してみるまで箱が出るのか字が出るのか分からない（種別ごとに見せ方が
            違うと決めてあるので、印もそこへ合わせる） */}
        <span aria-hidden data-testid="folder-entry-icon" className="shrink-0">
          {entry.kind === 'dir'
            ? '📁'
            : entry.kind === 'symlink'
              ? '🔗'
              : fileIcon(entry.name)}
        </span>
        <span className="min-w-0 truncate">{entry.name}</span>
        {entry.is_project && (
          // 深い階層で「どれが目的地か」を1階層ぶん先に教える（設計§8）
          <span
            data-testid="folder-project-mark"
            title="このフォルダは .git を持っています"
            className="border-primary/40 text-primary ml-auto shrink-0 rounded border px-1 text-[10px]"
          >
            PJT
          </span>
        )}
      </Button>
      <CopyPath
        full={full}
        root={root}
        isDir={entry.kind === 'dir'}
        state={copyState}
        onCopy={onCopy}
      />
    </li>
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
  state: 'idle' | 'done' | 'failed'
  onCopy: (value: string) => void
}) {
  const base = root === undefined ? full : relativeOf(root, full)
  // **フォルダは末尾に `/` を付ける。** 貼られた側で「これは入れ物か中身か」が
  // 一目で分かり、続けて名前を書き足すときにも区切りを打ち直さずに済む
  const value = isDir && !base.endsWith('/') ? `${base}/` : base

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
      className="text-muted-foreground shrink-0 text-xs"
      onClick={() => onCopy(value)}
    >
      {state === 'done' ? 'コピーしました' : state === 'failed' ? 'コピーできません' : 'コピー'}
    </Button>
  )
}
