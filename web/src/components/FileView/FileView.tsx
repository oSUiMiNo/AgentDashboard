/**
 * ファイル1つを見せる（イシューグループ_2026_0805_0514 設計§15、
 * `ファイル閲覧で画像とHTMLも表示する` 設計§7）。
 *
 * # 何のための画面か
 *
 * 目的は2つで、どちらも「エージェントへ指示を出す前の一手」にあたる。
 *
 * - **相対パスを渡す** … 実 PC の VSCode を見に行かずに、貼れる形の値を取る
 * - **進捗を確かめる** … `計画.md` のチェックボックスが入っているかを見る
 *
 * だから整形は Markdown に寄せてあり、**チェックボックスが読めること**がこの画面の
 * 価値のほとんどを占める。
 *
 * # 種別で1回だけ分岐する
 *
 * 拡張子の判定は `lib/fileKind.ts` の1箇所（設計§2）。ここに `isImage` を足すと、
 * 判定が2箇所になって片方だけ直したときに食い違う。
 *
 * | 種別 | 読み方 | 見せ方 |
 * |---|---|---|
 * | `markdown` / `text` | テキストの口（JSON） | いままでどおり |
 * | `image` | **生の口を自分で取りに行く**（`readBlob`） | `<img>` |
 * | `html` / `svg` | **先にテキストの口** → そのあと箱 | **隔離した `<iframe>`** |
 *
 * # 生の HTML は、整形の中では通さない
 *
 * `react-markdown` は既定で生の HTML を素通ししないので、**`rehype-raw` を入れないこと
 * 自体が安全条件**になっている（設計§15・フェーズ0 の実測）。**これは変えていない**——
 * HTML を描くのは隔離した箱の中だけで、整形の中ではない（設計§13）。
 *
 * # 整形が嘘をついたときの逃げ道を残す
 *
 * 整形すると、元の字面との対応が見えなくなる。**生テキストへ切り替えられる**ように
 * してあるのはそのためで、確かめる先が無い整形は信じられない。箱の中で描く HTML と
 * SVG にも同じ理由が当てはまるので、そちらにも出す（設計§7-4）。
 */

import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/clipboard'
import { fileKind, needsSandbox } from '@/lib/fileKind'
import { REHYPE_PLUGINS, REMARK_PLUGINS } from '@/lib/markdown'
import {
  rawUrl,
  readBlob,
  readFile,
  relativeOf,
  type FileContent,
} from '@/lib/hostfs'

/**
 * **これより大きい Markdown は、整形を既定にしない**（`表示できるテキストの上限を3MBへ上げる`
 * フェーズ3）。
 *
 * # 掛かるのは Markdown だけ
 *
 * **HTML と SVG には掛けない。** あちらを描くのは `iframe`——ブラウザ自身のパーサが
 * 別の文書として描くので、この節が言う重さは当てはまらない。**同じ `readFile` を通る
 * からといって同じ扱いにすると、大きい HTML が `iframe` へ行かなくなる**（実際に
 * そうしてしまった）。
 *
 * # なぜ要るのか
 *
 * 整形（`ReactMarkdown`）は**同期で走り、大きさに対して超線形に伸びる**。実測（jsdom）：
 *
 * | 大きさ | 整形 | 生テキスト |
 * |---:|---:|---:|
 * | 128 KiB | 985 ms | — |
 * | 256 KiB | 1.9 秒 | — |
 * | 512 KiB | 5.5 秒 | — |
 * | 1 MiB | 18.6 秒 | 15 ms |
 * | 3 MiB | **180 秒で終わらず** | 36 ms |
 *
 * 中身を返す上限が 3 MiB へ上がったので、**そのまま整形へ流すと画面が止まる**。
 * 生テキストは大きさによらず一定なので、大きいものはそちらで始める。
 *
 * # なぜ 256 KiB なのか
 *
 * **そこまでは実際に使われていて、問題が出ていない**から。ここは中身を返す上限が
 * 元々置かれていた値で、`guideline.md`（204 KiB）が毎日その内側で整形されている。
 * 「耐えられるはず」ではなく「耐えているのを見た」大きさを線にした。
 *
 * # 整形を禁じてはいない
 *
 * 押せば整形する。**時間がかかることを先に言う**（下の `file-heavy`）だけで、
 * 決めるのは利用者である——300 KiB の文書を整形したい人には2秒の話でしかない。
 *
 * **多バイトの文書を整形で開けるようにすることは、これでは解決していない。**
 * 直すなら分割か仮想化が要るが、それは上限の話とは別の設計になる（別イシュー）。
 */
const FORMAT_DEFAULT_LIMIT = 256 * 1024

interface Props {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /** 相対パスの基準（その枠のパス）。**画面にも出す** */
  root: string
  /** 読むファイルの絶対パス */
  path: string
  /** 閉じる。省略すると閉じる操作を出さない */
  onClose?: () => void
}

/** 取ってきた画像。`url` は `blob:` なので、**使い終わったら捨てる**。 */
interface Picture {
  url: string
  bytes: number
  mediaType: string
}

export function FileView({ host, root, path, onClose }: Props) {
  const kind = fileKind(path)
  const [content, setContent] = useState<FileContent | null>(null)
  const [picture, setPicture] = useState<Picture | null>(null)
  /** 拡張子は画像なのに、中身が画像として読めなかった（設計§7-2） */
  const [broken, setBroken] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // 整形できる相手のときだけ意味を持つ。既定は整形（進捗を読むのが目的のため）
  const [raw, setRaw] = useState(false)
  // `CopyPath`（`FolderBrowser`）と同じ3つの状態。**片方だけ黙る作りにしない**
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')

  useEffect(() => {
    let alive = true
    let made: string | null = null
    setLoading(true)
    setError(null)
    setCopied('idle')
    setRaw(false)
    setBroken(false)
    setContent(null)
    setPicture(null)

    void (async () => {
      try {
        if (kind === 'image') {
          // **画像はテキストの口を1回も叩かない。** 二度運ぶ意味が無いうえ、
          // あちらは UTF-8 として読めないものを断るので、必ず失敗する
          const found = await readBlob(host, path)
          made = found.url
          if (alive) {
            setPicture(found)
          } else {
            // 外れたあとに届いたぶんも捨てる（下の後始末は `made` を見る）
            URL.revokeObjectURL(found.url)
            made = null
          }
        } else {
          // **HTML と SVG も、まずここを通る**（設計§7-3）。断りの理由と
          // 「生テキストで見る」の中身が、この1回で揃う
          const result = await readFile(host, path)
          if (alive) {
            setContent(result)
            // **大きい Markdown だけを生テキストで始める**（`FORMAT_DEFAULT_LIMIT`）。
            //
            // **種別を見ずに掛けてはいけない。** ここは HTML と SVG も通るが、
            // あちらを描くのは `ReactMarkdown` ではなく `iframe`——**ブラウザ自身の
            // パーサが別の文書として**描くので、主線を塞がない。重いのは整形の道
            // だけであって、大きさそのものではない。
            //
            // 実際に取り違えて、**2 MB の HTML が `iframe` ではなく `<pre>` へ
            // 落ちた**（利用者の報告・2026-08-27）。しかも断り書きは Markdown に
            // 絞ってあるので、**理由も出ないまま整形が消えた**ように見えていた。
            if (kind === 'markdown' && result.bytes > FORMAT_DEFAULT_LIMIT) {
              setRaw(true)
            }
          }
        }
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : '読めませんでした')
        }
      } finally {
        if (alive) {
          setLoading(false)
        }
      }
    })()

    return () => {
      alive = false
      // **作った URL は必ず捨てる。** 忘れると、開くたびにブラウザの中で溜まる
      if (made !== null) {
        URL.revokeObjectURL(made)
      }
    }
  }, [host, path, kind])

  const relative = relativeOf(root, path)

  const copy = useCallback(async () => {
    // **黙って失敗させない。** 使えない環境（http の別ホスト・古いブラウザ）では
    // 選べる形で出して、利用者が自分で取れるようにする。
    //
    // 写す手は `lib/clipboard.ts` が1つだけ持つ（設計§4）。**ここへ書き直さない**
    // ——一覧（`CopyPath`）と同じ手を使うので、片方だけ直る形が作れない
    setCopied((await copyToClipboard(relative)) ? 'done' : 'failed')
  }, [relative])

  const markdown = kind === 'markdown'
  const boxed = needsSandbox(kind)
  // 整形の逃げ道を出す相手（設計§7-4）。**画像には出さない**——テキストではないので、
  // 出しても読めない。代わりに大きさと種別を出す
  const canShowSource = markdown || boxed

  return (
    <section
      data-testid="file-view"
      data-path={path}
      data-kind={kind}
      // **入れ物の高さいっぱいに広がる。** これが無いと中身が伸び放題になり、
      // 下の `overflow-auto` が効かずに親ごとはみ出す（兄弟の `FolderBrowser` と同じ理由）。
      // `overflow-auto` が言うのは「はみ出したら遡らせる」だけで、**どこまでがはみ出しかは
      // 別に決まっている必要がある**。高さが `auto` のままだと箱も中身と一緒に伸びるので、
      // はみ出しが永久に発生しない——遡れないのに、画面には「短い文書」に見える
      className="border-border flex h-full min-h-0 flex-col gap-2 border-t pt-2"
    >
      <header className="flex flex-wrap items-center gap-1.5">
        {/* **何からの相対パスかを必ず出す。** 基準の分からない相対パスは、
            貼られた側で解釈できない（設計§15） */}
        <code
          data-testid="file-relative-path"
          className="bg-muted min-w-0 truncate rounded px-1.5 py-0.5 text-xs"
          title={path}
        >
          {relative}
        </code>
        <span
          data-testid="file-relative-base"
          className="text-muted-foreground shrink-0 text-[11px]"
        >
          （{root} からの相対パス）
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="file-copy"
            onClick={() => void copy()}
          >
            パスをコピー
          </Button>
          {canShowSource && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="file-toggle-raw"
              aria-pressed={raw}
              onClick={() => setRaw((now) => !now)}
            >
              {raw ? '整形して見る' : '生テキストで見る'}
            </Button>
          )}
          {onClose !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="file-close"
              onClick={onClose}
            >
              閉じる
            </Button>
          )}
        </div>
      </header>

      {copied === 'done' && (
        <p data-testid="file-copied" className="text-xs text-emerald-400">
          コピーしました
        </p>
      )}

      {copied === 'failed' && (
        <p data-testid="file-copied" className="text-xs text-amber-300">
          コピーできません。この値を選んで取ってください：{' '}
          <code
            data-testid="file-copy-fallback"
            className="bg-muted/60 rounded px-1 py-0.5 font-mono select-all"
          >
            {relative}
          </code>
        </p>
      )}

      {error !== null && (
        <p data-testid="file-error" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {/* **断られたのとは別の言い方にする**（設計§7-2）。直す場所が違う——
          あちらは上限や版、こちらはファイルそのもの */}
      {broken && (
        <p data-testid="file-broken" className="text-xs text-amber-300">
          画像として読めません（拡張子と中身が食い違っているようです）。
        </p>
      )}

      {content?.truncated === true && (
        <p data-testid="file-truncated" className="text-xs text-amber-300">
          長すぎるので途中までしか出していません（全体は {content.bytes} バイト）。
        </p>
      )}

      {/* **なぜ整形されていないのかを言う**（`FORMAT_DEFAULT_LIMIT`）。
          黙って生テキストで出すと、整形が壊れたように見える。
          禁じてはいないので、押せば整形する——待つと決めるのは利用者 */}
      {markdown && raw && content !== null && content.bytes > FORMAT_DEFAULT_LIMIT && (
        <p data-testid="file-heavy" className="text-xs text-amber-300">
          大きいので整形せずに出しています（{content.bytes} バイト）。整形すると時間が
          かかります。
        </p>
      )}

      {loading && (
        <p className="text-muted-foreground text-xs">読み込み中…</p>
      )}

      {!loading && picture !== null && (
        <div data-testid="file-body" className="min-h-0 flex-1 overflow-auto">
          {/* **入れ物の幅まで縮める**（設計§8）。原寸で出すと横スクロールが二重になる */}
          <img
            data-testid="file-image"
            src={picture.url}
            alt={relative}
            className="h-auto max-w-full"
            onError={() => setBroken(true)}
          />
          {/* 画像には生テキストが無いので、代わりに素性を出す（設計§7-4） */}
          <p data-testid="file-meta" className="text-muted-foreground mt-1 text-[11px]">
            {picture.mediaType} ／ {picture.bytes} バイト
          </p>
        </div>
      )}

      {!loading && content !== null && (
        /* 遡る箱。**印を持っているのは、遡れることが実測でしか言えないため**——
           `file-markdown` と `file-raw` は中身の出し方を指しているので、どちらへ
           切り替えても同じこの箱を掴めるようにしておく（設計§6） */
        <div data-testid="file-body" className="min-h-0 flex-1 overflow-auto">
          {boxed && !raw ? (
            /* **隔離した箱**（設計§6-1）。鍵は二重で、ここに書く `sandbox` 属性と、
               応答に付く CSP の `sandbox` 指令。後者は**URL を直接開かれたときにも
               効く**唯一の鍵になる。

               `srcdoc` に手元の本文を渡さないのは、**そちらには CSP が付かない**
               ため（設計§14 の1）。

               **二度運んでいる**——上の `useEffect` が `readFile` で1回、この
               `iframe` が `?as=raw` でもう1回。これを「HTML と SVG はテキストの
               上限（256 KiB）の内側と決まっている」ことで許していたが、
               **その上限は 3 MiB へ上がった**（`表示できるテキストの上限を3MBへ上げる`）。
               桁が変わったので、許していた理由はもう効いていない。

               直すなら「先にテキストを取りに行かず、押されたときに初めて取る」だが、
               それは**断りの理由と生テキストの中身が1回で揃う**という上の作法を
               手放すことになる。**上限の話とは別の判断**なので、ここでは事実だけ
               残す */
            <iframe
              data-testid="file-frame"
              title={relative}
              sandbox=""
              src={rawUrl(host, path)}
              className="h-full w-full border-0 bg-white"
            />
          ) : markdown && !raw ? (
            <div
              data-testid="file-markdown"
              className="prose-dashboard text-sm leading-relaxed"
            >
              {/* 生の HTML は通さない。`rehype-raw` を入れていないことが、
                  そのまま「通さない」の実体になっている（設計§15）。

                  `skipHtml` は、その HTML を**字面としても出さない**（設計§27）。
                  外すと `<br/>` のような綴りが本文に混ざる——このリポジトリの
                  ドキュメントは段落の間隔に使っているので、節のたびに出る。
                  外して困らないのは、消えた中身を「生テキストで見る」で確かめられるため。

                  **改行の扱いだけは履歴と揃える**（`構造化ビューでメッセージの改行が
                  反映されない` 設計§5）。同じ配列を使うので、同じ字を貼れば同じ見え方に
                  なる。`skipHtml` は rehype が走った**あと**に効くので、`<br/>` は先に
                  `br` 要素へ変わって残り、残りの生 HTML はいままでどおり落ちる */}
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} skipHtml>
                {content.text}
              </ReactMarkdown>
            </div>
          ) : (
            <pre
              data-testid="file-raw"
              className="text-muted-foreground overflow-x-auto text-xs whitespace-pre-wrap"
            >
              {content.text}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}
