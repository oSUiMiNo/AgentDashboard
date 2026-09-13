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

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import ReactMarkdown from 'react-markdown'
import { FileEditor } from './FileEditor'
import { FileFind } from '@/components/FileView/FileFind'
import { FileTabs } from '@/components/FileView/FileTabs'
import { Button } from '@/components/ui/button'
import {
  CloseGlyph,
  CodeGlyph,
  ExternalLinkGlyph,
  MinusGlyph,
  PlusGlyph,
  SearchGlyph,
} from '@/components/ui/glyphs'
import { fileKind, needsSandbox } from '@/lib/fileKind'
import { useFileZoom, ZOOM_STEPS } from '@/lib/fileZoom'
import { isFindOpen } from '@/lib/keys'
import { REHYPE_PLUGINS, REMARK_PLUGINS } from '@/lib/markdown'
import {
  HostFsError,
  previewUrl,
  rawUrl,
  readBlob,
  readFile,
  relativeOf,
  writeFile,
  type FileContent,
} from '@/lib/hostfs'
import { dropEdit, putEdit, readEdit, WRITE_DEBOUNCE_MS } from '@/lib/fileEdits'
import { useAuthStore } from '@/stores/auth'

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

/**
 * いま何をしている面か（`ファイルビュアにエディタ機能を追加` 設計§5-1）。
 *
 * **2値である。**「ビュアーを持たない」は種別から導くので、状態には写さない——
 * 導けるものを状態に持つと、片方だけ更新される余地が生まれる。
 */
export type FileMode = 'viewer' | 'editor'

/**
 * 開いたときにどちらで始めるか（設計§5-1・§10-2）。
 *
 * **ビュアーを持たない種別はエディタで始める。** `text` は表に無い拡張子すべての
 * 落ちどころなので、**既定がエディタ**になる（要件「設定無しの拡張子はエディタ」）。
 * `markdown` ／ `html` ／ `svg` はビュアーを持つので、**見たいものをまず見せる。**
 *
 * **`image` はどちらも持たない**（描画の手前で分かれるので、ここの値は使われない）。
 */
function 既定のモード(kind: ReturnType<typeof fileKind>): FileMode {
  return kind === 'text' ? 'editor' : 'viewer'
}

interface Props {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /** 相対パスの基準（その枠のパス）。**画面にも出す** */
  root: string
  /** 読むファイルの絶対パス。**開いているタブのうち、いま見ている1枚** */
  path: string
  /** 開いているタブの絶対パス（左から右の順） */
  tabs: string[]
  /** タブを押した。**並びは動かさず、選び直すだけ** */
  onSelectTab: (path: string) => void
  /** タブの ✕。**1枚だけ閉じる**（下の `onClose` は列ごと） */
  onCloseTab: (path: string) => void
  /** タブを並べ替えた（掴んで運ぶ／Ctrl+Shift+← →）。**動かすものはパスで渡す** */
  onReorderTab: (path: string, to: number) => void
  /** 並べ替えが確定した。**覚えるのはここだけ** */
  onReorderTabCommit: () => void
  /**
   * **列ごと**閉じる。省略すると閉じる操作を出さない。
   *
   * **タブの ✕ とは別物なので、ラベルを書き分ける**（要件の完了条件5）。残してある
   * のは、タブが10枚あるときに1枚ずつ閉じるのが苦行だからである。
   */
  onClose?: () => void
  /**
   * 読めなかったことを親へ知らせる（`イシューグループ_2026-0813-1804` 設計§6-5）。
   *
   * **省略すると断り文を出すだけで、列は開いたまま。** 渡すのは**復元した1件**のときだけで、
   * 利用者が自分で押した1件には渡さない——押した人には理由を見せるのが正しく、
   * **渡さないことがそのまま仕様の実体**になる。
   *
   * `status` は畳むか忘れるかの判断に要る。**畳むのは全部の失敗で、忘れるのは「無い」
   * （404）のときだけ**——寝ている PC で忘れると、起きたときに戻れなくなる。
   */
  onUnreadable?: (status: number | null) => void
}

/** 取ってきた画像。`url` は `blob:` なので、**使い終わったら捨てる**。 */
interface Picture {
  url: string
  bytes: number
  mediaType: string
}

export function FileView({
  host,
  root,
  path,
  tabs,
  onSelectTab,
  onCloseTab,
  onReorderTab,
  onReorderTabCommit,
  onClose,
  onUnreadable,
}: Props) {
  const kind = fileKind(path)
  /**
   * 最新の知らせ先。**効果の依存に入れない**——渡し方が変わるたびに読み直しが走り、
   * 同じファイルをもう一度取りに行くことになる。
   */
  const 知らせ先 = useRef(onUnreadable)
  知らせ先.current = onUnreadable
  const [content, setContent] = useState<FileContent | null>(null)
  const [picture, setPicture] = useState<Picture | null>(null)
  /** 拡張子は画像なのに、中身が画像として読めなかった（設計§7-2） */
  const [broken, setBroken] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /**
   * いま**ビュアーで見ている**のか、**エディタで編集している**のか（設計§5-1）。
   *
   * **名前を `raw` のままにしなかった。** 意味が反転している——もとの `raw=true`
   * （生テキスト）が、置き換え後は**エディタ**である。名前を残すと読めなくなる。
   */
  const [mode, setMode] = useState<FileMode>(() => 既定のモード(kind))
  /**
   * 編集中の中身。**`null` は「まだ触っていない」**で、ディスクの中身をそのまま出す。
   *
   * **空文字列と区別する**——全部消したのも編集である。
   */
  const [書きかけ, set書きかけ] = useState<string | null>(null)
  /** 保存の最中か。**二重に走らせない** */
  const [保存中, set保存中] = useState(false)
  /** 保存が断られた理由。**出しても書きかけは捨てない**（設計§8-4） */
  /**
   * 保存が断られた理由。**競合かどうかを一緒に持つ**（設計§8-3）。
   *
   * 文だけだと、**競合のときにだけ出す2つの道**（読み直す／上書きする）を出し分けられない。
   * 競合以外で出すと、**押せて何も起きない**形になる。
   */
  const [保存の断り, set保存の断り] = useState<{ 文: string; 競合: boolean } | null>(null)
  /**
   * 次の保存が持っていく印（設計§8-3）。読んだ時点のものから始め、**保存のたびに更新する。**
   *
   * **中身を解釈しない。** 作るのも比べるのも PC 側だけで、こちらは持ち回すだけ。
   * **古い PC は付けてこないので、無いことがありうる**——そのときは保存できない
   * （省けば上書きできる道を残さないため）。
   */
  const [印, set印] = useState<string | undefined>(undefined)
  /** 書きかけを `localStorage` から戻したか。**黙って戻さない**（設計§7-4） */
  const [戻した, set戻した] = useState(false)
  /**
   * 書きかけの置き場を口座ごとに分けるための名前（`lib/drafts.ts` と同じ作法）。
   *
   * **`lib/` から `stores/` は読めない**（依存の向きが逆流する）ので、**呼ぶ側で受けて渡す。**
   */
  const account = useAuthStore((state) => state.auth.account)
  /** 探す窓が開いているか（`ファイルビュアの中を Ctrl+F で探せるようにする` 設計） */
  const [find, setFind] = useState(false)
  /**
   * 探すために、プレビューから生テキストへこちらが切り替えたか。
   *
   * **黙って見せ方を変えない。** 押した人から見ると画面が別物になるので、
   * **なぜ変わったのかを1行で言う**。押されるまでは出さない。
   */
  const [切替えた, set切替えた] = useState(false)
  /**
   * 「切り替えてよいか」を尋ねている最中か。
   *
   * **押した瞬間に勝手に切り替えない**（利用者の指定）。押した結果、読んでいたものが
   * 消えるのがいちばん効くので、**先に断って選ばせる**。
   */
  const [切り替えるか, set切り替えるか] = useState(false)
  /**
   * 画像を**原寸を基準に**出すか（既定は「器に収める」）。
   *
   * **倍率だけでは 1:1 に届かない。** 上限は 200% なので、器の 2倍までしか伸びない
   * ——大きな画像を細い列で見ているときは、200% でもまだ原寸の半分以下である。
   * **基を原寸へ切り替えると、100% がちょうど 1:1 になる。**
   *
   * **ファイルを切り替えたら戻す。** 前の画像で切り替えた基準が、次の画像へ持ち越すと
   * 「開いた瞬間に巨大な画像が出る」ことになる。
   */
  const [原寸, set原寸] = useState(false)
  /** 読み込んだ画像の原寸の幅（px）。**無いうちは器に収まる**（CSS のフォールバック） */
  const [画像の幅, set画像の幅] = useState<number | null>(null)
  /**
   * 探す合図の回数。**窓が既に開いているときに、もう一度押された**ことを
   * 窓へ伝えるために要る（入力を選び直して打ち直せる状態にする）。
   */
  const [探す合図, set探す合図] = useState(0)
  /** 遡る箱。**探す相手であり、送る相手でもある** */
  const bodyRef = useRef<HTMLDivElement>(null)
  /** プレビューの箱。**中を探すときは、ここへ便りを送る** */
  const frameRef = useRef<HTMLIFrameElement>(null)
  /** 打つ層（`<textarea>`）。**探す窓が当たりを選択で示すのに要る** */
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const [zoom, 大きさ] = useFileZoom()
  // `CopyPath`（`FolderBrowser`）と同じ3つの状態。**片方だけ黙る作りにしない**

  useEffect(() => {
    let alive = true
    let made: string | null = null
    setLoading(true)
    setError(null)
    setMode(既定のモード(kind))
    set書きかけ(null)
    set保存中(false)
    set保存の断り(null)
    set印(undefined)
    set戻した(false)
    // **ファイルを切り替えたら探す窓を畳む。** 前のファイルで打った語がそのまま
    // 残ると、当たりの数だけが別の文書のものに見える
    setFind(false)
    set切替えた(false)
    set切り替えるか(false)
    set原寸(false)
    set画像の幅(null)
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
            // **ここで反転させない**（設計§5-3）。もとは「重いので生テキストで始める」
            // だったが、生テキストの居場所は**エディタ**になった。そのまま移すと
            // **「重いので編集で開く」**という別の意味になる——**重いものを黙って
            // 編集させるほうが危ない**ので、**ビュアー既定のまま**にする。
            //
            // **代わりに、重いことは下の `file-heavy` で言う**（整形に時間がかかること
            // と、編集へ切り替えれば整形せずに出ること）。**情報は落とさない。**
          }
        }
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : '読めませんでした')
          // **`if (alive)` の中で呼ぶ。** 外で呼ぶと、既に外れた古い `FileView` が
          // 親へ「読めなかった」を報告し、いま開いている列を巻き添えに畳む
          知らせ先.current?.(err instanceof HostFsError ? err.status : null)
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

  const markdown = kind === 'markdown'
  const boxed = needsSandbox(kind)
  // 整形の逃げ道を出す相手（設計§7-4）。**画像には出さない**——テキストではないので、
  // 出しても読めない。代わりに大きさと種別を出す
  const モードを切り替えられる = markdown || boxed
  /**
   * このファイルを**書き戻せるか**（設計§8）。**決めるのはサーバ**で、画面は受け取るだけ
   * ——効いている根は「設定の `writable_roots` ＋ その口座で引けるプロジェクト全部」で、
   * **後者は記録を引かないと分からない**。**画面が自分で判定しない**（場所が2つあると食い違う）。
   *
   * 書けないファイルでも**ソースは読める**。トグルは残し、行き先を**読み取り専用の
   * 生テキスト**にする——消すと、このイシュー以前にできていた「整形を外して中を見る」を
   * 取り上げることになる。
   */
  const 書ける = content?.writable === true
  /** トグルの言葉。**書けないファイルで「編集する」と言わない**（嘘になる） */
  const 切替の言葉 = mode === 'editor' ? '見る' : 書ける ? '編集する' : '生テキスト'
  /** いま箱（`iframe`）で描いているか。**箱の中へは外から触れない** */
  const 箱で描いている = boxed && mode === 'viewer'
  /**
   * いま中を探せるか。**探せるのはテキストとして出している2つだけで、これは選択では
   * なく制約である**（`ファイルビュアの中を Ctrl+F で探せるようにする` 要件）。
   *
   * - 画像は**文字を持たない**
   * - HTML ／ SVG の箱は `allow-same-origin` を書いていないので**別の出自を名乗る**
   *   ——外から中身に触れないのは**隔離が効いている証拠**であって、直すべき不具合ではない
   */
  /** いま出す本文。**触っていなければディスクの中身そのもの** */
  const 本文 = 書きかけ ?? content?.text ?? ''
  /** ディスクの中身と違うか。**空にしたのも違いである** */
  const 変えた = 書きかけ !== null && content !== null && 書きかけ !== content.text
  /**
   * 保存を押せるか。**ボタンと鍵盤が同じ述語を読む**（設計§6-7）——別々に書くと
   * 「ボタンは押せないのに鍵盤では保存できる」が起こる。
   *
   * - **切れている中身は保存させない**（設計§9）。一部しか読んでいないものを書くと
   *   **ファイルを切り詰めて上書きする**
   * - **印が無ければ保存させない**（設計§8-3）。省けば上書きできる道を残さない
   */
  const 保存できる =
    変えた && !保存中 && content !== null && content.truncated !== true && 印 !== undefined
  const 探せる = !loading && content !== null && !箱で描いている
  /**
   * 探す入口を出すか。**プレビューでも出す**（利用者の指摘・2026-09-08）。
   *
   * # 箱の中は探せない。だから、探せる見せ方へ連れていく
   *
   * `iframe` は別の出自を名乗るので、**外から中身に触れない**——これは隔離が効いて
   * いる証拠であって、直せる不具合ではない。**入口を出さない**という前の答えは、
   * 「押せるのに何も起きないボタンを出さない」という理由では正しかったが、
   * **利用者から見ると「探せない道具」に見えていた**。
   *
   * **押したら生テキストへ切り替えて、そこで探す。** 同じ中身の別の見せ方であり、
   * 元から用意してある逃げ道でもある。**何も起きないボタンにはならず、黙って
   * 画面を変えることもしない**（切り替えたことは1行で言う）。
   *
   * **画像にだけは出さない。** あちらは文字を持たないので、連れていく先が無い。
   */
  /**
   * **箱の中をそのまま探せるか。**
   *
   * # 見ている姿を壊さずに探す（利用者の指定・2026-09-08）
   *
   * 前は「押したら生テキストへ切り替えて、そこで探す」にしていた。**筋は通っていたが、
   * 求められていたのは回避ではなく本体だった**——プレビューで読んでいるのは**整形された
   * 姿**なので、生テキストへ変わった瞬間に**探す目的そのものが半分消える**。
   *
   * # 隔離は1段も緩めていない
   *
   * 親から中へ手を伸ばす道（`allow-same-origin` を足す）は**採らなかった**。あれは
   * `allow-scripts` と並ぶと、**箱がダッシュボードと同じ出自を名乗れて script が自分で
   * `sandbox` を外せる**——利用者の手元の任意の HTML に、ダッシュボードの鍵を渡すのと
   * 同じになる。
   *
   * **代わりに、中へ探す係を置いて指示だけを渡す**（サーバの `FINDER_JS`。宛先は
   * [`previewUrl`]）。`postMessage` は隔離された箱にも元から許されているので、
   * **できることは1つも増えていない。**
   *
   * # SVG には足していない
   *
   * `</svg>` の外に要素を置けないので、同じ手が使えない。あちらは下の断りを通して
   * 生テキストへ切り替える道が残る。
   */
  const 箱の中で探せる = 箱で描いている && kind === 'html'
  /**
   * 打つ層で当たりを示す形か。**エディタを出しているときだけ。**
   *
   * **描き分けと同じ条件から導く**——別々に書くと、片方だけ直したときに「探せると
   * 言っているのに打つ層が無い」が起こる。下の描き分けは
   * 「箱 → 整形 Markdown → それ以外はエディタ」の順なので、**その「それ以外」がここ**。
   *
   * **`探せる` に `mode` を混ぜていない**ことに注意（設計§5-4）。探せるかどうかは
   * 今までどおりで、**どの道で探すか**だけがモードで変わる。
   */
  const 打つ層で探せる =
    探せる && picture === null && !(markdown && mode === 'viewer')
  const 探す入口 = !loading && content !== null

  /**
   * 探し始める。**プレビューなら、生テキストへ連れていってから開く。**
   *
   * 既に開いているときも合図だけ増やす——**もう一度押したら打ち直せる**のが
   * 探す窓の作法である。
   */
  const 探し始める = useCallback(() => {
    /*
      **見ている姿を壊さない。** HTML のプレビューは、箱の中の係へ頼めばそのまま探せる。

      SVG だけは係を置けないので、**切り替えるしかない**——ただし**黙って切り替えない**。
      押した結果、見ていたものが消えるのがいちばん効くので、**先に断って選ばせる**。
    */
    if (箱で描いている && !箱の中で探せる) {
      set切り替えるか(true)
      return
    }
    setFind(true)
    set探す合図((n) => n + 1)
  }, [箱で描いている, 箱の中で探せる])

  /** 断りを受けて、エディタへ切り替えてから探す（SVG だけが通る道） */
  const 切り替えて探す = useCallback(() => {
    set切り替えるか(false)
    setMode('editor')
    set切替えた(true)
    setFind(true)
    set探す合図((n) => n + 1)
  }, [])

  /**
   * 読み終えたら、印を控え、**書きかけが残っていないか見る**（設計§7-4）。
   *
   * **黙って戻さない。** 戻したことは画面で言い、**捨てる道を必ず添える**——
   * 黙って戻すと、ディスクの中身と違うものを見ているのに気づけない。
   */
  useEffect(() => {
    if (content === null) {
      return
    }
    set印(content.stamp)
    const 残り = readEdit(host, path, account)
    if (残り !== null && 残り !== content.text) {
      set書きかけ(残り)
      set戻した(true)
    }
  }, [content, host, path, account])

  /**
   * 打鍵を**まとめて**写す（設計§7-3）。1文字ごとには書かない。
   *
   * **まとめる以上、まとめた途中で離れるときに確定させなければならない。**
   * 窓は 300ms なので、**その内側でタブを閉じる・別のファイルへ移る・PJT を移る・
   * 版が切り替わって読み直す**と、打ったぶんが消える。だから `lib/drafts.ts` と
   * 同じ**3点セット**で解く——**確定させる口**・**`pagehide` で確定**・**片付けで確定**。
   *
   * `beforeunload` は足さない（web 全体に1つも無く、`pagehide` を意図して
   * 選んでいる——`beforeunload` はモバイルで発火しないことがある）。
   */
  /** まだ写していない中身。`null` は「写すものが無い」 */
  const 未書き出し = useRef<string | null>(null)
  const 書き出しの札 = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 時計を止めて、**その場で写す**。
   *
   * **`host` ／ `path` ／ `account` を閉じ込めている**ので、鍵が変わる瞬間に呼ばれても
   * **古い鍵へ書く**。ここを「いまの鍵」にすると、**別のファイルの書きかけとして
   * 現れる**——最も気づきにくい壊れ方である。
   */
  const 書きかけを確定する = useCallback(() => {
    if (書き出しの札.current !== null) {
      clearTimeout(書き出しの札.current)
      書き出しの札.current = null
    }
    if (未書き出し.current === null) {
      return
    }
    putEdit(host, path, 未書き出し.current, account)
    未書き出し.current = null
  }, [host, path, account])

  useEffect(() => {
    const 離れる = () => {
      書きかけを確定する()
    }
    globalThis.addEventListener('pagehide', 離れる)
    return () => {
      globalThis.removeEventListener('pagehide', 離れる)
      // **消えるときも書き切る。** 画面を移っただけで失われないため
      書きかけを確定する()
    }
  }, [書きかけを確定する])

  /**
   * 打鍵を受ける。**状態と「まだ写していない中身」の両方を進める。**
   *
   * 状態だけを効果の依存に置くと、**打鍵のたびに片付けが走って確定してしまい、
   * まとめる意味が消える**（1文字ごとに書くのと同じになる）。だから写す側は
   * 参照で持ち、窓が閉じたときだけ書く。
   */
  const 書きかけを打つ = useCallback(
    (次: string) => {
      set書きかけ(次)
      未書き出し.current = 次
      if (書き出しの札.current !== null) {
        clearTimeout(書き出しの札.current)
      }
      書き出しの札.current = setTimeout(() => {
        書き出しの札.current = null
        書きかけを確定する()
      }, WRITE_DEBOUNCE_MS)
    },
    [書きかけを確定する],
  )

  /**
   * 写す予定を取り消す。**捨てたあとに古い値が書き戻らないようにする。**
   *
   * 保存に成功したときと編集を捨てたときに呼ぶ。呼ばないと、**窓の中で保存すると
   * 直後に `putEdit` が走り、捨てたはずの書きかけが復活する。**
   */
  const 書き出しを取り消す = useCallback(() => {
    if (書き出しの札.current !== null) {
      clearTimeout(書き出しの札.current)
      書き出しの札.current = null
    }
    未書き出し.current = null
  }, [])

  /**
   * ディスクへ書き戻す（設計§2・§8）。
   *
   * **印を持っていく。** 読んでから保存するまでに他所で書き換えられていたら、
   * PC 側が断る——**このダッシュボードは別のセッションの claude が同じファイルを
   * 触るのが日常**なので、黙って上書きすると**相手の作業が音もなく消える**。
   */
  const 保存する = useCallback(
    async (印を取り直すか = false) => {
    if (content === null || 書きかけ === null || (印 === undefined && !印を取り直すか)) {
      return
    }
    const 送る = 書きかけ
    set保存中(true)
    set保存の断り(null)
    try {
      // **「上書きする」のときだけ印を取り直す**（設計§8-3）。**中身は書きかけのまま**
      // ——読み直しを経由して書きかけを消さない。**取り直す間にまた変わっていたら、
      // また断られるのが正しい**（黙って通さない）
      const 使う印 = 印を取り直すか ? ((await readFile(host, path)).stamp ?? '') : (印 ?? '')
      const 答え = await writeFile(host, path, 送る, 使う印)
      set印(答え.stamp)
      setContent((now) =>
        now === null ? now : { ...now, text: 送る, bytes: 答え.bytes, stamp: 答え.stamp },
      )
      set書きかけ(null)
      set戻した(false)
      // **成功したときだけ捨てる**（設計§7-3）。**写す予定も取り消す**——
      // 窓の内側で保存すると、直後に書き戻って捨てたはずのものが復活する
      書き出しを取り消す()
      dropEdit(host, path, account)
    } catch (err) {
      // **失敗しても書きかけを捨てない**（設計§8-4）。捨てると、断られた瞬間に
      // 打った文が消える——直せるはずのものが直せなくなる
      set保存の断り({
        文: err instanceof Error ? err.message : '保存できませんでした',
        // **競合だけは 409 で見分ける**（設計§8-3）。文で見分けると、断り文を
        // 直した日に黙って壊れる
        競合: err instanceof HostFsError && err.status === 409,
      })
    } finally {
      set保存中(false)
    }
    },
    [content, 書きかけ, 印, host, path, account, 書き出しを取り消す],
  )

  /**
   * 競合のときの「読み直す」（設計§8-3）。**自分の編集を捨てて、ディスクの中身を取り直す。**
   *
   * **`編集を捨てる` と分けてある。** あちらは手元の `content` へ戻すだけで、
   * **ディスクが変わっている競合の場面では、戻る先そのものが古い。**
   */
  const 読み直す = useCallback(async () => {
    set保存中(true)
    try {
      const 最新 = await readFile(host, path)
      setContent(最新)
      set印(最新.stamp)
      set書きかけ(null)
      set戻した(false)
      set保存の断り(null)
      書き出しを取り消す()
      dropEdit(host, path, account)
    } catch (err) {
      set保存の断り({
        文: err instanceof Error ? err.message : '読み直せませんでした',
        競合: false,
      })
    } finally {
      set保存中(false)
    }
  }, [host, path, account, 書き出しを取り消す])

  /** 編集を捨ててディスクの中身へ戻す。**戻す先を必ず用意する**（設計§7-4） */
  const 編集を捨てる = useCallback(() => {
    set書きかけ(null)
    set戻した(false)
    set保存の断り(null)
    // 捨てたあとに古い値が書き戻らないよう、**写す予定も取り消す**
    書き出しを取り消す()
    dropEdit(host, path, account)
  }, [host, path, account, 書き出しを取り消す])

  /*
    **Ctrl+F ／ Ctrl+G を奪うのは、探す入口があるときだけ。**

    ブラウザの探索は画面全体が対象なので、「開いているファイルの中だけ」という目的を
    ブラウザ側の機能では満たせない。一方**常に奪うのは行き過ぎ**で、ファイルビュアを
    開いていない画面でまで奪うと、ブラウザ本来の探索を取り上げることになる。

    **プレビューでも奪うようになった。** 奪ったうえで生テキストへ連れていくので、
    **押した結果が必ず在る**——奪っておいて何もしないのが、いちばん悪い形である。

    **焦点の位置で結果を変えない**（`lib/keys.ts` の作法）。この画面には入力口が2つ
    常設されているが、Ctrl+F はどちらでも文字を打つ操作ではないので、奪っても
    打鍵の邪魔にならない。**窓の中の Ctrl+G は窓自身が先に食う**（あちらでは「次へ」）
    ので、ここへは来ない。
  */
  useEffect(() => {
    if (!探す入口) {
      return
    }
    const 押した = (event: KeyboardEvent) => {
      if (
        !isFindOpen({
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          isComposing: event.isComposing,
        })
      ) {
        return
      }
      event.preventDefault()
      探し始める()
    }
    globalThis.addEventListener('keydown', 押した)
    return () => globalThis.removeEventListener('keydown', 押した)
  }, [探す入口, 探し始める])

  return (
    <section
      data-testid="file-view"
      data-path={path}
      data-kind={kind}
      /*
        **器が大きさを持ち、本文がそれを読む**（`index.css` の `.file-zoom`）。

        **`.prose-dashboard` へ直接書かない。** あちらは構造化ビューと共用しているので、
        値そのものを動かすと**関係の無い画面（履歴）まで一緒に動く**。ここで渡すのは
        「どこから取るか」だけで、器の外ではフォールバックが効く。
      */
      style={{ '--file-zoom': zoom / 100 } as CSSProperties}
      // **入れ物の高さいっぱいに広がる。** これが無いと中身が伸び放題になり、
      // 下の `overflow-auto` が効かずに親ごとはみ出す（兄弟の `FolderBrowser` と同じ理由）。
      // `overflow-auto` が言うのは「はみ出したら遡らせる」だけで、**どこまでがはみ出しかは
      // 別に決まっている必要がある**。高さが `auto` のままだと箱も中身と一緒に伸びるので、
      // はみ出しが永久に発生しない——遡れないのに、画面には「短い文書」に見える
      /*
        **`pt-2` と `gap-2`（どちらも 8px）は、タブ帯が当てにしている。** 帯は掴んだ
        1枚のために上下へ 6px はみ出す箱を持ち、`-my-1.5` で外形だけ戻している
        （`FileTabs.tsx`・`DESIGN.md` §48.18）。**ここを詰めると、はみ出した箱が
        下の本文へ被さる**——帯は `onPointerMove` を持つので、当たり判定も一緒に降りる。
      */
      className="file-zoom border-border flex h-full min-h-0 flex-col gap-2 border-t pt-2"
    >
      {/*
        **1行に保つ**（`flex-nowrap`）。3つの工事（タブ・探す・文字の大きさ）が同じ帯へ
        入り、どれも「狭い窓で2行にならない」を完了条件に挙げている。折り返しを許すと、
        部品が増えるたびにヘッダが伸びて中身が下へ押し出される。

        **折り返しを禁じたぶん、いちばん広い部品が入らなくなる。** `生テキストで見る`
        （約120px）だけは狭い窓で印にする——**`DESIGN.md` §39.6 のターミナルトグルが
        同じことをしている**。

        並びは**左から、効く相手が近いものから遠いものへ**。
        「どのファイルか（タブ）」→「中身をどう読むか（探す・大きさ・整形／生）」→
        「外へ出す」→「閉じる」。
      */}
      {/*
        **`items-center` を外さないこと。** 伸ばす（既定の `items-stretch`）に変えると、
        タブ帯の負の余白が「外形を戻す」意味を失い、帯だけが段から溢れる（§48.18）。
      */}
      <header className="flex items-center gap-1.5">
        {/*
          **タブ帯が、もとの相対パスの chip を置き換える**（`FileTabs`）。
          役目が同じ（いま何を見ているか）で、`title` も引き継いでいるので、
          置き換えても失われる情報が無い。
        */}
        <FileTabs
          tabs={tabs}
          current={path}
          root={root}
          onSelect={onSelectTab}
          onClose={onCloseTab}
          onReorder={onReorderTab}
          onReorderCommit={onReorderTabCommit}
        />

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {探す入口 && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="file-find-open"
              aria-label="このファイルの中を探す"
              title={
                箱で描いている
                  ? 'このファイルの中を探す（Ctrl+F ／ Ctrl+G）。生テキストに切り替わります'
                  : 'このファイルの中を探す（Ctrl+F ／ Ctrl+G）'
              }
              aria-pressed={find}
              onClick={探し始める}
            >
              <SearchGlyph />
            </Button>
          )}

          {/*
            **文字の大きさ**（`ファイルビュアの文字を小さめに始め…` 設計）。

            **3つで1つのまとまりに見せる。** 間を詰め、囲みを共有する——別々の
            ボタンに見えると、真ん中の数字が押せることが読めない。

            **端では押せなくする。** 押せるのに何も起きないものは、壊れているのと
            見分けが付かない。

            **「拡大／縮小」と呼ばない**（`DESIGN.md` §39.5）。その語は画面の行き来に
            取ってある。ここは「文字を大きく／小さく」。
          */}
          <div
            data-testid="file-zoom"
            className="border-border flex shrink-0 items-center rounded-md border"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="file-zoom-out"
              aria-label="文字を小さく"
              title="文字を小さく"
              disabled={zoom <= ZOOM_STEPS[0]}
              onClick={大きさ.小さく}
            >
              <MinusGlyph />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="file-zoom-reset"
              aria-label={`文字の大きさ ${zoom}%。押すと既定へ戻す`}
              title="押すと既定の大きさへ戻す"
              className="min-w-11 px-1 text-[11px] tabular-nums"
              onClick={大きさ.戻す}
            >
              {zoom}%
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="file-zoom-in"
              aria-label="文字を大きく"
              title="文字を大きく"
              disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
              onClick={大きさ.大きく}
            >
              <PlusGlyph />
            </Button>
          </div>

          {/* **「生テキストで見る」を、見る／編集するのトグルへ置き換えた**（設計§5）。
              綴りも `file-toggle-raw` から変えてある——**`raw` は意味が反転している**
              ので、印に残すと次に読む人が取り違える。

              **ビュアーを持たない種別には出さない**（`text` ／ `image`）。要件は
              「押しても反応しない」と書いていたが、**この PJT は「出さない」を採る**
              （押せて何も起きないものは壊れて見える）。**無いことは `DESIGN.md` の
              総当たり表へ「意図して出さない」と記録してある。** */}
          {モードを切り替えられる && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="file-toggle-mode"
              aria-pressed={mode === 'editor'}
              aria-label={切替の言葉}
              title={切替の言葉}
              onClick={() => {
                setMode((now) => (now === 'viewer' ? 'editor' : 'viewer'))
                // **人が自分で見せ方を変えたら、こちらの断りは消す。** そこから先は
                // 押した人が選んだ見せ方であって、こちらが切り替えた結果ではない
                set切替えた(false)
                set切り替えるか(false)
              }}
            >
              {/* **狭い窓では印だけ**（§39.6）。言葉は `aria-label` と `title` に残る */}
              <CodeGlyph className="md:hidden" />
              <span className="hidden md:inline">{切替の言葉}</span>
            </Button>
          )}
          {/* **保存はエディタのときだけ出す。** ビュアーに出しても書く対象が無い。

              **押せる条件は `保存できる` 1つ**（設計§6-7）——ボタンと、のちに足す
              鍵盤の道が**同じ述語を読む**。別々に書くと食い違う。 */}
          {mode === 'editor' && 書ける && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="file-save"
              aria-label="保存する"
              title="保存する"
              disabled={!保存できる}
              onClick={() => {
                void 保存する()
              }}
            >
              {保存中 ? '保存中…' : '保存'}
            </Button>
          )}
          {/* **押す道はリンクにする**（設計§6-2）。`window.open` を呼ぶボタンにすると、
              中クリック・修飾キー・キーボード操作・ブラウザ自身の「新しいタブで開く」を
              こちらで作り直すことになる。

              **宛先は `rawUrl` そのまま**（設計§6-3）——画面で文字列を継ぎ足さない。

              **種別で出し分けない**（設計§6-6）。表に無いものも `text/plain` で字が出る
              ようになったので、押して意味の無い相手でも字か理由のどちらかは必ず出る。

              **ここでいう「タブ」はブラウザのタブである**——左のタブ帯（アプリの中の
              タブ）とは別物なので、同じ帯に2つの意味の「タブ」が並ぶ */}
          <Button asChild variant="ghost" size="icon-sm">
            <a
              data-testid="file-open-tab"
              href={rawUrl(host, path)}
              target="_blank"
              rel="noopener"
              aria-label="ブラウザで開く"
              title="ブラウザで開く"
            >
              <ExternalLinkGlyph />
            </a>
          </Button>
          {onClose !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="file-close"
              /* **タブの ✕ は1枚だけ、こちらは列ごと。** 2つの「閉じる」が同じ帯に
                 並ぶので、ラベルで書き分ける（要件の完了条件5） */
              aria-label="ファイルの列を閉じる"
              title="ファイルの列を閉じる"
              onClick={onClose}
            >
              <CloseGlyph />
            </Button>
          )}
        </div>
      </header>

      {error !== null && (
        <p data-testid="file-error" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {/* **黙って見せ方を変えない。** 箱の中は外から触れないので、探すには生テキストへ
          移るしかない——**移ったこと自体は正しいが、理由を言わないと画面が壊れたように
          見える**。「整形して見る」で戻れることまで書く */}
      {/* **黙って切り替えない**（利用者の指定・2026-09-08）。SVG は箱の中に係を置けない
          ので、探すには生テキストへ移るしかない——**移るかどうかは押した人が決める** */}
      {切り替えるか && 箱で描いている && (
        <p
          data-testid="file-find-confirm"
          className="flex flex-wrap items-center gap-2 text-xs text-amber-300"
        >
          <span>
            この見せ方のままでは中を探せません。生テキストに切り替えて探しますか（表示が
            変わります
            {content !== null && content.bytes > FORMAT_DEFAULT_LIMIT
              ? `。大きいので時間がかかります：${content.bytes} バイト`
              : ''}
            ）。
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="file-find-confirm-go"
            onClick={切り替えて探す}
          >
            切り替えて探す
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="file-find-confirm-cancel"
            onClick={() => set切り替えるか(false)}
          >
            やめる
          </Button>
        </p>
      )}

      {切替えた && mode === 'editor' && (
        <p data-testid="file-find-switched" className="text-xs text-amber-300">
          中を探すために、編集の面に切り替えました（プレビューのままでは中に触れません）。
          「見る」で戻せます。
        </p>
      )}

      {/* **黙って戻さない**（設計§7-4）。前に開いたときの書きかけが残っていたら
          そう言い、**捨てる道を必ず添える**——添えないと、ディスクの中身へ戻る手が
          無くなる */}
      {戻した && (
        <p data-testid="file-unsaved" className="text-xs text-amber-300">
          未保存の変更があります（前に開いたときの続きです）。
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="file-discard"
            onClick={編集を捨てる}
          >
            編集を捨てる
          </Button>
        </p>
      )}

      {/* **断られても書きかけは消さない**（設計§8-4）。理由をそのまま出す——
          「許可されていない場所」「他所で書き換えられていた」は、**利用者が直せる
          ものと直せないものが違う**ので、こちらでまとめない */}
      {保存の断り !== null && (
        <p
          data-testid="file-save-error"
          /* **改行を保つ**（設計§8-2）。サーバは「どこなら書けるか」「どう足すか」を
             改行で3段に分けて返すのに、**HTML の既定では改行が空白に潰れる**——
             決めた効き目が、表示で失われていた。**長いパスで横へはみ出させない**
             ので `break-words` も要る */
          className="text-xs break-words whitespace-pre-line text-red-300"
        >
          保存できませんでした：{保存の断り.文}
        </p>
      )}

      {/* **競合のときだけ、2つの道を出す**（設計§8-3）。
          **「他所で変わっています」と出して終わりにしない**——選べないと、利用者は
          編集を手で写すしかなくなる。
          **競合以外では出さない。** 権限や許可の外で「上書きする」を出しても通らず、
          **押せて何も起きない**形になる */}
      {保存の断り?.競合 === true && (
        <p
          data-testid="file-conflict-choice"
          className="flex flex-wrap items-center gap-2 text-xs text-red-300"
        >
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="file-reload"
            disabled={保存中}
            onClick={() => {
              void 読み直す()
            }}
          >
            読み直す
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="file-overwrite"
            disabled={保存中}
            onClick={() => {
              void 保存する(true)
            }}
          >
            自分の編集で上書きする
          </Button>
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
      {markdown && mode === 'viewer' && content !== null && content.bytes > FORMAT_DEFAULT_LIMIT && (
        <p data-testid="file-heavy" className="text-xs text-amber-300">
          大きいので整形に時間がかかります（{content.bytes} バイト）。「編集する」に
          切り替えると、整形せずに出します。
        </p>
      )}

      {loading && (
        <p className="text-muted-foreground text-xs">読み込み中…</p>
      )}

      {!loading && picture !== null && (
        <div data-testid="file-body" className="min-h-0 flex-1 overflow-auto">
          {/*
            **既定は入れ物の幅まで縮める**（設計§8）。原寸で出すと横スクロールが二重に
            なる——ただし**倍率と原寸の切り替えでそこを越えられる**（`index.css` の
            `.file-image`）。はみ出した先へは、この箱をそのまま遡って行く。

            **大きさの直書き（`h-auto max-w-full`）は外した。** 要素へ直接効く
            ユーティリティに、器の側の変数は勝てない——**画像だけ拡大縮小が効かなかった
            のは、ここが器の道に繋がっていなかったからである**（利用者の指摘・2026-09-08）。
          */}
          <img
            data-testid="file-image"
            className="file-image"
            data-fit={原寸 ? 'natural' : 'contain'}
            /* **原寸が分かってから当てる**（`index.css`）。分かる前に当てると、
               小さい絵が一瞬だけ列幅いっぱいに広がってから縮む */
            data-measured={画像の幅 === null ? undefined : 'true'}
            style={
              画像の幅 === null
                ? undefined
                : ({ '--file-image-natural': `${画像の幅}px` } as CSSProperties)
            }
            src={picture.url}
            alt={relative}
            onLoad={(event) => set画像の幅(event.currentTarget.naturalWidth)}
            onError={() => setBroken(true)}
          />
          {/* 画像には生テキストが無いので、代わりに素性を出す（設計§7-4）。
              **原寸への切り替えもここが持つ**——帯に押しボタンを増やさない（§48.2） */}
          <p
            data-testid="file-meta"
            className="file-meta text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-[11px]"
          >
            <span>
              {picture.mediaType} ／ {picture.bytes} バイト
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="file-image-fit"
              /*
                **原寸がまだ分からないうちは押せない。** 押せると
                `calc(100% * 倍率)` に落ちて**器の幅いっぱいまで引き伸ばされる**
                ——「原寸＝1:1」と言っているのに 1:1 でない絵が出る。
                読めなかった絵（`broken`）も、幅が永久に分からないのでここで止まる。
              */
              disabled={画像の幅 === null}
              /*
                **`aria-pressed` は付けない。** 字が状態で変わる（「原寸で見る」↔
                「収めて見る」）ので、**字は「これから起きること」を言っている**。
                そこへ押下状態を重ねると、読み上げでは**逆の意味**になる
                （原寸のときに「収めて見る、がオン」と読まれる）。
              */
              title={
                原寸
                  ? '入れ物の幅に収めて見る'
                  : '原寸を基準にする（倍率 100% がそのままの大きさ）'
              }
              onClick={() => set原寸((now) => !now)}
            >
              {原寸 ? '収めて見る' : '原寸で見る'}
            </Button>
          </p>
        </div>
      )}

      {!loading && content !== null && (
        /* 遡る箱。**印を持っているのは、遡れることが実測でしか言えないため**——
           `file-markdown` と `file-raw` は中身の出し方を指しているので、どちらへ
           切り替えても同じこの箱を掴めるようにしておく（設計§6）。

           **`relative` は探す窓の基準**（`FileFind` を右上へ浮かせる）。位置は
           指定していないので、**見た目は `static` と1ピクセルも変わらない**。
           段を足さずに窓を出すために、ここが基準になっている必要がある */
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/*
            **探す窓は、遡る箱の「外側」へ置く。**

            `position: absolute` の子は、**スクロールする箱の中に置くと中身と一緒に
            流れる**——少し送っただけで窓が画面の外へ消える。基準は箱そのものではなく、
            **箱を包む流れない段**でなければならない。

            この段は `flex-1` を受け取って高さを解決するだけで、**見た目は1ピクセルも
            足していない**（§39.4 の言う「段」＝余白を持つ帯ではない）。
          */}
          {find && (探せる || 箱の中で探せる) && (
            <FileFind
              /* **整形と生テキストでは木の形が違う**ので、切り替えたら探し直す */
              contentKey={`${path}:${mode}`}
              合図={探す合図}
              bodyRef={bodyRef}
              /* **箱を見ているときは、中の係へ頼む**（親からは中に触れない） */
              {...(箱の中で探せる ? { frameRef } : {})}
              /* **エディタのときは、値の中を探して選択で示す**（設計§5-4）。
                 DOM を遡ると行番号と色の層に当たるので、そちらへは行かせない */
              {...(打つ層で探せる ? { editorRef, 本文 } : {})}
              onClose={() => setFind(false)}
            />
          )}
          <div
            ref={bodyRef}
            data-testid="file-body"
            className="min-h-0 flex-1 overflow-auto"
          >
          {boxed && mode === 'viewer' ? (
            /* **隔離した箱**（設計§6-1）。鍵は二重で、ここに書く `sandbox` 属性と、
               応答に付く CSP の `sandbox` 指令。後者は**URL を直接開かれたときにも
               効く**唯一の鍵になる。

               **`allow-scripts` を1段だけ許してある**（`ファイルの中身に掛けた隔離を、
               script の1段だけ解く` 設計§4）。理解ドキュメントの作法が文書内で完結する
               インライン script を許しているのに、こちらが黙って落としていたためである。

               **`allow-same-origin` は書かない。** 両方付くと箱がダッシュボードと同じ
               出自を名乗れて、script が自分で `sandbox` を外せる——鍵を渡したうえで
               「外してよい」と言うのと同じになる（設計§4-2）。**サーバの CSP と同じ1段
               でなければ効かない**ので、片方だけ直さないこと。

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
            /* **箱ごと拡大縮小する**（`index.css` の `.file-frame`）。中へ触れないので、
               `iframe` そのものを `transform` で拡大し、寸法を逆数で伸ばして打ち消す。
               外側の `file-frame-box` は**はみ出しを隠すため**に要る */
            <div className="file-frame-box">
              <iframe
                ref={frameRef}
                data-testid="file-frame"
                title={relative}
                sandbox="allow-scripts"
                /* **`as=preview`。** 中を探すための係が末尾に足された姿で返る
                   （「ブラウザで開く」の `as=raw` には1バイトも足さない） */
                src={previewUrl(host, path)}
                className="file-frame border-0 bg-white"
              />
            </div>
          ) : markdown && mode === 'viewer' ? (
            <div
              data-testid="file-markdown"
              /* **大きさを直書きしない**（もとは `text-sm leading-relaxed`）。
                 要素へ直接効くユーティリティに、器の側の変数は勝てない——
                 直書きを外すところまでが1組である（`index.css` の `.prose-body` が
                 同じ理由で同じ形になっている） */
              className="prose-dashboard file-prose"
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
          ) : !書ける ? (
            /* **読み取り専用の生テキスト**（設計§8）。**保存を許可した場所の外**なので、
               打てる姿で出さない——**打てるのに保存できないのは「押せて何も起きない」と
               同じ形**になる（`DESIGN.md` の原則）。

               **フェーズ3が `.file-zoom .file-raw` を消さずに残したのは、この用途のため。**
               新しく作らずに、そのまま戻している。 */
            <pre
              data-testid="file-raw"
              className="text-muted-foreground file-raw overflow-x-auto whitespace-pre-wrap"
            >
              {content.text}
            </pre>
          ) : (
            /* **エディタ**（設計§6）。この段は**素の `textarea`**で、色付けと行番号は
               次のフェーズで重ねる。**それでも「編集して保存できる」状態として単独で
               成立している。**

               **`file-raw` を流用していない。** 生テキストの表示とエディタは別物で、
               同じ印だと総当たり表が区別できない。

               **大きさは器から取る**（`index.css` の `.file-zoom .file-editor`）。
               直書きすると器の変数が勝てず、**この種類だけ拡大縮小が黙って効かなくなる**。
               次のフェーズで重ねる `<pre>` は、**ここと同じ変数を同じ経路で読む**こと
               ——片方だけ繋ぐと、ずれがカーソル位置に出る。

               **`wrap="off"`。** 折り返さずに横へ送る——**横スクロールを持つ層が
               ここへ移る**（もとは `<pre>` が持っていた）。 */
            <FileEditor
              value={本文}
              onChange={書きかけを打つ}
              onSave={() => {
                void 保存する()
              }}
              保存できる={保存できる}
              path={path}
              ラベル={`${relative} を編集`}
              打つ層Ref={editorRef}
            />
            )}
          </div>
        </div>
      )}
    </section>
  )
}
