/**
 * ブロックエディタ（メモ設計§9-2・方針の分かれ道2）。
 *
 * **ここが BlockNote を載せる唯一の場所である。** 読むだけの吹き出しは
 * `react-markdown` で描く（`lib/memoBody.ts`）——溜まったメモの数だけ ProseMirror を
 * 立てると重いので、**立つのは「いま書いているもの」と「いま直しているもの」だけ**に
 * 抑えてある。
 *
 * # キーの割り当て
 *
 * | キー | 何が起きるか |
 * |---|---|
 * | Enter | **ブロックを割る**（エディタの既定） |
 * | Shift+Enter | 改行 |
 * | **Ctrl+Enter** | **確定**（[`isComposerSubmit`]） |
 *
 * **この2つは衝突しない**（設計§9-2）——奪われるのは素の Enter だけで、確定のキーは
 * 入力欄・ターミナルと同じ Ctrl+Enter のままである。
 *
 * **`isComposerSubmit` の型には手を入れていない**（設計§9-1）。判断材料を増やすと
 * 「Shift の扱いを間違える余地そのものが無い」という性質が壊れるので、**そのまま
 * import して使う**。
 *
 * # 画像（設計§10）
 *
 * **貼る道はエディタが持っている。** 落とす・貼り付ける・選ぶのどれでも
 * `uploadFile` が呼ばれるので、**こちらが3経路を書き分ける必要は無い**
 * （`Composer` が3経路を1つの入口へ寄せているのと、結果は同じ形になる）。
 *
 * **ふるいは `pickImages` を通す。** 種別と大きさの線を入力欄と揃えるためで、
 * ここで独自に判定すると **svg が片方だけ通る**ような食い違いが生まれる。
 *
 * **保存先を渡されなければ、画像は貼れない。** 全体メモにはカードが無く、
 * **どの PC のディスクへ置くかが決まらない**（設計§10-1 の【未解決】）。
 * 決まっていないものを黙って既定の PC へ置くと、**別の機械から読めない画像**が
 * 残る。だから**渡されるまで口を開けない**。
 */

import { BlockNoteView } from '@blocknote/shadcn'
import { useCreateBlockNote } from '@blocknote/react'
import { useCallback, useEffect, useRef } from 'react'

import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'

import { isComposerSubmit } from '@/lib/keys'
import type { MemoBody } from '@/lib/memoBody'

interface Props {
  /** 初期の中身。**空なら新規、入っていれば編集。** */
  initial: MemoBody
  /** Ctrl+Enter で確定したとき。**中身を作って渡す。** */
  onSubmit: (body: MemoBody) => void
  /** 打つたび。書きかけを覚えるために使う（渡さなくてよい）。 */
  onChange?: (markdown: string) => void
  /** 読み上げ用。全体メモとセッションメモで**文言を分ける**（設計§6-4）。 */
  label: string
  /**
   * 画像を置く道。**渡さなければ画像を貼れない**（上の doc）。
   *
   * 返すのは**画面から読める URL** で、そのまま本文の Markdown へ入る。
   */
  onUploadImage?: (file: File) => Promise<string>
  /**
   * 画像を抱えているかが変わったとき（設計§8-2）。
   *
   * **抱えている間は版切替の門に札を上げる**——上げないと、版が切り替わった
   * ときにタブが自分で読み直して**運んでいる最中の画像が黙って消える**。
   */
  on抱える?: (抱えている: boolean) => void
  'data-testid'?: string
}

export function MemoEditor({
  initial,
  onSubmit,
  onChange,
  label,
  onUploadImage,
  on抱える,
  'data-testid': testId,
}: Props) {
  /** 最新の運び手を持つ。**エディタは作り直さない**ので参照で渡す */
  const uploadRef = useRef(onUploadImage)
  uploadRef.current = onUploadImage
  const 抱えるRef = useRef(on抱える)
  抱えるRef.current = on抱える

  /** 運んでいる最中の枚数。**0 でなければ抱えている** */
  const 運び中 = useRef(0)

  const editor = useCreateBlockNote({
    initialContent: initial.blocks.length > 0 ? (initial.blocks as never) : undefined,
    /*
      **渡されたときだけ口を開ける。** `undefined` にすると、エディタは画像の
      ブロックを作らせない——「貼れないこと」が押す前に分かる形になる。

      **運んでいる間は札を上げる**（設計§8-2）。8 MiB を運ぶ最中に版が切り替わると、
      読み直しで**運んでいる最中のものが消える**。
    */
    uploadFile:
      onUploadImage === undefined
        ? undefined
        : async (file: File) => {
            運び中.current += 1
            抱えるRef.current?.(true)
            try {
              return await uploadRef.current!(file)
            } finally {
              運び中.current -= 1
              if (運び中.current === 0) {
                抱えるRef.current?.(false)
              }
            }
          },
  })

  /** 開いた時点の中身。**戻すのは1度だけ**なので参照で持つ（毎回の再描画で走らせない） */
  const initialRef = useRef(initial)

  /** 最新の確定先を持つ。**エディタは作り直さない**ので、参照で渡す */
  const submitRef = useRef(onSubmit)
  submitRef.current = onSubmit
  const changeRef = useRef(onChange)
  changeRef.current = onChange

  /** いまの中身を [`MemoBody`] にする。**確定と書きかけで同じ道を通す。** */
  const 読み取る = useCallback((): MemoBody => {
    return {
      blocks: editor.document as unknown[],
      markdown: editor.blocksToMarkdownLossy(editor.document),
    }
  }, [editor])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // **入力欄と同じ述語を使う。** ここで独自に判定すると、同じ Ctrl+Enter が
      // 画面によって違う意味になる。**組み立て方も `Composer` と同じ**——
      // `isComposing` は React の合成イベントではなく生のイベントが持っている
      if (
        !isComposerSubmit({
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          isComposing: event.nativeEvent.isComposing,
        })
      ) {
        return
      }
      // エディタが素の Enter を持っていくのは既定のまま。**確定だけを横取りする**
      event.preventDefault()
      event.stopPropagation()
      submitRef.current(読み取る())
    },
    [読み取る],
  )

  /*
    **書きかけを戻す**（設計§8-1）。

    表が持っているのは**マークダウンの文字列だけ**なので、ブロックへ戻す一手が要る。
    **`tryParseMarkdownToBlocks` は同期である**——`blocksToMarkdownLossy` と同じで、
    名前から非同期に見えるが待たなくてよい（【実測 0.1.137 時点】型が `Block[]` を
    返しており `then` が無い）。**待つ形で書くと `tsc` が落ちる。**
  */
  useEffect(() => {
    const 戻す字 = initialRef.current.markdown
    if (initialRef.current.blocks.length > 0 || 戻す字.trim() === '') {
      return
    }
    const blocks = editor.tryParseMarkdownToBlocks(戻す字)
    if (blocks.length === 0) {
      return
    }
    // **ここは検証しない。** `blocks` は `tryParseMarkdownToBlocks` が作ったもので、
    // **エディタ自身の出力**である。記録から来た `unknown` を渡す93行とは出所が違う
    // ——あちらは `readMemoBody` が要素まで検証している（レビュー対応8）
    editor.replaceBlocks(editor.document, blocks as never)
  }, [editor])

  // 打つたびに書きかけを覚える。**確定していない字を失わない**（設計§8-1）
  useEffect(() => {
    if (changeRef.current === undefined) {
      return
    }
    return editor.onChange(() => {
      changeRef.current?.(editor.blocksToMarkdownLossy(editor.document))
    })
  }, [editor])

  return (
    <div
      data-testid={testId}
      // **打ったキーがここから外へ漏れないこと**が、この機能の安全性そのものである
      // （要件「気をつけること1」）。ターミナルへ飛ぶと勝手に作業が始まる
      onKeyDown={onKeyDown}
      role="group"
      aria-label={label}
    >
      <BlockNoteView editor={editor} />
    </div>
  )
}
